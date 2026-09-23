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

  {
    version: 6,
    name: 'prices',
    // Price history, keyed by the security rather than the position: one series
    // per (symbol, market), the way `fx_rates` is one series per pair and not
    // per account. `holdings.last_price` was a single mutable field — updating
    // a price destroyed the previous one, so there was no history to build a
    // trend, a return, or an honest securities line on. This is the table the
    // rest of phase 2 (auto price fetch, XIRR) writes into and reads from.
    //
    // This is the first migration that is *meant* to move rows, so it carries
    // `verify()`; the default check would refuse it. It stays honest twice
    // over: the earliest-price fallback that `fx.on` does is deliberately NOT
    // copied into the lookup (a price before the first observation is null, not
    // the oldest one dragged backward), and the backfill below dates an
    // observation only when the holding already carried a date — a price with
    // no date is left to the `last_price` fallback rather than stamped by guess.
    up(db) {
      db.exec(`
CREATE TABLE prices (
  symbol TEXT NOT NULL,
  market TEXT NOT NULL,          -- TW | US, so a TW 2330 never collides with a US symbol
  date   TEXT NOT NULL,          -- YYYY-MM-DD
  price  REAL NOT NULL,          -- per share, native currency
  source TEXT NOT NULL DEFAULT 'manual',   -- manual | api (the seam vocabulary)
  PRIMARY KEY (symbol, market, date)
);
CREATE INDEX idx_prices_lookup ON prices(symbol, market, date);
`);
      // Each priced holding's stored last_price becomes its opening
      // observation, so the position keeps the number it already showed and the
      // history has one real point in it. INSERT OR IGNORE because two holdings
      // of one symbol sharing a date collapse to a single observation.
      db.exec(`
INSERT OR IGNORE INTO prices (symbol, market, date, price, source)
SELECT UPPER(TRIM(symbol)), market, price_date, last_price, 'manual'
  FROM holdings
 WHERE last_price > 0 AND TRIM(symbol) <> '' AND price_date IS NOT NULL AND TRIM(price_date) <> ''
`);
    },
    verify(db, before, after) {
      // prices is the only count allowed to move, and it must land on exactly
      // the number of distinct (symbol, market, date) the backfill could see.
      for (const t of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (t === 'prices') continue;
        if ((before[t] ?? 0) !== (after[t] ?? 0)) {
          throw new Error(`v6 只該新增 prices，卻動到 ${t}（${before[t] ?? '—'}→${after[t] ?? '—'}）`);
        }
      }
      const expected = db
        .prepare(
          `SELECT COUNT(*) AS n FROM (
             SELECT DISTINCT UPPER(TRIM(symbol)) AS s, market, price_date
               FROM holdings
              WHERE last_price > 0 AND TRIM(symbol) <> '' AND price_date IS NOT NULL AND TRIM(price_date) <> ''
           )`
        )
        .get().n;
      if ((after.prices ?? 0) !== expected) {
        throw new Error(`v6 回填應為 ${expected} 筆 prices，實際 ${after.prices ?? 0} 筆`);
      }
    },
  },

  {
    version: 7,
    name: 'account access',
    // Whether there is a rule between you and the money in this account: an
    // age, a notice period, a penalty. Net worth sums a checking balance, a
    // brokerage position and a card into one figure per currency, which works
    // because all three are money you could have this week. A retirement
    // account or a locked stake is not, and adding it to that figure raises the
    // headline by an amount nobody can spend. The vocabulary is
    // `shared/kinds.js`'s ACCESS; see docs/plans/asset-classes.md.
    //
    // 'liquid' as the default is what every existing account already is, so a
    // book upgrades with every figure unchanged — which is the test. A CHECK
    // would catch a typo at the database, but an ALTER cannot add one to an
    // existing column's table without a rebuild, and the API refuses anything
    // outside the list before it gets here.
    up(db) {
      db.exec("ALTER TABLE accounts ADD COLUMN access TEXT NOT NULL DEFAULT 'liquid'");
    },
  },

  {
    version: 8,
    name: 'holdings decimals',
    // How many places a holding's quantity is written to. Shares were shown by
    // asking whether the number had a fraction and then printing four places,
    // which reports 0.00000001 BTC as `0.0000`; a coin needs eight. The scale
    // now belongs to the holding, with a per-market default in
    // `shared/kinds.js`'s MARKETS.
    //
    // 4 for every existing row because it is exactly the display they already
    // had — `quantity()` defaulted to four places — so a book upgrades with
    // nothing on screen changing. New holdings take their market's default
    // instead (TW 0, US 4, CRYPTO 8), which is why the migration default and
    // the TW default differ on purpose. Nothing is rounded on the way in:
    // this is the scale a quantity is shown at, not a precision to truncate
    // stored values to.
    //
    // Step 1 still says `market … -- TW | US`. That comment is frozen with the
    // step it belongs to; the list of markets is MARKETS now, CRYPTO included.
    up(db) {
      db.exec('ALTER TABLE holdings ADD COLUMN decimals INTEGER NOT NULL DEFAULT 4');
    },
  },

  {
    version: 9,
    name: 'accounts tax status and unvested',
    // The two things a retirement account says that nothing else here can.
    //
    // `tax_status` is what kind of figure the balance is — pre-tax, Roth,
    // after-tax — and is only ever displayed. Nullable, because for almost
    // every account there is nothing to state, and a default would state one.
    //
    // `unvested` is the part of the balance an employer can still take back,
    // a figure the plan document gives. Net worth subtracts it; the balance
    // does not, because the balance is what the statement says and what a
    // balance check is compared against, and the statement counts it in.
    // 0 for every existing account, so a book upgrades with every figure
    // unchanged. The API refuses a negative one, which would add money nobody
    // has.
    up(db) {
      db.exec(`
ALTER TABLE accounts ADD COLUMN tax_status TEXT;
ALTER TABLE accounts ADD COLUMN unvested REAL NOT NULL DEFAULT 0;
`);
    },
  },
];

const LATEST = MIGRATIONS[MIGRATIONS.length - 1].version;

module.exports = { MIGRATIONS, LATEST };
