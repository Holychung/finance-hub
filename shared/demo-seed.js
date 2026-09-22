'use strict';

// The demo book: one definition, two places that open it.
//
// `scripts/seed-demo.js` writes these rows into a SQLite profile so the real
// app can be looked at with something in it. `web/storage.js` loads the same
// rows into the in-memory store so the hosted demo can. Two hand-written
// fake ledgers would drift the first time either was touched, and the whole
// point of a demo is that what a visitor sees is what the app does.
//
// So this returns **table rows, ids already assigned** — exactly the shape
// `makeMapStore` takes and exactly what the seeder inserts, verbatim. Neither
// consumer gets to reinterpret anything, and `test/seed.test.js` builds a
// book both ways and compares them.
//
// **Everything here is invented**, the same rule `test/fixtures/` lives
// under: merchants, amounts, account numbers, the lot. Nothing came off
// anybody's statement. A demo carved out of a real export would be the worst
// available mistake in a project whose entire pitch is that the data never
// leaves the machine.
//
// Deterministic, given the same `to` and `months`: the jitter runs off a
// fixed seed, so the same call twice produces the same book and a test can
// assert on it. `now` and `uuid` are injected for the same reason.

(function (root) {
  const dep = typeof module !== 'undefined' && module.exports;
  const { round2 } = dep ? require('./money') : root;
  const { fingerprint } = dep ? require('./csv') : root;

  // A linear congruential generator, four lines, because "no dependencies"
  // includes not reaching for a seeded-random package to wobble a rent
  // payment.
  function makeRandom(seed) {
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    return {
      rnd,
      wobble: (base, pct) => round2(base * (1 + (rnd() * 2 - 1) * pct)),
      pick: (xs) => xs[Math.floor(rnd() * xs.length)],
    };
  }

  const monthKey = (d) => d.slice(0, 7);
  const addMonths = (iso, n) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 10);
  };
  const dayIn = (month, day) => `${month}-${String(day).padStart(2, '0')}`;
  const lastDayOf = (month) => {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  };

  const INSTITUTIONS = [
    { key: 'esun', name: '玉山銀行', kind: 'bank', country: 'TW' },
    { key: 'cathay', name: '國泰世華', kind: 'bank', country: 'TW' },
    { key: 'sinopac', name: '永豐金證券', kind: 'broker', country: 'TW' },
    { key: 'chase', name: 'Chase', kind: 'bank', country: 'US' },
    { key: 'firstrade', name: 'Firstrade', kind: 'broker', country: 'US' },
  ];

  // Five kinds across two currencies, which is the point: with only cash
  // accounts every breakdown reads 100% and the diverging asset/liability
  // scale the charts were built for never appears. `openAt` is an offset in
  // months from the start of the window — 國泰 opens late on purpose, so the
  // series shows an account joining and the coverage grid shows months it
  // predates.
  const ACCOUNTS = [
    { key: 'esun', inst: 'esun', name: '玉山 活存', kind: 'cash', currency: 'TWD', openAt: 0, target: 618400 },
    { key: 'cathay', inst: 'cathay', name: '國泰 數位帳戶', kind: 'cash', currency: 'TWD', openAt: 8, target: 184200 },
    { key: 'esuncard', inst: 'esun', name: '玉山 信用卡', kind: 'card', currency: 'TWD', openAt: 0, target: -38600 },
    { key: 'mortgage', inst: 'cathay', name: '房貸', kind: 'loan', currency: 'TWD', openAt: 0, target: -1847000 },
    { key: 'sinopac', inst: 'sinopac', name: '永豐金 交割戶', kind: 'brokerage', currency: 'TWD', openAt: 0, target: 96300 },
    { key: 'chase', inst: 'chase', name: 'Chase Checking', kind: 'cash', currency: 'USD', openAt: 0, target: 14580 },
    { key: 'sapphire', inst: 'chase', name: 'Chase Sapphire', kind: 'card', currency: 'USD', openAt: 0, target: -2140 },
    { key: 'firstrade', inst: 'firstrade', name: 'Firstrade', kind: 'brokerage', currency: 'USD', openAt: 0, target: 4260 },
    // Self-custody: no institution and no cash of its own — its whole value is
    // the coin in `holdings`, which is what a wallet is. It has no statements
    // either, so the coverage grid reports every month since it opened as a
    // gap. Whether an account with nothing to import belongs in that grid is
    // decision 3 in docs/plans/asset-classes.md, still open; the demo shows
    // what the app does today rather than tuning the dates to hide it.
    { key: 'coldwallet', inst: null, name: '冷錢包', kind: 'wallet', currency: 'USD', openAt: 12, target: 0 },
  ];

  const HOLDINGS = [
    // `decimals` is each market's default (TW whole shares, US to four, a coin
    // to eight), stated rather than left to the column default so the book the
    // browser builds and the one SQLite stores are the same rows.
    { account: 'sinopac', symbol: '2330', name: '台積電', market: 'TW', shares: 500, avg_cost: 982, last_price: 1085, currency: 'TWD', decimals: 0 },
    { account: 'sinopac', symbol: '0050', name: '元大台灣50', market: 'TW', shares: 3000, avg_cost: 171.4, last_price: 195.2, currency: 'TWD', decimals: 0 },
    { account: 'firstrade', symbol: 'VTI', name: 'Vanguard Total Stock Market', market: 'US', shares: 80, avg_cost: 251.3, last_price: 288.4, currency: 'USD', decimals: 4 },
    { account: 'firstrade', symbol: 'AAPL', name: 'Apple Inc.', market: 'US', shares: 40, avg_cost: 205.8, last_price: 242.1, currency: 'USD', decimals: 4 },
    // Eight places, all of them carrying a digit, so the page shows a quantity
    // the old four-place rule would have printed as 0.1235.
    { account: 'coldwallet', symbol: 'BTC', name: 'Bitcoin', market: 'CRYPTO', shares: 0.12345678, avg_cost: 51800, last_price: 63250.4, currency: 'USD', decimals: 8 },
  ];

  // Only the card rows carry a category, which is what the real files do: six
  // of the eight supported statement formats have no category column at all.
  // The spending page should open on a real 未分類 figure, not a tidy one.
  const CARD_SPEND_TWD = [
    { desc: '全聯福利中心 民生店', amount: -1850, category: '食品雜貨', per: 4 },
    { desc: '7-ELEVEN 復興門市', amount: -138, category: '食品雜貨', per: 6 },
    { desc: 'UBER EATS', amount: -420, category: '外食', per: 5 },
    { desc: '星巴克 敦化店', amount: -180, category: '外食', per: 3 },
    { desc: '台北捷運 悠遊卡加值', amount: -1000, category: '交通', per: 2 },
    { desc: '誠品書店 信義店', amount: -890, category: '購物', per: 1 },
  ];
  const CARD_SPEND_USD = [
    { desc: 'WHOLE FOODS MKT 10283', amount: -84.2, category: 'Groceries', per: 3 },
    { desc: 'SHELL OIL 574123', amount: -46.8, category: 'Gas', per: 2 },
    { desc: 'UBER TRIP', amount: -18.4, category: 'Travel', per: 4 },
  ];

  // Fixed amount, fixed day, every month — so the recurring detector has
  // something to find, and finds it for the right reason.
  const SUBSCRIPTIONS = [
    { account: 'esuncard', desc: 'NETFLIX.COM', amount: -390, day: 8, category: '娛樂' },
    { account: 'esuncard', desc: 'SPOTIFY AB', amount: -149, day: 14, category: '娛樂' },
    { account: 'esuncard', desc: '中華電信 行動月租', amount: -799, day: 21, category: '電信' },
    { account: 'sapphire', desc: 'ICLOUD STORAGE', amount: -2.99, day: 11, category: 'Subscriptions' },
  ];

  // Rules that match rows the statements left uncategorised, and are **not**
  // applied. The rules page opens with something in it, 套用規則 has work to
  // do, and the spending breakdown still shows the honest 未分類 share until
  // the visitor presses it. Pre-applying them would demonstrate nothing.
  const RULES = [
    { pattern: '房租', category: '居住', priority: 10 },
    { pattern: '水電瓦斯', category: '居住', priority: 10 },
    { pattern: '證券交割', category: '投資', priority: 20 },
    { pattern: 'BOUGHT', category: '投資', priority: 20 },
  ];

  // Two, not three: three is MIN_OCCURRENCES in the recurring detector, so a
  // tail of three unpaired card payments is long enough to be reported as a
  // monthly subscription. Which is correct — an unpaired transfer *is*
  // spending as far as the ledger knows — but it puts a mortgage payment at
  // the top of the 固定扣款 list, which is a confusing first thing to see.
  const PAIRS_LEFT_OPEN = 2;

  function buildDemoBook({ to, months: monthCount = 18, now, uuid } = {}) {
    if (!to) throw new Error('buildDemoBook 需要 to（最後一個月的日期）');
    if (typeof now !== 'function' || typeof uuid !== 'function') {
      throw new Error('buildDemoBook 需要注入 now() 和 uuid()，否則每次建出來的書都不一樣');
    }
    const { wobble, rnd, pick } = makeRandom(20260921);
    const stamp = now();

    const months = [];
    for (let i = monthCount - 1; i >= 0; i--) months.push(monthKey(addMonths(to, -i)));

    // --- the transactions, still keyed by account name ---------------------

    const draft = [];
    const add = (account, date, amount, description, extra = {}) =>
      draft.push({ account, date, amount: round2(amount), description, category: '', kind: 'other', ...extra });
    const transfer = (pair, out, into) => {
      add(out.account, out.date, out.amount, out.description, { pair });
      add(into.account, into.date, into.amount, into.description, { pair });
    };

    for (const [i, m] of months.entries()) {
      add('esun', dayIn(m, 5), wobble(95000, 0.03), '薪資轉帳 XX科技股份有限公司', { kind: 'income' });
      add('esun', dayIn(m, 6), -28000, '房租 轉出', { kind: 'expense' });
      const mortgagePay = wobble(18500, 0.001);
      transfer(`mortgage-${m}`,
        { account: 'esun', date: dayIn(m, 25), amount: -mortgagePay, description: '房貸扣款' },
        { account: 'mortgage', date: dayIn(m, 25), amount: mortgagePay, description: '房貸本息' });

      let cardMonth = 0;
      for (const s of CARD_SPEND_TWD) {
        for (let n = 0; n < s.per; n++) {
          const amt = wobble(s.amount, 0.35);
          cardMonth += amt;
          add('esuncard', dayIn(m, 2 + Math.floor(rnd() * 26)), amt, s.desc, { category: s.category, kind: 'expense' });
        }
      }
      for (const s of SUBSCRIPTIONS.filter((x) => x.account === 'esuncard')) {
        cardMonth += s.amount;
        add('esuncard', dayIn(m, s.day), s.amount, s.desc, { category: s.category, kind: 'expense' });
      }
      // Paid in full the following month, which is why the card still carries
      // a balance: the last month's spend has not been billed yet.
      if (i < months.length - 1) {
        const pay = round2(-cardMonth);
        transfer(`card-tw-${m}`,
          { account: 'esun', date: dayIn(months[i + 1], 12), amount: -pay, description: '玉山信用卡 扣繳' },
          { account: 'esuncard', date: dayIn(months[i + 1], 12), amount: pay, description: '信用卡 自動扣繳' });
      }

      // 國泰 only exists for the last stretch, and sits idle in two of those
      // months. Its statements cover them anyway, which is the whole point of
      // the `quiet` state on the coverage grid: a month the bank was asked
      // about and had nothing to report is not a month nobody downloaded.
      const cathayOpen = ACCOUNTS.find((a) => a.key === 'cathay').openAt;
      if (i >= cathayOpen && (i - cathayOpen) % 4 !== 2) {
        add('cathay', dayIn(m, 15), wobble(12000, 0.2), '利息與零存整付');
        add('cathay', dayIn(m, 28), -wobble(6400, 0.4), '水電瓦斯 代扣');
      }

      add('chase', dayIn(m, 9), wobble(3200, 0.25), 'ACH CREDIT CONTRACT WORK', { kind: 'income' });
      let usdCard = 0;
      for (const s of CARD_SPEND_USD) {
        for (let n = 0; n < s.per; n++) {
          const amt = wobble(s.amount, 0.3);
          usdCard += amt;
          add('sapphire', dayIn(m, 3 + Math.floor(rnd() * 24)), amt, s.desc, { category: s.category, kind: 'expense' });
        }
      }
      for (const s of SUBSCRIPTIONS.filter((x) => x.account === 'sapphire')) {
        usdCard += s.amount;
        add('sapphire', dayIn(m, s.day), s.amount, s.desc, { category: s.category, kind: 'expense' });
      }
      if (i < months.length - 1) {
        const pay = round2(-usdCard);
        transfer(`card-us-${m}`,
          { account: 'chase', date: dayIn(months[i + 1], 18), amount: -pay, description: 'CHASE CREDIT CRD AUTOPAY' },
          { account: 'sapphire', date: dayIn(months[i + 1], 18), amount: pay, description: 'AUTOPAY PAYMENT THANK YOU' });
      }

      // A brokerage buy every third month: cash moves across (a transfer),
      // then the purchase itself leaves the settlement account (not a
      // transfer — the money became shares, which live in `holdings`).
      if (i % 3 === 1) {
        const moved = wobble(48000, 0.3);
        transfer(`broker-tw-${m}`,
          { account: 'esun', date: dayIn(m, 16), amount: -moved, description: '轉出 永豐金證券' },
          { account: 'sinopac', date: dayIn(m, 16), amount: moved, description: '存入 交割款' });
        add('sinopac', dayIn(m, 17), -wobble(48000, 0.3), pick(['證券交割 2330 買進', '證券交割 0050 買進']), { kind: 'trade' });
      }
      if (i % 4 === 2) {
        const moved = wobble(1400, 0.25);
        transfer(`broker-us-${m}`,
          { account: 'chase', date: dayIn(m, 19), amount: -moved, description: 'WIRE OUT FIRSTRADE' },
          { account: 'firstrade', date: dayIn(m, 19), amount: moved, description: 'WIRE IN' });
        add('firstrade', dayIn(m, 20), -wobble(1400, 0.25), pick(['BOUGHT VTI', 'BOUGHT AAPL']), { kind: 'trade' });
      }
    }

    // --- resolve it into table rows ----------------------------------------

    const instId = new Map(INSTITUTIONS.map((i, n) => [i.key, n + 1]));
    const acctId = new Map(ACCOUNTS.map((a, n) => [a.key, n + 1]));
    const movedOn = (key) => draft.filter((t) => t.account === key).reduce((s, t) => s + t.amount, 0);

    const institutions = INSTITUTIONS.map((i, n) => ({
      id: n + 1, name: i.name, kind: i.kind, country: i.country,
    }));

    // `opening_balance` is derived, never chosen: the target minus everything
    // that happened, so the balance the app prints is the one intended above
    // and the reconciliation figures below actually reconcile.
    const accounts = ACCOUNTS.map((a, n) => ({
      id: n + 1,
      // null for a wallet: self-custody has no institution, and the FK allows it.
      institution_id: a.inst ? instId.get(a.inst) : null,
      name: a.name,
      kind: a.kind,
      currency: a.currency,
      opening_balance: round2(a.target - movedOn(a.key)),
      opening_date: `${months[a.openAt]}-01`,
      is_active: 1,
      sort_order: n,
      note: '示範資料',
      // Every demo account is reachable today. The first restricted one
      // arrives with the retirement kind (docs/plans/asset-classes.md PR 5);
      // until then there is nothing that reads the split to demonstrate it.
      access: 'liquid',
    }));

    // Everything but the last few months is already paired, the way a book
    // somebody had been keeping would be. An unpaired pair counts as both
    // income and expense, which would put a card payment and a mortgage
    // transfer into the spending breakdown every month and roughly double
    // both totals.
    const openFrom = months[Math.max(0, months.length - PAIRS_LEFT_OPEN)];
    const groups = new Map();
    for (const t of draft) {
      if (!t.pair || t.date.slice(0, 7) >= openFrom) continue;
      if (!groups.has(t.pair)) groups.set(t.pair, uuid());
    }

    const txns = draft.map((t, n) => {
      const account_id = acctId.get(t.account);
      const group = t.pair ? groups.get(t.pair) || null : null;
      return {
        id: n + 1,
        account_id,
        date: t.date,
        amount: t.amount,
        description: t.description,
        category: t.category,
        kind: group ? 'transfer' : t.kind,
        transfer_group: group,
        source: 'csv',
        external_id: null,
        fingerprint: fingerprint(account_id, t.date, t.amount, t.description),
        import_id: null,
        note: '',
        created_at: stamp,
      };
    });

    const holdings = HOLDINGS.map((h, n) => ({
      id: n + 1,
      account_id: acctId.get(h.account),
      symbol: h.symbol,
      name: h.name,
      market: h.market,
      shares: h.shares,
      avg_cost: h.avg_cost,
      last_price: h.last_price,
      price_date: to,
      currency: h.currency,
      note: '示範資料',
      decimals: h.decimals,
    }));

    // A short price history per holding, so the price panel opens with a series
    // rather than a single dot. Deterministic and RNG-free on purpose — it must
    // not perturb the jittered transactions above — and the final point lands
    // exactly on `last_price` at `to`, so each position still values to the same
    // figure the single `last_price` column used to give.
    const prices = holdings.flatMap((h) => {
      const dates = [...new Set([...months.slice(-4).map(lastDayOf), to])]
        .filter((d) => d <= to)
        .sort();
      const start = round2((h.avg_cost + h.last_price) / 2);
      return dates.map((date, i) => ({
        symbol: h.symbol,
        market: h.market,
        date,
        price: i === dates.length - 1
          ? h.last_price
          : round2(start + ((h.last_price - start) * i) / (dates.length - 1)),
        source: 'manual',
      }));
    });

    // Two imports on 玉山, with a deliberate hole between them so the
    // coverage grid has something to report, and declared periods so the
    // months inside them read as confirmed rather than merely quiet.
    // Firstrade, the cards and the mortgage deliberately have no import
    // record at all, so the grid shows both halves of what it is for: an
    // account whose quiet months are confirmed, and one whose quiet months
    // are simply unknown.
    const mid = Math.floor(months.length / 2);
    const cathayOpenMonth = months[ACCOUNTS.find((a) => a.key === 'cathay').openAt];
    const spans = [
      { account: 'esun', from: `${months[0]}-01`, to: lastDayOf(months[mid - 2]) },
      // Ends on the 14th, so its final month is only half covered.
      { account: 'esun', from: `${months[mid + 1]}-01`, to: dayIn(months[months.length - 1], 14) },
      { account: 'chase', from: `${months[0]}-01`, to: lastDayOf(months[months.length - 1]) },
      { account: 'cathay', from: `${cathayOpenMonth}-01`, to: lastDayOf(months[months.length - 1]) },
      { account: 'sinopac', from: `${months[0]}-01`, to: lastDayOf(months[months.length - 1]) },
    ];
    const imports = spans.map((s, n) => ({
      id: n + 1,
      account_id: acctId.get(s.account),
      filename: `${s.account}-${s.from}.csv`,
      mapping: '{}',
      imported: draft.filter((t) => t.account === s.account && t.date >= s.from && t.date <= s.to).length,
      skipped: 0,
      created_at: stamp,
      date_from: s.from,
      date_to: s.to,
      period_kind: 'declared',
    }));

    const fx_rates = months
      .filter((_, i) => i % 3 === 0)
      .map((m) => ({ date: `${m}-01`, pair: 'USDTWD', rate: wobble(31.8, 0.03) }));

    // One check that agrees and one that does not, because the overview's
    // warning list is a feature and an empty one demonstrates nothing.
    const balanceOn = (key, date) => {
      const a = ACCOUNTS.find((x) => x.key === key);
      const upTo = draft.filter((t) => t.account === key && t.date <= date).reduce((s, t) => s + t.amount, 0);
      return round2(a.target - movedOn(key) + upTo);
    };
    const checkDate = lastDayOf(months[months.length - 2]);
    const balance_checks = [
      { id: 1, account_id: acctId.get('esun'), date: checkDate, stated: balanceOn('esun', checkDate), note: '網銀截圖，對得上' },
      { id: 2, account_id: acctId.get('cathay'), date: checkDate, stated: round2(balanceOn('cathay', checkDate) - 3250), note: '對不上，示範漏匯的樣子' },
    ];

    const rules = RULES.map((r, n) => ({ id: n + 1, ...r, created_at: stamp }));

    return {
      institutions, accounts, txns, holdings, prices, imports, fx_rates, balance_checks, rules,
      mappings: [],
      // No schema_version: the demo reports its own (SCHEMA_VERSION in
      // web/storage-demo.js). A second copy here was never read, and had
      // fallen behind unnoticed.
      meta: [{ key: 'base_currency', value: 'TWD' }],
      // Not a table — what the seeder prints and what the demo's copy says.
      span: { from: months[0], to: monthKey(to) },
    };
  }

  // A statement a visitor can drop into the import view, so the parser can be
  // watched doing its job rather than described. 玉山's shape: the header
  // wording, ROC dates, 支出/存入 as two columns, thousands separators inside
  // quotes on the amounts but not on the balance, CRLF. Every value invented.
  //
  // It is built rather than stored, for three reasons.
  //
  // A committed `.csv` outside `test/fixtures/` is refused by
  // `githooks/pre-commit` — the right rule, and why the short statements in
  // `test/api.test.js` are inline too.
  //
  // The month has to move with the book. A fixed one drifts out of the window
  // the demo covers, and a month that has not happened yet is worse than
  // stale: the ten rows import perfectly and then no balance moves, because a
  // balance is computed as of today. So it covers the last **complete** month
  // before `to`, which is also what a real download would be.
  //
  // And it belongs to no account in the seeded book, on purpose. Dropped in
  // with nothing selected it lands in 「從這個檔案建立帳戶」 — the flow the
  // import view was built around — and it cannot collide with a seeded row
  // or quietly double a month of salary.
  const STATEMENT_OPENING = 620000;
  const STATEMENT_ROWS = [
    { day: 5, desc: '薪資轉帳 XX科技股份有限公司', in: 95200, note: (mon) => `${mon}月薪` },
    { day: 6, desc: '房租 轉出', out: 28000 },
    { day: 8, desc: '全聯福利中心 民生店', out: 1864 },
    { day: 12, desc: '玉山信用卡 扣繳', out: 24310, note: () => '上期帳單' },
    { day: 15, desc: '7-ELEVEN 復興門市', out: 142 },
    { day: 18, desc: '台電 電費 代扣', out: 2470 },
    { day: 21, desc: '中華電信 行動月租', out: 799 },
    { day: 25, desc: '房貸扣款', out: 18503 },
    { day: 27, desc: '存款利息', in: 63 },
    { day: 28, desc: '誠品書店 信義店', out: 1290 },
  ];

  // Grouped with commas and quoted when that comma would split the field,
  // which is the statement's own convention and the reason the file is worth
  // handing to the parser at all.
  const grouped = (n) => {
    const s = String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return s.includes(',') ? `"${s}"` : s;
  };

  function buildDemoStatement(to) {
    if (!to) throw new Error('buildDemoStatement 需要 to（今天）');
    const month = monthKey(addMonths(`${monthKey(to)}-01`, -1));
    const [year, mon] = month.split('-').map(Number);
    const roc = `${year - 1911}/${String(mon).padStart(2, '0')}`;

    let balance = STATEMENT_OPENING;
    const lines = ['交易日期,摘要,支出金額,存入金額,餘額,備註'];
    for (const r of STATEMENT_ROWS) {
      balance = round2(balance + (r.in || 0) - (r.out || 0));
      lines.push([
        `${roc}/${String(r.day).padStart(2, '0')}`,
        r.desc,
        r.out ? grouped(r.out) : '',
        r.in ? grouped(r.in) : '',
        balance,
        r.note ? r.note(mon) : '',
      ].join(','));
    }
    return {
      // The filename is what `suggestAccount` names the account after, so it
      // reads as a download would.
      name: `玉山活存-${year - 1911}年${String(mon).padStart(2, '0')}月.csv`,
      text: lines.join('\r\n') + '\r\n',
      month,
    };
  }

  const api = {
    buildDemoBook, buildDemoStatement,
    INSTITUTIONS, ACCOUNTS, HOLDINGS, RULES, PAIRS_LEFT_OPEN,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
