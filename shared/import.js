'use strict';

// What an import concludes from the rows `csv.js` read, and the one rule that
// decides whether a file may be written without asking first.
//
// The import used to show all of it, every time: a column-mapping form, four
// counters, a table of every row, a period selector and a commit button. All
// of that exists to catch a file that parses cleanly and is still wrong — a
// shifted row, an inverted card, a statement that lost lines — and none of it
// needs a person to look at it when nothing is wrong. So the checks still run
// on every file, and a file passes straight through when they all agree. What
// reaches the person is only what a check could not settle:
//
//   unreadable        the mapping read nothing sensible       fix it, or give up
//   refused           rows that would not parse               leave them out
//   repaired          a shifted row put back, unconfirmed     keep, or leave out
//   repair_contradicted  a repair the balance chain disproves leave out, or keep
//   balance_breaks   the file's own running balance breaks   import anyway
//   balance_mismatch  the account will not agree with the     import anyway
//                     statement's last balance afterwards
//   sign_suspect      a card or loan receiving mostly inflows flip, or keep
//
// Everything else — a duplicate, a pending row, a plan's exchange, a total
// line, a repair the balance chain confirmed — is the file behaving normally
// and is reported afterwards, not asked about.
//
// **The gate is the commit's, not the page's.** `/api/import/commit` runs
// `importIssues` over its own reading of the file and refuses while any issue
// is unanswered, so no path to the database can skip it — a page that auto-
// imports is only safe because the server would refuse it if it should not.
// `unreadable` cannot be answered at all; the rest are answered by naming
// their `key` in `accept` — see importIssues for why a key and not a code.
//
// Pure, like the rest of `shared/`: rows in, answer out. The two balances it
// needs are the loader's to fetch, because only the loader can see the book.

