'use strict';

// The migration runner.
//
// Pure in the sense that matters here: it is handed an open database and a
// way to take a snapshot, and it decides where neither of them lives. That is
// what lets `test/migrate.test.js` drive it against throwaway handles and
// deliberately broken migration lists without going anywhere near
// `~/.finance-hub`, and it keeps `paths.js` out of the picture entirely.
//
// It runs at `require('./db')` time. That is the only placement with no way
// around it: every route into the ledger — `index.js`, a future script,
// `node -e`, a unit test — goes through that require, whereas an explicit
// bootstrap is a promise that every future caller remembers, and the caller
// who forgets opens a real v1 book with vN code and writes rows into a shape
// the file does not have. The price is that everything below is synchronous,
// which is why `db.js`'s snapshot is now `VACUUM INTO` rather than the async
// `backup()`.

const { MIGRATIONS } = require('./migrations');

class MigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

// Version 0 is a file with nothing in it yet.
//
// A book that has the tables but no stamp also reads as 0. It can only have
// come from the old code being killed between `exec(SCHEMA)` and writing the
// row, and step 1 is idempotent precisely so that replaying it there is a
// no-op — which is a fact about the step, not a guess about the file. That is
// also why step 1 must keep every IF NOT EXISTS it has.
function readVersion(db) {
  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (!hasMeta) return 0;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  const n = row ? Number(row.value) : 0;
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// Counted over whatever tables the database has at that moment, read from
// sqlite_master rather than from a list — a list is a second place to rot,
// and it would miss exactly the table the migration under test just created.
// `sqlite_%` is SQLite's own bookkeeping.
function tableCounts(db) {
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const out = {};
  // The name comes from sqlite_master, not from anything a user typed, but it
  // is still going into SQL by concatenation because an identifier cannot be
  // bound — so it is quoted, and an embedded quote is doubled.
  for (const t of names) out[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t.replace(/"/g, '""')}"`).get().n;
  return out;
}

// The default self-test: a schema change moves no rows.
//
// Compared over the union of before and after, not over the tables that
// existed before — a step that creates a table and fills it is the case that
// slips through otherwise, and it is the shape a backfill actually takes.
//
// A step that is *supposed* to change how many rows exist says so by
// supplying `verify()`, which then has to assert the right post-state itself.
// There is deliberately no boolean that switches the check off: an escape
// hatch you can take by typing `true` becomes the default the first time
// somebody is in a hurry, whereas one that makes you write down what correct
// looks like is visible in the diff.
function assertSameCounts(m, before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const moved = names
    .filter((t) => (before[t] ?? 0) !== (after[t] ?? 0))
    .map((t) => `${t} ${before[t] ?? '—'}→${after[t] ?? '—'}`);
  if (moved.length) {
    throw new MigrationError(
      'ROW_COUNT',
      `migration ${m.version}（${m.name}）改動了資料筆數但沒有寫 verify()：${moved.join('、')}`
    );
  }
}

// Versions are 1, 2, 3 … with no gaps, so "what is the latest" is the last
// entry and "has this one run" is a comparison. A duplicate or a skipped
// number means two people appended at once and one of them is about to be
// silently skipped on every database that saw the other first.
function assertOrdered(migrations) {
  let prev = 0;
  for (const m of migrations) {
    if (m.version !== prev + 1) {
      throw new MigrationError('BAD_LIST', `migration 版本要從 1 起連號：${prev} 之後是 ${m.version}`);
    }
    if (typeof m.up !== 'function') {
      throw new MigrationError('BAD_LIST', `migration ${m.version} 沒有 up()`);
    }
    prev = m.version;
  }
}

// Returns true if this process applied the step, false if it found it already
// applied by somebody else.
function applyOne(db, m) {
  // A table rebuild is the twelve-step dance, and `PRAGMA foreign_keys` is a
  // no-op once a transaction is open — verified, not assumed — so it has to
  // be toggled out here.
  if (m.rebuild) db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read under the write lock. Nothing stops two servers being pointed
      // at one book, and the loser of that race has to find the step already
      // applied rather than apply it a second time.
      if (readVersion(db) >= m.version) {
        db.exec('COMMIT');
        return false;
      }

      const before = tableCounts(db);
      const returned = m.up(db);

      // `async up()` is the habit the rest of this codebase teaches, and it
      // is the worst thing that can happen here. Nothing below awaits, so the
      // counts are taken, the version is stamped and the transaction commits
      // while the step's real work is still queued — it then runs afterwards
      // with no transaction around it at all, and if it fails the book claims
      // a version it never reached and nothing will ever re-run the step.
      // Observed exactly that before this check existed.
      if (returned && typeof returned.then === 'function') {
        throw new MigrationError(
          'ASYNC_UP',
          `migration ${m.version}（${m.name}）的 up() 是 async。這裡全程同步，回傳 Promise 等於在交易外做事`
        );
      }

      // An `up()` that issued its own COMMIT has already ended the
      // transaction: the version bump below would land unprotected, and a
      // failure after it could no longer roll anything back. Caught here
      // rather than discovered on somebody's ledger.
      if (!db.isTransaction) {
        throw new MigrationError('SELF_COMMIT', `migration ${m.version}（${m.name}）的 up() 自己結束了交易`);
      }

      const after = tableCounts(db);
      if (m.verify) m.verify(db, before, after);
      else assertSameCounts(m, before, after);

      // Inside the transaction, so a rebuild that orphaned rows rolls back
      // instead of being reported afterwards about a database already
      // written.
      if (m.rebuild) {
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) {
          throw new MigrationError(
            'FK_BROKEN',
            `migration ${m.version}（${m.name}）留下 ${broken.length} 筆對不到的外鍵`
          );
        }
      }

      // The stamp goes in the same commit as the change it describes. That is
      // the whole resume story: killed anywhere in this block, the database
      // comes back at the last version that completed, with this step
      // entirely absent rather than half there.
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run('schema_version', String(m.version));

      db.exec('COMMIT');
      return true;
    } catch (e) {
      // A failed statement leaves the transaction open rather than unwinding
      // it, so the rollback is explicit.
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    if (m.rebuild) db.exec('PRAGMA foreign_keys = ON');
  }
}

function runMigrations(db, { snapshot = null, migrations = MIGRATIONS } = {}) {
  assertOrdered(migrations);
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  const from = readVersion(db);

  // Somebody ran a newer build against this book and then went back. Opening
  // it anyway means writing v(latest)-shaped rows into a v(from) file and
  // finding out later, so this refuses for the same reason `paths.js` refuses
  // a stranded `data/finance.db`: a clear stop beats a quiet wrong answer.
  if (from > latest) {
    throw new MigrationError(
      'NEWER_THAN_CODE',
      `這本帳是 schema v${from}，這份程式最高只認得 v${latest}`
    );
  }

  const pending = migrations.filter((m) => m.version > from);
  if (!pending.length) return { from, to: from, applied: [], backup: null };

  // `from > 0` means there are already rows in there to lose. A brand new
  // file has nothing to back up, and snapshotting one would put a copy of an
  // empty database in `backups/` on every single test run.
  const backup = from > 0 && snapshot ? snapshot('migrate') : null;

  // Without this the second of two processes starting together dies on the
  // write lock immediately (the default is 0). Ten seconds is longer than any
  // step here and short enough that a genuine deadlock still looks like one.
  // Restored afterwards because this connection is the whole app's.
  const previousTimeout = Number(db.prepare('PRAGMA busy_timeout').get().timeout) || 0;
  db.exec('PRAGMA busy_timeout = 10000');

  const applied = [];
  try {
    for (const m of pending) if (applyOne(db, m)) applied.push(m.version);
  } finally {
    db.exec(`PRAGMA busy_timeout = ${Number(previousTimeout)}`);
  }

  return { from, to: readVersion(db), applied, backup };
}

module.exports = { runMigrations, readVersion, tableCounts, MigrationError };
