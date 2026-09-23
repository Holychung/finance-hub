'use strict';

// The half of the money logic that talks to the database.
//
// Every function here loads rows and hands them to its namesake in
// `shared/money.js`, which does the arithmetic and knows nothing about
// storage. The names and signatures are the ones `api.js` has always called,
// so nothing above this file has to know the split exists — and the pure half
// is re-exported below, so `M.computeNetWorth` still resolves through here.
//
// A query belongs in this file and nowhere else. The moment a `compute*`
// reaches for `db` it stops being testable without a server and stops being
// able to run in a browser, which is the whole reason for the boundary.

const crypto = require('node:crypto');
const { db, getMeta } = require('./db');
const pure = require('../shared/money');

const {
  round2, todayISO, COVERAGE_MONTHS,
  computeFxLookup, computePriceLookup, computeAccountsWithBalances, computeHoldingsValued,
  computeNetWorth, computeNetWorthSeries, computeCoverage, computeReconcile,
  computeTransferCandidates,
} = pure;

const baseCurrency = () => getMeta('base_currency', 'TWD');

function buildFxLookup(pair = 'USDTWD') {
  const rows = db.prepare('SELECT date, rate FROM fx_rates WHERE pair = ? ORDER BY date').all(pair);
  return computeFxLookup({ rows });
}

function buildPriceLookup() {
  const rows = db
    .prepare('SELECT symbol, market, date, price FROM prices ORDER BY symbol, market, date')
    .all();
  return computePriceLookup({ rows });
}

function accountsWithBalances(asOf = todayISO()) {
  const accounts = db
    .prepare('SELECT * FROM accounts ORDER BY sort_order, id')
    .all();
  const totals = db
    .prepare('SELECT account_id, SUM(amount) AS total FROM txns WHERE date <= ? GROUP BY account_id')
    .all(asOf);
  return computeAccountsWithBalances({ accounts, totals });
}

function holdingsValued(asOf = todayISO()) {
  const holdings = db
    .prepare(
      `SELECT h.*, a.name AS account_name
         FROM holdings h JOIN accounts a ON a.id = h.account_id
        ORDER BY h.market, h.symbol`
    )
    .all();
  return computeHoldingsValued({ holdings, priceLookup: buildPriceLookup(), asOf });
}

function netWorth(asOf = todayISO()) {
  return computeNetWorth({
    accounts: accountsWithBalances(asOf),
    holdings: holdingsValued(asOf),
    asOf,
  });
}

function netWorthSeries(from, to, access = null) {
  const accounts = db.prepare('SELECT id, currency, opening_balance, opening_date, access FROM accounts').all();
  const txns = accounts.length
    ? db.prepare('SELECT account_id, date, amount FROM txns WHERE date <= ? ORDER BY date').all(to)
    : [];
  return computeNetWorthSeries({ accounts, txns, from, to, access });
}

// One account's month-end balance: the same walk as the net worth series over
// a book of one, so the account page's line and the overview's cannot tell
// the same account's history two different ways. It starts on the opening
// date for the same reason the overview's does.
function accountSeries(id, to = todayISO()) {
  const accounts = db.prepare('SELECT id, currency, opening_balance, opening_date, access FROM accounts WHERE id = ?').all(id);
  if (!accounts.length) return null;
  const txns = db
    .prepare('SELECT account_id, date, amount FROM txns WHERE account_id = ? AND date <= ? ORDER BY date')
    .all(id, to);
  const [a] = accounts;
  const from = a.opening_date || (txns[0] && txns[0].date) || to;
  return computeNetWorthSeries({ accounts, txns, from, to })[a.currency] || [];
}

function coverage({ to = todayISO(), months = COVERAGE_MONTHS } = {}) {
  const accounts = db
    .prepare('SELECT id, name, kind, currency, opening_date, is_active FROM accounts ORDER BY sort_order, id')
    .all();
  const activity = db
    .prepare(
      `SELECT account_id, substr(date, 1, 7) AS month, COUNT(*) AS n, SUM(amount) AS net
         FROM txns WHERE date <= ? GROUP BY account_id, month`
    )
    .all(to);
  const checks = reconcile().map((c) => ({ account_id: c.account_id, date: c.date, ok: c.ok }));
  const imports = db
    .prepare(
      `SELECT account_id, date_from, date_to, period_kind FROM imports
        WHERE account_id IS NOT NULL AND date_from IS NOT NULL AND date_to IS NOT NULL`
    )
    .all();
  return computeCoverage({ accounts, activity, checks, imports, to, months });
}

function reconcile() {
  const rows = db
    .prepare(
      `SELECT bc.*, a.name AS account_name, a.currency, a.opening_balance
         FROM balance_checks bc JOIN accounts a ON a.id = bc.account_id
        ORDER BY bc.date DESC, bc.id DESC`
    )
    .all();

  // One indexed sum per check rather than pulling every transaction into
  // memory: `idx_txns_account_date` covers exactly this, and a ledger has far
  // more transactions than balance checks.
  const stmt = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM txns WHERE account_id = ? AND date <= ?');
  const checks = rows.map((c) => ({ ...c, txn_total: stmt.get(c.account_id, c.date).total }));

  return computeReconcile({ checks });
}

function findTransferCandidates({ windowDays = 3, tolerancePct = 1.5 } = {}) {
  const rows = db
    .prepare(
      `SELECT t.id, t.account_id, t.date, t.amount, t.description, t.kind, a.currency, a.name AS account_name
         FROM txns t JOIN accounts a ON a.id = t.account_id
        WHERE t.transfer_group IS NULL
        ORDER BY t.date`
    )
    .all();
  return computeTransferCandidates({ rows, fx: buildFxLookup(), windowDays, tolerancePct });
}

function applyTransferPairs(pairs) {
  const upd = db.prepare("UPDATE txns SET transfer_group = ?, kind = 'transfer' WHERE id = ?");
  let n = 0;
  for (const p of pairs) {
    const g = crypto.randomUUID();
    upd.run(g, p.outId);
    upd.run(g, p.inId);
    n++;
  }
  return n;
}

function unlinkTransfer(groupId) {
  return db
    .prepare("UPDATE txns SET transfer_group = NULL, kind = 'other' WHERE transfer_group = ?")
    .run(groupId).changes;
}

module.exports = {
  // The pure half, re-exported so `require('./money')` is still the one way in.
  ...pure,

  // Load the rows, then call the matching compute* in shared/money.js.
  baseCurrency, buildFxLookup, buildPriceLookup, accountsWithBalances, holdingsValued,
  netWorth, netWorthSeries, accountSeries, coverage, reconcile, findTransferCandidates,

  // Writes. Still the odd ones out; nothing needs them pure yet.
  applyTransferPairs, unlinkTransfer,
};
