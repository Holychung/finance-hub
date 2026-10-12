'use strict';

// 月度審計: one month of the ledger read the way its owner would read a
// statement they distrust — charged twice, a subscription that went up, one
// that was cancelled and still charges, a category far above its usual, a
// purchase larger than anything in half a year, a fee. Pure: rows in,
// findings out, no database and no clock beyond the `today` passed in. No AI
// either — every finding is a rule that can be read here and checked by hand,
// so it works the same in every AI mode, 晴天 included.
//
// Three things it inherits and may not soften:
//
// **It never concludes, it points.** Two coffees on one day are two coffees.
// Every finding names its rows and its evidence and is a question for a person;
// "沒問題" is an answer the page records, never one the code assumes. So the
// rules lean towards asking: a missed finding is money nobody looks at, an
// extra one is a click.
//
// **Per currency, never summed**, and a currency is judged against its own
// history only. Same reason as everywhere else: nothing here has a rate.
//
// **A month with no data is unknown, not quiet.** Every comparison with the
// past needs past months that actually hold spending; with too few, the rule
// stays silent rather than calling everything new or everything large.

(function (root) {
  const NODE = typeof module !== 'undefined' && module.exports;
  const { normalise } = NODE ? require('./rules') : root;
  const { round2, money } = NODE ? require('./currency') : root;
  const { computeRecurring, computeSpending, notSpending, monthsBetween, MIN_OCCURRENCES, CADENCES } =
    NODE ? require('./spending') : root;
  const { parseDate } = NODE ? require('./csv') : root;

  // A charge and its twin: same account, same merchant, same amount, at most
  // this many days apart. Banks post a double charge on the same day or the
  // next; further apart it is more often two real purchases.
  const DUPLICATE_DAYS = 1;
  // A merchant repeated on one day this many times in the year before is a
  // habit — the café on the way to work — and its pairs are not asked about.
  const HABIT_PAIRS = 2;
  // A twin refunded in full within this many days was a double charge the
  // bank already undid.
  const REFUND_DAYS = 30;
  // A category this many times its usual month, and at least this share of
  // the month's spending: half again, and big enough to move the month.
  const SPIKE_RATIO = 1.5;
  const SPIKE_SHARE = 0.1;
  // How many earlier months a comparison wants, and how many of them must
  // hold any spending at all before it says anything.
  const BASELINE_MONTHS = 3;
  const LARGE_LOOKBACK = 6;
  // Larger than anything in the half year by this factor: two dollars over
  // last month's biggest grocery run is the same grocery run.
  const LARGE_RATIO = 2;
  const MIN_HISTORY = 2;

  // Words that positively say "this is a fee". English ones match whole words
  // only — `fee` must not find COFFEE — and CJK ones anywhere, because 手續費
  // is written inside longer strings with no spaces. A `fee` kind counts too.
  const FEE_WORDS = {
    cjk: ['手續費', '年費', '利息', '循環', '違約金', '滯納', '遲繳', '跨行', '匯費', '服務費', '管理費'],
    en: ['fee', 'fees', 'interest', 'late charge', 'overdraft', 'finance charge', 'service charge', 'annual fee', 'foreign transaction'],
  };

  // What the page calls each kind, and how loud it is. `warn` is money that may
  // have gone where it should not; `note` is worth a look.
  const KINDS = {
    duplicate:  { label: '可能重複扣款', severity: 'warn' },
    double:     { label: '一期扣了兩次', severity: 'warn' },
    cancelled:  { label: '取消了還在扣', severity: 'warn' },
    price_up:   { label: '固定扣款漲價', severity: 'note' },
    new_series: { label: '新的固定扣款', severity: 'note' },
    spike:      { label: '分類比平常高很多', severity: 'note' },
    large:      { label: '大額支出', severity: 'note' },
    fee:        { label: '手續費或利息', severity: 'note' },
  };
  const KIND_ORDER = Object.keys(KINDS);

  // Buying a security or a currency moves money into something you still own:
  // it is not consumption, and two purchases of one fund on one day are two
  // lots, not a double charge. Left out of every rule but the fee check —
  // a trade's own commission is still a fee.
  const NOT_CONSUMPTION = new Set(['trade', 'fx']);

  // One merchant on one account, the way computeRecurring groups a series.
  const seriesKey = (t) => `${t.account_id}|${normalise(t.description)}`;
  const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  const lastDayOf = (month) => {
    const [y, m] = month.split('-').map(Number);
    return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  };
  const shiftMonth = (month, n) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  };

  function isFee(t) {
    if (t.kind === 'fee') return true;
    const norm = normalise(t.description);
    if (FEE_WORDS.cjk.some((w) => norm.includes(w))) return true;
    const padded = ` ${norm} `;
    return FEE_WORDS.en.some((w) => padded.includes(` ${w} `));
  }

  // `ok` is the finding keys somebody answered 沒問題; `cancelled` maps a
  // series key to the day it was marked cancelled. Both are the owner's
  // answers, kept by the caller — this only reads them.
  //
  // `unpaired` is the ids of rows that look like one leg of a transfer between
  // the owner's own accounts and have not been paired yet (the transfer
  // candidates). They are left out of every rule and counted instead: paired,
  // they are not spending at all, and unpaired they are the month's largest
  // "purchases" — a finding about bookkeeping wearing a finding about money.
  function computeAudit({ txns, accounts, month, today, ok = [], cancelled = {}, unpaired = [] }) {
    const from = `${month}-01`;
    const last = lastDayOf(month);
    const to = last < today ? last : today;
    const running = today.slice(0, 7) === month;
    const future = month > today.slice(0, 7);
    const currencyOf = new Map(accounts.map((a) => [a.id, a.currency]));
    const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
    const okSet = new Set(ok);
    const findings = [];

    const pending = new Set(unpaired);
    const moving = txns.filter((t) => !notSpending(t) && !pending.has(t.id) && t.date <= to);
    const flows = moving.filter((t) => !NOT_CONSUMPTION.has(t.kind));
    const expenses = flows.filter((t) => t.amount < 0);
    const inMonth = (t) => t.date >= from && t.date <= to;
    const currency = (t) => currencyOf.get(t.account_id) || 'TWD';
    const out = (t) => round2(-t.amount);
    const shown = (n, cur) => money(n, cur);
    const row = (t) => ({ id: t.id, date: t.date, amount: t.amount, description: t.description, category: t.category || '' });

    const add = (kind, key, t, fields) => {
      if (findings.some((f) => f.key === key)) return;
      findings.push({
        key,
        kind,
        label: KINDS[kind].label,
        severity: KINDS[kind].severity,
        currency: fields.currency || currency(t),
        account_id: t ? t.account_id : null,
        account_name: t ? nameOf.get(t.account_id) || '' : '',
        ok: okSet.has(key),
        ...fields,
      });
    };

    // Every series of one merchant on one account, oldest first: the twins,
    // the price changes and the cancelled ones all read from these.
    const series = new Map();
    for (const t of expenses) {
      if (!normalise(t.description)) continue;
      const k = seriesKey(t);
      if (!series.has(k)) series.set(k, []);
      series.get(k).push(t);
    }
    for (const rows of series.values()) rows.sort((a, b) => a.date.localeCompare(b.date) || (a.id || 0) - (b.id || 0));

    // --- charged twice ---------------------------------------------------------
    const yearBefore = shiftMonth(month, -12);
    const twins = new Set();
    for (const rows of series.values()) {
      const pairs = [];
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1];
        const b = rows[i];
        if (a.amount.toFixed(2) === b.amount.toFixed(2) && daysBetween(a.date, b.date) <= DUPLICATE_DAYS) pairs.push([a, b]);
      }
      const habit = pairs.filter(([, b]) => b.date >= `${yearBefore}-01` && b.date < from).length >= HABIT_PAIRS;
      if (habit) continue;
      for (const [a, b] of pairs) {
        if (!inMonth(b)) continue;
        const refunded = flows.some((r) => r.account_id === b.account_id && r.amount > 0
          && r.amount.toFixed(2) === (-b.amount).toFixed(2)
          && r.date >= b.date && daysBetween(b.date, r.date) <= REFUND_DAYS);
        if (refunded) continue;
        twins.add(a.id).add(b.id);
        add('duplicate', `duplicate|${a.id}|${b.id}`, b, {
          amount: out(b),
          detail: `${a.date} 和 ${b.date} 各扣了一次，商家和金額都一樣。對一下帳單：是兩筆真的消費，還是同一筆被扣了兩次。`,
          rows: [row(a), row(b)],
        });
      }
    }

    // --- the recurring charges -------------------------------------------------
    // Over everything up to the month's end, so a series that became one this
    // month is found, and judged against what it was before.
    const recurring = computeRecurring({ txns: flows, accounts, to }).items;
    const cadenceOf = new Map(CADENCES.map((c) => [c.name, c]));
    for (const item of recurring) {
      const k = `${item.account_id}|${item.key}`;
      const rows = series.get(k) || [];
      const here = rows.filter(inMonth);
      if (!here.length) continue;
      const before = rows.filter((t) => t.date < from);
      const cadence = cadenceOf.get(item.cadence);

      // Two charges in less than half a cycle: one period billed twice. The
      // same-day twins above already asked about their pair.
      if (cadence.name !== 'weekly') {
        for (let i = 1; i < here.length; i++) {
          const a = here[i - 1];
          const b = here[i];
          if (twins.has(b.id)) continue;
          if (daysBetween(a.date, b.date) < cadence.min / 2) {
            add('double', `double|${a.id}|${b.id}`, b, {
              amount: out(b),
              detail: `這是${cadence.label}的固定扣款，${a.date} 和 ${b.date} 卻相隔 ${daysBetween(a.date, b.date)} 天各扣一次。`,
              rows: [row(a), row(b)],
            });
          }
        }
      }

      // A price that held still and then rose: the two charges before this
      // month agree to the cent, and this one is higher. A bill that wanders
      // with the weather never holds still, so it is not asked about.
      const [p1, p2] = before.slice(-2);
      const now = here[here.length - 1];
      if (p1 && p2 && p1.amount.toFixed(2) === p2.amount.toFixed(2) && out(now) > out(p2)) {
        const cur = currency(now);
        add('price_up', `price_up|${now.id}`, now, {
          amount: out(now),
          detail: `之前每次 ${shown(out(p2), cur)}，這次 ${shown(out(now), cur)}，多了 ${shown(round2(out(now) - out(p2)), cur)}。`,
          rows: [row(p2), row(now)],
        });
      }

      // A series that is a series only because of this month's charge.
      if (before.length < MIN_OCCURRENCES && before.length + here.length >= MIN_OCCURRENCES) {
        add('new_series', `new_series|${k}|${month}`, now, {
          amount: out(now),
          detail: `「${item.label}」這個月起算得上${cadence.label}的固定扣款（${item.occurrences} 次，從 ${item.first} 開始）。是你訂的嗎？`,
          rows: here.map(row),
        });
      }
    }

    // --- cancelled, and still charging -------------------------------------------
    // From the owner's own mark, not from detection: a series stops looking like
    // one soon after it stops, but a charge after the day it was cancelled is
    // exactly the case worth catching.
    for (const [k, since] of Object.entries(cancelled)) {
      for (const t of (series.get(k) || []).filter((r) => inMonth(r) && r.date > since)) {
        add('cancelled', `cancelled|${t.id}`, t, {
          amount: out(t),
          detail: `你在 ${since} 標記這筆固定扣款已經取消，${t.date} 還是扣了 ${shown(out(t), currency(t))}。`,
          rows: [row(t)],
        });
      }
    }

    // --- a category far above its usual ---------------------------------------------
    // Against the months before that actually hold spending in the currency: a
    // month with nothing imported is unknown, and averaging it in as zero would
    // make every category look like it doubled.
    //
    // 未分類 is not compared. It grows when rows are not categorised yet or a
    // transfer between your own accounts is not paired — both already asked
    // about elsewhere, on 消費 and in 待辦 — and reading that as "spent far more
    // than usual" would put the loudest finding on the month's bookkeeping.
    const sp = computeSpending({ txns: flows, accounts, from: `${shiftMonth(month, -BASELINE_MONTHS)}-01`, to });
    for (const cur of sp.order) {
      const c = sp.currencies[cur];
      const thisMonth = c.months.find((m) => m.month === month);
      if (!thisMonth || !thisMonth.expense) continue;
      const earlier = monthsBetween(shiftMonth(month, -BASELINE_MONTHS), shiftMonth(month, -1))
        .filter((m) => (c.months.find((x) => x.month === m) || {}).expense > 0);
      if (earlier.length < MIN_HISTORY) continue;
      const byMonth = (m) => computeSpending({
        txns: flows.filter((t) => currency(t) === cur), accounts, from: `${m}-01`, to: m === month ? to : lastDayOf(m),
      }).currencies[cur];
      const now = byMonth(month);
      const past = earlier.map(byMonth);
      for (const cat of now.categories) {
        if (!cat.category) continue;
        const usual = past.reduce((n, p) => n + ((p.categories.find((x) => x.category === cat.category) || {}).total || 0), 0) / past.length;
        if (usual > 0 && cat.total >= usual * SPIKE_RATIO && cat.total >= now.expense * SPIKE_SHARE) {
          add('spike', `spike|${cur}|${cat.category}|${month}`, null, {
            currency: cur,
            category: cat.category,
            amount: cat.total,
            usual: round2(usual),
            detail: `${running ? '這個月到目前' : '這個月'}花了 ${shown(cat.total, cur)}，前 ${past.length} 個月平均 ${shown(round2(usual), cur)}，是平常的 ${round2(cat.total / usual)} 倍。`,
            rows: [],
          });
        }
      }
    }

    // --- larger than anything in half a year ------------------------------------
    const lookFrom = `${shiftMonth(month, -LARGE_LOOKBACK)}-01`;
    for (const cur of new Set(expenses.filter(inMonth).map(currency))) {
      const past = expenses.filter((t) => currency(t) === cur && t.date >= lookFrom && t.date < from);
      const months = new Set(past.map((t) => t.date.slice(0, 7)));
      if (months.size < MIN_HISTORY) continue;
      const biggest = Math.max(...past.map(out));
      for (const t of expenses.filter((x) => currency(x) === cur && inMonth(x))) {
        if (twins.has(t.id) || out(t) < biggest * LARGE_RATIO) continue;
        add('large', `large|${t.id}`, t, {
          amount: out(t),
          detail: `比前 ${LARGE_LOOKBACK} 個月最大的一筆支出（${shown(biggest, cur)}）大 ${LARGE_RATIO} 倍以上。`,
          rows: [row(t)],
        });
      }
    }

    // --- fees and interest --------------------------------------------------------------
    for (const t of moving.filter((x) => x.amount < 0 && inMonth(x) && isFee(x))) {
      add('fee', `fee|${t.id}`, t, {
        amount: out(t),
        detail: '看起來是手續費、利息或罰款。有些可以申請退回，或換個方式就不必付。',
        rows: [row(t)],
      });
    }

    // Loudest first, then by kind in the order above, then the biggest amount.
    findings.sort((a, b) => Number(a.ok) - Number(b.ok)
      || (a.severity === b.severity ? 0 : a.severity === 'warn' ? -1 : 1)
      || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
      || b.amount - a.amount
      || a.key.localeCompare(b.key));

    return {
      month,
      from,
      to,
      running,
      future,
      findings,
      open: findings.filter((f) => !f.ok).length,
      unpaired_in_month: txns.filter((t) => pending.has(t.id) && inMonth(t)).length,
    };
  }

  // Every subscription the owner can mark cancelled: the recurring charges
  // still running, and any already marked, with the day they were.
  function computeSubscriptions({ txns, accounts, today, cancelled = {} }) {
    const flows = txns.filter((t) => !notSpending(t) && t.date <= today);
    const items = computeRecurring({ txns: flows, accounts, to: today }).items.map((i) => {
      const series = `${i.account_id}|${i.key}`;
      return { ...i, series, cancelled_since: cancelled[series] || null };
    });
    return { items: items.filter((i) => i.active || i.cancelled_since) };
  }

  // ---------------------------------------------------------------------------
  // The owner's answers
  // ---------------------------------------------------------------------------
  //
  // Two, and both are the owner's to give: a finding answered 沒問題, and a
  // subscription marked cancelled on a day. The caller keeps them — the server
  // in `meta`, the demo in its Map — and these are the only code that reads or
  // changes them, so both refuse the same input in the same words. Each change
  // returns `{ value }` to store or `{ error }` to refuse; nothing throws, so a
  // bug elsewhere is never dressed up as a refusal.

  // What was stored, read back. Unreadable is "no answers yet": the page stays
  // up and the next answer rewrites it.
  function parseAnswers(okRaw, cancelledRaw) {
    const read = (s) => { try { return JSON.parse(s); } catch { return null; } };
    const ok = read(okRaw);
    const cancelled = read(cancelledRaw);
    return {
      ok: Array.isArray(ok) ? ok.filter((k) => typeof k === 'string') : [],
      cancelled: cancelled && typeof cancelled === 'object' && !Array.isArray(cancelled) ? cancelled : {},
    };
  }

  const KEY_RE = new RegExp(`^(${KIND_ORDER.join('|')})\\|`);

  function answerOk(list, body) {
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!KEY_RE.test(key) || key.length > 300) return { error: '要回答的審計項目不對' };
    if (typeof body.ok !== 'boolean') return { error: 'ok 要是 true 或 false' };
    const set = new Set(list);
    if (body.ok) set.add(key); else set.delete(key);
    return { value: [...set].sort() };
  }

  // `since: null` takes the mark back off.
  function answerCancelled(map, body) {
    const series = typeof body.series === 'string' ? body.series.trim() : '';
    if (!/^\d+\|\S/.test(series) || series.length > 300) return { error: '要標記的固定扣款不對' };
    const next = { ...map };
    if (body.since === null) {
      delete next[series];
      return { value: next };
    }
    const since = typeof body.since === 'string' ? parseDate(body.since, 'auto') : null;
    if (!since) return { error: `日期無法解析：${body.since}` };
    next[series] = since;
    return { value: next };
  }

  const api = {
    computeAudit, computeSubscriptions, parseAnswers, answerOk, answerCancelled,
    AUDIT_KINDS: KINDS, FEE_WORDS, isFee,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
