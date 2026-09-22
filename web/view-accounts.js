'use strict';

// /accounts — the account list, and the one form only this page opens.

views.accounts = async () => {
  const [accounts, institutions, checks] = await Promise.all([
    api('/api/accounts'), api('/api/institutions'), api('/api/reconcile'),
  ]);

  mount(main, html`
    <div class="page-head">
      <div><h1>帳戶</h1><div class="sub">銀行、券商、信用卡、貸款都放同一張表</div></div>
      <div class="row shrink">
        <button class="btn" id="add-inst">新增機構</button>
        <button class="primary" id="add-acct">新增帳戶</button>
      </div>
    </div>

    <section class="card">
      <div class="table-wrap">${
        accounts.length
          ? html`<table>
              <thead><tr>
                <th>帳戶</th><th>機構</th><th>類型</th><th>幣別</th>
                <th class="num">期初</th><th class="num">目前餘額</th><th></th>
              </tr></thead>
              <tbody>${accounts.map((a) => {
                const inst = institutions.find((i) => i.id === a.institution_id);
                return html`<tr>
                  <td>${a.name}${a.is_active ? '' : html` <span class="pill">已停用</span>`}${a.access === 'restricted' ? html` <span class="pill">${accessName(a.access)}</span>` : ''}</td>
                  <td class="dim">${inst ? inst.name : '—'}</td>
                  <td>${kindName(a.kind)}</td>
                  <td class="cur">${a.currency}</td>
                  <td class="num dim">${money(a.opening_balance, a.currency)}<br><span class="small">${a.opening_date}</span></td>
                  <td class="num ${level(a.balance)}">${money(a.balance, a.currency)}</td>
                  <td class="num nowrap row-actions">
                    <button class="sm" data-check="${a.id}">對帳</button>
                    <button class="icon-btn" data-edit="${a.id}" title="編輯" aria-label="編輯「${a.name}」">${icon('edit')}</button>
                    <button class="icon-btn danger" data-del="${a.id}" title="刪除" aria-label="刪除「${a.name}」">${icon('trash')}</button>
                  </td>
                </tr>`;
              })}</tbody>
            </table>`
          : empty('還沒有帳戶。點右上角「新增帳戶」開始。')
      }</div>
    </section>

    <section class="card">
      <h2 class="sec">餘額對帳紀錄</h2>
      <div class="note">CSV 匯入一定會漏東西（區間沒涵蓋、分頁沒撈完、格式怪的那幾行）。定期把網銀上看到的餘額記一筆進來，系統就會告訴你差多少，而不是讓帳默默爛掉。</div>
      <div class="table-wrap">${checks.length ? reconcileTable(checks) : empty('還沒有對帳紀錄。在上面任一帳戶點「對帳」。')}</div>
    </section>
  `);

  $('#add-acct').onclick = () => accountForm(null, institutions);
  $('#add-inst').onclick = () => institutionForm();
  $$('[data-edit]').forEach((b) => (b.onclick = () => accountForm(accounts.find((a) => a.id === +b.dataset.edit), institutions)));
  $$('[data-check]').forEach((b) => (b.onclick = () => balanceCheckForm(accounts.find((a) => a.id === +b.dataset.check))));
  $$('[data-del]').forEach((b) => (b.onclick = async () => {
    const a = accounts.find((x) => x.id === +b.dataset.del);
    if (!confirm(`刪除帳戶「${a.name}」？它底下的所有交易和持股都會一起刪掉，無法復原。`)) return;
    await del(`/api/accounts/${a.id}`);
    toast('已刪除', 'ok');
    render();
  }));
};

function institutionForm() {
  modal('新增機構', html`
    <label class="field"><span>名稱</span><input id="i-name" placeholder="玉山銀行"></label>
    <div class="row">
      <label class="field"><span>類型</span><select id="i-kind">
        <option value="bank">銀行</option><option value="broker">券商</option>
        <option value="card">發卡機構</option><option value="other">其他</option>
      </select></label>
      <label class="field"><span>國別</span><select id="i-country">
        <option value="TW">台灣</option><option value="US">美國</option><option value="other">其他</option>
      </select></label>
    </div>
    <div class="modal-foot">
      <button data-close-modal>取消</button><button class="primary" id="i-save">儲存</button>
    </div>
  `, (body) => {
    $('#i-save', body).onclick = async () => {
      const name = $('#i-name').value.trim();
      if (!name) return toast('名稱必填', 'err');
      try {
        await post('/api/institutions', { name, kind: $('#i-kind').value, country: $('#i-country').value });
        closeModal(); toast('已新增', 'ok'); render();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}
