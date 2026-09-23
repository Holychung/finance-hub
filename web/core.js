'use strict';

// Everything every other file needs: DOM helpers, the money formatters, the
// fetch wrapper, the toast and modal chrome, the names the API speaks in, and
// the focus/scroll pair every full redraw goes through.
//
// Markup is built with the html`` tag from html.js: interpolated values are
// escaped unless they are themselves html`` output, and mount() is the only
// way anything reaches the document. Nothing here calls innerHTML directly.
//
// Loaded first. Its only dependency is html.js.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const main = $('#main');

const nf = (n, d = 0) =>
  n === null || n === undefined || Number.isNaN(n)
    ? '—'
    : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// Symbol and decimals come from shared/currency.js, not from a ternary on
// 'USD'. The ternary wrote `NT$` for every currency that was not USD, so a
// JPY balance read as `NT$1,234` — the right number in the wrong country, and
// the kind of wrong that looks fine until you hold three currencies.
const money = (n, cur = 'TWD') => {
  if (n === null || n === undefined) return '—';
  return `${n < 0 ? '-' : ''}${symbolOf(cur)}${nf(Math.abs(n), decimalsOf(cur))}`;
};

// `quantity()` for share and coin counts is in shared/currency.js, off the
// global like the rest of that module — it is testable there and this file is
// not, because it touches the document at load.
const signed = (n, cur = 'TWD') => (n > 0 ? '+' : '') + money(n, cur);
// A delta is news in both directions, so `cls` colours both. A level is not:
// colouring every positive balance green leaves the negative ones no louder
// than the rest, which is the only thing colouring a balance is for. See
// CLAUDE.md "Styling".
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'dim');
const level = (n) => (n < 0 ? 'neg' : '');
// round2 is shared/money.js's — same definition, and every amount the server
// rounds on write goes through that one. A second copy here rounded the
// browser's own arithmetic (chart deltas, the spending "other" bucket) with a
// function nothing held against it.
const today = () => new Date().toISOString().slice(0, 10);
// A stored ISO timestamp shown in the viewer's own timezone, to the minute —
// unlike the UTC-sliced `created_at` shown for backups, because a "last updated"
// line is read as "how fresh is this", which only makes sense in local time.
const localTime = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// The four verbs every view already speaks, now one line each over the
// storage adapter in storage-http.js. Kept as bare names because that is what
// eighteen call sites say; what changed is that none of them reaches a
// `fetch` any more.
const api = (p) => storage.get(p);
const post = (p, b) => storage.post(p, b);
const put = (p, b) => storage.put(p, b);
const del = (p) => storage.del(p);

// Every export control in the app. Six views built their own
// `<a href="/api/export/...">`, which is six places to miss when the thing
// behind the URL changes — `storage.exportHref` is the one that decides, and
// this is the one that renders.
// `download` comes from the caller when it has an opinion, otherwise from the
// adapter. Over HTTP the adapter has none: the server already named the file
// in its Content-Disposition, down to the date stamp, and setting `download`
// would override that with the last path segment. An adapter handing back a
// `blob:` URL has to supply one, because a blob carries no name at all.
const exportLink = (label, path, filename) => {
  const name = filename || storage.exportName(path);
  return name
    ? html`<a class="btn" href="${storage.exportHref(path)}" download="${name}">${label}</a>`
    : html`<a class="btn" href="${storage.exportHref(path)}">${label}</a>`;
};

let toastTimer;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function modal(title, body, onMount) {
  $('#modal-title').textContent = title;
  mount($('#modal-body'), body);
  $('#modal').hidden = false;
  if (onMount) onMount($('#modal-body'));
}
const closeModal = () => { $('#modal').hidden = true; };
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' || e.target.closest('[data-close-modal]')) closeModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

// `KIND_LABEL`, `kindName`, `KIND_ORDER` and `LIABILITY_KINDS` are not
// declared here: they come off the global from shared/kinds.js, which
// index.html loads before this file. They used to be copies — a label map and
// a sort order here, array literals in two forms, defaults in two adapters —
// and adding a kind meant editing all of them with nothing to catch a miss.

// The segment after the view name: `#/account/7` → '7'.
// Real paths, not `#/account/5`. The server hands index.html back for any
// extensionless path it cannot find, so a refresh or a pasted link works.
const segments = () => location.pathname.split('/').filter(Boolean);
const routeParam = () => segments()[1] || null;

