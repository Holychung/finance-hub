'use strict';

// Run with:  node --test
//
// The migration runner is handed an open database and a snapshot function, so
// everything here drives it against throwaway handles and deliberately broken
// migration lists. Nothing in this file can reach ~/.finance-hub: `migrate.js`
// requires `./migrations` and nothing else — importantly not `./db`, which
// would open the real ledger just by being required.
//
// Each case gets its own mkdtemp DIRECTORY rather than a unique filename,
// which is the same rule the rest of the suite follows: `paths.js` derives
// DATA_DIR and BACKUP_DIR from the database's directory, and teardown must
// only ever remove a directory this process created.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runMigrations, readVersion, tableCounts, MigrationError } = require('../server/migrate');
const { MIGRATIONS, LATEST } = require('../server/migrations');

const DB_JS = path.join(__dirname, '..', 'server', 'db.js');

// A directory per case. The caller removes it; nothing is shared.
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hub-migrate-'));
  const open = (name = 'finance.db') => {
    const db = new DatabaseSync(path.join(dir, name));
    db.exec('PRAGMA foreign_keys = ON');
    return db;
  };
  return { dir, open, rm: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// The shape every existing ledger in the world already has: step 1 applied,
// stamped 1, with rows in it. Built from MIGRATIONS[0] rather than from a
// frozen .sql copy, so there is still only one definition of version 1.
function v1BookWithRows(db, txnCount = 5) {
  MIGRATIONS[0].up(db);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  db.prepare("INSERT INTO institutions (name) VALUES ('玉山銀行')").run();
  db.prepare("INSERT INTO accounts (institution_id, name) VALUES (1, '活存')").run();
  const ins = db.prepare(
    'INSERT INTO txns (account_id, date, amount, fingerprint, created_at) VALUES (1, ?, ?, ?, ?)'
  );
  for (let i = 0; i < txnCount; i++) ins.run(`2026-01-0${i + 1}`, i * 10, `fp${i}`, '2026-01-01');
}

// sqlite_master with the rowids and the ordering taken out, so two databases
// built by different routes can be compared as shapes.
function shape(db) {
  return db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => `${r.type} ${r.name} ${r.tbl_name} ${String(r.sql).replace(/\s+/g, ' ').trim()}`)
    .sort();
}

// A list whose steps record that they ran, so "was this applied again?" is a
// count rather than a version read — a runner that silently re-applies a step
// would pass the version check and fail this one.
function countingList(specs) {
  const calls = [];
  const list = specs.map((s, i) => ({
    version: i + 1,
    name: s.name || `step ${i + 1}`,
    rebuild: s.rebuild,
    verify: s.verify,
    up(db) {
      calls.push(i + 1);
      s.up(db);
    },
  }));
  return { list, calls };
}

// The smallest usable schema, so a test list does not have to carry the real
// step 1 when it is not what is under test.
const tinyBase = {
  name: 'base',
  up: (db) => db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE t (x)'),
};

