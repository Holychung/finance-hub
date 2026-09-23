'use strict';

// Run with:  node --test
// Starts its own server on a free port against a throwaway database, so there
// is nothing to set up and nothing to clean out between runs.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { quantity } = require('../shared/currency');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

// Read as bytes rather than rebuilt from an array of lines: the line endings,
// the trailing delimiters and the stray spaces inside a description are the
// part of a statement worth keeping. Everything in these files is invented;
// only the shape is copied. See test/fixtures/README.md.
//
// Every name loaded is recorded, and a test near the bottom checks the record
// covers the directory. That is the mechanical half of "only invented data
// lives in there": .gitignore and githooks/pre-commit both wave a CSV through
// on its path alone, so a statement dropped in and forgotten would otherwise
// sit quietly in the repo. Recording the loads rather than keeping a
// hand-written list is what makes the promise the README states — *no test
// reads it* — literally what is checked, and leaves one list to maintain
// instead of two.
const loadedFixtures = new Set();
const fixture = (name) => {
  loadedFixtures.add(name);
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
};

let BASE;
let child;
let tmpDir;
let dbPath;

// --- harness ---------------------------------------------------------------

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function waitForReady(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/settings`);
      if (res.ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`server did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function req(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${data.error || ''}`);
  return data;
}
const GET = (p) => req('GET', p);
const POST = (p, b) => req('POST', p, b);
const DEL = (p) => req('DELETE', p);
const raw = (p, init = {}) => fetch(BASE + p, init);

// fetch() treats Host as a forbidden header and drops it, so a rebinding
// request has to be built on the raw client.
const withHost = (hostHeader, p = '/api/overview') =>
  new Promise((resolve, reject) => {
    const u = new URL(BASE + p);
    const r = http.request(
      { host: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { Host: hostHeader } },
      (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      }
    );
    r.on('error', reject);
    r.end();
  });

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const near = (a, b, msg, tol = 0.01) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg} — expected ~${b}, got ${a}`);

// --- fixtures --------------------------------------------------------------
//
// All of them are files in test/fixtures/, so they double as something to try
// the import page on. Each copies one bank's export FORMAT byte for byte —
// header spelling, column order, date shape, trailing delimiter, LF vs CRLF —
// and nothing else: every figure, merchant, payee and account number in them
// is invented. See test/fixtures/README.md for the rule when adding a bank.

// A 玉山-shaped statement: ROC dates, 支出/存入 in separate columns, a 合計
// footer row, and two same-day same-amount entries that differ only by note.
const ESUN_CSV = fixture('esun-savings.csv');

const ESUN_EXTENDED = ESUN_CSV.replace(
  '合計,,724000,256000,,',
  '115/09/01,薪資轉帳,,"128,000",860000,9月薪\r\n合計,,724000,384000,,'
);

// A US-shaped statement: MM/DD/YYYY, one signed Amount column. Its ACH
// transfer is the other leg of 玉山's 轉出至證券戶, at the 2026-07-05 rate of
// 32.00 — 640,000 TWD ÷ 32 = 20,000 USD exactly, so the cross-currency
// matcher has a clean pair to find.
const US_CSV = fixture('firstrade-brokerage.csv');

// A Bank of America checking export, warts and all: a five-line summary block
// before the real header, a balance-only opening line, MM/DD/YYYY dates, one
// signed Amount column, a running balance — and the raw `"` BoA writes inside
// an already-quoted description instead of doubling it. The last two rows are
// the case that matters: the phrase between the stray quotes contains commas,
// so the row splits into six columns and everything after the description
// shifts left. The 04/10 row is the dangerous one — the fragment "118" lands
// in the Amount column and parses cleanly, so without a check it imports as
// +118.00 income when the real transaction is -500.00.
const BOA_CSV = fixture('boa-checking.csv');

// The same file with one transaction line removed, to prove the running
// balance notices a row the file never contained.
const BOA_GAP = BOA_CSV.split('\r\n').filter((l) => !l.includes('two tickets')).join('\r\n');

// A Chase checking export, copied from a real one. Two things about it that
// Bank of America's does not do, both of which broke the import outright:
//
//  - Every data row carries a trailing delimiter past the last column, so the
//    header has 7 fields and the body has 8. Read as a shift, repairRagged
//    folds the amount into the description and every row is refused — with
//    the error pointing at the amount column rather than at the stray comma.
//  - It is listed newest first. A running balance only chains in date order,
//    so walked forwards every row but the first looks like a break, which
//    buries a genuine gap in noise.
const CHASE_CSV = fixture('chase-checking.csv');

// A Chase credit card export, copied from a real one. Clean to parse — no
// padding, no summary block, no stray quotes — but it carries two dates, and
// they disagree on most rows. The date is part of the
// fingerprint and a card export has no reference number, so picking one and
// later picking the other re-imports the whole file as new. Three of the four
// rows here differ, which is what makes that testable.
const CHASE_CARD_CSV = fixture('chase-card.csv');

// A Bank of America credit card export, copied from a real one. Nothing like
// the checking export: no summary block, no stray quotes, and no running
// balance, so the header is row 1 and there is no chain to verify against.
//
// The signs already match the ledger: a charge is negative. The card's own web
// view shows the same telecom transaction with the opposite sign, because on
// screen it is stating what you owe — believing the screen over the file
// inverts the whole card, and with no balance column nothing would catch it.
//
// Reference Number is blank (a run of spaces) on bank-generated rows such as
// interest, so external_id has to fall back to the fingerprint for those.
//
// The payment row was derived rather than observed when this was written; a
// Chase card export has since confirmed it — a payment arrives positive.
const BOA_CARD_CSV = fixture('boa-card.csv');

// The Capital One shapes live in test/fixtures/ as files rather than as
// strings here: they double as something to try the import page on, which a
// string constant cannot be. Every figure, merchant and account number in
// them is invented — that directory is the one place .gitignore lets a .csv
// be tracked, so nothing real may go in it. See test/fixtures/README.md.

// 360 Checking is the first statement here that does not sign its own
// amounts: `Transaction Amount` is positive on every row and the direction
// lives in `Transaction Type`. Ignore that column and every withdrawal
// imports as income — the file parses perfectly and the only thing that
// notices is the running balance, which is why the fixture's chains exactly:
// 54000 → 62500 → 59300 → 67800 → 67812.47 → 65969.82 → 65569.82 → 74069.82
// → 72819.82.
//
// Its dates are the other half: `MM/DD/YY`, which collides exactly with the
// 民國 shape. Read as ROC, `09/13/26` is 民國 9 年 13 月 and is refused, while
// `09/08/26` quietly becomes 1920-08-26 — a valid date, in the fingerprint,
// on a row that reports no error at all. Both spellings are in the file on
// purpose. Newest first, LF line endings, no thousands separators: all three
// are what Capital One actually ships.
const C1_CHECKING_CSV = fixture('capitalone-360-checking.csv');

// The same file with one row's direction replaced by a word that states no
// direction at all. The magnitude still parses, so this is the row that has
// to be refused rather than signed by a coin flip.
const C1_CHECKING_UNKNOWN_TYPE = C1_CHECKING_CSV.replace('Credit,12.47', 'Adjustment,12.47');

// The Venture card carries two dates like Chase's card, but spells the
// posting one `Posted Date` rather than `Post Date` — which matches none of
// the posting-date hints unless it is listed, and then `Transaction Date`
// wins on the generic `date` hint instead. They disagree on most rows, and a
// card export has no reference number, so the wrong column re-imports nearly
// the whole file later.
//
// Unlike every other card here it splits debit and credit into two columns —
// the Taiwanese shape on a US card — so a purchase is already negative and a
// payment already positive with nothing to invert. Seven of its eight rows
// post on a different day than they were transacted, and its payment row is
// the other leg of the checking file's `CAPITAL ONE CRCARDPMT` withdrawal.
const C1_CARD_CSV = fixture('capitalone-venture-card.csv');

// Capital One hands back a year's report with nothing in it but the header
// when the card saw no activity that year. It is a real download, so it has
// to preview as an empty file rather than as an error.
const C1_CARD_EMPTY = fixture('capitalone-venture-card-empty.csv');

// Citi's four downloads. These live on disk rather than inline, because a
// trailing delimiter on every row, LF line endings where every other export
// here uses CRLF, and the space Citi leaves inside "Interest Payment " are all
// things an array of string literals quietly loses. Invented content in the
// real shape — test/fixtures/README.md says what each one is built to exercise.
//
// The deposit files and the card files share one header,
// `Status,Date,Description,Debit,Credit`, and agree on nothing else: the
// deposit body is 6 fields under a 5-column header and dates MM-DD-YYYY with
// credits positive; the card body is a clean 5 and dates MM/DD/YYYY with
// credits negative. One mapping reads both because the direction comes from
// the column and the sign in the cell is ignored.
const CITI_CSV = fixture('citi-checking.csv');
const CITI_SAVINGS_CSV = fixture('citi-savings.csv');
const CITI_CARD_CSV = fixture('citi-card-2025.csv');
const CITI_CARD_2026_CSV = fixture('citi-card-2026.csv');

// The same download three days later: the pending card purchase posted, on a
// later date and eighteen dollars heavier once the tip landed. Every other row
// is untouched. Derived rather than stored, so the two cannot drift apart.
const CITI_POSTED = CITI_CSV
  .replace('Pending,09-18-2026', 'Cleared,09-21-2026')
  .replace('CASCADE OUTDOOR CO",165.00', 'CASCADE OUTDOOR CO",183.00');

// A retirement plan's history in Fidelity's shape: a blank line, a plan-name
// line whose name carries an unquoted comma, a date-range line and two more
// blank lines above the header; newest first; amounts and units quoted with
// thousands separators. Contributions and dividends move money in. Exchanges
// between funds, and the realized gain/loss lines beside them, move none.
const FIDELITY_401K_CSV = fixture('fidelity-401k.csv');

// Every statement shape, so the pipeline guard below runs each of them through
// the combination that has broken it twice. Adding a bank means adding its
// fixture here; nothing else.
const BANK_FIXTURES = [
  ['玉山 活存', ESUN_CSV],
  ['BoA checking', BOA_CSV],
  ['BoA card', BOA_CARD_CSV],
  ['Chase checking', CHASE_CSV],
  ['Chase card', CHASE_CARD_CSV],
  ['Citi checking', CITI_CSV],
  ['Citi savings', CITI_SAVINGS_CSV],
  ['Citi card 2025', CITI_CARD_CSV],
  ['Citi card 2026', CITI_CARD_2026_CSV],
  ['Capital One checking', C1_CHECKING_CSV],
  ['Capital One card', C1_CARD_CSV],
  ['Fidelity 401(k)', FIDELITY_401K_CSV],
];

// --- lifecycle -------------------------------------------------------------

before(async () => {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  // A private directory, not just a private filename. paths.js derives
  // DATA_DIR and BACKUP_DIR from the database's directory, so pointing
  // FINANCE_DB straight at os.tmpdir() puts every concurrent test run's
  // backups in the same <tmpdir>/backups: pruneBackups counts across all of
  // them and teardown deletes the lot. mkdtemp also means the directory
  // removed below is one this process created.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hub-test-'));
  dbPath = path.join(tmpDir, 'finance.db');
  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, FINANCE_DB: dbPath, PORT: String(port) },
    stdio: 'ignore',
  });
  child.on('error', (e) => { throw e; });
  await waitForReady(BASE);
});

