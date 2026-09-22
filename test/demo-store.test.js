'use strict';

// Run with:  node --test
//
// The demo adapter answers the same `/api/...` vocabulary as the server, so
// the test that matters is not "does it return something plausible" but
// **does it return the same thing**. Both are driven through the identical
// sequence of writes — the real one over HTTP against a throwaway database,
// the demo one over its own Map — and then every read is compared.
//
// Anything that legitimately differs is normalised away and named where it
// is: ids line up because both assign sequentially from empty, but wall-clock
// timestamps and a random transfer group cannot, and `/api/settings` is
// *supposed* to differ because that is how the chrome says which one you are
// looking at.
//
// The plan asked for the store's logic to sit behind an injected raw store so
// a test could drive it with a plain Map. It does, and the second half of
// this file does exactly that — but the comparison above is the one that
// would catch a handler quietly answering something the views cannot use.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeMapStore, createDemoStorage } = require('../web/storage-demo.js');
const { buildDemoStatement } = require('../shared/demo-seed.js');

const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const FIXTURES = path.join(__dirname, 'fixtures');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function waitForReady(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(`${url}/api/settings`)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not come up at ${url}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// An adapter-shaped client over the real server, so the script below can be
// written once and run against either.
const httpClient = (base) => {
  const req = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `${res.status}`), { status: res.status });
    return data;
  };
  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    put: (p, b) => req('PUT', p, b),
    del: (p) => req('DELETE', p),
  };
};

// Everything invented, the same rule test/fixtures/ lives under.
const SCRIPT = async (s) => {
  await s.post('/api/institutions', { name: '玉山銀行', kind: 'bank', country: 'TW' });
  await s.post('/api/institutions', { name: 'Firstrade', kind: 'broker', country: 'US' });
  await s.post('/api/accounts', { institution_id: 1, name: '台幣活存', kind: 'cash', currency: 'TWD', opening_balance: 120000, opening_date: '2026-01-01' });
  await s.post('/api/accounts', { institution_id: 1, name: '信用卡', kind: 'card', currency: 'TWD', opening_balance: -8400, opening_date: '2026-01-01' });
  await s.post('/api/accounts', { institution_id: 2, name: '券商', kind: 'brokerage', currency: 'USD', opening_balance: 3000, opening_date: '2026-02-01', access: 'restricted' });
  await s.post('/api/accounts', { name: '冷錢包', kind: 'wallet', currency: 'USD', opening_balance: 0, opening_date: '2026-03-01' });
  // No access given, so both sides have to start it restricted from its kind;
  // the unvested figure has to come off both net worths and neither balance.
  await s.post('/api/accounts', { institution_id: 2, name: '401(k)', kind: 'retirement', currency: 'USD', opening_balance: 18000, opening_date: '2026-01-01', tax_status: 'pretax', unvested: 950 });

  await s.post('/api/fx', { date: '2026-01-05', pair: 'USDTWD', rate: 31.4 });
  await s.post('/api/fx', { date: '2026-06-05', pair: 'USDTWD', rate: 32.1 });

  await s.post('/api/txns', { account_id: 1, date: '2026-01-25', amount: 68000, description: '薪資轉帳', kind: 'income' });
  await s.post('/api/txns', { account_id: 1, date: '2026-02-03', amount: -1250.5, description: 'PX MART 全聯', category: '食' });
  await s.post('/api/txns', { account_id: 2, date: '2026-02-04', amount: -3200, description: 'UBER EATS' });
  await s.post('/api/txns', { account_id: 1, date: '2026-03-10', amount: -31400, description: '轉出至券商' });
  await s.post('/api/txns', { account_id: 3, date: '2026-03-11', amount: 1000, description: 'INCOMING WIRE' });
  await s.post('/api/txns', { account_id: 2, date: '2026-04-02', amount: -899, description: 'UBER EATS' });

  await s.post('/api/holdings', { account_id: 3, symbol: 'vti', name: 'Vanguard Total', market: 'US', shares: 12, avg_cost: 210, last_price: 248.5, currency: 'USD' });
  // Two price observations, so /api/holdings values off the series (the latest
  // at or before today) rather than the last_price it was created with — the
  // same resolution has to happen on both sides or the holdings read diverges.
  await s.post('/api/prices', { symbol: 'vti', market: 'US', date: '2026-03-15', price: 251 });
  await s.post('/api/prices', { symbol: 'VTI', market: 'US', date: '2026-05-20', price: 262.4 });
  // A coin sent the way a hand-written client would: lower-case market, no
  // currency, no decimals. Both sides have to fill in USD and eight places,
  // and the price has to land on the same series the holding reads.
  await s.post('/api/holdings', { account_id: 4, symbol: 'btc', name: 'Bitcoin', market: 'crypto', shares: 0.12345678, avg_cost: 51800, last_price: 63250.4 });
  await s.post('/api/prices', { symbol: 'btc', market: 'crypto', date: '2026-05-20', price: 64100.25 });
  await s.post('/api/balance-checks', { account_id: 1, date: '2026-03-31', stated: 155349.5 });
  await s.post('/api/rules', { pattern: 'UBER EATS', category: '食', priority: 10 });

  // A write that reads back what it wrote, and the edit path.
  const extra = await s.post('/api/txns', { account_id: 1, date: '2026-05-01', amount: -10, description: 'TO BE EDITED' });
  await s.put(`/api/txns/${extra.id}`, { amount: -25.5, description: 'EDITED' });
  const doomed = await s.post('/api/txns', { account_id: 1, date: '2026-05-02', amount: -1, description: 'TO BE DELETED' });
  await s.del(`/api/txns/${doomed.id}`);
};

