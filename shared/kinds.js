'use strict';

// The ledger's closed vocabularies, in one place: what kinds of account and
// transaction exist, whether an account's money is reachable, what tax
// treatment its balance has, and which markets a holding can sit in.
//
// The account kinds used to be seven copies. `server/migrations.js` described it in a
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
  //
  // `holds` says whether positions can live in the account. The holdings page
  // used to hardcode `kind === 'brokerage'`, so the first account of any other
  // kind that held something — a wallet — could not be given a holding at all.
  //
  // A wallet is self-custody: no institution, and usually no cash balance of
  // its own, because its value is the coins in `holdings`. An exchange account
  // that also keeps cash is closer to a brokerage, and which one an account is
  // is the user's call.
  //
  // `access` is only where a new account of the kind starts. The account's own
  // `access` is what counts, and the form shows it: a 401(k) is behind a rule
  // almost by definition, so it starts restricted, while a wallet starts liquid
  // and a locked stake is changed by hand, because the kind cannot tell those
  // two apart. See ACCESS below.
  //
  // `taxAdvantaged` says the balance sits under a tax rule — a 401(k), an IRA,
  // 勞退 — so the account can say whether its balance is pre-tax and how much
  // of it has not vested. On any other kind both questions are noise.
  //
  // `statements` says whether there is a statement to import at all. A
  // self-custody wallet has none: its value is the quantity and price typed in
  // on the holdings page, and only the latest figure matters. The coverage
  // grid measures whether statements were imported, so such an account has no
  // months to be complete about — kept in, every month it existed was a gap
  // nobody could close. Only the wallet so far; a retirement plan that only
  // ever reports a balance is the same case, and joins when it is needed.
  const ACCOUNT_KINDS = [
    { key: 'cash', label: '現金／存款', order: 10, liability: false, holds: false, access: 'liquid', taxAdvantaged: false, statements: true },
    { key: 'card', label: '信用卡', order: 20, liability: true, holds: false, access: 'liquid', taxAdvantaged: false, statements: true },
    { key: 'brokerage', label: '證券', order: 30, liability: false, holds: true, access: 'liquid', taxAdvantaged: false, statements: true },
    { key: 'wallet', label: '錢包', order: 35, liability: false, holds: true, access: 'liquid', taxAdvantaged: false, statements: false },
    { key: 'retirement', label: '退休金', order: 38, liability: false, holds: true, access: 'restricted', taxAdvantaged: true, statements: true },
    { key: 'loan', label: '貸款', order: 40, liability: true, holds: false, access: 'liquid', taxAdvantaged: false, statements: true },
    { key: 'other', label: '其他', order: 90, liability: false, holds: false, access: 'liquid', taxAdvantaged: false, statements: true },
  ];

  const HOLDING_KINDS = new Set(ACCOUNT_KINDS.filter((k) => k.holds).map((k) => k.key));
  const TAX_ADVANTAGED_KINDS = new Set(ACCOUNT_KINDS.filter((k) => k.taxAdvantaged).map((k) => k.key));
  const NO_STATEMENT_KINDS = new Set(ACCOUNT_KINDS.filter((k) => !k.statements).map((k) => k.key));

  // Where a holding trades, and the three things that follow from it by
  // default: the currency it is usually priced in, how many places its
  // quantity is written to, and what the quantity column is called.
  //
  // **The keys are upper case, and have to be.** `/api/prices` upper-cases the
  // market on the way in and out, while holdings used to store whatever they
  // were sent. A lower-case `crypto` holding would have looked its price up
  // under `crypto` in a series stored as `CRYPTO`, found nothing, and fallen
  // back to `last_price` forever — a price history that silently never
  // applied. Both endpoints now normalise and validate against this list.
  //
  // `currency` is a default, not a rule: a coin is priced in whatever the
  // venue quotes — USD on most exchanges, TWD on a Taiwanese one — so the form
  // offers the choice. `decimals` is the quantity's scale: shares on the TWSE
  // are whole, US brokers sell fractions, a coin is eight places. It is also a
  // default the holding can override.
  const MARKETS = [
    { key: 'TW', label: '台股', currency: 'TWD', decimals: 0, unit: '股數', per: '每股' },
    { key: 'US', label: '美股', currency: 'USD', decimals: 4, unit: '股數', per: '每股' },
    { key: 'CRYPTO', label: '加密貨幣', currency: 'USD', decimals: 8, unit: '數量', per: '每單位' },
  ];
  const MARKET_KEYS = MARKETS.map((m) => m.key);
  const DEFAULT_MARKET = 'TW';
  const marketInfo = (k) => MARKETS.find((m) => m.key === k) || null;

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
  //
  // **`flow` says whether any money moved at all.** A `valuation` row is a
  // statement saying the funds are now worth this much more or less: nobody
  // paid it and nobody spent it. Recorded, it brings a balance to the
  // statement's figure — which is what a retirement balance is — and it stays
  // out of everything that asks where money came from or went. Without the
  // flag a fund's bad month would be the biggest expense in the spending
  // breakdown, and could be offered as the other leg of a card payment. A
  // transfer *is* a flow — money really left one account — which is why it
  // keeps its own rule for leaving spending and this flag does not cover it.
  const TXN_KINDS = [
    { key: 'other', label: '其他', pickable: true, flow: true },
    { key: 'income', label: '收入', pickable: true, flow: true },
    { key: 'expense', label: '支出', pickable: true, flow: true },
    { key: 'trade', label: '買賣', pickable: true, flow: true },
    { key: 'dividend', label: '股利', pickable: true, flow: true },
    { key: 'fee', label: '手續費', pickable: true, flow: true },
    { key: 'fx', label: '換匯', pickable: true, flow: true },
    { key: 'valuation', label: '市值變動', pickable: true, flow: false },
    { key: 'transfer', label: '轉帳', pickable: false, flow: true },
  ];

  const TXN_KIND_ORDER = TXN_KINDS.filter((k) => k.pickable).map((k) => k.key);
  const NON_FLOW_KINDS = new Set(TXN_KINDS.filter((k) => !k.flow).map((k) => k.key));

  // Whether there is a rule between you and the money. Not a kind: a
  // self-custody wallet is as reachable as a current account, a locked stake
  // is not, and both would be the same kind. Guessing access from the kind is
  // wrong for exactly the cases that matter, so it is its own property.
  //
  // `restricted` means a rule — an age, a notice period, a penalty — not
  // "hard to sell". Nobody is stopping you selling a property, so it is liquid
  // by this definition, and a scale of days-until-access would be a guess
  // dressed as data for almost every account that had one.
  //
  // See docs/plans/asset-classes.md: this is the property the plan rests on,
  // and nothing reads it yet — net worth splits on it in PR 6.
  const ACCESS = [
    { key: 'liquid', label: '可動用' },
    { key: 'restricted', label: '受限制' },
  ];
  const ACCESS_KEYS = ACCESS.map((a) => a.key);
  const DEFAULT_ACCESS = 'liquid';
  const accessName = (k) => (ACCESS.find((a) => a.key === k) || {}).label || k;

  // What a new account of `kind` starts as when nobody said. A kind the list
  // does not know starts liquid, like every account that existed before
  // access did.
  const defaultAccessFor = (kind) => (ACCOUNT_KINDS.find((k) => k.key === kind) || {}).access || DEFAULT_ACCESS;

  // What kind of figure a tax-advantaged balance is — a label, never
  // arithmetic. A pre-tax balance is worth less than it says once withdrawn,
  // by a rate nobody knows at a date nobody knows, and applying one would
  // turn the institution's figure into an estimate that moves every time
  // somebody guesses again: the same reason there is no cross-currency total.
  // So the balance stays the statement's number and this says which kind of
  // number it is. Null means not stated, which is most accounts.
  const TAX_STATUS = [
    { key: 'pretax', label: '稅前' },
    { key: 'roth', label: 'Roth' },
    { key: 'aftertax', label: '稅後' },
  ];
  const TAX_STATUS_KEYS = TAX_STATUS.map((t) => t.key);
  const taxStatusName = (k) => (TAX_STATUS.find((t) => t.key === k) || {}).label || k;

  // Not kinds of anything — rows the overview's breakdown adds that belong to
  // no account kind: the market value of holdings, and the unvested part of a
  // balance, which is subtracted there. They need a label and nothing else,
  // and must never appear in a picker.
  const EXTRA_LABELS = { securities: '持股市值', unvested: '未歸屬' };

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
    ACCOUNT_KINDS, TXN_KINDS, KIND_ORDER, TXN_KIND_ORDER, NON_FLOW_KINDS, KIND_LABEL, kindName,
    LIABILITY_KINDS, DEFAULT_ACCOUNT_KIND, DEFAULT_TXN_KIND,
    ACCESS, ACCESS_KEYS, DEFAULT_ACCESS, accessName, defaultAccessFor,
    TAX_ADVANTAGED_KINDS, TAX_STATUS, TAX_STATUS_KEYS, taxStatusName, NO_STATEMENT_KINDS,
    HOLDING_KINDS, MARKETS, MARKET_KEYS, DEFAULT_MARKET, marketInfo,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