describe('migration runner — 版本與重放', () => {
  it('全新的檔案是版本 0，整條 chain 跑完就到最新版', () => {
    const s = scratch();
    const db = s.open();
    assert.equal(readVersion(db), 0, '空檔案沒有 meta 表，就是版本 0');

    const r = runMigrations(db, {});
    assert.equal(r.from, 0);
    assert.equal(r.to, LATEST);
    assert.deepEqual(r.applied, MIGRATIONS.map((m) => m.version));
    assert.equal(readVersion(db), LATEST);

    db.close();
    s.rm();
  });

  it('再跑一次完全不做事：不是版本沒動而已，是 up() 一次都沒被呼叫', () => {
    const s = scratch();
    const db = s.open();
    const { list, calls } = countingList([tinyBase, { up: (db2) => db2.exec('CREATE INDEX i1 ON t(x)') }]);

    runMigrations(db, { migrations: list });
    assert.deepEqual(calls, [1, 2]);

    const again = runMigrations(db, { migrations: list });
    assert.deepEqual(calls, [1, 2], 'no-op 的意思是沒有再跑一次，不是跑了但結果一樣');
    assert.deepEqual(again.applied, []);
    assert.equal(again.from, 2);

    db.close();
    s.rm();
  });

  it('既有的 v1 帳本只補跑 v1 以後的步驟，資料一筆不動', () => {
    const s = scratch();
    const db = s.open();
    v1BookWithRows(db);
    const before = tableCounts(db);

    const r = runMigrations(db, {});
    assert.equal(r.from, 1);
    assert.equal(r.to, LATEST);
    assert.deepEqual(r.applied, MIGRATIONS.filter((m) => m.version > 1).map((m) => m.version));

    // Not deepEqual: a step may add an empty table, and one does. What must
    // hold is that no table's count moved — the same thing the runner's own
    // self-test checks, asserted here across the whole chain at once.
    const after = tableCounts(db);
    const moved = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((t) => (before[t] ?? 0) !== (after[t] ?? 0));
    assert.deepEqual(moved, [], '升級不該動到任何一張表的筆數');

    db.close();
    s.rm();
  });

  // The one test that makes "append, never edit" mechanical. Editing step 1 —
  // to add a column to a fresh install, say — gives new databases something
  // every existing book will never get, and nothing else in the suite would
  // notice. Here the two shapes stop matching.
  it('補跑上來的帳本和全新建立的帳本，schema 完全一樣', () => {
    const s = scratch();
    const fresh = s.open('fresh.db');
    const upgraded = s.open('upgraded.db');

    runMigrations(fresh, {});
    v1BookWithRows(upgraded);
    runMigrations(upgraded, {});

    assert.deepEqual(shape(upgraded), shape(fresh));
    assert.equal(readVersion(upgraded), readVersion(fresh));

    fresh.close();
    upgraded.close();
    s.rm();
  });

  it('版本要從 1 起連號，重號或跳號當場拒絕', () => {
    const s = scratch();
    const db = s.open();
    for (const bad of [
      [{ version: 2, name: 'a', up() {} }],
      [{ version: 1, name: 'a', up() {} }, { version: 1, name: 'b', up() {} }],
      [{ version: 1, name: 'a', up() {} }, { version: 3, name: 'c', up() {} }],
    ]) {
      assert.throws(
        () => runMigrations(db, { migrations: bad }),
        (e) => e instanceof MigrationError && e.code === 'BAD_LIST'
      );
    }
    db.close();
    s.rm();
  });

  it('比程式新的帳本不會被硬開，而是拒絕', () => {
    const s = scratch();
    const db = s.open();
    v1BookWithRows(db);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();

    assert.throws(
      () => runMigrations(db, {}),
      (e) => e instanceof MigrationError && e.code === 'NEWER_THAN_CODE'
    );
    assert.equal(readVersion(db), 99, '拒絕就是什麼都不做，連版本都沒碰');

    db.close();
    s.rm();
  });

  // The old db.js set schema_version in a separate statement after creating
  // the tables, so a kill in between could leave a book with the shape and no
  // stamp. Step 1 is all IF NOT EXISTS so replaying it there is a fact, not a
  // hope — this pins that it stays so.
  it('有表但沒有 schema_version 的帳本，重放第 1 步不會弄壞它', () => {
    const s = scratch();
    const db = s.open();
    MIGRATIONS[0].up(db);
    db.prepare("INSERT INTO institutions (name) VALUES ('玉山銀行')").run();
    assert.equal(readVersion(db), 0);

    const r = runMigrations(db, {});
    assert.equal(r.to, LATEST);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM institutions').get().n, 1, '既有的資料還在');

    db.close();
    s.rm();
  });

  // v6 is the first step that is *meant* to move rows: it seeds `prices` from
  // each priced holding, so it carries verify() and this pins what it backfills.
  it('v6 把有價又有日期的持股回填成第一筆報價，其餘留白', () => {
    const s = scratch();
    const db = s.open();
    v1BookWithRows(db);
    const h = db.prepare(
      'INSERT INTO holdings (account_id, symbol, market, shares, avg_cost, last_price, price_date, currency) VALUES (1, ?, ?, ?, ?, ?, ?, ?)'
    );
    h.run('2330', 'TW', 100, 900, 1085, '2026-09-19', 'TWD');   // priced + dated → backfills
    h.run('VTI', 'US', 10, 250, 288.4, null, 'USD');            // no date → left to the fallback, not guessed
    h.run('GIFT', 'US', 5, 0, 0, '2026-09-19', 'USD');          // no price → nothing to record

    const r = runMigrations(db, {});
    assert.equal(r.to, LATEST);

    // Spread each row: node:sqlite hands back null-prototype objects, and
    // strict deepEqual counts that against a plain literal.
    const prices = db.prepare('SELECT symbol, market, date, price, source FROM prices').all().map((r) => ({ ...r }));
    assert.deepEqual(prices, [
      { symbol: '2330', market: 'TW', date: '2026-09-19', price: 1085, source: 'manual' },
    ]);

    db.close();
    s.rm();
  });
});

