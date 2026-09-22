'use strict';

// What kinds of account and transaction exist, in one place.
//
// This list used to be seven copies. `server/migrations.js` described it in a
// comment, `web/core.js` held a label map and a sort order, `web/forms.js` and
// `web/view-import.js` each built a `<select>` from an array literal,
// `web/storage-demo.js` and `server/api.js` each repeated the default, and
// `shared/money.js` kept the liability set. Adding a kind meant seven edits and
// **nothing failed when one was missed** — the account simply rendered with a
// raw English key, in a sidebar group of its own, at the end.
//
// So a kind is one entry here with everything a kind needs: what to call it,
// where it sorts, and whether it is something you owe. Everything else reads
// from this.

(function (root) {
  // `order` is the sidebar and breakdown order, and it is a property rather
  // than the array's position so a kind can be inserted without renumbering:
  // what you spend from, then what you owe, then what you hold.
  //
  // `liability` is the sign convention, not a display choice. A balance is
  // what the account is worth to you, so one you owe on is negative — which is
  // why net worth can be a plain sum that never asks what it is adding. See
  // CLAUDE.md, "Money conventions".
  const ACCOUNT_KINDS = [
    { key: 'cash', label: '現金／存款', order: 10, liability: false },
    { key: 'card', label: '信用卡', order: 20, liability: true },
    { key: 'brokerage', label: '證券', order: 30, liability: false },
    { key: 'loan', label: '貸款', order: 40, liability: true },
    { key: 'other', label: '其他', order: 90, liability: false },
  ];

  // Not account kinds: what a transaction *is*. They share `kindName` because
  // they share a column name and a rendering, and for no other reason — keep
  // the two lists apart or `KIND_ORDER` starts offering 手續費 as somewhere to
  // put your salary.
  //
  // `other` leads because it is the default and the honest answer when you do
  // not know, and a picker that opens on 收入 invites a wrong one.
  //
  // **`transfer` is not pickable.** It is the conclusion the pairing flow
  // draws about two rows together, and it is removed by unlinking them, not by
  // relabelling one. Offering it in a per-row picker would let a transaction
  // claim to be half of a pair that does not exist — and transfers are
  // excluded from spending, so the row would quietly leave the totals. The two
  // pickers used to hold two hand-written subsets that agreed on excluding it
  // and disagreed about 換匯 for no stated reason.
  const TXN_KINDS = [
    { key: 'other', label: '其他', pickable: true },
    { key: 'income', label: '收入', pickable: true },
    { key: 'expense', label: '支出', pickable: true },
    { key: 'trade', label: '買賣', pickable: true },
    { key: 'dividend', label: '股利', pickable: true },
    { key: 'fee', label: '手續費', pickable: true },
    { key: 'fx', label: '換匯', pickable: true },
    { key: 'transfer', label: '轉帳', pickable: false },
  ];

  const TXN_KIND_ORDER = TXN_KINDS.filter((k) => k.pickable).map((k) => k.key);

  // Not a kind of anything — the row the overview's breakdown adds for the
  // market value of holdings, which belongs to no account. It needs a label
  // and nothing else, and it must never appear in a picker.
  const EXTRA_LABELS = { securities: '持股市值' };

  const byOrder = [...ACCOUNT_KINDS].sort((a, b) => a.order - b.order);

  // The order the sidebar groups accounts in and the order a picker lists
  // them. One array, so a group that exists cannot be missing from the form.
  const KIND_ORDER = byOrder.map((k) => k.key);

  const KIND_LABEL = {};
  for (const k of [...ACCOUNT_KINDS, ...TXN_KINDS]) KIND_LABEL[k.key] = k.label;
  Object.assign(KIND_LABEL, EXTRA_LABELS);

  // Falls back to the key rather than to a placeholder: a kind nobody has
  // labelled should look wrong, not look like a category called "其他".
  const kindName = (k) => KIND_LABEL[k] || k;

  const LIABILITY_KINDS = new Set(ACCOUNT_KINDS.filter((k) => k.liability).map((k) => k.key));

  // What an account is when nobody said. One constant rather than four string
  // literals in four defaults, which is how they drift.
  const DEFAULT_ACCOUNT_KIND = 'cash';
  const DEFAULT_TXN_KIND = 'other';

  // Dual-environment, the same three lines every file in shared/ ends with:
  // onto the global for the browser's classic scripts, onto module.exports for
  // Node.
  const api = {
    ACCOUNT_KINDS, TXN_KINDS, KIND_ORDER, TXN_KIND_ORDER, KIND_LABEL, kindName,
    LIABILITY_KINDS, DEFAULT_ACCOUNT_KIND, DEFAULT_TXN_KIND,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
