'use strict';

// shared/handlers.js: the routes written once for the server and the demo.
// What has to hold is that a route lives in exactly one place, that the
// handlers reach rows only through the port and the clock only through what
// they are handed, and that the server's port lets no name into SQL that the
// schema did not put there.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runMigrations } = require('../server/migrate');
const { makeLedger } = require('../server/ledger');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HANDLERS = read('shared/handlers.js');

// Every `on('GET', '/api/…'` a file registers, plus the demo's one loop that
// refuses AI 健檢's routes as `['PUT', '/api/ai']`.
const routesIn = (src) => new Set([
  ...src.matchAll(/\bon\('(GET|POST|PUT|DELETE)', '(\/api\/[^']+)'/g),
  ...src.matchAll(/\['(GET|POST|PUT|DELETE)', '(\/api\/[^']+)'\]/g),
].map((m) => `${m[1]} ${m[2]}`));

const SHARED = routesIn(HANDLERS);
const SERVER = routesIn(read('server/api.js'));
const DEMO = routesIn(read('web/storage-demo.js'));

describe('共用的路由', () => {
  it('寫在 shared/handlers.js 的，server 和示範版都不再自己寫一份', () => {
    assert.ok(SHARED.size >= 9, `shared/handlers.js 只讀到 ${SHARED.size} 條`);
    assert.deepEqual([...SHARED].filter((r) => SERVER.has(r)), [], 'server/api.js 還留著');
    assert.deepEqual([...SHARED].filter((r) => DEMO.has(r)), [], 'web/storage-demo.js 還留著');
  });

  // Both sides answer the same vocabulary, shared or not: a route only one of
  // them has is a view that works on one and 404s on the other.
  it('server 和示範版答得出的路由是同一組', () => {
    const server = [...SERVER, ...SHARED].sort();
    const demo = [...DEMO, ...SHARED].sort();
    assert.deepEqual(server, demo);
  });

  // The demo's clock is injected and the server's is the machine's, so a
  // handler that read its own would answer the demo's tests with today. And a
  // handler that reached for `db` or the Map would be one side's again.
  it('handler 不自己讀時鐘，也不繞過 L 去碰資料', () => {
    for (const re of [/new Date\(/, /Date\.now\(/, /todayISO\(/, /\bdb\./, /\braw\./, /require\('\.\.\//, /require\('node:/]) {
      assert.ok(!re.test(HANDLERS), `shared/handlers.js 用到了 ${re}`);
    }
  });
});

describe('server 的 L', () => {
  function scratch() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hub-ledger-'));
    const db = new DatabaseSync(path.join(dir, 'x.db'));
    db.exec('PRAGMA foreign_keys = ON');
    runMigrations(db, {});
    const L = makeLedger({ db, getMeta: () => null, setMeta: () => {}, M: {} });
    return { db, L, rm: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
  }

  it('一列一列寫、讀、改、刪', () => {
    const { L, rm } = scratch();
    try {
      const id = L.insert('budgets', { category: '食', currency: 'TWD', amount: 100, created_at: 'x' });
      assert.equal(L.get('budgets', id).category, '食');
      assert.equal(L.update('budgets', id, { amount: 250 }), 1);
      assert.equal(L.all('budgets')[0].amount, 250);
      assert.equal(L.remove('budgets', id), 1);
      assert.equal(L.get('budgets', 999), null);
    } finally { rm(); }
  });

  // The names in a statement are the only part not bound, so they come from
  // the list and the schema or nowhere — whatever a key in a row says.
  it('不認得的表、不存在的欄位，在變成 SQL 之前就拒絕', () => {
    const { db, L, rm } = scratch();
    try {
      assert.throws(() => L.all('meta'), /不認得的表/);
      assert.throws(() => L.get('sqlite_master', 1), /不認得的表/);
      assert.throws(() => L.insert('budgets', { nope: 1 }), /沒有 nope 這一欄/);
      const evil = "category) VALUES ('x'); DROP TABLE budgets; --";
      assert.throws(() => L.insert('budgets', { [evil]: 1 }), /這一欄/);
      assert.throws(() => L.update('budgets', 1, { [evil]: 1 }), /這一欄/);
      assert.throws(() => L.update('budgets', 1, {}), /沒有要寫的欄位/);
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'budgets'").get(), 'budgets 還在');
    } finally { rm(); }
  });
});
