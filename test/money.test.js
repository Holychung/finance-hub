'use strict';

// Run with:  node --test
//
// The point of the compute*/loader split: net worth, cross-currency transfer
// pairing and reconciliation are the three things in this project most worth
// testing, and until the split they could only be reached by starting a
// server and going through an HTTP round trip. Here they are ordinary
// function calls over arrays.
//
// Nothing in this file opens a database, and it does not have to arrange not
// to — `shared/money.js` has no `require('./db')` to trigger. That is the
// whole claim of `shared/`, and this require is the proof: an earlier version
// of this file had to point FINANCE_DB at a throwaway directory before the
// first line of test code, purely because importing the module created a
// ledger.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const M = require('../shared/money');
const MONEY_SRC = fs.readFileSync(path.join(__dirname, '..', 'shared', 'money.js'), 'utf8');
// The loaders are read rather than required: `server/money.js` pulls in
// `./db`, and this file is the one place that must stay able to say it never
// touches a database.
const LOADER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'money.js'), 'utf8');

const acct = (o) => ({
  id: 1, name: 'a', kind: 'cash', currency: 'TWD', opening_balance: 0,
  opening_date: '2026-01-01', is_active: 1, sort_order: 0, note: '', ...o,
});

describe('computeFxLookup', () => {
  const fx = M.computeFxLookup({
    rows: [
      { date: '2026-03-01', rate: 31 },
      { date: '2026-06-01', rate: 32 },
      { date: '2026-09-01', rate: 33 },
    ],
  });

  it('拿到的是那天或那天以前最近的一筆', () => {
    assert.equal(fx.on('2026-06-01'), 32, '當天有匯率就用當天的');
    assert.equal(fx.on('2026-08-31'), 32, '當天沒有就往前找');
    assert.equal(fx.on('2027-01-01'), 33, '最後一筆之後一路沿用');
  });

  it('早於所有匯率的日期拿到最早的那一筆，而不是沒有', () => {
    assert.equal(fx.on('2020-01-01'), 31, '不然第一筆匯率之前的轉帳永遠配不起來');
  });

  it('一筆匯率都沒有就是 null——不會假裝有', () => {
    assert.equal(M.computeFxLookup({ rows: [] }).on('2026-06-01'), null);
  });
});

describe('computeAccountsWithBalances', () => {
  it('餘額是期初加上區間內的異動', () => {
    const out = M.computeAccountsWithBalances({
      accounts: [acct({ id: 1, opening_balance: 1000 }), acct({ id: 2, opening_balance: 0 })],
      totals: [{ account_id: 1, total: 234.567 }],
    });
    assert.equal(out[0].balance, 1234.57, '每次寫入都過 round2');
    assert.equal(out[1].balance, 0, '沒有任何交易的帳戶就是期初餘額');
  });

  it('負債帳戶的餘額是負的，而且不用特別處理', () => {
    const [card] = M.computeAccountsWithBalances({
      accounts: [acct({ kind: 'card', opening_balance: -1234 })],
      totals: [{ account_id: 1, total: -500 }],
    });
    assert.equal(card.balance, -1734);
  });
});

describe('computeHoldingsValued', () => {
  it('市值、成本、未實現損益、報酬率', () => {
    const [h] = M.computeHoldingsValued({
      holdings: [{ shares: 100, last_price: 12.5, avg_cost: 10, currency: 'USD' }],
    });
    assert.equal(h.market_value, 1250);
    assert.equal(h.cost_total, 1000);
    assert.equal(h.unrealized, 250);
    assert.equal(h.roi_pct, 25);
  });

  it('成本為零不會變成 Infinity', () => {
    const [h] = M.computeHoldingsValued({
      holdings: [{ shares: 10, last_price: 5, avg_cost: 0, currency: 'TWD' }],
    });
    assert.equal(h.roi_pct, 0, '零成本沒有分母，不是無限大的報酬');
    assert.equal(h.unrealized, 50);
  });
});

