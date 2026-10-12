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

function makeLedger({ db, getMeta, setMeta, M }) {
  const columns = new Map();

  const tableOf = (table) => {
    if (!TABLES.has(table)) throw new Error(`ledger: 不認得的表 ${table}`);
    if (!columns.has(table)) {
      columns.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)));
    }
    return table;
  };

  const columnsOf = (table, row) => {
    const known = columns.get(tableOf(table));
    const keys = Object.keys(row);
    if (!keys.length) throw new Error(`ledger: ${table} 沒有要寫的欄位`);
    for (const k of keys) if (!known.has(k)) throw new Error(`ledger: ${table} 沒有 ${k} 這一欄`);
    return keys;
  };

  return {
    all: (table) => db.prepare(`SELECT * FROM ${tableOf(table)} ORDER BY id`).all(),
    get: (table, id) => db.prepare(`SELECT * FROM ${tableOf(table)} WHERE id = ?`).get(id) || null,

    insert(table, row) {
      const keys = columnsOf(table, row);
      const r = db
        .prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
        .run(...keys.map((k) => row[k]));
      return Number(r.lastInsertRowid);
    },

    update(table, id, patch) {
      const keys = columnsOf(table, patch);
      return db
        .prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => patch[k]), id).changes;
    },

    remove: (table, id) => db.prepare(`DELETE FROM ${tableOf(table)} WHERE id = ?`).run(id).changes,

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
