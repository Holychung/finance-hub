'use strict';

// How many decimal places a number has, and what symbol goes in front of it.
//
// Both used to be a ternary on `'USD'`. `round2` rounded to two places
// everywhere, three files each declaring their own copy of it; `money()` wrote
// `$` for USD and `NT$` for **everything else**, so a JPY balance rendered as
// `NT$1,234` — right number, wrong country. And a quantity picked its own
// precision by asking whether it happened to have a fraction, capped at four,
// which is fine for shares and reports 0.00000001 as `0.0000`.
//
// Two decimal places is not a property of money. It is a property of a
// currency, and the ledger already holds currencies that disagree: TWD is
// quoted whole, USD to cents, and an eight-place coin is the next thing this
// table has to answer for.
//
// **This does not make float money exact.** Amounts are still `REAL` in
// SQLite and still rounded at every boundary; what changes is that the scale
// is a parameter rather than the number 2 written 52 times. Converting to
// integer minor units is its own project, and after this it is a change of
// storage rather than a change of every call site.

(function (root) {
  // `dp` is how the amount is written down, which is also how far it may be
  // rounded without losing anything a statement said. Nothing infers it: a
  // currency the ledger has not been taught falls back to two places and its
  // own code as the symbol, which reads as unfinished rather than as TWD.
  const CURRENCIES = {
    TWD: { symbol: 'NT$', dp: 0, label: '新台幣' },
    USD: { symbol: '$', dp: 2, label: '美元' },
  };

  // What the account and import forms offer. One list, for the same reason
  // `shared/kinds.js` exists: it used to be an array literal in two views.
  const CURRENCY_CODES = Object.keys(CURRENCIES);

  const DEFAULT_DP = 2;
  const infoOf = (code) => CURRENCIES[String(code || '').toUpperCase()] || null;

  const decimalsOf = (code) => {
    const c = infoOf(code);
    return c ? c.dp : DEFAULT_DP;
  };

  // The code itself, spaced, for a currency with no entry. `JPY 1,234` is
  // readable and honestly unfinished; `NT$1,234` is a lie about what you hold.
  const symbolOf = (code) => {
    const c = infoOf(code);
    return c ? c.symbol : `${String(code || '').toUpperCase()} `;
  };

  // `Number.EPSILON` before scaling, because 1.005 is stored as slightly less
  // than 1.005 and would round down without it. The same expression that was
  // copied into three files, with the scale lifted out.
  const roundTo = (n, dp = DEFAULT_DP) => {
    const f = 10 ** dp;
    return Math.round((n + Number.EPSILON) * f) / f;
  };

  // Kept as a name because it is what 52 call sites say, and because two
  // places is genuinely the right answer for a statement amount — every
  // format this ledger reads writes at most two. Not a synonym to be replaced
  // mechanically: a call site that means "cents" should go on saying so.
  //
  // **The dedup fingerprint does not use this.** It calls `.toFixed(2)`
  // directly, and must keep doing so: the contract in CLAUDE.md freezes that
  // definition, and a statement will never carry a coin amount anyway.
  const round2 = (n) => roundTo(n, 2);

  // A quantity is not money: no symbol, and its scale belongs to the thing
  // being counted rather than to a currency. Shares are whole or a few places;
  // a coin is eight.
  //
  // Trailing zeros go, because `1.50000000 BTC` is noise — but every place
  // that carries information stays. The rule this replaces asked whether the
  // number had any fraction at all and then showed four places, which reports
  // 0.00000001 as `0.0000`.
  //
  // Here rather than in `web/core.js` so it can be tested: core.js touches the
  // document at load, so nothing in it runs under `node --test`.
  const quantity = (n, dp = 4) => {
    if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    if (Number.isInteger(v)) return v.toLocaleString('en-US');
    const trimmed = roundTo(v, dp).toFixed(dp).replace(/0+$/, '').replace(/\.$/, '');
    const places = (trimmed.split('.')[1] || '').length;
    return Number(trimmed).toLocaleString('en-US', {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    });
  };

  const api = {
    CURRENCIES, CURRENCY_CODES, DEFAULT_DP,
    decimalsOf, symbolOf, roundTo, round2, quantity,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