describe('computeNetWorth', () => {
  const accounts = [
    { ...acct({ id: 1, currency: 'TWD', kind: 'cash' }), balance: 500000 },
    { ...acct({ id: 2, currency: 'TWD', kind: 'card' }), balance: -12000 },
    { ...acct({ id: 3, currency: 'USD', kind: 'brokerage' }), balance: 2000 },
  ];
  const holdings = [{ currency: 'USD', market_value: 58420.15 }];
  const nw = M.computeNetWorth({ accounts, holdings, asOf: '2026-09-21' });

  it('一個幣別一組數字，而且沒有一個跨幣別的總計', () => {
    assert.deepEqual(Object.keys(nw.currencies).sort(), ['TWD', 'USD']);
    assert.equal(nw.currencies.TWD.total, 488000);
    assert.equal(nw.currencies.USD.total, 60420.15);
    // The load-bearing assertion of this whole project: adding USD to TWD
    // without a rate produces a number nobody holds, so it does not exist.
    const flat = JSON.stringify(nw);
    assert.ok(!('total' in nw), '最上層不該有 total');
    assert.ok(!flat.includes('548420'), '不能出現任何把兩個幣別加起來的數字');
  });

  it('持股市值另外算，不折進帳戶餘額', () => {
    assert.equal(nw.currencies.USD.ledger, 2000);
    assert.equal(nw.currencies.USD.securities, 58420.15);
    assert.equal(nw.currencies.USD.by_kind.securities, 58420.15);
    assert.equal(nw.currencies.USD.by_kind.brokerage, 2000, '持股沒有被算進券商帳戶餘額');
  });

  it('負債是負數，直接加就對了', () => {
    assert.equal(nw.currencies.TWD.by_kind.card, -12000);
    assert.equal(nw.currencies.TWD.ledger, 488000, '不用判斷帳戶類型');
  });

  it('幣別順序固定 USD、TWD，不隨金額大小跳動', () => {
    assert.deepEqual(nw.order, ['USD', 'TWD'], 'TWD 金額大得多，但欄位位置不該因此改變');
  });

  it('沒有任何帳戶就是空的，不是零', () => {
    const empty = M.computeNetWorth({ accounts: [], holdings: [], asOf: '2026-09-21' });
    assert.deepEqual(empty.currencies, {});
    assert.deepEqual(empty.order, []);
    assert.equal(empty.as_of, '2026-09-21');
  });
});

