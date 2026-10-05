'use strict';

// The whole book in one document: each currency's net worth and what it is
// made of, every account and holding, a year of spending, and what the ledger
// wants looked at or does not know. It is the file the overview page's
// 匯出全覽 hands back — something to read, print, keep a month at a time, or
// paste into an AI chat yourself.
//
// Pure, like the rest of shared/. `computeOverview` takes what the other
// compute* functions already returned and re-derives none of it, so the file
// and the screen cannot disagree about a number; `overviewMarkdown` writes the
// model down. `server/money.js`'s `overview()` loads it from SQLite and the
// demo loads it from its Map, and both hand back the same bytes —
// test/demo-store.test.js compares them.
//
// Three rules it inherits and may not soften:
//
// **Per currency, never summed.** There is no total across currencies in the
// model or in the file, and no rate anywhere in this code: USD and TWD do not
// add up without one, which is why computeNetWorth reports a block each.
//
// **No `$` in the file.** An amount is written by `figure()` — its currency's
// decimal places, no symbol — and the currency is named by the row, the
// section or the code after the number. A viewer that reads `$…$` as LaTeX
// (Obsidian; GitHub with maths on) can turn a line holding two `NT$` amounts
// into a formula, and every TWD row of a table is such a line. The code is
// also the unambiguous answer for anyone, or anything, reading the file cold:
// `$` alone is a dozen currencies.
//
// **Every string from the book is escaped.** An account name is somebody's
// typing and a recurring label is a bank's. Either can carry a `|` that splits
// a table row, a `<` a renderer takes for a tag, or `[…](…)` and `![…](…)` —
// a link, or a remote image fetched the moment the file is opened.

