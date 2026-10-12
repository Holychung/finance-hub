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
  const O = dep ? require('../shared/overview') : root;
  const I = dep ? require('../shared/import') : root;
  const H = dep ? require('../shared/handlers') : root;

  // The demo's shape is shipped with the code, so this is a statement about
  // the seed rather than a version anything migrates to. It has to be the
  // last step in server/migrations.js, because the seed carries every column
  // that step added; test/demo-store.test.js compares it with a fresh server.
  const SCHEMA_VERSION = '12';

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
    budgets: { key: 'id' },
    // The one table with no id: the schema's primary key is (date, pair).
    fx_rates: { key: (r) => `${r.date}|${r.pair}` },
    // Same shape, keyed by the security and the day — the SQLite PK.
    prices: { key: (r) => `${r.symbol}|${r.market}|${r.date}` },
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

  // The shared handlers' error, under the name this file has always exported,
  // so a refusal reads the same whichever side raised it.
  const DemoError = H.ApiError;

  // The same coercions api.js applies, because the views send the same things
  // and a demo that accepted a string where the server wanted a number would
  // pass here and fail there.
  const S = (v, d = '') => (v === undefined || v === null ? d : String(v));
  const N = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const B = (v, d = 1) => (v === undefined || v === null ? d : v ? 1 : 0);
  const OPT = (v) => (v === undefined || v === '' ? null : v);
  const bad = (m) => { throw new DemoError(400, m); };
  const missing = (m) => { throw new DemoError(404, m); };
  const conflict = (m) => { throw new DemoError(409, m); };

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
    // Refused when registered twice, as server/api.js refuses it: dispatch
    // takes the first match, so a route moved into shared/handlers.js and left
    // behind here would answer instead of the shared one.
    const ROUTES = [];
    const on = (method, pattern, fn) => {
      if (ROUTES.some((r) => r.method === method && r.pattern === pattern)) {
        throw new Error(`路由重複註冊：${method} ${pattern}`);
      }
      ROUTES.push({ method, pattern, ...compile(pattern), fn });
    };

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

    const priceLookup = () => M.computePriceLookup({
      rows: raw.all('prices').sort(by('symbol', 'market', 'date')),
    });

    const holdingsValued = (asOf = today()) => {
      const acct = accountsById();
      return M.computeHoldingsValued({
        holdings: raw.all('holdings').sort(by('market', 'symbol'))
          .map((h) => ({ ...h, account_name: acct.get(h.account_id)?.name || '' })),
        priceLookup: priceLookup(),
        asOf,
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
            description: t.description, kind: t.kind,
            currency: acct.get(t.account_id)?.currency,
            account_name: acct.get(t.account_id)?.name,
          })),
        fx: fxLookup(),
        ...opts,
      });
    };

    // Where a line over the whole book starts, as server/money.js's
    // seriesStart: the first transaction, else the earliest opening date.
    const seriesStart = (asOf) => {
      const dates = raw.all('txns').map((t) => t.date).sort();
      const opens = raw.all('accounts').map((a) => a.opening_date).sort();
      return dates[0] || opens[0] || asOf;
    };

    // The grid /api/coverage answers with, and the overview export states
    // the gaps of. Its monthly totals are the SUM … GROUP BY the server runs.
    const coverage = ({ to = today(), months = M.COVERAGE_MONTHS } = {}) => {
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
      const from = seriesStart(asOf);
      const upTo = raw.all('txns').filter((t) => t.date <= asOf).sort(by('date'));
      const seriesOf = (access) => M.computeNetWorthSeries({
        accounts: raw.all('accounts'), txns: upTo, from, to: asOf, access,
      });

      return {
        net_worth: M.computeNetWorth({ accounts, holdings, asOf }),
        accounts,
        holdings,
        series: seriesOf(null),
        series_by_access: Object.fromEntries(ACCESS_KEYS.map((k) => [k, seriesOf(k)])),
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

    // What the import commit below writes each row with, until the import
    // routes join the others in shared/handlers.js.
    function insertTxn(b, importId = null) {
      const accountId = N(b.account_id);
      if (!accountId) bad('account_id 必填');
      const date = csv.parseDate(b.date, 'auto');
      if (!date) bad(`日期無法解析：${b.date}`);
      const amount = M.round2(N(b.amount));
      const desc = S(b.description);
      return raw.insert('txns', {
        account_id: accountId, date, amount, description: desc,
        category: S(b.category), kind: S(b.kind, DEFAULT_TXN_KIND),
        transfer_group: null,
        source: S(b.source, 'manual'), external_id: OPT(b.external_id),
        fingerprint: S(b.fingerprint) || csv.fingerprint(accountId, date, amount, desc),
        import_id: importId, note: S(b.note), created_at: now(),
      }).id;
    }

    // --- the shared routes -------------------------------------------------

    // The rows spending, recurring and budgets read over one window, and the
    // ones 月度審計 reads with their ids, two years back from `to`: the queries
    // server/money.js and server/ledger.js run, over the Map.
    const spendingRows = (from, to) => raw.all('txns')
      .filter((t) => t.date >= from && t.date <= to).sort(by('date'))
      .map(({ account_id, date, amount, description, category, kind, transfer_group }) =>
        ({ account_id, date, amount, description, category, kind, transfer_group }));
    const accountCurrencies = () => raw.all('accounts')
      .map(({ id, name, currency }) => ({ id, name, currency }));
    const auditRows = (to) => {
      const from = `${Number(to.slice(0, 4)) - 2}${to.slice(4, 7)}-01`;
      return raw.all('txns').filter((t) => t.date >= from && t.date <= to)
        .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
        .map(({ id, account_id, date, amount, description, category, kind, transfer_group }) =>
          ({ id, account_id, date, amount, description, category, kind, transfer_group }));
    };

    // A row whose columns equal `match`, as SQL's `=` reads it: NULL equals
    // nothing. An empty match is refused, as the server's port refuses it.
    const matching = (match) => {
      if (!Object.keys(match).length) throw new Error('ledger: 沒有條件');
      return (r) => Object.entries(match).every(([k, v]) => v !== null && r[k] === v);
    };

    // SQLite's LIKE, which is what the server searches with: `%` any run of
    // characters, `_` exactly one, letters folded for ASCII only — so `_`,
    // `%` and an accented capital mean the same on both sides. Walked, not
    // turned into a RegExp, so nothing typed becomes a pattern to backtrack.
    const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const like = (pattern, value) => {
      const p = [...asciiLower(pattern)];
      const s = [...asciiLower(value)];
      let i = 0;
      let j = 0;
      let star = -1;
      let mark = 0;
      while (i < s.length) {
        if (j < p.length && (p[j] === '_' || (p[j] !== '%' && p[j] === s[i]))) { i++; j++; }
        else if (j < p.length && p[j] === '%') { star = j++; mark = i; }
        else if (star !== -1) { j = star + 1; i = ++mark; }
        else return false;
      }
      while (p[j] === '%') j++;
      return j === p.length;
    };

    // The demo's half of the ledger port shared/handlers.js runs on, the same
    // methods server/ledger.js answers in SQL.
    const ledger = {
      all: (table) => raw.all(table).sort(by('id')),
      get: (table, id) => raw.get(table, id) || null,
      insert: (table, row) => raw.insert(table, row).id,
      update: (table, id, patch) => raw.update(table, id, patch),
      remove: (table, id) => raw.remove(table, (x) => x.id === id),
      // The two keyed tables: `put` merges by the table's key, as ON CONFLICT
      // does, and a delete names the whole key.
      upsert: (table, row) => { raw.put(table, row); },
      removeKey: (table, key) => raw.remove(table, (r) => Object.entries(key).every(([k, v]) => r[k] === v)),
      removeWhere: (table, match) => raw.remove(table, matching(match)),
      updateWhere: (table, match, patch) => raw.all(table).filter(matching(match))
        .reduce((n, r) => n + raw.update(table, r.id, patch), 0),
      tx: (fn) => raw.tx(fn),
      getMeta: (key, fallback = null) => { const r = raw.get('meta', key); return r ? r.value : fallback; },
      setMeta: (key, value) => { raw.put('meta', { key, value: String(value) }); },
      spendingRows,
      accountCurrencies,
      transferCandidates: () => transferCandidates(),
      reconcile: () => reconcile(),
      coverage: (opts) => coverage(opts),
      holdingsValued: (asOf) => holdingsValued(asOf),
      accountsWithBalances: (asOf) => accountsWithBalances(asOf),

      // As server/money.js's accountSeries: the net worth walk over a book of
      // one, starting on the opening date. null for no such account.
      accountSeries: (id, to) => {
        const a = raw.get('accounts', id);
        if (!a) return null;
        const txns = raw.all('txns').filter((t) => t.account_id === a.id && t.date <= to).sort(by('date'));
        const from = a.opening_date || (txns[0] && txns[0].date) || to;
        return M.computeNetWorthSeries({ accounts: [a], txns, from, to })[a.currency] || [];
      },

      txnPage: ({ account, from, to, kind, q }, limit, offset) => {
        const acct = accountsById();
        const needle = q === null ? null : `%${q}%`;
        const rows = raw.all('txns').filter((t) => (account === null || t.account_id === account)
          && (from === null || t.date >= from) && (to === null || t.date <= to)
          && (kind === null || t.kind === kind)
          && (needle === null || [t.description, t.category, t.note]
            .some((v) => v !== null && v !== undefined && like(needle, String(v)))));
        const dates = rows.map((t) => t.date).sort();
        return {
          total: rows.length,
          // Every matching row's, like the server's MIN/MAX — null when none match.
          first: dates[0] || null,
          last: dates[dates.length - 1] || null,
          rows: rows.sort(by('-date', '-id')).slice(offset, offset + limit).map((t) => withAccount(t, acct)),
        };
      },

      transferLegs: () => {
        const acct = accountsById();
        return raw.all('txns').filter((t) => t.transfer_group).sort(by('-date', 'transfer_group', 'id'))
          .map((t) => ({
            transfer_group: t.transfer_group, id: t.id, account_id: t.account_id, date: t.date,
            amount: t.amount, description: t.description,
            account_name: acct.get(t.account_id)?.name, currency: acct.get(t.account_id)?.currency,
          }));
      },
      institutions: () => raw.all('institutions').sort(by('country', 'name')),
      prices: (symbol, market) => raw.all('prices')
        .filter((r) => r.symbol === symbol && r.market === market).sort(by('-date')),
      fxRates: () => raw.all('fx_rates').sort(by('-date')).slice(0, 400),
      txnDescriptions: () => raw.all('txns').sort(by('id'))
        .map(({ id, description, category }) => ({ id, description, category })),
      mappings: () => raw.all('mappings').sort(by('-used_at', 'name')),
      auditRows,
    };

    // Written once in shared/handlers.js, and registered by server/api.js too.
    H.defineLedgerRoutes(on, { L: ledger, now, today, uuid: newId });

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

    const balanceOf = (id, asOf) => accountsWithBalances(asOf).find((a) => a.id === id)?.balance ?? 0;

    // server/api.js's analyseImport, over the Map.
    function analyseImport(account, grid, mapping, skipLines) {
      const skip = I.importListParam(skipLines, 'skip_lines');
      if (skip.error) bad(skip.error);
      const { rows } = csv.extractRows(grid, mapping, account ? account.id : null);
      csv.markDuplicates(rows, existingCounts(account ? account.id : null));
      I.skipImportRows(rows, skip);
      const st = I.statedBalance(rows);
      const { summary, reconcile } = I.computeImportSummary({
        rows, account,
        before: account ? balanceOf(account.id) : null,
        ledgerOn: account && st ? balanceOf(account.id, st.stated_on) : null,
      });
      return { rows, summary, reconcile, issues: I.importIssues({ summary, reconcile, rows, mapping }) };
    }

    const accountRef = (a) => ({ id: a.id, name: a.name, kind: a.kind, currency: a.currency });

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

      const ref = account ? accountRef(account) : null;
      const { rows, summary, reconcile, issues } = analyseImport(ref, grid, mapping, b.skip_lines);

      return {
        encoding, delimiter, headers, mapping,
        account: ref,
        suggested_account: accountId
          ? null
          : csv.suggestAccount({ filename: S(b.filename), headers, rows, mapping }),
        grid_preview: grid.slice(0, Math.max(headerRow + 5, 8)),
        rows: rows.slice(0, 500),
        truncated: rows.length > 500,
        summary,
        reconcile,
        issues,
      };
    });

    on('POST', '/api/import/commit', (_p, b) => {
      const accountId = N(b.account_id);
      if (!accountId) bad('請先選擇要匯入的帳戶');
      const buf = decodeBase64(S(b.content_base64));
      const mapping = b.mapping || bad('缺少欄位對應設定');
      const stored = raw.get('accounts', accountId) || missing('帳戶不存在');
      const account = accountRef(stored);

      const { text } = csv.decode(buf, mapping.encoding || 'auto');
      const grid = csv.parseCsv(text, mapping.delimiter || ',');
      const { rows, summary, reconcile, issues } = analyseImport(account, grid, mapping, b.skip_lines);

      const accept = I.importListParam(b.accept, 'accept');
      if (accept.error) bad(accept.error);
      const refusal = I.commitRefusal(issues, accept);
      if (refusal) conflict(refusal);

      const toInsert = rows.filter((r) => r.status === 'new');
      if (!toInsert.length) bad('這份檔案沒有新的交易可以匯入');

      const span = I.fileSpan(rows);
      const declaredFrom = OPT(b.period_from) && S(b.period_from);
      const declaredTo = OPT(b.period_to) && S(b.period_to);
      const declared = !!(declaredFrom && declaredTo);
      if (declared) {
        const problem = I.periodProblem({ from: declaredFrom, to: declaredTo }, span);
        if (problem) bad(problem);
      }
      const period = declared
        ? { from: declaredFrom, to: declaredTo, kind: 'declared' }
        : { from: span.from, to: span.to, kind: 'derived' };

      const ruleList = listRules();
      const importId = raw.tx(() => {
        const imp = raw.insert('imports', {
          account_id: accountId, filename: S(b.filename, 'upload.csv'),
          mapping: JSON.stringify(mapping), imported: 0, skipped: 0, created_at: now(),
          date_from: period.from,
          date_to: period.to,
          period_kind: period.kind,
          span_from: span.from,
          span_to: span.to,
        });
        for (const r of toInsert) {
          insertTxn({
            account_id: accountId, date: r.date, amount: r.amount,
            description: r.description,
            category: r.category || R.categorise(r.description, ruleList),
            kind: r.kind || S(b.default_kind, DEFAULT_TXN_KIND),
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
        account,
        summary,
        reconcile,
        period,
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

    on('PUT', '/api/imports/:id', (p, b) => {
      const imp = raw.get('imports', N(p.id)) || missing('匯入紀錄不存在');
      if (!imp.span_from || !imp.span_to) bad('這筆匯入沒有記下檔案的範圍（是舊版匯入的），涵蓋期間不能再改。');
      const rawFrom = OPT(b.period_from);
      const rawTo = OPT(b.period_to);
      if (!!rawFrom !== !!rawTo) bad('期間要有起日和迄日');
      const from = rawFrom && (csv.parseDate(rawFrom, 'ymd') || bad(`日期無法解析：${rawFrom}`));
      const to = rawTo && (csv.parseDate(rawTo, 'ymd') || bad(`日期無法解析：${rawTo}`));
      const span = { from: imp.span_from, to: imp.span_to };
      if (from) {
        const problem = I.periodProblem({ from, to }, span);
        if (problem) bad(problem);
      }
      const period = from ? { from, to, kind: 'declared' } : { ...span, kind: 'derived' };
      raw.update('imports', imp.id, { date_from: period.from, date_to: period.to, period_kind: period.kind });
      return { id: imp.id, period };
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
      // The hosted demo is incapable of an outbound call (its CSP ships
      // `connect-src 'none'`), so auto price fetch is always off here and the
      // settings card that toggles it is hidden — it keys on db_path.
      auto_prices: false,
      prices_fetched_on: null,
      prices_fetched_at: null,
      // No AI can be reached from here at all, so the demo is 晴天 by
      // construction, and PUT /api/ai below refuses to make it anything else.
      ai_reach: 'none',
    }));

    on('PUT', '/api/settings', (_p, b) => {
      if (b.base_currency) raw.put('meta', { key: 'base_currency', value: String(b.base_currency).toUpperCase() });
      return { ok: true };
    });

    // Answered so the route exists, but the demo can never reach the network,
    // so it is always a no-op reporting itself disabled.
    on('POST', '/api/prices/refresh', () => ({ enabled: false, updated: [], failed: [] }));

    // AI 健檢 needs a server to make the call and a page allowed to reach one,
    // and the hosted demo has neither, by design. So the status says so, and
    // every route that would configure it or send is refused in one sentence
    // rather than answered with something that looks like it worked.
    const NO_AI = '示範版不能用 AI 健檢：這裡沒有伺服器，頁面也被 CSP 禁止對外連線。'
      + '在自己的電腦上跑 node server/index.js 才有。';
    on('GET', '/api/ai', () => ({ available: false, reason: NO_AI }));
    for (const [method, pattern] of [
      ['PUT', '/api/ai'], ['GET', '/api/ai/preview'], ['POST', '/api/ai/review'],
    ]) on(method, pattern, () => bad(NO_AI));

    const exportJson = () => ({
      exported_at: now(),
      base_currency: (raw.get('meta', 'base_currency') || {}).value || 'TWD',
      institutions: raw.all('institutions'),
      accounts: raw.all('accounts'),
      txns: raw.all('txns'),
      holdings: raw.all('holdings'),
      prices: raw.all('prices'),
      fx_rates: raw.all('fx_rates'),
      balance_checks: raw.all('balance_checks'),
      mappings: raw.all('mappings'),
      budgets: raw.all('budgets'),
    });

    on('GET', '/api/export/json', () => exportJson());

    // server/money.js's overview(), piece for piece, from the Map: the same
    // loaders over the same windows, and shared/overview.js doing the rest.
    const overview = (to) => {
      const accounts = accountsWithBalances(to);
      const holdings = holdingsValued(to);
      const currencies = accountCurrencies();
      const spendFrom = SP.yearsBefore(to, 1);
      const recurFrom = SP.yearsBefore(to, 2);
      return O.computeOverview({
        asOf: to,
        netWorth: M.computeNetWorth({ accounts, holdings, asOf: to }),
        accounts,
        holdings,
        series: M.computeNetWorthSeries({
          accounts: raw.all('accounts'),
          txns: raw.all('txns').filter((t) => t.date <= to).sort(by('date')),
          from: seriesStart(to),
          to,
        }),
        spending: SP.computeSpending({ txns: spendingRows(spendFrom, to), accounts: currencies, from: spendFrom, to }),
        recurring: SP.computeRecurring({ txns: spendingRows(recurFrom, to), accounts: currencies, to }),
        coverage: coverage({ to }),
        reconcile: reconcile(),
        transferCandidates: transferCandidates(),
      });
    };

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
      if (pathname === '/api/export/overview') {
        const asOf = query.to ? csv.parseDate(query.to, 'auto') : today();
        if (!asOf) bad(`日期無法解析：${query.to}`);
        return { name: `overview_${asOf}.md`, type: 'text/markdown;charset=utf-8', body: O.overviewMarkdown(overview(asOf)) };
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

    // One live URL per export, revoked when that export's link is built again.
    // Revoking whichever URL came last — what this did at first — stopped a
    // settings view re-rendered fifty times from holding fifty copies of the
    // ledger alive, but a page builds all its links in one render, so every
    // link except the newest pointed at a revoked blob: settings' 完整 JSON
    // 備份 and its first CSVs downloaded nothing. Per path keeps both halves.
    const liveUrls = new Map();
    function exportHref(path) {
      if (typeof URL.createObjectURL !== 'function') return path;
      if (liveUrls.has(path)) URL.revokeObjectURL(liveUrls.get(path));
      const { body, type } = exportFile(path);
      const url = URL.createObjectURL(new Blob([body], { type }));
      liveUrls.set(path, url);
      return url;
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
