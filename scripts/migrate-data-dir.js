'use strict';

// One-time move of the ledger out of the repository.
//
//   node scripts/migrate-data-dir.js
//
// Copies <repo>/data/finance.db to ~/.finance-hub/finance.db, verifies the
// copy row by row, and leaves the original exactly where it was. Deleting it
// is a decision for whoever runs this, after they have seen the new one work.

const { DatabaseSync, backup } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const paths = require('../server/paths');
// Reads sqlite_master rather than a list of names, so a table added after
// this script was written is still compared. `./migrate` pulls in the
// migration list and nothing else — importantly not `./db`, which would open
// the very database this script is here to move.
const { tableCounts } = require('../server/migrate');

const SRC = paths.LEGACY_DB;
const SRC_BACKUPS = path.join(path.dirname(SRC), 'backups');
// The legacy book is by definition the personal one, whatever FINANCE_PROFILE
// happens to say in this shell.
const DEST = path.join(paths.HOME_DIR, 'finance.db');
const DEST_BACKUPS = path.join(paths.HOME_DIR, 'backups');

const die = (msg) => { console.error(`\n  ${msg}\n`); process.exit(1); };

function counts(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return tableCounts(db);
  } finally {
    db.close();
  }
}

(async () => {
  if (!fs.existsSync(SRC)) die(`找不到舊的帳本：${SRC}\n  已經搬過了，或這個 repo 本來就沒有資料。`);
  if (fs.existsSync(DEST)) {
    die(
      `新位置已經有一本帳了：${DEST}\n` +
      '  這個腳本不會覆蓋它。先確認哪一本才是你要的，把不要的改名，再跑一次。'
    );
  }

  fs.mkdirSync(paths.HOME_DIR, { recursive: true });

  // WAL means the .db file alone is not the whole database — a plain file copy
  // can silently leave behind everything still sitting in the -wal. SQLite's
  // own online backup produces a consistent copy that includes it.
  const src = new DatabaseSync(SRC, { readOnly: true });
  try {
    await backup(src, DEST);
  } finally {
    src.close();
  }

  const before = counts(SRC);
  const after = counts(DEST);
  // The union, so a table the copy dropped altogether is a mismatch rather
  // than an absent key on both sides that compares equal.
  const tables = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const mismatched = tables.filter((t) => before[t] !== after[t]);
  if (mismatched.length) {
    fs.rmSync(DEST, { force: true });
    die(
      `複製出來的資料對不上，已經把新檔刪掉，舊檔沒有動：\n` +
      mismatched.map((t) => `    ${t}: 舊 ${before[t]} → 新 ${after[t]}`).join('\n')
    );
  }

  // Pre-import snapshots belong with the ledger they protect.
  let movedBackups = 0;
  if (fs.existsSync(SRC_BACKUPS)) {
    fs.mkdirSync(DEST_BACKUPS, { recursive: true });
    for (const f of fs.readdirSync(SRC_BACKUPS).filter((f) => f.endsWith('.db'))) {
      const to = path.join(DEST_BACKUPS, f);
      if (!fs.existsSync(to)) { fs.copyFileSync(path.join(SRC_BACKUPS, f), to); movedBackups++; }
    }
  }

  console.log('');
  console.log('  搬好了。');
  console.log('');
  console.log(`    新：${DEST}`);
  for (const t of tables) if (after[t]) console.log(`         ${t.padEnd(15)} ${after[t]} 筆`);
  if (movedBackups) console.log(`    快照：${movedBackups} 份 → ${DEST_BACKUPS}`);
  console.log('');
  console.log(`    舊檔還在原地，一個位元組都沒動：${SRC}`);
  console.log('    跑一次 node server/index.js 確認資料都在，再自己把舊的 data/ 刪掉。');
  console.log('');
})().catch((e) => die(`搬移失敗，舊檔沒有動：${e.message}`));
