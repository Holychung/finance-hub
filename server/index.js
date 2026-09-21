'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Consulted before anything opens a database: ./paths has no side effects,
// while requiring ./api pulls in ./db, which creates the file it is told to
// open. Refusing here is the difference between a clear instruction and a
// brand new empty ledger sitting beside the real one.
const paths = require('./paths');
if (paths.strandedLegacyDb) {
  console.error('');
  console.error('  帳本位置已經改了，但舊的那本還在 repo 裡面。');
  console.error('');
  console.error(`    舊：${paths.strandedLegacyDb}`);
  console.error(`    新：${paths.DB_PATH}`);
  console.error('');
  console.error('  現在直接啟動會在新位置開一本空帳，舊的那本原封不動留在 repo，');
  console.error('  而 repo 裡的東西會被 git clean -xdf 一起刪掉。先搬過去：');
  console.error('');
  console.error('    node scripts/migrate-data-dir.js');
  console.error('');
  console.error('  搬完舊檔還會留著，確認新的沒問題再自己刪。');
  console.error('  真的想開一本新的空帳：FINANCE_PROFILE=<名字> node server/index.js');
  console.error('');
  process.exit(1);
}

const { csp, LOCAL } = require('./csp');
const { routes, HttpError } = require('./api');
const { db, DB_PATH } = require('./db');
const M = require('./money');
const { exportCsv: sharedExport } = require('../shared/export');

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1'; // never bind the world to a ledger
const WEB_DIR = path.join(__dirname, '..', 'web');
// The browser loads the same domain modules Node requires, from the same
// files. Served out of their own directory rather than copied into `web/`,
// because a second copy of `csv.js` is the exact thing `shared/` exists to
// prevent.
const SHARED_DIR = path.join(__dirname, '..', 'shared');

