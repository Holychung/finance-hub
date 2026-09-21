'use strict';

// Categorisation rules: a pattern, a category, and the order they are tried in.
// Pure — no DB access, the same rule csv.js follows — so matching can be tested
// and argued about without a ledger in the way.
//
// This exists because **six of the eight supported statement formats carry no
// category column at all** (see docs/formats.md). Only Chase's card and the
// Venture card export one. For every other file the category is something the
// ledger decides or nobody does, and a spending breakdown built on a column
// that is empty 75% of the time is a chart of the word "未分類".

// Matching is done on a normalised copy of both sides, never the raw text. A
// statement writes the same merchant six ways across two banks — `7-ELEVEN`,
// `7 ELEVEN #1234`, `7-Eleven Co.` — and a user typing a pattern should not
// have to guess which. Case, punctuation and runs of whitespace all go; CJK
// and alphanumerics stay.
//
// Deliberately NOT the fingerprint's normalisation, even though it looks
// similar. That one is a hash input and can never change without invalidating
// every stored fingerprint (see CLAUDE.md's dedup contract). This one is a
// display-time convenience and must stay free to improve. Sharing the function
// would quietly chain the two together.

(function (root) {
  const normalise = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();

  // First match wins, ordered by priority then by age. Not "most specific wins":
  // specificity is a guess the code makes — is a longer pattern more specific, or
  // just wordier? — whereas order is something the user can see and drag. When a
  // row lands in the wrong category the fix has to be findable.
  function sortRules(rules) {
    return [...rules].sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.id - b.id);
  }

  // Returns the matching rule, not just its category, so a caller can say *which*
  // rule did it. "Why is this Groceries?" is the question a rules engine has to
  // be able to answer, or the user stops trusting it and stops using it.
  function match(description, rules) {
    const hay = normalise(description);
    if (!hay) return null;
    for (const r of rules) {
      const needle = normalise(r.pattern);
      if (needle && hay.includes(needle)) return r;
    }
    return null;
  }

  const categorise = (description, rules) => {
    const hit = match(description, rules);
    return hit ? hit.category : '';
  };

  // What applying the rules to a set of rows would do, as data rather than as a
  // side effect. The API uses it for both the preview and the write, so what the
  // user is shown and what actually happens cannot drift apart.
  //
  // `overwrite` is off by default and deliberately hard to reach: a category the
  // user typed by hand is a decision, and a rule sweeping it away is the kind of
  // data loss that leaves no trace of what was there before.
  function plan(txns, rules, { overwrite = false } = {}) {
    const ordered = sortRules(rules);
    const changes = [];
    for (const t of txns) {
      if (t.category && !overwrite) continue;
      const hit = match(t.description, ordered);
      if (!hit || hit.category === t.category) continue;
      changes.push({ id: t.id, from: t.category || '', to: hit.category, rule_id: hit.id });
    }
    return changes;
  }

  // Dual-environment, the same three lines `web/html.js` ends with: onto
  // the global for the browser's classic scripts, onto module.exports for
  // Node. Everything above stays inside the closure.
  const api = {
    normalise, sortRules, match, categorise, plan,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
