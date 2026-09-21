'use strict';

// The router and the chrome around the views: which view is on screen, the
// delegated click handler that turns a link into a pushState, and the sidebar.
//
// Loaded last, and the only file that runs anything at load: render() at the
// bottom needs every views.* already registered, and every other file only
// defines things. Adding a view means adding its file to index.html *above*
// this one, and its name to APP_ROUTES in server/index.js.

function currentView() {
  const name = segments()[0] || 'overview';
  return views[name] ? name : 'overview';
}

async function render() {
  const snap = captureUi();
  const name = currentView();
  // The active item used to carry a leading bar as well as its tint. The bar
  // is gone — see the --marker comment in style.css — so the state is stated
  // rather than only drawn, which it should have been anyway.
  $$('#nav a').forEach((a) => {
    const on = a.dataset.view === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  try {
    await views[name]();
  } catch (e) {
    mount(main, html`
      <div class="page-head"><h1>出錯了</h1></div>
      <section class="card"><div class="note warn">${e.message}</div></section>`);
  }
  // After the view, and outside its try: a sidebar that fails to draw must not
  // take the page with it, and a page that failed still wants its chrome.
  await renderSidebarAccounts();
  restoreUi(snap);
}

// Which book is open, stated in the chrome rather than only in the terminal.
// A demo profile and the real ledger are the same application at the same
// address; without this the only difference between the two windows is what
// the numbers happen to say.
async function showProfile() {
  try {
    const s = await api('/api/settings');
    // `db_path: null` is the demo saying there is no file. Printing "資料存在
    // 這台電腦的" above an empty <code> would be the one sentence on screen
    // that is not true, in the app whose whole claim is about where the data
    // is.
    mount($('#db-where'), s.db_path
      ? html`資料存在這台電腦的<br><code>${s.db_path}</code>`
      : html`資料只存在這個分頁裡，重新整理就沒了。<br>要保存就下載回去自己跑。`);
    if (!s.is_personal) {
      const badge = $('#local-badge');
      badge.classList.add('profile-alt');
      // The demo says what it is rather than what it is called: "profile：
      // demo" reads as a setting, and a visitor should not have to work out
      // that it means the numbers are invented.
      mount(badge, s.db_path
        ? html`<span class="dot"></span> profile：${s.profile}`
        : html`<span class="dot"></span> 示範資料`);
    }
    if (!s.db_path) mount($('#source-offer'), sourceOffer());
  } catch { /* the view itself will report a server that is not answering */ }
}

// The source offer, and it is an obligation rather than a courtesy.
//
// The repo is AGPL-3.0 and the hosted demo is a *modified* version served to
// people over a network — a tighter CSP, an adapter picker, seed data — so
// §13 says those users must be prominently offered the Corresponding Source
// of **the version they are running**. Prominent is why it sits in the
// sidebar, which is on every view, rather than on the settings page. "The
// version they are running" is why it names a commit: a link to `main` is an
// offer of whatever happens to be there later, which is not the same thing.
//
// `scripts/pack-demo.js` stamps the commit into the page when it packs it.
// There is no stamp when the demo is opened from a source checkout with
// `?storage=demo`, and then the honest answer is the repo itself — the source
// is already on the machine reading this.
const SOURCE_REPO = 'https://github.com/Holychung/finance-hub';

function sourceOffer() {
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content || '';
  const repo = meta('source-repo') || SOURCE_REPO;
  const stamped = meta('source-commit');
  // `--allow-dirty` packs a tree with uncommitted changes and marks it. The
  // link still has to resolve, so it points at the commit and the label says
  // the running copy is not exactly that.
  const commit = stamped.replace(/-dirty$/, '');
  const dirty = stamped.endsWith('-dirty');
  return html`<a href="${commit ? `${repo}/tree/${commit}` : repo}" target="_blank" rel="noreferrer">
    原始碼${commit ? html` · ${commit.slice(0, 7)}${dirty ? '+未提交' : ''}` : ''}</a>`;
}

// Every account listed in the chrome, grouped, each with its own balance and
// its own page. The balances move on every import, so this re-runs with the
// view rather than once at boot.
async function renderSidebarAccounts() {
  const slot = $('#nav-accounts');
  if (!slot) return;
  try {
    const accounts = (await api('/api/accounts')).filter((a) => a.is_active);
    const active = currentView() === 'account' ? Number(routeParam()) : null;
    const groups = KIND_ORDER
      .map((k) => [k, accounts.filter((a) => a.kind === k)])
      .concat([['other', accounts.filter((a) => !KIND_ORDER.includes(a.kind))]])
      .filter(([, list]) => list.length);

    mount(slot, html`${groups.map(([kind, list]) => html`
      <div class="nav-group">
        <div class="nav-group-head">${kindName(kind)}</div>
        ${list.map((a) => html`<a class="nav-account ${a.id === active ? 'active' : ''}" href="/account/${a.id}"
          ${a.id === active ? 'aria-current="page"' : ''}>
          <span class="nav-account-name" title="${a.name}">${a.name}</span>
          <span class="nav-account-bal ${level(a.balance)}">${money(a.balance, a.currency)}</span>
        </a>`)}
      </div>`)}`);
  } catch { /* the view itself reports a server that is not answering */ }
}

// One delegated handler rather than wiring every link: the views rebuild their
// markup constantly, and a per-link listener would have to be reattached on
// every render.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  // Leave anything the browser should handle itself: new tabs, downloads,
  // modified clicks, middle clicks, other origins.
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  if (a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  // The CSV export is a real download served by the server; intercepting it
  // would swallow the file and show the overview instead.
  if (url.pathname.startsWith('/api/')) return;

  e.preventDefault();
  if (url.pathname === location.pathname) return;
  history.pushState(null, '', url.pathname);
  render();
});

window.addEventListener('popstate', render);
wireChartHover();
render();
showProfile();