// Action icons: inline stroke SVG, coloured by `currentColor` so a button's
// own state drives them. No icon font and no CDN — the app installs nothing.
//
// Severity icons are deliberately NOT here. Those belong to the container and
// come from a CSS mask (`--icon-*` in style.css), so a `.note` cannot be
// written without one. These are content: which action a button performs is
// something only the call site knows.
//
// Each entry is a finished html`` template rather than a path string, because
// a bare `<path …>` interpolated into a template would be escaped, and reaching
// for raw() to get around that would be a hole where a convenience should be.
const ICONS = {
  edit: html`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>`,
  trash: html`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="m6 7 1 13h10l1-13"/></svg>`,
  file: html`<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h11l5 5v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M15 5v5h5"/></svg>`,
  chart: html`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="m7 14 4-4 3 3 5-6"/></svg>`,
  refresh: html`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`,
};
// The sidebar's nav and brand marks are not here: they are drawn once, in
// index.html, and never from a template. An entry with no caller in this file
// would be a definition kept in step with nothing.

// Throws rather than rendering nothing: a mistyped name should be a blank
// screen with a message in the console, not a button with no glyph that
// nobody notices until someone asks why they cannot find delete.
function icon(name) {
  if (!ICONS[name]) throw new Error(`no icon named "${name}"`);
  return ICONS[name];
}

const empty = (msg) => html`<div class="empty">${icon('file')}<div>${msg}</div></div>`;

// An ARIA state written out as the word it has to be. html`` renders a
// boolean as nothing, which is what lets `${cond && html`…`}` work — and it
// also means an aria-pressed filled straight from a comparison always comes
// out empty. That is how every range switch in the app shipped with no
// pressed state: no highlight on screen, and nothing for a screen reader.
const ariaBool = (on) => (on ? 'true' : 'false');

// The status pills an account carries wherever its name is written: no longer
// in use, money behind a rule, and which kind of tax figure its balance is.
// Kind and currency are not pills — they have columns of their own. This was
// two copies of the same two conditionals until a third pill arrived.
const accountPills = (a) => [
  a.is_active ? '' : html` <span class="pill">已停用</span>`,
  a.access === 'restricted' ? html` <span class="pill">${accessName(a.access)}</span>` : '',
  a.tax_status ? html` <span class="pill">${taxStatusName(a.tax_status)}</span>` : '',
];

// Rebuilding a container replaces every node in it, so whatever had focus is
// gone and the caret with it — type in the transactions search box, press
// Enter, and you have to click back into it to change a letter. Nothing here
// diffs, by design; putting the focus back afterwards is the 20 lines that
// buys what a virtual DOM would, for the one case that actually hurts.
//
// The sidebar's account list scrolls independently and is redrawn on every
// render too, so it gets the same treatment.
function captureUi() {
  const el = document.activeElement;
  const snap = {
    focusId: el && el.id && el !== document.body ? el.id : null,
    selStart: null,
    selEnd: null,
    scrollY: window.scrollY,
    navScroll: $('#nav-accounts') ? $('#nav-accounts').scrollTop : 0,
  };
  // selectionStart throws on input types that do not support it — number and
  // date among them, both of which this app uses.
  try { snap.selStart = el.selectionStart; snap.selEnd = el.selectionEnd; } catch { /* not a text field */ }
  return snap;
}

function restoreUi(snap) {
  const nav = $('#nav-accounts');
  if (nav) nav.scrollTop = snap.navScroll;
  window.scrollTo(0, snap.scrollY);

  if (!snap.focusId) return;
  const el = document.getElementById(snap.focusId);
  if (!el) return;
  // preventScroll, or focusing something below the fold undoes the scroll
  // position that was just restored.
  el.focus({ preventScroll: true });
  if (snap.selStart !== null) {
    try { el.setSelectionRange(snap.selStart, snap.selEnd); } catch { /* not selectable */ }
  }
}

// One render function per view, filled in by the view-*.js files. Declared
// here rather than in app.js because every one of them assigns into it at
// load and app.js is loaded last — by then the registry has to already exist.
// render() re-runs the current view after every mutation; there is no
// client-side cache to invalidate. Kept in step with APP_ROUTES in
// server/index.js by test/html.test.js.
const views = {};
