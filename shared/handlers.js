'use strict';

// The route handlers the server and the hosted demo both run.
//
// Every route used to be written twice: once in server/api.js over SQLite and
// once in web/storage-demo.js over a Map, held equal by test/demo-store.test.js
// asking both the same questions. Two copies drift — a refusal worded one way
// on one side, a response shaped differently on the one route no view calls —
// and every feature paid for its handlers twice. A route here is written
// once: what it accepts, what it refuses and in which words, and which pure
// `compute*` answers it.
//
// What differs between the two is where the rows are, and only that. Each
// side hands in `L`, its half of the ledger port: the server's runs SQL
// (server/ledger.js), the demo's filters its Map (createDemoStorage). A read
// is named for what a handler needs, so the server keeps its queries and its
// indexes rather than loading a table to filter it in JS; a write is generic —
// one table, one row, by id — because every write here is exactly that.
//
// **A write names its columns here, in code, and never takes them from a
// request.** The server's port refuses a table or a column its schema does
// not have and binds every value, so a name reaches SQL only from this file.
// `checked` refuses, on both sides, the values node:sqlite cannot bind, so the
// demo cannot store something the server would answer with a 500.
//
// Sync, every one of them. The only handlers that wait are the two that reach
// the network — the price refresh and AI 健檢's review — and the hosted demo
// can do neither, so they stay in server/api.js with the other routes only a
// server can answer.
//
// Routes move here one group at a time. Both routers throw when a route is
// registered twice, so one that moved cannot quietly stay behind on either
// side and answer instead of this.