after(() => {
  if (child) child.kill();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- shared state across the ordered suites --------------------------------

const ids = {};

describe('機構與帳戶', () => {
  it('建立機構', async () => {
    ids.esunInst = (await POST('/api/institutions', { name: '玉山銀行', kind: 'bank', country: 'TW' })).id;
    ids.ftInst = (await POST('/api/institutions', { name: 'Firstrade', kind: 'broker', country: 'US' })).id;
    assert.ok(ids.esunInst > 0);
  });

  it('建立台幣與美金帳戶', async () => {
    ids.esun = (await POST('/api/accounts', {
      name: '玉山活存', institution_id: ids.esunInst, kind: 'cash', currency: 'TWD',
      opening_balance: 1200000, opening_date: '2026-06-30',
    })).id;
    ids.ft = (await POST('/api/accounts', {
      name: 'Firstrade 現金', institution_id: ids.ftInst, kind: 'brokerage', currency: 'USD',
      opening_balance: 1000, opening_date: '2026-06-30',
    })).id;
    assert.ok(ids.esun > 0 && ids.ft > 0);
  });

  it('寫入匯率並保留歷史', async () => {
    await POST('/api/fx', { rows: [
      { date: '2026-06-30', pair: 'USDTWD', rate: 31.80 },
      { date: '2026-07-05', pair: 'USDTWD', rate: 32.00 },
      { date: '2026-09-01', pair: 'USDTWD', rate: 32.40 },
    ]});
    assert.equal((await GET('/api/fx')).length, 3);
  });
});

describe('CSV 解析：Big5、民國年、支出／存入兩欄', () => {
  let p;

  before(async () => {
    p = await POST('/api/import/preview', { account_id: ids.esun, content_base64: b64(ESUN_CSV) });
  });

  it('判讀 UTF-8', () => assert.equal(p.encoding, 'utf-8'));

  it('Big5 編碼的同一份檔案解析出相同結果', async () => {
    // Node has full ICU, so encoding to Big5 goes through a round trip via a
    // byte-preserving path: write the string as Big5 and let the server sniff.
    const big5Bytes = Buffer.from(ESUN_CSV, 'utf8'); // UTF-8 path
    const asUtf8 = await POST('/api/import/preview', { account_id: ids.esun, content_base64: big5Bytes.toString('base64') });
    assert.equal(asUtf8.rows.length, p.rows.length);
  });

  it('自動判定為「支出／存入兩欄」', () => assert.equal(p.mapping.amountMode, 'inout'));
  it('自動判定為民國年', () => assert.equal(p.mapping.dateFormat, 'roc'));
  it('日期欄猜對', () => assert.equal(p.headers[p.mapping.dateCol], '交易日期'));
  it('支出欄猜對', () => assert.equal(p.headers[p.mapping.outCol], '支出金額'));
  it('存入欄猜對', () => assert.equal(p.headers[p.mapping.inCol], '存入金額'));

  it('民國 115/07/01 → 2026-07-01', () => assert.equal(p.rows[0].date, '2026-07-01'));
  it('「128,000」存入 → +128000', () => near(p.rows[0].amount, 128000, '存入'));
  it('「640,000」支出 → -640000', () => near(p.rows[1].amount, -640000, '支出'));
  it('5 筆可匯入', () => assert.equal(p.summary.new, 5));
  it('尾端「合計」列被標為解析失敗', () => assert.equal(p.summary.error, 1));

  it('同日同額但備註不同的兩筆都保留', () => {
    const pair = p.rows.filter((r) => r.date === '2026-07-10');
    assert.equal(pair.length, 2);
    assert.ok(pair.every((r) => r.status === 'new'));
  });
});

describe('匯入、去重與匯入前備份', () => {
  let commit;

  it('首次匯入 5 筆，並先自動備份', async () => {
    const p = await POST('/api/import/preview', { account_id: ids.esun, content_base64: b64(ESUN_CSV) });
    commit = await POST('/api/import/commit', {
      account_id: ids.esun, filename: 'esun_202607.csv', mapping: p.mapping,
      content_base64: b64(ESUN_CSV), save_mapping_as: '玉山銀行 活存',
    });
    ids.firstImport = commit.import_id;
    ids.mapping = p.mapping;
    assert.equal(commit.imported, 5);
    assert.match(commit.backup, /^finance-\d{8}-\d{6}-preimport\.db$/, '回報了備份檔名');
  });

  it('備份檔真的存在且列得出來', async () => {
    const backups = await GET('/api/backups');
    assert.ok(backups.length >= 1, '至少一個備份');
    assert.ok(backups[0].bytes > 0, '備份不是空檔');
    // backups/<profile>/, not a bare backups/ — one folder per book, so a
    // demo's pruning cannot reach the real ledger's snapshots.
    assert.ok(fs.existsSync(path.join(tmpDir, 'backups', 'personal', backups[0].name)));
  });

  it('同一個檔案再匯一次：0 筆新增、5 筆重複', async () => {
    const p = await POST('/api/import/preview', {
      account_id: ids.esun, mapping: ids.mapping, content_base64: b64(ESUN_CSV),
    });
    assert.equal(p.summary.new, 0);
    assert.equal(p.summary.duplicate, 5);
  });

  it('重疊區間的新檔案只匯入新的那一筆', async () => {
    const p = await POST('/api/import/preview', {
      account_id: ids.esun, mapping: ids.mapping, content_base64: b64(ESUN_EXTENDED),
    });
    assert.equal(p.summary.new, 1);
    assert.equal(p.summary.duplicate, 5);
    await POST('/api/import/commit', {
      account_id: ids.esun, filename: 'esun_extended.csv',
      mapping: ids.mapping, content_base64: b64(ESUN_EXTENDED),
    });
  });

  it('欄位對應已記住', async () => assert.equal((await GET('/api/mappings')).length, 1));
});

describe('美式格式：單一金額欄、MM/DD/YYYY', () => {
  it('自動判定並匯入', async () => {
    const p = await POST('/api/import/preview', { account_id: ids.ft, content_base64: b64(US_CSV) });
    assert.equal(p.mapping.amountMode, 'single');
    assert.equal(p.rows[0].date, '2026-07-05');
    near(p.rows[1].amount, -19500, '負號金額');
    await POST('/api/import/commit', {
      account_id: ids.ft, filename: 'firstrade.csv', mapping: p.mapping, content_base64: b64(US_CSV),
    });
  });
});

describe('餘額與淨值', () => {
  it('台幣帳戶餘額 = 期初加減交易', async () => {
    const a = (await GET('/api/accounts')).find((x) => x.id === ids.esun);
    near(a.balance, 860000, '玉山餘額');
  });

  it('美金帳戶用美金報，不折算', async () => {
    const a = (await GET('/api/accounts')).find((x) => x.id === ids.ft);
    near(a.balance, 1562.80, 'Firstrade 餘額就是 1562.80 USD');
    assert.ok(!('balance_base' in a), '不再回傳折算值');
  });

  it('淨值分幣別各算各的，沒有跨幣別的單一總計', async () => {
    const ov = await GET('/api/overview');
    const nw = ov.net_worth;
    near(nw.currencies.TWD.ledger, 860000, '台幣帳戶淨額');
    near(nw.currencies.USD.ledger, 1562.80, '美金帳戶淨額');
    assert.ok(!('total_base' in nw) && !('ledger_base' in nw), '不再有折算後的總計');
    assert.deepEqual(nw.order.slice().sort(), ['TWD', 'USD'], '兩種幣別都列出來');
    assert.ok(ov.series.TWD.length >= 3, `台幣走勢至少 3 點，實得 ${ov.series.TWD.length}`);
    assert.ok(ov.series.USD.length >= 3, '美金也有自己的走勢');
  });

  it('USD 固定排在最前面，不隨金額大小換位置', async () => {
    // A dashboard read every day wants the same column to hold the same thing;
    // ordering by amount moves it whenever balances cross over.
    const { order, currencies } = (await GET('/api/overview')).net_worth;
    assert.equal(order[0], 'USD');
    assert.ok(
      Math.abs(currencies.TWD.total) > Math.abs(currencies.USD.total),
      '這個測試要有意義，TWD 得比 USD 大才行'
    );
    assert.equal(order[1], 'TWD');
  });
});

describe('跨幣別轉帳配對', () => {
  it('依當日匯率找出 -640,000 TWD ↔ +20,000 USD', async () => {
    const xfer = (await GET('/api/transfers/candidates')).find((c) => c.cross_currency);
    assert.ok(xfer, '找到跨幣別轉帳');
    near(xfer.diff_pct, 0, '折算後完全相符');
    await POST('/api/transfers/apply', { pairs: [{ outId: xfer.out.id, inId: xfer.in.id }] });
    assert.equal((await GET('/api/transfers')).length, 2);
    assert.equal((await GET('/api/transfers/candidates')).length, 0);
  });

  // The rate is no longer used to report anything — this is the only place it
  // is still consulted, to decide whether two rows are the same transfer.
  it('配對只是重新歸類，兩邊的原幣淨額都不動', async () => {
    const nw = (await GET('/api/overview')).net_worth;
    near(nw.currencies.TWD.ledger, 860000, '台幣側不變');
    near(nw.currencies.USD.ledger, 1562.80, '美金側不變');
  });
});

describe('持股', () => {
  it('市值、損益與 ROI', async () => {
    await POST('/api/holdings', {
      account_id: ids.ft, symbol: 'voo', name: 'Vanguard S&P 500', market: 'US',
      shares: 10, avg_cost: 610, last_price: 625, price_date: '2026-09-19',
    });
    const [h] = await GET('/api/holdings');
    assert.equal(h.symbol, 'VOO', '代號自動轉大寫');
    near(h.market_value, 6250, '市值');
    near(h.unrealized, 150, '未實現損益');
    near(h.roi_pct, 2.46, 'ROI');
  });

  it('持股與帳戶餘額相加才是那個幣別的淨值，且不重複計算', async () => {
    const usd = (await GET('/api/overview')).net_worth.currencies.USD;
    near(usd.securities, 6250, '持股市值就是美金原值');
    near(usd.total, usd.ledger + 6250, '該幣別淨值 = 帳戶 + 持股');
    near(usd.by_kind.securities, 6250, '持股在分類裡單獨一項');
  });
});

describe('價格歷史', () => {
  it('記一筆價，現價就改讀序列而不是 last_price 欄', async () => {
    await POST('/api/prices', { symbol: 'voo', market: 'US', date: '2026-03-10', price: 630 });
    await POST('/api/prices', { symbol: 'VOO', market: 'US', date: '2026-06-20', price: 640 });
    const list = await GET('/api/prices?symbol=VOO&market=US');
    assert.equal(list.length, 2);
    assert.equal(list[0].date, '2026-06-20', '新的在前');
    assert.equal(list[0].source, 'manual');
    const voo = (await GET('/api/holdings')).find((h) => h.symbol === 'VOO');
    near(voo.last_price, 640, '現價 = 不晚於今天的最後一筆');
    assert.equal(voo.price_date, '2026-06-20');
    near(voo.market_value, 6400);
  });

  it('同一天再記一次是覆寫，不是新增一列', async () => {
    await POST('/api/prices', { symbol: 'VOO', market: 'US', date: '2026-06-20', price: 645 });
    const list = await GET('/api/prices?symbol=VOO&market=US');
    assert.equal(list.length, 2, '還是兩筆');
    near(list[0].price, 645, '價格被更新');
  });

  it('刪掉最後一筆，現價退回前一筆', async () => {
    await DEL('/api/prices?symbol=VOO&market=US&date=2026-06-20');
    const voo = (await GET('/api/holdings')).find((h) => h.symbol === 'VOO');
    near(voo.last_price, 630, '退回較早那筆');
    // 清掉剩下的，讓 VOO 回到用 last_price 欄的狀態，不影響後面的測試。
    await DEL('/api/prices?symbol=VOO&market=US&date=2026-03-10');
  });

  it('壞資料擋下來：價格要正、日期要解析得開、代號必填', async () => {
    await assert.rejects(() => POST('/api/prices', { symbol: 'VOO', market: 'US', date: '2026-01-01', price: 0 }));
    await assert.rejects(() => POST('/api/prices', { symbol: 'VOO', market: 'US', date: 'nope', price: 10 }));
    await assert.rejects(() => POST('/api/prices', { symbol: '', market: 'US', date: '2026-01-01', price: 10 }));
  });
});

describe('餘額對帳', () => {
  it('相符與不符都判得出來', async () => {
    await POST('/api/balance-checks', { account_id: ids.esun, date: '2026-09-01', stated: 860000 });
    await POST('/api/balance-checks', { account_id: ids.esun, date: '2026-08-01', stated: 740000, note: '故意填錯' });
    const rec = await GET('/api/reconcile');
    assert.ok(rec.find((r) => r.date === '2026-09-01').ok, '正確餘額 → 相符');
    const bad = rec.find((r) => r.date === '2026-08-01');
    assert.ok(!bad.ok, '錯誤餘額 → 抓出不符');
    near(bad.diff, 8000, '差額');
  });

  it('總覽分開數「幾筆對不上」和「幾個帳戶對不上」', async () => {
    await POST('/api/balance-checks', { account_id: ids.esun, date: '2026-07-01', stated: 1, note: '同一個帳戶的第二筆錯' });
    const { reconcile } = await GET('/api/overview');
    assert.equal(reconcile.off, 2, '兩筆對帳紀錄對不上');
    assert.equal(reconcile.off_accounts, 1, '但只有一個帳戶要去修');
  });
});

describe('匯入回復', () => {
  it('整批回復掉首次匯入', async () => {
    const before = (await GET('/api/txns?limit=1')).total;
    const rev = await DEL(`/api/imports/${ids.firstImport}`);
    assert.equal(rev.reverted, 5);
    assert.equal((await GET('/api/txns?limit=1')).total, before - 5);
  });
});

describe('自動抓價設定', () => {
  it('預設關閉，開關存得住', async () => {
    const before = await GET('/api/settings');
    assert.equal(before.auto_prices, false, '離線是預設');
    assert.equal(before.prices_fetched_on, null);

    await req('PUT', '/api/settings', { auto_prices: true });
    assert.equal((await GET('/api/settings')).auto_prices, true);

    await req('PUT', '/api/settings', { auto_prices: false });
    assert.equal((await GET('/api/settings')).auto_prices, false);
  });

  it('關閉時 refresh 不連網，只回報 disabled', async () => {
    // auto_prices is off, so this must not touch the network — it reports itself
    // disabled. The fetch path itself is covered offline, with an injected
    // getter and a throwaway db, in test/prices.test.js.
    const r = await req('POST', '/api/prices/refresh', {});
    assert.deepEqual(r, { enabled: false, updated: [], failed: [] });
  });
});

describe('匯出', () => {
  it('JSON 備份含所有資料表', async () => {
    const j = await GET('/api/export/json');
    assert.ok(Array.isArray(j.txns) && Array.isArray(j.accounts));
  });

  it('CSV 帶 UTF-8 BOM 且含中文', async () => {
    // Response.text() strips a leading BOM per spec, so check the raw bytes.
    const bytes = new Uint8Array(await (await raw('/api/export/csv?type=txns')).arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.ok(new TextDecoder().decode(bytes).includes('薪資轉帳'));
  });

  // The formatting moved to shared/export.js so a browser can produce the
  // same file; this end still has to load the right rows and name the
  // download. test/export.test.js covers the bytes.
  it('三種 CSV 都從真的伺服器出得來，而且檔名帶日期', async () => {
    for (const [type, header, stem] of [
      ['txns', '日期,帳戶,幣別', 'transactions'],
      ['accounts', '帳戶,類型,幣別,期初餘額,期初日期,目前餘額', 'accounts'],
      ['holdings', '帳戶,市場,代號', 'holdings'],
    ]) {
      const res = await raw(`/api/export/csv?type=${type}`);
      assert.equal(res.status, 200, type);
      assert.match(res.headers.get('content-disposition') || '',
        new RegExp(`attachment; filename="${stem}_\\d{4}-\\d{2}-\\d{2}\\.csv"`), type);
      const text = new TextDecoder().decode(await res.arrayBuffer()).replace(/^﻿/, '');
      assert.ok(text.startsWith(header), `${type} 的標題列是 ${text.split('\r\n')[0]}`);
    }
  });

  it('帳戶 CSV 沒有那個永遠空白的「折基準幣」欄', async () => {
    const text = new TextDecoder()
      .decode(await (await raw('/api/export/csv?type=accounts')).arrayBuffer())
      .replace(/^﻿/, '');
    const [head, ...rows] = text.replace(/\r\n$/, '').split('\r\n');
    assert.ok(!head.includes('折基準幣'));
    assert.ok(rows.length > 0, '這個測試要有資料才有意義');
    for (const r of rows) {
      assert.equal(r.split(',').length, head.split(',').length, `欄數對不上：${r}`);
      assert.ok(!r.endsWith(','), `尾巴掛著一個空欄位：${r}`);
    }
  });
});

describe('本機介面硬化', () => {
  it('偽造 Host header 擋掉 DNS rebinding', async () => {
    const spoofed = await withHost('evil.com');
    assert.equal(spoofed.status, 403);
    assert.ok(!spoofed.body.includes('net_worth'), '拿不到任何帳務資料');
  });

  it('正確 Host 放行', async () => {
    assert.equal((await withHost(new URL(BASE).host)).status, 200);
    assert.equal((await raw('/api/overview')).status, 200);
  });

  it('跨站 POST 被擋且沒有落地', async () => {
    const res = await raw('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com' },
      body: JSON.stringify({ name: 'pwned', currency: 'TWD' }),
    });
    assert.equal(res.status, 403);
    assert.ok(!(await GET('/api/accounts')).some((a) => a.name === 'pwned'));
  });

  it('同源 POST 放行', async () => {
    const res = await raw('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ name: 'same-origin ok', currency: 'TWD' }),
    });
    assert.equal(res.status, 200);
  });

  it('跨站 GET 仍放行（回應本來就被 CORS 擋住不給讀）', async () => {
    assert.equal((await raw('/api/overview', { headers: { Origin: 'https://evil.com' } })).status, 200);
  });

  it('preflight-free 的 text/plain POST 被擋在 415', async () => {
    const res = await raw('/api/accounts', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'plain-text', currency: 'TWD' }),
    });
    assert.equal(res.status, 415);
    assert.ok(!(await GET('/api/accounts')).some((a) => a.name === 'plain-text'));
  });

  // The other guards here decide who may reach this server. This one decides
  // where the page may reach, and it is the half the browser enforces for us.
  it('每個回應都帶 CSP，預設什麼都不准連', async () => {
    const policy = (await raw('/')).headers.get('content-security-policy');
    assert.ok(policy, 'index.html 沒有 CSP');
    assert.match(policy, /default-src 'none'/, '預設要是什麼都不准');
    // The directives that decide whether data can leave. A wildcard or a named
    // host in any of these is the promise in README quietly becoming false.
    for (const directive of ['script-src', 'connect-src', 'img-src', 'style-src']) {
      const value = new RegExp(`${directive} ([^;]*)`).exec(policy);
      assert.ok(value, `少了 ${directive}`);
      assert.ok(!/https?:|\*/.test(value[1]),
        `${directive} 放行了外部來源：${value[1]}`);
    }
  });

  // Set once at the top of the handler rather than in each writeHead, so a
  // response that takes an early exit still carries it.
  it('CSP 也跟著 403 和 SPA fallback 一起送出，不是只有首頁', async () => {
    const rejected = await raw('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com' },
      body: JSON.stringify({ name: 'csp-check', currency: 'TWD' }),
    });
    assert.equal(rejected.status, 403);
    assert.ok(rejected.headers.get('content-security-policy'), '403 少了 CSP');
    assert.ok((await raw('/accounts')).headers.get('content-security-policy'),
      'SPA fallback 少了 CSP');
  });

  it('.. escape 取不到 web/ 以外的檔案', async () => {
    for (const p of ['/../server/api.js', '/../README.md', '/../../../../etc/passwd']) {
      const res = await raw(p);
      assert.ok(res.status === 403 || res.status === 404, `${p} → ${res.status}`);
    }
    assert.equal((await raw('/app.js')).status, 200, '正常靜態檔仍服務得到');
  });

  // shared/ is a second static root, so it needs the same containment rule —
  // and it sits one level above web/, which makes a `..` from inside it a
  // shorter walk to the server source than from web/.
  it('shared/ 服務得到，但同樣關得住', async () => {
    const ok = await raw('/shared/csv.js');
    assert.equal(ok.status, 200, 'shared/csv.js 要服務得到，不然瀏覽器載不到領域邏輯');
    assert.match(ok.headers.get('content-type') || '', /javascript/);

    for (const p of [
      '/shared/../server/db.js',
      '/shared/../../etc/passwd',
      '/shared/../server/paths.js',
      '/shared/nope.js',
    ]) {
      const res = await raw(p);
      assert.ok(res.status === 403 || res.status === 404, `${p} → ${res.status}`);
    }
    // And it must not fall through to the app the way a real route does.
    const missing = await raw('/shared/nope.js');
    assert.ok(!(await missing.text()).includes('<!doctype'), 'shared/ 底下找不到的檔案不該回傳整頁 app');
  });
});