describe('computeNetWorthSeries', () => {
  const accounts = [
    { id: 1, currency: 'TWD', opening_balance: 1000, opening_date: '2026-01-01' },
    { id: 2, currency: 'USD', opening_balance: 100, opening_date: '2026-01-01' },
  ];
  const txns = [
    { account_id: 1, date: '2026-01-15', amount: 500 },
    { account_id: 2, date: '2026-02-10', amount: -40 },
    { account_id: 1, date: '2026-03-02', amount: -200 },
  ];

  it('每個幣別各一條線，不合併', () => {
    const s = M.computeNetWorthSeries({ accounts, txns, from: '2026-01-01', to: '2026-03-31' });
    assert.deepEqual(Object.keys(s).sort(), ['TWD', 'USD']);
    assert.deepEqual(s.TWD.map((p) => p.value), [1500, 1500, 1300]);
    assert.deepEqual(s.USD.map((p) => p.value), [100, 60, 60]);
  });

  it('點落在月底', () => {
    const s = M.computeNetWorthSeries({ accounts, txns, from: '2026-01-01', to: '2026-03-31' });
    assert.deepEqual(s.TWD.map((p) => p.date), ['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  it('沒有帳戶就回空陣列', () => {
    assert.deepEqual(M.computeNetWorthSeries({ accounts: [], txns: [], from: '2026-01-01', to: '2026-03-31' }), []);
  });

  // The bug this block exists to stop coming back. `opening_date` was being
  // selected from the database and never looked at, so every account put its
  // opening balance into every point of the chart — including the months
  // before the account existed. With more than one account the effect is a
  // long flat line at today's total that only starts moving at the first
  // imported transaction, which reads as a complete ledger rather than as a
  // chart of the months you have actually imported.
  it('帳戶開戶之前不算進淨值', () => {
    const s = M.computeNetWorthSeries({
      accounts: [{ id: 1, currency: 'TWD', opening_balance: 1000000, opening_date: '2026-07-01' }],
      txns: [{ account_id: 1, date: '2026-08-15', amount: -50000 }],
      from: '2026-01-01',
      to: '2026-09-30',
    });
    assert.deepEqual(s.TWD.map((p) => p.date), ['2026-07-31', '2026-08-31', '2026-09-30'],
      '一到六月這個帳戶還不存在，不該有點');
    assert.deepEqual(s.TWD.map((p) => p.value), [1000000, 950000, 950000]);
  });

  it('後來才開的帳戶在它開戶那個月才加進來', () => {
    const s = M.computeNetWorthSeries({
      accounts: [
        { id: 1, currency: 'TWD', opening_balance: 100, opening_date: '2026-01-01' },
        { id: 2, currency: 'TWD', opening_balance: 900, opening_date: '2026-09-01' },
      ],
      txns: [],
      from: '2026-01-01',
      to: '2026-09-30',
    });
    assert.equal(s.TWD[0].value, 100, '一月只有第一個帳戶');
    assert.equal(s.TWD.at(-1).value, 1000, '九月兩個都在');
    assert.equal(new Set(s.TWD.map((p) => p.value)).size, 2, '應該是一階，不是一條平線');
  });

  it('某個幣別還沒有帳戶時，那條線就還沒開始', () => {
    const s = M.computeNetWorthSeries({
      accounts: [
        { id: 1, currency: 'TWD', opening_balance: 1000, opening_date: '2026-01-01' },
        { id: 2, currency: 'USD', opening_balance: 500, opening_date: '2026-03-01' },
      ],
      txns: [],
      from: '2026-01-01',
      to: '2026-03-31',
    });
    assert.equal(s.TWD.length, 3);
    assert.deepEqual(s.USD.map((p) => p.date), ['2026-03-31'], '美金戶三月才開，線就從三月開始');
  });

  // The chart and the numbers beside it have to agree. Both are built from
  // the same rows, so the last point of the series is the same arithmetic
  // `accountsWithBalances` does — if they ever disagree, one of them is
  // telling the user something the other denies.
  it('最後一個點等於當下的帳戶餘額', () => {
    const accts = [
      { id: 1, currency: 'TWD', kind: 'cash', opening_balance: 1000, opening_date: '2026-01-01' },
      { id: 2, currency: 'TWD', kind: 'card', opening_balance: -500, opening_date: '2026-02-01' },
    ];
    const rows = [
      { account_id: 1, date: '2026-01-15', amount: 250.5 },
      { account_id: 2, date: '2026-02-20', amount: -120.25 },
    ];
    const s = M.computeNetWorthSeries({ accounts: accts, txns: rows, from: '2026-01-01', to: '2026-03-31' });

    const totals = [...rows.reduce((m, t) => m.set(t.account_id, (m.get(t.account_id) || 0) + t.amount), new Map())]
      .map(([account_id, total]) => ({ account_id, total }));
    const balances = M.computeAccountsWithBalances({ accounts: accts, totals });
    const sum = M.round2(balances.reduce((n, a) => n + a.balance, 0));

    assert.equal(s.TWD.at(-1).value, sum);
  });
});

describe('computeReconcile', () => {
  const base = { id: 1, account_id: 1, account_name: '活存', currency: 'TWD', date: '2026-03-31' };

  it('對得上就是 ok，差額是「網銀說的」減「算出來的」', () => {
    const [r] = M.computeReconcile({
      checks: [{ ...base, stated: 1500, opening_balance: 1000, txn_total: 500 }],
    });
    assert.equal(r.computed, 1500);
    assert.equal(r.diff, 0);
    assert.equal(r.ok, true);
  });

  it('差一分以內算對得上，float 誤差不會被當成漏帳', () => {
    const [r] = M.computeReconcile({
      checks: [{ ...base, stated: 1500, opening_balance: 1000.004, txn_total: 500 }],
    });
    assert.equal(r.ok, true);
    const [bad] = M.computeReconcile({
      checks: [{ ...base, stated: 1500, opening_balance: 1000, txn_total: 499 }],
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.diff, 1, '少匯了一筆 1 元，差額就是 1');
  });

  it('沒有任何交易的帳戶，算出來就是期初餘額', () => {
    const [r] = M.computeReconcile({ checks: [{ ...base, stated: 1000, opening_balance: 1000 }] });
    assert.equal(r.computed, 1000);
    assert.equal(r.ok, true);
  });

  it('txn_total 是輸入不是答案，不會跑進回傳的欄位裡', () => {
    const [r] = M.computeReconcile({
      checks: [{ ...base, stated: 1500, opening_balance: 1000, txn_total: 500 }],
    });
    assert.ok(!('txn_total' in r), '/api/reconcile 的形狀不該因為這次重構多一個欄位');
  });
});

describe('computeTransferCandidates', () => {
  const fx = M.computeFxLookup({ rows: [{ date: '2026-01-01', rate: 32 }] });
  const row = (o) => ({ id: 1, account_id: 1, date: '2026-03-01', amount: 0, description: '', currency: 'TWD', account_name: 'a', ...o });

  it('同幣別、同金額、幾天內的一出一進會配成一對', () => {
    const pairs = M.computeTransferCandidates({
      rows: [
        row({ id: 1, account_id: 1, amount: -5000, date: '2026-03-01' }),
        row({ id: 2, account_id: 2, amount: 5000, date: '2026-03-02' }),
      ],
      fx,
    });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].out.id, 1);
    assert.equal(pairs[0].in.id, 2);
    assert.equal(pairs[0].day_gap, 1);
    assert.equal(pairs[0].cross_currency, false);
  });

  it('跨幣別要靠匯率才認得出來', () => {
    const rows = [
      row({ id: 1, account_id: 1, amount: -32000, currency: 'TWD' }),
      row({ id: 2, account_id: 2, amount: 1000, currency: 'USD', date: '2026-03-02' }),
    ];
    const paired = M.computeTransferCandidates({ rows, fx });
    assert.equal(paired.length, 1);
    assert.equal(paired[0].cross_currency, true);

    // Same rows, no rates: both legs stay unpaired and go on counting as an
    // expense and an income. That is the documented cost of not setting one.
    const unpaired = M.computeTransferCandidates({ rows, fx: M.computeFxLookup({ rows: [] }) });
    assert.deepEqual(unpaired, []);
  });

  it('超過時間窗或超過容差就不配', () => {
    assert.deepEqual(M.computeTransferCandidates({
      rows: [row({ id: 1, account_id: 1, amount: -5000, date: '2026-03-01' }),
             row({ id: 2, account_id: 2, amount: 5000, date: '2026-03-20' })],
      fx,
    }), [], '差 19 天');
    assert.deepEqual(M.computeTransferCandidates({
      rows: [row({ id: 1, account_id: 1, amount: -5000 }),
             row({ id: 2, account_id: 2, amount: 4000, date: '2026-03-02' })],
      fx,
    }), [], '差 20%');
  });

  it('同一個帳戶內部的一出一進不是轉帳', () => {
    assert.deepEqual(M.computeTransferCandidates({
      rows: [row({ id: 1, account_id: 1, amount: -5000 }), row({ id: 2, account_id: 1, amount: 5000 })],
      fx,
    }), []);
  });

  it('一筆只會被用掉一次，而且挑最接近的那個', () => {
    const pairs = M.computeTransferCandidates({
      rows: [
        row({ id: 1, account_id: 1, amount: -5000, date: '2026-03-01' }),
        row({ id: 2, account_id: 2, amount: 5000, date: '2026-03-03' }),
        row({ id: 3, account_id: 3, amount: 5000, date: '2026-03-01' }),
      ],
      fx,
    });
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].in.id, 3, '同一天的比隔兩天的近');
  });
});