(function (root) {
  const NODE = typeof module !== 'undefined' && module.exports;
  const { round2, MAX_DECIMALS } = NODE ? require('./currency') : root;
  const { MARKET_KEYS, DEFAULT_MARKET, marketInfo } = NODE ? require('./kinds') : root;
  const { COVERAGE_MONTHS } = NODE ? require('./money') : root;
  const { parseDate } = NODE ? require('./csv') : root;
  const R = NODE ? require('./rules') : root;
  const SP = NODE ? require('./spending') : root;
  const AUDIT = NODE ? require('./audit') : root;

  // The router's error on both sides: server/index.js answers it with its
  // status, and the demo's adapter rejects with it.
  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const bad = (msg) => { throw new ApiError(400, msg); };
  const missing = (msg) => { throw new ApiError(404, msg); };

  const S = (v, d = '') => (v === undefined || v === null ? d : String(v));
  const N = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const OPT = (v) => (v === undefined || v === '' ? null : v);

  function checked(row) {
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && typeof v !== 'number' && typeof v !== 'string') {
        throw new TypeError(`${k} 不能寫成 ${typeof v}`);
      }
    }
    return row;
  }

  // `on(method, pattern, handler)` is the side's router. `today()` and `now()`
  // are its clock: the server's is the machine's, the demo's is injected, so a
  // handler here never reads one of its own.
  function defineLedgerRoutes(on, { L, now, today }) {

    // --- spending ------------------------------------------------------------

    // Twelve months back by default, the shortest window that shows a yearly
    // subscription at all.
    const windowFrom = (q) => {
      const to = q.to ? S(q.to) : today();
      if (q.from) return { from: S(q.from), to };
      return { from: SP.yearsBefore(to, N(q.years, 1)), to };
    };

    on('GET', '/api/spending', (_p, _b, q) => {
      const { from, to } = windowFrom(q);
      return SP.computeSpending({ txns: L.spendingRows(from, to), accounts: L.accountCurrencies(), from, to });
    });

    on('GET', '/api/recurring', (_p, _b, q) => {
      // Two years by default rather than one: three occurrences is the minimum a
      // series needs, and a yearly charge cannot reach three inside twelve months.
      const { from, to } = windowFrom({ ...q, years: q.years || 2 });
      return SP.computeRecurring({ txns: L.spendingRows(from, to), accounts: L.accountCurrencies(), to });
    });

    // --- budgets -------------------------------------------------------------

    // A month is written the way the ledger slices one off a date. No month
    // means the running one; a month that is not a month is refused rather than
    // read as the running one, which would answer a typo with a plausible card.
    const monthOf = (v) => {
      if (v === undefined || v === null || v === '') return today().slice(0, 7);
      const m = S(v).trim();
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) bad(`月份要寫成 YYYY-MM：${m}`);
      return m;
    };

    // 未分類 is the ledger not knowing yet, not a place money was meant to go,
    // so it cannot carry a budget — by its empty key or by the word the page
    // shows.
    const budgetCategoryOf = (v) => {
      const c = S(v).trim();
      if (!c || c === SP.UNCATEGORISED_LABEL) bad(`預算要有分類，而且不能是「${SP.UNCATEGORISED_LABEL}」`);
      return c;
    };

    // Any three-letter code, as an account's currency may be. Nothing converts,
    // so the currency is which accounts' spending the budget counts.
    const budgetCurrencyOf = (v) => {
      const c = S(v).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(c)) bad('幣別要是三個英文字母，例如 TWD');
      return c;
    };

    // Refused rather than coerced: N() turns garbage into 0, and a budget of 0
    // is a bar that is over budget the moment anything is bought.
    const budgetAmountOf = (v) => {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
      if (!Number.isFinite(n) || n <= 0) bad('預算金額要是大於 0 的數字');
      return round2(n);
    };

    // The table's UNIQUE (category, currency) would refuse it too, in SQLite's
    // words, and the demo's Map not at all; this says it in the user's.
    const refuseDuplicateBudget = (category, currency, id) => {
      if (L.all('budgets').some((x) => x.category === category && x.currency === currency && x.id !== id)) {
        bad(`「${category}」已經有 ${currency} 的預算了`);
      }
    };

    // The rows are the month's own window, cut at today by computeBudgets itself
    // — the same cut the breakdown makes. `-31` is the last day any month can
    // have, and dates compare as strings, so no calendar is needed to bound it.
    on('GET', '/api/budgets', (_p, _b, q) => {
      const month = monthOf(q.month);
      return SP.computeBudgets({
        budgets: L.all('budgets'),
        txns: L.spendingRows(`${month}-01`, `${month}-31`),
        accounts: L.accountCurrencies(),
        month,
        today: today(),
      });
    });

    on('POST', '/api/budgets', (_p, b) => {
      const category = budgetCategoryOf(b.category);
      const currency = budgetCurrencyOf(b.currency);
      const amount = budgetAmountOf(b.amount);
      refuseDuplicateBudget(category, currency, 0);
      return { id: L.insert('budgets', checked({ category, currency, amount, created_at: now() })) };
    });

    on('PUT', '/api/budgets/:id', (p, b) => {
      const cur = L.get('budgets', N(p.id)) || missing('預算不存在');
      const category = b.category === undefined ? cur.category : budgetCategoryOf(b.category);
      const currency = b.currency === undefined ? cur.currency : budgetCurrencyOf(b.currency);
      const amount = b.amount === undefined ? cur.amount : budgetAmountOf(b.amount);
      refuseDuplicateBudget(category, currency, cur.id);
      L.update('budgets', cur.id, checked({ category, currency, amount }));
      return { ok: true };
    });

    on('DELETE', '/api/budgets/:id', (p) => ({ deleted: L.remove('budgets', N(p.id)) }));

    // --- 月度審計 --------------------------------------------------------------

    // The rules are shared/audit.js; this keeps the owner's two answers. They
    // live in `meta` beside the book's other choices — small, only ever read
    // whole, so one JSON value each rather than a table.
    const auditAnswers = () => AUDIT.parseAnswers(L.getMeta('audit_ok', ''), L.getMeta('audit_cancelled', ''));

    // One month's findings, and every subscription that can be marked
    // cancelled. `-31` bounds any month, as the budgets route does.
    on('GET', '/api/audit', (_p, _b, q) => {
      const month = monthOf(q.month);
      const day = today();
      const { ok, cancelled } = auditAnswers();
      const accounts = L.accountCurrencies();
      const unpaired = L.transferCandidates().flatMap((c) => [c.out.id, c.in.id]);
      return {
        ...AUDIT.computeAudit({ txns: L.auditRows(`${month}-31`), accounts, month, today: day, ok, cancelled, unpaired }),
        subscriptions: AUDIT.computeSubscriptions({ txns: L.auditRows(day), accounts, today: day, cancelled }).items,
      };
    });

    on('PUT', '/api/audit/ok', (_p, b) => {
      const r = AUDIT.answerOk(auditAnswers().ok, b);
      if (r.error) bad(r.error);
      L.setMeta('audit_ok', JSON.stringify(r.value));
      return { ok: true };
    });

    on('PUT', '/api/audit/cancel', (_p, b) => {
      const r = AUDIT.answerCancelled(auditAnswers().cancelled, b);
      if (r.error) bad(r.error);
      L.setMeta('audit_cancelled', JSON.stringify(r.value));
      return { ok: true };
    });

    // --- categorisation rules ------------------------------------------------

    on('GET', '/api/rules', () => R.sortRules(L.all('rules')));

    on('POST', '/api/rules', (_p, b) => {
      const pattern = S(b.pattern).trim();
      const category = S(b.category).trim();
      if (!pattern) bad('比對字串必填');
      if (!category) bad('分類必填');
      // A pattern that normalises to nothing — punctuation only — would match
      // every description or none, depending on which way the loop reads.
      // Neither is a rule anybody meant to write.
      if (!R.normalise(pattern)) bad('比對字串至少要有一個文字或數字');
      return { id: L.insert('rules', checked({ pattern, category, priority: N(b.priority), created_at: now() })) };
    });

    on('PUT', '/api/rules/:id', (p, b) => {
      const cur = L.get('rules', N(p.id)) || missing('規則不存在');
      const pattern = b.pattern === undefined ? cur.pattern : S(b.pattern).trim();
      if (!R.normalise(pattern)) bad('比對字串至少要有一個文字或數字');
      L.update('rules', cur.id, checked({
        pattern,
        category: b.category === undefined ? cur.category : S(b.category).trim(),
        priority: b.priority === undefined ? cur.priority : N(b.priority),
      }));
      return { ok: true };
    });

    on('DELETE', '/api/rules/:id', (p) => ({ deleted: L.remove('rules', N(p.id)) }));

    // Preview and apply run the same `plan()` over the same rows, so what the
    // user is shown and what actually happens cannot drift apart. `dry` is the
    // default: a sweep over every transaction in the ledger is not something
    // to discover after the fact.
    on('POST', '/api/rules/apply', (_p, b) => {
      const changes = R.plan(L.txnDescriptions(), R.sortRules(L.all('rules')), { overwrite: !!b.overwrite });
      if (b.dry !== false) return { dry: true, changes: changes.slice(0, 200), total: changes.length };
      L.tx(() => { for (const c of changes) L.update('txns', c.id, checked({ category: c.to })); });
      return { dry: false, applied: changes.length };
    });

    // --- balance checks, reconciliation, coverage ----------------------------

    on('GET', '/api/reconcile', () => L.reconcile());

    on('POST', '/api/balance-checks', (_p, b) => {
      const d = parseDate(b.date, 'auto');
      if (!d) bad(`日期無法解析：${b.date}`);
      return {
        id: L.insert('balance_checks', checked({ account_id: N(b.account_id), date: d, stated: N(b.stated), note: S(b.note) })),
      };
    });

    on('DELETE', '/api/balance-checks/:id', (p) => ({ deleted: L.remove('balance_checks', N(p.id)) }));

    // Clamped rather than validated: a silly `months` is a URL someone typed,
    // not an error worth refusing, and an unbounded one would build a grid per
    // month per account for no reader.
    on('GET', '/api/coverage', (_p, _b, q) => L.coverage({
      months: Math.min(Math.max(N(q.months, COVERAGE_MONTHS), 1), 120),
      to: q.to ? S(q.to) : today(),
    }));

    // --- column mappings -----------------------------------------------------

    on('GET', '/api/mappings', () => L.mappings().map((m) => ({ ...m, config: JSON.parse(m.config) })));

    // Saved under a name, and saving the same name again replaces its config.
    on('POST', '/api/mappings', (_p, b) => {
      const name = S(b.name).trim();
      if (!name) bad('對應名稱必填');
      const config = JSON.stringify(b.config || {});
      const cur = L.all('mappings').find((m) => m.name === name);
      if (cur) L.update('mappings', cur.id, checked({ config }));
      else L.insert('mappings', checked({ name, config, created_at: now(), used_at: null }));
      return { ok: true, name };
    });

    on('DELETE', '/api/mappings/:id', (p) => ({ deleted: L.remove('mappings', N(p.id)) }));

    // --- institutions --------------------------------------------------------

    on('GET', '/api/institutions', () => L.institutions());

    // The name is UNIQUE in the schema. Checked here first so the refusal is a
    // sentence rather than SQLite's constraint error, which the server used to
    // answer with as a 500.
    on('POST', '/api/institutions', (_p, b) => {
      const name = S(b.name).trim();
      if (!name) bad('機構名稱必填');
      if (L.all('institutions').some((i) => i.name === name)) bad(`機構「${name}」已經存在`);
      return { id: L.insert('institutions', checked({ name, kind: S(b.kind, 'bank'), country: S(b.country, 'TW') })) };
    });

    // Its accounts stay and lose the link — the schema's ON DELETE SET NULL,
    // done here so a store without foreign keys does the same.
    on('DELETE', '/api/institutions/:id', (p) => {
      const id = N(p.id);
      return L.tx(() => {
        for (const a of L.all('accounts').filter((x) => x.institution_id === id)) {
          L.update('accounts', a.id, checked({ institution_id: null }));
        }
        return { deleted: L.remove('institutions', id) };
      });
    });

    // --- holdings ------------------------------------------------------------

    // One normaliser for every place a market arrives: holdings and all three
    // price routes. Holdings used to store the market as sent while /api/prices
    // upper-cased it, so a `crypto` holding looked its price up under `crypto`
    // in a series stored as `CRYPTO` and never found it. Refused outside the
    // list rather than stored, because an unknown market has no section on the
    // holdings page to be shown in.
    const marketOf = (v, fallback) => {
      if (v === undefined || v === null || v === '') return fallback;
      const m = S(v).trim().toUpperCase();
      if (!MARKET_KEYS.includes(m)) bad(`market 只能是 ${MARKET_KEYS.join('、')}`);
      return m;
    };

    // The quantity's scale. Refused rather than clamped: 12 places would look
    // like precision and be float noise, and 2.5 places is a typo.
    const placesOf = (v, fallback) => {
      if (v === undefined || v === null || v === '') return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > MAX_DECIMALS) bad(`decimals 要是 0 到 ${MAX_DECIMALS} 的整數`);
      return n;
    };

    on('GET', '/api/holdings', () => L.holdingsValued(today()));

    on('POST', '/api/holdings', (_p, b) => {
      if (!S(b.symbol).trim()) bad('代號必填');
      const market = marketOf(b.market, DEFAULT_MARKET);
      // The market's currency and scale are defaults for a holding that did
      // not say — a coin can be priced in TWD on a Taiwanese exchange — not
      // rules. This used to be a ternary on the market, which priced any third
      // market in TWD.
      const info = marketInfo(market);
      return {
        id: L.insert('holdings', checked({
          account_id: N(b.account_id), symbol: S(b.symbol).trim().toUpperCase(), name: S(b.name), market,
          shares: N(b.shares), avg_cost: N(b.avg_cost), last_price: N(b.last_price),
          price_date: OPT(b.price_date), currency: S(b.currency, info.currency), note: S(b.note),
          decimals: placesOf(b.decimals, info.decimals),
        })),
      };
    });

    on('PUT', '/api/holdings/:id', (p, b) => {
      const cur = L.get('holdings', N(p.id)) || missing('持股不存在');
      L.update('holdings', cur.id, checked({
        account_id: b.account_id === undefined ? cur.account_id : N(b.account_id),
        symbol: S(b.symbol, cur.symbol).trim().toUpperCase(),
        name: S(b.name, cur.name),
        market: marketOf(b.market, cur.market),
        shares: b.shares === undefined ? cur.shares : N(b.shares),
        avg_cost: b.avg_cost === undefined ? cur.avg_cost : N(b.avg_cost),
        last_price: b.last_price === undefined ? cur.last_price : N(b.last_price),
        price_date: b.price_date === undefined ? cur.price_date : OPT(b.price_date),
        currency: S(b.currency, cur.currency),
        note: S(b.note, cur.note),
        decimals: placesOf(b.decimals, cur.decimals),
      }));
      return { ok: true };
    });

    on('DELETE', '/api/holdings/:id', (p) => ({ deleted: L.remove('holdings', N(p.id)) }));

    // --- prices --------------------------------------------------------------

    // Price history per security. Keyed (symbol, market, date) and read by
    // symbol, so a holding of that symbol in any account values off the same
    // series — exactly how /api/fx serves one series per pair rather than per
    // account. The symbol is upper-cased on the way in and out to match how
    // holdings store it, and the date goes through the same parser a statement
    // does. Query params, not a path segment, because a US symbol can carry a
    // slash (BRK/B).
    on('GET', '/api/prices', (_p, _b, q) => {
      const symbol = S(q.symbol).trim().toUpperCase();
      if (!symbol) bad('代號必填');
      return L.prices(symbol, marketOf(q.market, DEFAULT_MARKET));
    });

    // One row or `rows`, all or nothing; a day already priced takes the new one.
    on('POST', '/api/prices', (_p, b) => {
      const list = Array.isArray(b.rows) ? b.rows : [b];
      return {
        saved: L.tx(() => {
          for (const r of list) {
            const symbol = S(r.symbol).trim().toUpperCase();
            if (!symbol) bad('代號必填');
            const date = parseDate(r.date, 'auto');
            if (!date) bad(`日期無法解析：${r.date}`);
            const price = N(r.price);
            if (price <= 0) bad('價格必須大於 0');
            L.upsert('prices', checked({
              symbol, market: marketOf(r.market, DEFAULT_MARKET), date, price, source: S(r.source, 'manual'),
            }));
          }
          return list.length;
        }),
      };
    });

    // The market is resolved before anything is looked up, so a bad market is
    // refused even when there is nothing to delete.
    on('DELETE', '/api/prices', (_p, _b, q) => ({
      deleted: L.removeKey('prices', {
        symbol: S(q.symbol).trim().toUpperCase(), market: marketOf(q.market, DEFAULT_MARKET), date: S(q.date),
      }),
    }));

    // --- fx ------------------------------------------------------------------

    on('GET', '/api/fx', () => L.fxRates());

    on('POST', '/api/fx', (_p, b) => {
      const list = Array.isArray(b.rows) ? b.rows : [b];
      return {
        saved: L.tx(() => {
          for (const r of list) {
            const date = parseDate(r.date, 'auto');
            if (!date) bad(`日期無法解析：${r.date}`);
            const rate = N(r.rate);
            if (rate <= 0) bad('匯率必須大於 0');
            L.upsert('fx_rates', checked({ date, pair: S(r.pair, 'USDTWD').toUpperCase(), rate }));
          }
          return list.length;
        }),
      };
    });

    on('DELETE', '/api/fx/:date', (p, _b, q) => ({
      deleted: L.removeKey('fx_rates', { date: String(p.date), pair: S(q.pair, 'USDTWD') }),
    }));
  }

  const api = { defineLedgerRoutes, ApiError };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
