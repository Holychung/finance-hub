'use strict';

// The routes, registered for server/index.js. Nearly all of them are written
// once in shared/handlers.js, which the hosted demo runs too, and answered
// here from SQLite through server/ledger.js. The ones below are the routes
// only a server can answer: the price refresh and AI 健檢 reach the network,
// the backups are files beside the book, and the settings say which file is
// open.

const crypto = require('node:crypto');
const path = require('node:path');
const paths = require('./paths');
const { db, getMeta, setMeta, snapshot, listBackups } = require('./db');
const csv = require('../shared/csv');
const M = require('./money');
const PRICES = require('./prices');
const AI = require('./ai');

const S = (v, d = '') => (v === undefined || v === null ? d : String(v));
const now = () => new Date().toISOString();

// One error class for every route, the shared ones included, because
// server/index.js answers with the status of exactly this class.
const { defineLedgerRoutes, ApiError: HttpError } = require('../shared/handlers');
const { makeLedger } = require('./ledger');
const ledger = makeLedger({ db, getMeta, setMeta, M });
const bad = (msg) => { throw new HttpError(400, msg); };

// ---------------------------------------------------------------------------

// A route registered twice is refused at load. The second used to replace the
// first without a word, so a route moved into shared/handlers.js and left
// behind here would answer instead of the shared one.
const routes = {};
const on = (method, pattern, handler) => {
  const key = `${method} ${pattern}`;
  if (routes[key]) throw new Error(`路由重複註冊：${key}`);
  routes[key] = handler;
};

// --- prices refresh ---------------------------------------------------------

// Opt-in daily fetch of each holding's previous close (server/prices.js). Off
// unless the user turned it on in settings, and when off this does nothing and
// says so, so the button can stay hidden without the endpoint pretending. Async
// because the network wait is the one place a handler genuinely is not sync,
// which is also why it is not in shared/handlers.js.
on('POST', '/api/prices/refresh', async () => {
  if (getMeta('auto_prices', '0') !== '1') return { enabled: false, updated: [], failed: [] };
  return { enabled: true, ...(await PRICES.updatePrices()) };
});

// --- the shared routes -----------------------------------------------------

// Written once in shared/handlers.js and answered here from SQLite through
// server/ledger.js; the demo registers the same handlers over its Map. What
// comes back is the two file exports, which server/index.js sends.
const { exportFile } = defineLedgerRoutes(on, {
  L: ledger,
  now,
  today: M.todayISO,
  uuid: () => crypto.randomUUID(),
  // The pre-import copy of the book, by the name the import page shows.
  snapshot: (label) => {
    const dest = snapshot(label);
    return dest ? path.basename(dest) : null;
  },
  decodeBase64: (s) => Buffer.from(s, 'base64'),
});

// --- backups ---------------------------------------------------------------

// The pre-import snapshots beside the book: files, so a server's alone.
on('GET', '/api/backups', () => listBackups());

// --- settings ----------------------------------------------------------------

on('GET', '/api/settings', () => ({
  base_currency: getMeta('base_currency', 'TWD'),
  schema_version: getMeta('schema_version', '1'),
  // The UI says which book is open, so a demo window is never mistaken for
  // the real one. The path is already local-only information.
  profile: paths.PROFILE,
  is_personal: paths.IS_PERSONAL,
  db_path: paths.DB_PATH,
  // Off unless the user turned it on: the whole app is offline by default and
  // this is one of the two switches that let it reach out (AI 健檢 has the
  // other). `prices_fetched_on` lets the holdings view say when it last ran.
  auto_prices: getMeta('auto_prices', '0') === '1',
  prices_fetched_on: getMeta('prices_fetched_on', null),
  prices_fetched_at: getMeta('prices_fetched_at', null),
  // How far AI may reach for this book — the mode the sidebar draws. Here as
  // well as in GET /api/ai because that one reads the keychain, and the chrome
  // asks on every load. It is written through PUT /api/ai.
  ai_reach: AI.settings(getMeta).reach,
}));

on('PUT', '/api/settings', (_p, b) => {
  if (b.base_currency) setMeta('base_currency', String(b.base_currency).toUpperCase());
  if (b.auto_prices !== undefined) setMeta('auto_prices', b.auto_prices ? '1' : '0');
  return { ok: true };
});

// --- AI 健檢 ----------------------------------------------------------------

// The one feature that sends the book off the machine, and only when somebody
// presses 送出: see server/ai.js. It raises AiError with the status it means —
// a refused setting is a 400, a provider that failed a 502 — and this turns
// that into the router's HttpError, keeping a sync handler sync.
const viaAi = (fn) => (...args) => {
  const asHttp = (e) => (e instanceof AI.AiError ? new HttpError(e.status, e.message) : e);
  try {
    const out = fn(...args);
    return out instanceof Promise ? out.catch((e) => { throw asHttp(e); }) : out;
  } catch (e) { throw asHttp(e); }
};

// It reads the keychain, so a locked one is an AiError too.
on('GET', '/api/ai', viaAi(() => AI.status({ getMeta })));

on('PUT', '/api/ai', viaAi((_p, b) => AI.saveSettings(b, { getMeta, setMeta })));

// There is no route that takes a key. It is set on the machine, by its owner,
// in the keychain or the environment; the page only says how.

// Exactly what 送出 would send, for the page to show above the button. `to`
// pins the day, so a test can hold it against the exported file.
on('GET', '/api/ai/preview', viaAi((_p, _b, q) => {
  const asOf = q.to ? csv.parseDate(q.to, 'auto') || bad(`日期無法解析：${q.to}`) : M.todayISO();
  return AI.preview({ mode: S(q.mode), asOf, getMeta });
}));

// Async because the provider's answer is a network wait of up to minutes —
// the other handler here that genuinely is not sync, beside the price refresh.
// The page sends back the preview's day and digest; the document itself is
// rebuilt from the book, never taken from the request.
on('POST', '/api/ai/review', viaAi((_p, b) => {
  const asOf = b.as_of ? csv.parseDate(S(b.as_of), 'auto') || bad(`日期無法解析：${b.as_of}`) : M.todayISO();
  return AI.review({ mode: S(b.mode), asOf, digest: S(b.digest), getMeta });
}));

module.exports = { routes, HttpError, exportFile };
