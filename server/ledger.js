'use strict';

// The server's half of the ledger port that shared/handlers.js runs on: the
// questions web/storage-demo.js answers from its Map, answered here in SQL.
// Reads are named for what a handler needs and keep their queries; writes are
// one table, one row, by id.
//
// Like migrate.js it takes an open handle and opens nothing, so a test can
// hand it a throwaway database without requiring db.js. server/api.js passes
// the real one, with the meta helpers and the loaders in server/money.js.

// Names reach SQL only from this list and from the table's own schema. A
// handler writes the columns it names in code; a table not listed here, or a
// column `PRAGMA table_info` does not report, is refused before it becomes
// part of a statement, and every value is bound.
const TABLES = new Set([
  'institutions', 'accounts', 'txns', 'holdings', 'imports', 'balance_checks', 'mappings', 'rules', 'budgets',
]);
// The two tables with no id, by their primary keys: a row is written by
// upsert and deleted by its whole key, never part of it — a key with a column
// missing would be a WHERE that matches every rate of a pair.
const KEYS = { fx_rates: ['date', 'pair'], prices: ['symbol', 'market', 'date'] };

function makeLedger({ db, getMeta, setMeta, M }) {
  const columns = new Map();

  const known = (table) => {
    if (!TABLES.has(table) && !KEYS[table]) throw new Error(`ledger: 不認得的表 ${table}`);
    if (!columns.has(table)) {
      columns.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)));
    }
    return columns.get(table);
  };
  const tableOf = (table) => {
    known(table);
    if (!TABLES.has(table)) throw new Error(`ledger: ${table} 沒有 id`);
    return table;
  };
  const keyedOf = (table) => {
    known(table);
    if (!KEYS[table]) throw new Error(`ledger: ${table} 不是用主鍵寫的表`);
    return table;
  };

  const columnsOf = (table, row) => {
    const cols = known(table);
    const keys = Object.keys(row);
    if (!keys.length) throw new Error(`ledger: ${table} 沒有要寫的欄位`);
    for (const k of keys) if (!cols.has(k)) throw new Error(`ledger: ${table} 沒有 ${k} 這一欄`);
    return keys;
  };

  const wholeKey = (table, key) => {
    const keys = columnsOf(keyedOf(table), key);
    const pk = KEYS[table];
    if (keys.length !== pk.length || !pk.every((k) => keys.includes(k))) {
      throw new Error(`ledger: ${table} 的主鍵是 ${pk.join(', ')}`);
    }
    return pk;
  };

  return {
    all: (table) => db.prepare(`SELECT * FROM ${tableOf(table)} ORDER BY id`).all(),
    get: (table, id) => db.prepare(`SELECT * FROM ${tableOf(table)} WHERE id = ?`).get(id) || null,

    insert(table, row) {
      const keys = columnsOf(tableOf(table), row);
      const r = db
        .prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
        .run(...keys.map((k) => row[k]));
      return Number(r.lastInsertRowid);
    },

    update(table, id, patch) {
      const keys = columnsOf(tableOf(table), patch);
      return db
        .prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => patch[k]), id).changes;
    },

    remove: (table, id) => db.prepare(`DELETE FROM ${tableOf(table)} WHERE id = ?`).run(id).changes,

    // Every row whose columns equal `match`: an account's rows when it goes,
    // a transfer's two legs when it is unlinked. An empty match is refused,
    // so neither can become the whole table.
    removeWhere(table, match) {
      const keys = columnsOf(tableOf(table), match);
      return db.prepare(`DELETE FROM ${table} WHERE ${keys.map((k) => `${k} = ?`).join(' AND ')}`)
        .run(...keys.map((k) => match[k])).changes;
    },

    updateWhere(table, match, patch) {
      const where = columnsOf(tableOf(table), match);
      const set = columnsOf(table, patch);
      return db
        .prepare(`UPDATE ${table} SET ${set.map((k) => `${k} = ?`).join(', ')} WHERE ${where.map((k) => `${k} = ?`).join(' AND ')}`)
        .run(...set.map((k) => patch[k]), ...where.map((k) => match[k])).changes;
    },

    // Insert, or on its key replace the columns given.
    upsert(table, row) {
      const keys = columnsOf(keyedOf(table), row);
      const pk = KEYS[table];
      if (!pk.every((k) => keys.includes(k))) throw new Error(`ledger: ${table} 的主鍵是 ${pk.join(', ')}`);
      const rest = keys.filter((k) => !pk.includes(k));
      const set = rest.length ? `DO UPDATE SET ${rest.map((k) => `${k} = excluded.${k}`).join(', ')}` : 'DO NOTHING';
      db.prepare(
        `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})
         ON CONFLICT(${pk.join(', ')}) ${set}`
      ).run(...keys.map((k) => row[k]));
    },

    removeKey(table, key) {
      const pk = wholeKey(table, key);
      return db.prepare(`DELETE FROM ${table} WHERE ${pk.map((k) => `${k} = ?`).join(' AND ')}`)
        .run(...pk.map((k) => key[k])).changes;
    },

    // All or nothing. node:sqlite refuses a BEGIN inside a BEGIN, as the
    // demo's store refuses a nested tx.
    tx(fn) {
      db.exec('BEGIN');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },

    getMeta,
    setMeta,

    spendingRows: M.spendingRows,
    accountCurrencies: M.accountCurrencies,
    transferCandidates: () => M.findTransferCandidates(),
    reconcile: () => M.reconcile(),
    coverage: (opts) => M.coverage(opts),
    holdingsValued: (asOf) => M.holdingsValued(asOf),
    accountsWithBalances: (asOf) => M.accountsWithBalances(asOf),
    accountSeries: (id, to) => M.accountSeries(id, to),

    // One page of the transactions table, and what every matching row spans.
    txnPage({ account, from, to, kind, q }, limit, offset) {
      const where = [];
      const args = [];
      if (account !== null) { where.push('t.account_id = ?'); args.push(account); }
      if (from !== null) { where.push('t.date >= ?'); args.push(from); }
      if (to !== null) { where.push('t.date <= ?'); args.push(to); }
      if (kind !== null) { where.push('t.kind = ?'); args.push(kind); }
      if (q !== null) {
        where.push('(t.description LIKE ? OR t.category LIKE ? OR t.note LIKE ?)');
        const k = `%${q}%`;
        args.push(k, k, k);
      }
      const sql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const { n: total, first, last } = db
        .prepare(`SELECT COUNT(*) AS n, MIN(t.date) AS first, MAX(t.date) AS last FROM txns t${sql}`)
        .get(...args);
      const rows = db
        .prepare(
          `SELECT t.*, a.name AS account_name, a.currency
             FROM txns t JOIN accounts a ON a.id = t.account_id${sql}
            ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`
        )
        .all(...args, limit, offset);
      return { total, first, last, rows };
    },

    // What the dedup compares a file against: how many rows of the account
    // carry each fingerprint, and which external ids it already holds.
    dedupCounts(accountId) {
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
    },

    // The latest fifty, with the account's name where the account still exists.
    importList: () => db.prepare(
      `SELECT i.*, a.name AS account_name FROM imports i
         LEFT JOIN accounts a ON a.id = i.account_id ORDER BY i.id DESC LIMIT 50`
    ).all(),

    transferLegs: () => db.prepare(
      `SELECT t.transfer_group, t.id, t.account_id, t.date, t.amount, t.description, a.name AS account_name, a.currency
         FROM txns t JOIN accounts a ON a.id = t.account_id
        WHERE t.transfer_group IS NOT NULL ORDER BY t.date DESC, t.transfer_group, t.id`
    ).all(),

    institutions: () => db.prepare('SELECT * FROM institutions ORDER BY country, name').all(),
    prices: (symbol, market) => db.prepare(
      'SELECT symbol, market, date, price, source FROM prices WHERE symbol = ? AND market = ? ORDER BY date DESC'
    ).all(symbol, market),
    // The newest 400, which is years of a monthly rate.
    fxRates: () => db.prepare('SELECT * FROM fx_rates ORDER BY date DESC LIMIT 400').all(),

    // What the rules sweep reads: every row, only the three columns it needs.
    txnDescriptions: () => db.prepare('SELECT id, description, category FROM txns ORDER BY id').all(),

    // The last used first, never-used last, then by name.
    mappings: () => db.prepare('SELECT * FROM mappings ORDER BY used_at DESC NULLS LAST, name').all(),

    // 月度審計's rows: with their ids, because a finding names the rows it is
    // about, and two years back from `to`, which is what the recurring scan
    // needs to see a series.
    auditRows(to) {
      const from = `${Number(to.slice(0, 4)) - 2}${to.slice(4, 7)}-01`;
      return db.prepare(
        `SELECT id, account_id, date, amount, description, category, kind, transfer_group
           FROM txns WHERE date >= ? AND date <= ? ORDER BY date, id`
      ).all(from, to);
    },
  };
}

module.exports = { makeLedger };
