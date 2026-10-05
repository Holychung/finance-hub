'use strict';

// Run with:  node --test
//
// The overview export over plain arrays. `computeOverview` is fed exactly what
// server/money.js's `overview()` feeds it — the outputs of the other compute*
// functions over one invented book — so these are ordinary function calls, and
// the whole of the file the overview page hands back can be read line by line
// without a server. test/api.test.js checks the route that serves it and
// test/demo-store.test.js that the demo writes the same bytes.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const M = require('../shared/money');
const SP = require('../shared/spending');
const O = require('../shared/overview');

const ROOT = path.join(__dirname, '..');
const OVERVIEW_SRC = fs.readFileSync(path.join(ROOT, 'shared', 'overview.js'), 'utf8');
// Read rather than required: server/money.js pulls in ./db.
const LOADER_SRC = fs.readFileSync(path.join(ROOT, 'server', 'money.js'), 'utf8');

const ASOF = '2026-06-30';

// Everything invented. Two currencies, both halves, a card that was overpaid,
// a plan with an unvested share, a wallet off the coverage grid, and a pair of
// transfer legs nobody has paired yet.
const acct = (o) => ({
  opening_date: '2026-01-01', is_active: 1, sort_order: 0, note: '', access: 'liquid',
  tax_status: null, unvested: 0, ...o,
});
const ACCOUNTS = [
  acct({ id: 1, name: '台幣活存', kind: 'cash', currency: 'TWD', opening_balance: 100000 }),
  acct({ id: 2, name: '信用卡', kind: 'card', currency: 'TWD', opening_balance: -5000 }),
  acct({ id: 3, name: '永豐 交割戶', kind: 'brokerage', currency: 'TWD', opening_balance: 50000 }),
  acct({ id: 4, name: 'Firstrade', kind: 'brokerage', currency: 'USD', opening_balance: 2000 }),
  acct({ id: 5, name: '401(k)', kind: 'retirement', currency: 'USD', opening_balance: 18000, access: 'restricted', tax_status: 'pretax', unvested: 950 }),
  acct({ id: 6, name: '冷錢包', kind: 'wallet', currency: 'USD', opening_balance: 0, opening_date: '2026-03-01' }),
];

let seq = 0;
const tx = (account_id, date, amount, description, o = {}) => ({
  id: ++seq, account_id, date, amount, description, category: '', kind: 'other', transfer_group: null, ...o,
});
const TXNS = [
  tx(1, '2026-01-25', 68000, '薪資轉帳', { kind: 'income' }),
  tx(1, '2026-02-03', -1250, '全聯', { category: '食品' }),
  tx(2, '2026-02-04', -3200, 'UBER EATS', { category: '外食' }),
  tx(1, '2026-03-10', -32000, '轉出至券商', { kind: 'transfer', transfer_group: 'g1' }),
  tx(4, '2026-03-11', 1000, 'INCOMING WIRE', { kind: 'transfer', transfer_group: 'g1' }),
  tx(5, '2026-05-31', 1200, 'CHANGE IN MARKET VALUE', { kind: 'valuation' }),
  tx(1, '2026-06-02', -899, '不知名扣款'),
  tx(1, '2026-06-05', -15000, '轉出'),
  tx(3, '2026-06-05', 15000, '轉入'),
  tx(2, '2026-06-10', 10000, 'PAYMENT THANK YOU'),
];

const HOLDINGS = [
  { id: 1, account_id: 3, symbol: '2330', name: '台積電', market: 'TW', shares: 100, avg_cost: 900, last_price: 1000, price_date: '2026-06-20', currency: 'TWD', decimals: 0 },
  { id: 2, account_id: 3, symbol: '0050', name: '元大台灣50', market: 'TW', shares: 1000, avg_cost: 150, last_price: 180, price_date: '2026-06-20', currency: 'TWD', decimals: 0 },
  { id: 3, account_id: 4, symbol: 'VTI', name: 'Vanguard Total', market: 'US', shares: 10, avg_cost: 200, last_price: 250, price_date: '2026-06-20', currency: 'USD', decimals: 4 },
  { id: 4, account_id: 6, symbol: 'BTC', name: 'Bitcoin', market: 'CRYPTO', shares: 0.01, avg_cost: 50000, last_price: 60000, price_date: '2026-06-20', currency: 'USD', decimals: 8 },
];