describe('liabilitiesInCredit', () => {
  it('只挑出餘額為正的卡與貸款', () => {
    const out = M.liabilitiesInCredit([
      { ...acct({ id: 1, kind: 'card' }), balance: 500 },
      { ...acct({ id: 2, kind: 'card' }), balance: -1234 },
      { ...acct({ id: 3, kind: 'loan' }), balance: 10 },
      { ...acct({ id: 4, kind: 'cash' }), balance: 99999 },
    ]);
    assert.deepEqual(out.map((a) => a.id), [1, 3], '現金帳戶是正的很正常，卡是正的才要問');
  });
});

describe('computeCoverage', () => {
  const months = 3;
  const to = '2026-03-31';
  const a = { id: 1, name: '活存', kind: 'cash', currency: 'TWD', opening_date: '2026-01-01', is_active: 1 };

  it('有交易是 data，沒交易但有對帳是 quiet，兩者都沒有才是 gap', () => {
    const g = M.computeCoverage({
      accounts: [a],
      activity: [{ account_id: 1, month: '2026-01', n: 12, net: 500 }],
      checks: [{ account_id: 1, date: '2026-02-15', ok: true }],
      to,
      months,
    });
    assert.deepEqual(g.accounts[0].cells.map((c) => c.state), ['data', 'quiet', 'gap']);
    assert.equal(g.accounts[0].gaps, 1);
    assert.equal(g.accounts[0].trailing_gap, 1, '最後一個月沒資料，這才是會叫人去下載對帳單的數字');
  });

  it('帳戶還沒開戶的月份是 outside，不算在缺口裡', () => {
    const g = M.computeCoverage({
      accounts: [{ ...a, opening_date: '2026-03-01' }],
      activity: [],
      checks: [],
      to,
      months,
    });
    assert.deepEqual(g.accounts[0].cells.map((c) => c.state), ['outside', 'outside', 'gap']);
    assert.equal(g.accounts[0].expected, 1, '開戶前沒有東西可以下載，不是你的錯');
  });

  it('已關閉的帳戶在最後一次活動之後也是 outside', () => {
    const g = M.computeCoverage({
      accounts: [{ ...a, is_active: 0 }],
      activity: [{ account_id: 1, month: '2026-01', n: 3, net: -100 }],
      checks: [],
      to,
      months,
    });
    assert.deepEqual(g.accounts[0].cells.map((c) => c.state), ['data', 'outside', 'outside']);
    assert.equal(g.accounts[0].trailing_gap, 0);
  });

  it('同一個月有多筆對帳，只要一筆對不上就算 off', () => {
    const g = M.computeCoverage({
      accounts: [a],
      activity: [],
      checks: [
        { account_id: 1, date: '2026-03-01', ok: true },
        { account_id: 1, date: '2026-03-20', ok: false },
      ],
      to,
      months,
    });
    assert.equal(g.accounts[0].cells[2].check, 'off', '順序不該影響結論');
  });
});

