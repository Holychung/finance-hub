'use strict';

// The one networked feature, tested with nothing leaving the machine.
//
// `server/prices.js` requires only node:https and shared/currency at load —
// never ./db — so this file imports it in-process without opening a ledger. The
// pure halves (yahooTicker, parseQuote) take data and return data; updatePrices
// takes its network getter and its database handle as arguments, so a canned
// getter and a throwaway db drive the whole path offline. See [[never-require-db]].

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runMigrations } = require('../server/migrate');
const P = require('../server/prices');

const SEC = (iso) => Math.floor(Date.parse(iso) / 1000);
// A Yahoo chart response, trimmed to what parseQuote reads.
function chart(currency, bars, gmtoffset = 0) {
  return { chart: { result: [{
    meta: { currency, gmtoffset },
    timestamp: bars.map((b) => SEC(b[0])),
    indicators: { quote: [{ close: bars.map((b) => b[1]) }] },
  }] } };
}
// A getter that answers from a {ticker: chartJson} table and 404s otherwise —
// the ticker is read back out of the URL exactly as fetchSymbol built it.
function getter(table) {
  return async (url) => {
    const t = decodeURIComponent(url.slice(url.indexOf('/chart/') + 7, url.indexOf('?')));
    if (!(t in table)) throw new Error('HTTP 404');
    return table[t];
  };
}

describe('yahooTicker', () => {
  it('美股用原代號，台股加 .TW / .TWO', () => {
    assert.equal(P.yahooTicker('aapl', 'US'), 'AAPL');
    assert.equal(P.yahooTicker('2330', 'TW'), '2330.TW');
    assert.equal(P.yahooTicker('5483', 'TW', 'TWO'), '5483.TWO');
  });
});

describe('parseQuote', () => {
  it('取最後一根有收盤的日線', () => {
    const q = P.parseQuote(chart('USD', [['2026-06-11', 100], ['2026-06-12', 101.5]]));
    assert.deepEqual(q, { date: '2026-06-12', close: 101.5, currency: 'USD' });
  });

  it('最新那根就算是今天也用它——收盤後跑就是當天收盤', () => {
    const q = P.parseQuote(chart('USD', [['2026-06-12', 101.5], ['2026-06-15', 108]]));
    assert.equal(q.date, '2026-06-15');
    assert.equal(q.close, 108);
  });

  it('跳過 null 的收盤，往回找到有值的那根', () => {
    const q = P.parseQuote(chart('USD', [['2026-06-11', 100], ['2026-06-12', null]]));
    assert.equal(q.date, '2026-06-11');
  });

  it('沒有可用的資料就回 null，不亂猜', () => {
    assert.equal(P.parseQuote(chart('USD', [['2026-06-12', null]])), null);
    assert.equal(P.parseQuote({}), null);
    assert.equal(P.parseQuote({ chart: { result: [] } }), null);
  });

  it('用交易所時區判斷日期（gmtoffset）', () => {
    // A bar at 2026-06-12 20:00 UTC is 2026-06-13 in Taipei (+8h): the date is
    // the exchange's trading day, not UTC's.
    const q = P.parseQuote(chart('TWD', [['2026-06-12T20:00:00Z', 590]], 8 * 3600));
    assert.equal(q.date, '2026-06-13');
    assert.equal(q.currency, 'TWD');
  });
});

describe('updatePrices（注入假 getter 與拋棄式 db，全程離線）', () => {
  const now = Date.parse('2026-06-15T12:00:00Z');

  function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hub-prices-'));
    const db = new DatabaseSync(path.join(dir, 'x.db'));
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, {});
    db.exec("INSERT INTO accounts (id, name, kind, currency) VALUES (1,'美股券商','brokerage','USD'),(2,'台股券商','brokerage','TWD')");
    const meta = new Map();
    const deps = {
      db,
      getMeta: (k, f = null) => (meta.has(k) ? meta.get(k) : f),
      setMeta: (k, v) => meta.set(k, String(v)),
    };
    return { dir, db, deps, meta, rm: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  it('抓到的寫成 source=api，抓不到的進 failed，其餘不動', async () => {
    const s = scratch();
    s.db.exec(`INSERT INTO holdings (account_id, symbol, market, shares, avg_cost, last_price, currency) VALUES
      (1,'AAPL','US',10,100,0,'USD'),
      (2,'2330','TW',500,900,0,'TWD'),
      (1,'NOPE','US',5,10,7,'USD')`);

    const get = getter({
      AAPL: chart('USD', [['2026-06-11', 200], ['2026-06-12', 205]]),
      '2330.TW': chart('TWD', [['2026-06-12', 1090]], 8 * 3600),
      // NOPE: absent → 404 → failed
    });

    const r = await P.updatePrices({ get, nowMs: now, deps: s.deps });
    assert.deepEqual(r.updated.sort(), ['2330', 'AAPL']);
    assert.deepEqual(r.failed, ['NOPE']);
    assert.equal(r.fetched_on, '2026-06-15');
    assert.equal(s.meta.get('prices_fetched_on'), '2026-06-15');

    const rows = s.db.prepare('SELECT symbol, market, date, price, source FROM prices ORDER BY symbol').all().map((x) => ({ ...x }));
    assert.deepEqual(rows, [
      { symbol: '2330', market: 'TW', date: '2026-06-12', price: 1090, source: 'api' },
      { symbol: 'AAPL', market: 'US', date: '2026-06-12', price: 205, source: 'api' },
    ]);
    s.rm();
  });

  it('台股 .TW 抓不到會退而試 .TWO', async () => {
    const s = scratch();
    s.db.exec("INSERT INTO holdings (account_id, symbol, market, shares, avg_cost, last_price, currency) VALUES (2,'5483','TW',1000,80,0,'TWD')");
    const get = getter({ '5483.TWO': chart('TWD', [['2026-06-12', 95.5]], 8 * 3600) });
    const r = await P.updatePrices({ get, nowMs: now, deps: s.deps });
    assert.deepEqual(r.updated, ['5483']);
    assert.equal(s.db.prepare("SELECT price FROM prices WHERE symbol='5483'").get().price, 95.5);
    s.rm();
  });

  it('幣別對不上（代號在 Yahoo 指到別的東西）就當抓不到，不寫進去', async () => {
    const s = scratch();
    s.db.exec("INSERT INTO holdings (account_id, symbol, market, shares, avg_cost, last_price, currency) VALUES (2,'0050','TW',100,150,0,'TWD')");
    // 0050.TW resolves, but Yahoo hands back USD — a wrong match; must be rejected.
    const get = getter({ '0050.TW': chart('USD', [['2026-06-12', 60]], 8 * 3600), '0050.TWO': chart('USD', [['2026-06-12', 60]]) });
    const r = await P.updatePrices({ get, nowMs: now, deps: s.deps });
    assert.deepEqual(r.failed, ['0050']);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM prices').get().n, 0, '寧可不寫，也不寫錯幣別的價');
    s.rm();
  });

  it('shares 為 0 的持股不抓', async () => {
    const s = scratch();
    s.db.exec("INSERT INTO holdings (account_id, symbol, market, shares, avg_cost, last_price, currency) VALUES (1,'SOLD','US',0,100,120,'USD')");
    let called = 0;
    const get = async () => { called++; throw new Error('should not be called'); };
    const r = await P.updatePrices({ get, nowMs: now, deps: s.deps });
    assert.equal(called, 0, '賣光的部位沒有理由再抓');
    assert.deepEqual(r.updated, []);
    assert.deepEqual(r.failed, []);
    s.rm();
  });
});
