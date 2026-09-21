'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { DB_PATH, DATA_DIR, BACKUP_DIR } = require('./paths');
const { runMigrations } = require('./migrate');
const { LATEST } = require('./migrations');

const KEEP_BACKUPS = Number(process.env.KEEP_BACKUPS || 10);

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// A CSV import is the one action that writes hundreds of rows in one go, and
// a wrong column mapping is only obvious afterwards. Snapshot first so undoing
// it is a file copy rather than an archaeology exercise.
//
// SQLite's own `VACUUM INTO` rather than `fs.copyFile`: under WAL the `.db`
// file alone is not the whole database, and a plain copy silently leaves
// behind whatever is still in the `-wal`. It replaces the async `backup()`
// that used to do this job because it is synchronous, and the migration
// runner below takes a snapshot at require time, where there is nothing to
// await into. One snapshot path rather than two means the copy that only
// ever runs on somebody else's decade-old ledger is the same code, covered
// by the same tests, as the one that runs on every import.
//
// The copy is written to a `.part` and renamed on success. A half-written
// file that looks like a backup is worse than no backup: `listBackups()`
// would offer it, and it is the file somebody restores from.
function snapshot(label = 'manual') {
  if (DB_PATH === ':memory:') return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:-]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  let dest = path.join(BACKUP_DIR, `finance-${stamp}-${label}.db`);
  // Two snapshots inside the same second. `backup()` overwrote silently;
  // `VACUUM INTO` refuses an existing destination, so the later one gets a
  // suffix instead of an error. The unsuffixed name stays the normal case.
  for (let n = 2; fs.existsSync(dest); n++) {
    dest = path.join(BACKUP_DIR, `finance-${stamp}-${label}-${n}.db`);
  }
  const part = `${dest}.part`;
  fs.rmSync(part, { force: true });
  // Bound, not interpolated: a home directory with an apostrophe in it would
  // otherwise break the statement, and paths are not ours to assume about.
  db.prepare('VACUUM INTO ?').run(part);
  fs.renameSync(part, dest);
  pruneBackups();
  return dest;
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .sort()
    .reverse()
    .map((f) => {
      const s = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, bytes: s.size, created_at: s.mtime.toISOString() };
    });
}

// Always keeps at least one, whatever `KEEP_BACKUPS` says. `snapshot()` runs
// this immediately after writing a file and then hands its path back, so at
// `KEEP_BACKUPS=0` the caller was told about a backup that had already been
// deleted — and the migration runner, which now depends on that path, would
// have upgraded a real ledger with no safety net while reporting one.
function pruneBackups() {
  const keep = Math.max(1, KEEP_BACKUPS);
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
  }
}

// The schema lives in `./migrations`, not here. Everything that opens the
// ledger arrives through this module, so this is the one place a migration
// cannot be skipped — see the note at the top of `migrate.js` for why that
// matters more than being able to await.
let migration;
try {
  migration = runMigrations(db, { snapshot });
} catch (e) {
  if (e.code !== 'NEWER_THAN_CODE') throw e;
  // Same posture as the stranded-legacy-db guard in index.js: a book this
  // code does not understand gets a clear stop, not a best effort. Carrying
  // on would write today's rows into a shape the file does not have.
  console.error('');
  console.error('  這本帳是比這份程式新的版本建立的，不能用舊版打開。');
  console.error('');
  console.error(`    帳本：${DB_PATH}`);
  console.error(`    ${e.message}`);
  console.error('');
  console.error('  照著跑下去會把今天格式的資料寫進一個沒有那些欄位的檔案。');
  console.error('  把程式更新到建立這本帳的那個版本，或改用別本：');
  console.error('');
  console.error('    FINANCE_PROFILE=<名字> node server/index.js');
  console.error('');
  process.exit(1);
}

if (migration.applied.length && migration.from > 0) {
  console.log('');
  console.log(`  帳本結構從 v${migration.from} 升到 v${migration.to}（${migration.applied.join('、')}）。`);
  if (migration.backup) console.log(`  升級前的快照：${migration.backup}`);
  console.log('');
}

function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// `schema_version` is the runner's to write — it goes in the same commit as
// the step it describes, which is what makes a half-finished run resumable.
if (!getMeta('base_currency')) setMeta('base_currency', 'TWD');

module.exports = {
  db, getMeta, setMeta, snapshot, listBackups,
  migration, SCHEMA_VERSION: LATEST,
  DB_PATH, DATA_DIR, BACKUP_DIR,
};