describe('migration runner — 交易與續跑', () => {
  it('某一步炸掉，帳本停在上一步，而且那一步一點痕跡都沒留下', () => {
    const s = scratch();
    const db = s.open();
    const { list } = countingList([
      tinyBase,
      { up: (db2) => db2.exec('CREATE INDEX i1 ON t(x)') },
      {
        name: 'boom',
        up: (db2) => {
          db2.exec('CREATE INDEX i2 ON t(x)');
          throw new Error('半路壞掉');
        },
      },
    ]);

    assert.throws(() => runMigrations(db, { migrations: list }), /半路壞掉/);
    assert.equal(readVersion(db), 2, '停在最後一個完成的版本');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    assert.ok(idx.includes('i1'));
    assert.ok(!idx.includes('i2'), '失敗那一步的 DDL 要跟著 rollback，不能留一半');

    db.close();
    s.rm();
  });

  it('修好以後再跑，只會跑沒跑過的那一步', () => {
    const s = scratch();
    const db = s.open();
    let explode = true;
    const { list, calls } = countingList([
      tinyBase,
      { up: (db2) => db2.exec('CREATE INDEX i1 ON t(x)') },
      {
        up: (db2) => {
          db2.exec('CREATE INDEX i2 ON t(x)');
          if (explode) throw new Error('第一次會壞');
        },
      },
    ]);

    assert.throws(() => runMigrations(db, { migrations: list }), /第一次會壞/);
    assert.deepEqual(calls, [1, 2, 3]);

    explode = false;
    const r = runMigrations(db, { migrations: list });
    assert.deepEqual(calls, [1, 2, 3, 3], '只有第 3 步再跑一次，1 和 2 不該被碰');
    assert.deepEqual(r.applied, [3]);
    assert.equal(readVersion(db), 3);

    db.close();
    s.rm();
  });

  // An up() that issues its own COMMIT has already ended the transaction, so
  // the version bump after it would land unprotected and a later failure
  // could no longer roll back. Cheap to catch here, invisible if it ships.
  it('up() 自己 COMMIT 會被抓出來，而不是默默失去原子性', () => {
    const s = scratch();
    const db = s.open();
    const list = [
      { ...tinyBase, version: 1 },
      { version: 2, name: 'self commit', up: (db2) => { db2.exec('CREATE INDEX i1 ON t(x)'); db2.exec('COMMIT'); } },
    ];

    assert.throws(
      () => runMigrations(db, { migrations: list }),
      (e) => e instanceof MigrationError && e.code === 'SELF_COMMIT'
    );
    assert.equal(readVersion(db), 1, '版本沒有被蓋上去');

    db.close();
    s.rm();
  });

  // The failure this catches was real before the check existed: the runner
  // returned success, stamped the version and committed, and the step's DDL
  // then ran outside any transaction after the microtask queue drained. A
  // failure at that point would leave the book claiming a version it never
  // reached, with nothing left to re-run the step.
  it('up() 寫成 async 會被拒絕，而不是在交易外偷偷做事', async () => {
    const s = scratch();
    const db = s.open();
    // Held so the test can settle it; a real one is simply dropped on the
    // floor, which is the whole problem.
    let deferred;
    const list = [
      { ...tinyBase, version: 1 },
      {
        version: 2,
        name: 'async up',
        up(db2) {
          deferred = (async () => {
            await Promise.resolve();
            db2.exec('CREATE INDEX i_late ON t(x)');
          })();
          return deferred;
        },
      },
    ];

    assert.throws(
      () => runMigrations(db, { migrations: list }),
      (e) => e instanceof MigrationError && e.code === 'ASYNC_UP'
    );
    assert.equal(readVersion(db), 1, '版本沒有被蓋上去');

    // And this is why it has to be refused rather than tolerated: the work
    // still happens, just later and with no transaction around it. Without
    // the check the runner would already have stamped version 2 and
    // committed by now, and a failure in here would leave the book claiming
    // a version it never reached with nothing left to re-run the step.
    await deferred;
    assert.ok(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'i_late'").get(),
      'up() 的內容還是跑了，而且是在交易外面跑的'
    );

    db.close();
    s.rm();
  });

  it('跑的時候 busy_timeout 是開的，跑完會還原成原本的值', () => {
    const s = scratch();
    const db = s.open();
    let seenInside = null;
    const list = [
      { ...tinyBase, version: 1 },
      {
        version: 2,
        name: 'peek',
        up: (db2) => {
          seenInside = db2.prepare('PRAGMA busy_timeout').get().timeout;
          db2.exec('CREATE INDEX i1 ON t(x)');
        },
      },
    ];

    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 0, '預設是 0，第二個行程會當場撞鎖');
    runMigrations(db, { migrations: list });
    assert.equal(seenInside, 10000, '遷移期間要等得起另一個行程');
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 0, '連線是整個 app 共用的，不能留下副作用');

    db.close();
    s.rm();
  });

  it('另一個連線已經升好的帳本，這邊開起來不會再跑一次', () => {
    const s = scratch();
    const first = s.open();
    const second = s.open();
    const { list, calls } = countingList([tinyBase, { up: (db2) => db2.exec('CREATE INDEX i1 ON t(x)') }]);

    runMigrations(first, { migrations: list });
    assert.deepEqual(calls, [1, 2]);

    const r = runMigrations(second, { migrations: list });
    assert.deepEqual(calls, [1, 2], '同一本帳兩個連線，第二個要看見別人做完了');
    assert.deepEqual(r.applied, []);

    first.close();
    second.close();
    s.rm();
  });
});

