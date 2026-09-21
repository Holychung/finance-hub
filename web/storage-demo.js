'use strict';

// The ledger, in memory, with no server behind it.
//
// Same contract as `storage-http.js` — `get/post/put/del(path)` plus the two
// export members — so no view knows which one it is talking to. Writes work
// and are lost on reload, which is the honest behaviour for a demo: nothing
// script-writable in a browser survives reliably, so pretending otherwise
// would be the one thing this project refuses to do about where money is
// recorded.
//
// **It routes on the path rather than serving it.** The `/api/...` routes are
// the vocabulary the views already speak; answering them is what makes this a
// drop-in. The handlers below are `server/api.js`'s, with the SQL replaced by
// `filter` and `reduce` — and with every computation delegated to `shared/`,
// which is the whole reason `shared/` exists. If a handler here is doing
// arithmetic, it has gone wrong.
//
// Two things a browser cannot do at all, answered rather than faked:
//
//   the pre-import snapshot   There is no filesystem. `/api/backups` is empty
//                             and a commit reports `backup: null`, which the
//                             import view already renders as "no backup".
//                             Inventing a fake filename would be worse than
//                             saying there is none.
//   schema migrations         The demo's shape ships with the code, so there
//                             is nothing to migrate. `schema_version` reports
//                             what the seed was built as.

