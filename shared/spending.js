'use strict';

// Where the money went: monthly in/out, a breakdown by category, and the
// repeating charges nobody remembers signing up for. Pure — takes rows, returns
// numbers, touches no database — so every rule below is testable as a function.
//
// Two things it inherits from the rest of the ledger and may not soften:
//
// **Per currency, never summed.** USD and TWD do not add without a rate, and a
// headline "you spent 84,000 this month" built from both is an estimate wearing
// a fact's clothes. Same reason netWorth returns one block per currency.
//
// **Transfers are not spending.** Moving your own money between your own
// accounts is neither income nor expense; counting both legs inflates the two
// totals at once and the net still looks right, which is why it survives so
// long unnoticed. A row is excluded if it is in a transfer group or its kind
// says transfer — a manually marked one has the kind and no group.
//
// **Neither is a change in what something is worth.** A `valuation` row moves
// no money at all (see `flow` in shared/kinds.js); counted here, a plan's
// down month would be the largest expense on the page and its up month the
// largest income.

(function (root) {
  const NODE = typeof module !== 'undefined' && module.exports;
  const { normalise } = NODE ? require('./rules') : root;
  const { round2 } = NODE ? require('./currency') : root;
  const { NON_FLOW_KINDS } = NODE ? require('./kinds') : root;

  const isTransfer = (t) => !!t.transfer_group || t.kind === 'transfer';
  const notSpending = (t) => isTransfer(t) || NON_FLOW_KINDS.has(t.kind);

  // Uncategorised is a category, reported alongside the others rather than
  // dropped. Hiding it would make every percentage in the chart wrong in the
  // flattering direction, and the whole point of the rules engine is to make the
  // number visible enough to be worth shrinking.
  const UNCATEGORISED = '';

  function computeSpending({ txns, accounts, from, to }) {
    const currencyOf = new Map(accounts.map((a) => [a.id, a.currency]));
    const cur = {};
    const of = (c) => (cur[c] ||= { months: new Map(), categories: new Map(), income: 0, expense: 0, uncategorised: { total: 0, count: 0 } });

    for (const t of txns) {
      if (notSpending(t)) continue;
      if (t.date < from || t.date > to) continue;
      const c = of(currencyOf.get(t.account_id) || 'TWD');
      const month = t.date.slice(0, 7);
      const m = c.months.get(month) || { month, income: 0, expense: 0 };
      if (t.amount >= 0) {
        m.income += t.amount;
        c.income += t.amount;
      } else {
        // Expenses are accumulated as positive magnitudes. A breakdown is a set
        // of shares of a whole, and a column of negative shares adding to -100%
        // says "this is money you spent" a second time, after the label already
        // did. The sign lives on the totals, not inside them.
        const out = -t.amount;
        m.expense += out;
        c.expense += out;
        const key = t.category || UNCATEGORISED;
        const cat = c.categories.get(key) || { category: key, total: 0, count: 0 };
        cat.total += out;
        cat.count++;
        c.categories.set(key, cat);
        if (key === UNCATEGORISED) {
          c.uncategorised.total += out;
          c.uncategorised.count++;
        }
      }
      c.months.set(month, m);
    }

    const out = {};
    for (const [name, c] of Object.entries(cur)) {
      // Every month in the window, including the ones with nothing in them: a
      // line chart that skips empty months draws a slope between two points that
      // were never adjacent, which reads as a gentle decline rather than as a
      // month where nothing was imported.
      const months = monthsBetween(from.slice(0, 7), to.slice(0, 7)).map((month) => {
        const m = c.months.get(month) || { month, income: 0, expense: 0 };
        return { month, income: round2(m.income), expense: round2(m.expense), net: round2(m.income - m.expense) };
      });
      out[name] = {
        months,
        categories: [...c.categories.values()]
          .map((x) => ({ ...x, total: round2(x.total) }))
          .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category)),
        income: round2(c.income),
        expense: round2(c.expense),
        net: round2(c.income - c.expense),
        uncategorised: { total: round2(c.uncategorised.total), count: c.uncategorised.count },
      };
    }

    return {
      from,
      to,
      currencies: out,
      // Same fixed display order as netWorth: the same column holds the same
      // thing every time, rather than moving when one currency overtakes another.
      order: Object.keys(out).sort((x, y) => {
        const rank = (c) => (c === 'USD' ? 0 : c === 'TWD' ? 1 : 2);
        return rank(x) - rank(y) || out[y].expense - out[x].expense;
      }),
    };
  }

  function monthsBetween(from, to) {
    const out = [];
    let [y, m] = from.split('-').map(Number);
    const [ey, em] = to.split('-').map(Number);
    while (y < ey || (y === ey && m <= em)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return out;
  }

  // Where a window of `years` ending on `date` starts: the same day of the
  // month, counted in UTC, so a year back from 2026-09-25 is 2025-09-25. From
  // 29 February it lands on 1 March, which is Date's answer and the one the
  // windows have always given. The server, the demo and the overview export
  // all reach back with this rather than with three copies of the arithmetic.
  function yearsBefore(date, years = 1) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - years);
    return d.toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------------------
  // Recurring charges
  // ---------------------------------------------------------------------------

  // The bands are wide because real billing is: a monthly subscription lands on
  // the 3rd, then the 5th because the 3rd was a Sunday, then the 2nd. Narrow
  // bands would miss those and report nothing, which is the failure mode that
  // makes a feature like this get ignored.
  //
  // `label` is what the spending page and the overview export both call it.
  const CADENCES = [
    { name: 'weekly',    label: '每週', per_year: 52, min: 5,   max: 9 },
    { name: 'monthly',   label: '每月', per_year: 12, min: 24,  max: 38 },
    { name: 'quarterly', label: '每季', per_year: 4,  min: 80,  max: 100 },
    { name: 'yearly',    label: '每年', per_year: 1,  min: 330, max: 400 },
  ];

  const MIN_OCCURRENCES = 3;
  // Two points make a line through anything; three is the first count that can
  // disagree with itself. Below that every pair of identical amounts a month
  // apart would be announced as a subscription.

  // How much the amounts may wander and still be the same charge. A utility bill
  // moves with the weather and a subscription moves with the exchange rate, so
  // this is loose on purpose — and the caller gets the min and max back so the
  // user judges rather than the code pretending to.
  const AMOUNT_TOLERANCE = 0.25;

  function computeRecurring({ txns, accounts, to, minOccurrences = MIN_OCCURRENCES }) {
    const currencyOf = new Map(accounts.map((a) => [a.id, a.currency]));
    const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
    const groups = new Map();

    for (const t of txns) {
      if (notSpending(t) || t.amount >= 0) continue;
      const key = normalise(t.description);
      if (!key) continue;
      const id = `${t.account_id}\u0000${key}`;
      if (!groups.has(id)) {
        groups.set(id, { account_id: t.account_id, key, label: t.description, rows: [] });
      }
      groups.get(id).rows.push(t);
    }

    const found = [];
    for (const g of groups.values()) {
      if (g.rows.length < minOccurrences) continue;
      const rows = [...g.rows].sort((a, b) => a.date.localeCompare(b.date));

      const gaps = [];
      for (let i = 1; i < rows.length; i++) gaps.push(daysBetween(rows[i - 1].date, rows[i].date));
      const medianGap = median(gaps);
      const cadence = CADENCES.find((c) => medianGap >= c.min && medianGap <= c.max);
      if (!cadence) continue;
      // Most of the gaps, not all of them: one missed month — a card replaced, a
      // statement not yet imported — is the ordinary case, and refusing the whole
      // series over it would drop exactly the subscriptions worth noticing.
      const onBeat = gaps.filter((d) => d >= cadence.min && d <= cadence.max).length;
      if (onBeat / gaps.length < 0.7) continue;

      const amounts = rows.map((r) => -r.amount);
      const mid = median(amounts);
      const lo = Math.min(...amounts);
      const hi = Math.max(...amounts);
      if (mid <= 0 || (hi - lo) / mid > AMOUNT_TOLERANCE * 2) continue;

      const last = rows[rows.length - 1].date;
      found.push({
        account_id: g.account_id,
        account_name: nameOf.get(g.account_id) || '',
        currency: currencyOf.get(g.account_id) || 'TWD',
        // The most recent spelling, not the first: banks rewrite merchant
        // strings, and the one the user will see on their next statement is the
        // one they can recognise.
        label: rows[rows.length - 1].description,
        category: rows[rows.length - 1].category || '',
        cadence: cadence.name,
        occurrences: rows.length,
        median_amount: round2(mid),
        min_amount: round2(lo),
        max_amount: round2(hi),
        first: rows[0].date,
        last,
        next_expected: addDays(last, Math.round(medianGap)),
        // Normalised so a yearly charge and a monthly one can be compared and
        // added. Per currency only — see the header.
        monthly_equivalent: round2((mid * cadence.per_year) / 12),
        // Still charging, or did it stop? A cancelled subscription should drop
        // off the list rather than pad the monthly total forever.
        active: daysBetween(last, to) <= cadence.max * 1.5,
      });
    }

    found.sort((a, b) => Number(b.active) - Number(a.active) || b.monthly_equivalent - a.monthly_equivalent);

    const monthly = {};
    for (const r of found) {
      if (!r.active) continue;
      monthly[r.currency] = round2((monthly[r.currency] || 0) + r.monthly_equivalent);
    }
    return { items: found, monthly_total: monthly };
  }

  function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

  function addDays(date, n) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Dual-environment, the same three lines `web/html.js` ends with: onto
  // the global for the browser's classic scripts, onto module.exports for
  // Node. Everything above stays inside the closure.
  const api = {
    computeSpending, computeRecurring, monthsBetween, yearsBefore, CADENCES,
    MIN_OCCURRENCES, UNCATEGORISED,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