describe('migration runner — 筆數自我檢查', () => {
  it('偷偷搬動既有表的筆數會被擋下來', () => {
    const s = scratch();
    const db = s.open();
    const list = [
      { ...tinyBase, version: 1 },
      { version: 2, name: 'sneaky insert', up: (db2) => db2.exec("INSERT INTO t (x) VALUES (1)") },
    ];

    assert.throws(
      () => runMigrations(db, { migrations: list }),
      (e) => e instanceof MigrationError && e.code === 'ROW_COUNT' && /t 0→1/.test(e.message)
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM t').get().n, 0, '整步 rollback，那筆沒進去');

    db.close();
    s.rm();
  });

  // The case a before-keys-only comparison misses entirely: the table did not
  // exist when the counts were taken, so there is nothing to compare it
  // against unless the check walks the union.
  it('新建一張表又塞資料進去，同樣被擋下來', () => {
    const s = scratch();
    const db = s.open();
    const list = [
      { ...tinyBase, version: 1 },
      {
        version: 2,
        name: 'new table with rows',
        up: (db2) => db2.exec('CREATE TABLE u (y); INSERT INTO u (y) VALUES (1), (2)'),
      },
    ];

    assert.throws(
      () => runMigrations(db, { migrations: list }),
      (e) => e instanceof MigrationError && e.code === 'ROW_COUNT' && /u —→2/.test(e.message)
    );

    db.close();
    s.rm();
  });

  it('新建一張空表沒問題', () => {
    const s = scratch();
    const db = s.open();
    const list = [
      { ...tinyBase, version: 1 },
      { version: 2, name: 'new empty table', up: (db2) => db2.exec('CREATE TABLE u (y)') },
    ];

    runMigrations(db, { migrations: list });
    assert.equal(readVersion(db), 2);

    db.close();
    s.rm();
  });

  it('真的要搬資料的步驟寫 verify()，而 verify() 自己也會擋', () => {
    const s = scratch();
    const good = s.open('good.db');
    const bad = s.open('bad.db');
    const backfill = (db2) => db2.exec("INSERT INTO t (x) VALUES (1), (2), (3)");

    runMigrations(good, {
      migrations: [
        { ...tinyBase, version: 1 },
        {
          version: 2,
          name: 'backfill',
          up: backfill,
          verify: (db2, before, after) => {
            assert.equal(before.t, 0);
            assert.equal(after.t, 3);
          },
        },
      ],
    });
    assert.equal(readVersion(good), 2, 'verify() 過了就照常升版');

    assert.throws(() => runMigrations(bad, {
      migrations: [
        { ...tinyBase, version: 1 },
        {
          version: 2,
          name: 'backfill',
          up: backfill,
          verify: (_db, _before, after) => { if (after.t !== 99) throw new Error('筆數不是我說的那個'); },
        },
      ],
    }), /筆數不是我說的那個/);
    assert.equal(readVersion(bad), 1, 'verify() 擋下來也是整步 rollback');

    good.close();
    bad.close();
    s.rm();
  });
});

describe('migration runner — 重建表', () => {
  // PRAGMA foreign_keys is a no-op while a transaction is open, so a step
  // that rewrites a table has to have it switched off from outside — and the
  // check that the rewrite did not orphan anything has to run inside, or it
  // reports on a database that is already written.
  it('rebuild 的步驟在交易外關掉外鍵，跑完再打開', () => {
    const s = scratch();
    const db = s.open();
    let insideTxn = null;
    const list = [
      { ...tinyBase, version: 1 },
      {
        version: 2,
        name: 'rebuild',
        rebuild: true,
        up: (db2) => { insideTxn = db2.prepare('PRAGMA foreign_keys').get().foreign_keys; },
      },
    ];

    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    runMigrations(db, { migrations: list });
    assert.equal(insideTxn, 0, '重建期間外鍵必須是關的');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, '跑完要還原');

    db.close();
    s.rm();
  });

  it('重建留下對不到的外鍵就整步 rollback', () => {
    const s = scratch();
    const db = s.open();
    const base = {
      version: 1,
      name: 'base',
      up: (db2) => db2.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
      `),
    };
    // Seeded outside the runner: a step that inserts rows without declaring
    // it is exactly what the self-test above refuses, and this case is about
    // the foreign keys, not about the counts.
    runMigrations(db, { migrations: [base] });
    db.exec('INSERT INTO parent (id) VALUES (1); INSERT INTO child (id, parent_id) VALUES (1, 1);');

    const list = [
      base,
      {
        version: 2,
        name: 'orphaning rebuild',
        rebuild: true,
        // With foreign keys off this is allowed and would otherwise commit.
        up: (db2) => db2.exec('DELETE FROM parent'),
        // Declared, because deleting a row is a row-count change; the point
        // is that foreign_key_check still refuses it.
        verify: () => {},
      },
    ];

    assert.throws(
      () => runMigrations(db, { migrations: list }),
      (e) => e instanceof MigrationError && e.code === 'FK_BROKEN'
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM parent').get().n, 1, 'parent 還在');
    assert.equal(readVersion(db), 1);

    db.close();
    s.rm();
  });
});

describe('遷移前的快照', () => {
  it('有東西可以弄丟的時候才拍快照，而且拍的是升級前的樣子', () => {
    const s = scratch();
    const db = s.open();
    v1BookWithRows(db, 5);

    const taken = [];
    const snapshot = (label) => {
      const dest = path.join(s.dir, `snap-${label}.db`);
      db.prepare('VACUUM INTO ?').run(dest);
      taken.push(dest);
      return dest;
    };

    const r = runMigrations(db, { snapshot });
    assert.equal(taken.length, 1, '升級一定要先備份');
    assert.equal(r.backup, taken[0], '回報備份在哪，不然使用者不知道要去哪找');

    const snap = new DatabaseSync(taken[0], { readOnly: true });
    assert.equal(snap.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '1',
      '快照必須是動手之前的狀態，不然它救不了任何東西');
    assert.equal(snap.prepare('SELECT COUNT(*) AS n FROM txns').get().n, 5);
    snap.close();

    db.close();
    s.rm();
  });

  it('全新的帳本不拍快照——空資料庫沒什麼好備份的', () => {
    const s = scratch();
    const db = s.open();
    let called = 0;
    const r = runMigrations(db, { snapshot: () => { called++; return 'x'; } });
    assert.equal(called, 0);
    assert.equal(r.backup, null);
    assert.equal(r.from, 0);

    db.close();
    s.rm();
  });

  // The whole point of the snapshot is that it is there afterwards.
  // `pruneBackups()` runs inside `snapshot()`, so with KEEP_BACKUPS=0 it used
  // to delete the file a millisecond after writing it and the runner reported
  // the path anyway — an upgrade with no safety net, claiming one.
  it('KEEP_BACKUPS=0 也不會把剛拍好的那份刪掉', () => {
    const s = scratch();
    const dbPath = path.join(s.dir, 'finance.db');
    const seed = s.open();
    v1BookWithRows(seed);
    seed.close();

    const run = spawnSync(
      process.execPath,
      ['-e', `const d = require(${JSON.stringify(DB_JS)}); process.stdout.write(JSON.stringify(d.migration))`],
      { env: { ...process.env, FINANCE_DB: dbPath, KEEP_BACKUPS: '0' }, encoding: 'utf8' }
    );
    assert.equal(run.status, 0, run.stderr);

    // db.js prints an upgrade notice on the way through, so the JSON is the
    // last line rather than the whole of stdout.
    const lines = run.stdout.split('\n').filter((l) => l.trim());
    const { backup } = JSON.parse(lines[lines.length - 1]);
    assert.ok(backup, '升級一定要回報備份');
    assert.ok(fs.existsSync(backup), `回報了 ${backup} 卻不存在，等於升級沒有安全網`);

    s.rm();
  });

  it('沒有要跑的步驟就不拍快照', () => {
    const s = scratch();
    const db = s.open();
    runMigrations(db, {});
    let called = 0;
    runMigrations(db, { snapshot: () => { called++; return 'x'; } });
    assert.equal(called, 0, '每次開 app 都多一份備份會把 KEEP_BACKUPS 沖掉');

    db.close();
    s.rm();
  });
});

describe('schema 只有一份定義', () => {
  // The duplication this design exists to remove. A CREATE TABLE creeping
  // back into db.js means fresh installs and upgrades stop being the same
  // path, and only one of them is ever exercised by the suite.
  it('db.js 不自己建表，schema 全在 migrations.js', () => {
    const src = fs.readFileSync(DB_JS, 'utf8');
    const code = src.replace(/\/\/[^\n]*/g, '');
    assert.ok(!/CREATE\s+TABLE/i.test(code), 'db.js 不該有 CREATE TABLE，新增欄位要 append 一個 migration');
    assert.ok(!/ALTER\s+TABLE/i.test(code), 'db.js 不該有 ALTER TABLE');
  });

  it('LATEST 就是清單最後一個版本', () => {
    assert.equal(LATEST, MIGRATIONS[MIGRATIONS.length - 1].version);
  });
});

describe('v2：txns.import_id 的索引', () => {
  // A row in sqlite_master only proves the statement ran. What the migration
  // is for is the query plan of the revert in api.js.
  it('回復匯入的那句 DELETE 真的會用到索引', () => {
    const s = scratch();
    const db = s.open();
    runMigrations(db, {});

    const plan = db
      .prepare('EXPLAIN QUERY PLAN DELETE FROM txns WHERE import_id = ?')
      .all()
      .map((r) => r.detail)
      .join(' | ');
    assert.match(plan, /idx_txns_import/, `沒用到索引，計畫是：${plan}`);

    db.close();
    s.rm();
  });
});

describe('v4：imports 的日期區間', () => {
  // The backfill is the only thing here that has to be right about *old*
  // books: from step 4 onwards api.js records the span itself, but every
  // ledger that already exists has imports with no range at all, and what it
  // can be reconstructed from is the rows that landed.
  it('既有的匯入紀錄從自己的交易補出區間', () => {
    const s = scratch();
    const db = s.open();
    v1BookWithRows(db, 0);
    db.prepare("INSERT INTO imports (account_id, filename, created_at) VALUES (1, 'a.csv', '2026-01-01')").run();
    db.prepare("INSERT INTO imports (account_id, filename, created_at) VALUES (1, 'b.csv', '2026-01-02')").run();
    const ins = db.prepare(
      'INSERT INTO txns (account_id, date, amount, fingerprint, import_id, created_at) VALUES (1, ?, -1, ?, ?, ?)'
    );
    ins.run('2026-03-04', 'f1', 1, '2026-01-01');
    ins.run('2026-05-06', 'f2', 1, '2026-01-01');
    ins.run('2026-07-08', 'f3', 2, '2026-01-02');

    runMigrations(db, {});

    // Spread: node:sqlite hands back null-prototype rows and deepEqual in
    // strict mode compares prototypes too.
    const got = db.prepare('SELECT id, date_from, date_to FROM imports ORDER BY id').all().map((r) => ({ ...r }));
    assert.deepEqual(got[0], { id: 1, date_from: '2026-03-04', date_to: '2026-05-06' });
    assert.deepEqual(got[1], { id: 2, date_from: '2026-07-08', date_to: '2026-07-08' });

    db.close();
    s.rm();
  });

  it('沒有留下任何交易的匯入紀錄補不出區間，就留著 null', () => {
    const s = scratch();
    const db = s.open();
    v1BookWithRows(db, 0);
    // A reverted import: the row survives, its transactions do not. Guessing
    // a range for it would claim coverage the ledger cannot show.
    db.prepare("INSERT INTO imports (account_id, filename, created_at) VALUES (1, 'gone.csv', '2026-01-01')").run();

    runMigrations(db, {});

    const got = db.prepare('SELECT date_from, date_to FROM imports').get();
    assert.equal(got.date_from, null);
    assert.equal(got.date_to, null);

    db.close();
    s.rm();
  });
});

describe('v7：帳戶的 access', () => {
  // The whole point of 'liquid' as the default: every account that already
  // exists is money you can reach this week, so a book upgrades with every
  // figure unchanged. A different default would quietly move balances out of
  // the spendable half the day PR 6 starts reading it.
  it('既有的帳戶一律補成 liquid，筆數一個都不動', () => {
    const s = scratch();
    const db = s.open();
    v1BookWithRows(db, 3);
    db.prepare("INSERT INTO accounts (institution_id, name, kind) VALUES (1, '信用卡', 'card')").run();

    runMigrations(db, {});

    const rows = db.prepare('SELECT name, access FROM accounts ORDER BY id').all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { name: '活存', access: 'liquid' },
      { name: '信用卡', access: 'liquid' },
    ]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM txns').get().n, 3);

    db.close();
    s.rm();
  });

  it('新插入的帳戶沒說的話也是 liquid', () => {
    const s = scratch();
    const db = s.open();
    runMigrations(db, {});
    db.prepare("INSERT INTO accounts (name) VALUES ('新的')").run();
    assert.equal(db.prepare('SELECT access FROM accounts').get().access, 'liquid');
    db.close();
    s.rm();
  });
});

describe('比程式新的帳本會讓 server 停下來', () => {
  // db.js prints and exits rather than throwing, for the same reason
  // index.js does it for a stranded data/finance.db: the person needs an
  // instruction, not a stack trace. Checked from a child process, the way
  // paths.test.js checks the other refusal.
  it('db.js 印出說明並以 1 結束，不是丟 stack trace', () => {
    const s = scratch();
    const dbPath = path.join(s.dir, 'finance.db');
    const seed = s.open();
    MIGRATIONS[0].up(seed);
    seed.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '99')").run();
    seed.close();

    const run = spawnSync(
      process.execPath,
      ['-e', `require(${JSON.stringify(DB_JS)})`],
      { env: { ...process.env, FINANCE_DB: dbPath }, encoding: 'utf8' }
    );

    assert.equal(run.status, 1, `應該是 exit 1，實際 ${run.status}；stderr：${run.stderr}`);
    assert.match(run.stderr, /schema v99/);
    assert.match(run.stderr, /FINANCE_PROFILE/, '要告訴使用者下一步怎麼辦');
    assert.doesNotMatch(run.stderr, /at .*migrate\.js/, '不要丟 stack trace 給使用者看');

    s.rm();
  });

  it('沒有比較新的時候，db.js 照常載入而且是最新版', () => {
    const s = scratch();
    const dbPath = path.join(s.dir, 'finance.db');
    const run = spawnSync(
      process.execPath,
      ['-e', `const d = require(${JSON.stringify(DB_JS)}); process.stdout.write(d.getMeta('schema_version'))`],
      { env: { ...process.env, FINANCE_DB: dbPath }, encoding: 'utf8' }
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, String(LATEST));
    s.rm();
  });
});