// Fields that cannot line up between a real clock and an injected one, and
// the surrogate keys that hang off them.
const NORMALISE = new Set(['created_at', 'used_at', 'exported_at', 'transfer_group', 'as_of', 'stated_on']);

function scrubWith(extra) {
  const drop = new Set([...NORMALISE, ...extra]);
  return function walk(v) {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = drop.has(k) ? (val === null ? null : '·') : walk(val);
      return out;
    }
    return v;
  };
}

const scrub = scrubWith([]);
// Ids diverge, on purpose, once anything has been deleted — see the test
// named for it. Used only where that has happened.
const scrubIds = scrubWith(['id', 'import_id']);

describe('demo adapter 跟真伺服器回同一份東西', () => {
  let child;
  let tmpDir;
  let live;
  let demo;

  before(async () => {
    const port = await freePort();
    // Its own directory, not just its own filename: paths.js derives
    // BACKUP_DIR from the database's directory.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hub-demo-'));
    child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, FINANCE_DB: path.join(tmpDir, 'finance.db'), PORT: String(port) },
      stdio: 'ignore',
    });
    child.on('error', (e) => { throw e; });
    await waitForReady(`http://127.0.0.1:${port}`);

    live = httpClient(`http://127.0.0.1:${port}`);
    demo = createDemoStorage({
      raw: makeMapStore({ meta: [{ key: 'base_currency', value: 'TWD' }] }),
      now: () => '2026-09-21T00:00:00.000Z',
      uuid: () => 'g1',
    });

    await SCRIPT(live);
    await SCRIPT(demo);
  });

  after(() => {
    if (child) child.kill();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // `to=` is pinned on everything that would otherwise read the clock, so the
  // two are asked about the same day.
  const SAME = [
    '/api/accounts',
    '/api/institutions',
    '/api/holdings',
    '/api/prices?symbol=VTI&market=US',
    '/api/prices?symbol=BTC&market=CRYPTO',
    '/api/fx',
    '/api/reconcile',
    '/api/rules',
    '/api/mappings',
    '/api/imports',
    '/api/txns?limit=200',
    '/api/txns?account=1&limit=200',
    '/api/txns?from=2026-02-01&to=2026-03-31&limit=200',
    '/api/txns?q=uber&limit=200',
    '/api/txns?kind=income&limit=200',
    '/api/txns?limit=2&offset=1',
    '/api/transfers/candidates',
    '/api/coverage?months=6&to=2026-09-30',
    '/api/spending?from=2026-01-01&to=2026-09-30',
    '/api/recurring?from=2025-01-01&to=2026-09-30',
    '/api/export/json',
  ];

  for (const p of SAME) {
    it(`GET ${p}`, async () => {
      assert.deepEqual(scrub(await demo.get(p)), scrub(await live.get(p)));
    });
  }

  // The overview reads the clock for `as_of` and for the end of the series,
  // so it is compared field by field against a pinned day rather than whole.
  it('GET /api/overview — 除了 as_of 以外一致', async () => {
    const [a, b] = [scrub(await demo.get('/api/overview')), scrub(await live.get('/api/overview'))];
    assert.deepEqual(a.net_worth.currencies, b.net_worth.currencies);
    assert.deepEqual(a.net_worth.order, b.net_worth.order);
    assert.deepEqual(a.accounts, b.accounts);
    assert.deepEqual(a.holdings, b.holdings);
    assert.deepEqual(a.reconcile, b.reconcile);
    assert.deepEqual(a.counts, b.counts);
    assert.deepEqual(a.liabilities_in_credit, b.liabilities_in_credit);
    assert.deepEqual(a.fx_latest, b.fx_latest);
    // The series ends on today either way, so only its shape and its start
    // can be compared without freezing the server's clock too.
    assert.deepEqual(Object.keys(a.series).sort(), Object.keys(b.series).sort());
    for (const cur of Object.keys(a.series)) {
      assert.deepEqual(a.series[cur][0], b.series[cur][0], `${cur} 的第一個點`);
    }
    // The same for each half the overview's switch can show.
    assert.deepEqual(Object.keys(a.series_by_access).sort(), Object.keys(b.series_by_access).sort());
    for (const [access, s] of Object.entries(a.series_by_access)) {
      assert.deepEqual(Object.keys(s).sort(), Object.keys(b.series_by_access[access]).sort(), access);
      for (const cur of Object.keys(s)) {
        assert.deepEqual(s[cur][0], b.series_by_access[access][cur][0], `${access} ${cur} 的第一個點`);
      }
    }
  });

  it('同一份對帳單，兩邊預覽出同一批資料列', async () => {
    const content_base64 = fs.readFileSync(path.join(FIXTURES, 'esun-savings.csv')).toString('base64');
    const body = { account_id: 1, filename: 'esun-savings.csv', content_base64 };
    const [a, b] = [await demo.post('/api/import/preview', body), await live.post('/api/import/preview', body)];
    assert.deepEqual(a.mapping, b.mapping, '欄位對應');
    assert.deepEqual(a.headers, b.headers);
    assert.equal(a.encoding, b.encoding);
    assert.deepEqual(a.summary, b.summary, '每一種狀態的筆數');
    assert.deepEqual(a.reconcile, b.reconcile, '匯入後會不會對得上');
    assert.deepEqual(a.rows, b.rows, '每一行的指紋、狀態、金額');
  });

  it('同一份對帳單，兩邊匯入後的帳本一致', async () => {
    const content_base64 = fs.readFileSync(path.join(FIXTURES, 'esun-savings.csv')).toString('base64');
    const pre = await demo.post('/api/import/preview', { account_id: 1, content_base64 });
    const body = { account_id: 1, filename: 'esun-savings.csv', content_base64, mapping: pre.mapping };

    const [a, b] = [await demo.post('/api/import/commit', body), await live.post('/api/import/commit', body)];
    assert.equal(a.imported, b.imported);
    assert.equal(a.skipped, b.skipped);
    assert.equal(a.transfer_candidates, b.transfer_candidates);
    // The one place they are allowed to differ, and it is stated rather than
    // faked: a browser has no filesystem to snapshot to.
    assert.equal(a.backup, null, 'demo 沒有檔案系統，不能假造一個備份檔名');
    assert.ok(typeof b.backup === 'string', '真伺服器有拍快照');

    assert.deepEqual(scrub(await demo.get('/api/accounts')), scrub(await live.get('/api/accounts')));
    // Ids are scrubbed here and only here: the setup deleted a row, and from
    // that point the two number new rows differently on purpose. Everything
    // else about every row — date, amount, description, category,
    // fingerprint, source — still has to match exactly.
    assert.deepEqual(scrubIds(await demo.get('/api/txns?limit=500')), scrubIds(await live.get('/api/txns?limit=500')));

    // And importing it a second time must find every row already there.
    const again = await demo.post('/api/import/preview', { account_id: 1, content_base64 });
    assert.equal(again.summary.new, 0, '同一份檔案再匯一次，不該有新的');
    assert.ok(again.summary.duplicate > 0);
  });

  // The one divergence, named rather than normalised away everywhere. SQLite
  // hands a deleted row's rowid back to the next insert; the demo store
  // counts monotonically. Reusing an id means a bookmarked /account/3 or a
  // /api/txns/412 quietly points at a different row than it did, which is
  // not a thing to inherit just because SQLite does it.
  it('刪掉最後一筆之後，兩邊發出的 id 就不一樣了——而且是故意的', async () => {
    const a = await demo.post('/api/txns', { account_id: 1, date: '2026-06-01', amount: -1, description: 'ID PROBE' });
    const b = await live.post('/api/txns', { account_id: 1, date: '2026-06-01', amount: -1, description: 'ID PROBE' });
    assert.ok(a.id > b.id, `demo ${a.id} 應該比伺服器 ${b.id} 大：中間刪掉的那個號碼沒有被發回去`);
    await demo.del(`/api/txns/${a.id}`);
    await live.del(`/api/txns/${b.id}`);
  });

  it('回復匯入，兩邊都回到原狀', async () => {
    const imports = await demo.get('/api/imports');
    const liveImports = await live.get('/api/imports');
    await demo.del(`/api/imports/${imports[0].id}`);
    await live.del(`/api/imports/${liveImports[0].id}`);
    assert.deepEqual(scrubIds(await demo.get('/api/txns?limit=500')), scrubIds(await live.get('/api/txns?limit=500')));
    assert.deepEqual(scrub(await demo.get('/api/accounts')), scrub(await live.get('/api/accounts')));
  });

  it('設定是刻意不一樣的——那正是使用者分辨得出來的方式', async () => {
    const [a, b] = [await demo.get('/api/settings'), await live.get('/api/settings')];
    assert.equal(a.is_personal, false, 'demo 一定要讓側邊欄徽章變色');
    assert.equal(b.is_personal, true);
    assert.equal(a.profile, 'demo');
    assert.equal(a.db_path, null, 'demo 沒有檔案，不該編一個路徑出來');
    assert.ok(typeof b.db_path === 'string');
    assert.equal(a.base_currency, b.base_currency);
    // Not one of the differences. The demo's rows are built with every column
    // the last migration added, so it is that version; it said 6 for two
    // steps because nothing compared it.
    assert.equal(a.schema_version, b.schema_version, 'demo 的 schema 版本要跟全新的伺服器一樣');
  });

  it('沒有這條 route 時兩邊都是 404', async () => {
    await assert.rejects(() => demo.get('/api/nope'), (e) => e.status === 404);
    await assert.rejects(() => live.get('/api/nope'), (e) => e.status === 404);
  });

  it('壞資料兩邊都是 400，而且是同一句話', async () => {
    for (const [p, body] of [
      ['/api/txns', { date: '2026-01-01', amount: 1 }],
      ['/api/fx', { date: 'not a date', rate: 30 }],
      ['/api/fx', { date: '2026-01-01', rate: 0 }],
      ['/api/rules', { pattern: '!!!', category: '食' }],
      ['/api/import/commit', { account_id: 1 }],
      ['/api/holdings', { account_id: 4, symbol: 'ETH', market: 'NYSE' }],
      ['/api/holdings', { account_id: 4, symbol: 'ETH', market: 'CRYPTO', decimals: 12 }],
      ['/api/prices', { symbol: 'ETH', market: 'eth-chain', date: '2026-01-01', price: 1 }],
      ['/api/accounts', { name: 'IRA', kind: 'retirement', tax_status: 'ira' }],
      ['/api/accounts', { name: 'IRA', kind: 'retirement', unvested: -1 }],
    ]) {
      const of = async (s) => { try { await s.post(p, body); return null; } catch (e) { return [e.status, e.message]; } };
      assert.deepEqual(await of(demo), await of(live), `${p} ${JSON.stringify(body)}`);
    }
  });

  // No row carries this symbol, which is the case a market check placed
  // inside the row predicate never reaches: it would answer 200, not 400.
  it('刪價格時市場不對，兩邊都拒絕，就算沒有這個代號', async () => {
    const q = '/api/prices?symbol=NOPE&market=nyse&date=2026-01-01';
    const of = async (s) => { try { await s.del(q); return null; } catch (e) { return [e.status, e.message]; } };
    const [a, b] = [await of(demo), await of(live)];
    assert.equal(b?.[0], 400);
    assert.deepEqual(a, b);
  });
});

