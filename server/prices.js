'use strict';

// The one place this app reaches the network, and it does so only when the
// user has turned it on.
//
// Everything else in the ledger is offline by construction — `default-src
// 'none'` in the browser, no outbound call in Node. This file is the single,
// deliberate exception: an opt-in daily fetch of each holding's previous
// close, off by default, run server-side so the *page* still never connects
// out. `test/deps.test.js` allows the Yahoo host in this file and nowhere else.
//
// Why previous close and not the live price: the user asked for one settled
// number a day, not an intraday ticker. `parseQuote` walks back to the last
// COMPLETED session, so a mid-session bar never lands as if it were a close.
//
// Testability follows the rest of the codebase: the pure parts (`yahooTicker`,
// `parseQuote`) take data and return data, and `updatePrices` takes its network
// getter and its database handle as arguments — a fake getter and a throwaway
// db drive the whole thing under `node --test` with nothing leaving the
// machine and the real ledger never opened. See [[never-require-db]].

const https = require('node:https');
const { roundTo } = require('../shared/currency');
const { marketInfo } = require('../shared/kinds');

// The markets this fetch knows how to ask Yahoo about. A coin is not one of
// them: its bare symbol is not Yahoo's ticker for the coin, and a bare `BTC`
// can resolve to a listed fund quoted in USD, which would pass the currency
// check below and be stored as the coin's price. Coins stay priced by hand.
const FETCHABLE = new Set(['TW', 'US']);

// The only external address in the app. Kept as a base so the deps-test
// exception can be anchored to this file.
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';

const up = (s) => String(s == null ? '' : s).trim().toUpperCase();
const dayKey = (ms, gmtoffsetSec = 0) =>
  new Date(ms + gmtoffsetSec * 1000).toISOString().slice(0, 10);

// The ticker Yahoo knows a holding by. US is the bare symbol; a TW listing is
// suffixed, and the caller tries `.TW` (上市) then `.TWO` (上櫃) because the
// ledger does not record which board a symbol trades on.
function yahooTicker(symbol, market, board = 'TW') {
  const s = up(symbol);
  if (market === 'US') return s;
  if (market === 'TW') return `${s}.${board === 'TWO' ? 'TWO' : 'TW'}`;
  return s;
}

// Yahoo's chart response -> the most recent daily close, dated the exchange's
// own trading day, or null.
//
// It takes the latest non-null daily bar rather than skipping "today": run
// after the close (the natural once-a-day time) that bar *is* the day's settled
// close, and because it is dated today it becomes the newest observation and
// replaces whatever price the position was showing — which is the whole point
// of turning the fetch on. Run mid-session it is that instant's price instead;
// the trade-off is deliberate (see docs/formats or the settings note), and the
// alternative — always a day behind, and silently shadowed by any price the
// user entered today — is worse for a convenience feature.
function parseQuote(json) {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.meta) return null;
  const currency = r.meta.currency || null;
  const gmt = Number(r.meta.gmtoffset) || 0;
  const ts = r.timestamp || [];
  const quote = r.indicators && r.indicators.quote && r.indicators.quote[0];
  const closes = (quote && quote.close) || [];
  for (let i = Math.min(ts.length, closes.length) - 1; i >= 0; i--) {
    if (closes[i] == null) continue;
    return { date: dayKey(ts[i] * 1000, gmt), close: roundTo(closes[i], 4), currency };
  }
  return null;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      // A default Node user-agent gets an empty 200 from this endpoint; a
      // browser-ish one gets the JSON. No cookies, no auth, no body sent.
      { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, timeout: 8000 },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

// One holding's settled close, or null. The parsed currency must match the
// market (TW→TWD, US→USD): a wrong-currency answer means the symbol resolved to
// something else on Yahoo, and storing it would corrupt the valuation, so it is
// treated as a miss rather than trusted.
async function fetchSymbol(symbol, market, get) {
  if (!FETCHABLE.has(market)) return null;
  // The market's own currency, from the one list that says what a market
  // implies (shared/kinds.js MARKETS), rather than a ternary of its own.
  const want = marketInfo(market).currency;
  const tickers = market === 'TW'
    ? [yahooTicker(symbol, 'TW', 'TW'), yahooTicker(symbol, 'TW', 'TWO')]
    : [yahooTicker(symbol, market)];
  for (const t of tickers) {
    let json;
    try { json = await get(`${YAHOO_BASE}${encodeURIComponent(t)}?interval=1d&range=7d`); }
    catch { continue; }
    const q = parseQuote(json);
    if (q && q.currency === want && Number.isFinite(q.close) && q.close > 0) return q;
  }
  return null;
}

// Fetch every held symbol's previous close and write it as a `source: 'api'`
// price. `get` and the db handle are injected so the whole thing runs offline
// under test; in production both default to the real ones, and the db module is
// required lazily so importing this file for its pure helpers opens nothing.
async function updatePrices({ get = httpsGetJson, nowMs = Date.now(), deps } = {}) {
  const d = deps || require('./db');
  const { db, setMeta } = d;
  const held = db
    .prepare(
      "SELECT DISTINCT UPPER(TRIM(symbol)) AS symbol, market FROM holdings "
      + "WHERE TRIM(symbol) <> '' AND shares <> 0 ORDER BY market, symbol"
    )
    .all();
  const ins = db.prepare(
    `INSERT INTO prices (symbol, market, date, price, source) VALUES (?, ?, ?, ?, 'api')
     ON CONFLICT(symbol, market, date) DO UPDATE SET price = excluded.price, source = 'api'`
  );
  const updated = [];
  const failed = [];
  for (const h of held) {
    // Not asked about, so not a failure: a coin is priced by hand, and
    // reporting it as failed every day would be a warning nobody can clear.
    if (!FETCHABLE.has(h.market)) continue;
    let q = null;
    try { q = await fetchSymbol(h.symbol, h.market, get); } catch { q = null; }
    if (q) { ins.run(h.symbol, h.market, q.date, q.close); updated.push(h.symbol); }
    else failed.push(h.symbol);
  }
  // `_on` (a date) is the once-a-day gate; `_at` (a full timestamp) is what the
  // holdings view shows as "last updated".
  setMeta('prices_fetched_on', dayKey(nowMs));
  setMeta('prices_fetched_at', new Date(nowMs).toISOString());
  return { updated, failed, fetched_on: dayKey(nowMs) };
}

// Whether auto-fetch is on, and whether it has already run today. Both read the
// setting store, so a restart on the same day does nothing and leaving the
// server up overnight picks the new close up on the next start.
function autoPricesOn(deps) {
  const { getMeta } = deps || require('./db');
  return getMeta('auto_prices', '0') === '1';
}

// Called from index.js after the server is listening — fire-and-forget, never
// awaited, never allowed to take the process down. Returns the result (or null
// when it did nothing) so a test can drive it with injected deps.
async function maybeFetchOnStartup({ get, nowMs = Date.now(), deps } = {}) {
  const d = deps || require('./db');
  if (!autoPricesOn(d)) return null;
  if (d.getMeta('prices_fetched_on', '') === dayKey(nowMs)) return null;
  return updatePrices({ get, nowMs, deps: d });
}

module.exports = {
  YAHOO_BASE, yahooTicker, parseQuote, fetchSymbol,
  updatePrices, autoPricesOn, maybeFetchOnStartup,
};
