'use strict';

// /transactions — every transaction, filtered, plus the transfer pairing
// review that keeps both legs of a transfer out of income and expense.

const txState = { account: '', from: '', to: '', q: '', kind: '', offset: 0, limit: 100 };

views.transactions = async () => {
  const accounts = await api('/api/accounts');
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(txState).filter(([, v]) => v !== '' && v !== null)));
  const [data, candidates] = await Promise.all([api(`/api/txns?${qs}`), api('/api/transfers/candidates')]);
  const filtered = txState.account || txState.q || txState.from || txState.to || txState.kind;

  mount(main, html`
    <div class="page-head">
      <div><h1>交易</h1><div class="sub">共 ${data.total} 筆${filtered ? '（已篩選）' : ''}</div></div>
      <div class="row shrink">
        ${exportLink('匯出 CSV', '/api/export/csv?type=txns')}
        <button class="primary" id="add-tx">手動新增</button>
      </div>
    </div>

    ${candidates.length ? html`<section><div class="note">
      偵測到 <b>${candidates.length}</b> 組可能的帳戶間轉帳。配對之後這些金額就不會被算成收入或支出。
      <button class="sm" id="review-transfers">檢視並配對</button>
    </div></section>` : ''}

    <section class="card">
      <div class="toolbar">
        <select id="f-account">
          <option value="">全部帳戶</option>
          ${accounts.map((a) => html`<option value="${a.id}" ${String(a.id) === txState.account ? 'selected' : ''}>${a.name}</option>`)}
        </select>
        <select id="f-kind">
          <option value="">全部類型</option>
          ${TXN_KINDS.map(({ key: k }) => html`<option value="${k}" ${k === txState.kind ? 'selected' : ''}>${kindName(k)}</option>`)}
        </select>
        <input id="f-from" type="date" value="${txState.from}">
        <input id="f-to" type="date" value="${txState.to}">
        <input id="f-q" class="grow" type="search" placeholder="搜尋摘要／分類／備註" value="${txState.q}">
        <button class="shrink" id="f-clear">清除</button>
      </div>

      <div class="table-wrap">${txnTable(data.rows)}</div>

      ${data.total > data.limit ? html`<div class="toolbar pager">
        <button ${data.offset === 0 ? 'disabled' : ''} id="pg-prev">上一頁</button>
        <span class="muted small">${data.offset + 1}–${Math.min(data.offset + data.limit, data.total)} / ${data.total}</span>
        <button ${data.offset + data.limit >= data.total ? 'disabled' : ''} id="pg-next">下一頁</button>
      </div>` : ''}
    </section>
  `);

  const apply = () => {
    txState.account = $('#f-account').value;
    txState.kind = $('#f-kind').value;
    txState.from = $('#f-from').value;
    txState.to = $('#f-to').value;
    txState.q = $('#f-q').value.trim();
    txState.offset = 0;
    render();
  };
  ['#f-account', '#f-kind', '#f-from', '#f-to'].forEach((s) => ($(s).onchange = apply));
  $('#f-q').onkeydown = (e) => { if (e.key === 'Enter') apply(); };
  $('#f-clear').onclick = () => {
    Object.assign(txState, { account: '', from: '', to: '', q: '', kind: '', offset: 0 });
    render();
  };
  if ($('#pg-prev')) $('#pg-prev').onclick = () => { txState.offset = Math.max(0, txState.offset - txState.limit); render(); };
  if ($('#pg-next')) $('#pg-next').onclick = () => { txState.offset += txState.limit; render(); };
  $('#add-tx').onclick = () => txnForm(null, accounts);
  if ($('#review-transfers')) $('#review-transfers').onclick = () => transferReview(candidates);
  wireTxnRowActions(data.rows, accounts);
};

function transferReview(candidates) {
  modal('轉帳配對', html`
    <div class="note small">
      這些是系統找到的「一出一進、金額相符、日期相近」的成對交易。勾選要配對的，配對後兩筆會標成轉帳，不再計入收支。
      跨幣別的會依當日匯率比對，容許 1.5% 的手續費與價差。
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        <th class="col-check"><input type="checkbox" id="chk-all" checked></th>
        <th>轉出</th><th>轉入</th><th class="num">金額</th><th class="num">差異</th>
      </tr></thead>
      <tbody>${candidates.map((c, i) => html`<tr>
        <td><input type="checkbox" class="chk" data-i="${i}" checked></td>
        <td class="small">${c.out.date}<br><span class="dim">${c.out.account_name}</span></td>
        <td class="small">${c.in.date}<br><span class="dim">${c.in.account_name}</span></td>
        <td class="num small">${money(Math.abs(c.out.amount), c.out.currency)}<br><span class="dim">${money(c.in.amount, c.in.currency)}</span></td>
        <td class="num small">${c.diff_pct}%
          ${c.cross_currency ? html`<br><span class="pill blue">跨幣</span>` : ''}
          ${c.day_gap ? html`<br><span class="dim">差 ${c.day_gap} 天</span>` : ''}</td>
      </tr>`)}</tbody>
    </table></div>
    <div class="modal-foot">
      <button data-close-modal>取消</button><button class="primary" id="tr-apply">配對選取的</button>
    </div>
  `, (body) => {
    $('#chk-all', body).onchange = (e) => $$('.chk', body).forEach((c) => (c.checked = e.target.checked));
    $('#tr-apply', body).onclick = async () => {
      const pairs = $$('.chk', body).filter((c) => c.checked)
        .map((c) => candidates[+c.dataset.i]).map((c) => ({ outId: c.out.id, inId: c.in.id }));
      if (!pairs.length) return toast('沒有選取任何項目', 'err');
      try {
        const r = await post('/api/transfers/apply', { pairs });
        closeModal(); toast(`已配對 ${r.paired} 組轉帳`, 'ok'); render();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}
