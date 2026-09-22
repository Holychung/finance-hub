'use strict';

// Unit tests for the escaping template tag, plus static guards that the
// frontend actually uses it everywhere.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { html, raw, fmt, Html } = require('../web/html.js');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
// shared/ is loaded by the browser too, so every guard below has to cover it.
// Left out, the escaping rules and the dependency graph would silently stop
// applying to the moment domain logic moved out of web/.
const SHARED = path.join(ROOT, 'shared');

// index.html names web/ files from the root and shared/ files with a
// `/shared/` prefix, which is also how the server routes them.
const fileFor = (src) => (src.startsWith('shared/') ? path.join(ROOT, src) : path.join(WEB, src));

// Every frontend file except html.js, which is the escaping library itself:
// mount() owns the one sanctioned innerHTML and esc() is its implementation,
// so the guards below would flag the very code they exist to enforce.
//
// Read from the directories rather than from a list, so a new view file is
// covered the moment it is created. A list would have to be remembered, and
// the whole point of these guards is that nothing has to be.
const read = (dir, prefix) => fs.readdirSync(dir)
  .filter((f) => f.endsWith('.js') && f !== 'html.js')
  .map((f) => ({ name: `${prefix}${f}`, src: fs.readFileSync(path.join(dir, f), 'utf8') }));

const FILES = [...read(WEB, ''), ...read(SHARED, 'shared/')]
  .sort((a, b) => a.name.localeCompare(b.name));

// One string for the scans that look for a function wherever it now lives.
const SRC = FILES.map((f) => f.src).join('\n');

// Lines matching `pattern` that carry no comment on the line or just above it.
// The escape hatches are allowed; using one silently is not. Reported as
// file:line, because the file is no longer implied.
function undocumented(pattern) {
  return FILES.flatMap(({ name, src }) => {
    const lines = src.split('\n');
    return lines.reduce((hits, line, i) => {
      if (!pattern.test(line)) return hits;
      const explained = line.includes('//') || /^\s*(\/\/|\*)/.test(lines[i - 1] || '');
      return explained ? hits : [...hits, `${name}:${i + 1}`];
    }, []);
  });
}