// 台幣活存 holds 134,750 from March to May: the March and May checks
// disagree, April's agrees. Firstrade holds 3,000 and its June check says
// 3,100.
const CHECKS = [
  { id: 1, account_id: 1, date: '2026-03-31', stated: 134250 },
  { id: 2, account_id: 1, date: '2026-04-30', stated: 134750 },
  { id: 3, account_id: 1, date: '2026-05-31', stated: 134000 },
  { id: 4, account_id: 4, date: '2026-06-30', stated: 3100 },
];

// What server/money.js's overview() hands computeOverview, built from rows
// the way its loaders build it: the same compute* over the same windows.
function inputs({ accounts = ACCOUNTS, txns = TXNS, holdings = HOLDINGS, checks = CHECKS, asOf = ASOF, months = 6 } = {}) {
  const upTo = txns.filter((t) => t.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const sum = (rows) => {
    const m = new Map();
    for (const t of rows) m.set(t.account_id, (m.get(t.account_id) || 0) + t.amount);
    return [...m].map(([account_id, total]) => ({ account_id, total }));
  };
  const withBalances = M.computeAccountsWithBalances({ accounts, totals: sum(upTo) });
  const valued = M.computeHoldingsValued({
    holdings: holdings.map((h) => ({ ...h, account_name: byId.get(h.account_id).name })),
    asOf,
  });
  const currencies = accounts.map(({ id, name, currency }) => ({ id, name, currency }));
  const reconcile = M.computeReconcile({
    checks: checks.map((c) => {
      const a = byId.get(c.account_id);
      return {
        ...c, note: '', account_name: a.name, currency: a.currency, opening_balance: a.opening_balance,
        txn_total: upTo.filter((t) => t.account_id === c.account_id && t.date <= c.date).reduce((n, t) => n + t.amount, 0),
      };
    }).sort((x, y) => y.date.localeCompare(x.date) || y.id - x.id),
  });
  const activity = new Map();
  for (const t of upTo) {
    const k = `${t.account_id}|${t.date.slice(0, 7)}`;
    const cur = activity.get(k) || { account_id: t.account_id, month: t.date.slice(0, 7), n: 0, net: 0 };
    cur.n++;
    cur.net += t.amount;
    activity.set(k, cur);
  }
  const from = upTo.length ? upTo[0].date : accounts.map((a) => a.opening_date).sort()[0] || asOf;
  return {
    asOf,
    netWorth: M.computeNetWorth({ accounts: withBalances, holdings: valued, asOf }),
    accounts: withBalances,
    holdings: valued,
    series: M.computeNetWorthSeries({ accounts, txns: upTo, from, to: asOf }),
    spending: SP.computeSpending({ txns: upTo, accounts: currencies, from: SP.yearsBefore(asOf, 1), to: asOf }),
    recurring: SP.computeRecurring({ txns: upTo, accounts: currencies, to: asOf }),
    coverage: M.computeCoverage({
      accounts,
      activity: [...activity.values()],
      checks: reconcile.map((c) => ({ account_id: c.account_id, date: c.date, ok: c.ok })),
      imports: [],
      to: asOf,
      months,
    }),
    reconcile,
    transferCandidates: M.computeTransferCandidates({
      rows: upTo.filter((t) => !t.transfer_group).map((t) => ({
        ...t, currency: byId.get(t.account_id).currency, account_name: byId.get(t.account_id).name,
      })),
      fx: M.computeFxLookup({ rows: [] }),
    }),
  };
}

const model = (o) => O.computeOverview(inputs(o));
const markdown = (o) => O.overviewMarkdown(model(o));

// The cells of one table row, split on the pipes that are not escaped.
const cells = (row) => row.split(/(?<!\\)\|/).slice(1, -1).map((s) => s.trim());
const rowOf = (md, first) => md.split('\n').find((l) => l.startsWith(`| ${first} `));

describe('computeOverview：一整本帳組成一份模型', () => {
  it('每個幣別一個區塊，順序跟淨值一樣，而且沒有任何跨幣別的總數', () => {
    const inp = inputs();
    const m = O.computeOverview(inp);
    assert.deepEqual(m.order, inp.netWorth.order);
    assert.deepEqual(Object.keys(m.currencies).sort(), [...m.order].sort());
    assert.ok(!('total' in m), '模型最上層不該有一個總數');
    // TWD 465,651 and USD 24,350 add up to a number nobody holds.
    assert.equal(m.currencies.TWD.total, 465651);
    assert.equal(m.currencies.USD.total, 24350);
    const md = O.overviewMarkdown(m);
    for (const s of [JSON.stringify(m), md]) {
      assert.ok(!s.includes('490001') && !s.includes('490,001'), '兩個幣別被加在一起了');
    }
  });

  it('可動用加受限制就是合計；未歸屬從淨值扣，不從帳戶餘額扣', () => {
    const m = model();
    for (const cur of m.order) {
      const c = m.currencies[cur];
      assert.equal(M.round2(c.liquid + c.restricted), c.total, cur);
      assert.equal(M.round2(c.ledger + c.securities - c.unvested), c.total, cur);
    }
    assert.equal(m.currencies.USD.restricted, 18250, '401(k) 19,200 扣掉未歸屬 950');
    const plan = m.currencies.USD.accounts.find((a) => a.name === '401(k)');
    assert.equal(plan.balance, 19200, '帳戶餘額是對帳單的數字，含未歸屬');
    assert.equal(plan.access, 'restricted');
  });

  it('持股只出現在自己的幣別，最大的在前面，佔持股加起來是 100%', () => {
    const m = model();
    assert.deepEqual(m.currencies.TWD.holdings.map((h) => h.symbol), ['0050', '2330']);
    assert.deepEqual(m.currencies.USD.holdings.map((h) => h.symbol), ['VTI', 'BTC']);
    for (const cur of m.order) {
      const total = m.currencies[cur].holdings.reduce((n, h) => n + h.share, 0);
      assert.ok(Math.abs(total - 100) <= 0.2, `${cur} 的佔比加起來是 ${total}`);
    }
    assert.equal(m.currencies.TWD.holdings[0].share, 64.3, '180,000 ÷ 280,000');
  });

  it('較上月是帳戶淨額跟上一個月底比，跟總覽卡片同一條規則', () => {
    const inp = inputs();
    const m = O.computeOverview(inp);
    const s = inp.series.TWD;
    assert.equal(m.currencies.TWD.change, M.round2(m.currencies.TWD.ledger - s[s.length - 2].value));
    assert.equal(m.currencies.TWD.change, 9101);
    assert.equal(m.currencies.USD.change, 0);
    assert.equal(m.currencies.TWD.series.at(-1).date, ASOF, '最後一點就是匯出那一天');
    assert.equal(m.currencies.TWD.series.at(-1).value, m.currencies.TWD.ledger);
  });

  it('走勢只留最後十二個點', () => {
    const txns = [];
    for (let i = 0; i < 20; i++) {
      const d = new Date(Date.UTC(2025, i, 15)).toISOString().slice(0, 10);
      txns.push(tx(1, d, 100, `月 ${i}`, { category: '收入' }));
    }
    const m = model({ accounts: [acct({ id: 1, name: '活存', kind: 'cash', currency: 'TWD', opening_balance: 0, opening_date: '2025-01-01' })], txns, holdings: [], checks: [], asOf: '2026-08-31' });
    assert.equal(m.currencies.TWD.series.length, 12);
    assert.equal(m.currencies.TWD.series[0].date, '2025-09-30');
  });

  it('近一年的收支：轉帳和市值變動不算，前八類之外併成一列', () => {
    const m = model();
    const s = m.currencies.TWD.spending;
    assert.equal(s.expense, 20349, '32,000 的轉帳不是支出');
    assert.equal(s.income, 93000);
    assert.equal(s.uncategorised.count, 2);
    assert.equal(s.uncategorised.share, 78.1);
    assert.equal(s.other, null);
    assert.equal(m.currencies.USD.spending, null, 'USD 只有轉帳和市值變動，沒有收支');

    const ten = [...'ABCDEFGHIJ'].map((c, i) => tx(1, '2026-06-01', -(1000 - i * 100), `店 ${c}`, { category: `類別${c}` }));
    const one = [acct({ id: 1, name: '活存', kind: 'cash', currency: 'TWD', opening_balance: 10000 })];
    const cut = model({ accounts: one, txns: ten, holdings: [], checks: [] }).currencies.TWD.spending;
    assert.equal(cut.categories.length, 8);
    assert.deepEqual(cut.other, { categories: 2, total: 300, count: 2, share: 5.5 });
  });

  it('需要注意：會讓數字錯的排前面，一個帳戶只點名最新那筆對不上的對帳', () => {
    const m = model();
    assert.deepEqual(m.attention.map((a) => [a.level, a.type]), [
      ['err', 'liability_in_credit'],
      ['err', 'reconcile_off'],
      ['err', 'reconcile_off'],
      ['warn', 'unpaired_transfers'],
      ['warn', 'stale'],
      ['warn', 'uncategorised'],
    ]);
    const [card, newest, older, pairs, stale, uncat] = m.attention;
    assert.equal(card.name, '信用卡');
    assert.equal(card.balance, 1800);
    assert.equal(card.overstatement, 3600, '記反了的話，淨值多算兩倍');
    assert.equal(newest.account_name, 'Firstrade');
    assert.equal(newest.diff, 100);
    assert.equal(older.account_name, '台幣活存');
    assert.equal(older.date, '2026-05-31', '三月那筆也對不上，但點名的是最新那筆');
    assert.equal(older.diff, -750);
    assert.equal(pairs.count, 1);
    assert.deepEqual([stale.name, stale.months, stale.last_data], ['401(k)', 1, '2026-05']);
    assert.deepEqual([uncat.currency, uncat.count, uncat.share], ['TWD', 2, 78.1]);
  });

  it('什麼都對得上的帳本，需要注意是空的', () => {
    const one = [acct({ id: 1, name: '活存', kind: 'cash', currency: 'TWD', opening_balance: 1000 })];
    const clean = [tx(1, '2026-06-03', -100, '午餐', { category: '外食' })];
    const m = model({ accounts: one, txns: clean, holdings: [], checks: [], months: 1 });
    assert.deepEqual(m.attention, []);
    assert.match(O.overviewMarkdown(m), /## 需要注意\n\n沒有需要處理的事。\n/);
  });

  it('錢包這種手動記價的帳戶，被點名為不在完整度裡', () => {
    const m = model();
    assert.deepEqual(m.unknowns.manual, [{ name: '冷錢包', kind: 'wallet' }]);
    assert.equal(m.unknowns.months, 6);
    assert.ok(m.unknowns.gaps > 0);
  });
});

describe('overviewMarkdown：寫成一份讀得懂的檔案', () => {
  it('章節都在，換行是 LF，同樣的帳本寫出同樣的位元組', () => {
    const md = markdown();
    assert.ok(md.startsWith('# 資產全覽\n'));
    assert.match(md, /^截至 2026-06-30，/m);
    for (const h of ['## 淨值', '## TWD', '## USD', '### 組成', '### 帳戶', '### 持股', '### 近一年收支',
      '#### 支出分類', '### 帳戶淨額走勢（月底，不含持股）', '## 需要注意', '## 這份資料不知道的事']) {
      assert.ok(md.includes(`\n${h}\n`), `少了 ${h}`);
    }
    assert.ok(!md.includes('\r'), '換行是 LF');
    assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'), '結尾剛好一個換行');
    assert.equal(markdown(), md, '沒有時鐘，同一本帳同一天就是同一份檔案');
  });

  it('淨值表一個幣別一列，數字照幣別的小數位', () => {
    const md = markdown();
    assert.deepEqual(cells(rowOf(md, 'TWD')), ['TWD', '465,651', '0', '465,651', '+9,101']);
    assert.deepEqual(cells(rowOf(md, 'USD')), ['USD', '6,100.00', '18,250.00', '24,350.00', '0.00']);
    assert.match(md, /以下金額都是 USD。淨值 24,350\.00 ＝ 帳戶 22,200\.00 ＋ 持股 3,100\.00 － 未歸屬 950\.00。/);
  });

  // Obsidian, and GitHub with maths on, read a line holding two `$` as a
  // formula, and every TWD row would be one. So the file never writes one:
  // the currency is the row's, the section's, or the code after the number.
  it('金額不帶貨幣符號：整份檔案裡沒有一個 $', () => {
    const md = markdown();
    assert.ok(!md.includes('$'), md.split('\n').find((l) => l.includes('$')));
    assert.ok(!md.includes('NT'), '台幣也不寫 NT$');
  });

  it('句子裡的金額後面跟著幣別代號', () => {
    const md = markdown();
    assert.match(md, /「信用卡」是信用卡，但餘額是正的（1,800 TWD）。欠款要記成負數，否則 TWD 淨值會多算 3,600 TWD/);
    assert.match(md, /「Firstrade」在 2026-06-30 的實際餘額是 3,100\.00 USD，交易累計是 3,000\.00 USD，差 \+100\.00 USD。/);
    assert.match(md, /- \*\*需處理\*\*：「台幣活存」在 2026-05-31/);
    assert.match(md, /- \*\*待確認\*\*：有 1 組可能的轉帳還沒配對/);
  });

  it('USD 近一年沒有收支，就這樣說，不畫一張全是零的表', () => {
    const usd = markdown().split('\n## ').find((s) => s.startsWith('USD'));
    assert.match(usd, /近一年沒有這個幣別的收支（不含轉帳和市值變動）。/);
    assert.ok(!usd.includes('#### 支出分類'));
  });

  it('持股表寫得出八位小數的幣和它的報酬率', () => {
    const btc = cells(rowOf(markdown(), 'BTC'));
    assert.deepEqual(btc, ['BTC', 'Bitcoin', '加密貨幣', '冷錢包', '0.01', '60,000.00', '2026-06-20',
      '600.00', '500.00', '+100.00', '+20.00%', '19.4%']);
  });

  // A name is somebody's typing and a label is a bank's. Neither may split a
  // row, open a tag, or turn into a link or a remote image when the file is
  // opened in a renderer.
  it('帳本裡來的字串一律跳脫，一列還是一列', () => {
    const evil = 'A|B <b>x</b> [點我](javascript:alert(1)) ![p](x.png) 5$ 反\\斜 `code`\n第二行';
    const accounts = ACCOUNTS.map((a) => (a.id === 1 ? { ...a, name: evil } : a));
    const md = markdown({ accounts });
    const row = md.split('\n').find((l) => l.startsWith('| A'));
    assert.ok(row, '找不到那一列——換行把它切斷了');
    assert.equal(cells(row).length, 5, `欄數不對：${row}`);
    assert.equal(cells(row)[0],
      'A\\|B \\<b\\>x\\</b\\> \\[點我\\](javascript:alert(1)) !\\[p\\](x.png) 5\\$ 反\\\\斜 \\`code\\` 第二行');
    assert.ok(!md.includes('<b>'), '不能留下一個標籤');
    assert.ok(!/(^|[^\\])\[點我\]/.test(md), '不能留下一個連結');
    assert.ok(!/!\[p\]/.test(md), '不能留下一張會自己去抓的圖');
  });

  it('還沒有帳戶的帳本也寫得出來', () => {
    const md = markdown({ accounts: [], txns: [], holdings: [], checks: [] });
    assert.match(md, /## 淨值\n\n還沒有帳戶。\n/);
    assert.match(md, /## 需要注意\n\n沒有需要處理的事。\n/);
    assert.match(md, /## 這份資料不知道的事\n/);
  });

  // What the browser does: classic scripts in index.html's order, one global
  // scope, no `require`. The demo's 匯出全覽 runs this path, and it has to
  // write the same file as the server's.
  it('瀏覽器那條路寫出一模一樣的檔案', () => {
    const ctx = vm.createContext({ TextEncoder, TextDecoder });
    const doc = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
    const order = [...doc.matchAll(/<script src="\/shared\/([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.ok(order.includes('overview.js'), 'index.html 沒有載入 shared/overview.js');
    for (const f of order) vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared', f), 'utf8'), ctx, { filename: `shared/${f}` });
    ctx.INPUT = JSON.parse(JSON.stringify(inputs()));
    assert.equal(vm.runInContext('overviewMarkdown(computeOverview(INPUT))', ctx), markdown());
  });
});

describe('一年前是哪一天', () => {
  it('同一個月的同一天；二月二十九日往回落在三月一日', () => {
    assert.equal(SP.yearsBefore('2026-09-25'), '2025-09-25');
    assert.equal(SP.yearsBefore('2026-09-25', 2), '2024-09-25');
    assert.equal(SP.yearsBefore('2024-02-29', 1), '2023-03-01');
  });
});

describe('純的，而且只有一份', () => {
  it('shared/overview.js 不碰資料庫，也不碰檔案系統', () => {
    const code = OVERVIEW_SRC.replace(/\/\/[^\n]*/g, '');
    for (const re of [/\bdb\b/, /\bgetMeta\b/, /\.prepare\(/, /require\(['"](?:node:|fs|\.\.\/server)/]) {
      assert.ok(!re.test(code), `shared/overview.js 碰到了 ${re}`);
    }
  });

  it('server/money.js 有它的載入器，而且呼叫的就是 computeOverview', () => {
    assert.match(LOADER_SRC, /function overview\s*\(/);
    assert.match(LOADER_SRC, /\bcomputeOverview\(/);
  });

  // The page's 待辦 and the file's 需要注意 use the same two words, from one
  // table. A second copy in a view would say something else the day either
  // is reworded.
  it('需處理／待確認只寫在 shared/overview.js 一個地方', () => {
    const web = path.join(ROOT, 'web');
    const copies = fs.readdirSync(web).filter((f) => f.endsWith('.js'))
      .filter((f) => /['"`]需處理['"`]|['"`]待確認['"`]|TODO_LEVELS/.test(fs.readFileSync(path.join(web, f), 'utf8')));
    assert.deepEqual(copies, []);
    assert.deepEqual(Object.keys(O.ATTENTION_LEVELS), ['err', 'warn']);
  });
});
