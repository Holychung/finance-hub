'use strict';

// Run with:  node --test
//
// The seeder is the only script that writes a whole ledger, so the two things
// worth pinning are that it refuses to write the wrong one, and that what it
// produces actually exercises the views it exists to fill. A book with eight
// accounts that are all `cash` would satisfy "it ran" and demonstrate nothing.
//
// Each case gets its own mkdtemp HOME, so nothing can reach ~/.finance-hub —
// and its own directory rather than just a unique filename, because paths.js
// derives BACKUP_DIR from the database's directory.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require('../shared/money');
const SP = require('../shared/spending');
const R = require('../shared/rules');
const { buildDemoBook, DEMO_MONTHS } = require('../shared/demo-seed');

const SEED = path.join(__dirname, '..', 'scripts', 'seed-demo.js');
const TO = '2026-09-30';

const fakeHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hub-seed-'));

function run(env, args = []) {
  const clean = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete clean[k];
  return spawnSync(process.execPath, [SEED, `--to=${TO}`, ...args], { env: clean, encoding: 'utf8' });
}

describe('示範資料的產生器', () => {
  let db;
  let home;

  before(() => {
    home = fakeHome();
    const r = run({ HOME: home, FINANCE_PROFILE: 'demo', FINANCE_DB: undefined });
    assert.equal(r.status, 0, r.stderr);
    db = new DatabaseSync(path.join(home, '.finance-hub', 'demo.db'));
  });

  it('拒絕寫入個人帳本，而且不是警告是拒絕', () => {
    const h = fakeHome();
    const r = run({ HOME: h, FINANCE_PROFILE: undefined, FINANCE_DB: undefined });
    assert.notEqual(r.status, 0, '應該要失敗');
    assert.match(r.stderr, /拒絕寫入個人帳本/);
    assert.ok(!fs.existsSync(path.join(h, '.finance-hub', 'finance.db')), '連檔案都不該被建出來');
  });

  it('已經有資料就不覆蓋，除非 --force', () => {
    const again = run({ HOME: home, FINANCE_PROFILE: 'demo', FINANCE_DB: undefined });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /已經有/);
    const forced = run({ HOME: home, FINANCE_PROFILE: 'demo', FINANCE_DB: undefined }, ['--force']);
    assert.equal(forced.status, 0, forced.stderr);
  });

  // The reason the seeder exists: with one kind the breakdown reads 100% and
  // the diverging asset/liability scale the charts were built for never shows.
  it('帳戶類型夠分散，每個幣別都不只一種', () => {
    const rows = db.prepare('SELECT currency, kind, COUNT(*) AS n FROM accounts GROUP BY currency, kind').all();
    const byCurrency = new Map();
    for (const r of rows) byCurrency.set(r.currency, (byCurrency.get(r.currency) || new Set()).add(r.kind));
    assert.ok(byCurrency.size >= 2, '至少兩種幣別');
    for (const [cur, kinds] of byCurrency) {
      assert.ok(kinds.size >= 2, `${cur} 只有一種帳戶類型（${[...kinds]}），佔比圖會是 100%`);
    }
    assert.ok([...byCurrency.values()].some((k) => k.has('card') || k.has('loan')), '要有負債，不然負數那半永遠不會出現');
  });

  // A wallet is the exception, and a precise one rather than a loosened
  // rule: self-custody holds no cash, so its balance is exactly zero and its
  // value is entirely the coins in `holdings`. Relaxing the rest to `>= 0`
  // would let a cash account that lost its opening balance pass.
  it('負債是負的，資產是正的，錢包的價值全在持股', () => {
    const accounts = load(db);
    const holdings = db.prepare('SELECT account_id FROM holdings').all();
    for (const a of accounts) {
      if (a.kind === 'card' || a.kind === 'loan') assert.ok(a.balance < 0, `${a.name} 應該是負的`);
      else if (a.kind === 'wallet') {
        assert.equal(a.balance, 0, `${a.name} 沒有現金，餘額應該剛好是 0`);
        assert.ok(holdings.some((h) => h.account_id === a.id), `${a.name} 應該至少有一筆持股`);
      } else assert.ok(a.balance > 0, `${a.name} 應該是正的`);
    }
  });

  it('有一筆八位小數的幣，讓頁面真的顯示得出八位', () => {
    const coin = db.prepare("SELECT shares, decimals, currency FROM holdings WHERE market = 'CRYPTO'").get();
    assert.ok(coin, '示範帳本裡要有一筆 CRYPTO 持股');
    assert.equal(coin.decimals, 8);
    assert.ok(!Number.isInteger(coin.shares * 1e4), '四位小數表達不了它，這筆才示範得了');
  });

  // The only restricted account in the book, and it has to carry both figures
  // its kind exists for, or the pills and the subtraction never reach a screen.
  it('有一個退休金帳戶：受限制、稅前、有未歸屬，而且每個月都有資料', () => {
    const plan = db.prepare("SELECT id, access, tax_status, unvested FROM accounts WHERE kind = 'retirement'").get();
    assert.ok(plan, '示範帳本裡要有一個退休金帳戶');
    assert.equal(plan.access, 'restricted', '從類型來的起始值');
    assert.equal(plan.tax_status, 'pretax');
    assert.ok(plan.unvested > 0, '沒有未歸屬就示範不出淨值扣掉它');
    const others = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE kind <> 'retirement' AND access <> 'liquid'").get().n;
    assert.equal(others, 0, '其他帳戶都是可動用的');
    const row = coverage(db).accounts.find((a) => a.id === plan.id);
    assert.equal(row.gaps, 0, '提撥每個月都有，完整度不該把它當成沒人匯');
  });

  // Kept the way its statements keep it: contributions on payday, and at every
  // month-end the change in market value the statement reports. So its line is
  // the plan's value, the drawdown included, and none of that is spending.
  it('401(k) 的線跟著市值走：有漲有跌、三年約二十萬，市值變動不算收支', () => {
    const plan = db.prepare("SELECT id, opening_balance FROM accounts WHERE kind = 'retirement'").get();
    const txns = db.prepare('SELECT date, amount, kind FROM txns WHERE account_id = ? ORDER BY date').all(plan.id);
    const valuations = txns.filter((t) => t.kind === 'valuation');
    assert.equal(valuations.length, DEMO_MONTHS - 1, '每個過完的月份一筆；這個月的對帳單還沒來');
    assert.ok(valuations.some((v) => v.amount < 0), '沒有跌過的月份，線就只是另一條斜線');
    assert.ok(valuations.some((v) => v.amount > 0));
    const balance = plan.opening_balance + txns.reduce((s, t) => s + t.amount, 0);
    assert.ok(balance > 190000 && balance < 210000, `期末 ${balance}`);

    const { txns: all, accounts } = rows(db);
    const contributed = txns.filter((t) => t.kind === 'income').reduce((s, t) => s + t.amount, 0);
    const planOnly = SP.computeSpending({ txns: all.filter((t) => t.account_id === plan.id), accounts, from: '2000-01-01', to: TO });
    assert.equal(planOnly.currencies.USD.expense, 0, '跌的月份不是支出');
    assert.ok(Math.abs(planOnly.currencies.USD.income - contributed) < 0.01, '收入只有提撥，漲的月份不算');
  });

  it('完整度五種狀態都生得出來', () => {
    const cov = coverage(db);
    const states = new Set();
    for (const a of cov.accounts) for (const c of a.cells) states.add(c.state);
    for (const want of ['data', 'quiet', 'gap', 'partial', 'outside']) {
      assert.ok(states.has(want), `沒有任何一格是 ${want}，那個狀態在畫面上永遠看不到`);
    }
  });

  it('固定扣款抓得到訂閱，而且抓到的不是轉帳', () => {
    const { txns, accounts } = rows(db);
    const rec = SP.computeRecurring({ txns, accounts, to: TO });
    const active = rec.items.filter((r) => r.active);
    assert.ok(active.length >= 3, `只抓到 ${active.length} 筆`);
    assert.ok(active.some((r) => r.cadence === 'monthly'));
    // 已配對的轉帳不該出現在這裡。房貸和卡費各自都是每月同額，只要漏掉
    // transfer 的排除就會爬到清單最上面。
    assert.ok(!active.some((r) => /房貸|扣繳|AUTOPAY/.test(r.label)), `轉帳跑進固定扣款：${active.map((r) => r.label)}`);
  });

  it('分類有一部分有、一部分沒有 —— 兩邊都要看得到', () => {
    const { txns, accounts } = rows(db);
    const sp = SP.computeSpending({ txns, accounts, from: '2000-01-01', to: TO });
    for (const cur of sp.order) {
      const d = sp.currencies[cur];
      const share = d.uncategorised.total / d.expense;
      assert.ok(share > 0.05 && share < 0.95, `${cur} 未分類佔 ${(share * 100).toFixed(0)}%，示範不出規則引擎的用處`);
    }
  });

  // The overview's pairing to-do is a demo of pairing, so every pair it offers
  // has to be one the book left open on purpose: two legs of one transfer, the
  // same day, the same amount. An employer match that, at this book's rates,
  // came within tolerance of the rent leaving 玉山 the next day was once offered
  // as a transfer month after month.
  it('待配對的只有故意留著的轉帳，沒有湊巧對上的', () => {
    const { accounts } = rows(db);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const unpaired = db.prepare('SELECT id, account_id, date, amount, description, kind FROM txns WHERE transfer_group IS NULL ORDER BY date').all()
      .map((t) => ({ ...t, currency: byId.get(t.account_id).currency, account_name: byId.get(t.account_id).name }));
    const fx = M.computeFxLookup({ rows: db.prepare("SELECT date, rate FROM fx_rates WHERE pair = 'USDTWD' ORDER BY date").all() });
    const pairs = M.computeTransferCandidates({ rows: unpaired, fx });
    assert.ok(pairs.length > 0, '留著沒配的要看得到');
    for (const p of pairs) {
      const what = `${p.out.account_name} ${p.out.description} ↔ ${p.in.account_name} ${p.in.description}`;
      assert.equal(p.out.date, p.in.date, what);
      assert.equal(p.out.amount, -p.in.amount, what);
    }
  });

  it('留下一些待辦，因為空的待辦清單示範不了待辦', () => {
    const { txns, accounts } = rows(db);
    const unpaired = txns.filter((t) => !t.transfer_group && t.kind !== 'transfer');
    assert.ok(unpaired.length > 0);
    const checks = db.prepare('SELECT COUNT(*) AS n FROM balance_checks').get().n;
    assert.ok(checks >= 2, '要有對得上的也要有對不上的');
    assert.ok(accounts.length >= 5);
  });

  it('同樣的指令跑兩次，結果一樣', () => {
    const a = fakeHome();
    const b = fakeHome();
    run({ HOME: a, FINANCE_PROFILE: 'demo', FINANCE_DB: undefined });
    run({ HOME: b, FINANCE_PROFILE: 'demo', FINANCE_DB: undefined });
    const sum = (home) => {
      const d = new DatabaseSync(path.join(home, '.finance-hub', 'demo.db'));
      const out = d.prepare('SELECT COUNT(*) AS n, SUM(amount) AS total FROM txns').get();
      d.close();
      return `${out.n}/${Math.round(out.total)}`;
    };
    assert.equal(sum(a), sum(b), '亂數要吃固定種子，不然沒有人能拿它當基準');
  });

  // The month list used to be stepped back from `to` itself, and a day that
  // does not exist in an earlier month rolls into the next: from the 30th,
  // February disappeared and March held two of everything. The salary is one
  // row a month, so it counts the months exactly.
  it('不管結束在哪一天，都是連續十八個月、每個月一份薪水', () => {
    for (const to of ['2026-09-30', '2026-10-31', '2026-03-31', '2026-09-22']) {
      const book = buildDemoBook({ to, months: 18, now: () => 'x', uuid: () => 'g' });
      const salary = book.txns.filter((t) => t.description.startsWith('薪資轉帳')).map((t) => t.date.slice(0, 7));
      assert.equal(salary.length, 18, `${to}：${salary.length} 份薪水`);
      assert.equal(new Set(salary).size, 18, `${to}：有月份重複，也就有月份不見了`);
      assert.equal(salary[salary.length - 1], to.slice(0, 7), `${to}：最後一個月要是 to 那個月`);
    }
  });

  // The reason the book moved out of this script and into shared/: the
  // hosted demo loads the same rows into memory. Two hand-written fake
  // ledgers would have drifted the first time either was touched, and a
  // visitor would be looking at something the app does not actually do.
  it('寫進 SQLite 的，跟瀏覽器載進記憶體的，是同一本帳', () => {
    // No `months`, like the seeder above and like web/storage.js: both open
    // the book at its own default, DEMO_MONTHS.
    const book = buildDemoBook({ to: TO, now: () => 'x', uuid: () => 'g' });

    // created_at is a real clock in the script and transfer_group a real
    // uuid; neither can line up with an injected one, and neither is what is
    // being compared.
    const scrub = (r) => {
      const out = { ...r };
      if ('created_at' in out) out.created_at = 'x';
      if ('transfer_group' in out && out.transfer_group) out.transfer_group = 'g';
      return out;
    };

    for (const table of ['institutions', 'accounts', 'imports', 'txns', 'holdings', 'prices', 'fx_rates', 'balance_checks', 'rules']) {
      const written = db.prepare(`SELECT * FROM ${table}`).all().map(scrub);
      const built = book[table].map(scrub);
      assert.equal(written.length, built.length, `${table} 的筆數`);
      assert.deepEqual(written, built, `${table} 寫進去的跟建出來的不一樣`);
    }
  });

  // Seeded but deliberately not applied: the rules page opens with something
  // in it, 套用規則 has work to do, and the spending breakdown still shows an
  // honest 未分類 share until the visitor presses it. Pre-applying them would
  // demonstrate nothing.
  it('規則有種，但故意沒套用，所以「套用規則」真的有事做', () => {
    const rules = db.prepare('SELECT * FROM rules ORDER BY id').all();
    assert.ok(rules.length >= 3, '規則頁空的就示範不了規則');

    const txns = db.prepare('SELECT id, description, category FROM txns').all();
    const planned = R.plan(txns, R.sortRules(rules), { overwrite: false });
    assert.ok(planned.length > 0, '每一條規則都已經套掉的話，按下去什麼都不會發生');
    // And they must match rows the statements left blank, not overwrite the
    // categories the card exports supplied.
    for (const c of planned) assert.equal(c.from, '', `${c.id} 本來就有分類了`);
  });
});

// --- reading the seeded book ----------------------------------------------

function rows(db) {
  return {
    accounts: db.prepare('SELECT id, name, currency, kind, opening_balance, opening_date, is_active FROM accounts').all(),
    txns: db.prepare('SELECT account_id, date, amount, description, category, kind, transfer_group FROM txns ORDER BY date').all(),
  };
}

function load(db) {
  const { accounts } = rows(db);
  const totals = db.prepare('SELECT account_id, SUM(amount) AS total FROM txns GROUP BY account_id').all();
  return M.computeAccountsWithBalances({ accounts, totals });
}

function coverage(db) {
  const { accounts } = rows(db);
  const activity = db
    .prepare(
      `SELECT account_id, substr(date, 1, 7) AS month, COUNT(*) AS n, SUM(amount) AS net
         FROM txns GROUP BY account_id, month`
    )
    .all();
  const imports = db.prepare('SELECT account_id, date_from, date_to, period_kind FROM imports').all();
  const checks = db
    .prepare('SELECT account_id, date FROM balance_checks')
    .all()
    .map((c) => ({ ...c, ok: true }));
  return M.computeCoverage({ accounts, activity, checks, imports, to: TO, months: DEMO_MONTHS });
}
