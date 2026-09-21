'use strict';

// Tables more than one view renders. A helper earns its place here by having
// a second caller: accountTable is still in view-overview.js because only the
// overview draws it.

function reconcileTable(checks) {
  return html`<table>
    <thead><tr><th>日期</th><th>帳戶</th><th class="num">銀行顯示</th><th class="num">交易累計</th><th class="num">差額</th></tr></thead>
    <tbody>${checks.map((c) => html`<tr>
      <td class="nowrap">${c.date}</td><td>${c.account_name}</td>
      <td class="num">${money(c.stated, c.currency)}</td>
      <td class="num dim">${money(c.computed, c.currency)}</td>
      <td class="num ${c.ok ? 'dim' : 'neg'}">${c.ok ? '✓ 相符' : signed(c.diff, c.currency)}</td>
    </tr>`)}</tbody>
  </table>`;
}

// Shared by the all-transactions view and each account's own page. The account
// column is noise on a page that is already about one account.
function txnTable(rows, { showAccount = true } = {}) {
  if (!rows.length) return empty('沒有符合的交易。');
  return html`<table>
    <thead><tr>
      <th>日期</th>${showAccount ? html`<th>帳戶</th>` : ''}<th>摘要</th><th>分類</th><th>類型</th>
      <th class="num">金額</th><th></th>
    </tr></thead>
    <tbody>${rows.map((t) => html`<tr>
      <td class="nowrap">${t.date}</td>
      ${showAccount ? html`<td class="nowrap dim">${t.account_name}</td>` : ''}
      <td class="truncate" title="${t.description}">${t.description || html`<span class="dim">（無摘要）</span>`}${
        // `csv` is what almost every row is, so a column of it said nothing and
        // a pill of it said nothing loudly. Only a row that did NOT come from a
        // statement is worth marking, and it is marked where you are already
        // reading rather than in a column of its own.
        t.source === 'csv' ? '' : html` <span class="pill">${t.source}</span>`}</td>
      <td class="dim">${t.category || '—'}</td>
      <td>${t.transfer_group
        // The one pill left in this table: 轉帳 is a status — these two rows
        // are a matched pair and no longer count as income or spending. Every
        // other kind is just the value of the 類型 column, which the header
        // already names.
        ? html`<span class="pill violet">轉帳</span>`
        : kindName(t.kind)}</td>
      <td class="num ${cls(t.amount)}">${signed(t.amount, t.currency)}</td>
      <td class="num nowrap row-actions">
        <button class="icon-btn" data-edit="${t.id}" title="編輯" aria-label="編輯這筆交易">${icon('edit')}</button>
        <button class="icon-btn danger" data-del="${t.id}" title="刪除" aria-label="刪除這筆交易">${icon('trash')}</button>
      </td>
    </tr>`)}</tbody>
  </table>`;
}

// Edit and delete behave the same wherever the table is shown.
function wireTxnRowActions(rows, accounts) {
  $$('[data-edit]').forEach((b) => (b.onclick = () => txnForm(rows.find((t) => t.id === +b.dataset.edit), accounts)));
  $$('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('刪除這筆交易？')) return;
    await del(`/api/txns/${b.dataset.del}`);
    toast('已刪除', 'ok'); render();
  }));
}
