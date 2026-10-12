'use strict';

// Feature flags: work that is merged but stays off until somebody turns it on.
//
// Cmd+Shift+F (Ctrl+Shift+F off a Mac) opens the panel. A flag is stored in
// this browser only — the ledger never hears of it, a snapshot never carries
// it, and another browser, or the hosted demo for another visitor, still has
// it off. That is the point: a merge behind a flag changes nothing anybody
// sees by default.
//
// A flag is a look, never a permission. Nothing behind one may decide what
// the server does or what leaves the machine; that belongs in settings, where
// it is stated and kept.
//
// Each entry's apply(on) runs at boot and again whenever the box is ticked,
// so a flag takes effect without a reload. Retiring one means deleting its
// entry and the code it guarded, in one change.

const FLAGS = [
  {
    id: 'modes',
    name: 'AI 三模式',
    note: '晴天、月夜、萬聖夜的樣式、側欄的切換鈕、頁首橫幅和切換動畫。目前只是外觀，還不會擋任何 AI 功能。',
    apply: (on) => setModes(on),
  },
];

const FLAG_STORE = 'finance-hub-flags';

function readFlags() {
  try { return JSON.parse(localStorage.getItem(FLAG_STORE)) || {}; } catch { return {}; }
}

const flagOn = (id) => readFlags()[id] === true;

function setFlag(id, on) {
  const all = readFlags();
  if (on) all[id] = true; else delete all[id];
  try { localStorage.setItem(FLAG_STORE, JSON.stringify(all)); } catch { /* this page only, then */ }
  FLAGS.find((f) => f.id === id).apply(on);
}

const applyFlags = () => FLAGS.forEach((f) => f.apply(flagOn(f.id)));

function openFlags() {
  modal('實驗功能', html`
    <div class="note">還在做的功能，開了只影響<b>這個瀏覽器</b>，不會寫進帳本。快捷鍵 ⌘⇧F（Windows 是 Ctrl+Shift+F）開關這個面板。</div>
    ${FLAGS.map((f) => html`
      <label class="check">
        <input type="checkbox" data-flag="${f.id}" ${flagOn(f.id) ? 'checked' : ''}>
        <span><b>${f.name}</b><span class="sub-line">${f.note}</span></span>
      </label>`)}`, (body) => {
    $$('[data-flag]', body).forEach((box) => {
      box.onchange = () => setFlag(box.dataset.flag, box.checked);
    });
  });
}

// Cmd+Shift+F on a Mac, Ctrl+Shift+F elsewhere — either modifier works on
// either, so a Mac with a PC keyboard still gets there.
document.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey || e.code !== 'KeyF' || e.isComposing) return;
  e.preventDefault();
  if (!$('#modal').hidden && $('#modal-title').textContent === '實驗功能') closeModal();
  else openFlags();
});