(function (root) {
  const NODE = typeof module !== 'undefined' && module.exports;
  const { round2 } = NODE ? require('./currency') : root;
  const { inDateOrder } = NODE ? require('./csv') : root;
  const { LIABILITY_KINDS } = NODE ? require('./kinds') : root;

  // Every status a row can leave markDuplicates with, plus the one a person
  // gives it. All of them are counted, zero or not, so a reader can rely on
  // the key being there.
  const STATUSES = ['new', 'duplicate', 'pending', 'internal', 'summary_line', 'error', 'skipped'];

  // The earliest and latest date any row carries — not only the rows that
  // import. A duplicate is still proof the statement reached that date, and so
  // is a refused row; counting only what landed would shrink the range every
  // time a file overlapped one already imported, which is the normal case.
  function fileSpan(rows) {
    const dates = rows.map((r) => r.date).filter(Boolean).sort();
    return { from: dates[0] || null, to: dates[dates.length - 1] || null };
  }

  // The figure the statement ends on: the latest intact row carrying a
  // balance. A ragged row's balance cell is a fragment of something else.
  function statedBalance(rows) {
    const last = inDateOrder(rows).filter((r) => r.balance !== null && !r.ragged && r.date).pop();
    return last ? { stated: last.balance, stated_on: last.date } : null;
  }

  // Rows the person chose to leave out. Only a row that would otherwise import
  // can be skipped: the rest are already out, for a reason of their own.
  function skipImportRows(rows, lines = []) {
    const skip = new Set(lines.map(Number));
    for (const r of rows) if (r.status === 'new' && skip.has(r.lineNo)) r.status = 'skipped';
    return rows;
  }

  // `before` is the account's balance today and `ledgerOn` its balance on the
  // statement's last balance date, both before this file. The second is what
  // the statement is compared against: comparing today's balance, an older
  // statement imported into an account that already holds later months would
  // never agree, and a check that is wrong whenever a backfill happens is a
  // check people learn to click past.
  function computeImportSummary({ rows, account = null, before = null, ledgerOn = null }) {
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
    const fresh = rows.filter((r) => r.status === 'new');
    const sum = (list) => round2(list.reduce((s, r) => s + r.amount, 0));
    const net = sum(fresh);
    const freshDates = fresh.map((r) => r.date).sort();
    const span = fileSpan(rows);

    const summary = {
      ...counts,
      total: rows.length,
      repaired: rows.filter((r) => r.repaired).length,
      balance_breaks: rows.filter((r) => r.balanceBreak !== undefined).length,
      // A card statement is nearly all charges, so a file that is mostly
      // inflows is almost certainly stating what you owe rather than what the
      // account is worth. Card exports carry no running balance, so this is
      // the only check available — and every row of an inverted file parses
      // perfectly. Bank of America's own CSV needs no flipping even though
      // its web view shows the opposite signs; other issuers differ.
      sign_suspect: !!account && LIABILITY_KINDS.has(account.kind) &&
        fresh.filter((r) => r.amount > 0).length > fresh.filter((r) => r.amount < 0).length,
      net,
      date_min: freshDates[0] || null,
      date_max: freshDates[freshDates.length - 1] || null,
      span_from: span.from,
      span_to: span.to,
    };

    let reconcile = null;
    if (account) {
      const st = statedBalance(rows);
      const ledger = st
        ? round2((ledgerOn || 0) + sum(fresh.filter((r) => r.date <= st.stated_on)))
        : null;
      reconcile = {
        before,
        after: round2((before || 0) + net),
        stated: st ? st.stated : null,
        stated_on: st ? st.stated_on : null,
        // The account on that day once this file is in. `null` throughout when
        // the file states no balance: nothing to compare is not a mismatch.
        ledger,
        matches: st ? Math.abs(ledger - st.stated) < 0.005 : null,
        drift: st ? round2(ledger - st.stated) : null,
      };
    }
    return { summary, reconcile };
  }

  // What has to be answered before this file may be written. Empty means it
  // may go straight in. Nothing new to write means nothing to ask, except
  // that the mapping read nothing at all, which is worth saying either way.
  //
  // Each issue carries a `key`: its code, the rows it names, and the figure it
  // is about. An answer is given to a key, not to a code, so it covers exactly
  // what the person saw — re-read the file with another mapping, skip a row,
  // or let another import land first, and a mismatch of 0.50 that was waved
  // through does not quietly stand for one of 50,000.
  function importIssues({ summary, reconcile, rows, mapping }) {
    const lines = (pred) => rows.filter(pred).map((r) => r.lineNo);
    const issue = (code, extra = {}, detail = '') => ({
      code, acceptable: code !== 'unreadable', ...extra,
      key: [code, (extra.lines || []).join(','), detail].join(':'),
    });
    const read = summary.new + summary.duplicate + summary.pending + summary.internal + summary.skipped;
    // Half or more of the rows refused is the mapping, not the file: a
    // statement with that many broken lines is not one anybody exports. The
    // statement's own summary lines are left out of both sides — they are
    // neither read nor broken.
    if (mapping.dateCol === null || mapping.dateCol === undefined ||
        (summary.error > 0 && summary.error * 2 >= read + summary.error)) {
      return [issue('unreadable', { lines: lines((r) => r.status === 'error') })];
    }
    if (!summary.new) return [];

    const issues = [];
    const refused = lines((r) => r.status === 'error');
    if (refused.length) issues.push(issue('refused', { lines: refused }));

    // A repair folds overflow back into the description and trusts the cells
    // after it. A running balance compared on that row settles it either way:
    // agreeing, it is proof the repair was right and nobody is asked; not
    // agreeing, it is proof the repair produced the wrong amount, which is a
    // different thing to tell a person than "nothing could check this".
    const repairs = rows.filter((r) => r.status === 'new' && r.repaired);
    const unconfirmed = repairs.filter((r) => !r.chained).map((r) => r.lineNo);
    const contradicted = repairs.filter((r) => r.chained && r.balanceBreak !== undefined).map((r) => r.lineNo);
    if (contradicted.length) issues.push(issue('repair_contradicted', { lines: contradicted }));
    if (unconfirmed.length) issues.push(issue('repaired', { lines: unconfirmed }));

    const askedAbout = new Set([...unconfirmed, ...contradicted]);
    const breaks = lines((r) => r.balanceBreak !== undefined && !askedAbout.has(r.lineNo));
    if (breaks.length) issues.push(issue('balance_breaks', { lines: breaks }));

    if (reconcile && reconcile.matches === false) {
      issues.push(issue('balance_mismatch', {}, `${reconcile.stated_on}=${reconcile.stated}/${reconcile.ledger}`));
    }
    if (summary.sign_suspect) {
      const fresh = rows.filter((r) => r.status === 'new');
      issues.push(issue('sign_suspect', {}, `${fresh.filter((r) => r.amount > 0).length}/${fresh.length}`));
    }
    return issues;
  }

  // What each issue is called, wherever it is named: the page's heading for
  // it and the commit's refusal both read this, so the two cannot describe the
  // same problem in different words.
  const IMPORT_ISSUE_TITLES = {
    unreadable: '欄位對應讀不出這個檔案',
    refused: '有幾行讀不出來',
    repaired: '有幾行是自動修復的，沒有餘額能驗證',
    repair_contradicted: '自動修復的行，跟檔案自己的餘額對不上',
    balance_breaks: '檔案自己的餘額欄接不起來',
    balance_mismatch: '匯入後跟對帳單的餘額不一致',
    sign_suspect: '正負號可能是反的',
  };

  // The issues still standing once `accept` (a list of issue keys) is applied.
  function unansweredIssues(issues, accept = []) {
    const yes = new Set(accept);
    return issues.filter((i) => !(i.acceptable && yes.has(i.key)));
  }

  // A request's list of answers or of line numbers: absent is empty, anything
  // but an array is the caller's mistake, reported as such rather than thrown
  // as a TypeError from somewhere inside a Set.
  function importListParam(v, name) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) return { error: `${name} 要是陣列` };
    return v;
  }

  // The commit's refusal, or null when everything has been answered. It
  // names what is open rather than saying "conflict": the usual way here is a
  // page whose preview went stale — another import landed in between — and
  // the answer is to look again.
  function commitRefusal(issues, accept) {
    const open = unansweredIssues(issues, accept);
    return open.length
      ? `這份檔案還有沒確認的問題：${open.map((i) => IMPORT_ISSUE_TITLES[i.code]).join('、')}。重新預覽一次再匯入。`
      : null;
  }

  // A declared period has to contain every row of the file. A row outside it
  // is not a warning, it is proof the declaration is wrong — the wrong period
  // was picked, or this is not the file the user thinks it is — and recording
  // it anyway would have the coverage grid confirm months on the strength of a
  // claim the file contradicts. Returns the refusal, or null.
  function periodProblem({ from, to }, span) {
    if (from > to) return '期間的起日不能晚於迄日';
    if ((span.from && span.from < from) || (span.to && span.to > to)) {
      return `宣告的期間是 ${from} 到 ${to}，但檔案裡有資料列落在期間外（檔案從 ${span.from} 到 ${span.to}）。` +
        '期間填錯了，或這份檔案不是你以為的那一份。';
    }
    return null;
  }

  // Dual-environment, the same three lines `web/html.js` ends with: onto
  // the global for the browser's classic scripts, onto module.exports for
  // Node. Everything above stays inside the closure.
  const api = {
    fileSpan, statedBalance, skipImportRows, computeImportSummary, importIssues, unansweredIssues, commitRefusal,
    periodProblem, importListParam, IMPORT_ISSUE_TITLES,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
