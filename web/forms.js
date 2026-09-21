'use strict';

// The modal editors two or more views open. Same rule as tables.js — a form
// stays with its view until a second view needs it, which is why
// institutionForm and holdingForm are not here.

function accountForm(acct, institutions) {
  const a = acct || {
    name: '', kind: 'cash', currency: 'TWD', opening_balance: 0,
    opening_date: today(), institution_id: null, is_active: 1, note: '',
  };
  modal(acct ? `編輯 ${acct.name}` : '新增帳戶', html`
    <label class="field"><span>帳戶名稱</span><input id="f-name" value="${a.name}" placeholder="玉山活存"></label>
    <div class="row">
      <label class="field"><span>機構</span><select id="f-inst">
        <option value="">（未指定）</option>
        ${institutions.map((i) => html`<option value="${i.id}" ${i.id === a.institution_id ? 'selected' : ''}>${i.name}</option>`)}
      </select></label>
      <label class="field"><span>類型</span><select id="f-kind">
        ${['cash', 'brokerage', 'card', 'loan', 'other'].map((k) => html`<option value="${k}" ${k === a.kind ? 'selected' : ''}>${kindName(k)}</option>`)}
      </select></label>
      <label class="field"><span>幣別</span><select id="f-cur">
        ${['TWD', 'USD'].map((c) => html`<option ${c === a.currency ? 'selected' : ''}>${c}</option>`)}
      </select></label>
    </div>
    <div class="row">
      <label class="field"><span>期初餘額（原幣）</span><input id="f-ob" type="number" step="0.01" value="${a.opening_balance}"></label>
      <label class="field"><span>期初日期</span><input id="f-od" type="date" value="${a.opening_date}"></label>
    </div>
    <div class="note small">期初餘額是「你開始匯入 CSV 那天之前的餘額」。之後所有交易都在這個基礎上加減。設錯了餘額會整體偏移，但隨時可以回來改。</div>
    <div class="note warn small" id="f-liability" hidden></div>
    <label class="field"><span>備註</span><input id="f-note" value="${a.note}"></label>
    <label class="field"><span><input type="checkbox" id="f-active" ${a.is_active ? 'checked' : ''}> 啟用中</span></label>
    <div class="modal-foot">
      <button data-close-modal>取消</button><button class="primary" id="f-save">儲存</button>
    </div>
  `, (body) => {
    // A statement shows what you owe as a positive number, but the ledger
    // stores what the account is worth to you, so a card you owe on is
    // negative. Typing the statement figure straight in overstates net worth
    // by twice the balance and every total still looks plausible, so say so
    // while the number is being typed rather than leaving it to be noticed.
    const note = $('#f-liability', body);
    const syncLiability = () => {
      const kind = $('#f-kind', body).value;
      const ob = Number($('#f-ob', body).value || 0);
      const show = LIABILITY_KINDS.has(kind) && ob > 0;
      if (show) {
        // The account does not exist yet, so there is no converted figure to
        // quote; name the currency explicitly instead of letting a bare "$"
        // read as the base currency the overview reports in.
        const cur = $('#f-cur', body).value;
        mount(note, html`欠款要填<b>負數</b>：${kindName(kind)}欠 ${nf(ob, 2)} 請填 <code>-${nf(ob, 2)}</code>。
          填成正數的話，淨值會多算 ${money(ob * 2, cur)} ${cur} 等值的金額。真的是溢繳就不用理這則提醒。`);
      }
      note.hidden = !show;
    };
    $('#f-kind', body).onchange = syncLiability;
    $('#f-cur', body).onchange = syncLiability;
    $('#f-ob', body).oninput = syncLiability;
    syncLiability();

    $('#f-save', body).onclick = async () => {
      const payload = {
        name: $('#f-name').value.trim(),
        institution_id: $('#f-inst').value || null,
        kind: $('#f-kind').value,
        currency: $('#f-cur').value,
        opening_balance: Number($('#f-ob').value || 0),
        opening_date: $('#f-od').value || today(),
        is_active: $('#f-active').checked ? 1 : 0,
        note: $('#f-note').value,
      };
      if (!payload.name) return toast('帳戶名稱必填', 'err');
      try {
        acct ? await put(`/api/accounts/${acct.id}`, payload) : await post('/api/accounts', payload);
        closeModal(); toast('已儲存', 'ok'); render();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

function balanceCheckForm(acct, date = today()) {
  modal(`對帳 — ${acct.name}`, html`
    <div class="note small">打開網銀，把它顯示的餘額填進來。系統會拿這個數字跟「期初餘額 ＋ 所有交易」比對。</div>
    <div class="row">
      <label class="field"><span>日期</span><input id="b-date" type="date" value="${date}"></label>
      <label class="field"><span>銀行顯示餘額（${acct.currency}）</span><input id="b-stated" type="number" step="0.01" placeholder="0.00"></label>
    </div>
    <label class="field"><span>備註</span><input id="b-note" placeholder="例如：網銀截圖 2026-09-20"></label>
    <div class="modal-foot">
      <button data-close-modal>取消</button><button class="primary" id="b-save">儲存</button>
    </div>
  `, (body) => {
    $('#b-save', body).onclick = async () => {
      try {
        await post('/api/balance-checks', {
          account_id: acct.id, date: $('#b-date').value,
          stated: Number($('#b-stated').value || 0), note: $('#b-note').value,
        });
        closeModal(); toast('已記錄', 'ok'); render();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

function txnForm(txn, accounts) {
  if (!accounts.length) return toast('請先建立至少一個帳戶', 'err');
  const t = txn || {
    account_id: accounts[0]?.id, date: today(), amount: '',
    description: '', category: '', kind: 'other', note: '',
  };
  modal(txn ? '編輯交易' : '手動新增交易', html`
    <div class="row">
      <label class="field"><span>帳戶</span><select id="t-acct">
        ${accounts.map((a) => html`<option value="${a.id}" ${a.id === t.account_id ? 'selected' : ''}>${a.name}（${a.currency}）</option>`)}
      </select></label>
      <label class="field"><span>日期</span><input id="t-date" type="date" value="${t.date}"></label>
    </div>
    <div class="row">
      <label class="field"><span>金額（流入為正，流出為負）</span><input id="t-amt" type="number" step="0.01" value="${t.amount}" placeholder="-1200"></label>
      <label class="field"><span>類型</span><select id="t-kind">
        ${['other', 'income', 'expense', 'trade', 'dividend', 'fee', 'fx']
          .map((k) => html`<option value="${k}" ${k === t.kind ? 'selected' : ''}>${kindName(k)}</option>`)}
      </select></label>
    </div>
    <label class="field"><span>摘要</span><input id="t-desc" value="${t.description}"></label>
    <div class="row">
      <label class="field"><span>分類</span><input id="t-cat" value="${t.category}" placeholder="房租／薪資／…"></label>
      <label class="field"><span>備註</span><input id="t-note" value="${t.note || ''}"></label>
    </div>
    <div class="modal-foot">
      <button data-close-modal>取消</button><button class="primary" id="t-save">儲存</button>
    </div>
  `, (body) => {
    $('#t-save', body).onclick = async () => {
      const payload = {
        account_id: Number($('#t-acct').value), date: $('#t-date').value,
        amount: Number($('#t-amt').value), description: $('#t-desc').value,
        category: $('#t-cat').value, kind: $('#t-kind').value, note: $('#t-note').value,
      };
      if (!payload.amount) return toast('金額不能是 0', 'err');
      try {
        txn ? await put(`/api/txns/${txn.id}`, payload) : await post('/api/txns', payload);
        closeModal(); toast('已儲存', 'ok'); render();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}
