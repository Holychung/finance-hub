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
  // is gone — see the --marker comment in tokens.css — so the state is stated
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

// The three AI modes, behind the `modes` flag in flags.js. A mode is the
// book's AI reach (server/ai.js): the server keeps it and enforces it, and this
// only draws it. The switch writes the next reach and changes the look only
// once the server has taken it, so the screen never shows a mode the book is
// not in. With the flag off data-mode is never set and modes.css applies
// nothing; the reach is still the book's, switched on the AI 健檢 page.
const PRIVACY_MODES = [
  { id: 'none', name: '晴天', where: '不用 AI',
    promise: '不用 AI，這個帳本不會交給任何 AI。',
    icon: html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>` },
  // Says what it does today, not what it is for: there is no local model yet,
  // so the server refuses here exactly as it does for 晴天.
  { id: 'local', name: '月夜', where: 'AI 在這台電腦',
    promise: '只允許這台電腦上的 AI。本機 AI 還沒有做好，所以現在什麼都不會送出。',
    icon: html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>` },
  { id: 'cloud', name: '萬聖夜', where: '雲端 AI',
    promise: '按「送出」之後，資料會傳給你選的雲端 AI。',
    icon: html`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 7c-5 0-8 3-8 7s3 7 8 7 8-3 8-7-3-7-8-7z"/><path d="M12 7V4c1 0 2 .5 2.5 1.5"/><path d="M9 7.5C7.5 10 7.5 17 9 20.5M15 7.5c1.5 2.5 1.5 9.5 0 13"/></svg>` },
];

// The flag's apply(). Off takes every trace back out, so the page is
// the app layer's again without a reload; on draws the book's reach once the
// server has said what it is.
async function setModes(on) {
  if (!on) {
    $('#mode-switch').hidden = true;
    $('#mode-bar').hidden = true;
    delete document.documentElement.dataset.mode;
    $('#nav a[data-view="ai"]').hidden = false;
    return;
  }
  await showReach();
}

// Draws the book's reach as the server has it. The AI 健檢 page calls this too
// after its own switch moves the reach, so the two never disagree.
async function showReach() {
  if (!flagOn('modes')) return;
  try {
    showMode((await api('/api/settings')).ai_reach);
  } catch { /* the view itself reports a server that is not answering */ }
}

function showMode(id) {
  const i = Math.max(0, PRIVACY_MODES.findIndex((m) => m.id === id));
  const m = PRIVACY_MODES[i];
  const next = PRIVACY_MODES[(i + 1) % PRIVACY_MODES.length];
  document.documentElement.dataset.mode = m.id;
  $('#mode-bar').hidden = false;
  mount($('#mode-bar'), html`${m.icon}<b>${m.name}</b><span>${m.promise}</span>`);
  // Under 晴天 there is no AI to visit, so the page does not offer one.
  $('#nav a[data-view="ai"]').hidden = m.id === 'none';
  const btn = $('#mode-switch');
  btn.hidden = false;
  btn.disabled = false;
  btn.setAttribute('aria-label', `模式：${m.name}，${m.where}。按一下切換到${next.name}`);
  mount(btn, html`${m.icon}<span><b>${m.name}</b><small>${m.where}</small></span>`);
  // The server first: a reach it refuses — the hosted demo refuses every one
  // but 晴天 — is a toast and no change, never a look the book is not in.
  // The AI 健檢 page is redrawn inside the reveal, so it says the new reach.
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await put('/api/ai', { reach: next.id });
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
      return;
    }
    switchWithReveal(btn, () => {
      showMode(next.id);
      if (currentView() === 'ai') return render();
    });
  };
}

// The new mode spreads out from the button that was pressed, as a widening
// circle over a snapshot of the old one. Two dark modes are close enough in
// colour that the circle's edge alone barely shows — 月夜 into 萬聖夜 read
// as a faint flash — so the edge carries a glow in the new mode's brand
// colour and the old view dims as it is covered. A browser without view
// transitions, or a person who asked for less motion, gets the switch with
// no animation: the same result, just immediate.
function switchWithReveal(from, apply) {
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!document.startViewTransition || still) { apply(); return; }
  const r = from.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const timing = { duration: 700, easing: 'cubic-bezier(.4, 0, .2, 1)' };
  // Inside the new view, so it is drawn in the new mode's colour and clipped
  // by the same circle; scaled with the same timing, its rim is the edge.
  const ring = document.createElement('div');
  ring.className = 'mode-ring';
  ring.style.setProperty('--rx', `${x}px`);
  ring.style.setProperty('--ry', `${y}px`);
  ring.style.setProperty('--rr', `${end}px`);
  const t = document.startViewTransition(() => { apply(); document.body.append(ring); });
  t.ready.then(() => {
    const root = document.documentElement;
    root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
      { ...timing, pseudoElement: '::view-transition-new(root)' },
    );
    root.animate({ filter: ['brightness(1)', 'brightness(.45)'] },
      { ...timing, pseudoElement: '::view-transition-old(root)' });
    ring.animate({ transform: ['scale(0)', 'scale(1)'], opacity: [1, 1, 0] }, timing);
  });
  t.finished.finally(() => ring.remove());
}

window.addEventListener('popstate', render);
wireChartHover();
applyFlags();
render();
showProfile();
