'use strict';

// Run with:  node --test
//
// server/paths.js is pure path resolution with no side effects, so it can be
// evaluated in a child process against a throwaway HOME. Nothing here creates
// a directory, opens a database, or can reach the real ~/.finance-hub.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PATHS = path.join(__dirname, '..', 'server', 'paths.js');
const DB_JS = path.join(__dirname, '..', 'server', 'db.js');
const SERVER = path.join(__dirname, '..', 'server', 'index.js');
const LEGACY = path.join(__dirname, '..', 'data', 'finance.db');

const fakeHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hub-home-'));

// Evaluate paths.js under a controlled environment and hand back what it resolved.
function resolveUnder(env) {
  const clean = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete clean[k];
  const out = execFileSync(
    process.execPath,
    ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(PATHS)})))`],
    { env: clean, encoding: 'utf8' }
  );
  return JSON.parse(out);
}

// Open a book under a throwaway HOME and take some snapshots, in a child so
// the real ~/.finance-hub is unreachable and db.js's require-time work — the
// migrations and the one-time backup adoption — runs the way it would at
// startup. Returns what it printed.
function snapshotUnder(HOME, profile, times = 1, keep = '1') {
  const env = { ...process.env, HOME, KEEP_BACKUPS: keep };
  delete env.FINANCE_DB;
  if (profile) env.FINANCE_PROFILE = profile;
  else delete env.FINANCE_PROFILE;
  return execFileSync(
    process.execPath,
    ['-e', `const { snapshot } = require(${JSON.stringify(DB_JS)}); for (let i = 0; i < ${times}; i++) snapshot('test');`],
    { env, encoding: 'utf8' }
  );
}

describe('帳本位置', () => {
  it('預設走 ~/.finance-hub/finance.db，不在 repo 裡', () => {
    const HOME = fakeHome();
    const p = resolveUnder({ HOME, FINANCE_DB: undefined, FINANCE_PROFILE: undefined });

    assert.equal(p.PROFILE, 'personal');
    assert.equal(p.IS_PERSONAL, true);
    assert.equal(p.DB_PATH, path.join(HOME, '.finance-hub', 'finance.db'));
    assert.equal(p.BACKUP_DIR, path.join(HOME, '.finance-hub', 'backups', 'personal'));

    const repo = path.join(__dirname, '..');
    assert.ok(!p.DB_PATH.startsWith(repo), '帳本不能落在 checkout 裡面');
    assert.ok(!fs.existsSync(path.join(HOME, '.finance-hub')), '解析路徑不該建立任何東西');

    fs.rmSync(HOME, { recursive: true, force: true });
  });

  it('profile 換一本帳，檔名就是 profile 名', () => {
    const HOME = fakeHome();
    const p = resolveUnder({ HOME, FINANCE_DB: undefined, FINANCE_PROFILE: 'demo' });

    assert.equal(p.PROFILE, 'demo');
    assert.equal(p.IS_PERSONAL, false);
    assert.equal(p.DB_PATH, path.join(HOME, '.finance-hub', 'demo.db'));

    fs.rmSync(HOME, { recursive: true, force: true });
  });

  // Every profile shares a DATA_DIR, so a shared backups/ meant a demo's
  // imports pruned the personal ledger's snapshots — and the two sat next to
  // each other under names that say when, never which book.
  it('每本帳的備份各自一個資料夾，名字就是帳本的名字', () => {
    const HOME = fakeHome();
    const mine = resolveUnder({ HOME, FINANCE_DB: undefined, FINANCE_PROFILE: undefined });
    const demo = resolveUnder({ HOME, FINANCE_DB: undefined, FINANCE_PROFILE: 'demo' });

    assert.equal(mine.BACKUP_DIR, path.join(HOME, '.finance-hub', 'backups', 'personal'));
    assert.equal(demo.BACKUP_DIR, path.join(HOME, '.finance-hub', 'backups', 'demo'));
    assert.notEqual(mine.BACKUP_DIR, demo.BACKUP_DIR);

    fs.rmSync(HOME, { recursive: true, force: true });
  });

  // The property the split exists for, asserted by doing it rather than by
  // comparing two strings: KEEP_BACKUPS=1 and five snapshots in a demo book
  // used to leave the personal ledger with nothing.
  it('demo 的備份修剪碰不到個人帳本的備份', () => {
    const HOME = fakeHome();
    const mineDir = path.join(HOME, '.finance-hub', 'backups', 'personal');
    fs.mkdirSync(mineDir, { recursive: true });
    const mine = ['finance-20260101-000000-preimport.db', 'finance-20260102-000000-preimport.db'];
    for (const f of mine) fs.writeFileSync(path.join(mineDir, f), 'pretend ledger');

    snapshotUnder(HOME, 'demo', 5);

    for (const f of mine) {
      assert.ok(fs.existsSync(path.join(mineDir, f)), `${f} 被 demo 的修剪刪掉了`);
    }
    assert.ok(fs.existsSync(path.join(HOME, '.finance-hub', 'backups', 'demo')), 'demo 應該有自己的資料夾');

    fs.rmSync(HOME, { recursive: true, force: true });
  });

  it('FINANCE_DB 蓋過一切，備份跟著它走而不是留在 repo', () => {
    const HOME = fakeHome();
    const explicit = path.join(os.tmpdir(), 'somewhere', 'else.db');
    const p = resolveUnder({ HOME, FINANCE_DB: explicit, FINANCE_PROFILE: 'demo' });

    assert.equal(p.DB_PATH, explicit);
    assert.equal(p.DATA_DIR, path.dirname(explicit));
    // Still beside the database rather than in the repo, and still under the
    // profile's own folder — the rule is the profile's, not the path's.
    assert.equal(p.BACKUP_DIR, path.join(path.dirname(explicit), 'backups', 'demo'));

    fs.rmSync(HOME, { recursive: true, force: true });
  });

  it('profile 名稱不能是路徑', () => {
    const HOME = fakeHome();
    for (const bad of ['../../etc/passwd', 'a/b', '.', 'x'.repeat(33)]) {
      assert.throws(
        () => resolveUnder({ HOME, FINANCE_DB: undefined, FINANCE_PROFILE: bad }),
        `FINANCE_PROFILE=${JSON.stringify(bad)} 應該被拒絕`
      );
    }
    // An empty value is an unset value, not a bad one: it falls back to the
    // personal book rather than failing to start.
    const blank = resolveUnder({ HOME, FINANCE_DB: undefined, FINANCE_PROFILE: '' });
    assert.equal(blank.PROFILE, 'personal');

    fs.rmSync(HOME, { recursive: true, force: true });
  });
});

describe('搬移腳本', () => {
  const MIGRATE = path.join(__dirname, '..', 'scripts', 'migrate-data-dir.js');

  const run = (HOME) => {
    const env = { ...process.env, HOME };
    delete env.FINANCE_DB;
    delete env.FINANCE_PROFILE;
    return spawnSync(process.execPath, [MIGRATE], { env, encoding: 'utf8', timeout: 20000 });
  };

  it('複製過去、逐表核對，而且一個位元組都不動舊檔', (t) => {
    if (fs.existsSync(LEGACY)) return t.skip('這個 checkout 真的有 data/finance.db，不動它');

    const HOME = fakeHome();
    fs.mkdirSync(path.dirname(LEGACY), { recursive: true });
    try {
      // A legacy book with rows still sitting in the WAL, which is exactly the
      // case a plain file copy would silently truncate.
      const { DatabaseSync } = require('node:sqlite');
      const seed = new DatabaseSync(LEGACY);
      seed.exec('PRAGMA journal_mode = WAL');
      seed.exec(`
        CREATE TABLE institutions (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT);
        CREATE TABLE txns (id INTEGER PRIMARY KEY, amount REAL);
        CREATE TABLE holdings (id INTEGER PRIMARY KEY);
        CREATE TABLE fx_rates (date TEXT);
        CREATE TABLE balance_checks (id INTEGER PRIMARY KEY);
        CREATE TABLE imports (id INTEGER PRIMARY KEY);
        CREATE TABLE mappings (id INTEGER PRIMARY KEY);
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO institutions (name) VALUES ('玉山銀行'), ('Bank of America');
        INSERT INTO accounts (name) VALUES ('玉山活存'), ('Adv Plus Banking');
        INSERT INTO meta VALUES ('schema_version', '1');
      `);
      for (let i = 0; i < 250; i++) seed.prepare('INSERT INTO txns (amount) VALUES (?)').run(i * 1.5);
      seed.close();

      const sizeBefore = fs.statSync(LEGACY).size;
      const res = run(HOME);
      assert.equal(res.status, 0, `搬移應該成功：${res.stderr}`);

      const dest = path.join(HOME, '.finance-hub', 'finance.db');
      assert.ok(fs.existsSync(dest), '新位置要有檔案');

      const { DatabaseSync: DS } = require('node:sqlite');
      const out = new DS(dest, { readOnly: true });
      assert.equal(out.prepare('SELECT COUNT(*) AS n FROM txns').get().n, 250, 'WAL 裡的 250 筆都要在');
      assert.equal(out.prepare('SELECT COUNT(*) AS n FROM institutions').get().n, 2);
      out.close();

      assert.ok(fs.existsSync(LEGACY), '舊檔必須還在');
      assert.equal(fs.statSync(LEGACY).size, sizeBefore, '舊檔不能被改動');

      // Running it again must not overwrite the book that is now in use.
      const again = run(HOME);
      assert.equal(again.status, 1, '第二次要拒絕');
      assert.match(again.stderr, /不會覆蓋/);
    } finally {
      for (const s of ['', '-wal', '-shm']) fs.rmSync(LEGACY + s, { force: true });
      fs.rmSync(path.dirname(LEGACY), { recursive: true, force: true });
      fs.rmSync(HOME, { recursive: true, force: true });
    }
  });
});

describe('舊帳本還留在 repo 時', () => {
  it('偵測得到，而且拒絕啟動而不是開一本空的', (t) => {
    // Never fabricate a legacy file over a real one.
    if (fs.existsSync(LEGACY)) return t.skip('這個 checkout 真的有 data/finance.db，不動它');

    const HOME = fakeHome();
    fs.mkdirSync(path.dirname(LEGACY), { recursive: true });
    fs.writeFileSync(LEGACY, '');
    try {
      const p = resolveUnder({ HOME, FINANCE_DB: undefined, FINANCE_PROFILE: undefined });
      assert.equal(p.strandedLegacyDb, LEGACY, '舊帳本應該被認出來');

      const env = { ...process.env, HOME, PORT: '0' };
      delete env.FINANCE_DB;
      delete env.FINANCE_PROFILE;
      const run = spawnSync(process.execPath, [SERVER], { env, encoding: 'utf8', timeout: 15000 });

      assert.equal(run.status, 1, '應該直接結束，而不是把空帳本開起來');
      assert.match(run.stderr, /migrate-data-dir/, '訊息要指出怎麼搬');
      assert.ok(
        !fs.existsSync(path.join(HOME, '.finance-hub', 'finance.db')),
        '拒絕啟動時不可以已經建好新的空帳本'
      );

      // An explicit path means the caller knows which book it wants.
      const chosen = path.join(HOME, 'chosen.db');
      const p2 = resolveUnder({ HOME, FINANCE_DB: chosen, FINANCE_PROFILE: undefined });
      assert.equal(p2.strandedLegacyDb, null, 'FINANCE_DB 指定時不該擋');
    } finally {
      fs.rmSync(LEGACY, { force: true });
      fs.rmSync(path.dirname(LEGACY), { recursive: true, force: true });
      fs.rmSync(HOME, { recursive: true, force: true });
    }
  });
});
