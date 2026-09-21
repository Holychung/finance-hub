'use strict';

const path = require('node:path');
const paths = require('./paths');
const { db, getMeta, setMeta, snapshot, listBackups } = require('./db');
const csv = require('../shared/csv');
const M = require('./money');
const R = require('../shared/rules');
const SP = require('../shared/spending');

// node:sqlite only binds null/number/bigint/string/Uint8Array.
const S = (v, d = '') => (v === undefined || v === null ? d : String(v));
const N = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const B = (v, d = 1) => (v === undefined || v === null ? d : v ? 1 : 0);
const OPT = (v) => (v === undefined || v === '' ? null : v);
const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };
const missing = (msg) => { throw new HttpError(404, msg); };

// ---------------------------------------------------------------------------

const routes = {};
const on = (method, pattern, handler) => {
  routes[`${method} ${pattern}`] = handler;
};

// --- overview --------------------------------------------------------------

on('GET', '/api/overview', () => {
  const asOf = M.todayISO();
  const accounts = M.accountsWithBalances(asOf);
  const holdings = M.holdingsValued();
  const nw = M.netWorth(asOf);
  const checks = M.reconcile();
  const firstTxn = db.prepare('SELECT MIN(date) AS d FROM txns').get().d;
  const firstAcct = db.prepare('SELECT MIN(opening_date) AS d FROM accounts').get().d;
  const from = firstTxn || firstAcct || asOf;

  return {
    net_worth: nw,
    accounts,
    holdings,
    series: M.netWorthSeries(from, asOf),
    reconcile: {
      total: checks.length,
      off: checks.filter((c) => !c.ok).length,
      // Checks, not accounts: three bad checks against one account are three
      // here and one book to go and fix, and only the second number is worth
      // putting in a sentence. `latest` is capped, so the client cannot count
      // the accounts itself without undercounting.
      off_accounts: new Set(checks.filter((c) => !c.ok).map((c) => c.account_id)).size,
      latest: checks.slice(0, 8),
    },
    counts: {
      txns: db.prepare('SELECT COUNT(*) AS n FROM txns').get().n,
      unpaired_candidates: M.findTransferCandidates().length,
    },
    // A card or loan sitting in credit is usually a sign flipped somewhere.
    // It belongs on the overview rather than in a dismissible notice, because
    // the number it produces looks perfectly reasonable on its own.
    liabilities_in_credit: M.liabilitiesInCredit(accounts),
    fx_latest: db.prepare("SELECT date, rate FROM fx_rates WHERE pair='USDTWD' ORDER BY date DESC LIMIT 1").get() || null,
  };
});

// --- institutions ----------------------------------------------------------

on('GET', '/api/institutions', () => db.prepare('SELECT * FROM institutions ORDER BY country, name').all());

on('POST', '/api/institutions', (_p, body) => {
  if (!S(body.name).trim()) bad('機構名稱必填');
  const r = db
    .prepare('INSERT INTO institutions (name, kind, country) VALUES (?, ?, ?)')
    .run(S(body.name).trim(), S(body.kind, 'bank'), S(body.country, 'TW'));
  return { id: Number(r.lastInsertRowid) };
});

on('DELETE', '/api/institutions/:id', (p) => ({
  deleted: db.prepare('DELETE FROM institutions WHERE id = ?').run(N(p.id)).changes,
}));

// --- accounts --------------------------------------------------------------

on('GET', '/api/accounts', () => M.accountsWithBalances());

