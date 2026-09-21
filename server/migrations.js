'use strict';

// Every version this database has ever had, in order.
//
// This list is the *only* description of the schema. `db.js` issues no
// CREATE TABLE of its own: a brand new file is version 0 and is built by
// replaying from step 1, an existing book catches up from wherever it is, and
// there is exactly one code path to any given version.
//
// The alternative — keeping today's shape in a SCHEMA string for fresh
// installs and writing a migration for existing ones — is the arrangement
// that fails quietly. The migration then only ever executes on other
// people's ledgers, never in a test run or on the author's machine, so a
// broken step ships unexercised; and the two definitions drift the first time
// someone edits one and forgets the other. Here the whole chain runs on every
// `node --test`, because the throwaway database each suite creates is born at
// version 0 like any other.
//
// **Append, never edit.** An applied step is history. Changing step 3 after it
// has run changes what somebody's ledger was told it already had, and nothing
// will ever notice. Step 1 in particular is frozen: it is what every existing
// book already has, and `test/migrate.test.js` compares a replayed database
// against it.
//
// Each entry is `{ version, name, up(db) }` plus two optional keys, both
// documented where the runner uses them:
//
//   rebuild: true   the step rewrites a table, so foreign keys are switched
//                   off around it and checked again before the commit
//   verify(db, before, after)
//                   replaces the default row-count identity check, for a step
//                   that is *supposed* to change how many rows exist

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial schema',
    // Verbatim what `db.js` issued as CREATE TABLE IF NOT EXISTS from the
    // first commit until the runner existed. Every ledger in the world is
    // already at this shape, so the step exists to build new ones — and to be
    // harmlessly re-runnable against a book whose `schema_version` stamp went
    // missing, which is why every statement here keeps its IF NOT EXISTS.
    up(db) {
      db.exec(`
CREATE TABLE IF NOT EXISTS institutions (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  kind     TEXT NOT NULL DEFAULT 'bank',   -- bank | broker | card | other
  country  TEXT NOT NULL DEFAULT 'TW'      -- TW | US | other
);

CREATE TABLE IF NOT EXISTS accounts (
  id              INTEGER PRIMARY KEY,
  institution_id  INTEGER REFERENCES institutions(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'cash',  -- cash | brokerage | card | loan | other
  currency        TEXT NOT NULL DEFAULT 'TWD',   -- TWD | USD
  opening_balance REAL NOT NULL DEFAULT 0,
  opening_date    TEXT NOT NULL DEFAULT '2020-01-01',
  is_active       INTEGER NOT NULL DEFAULT 1,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  note            TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS imports (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  filename   TEXT NOT NULL,
  mapping    TEXT NOT NULL DEFAULT '',
  imported   INTEGER NOT NULL DEFAULT 0,
  skipped    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS txns (
  id             INTEGER PRIMARY KEY,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,                  -- YYYY-MM-DD
  amount         REAL NOT NULL,                  -- native currency; + in, - out
  description    TEXT NOT NULL DEFAULT '',
  category       TEXT NOT NULL DEFAULT '',
  kind           TEXT NOT NULL DEFAULT 'other',  -- income|expense|transfer|trade|dividend|fee|fx|other
  transfer_group TEXT,                           -- set when paired with its counterpart
  source         TEXT NOT NULL DEFAULT 'manual', -- manual|csv|api
  external_id    TEXT,                           -- FITID / broker ref, when the file has one
  fingerprint    TEXT NOT NULL,
  import_id      INTEGER REFERENCES imports(id) ON DELETE SET NULL,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_txns_account_date ON txns(account_id, date);
CREATE INDEX IF NOT EXISTS idx_txns_date         ON txns(date);
CREATE INDEX IF NOT EXISTS idx_txns_fingerprint  ON txns(fingerprint);
CREATE INDEX IF NOT EXISTS idx_txns_transfer     ON txns(transfer_group);

CREATE TABLE IF NOT EXISTS fx_rates (
  date TEXT NOT NULL,
  pair TEXT NOT NULL,          -- e.g. USDTWD
  rate REAL NOT NULL,
  PRIMARY KEY (date, pair)
);

CREATE TABLE IF NOT EXISTS holdings (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  market     TEXT NOT NULL DEFAULT 'TW',   -- TW | US
  shares     REAL NOT NULL DEFAULT 0,
  avg_cost   REAL NOT NULL DEFAULT 0,      -- per share, native currency
  last_price REAL NOT NULL DEFAULT 0,      -- per share, native currency
  price_date TEXT,
  currency   TEXT NOT NULL DEFAULT 'TWD',
  note       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_holdings_account ON holdings(account_id);

-- What the bank/broker actually says the balance is, so drift from a
-- missed CSV row surfaces instead of quietly rotting the numbers.
CREATE TABLE IF NOT EXISTS balance_checks (
  id         INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date       TEXT NOT NULL,
  stated     REAL NOT NULL,
  note       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_balchk_account ON balance_checks(account_id, date);

-- Remembered column mapping per institution/file shape.
CREATE TABLE IF NOT EXISTS mappings (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  config     TEXT NOT NULL,           -- JSON
  created_at TEXT NOT NULL,
  used_at    TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
    },
  },

  {
    version: 2,
    name: 'rules',
    // Categorisation rules: match a pattern against a description, assign a
    // category. Six of the eight supported statement formats carry no category
    // column at all, so for most files this is where a category comes from.
    // `priority` decides the order they are tried in; first match wins.
    //
    // This arrived before the runner did, as a `CREATE TABLE IF NOT EXISTS` in
    // `db.js` that stamped `schema_version = 2` on the way past — which is why
    // it is version 2 here and not 3. Books that were opened by that build
    // already have the table and the stamp, so they skip this step; books that
    // were not get it here. A new table really is that cheap; a new *column*
    // is not, and that is what the rest of this machinery is for.
    up(db) {
      db.exec(`
CREATE TABLE IF NOT EXISTS rules (
  id         INTEGER PRIMARY KEY,
  pattern    TEXT NOT NULL,
  category   TEXT NOT NULL,
  priority   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`);
    },
  },

  {
    version: 3,
    name: 'index txns.import_id',
    // Reverting an import is `DELETE FROM txns WHERE import_id = ?`
    // (api.js), and `import_id` was the one foreign key on `txns` with no
    // index — every revert was a full table scan, and with ON DELETE SET NULL
    // pointing at `imports`, so was deleting an import row. The four indexes
    // step 1 creates cover account/date, date, fingerprint and transfer_group
    // and stop there.
    up(db) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_txns_import ON txns(import_id)');
    },
  },

  {
    version: 4,
    name: 'imports date range',
    // What span of dates a statement actually covered, which the ledger threw
    // away. Without it a month with no transactions is indistinguishable from
    // a month nobody downloaded, and /coverage had to call both a gap — so an
    // account that genuinely sat idle collected red squares it had no way to
    // clear except by typing a balance check for every quiet month.
    //
    // `ALTER TABLE ADD COLUMN` has no IF NOT EXISTS in SQLite, unlike every
    // statement in step 1. It does not need one: the runner gates each step on
    // the stored version and runs it exactly once. Step 1 is the exception
    // because it also has to be safe against a book whose stamp went missing.
    //
    // The backfill can only see the rows that landed, so an older import's
    // range is its *imported* extent — duplicates and refused rows are not in
    // `txns` and a reverted import leaves nothing at all. It therefore
    // under-reports, which is the right direction to be wrong in: it can only
    // fail to clear a gap, never invent coverage that was not there. From here
    // on `api.js` records the extent of every parsed row instead.
    up(db) {
      db.exec('ALTER TABLE imports ADD COLUMN date_from TEXT');
      db.exec('ALTER TABLE imports ADD COLUMN date_to TEXT');
      db.exec(`
UPDATE imports SET
  date_from = (SELECT MIN(t.date) FROM txns t WHERE t.import_id = imports.id),
  date_to   = (SELECT MAX(t.date) FROM txns t WHERE t.import_id = imports.id)
`);
    },
  },

  {
    version: 5,
    name: 'imports declared period',
    // Where the range came from, which decides how far it may be trusted.
    //
    // A range derived from the file's own rows can only ever be believed for
    // whole months: a statement whose first row is the 12th says nothing
    // about the first eleven days, because a file with no rows there looks
    // exactly like a month with no spending. A range the *user* declared has
    // no such problem — the bank's download page asked them to pick
    // "Statement of 2026-08" or "Year to date" and they know which they
    // chose, so 08-16 to 09-15 really does mean the second half of August is
    // covered and the first half is not.
    //
    // 'derived' as the default backfills every existing row, which is what
    // they are: step 4 reconstructed them from rows, and nobody was asked.
    up(db) {
      db.exec("ALTER TABLE imports ADD COLUMN period_kind TEXT NOT NULL DEFAULT 'derived'");
    },
  },
];

const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;

module.exports = { MIGRATIONS, LATEST };