(function (root) {
  const dep = typeof module !== 'undefined' && module.exports;
  const M = dep ? require('../shared/money') : root;
  const csv = dep ? require('../shared/csv') : root;
  const R = dep ? require('../shared/rules') : root;
  const SP = dep ? require('../shared/spending') : root;
  const X = dep ? require('../shared/export') : root;

  // The demo's shape is shipped with the code, so this is a statement about
  // the seed rather than a version anything migrates to.
  const SCHEMA_VERSION = '5';

  // ---------------------------------------------------------------------
  // The raw store
  // ---------------------------------------------------------------------
  //
  // Everything above it is written against this interface and never against a
  // Map, which is what lets `test/storage.test.js` hand in its own and read
  // the result back. Rows are plain objects with the SQLite column names,
  // because every `compute*` and every response shape already destructures
  // those names.

  const TABLES = {
    institutions: { key: 'id' },
    accounts: { key: 'id' },
    txns: { key: 'id' },
    holdings: { key: 'id' },
    imports: { key: 'id' },
    balance_checks: { key: 'id' },
    mappings: { key: 'id' },
    rules: { key: 'id' },
    // The one table with no id: the schema's primary key is (date, pair).
    fx_rates: { key: (r) => `${r.date}|${r.pair}` },
    meta: { key: 'key' },
  };

  function makeMapStore(seed = {}) {
    const data = new Map();
    const counters = new Map();
    for (const name of Object.keys(TABLES)) {
      data.set(name, new Map());
      counters.set(name, 0);
    }

    const keyOf = (table, row) => {
      const k = TABLES[table].key;
      return typeof k === 'function' ? k(row) : row[k];
    };
    const copy = (r) => (r === undefined ? undefined : { ...r });

    let journal = null;

    const store = {
      names: () => Object.keys(TABLES),
      all: (table) => [...data.get(table).values()].map(copy),
      get: (table, key) => copy(data.get(table).get(key)),

      insert(table, row) {
        journalise(table);
        const next = { ...row };
        // Monotonic, never max(id)+1. SQLite reuses a rowid after the last
        // row is deleted, and a demo where deleting account 3 and adding one
        // hands out 3 again makes a stale /account/3 link point somewhere
        // else. One integer per table is a cheap way not to think about it.
        if (TABLES[table].key === 'id') {
          counters.set(table, counters.get(table) + 1);
          next.id = counters.get(table);
        }
        data.get(table).set(keyOf(table, next), next);
        return copy(next);
      },

      // Upsert by key, for the tables whose key comes from the row itself.
      put(table, row) {
        journalise(table);
        const k = keyOf(table, row);
        const merged = { ...data.get(table).get(k), ...row };
        data.get(table).set(k, merged);
        return copy(merged);
      },

      update(table, key, patch) {
        const cur = data.get(table).get(key);
        if (!cur) return 0;
        journalise(table);
        // Replace rather than mutate, so journalling a shallow clone of the
        // Map is a complete undo.
        data.get(table).set(key, { ...cur, ...patch });
        return 1;
      },

      remove(table, pred) {
        journalise(table);
        let n = 0;
        for (const [k, row] of [...data.get(table)]) {
          if (pred(row)) { data.get(table).delete(k); n++; }
        }
        return n;
      },

      // All or nothing. Copy-on-first-write per table: the first mutation
      // that touches a table stores its Map and its counter, and a throw puts
      // them back.
      tx(fn) {
        if (journal) throw new Error('demo store: 交易不能巢狀');
        journal = new Map();
        try {
          const out = fn();
          journal = null;
          return out;
        } catch (e) {
          for (const [table, snap] of journal) {
            data.set(table, snap.rows);
            counters.set(table, snap.counter);
          }
          journal = null;
          throw e;
        }
      },

      // Everything back to the seed, for the 重設示範資料 control.
      reset: (next = seed) => load(next),
    };

    function journalise(table) {
      if (!journal || journal.has(table)) return;
      journal.set(table, { rows: new Map(data.get(table)), counter: counters.get(table) });
    }

    function load(source) {
      for (const name of Object.keys(TABLES)) {
        data.set(name, new Map());
        counters.set(name, 0);
        for (const row of source[name] || []) {
          const next = { ...row };
          if (TABLES[name].key === 'id') {
            next.id = row.id !== undefined ? row.id : counters.get(name) + 1;
            counters.set(name, Math.max(counters.get(name), next.id));
          }
          data.get(name).set(keyOf(name, next), next);
        }
      }
    }

    load(seed);
    return store;
  }

  // ---------------------------------------------------------------------
  // The adapter
  // ---------------------------------------------------------------------

  class DemoError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  // The same coercions api.js applies, because the views send the same things
  // and a demo that accepted a string where the server wanted a number would
  // pass here and fail there.
  const S = (v, d = '') => (v === undefined || v === null ? d : String(v));
  const N = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const B = (v, d = 1) => (v === undefined || v === null ? d : v ? 1 : 0);
  const OPT = (v) => (v === undefined || v === '' ? null : v);
  const bad = (m) => { throw new DemoError(400, m); };
  const missing = (m) => { throw new DemoError(404, m); };

  const by = (...keys) => (a, b) => {
    for (const k of keys) {
      const [field, dir] = k.startsWith('-') ? [k.slice(1), -1] : [k, 1];
      const x = a[field], y = b[field];
      if (x === y) continue;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : 1) * dir;
    }
    return 0;
  };

  function compile(pattern) {
    const names = [];
    const rx = new RegExp(
      `^${pattern.replace(/:[A-Za-z_]+/g, (m) => { names.push(m.slice(1)); return '([^/]+)'; })}$`
    );
    return { rx, names };
  }

  function createDemoStorage({ raw, now = () => new Date().toISOString(), uuid }) {
    const newId = uuid || (() => `demo-${Math.random().toString(16).slice(2, 10)}`);
    const today = () => now().slice(0, 10);
    const ROUTES = [];
    const on = (method, pattern, fn) => ROUTES.push({ method, ...compile(pattern), fn });

    // --- shared little loaders ------------------------------------------

    const accountsById = () => new Map(raw.all('accounts').map((a) => [a.id, a]));

    const sumByAccount = (rows) => {
      const m = new Map();
      for (const t of rows) m.set(t.account_id, (m.get(t.account_id) || 0) + t.amount);
      return [...m].map(([account_id, total]) => ({ account_id, total }));
    };

    const accountsWithBalances = (asOf = today()) => M.computeAccountsWithBalances({
      accounts: raw.all('accounts').sort(by('sort_order', 'id')),
      totals: sumByAccount(raw.all('txns').filter((t) => t.date <= asOf)),
    });

    const holdingsValued = () => {
      const acct = accountsById();
      return M.computeHoldingsValued({
        holdings: raw.all('holdings').sort(by('market', 'symbol'))
          .map((h) => ({ ...h, account_name: acct.get(h.account_id)?.name || '' })),
      });
    };

    const reconcile = () => {
      const acct = accountsById();
      const txns = raw.all('txns');
      const checks = raw.all('balance_checks').sort(by('-date', '-id')).map((c) => {
        const a = acct.get(c.account_id) || {};
        return {
          ...c,
          account_name: a.name,
          currency: a.currency,
          opening_balance: a.opening_balance,
          txn_total: txns
            .filter((t) => t.account_id === c.account_id && t.date <= c.date)
            .reduce((n, t) => n + t.amount, 0),
        };
      });
      return M.computeReconcile({ checks });
    };

    const fxLookup = (pair = 'USDTWD') => M.computeFxLookup({
      rows: raw.all('fx_rates').filter((r) => r.pair === pair).sort(by('date')),
    });

    const transferCandidates = (opts = {}) => {
      const acct = accountsById();
      return M.computeTransferCandidates({
        rows: raw.all('txns').filter((t) => !t.transfer_group).sort(by('date'))
          .map((t) => ({
            id: t.id, account_id: t.account_id, date: t.date, amount: t.amount,
            description: t.description,
            currency: acct.get(t.account_id)?.currency,
            account_name: acct.get(t.account_id)?.name,
          })),
        fx: fxLookup(),
        ...opts,
      });
    };

    const listRules = () => R.sortRules(raw.all('rules'));

    const withAccount = (t, acct) => ({
      ...t,
      account_name: acct.get(t.account_id)?.name,
      currency: acct.get(t.account_id)?.currency,
    });

    // --- overview --------------------------------------------------------

    on('GET', '/api/overview', () => {
      const asOf = today();
      const accounts = accountsWithBalances(asOf);
      const holdings = holdingsValued();
      const checks = reconcile();
      const dates = raw.all('txns').map((t) => t.date).sort();
      const opens = raw.all('accounts').map((a) => a.opening_date).sort();
      const from = dates[0] || opens[0] || asOf;

      return {
        net_worth: M.computeNetWorth({ accounts, holdings, asOf }),
        accounts,
        holdings,
        series: M.computeNetWorthSeries({
          accounts: raw.all('accounts'),
          txns: raw.all('txns').filter((t) => t.date <= asOf).sort(by('date')),
          from,
          to: asOf,
        }),
        reconcile: {
          total: checks.length,
          off: checks.filter((c) => !c.ok).length,
          off_accounts: new Set(checks.filter((c) => !c.ok).map((c) => c.account_id)).size,
          latest: checks.slice(0, 8),
        },
        counts: {
          txns: raw.all('txns').length,
          unpaired_candidates: transferCandidates().length,
        },
        liabilities_in_credit: M.liabilitiesInCredit(accounts),
        fx_latest: raw.all('fx_rates').filter((r) => r.pair === 'USDTWD')
          .sort(by('-date')).map((r) => ({ date: r.date, rate: r.rate }))[0] || null,
      };
    });

    // --- institutions ----------------------------------------------------

    on('GET', '/api/institutions', () => raw.all('institutions').sort(by('country', 'name')));

    on('POST', '/api/institutions', (_p, b) => {
      const name = S(b.name).trim();
      if (!name) bad('機構名稱必填');
      // name is UNIQUE in the schema, so the insert would fail rather than
      // make a second one.
      if (raw.all('institutions').some((i) => i.name === name)) bad(`機構「${name}」已經存在`);
      return { id: raw.insert('institutions', { name, kind: S(b.kind, 'bank'), country: S(b.country, 'TW') }).id };
    });

    on('DELETE', '/api/institutions/:id', (p) => {
      const id = N(p.id);
      // ON DELETE SET NULL on accounts.institution_id.
      raw.all('accounts').filter((a) => a.institution_id === id)
        .forEach((a) => raw.update('accounts', a.id, { institution_id: null }));
      return { deleted: raw.remove('institutions', (i) => i.id === id) };
    });

    // --- accounts --------------------------------------------------------

    on('GET', '/api/accounts', () => accountsWithBalances());

    on('POST', '/api/accounts', (_p, b) => {
      if (!S(b.name).trim()) bad('帳戶名稱必填');
      return {
        id: raw.insert('accounts', {
          institution_id: OPT(b.institution_id) === null ? null : N(b.institution_id),
          name: S(b.name).trim(), kind: S(b.kind, 'cash'), currency: S(b.currency, 'TWD'),
          opening_balance: N(b.opening_balance), opening_date: S(b.opening_date, '2020-01-01'),
          is_active: B(b.is_active), sort_order: N(b.sort_order), note: S(b.note),
        }).id,
      };
    });

    on('PUT', '/api/accounts/:id', (p, b) => {
      const cur = raw.get('accounts', N(p.id));
      if (!cur) missing('帳戶不存在');
      raw.update('accounts', cur.id, {
        institution_id: b.institution_id === undefined
          ? cur.institution_id
          : (OPT(b.institution_id) === null ? null : N(b.institution_id)),
        name: S(b.name, cur.name), kind: S(b.kind, cur.kind), currency: S(b.currency, cur.currency),
        opening_balance: b.opening_balance === undefined ? cur.opening_balance : N(b.opening_balance),
        opening_date: S(b.opening_date, cur.opening_date),
        is_active: b.is_active === undefined ? cur.is_active : B(b.is_active),
        sort_order: b.sort_order === undefined ? cur.sort_order : N(b.sort_order),
        note: S(b.note, cur.note),
      });
      return { ok: true };
    });

    on('DELETE', '/api/accounts/:id', (p) => {
      const id = N(p.id);
      // ON DELETE CASCADE on txns and holdings; the UI warns about it.
      raw.remove('txns', (t) => t.account_id === id);
      raw.remove('holdings', (h) => h.account_id === id);
      raw.remove('balance_checks', (c) => c.account_id === id);
      return { deleted: raw.remove('accounts', (a) => a.id === id) };
    });

    // --- transactions ----------------------------------------------------

    on('GET', '/api/txns', (_p, _b, q) => {
      const acct = accountsById();
      let rows = raw.all('txns');
      if (q.account) rows = rows.filter((t) => t.account_id === N(q.account));
      if (q.from) rows = rows.filter((t) => t.date >= q.from);
      if (q.to) rows = rows.filter((t) => t.date <= q.to);
      if (q.kind) rows = rows.filter((t) => t.kind === q.kind);
      if (q.q) {
        // SQLite's LIKE is case-insensitive for ASCII, which is what the
        // server does here too.
        const k = String(q.q).toLowerCase();
        rows = rows.filter((t) => [t.description, t.category, t.note]
          .some((v) => String(v || '').toLowerCase().includes(k)));
      }
      const total = rows.length;
      const limit = Math.min(N(q.limit, 200), 2000);
      const offset = N(q.offset, 0);
      return {
        total,
        limit,
        offset,
        rows: rows.sort(by('-date', '-id')).slice(offset, offset + limit).map((t) => withAccount(t, acct)),
      };
    });

    function insertTxn(b, importId = null) {
      const accountId = N(b.account_id);
      if (!accountId) bad('account_id 必填');
      const date = csv.parseDate(b.date, 'auto');
      if (!date) bad(`日期無法解析：${b.date}`);
      const amount = M.round2(N(b.amount));
      const desc = S(b.description);
      return raw.insert('txns', {
        account_id: accountId, date, amount, description: desc,
        category: S(b.category), kind: S(b.kind, 'other'),
        transfer_group: null,
        source: S(b.source, 'manual'), external_id: OPT(b.external_id),
        fingerprint: S(b.fingerprint) || csv.fingerprint(accountId, date, amount, desc),
        import_id: importId, note: S(b.note), created_at: now(),
      }).id;
    }

    on('POST', '/api/txns', (_p, b) => {
      if (Array.isArray(b.rows)) {
        const ids = raw.tx(() => b.rows.map((row) => insertTxn(row)));
        return { ids, inserted: ids.length };
      }
      return { id: insertTxn(b) };
    });

    on('PUT', '/api/txns/:id', (p, b) => {
      const cur = raw.get('txns', N(p.id));
      if (!cur) missing('交易不存在');
      const accountId = b.account_id === undefined ? cur.account_id : N(b.account_id);
      const date = b.date === undefined ? cur.date : csv.parseDate(b.date, 'auto');
      if (!date) bad(`日期無法解析：${b.date}`);
      const amount = b.amount === undefined ? cur.amount : M.round2(N(b.amount));
      const description = S(b.description, cur.description);
      raw.update('txns', cur.id, {
        account_id: accountId, date, amount, description,
        category: S(b.category, cur.category), kind: S(b.kind, cur.kind),
        note: S(b.note, cur.note),
        // Recomputed, the same as the server does: the fingerprint is made of
        // exactly the four fields that can change here.
        fingerprint: csv.fingerprint(accountId, date, amount, description),
      });
      return { ok: true };
    });

    on('DELETE', '/api/txns/:id', (p) => ({ deleted: raw.remove('txns', (t) => t.id === N(p.id)) }));

    // --- transfers -------------------------------------------------------

    on('GET', '/api/transfers/candidates', () => transferCandidates());

    on('GET', '/api/transfers', () => {
      const acct = accountsById();
      const groups = new Map();
      for (const t of raw.all('txns').filter((x) => x.transfer_group)) {
        if (!groups.has(t.transfer_group)) groups.set(t.transfer_group, []);
        groups.get(t.transfer_group).push(withAccount(t, acct));
      }
      return [...groups].map(([transfer_group, legs]) => ({ transfer_group, legs }));
    });

    on('POST', '/api/transfers/apply', (_p, b) => {
      const pairs = Array.isArray(b.pairs) ? b.pairs : [];
      if (!pairs.length) bad('沒有要配對的項目');
      return {
        paired: raw.tx(() => {
          let n = 0;
          for (const p of pairs) {
            const g = newId();
            raw.update('txns', N(p.outId), { transfer_group: g, kind: 'transfer' });
            raw.update('txns', N(p.inId), { transfer_group: g, kind: 'transfer' });
            n++;
          }
          return n;
        }),
      };
    });

    on('DELETE', '/api/transfers/:group', (p) => {
      let n = 0;
      for (const t of raw.all('txns').filter((x) => x.transfer_group === String(p.group))) {
        n += raw.update('txns', t.id, { transfer_group: null, kind: 'other' });
      }
      return { unlinked: n };
    });

    // --- holdings --------------------------------------------------------

    on('GET', '/api/holdings', () => holdingsValued());

    on('POST', '/api/holdings', (_p, b) => {
      if (!S(b.symbol).trim()) bad('代號必填');
      return {
        id: raw.insert('holdings', {
          account_id: N(b.account_id), symbol: S(b.symbol).trim().toUpperCase(),
          name: S(b.name), market: S(b.market, 'TW'), shares: N(b.shares),
          avg_cost: N(b.avg_cost), last_price: N(b.last_price),
          price_date: OPT(b.price_date), currency: S(b.currency, 'TWD'), note: S(b.note),
        }).id,
      };
    });

    on('PUT', '/api/holdings/:id', (p, b) => {
      const cur = raw.get('holdings', N(p.id));
      if (!cur) missing('持股不存在');
      raw.update('holdings', cur.id, {
        account_id: b.account_id === undefined ? cur.account_id : N(b.account_id),
        symbol: S(b.symbol, cur.symbol).trim().toUpperCase(),
        name: S(b.name, cur.name), market: S(b.market, cur.market),
        shares: b.shares === undefined ? cur.shares : N(b.shares),
        avg_cost: b.avg_cost === undefined ? cur.avg_cost : N(b.avg_cost),
        last_price: b.last_price === undefined ? cur.last_price : N(b.last_price),
        price_date: b.price_date === undefined ? cur.price_date : OPT(b.price_date),
        currency: S(b.currency, cur.currency), note: S(b.note, cur.note),
      });
      return { ok: true };
    });

    on('DELETE', '/api/holdings/:id', (p) => ({
      deleted: raw.remove('holdings', (h) => h.id === N(p.id)),
    }));

    // --- fx ---------------------------------------------------------------

    on('GET', '/api/fx', () => raw.all('fx_rates').sort(by('-date')).slice(0, 400));

    on('POST', '/api/fx', (_p, b) => {
      const list = Array.isArray(b.rows) ? b.rows : [b];
      return {
        saved: raw.tx(() => {
          let n = 0;
          for (const r of list) {
            const d = csv.parseDate(r.date, 'auto');
            if (!d) bad(`日期無法解析：${r.date}`);
            const rate = N(r.rate);
            if (rate <= 0) bad('匯率必須大於 0');
            raw.put('fx_rates', { date: d, pair: S(r.pair, 'USDTWD').toUpperCase(), rate });
            n++;
          }
          return n;
        }),
      };
    });

    on('DELETE', '/api/fx/:date', (p, _b, q) => ({
      deleted: raw.remove('fx_rates',
        (r) => r.date === String(p.date) && r.pair === S(q.pair, 'USDTWD')),
    }));

    // --- reconciliation and coverage --------------------------------------

    on('GET', '/api/reconcile', () => reconcile());

    on('POST', '/api/balance-checks', (_p, b) => {
      const d = csv.parseDate(b.date, 'auto');
      if (!d) bad(`日期無法解析：${b.date}`);
      return {
        id: raw.insert('balance_checks', {
          account_id: N(b.account_id), date: d, stated: N(b.stated), note: S(b.note),
        }).id,
      };
    });

    on('DELETE', '/api/balance-checks/:id', (p) => ({
      deleted: raw.remove('balance_checks', (c) => c.id === N(p.id)),
    }));

    on('GET', '/api/coverage', (_p, _b, q) => {
      const months = Math.min(Math.max(N(q.months, M.COVERAGE_MONTHS), 1), 120);
      const to = q.to ? S(q.to) : today();
      const activity = new Map();
      for (const t of raw.all('txns').filter((x) => x.date <= to)) {
        const k = `${t.account_id}|${t.date.slice(0, 7)}`;
        const cur = activity.get(k) || { account_id: t.account_id, month: t.date.slice(0, 7), n: 0, net: 0 };
        cur.n++;
        cur.net += t.amount;
        activity.set(k, cur);
      }
      return M.computeCoverage({
        accounts: raw.all('accounts').sort(by('sort_order', 'id')),
        activity: [...activity.values()],
        checks: reconcile().map((c) => ({ account_id: c.account_id, date: c.date, ok: c.ok })),
        imports: raw.all('imports').filter((i) => i.account_id && i.date_from && i.date_to),
        to,
        months,
      });
    });

    // --- spending ----------------------------------------------------------

    const windowFrom = (q) => {
      const to = q.to ? S(q.to) : today();
      if (q.from) return { from: S(q.from), to };
      const d = new Date(`${to}T00:00:00Z`);
      d.setUTCFullYear(d.getUTCFullYear() - N(q.years, 1));
      return { from: d.toISOString().slice(0, 10), to };
    };
    const spendingRows = (from, to) => raw.all('txns')
      .filter((t) => t.date >= from && t.date <= to).sort(by('date'))
      .map(({ account_id, date, amount, description, category, kind, transfer_group }) =>
        ({ account_id, date, amount, description, category, kind, transfer_group }));
    const accountCurrencies = () => raw.all('accounts')
      .map(({ id, name, currency }) => ({ id, name, currency }));

    on('GET', '/api/spending', (_p, _b, q) => {
      const { from, to } = windowFrom(q);
      return SP.computeSpending({ txns: spendingRows(from, to), accounts: accountCurrencies(), from, to });
    });

    on('GET', '/api/recurring', (_p, _b, q) => {
      const { from, to } = windowFrom({ ...q, years: q.years || 2 });
      return SP.computeRecurring({ txns: spendingRows(from, to), accounts: accountCurrencies(), to });
    });

    // --- rules --------------------------------------------------------------

    on('GET', '/api/rules', () => listRules());

    on('POST', '/api/rules', (_p, b) => {
      const pattern = S(b.pattern).trim();
      const category = S(b.category).trim();
      if (!pattern) bad('比對字串必填');
      if (!category) bad('分類必填');
      if (!R.normalise(pattern)) bad('比對字串至少要有一個文字或數字');
      return { id: raw.insert('rules', { pattern, category, priority: N(b.priority), created_at: now() }).id };
    });

    on('PUT', '/api/rules/:id', (p, b) => {
      const cur = raw.get('rules', N(p.id));
      if (!cur) missing('規則不存在');
      const pattern = b.pattern === undefined ? cur.pattern : S(b.pattern).trim();
      if (!R.normalise(pattern)) bad('比對字串至少要有一個文字或數字');
      raw.update('rules', cur.id, {
        pattern,
        category: b.category === undefined ? cur.category : S(b.category).trim(),
        priority: b.priority === undefined ? cur.priority : N(b.priority),
      });
      return { ok: true };
    });

    on('DELETE', '/api/rules/:id', (p) => ({ deleted: raw.remove('rules', (r) => r.id === N(p.id)) }));

    on('POST', '/api/rules/apply', (_p, b) => {
      const overwrite = !!b.overwrite;
      const txns = raw.all('txns').map(({ id, description, category }) => ({ id, description, category }));
      const changes = R.plan(txns, listRules(), { overwrite });
      if (b.dry !== false) return { dry: true, changes: changes.slice(0, 200), total: changes.length };
      raw.tx(() => { for (const c of changes) raw.update('txns', c.id, { category: c.to }); });
      return { dry: false, applied: changes.length };
    });

    // --- mappings ------------------------------------------------------------

    on('GET', '/api/mappings', () => raw.all('mappings').sort(by('-used_at', 'name'))
      .map((m) => ({ ...m, config: JSON.parse(m.config) })));

    on('POST', '/api/mappings', (_p, b) => {
      const name = S(b.name).trim();
      if (!name) bad('對應名稱必填');
      const cfg = JSON.stringify(b.config || {});
      const cur = raw.all('mappings').find((m) => m.name === name);
      if (cur) raw.update('mappings', cur.id, { config: cfg });
      else raw.insert('mappings', { name, config: cfg, created_at: now(), used_at: null });
      return { ok: true, name };
    });

    on('DELETE', '/api/mappings/:id', (p) => ({
      deleted: raw.remove('mappings', (m) => m.id === N(p.id)),
    }));

    // --- import ---------------------------------------------------------------

    function existingCounts(accountId) {
      const mine = raw.all('txns').filter((t) => t.account_id === accountId);
      const fingerprints = new Map();
      for (const t of mine) fingerprints.set(t.fingerprint, (fingerprints.get(t.fingerprint) || 0) + 1);
      return {
        fingerprints,
        externalIds: new Set(mine.map((t) => t.external_id).filter((v) => v !== null && v !== undefined)),
      };
    }

    const rowSpan = (rows) => {
      const dates = rows.map((r) => r.date).filter(Boolean).sort();
      return { from: dates[0] || null, to: dates[dates.length - 1] || null };
    };

    // Base64 in both environments: Node has Buffer, a browser has atob. The
    // views send `content_base64` because that is what survives a JSON body.
    function decodeBase64(b64) {
      if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    on('POST', '/api/import/preview', (_p, b) => {
      const accountId = N(b.account_id);
      const account = accountId ? raw.get('accounts', accountId) : null;
      if (accountId && !account) missing('帳戶不存在');
      const buf = decodeBase64(S(b.content_base64));
      if (!buf.length) bad('檔案是空的');

      const { text, encoding } = csv.decode(buf, S(b.encoding, 'auto') || 'auto');
      const delimiter = (b.mapping && b.mapping.delimiter) || csv.sniffDelimiter(text);
      const grid = csv.parseCsv(text, delimiter);
      if (!grid.length) bad('這個檔案解析不出任何一行');

      const headerRow = b.mapping && b.mapping.headerRow
        ? Math.max(1, N(b.mapping.headerRow, 1))
        : csv.detectHeaderRow(grid);
      const headers = grid[headerRow - 1] || [];
      const mapping = b.mapping && b.mapping.dateCol !== undefined && b.mapping.dateCol !== null
        ? { ...b.mapping, delimiter, encoding }
        : { ...csv.guessMapping(headers, grid.slice(headerRow)), delimiter, encoding, headerRow };

      const { rows } = csv.extractRows(grid, mapping, accountId);
      csv.markDuplicates(rows, existingCounts(accountId));

      const summary = rows.reduce(
        (acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; },
        { new: 0, duplicate: 0, error: 0, pending: 0 }
      );
      const fresh = rows.filter((r) => r.status === 'new');
      const net = M.round2(fresh.reduce((s, r) => s + r.amount, 0));

      let reconcileInfo = null;
      if (account) {
        const before = accountsWithBalances().find((a) => a.id === account.id)?.balance ?? 0;
        const after = M.round2(before + net);
        const lastWithBalance = csv.inDateOrder(rows).filter((r) => r.balance !== null && !r.ragged).pop();
        const stated = lastWithBalance ? lastWithBalance.balance : null;
        reconcileInfo = {
          before,
          after,
          stated,
          stated_on: lastWithBalance ? lastWithBalance.date : null,
          matches: stated === null ? null : Math.abs(after - stated) < 0.005,
          drift: stated === null ? null : M.round2(after - stated),
        };
      }

      return {
        encoding, delimiter, headers, mapping,
        account: account
          ? { id: account.id, name: account.name, kind: account.kind, currency: account.currency }
          : null,
        suggested_account: accountId
          ? null
          : csv.suggestAccount({ filename: S(b.filename), headers, rows, mapping }),
        grid_preview: grid.slice(0, Math.max(headerRow + 5, 8)),
        rows: rows.slice(0, 500),
        truncated: rows.length > 500,
        summary: {
          ...summary,
          total: rows.length,
          repaired: rows.filter((r) => r.repaired).length,
          balance_breaks: rows.filter((r) => r.balanceBreak !== undefined).length,
          sign_suspect:
            M.LIABILITY_KINDS.has(S(account && account.kind)) &&
            fresh.filter((r) => r.amount > 0).length > fresh.filter((r) => r.amount < 0).length,
          net,
          date_min: fresh.length ? fresh.reduce((a, r) => (r.date < a ? r.date : a), fresh[0].date) : null,
          date_max: fresh.length ? fresh.reduce((a, r) => (r.date > a ? r.date : a), fresh[0].date) : null,
          span_from: rowSpan(rows).from,
          span_to: rowSpan(rows).to,
        },
        reconcile: reconcileInfo,
      };
    });

    on('POST', '/api/import/commit', (_p, b) => {
      const accountId = N(b.account_id);
      if (!accountId) bad('請先選擇要匯入的帳戶');
      const buf = decodeBase64(S(b.content_base64));
      const mapping = b.mapping || bad('缺少欄位對應設定');

      const { text } = csv.decode(buf, mapping.encoding || 'auto');
      const grid = csv.parseCsv(text, mapping.delimiter || ',');
      const { rows } = csv.extractRows(grid, mapping, accountId);
      csv.markDuplicates(rows, existingCounts(accountId));

      const skipLines = new Set((b.skip_lines || []).map(Number));
      const toInsert = rows.filter((r) => r.status === 'new' && !skipLines.has(r.lineNo));

      const span = rowSpan(rows);
      const declaredFrom = OPT(b.period_from) && S(b.period_from);
      const declaredTo = OPT(b.period_to) && S(b.period_to);
      const declared = !!(declaredFrom && declaredTo);
      if (declared && declaredFrom > declaredTo) bad('期間的起日不能晚於迄日');
      if (declared) {
        const outside = rows.filter((r) => r.date && (r.date < declaredFrom || r.date > declaredTo));
        if (outside.length) {
          bad(
            `宣告的期間是 ${declaredFrom} 到 ${declaredTo}，但檔案裡有 ${outside.length} 行落在期間外` +
              `（${outside[0].date} 等）。期間填錯了，或這份檔案不是你以為的那一份。`
          );
        }
      }

      const ruleList = listRules();
      const importId = raw.tx(() => {
        const imp = raw.insert('imports', {
          account_id: accountId, filename: S(b.filename, 'upload.csv'),
          mapping: JSON.stringify(mapping), imported: 0, skipped: 0, created_at: now(),
          date_from: declared ? declaredFrom : span.from,
          date_to: declared ? declaredTo : span.to,
          period_kind: declared ? 'declared' : 'derived',
        });
        for (const r of toInsert) {
          insertTxn({
            account_id: accountId, date: r.date, amount: r.amount,
            description: r.description,
            category: r.category || R.categorise(r.description, ruleList),
            kind: S(b.default_kind, 'other'),
            source: 'csv', external_id: r.externalId, fingerprint: r.fingerprint,
          }, imp.id);
        }
        raw.update('imports', imp.id, {
          imported: toInsert.length, skipped: rows.length - toInsert.length,
        });
        return imp.id;
      });

      if (b.save_mapping_as) {
        const name = String(b.save_mapping_as).trim();
        const cur = raw.all('mappings').find((m) => m.name === name);
        const cfg = JSON.stringify(mapping);
        if (cur) raw.update('mappings', cur.id, { config: cfg, used_at: now() });
        else raw.insert('mappings', { name, config: cfg, created_at: now(), used_at: now() });
      }

      return {
        import_id: importId,
        imported: toInsert.length,
        skipped: rows.length - toInsert.length,
        transfer_candidates: transferCandidates().length,
        // No filesystem, so no snapshot. The import view already renders this
        // as "no backup" rather than inventing a filename.
        backup: null,
      };
    });

    on('GET', '/api/imports', () => {
      const acct = accountsById();
      return raw.all('imports').sort(by('-id')).slice(0, 50)
        .map((i) => ({ ...i, account_name: acct.get(i.account_id)?.name ?? null }));
    });

    on('DELETE', '/api/imports/:id', (p) => {
      const id = N(p.id);
      return raw.tx(() => {
        const reverted = raw.remove('txns', (t) => t.import_id === id);
        raw.remove('imports', (i) => i.id === id);
        return { reverted };
      });
    });

    // --- settings and export -------------------------------------------------

    on('GET', '/api/backups', () => []);

    on('GET', '/api/settings', () => ({
      base_currency: (raw.get('meta', 'base_currency') || {}).value || 'TWD',
      schema_version: SCHEMA_VERSION,
      profile: 'demo',
      // What turns the sidebar badge amber. A visitor must never have to
      // wonder whether the numbers on screen are theirs.
      is_personal: false,
      // There is no file. The chrome reads this to say where the data lives,
      // and for the demo the honest answer is "nowhere that survives".
      db_path: null,
    }));

    on('PUT', '/api/settings', (_p, b) => {
      if (b.base_currency) raw.put('meta', { key: 'base_currency', value: String(b.base_currency).toUpperCase() });
      return { ok: true };
    });

    const exportJson = () => ({
      exported_at: now(),
      base_currency: (raw.get('meta', 'base_currency') || {}).value || 'TWD',
      institutions: raw.all('institutions'),
      accounts: raw.all('accounts'),
      txns: raw.all('txns'),
      holdings: raw.all('holdings'),
      fx_rates: raw.all('fx_rates'),
      balance_checks: raw.all('balance_checks'),
      mappings: raw.all('mappings'),
    });

    on('GET', '/api/export/json', () => exportJson());

    // --- dispatch --------------------------------------------------------------

    // The path carries its own query string, and `DELETE /api/fx/:date` is
    // the one non-GET that reads one — a router that splits on the path
    // alone deletes the wrong rate.
    //
    // Split by hand rather than with `new URL(path, base)`: that needs an
    // absolute base, and any hostname written here — however unresolvable —
    // is a string `test/deps.test.js` has to be argued out of flagging. The
    // no-outbound scan being hard to satisfy is the scan working.
    function splitPath(rawPath) {
      const q = rawPath.indexOf('?');
      return q === -1
        ? { pathname: rawPath, query: {} }
        : {
          pathname: rawPath.slice(0, q),
          query: Object.fromEntries(new URLSearchParams(rawPath.slice(q + 1))),
        };
    }

    function dispatch(method, rawPath, body) {
      const { pathname, query } = splitPath(rawPath);
      for (const r of ROUTES) {
        if (r.method !== method) continue;
        const m = pathname.match(r.rx);
        if (!m) continue;
        const params = {};
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        return r.fn(params, body, query);
      }
      throw new DemoError(404, `無此 API：${method} ${pathname}`);
    }

    // The file an export produces, as data. `exportHref` wraps it in a Blob
    // for the browser; the tests read it directly, because asserting on bytes
    // beats asserting on a `blob:` URL nothing can open.
    function exportFile(rawPath) {
      const { pathname, query } = splitPath(rawPath);
      if (pathname === '/api/export/json') {
        return { name: 'finance_backup.json', type: 'application/json', body: JSON.stringify(exportJson(), null, 2) };
      }
      const type = query.type || 'txns';
      const acct = accountsById();
      const { name, body } = X.exportCsv({
        type,
        accounts: accountsWithBalances(),
        holdings: holdingsValued(),
        txns: raw.all('txns').sort(by('-date', '-id')).map((t) => withAccount(t, acct)),
      });
      return { name: `${name}_${today()}.csv`, type: 'text/csv;charset=utf-8', body };
    }

    // Revoked on the next call rather than left to the page's lifetime: a
    // settings view re-rendered fifty times would otherwise hold fifty copies
    // of the ledger alive.
    let lastUrl = null;
    function exportHref(path) {
      if (typeof URL.createObjectURL !== 'function') return path;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      const { body, type } = exportFile(path);
      lastUrl = URL.createObjectURL(new Blob([body], { type }));
      return lastUrl;
    }

    return {
      name: 'demo',
      async get(p) { return dispatch('GET', p, {}); },
      async post(p, b) { return dispatch('POST', p, b); },
      async put(p, b) { return dispatch('PUT', p, b); },
      async del(p) { return dispatch('DELETE', p, {}); },
      exportHref,
      // A blob: URL carries no filename, so the adapter has to supply one.
      // The HTTP adapter returns null because the server's
      // Content-Disposition already did.
      exportName: (p) => exportFile(p).name,
      // Demo-only, and the reason the tests can assert on bytes.
      exportFile,
      reset: (seed) => raw.reset(seed),
      raw,
    };
  }

  const api = { makeMapStore, createDemoStorage, DemoError, TABLES, SCHEMA_VERSION };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
