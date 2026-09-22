'use strict';

// /overview — one column per currency. Nothing is converted, so there is no
// grand total to put above them.

views.overview = async () => {
  const d = await api('/api/overview');
  const nw = d.net_worth;
  const order = nw.order;

  // Each check carries its own severity and the page that resolves it. What
  // this replaced was one amber block of `⚠︎` lines: a sign error doubling a
  // currency's net worth read exactly like a pairing that could wait, and
  // neither said where to go.
  const todos = [];
  for (const a of d.liabilities_in_credit || []) {
    todos.push({
      level: 'err',
      text: html`「${a.name}」是${kindName(a.kind)}，但餘額是正的（${money(a.balance, a.currency)}）。
        欠款要記成負數，否則 ${a.currency} 淨值會多算 ${money(a.balance * 2, a.currency)}。確實溢繳的話可以忽略。`,
      href: `/account/${a.id}`,
      cta: '開啟帳戶',
    });
  }
  if (d.reconcile.off_accounts > 0) {
    // One account is the common case and the one worth naming: "go and look"
    // is a worse instruction than "this account, this much, this way". Beyond
    // one the sentence would be a list, so it goes back to a count — and the
    // count is of accounts, not of checks, because a book is what you go and
    // fix. `latest` is capped at 8, so the named row is only used when the
    // failing check is actually in it.
    const off = (d.reconcile.latest || []).filter((c) => !c.ok);
    const one = d.reconcile.off_accounts === 1 && off.length === 1 ? off[0] : null;
    todos.push({
      level: 'err',
      text: one
        ? html`「${one.account_name}」在 ${one.date} 的實際餘額跟交易累計差
            ${signed(one.diff, one.currency)}，可能是 CSV 有區間沒涵蓋到。`
        : html`有 ${d.reconcile.off_accounts} 個帳戶的實際餘額跟交易累計對不起來，可能是 CSV 漏匯。`,
      href: one ? `/account/${one.account_id}` : '/accounts',
      cta: one ? '開啟帳戶' : '看對帳',
    });
  }
  if (d.counts.unpaired_candidates > 0) {
    todos.push({
      level: 'warn',
      text: html`偵測到 ${d.counts.unpaired_candidates} 組可能的轉帳還沒配對，配對後才不會被當成收支。`,
      href: '/transactions',
      cta: '去配對',
    });
  }
  // Blocking first. Sort is stable, so items of one severity keep the order
  // they were pushed in, and adding a level cannot silently reshuffle them.
  todos.sort((a, b) => TODO_LEVELS[a.level].rank - TODO_LEVELS[b.level].rank);

  // One column per currency, side by side. Nothing is converted, so there is no
  // grand total and no rate quietly deciding what the headline number is — each
  // currency simply stands on its own. `.g2` is auto-fit, so a single currency
  // fills the width instead of leaving a hole beside itself.
  const perCurrency = (cur) => {
    const c = nw.currencies[cur];
    const s = d.series[cur] || [];
    const prev = s.length > 1 ? s[s.length - 2].value : null;
    const change = prev === null ? null : round2(c.ledger - prev);
    const nAcc = d.accounts.filter((a) => a.currency === cur).length;
    const nHold = d.holdings.filter((h) => h.currency === cur).length;
    const byKind = Object.entries(c.by_kind)
      .filter(([, v]) => Math.abs(v) > 0.01).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]));
    const gross = byKind.reduce((sum, [, v]) => sum + Math.abs(v), 0);

    return html`<div class="card">
      <h2 class="sec cur-head">
        <span>${cur} 淨值</span>
        <span class="muted">${nAcc} 個帳戶${nHold ? ` · ${nHold} 檔持股` : ''}</span>
      </h2>

      <div class="cur-total ${level(c.total)}">${money(c.total, cur)}</div>
      <div class="cur-sub">
        帳戶 ${money(c.ledger, cur)}${c.securities ? html` ＋ 持股 ${money(c.securities, cur)}` : ''}${c.unvested
          ? html` － 未歸屬 ${money(c.unvested, cur)}` : ''}
        <span class="${change === null ? 'dim' : cls(change)}">
          ${change === null ? '· 無上期可比' : `· 較上月 ${signed(change, cur)}`}</span>
      </div>

      <h2 class="sec">帳戶淨額走勢（月底，不含持股）</h2>
      ${lineChart(s, cur)}

      <h2 class="sec">依類型</h2>
      ${barBreakdown(byKind.map(([k, v]) => [kindName(k), v]), gross, cur)}
    </div>`;
  };

  mount(main, html`
    <div class="page-head">
      <div><h1>總覽</h1><div class="sub">${d.counts.txns} 筆交易 · ${nw.as_of}</div></div>
      <div class="row shrink"><button class="btn" id="refresh">重新整理</button></div>
    </div>

    ${todos.length ? html`<section>${todoList(todos)}</section>` : ''}

    ${order.length
      ? html`<section class="grid g2">${order.map(perCurrency)}</section>`
      : html`<section class="card">${empty('還沒有帳戶。丟一個 CSV 到「匯入」頁就會幫你建。')}</section>`}

    ${order.length ? html`<section><div class="muted small">
      持股在第一階段只有當前市值、沒有歷史價格，所以不畫進走勢，避免畫出一條從來不存在的線。
    </div></section>` : ''}

    <section class="card">
      <h2 class="sec">帳戶餘額</h2>
      <div class="table-wrap">${accountTable(d.accounts)}</div>
    </section>

    ${d.reconcile.latest.length ? html`<section class="card">
      <h2 class="sec">餘額對帳</h2>
      <div class="table-wrap">${reconcileTable(d.reconcile.latest)}</div>
    </section>` : ''}
  `);
  $('#refresh').onclick = () => render();
};

// The icon is not here: `.todo-item.<level>` draws it from the same mask the
// matching `.note` variant uses, so a severity has exactly one shape wherever
// it appears and a row cannot be written without one. This table is what the
// level means in words and where it sorts.
const TODO_LEVELS = {
  err:  { rank: 0, label: '需處理' },
  warn: { rank: 1, label: '待確認' },
};

function todoList(todos) {
  return html`<div class="card todo">
    <div class="todo-head">
      <h2>待辦</h2>
      <span class="muted small">${todos.length} 項</span>
    </div>
    ${todos.map((t) => html`<div class="todo-item ${t.level}">
      <div class="todo-body">
        <div class="todo-label">${TODO_LEVELS[t.level].label}</div>
        <div class="todo-text">${t.text}</div>
      </div>
      <a class="btn" href="${t.href}">${t.cta}</a>
    </div>`)}
  </div>`;
}

function accountTable(accounts) {
  if (!accounts.length) return empty('還沒有帳戶。先到「帳戶」頁新增。');
  return html`<table>
    <thead><tr><th>帳戶</th><th>類型</th><th>幣別</th><th class="num">餘額</th></tr></thead>
    <tbody>${accounts.map((a) => html`<tr>
      <td>${a.name}${accountPills(a)}</td>
      <td>${kindName(a.kind)}</td>
      <td class="cur">${a.currency}</td>
      <td class="num ${level(a.balance)}">${money(a.balance, a.currency)}</td>
    </tr>`)}</tbody>
  </table>`;
}
