'use strict';

// /audit — 月度審計. One month read the way you would read a statement you do
// not trust: charged twice, a subscription that went up or that was cancelled
// and still charges, a category far above its usual, the largest purchase in
// half a year, a fee. The rules are shared/audit.js, plain and checkable; no AI
// is involved, so it works the same in every mode.
//
// Every finding is a question, and the page records the answer: 沒問題 keeps it
// listed but settled, and a subscription marked cancelled is watched for the
// next charge. Both answers live with the book, not in this browser.

// Which month, as page state like spendingYears. The last complete month by
// default: the running one is half a month and would compare unfairly.
let auditMonth = null;

const cadenceName = (name) => (CADENCES.find((c) => c.name === name) || {}).label || name;
const findingLevel = (f) => (f.ok ? 'ok' : f.severity === 'warn' ? 'warn' : 'info');

views.audit = async () => {
  const thisMonth = today().slice(0, 7);
  const month = auditMonth || monthAdd(thisMonth, -1);
  const a = await api(`/api/audit?month=${month}`);
  const answered = a.findings.length - a.open;

  mount(main, html`
    <div class="page-head">
      <div><h1>月度審計</h1><div class="sub">${month} · 不用 AI，每一條規則都看得到、查得到</div></div>
      <div class="row">
        <button data-step="-1">‹ 上個月</button>
        <button data-step="1" ${month >= thisMonth ? 'disabled' : ''}>下個月 ›</button>
      </div>
    </div>

    ${a.running ? html`<div class="note">這個月還沒過完，算到今天（${a.to}）為止。</div>` : ''}
    ${a.unpaired_in_month ? html`<div class="note warn">這個月有 ${a.unpaired_in_month}
      筆看起來是自己帳戶之間的轉帳、還沒配對，審計先不算它們——配對了就不是消費，沒配對的話它們會是這個月最大的幾筆「支出」。
      <a href="/transactions">去交易頁配對</a></div>` : ''}

    ${a.findings.length ? html`<section class="card todo">
      <div class="todo-head">
        <h2>要看一下的地方</h2>
        <span class="muted small">${a.open} 項待看${answered ? `，${answered} 項已確認` : ''}</span>
      </div>
      ${a.findings.map(findingRow)}
    </section>` : html`<section class="card">${empty(a.future
      ? '這個月還沒開始。'
      : '這個月沒有發現要看的地方。下面列了查過哪些。')}</section>`}

    <section class="card">
      <h2 class="sec">固定扣款</h2>
      <div class="muted small spaced">取消了某個訂閱，就在這裡標記；之後它再扣款，審計會列出來。</div>
      ${subscriptionTable(a.subscriptions)}
    </section>

    <section class="card">
      <details>
        <summary>查了哪些</summary>
        <ul class="small">
          <li><b>可能重複扣款</b>：同一個帳戶、同一家、同金額，同一天或隔天各扣一次。過去一年常這樣買的（例如每天兩杯咖啡）不問；其中一筆已經退款的也不問。</li>
          <li><b>一期扣了兩次</b>：固定扣款在不到半個週期內扣了兩次。</li>
          <li><b>取消了還在扣</b>：你標記取消之後，同一個商家又扣款。</li>
          <li><b>固定扣款漲價</b>：前兩次金額一模一樣，這次比較貴。本來就會浮動的帳單（例如電費）不算。</li>
          <li><b>新的固定扣款</b>：這個月起才湊滿三次、算得上固定扣款的。</li>
          <li><b>分類比平常高很多</b>：是前三個月平均的 1.5 倍以上，而且佔這個月支出一成以上。前面有資料的月份少於兩個就不判斷；未分類不比，它變多通常是還沒分類或轉帳沒配對。</li>
          <li><b>大額支出</b>：比前六個月同一個幣別最大的一筆支出還大兩倍以上。</li>
          <li><b>手續費或利息</b>：描述裡有手續費、年費、利息、循環、違約金、FEE、INTEREST 這類字，或類型是手續費。</li>
        </ul>
        <div class="muted small">每個幣別只跟自己比，不換算。轉帳、還沒配對的轉帳、市值變動和買賣股票都不算支出（買賣的手續費照樣列）。</div>
      </details>
    </section>
  `);

  $$('[data-step]').forEach((b) => (b.onclick = () => {
    auditMonth = monthAdd(month, Number(b.dataset.step));
    render();
  }));
  const answer = async (path, body, done) => {
    try {
      await put(path, body);
      toast(done, 'ok');
      render();
    } catch (e) { toast(e.message, 'err'); }
  };
  $$('[data-ok]').forEach((b) => (b.onclick = () =>
    answer('/api/audit/ok', { key: b.dataset.ok, ok: b.dataset.answer === 'ok' },
      b.dataset.answer === 'ok' ? '已確認沒問題' : '改回待看')));
  $$('[data-cancel]').forEach((b) => (b.onclick = () =>
    answer('/api/audit/cancel', { series: b.dataset.cancel, since: b.dataset.since ? today() : null },
      b.dataset.since ? '已標記取消：之後再扣款會列出來' : '已拿掉取消的標記')));
};

function findingRow(f) {
  const where = [f.currency, f.account_name, f.category !== undefined ? f.category || UNCATEGORISED_LABEL : '']
    .filter(Boolean).join(' · ');
  return html`<div class="todo-item ${findingLevel(f)}">
    <div class="todo-body">
      <div class="todo-label">${f.ok ? `${f.label}（已確認沒問題）` : f.label} · ${money(f.amount, f.currency)}</div>
      <div class="todo-text">${f.detail}</div>
      <div class="todo-rows">${where}${f.rows.map((r) => html`<br>${r.date} ${r.description} ${money(r.amount, f.currency)}`)}</div>
    </div>
    ${f.ok
      ? html`<button class="sm" data-ok="${f.key}" data-answer="reopen">改回待看</button>`
      : html`<button class="sm" data-ok="${f.key}" data-answer="ok">沒問題</button>`}
  </div>`;
}

function subscriptionTable(items) {
  if (!items.length) return empty('還沒有偵測到固定扣款：同一家要扣滿三次、間隔規律才算。');
  return html`<div class="table-wrap"><table>
    <thead><tr><th>商家</th><th>帳戶</th><th>節奏</th><th class="num">金額</th><th>最近一次</th><th></th></tr></thead>
    <tbody>${items.map((s) => html`<tr>
      <td>${s.label}</td>
      <td>${s.account_name}</td>
      <td>${cadenceName(s.cadence)}</td>
      <td class="num">${money(s.median_amount, s.currency)}</td>
      <td>${s.last}</td>
      <td class="num">${s.cancelled_since
        ? html`<span class="muted small">${s.cancelled_since} 取消</span> <button class="sm" data-cancel="${s.series}">拿掉標記</button>`
        : html`<button class="sm" data-cancel="${s.series}" data-since="1">我取消了</button>`}</td>
    </tr>`)}</tbody>
  </table></div>`;
}