// Anything declared at column 0 in a classic script shares one global scope
// with every other file, so two files declaring the same name is a
// SyntaxError at load — the whole app, blank.
const topLevelDecls = ({ name, src }) =>
  [...src.matchAll(/^(?:const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => ({ decl: m[1], file: name }));

describe('html`` 逃脫', () => {
  it('預設逃脫插入值', () => {
    const evil = '<img src=x onerror=alert(1)>';
    assert.equal(String(html`<p>${evil}</p>`),
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('逃脫引號，屬性位置也安全', () => {
    const evil = '" onmouseover="alert(1)';
    assert.equal(String(html`<a title="${evil}">x</a>`),
      '<a title="&quot; onmouseover=&quot;alert(1)">x</a>');
  });

  it('逃脫單引號與 &', () => {
    assert.equal(String(html`${`it's & <b>`}`), 'it&#39;s &amp; &lt;b&gt;');
  });

  it('巢狀模板不被二次逃脫', () => {
    const inner = html`<b>${'<i>'}</b>`;
    assert.equal(String(html`<p>${inner}</p>`), '<p><b>&lt;i&gt;</b></p>');
  });

  it('陣列逐項處理，不需要 join', () => {
    const rows = ['a', '<b>'].map((v) => html`<li>${v}</li>`);
    assert.equal(String(html`<ul>${rows}</ul>`), '<ul><li>a</li><li>&lt;b&gt;</li></ul>');
  });

  it('null / undefined / false 渲染成空字串，便於條件插入', () => {
    assert.equal(String(html`[${null}${undefined}${false}]`), '[]');
  });

  it('0 與空字串照常輸出', () => {
    assert.equal(String(html`[${0}][${''}]`), '[0][]');
  });

  it('數字不被破壞', () => {
    assert.equal(String(html`${-1234.56}`), '-1234.56');
  });

  it('raw() 是唯一的逃生門', () => {
    assert.equal(String(html`${raw('<hr>')}`), '<hr>');
    assert.ok(raw('<hr>') instanceof Html);
  });

  it('殘留的 .join(\'\') 會降級成可見的跳脫文字，而不是注入', () => {
    // The fail-safe property: a forgotten join produces a plain string, which
    // is then escaped, so the bug is visible instead of exploitable.
    const joined = ['<b>x</b>'].map((v) => html`${raw(v)}`).join('');
    assert.equal(typeof joined, 'string');
    assert.equal(String(html`<p>${joined}</p>`), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });

  it('fmt 把模板攤平成字串', () => {
    assert.equal(fmt(html`<i>${'&'}</i>`), '<i>&amp;</i>');
  });
});

describe('前端靜態防線', () => {
  it('前端沒有任何檔案直接指派 innerHTML，一律走 mount()', () => {
    const direct = FILES.flatMap(({ name, src }) =>
      (src.match(/\.innerHTML\s*=/g) || []).map(() => name));
    assert.deepEqual(direct, [],
      `${direct.join('、')} 直接指派 innerHTML，應改用 mount(el, html\`…\`)`);
  });

  it('前端沒有未經說明的 .join(\'\')', () => {
    // html`` takes arrays directly. A leftover join collapses templates into a
    // plain string that then gets escaped, so it shows up as visible tags.
    // Joining non-markup (SVG path numbers) is fine when it says so.
    assert.deepEqual(undocumented(/\.join\(''\)/), [],
      "有 .join('') 沒有說明為什麼不是在組 markup");
  });

  it('前端不再需要手動 esc()', () => {
    const escCalls = FILES.flatMap(({ name, src }) =>
      (src.match(/\besc\(/g) || []).map(() => name));
    assert.deepEqual(escCalls, [],
      `${escCalls.join('、')} 還在呼叫 esc()，html\`\` 已預設逃脫`);
  });

  // The split into per-view files bought readability at the price of a new way
  // to break the app: these are classic scripts sharing one global scope, so a
  // name declared at column 0 in two files throws on load and the page never
  // renders. Nothing else would catch it — each file parses fine alone.
  //
  // The browser is the only thing that really concatenates them, so do what it
  // does: compile the files in index.html's order as one script. This is the
  // ground truth; the regex test below only exists to name both culprits,
  // which the SyntaxError does not.
  it('照 index.html 的順序串起來能編譯（瀏覽器實際看到的東西）', () => {
    const doc = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    // The src is root-absolute so it resolves the same from /account/7 as
    // from /overview. What these checks care about is which file and in what
    // order, so the leading slash comes off here rather than in a dozen
    // string comparisons below.
    const order = [...doc.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1].replace(/^\//, ''));
    const joined = order
      .map((f) => fs.readFileSync(fileFor(f), 'utf8'))
      .join('\n;\n');
    // A duplicate top-level declaration is a compile-time error, so this
    // alone catches the clash the test exists for. Running them is the next
    // test; compiling first means a syntax error is reported as a syntax
    // error rather than as whatever the DOM stub trips over afterwards.
    assert.doesNotThrow(() => new vm.Script(joined, { filename: 'web/*.js' }),
      '前端檔案串在一起編不過，瀏覽器會整頁空白');
  });

  // Compiling proves the files parse together. It does not prove they *run*
  // together, and the difference is every name one file expects another to
  // have put on the global: `LIABILITY_KINDS` and `round2` come from
  // `shared/money.js`, `html` from `html.js`, `storage` from
  // `storage-http.js`. Delete one and the page throws on load with one line
  // in the console, which is the failure this project keeps rediscovering.
  //
  // So load them for real, in index.html's order, against a DOM stubbed just
  // far enough to get through the top-level wiring. Nothing is rendered and
  // nothing is asserted about behaviour — the claim is only that the app
  // gets as far as having registered its views.
  it('照同樣的順序真的載得起來，而且九個 view 都註冊了', () => {
    const doc = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    const order = [...doc.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1].replace(/^\//, ''));

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
      location: { pathname: '/', origin: 'http://127.0.0.1', href: 'http://127.0.0.1/', search: '' },
      history: { pushState() {}, replaceState() {} },
      // render() runs at the bottom of app.js and will reach for data. There
      // is nothing to serve it and nothing here is waiting on the result; the
      // rejection is the point at which loading has already succeeded.
      fetch: () => Promise.reject(new Error('the loader test does not serve data')),
      requestAnimationFrame: (f) => f(),
      URL, URLSearchParams,
    });
    ctx.globalThis = ctx;

    for (const f of order) {
      assert.doesNotThrow(
        () => vm.runInContext(fs.readFileSync(fileFor(f), 'utf8'), ctx, { filename: f }),
        `${f} 載入時就炸了，瀏覽器會停在這裡`
      );
    }

    // The names one file puts on the global for the next one to find.
    assert.equal(vm.runInContext('typeof html', ctx), 'function');
    assert.equal(vm.runInContext('typeof storage', ctx), 'object');
    // Behaviour, not just presence: `round2` reaches the views from a shared
    // module now that core.js has no copy, and a global that exists but
    // rounds differently is worse than one that is missing.
    assert.equal(vm.runInContext('round2(1.005)', ctx), 1.01, 'round2 沒有從 shared/ 掛上來');
    assert.equal(vm.runInContext('LIABILITY_KINDS.has("card")', ctx), true, 'LIABILITY_KINDS 來自 shared/money.js');
    assert.equal(vm.runInContext('typeof fingerprint', ctx), 'function', 'shared/csv.js 也掛上來了');
    // The demo book is built in the browser, not shipped as JSON, so both
    // halves of shared/demo-seed.js have to be reachable from a view.
    assert.equal(vm.runInContext('typeof buildDemoBook', ctx), 'function');
    assert.equal(vm.runInContext('typeof buildDemoStatement', ctx), 'function',
      'view-import.js 的範例對帳單按鈕會叫它');

    // app.js is last because it calls render(), which needs every view file
    // to have registered itself by then.
    const registered = vm.runInContext('Object.keys(views).sort()', ctx);
    assert.deepEqual([...registered].sort(),
      ['account', 'accounts', 'coverage', 'holdings', 'import', 'overview', 'settings', 'spending', 'transactions'],
      '載入後 views 裡缺了東西，路由會默默退回總覽');
  });

  it('沒有兩個檔案宣告同一個頂層名稱', () => {
    const seen = new Map();
    const clashes = [];
    for (const f of FILES) {
      for (const { decl, file } of topLevelDecls(f)) {
        if (seen.has(decl)) clashes.push(`${decl}（${seen.get(decl)} 與 ${file}）`);
        else seen.set(decl, file);
      }
    }
    assert.deepEqual(clashes, [],
      `這些名稱重複宣告，載入時會整個 app 掛掉：${clashes.join('、')}`);
  });

  it('raw() 的每一次使用都有註解說明', () => {
    assert.deepEqual(undocumented(/\braw\(/), [], 'raw() 沒有說明為什麼安全');
  });

  // There used to be a test here holding two copies of LIABILITY_KINDS in
  // step — one in `web/core.js`, one on the server — because the browser
  // could not import from `server/money.js`. It can import from `shared/`, so
  // the copy is gone and the only thing left to check is that nobody declares
  // a second one. It is derived in `shared/kinds.js` now, from the `liability`
  // flag on each kind, and re-exported by `shared/money.js` so every caller
  // that already read it from there still works.
  it('LIABILITY_KINDS 只有一份，就是 shared/kinds.js 那個', () => {
    const local = FILES
      .filter((f) => f.name !== 'shared/kinds.js')
      .filter((f) => /^\s*(?:const|let|var)\s+LIABILITY_KINDS\b/m.test(f.src));
    assert.deepEqual(local.map((f) => f.name), [],
      `${local.map((f) => f.name).join('、')} 又自己宣告了一份負債類型清單`);
    assert.match(SRC, /\bLIABILITY_KINDS\.has\(/,
      '前端應該用 shared/ 匯出的 Set');
  });

  // The whole point of shared/kinds.js: a seventh copy of the account kinds
  // would look like an array literal with 'brokerage' in it, and nothing else
  // would notice — the account would simply render with a raw English key.
  it('帳戶類型清單只有一份，其他地方不准再寫一個字面陣列', () => {
    const literal = /\[\s*'(?:cash|brokerage|card|loan|other)'(?:\s*,\s*'(?:cash|brokerage|card|loan|other)'\s*)+\]/;
    const copies = FILES
      .filter((f) => f.name !== 'shared/kinds.js')
      .filter((f) => literal.test(f.src));
    assert.deepEqual(copies.map((f) => f.name), [],
      `${copies.map((f) => f.name).join('、')} 又寫了一份帳戶類型清單，用 KIND_ORDER`);
  });

  // There used to be three copies of round2 — money.js, csv.js and
  // spending.js — and a test here pinning their bodies to be identical,
  // because all three assign the name to the global and **whichever loads
  // last wins**. Harmless while they agreed; an arithmetic difference nobody
  // would look for if they ever stopped. One definition now, in
  // shared/currency.js, so there is nothing left to keep in step.
  it('round2 只有一份，就是 shared/currency.js 那個', () => {
    const copies = FILES
      .filter((f) => f.name !== 'shared/currency.js')
      .filter((f) => /^\s*(?:const|let|var)\s+round2\s*=/m.test(f.src));
    assert.deepEqual(copies.map((f) => f.name), [],
      `${copies.map((f) => f.name).join('、')} 又自己宣告了一份 round2`);
  });

  // The other half of the same idea: two decimal places is a property of a
  // currency, not of money, and a hardcoded 100 is that decision written
  // where nobody will find it again. `toFixed(2)` in the fingerprint is the
  // one exception and is frozen by the dedup contract.
  it('沒有人自己寫死兩位小數的四捨五入', () => {
    const offenders = FILES
      .filter((f) => f.name !== 'shared/currency.js')
      .filter((f) => /Math\.round\([^)]*\*\s*100\s*\)\s*\/\s*100/.test(f.src));
    assert.deepEqual(offenders.map((f) => f.name), [],
      `${offenders.map((f) => f.name).join('、')} 自己寫死了兩位小數，用 roundTo`);
  });

  // renderPreview reads imp.preview and imp.mapping together, and views.import
  // ends by calling it whenever a preview is held. Clearing one without the
  // other throws *inside* the view, so render() swaps the page for the error
  // screen — which removes #imp-result, so the next mount fails on a missing
  // element and reports that instead of the real fault. The masking is what
  // makes this worth a test rather than a comment.
  it('imp.mapping 和 imp.preview 一起清掉，不留半清狀態', () => {
    const offenders = FILES.flatMap(({ name, src }) => {
      const lines = src.split('\n');
      return lines.reduce((hits, line, i) => {
        if (!/imp\.mapping\s*=\s*null/.test(line)) return hits;
        const near = lines.slice(Math.max(0, i - 6), i + 7).join('\n');
        return /imp\.preview\s*=\s*null/.test(near) ? hits : [...hits, `${name}:${i + 1}`];
      }, []);
    });
    assert.deepEqual(offenders, [],
      `${offenders.join('、')} 把 imp.mapping 清成 null 卻沒一起清 imp.preview`);
  });

  // money() and signed() default to TWD, which is right for the overview —
  // everything there is already converted to the base currency. The import
  // preview is the opposite: those rows are in the account's own currency and
  // nothing converts them. A USD statement previewed as "NT$3,761" reads as a
  // number thirty times smaller than it is, with the cents rounded away.
  // Listed one by one rather than swept, because the rule is not "always pass a
  // currency": the overview is right to take the default, everything there
  // having already been converted to the base currency. These two render raw
  // account amounts, which nothing converts.
  for (const fn of ['function renderPreview()', 'async function renderSidebarAccounts()']) {
    it(`${fn.replace(/^(async )?function /, '').replace('()', '')} 的每個金額都帶幣別，不吃 TWD 預設`, () => {
      const start = SRC.indexOf(fn);
      assert.ok(start !== -1, `找不到 ${fn}`);
      const end = SRC.indexOf('\n}', start);
      const body = SRC.slice(start, end === -1 ? undefined : end);
      const bare = [...body.matchAll(/\b(?:signed|money)\(([^)]*)\)/g)]
        .map((m) => m[1])
        .filter((args) => !args.includes(','));
      assert.deepEqual(bare, [], `這些金額沒帶幣別，會用 TWD 顯示：${bare.join(' / ')}`);
    });
  }

  it('renderPreview 先擋掉空的 mapping 再去讀它的欄位', () => {
    const start = SRC.indexOf('function renderPreview()');
    assert.ok(start !== -1, '找不到 renderPreview');
    const body = SRC.slice(start, start + 4000);
    const guard = body.indexOf('!imp.mapping');
    const firstUse = body.search(/\bm\.[A-Za-z]/);
    assert.ok(guard !== -1, 'renderPreview 要先確認 imp.mapping 還在');
    // -1 means the function never dereferences the mapping, which needs no
    // guard at all; anything else has to come after one.
    assert.ok(firstUse === -1 || guard < firstUse, '守衛要排在第一次讀 m.* 之前');
  });

  // The server answers when someone refreshes on a route, so it has to know
  // which paths are routes. That list lives in two files and a comment asking
  // the next person to keep them in step is not a mechanism.
  it('伺服器的 APP_ROUTES 跟 app.js 的 views 一致', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const declared = /const APP_ROUTES = new Set\(\[([\s\S]*?)\]\)/.exec(server);
    assert.ok(declared, '找不到 APP_ROUTES');
    const routes = declared[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
    // Each view registers itself in its own view-*.js now, so this has to scan
    // every file — against app.js alone it would find nothing and fail while
    // naming the wrong cause.
    const views = [...SRC.matchAll(/^views\.([a-zA-Z]+)\s*=/gm)].map((m) => m[1]).sort();
    assert.deepEqual(routes, views, 'server/index.js 的 APP_ROUTES 跟 web/ 的 views 對不上');
  });

  it('前端連結都是真實路徑，沒有殘留的 #/', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
    const leftover = [...(doc + SRC).matchAll(/href="(#\/[^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(leftover, [], `還有 hash 連結：${leftover.join(' / ')}`);
  });

  // Nothing here diffs, so every re-render replaces the focused node. Without
  // this pairing, typing in the transactions search and pressing Enter drops
  // the caret and you have to click back in to change a letter.
  it('每個會整塊重畫的路徑都先存後還原焦點與捲動', () => {
    // render() is in app.js and runPreview() in view-import.js, and captureUi
    // /restoreUi in core.js because both callers need them — so this pairing
    // now spans three files and only the concatenation can see it.
    for (const fn of ['async function render()', 'async function runPreview()']) {
      const start = SRC.indexOf(fn);
      assert.ok(start !== -1, `找不到 ${fn}`);
      const end = SRC.indexOf('\n}', start);
      const body = SRC.slice(start, end === -1 ? undefined : end);
      const capture = body.indexOf('captureUi()');
      const restore = body.indexOf('restoreUi(');
      assert.ok(capture !== -1, `${fn} 沒有存下焦點`);
      assert.ok(restore !== -1, `${fn} 沒有還原焦點`);
      assert.ok(capture < restore, `${fn} 的存要在還原之前`);
    }
  });

  // There is no bundler, so index.html *is* the dependency graph. These three
  // are the ways that graph can be wrong, and all three fail as a blank page
  // with one line in the console rather than as anything a test would notice.
  describe('index.html 的載入順序就是相依圖', () => {
    const doc = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
    const loaded = [...doc.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1].replace(/^\//, ''));

    it('html.js 第一個，app.js 最後一個', () => {
      assert.equal(loaded[0], 'html.js', 'html.js 要最先載入，其他檔案都拿它組 markup');
      assert.equal(loaded.at(-1), 'app.js', 'app.js 要最後載入，它在底部直接呼叫 render()');
    });

    // A view file nobody loads is not a broken view — it is a view that
    // silently does not exist, and the router quietly falls back to overview.
    it('web/ 和 shared/ 底下每個 .js 都被載入', () => {
      const onDisk = [
        ...fs.readdirSync(WEB).filter((f) => f.endsWith('.js')),
        ...fs.readdirSync(SHARED).filter((f) => f.endsWith('.js')).map((f) => `shared/${f}`),
      ].sort();
      assert.deepEqual([...loaded].sort(), onDisk,
        'index.html 載入的檔案跟 web/ 與 shared/ 裡的 .js 不一致');
    });

    // sha1.js has no require() to reach for in a browser, so csv.js reads
    // sha1Hex off the global — which only exists once sha1.js has run.
    it('shared/ 的檔案排在用到它們的東西之前', () => {
      const at = (f) => loaded.indexOf(f);
      assert.ok(at('shared/sha1.js') !== -1, '要載入 shared/sha1.js');
      assert.ok(at('shared/sha1.js') < at('shared/csv.js'),
        'csv.js 在瀏覽器裡從 global 讀 sha1Hex，sha1.js 必須先跑');
      assert.ok(at('shared/csv.js') < at('core.js'), 'shared/ 要排在前端程式之前');
      assert.ok(at('shared/money.js') < at('core.js'));
    });

    it('core.js 排在所有 view 之前', () => {
      const core = loaded.indexOf('core.js');
      const firstView = loaded.findIndex((f) => f.startsWith('view-'));
      assert.ok(core !== -1, '要載入 core.js');
      assert.ok(firstView === -1 || core < firstView,
        'views 物件宣告在 core.js，每個 view 檔載入時就會寫進去');
    });
  });

  // An author `display` outranks the UA sheet's `[hidden] { display: none }`,
  // so a styled element toggled with `hidden` stays on screen. The modal
  // overlay did exactly that and greyed out the whole app from first paint.
  it('用 hidden 切換又自己設了 display 的元素，都有 [hidden] 覆寫', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'web', 'style.css'), 'utf8');
    // app.js builds elements carrying `hidden` too — the liability note in the
    // account form is one — and they hit the same precedence rule. Scanning
    // only index.html would call the file clean while missing them.
    const markup = doc + SRC;

    // `\bhidden\b` also matches the tail of `aria-hidden`, because `-` is a
    // word boundary — so decorating anything with `aria-hidden="true"` used to
    // report it as needing a `[hidden]` override it never wanted. Only the
    // bare boolean attribute counts: not preceded by `-` or a letter, and
    // standing alone rather than starting a longer name.
    const toggled = [...markup.matchAll(/<(\w+)([^>]*(?<![-\w])hidden(?=[\s>])[^>]*)>/g)]
      .flatMap(([, , attrs]) => {
        const id = /id="([^"]+)"/.exec(attrs);
        const klass = /class="([^"]+)"/.exec(attrs);
        return [
          ...(id ? [`#${id[1]}`] : []),
          ...(klass ? klass[1].trim().split(/\s+/).map((c) => `.${c}`) : []),
        ];
      });

    const offenders = toggled.filter((sel) => {
      const esc = sel.replace(/[.#]/g, '\\$&');
      const setsDisplay = new RegExp(`${esc}[^{}]*\\{[^}]*\\bdisplay\\s*:`, 's').test(css);
      const guarded = new RegExp(`${esc}\\[hidden\\]`).test(css);
      return setsDisplay && !guarded;
    });

    assert.deepEqual(offenders, [],
      `${offenders.join(', ')} 設了 display 又用 hidden 切換，需要一條 ${offenders[0] || 'X'}[hidden] { display: none }`);
  });
});
