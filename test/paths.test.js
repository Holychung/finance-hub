'use strict';

// Run with:  node --test
//
// server/paths.js is pure path resolution with no side effects, so it can be
// evaluated in a child process against a throwaway HOME. Nothing here creates
// a directory, opens a database, or can reach the real ~/.finance-hub.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PATHS = path.join(__dirname, '..', 'server', 'paths.js');
const DB_JS = path.join(__dirname, '..', 'server', 'db.js');

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

  // The key is the person's, so every book in the directory shares one file,
  // and it sits beside the books rather than in any of them: a snapshot is a
  // copy of the database and would carry it.
  it('AI 的 key 檔在帳本旁邊，每本帳共用一個，而且跟著 FINANCE_DB 走', () => {
    const HOME = fakeHome();
    const mine = resolveUnder({ HOME, FINANCE_DB: undefined, FINANCE_PROFILE: undefined });
    const demo = resolveUnder({ HOME, FINANCE_DB: undefined, FINANCE_PROFILE: 'demo' });
    assert.equal(mine.AI_KEYS_PATH, path.join(HOME, '.finance-hub', 'ai-keys.json'));
    assert.equal(demo.AI_KEYS_PATH, mine.AI_KEYS_PATH);

    const explicit = path.join(os.tmpdir(), 'somewhere', 'else.db');
    const moved = resolveUnder({ HOME, FINANCE_DB: explicit, FINANCE_PROFILE: undefined });
    assert.equal(moved.AI_KEYS_PATH, path.join(path.dirname(explicit), 'ai-keys.json'));
    assert.ok(!fs.existsSync(path.join(HOME, '.finance-hub')), '解析路徑不該建立任何東西');

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