(function (root) {
  const NODE = typeof module !== 'undefined' && module.exports;
  const { round2, roundTo, figure, quantity, unitPrice } = NODE ? require('./currency') : root;
  const { kindName, accessName, taxStatusName, marketInfo, DEFAULT_ACCESS } = NODE ? require('./kinds') : root;
  const { liabilitiesInCredit } = NODE ? require('./money') : root;
  const { CADENCES } = NODE ? require('./spending') : root;

  // How many categories the file names before folding the rest into one row,
  // and how many points of the ledger line it lists. The spending page's chart
  // names four and its table every one; a file is read top to bottom, so it
  // names more than the chart and still ends.
  const TOP_CATEGORIES = 8;
  const SERIES_POINTS = 12;

  // What a severity is called and where it sorts. The overview page's 待辦
  // list and this file's 需要注意 say the same two words about the same two
  // things, so there is one table of them.
  const ATTENTION_LEVELS = {
    err:  { rank: 0, label: '需處理' },
    warn: { rank: 1, label: '待確認' },
  };

  // A share of a whole, in percent to one place. A share of nothing is zero,
  // not NaN.
  const pct = (part, whole) => (whole ? roundTo((part / whole) * 100, 1) : 0);

  function computeOverview({
    asOf, netWorth, accounts, holdings, series, spending, recurring, coverage, reconcile, transferCandidates,
  }) {
    const currencies = {};
    for (const cur of netWorth.order) {
      const c = netWorth.currencies[cur];
      // The ledger line ends on `asOf`, so the point before the last is the
      // previous month-end: the comparison the overview card calls 較上月.
      const points = (series && series[cur]) || [];
      const prev = points.length > 1 ? points[points.length - 2].value : null;
      // Magnitudes, the way barBreakdown takes them: every share positive and
      // the column adding up to 100%, the sign left on the amount.
      const byKind = Object.entries(c.by_kind)
        .filter(([, v]) => Math.abs(v) > 0.01)
        .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
      const gross = byKind.reduce((s, [, v]) => s + Math.abs(v), 0);
      const sp = spending.currencies[cur];

      currencies[cur] = {
        total: c.total,
        ledger: c.ledger,
        securities: c.securities,
        unvested: c.unvested,
        liquid: c.liquid.total,
        restricted: c.restricted.total,
        change: prev === null ? null : round2(c.ledger - prev),
        by_kind: byKind.map(([kind, amount]) => ({ kind, amount, share: pct(Math.abs(amount), gross) })),
        accounts: accounts.filter((a) => a.currency === cur).map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          access: a.access || DEFAULT_ACCESS,
          tax_status: a.tax_status || null,
          unvested: a.unvested || 0,
          balance: a.balance,
          is_active: !!a.is_active,
        })),
        // Largest first, as the holdings page lists them.
        holdings: holdings.filter((h) => h.currency === cur)
          .slice().sort((a, b) => b.market_value - a.market_value)
          .map((h) => ({
            symbol: h.symbol,
            name: h.name,
            market: h.market,
            account_name: h.account_name,
            shares: h.shares,
            decimals: h.decimals,
            last_price: h.last_price,
            price_date: h.price_date || null,
            market_value: h.market_value,
            cost_total: h.cost_total,
            unrealized: h.unrealized,
            roi_pct: h.roi_pct,
            share: pct(h.market_value, c.securities),
          })),
        series: points.slice(-SERIES_POINTS),
        spending: sp ? spendingOf(sp, spending, recurring, cur) : null,
      };
    }

    return {
      as_of: asOf,
      order: [...netWorth.order],
      currencies,
      attention: attentionOf({ accounts, reconcile, transferCandidates, coverage, spending }),
      unknowns: {
        months: coverage.months.length,
        from: coverage.months[0] || null,
        to: coverage.months[coverage.months.length - 1] || null,
        gaps: coverage.summary.gaps,
        partials: coverage.summary.partials,
        accounts_with_gaps: coverage.summary.accounts_with_gaps,
        manual: coverage.manual.map((a) => ({ name: a.name, kind: a.kind })),
      },
    };
  }

  function spendingOf(sp, spending, recurring, cur) {
    const top = sp.categories.slice(0, TOP_CATEGORIES);
    const rest = sp.categories.slice(TOP_CATEGORIES);
    const restTotal = round2(rest.reduce((s, c) => s + c.total, 0));
    return {
      from: spending.from,
      to: spending.to,
      income: sp.income,
      expense: sp.expense,
      net: sp.net,
      categories: top.map((c) => ({ category: c.category, total: c.total, count: c.count, share: pct(c.total, sp.expense) })),
      other: rest.length
        ? { categories: rest.length, total: restTotal, count: rest.reduce((n, c) => n + c.count, 0), share: pct(restTotal, sp.expense) }
        : null,
      uncategorised: { ...sp.uncategorised, share: pct(sp.uncategorised.total, sp.expense) },
      // Active ones only, the way the spending page's monthly figure counts
      // them: a subscription that stopped is not what goes out every month.
      recurring: {
        monthly_total: recurring.monthly_total[cur] || 0,
        items: recurring.items.filter((r) => r.active && r.currency === cur).map((r) => ({
          label: r.label,
          account_name: r.account_name,
          category: r.category,
          cadence: r.cadence,
          median_amount: r.median_amount,
          monthly_equivalent: r.monthly_equivalent,
        })),
      },
    };
  }

  // What wants looking at, as data — a type and its figures, never a
  // sentence — so whoever reads the model can say it in their own words.
  // Blocking first, as on the overview page: a sign error or a check that
  // disagrees makes a number wrong, the rest leave it incomplete.
  function attentionOf({ accounts, reconcile, transferCandidates, coverage, spending }) {
    const out = [];
    for (const a of liabilitiesInCredit(accounts)) {
      out.push({
        level: 'err', type: 'liability_in_credit',
        name: a.name, kind: a.kind, currency: a.currency, balance: a.balance,
        // What the currency's net worth is out by if the sign is the mistake:
        // the balance counted in the wrong direction, so twice over.
        overstatement: round2(a.balance * 2),
      });
    }
    // One line per account, naming its newest check that disagrees. Three bad
    // checks against one account are one book to go and fix.
    const named = new Set();
    const newestFirst = [...reconcile].sort((x, y) => y.date.localeCompare(x.date) || y.id - x.id);
    for (const c of newestFirst) {
      if (c.ok || named.has(c.account_id)) continue;
      named.add(c.account_id);
      out.push({
        level: 'err', type: 'reconcile_off',
        account_name: c.account_name, currency: c.currency, date: c.date,
        stated: c.stated, computed: c.computed, diff: c.diff,
      });
    }
    if (transferCandidates.length) {
      out.push({ level: 'warn', type: 'unpaired_transfers', count: transferCandidates.length });
    }
    // Coverage's headline, account by account: how many months back the
    // ledger stops knowing anything. That is what sends somebody to download a
    // statement; a total gap count spread over two years does not.
    for (const s of coverage.summary.stale) {
      out.push({ level: 'warn', type: 'stale', name: s.name, months: s.trailing_gap, last_data: s.last_data });
    }
    // The spending page's own condition for its warning.
    for (const cur of spending.order) {
      const d = spending.currencies[cur];
      if (!d.uncategorised.count) continue;
      out.push({
        level: 'warn', type: 'uncategorised', currency: cur,
        total: d.uncategorised.total, count: d.uncategorised.count, share: pct(d.uncategorised.total, d.expense),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // The file
  // ---------------------------------------------------------------------

  // Every string that came out of the book goes through this, and nothing
  // else needs to. A backslash before ASCII punctuation is CommonMark's own
  // escape, so a renderer shows the character and a plain-text reader sees
  // one backslash on the rare name that needed it. A line break would end the
  // table row it sits in, so it becomes a space.
  const text = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/\r\n?|\n/g, ' ')
    .replace(/[\\`|<>[\]$]/g, '\\$&');

  const fixed = (n, dp) => Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const percent = (p) => `${fixed(p, 1)}%`;
  const roi = (p) => `${p > 0 ? '+' : ''}${fixed(p, 2)}%`;
  // A delta is news in both directions, so it says which way.
  const delta = (n, cur) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${figure(n, cur)}`);
  const cadenceName = (name) => (CADENCES.find((c) => c.name === name) || {}).label || name;

  // A GitHub-flavoured table. The cells arrive already written — escaped
  // text, or a figure — and `align` is 'l' or 'r' for each column.
  function table(head, align, rows) {
    const rule = align.map((a) => (a === 'r' ? '--:' : ':--'));
    return [head, rule, ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n');
  }

  function overviewMarkdown(m) {
    const out = [];
    const add = (...lines) => out.push(...lines);

    add('# 資產全覽', '', `截至 ${m.as_of}，Finance Hub 匯出。`, '');
    add(
      '- 金額一律是原幣，不跨幣別加總：兩種貨幣沒有匯率就加不起來，所以這裡沒有一個總淨值。',
      '- 數字不帶貨幣符號，幣別寫在它所在的那一列、那一節，或數字後面。',
      '- 淨值 ＝ 帳戶餘額 ＋ 持股市值 － 未歸屬。信用卡和貸款的餘額是負數。',
      '- 可動用是隨時動得了的錢；受限制是你和它之間隔著一道規則，例如退休金。',
      '',
    );

    add('## 淨值', '');
    if (m.order.length) {
      add(table(
        ['幣別', '可動用', '受限制', '合計', '帳戶較上月'],
        ['l', 'r', 'r', 'r', 'r'],
        m.order.map((cur) => {
          const c = m.currencies[cur];
          return [text(cur), figure(c.liquid, cur), figure(c.restricted, cur), figure(c.total, cur), delta(c.change, cur)];
        })
      ), '');
    } else {
      add('還沒有帳戶。', '');
    }

    for (const cur of m.order) add(...currencySection(cur, m.currencies[cur]));

    add('## 需要注意', '');
    if (m.attention.length) {
      add(...m.attention.map((a) => `- **${ATTENTION_LEVELS[a.level].label}**：${sayAttention(a)}`), '');
    } else {
      add('沒有需要處理的事。', '');
    }

    add('## 這份資料不知道的事', '', ...unknownLines(m.unknowns));

    return `${out.join('\n').replace(/\n+$/, '')}\n`;
  }

  function currencySection(cur, c) {
    const lines = [`## ${text(cur)}`, ''];
    const parts = [`帳戶 ${figure(c.ledger, cur)}`];
    if (c.securities) parts.push(`＋ 持股 ${figure(c.securities, cur)}`);
    if (c.unvested) parts.push(`－ 未歸屬 ${figure(c.unvested, cur)}`);
    lines.push(`以下金額都是 ${text(cur)}。淨值 ${figure(c.total, cur)} ＝ ${parts.join(' ')}。`, '');

    if (c.by_kind.length) {
      lines.push('### 組成', '', table(
        ['項目', '金額', '佔比'],
        ['l', 'r', 'r'],
        c.by_kind.map((k) => [text(kindName(k.kind)), figure(k.amount, cur), percent(k.share)])
      ), '');
    }

    lines.push('### 帳戶', '', table(
      ['帳戶', '類型', '動用', '餘額', '備註'],
      ['l', 'l', 'l', 'r', 'l'],
      c.accounts.map((a) => [
        text(a.name), text(kindName(a.kind)), text(accessName(a.access)), figure(a.balance, cur), accountNote(a, cur),
      ])
    ), '');

    if (c.holdings.length) {
      lines.push('### 持股', '', table(
        ['代號', '名稱', '市場', '帳戶', '數量', '現價', '報價日', '市值', '成本', '未實現損益', '報酬率', '佔持股'],
        ['l', 'l', 'l', 'l', 'r', 'r', 'l', 'r', 'r', 'r', 'r', 'r'],
        c.holdings.map((h) => [
          text(h.symbol), text(h.name), text((marketInfo(h.market) || {}).label || h.market), text(h.account_name),
          quantity(h.shares, h.decimals), unitPrice(h.last_price), text(h.price_date || '—'),
          figure(h.market_value, cur), figure(h.cost_total, cur), delta(h.unrealized, cur), roi(h.roi_pct), percent(h.share),
        ])
      ), '');
    }

    const s = c.spending;
    lines.push('### 近一年收支', '');
    if (s) {
      lines.push(`${s.from} 到 ${s.to}，不含轉帳和市值變動。`, '', table(
        ['收入', '支出', '淨額', '固定扣款（每月等值）'],
        ['r', 'r', 'r', 'r'],
        [[figure(s.income, cur), figure(s.expense, cur), delta(s.net, cur), figure(s.recurring.monthly_total, cur)]]
      ), '');
      if (s.categories.length) {
        const rows = s.categories.map((k) => [text(k.category || '未分類'), figure(k.total, cur), String(k.count), percent(k.share)]);
        if (s.other) rows.push([`其他 ${s.other.categories} 類`, figure(s.other.total, cur), String(s.other.count), percent(s.other.share)]);
        lines.push('#### 支出分類', '', table(['分類', '支出', '筆數', '佔比'], ['l', 'r', 'r', 'r'], rows), '');
      }
      if (s.recurring.items.length) {
        lines.push('#### 固定扣款', '', table(
          ['項目', '帳戶', '週期', '金額', '每月等值'],
          ['l', 'l', 'l', 'r', 'r'],
          s.recurring.items.map((r) => [
            text(r.label), text(r.account_name), text(cadenceName(r.cadence)),
            figure(r.median_amount, cur), figure(r.monthly_equivalent, cur),
          ])
        ), '');
      }
    } else {
      lines.push('近一年沒有這個幣別的收支（不含轉帳和市值變動）。', '');
    }

    if (c.series.length) {
      lines.push('### 帳戶淨額走勢（月底，不含持股）', '', table(
        ['日期', '帳戶淨額'],
        ['l', 'r'],
        c.series.map((p) => [p.date, figure(p.value, cur)])
      ), '');
    }
    return lines;
  }

  // The status pills an account carries on screen, as words. Restricted
  // access has a column of its own.
  const accountNote = (a, cur) => [
    a.is_active ? '' : '已停用',
    a.tax_status ? text(taxStatusName(a.tax_status)) : '',
    a.unvested ? `未歸屬 ${figure(a.unvested, cur)}` : '',
  ].filter(Boolean).join('、');

  function sayAttention(a) {
    const cur = text(a.currency);
    switch (a.type) {
      case 'liability_in_credit':
        return `「${text(a.name)}」是${text(kindName(a.kind))}，但餘額是正的（${figure(a.balance, a.currency)} ${cur}）。`
          + `欠款要記成負數，否則 ${cur} 淨值會多算 ${figure(a.overstatement, a.currency)} ${cur}；確實溢繳的話可以忽略。`;
      case 'reconcile_off':
        return `「${text(a.account_name)}」在 ${a.date} 的實際餘額是 ${figure(a.stated, a.currency)} ${cur}，`
          + `交易累計是 ${figure(a.computed, a.currency)} ${cur}，差 ${delta(a.diff, a.currency)} ${cur}。`
          + '可能有一段期間的對帳單沒有匯進來。';
      case 'unpaired_transfers':
        return `有 ${a.count} 組可能的轉帳還沒配對。配對之前，兩邊會各自被算成一筆支出和一筆收入。`;
      case 'stale':
        return `「${text(a.name)}」最近 ${a.months} 個月都沒有資料${a.last_data ? `（最後一筆在 ${a.last_data}）` : ''}，`
          + '那段期間帳本什麼都不知道。';
      case 'uncategorised':
        return `近一年 ${cur} 的支出有 ${percent(a.share)}（${figure(a.total, a.currency)} ${cur}，${a.count} 筆）沒有分類。`;
      default:
        return text(a.type);
    }
  }

  function unknownLines(u) {
    const lines = [];
    if (u.gaps) {
      lines.push(`- 帳本只知道匯入過的月份。${u.from} 到 ${u.to} 這 ${u.months} 個月裡，${u.accounts_with_gaps} 個帳戶共有 `
        + `${u.gaps} 個月份什麼都不知道：沒有交易、沒有對帳，也沒有涵蓋那個月的對帳單。沒有資料的月份，不代表那個月沒有花錢。`);
    } else if (u.months) {
      lines.push(`- ${u.from} 到 ${u.to} 這 ${u.months} 個月裡，每個帳戶的每個月份都有交易、對帳，或涵蓋它的對帳單。`);
    }
    if (u.partials) {
      lines.push(`- 另有 ${u.partials} 個月份只涵蓋了一部分：宣告的對帳單期間只蓋到那個月的一段。`);
    }
    if (u.manual.length) {
      lines.push(`- ${u.manual.map((a) => `「${text(a.name)}」`).join('、')}沒有對帳單可匯，數字是手動記的，不在完整度裡。`);
    }
    lines.push(
      '- 帳戶淨額走勢只算帳戶，不含持股。持股市值用的是帳本裡最新的一筆價格（見「報價日」），不是即時報價。',
      '- 收支、分類和固定扣款只看得到匯入過的交易。'
    );
    return lines;
  }

  // Dual-environment, the same three lines every file in shared/ ends with:
  // onto the global for the browser's classic scripts, onto module.exports for
  // Node.
  const api = { computeOverview, overviewMarkdown, ATTENTION_LEVELS };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