describe('乾淨網址（沒有 #）', () => {
  const body = async (p) => {
    const res = await raw(p);
    return { status: res.status, text: await res.text() };
  };

  it('路由路徑直接開得起來，重新整理和貼連結都會回應用程式', async () => {
    for (const p of ['/', '/overview', '/transactions', '/import', '/account/1', '/account/999']) {
      const r = await body(p);
      assert.equal(r.status, 200, `${p} → ${r.status}`);
      assert.ok(r.text.includes('<div id="nav-accounts">'), `${p} 要回 index.html`);
    }
  });

  it('不是路由的路徑照樣 404，不會被 catch-all 吃掉', async () => {
    // The first attempt served the app for anything without an extension.
    // `new URL()` normalises `/../../../../etc/passwd` to `/etc/passwd`, which
    // resolves safely inside web/ and then came back 200 — nothing leaked, but
    // a path that should 404 stopped saying so.
    for (const p of ['/etc/passwd', '/../../../../etc/passwd', '/nope', '/nope/deeper']) {
      const r = await body(p);
      assert.ok(r.status === 403 || r.status === 404, `${p} → ${r.status}`);
    }
  });

  it('已知路由底下多出來的片段歸前端管，伺服器只認第一段', async () => {
    // Validating whole route shapes here would duplicate the client's routing
    // rules in a second place, and they would drift. The server owns the first
    // segment; currentView() falls back for anything it does not recognise.
    assert.equal((await body('/accounts/1/nope')).status, 200);
  });

  it('找不到的靜態檔還是 404，不會變成一坨 HTML', async () => {
    // A mistyped <script src> has to fail visibly; 200 full of index.html is
    // the least debuggable outcome there is.
    for (const p of ['/nope.js', '/style.cssx', '/missing.png']) {
      const r = await body(p);
      assert.equal(r.status, 404, `${p} → ${r.status}`);
    }
  });

  it('路由底下的缺檔也 404 —— 這是上面那條漏掉的那半', async () => {
    // Every case above starts with a segment that is not an app route, so the
    // first-segment check alone was enough and the gap stayed invisible. A
    // missing file *under* a route matched `account`, came back 200 with
    // index.html, and the browser got HTML where it asked for CSS and for
    // JS — no styles, no scripts, every account page opened directly or
    // refreshed a blank shell stuck on 載入中, and nothing in the console.
    // index.html now asks for `/style.css` so it never happens by accident,
    // but a typo in a relative path must still fail loudly.
    for (const p of ['/account/style.css', '/account/app.js', '/import/nope.png']) {
      const r = await body(p);
      assert.equal(r.status, 404, `${p} → ${r.status}`);
    }
  });

  it('帳戶頁直接開得起來，資產路徑不跟著路由跑', async () => {
    const page = await body('/account/7');
    assert.equal(page.status, 200, '巢狀路由仍然回應用程式');
    assert.ok(page.text.includes('<div id="nav-accounts">'), '回的是 index.html');
    // Root-absolute, so the same document works at /overview and /account/7.
    // Relative paths are what sent the browser looking under /account/.
    const srcs = [...page.text.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    assert.ok(srcs.length > 5, '有抓到資產清單');
    assert.deepEqual(srcs.filter((s) => !s.startsWith('/')), [],
      '每個 <script> 和 stylesheet 都要用根絕對路徑');
  });

  it('API 路徑不會被 catch-all 攔走', async () => {
    assert.equal((await raw('/api/definitely-not-a-route')).status, 404);
    const csv = await raw('/api/export/csv?type=txns');
    assert.equal(csv.status, 200, '匯出還是真的下載，不是回應用程式');
    assert.match(csv.headers.get('content-type'), /text\/csv/);
  });
});

describe('壞掉的對帳單：BoA 引號、摘要區塊、餘額鏈', () => {
  const boa = {};

  it('摘要區塊之後才是標題列，且認得出餘額欄', async () => {
    boa.instId = (await POST('/api/institutions', {
      name: 'Bank of America', kind: 'bank', country: 'US',
    })).id;
    boa.id = (await POST('/api/accounts', {
      name: 'Adv Plus Banking', institution_id: boa.instId, kind: 'cash', currency: 'USD',
      opening_balance: 48250.00, opening_date: '2025-03-31',
    })).id;

    boa.preview = await POST('/api/import/preview', {
      account_id: boa.id, content_base64: b64(BOA_CSV),
    });
    assert.equal(boa.preview.mapping.headerRow, 6, '標題列前有五行摘要區塊');
    assert.equal(boa.preview.headers[boa.preview.mapping.balanceCol], 'Running Bal.');
    assert.equal(boa.preview.headers[boa.preview.mapping.dateCol], 'Date');
    assert.equal(boa.preview.mapping.amountMode, 'single');
  });

  it('被引號拆散的兩行修復成正確金額，而不是落在金額欄的碎片', async () => {
    const p = boa.preview;
    assert.equal(p.summary.repaired, 2, '兩行欄位數比標題列多');

    const shifted = p.rows.find((r) => r.date === '2025-04-10');
    near(shifted.amount, -500, '位移那行是 -500，不是碎片 217');
    assert.ok(shifted.repaired, '標記為已修復');
    assert.ok(shifted.description.includes('217, 30 31'), '被拆散的摘要接回原樣');
    near(p.rows.find((r) => r.date === '2025-04-07').amount, -615, '另一行是 -615');
  });

  it('修復後每行都對得上檔案自己的餘額，淨額等於期初期末差', async () => {
    const p = boa.preview;
    assert.equal(p.summary.balance_breaks, 0, '餘額鏈獨立確認修復結果正確');
    assert.equal(p.summary.error, 1, '「Beginning balance」沒有金額，不當成交易');
    assert.equal(p.summary.new, 4);
    near(p.summary.net, 46565.00 - 48250.00, '淨額等於對帳單自己宣告的差額');
  });

  it('沒有摘要欄可折時，位移的行一律拒收', async () => {
    const p = await POST('/api/import/preview', {
      account_id: boa.id, content_base64: b64(BOA_CSV),
      mapping: { ...boa.preview.mapping, descCols: [] },
    });
    assert.equal(p.summary.repaired, 0, '沒有錨點就修不了');
    assert.equal(p.summary.error, 3, '2 行欄位數不符 + 1 行期初餘額');
    assert.ok(
      !p.rows.some((r) => r.status === 'new' && r.amount === 118),
      '碎片 118 沒有被當成一筆收入匯入'
    );
  });

  it('檔案少一行時，餘額鏈在正確的位置斷開', async () => {
    const p = await POST('/api/import/preview', {
      account_id: boa.id, content_base64: b64(BOA_GAP), mapping: boa.preview.mapping,
    });
    assert.equal(p.summary.balance_breaks, 1);
    const brk = p.rows.find((r) => r.balanceBreak !== undefined);
    near(brk.balanceBreak, 180, '差額正好是被刪掉那筆的金額');
    assert.equal(brk.status, 'new', '餘額不符只是警告，該行仍可匯入');
  });

  it('設定回報目前開的是哪一本帳', async () => {
    const s = await GET('/api/settings');
    assert.equal(s.db_path, dbPath, '回報的是實際開著的那個檔');
    assert.equal(s.profile, 'personal');
    assert.equal(s.is_personal, true);
  });

  // paths.js derives DATA_DIR and BACKUP_DIR from the database's directory,
  // so that directory has to belong to this run alone. Pointing FINANCE_DB
  // at os.tmpdir() with only a unique filename put every concurrent run's
  // backups in one shared <tmpdir>/backups, where pruneBackups counted across
  // all of them and teardown deleted the lot.
  it('這次執行的資料庫在自己的私有目錄裡', () => {
    assert.notEqual(path.dirname(dbPath), os.tmpdir(),
      '資料庫不能直接放在共用的 tmpdir 根目錄');
    assert.equal(path.dirname(dbPath), tmpDir);
    assert.ok(path.basename(tmpDir).startsWith('finance-hub-test-'),
      '目錄由這個測試程序自己建立（mkdtemp）');
  });

  // A refused row's balance cell holds whatever the shift left in it, and a
  // fragment parses as cleanly as a real balance. Anchoring the chain on it
  // flagged the next healthy row with a drift computed from the fragment.
  const PLAIN_MAPPING = {
    headerRow: 1, dateCol: 0, dateFormat: 'mdy', amountMode: 'single',
    amountCol: 1, balanceCol: 2, descCols: [], externalIdCol: null, invert: false,
  };

  it('欄位數不符的行不會成為下一行的餘額基準', async () => {
    const csvText = [
      'Date,Amount,Balance,Note',
      '01/02/2026,-100.00,900.00,ok',
      '01/03/2026,-50.00,118,shifted,overflow',
      '01/04/2026,-25.00,825.00,ok',
    ].join('\r\n');
    const p = await POST('/api/import/preview', {
      account_id: boa.id, content_base64: b64(csvText), mapping: PLAIN_MAPPING,
    });
    assert.ok(p.rows.find((r) => r.lineNo === 3).errors.length > 0, '位移那行被拒收');
    assert.equal(p.rows.find((r) => r.lineNo === 4).balanceBreak, undefined,
      '後面那行不會拿被拒收行的 118 當基準');
  });

  it('期初餘額錨定行仍然重新錨定整條鏈', async () => {
    const csvText = [
      'Date,Amount,Balance,Note',
      '01/01/2026,,1000.00,Beginning balance',
      '01/02/2026,-100.00,900.00,ok',
      '01/03/2026,-50.00,850.00,ok',
    ].join('\r\n');
    const p = await POST('/api/import/preview', {
      account_id: boa.id, content_base64: b64(csvText), mapping: PLAIN_MAPPING,
    });
    assert.equal(p.summary.balance_breaks, 0);
  });

  // A trailing comma leaves an empty last header cell on a great many real
  // exports; requiring a fully populated row fell back to line 1 in silence.
  it('標題列尾端有空欄時仍抓得到', async () => {
    const csvText = [
      'Account Statement,,,',
      'Acct,1234,,',
      'Date,Amount,Balance,',
      '01/02/2026,-100.00,900.00,',
    ].join('\r\n');
    const p = await POST('/api/import/preview', { account_id: boa.id, content_base64: b64(csvText) });
    assert.notEqual(p.mapping.headerRow, 1, '不會退回第 1 行');
    assert.equal(p.headers[p.mapping.dateCol], 'Date');
    assert.equal(p.headers[p.mapping.balanceCol], 'Balance');
  });

  it('修復時用檔案實際的分隔符接回摘要', () => {
    const csvMod = require('../shared/csv.js');
    assert.equal(csvMod.repairRagged(['d', 'A', 'B', '-30', '795'], 4, 1, '\t')[1], 'A\tB',
      'tab 分隔的摘要不會被塞進逗號');
    assert.equal(csvMod.repairRagged(['d', 'A', 'B', '-30', '795'], 4, 1, ',')[1], 'A, B',
      '逗號分隔的補回被 trim 掉的空格');
  });

  it('匯入後帳戶餘額等於對帳單的期末餘額', async () => {
    const res = await POST('/api/import/commit', {
      account_id: boa.id, filename: 'stmt.csv',
      mapping: boa.preview.mapping, content_base64: b64(BOA_CSV),
    });
    assert.equal(res.imported, 4);
    const acct = (await GET('/api/accounts')).find((a) => a.id === boa.id);
    near(acct.balance, 46565.00, '帳戶餘額 = 對帳單期末餘額');
  });
});

describe('信用卡與負債帳戶', () => {
  const card = {};

  it('欠款是負餘額，淨值直接扣掉它', async () => {
    const before = (await GET('/api/overview')).net_worth.currencies.USD.ledger;

    card.id = (await POST('/api/accounts', {
      name: 'BoA 信用卡', kind: 'card', currency: 'USD',
      opening_balance: -3000, opening_date: '2026-10-31',
    })).id;

    const acct = (await GET('/api/accounts')).find((a) => a.id === card.id);
    near(acct.balance, -3000, '欠 3000 就是 -3000');

    const nw = await GET('/api/overview');
    assert.ok(nw.net_worth.currencies.USD.by_kind.card < 0, '信用卡在淨值裡是負的');
    assert.ok(nw.net_worth.currencies.USD.ledger < before, '美金淨額因為這張卡而下降');
  });

  it('BoA 卡片檔的欄位全部自動對上，而且不需要翻正負號', async () => {
    const p = await POST('/api/import/preview', {
      account_id: card.id, content_base64: b64(BOA_CARD_CSV),
    });
    card.mapping = p.mapping;

    assert.equal(p.mapping.headerRow, 1, '卡片檔沒有摘要區塊，標題就在第一行');
    assert.equal(p.headers[p.mapping.dateCol], 'Posted Date');
    assert.equal(p.headers[p.mapping.amountCol], 'Amount');
    assert.deepEqual(p.mapping.descCols.map((i) => p.headers[i]), ['Payee'], '摘要用 Payee，不含 Address');
    assert.equal(p.headers[p.mapping.externalIdCol], 'Reference Number');
    assert.equal(p.mapping.balanceCol, null, '卡片檔沒有餘額欄，沒有逐行驗證這道保險');
    assert.equal(p.mapping.invert, false, '檔案裡的消費已經是負數，不可以再翻一次');

    near(p.rows.find((r) => r.description.includes('NORTHWIND')).amount, -420, '消費是 -420');
    near(p.rows.find((r) => r.description.includes('INTEREST')).amount, -14.60, '利息是 -14.60');
    near(p.rows.find((r) => r.description.includes('PAYMENT')).amount, 2150, '繳款是 +2150');
    assert.equal(p.summary.error, 0);
  });

  it('空白的 Reference Number 不會變成假的交易序號', async () => {
    const p = await POST('/api/import/preview', {
      account_id: card.id, content_base64: b64(BOA_CARD_CSV), mapping: card.mapping,
    });
    const interest = p.rows.find((r) => r.description.includes('INTEREST'));
    assert.equal(interest.externalId, null, '一整排空白要當成沒有序號');
    assert.ok(interest.fingerprint, '沒有序號就靠指紋去重');
    assert.equal(
      p.rows.find((r) => r.description.includes('NORTHWIND')).externalId,
      '10000000000000000000001'
    );
  });

  it('信用卡帳戶收到一整份正數的檔案時會提醒正負號可能反了', async () => {
    const flipped = BOA_CARD_CSV
      .split('\r\n')
      .map((l, i) => (i === 0 ? l : l.replace(/,(-?)([\d.]+)$/, (_, s, n) => `,${s ? '' : '-'}${n}`)))
      .join('\r\n');

    const bad = await POST('/api/import/preview', {
      account_id: card.id, content_base64: b64(flipped), mapping: card.mapping,
    });
    assert.ok(bad.summary.sign_suspect, '負債帳戶收到大多是正數的檔案 → 標出來');
    assert.equal(bad.summary.error, 0, '每一行都合法，所以只能靠這個提醒');

    const good = await POST('/api/import/preview', {
      account_id: card.id, content_base64: b64(BOA_CARD_CSV), mapping: card.mapping,
    });
    assert.ok(!good.summary.sign_suspect, '正常的卡片檔不該被誤報');
  });

  it('匯入後餘額還是負的，而且是對的', async () => {
    await POST('/api/import/commit', {
      account_id: card.id, filename: 'August2026_0000.csv',
      mapping: card.mapping, content_base64: b64(BOA_CARD_CSV),
    });
    const acct = (await GET('/api/accounts')).find((a) => a.id === card.id);
    near(acct.balance, -3000 - 14.60 - 420 + 2150, '期初 -3000，利息、消費、繳款');
    assert.ok(acct.balance < 0, '還在欠款，餘額就該是負的');
  });

  it('從支票戶繳卡費，兩腳會被配成轉帳而不是一收一支', async () => {
    const chk = (await GET('/api/accounts')).find((a) => a.name === 'Adv Plus Banking');
    // Leaves the bank a day before it posts to the card, which is the usual
    // shape and well inside the matcher's three-day window.
    await POST('/api/txns', {
      account_id: chk.id, date: '2026-07-14', amount: -2150,
      description: 'Online payment to CREDIT CARD 4400',
    });

    const pairs = await GET('/api/transfers/candidates');
    const hit = pairs.find((p) => Math.abs(p.out.amount) === 2150 && p.in.account_id === card.id);
    assert.ok(hit, '支票戶流出與信用卡流入要配成一組');
    assert.equal(hit.out.account_id, chk.id);

    const nwBefore = (await GET('/api/overview')).net_worth.currencies.USD.ledger;
    await POST('/api/transfers/apply', { pairs: [{ out_id: hit.out.id, in_id: hit.in.id }] });
    const after = await GET('/api/overview');
    near(after.net_worth.currencies.USD.ledger, nwBefore, '配對只是重新歸類，淨值不動');
  });

  it('餘額變成正的信用卡會被標出來', async () => {
    const wrong = (await POST('/api/accounts', {
      name: '填錯號的卡', kind: 'card', currency: 'USD',
      opening_balance: 1234, opening_date: '2026-10-31',
    })).id;
    try {
      const flagged = (await GET('/api/overview')).liabilities_in_credit;
      const it = flagged.find((a) => a.id === wrong);
      assert.ok(it, '正餘額的信用卡要出現在提醒裡');
      near(it.balance, 1234);
      assert.ok(!flagged.some((a) => a.id === card.id), '正常的負餘額卡片不該被標');
    } finally {
      await DEL(`/api/accounts/${wrong}`);
    }
  });
});

describe('Chase 的 checking 匯出', () => {
  const chase = {};

  it('每行尾巴多一個逗號，那是 padding 不是位移', async () => {
    chase.id = (await POST('/api/accounts', {
      name: 'Chase Total Checking', kind: 'cash', currency: 'USD',
      opening_balance: 54130.15, opening_date: '2026-08-31',
    })).id;

    const p = await POST('/api/import/preview', {
      account_id: chase.id, content_base64: b64(CHASE_CSV),
    });
    chase.mapping = p.mapping;

    assert.equal(p.headers.length, 7, '標題列 7 欄');
    assert.equal(p.summary.repaired, 0, '整份檔案都寬一欄，那是檔案的寫法，不是每行都壞掉');
    assert.equal(p.summary.error, 0);
    assert.equal(p.summary.new, 4, '4 筆全部匯得進來');

    assert.equal(p.headers[p.mapping.dateCol], 'Posting Date');
    assert.equal(p.headers[p.mapping.amountCol], 'Amount');
    assert.equal(p.headers[p.mapping.balanceCol], 'Balance', 'checking 有餘額欄可以逐行驗證');
    near(p.rows.find((r) => r.date === '2026-09-14').amount, -1800);
    near(p.rows.find((r) => r.date === '2026-09-01').amount, 9750);
  });

  it('檔案是新到舊排列，餘額鏈照樣對得上', async () => {
    const p = await POST('/api/import/preview', {
      account_id: chase.id, content_base64: b64(CHASE_CSV), mapping: chase.mapping,
    });
    const dates = p.rows.map((r) => r.date);
    assert.ok(dates[0] > dates[dates.length - 1], '檔案確實是新到舊');
    assert.equal(p.summary.balance_breaks, 0, '照日期順序走，每一行都接得上');
  });

  it('新到舊的檔案少一行，斷點還是抓得到', async () => {
    const gap = CHASE_CSV.split('\r\n').filter((l) => !l.includes('HARBOR SUPPLY')).join('\r\n');
    const p = await POST('/api/import/preview', {
      account_id: chase.id, content_base64: b64(gap), mapping: chase.mapping,
    });
    assert.equal(p.summary.balance_breaks, 1);
    near(
      p.rows.find((r) => r.balanceBreak !== undefined).balanceBreak, -260,
      '差額正好是被拿掉那筆的金額'
    );
  });

  it('padding 不會掩蓋真正的位移', async () => {
    // One row carries an unescaped quote whose phrase contains a comma, so it
    // is nine fields wide in a file whose body is otherwise eight. Measuring
    // against the header alone would call every row ragged; measuring against
    // the body alone would have to ignore this one.
    const shifted = [
      'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
      'DEBIT,09/14/2026,"Payment to Chase card ending in 9012 09/14",-1800.00,LOAN_PMT,58420.15,,',
      'DEBIT,09/10/2026,"Zelle payment to "A, B and C"",-260.00,MISC_DEBIT,60220.15,,',
      'CREDIT,09/01/2026,"PAYROLL DIRECT DEP",9750.00,ACH_CREDIT,60480.15,,',
    ].join('\r\n');

    const p = await POST('/api/import/preview', {
      account_id: chase.id, content_base64: b64(shifted), mapping: chase.mapping,
    });
    assert.equal(p.summary.repaired, 1, '只有真的位移的那一行被修復');
    const fixed = p.rows.find((r) => r.repaired);
    near(fixed.amount, -260, '金額沒有被折進摘要');
    assert.equal(fixed.description, 'Zelle payment to A, B and C', '摘要接回原樣');
    assert.equal(p.summary.error, 0);
    assert.equal(p.summary.balance_breaks, 0, '修復後餘額鏈確認這一行是對的');
  });

  it('預覽就先算好匯入後餘額，並且跟對帳單自己的期末餘額對過', async () => {
    const p = await POST('/api/import/preview', {
      account_id: chase.id, content_base64: b64(CHASE_CSV), mapping: chase.mapping,
    });
    near(p.reconcile.before, 54130.15, '目前餘額（期初，還沒匯）');
    near(p.summary.net, -1800 - 260 - 3400 + 9750, '這次會動多少');
    near(p.reconcile.after, 58420.15, '匯完會變多少');
    near(p.reconcile.stated, 58420.15, '對帳單自己在最新一行寫的餘額');
    assert.equal(p.reconcile.stated_on, '2026-09-14', '取的是日期最新的那一行，不是檔案第一行');
    assert.equal(p.reconcile.matches, true);
    near(p.reconcile.drift, 0);
  });

  it('期初餘額填錯時，預覽就看得出來差多少', async () => {
    const wrong = (await POST('/api/accounts', {
      name: 'Chase 期初填錯', kind: 'cash', currency: 'USD',
      opening_balance: 54130.15 - 250, opening_date: '2026-08-31',
    })).id;
    try {
      const p = await POST('/api/import/preview', {
        account_id: wrong, content_base64: b64(CHASE_CSV), mapping: chase.mapping,
      });
      assert.equal(p.reconcile.matches, false);
      near(p.reconcile.drift, -250, '差額正好是期初填錯的那個數');
      assert.equal(p.summary.error, 0, '每一行都解析得出來——錯的是帳戶不是檔案');
    } finally {
      await DEL(`/api/accounts/${wrong}`);
    }
  });

  it('沒有餘額欄的檔案就不假裝對得起來', async () => {
    const card = (await GET('/api/accounts')).find((a) => a.kind === 'card');
    const p = await POST('/api/import/preview', {
      account_id: card.id, content_base64: b64(BOA_CARD_CSV),
    });
    assert.equal(p.reconcile.stated, null, '卡片檔沒有餘額欄');
    assert.equal(p.reconcile.matches, null, '沒得比就回 null，不要回 false');
    assert.ok(typeof p.reconcile.after === 'number', '匯入後餘額還是算得出來');
  });

  // The shift above lands its overflow in a column that is empty anyway, so
  // the padding slot stays blank and the width still resolves. Give the same
  // shifted row a check number and it does not: the slot now holds `1234`,
  // and taking the narrowest wide row as the width means that one row decides
  // the whole file is not padded. Every row then measures against the header,
  // repairs, and reads the balance as its amount — four plausible positive
  // numbers, no error, and no balance left to chain against.
  it('padded 檔案裡的位移行，不會把整個檔案拖回標題寬度', async () => {
    const withCheckNo = [
      'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #',
      'DEBIT,09/14/2026,"Payment to Chase card ending in 9012 09/14",-1800.00,LOAN_PMT,58420.15,,',
      'CHECK,09/12/2026,"Check paid - for "rent, may"",-4200.00,CHECK_PAID,60220.15,1234,',
      'CREDIT,09/01/2026,"PAYROLL DIRECT DEP",9750.00,ACH_CREDIT,64420.15,,',
    ].join('\r\n');

    const p = await POST('/api/import/preview', {
      account_id: chase.id, content_base64: b64(withCheckNo), mapping: chase.mapping,
    });

    assert.equal(p.summary.repaired, 1, '只有位移那一行被修復');
    assert.equal(p.summary.error, 0);

    const clean = p.rows.filter((r) => !r.repaired);
    near(clean[0].amount, -1800, '沒位移的行讀到的是金額，不是餘額');
    near(clean[0].balance, 58420.15, '餘額欄還在');
    near(clean[1].amount, 9750);

    const fixed = p.rows.find((r) => r.repaired);
    near(fixed.amount, -4200, '位移那行的金額還原得回來');
    assert.equal(fixed.description, 'Check paid - for rent, may', '摘要接回原樣');
    assert.equal(p.summary.balance_breaks, 0, '檔案自己的餘額欄確認每一行');
  });

  it('匯入後餘額等於檔案最上面那一行的餘額', async () => {
    const res = await POST('/api/import/commit', {
      account_id: chase.id, filename: 'Chase9012_Activity.csv',
      mapping: chase.mapping, content_base64: b64(CHASE_CSV),
    });
    assert.equal(res.imported, 4);
    const acct = (await GET('/api/accounts')).find((a) => a.id === chase.id);
    near(acct.balance, 58420.15, '期初 54130.15 加減四筆 = 最新那行的 Balance');
  });
});

describe('Chase 的信用卡匯出', () => {
  const cc = {};

  it('有兩個日期欄時，預設取入帳日而不是交易日', async () => {
    cc.id = (await POST('/api/accounts', {
      name: 'Sapphire Reserve', kind: 'card', currency: 'USD',
      opening_balance: -1000, opening_date: '2026-08-31',
    })).id;

    const p = await POST('/api/import/preview', {
      account_id: cc.id, content_base64: b64(CHASE_CARD_CSV),
    });
    cc.mapping = p.mapping;

    assert.equal(p.headers[p.mapping.dateCol], 'Post Date', '對帳看的是入帳日');
    assert.equal(p.headers[p.mapping.categoryCol], 'Category');
    assert.equal(p.headers[p.mapping.amountCol], 'Amount');
    assert.deepEqual(p.mapping.descCols.map((i) => p.headers[i]), ['Description'], 'Memo 和 Type 都不是摘要');
    assert.equal(p.mapping.balanceCol, null, '卡片沒有餘額欄');
    assert.equal(p.mapping.externalIdCol, null, 'Chase 卡片沒有序號，去重只能靠指紋');

    // The 09/17 purchase posted on 09/18; taking the transaction date would
    // file it a day early and break the tie with the statement.
    assert.ok(
      p.rows.some((r) => r.date === '2026-09-18' && r.description.includes('LANTERN TEA')),
      '交易日 09/17、入帳日 09/18 的那筆要記在 09/18'
    );
  });

  it('繳款是正數、消費是負數，不需要翻正負號', async () => {
    const p = await POST('/api/import/preview', {
      account_id: cc.id, content_base64: b64(CHASE_CARD_CSV), mapping: cc.mapping,
    });
    assert.equal(p.mapping.invert, false);
    near(p.rows.find((r) => r.description.includes('Payment')).amount, 1650, '繳款 +1650');
    near(p.rows.find((r) => r.description.includes('GREENFIELD')).amount, -284.50, '消費 -284.50');
    assert.ok(!p.summary.sign_suspect, '消費筆數多於流入，不該誤報正負號');
    assert.equal(p.summary.error, 0);
  });

  it('分類欄會跟著交易一起存進去', async () => {
    await POST('/api/import/commit', {
      account_id: cc.id, filename: 'Chase9012_Activity.csv',
      mapping: cc.mapping, content_base64: b64(CHASE_CARD_CSV),
    });
    const { rows } = await GET(`/api/txns?account=${cc.id}`);
    assert.equal(rows.find((r) => r.description.includes('GREENFIELD')).category, 'Groceries');
    assert.equal(rows.find((r) => r.description.includes('LANTERN TEA')).category, 'Food & Drink');
    assert.equal(rows.find((r) => r.description.includes('Payment')).category, '', '繳款沒有分類');
  });

  it('換一個日期欄，同一份檔案會整批被當成新的', async () => {
    // Not a bug to fix — the date is part of the fingerprint by design. It is
    // the reason the default has to be right the first time, because a card
    // export has no reference number to dedup on instead.
    const byTxnDate = { ...cc.mapping, dateCol: 0 };
    const p = await POST('/api/import/preview', {
      account_id: cc.id, content_base64: b64(CHASE_CARD_CSV), mapping: byTxnDate,
    });
    assert.equal(p.summary.new, 3, '三筆兩個日期不同的，會重新匯入一次');
    assert.equal(p.summary.duplicate, 1, '只有兩個日期相同的那一筆認得出是重複');
  });

  it('分類改了不會讓同一筆變成新交易', async () => {
    // Banks recategorise rows between exports; the fingerprint must not care.
    const recategorised = CHASE_CARD_CSV.replace('Groceries', 'Shopping');
    const p = await POST('/api/import/preview', {
      account_id: cc.id, content_base64: b64(recategorised), mapping: cc.mapping,
    });
    assert.equal(p.summary.new, 0, '分類不在指紋裡');
    assert.equal(p.summary.duplicate, 4);
  });
});

describe('Capital One 的 360 Checking 匯出', () => {
  const co = {};

  it('金額欄沒有正負號，方向要去讀「Transaction Type」', async () => {
    co.id = (await POST('/api/accounts', {
      name: '360 Checking', kind: 'cash', currency: 'USD',
      opening_balance: 54000, opening_date: '2026-06-29',
    })).id;

    const p = await POST('/api/import/preview', {
      account_id: co.id, content_base64: b64(C1_CHECKING_CSV),
    });
    co.mapping = p.mapping;

    assert.equal(p.mapping.amountMode, 'typed', '不是單一有號欄，也不是支出／存入兩欄');
    assert.equal(p.headers[p.mapping.amountCol], 'Transaction Amount');
    assert.equal(p.headers[p.mapping.typeCol], 'Transaction Type');
    assert.equal(p.headers[p.mapping.balanceCol], 'Balance');
    assert.deepEqual(
      p.mapping.descCols.map((i) => p.headers[i]),
      ['Transaction Description'],
      'Transaction Type 不是摘要'
    );
    assert.equal(p.mapping.externalIdCol, null, '每行都一樣的 Account Number 不是交易序號');

    near(p.rows.find((r) => r.description.includes('PAYROLL')).amount, 8500, 'Credit → 正');
    near(p.rows.find((r) => r.description.includes('HOME INSURANCE')).amount, -1250, 'Debit → 負');
    near(p.rows.find((r) => r.description.includes('Interest')).amount, 12.47, '小額利息也照收');
    assert.equal(p.summary.error, 0);
    assert.equal(p.summary.new, 8);
  });

  it('餘額鏈整份對得上——這才是正負號真的對的證據', async () => {
    const p = await POST('/api/import/preview', {
      account_id: co.id, content_base64: b64(C1_CHECKING_CSV), mapping: co.mapping,
    });
    // Every Debit read as income still parses, still lands in the right
    // columns and still reports no error. The running balance is the only
    // thing in the file that disagrees, so it is the assertion that matters.
    assert.equal(p.summary.balance_breaks, 0, '每一行都等於上一行餘額加本行金額');
    near(p.summary.net, 18819.82, '三筆薪資加利息，減房租、卡費、提款、保費');
    assert.equal(p.reconcile.stated, 72819.82, '對帳單最後的餘額');
    assert.ok(p.reconcile.matches, '匯入後餘額要跟對帳單一致');
  });

  it('讀不出收支別的行被拒收，不會猜一個正負號', async () => {
    const p = await POST('/api/import/preview', {
      account_id: co.id, content_base64: b64(C1_CHECKING_UNKNOWN_TYPE), mapping: co.mapping,
    });
    const row = p.rows.find((r) => r.description.includes('Interest'));
    assert.equal(row.amount, null, '金額有讀到，但沒有方向就不成一筆交易');
    assert.ok(
      row.errors.some((e) => e.includes('收支別')),
      `錯誤訊息要指到收支別那一格，實際是 ${JSON.stringify(row.errors)}`
    );
    assert.equal(p.summary.error, 1, '只有那一行壞掉');
    assert.equal(p.summary.new, 7, '其餘七行照常匯入');
  });

  it('MM/DD/YY 不會被當成民國年', async () => {
    const p = await POST('/api/import/preview', {
      account_id: co.id, content_base64: b64(C1_CHECKING_CSV),
    });
    assert.equal(p.mapping.dateFormat, 'auto', '兩位數年份不是民國');
    // 09/13/26 read as ROC is 民國 9 年 13 月 — refused outright.
    assert.ok(p.rows.some((r) => r.date === '2026-09-13'), '09/13/26 → 2026-09-13');
    // These two are the silent half: read as ROC, 09/08/26 is 1920-08-26 and
    // 07/01/26 is 1918-01-26. Both valid, both in the fingerprint, both on a
    // row that would have reported no error whatsoever.
    assert.ok(p.rows.some((r) => r.date === '2026-09-08'), '09/08/26 → 2026-09-08，不是 1920-08-26');
    assert.ok(p.rows.some((r) => r.date === '2026-07-01'), '07/01/26 → 2026-07-01，不是 1918-01-26');
    assert.ok(!p.rows.some((r) => r.date && r.date < '2000-01-01'), '沒有任何一行掉到上個世紀');
  });

  it('三位數的民國年還是照舊判得出來', async () => {
    const p = await POST('/api/import/preview', { account_id: ids.esun, content_base64: b64(ESUN_CSV) });
    assert.equal(p.mapping.dateFormat, 'roc');
    assert.equal(p.rows[0].date, '2026-07-01');
  });

  it('叫 Type 但寫的是交易種類的欄位，不會被當成收支別', async () => {
    // Chase heads a column `Type` too, and it matches the hint just as well.
    // Its values are LOAN_PMT / ACH_CREDIT / CHASE_TO_PARTNERFI — what the
    // transaction was, not which way it went — so nothing in the header tells
    // the two apart and only the cells can. Believing the header would put
    // every row into a mode that then refuses it — every row in the file.
    const p = await POST('/api/import/preview', {
      account_id: co.id, content_base64: b64(CHASE_CSV),
    });
    assert.equal(p.mapping.amountMode, 'single');
    assert.equal(p.mapping.typeCol, null);
    assert.equal(p.summary.error, 0, '照舊全部解析得出來');
  });

  it('同一份檔案先簽好正負號，也不會被 abs 掉', async () => {
    // A statement that both signs its amounts and labels them states the
    // direction twice. Taking the magnitude absolutely is what keeps the two
    // from cancelling — without it a labelled `-1250.00` would come out
    // +1250.00, and the balance chain is what would notice.
    const signed = C1_CHECKING_CSV.replace('Debit,1250.00', 'Debit,-1250.00');
    const p = await POST('/api/import/preview', {
      account_id: co.id, content_base64: b64(signed), mapping: co.mapping,
    });
    near(p.rows.find((r) => r.description.includes('HOME INSURANCE')).amount, -1250, '還是 -1250');
    assert.equal(p.summary.balance_breaks, 0);
  });

  it('匯入後帳戶餘額等於對帳單的期末餘額', async () => {
    await POST('/api/import/commit', {
      account_id: co.id, filename: 'capitalone-360-checking.csv',
      mapping: co.mapping, content_base64: b64(C1_CHECKING_CSV),
    });
    const acct = (await GET('/api/accounts')).find((a) => a.id === co.id);
    near(acct.balance, 72819.82, '期初 54000 加上這八行');
  });
});

describe('Capital One 的 Venture 卡匯出', () => {
  const cv = {};

  it('入帳日那一欄叫 Posted Date，還是要勝過交易日', async () => {
    cv.id = (await POST('/api/accounts', {
      name: 'Venture', kind: 'card', currency: 'USD',
      opening_balance: 0, opening_date: '2026-07-28',
    })).id;

    const p = await POST('/api/import/preview', {
      account_id: cv.id, content_base64: b64(C1_CARD_CSV),
    });
    cv.mapping = p.mapping;

    assert.equal(p.headers[p.mapping.dateCol], 'Posted Date', '對帳看的是入帳日');
    assert.equal(p.headers[p.mapping.categoryCol], 'Category');
    assert.equal(p.mapping.amountMode, 'inout', '這張卡把借貸拆成兩欄');
    assert.equal(p.headers[p.mapping.outCol], 'Debit');
    assert.equal(p.headers[p.mapping.inCol], 'Credit');
    assert.deepEqual(p.mapping.descCols.map((i) => p.headers[i]), ['Description'], 'Card No. 不是摘要');

    // Transacted 07/30, posted 08/01. Taking the transaction date files it in
    // the wrong month as well as the wrong day.
    assert.ok(
      p.rows.some((r) => r.date === '2026-08-01' && r.description.includes('FUEL DEPOT')),
      '交易日 07/30、入帳日 08/01 的那筆要記在 08/01'
    );
  });

  it('消費是負數、繳款和退款是正數，不需要翻正負號', async () => {
    const p = await POST('/api/import/preview', {
      account_id: cv.id, content_base64: b64(C1_CARD_CSV), mapping: cv.mapping,
    });
    assert.equal(p.mapping.invert, false);
    near(p.rows.find((r) => r.description.includes('SKYLINE')).amount, -2480, '大額消費 -2480');
    near(p.rows.find((r) => r.description.includes('AUTOPAY')).amount, 1842.65, '繳款 +1842.65');
    near(p.rows.find((r) => r.description.includes('NORTHSIDE')).amount, 329.99, '退款 +329.99');
    near(p.rows.find((r) => r.description.includes('INTEREST')).amount, -38.12, '利息費用 -38.12');
    near(p.summary.net, -722.93, '六筆消費減繳款與退款');
    assert.ok(!p.summary.sign_suspect, '流出多於流入，不該誤報正負號');
    assert.equal(p.summary.error, 0);
  });

  it('各種分類都跟著交易存進去', async () => {
    await POST('/api/import/commit', {
      account_id: cv.id, filename: 'capitalone-venture-card.csv',
      mapping: cv.mapping, content_base64: b64(C1_CARD_CSV),
    });
    const { rows } = await GET(`/api/txns?account=${cv.id}`);
    const byCategory = Object.fromEntries(rows.map((r) => [r.description, r.category]));
    assert.equal(byCategory['SKYLINE AIRWAYS'], 'Other Travel');
    assert.equal(byCategory['HARBOR BISTRO'], 'Dining');
    assert.equal(byCategory['CITY PHARMACY'], 'Health Care');
    assert.equal(byCategory['FUEL DEPOT 2201'], 'Gas/Automotive');
    assert.equal(byCategory['GRAND CINEMA 14'], 'Entertainment');
  });

  it('繳卡費的兩腳配得成轉帳——支票戶那腳的正負號是收支別欄給的', async () => {
    // The whole point of this pair: the checking leg is -1842.65 only because
    // `typed` mode read `Debit` out of Transaction Type. Get that wrong and
    // it is +1842.65, there is no outflow to match, and the pair never forms.
    const chk = (await GET('/api/accounts')).find((a) => a.name === '360 Checking');
    const pairs = await GET('/api/transfers/candidates');
    const hit = pairs.find(
      (p) => Math.abs(p.out.amount) === 1842.65 && p.in.account_id === cv.id
    );
    assert.ok(hit, '支票戶的 CRCARDPMT 要跟卡片的 AUTOPAY PYMT 配成一組');
    assert.equal(hit.out.account_id, chk.id);

    const before = (await GET('/api/overview')).net_worth.currencies.USD.ledger;
    await POST('/api/transfers/apply', { pairs: [{ out_id: hit.out.id, in_id: hit.in.id }] });
    const after = (await GET('/api/overview')).net_worth.currencies.USD.ledger;
    near(after, before, '配對只是重新歸類，淨值不動');
  });

  it('整年沒刷、只有標題列的年度報表，預覽是空的而不是錯誤', async () => {
    const p = await POST('/api/import/preview', {
      account_id: cv.id, content_base64: b64(C1_CARD_EMPTY),
    });
    assert.equal(p.summary.total, 0);
    assert.equal(p.summary.error, 0);
    assert.equal(p.summary.net, 0);
    assert.equal(p.headers[p.mapping.dateCol], 'Posted Date', '沒有資料列也還是對得出欄位');
  });
});

describe('Citi 的匯出：同一個標題列，兩種完全不同的檔案', () => {
  const chk = {};
  const sav = {};
  const card = {};

  it('支票戶：尾隨逗號的 6 欄 body 配 5 欄標題，不會整份被當成位移', async () => {
    chk.id = (await POST('/api/accounts', {
      name: 'Citi 支票', kind: 'cash', currency: 'USD',
      opening_balance: 0, opening_date: '2026-06-05',
    })).id;

    const p = await POST('/api/import/preview', {
      account_id: chk.id, content_base64: b64(CITI_CSV),
    });
    chk.mapping = p.mapping;

    assert.equal(p.summary.error, 0, '八行都讀得出來');
    assert.equal(p.summary.repaired, 0, '尾隨逗號是這個檔案的寬度，不是位移');
    assert.equal(p.headers[p.mapping.dateCol], 'Date');
    assert.equal(p.headers[p.mapping.outCol], 'Debit');
    assert.equal(p.headers[p.mapping.inCol], 'Credit');
    assert.equal(p.headers[p.mapping.statusCol], 'Status');
    assert.equal(p.mapping.amountMode, 'inout', '兩欄，不是單一欄含正負號');
    assert.equal(p.mapping.balanceCol, null, 'Citi 兩種檔案都沒有餘額欄');
    assert.equal(p.reconcile.stated, null, '沒有餘額欄就不假裝對得起來');
  });

  it('破折號的 MM-DD-YYYY 讀得對，Debit 是流出、Credit 是流入', async () => {
    const p = await POST('/api/import/preview', {
      account_id: chk.id, content_base64: b64(CITI_CSV), mapping: chk.mapping,
    });
    const interest = p.rows.find((r) => r.description.includes('Interest Adj'));
    assert.equal(interest.date, '2026-09-11', '09-11-2026 是 9 月 11 日');
    near(interest.amount, 900, 'Credit 欄的 900.00 是流入');
    near(p.rows.find((r) => r.description.includes('ATM')).amount, -600, 'Debit 欄是流出');
    assert.equal(
      p.rows.find((r) => r.description.includes('Transfer to Savings')).description,
      'Transfer to Savings, monthly',
      '引號裡的逗號不會把摘要切成兩欄'
    );
  });

  // 同一天在同一家買兩次同樣的金額是兩筆，不是重複——指紋一樣，但檔案裡有兩行而
  // 資料庫裡一行都還沒有。
  it('同一天同金額同摘要的兩筆，兩筆都留下來', async () => {
    const p = await POST('/api/import/preview', {
      account_id: chk.id, content_base64: b64(CITI_CSV), mapping: chk.mapping,
    });
    const twice = p.rows.filter((r) => r.description.includes('BRIGHTLEAF'));
    assert.equal(twice.length, 2);
    assert.equal(twice[0].fingerprint, twice[1].fingerprint, '指紋本來就一樣');
    assert.ok(twice.every((r) => r.status === 'new'), '兩筆都要進來');
  });

  // `CURRENT_VIEW` 是「螢幕上現在長這樣」，所以會含未入帳的授權。
  it('未入帳（Pending）的那一行不匯入，但也不是解析失敗', async () => {
    const p = await POST('/api/import/preview', {
      account_id: chk.id, content_base64: b64(CITI_CSV), mapping: chk.mapping,
    });
    assert.equal(p.summary.pending, 1);
    assert.equal(p.summary.new, 7);
    assert.equal(p.summary.duplicate, 0);
    assert.equal(p.summary.error, 0, '未入帳的行是好行，只是還沒定案');

    const row = p.rows.find((r) => r.status === 'pending');
    assert.ok(row.description.includes('CASCADE OUTDOOR'));
    near(row.amount, -165, '金額讀得出來，只是不採用');
    assert.ok(row.fingerprint, '不是壞行，指紋照算');
  });

  it('匯入只寫進已入帳的七筆', async () => {
    const res = await POST('/api/import/commit', {
      account_id: chk.id, filename: 'citi-checking.csv',
      mapping: chk.mapping, content_base64: b64(CITI_CSV),
    });
    assert.equal(res.imported, 7);
    const acct = (await GET('/api/accounts')).find((a) => a.id === chk.id);
    near(acct.balance, 6100, '未入帳的 165 沒有算進來，算進來的話是 5935');
  });

  // The reason the pending row is held back at all. Between the two downloads
  // the purchase settled three days later and eighteen dollars heavier once
  // the tip landed, and date and amount are both in the fingerprint — so the
  // row imported from the first download would not be recognised as this one,
  // and a deposit export has no reference number to catch it either.
  it('等它入帳之後再下載一次，同一筆消費只會進來一次', async () => {
    const p = await POST('/api/import/preview', {
      account_id: chk.id, content_base64: b64(CITI_POSTED), mapping: chk.mapping,
    });
    assert.equal(p.summary.pending, 0, '這次它已經入帳了');
    assert.equal(p.summary.duplicate, 7, '另外七筆上次就匯過了');
    assert.equal(p.summary.new, 1);

    await POST('/api/import/commit', {
      account_id: chk.id, filename: 'citi-checking.csv',
      mapping: chk.mapping, content_base64: b64(CITI_POSTED),
    });
    const { rows } = await GET(`/api/txns?account=${chk.id}`);
    const settled = rows.filter((r) => r.description.includes('CASCADE OUTDOOR'));
    assert.equal(settled.length, 1, '一筆消費只能有一筆——這就是不匯未入帳的理由');
    near(settled[0].amount, -183, '記的是入帳後的金額，不是授權時的');
    assert.equal(settled[0].date, '2026-09-21', '記的是入帳日');
    const acct = (await GET('/api/accounts')).find((a) => a.id === chk.id);
    near(acct.balance, 5917, '6100 − 183');
  });

  it('儲蓄戶是同一種檔案，同一組對應就讀得動', async () => {
    sav.id = (await POST('/api/accounts', {
      name: 'Citi 儲蓄', kind: 'cash', currency: 'USD',
      opening_balance: 0, opening_date: '2026-02-05',
    })).id;

    const p = await POST('/api/import/preview', {
      account_id: sav.id, content_base64: b64(CITI_SAVINGS_CSV),
    });
    assert.equal(p.summary.error, 0);
    assert.equal(p.summary.new, 8);
    assert.equal(p.summary.pending, 0, '這份全部都入帳了');
    assert.deepEqual(
      [p.headers[p.mapping.dateCol], p.headers[p.mapping.outCol], p.headers[p.mapping.inCol]],
      ['Date', 'Debit', 'Credit'],
      '跟支票戶猜出同一組欄位'
    );
    assert.ok(
      p.rows.some((r) => r.description === 'Interest Payment'),
      'Citi 在摘要後面留了一個空格，去掉之後才是摘要'
    );

    await POST('/api/import/commit', {
      account_id: sav.id, filename: 'citi-savings.csv',
      mapping: p.mapping, content_base64: b64(CITI_SAVINGS_CSV),
    });
    const acct = (await GET('/api/accounts')).find((a) => a.id === sav.id);
    near(acct.balance, 58000);
  });

  it('信用卡：Credit 欄寫的是負數，繳款還是正的', async () => {
    card.id = (await POST('/api/accounts', {
      name: 'Citi 信用卡', kind: 'card', currency: 'USD',
      opening_balance: 0, opening_date: '2025-08-20',
    })).id;

    const p = await POST('/api/import/preview', {
      account_id: card.id, content_base64: b64(CITI_CARD_CSV),
    });
    card.mapping = p.mapping;

    assert.equal(p.summary.error, 0);
    assert.equal(p.mapping.amountMode, 'inout', '跟支票戶是同一個標題列');
    near(p.rows.find((r) => r.description.includes('ONLINE PAYMENT')).amount, 2600,
      '檔案寫 -2600.00，繳款是還錢，記正的');
    near(p.rows.find((r) => r.description.includes('HOTEL AURELIA')).amount, -1480, '消費記負的');
    near(p.rows.find((r) => r.description.includes('RETURN')).amount, 465, '退款記正的');
    assert.ok(!p.summary.sign_suspect, '消費筆數多於流入，不該誤報正負號');
  });

  // Citi is itself inconsistent: the deposit export writes a credit positive
  // and the card export writes one negative, under an identical header. Read
  // the sign and every card payment turns back into a charge.
  it('方向由欄位決定，儲存格裡的正負號不算數', async () => {
    const flipped = CITI_CARD_CSV.replace(',1480.00,', ',-1480.00,');
    const p = await POST('/api/import/preview', {
      account_id: card.id, content_base64: b64(flipped), mapping: card.mapping,
    });
    assert.equal(p.summary.error, 0);
    near(p.rows.find((r) => r.description.includes('HOTEL AURELIA')).amount, -1480,
      'Debit 欄寫成負的，還是流出');
  });

  // 「CREDIT REFUND AS REQUESTED」寫在 Debit 欄：卡片原本溢繳，Citi 把多的錢退回
  // 你的戶頭，所以那筆是欠款又長回來，不是還款。欄位講的才算數。
  it('摘要說 credit、欄位說 debit 時，以欄位為準', async () => {
    const p = await POST('/api/import/preview', {
      account_id: card.id, content_base64: b64(CITI_CARD_2026_CSV), mapping: card.mapping,
    });
    near(p.rows.find((r) => r.description === 'CREDIT REFUND AS REQUESTED').amount, -940);
    near(p.rows.find((r) => r.description.includes('AUTOPAY')).amount, 940, '同一筆錢的另一半');
  });

  it('兩年份匯進同一張卡，餘額回到零', async () => {
    const y25 = await POST('/api/import/commit', {
      account_id: card.id, filename: 'citi-card-2025.csv',
      mapping: card.mapping, content_base64: b64(CITI_CARD_CSV),
    });
    assert.equal(y25.imported, 8, '卡片檔沒有未入帳要擋');
    near((await GET('/api/accounts')).find((a) => a.id === card.id).balance, -2160,
      '2025 年底還欠 2160');

    const y26 = await POST('/api/import/commit', {
      account_id: card.id, filename: 'citi-card-2026.csv',
      mapping: card.mapping, content_base64: b64(CITI_CARD_2026_CSV),
    });
    assert.equal(y26.imported, 9);
    assert.equal(y26.skipped, 0, '兩個年度沒有重疊');
    near((await GET('/api/accounts')).find((a) => a.id === card.id).balance, 0,
      '2026 把它繳清了；正負號讀錯的話會是 −19950');
  });

  it('支票戶的繳卡費跟卡片那邊的繳款配得起來', async () => {
    const pairs = await GET('/api/transfers/candidates');
    const hit = pairs.find((p) => p.out.account_id === chk.id && p.in.account_id === card.id);
    assert.ok(hit, '兩張對帳單各記一腳，要認得出是同一筆');
    near(Math.abs(hit.out.amount), 3200);
    assert.equal(hit.day_gap, 0, '同一天');
    assert.equal(hit.cross_currency, false);
  });

  it('支票戶轉到儲蓄戶也配得起來', async () => {
    const pairs = await GET('/api/transfers/candidates');
    const hit = pairs.find((p) => p.out.account_id === chk.id && p.in.account_id === sav.id);
    assert.ok(hit, '同一天同金額的兩腳');
    near(Math.abs(hit.out.amount), 2500);
  });

  // The registry check this suite used to end with now lives in its own
  // describe below, driven by what `fixture()` actually loaded rather than by
  // a hand-kept list — same guarantee, one less list to forget.
});

// Both pipeline bugs so far had the same shape: a stage drew a conclusion
// about the whole file from one anomalous row, and the damage landed on the
// other rows. bodyWidth let a single shifted row decide a padded file was not
// padded, and every row then read its balance as its amount.
// checkBalanceChain anchored on a refused row's balance and reported a drift
// against a fragment. Each stage's own tests passed both times.
//
// So the invariant is asserted once, over every statement shape: a shift is
// local. Injecting one into a fixture must leave every other row byte for
// byte as it was, and must not let the injected row through with a different
// amount.
// `.gitignore` blocks `*.csv` across the whole repo because a real statement
// arrives named `stmt.csv` and matches nothing specific. test/fixtures/ is the
// single hole in that, so it is now the easiest place in the repo for real
// transactions to reach version control — a statement dropped in there to try
// something out is tracked by default and nothing else would say so.
//
// So the hole is only as wide as what is declared: a .csv sitting in that
// directory without a line in BANK_FIXTURES fails the suite. That turns
// "forgot to delete it" into a red test instead of a commit.
describe('樣本目錄裡不准有沒讀到的檔案', () => {
  it('test/fixtures 的每一個 .csv 都被這份測試讀過', () => {
    const onDisk = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.csv')).sort();
    assert.deepEqual(
      [...loadedFixtures].sort(),
      onDisk,
      '有樣本檔沒被任何測試讀到——真的對帳單丟進去試完忘了刪，就長這樣'
    );
  });
});

// guessMapping assigns columns in one pass, and the ORDER of the calls is
// the precedence: whatever a line takes is gone for every line below it.
// That used to be nine hand-copied exclusion arrays, and they had already
// drifted — `typeCol` and `statusCol` carried the same list, so neither
// excluded the other. columnPicker keeps the accumulator in one place; these
// pin down what it has to guarantee.
describe('欄位對應：先搶先贏，一欄只能有一個用途', () => {
  const csvMod = require('../shared/csv.js');
  const mapOf = (text) => {
    const grid = csvMod.parseCsv(text, ',');
    return csvMod.guessMapping(grid[0], grid.slice(1));
  };

  it('同一欄不會同時被當成兩種用途', () => {
    // `Type Status` matches both HINTS.type and HINTS.status. Before the
    // shared picker both claimed column 2 and the same cells were read under
    // two different rules. Contrived, and no real statement here reaches it —
    // but it is exactly what copying the exclusion list invites.
    const m = mapOf([
      'Date,Description,Type Status,Amount',
      '09/13/26,COFFEE,Debit,12.00',
      '09/14/26,PAY,Credit,50.00',
    ].join('\r\n'));
    const used = [m.dateCol, m.outCol, m.inCol, m.amountCol, m.balanceCol,
      m.externalIdCol, m.categoryCol, m.statusCol, m.typeCol, ...(m.descCols || [])]
      .filter((c) => c !== null && c !== undefined);
    assert.equal(new Set(used).size, used.length, `有欄位被兩種用途同時佔用：${used}`);
  });

  it('摘要欄贏過分類欄，因為它先被挑', () => {
    // 摘要 matches HINTS.category too. Precedence is the only thing keeping
    // it the summary, so it is worth a test rather than a comment.
    const m = mapOf([
      '交易日期,摘要,交易金額',
      '115/07/01,薪資,"85,000"',
    ].join('\r\n'));
    assert.deepEqual(m.descCols, [1], '摘要是摘要');
    assert.equal(m.categoryCol, null, '不會又被當成分類欄');
  });

  it('沒有用到的欄位形式不會白白吃掉一欄', () => {
    // A two-column debit/credit file never needs a direction column, so the
    // type pick must not run and swallow something else.
    const m = mapOf([
      'Date,Description,Type,Debit,Credit',
      '09/13/2026,COFFEE,Sale,12.00,',
    ].join('\r\n'));
    assert.equal(m.amountMode, 'inout');
    assert.equal(m.typeCol, null, '兩欄式不需要收支別欄，就不要去挑');
  });
});

describe('管線不變量：一行位移只影響那一行', () => {
  const csvMod = require('../shared/csv.js');

  const analyse = (grid, mapping) => csvMod.extractRows(grid, mapping, 1).rows;

  const baseline = (text) => {
    const grid = csvMod.parseCsv(text, ',');
    const headerRow = csvMod.detectHeaderRow(grid);
    const headers = grid[headerRow - 1] || [];
    const mapping = { ...csvMod.guessMapping(headers, grid.slice(headerRow)), headerRow };
    return { grid, mapping, rows: analyse(grid, mapping) };
  };

  const cleanRow = (rows) => rows.findIndex((r) => !r.errors.length && r.amount !== null);

  const inject = (grid, gridIdx, at) =>
    grid.map((r, i) => (i === gridIdx ? [...r.slice(0, at), 'OVERFLOW', ...r.slice(at)] : r));

  for (const [name, text] of BANK_FIXTURES) {
    // Sweep the insertion point. Where the extra field lands decides whether a
    // stage draws the wrong conclusion — both historical bugs turned on it,
    // and both existing fixtures happened to push a blank into the slot that
    // mattered, which is exactly why they passed while the bug was live.
    it(`${name}：任何一行變寬，其餘每一行都不受影響`, () => {
      const base = baseline(text);
      const target = cleanRow(base.rows);
      assert.ok(target >= 0, `${name}：沒有乾淨的資料行可以注入`);
      const gridIdx = base.mapping.headerRow + target;
      const rowLen = base.grid[gridIdx].length;

      for (let at = 0; at <= rowLen; at++) {
        const after = analyse(inject(base.grid, gridIdx, at), base.mapping);
        assert.equal(after.length, base.rows.length, `插在第 ${at} 欄時行數變了`);

        for (let i = 0; i < base.rows.length; i++) {
          if (i === target) continue;
          const b = base.rows[i];
          const a = after[i];
          const where = `${name}：多一欄插在第 ${at} 欄時，第 ${b.lineNo} 行`;
          assert.equal(a.amount, b.amount, `${where}的金額被改變了`);
          assert.equal(a.balance, b.balance, `${where}的餘額被改變了`);
          assert.equal(a.errors.length, b.errors.length, `${where}的錯誤數改變了`);
          assert.equal(a.balanceBreak, b.balanceBreak, `${where}冒出了不該有的餘額斷點`);
        }
      }
    });

    // With no description column there is nothing to fold the overflow into,
    // so the row is refused rather than repaired — the only way to reach the
    // stages that have to cope with a refused row. Its cells are all read
    // from shifted positions, the balance included, so nothing downstream may
    // treat that balance as true.
    it(`${name}：修不了的位移行被拒收，也不會污染餘額鏈`, () => {
      const base = baseline(text);
      if (base.mapping.balanceCol === null || base.mapping.balanceCol === undefined) return;

      const noDesc = { ...base.mapping, descCols: [] };
      const before = analyse(base.grid, noDesc);
      const target = cleanRow(before);
      assert.ok(target >= 0, `${name}：沒有乾淨的資料行可以注入`);
      const gridIdx = base.mapping.headerRow + target;
      const rowLen = base.grid[gridIdx].length;

      for (let at = 0; at <= rowLen; at++) {
        const after = analyse(inject(base.grid, gridIdx, at), noDesc);
        assert.ok(after[target].errors.length,
          `${name}：多一欄插在第 ${at} 欄，沒有摘要欄可折回卻沒被拒收`);

        for (let i = 0; i < before.length; i++) {
          if (i === target) continue;
          assert.equal(after[i].balanceBreak, before[i].balanceBreak,
            `${name}：多一欄插在第 ${at} 欄時，第 ${before[i].lineNo} 行被拒收行的餘額污染了`);
          assert.equal(after[i].amount, before[i].amount,
            `${name}：多一欄插在第 ${at} 欄時，第 ${before[i].lineNo} 行的金額被改變了`);
        }
      }
    });

    // The realistic shape: a stray comma inside the description splits that
    // field, so the extra one lands right after it. Repair has an anchor to
    // fold back to, and the amount has to come out unchanged.
    it(`${name}：摘要欄被逗號拆開時，金額還原得回來`, () => {
      const base = baseline(text);
      const descCol = (base.mapping.descCols || [])[0];
      assert.ok(descCol !== undefined && descCol !== null,
        `${name}：猜不到摘要欄，沒有地方可以注入`);

      const target = cleanRow(base.rows);
      const gridIdx = base.mapping.headerRow + target;
      const hit = analyse(inject(base.grid, gridIdx, descCol + 1), base.mapping)[target];

      assert.ok(hit.repaired || hit.errors.length, `${name}：位移那行既沒修復也沒拒收`);
      if (!hit.errors.length) {
        assert.equal(hit.amount, base.rows[target].amount,
          `${name}：修復後的金額跟原本不同`);
      }
    });
  }
});

describe('還沒有帳戶時，從檔案推出一份草稿', () => {
  const peek = (body) => POST('/api/import/preview', body);

  it('沒有 account_id 也預覽得動，而且附上建議', async () => {
    const p = await peek({ content_base64: b64(CHASE_CSV), filename: 'Chase0000_Activity_20260920.csv' });
    assert.ok(p.suggested_account, '沒有帳戶時要給建議');
    assert.equal(p.summary.error, 0, '沒有帳戶不影響解析');
    assert.equal(p.suggested_account.institution.name, 'Chase');
    assert.equal(p.suggested_account.name, 'Chase ...0000');
    assert.equal(p.suggested_account.currency, 'USD');
  });

  it('有餘額欄時，期初餘額從最早一筆倒推得出來', async () => {
    const s = (await peek({ content_base64: b64(CHASE_CSV), filename: 'Chase0000.csv' })).suggested_account;
    assert.equal(s.kind, 'cash', '有餘額欄就是存款帳戶');
    assert.ok(s.kind_confident, '檔案自己說了，不是用猜的');
    assert.equal(s.opening_source, 'derived');
    // 最早一筆是 09/01 的 +9750，之後餘額 63880.15，所以期初是 54130.15。
    near(s.opening_balance, 54130.15);
    assert.equal(s.opening_date, '2026-08-31', '期初日期是最早一筆的前一天');
    assert.deepEqual(
      { from: s.covers.from, to: s.covers.to, rows: s.covers.rows },
      { from: '2026-09-01', to: '2026-09-14', rows: 4 }
    );
  });

  it('檔案自己寫了期初餘額就直接用，不用倒推', async () => {
    const s = (await peek({ content_base64: b64(BOA_CSV), filename: 'stmt.csv' })).suggested_account;
    assert.equal(s.opening_source, 'anchor');
    near(s.opening_balance, 48250.00, 'BoA 的「Beginning balance」那一列');
    assert.equal(s.opening_date, '2025-04-01', '就是那一列自己的日期，不用往前推');
    assert.equal(s.institution, null, '檔名看不出機構就不要編一個');
    assert.equal(s.name, '', '看不出來就留空，讓使用者填');
  });

  it('有分類欄就是信用卡，而且老實說期初欠款推不出來', async () => {
    const s = (await peek({
      content_base64: b64(CHASE_CARD_CSV), filename: 'Chase9012_Activity_20260920.csv',
    })).suggested_account;
    assert.equal(s.kind, 'card');
    assert.ok(s.kind_confident);
    assert.equal(s.institution.kind, 'card', '發卡機構');
    assert.equal(s.opening_source, null, '卡片沒有餘額欄，推不出來');
    assert.equal(s.opening_balance, 0);
    assert.ok(s.notes.some((n) => n.includes('負數')), '要提醒欠款填負數');
  });

  it('兩種欄位都沒有時，說清楚類型是用猜的', async () => {
    const s = (await peek({
      content_base64: b64(BOA_CARD_CSV), filename: 'August2026_0000.csv',
    })).suggested_account;
    assert.equal(s.kind_confident, false, '沒有分類欄也沒有餘額欄');
    assert.ok(s.notes.some((n) => n.includes('請確認')), '要說這是用猜的');
    assert.equal(s.name, '...0000', '檔名裡的 2026 是年份不是卡號末四碼');
  });

  it('每個帳戶的交易查得出來，總數也是那個帳戶自己的', async () => {
    // What the per-account page is built on.
    const accounts = await GET('/api/accounts');
    const all = await GET('/api/txns?limit=2000');
    let summed = 0;
    for (const a of accounts) {
      const mine = await GET(`/api/txns?account=${a.id}&limit=2000`);
      assert.ok(mine.rows.every((t) => t.account_name === a.name), `${a.name} 的查詢混進了別人的交易`);
      assert.equal(mine.total, mine.rows.length, '總數要跟回傳的列數一致');
      summed += mine.total;
    }
    assert.equal(summed, all.total, '各帳戶加起來要等於全部');
  });

  it('對帳紀錄帶得出帳戶 id，才分得到各自的頁面', async () => {
    const checks = await GET('/api/reconcile');
    assert.ok(checks.length, '前面的測試已經記過對帳');
    assert.ok(checks.every((c) => typeof c.account_id === 'number'));
    assert.ok(checks.every((c) => 'ok' in c && 'diff' in c && 'computed' in c));
  });

  it('預覽回報帳戶幣別，畫面才知道那些數字是哪一國的錢', async () => {
    const usd = (await GET('/api/accounts')).find((a) => a.currency === 'USD');
    const p = await peek({ account_id: usd.id, content_base64: b64(CHASE_CSV) });
    assert.equal(p.account.currency, 'USD');
    assert.equal(p.account.id, usd.id);
    assert.equal(p.account.name, usd.name);
  });

  it('已經選了帳戶就不再給建議，免得蓋掉使用者設好的', async () => {
    const accounts = await GET('/api/accounts');
    const p = await peek({
      account_id: accounts[0].id, content_base64: b64(CHASE_CSV), filename: 'Chase0000.csv',
    });
    assert.equal(p.suggested_account, null);
  });

  it('account_id 指到不存在的帳戶要擋下來', async () => {
    await assert.rejects(
      () => peek({ account_id: 999999, content_base64: b64(CHASE_CSV) }),
      /帳戶不存在/
    );
  });
});

// The only thing in the app that reports what the ledger does NOT hold, so the
// four states have to be exact — a month with no rows is a hole only when
// nothing else vouches for it. `to` is a parameter precisely so these assert
// against a fixed window instead of drifting with today's date.
describe('帳本完整度', () => {
  const WINDOW = 'months=5&to=2026-05-31';
  const row = (cov, name) => cov.accounts.find((a) => a.name === name);
  const states = (cov, name) => row(cov, name).cells.map((c) => c.state);
  let acct;

  before(async () => {
    acct = (await POST('/api/accounts', {
      name: '完整度測試戶', kind: 'cash', currency: 'TWD',
      opening_balance: 0, opening_date: '2026-02-01',
    })).id;
    await POST('/api/txns', {
      rows: [
        { account_id: acct, date: '2026-02-10', amount: -100, description: 'a' },
        { account_id: acct, date: '2026-02-20', amount: -50, description: 'b' },
        { account_id: acct, date: '2026-04-05', amount: -70, description: 'c' },
      ],
    });
  });

  it('還沒開始、有資料、沒資料，三種月份分得清楚', async () => {
    const cov = await GET(`/api/coverage?${WINDOW}`);
    assert.deepEqual(cov.months, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05']);
    // 帳戶 2026-02 才開，所以 1 月不是缺口而是「還沒開始」——把它算成缺口的話，
    // 任何新帳戶一建立就背著一整排紅格子，那個警告立刻變成雜訊。
    assert.deepEqual(states(cov, '完整度測試戶'), ['outside', 'data', 'gap', 'data', 'gap']);
    assert.equal(row(cov, '完整度測試戶').gaps, 2);
    assert.equal(row(cov, '完整度測試戶').expected, 4, '只有開戶之後的月份算數');
  });

  it('有資料的格子帶著筆數和淨額', async () => {
    const cells = row(await GET(`/api/coverage?${WINDOW}`), '完整度測試戶').cells;
    assert.equal(cells[1].txns, 2);
    near(cells[1].net, -150, '2026-02 淨額');
    assert.equal(cells[2].txns, 0, '缺口沒有筆數可報');
  });

  it('最後一筆之後連續幾個月沒資料，是那個帳戶的頭條數字', async () => {
    const cov = await GET(`/api/coverage?${WINDOW}`);
    assert.equal(row(cov, '完整度測試戶').trailing_gap, 1);
    assert.equal(row(cov, '完整度測試戶').last_data, '2026-04');
    const stale = cov.summary.stale.find((s) => s.name === '完整度測試戶');
    assert.ok(stale, '沒匯入的帳戶要出現在 stale 裡');
    assert.equal(stale.trailing_gap, 1);
  });

  it('對帳紀錄可以把沒有交易的月份確認掉，缺口就不是缺口', async () => {
    // 期初 0 ＋ 到 3 月底為止的交易 = -150，所以這筆對得起來。
    await POST('/api/balance-checks', { account_id: acct, date: '2026-03-31', stated: -150 });
    const cov = await GET(`/api/coverage?${WINDOW}`);
    assert.deepEqual(states(cov, '完整度測試戶'), ['outside', 'data', 'quiet', 'data', 'gap']);
    assert.equal(row(cov, '完整度測試戶').gaps, 1, '確認過的安靜月份不算缺口');
    assert.equal(row(cov, '完整度測試戶').cells[2].check, 'ok');
  });

  it('對不起來的對帳，格子照樣標出來', async () => {
    await POST('/api/balance-checks', { account_id: acct, date: '2026-05-31', stated: 999 });
    const cells = row(await GET(`/api/coverage?${WINDOW}`), '完整度測試戶').cells;
    // 有人看過了，所以不再是「帳本不知道」；但銀行跟帳本講的不是同一件事，
    // 所以那格額外帶著 off，而不是安靜地變成一個乾淨的綠燈。
    assert.equal(cells[4].state, 'quiet');
    assert.equal(cells[4].check, 'off');
  });

  it('停用的帳戶在最後一次動靜之後就不再算缺口', async () => {
    const closed = (await POST('/api/accounts', {
      name: '已停用測試戶', kind: 'cash', currency: 'TWD',
      opening_balance: 0, opening_date: '2026-02-01', is_active: 0,
    })).id;
    await POST('/api/txns', { account_id: closed, date: '2026-02-10', amount: -10, description: 'x' });
    const cov = await GET(`/api/coverage?${WINDOW}`);
    assert.deepEqual(states(cov, '已停用測試戶'), ['outside', 'data', 'outside', 'outside', 'outside']);
    assert.equal(row(cov, '已停用測試戶').gaps, 0);
  });

  it('months 夾在範圍內，網址亂打不會生出一張沒人讀的表', async () => {
    assert.equal((await GET('/api/coverage?months=999&to=2026-05-31')).months.length, 120);
    assert.equal((await GET('/api/coverage?months=0&to=2026-05-31')).months.length, 1);
    assert.equal((await GET('/api/coverage?months=abc&to=2026-05-31')).months.length, 24);
  });
});

// A third currency, so every figure below is isolated from the accounts the
// rest of this file builds — and so the per-currency split is exercised
// against something that is not one of the two hardcoded anywhere.
const SPEND_WINDOW = 'from=2026-01-01&to=2026-06-30';

describe('消費分析：一個幣別一組數字，轉帳不算', () => {
  let jpy;

  before(async () => {
    jpy = (await POST('/api/accounts', {
      name: '消費測試戶', kind: 'card', currency: 'JPY',
      opening_balance: 0, opening_date: '2026-01-01',
    })).id;
    const rows = [
      // 每月同額 → 固定扣款
      ...['2026-01-05', '2026-02-05', '2026-03-06', '2026-04-05']
        .map((date) => ({ date, amount: -980, description: 'ZZQ SUBSCRIPTION' })),
      // 只有兩次 → 看不出規律
      ...['2026-01-10', '2026-02-10']
        .map((date) => ({ date, amount: -300, description: 'ZZQ TWICE', category: '測試分類' })),
      // 每月一次但金額差很多 → 不是訂閱，是一家常去的店
      { date: '2026-01-12', amount: -500, description: 'ZZQ MART TOKYO' },
      { date: '2026-02-12', amount: -3000, description: 'ZZQ MART TOKYO' },
      { date: '2026-03-12', amount: -900, description: 'ZZQ MART TOKYO' },
      // 三次之後就停了
      ...['2026-01-03', '2026-02-03', '2026-03-03']
        .map((date) => ({ date, amount: -2000, description: 'ZZQ GYM' })),
      { date: '2026-01-25', amount: 50000, description: 'ZZQ SALARY' },
      // 轉帳的那一隻腳：金額很大，如果被算進去，支出和收入會同時虛胖而淨額還是對的
      { date: '2026-02-01', amount: -10000, description: 'ZZQ MOVE OUT', kind: 'transfer' },
    ];
    await POST('/api/txns', { rows: rows.map((r) => ({ ...r, account_id: jpy })) });
  });

  it('自成一個幣別，不跟別的幣別加在一起', async () => {
    const sp = await GET(`/api/spending?${SPEND_WINDOW}`);
    assert.ok(sp.order.includes('JPY'));
    assert.ok(sp.order.length > 1, '有多種幣別');
    // 沒有 total、沒有 grand_total、沒有任何一個跨幣別的數字。
    assert.equal(sp.total, undefined, '跨幣別總額不存在，也不該憑空生一個出來');
  });

  it('轉帳不算收支', async () => {
    const d = (await GET(`/api/spending?${SPEND_WINDOW}`)).currencies.JPY;
    near(d.expense, 14920, '支出（不含那筆 10,000 的轉帳）');
    near(d.income, 50000, '收入');
    near(d.net, 35080, '淨額');
  });

  it('沒有分類的部分單獨報出來，不會被藏進別的分類裡', async () => {
    const d = (await GET(`/api/spending?${SPEND_WINDOW}`)).currencies.JPY;
    near(d.uncategorised.total, 14320, '未分類金額');
    assert.equal(d.uncategorised.count, 10);
    const cats = Object.fromEntries(d.categories.map((c) => [c.category, c.total]));
    near(cats[''], 14320, '未分類也是一個分類，照樣出現在明細裡');
    near(cats['測試分類'], 600, '有分類的那兩筆');
  });

  it('窗內每個月都有一個點，空月份不會被跳過', async () => {
    const d = (await GET(`/api/spending?${SPEND_WINDOW}`)).currencies.JPY;
    assert.equal(d.months.length, 6, '1 月到 6 月');
    assert.deepEqual(d.months.map((m) => m.month).slice(0, 2), ['2026-01', '2026-02']);
    // 5、6 月什麼都沒有。跳過它們的話，折線會在 4 月和 7 月之間畫一條從來不存在
    // 的斜線，看起來像「花費慢慢下降」而不是「這兩個月沒匯入」。
    near(d.months[4].expense, 0, '2026-05 是 0 不是不存在');
    near(d.months[5].expense, 0, '2026-06 同理');
  });
});

describe('固定扣款偵測', () => {
  // 窗尾停在 5/10：訂閱最後一次是 4/5（35 天前，還在節奏上），健身房是 3/3
  // （68 天前，已經漏掉一次以上）。窗尾再往後拉，連還在扣的那筆都會算成停了
  // —— 那是對的行為，只是這裡要驗的是兩者分得開。
  const REC_WINDOW = 'from=2026-01-01&to=2026-05-10';
  const mine = async () =>
    (await GET(`/api/recurring?${REC_WINDOW}`)).items.filter((r) => r.currency === 'JPY');

  it('每月同額連續出現就認得出來，還算得出下一次大約在哪天', async () => {
    const hit = (await mine()).find((r) => r.label === 'ZZQ SUBSCRIPTION');
    assert.ok(hit, '四次每月同額要被認出來');
    assert.equal(hit.cadence, 'monthly');
    assert.equal(hit.occurrences, 4);
    near(hit.median_amount, 980, '金額取中位數');
    assert.equal(hit.last, '2026-04-05');
    assert.equal(hit.next_expected, '2026-05-05', '上次 + 中位間隔');
  });

  it('只有兩次不算 —— 兩點之間永遠畫得出一條線', async () => {
    assert.ok(!(await mine()).some((r) => r.label === 'ZZQ TWICE'));
  });

  it('間隔對但金額亂跳的，是常去的店不是訂閱', async () => {
    assert.ok(!(await mine()).some((r) => r.label === 'ZZQ MART TOKYO'));
  });

  it('停掉的訂閱留在清單上但不算進每月金額', async () => {
    const gym = (await mine()).find((r) => r.label === 'ZZQ GYM');
    assert.ok(gym, '停掉的也要看得到，才知道它停了');
    assert.equal(gym.active, false, '最後一次是 3 月，到 6 月底早就過了一個月的節奏');
    const rec = await GET(`/api/recurring?${REC_WINDOW}`);
    // 每月等值只加還在扣的：一個取消掉的訂閱永遠墊高那個數字的話，那個數字就沒用了。
    near(rec.monthly_total.JPY, 980, '只有還在扣的那一筆');
  });
});

describe('分類規則', () => {
  const SPEND = () => GET(`/api/spending?${SPEND_WINDOW}`);
  let jpyId;

  before(async () => {
    jpyId = (await GET('/api/accounts')).find((a) => a.currency === 'JPY').id;
  });

  it('比對忽略大小寫、標點和空白', async () => {
    await POST('/api/rules', { pattern: 'zzq-mart, tokyo', category: '食品' });
    const dry = await POST('/api/rules/apply', { dry: true });
    assert.equal(dry.total, 3, '三筆 ZZQ MART TOKYO，寫法不同照樣對上');
    assert.ok(dry.changes.every((c) => c.to === '食品'));
  });

  it('預設是 dry run，不會在沒說的情況下掃過整本帳', async () => {
    const d = (await SPEND()).currencies.JPY;
    near(d.uncategorised.total, 14320, '剛才那次預覽沒有真的改動任何東西');
  });

  it('套用之後分類才真的進去', async () => {
    const res = await POST('/api/rules/apply', { dry: false });
    assert.equal(res.applied, 3);
    const d = (await SPEND()).currencies.JPY;
    const cats = Object.fromEntries(d.categories.map((c) => [c.category, c.total]));
    near(cats['食品'], 4400, '三筆合起來');
    near(d.uncategorised.total, 9920, '未分類少掉那 4,400');
    near(d.expense, 14920, '總支出不變 —— 分類只是搬位置，不是改金額');
  });

  it('不覆蓋已經有分類的交易', async () => {
    await POST('/api/rules', { pattern: 'ZZQ TWICE', category: '會被擋下來' });
    await POST('/api/rules/apply', { dry: false });
    const cats = Object.fromEntries((await SPEND()).currencies.JPY.categories.map((c) => [c.category, c.total]));
    near(cats['測試分類'], 600, '手填的分類是決定，規則不該蓋掉它');
    assert.equal(cats['會被擋下來'], undefined);
  });

  it('優先度高的先比對，第一個對上的就決定', async () => {
    await POST('/api/rules', { pattern: 'ZZQ', category: '低優先度', priority: 0 });
    await POST('/api/rules', { pattern: 'ZZQ SUBSCRIPTION', category: '高優先度', priority: 10 });
    await POST('/api/rules/apply', { dry: false });
    const cats = Object.fromEntries((await SPEND()).currencies.JPY.categories.map((c) => [c.category, c.total]));
    near(cats['高優先度'], 3920, '四筆訂閱走了高優先度那條');
    assert.ok(cats['低優先度'] > 0, '其餘沒分類的才落到低優先度那條');
  });

  it('只有標點的比對字串會被擋下來', async () => {
    await assert.rejects(() => POST('/api/rules', { pattern: '---', category: 'x' }), /至少要有一個文字或數字/);
    await assert.rejects(() => POST('/api/rules', { pattern: 'x', category: '' }), /分類必填/);
  });

  it('匯入時就套用，因為沒有人會回頭手動分兩百筆', async () => {
    await POST('/api/rules', { pattern: 'zzq cafe', category: '咖啡', priority: 20 });
    const csvText = 'Date,Description,Amount\n2026-05-10,ZZQ CAFE SHIBUYA,-450\n2026-05-11,ZZQ CAFE SHIBUYA,-380\n';
    const p = await POST('/api/import/preview', { account_id: jpyId, content_base64: b64(csvText) });
    await POST('/api/import/commit', {
      account_id: jpyId, filename: 'zzq.csv', mapping: p.mapping, content_base64: b64(csvText),
    });
    const cats = Object.fromEntries((await SPEND()).currencies.JPY.categories.map((c) => [c.category, c.total]));
    near(cats['咖啡'], 830, '兩筆一進來就有分類');
  });

  it('刪掉規則不會動到已經分好的交易', async () => {
    const rule = (await GET('/api/rules')).find((r) => r.category === '咖啡');
    await DEL(`/api/rules/${rule.id}`);
    const cats = Object.fromEntries((await SPEND()).currencies.JPY.categories.map((c) => [c.category, c.total]));
    near(cats['咖啡'], 830, '分類存在交易上，不是每次重算');
  });
});

// A statement that spans a month and carries nothing for it is the bank
// saying "nothing happened", which is the same answer as a row — and before
// imports recorded their span the grid could not tell it from "nobody
// downloaded this". An idle account collected red squares with no way to
// clear them except typing a balance check for every quiet month.
describe('匯入區間讓沒有交易的月份也能被確認', () => {
  const states = (cov, name) => cov.accounts.find((a) => a.name === name).cells.map((c) => c.state);
  const cell = (cov, name, month) =>
    cov.accounts.find((a) => a.name === name).cells.find((c) => c.month === month);
  const NAME = '區間測試戶';
  let acct;

  const bring = async (text) => {
    const p = await POST('/api/import/preview', { account_id: acct, content_base64: b64(text) });
    return POST('/api/import/commit', {
      account_id: acct, filename: 'span.csv', mapping: p.mapping, content_base64: b64(text),
    });
  };

  before(async () => {
    acct = (await POST('/api/accounts', {
      name: NAME, kind: 'cash', currency: 'KRW', opening_balance: 0, opening_date: '2026-01-01',
    })).id;
    await bring('Date,Description,Amount\n2026-01-05,SPAN ONE,-100\n2026-04-20,SPAN TWO,-200\n');
  });

  it('匯入紀錄記下檔案涵蓋的日期區間', async () => {
    const imp = (await GET('/api/imports')).find((i) => i.account_id === acct);
    assert.equal(imp.date_from, '2026-01-05');
    assert.equal(imp.date_to, '2026-04-20');
  });

  it('區間內沒有交易的月份是「確認過」，不是缺口', async () => {
    const cov = await GET('/api/coverage?months=5&to=2026-05-31');
    assert.deepEqual(states(cov, NAME), ['data', 'quiet', 'quiet', 'data', 'gap']);
    assert.equal(cell(cov, NAME, '2026-02').reason, 'import', '2、3 月是被對帳單涵蓋到的');
    assert.equal(cell(cov, NAME, '2026-05').reason, null, '5 月超出區間，還是缺口');
  });

  it('區間算的是檔案裡的每一行，不是匯進去的那幾行', async () => {
    // 第一行是重複的，不會被匯入 —— 但它仍然證明那份對帳單涵蓋到 1/5。只算
    // 匯進去的行，區間會在每次區間重疊時縮水，而重疊才是常態。
    const res = await bring('Date,Description,Amount\n2026-01-05,SPAN ONE,-100\n2026-06-10,SPAN THREE,-300\n');
    assert.equal(res.imported, 1, '只有一行是新的');
    const imp = (await GET('/api/imports'))[0];
    assert.equal(imp.date_from, '2026-01-05', '重複的那一行照樣算進區間');
    assert.equal(imp.date_to, '2026-06-10');

    const cov = await GET('/api/coverage?months=6&to=2026-06-30');
    assert.deepEqual(states(cov, NAME), ['data', 'quiet', 'quiet', 'data', 'quiet', 'data']);
  });

  it('有對帳紀錄時，理由說的是對帳 —— 銀行給了數字，那是比較強的說法', async () => {
    await POST('/api/balance-checks', { account_id: acct, date: '2026-02-28', stated: -100 });
    const cov = await GET('/api/coverage?months=6&to=2026-06-30');
    const feb = cell(cov, NAME, '2026-02');
    assert.equal(feb.state, 'quiet');
    assert.equal(feb.reason, 'check');
    assert.equal(feb.check, 'ok');
  });

  it('只涵蓋半個月的話不算 —— 檔案對那個月的前半段什麼都沒說', async () => {
    // 到 7 月底為止：區間最後是 6/10，7 月完全在外面，6 月則是有交易。
    const cov = await GET('/api/coverage?months=2&to=2026-07-31');
    assert.deepEqual(states(cov, NAME), ['data', 'gap']);
    assert.equal(cov.accounts.find((a) => a.name === NAME).trailing_gap, 1);
  });

  it('推算出來的區間永遠不會產生「只涵蓋一半」', async () => {
    // 這個帳戶的兩次匯入都沒有宣告期間。推算出來的區間邊緣是資料列碰巧落在哪裡
    // 的產物，不是事實，所以它只能整月整月地算 —— 拿它去說「這個月前半段有涵蓋」
    // 就是把推論講成宣告。
    const cov = await GET('/api/coverage?months=6&to=2026-06-30');
    assert.ok(!states(cov, NAME).includes('partial'));
  });
});

// The CSV does not say what period it was downloaded for; the person who
// clicked "Statement of 2026-08" on the bank's download page does. That
// answer is the only honest source for the edges of a range, and it is what
// makes a half-covered month knowable at all.
describe('使用者宣告的匯入期間', () => {
  const NAME = '期間測試戶';
  const states = (cov) => cov.accounts.find((a) => a.name === NAME).cells.map((c) => c.state);
  let acct;

  const bring = (text, period) =>
    POST('/api/import/preview', { account_id: acct, content_base64: b64(text) }).then((p) =>
      POST('/api/import/commit', {
        account_id: acct, filename: 'period.csv', mapping: p.mapping, content_base64: b64(text), ...period,
      })
    );

  before(async () => {
    acct = (await POST('/api/accounts', {
      name: NAME, kind: 'card', currency: 'SGD', opening_balance: 0, opening_date: '2026-01-01',
    })).id;
  });

  it('宣告的期間會被記下來，而且標明它是宣告的不是推算的', async () => {
    await bring('Date,Description,Amount\n2026-02-20,PERIOD A,-10\n2026-03-10,PERIOD B,-20\n', {
      period_from: '2026-02-16', period_to: '2026-03-15',
    });
    const imp = (await GET('/api/imports'))[0];
    assert.equal(imp.date_from, '2026-02-16', '用宣告的，不是資料列的 2026-02-20');
    assert.equal(imp.date_to, '2026-03-15');
    assert.equal(imp.period_kind, 'declared');
  });

  it('一期帳單橫跨兩個月，兩個月都是「只涵蓋一半」', async () => {
    // 這是推算做不到的判斷。2/16–3/15 的帳單對 2 月的前半和 3 月的後半都沒有說
    // 法，而那正是「有資料」和「什麼都不知道」中間真正的答案。
    const cov = await GET('/api/coverage?months=4&to=2026-04-30');
    assert.deepEqual(states(cov), ['gap', 'partial', 'partial', 'gap']);
  });

  it('沒有交易的月份也可以是「只涵蓋一半」', async () => {
    await bring('Date,Description,Amount\n2026-05-25,PERIOD C,-30\n', {
      period_from: '2026-05-20', period_to: '2026-06-10',
    });
    const cov = await GET('/api/coverage?months=2&to=2026-06-30');
    // 6 月只有前十天被涵蓋，而且那十天裡沒有交易。既不是確認過，也不是一無所知。
    assert.deepEqual(states(cov), ['partial', 'partial']);
  });

  it('宣告涵蓋整個月，沒有交易的月份就是確認過', async () => {
    await bring('Date,Description,Amount\n2026-08-03,PERIOD D,-40\n', {
      period_from: '2026-07-01', period_to: '2026-09-30',
    });
    const cov = await GET('/api/coverage?months=3&to=2026-09-30');
    const cells = cov.accounts.find((a) => a.name === NAME).cells;
    assert.deepEqual(cells.map((c) => c.state), ['quiet', 'data', 'quiet']);
    assert.equal(cells[0].reason, 'import', '7 月被整月涵蓋，只是沒有交易');
  });

  it('有資料列落在宣告的期間外就擋下來 —— 那證明宣告是錯的', async () => {
    await assert.rejects(
      () => bring('Date,Description,Amount\n2026-10-05,OUTSIDE,-50\n', {
        period_from: '2026-11-01', period_to: '2026-11-30',
      }),
      /落在期間外/
    );
  });

  it('起日晚於迄日直接擋掉', async () => {
    await assert.rejects(
      () => bring('Date,Description,Amount\n2026-10-05,BACKWARDS,-60\n', {
        period_from: '2026-11-30', period_to: '2026-11-01',
      }),
      /起日不能晚於迄日/
    );
  });
});

// Whether there is a rule between you and the money. Nothing reads it yet —
// net worth splits on it later (docs/plans/asset-classes.md PR 6) — so what
// is worth pinning now is that it is stored exactly, and that a value outside
// the list is refused rather than quietly becoming 'liquid'. That last one is
// the failure that would put a retirement balance back into the spendable
// figure with nothing on screen to say so.
describe('帳戶的 access', () => {
  const PUT = (p, b) => req('PUT', p, b);
  const find = async (id) => (await GET('/api/accounts')).find((a) => a.id === id);

  it('沒說就是 liquid', async () => {
    const { id } = await POST('/api/accounts', { name: 'access 預設戶', currency: 'TWD' });
    assert.equal((await find(id)).access, 'liquid');
  });

  it('restricted 存得進去也讀得回來', async () => {
    const { id } = await POST('/api/accounts', { name: '退休帳戶', currency: 'USD', access: 'restricted' });
    assert.equal((await find(id)).access, 'restricted');
  });

  it('更新時可以改，沒帶就維持原本的', async () => {
    const { id } = await POST('/api/accounts', { name: '會改的戶', currency: 'TWD' });
    await PUT(`/api/accounts/${id}`, { access: 'restricted' });
    assert.equal((await find(id)).access, 'restricted');
    await PUT(`/api/accounts/${id}`, { note: '只改備註' });
    assert.equal((await find(id)).access, 'restricted', '沒帶 access 不該被打回 liquid');
  });

  it('清單以外的值一律拒絕，不會默默變成 liquid', async () => {
    await assert.rejects(
      () => POST('/api/accounts', { name: '打錯字', currency: 'TWD', access: 'restircted' }),
      /access 只能是/
    );
    const { id } = await POST('/api/accounts', { name: '更新打錯字', currency: 'TWD' });
    await assert.rejects(() => PUT(`/api/accounts/${id}`, { access: 'locked' }), /access 只能是/);
    assert.equal((await find(id)).access, 'liquid', '被拒絕的更新什麼都沒改');
  });

  // The total still counts it, because it is still yours. What access changes
  // is which half it lands in — and it must land in exactly one.
  it('受限制的帳戶算進總額和受限制那半，不算進可動用那半', async () => {
    const usd = async () => (await GET('/api/overview')).net_worth.currencies.USD || { total: 0, liquid: { total: 0 }, restricted: { total: 0 } };
    const before = await usd();
    const { id } = await POST('/api/accounts', {
      name: '受限但有錢', currency: 'USD', access: 'restricted', opening_balance: 1000, opening_date: '2020-01-01',
    });
    const after = await usd();
    near(after.total - before.total, 1000, '總額照樣算它');
    near(after.restricted.total - before.restricted.total, 1000);
    near(after.liquid.total - before.liquid.total, 0, '可動用的數字不該因為它變動');
    await req('DELETE', `/api/accounts/${id}`);
  });

  it('總覽的走勢也分成兩半，各自只畫自己的帳戶', async () => {
    const { id } = await POST('/api/accounts', {
      name: '只在受限制那條線上', currency: 'USD', access: 'restricted', opening_balance: 777, opening_date: '2020-01-01',
    });
    const d = await GET('/api/overview');
    const last = (s) => (s && s.USD ? s.USD[s.USD.length - 1].value : 0);
    near(last(d.series_by_access.liquid) + last(d.series_by_access.restricted), last(d.series), '兩條線加起來是整本的線');
    assert.ok(last(d.series_by_access.restricted) >= 777);
    await req('DELETE', `/api/accounts/${id}`);
  });
});

// A coin is a holding like any other, valued in a currency like any other, so
// what is new is small and each part of it fails silently if it is wrong: the
// quantity's eight places, the market's case (a price history keyed under
// another spelling never applies), and the currency a holding defaults to.
describe('加密貨幣：錢包裡的一枚幣', () => {
  const PUT = (p, b) => req('PUT', p, b);
  const coin = async (symbol) => (await GET('/api/holdings')).find((h) => h.symbol === symbol);
  let wallet;

  before(async () => {
    // No institution: self-custody has none, and the column was always nullable.
    wallet = (await POST('/api/accounts', { name: '冷錢包', kind: 'wallet', currency: 'USD', opening_date: '2026-01-01' })).id;
  });

  after(async () => {
    await DEL('/api/prices?symbol=BTC&market=CRYPTO&date=2026-06-20');
    await DEL(`/api/accounts/${wallet}`);
  });

  it('沒說幣別和位數，就用市場的預設：美元、八位', async () => {
    const usdBefore = (await GET('/api/overview')).net_worth.currencies.USD.securities;
    await POST('/api/holdings', {
      account_id: wallet, symbol: 'btc', name: 'Bitcoin', market: 'crypto',
      shares: 0.12345678, avg_cost: 51800, last_price: 63250.4, price_date: '2026-06-01',
    });
    const btc = await coin('BTC');
    assert.equal(btc.market, 'CRYPTO', '市場存成大寫，跟價格表同一種寫法');
    assert.equal(btc.currency, 'USD', '以前是 market === US ? USD : TWD，第三個市場會變成台幣');
    assert.equal(btc.decimals, 8);
    assert.equal(btc.shares, 0.12345678, '八位小數原封不動');
    assert.equal(quantity(btc.shares, btc.decimals), '0.12345678', '顯示也是八位，不是 0.1235');
    near(btc.market_value, 0.12345678 * 63250.4);
    const usdAfter = (await GET('/api/overview')).net_worth.currencies.USD.securities;
    near(usdAfter - usdBefore, btc.market_value, '市值落在美元那一欄');
  });

  // The failure this normalisation exists for: a holding stored as `crypto`
  // looking its price up under `crypto` in a series stored as `CRYPTO`,
  // finding nothing, and reading last_price forever with no error anywhere.
  it('小寫的市場也對得上價格歷史', async () => {
    await POST('/api/prices', { symbol: 'btc', market: 'crypto', date: '2026-06-20', price: 64100.25 });
    const btc = await coin('BTC');
    near(btc.last_price, 64100.25, '現價改讀價格序列');
    assert.equal(btc.price_date, '2026-06-20');
    const list = await GET('/api/prices?symbol=BTC&market=crypto');
    assert.equal(list.length, 1);
    assert.equal(list[0].market, 'CRYPTO');
  });

  it('預設可以蓋掉：台灣交易所的幣用台幣計價', async () => {
    const { id } = await POST('/api/holdings', {
      account_id: wallet, symbol: 'eth', market: 'CRYPTO', currency: 'TWD', decimals: 6,
      shares: 1.5, avg_cost: 90000, last_price: 98000,
    });
    const eth = await coin('ETH');
    assert.equal(eth.currency, 'TWD');
    assert.equal(eth.decimals, 6);
    await DEL(`/api/holdings/${id}`);
  });

  it('更新時沒帶的欄位維持原本的，市場照樣正規化', async () => {
    const { id } = await coin('BTC');
    await PUT(`/api/holdings/${id}`, { shares: 0.5 });
    let btc = await coin('BTC');
    assert.equal(btc.decimals, 8, '沒帶 decimals 不該被打回預設');
    assert.equal(btc.market, 'CRYPTO');
    await PUT(`/api/holdings/${id}`, { market: 'crypto', shares: 0.12345678 });
    btc = await coin('BTC');
    assert.equal(btc.market, 'CRYPTO');
    assert.equal(btc.shares, 0.12345678);
  });

  // Refused rather than stored: an unknown market has no section on the
  // holdings page, and a typo'd one is a second price series nobody reads.
  it('清單以外的市場、不合理的位數，一律拒絕', async () => {
    const base = { account_id: wallet, symbol: 'SOL', shares: 1 };
    await assert.rejects(() => POST('/api/holdings', { ...base, market: 'NYSE' }), /market 只能是/);
    for (const decimals of [11, -1, 2.5, 'eight']) {
      await assert.rejects(() => POST('/api/holdings', { ...base, market: 'CRYPTO', decimals }), /decimals 要是/, `${decimals}`);
    }
    assert.equal(await coin('SOL'), undefined, '被拒絕的一筆都沒進去');

    const { id } = await coin('BTC');
    await assert.rejects(() => PUT(`/api/holdings/${id}`, { market: 'crypt0' }), /market 只能是/);
    assert.equal((await coin('BTC')).market, 'CRYPTO', '被拒絕的更新什麼都沒改');

    await assert.rejects(() => POST('/api/prices', { symbol: 'BTC', market: 'btc', date: '2026-06-20', price: 1 }), /market 只能是/);
    await assert.rejects(() => GET('/api/prices?symbol=BTC&market=btc'), /market 只能是/);
  });
});

// Three things a retirement account says, and only one of them is arithmetic.
// The kind decides where access starts; the tax status is a label; unvested
// comes off net worth and never off the balance, which is the statement's
// figure and has to go on agreeing with it.
describe('退休金帳戶', () => {
  const PUT = (p, b) => req('PUT', p, b);
  const find = async (id) => (await GET('/api/accounts')).find((a) => a.id === id);
  const usd = async () => (await GET('/api/overview')).net_worth.currencies.USD;
  const made = [];
  const open = async (body) => {
    const { id } = await POST('/api/accounts', { currency: 'USD', kind: 'retirement', ...body });
    made.push(id);
    return id;
  };

  after(async () => {
    for (const id of made) await DEL(`/api/accounts/${id}`);
  });

  it('沒說 access 就從類型來：退休金是受限制', async () => {
    assert.equal((await find(await open({ name: '401(k)' }))).access, 'restricted');
    assert.equal((await find(await open({ name: '可以動的退休金', access: 'liquid' }))).access, 'liquid', '明講的要照明講的');
    const { id } = await POST('/api/accounts', { name: '活存', currency: 'USD', kind: 'cash' });
    made.push(id);
    assert.equal((await find(id)).access, 'liquid');
  });

  it('未歸屬從淨值扣，餘額和對帳都不扣', async () => {
    const before = await usd();
    const id = await open({ name: '有未歸屬的計畫', opening_balance: 10000, opening_date: '2020-01-01', unvested: 1200.004 });
    const a = await find(id);
    assert.equal(a.balance, 10000, '餘額是對帳單上的總額');
    assert.equal(a.unvested, 1200, '存的時候過 round2');

    const after = await usd();
    near(after.ledger - before.ledger, 10000);
    near(after.unvested - (before.unvested || 0), 1200);
    near(after.total - before.total, 8800, '淨值只多了歸屬的那部分');

    // The statement counts the unvested share in its total. A balance check
    // against it has to agree, which it only does because the balance was
    // left alone.
    await POST('/api/balance-checks', { account_id: id, date: '2026-06-30', stated: 10000 });
    const check = (await GET('/api/reconcile')).find((c) => c.account_id === id);
    assert.ok(check.ok, `對帳應該對得上，差 ${check.diff}`);
  });

  it('稅務性質存得進去、清得掉，而且清單以外的拒絕', async () => {
    const id = await open({ name: 'Roth IRA', tax_status: 'roth' });
    assert.equal((await find(id)).tax_status, 'roth');
    await PUT(`/api/accounts/${id}`, { note: '只改備註' });
    assert.equal((await find(id)).tax_status, 'roth', '沒帶就維持原本的');
    await PUT(`/api/accounts/${id}`, { tax_status: '' });
    assert.equal((await find(id)).tax_status, null, '空字串是清掉');
    await assert.rejects(() => PUT(`/api/accounts/${id}`, { tax_status: 'tax-free' }), /tax_status 只能是/);
    await assert.rejects(() => POST('/api/accounts', { name: '打錯', currency: 'USD', tax_status: 'Roth' }), /tax_status 只能是/);
  });

  // N() would have turned both into a number without a word. A negative
  // unvested figure adds money nobody has; an unreadable one quietly becoming
  // 0 hands the employer's share back to the total.
  it('未歸屬是負的或讀不懂，一律拒絕，不會默默變成 0', async () => {
    const id = await open({ name: '會被拒絕的', unvested: 500 });
    for (const unvested of [-1, 'abc']) {
      await assert.rejects(() => PUT(`/api/accounts/${id}`, { unvested }), /unvested 要是 0 或正數/, `${unvested}`);
    }
    assert.equal((await find(id)).unvested, 500, '被拒絕的更新什麼都沒改');
    await PUT(`/api/accounts/${id}`, { name: '改名' });
    assert.equal((await find(id)).unvested, 500, '沒帶就維持原本的');
    await assert.rejects(() => POST('/api/accounts', { name: 'x', currency: 'USD', unvested: -5 }), /unvested/);
  });
});

// The file is built so its arithmetic can be checked end to end. The rows
// that import add up to 13,450.00 exactly: eleven contributions of 1,150.00
// and five dividends worth 800.00 between them. The two realized gain/loss
// lines would add 163.05 nobody put in, and every exchange date nets to
// zero, so an exchange imported as a flow is an expense and an income of the
// same amount. Last in the file because it adds a USD account, and suites
// above count accounts and USD totals outright.
describe('Fidelity 的 401(k) 交易紀錄', () => {
  const plan = {};
  const preview = (body) => POST('/api/import/preview', { content_base64: b64(FIDELITY_401K_CSV), ...body });

  after(async () => {
    if (plan.id) await DEL(`/api/accounts/${plan.id}`);
  });

  it('標題列在計畫名稱和日期區間那幾行之後，欄位對得到', async () => {
    const p = await preview({ filename: 'fidelity-401k.csv' });
    plan.mapping = p.mapping;
    assert.deepEqual(p.headers, ['Date', 'Investment', 'Transaction Type', 'Amount', 'Shares/Unit']);
    assert.equal(p.mapping.amountMode, 'single', '一欄、自帶正負號');
    assert.equal(p.headers[p.mapping.dateCol], 'Date');
    assert.equal(p.headers[p.mapping.amountCol], 'Amount');
    assert.deepEqual(p.mapping.descCols.map((i) => p.headers[i]), ['Investment'], '摘要是那一行的基金');
    assert.equal(p.headers[p.mapping.activityCol], 'Transaction Type');
    assert.equal(p.mapping.typeCol, null, '交易類型說的是這行是什麼，不是錢往哪走');
    assert.equal(p.summary.error, 0);
    assert.equal(p.summary.total, 25);
  });

  it('轉換和已實現損益擋下來，提撥和配息各自帶著類型匯入', async () => {
    const p = await preview({ mapping: plan.mapping });
    assert.equal(p.summary.internal, 9, '七行轉換、兩行已實現損益');
    assert.equal(p.summary.new, 16);
    near(p.summary.net, 13450, '十一筆提撥加五筆配息；多出 163.05 就是損益被匯進來了');
    const kinds = new Set(p.rows.filter((r) => r.status === 'new').map((r) => r.kind));
    assert.deepEqual([...kinds].sort(), ['dividend', 'income']);
  });

  // The one place the file's word has to reach the ledger: without it every
  // row would take the import's single default kind.
  it('建議開成退休金帳戶、美元，而且是檔案說的，不是用金額猜的', async () => {
    const s = (await preview({ filename: 'fidelity-401k.csv' })).suggested_account;
    assert.equal(s.kind, 'retirement');
    assert.ok(s.kind_confident);
    assert.equal(s.currency, 'USD');
    assert.equal(s.opening_source, null, '沒有餘額欄，推不出期初');
    assert.ok(s.notes.some((n) => /放進去的錢/.test(n)), '要說清楚匯進來的不含市值漲跌');
  });

  it('匯進退休金帳戶：餘額剛好 13,450，沒有任何一筆流出', async () => {
    plan.id = (await POST('/api/accounts', {
      name: '401(k)', kind: 'retirement', currency: 'USD', opening_balance: 0, opening_date: '2025-10-01',
    })).id;
    const r = await POST('/api/import/commit', {
      account_id: plan.id, content_base64: b64(FIDELITY_401K_CSV), mapping: plan.mapping, filename: 'fidelity-401k.csv',
    });
    assert.equal(r.imported, 16);
    near((await GET('/api/accounts')).find((a) => a.id === plan.id).balance, 13450);
    const txns = (await GET(`/api/txns?account=${plan.id}&limit=100`)).rows;
    assert.equal(txns.filter((t) => t.kind === 'income').length, 11, '提撥');
    assert.equal(txns.filter((t) => t.kind === 'dividend').length, 5, '配息');
    assert.ok(!txns.some((t) => t.amount < 0), '轉換流出的那一腳沒有進來');
  });

  it('同一份再匯一次，什麼都不會多，擋下的照樣擋下', async () => {
    const p = await preview({ account_id: plan.id, mapping: plan.mapping });
    assert.equal(p.summary.new, 0);
    assert.equal(p.summary.duplicate, 16);
    assert.equal(p.summary.internal, 9, '不匯入的行也不佔重複的位子');
  });

  it('帳戶頁的線：從開戶那個月起每個月底一點，最後一點就是餘額', async () => {
    const pts = await GET(`/api/accounts/${plan.id}/series?to=2026-09-30`);
    assert.deepEqual(pts[0], { date: '2025-10-31', value: 1150 }, '十月只有一筆提撥');
    assert.deepEqual(pts[pts.length - 1], { date: '2026-09-30', value: 13450 });
    assert.equal(pts.length, 12);
    await assert.rejects(() => GET('/api/accounts/999999/series'), /404/);
  });

  // The column is recognised by its cells, never its header. Chase heads its
  // Sale/Payment/Return column `Type` and Capital One's direction column is
  // `Transaction Type`, and neither may start holding rows back.
  it('其他每一家的檔案都不會被當成退休計畫的紀錄', async () => {
    for (const [name, text] of BANK_FIXTURES) {
      if (text === FIDELITY_401K_CSV) continue;
      const p = await POST('/api/import/preview', { content_base64: b64(text) });
      assert.equal(p.mapping.activityCol, null, `${name} 被認出了交易類型欄`);
      assert.equal(p.summary.internal, 0, `${name} 有行被當成不影響餘額`);
    }
  });
});
