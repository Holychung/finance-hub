'use strict';

// /account/<id> — one account's own page: its balance, its transactions and
// its reconciliation history.

const acctState = { id: null, offset: 0, limit: 100 };

views.account = async () => {
  const id = Number(routeParam());
  if (acctState.id !== id) { acctState.id = id; acctState.offset = 0; }

  const accounts = await api('/api/accounts');
  const a = accounts.find((x) => x.id === id);
  if (!a) {
    mount(main, html`
      <div class="page-head"><h1>找不到這個帳戶</h1></div>
      <section class="card">${empty('它可能已經被刪掉了。')}</section>`);
    return;
  }

  const qs = new URLSearchParams({ account: id, limit: acctState.limit, offset: acctState.offset });
  const [data, checks, imports] = await Promise.all([
    api(`/api/txns?${qs}`), api('/api/reconcile'), api('/api/imports'),
  ]);
  const mine = checks.filter((c) => c.account_id === id);
  const off = mine.filter((c) => !c.ok);
  const myImports = imports.filter((i) => i.account_id === id);
  const span = data.rows.length
    ? `${data.rows[data.rows.length - 1].date} → ${data.rows[0].date}`
    : '還沒有交易';

  mount(main, html`
    <div class="page-head">
      <div>
        <h1>${a.name}</h1>
        <div class="sub">
          ${kindName(a.kind)} · <span class="cur">${a.currency}</span> ·
          ${data.total} 筆交易 · ${span}
          ${a.is_active ? '' : html` <span class="pill">已停用</span>`}${a.access === 'restricted' ? html` <span class="pill">${accessName(a.access)}</span>` : ''}
        </div>
      </div>
      <div class="row shrink">
        <a class="btn" href="/import">匯入 CSV</a>
        <button id="a-check">對帳</button>
        <button id="a-edit">編輯帳戶</button>
      </div>
    </div>

    <section class="grid g4">
      <div class="card kpi"><div class="label">目前餘額</div>
        <div class="value ${level(a.balance)}">${money(a.balance, a.currency)}</div>
        <div class="meta">${LIABILITY_KINDS.has(a.kind) ? '負數代表欠款' : a.currency}</div></div>
      <div class="card kpi"><div class="label">交易筆數</div>
        <div class="value">${data.total}</div>
        <div class="meta">${span}</div></div>
      <div class="card kpi"><div class="label">期初餘額</div>
        <div class="value dim">${money(a.opening_balance, a.currency)}</div>
        <div class="meta">${a.opening_date}</div></div>
      <div class="card kpi"><div class="label">對帳</div>
        <div class="value ${off.length ? 'neg' : mine.length ? 'pos' : 'dim'}">
          ${mine.length ? (off.length ? `${off.length} 筆不符` : '相符') : '—'}</div>
        <div class="meta">${mine.length ? `共 ${mine.length} 次紀錄` : '還沒對過帳'}</div></div>
    </section>

    ${off.length ? html`<section><div class="note warn">
      這個帳戶的實際餘額跟交易累計對不起來：${off.map((c) => html`
        <div>${c.date} 網銀 ${money(c.stated, a.currency)}，帳面 ${money(c.computed, a.currency)}，
        差 <b>${signed(c.diff, a.currency)}</b></div>`)}
      通常是 CSV 漏匯，或期初餘額填錯。
    </div></section>` : ''}

    <section class="card">
      <h2 class="sec">交易</h2>
      <div class="table-wrap">${txnTable(data.rows, { showAccount: false })}</div>
      ${data.total > data.limit ? html`<div class="toolbar pager">
        <button ${data.offset === 0 ? 'disabled' : ''} id="pg-prev">上一頁</button>
        <span class="muted small">${data.offset + 1}–${Math.min(data.offset + data.limit, data.total)} / ${data.total}</span>
        <button ${data.offset + data.limit >= data.total ? 'disabled' : ''} id="pg-next">下一頁</button>
      </div>` : ''}
    </section>

    ${myImports.length ? html`<section class="card">
      <h2 class="sec">匯入紀錄</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>時間</th><th>檔名</th><th class="num">匯入</th><th class="num">略過</th></tr></thead>
        <tbody>${myImports.map((i) => html`<tr>
          <td class="nowrap small">${i.created_at.slice(0, 16).replace('T', ' ')}</td>
          <td class="truncate">${i.filename}</td>
          <td class="num">${i.imported}</td>
          <td class="num dim">${i.skipped}</td>
        </tr>`)}</tbody>
      </table></div>
    </section>` : ''}
  `);

  $('#a-check').onclick = () => balanceCheckForm(a);
  $('#a-edit').onclick = async () => accountForm(a, await api('/api/institutions'));
  if ($('#pg-prev')) $('#pg-prev').onclick = () => { acctState.offset = Math.max(0, acctState.offset - acctState.limit); render(); };
  if ($('#pg-next')) $('#pg-next').onclick = () => { acctState.offset += acctState.limit; render(); };
  wireTxnRowActions(data.rows, accounts);
};
