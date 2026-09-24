'use strict';

// Which ledger this window is looking at.
//
// Two adapters ship side by side and this picks one, once, at load. There is
// no second `index.html` for the hosted build: two copies of the markup drift
// and there is no build step to generate one from the other, so the unused
// adapter is a few kilobytes of dead weight in each deployment. That is the
// right price.
//
// **It never falls back.** This project is not vague about where money is
// recorded — `paths.js` refuses to start when it finds a stranded
// `data/finance.db` rather than opening an empty one beside it, and the
// sidebar badge turns amber for a non-personal profile. Same principle here,
// which in practice means three things it must not do:
//
//   no runtime probe    It does not ping `/api/settings` and switch to the
//                       demo when the fetch fails. A server that is down on
//                       127.0.0.1 has to produce the error the views already
//                       show for a server that is down — not a second ledger
//                       quietly appearing with sample numbers in it.
//   no catch around use The only `try` here wraps the choice, and its `catch`
//                       ends by replacing the page.
//   no default branch   A `?storage=` value that is neither name throws
//                       rather than being treated as absent.
//
// `?storage=demo` exists because otherwise the demo cannot be looked at on
// 127.0.0.1 at all, and it has to be walked before it can be trusted. That is
// explicit intent typed into an address bar, which is the opposite of a
// silent fallback — and the amber badge appears however the demo was chosen,
// so a window is never ambiguous about which it is.

// Pure, so the table of cases below can be tested without a browser.
function chooseStorage({ hostname, protocol, search, available }) {
  if (protocol === 'file:') {
    throw new Error(
      'file:// 開不起來：index.html 的 script 用的是根路徑絕對位址。'
      + '請跑 node server/index.js，然後開 http://127.0.0.1:4321'
    );
  }
  const forced = new URLSearchParams(search || '').get('storage');
  if (forced !== null && forced !== 'http' && forced !== 'demo') {
    throw new Error(`?storage=${forced} 不是 http 也不是 demo。不猜，直接停。`);
  }
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const want = forced || (LOOPBACK.has(hostname) ? 'http' : 'demo');
  if (!available.has(want)) {
    throw new Error(`選到「${want}」這個儲存實作，但它沒有載入。index.html 少了一個 <script>？`);
  }
  return want;
}

// Replacing the page, not logging. A blank screen with one line in the
// console is the failure this project keeps rediscovering, and `toast()`
// does not exist yet — it lives in core.js, which loads after this and fades
// after three seconds anyway.
function storageFatal(message) {
  const main = document.querySelector('#main');
  if (main) {
    mount(main, html`
      <section class="card">
        <h1>開不起來</h1>
        <p class="note err">${message}</p>
        <p class="dim">在挑到儲存實作之前不會渲染任何東西，免得畫面上的數字來路不明。</p>
      </section>
    `);
  }
  throw new Error(message);
}

const storage = (() => {
  const available = new Map();
  if (typeof createHttpStorage === 'function') available.set('http', createHttpStorage);
  if (typeof createDemoStorage === 'function') {
    available.set('demo', () => createDemoStorage({ raw: makeMapStore(demoSeed()) }));
  }
  try {
    const pick = chooseStorage({
      hostname: location.hostname,
      protocol: location.protocol,
      search: location.search,
      available,
    });
    return available.get(pick)();
  } catch (e) {
    return storageFatal(e.message);
  }
})();

// The demo's data, built by the same function `scripts/seed-demo.js` uses.
// One definition: whatever a visitor sees here is what somebody running the
// real thing against a demo profile sees, down to the row.
//
// `crypto.randomUUID` needs a secure context, which https and 127.0.0.1 both
// are — but a page served over plain http from a LAN address is not, and a
// demo that throws on load there would be worse than one whose transfer
// groups are not cryptographically random. Nothing here depends on them
// being unguessable; they only have to be distinct.
function demoSeed() {
  let n = 0;
  return buildDemoBook({
    to: new Date().toISOString().slice(0, 10),
    months: DEMO_MONTHS,
    now: () => new Date().toISOString(),
    uuid: () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `demo-group-${++n}`),
  });
}

// Start again from the seed. The demo is the one place where throwing the
// data away is a feature — everything is invented and nothing survives a
// reload anyway, so the control says what it does rather than asking twice.
function resetDemo() {
  storage.reset(demoSeed());
}
