'use strict';

// The half of the money logic that is only arithmetic.
//
// Rows in, answer out: no database, no filesystem, no clock beyond a date the
// caller passed in. That is what lets it load in a browser as a classic
// script and in Node as a require, from one copy — see `shared/sha1.js` for
// why there is a `shared/` at all.
//
// `server/money.js` is the other half: it runs the queries and calls these.
// The two are kept apart by name — everything here is `compute*` or a plain
// helper — and by `test/money.test.js`, which fails if anything here reaches
// for `db` and if a `compute*` turns up with no loader of its own.

(function (root) {
  // Same two-environment require as `shared/csv.js` uses for sha1: a module in
  // Node, a global the browser already loaded in index.html's order.
  const NODE = typeof module !== 'undefined' && module.exports;
  const { LIABILITY_KINDS, NO_STATEMENT_KINDS } = NODE ? require('./kinds') : root;
  const { round2, roundTo } = NODE ? require('./currency') : root;

  // Every snapshot converts with the rate that was true on its own date, so
  // looking back at last year does not get re-priced at today's rate. Rows must
  // arrive sorted by date; the lookup binary-searches them.
  function computeFxLookup({ rows }) {
    return {
      rows,
      on(date) {
        if (!rows.length) return null;
        let lo = 0, hi = rows.length - 1, found = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (rows[mid].date <= date) { found = rows[mid]; lo = mid + 1; }
          else hi = mid - 1;
        }
        // A date earlier than every stored rate falls back to the earliest one
        // rather than returning nothing, so a transfer dated before the first
        // rate is still comparable.
        return (found || rows[0]).rate;
      },
    };
  }

  // Prices, keyed by (symbol, market): one binary-searched series per security,
  // the same shape computeFxLookup gives a currency pair. The one deliberate
  // difference is at the near edge — before a symbol's first observation this
  // returns null, where fx drags its earliest rate backward. fx falls back so a
  // transfer dated before the first rate stays comparable; a holding has no
  // market value on a day nobody priced it, and inventing one by reaching back
  // is the same fiction the net-worth series refuses to draw. Rows arrive
  // sorted by date within a symbol — the loader orders them, the tests build
  // them so — and `on` returns the observation row (not just the number) so the
  // caller can show which day the price is from.
  function computePriceLookup({ rows }) {
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.symbol}|${r.market}`;
      let arr = groups.get(k);
      if (!arr) groups.set(k, (arr = []));
      arr.push(r);
    }
    return {
      rows,
      on(symbol, market, date) {
        const arr = groups.get(`${symbol}|${market}`);
        if (!arr || !arr.length) return null;
        let lo = 0, hi = arr.length - 1, found = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (arr[mid].date <= date) { found = arr[mid]; lo = mid + 1; }
          else hi = mid - 1;
        }
        return found;
      },
    };
  }

  function convert(amount, from, to, date, fx) {
    if (from === to) return amount;
    const rate = fx.on(date);
    if (rate === null) return null;
    if (from === 'USD' && to === 'TWD') return amount * rate;
    if (from === 'TWD' && to === 'USD') return amount / rate;
    return null;
  }

  // `totals` is one row per account that has any, `{ account_id, total }`; an
  // account missing from it simply has no transactions yet. The date cutoff is
  // the loader's business — by the time the rows are here they are already the
  // ones that count.
  function computeAccountsWithBalances({ accounts, totals }) {
    const sums = new Map(totals.map((r) => [r.account_id, r.total || 0]));
    return accounts.map((a) => ({
      ...a,
      balance: round2((a.opening_balance || 0) + (sums.get(a.id) || 0)),
    }));
  }

  function computeHoldingsValued({
    holdings,
    priceLookup = computePriceLookup({ rows: [] }),
    asOf = todayISO(),
  }) {
    return holdings.map((h) => {
      // The current price is the latest observation at or before asOf. A
      // holding with no history yet falls back to its stored last_price — the
      // column the prices table has otherwise superseded — and a brand-new
      // position with neither values at zero rather than NaN. `last_price` and
      // `price_date` are overwritten with what was actually used, so the view
      // shows the effective price and the day it is from, not a stale column.
      const obs = priceLookup.on(h.symbol, h.market, asOf);
      const price = obs ? obs.price : (h.last_price || 0);
      const marketValue = round2(h.shares * price);
      const cost = round2(h.shares * h.avg_cost);
      return {
        ...h,
        last_price: price,
        price_date: obs ? obs.date : h.price_date,
        market_value: marketValue,
        cost_total: cost,
        unrealized: round2(marketValue - cost),
        // Zero cost is not a 0% return, it is a return with no denominator —
        // a gift or a spin-off. Reported as 0 rather than Infinity.
        roi_pct: cost > 0 ? round2(((marketValue - cost) / cost) * 100) : 0,
      };
    });
  }

  // Reported per currency, never converted. A statement says 58,420.15 USD and
  // that is what the ledger says back; folding it into TWD at some rate turns a
  // fact into an estimate, and an estimate that silently changes whenever a rate
  // is added. The cost is real and worth naming: **there is no single net worth
  // figure** once more than one currency is held, because there isn't one —
  // USD and TWD do not add up without a rate, and inventing one to make a
  // headline number look tidy is exactly the sort of quiet fiction this ledger
  // exists to avoid. FX rates still exist; they just no longer touch anything
  // being reported. See findTransferCandidates for the one place they remain.
  // Takes accounts that already carry a `balance` and holdings that already
  // carry a `market_value` — the output of the two compute* above, not raw rows.
  //
  // `unvested` is subtracted here and nowhere earlier. It is part of the
  // balance the statement states, and the balance has to stay that figure or
  // every balance check against the statement disagrees by exactly the
  // unvested amount; it is not part of what you own, so the total leaves it
  // out. It gets its own breakdown row rather than coming off its account's
  // kind, because a plan held entirely in funds has a cash balance of zero
  // and would show a negative 退休金 row.
  function computeNetWorth({ accounts, holdings, asOf = todayISO() }) {
    const currencies = {};
    const of = (cur) => (currencies[cur] ||= { ledger: 0, securities: 0, unvested: 0, total: 0, by_kind: {} });

    for (const a of accounts) {
      const c = of(a.currency);
      c.ledger = round2(c.ledger + a.balance);
      c.by_kind[a.kind] = round2((c.by_kind[a.kind] || 0) + a.balance);
      if (a.unvested) c.unvested = round2(c.unvested + a.unvested);
    }
    for (const h of holdings) {
      const c = of(h.currency);
      c.securities = round2(c.securities + h.market_value);
    }
    for (const c of Object.values(currencies)) {
      c.total = round2(c.ledger + c.securities - c.unvested);
      if (c.securities) c.by_kind.securities = c.securities;
      if (c.unvested) c.by_kind.unvested = -c.unvested;
    }

    return {
      as_of: asOf,
      currencies,
      // A fixed display preference, not a statement about size: USD leads, then
      // TWD, then anything else by magnitude. Ordering by amount put whichever
      // currency happened to be larger on the left and moved it as balances
      // changed, which is the opposite of what a dashboard you read every day
      // wants — the same column should hold the same thing every time.
      order: Object.keys(currencies).sort((x, y) => {
        const rank = (c) => (c === 'USD' ? 0 : c === 'TWD' ? 1 : 2);
        return rank(x) - rank(y) || Math.abs(currencies[y].total) - Math.abs(currencies[x].total);
      }),
    };
  }

  // Ledger only — holdings have no price history in phase 1, so folding today's
  // market value into past points would draw a line that never existed.
  // `txns` must be sorted by date and already cut off at `to`; the walk below
  // consumes them in one pass rather than re-filtering per month.
  function computeNetWorthSeries({ accounts, txns, from, to }) {
    if (!accounts.length) return [];

    const bal = new Map(accounts.map((a) => [a.id, a.opening_balance || 0]));
    const meta = new Map(accounts.map((a) => [a.id, a]));

    const dates = monthEnds(from, to);
    // One series per currency, because a chart that adds USD to TWD without a
    // rate is drawing a number nobody holds.
    const series = {};
    let i = 0;

    for (const d of dates) {
      while (i < txns.length && txns[i].date <= d) {
        const t = txns[i++];
        if (bal.has(t.account_id)) bal.set(t.account_id, bal.get(t.account_id) + t.amount);
      }
      const totals = {};
      for (const [id, v] of bal) {
        const a = meta.get(id);
        // An account contributes nothing before it existed. `opening_balance`
        // is what the account held *on* `opening_date`, so carrying it back to
        // the start of the chart draws months of a balance nobody had — and
        // because every account does it at once, the line comes out flat at
        // today's total and then starts moving, which reads as a ledger that
        // was complete all along. `opening_date` was already being selected
        // for this and simply never consulted.
        if (a.opening_date && d < a.opening_date) continue;
        totals[a.currency] = (totals[a.currency] || 0) + v;
      }
      for (const [cur, v] of Object.entries(totals)) {
        (series[cur] ||= []).push({ date: d, value: round2(v) });
      }
    }
    return series;
  }

  function monthEnds(from, to) {
    const out = [];
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    let y = start.getUTCFullYear();
    let m = start.getUTCMonth();
    for (;;) {
      const last = new Date(Date.UTC(y, m + 1, 0));
      if (last > end) break;
      out.push(last.toISOString().slice(0, 10));
      m++;
      if (m > 11) { m = 0; y++; }
    }
    const toIso = end.toISOString().slice(0, 10);
    if (!out.length || out[out.length - 1] !== toIso) out.push(toIso);
    return out;
  }

  // Every other number in this file is computed as if the ledger were complete.
  // It is not. A CSV ledger holds exactly the months somebody remembered to
  // download, and **a month nobody downloaded looks precisely like a month
  // nothing happened in** — same empty result, same clean balance, no error
  // anywhere. Balances, net worth and the series cannot tell those two apart and
  // never will, because the difference is not in the data. So this is the one
  // thing here whose job is to report where the ledger does not know.
  //
  // A month with no rows is still not automatically a hole, which is why `quiet`
  // is its own state rather than a softer shade of `gap`. An account can sit
  // idle for a year, and a balance check standing in that month is the
  // institution agreeing with the ledger on that date — a stronger statement
  // than a row would have been, not a weaker one. Only a month with neither rows
  // nor a check counts against you. That keeps the warning honest: confirming a
  // quiet month is something the user can actually do, rather than a red square
  // they have no way to clear and therefore learn to ignore.
  const COVERAGE_MONTHS = 24;

  function monthAdd(month, delta) {
    const [y, m] = month.split('-').map(Number);
    const t = y * 12 + (m - 1) + delta;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  }

  function monthsEnding(last, n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) out.push(monthAdd(last, -i));
    return out;
  }

  const lastDayOf = (month) => {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  };

  // Which months a set of imported statements covers *completely*. Two imports
  // that meet — one ending 06-30, the next starting 07-01 — cover July together
  // and neither covers it alone, so the spans are merged before anything is
  // asked of them. Adjacent counts as overlapping for that reason.
  //
  // Only whole months count. A statement starting on the 12th says nothing about
  // the first eleven days: the file has no rows there, and no rows is exactly
  // what a month with no spending also looks like. Claiming that month as
  // covered would be inventing the one fact this whole grid exists to avoid
  // inventing.
  function mergeSpans(spans) {
    const clean = spans
      .filter((s) => s.date_from && s.date_to)
      .map((s) => ({ from: s.date_from, to: s.date_to }))
      .sort((a, b) => a.from.localeCompare(b.from));

    const merged = [];
    for (const s of clean) {
      const prev = merged[merged.length - 1];
      if (prev && s.from <= nextDay(prev.to)) {
        if (s.to > prev.to) prev.to = s.to;
      } else {
        merged.push({ ...s });
      }
    }
    return merged;
  }

  // Two answers, because the two kinds of range may be trusted differently.
  //
  // `full` — months a statement demonstrably spans end to end. Any range counts
  // here, declared or derived, because covering a whole month is a claim either
  // can support.
  //
  // `partial` — months a **declared** range reaches into without covering. Only
  // declared ranges, and this is the whole reason `period_kind` exists. A
  // derived range's edges are an artefact of where the rows happen to start: a
  // file whose first row is the 12th says nothing about the first eleven days,
  // since a file with no rows there is exactly what a quiet fortnight looks
  // like. A declared range's edges are a fact the user supplied — the bank's
  // download page asked them to pick a statement or a year, and they know which
  // one they clicked.
  function coverageOf(spans, axis) {
    const all = mergeSpans(spans);
    const declared = mergeSpans(spans.filter((s) => s.period_kind === 'declared'));

    const full = new Set();
    const partial = new Set();
    for (const m of axis) {
      const start = `${m}-01`;
      const end = lastDayOf(m);
      if (all.some((s) => s.from <= start && s.to >= end)) full.add(m);
      else if (declared.some((s) => s.from <= end && s.to >= start)) partial.add(m);
    }
    return { full, partial };
  }

  function nextDay(date) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  // Pure: takes the rows and returns the grid, so the states can be tested
  // without a database or a server. `coverage()` below is the thin loader.
  function computeCoverage({ accounts, activity, checks, imports = [], to = todayISO(), months = COVERAGE_MONTHS }) {
    const axis = monthsEnding(to.slice(0, 7), Math.max(1, months));
    const first = axis[0];
    const last = axis[axis.length - 1];

    const act = new Map();
    for (const r of activity) {
      if (!act.has(r.account_id)) act.set(r.account_id, new Map());
      act.get(r.account_id).set(r.month, r);
    }
    // One month can hold several checks. A single one that disagrees is the
    // interesting fact, so `off` wins over `ok` regardless of arrival order.
    const chk = new Map();
    for (const c of checks) {
      const m = c.date.slice(0, 7);
      if (!chk.has(c.account_id)) chk.set(c.account_id, new Map());
      const seen = chk.get(c.account_id).get(m);
      chk.get(c.account_id).set(m, seen === 'off' || !c.ok ? 'off' : 'ok');
    }

    const spans = new Map();
    for (const i of imports) {
      if (!spans.has(i.account_id)) spans.set(i.account_id, []);
      spans.get(i.account_id).push(i);
    }

    // An account whose kind has no statement to import is left out of the
    // grid and every count, and named instead, so the page can say where it
    // went rather than let it silently vanish. Its value is typed in by hand
    // and only the latest figure matters: there is no month it could be
    // incomplete about, and a row of gaps nobody can close is the kind of
    // warning that teaches people to stop reading the page.
    const manual = accounts
      .filter((a) => NO_STATEMENT_KINDS.has(a.kind))
      .map((a) => ({ id: a.id, name: a.name, kind: a.kind }));

    const rows = accounts.filter((a) => !NO_STATEMENT_KINDS.has(a.kind)).map((a) => {
      const mine = act.get(a.id) || new Map();
      const checked = chk.get(a.id) || new Map();
      const covered = coverageOf(spans.get(a.id) || [], axis);
      // Before the account existed there is nothing to have downloaded, and a
      // closed account stops being anyone's problem after its last sign of life.
      // Both read as `outside`: not covered, and not a reproach either.
      const opened = String(a.opening_date || first).slice(0, 7);
      const start = opened > first ? opened : first;
      const lastSeen = [...mine.keys(), ...checked.keys()].sort().pop() || null;
      const end = a.is_active || !lastSeen || lastSeen > last ? last : lastSeen;

      const cells = axis.map((m) => {
        if (m < start || m > end) {
          return { month: m, state: 'outside', txns: 0, net: 0, check: null, reason: null };
        }
        const row = mine.get(m);
        const check = checked.get(m) || null;
        // A statement that spans the whole month and carries no rows for it is
        // the same statement as one carrying rows: the bank was asked and said
        // nothing happened. Before imports recorded their span, that month was
        // indistinguishable from one nobody downloaded, so an idle account
        // collected red squares whose only remedy was typing a balance check
        // for each of them — a warning nobody can clear is a warning everyone
        // learns to scroll past.
        //
        // A check still outranks a span as the stated reason: the institution
        // put a number on it, which is the stronger of the two claims.
        //
        // `partial` is the one state that needs a declared period to exist at
        // all. It says the ledger knows part of this month and knows it does
        // not know the rest — which is different from both "confirmed" and
        // "nothing here", and was unreachable while a range could only be
        // inferred from the rows.
        const spanned = covered.full.has(m);
        const part = !spanned && covered.partial.has(m);
        const settled = check === 'ok' || spanned;

        let state;
        let reason = null;
        if (settled) {
          state = row ? 'data' : 'quiet';
          if (!row) reason = check === 'ok' ? 'check' : 'import';
        } else if (part) {
          state = 'partial';
        } else if (row) {
          state = 'data';
        } else if (check) {
          // Somebody looked and the number disagreed. Still not a gap: the
          // month was examined, and the leading bar says how it went.
          state = 'quiet';
          reason = 'check';
        } else {
          state = 'gap';
        }

        return {
          month: m,
          state,
          txns: row ? row.n : 0,
          net: row ? round2(row.net || 0) : 0,
          check,
          reason,
        };
      });

      // The headline number: how many months back the ledger stops knowing
      // anything. "Last imported in March" is what sends someone to download a
      // statement; a total gap count spread over two years does not.
      let trailing = 0;
      for (let i = cells.length - 1; i >= 0 && cells[i].state === 'gap'; i--) trailing++;

      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        currency: a.currency,
        is_active: !!a.is_active,
        cells,
        expected: cells.filter((c) => c.state !== 'outside').length,
        // `gaps` stays strictly the months nothing is known about. A partly
        // covered month is a different, smaller problem and gets its own count
        // rather than being folded in — otherwise declaring a period, which
        // adds information, would make the headline number go up.
        gaps: cells.filter((c) => c.state === 'gap').length,
        partials: cells.filter((c) => c.state === 'partial').length,
        trailing_gap: trailing,
        last_data: [...mine.keys()].sort().pop() || null,
      };
    });

    return {
      months: axis,
      accounts: rows,
      manual,
      summary: {
        expected: rows.reduce((n, r) => n + r.expected, 0),
        gaps: rows.reduce((n, r) => n + r.gaps, 0),
        partials: rows.reduce((n, r) => n + r.partials, 0),
        accounts_with_gaps: rows.filter((r) => r.gaps > 0).length,
        stale: rows
          .filter((r) => r.trailing_gap > 0)
          .sort((x, y) => y.trailing_gap - x.trailing_gap || x.name.localeCompare(y.name))
          .map((r) => ({ id: r.id, name: r.name, trailing_gap: r.trailing_gap, last_data: r.last_data })),
      },
    };
  }

  // One sign convention for everything: a balance is what the account is worth
  // to you. A credit card you owe 1,234 on is worth -1,234, so net worth is a
  // plain sum and never has to know what kind of account it is adding.
  //
  // The cost is that `opening_balance` for a card has to be entered negative,
  // which is not what a statement shows. Getting it backwards is the same shape
  // of bug as a shifted CSV row: a plausible number, a plausible total, and
  // nothing anywhere that says the net worth is out by twice the balance. So it
  // is surfaced rather than assumed — and not refused, because a genuinely
  // overpaid card really is a positive balance.
  //
  // Which kinds those are comes from `shared/kinds.js`, and is re-exported
  // below so every caller that already reads it from here keeps working. The
  // sign convention is a property of the kind, not of this file.

  // Takes an already-computed list so /api/overview does not walk every account
  // a second time inside the same request. The overstatement is quoted in the
  // account's own currency, which is now also the currency its total is reported
  // in, so there is nothing left for the reader to convert.
  function liabilitiesInCredit(accounts) {
    return accounts
      .filter((a) => LIABILITY_KINDS.has(a.kind) && a.balance > 0)
      .map((a) => ({ id: a.id, name: a.name, kind: a.kind, currency: a.currency, balance: a.balance }));
  }

  // A CSV import that silently dropped rows is invisible until the computed
  // balance is held against what the institution actually says.
  //
  // Each check arrives carrying `txn_total`: everything posted to its account up
  // to and including its own date. Summing is the loader's job. What is here is
  // the part that can be wrong in an interesting way — opening balance plus
  // movement against what the institution says, with a cent of tolerance so
  // float noise does not read as drift. `txn_total` is an input rather than part
  // of the answer, so it is destructured away instead of spread back out and the
  // shape `/api/reconcile` returns is unchanged.
  function computeReconcile({ checks }) {
    return checks.map(({ txn_total, ...c }) => {
      const computed = round2((c.opening_balance || 0) + (txn_total || 0));
      const diff = round2(c.stated - computed);
      return {
        ...c,
        computed,
        diff,
        ok: Math.abs(diff) < 0.01,
      };
    });
  }

  // Moving your own money between your own accounts is not income or expense.
  // Pair the two legs so reports stop double counting it.
  // `rows` are the unpaired transactions, each carrying its account's currency.
  // `fx` is the lookup from computeFxLookup — the last place a rate is used, and
  // for a different job: deciding whether two rows are the same transfer, not
  // restating what either one is worth. Nothing converted here reaches a balance
  // or a total. Without it, moving money between a TWD and a USD account simply
  // cannot be recognised and both legs go on counting as income and expense.
  function computeTransferCandidates({ rows, fx, windowDays = 3, tolerancePct = 1.5 }) {
    const outs = rows.filter((r) => r.amount < 0);
    const ins = rows.filter((r) => r.amount > 0);
    const used = new Set();
    const pairs = [];

    for (const o of outs) {
      if (used.has(o.id)) continue;
      let best = null;
      for (const n of ins) {
        if (used.has(n.id) || n.account_id === o.account_id) continue;
        const dayGap = Math.abs(daysBetween(o.date, n.date));
        if (dayGap > windowDays) continue;

        const outAbs = Math.abs(o.amount);
        let cmp = n.amount;
        if (o.currency !== n.currency) {
          const c = convert(n.amount, n.currency, o.currency, n.date, fx);
          if (c === null) continue;
          cmp = c;
        }
        const diffPct = (Math.abs(cmp - outAbs) / Math.max(outAbs, 1)) * 100;
        if (diffPct > tolerancePct) continue;

        const score = dayGap * 10 + diffPct;
        if (!best || score < best.score) best = { score, n, dayGap, diffPct };
      }
      if (best) {
        used.add(o.id);
        used.add(best.n.id);
        pairs.push({
          out: o,
          in: best.n,
          day_gap: best.dayGap,
          diff_pct: round2(best.diffPct),
          cross_currency: o.currency !== best.n.currency,
        });
      }
    }
    return pairs;
  }

  function daysBetween(a, b) {
    return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  // Dual-environment, the same three lines `web/html.js` ends with: onto the
  // global for the browser's classic scripts, onto module.exports for Node.
  const api = {
    round2, convert, monthEnds, monthAdd, monthsEnding, daysBetween, todayISO,
    computeFxLookup, computePriceLookup, computeAccountsWithBalances, computeHoldingsValued,
    computeNetWorth, computeNetWorthSeries, computeCoverage, mergeSpans, coverageOf,
    computeReconcile,
    computeTransferCandidates, liabilitiesInCredit,
    LIABILITY_KINDS, COVERAGE_MONTHS,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
