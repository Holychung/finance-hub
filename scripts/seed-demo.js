'use strict';

// Fill a *demo* ledger with invented data, so the app can be looked at with
// something in it.
//
//   FINANCE_PROFILE=demo node scripts/seed-demo.js
//   FINANCE_PROFILE=demo node server/index.js
//
// Why this exists: a fresh book shows empty states, and a book with one or
// two cash accounts in it shows "現金/存款 100%" in every breakdown, a net
// worth series with nothing to compare, no recurring charges and no coverage
// gaps. None of the things this app is actually for are visible until the
// data has some shape.
//
// **It refuses to touch the personal ledger.** Not a warning, a refusal: the
// whole point is a second book, and a seeder that can overwrite the first one
// is one typo away from being the worst bug in the repo.
//
// **The book itself is `shared/demo-seed.js`**, not here. The hosted demo in
// the browser loads exactly the same rows into memory, and two hand-written
// fake ledgers would have drifted the first time either was touched. What is
// left in this file is the half only a server can do: refuse the wrong
// database, and write.

const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('../server/paths');

// Before requiring ./db, which opens — and now migrates — whatever DB_PATH
// resolves to. server/paths.js is pure precisely so that this can come first.
const personal = path.join(paths.HOME_DIR, 'finance.db');
if (path.resolve(paths.DB_PATH) === path.resolve(personal)) {
  console.error(`
  拒絕寫入個人帳本：${paths.DB_PATH}

  這個腳本會塞進幾百筆編出來的交易。請指定另一本：
    FINANCE_PROFILE=demo node scripts/seed-demo.js
`);
  process.exit(1);
}

const { db } = require('../server/db');
const { buildDemoBook, DEMO_MONTHS } = require('../shared/demo-seed');

const args = new Set(process.argv.slice(2));
const argOf = (name) => {
  const hit = [...args].find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const FORCE = args.has('--force');
const TO = argOf('to') || new Date().toISOString().slice(0, 10);
const MONTHS = Number(argOf('months') || DEMO_MONTHS);

const existing = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
if (existing && !FORCE) {
  console.error(`
  ${paths.DB_PATH} 裡已經有 ${existing} 個帳戶。

  要重來的話加 --force（會清掉這本帳的所有內容，不影響個人帳本）。
`);
  process.exit(1);
}

const book = buildDemoBook({
  to: TO,
  months: MONTHS,
  now: () => new Date().toISOString(),
  uuid: () => crypto.randomUUID(),
});

// The columns come from the rows themselves, ids included. Letting SQLite
// assign its own ids would leave the two copies of this book numbered
// differently for no reason, and test/seed.test.js compares them row for row.
//
// There used to be a hand-written column list per table here, and it was a
// second copy of what shared/demo-seed.js builds: a column the book carried
// but the list did not was silently dropped and SQLite filled in its default.
// `access` went missing that way unnoticed — the demo's accounts were all
// `liquid`, which is also the default, so the two copies still agreed — and
// `holdings.decimals` was caught only because the demo's values differ from
// the column default. Writing every key the rows have leaves nothing to drift.
const columnsOf = (rows) => [...new Set(rows.flatMap((r) => Object.keys(r)))];

db.exec('BEGIN');
try {
  if (FORCE) {
    for (const t of ['txns', 'holdings', 'prices', 'balance_checks', 'imports', 'accounts', 'institutions', 'fx_rates', 'rules', 'budgets']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
  }

  // Insertion order matters: a foreign key points at a row that has to exist.
  for (const table of ['institutions', 'accounts', 'imports', 'txns', 'holdings', 'prices', 'fx_rates', 'balance_checks', 'rules', 'budgets']) {
    if (!book[table].length) continue;
    const cols = columnsOf(book[table]);
    const stmt = db.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
    );
    for (const row of book[table]) stmt.run(...cols.map((c) => (row[c] === undefined ? null : row[c])));
  }

  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

const counts = {
  帳戶: db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n,
  交易: db.prepare('SELECT COUNT(*) AS n FROM txns').get().n,
  持股: db.prepare('SELECT COUNT(*) AS n FROM holdings').get().n,
  匯入紀錄: db.prepare('SELECT COUNT(*) AS n FROM imports').get().n,
  分類規則: db.prepare('SELECT COUNT(*) AS n FROM rules').get().n,
  預算: db.prepare('SELECT COUNT(*) AS n FROM budgets').get().n,
};
console.log(`
  示範資料已寫入 ${paths.DB_PATH}
  ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}
  期間 ${book.span.from} → ${book.span.to}

  規則是故意沒有套用的：分類頁有東西可看，「套用規則」也真的有事做。

  看一下：  ${process.env.FINANCE_DB ? `FINANCE_DB=${paths.DB_PATH}` : `FINANCE_PROFILE=${paths.PROFILE}`} node server/index.js
`);
