'use strict';

// Run with:  node --test
//
// The storage seam. `web/storage-http.js` is the only thing in the frontend
// that knows the ledger is behind HTTP, and these are the checks that keep it
// that way — a second `fetch()` or a hand-written `href="/api/..."` does not
// break anything today, it just quietly puts a view back on the wrong side of
// the line, and the next adapter finds out one dead button at a time.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'web');
const FILES = fs.readdirSync(WEB)
  .filter((f) => f.endsWith('.js'))
  .map((name) => ({ name, src: fs.readFileSync(path.join(WEB, name), 'utf8') }));

// Comments talk about `fetch` and about `/api/export` constantly; only code
// counts.
const code = (src) => src.replace(/^\s*\/\/.*$/gm, '');

describe('儲存層的縫', () => {
  it('整個前端只有 storage-http.js 會 fetch', () => {
    const offenders = FILES
      .filter((f) => f.name !== 'storage-http.js' && /\bfetch\s*\(/.test(code(f.src)))
      .map((f) => f.name);
    assert.deepEqual(offenders, [],
      `${offenders.join('、')} 直接 fetch，應該走 storage`);
  });

  // The six that started this: `<a href="/api/export/...">` in three views.
  // The path string at the call site is fine — it says *what* to export. An
  // anchor built by hand is not, because it says *how*, and that is the part
  // a different backend changes.
  it('沒有任何 view 自己寫 <a href="/api/...">', () => {
    const offenders = FILES
      .filter((f) => /href\s*=\s*["'`]\/api\//.test(code(f.src)))
      .map((f) => f.name);
    assert.deepEqual(offenders, [],
      `${offenders.join('、')} 自己組了 /api/ 連結，應該用 exportLink()`);
  });

  it('api / post / put / del 全部轉給 storage，自己不做事', () => {
    const core = code(FILES.find((f) => f.name === 'core.js').src);
    for (const verb of ['api', 'post', 'put', 'del']) {
      const m = new RegExp(`const ${verb} = \\([^)]*\\) => storage\\.`).test(core);
      assert.ok(m, `core.js 的 ${verb} 沒有轉給 storage`);
    }
  });
});

// Evaluated the way the browser does — classic scripts, in index.html's own
// order, into one scope — because what is being pinned is the markup a view
// actually gets, and because `storage` is now the picker's, not any one
// adapter's. Reading the order out of index.html rather than listing files
// here means a new script cannot be left out of this harness by accident.
//
// `hostname` decides which adapter the picker takes, so it is the input this
// function exists to vary.
function browserScope({ hostname = '127.0.0.1', search = '' } = {}) {
  const ROOT = path.join(__dirname, '..');
  const node = () => {
    const n = {
      addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
      setAttribute() {}, removeAttribute() {}, getAttribute: () => null, hasAttribute: () => false,
      closest: () => null, focus() {}, click() {}, scrollTo() {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      style: {}, dataset: {}, children: [], childNodes: [],
      hidden: false, value: '', textContent: '', innerHTML: '', scrollTop: 0, offsetTop: 0,
    };
    n.querySelector = () => node();
    n.querySelectorAll = () => [];
    return n;
  };
  const ctx = vm.createContext({
    TextEncoder, TextDecoder, console, setTimeout, clearTimeout, setInterval, clearInterval,
    document: Object.assign(node(), { createElement: () => node(), body: node(), documentElement: node() }),
    window: { addEventListener() {}, removeEventListener() {}, scrollTo() {}, scrollY: 0 },
    location: { hostname, search, protocol: 'http:', pathname: '/', origin: `http://${hostname}`, href: `http://${hostname}/` },
    history: { pushState() {}, replaceState() {} },
    fetch: () => { throw new Error('a test must not reach the network'); },
    requestAnimationFrame: (f) => f(),
    URL, URLSearchParams,
  });
  ctx.globalThis = ctx;

  const doc = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const order = [...doc.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map((m) => m[1].replace(/^\//, ''))
    // core.js is where the markup helpers live and is the last file these
    // tests need; the views after it only register themselves.
    .filter((f) => !f.startsWith('view-') && f !== 'app.js');
  for (const f of order) {
    const p = f.startsWith('shared/') ? path.join(ROOT, f) : path.join(ROOT, 'web', f);
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

describe('挑哪一個儲存實作', () => {
  const ctx = browserScope();
  // `available` is a Map in the real thing; the pure function only asks it
  // `.has`, so a Set stands in for the table below.
  const call = (o) => {
    ctx.CASE = { ...o, available: new Set(o.available || ['http', 'demo']) };
    return vm.runInContext('chooseStorage(CASE)', ctx);
  };

  it('loopback 走 http，其他 origin 走 demo', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      assert.equal(call({ hostname: h, protocol: 'http:', search: '' }), 'http', h);
    }
    for (const h of ['harry.github.io', 'finance.example.com', '192.168.1.20']) {
      assert.equal(call({ hostname: h, protocol: 'https:', search: '' }), 'demo', h);
    }
  });

  it('?storage= 可以明講，因為 demo 本來就得在 loopback 上走一遍才敢信', () => {
    assert.equal(call({ hostname: '127.0.0.1', protocol: 'http:', search: '?storage=demo' }), 'demo');
    assert.equal(call({ hostname: 'harry.github.io', protocol: 'https:', search: '?storage=http' }), 'http');
  });

  it('?storage= 寫了看不懂的值就停，不當成沒寫', () => {
    assert.throws(() => call({ hostname: '127.0.0.1', protocol: 'http:', search: '?storage=sqlite' }),
      /不是 http 也不是 demo/);
  });

  it('file:// 直接說清楚為什麼開不起來', () => {
    assert.throws(() => call({ hostname: '', protocol: 'file:', search: '' }), /file:\/\//);
  });

  it('選到的實作沒載入就停，不改選另一個', () => {
    assert.throws(() => call({ hostname: '127.0.0.1', protocol: 'http:', search: '', available: ['demo'] }),
      /沒有載入/);
    assert.throws(() => call({ hostname: 'harry.github.io', protocol: 'https:', search: '', available: ['http'] }),
      /沒有載入/);
  });

  // The actual point of the file, and the thing a comment cannot enforce.
  it('沒有執行期偵測：它不會 ping 伺服器再決定', () => {
    const src = FILES.find((f) => f.name === 'storage.js').src;
    const body = code(src);
    assert.ok(!/\bfetch\s*\(/.test(body),
      'storage.js 不能自己戳伺服器——伺服器沒回應就該是伺服器沒回應，不是變出第二本帳');
    assert.equal((body.match(/\bcatch\s*[({]/g) || []).length, 1,
      '只有挑選那一個 try 的 catch，而且它結尾會把整頁換掉');
  });

  it('在非 loopback 的 origin 上，真的拿到 demo adapter', () => {
    const web = browserScope({ hostname: 'harry.github.io' });
    assert.equal(vm.runInContext('storage.name', web), 'demo');
    assert.equal(vm.runInContext('typeof storage.exportName', web), 'function');
  });

  // And it opens on the seeded book, not an empty one. A demo whose every
  // view shows an empty state demonstrates the empty states.
  it('demo 一開起來就有東西，而且說得出自己是示範資料', async () => {
    const web = browserScope({ hostname: 'harry.github.io' });
    const accounts = await vm.runInContext('storage.get("/api/accounts")', web);
    assert.ok(accounts.length >= 5, `只有 ${accounts.length} 個帳戶`);
    assert.ok(accounts.some((a) => a.balance < 0), '要有負債，不然負數那半永遠不會出現');
    assert.ok(new Set(accounts.map((a) => a.currency)).size >= 2, '要有兩種幣別');

    const nw = await vm.runInContext('storage.get("/api/overview")', web);
    assert.ok(nw.counts.txns > 300, `只有 ${nw.counts.txns} 筆交易，畫不出十八個月的線`);
    assert.ok(nw.counts.unpaired_candidates > 0, '配對審核要有東西可審');
    assert.ok(Object.keys(nw.series).length >= 2);

    const settings = await vm.runInContext('storage.get("/api/settings")', web);
    assert.equal(settings.is_personal, false, '側邊欄徽章靠這個變色');
    assert.equal(settings.db_path, null, '沒有檔案就不要編一個路徑出來');
  });

  it('重設把改過的東西丟掉，回到同一本種子', async () => {
    const web = browserScope({ hostname: 'harry.github.io' });
    const before = (await vm.runInContext('storage.get("/api/txns?limit=1")', web)).total;
    await vm.runInContext('storage.post("/api/txns", { account_id: 1, date: "2026-09-21", amount: -1, description: "X" })', web);
    assert.equal((await vm.runInContext('storage.get("/api/txns?limit=1")', web)).total, before + 1);
    vm.runInContext('resetDemo()', web);
    assert.equal((await vm.runInContext('storage.get("/api/txns?limit=1")', web)).total, before);
  });

  it('在 loopback 上還是 http，載入測試因此一直在測真正那條路', () => {
    assert.equal(vm.runInContext('storage.name', browserScope()), 'http');
  });
});

describe('HTTP adapter 就是原本那段程式', () => {
  const ctx = browserScope();

  it('契約上該有的都在', () => {
    for (const k of ['get', 'post', 'put', 'del', 'exportHref']) {
      assert.equal(vm.runInContext(`typeof storage.${k}`, ctx), 'function', `storage.${k} 不見了`);
    }
    assert.equal(vm.runInContext('storage.name', ctx), 'http');
  });

  it('exportHref 對 HTTP 來說就是原路徑', () => {
    assert.equal(vm.runInContext("storage.exportHref('/api/export/csv?type=txns')", ctx),
      '/api/export/csv?type=txns');
  });

  it('get 是 async，即使答得出來也不能同步回答', () => {
    // A promise that resolves synchronously in one adapter and not the other
    // is the kind of difference that surfaces as a render-order bug.
    assert.equal(vm.runInContext('storage.get.constructor.name', ctx), 'AsyncFunction');
  });

  // Byte for byte what the three views used to write out by hand. If this
  // ever has to change, it changes once — which was the point.
  it('exportLink 產生的 markup 跟改之前一模一樣', () => {
    assert.equal(
      vm.runInContext("String(exportLink('匯出 CSV', '/api/export/csv?type=txns'))", ctx),
      '<a class="btn" href="/api/export/csv?type=txns">匯出 CSV</a>'
    );
    assert.equal(
      vm.runInContext("String(exportLink('匯出 CSV', '/api/export/csv?type=holdings'))", ctx),
      '<a class="btn" href="/api/export/csv?type=holdings">匯出 CSV</a>'
    );
    assert.equal(
      vm.runInContext("String(exportLink('完整 JSON 備份', '/api/export/json', 'finance_backup.json'))", ctx),
      '<a class="btn" href="/api/export/json" download="finance_backup.json">完整 JSON 備份</a>'
    );
  });

  // The overview's page head holds small controls — the segmented switch and
  // 重新整理 — so its export link is the small size too, and nothing else about
  // the markup changes.
  it('exportLink 可以是小尺寸，給控制項都是小尺寸的頁首用', () => {
    assert.equal(
      vm.runInContext("String(exportLink('匯出全覽', '/api/export/overview', null, 'sm'))", ctx),
      '<a class="btn sm" href="/api/export/overview">匯出全覽</a>'
    );
  });

  it('exportLink 的標籤照樣逃脫', () => {
    assert.equal(
      vm.runInContext("String(exportLink('<img src=x onerror=alert(1)>', '/api/export/json', 'a.json'))", ctx),
      '<a class="btn" href="/api/export/json" download="a.json">&lt;img src=x onerror=alert(1)&gt;</a>'
    );
  });

  // The download attribute is what makes app.js's click handler leave the
  // link alone, and Content-Disposition is what names the file. Dropping it
  // from the JSON backup would save it as `json`.
  it('只有 JSON 備份帶 download 屬性，CSV 靠伺服器的 Content-Disposition', () => {
    const csv = vm.runInContext("String(exportLink('x', '/api/export/csv?type=txns'))", ctx);
    assert.ok(!csv.includes('download='), 'CSV 匯出不該自己指定檔名，日期戳記在伺服器那邊');
  });
});