// Binding to loopback keeps other machines out; it does nothing about the
// browser already running on this one. Two checks close that gap.
//
// 1. DNS rebinding. A page on evil.com can re-point its own hostname at
//    127.0.0.1. The browser still calls it evil.com, so same-origin policy
//    stops protecting anything and the page can read the whole ledger. Those
//    requests arrive with `Host: evil.com`, so pinning Host shuts it out.
// 2. CSRF. Reads are already blocked — no Access-Control-Allow-Origin means
//    the browser withholds the response body. Writes are not: a cross-site
//    POST with a simple content type never triggers a preflight and lands.
//    Browsers always attach Origin to those, so checking it is enough.
const ALLOWED_HOSTS = new Set(
  (process.env.ALLOWED_HOSTS
    ? process.env.ALLOWED_HOSTS.split(',')
    : [`${HOST}:${PORT}`, `127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]
  ).map((h) => h.trim().toLowerCase())
);

const hostAllowed = (req) => ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase());

// 3. Outbound. The two checks above decide who may talk to this server; this
//    one decides where the page may talk *to*, and it is the only guard the
//    browser enforces on our behalf rather than us enforcing it on the
//    browser. "No outbound network calls" is the promise README makes, and
//    until now it was kept by everyone remembering — one `@font-face`, one
//    analytics snippet, one CDN link, and the promise is quietly false with
//    nothing failing. `default-src 'none'` makes the page fetch nothing at
//    all unless named in `./csp`, and a violation shows up in the console
//    instead of in someone else's access log.
//
//    `connect-src 'self'` is the one directive that differs from the hosted
//    demo's, which has nothing to connect to and says 'none'. Both come out
//    of the same list so the gap between them cannot widen unnoticed.
const CSP = csp(LOCAL);

function originAllowed(req) {
  const origin = req.headers.origin;
  // Absent means a non-browser client (curl, the test runner). CSRF needs a
  // browser, so there is nothing to defend against there.
  if (!origin) return true;
  try { return ALLOWED_HOSTS.has(new URL(origin).host.toLowerCase()); }
  catch { return false; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Compiled once: "GET /api/txns/:id" -> matcher
const table = Object.entries(routes).map(([key, handler]) => {
  const [method, pattern] = key.split(' ');
  const names = [];
  const rx = new RegExp(
    `^${pattern.replace(/:[A-Za-z_]+/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; })}$`
  );
  return { method, rx, names, handler };
});

function match(method, pathname) {
  for (const r of table) {
    if (r.method !== method) continue;
    const m = pathname.match(r.rx);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { handler: r.handler, params };
  }
  return null;
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, '檔案太大（上限 64MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const SHARED_PREFIX = '/shared/';

function serveStatic(res, pathname) {
  // Two roots, one containment rule. `new URL()` has already normalised the
  // path by the time it gets here, so `/shared/../server/db.js` arrives as
  // `/server/db.js` and never takes this branch at all; the resolve-and-
  // compare below is what actually holds the line either way.
  const shared = pathname.startsWith(SHARED_PREFIX);
  const root = shared ? SHARED_DIR : WEB_DIR;
  const rel = pathname === '/'
    ? 'index.html'
    : shared ? pathname.slice(SHARED_PREFIX.length) : pathname.replace(/^\/+/, '');
  // Resolve first, then compare against the root *plus a separator*: a bare
  // startsWith(root) would also accept a sibling like ../web-notes/secret.
  const file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) return notFound(res, file, pathname);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// `/account/5` is a route, not a file. Routing lives in the browser, so the
// app has to be answered at every path it can be opened at — otherwise a
// refresh or a pasted link lands on a blank 404.
//
// Named explicitly rather than inferred. "Anything without an extension" was
// the first attempt and it is too wide: `new URL()` normalises
// `/../../../../etc/passwd` to `/etc/passwd`, which resolves safely inside
// web/ and then, having no extension, got the app back with a 200. Nothing
// leaked — the containment check above still held — but a path that should
// 404 stopped saying so, and that is the signal you need when a link is wrong.
//
// Kept in step with `views` in web/app.js by test/html.test.js.
const APP_ROUTES = new Set([
  'overview', 'accounts', 'account', 'transactions', 'import', 'holdings',
  'spending', 'coverage', 'settings',
]);

function notFound(res, file, pathname) {
  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0];
  const last = segments[segments.length - 1] || '';
  // An app route is `/accounts` or `/account/7` — never anything with a file
  // extension. Without this, only the first segment was checked, so a missing
  // asset under a route matched `account` and came back as index.html with a
  // 200: the browser asked for `/account/style.css` and got HTML, which it
  // discarded silently, and asked for `/account/app.js` and got HTML, which
  // it could not parse. Every account page opened directly or refreshed was a
  // blank unstyled shell stuck on 載入中, with nothing in the console to say
  // why. A 404 here is what turns that into a visible failure.
  const looksLikeAFile = last.includes('.');
  if (first !== undefined && (!APP_ROUTES.has(first) || looksLikeAFile)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  fs.readFile(path.join(WEB_DIR, 'index.html'), (err, buf) => {
    if (err) { res.writeHead(500); res.end('index.html missing'); return; }
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// --- CSV export (served here so it can stream a text/csv response) ---------

// The formatting lives in shared/export.js so a browser with no server
// behind it produces the same bytes. This end is the part that only a server
// can do: load the rows, and set the Content-Disposition that names the file.
function exportCsv(type) {
  if (type === 'accounts') return sharedExport({ type, accounts: M.accountsWithBalances() });
  if (type === 'holdings') return sharedExport({ type, holdings: M.holdingsValued() });
  const txns = db
    .prepare(
      `SELECT t.date, a.name AS account_name, a.currency, t.amount, t.description,
              t.category, t.kind, t.transfer_group, t.source, t.note
         FROM txns t JOIN accounts a ON a.id = t.account_id
        ORDER BY t.date DESC, t.id DESC`
    )
    .all();
  return sharedExport({ type: 'txns', txns });
}

// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  // Set once, here, rather than in each writeHead: every response gets it,
  // including the 403s and the SPA fallback, and there is no second place for
  // it to drift out of step with.
  res.setHeader('Content-Security-Policy', CSP);

  if (!hostAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden: unexpected Host header');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD' && !originAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden: cross-origin write');
    return;
  }

  try {
    if (pathname === '/api/export/csv') {
      const { name, body } = exportCsv(url.searchParams.get('type') || 'txns');
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}_${stamp}.csv"`,
      });
      res.end(body);
      return;
    }

    if (pathname.startsWith('/api/')) {
      const hit = match(req.method, pathname);
      if (!hit) { sendJson(res, 404, { error: `無此 API：${req.method} ${pathname}` }); return; }

      let body = {};
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        // Second line behind the Origin check: the content types a cross-site
        // form or no-cors fetch can set are exactly the ones that skip the
        // preflight, and none of them is application/json.
        const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (ct !== 'application/json') {
          sendJson(res, 415, { error: 'Content-Type 必須是 application/json' });
          return;
        }
        const raw = await readBody(req);
        if (raw.length) {
          try { body = JSON.parse(raw.toString('utf8')); }
          catch { sendJson(res, 400, { error: 'request body 不是合法 JSON' }); return; }
        }
      }
      const query = Object.fromEntries(url.searchParams);
      // Every handler is synchronous today; the await is here because the
      // router promises they may be, not because one currently is.
      sendJson(res, 200, (await hit.handler(hit.params, body, query)) ?? { ok: true });
      return;
    }

    serveStatic(res, pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    sendJson(res, status, { error: err.message || '伺服器錯誤' });
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Finance Hub');
  console.log(`  →  http://${HOST}:${PORT}`);
  console.log(`  DB  ${DB_PATH}`);
  if (!paths.IS_PERSONAL) console.log(`  ⚠  profile「${paths.PROFILE}」— 這不是你的個人帳本`);
  console.log('  只綁在本機，資料不離開這台電腦。Ctrl+C 結束。');
  console.log('');
});

process.on('SIGINT', () => { try { db.close(); } catch {} process.exit(0); });