describe('compute* 真的是純的', () => {
  // A mechanism, not a convention: the moment a compute* reaches for a query
  // it stops being testable here and stops being able to run in a browser,
  // and nothing else in the suite would notice.
  // Every compute* takes a destructured object, so "the first { after the
  // name" is the parameter list, not the body — an earlier version of this
  // did exactly that and passed happily with a `db.prepare` planted inside
  // one of them. Walk the parameter parens to their close first.
  const bodies = () => {
    const out = [];
    // Indented, because shared/money.js lives inside the dual-environment
    // IIFE. Anchoring on column 0 found nothing and said so, which is what
    // the count assertion below is for.
    const re = /\n\s*function (compute[A-Za-z]*)\s*\(/g;
    for (let m; (m = re.exec(MONEY_SRC)); ) {
      let i = m.index + m[0].length - 1; // the opening (
      let depth = 0;
      for (; i < MONEY_SRC.length; i++) {
        if (MONEY_SRC[i] === '(') depth++;
        else if (MONEY_SRC[i] === ')' && --depth === 0) break;
      }
      const open = MONEY_SRC.indexOf('{', i);
      depth = 0;
      let end = open;
      for (; end < MONEY_SRC.length; end++) {
        if (MONEY_SRC[end] === '{') depth++;
        else if (MONEY_SRC[end] === '}' && --depth === 0) break;
      }
      out.push([m[1], MONEY_SRC.slice(open, end + 1)]);
    }
    return out;
  };

  it('抓到的是函式體，不是參數列', () => {
    const [, body] = bodies().find(([n]) => n === 'computeHoldingsValued');
    assert.ok(body.includes('market_value'), `抓到的只有 ${body.slice(0, 40)}…，這個檢查等於沒做`);
  });

  it('每個 compute* 的函式體裡都沒有 db', () => {
    const found = bodies();
    assert.ok(found.length >= 7, `只找到 ${found.length} 個 compute*，抓取邏輯壞了`);
    const offenders = found
      .filter(([, body]) => /\bdb\b|\bgetMeta\b|\.prepare\(/.test(body.replace(/\/\/[^\n]*/g, '')))
      .map(([name]) => name);
    assert.deepEqual(offenders, [], `這些 compute* 碰了資料庫：${offenders.join('、')}`);
  });

  it('每個 compute* 都有一個同名的載入器對應', () => {
    const loaders = {
      computeFxLookup: 'buildFxLookup',
      computeAccountsWithBalances: 'accountsWithBalances',
      computeHoldingsValued: 'holdingsValued',
      computeNetWorth: 'netWorth',
      computeNetWorthSeries: 'netWorthSeries',
      computeCoverage: 'coverage',
      computeReconcile: 'reconcile',
      computeTransferCandidates: 'findTransferCandidates',
    };
    for (const [pure, loader] of Object.entries(loaders)) {
      assert.equal(typeof M[pure], 'function', `shared/money.js 沒有匯出 ${pure}`);
      assert.match(LOADER_SRC, new RegExp(`function ${loader}\\s*\\(`), `server/money.js 沒有 ${loader}`);
      assert.match(LOADER_SRC, new RegExp(`\\b${pure}\\b`), `${loader} 沒有呼叫 ${pure}`);
    }
    const exported = bodies().map(([n]) => n).filter((n) => !(n in loaders));
    assert.deepEqual(exported, [], `這些 compute* 沒有對應的載入器：${exported.join('、')}`);
  });
});