on('POST', '/api/accounts', (_p, b) => {
  if (!S(b.name).trim()) bad('帳戶名稱必填');
  const r = db
    .prepare(
      `INSERT INTO accounts (institution_id, name, kind, currency, opening_balance, opening_date, is_active, sort_order, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      OPT(b.institution_id) === null ? null : N(b.institution_id),
      S(b.name).trim(), S(b.kind, 'cash'), S(b.currency, 'TWD'),
      N(b.opening_balance), S(b.opening_date, '2020-01-01'),
      B(b.is_active), N(b.sort_order), S(b.note)
    );
  return { id: Number(r.lastInsertRowid) };
});

on('PUT', '/api/accounts/:id', (p, b) => {
  const cur = db.prepare('SELECT * FROM accounts WHERE id = ?').get(N(p.id));
  if (!cur) missing('帳戶不存在');
  db.prepare(
    `UPDATE accounts SET institution_id=?, name=?, kind=?, currency=?,
            opening_balance=?, opening_date=?, is_active=?, sort_order=?, note=?
      WHERE id=?`
  ).run(
    b.institution_id === undefined ? cur.institution_id : (OPT(b.institution_id) === null ? null : N(b.institution_id)),
    S(b.name, cur.name), S(b.kind, cur.kind), S(b.currency, cur.currency),
    b.opening_balance === undefined ? cur.opening_balance : N(b.opening_balance),
    S(b.opening_date, cur.opening_date),
    b.is_active === undefined ? cur.is_active : B(b.is_active),
    b.sort_order === undefined ? cur.sort_order : N(b.sort_order),
    S(b.note, cur.note), N(p.id)
  );
  return { ok: true };
});

on('DELETE', '/api/accounts/:id', (p) => ({
  deleted: db.prepare('DELETE FROM accounts WHERE id = ?').run(N(p.id)).changes,
}));

// --- transactions ----------------------------------------------------------

on('GET', '/api/txns', (_p, _b, q) => {
  const where = [];
  const args = [];
  if (q.account) { where.push('t.account_id = ?'); args.push(N(q.account)); }
  if (q.from) { where.push('t.date >= ?'); args.push(S(q.from)); }
  if (q.to) { where.push('t.date <= ?'); args.push(S(q.to)); }
  if (q.kind) { where.push('t.kind = ?'); args.push(S(q.kind)); }
  if (q.q) { where.push('(t.description LIKE ? OR t.category LIKE ? OR t.note LIKE ?)'); const k = `%${q.q}%`; args.push(k, k, k); }
  const sql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM txns t${sql}`).get(...args).n;
  const limit = Math.min(N(q.limit, 200), 2000);
  const offset = N(q.offset, 0);

  const rows = db
    .prepare(
      `SELECT t.*, a.name AS account_name, a.currency
         FROM txns t JOIN accounts a ON a.id = t.account_id${sql}
        ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset);

  return { total, limit, offset, rows };
});

function insertTxn(b, importId = null) {
  const accountId = N(b.account_id);
  if (!accountId) bad('account_id 必填');
  const date = csv.parseDate(b.date, 'auto');
  if (!date) bad(`日期無法解析：${b.date}`);
  const amount = M.round2(N(b.amount));
  const desc = S(b.description);
  const r = db
    .prepare(
      `INSERT INTO txns (account_id, date, amount, description, category, kind,
                         source, external_id, fingerprint, import_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      accountId, date, amount, desc, S(b.category), S(b.kind, 'other'),
      S(b.source, 'manual'), OPT(b.external_id),
      S(b.fingerprint) || csv.fingerprint(accountId, date, amount, desc),
      importId, S(b.note), now()
    );
  return Number(r.lastInsertRowid);
}

on('POST', '/api/txns', (_p, b) => {
  if (Array.isArray(b.rows)) {
    const ids = [];
    db.exec('BEGIN');
    try {
      for (const row of b.rows) ids.push(insertTxn(row));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ids, inserted: ids.length };
  }
  return { id: insertTxn(b) };
});

on('PUT', '/api/txns/:id', (p, b) => {
  const cur = db.prepare('SELECT * FROM txns WHERE id = ?').get(N(p.id));
  if (!cur) missing('交易不存在');
  const date = b.date === undefined ? cur.date : csv.parseDate(b.date, 'auto') || bad(`日期無法解析：${b.date}`);
  const amount = b.amount === undefined ? cur.amount : M.round2(N(b.amount));
  const desc = S(b.description, cur.description);
  const accountId = b.account_id === undefined ? cur.account_id : N(b.account_id);
  db.prepare(
    `UPDATE txns SET account_id=?, date=?, amount=?, description=?, category=?, kind=?, note=?, fingerprint=?
      WHERE id=?`
  ).run(
    accountId, date, amount, desc, S(b.category, cur.category),
    S(b.kind, cur.kind), S(b.note, cur.note),
    csv.fingerprint(accountId, date, amount, desc), N(p.id)
  );
  return { ok: true };
});

on('DELETE', '/api/txns/:id', (p) => ({
  deleted: db.prepare('DELETE FROM txns WHERE id = ?').run(N(p.id)).changes,
}));

// --- transfers -------------------------------------------------------------

on('GET', '/api/transfers/candidates', () => M.findTransferCandidates());

on('POST', '/api/transfers/apply', (_p, b) => {
  const pairs = (b.pairs || []).map((p) => ({ outId: N(p.outId), inId: N(p.inId) }));
  if (!pairs.length) bad('沒有要配對的項目');
  return { paired: M.applyTransferPairs(pairs) };
});

on('GET', '/api/transfers', () =>
  db
    .prepare(
      `SELECT t.transfer_group, t.id, t.account_id, t.date, t.amount, t.description, a.name AS account_name, a.currency
         FROM txns t JOIN accounts a ON a.id = t.account_id
        WHERE t.transfer_group IS NOT NULL ORDER BY t.date DESC, t.transfer_group`
    )
    .all()
);

on('DELETE', '/api/transfers/:group', (p) => ({ unlinked: M.unlinkTransfer(String(p.group)) }));

// --- holdings --------------------------------------------------------------

on('GET', '/api/holdings', () => M.holdingsValued());

on('POST', '/api/holdings', (_p, b) => {
  if (!S(b.symbol).trim()) bad('股票代號必填');
  const r = db
    .prepare(
      `INSERT INTO holdings (account_id, symbol, name, market, shares, avg_cost, last_price, price_date, currency, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      N(b.account_id), S(b.symbol).trim().toUpperCase(), S(b.name), S(b.market, 'TW'),
      N(b.shares), N(b.avg_cost), N(b.last_price), OPT(b.price_date),
      S(b.currency, S(b.market, 'TW') === 'US' ? 'USD' : 'TWD'), S(b.note)
    );
  return { id: Number(r.lastInsertRowid) };
});

on('PUT', '/api/holdings/:id', (p, b) => {
  const cur = db.prepare('SELECT * FROM holdings WHERE id = ?').get(N(p.id));
  if (!cur) missing('持股不存在');
  db.prepare(
    `UPDATE holdings SET account_id=?, symbol=?, name=?, market=?, shares=?, avg_cost=?,
            last_price=?, price_date=?, currency=?, note=? WHERE id=?`
  ).run(
    b.account_id === undefined ? cur.account_id : N(b.account_id),
    S(b.symbol, cur.symbol).trim().toUpperCase(), S(b.name, cur.name), S(b.market, cur.market),
    b.shares === undefined ? cur.shares : N(b.shares),
    b.avg_cost === undefined ? cur.avg_cost : N(b.avg_cost),
    b.last_price === undefined ? cur.last_price : N(b.last_price),
    b.price_date === undefined ? cur.price_date : OPT(b.price_date),
    S(b.currency, cur.currency), S(b.note, cur.note), N(p.id)
  );
  return { ok: true };
});

on('DELETE', '/api/holdings/:id', (p) => ({
  deleted: db.prepare('DELETE FROM holdings WHERE id = ?').run(N(p.id)).changes,
}));

// --- fx --------------------------------------------------------------------

on('GET', '/api/fx', () => db.prepare('SELECT * FROM fx_rates ORDER BY date DESC LIMIT 400').all());

on('POST', '/api/fx', (_p, b) => {
  const list = Array.isArray(b.rows) ? b.rows : [b];
  const stmt = db.prepare(
    `INSERT INTO fx_rates (date, pair, rate) VALUES (?, ?, ?)
     ON CONFLICT(date, pair) DO UPDATE SET rate = excluded.rate`
  );
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const r of list) {
      const d = csv.parseDate(r.date, 'auto');
      if (!d) bad(`日期無法解析：${r.date}`);
      const rate = N(r.rate);
      if (rate <= 0) bad('匯率必須大於 0');
      stmt.run(d, S(r.pair, 'USDTWD').toUpperCase(), rate);
      n++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { saved: n };
});

on('DELETE', '/api/fx/:date', (p, _b, q) => ({
  deleted: db.prepare('DELETE FROM fx_rates WHERE date = ? AND pair = ?')
    .run(String(p.date), S(q.pair, 'USDTWD')).changes,
}));

// --- balance checks / reconciliation ---------------------------------------

on('GET', '/api/reconcile', () => M.reconcile());

// Clamped rather than validated: a silly `months` is a URL someone typed, not
// an error worth refusing, and an unbounded one would build a grid per month
// per account for no reader.
on('GET', '/api/coverage', (_p, _b, q) => {
  const months = Math.min(Math.max(N(q.months, M.COVERAGE_MONTHS), 1), 120);
  return M.coverage({ months, to: q.to ? S(q.to) : M.todayISO() });
});

// --- spending --------------------------------------------------------------

// One query serves both the breakdown and the recurring scan, and both want
// the same columns over the same window, so they share a loader rather than
// walking the table twice per page load.
const spendingRows = (from, to) =>
  db
    .prepare(
      `SELECT account_id, date, amount, description, category, kind, transfer_group
         FROM txns WHERE date >= ? AND date <= ? ORDER BY date`
    )
    .all(from, to);

const accountCurrencies = () => db.prepare('SELECT id, name, currency FROM accounts').all();

// The earliest and latest date any row in a parsed file carries. Shared by
// the preview (to prefill the period box) and the commit (as the fallback
// when nobody declared one), so the two cannot disagree about what the file's
// own extent is.
function rowSpan(rows) {
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  return { from: dates[0] || null, to: dates[dates.length - 1] || null };
}

// The default window is twelve months back, which is the shortest one that
// shows a yearly subscription at all.
function windowFrom(q) {
  const to = q.to ? S(q.to) : M.todayISO();
  if (q.from) return { from: S(q.from), to };
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - N(q.years, 1));
  return { from: d.toISOString().slice(0, 10), to };
}

on('GET', '/api/spending', (_p, _b, q) => {
  const { from, to } = windowFrom(q);
  return SP.computeSpending({ txns: spendingRows(from, to), accounts: accountCurrencies(), from, to });
});

on('GET', '/api/recurring', (_p, _b, q) => {
  // Two years by default rather than one: three occurrences is the minimum a
  // series needs, and a yearly charge cannot reach three inside twelve months.
  const { from, to } = windowFrom({ ...q, years: q.years || 2 });
  return SP.computeRecurring({ txns: spendingRows(from, to), accounts: accountCurrencies(), to });
});

// --- categorisation rules --------------------------------------------------

const listRules = () => R.sortRules(db.prepare('SELECT * FROM rules').all());

on('GET', '/api/rules', () => listRules());

on('POST', '/api/rules', (_p, b) => {
  const pattern = S(b.pattern).trim();
  const category = S(b.category).trim();
  if (!pattern) bad('比對字串必填');
  if (!category) bad('分類必填');
  // A pattern that normalises to nothing — punctuation only — would match
  // every description or none, depending on which way the loop reads. Neither
  // is a rule anybody meant to write.
  if (!R.normalise(pattern)) bad('比對字串至少要有一個文字或數字');
  const r = db
    .prepare('INSERT INTO rules (pattern, category, priority, created_at) VALUES (?, ?, ?, ?)')
    .run(pattern, category, N(b.priority), now());
  return { id: Number(r.lastInsertRowid) };
});

on('PUT', '/api/rules/:id', (p, b) => {
  const cur = db.prepare('SELECT * FROM rules WHERE id = ?').get(N(p.id)) || missing('規則不存在');
  const pattern = b.pattern === undefined ? cur.pattern : S(b.pattern).trim();
  if (!R.normalise(pattern)) bad('比對字串至少要有一個文字或數字');
  db.prepare('UPDATE rules SET pattern = ?, category = ?, priority = ? WHERE id = ?').run(
    pattern,
    b.category === undefined ? cur.category : S(b.category).trim(),
    b.priority === undefined ? cur.priority : N(b.priority),
    cur.id
  );
  return { ok: true };
});

on('DELETE', '/api/rules/:id', (p) => ({
  deleted: db.prepare('DELETE FROM rules WHERE id = ?').run(N(p.id)).changes,
}));

// Preview and apply run the same `plan()` over the same rows, so what the user
// is shown and what actually happens cannot drift apart. `dry` is the default:
// a sweep over every transaction in the ledger is not something to discover
// after the fact.
on('POST', '/api/rules/apply', (_p, b) => {
  const overwrite = !!b.overwrite;
  const txns = db.prepare('SELECT id, description, category FROM txns').all();
  const changes = R.plan(txns, listRules(), { overwrite });

  if (b.dry !== false) return { dry: true, changes: changes.slice(0, 200), total: changes.length };

  const upd = db.prepare('UPDATE txns SET category = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const c of changes) upd.run(c.to, c.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { dry: false, applied: changes.length };
});

on('POST', '/api/balance-checks', (_p, b) => {
  const d = csv.parseDate(b.date, 'auto');
  if (!d) bad(`日期無法解析：${b.date}`);
  const r = db
    .prepare('INSERT INTO balance_checks (account_id, date, stated, note) VALUES (?, ?, ?, ?)')
    .run(N(b.account_id), d, N(b.stated), S(b.note));
  return { id: Number(r.lastInsertRowid) };
});

on('DELETE', '/api/balance-checks/:id', (p) => ({
  deleted: db.prepare('DELETE FROM balance_checks WHERE id = ?').run(N(p.id)).changes,
}));

// --- mappings --------------------------------------------------------------

on('GET', '/api/mappings', () =>
  db.prepare('SELECT * FROM mappings ORDER BY used_at DESC NULLS LAST, name').all()
    .map((m) => ({ ...m, config: JSON.parse(m.config) }))
);

on('POST', '/api/mappings', (_p, b) => {
  const name = S(b.name).trim();
  if (!name) bad('對應名稱必填');
  const cfg = JSON.stringify(b.config || {});
  db.prepare(
    `INSERT INTO mappings (name, config, created_at) VALUES (?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET config = excluded.config`
  ).run(name, cfg, now());
  return { ok: true, name };
});

on('DELETE', '/api/mappings/:id', (p) => ({
  deleted: db.prepare('DELETE FROM mappings WHERE id = ?').run(N(p.id)).changes,
}));

// --- import ----------------------------------------------------------------

function existingCounts(accountId) {
  const fingerprints = new Map();
  for (const r of db
    .prepare('SELECT fingerprint, COUNT(*) AS n FROM txns WHERE account_id = ? GROUP BY fingerprint')
    .all(accountId)) {
    fingerprints.set(r.fingerprint, r.n);
  }
  const externalIds = new Set(
    db.prepare('SELECT external_id FROM txns WHERE account_id = ? AND external_id IS NOT NULL')
      .all(accountId).map((r) => r.external_id)
  );
  return { fingerprints, externalIds };
}

// The account is optional here on purpose. Without it there is nowhere to
// import to, but the file can still be read — and reading it is what supplies
// the numbers needed to create the account in the first place. Requiring one
// first made the first import a chicken-and-egg: the page told you to go to
// another view and type in an opening balance the file already knew.
on('POST', '/api/import/preview', (_p, b) => {
  const accountId = N(b.account_id);
  const account = accountId
    ? db.prepare('SELECT id, name, kind, currency FROM accounts WHERE id = ?').get(accountId)
    : null;
  if (accountId && !account) missing('帳戶不存在');
  const buf = Buffer.from(S(b.content_base64), 'base64');
  if (!buf.length) bad('檔案是空的');

  const { text, encoding } = csv.decode(buf, S(b.encoding, 'auto') || 'auto');
  const delimiter = b.mapping?.delimiter || csv.sniffDelimiter(text);
  const grid = csv.parseCsv(text, delimiter);
  if (!grid.length) bad('這個檔案解析不出任何一行');

  // Only guess the header row on the first look; once the user has told us
  // where it is, that answer stands even if the detector disagrees.
  const headerRow = b.mapping?.headerRow
    ? Math.max(1, N(b.mapping.headerRow, 1))
    : csv.detectHeaderRow(grid);
  const headers = grid[headerRow - 1] || [];
  const mapping = b.mapping?.dateCol !== undefined && b.mapping?.dateCol !== null
    ? { ...b.mapping, delimiter, encoding }
    : { ...csv.guessMapping(headers, grid.slice(headerRow)), delimiter, encoding, headerRow };

  const { rows } = csv.extractRows(grid, mapping, accountId);
  csv.markDuplicates(rows, existingCounts(accountId));

  const summary = rows.reduce(
    (acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; },
    { new: 0, duplicate: 0, error: 0, pending: 0 }
  );
  const fresh = rows.filter((r) => r.status === 'new');
  const net = M.round2(fresh.reduce((s, r) => s + r.amount, 0));

  // What the user actually wants to know before pressing import is not how
  // much this moves the account by, but whether the account will agree with
  // the statement afterwards. When the file carries a running balance it has
  // already stated the answer, so the check costs nothing — and reconciling
  // is the whole point of this ledger.
  //
  // Duplicates are excluded from `net` and already counted in the current
  // balance, so the sum covers every row in the file either way. It will not
  // match when the account holds transactions from outside this statement's
  // range, which is a fact about the account rather than a fault in the file.
  let reconcile = null;
  if (account) {
    const before = M.accountsWithBalances().find((a) => a.id === account.id)?.balance ?? 0;
    const after = M.round2(before + net);
    const lastWithBalance = csv.inDateOrder(rows).filter((r) => r.balance !== null && !r.ragged).pop();
    const stated = lastWithBalance ? lastWithBalance.balance : null;
    reconcile = {
      before,
      after,
      stated,
      stated_on: lastWithBalance ? lastWithBalance.date : null,
      matches: stated === null ? null : Math.abs(after - stated) < 0.005,
      drift: stated === null ? null : M.round2(after - stated),
    };
  }

  return {
    encoding, delimiter, headers, mapping,
    // The rows are in the account's own currency, and the preview has no other
    // way to know which. Without it every figure rendered as NT$ — a USD
    // statement previewed as "NT$3,761" reads as a number thirty times smaller
    // than it is, and the cents disappear with it.
    account,
    // Only when there is nothing to import into: with an account chosen the
    // answer is already on screen and re-deriving it would invite overwriting
    // what the user set.
    suggested_account: accountId
      ? null
      : csv.suggestAccount({ filename: S(b.filename), headers, rows, mapping }),
    grid_preview: grid.slice(0, Math.max(headerRow + 5, 8)),
    rows: rows.slice(0, 500),
    truncated: rows.length > 500,
    summary: {
      ...summary,
      total: rows.length,
      repaired: rows.filter((r) => r.repaired).length,
      balance_breaks: rows.filter((r) => r.balanceBreak !== undefined).length,
      // A card statement is nearly all charges, so a file that is mostly
      // inflows is almost certainly stating what you owe rather than what the
      // account is worth. Card exports carry no running balance, so this is
      // the only check available — and every row of an inverted file parses
      // perfectly. Bank of America's own CSV needs no flipping even though
      // its web view shows the opposite signs; other issuers differ.
      sign_suspect:
        M.LIABILITY_KINDS.has(S(account?.kind)) &&
        fresh.filter((r) => r.amount > 0).length > fresh.filter((r) => r.amount < 0).length,
      net,
      date_min: fresh.length ? fresh.reduce((a, r) => (r.date < a ? r.date : a), fresh[0].date) : null,
      date_max: fresh.length ? fresh.reduce((a, r) => (r.date > a ? r.date : a), fresh[0].date) : null,
      // Over every row, not just the new ones, and computed here rather than
      // in the browser because `rows` is truncated at 500 — a two-year export
      // would have the client prefilling the period box from the first 500
      // lines and calling it the file's extent.
      span_from: rowSpan(rows).from,
      span_to: rowSpan(rows).to,
    },
    reconcile,
  };
});

on('POST', '/api/import/commit', (_p, b) => {
  const accountId = N(b.account_id);
  if (!accountId) bad('請先選擇要匯入的帳戶');
  const buf = Buffer.from(S(b.content_base64), 'base64');
  const mapping = b.mapping || bad('缺少欄位對應設定');

  // Refuse rather than import without a safety net — the point of the
  // snapshot is the case where the mapping turns out to be wrong.
  let backupFile = null;
  if (!b.skip_backup) {
    try {
      const dest = snapshot('preimport');
      backupFile = dest ? path.basename(dest) : null;
    } catch (e) {
      throw new HttpError(500, `匯入前備份失敗，已中止匯入：${e.message}`);
    }
  }

  const { text } = csv.decode(buf, mapping.encoding || 'auto');
  const grid = csv.parseCsv(text, mapping.delimiter || ',');
  const { rows } = csv.extractRows(grid, mapping, accountId);
  csv.markDuplicates(rows, existingCounts(accountId));

  const skipLines = new Set((b.skip_lines || []).map(Number));
  const toInsert = rows.filter((r) => r.status === 'new' && !skipLines.has(r.lineNo));

  // What period this file covers. The user's answer wins, because the file
  // does not carry one: a bank's download page offers "Statement of 2026-08"
  // or "Year to date" and the person clicking knows which they picked, while
  // the CSV that comes back states only its rows.
  //
  // Failing that, the span of every row the file contained — not of the rows
  // that ended up inserted. A duplicate is still proof the statement reached
  // that date, and so is a row refused for being shifted. Recording only what
  // landed would shrink the range every time a file overlapped one already
  // imported, which is the normal case.
  const span = rowSpan(rows);
  const declaredFrom = OPT(b.period_from) && S(b.period_from);
  const declaredTo = OPT(b.period_to) && S(b.period_to);
  const declared = !!(declaredFrom && declaredTo);
  if (declared && declaredFrom > declaredTo) bad('期間的起日不能晚於迄日');

  // A row outside the declared period is not a warning, it is proof the
  // declaration is wrong — either the wrong period was picked or this is not
  // the file the user thinks it is. Importing anyway would write a coverage
  // claim that the file itself contradicts, and /coverage would then report
  // confirmed months on the strength of it.
  if (declared) {
    const outside = rows.filter((r) => r.date && (r.date < declaredFrom || r.date > declaredTo));
    if (outside.length) {
      bad(
        `宣告的期間是 ${declaredFrom} 到 ${declaredTo}，但檔案裡有 ${outside.length} 行落在期間外` +
          `（${outside[0].date} 等）。期間填錯了，或這份檔案不是你以為的那一份。`
      );
    }
  }

  const imp = db
    .prepare(
      `INSERT INTO imports (account_id, filename, mapping, imported, skipped, created_at, date_from, date_to, period_kind)
       VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)`
    )
    .run(
      accountId, S(b.filename, 'upload.csv'), JSON.stringify(mapping), now(),
      declared ? declaredFrom : span.from,
      declared ? declaredTo : span.to,
      declared ? 'declared' : 'derived'
    );
  const importId = Number(imp.lastInsertRowid);

  // The file's own category wins where it has one — Chase and the Venture card
  // are the only two that ship one, and the bank's own label beats a guess.
  // Everywhere else this is the only chance the row gets, because nobody goes
  // back through two hundred imported rows by hand.
  const ruleList = listRules();

  db.exec('BEGIN');
  try {
    for (const r of toInsert) {
      insertTxn(
        {
          account_id: accountId, date: r.date, amount: r.amount,
          description: r.description,
          category: r.category || R.categorise(r.description, ruleList),
          kind: S(b.default_kind, 'other'),
          source: 'csv', external_id: r.externalId, fingerprint: r.fingerprint,
        },
        importId
      );
    }
    db.prepare('UPDATE imports SET imported = ?, skipped = ? WHERE id = ?')
      .run(toInsert.length, rows.length - toInsert.length, importId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  if (b.save_mapping_as) {
    db.prepare(
      `INSERT INTO mappings (name, config, created_at, used_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET config = excluded.config, used_at = excluded.used_at`
    ).run(String(b.save_mapping_as).trim(), JSON.stringify(mapping), now(), now());
  }

  return {
    import_id: importId,
    imported: toInsert.length,
    skipped: rows.length - toInsert.length,
    transfer_candidates: M.findTransferCandidates().length,
    backup: backupFile,
  };
});

on('GET', '/api/backups', () => listBackups());

on('GET', '/api/imports', () =>
  db.prepare(
    `SELECT i.*, a.name AS account_name FROM imports i
       LEFT JOIN accounts a ON a.id = i.account_id ORDER BY i.id DESC LIMIT 50`
  ).all()
);

on('DELETE', '/api/imports/:id', (p) => {
  const id = N(p.id);
  const n = db.prepare('DELETE FROM txns WHERE import_id = ?').run(id).changes;
  db.prepare('DELETE FROM imports WHERE id = ?').run(id);
  return { reverted: n };
});

// --- settings & backup -----------------------------------------------------

on('GET', '/api/settings', () => ({
  base_currency: getMeta('base_currency', 'TWD'),
  schema_version: getMeta('schema_version', '1'),
  // The UI says which book is open, so a demo window is never mistaken for
  // the real one. The path is already local-only information.
  profile: paths.PROFILE,
  is_personal: paths.IS_PERSONAL,
  db_path: paths.DB_PATH,
}));

on('PUT', '/api/settings', (_p, b) => {
  if (b.base_currency) setMeta('base_currency', String(b.base_currency).toUpperCase());
  return { ok: true };
});

on('GET', '/api/export/json', () => ({
  exported_at: now(),
  base_currency: getMeta('base_currency', 'TWD'),
  institutions: db.prepare('SELECT * FROM institutions').all(),
  accounts: db.prepare('SELECT * FROM accounts').all(),
  txns: db.prepare('SELECT * FROM txns').all(),
  holdings: db.prepare('SELECT * FROM holdings').all(),
  fx_rates: db.prepare('SELECT * FROM fx_rates').all(),
  balance_checks: db.prepare('SELECT * FROM balance_checks').all(),
  mappings: db.prepare('SELECT * FROM mappings').all(),
}));

module.exports = { routes, HttpError };