describe('demo adapter — 用一個純 Map 驅動', () => {
  const build = (seed) => {
    const raw = makeMapStore(seed);
    return { raw, s: createDemoStorage({ raw, now: () => '2026-09-21T00:00:00.000Z', uuid: () => 'g1' }) };
  };

  it('寫進去的東西，測試從 raw store 讀得回來', async () => {
    const { raw, s } = build({});
    await s.post('/api/accounts', { name: '活存', currency: 'TWD', opening_balance: 100 });
    await s.post('/api/txns', { account_id: 1, date: '2026-01-01', amount: -40, description: 'x' });
    assert.equal(raw.all('txns').length, 1);
    assert.equal(raw.all('txns')[0].fingerprint.length, 40, '指紋就是 sha1，跟伺服器同一個');
    assert.equal(raw.get('accounts', 1).name, '活存');
  });

  it('id 是單調遞增的，刪掉最後一筆也不會被重新發出去', async () => {
    const { s } = build({});
    const a = await s.post('/api/accounts', { name: 'A' });
    const b = await s.post('/api/accounts', { name: 'B' });
    await s.del(`/api/accounts/${b.id}`);
    const c = await s.post('/api/accounts', { name: 'C' });
    assert.deepEqual([a.id, b.id, c.id], [1, 2, 3],
      'SQLite 會把 rowid 發回去，但那會讓 /account/2 這種連結指到別人');
  });

  it('讀出來的是副本，handler 改不到 store 裡的列', async () => {
    const { raw, s } = build({});
    await s.post('/api/accounts', { name: '活存', opening_balance: 100 });
    const [a] = await s.get('/api/accounts');
    a.name = '被改掉了';
    assert.equal(raw.get('accounts', 1).name, '活存');
  });

  it('交易失敗就整批回滾', async () => {
    const { raw, s } = build({});
    await s.post('/api/accounts', { name: '活存' });
    await assert.rejects(() => s.post('/api/fx', {
      rows: [{ date: '2026-01-01', rate: 30 }, { date: '2026-01-02', rate: -1 }],
    }));
    assert.equal(raw.all('fx_rates').length, 0, '第一筆不該留下來');
  });

  it('交易不能巢狀', () => {
    const { raw } = build({});
    assert.throws(() => raw.tx(() => raw.tx(() => 1)), /巢狀/);
  });

  it('重設把一切還原成種子', async () => {
    const seed = { accounts: [{ id: 1, name: '活存', currency: 'TWD', opening_balance: 100, opening_date: '2026-01-01', kind: 'cash', is_active: 1, sort_order: 0, note: '' }] };
    const { s } = build(seed);
    await s.post('/api/txns', { account_id: 1, date: '2026-01-02', amount: -50, description: 'x' });
    assert.equal((await s.get('/api/accounts'))[0].balance, 50);
    s.reset(seed);
    assert.equal((await s.get('/api/accounts'))[0].balance, 100);
    assert.equal((await s.get('/api/txns')).total, 0);
  });

  // The headline demo interaction: press 載入一份範例對帳單 and watch the
  // file parse. It is the one thing a visitor is invited to do, so it is
  // driven here exactly as the button drives it — no account selected, which
  // is what puts the 「從這個檔案建立帳戶」 flow on screen.
  it('範例對帳單真的解析得開，而且從檔案就能開出一個帳戶', async () => {
    const { s } = build({});
    const st = buildDemoStatement('2026-09-21');
    const content_base64 = Buffer.from(st.text, 'utf8').toString('base64');
    const p = await s.post('/api/import/preview', { filename: st.name, content_base64 });

    assert.equal(p.mapping.dateFormat, 'roc', '民國年是這份檔案要示範的東西之一');
    assert.equal(p.mapping.amountMode, 'inout', '支出／存入兩欄');
    assert.equal(p.summary.total, 10);
    assert.equal(p.summary.new, 10, '示範的檔案要全部匯得進去，不然第一印象是一排紅字');
    assert.equal(p.summary.error, 0);
    assert.equal(p.summary.balance_breaks, 0, '餘額欄要逐行對得起來——那是這份檔案的重點');
    assert.equal(p.summary.repaired, 0);

    // Every row has already happened, so committing actually moves a balance.
    // A statement dated next month imports just as cleanly and then changes
    // nothing on screen, because a balance is computed as of today.
    assert.ok(p.summary.date_max < '2026-09-21', `對帳單不能是未來的：${p.summary.date_max}`);

    // Nothing is selected, so the file is expected to describe the account
    // itself — exactly, because it carries a balance column.
    const sug = p.suggested_account;
    assert.equal(sug.kind, 'cash');
    assert.ok(sug.kind_confident, '有餘額欄就不是用金額猜的');
    assert.equal(sug.currency, 'TWD');
    assert.equal(sug.opening_balance, 620000, '第一行餘額減掉它自己那筆');
    assert.equal(sug.opening_source, 'derived');
    assert.match(sug.notes[0], /倒推/, '倒推出來的數字要說它是倒推的');
    // `fromFilename` reads `Chase8801_…`, not a Chinese filename, so there is
    // no name to suggest and it says so by leaving it blank rather than
    // offering the filename as one. The visitor types it — which is also
    // what pressing 建立 on a real 玉山 download asks of them.
    assert.equal(sug.name, '');

    const acct = await s.post('/api/accounts', {
      name: '玉山 活存', kind: sug.kind, currency: sug.currency,
      opening_balance: sug.opening_balance, opening_date: sug.opening_date,
    });
    const done = await s.post('/api/import/commit', { account_id: acct.id, content_base64, mapping: p.mapping });
    assert.equal(done.imported, 10);
    assert.equal((await s.get('/api/accounts'))[0].balance, 637885,
      '匯完的餘額要等於對帳單最後一行的餘額');

    // Dropping the same file again finds every row already there.
    const again = await s.post('/api/import/preview', { account_id: acct.id, content_base64 });
    assert.equal(again.summary.new, 0);
    assert.equal(again.summary.duplicate, 10);

    // The month is not a constant, so the days have to survive February.
    assert.match(buildDemoStatement('2026-03-05').text, /115\/02\/28,/);
  });

  it('匯出的是真的檔案內容，不是一個開不起來的 blob 網址', async () => {
    const { s } = build({});
    await s.post('/api/accounts', { name: '活存', currency: 'TWD', opening_balance: 1000 });
    const f = s.exportFile('/api/export/csv?type=accounts');
    assert.equal(f.name, 'accounts_2026-09-21.csv', 'blob 網址沒有檔名，adapter 得自己給');
    assert.ok(f.body.startsWith('﻿'), 'Excel 要 BOM');
    assert.match(f.body, /活存,cash,TWD/);
    assert.equal(s.exportName('/api/export/json'), 'finance_backup.json');
  });
});
