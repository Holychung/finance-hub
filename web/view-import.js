'use strict';

// /import — pick a file, map its columns, read what will land, confirm.
//
// The largest file here and the only flow whose state outlives a render:
// `imp` holds the file, the mapping and the skip set across the several
// round trips the wizard makes. renderPreview() mounts into #imp-result
// rather than re-running the view, which is why runPreview() has to do its
// own captureUi/restoreUi — render() never sees this path.

const imp = { file: null, base64: null, accountId: null, preview: null, mapping: null, skip: new Set(), period: null };

// 銀行的下載頁會讓你選「Statement of 2026-08」「Year to date」「自訂區間」。
// 那個選擇就是這份檔案涵蓋的期間，而 CSV 本身不會寫。使用者記得自己按了什麼，
// 所以問他 —— 這是唯一誠實的來源，其餘都只能從資料列反推，而反推看不出「這個月
// 前半段有涵蓋、只是沒有消費」。
//
// 預設是「照檔案內容推算」，因為那是不必回答就正確的答案（只是保守）。
const PERIOD_PRESETS = {
  derived: '照檔案內容推算（保守）',
  statement: '一期帳單／自訂區間',
  ytd: '年初至今',
  year: '整個年度',
};

views.import = async () => {
  const [accounts, mappings, imports] = await Promise.all([
    api('/api/accounts'), api('/api/mappings'), api('/api/imports'),
  ]);

  mount(main, html`
    <div class="page-head">
      <div><h1>匯入 CSV</h1><div class="sub">從網銀／券商下載對帳單，丟進來</div></div>
    </div>

    <section class="card">
      <div class="step ${imp.accountId ? 'done' : ''}"><span class="step-no">1</span><span class="step-label">選擇要匯入的帳戶</span>${accounts.length ? '' : html`<span class="pill">可跳過</span>`}</div>
      <select id="imp-account" class="constrained">
        <option value="">— 選擇帳戶 —</option>
        ${accounts.map((a) => html`<option value="${a.id}" ${a.id === imp.accountId ? 'selected' : ''}>${a.name}（${a.currency}）</option>`)}
      </select>
      ${accounts.length ? '' : html`<div class="note">
        還沒有帳戶也沒關係。直接丟檔案進來，系統會從檔案內容把帳戶資料填好讓你確認——
        有餘額欄的對帳單連<b>期初餘額都算得出來</b>，不用去網銀查。
      </div>`}
    </section>

    <section class="card">
      <div class="step ${imp.file ? 'done' : ''}"><span class="step-no">2</span><span class="step-label">選擇 CSV 檔</span></div>
      <div class="dropzone" id="dropzone">
        ${imp.file
          ? html`<b>${imp.file.name}</b><div class="small dim">${nf(imp.file.size / 1024, 1)} KB · 點此換一個檔案</div>`
          : html`把檔案拖進來，或點一下選檔<div class="small">自動判讀 UTF-8 與 Big5，民國年也認得</div>`}
      </div>
      <input type="file" id="file-input" accept=".csv,.txt,text/csv" hidden>
      ${storage.name === 'demo' ? html`<div class="toolbar">
        <button class="sm" id="demo-statement">載入一份範例對帳單</button>
        <span class="muted small">玉山格式：民國年、支出／存入兩欄、有餘額欄可以逐行對帳。沒選帳戶就會走「從這個檔案建立帳戶」</span>
      </div>` : ''}
      ${mappings.length ? html`<div class="toolbar">
        <span class="muted small">套用記住的對應：</span>
        ${mappings.map((m) => html`<button class="sm" data-mapping="${m.id}">${m.name}</button>`)}
      </div>` : ''}
    </section>

    <div id="imp-result"></div>

    <section class="card">
      <h2 class="sec">匯入紀錄</h2>
      <div class="table-wrap">${
        imports.length
          ? html`<table>
              <thead><tr><th>時間</th><th>帳戶</th><th>檔名</th><th class="num">匯入</th><th class="num">略過</th><th></th></tr></thead>
              <tbody>${imports.map((i) => html`<tr>
                <td class="nowrap small">${i.created_at.slice(0, 16).replace('T', ' ')}</td>
                <td class="dim">${i.account_name || '—'}</td>
                <td class="truncate small">${i.filename}</td>
                <td class="num pos">${i.imported}</td>
                <td class="num dim">${i.skipped}</td>
                <td class="num"><button class="sm danger" data-revert="${i.id}">回復</button></td>
              </tr>`)}</tbody>
            </table>`
          : empty('還沒有匯入過。')
      }</div>
    </section>
  `);

  $('#imp-account').onchange = (e) => {
    imp.accountId = e.target.value ? Number(e.target.value) : null;
    imp.preview = null;
    runPreview();
  };

  const dz = $('#dropzone');
  const fi = $('#file-input');
  dz.onclick = () => fi.click();
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); };
  fi.onchange = () => { if (fi.files[0]) loadFile(fi.files[0]); };

  // Demo only. Goes through loadFile like a dropped file rather than
  // shortcutting into the preview, so what gets exercised is the real path:
  // FileReader, the encoding sniff, the header detector, all of it.
  const sample = $('#demo-statement');
  if (sample) {
    sample.onclick = (e) => {
      e.stopPropagation();
      const s = buildDemoStatement(new Date().toISOString().slice(0, 10));
      loadFile(new File([s.text], s.name, { type: 'text/csv' }));
    };
  }

  $$('[data-mapping]').forEach((b) => (b.onclick = () => {
    const m = mappings.find((x) => x.id === +b.dataset.mapping);
    imp.mapping = { ...m.config };
    toast(`已套用「${m.name}」`, 'ok');
    runPreview();
  }));

  $$('[data-revert]').forEach((b) => (b.onclick = async () => {
    if (!confirm('回復這次匯入？該批次新增的交易會全部刪除。')) return;
    const r = await del(`/api/imports/${b.dataset.revert}`);
    toast(`已回復 ${r.reverted} 筆`, 'ok'); render();
  }));

  if (imp.preview) renderPreview();
};

function loadFile(file) {
  imp.file = file;
  imp.preview = null;
  imp.skip = new Set();
  // A new file is a new statement with its own period; keeping the last
  // answer would silently declare it for a file nobody answered for.
  imp.period = null;
  const reader = new FileReader();
  reader.onload = () => {
    imp.base64 = String(reader.result).split(',')[1];
    render().then(runPreview);
  };
  reader.readAsDataURL(file);
}

async function runPreview() {
  if (!imp.base64) return;
  // This path rebuilds #imp-result without going through render(), and that
  // block holds the mapping form — change 標題列, press 套用, and the field you
  // were in is a new node.
  const snap = captureUi();
  try {
    imp.preview = await post('/api/import/preview', {
      account_id: imp.accountId || undefined,
      content_base64: imp.base64,
      filename: imp.file?.name,
      mapping: imp.mapping || undefined,
    });
    imp.mapping = imp.preview.mapping;
    // No account yet: the file has just told us most of what one needs, so
    // offer to create it here rather than sending the user off to another
    // view to type in an opening balance this file already knows.
    if (!imp.accountId && imp.preview.suggested_account) {
      accountFromCsvForm(imp.preview.suggested_account);
      return;
    }
    renderPreview();
    restoreUi(snap);
  } catch (e) {
    // If the view already blew up, #imp-result is gone and mounting into it
    // throws again — reporting the missing element instead of what actually
    // failed. A toast always has somewhere to go.
    const slot = $('#imp-result');
    if (slot) mount(slot, html`<section class="card"><div class="note warn">${e.message}</div></section>`);
    else toast(e.message, 'err');
  }
}

// Everything is pre-filled and everything is editable; nothing is written
// until 建立 is pressed.
function accountFromCsvForm(s) {
  const inst = s.institution || { name: '', kind: 'bank', country: 'US' };
  modal('從這個檔案建立帳戶', html`
    <div class="note small">
      下面是從 <code>${imp.file?.name || 'CSV'}</code> 讀出來的。有錯就直接改，按「建立」才會寫入。
      ${s.covers ? html`<br>檔案涵蓋 ${s.covers.from} → ${s.covers.to}，共 ${s.covers.rows} 筆。` : ''}
    </div>
    ${s.notes.map((n) => html`<div class="note warn small">${n}</div>`)}

    <div class="row">
      <label class="field"><span>機構</span><input id="a-inst" value="${inst.name}" placeholder="Chase"></label>
      <label class="field"><span>機構類型</span><select id="a-instkind">
        ${[['bank', '銀行'], ['broker', '券商'], ['card', '發卡機構'], ['other', '其他']]
          .map(([v, l]) => html`<option value="${v}" ${v === inst.kind ? 'selected' : ''}>${l}</option>`)}
      </select></label>
      <label class="field"><span>國別</span><select id="a-country">
        ${[['US', '美國'], ['TW', '台灣'], ['other', '其他']]
          .map(([v, l]) => html`<option value="${v}" ${v === inst.country ? 'selected' : ''}>${l}</option>`)}
      </select></label>
    </div>

    <div class="row">
      <label class="field"><span>帳戶名稱</span><input id="a-name" value="${s.name}" placeholder="Chase ...0000"></label>
      <label class="field"><span>類型</span><select id="a-kind">
        ${['cash', 'brokerage', 'card', 'loan', 'other']
          .map((k) => html`<option value="${k}" ${k === s.kind ? 'selected' : ''}>${kindName(k)}</option>`)}
      </select></label>
      <label class="field"><span>幣別</span><select id="a-cur">
        ${['TWD', 'USD'].map((c) => html`<option ${c === s.currency ? 'selected' : ''}>${c}</option>`)}
      </select></label>
    </div>

    <div class="row">
      <label class="field"><span>期初餘額（原幣）</span>
        <input id="a-ob" type="number" step="0.01" value="${s.opening_balance}"></label>
      <label class="field"><span>期初日期</span>
        <input id="a-od" type="date" value="${s.opening_date || today()}"></label>
    </div>
    <div class="note warn small" id="a-liability" hidden></div>

    <div class="modal-foot">
      <button data-close-modal>取消</button><button class="primary" id="a-save">建立並繼續匯入</button>
    </div>
  `, (body) => {
    const note = $('#a-liability', body);
    const syncLiability = () => {
      const kind = $('#a-kind', body).value;
      const ob = Number($('#a-ob', body).value || 0);
      const show = LIABILITY_KINDS.has(kind) && ob > 0;
      if (show) {
        const cur = $('#a-cur', body).value;
        mount(note, html`欠款要填<b>負數</b>：欠 ${nf(ob, 2)} 請填 <code>-${nf(ob, 2)}</code>。
          填成正數的話，淨值會多算 ${money(ob * 2, cur)} ${cur} 等值的金額。`);
      }
      note.hidden = !show;
    };
    $('#a-kind', body).onchange = syncLiability;
    $('#a-cur', body).onchange = syncLiability;
    $('#a-ob', body).oninput = syncLiability;
    syncLiability();

    $('#a-save', body).onclick = async () => {
      const name = $('#a-name', body).value.trim();
      if (!name) return toast('帳戶名稱必填', 'err');
      try {
        const instName = $('#a-inst', body).value.trim();
        let institutionId = null;
        if (instName) {
          const existing = (await api('/api/institutions')).find((i) => i.name === instName);
          institutionId = existing
            ? existing.id
            : (await post('/api/institutions', {
                name: instName,
                kind: $('#a-instkind', body).value,
                country: $('#a-country', body).value,
              })).id;
        }
        const acct = await post('/api/accounts', {
          name, institution_id: institutionId,
          kind: $('#a-kind', body).value,
          currency: $('#a-cur', body).value,
          opening_balance: Number($('#a-ob', body).value || 0),
          opening_date: $('#a-od', body).value || today(),
        });
        closeModal();
        imp.accountId = acct.id;
        // Both, together. The preview held here was taken without an account,
        // so its dedup is meaningless now, and the mapping will be guessed
        // again against the real one.
        imp.preview = null;
        imp.mapping = null;
        toast(`已建立「${name}」`, 'ok');
        await render();
        await runPreview();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

function renderPreview() {
  const p = imp.preview;
  // The mapping is read out of `imp`, not out of the preview, so the two have
  // to be cleared together. views.import ends by calling this whenever a
  // preview is held, and a null mapping here throws *inside* the view — which
  // replaces the whole page with the error screen, taking #imp-result with it,
  // so the next mount fails on a missing element and reports that instead of
  // this. Never let a half-cleared state reach the template.
  if (!p || !imp.mapping) return;
  const m = imp.mapping;
  // Every amount on this page is in the account's currency, not the base one.
  const cur = p.account?.currency || p.suggested_account?.currency || 'TWD';
  // Survives a re-preview: changing a column mapping re-runs this whole
  // function, and a period the user already answered should not reset to the
  // default underneath them.
  const period = (imp.period ||= { kind: 'derived', from: p.summary.span_from, to: p.summary.span_to });
  const headers = p.headers;
  const colOpts = (sel) => html`
    <option value="">—</option>
    ${headers.map((h, i) => html`<option value="${i}" ${i === sel ? 'selected' : ''}>${i + 1}. ${h || '(空欄)'}</option>`)}`;

  // 將匯入 ＋ 重複略過 ＋ 解析失敗 has to account for every row in the file, and
  // a pending row is a fourth way to be left out. Shown only when there are
  // any: Citi is the only export here with a status column at all, so a
  // permanent 0 would be a tile about nothing on every other bank's file.
  const pendingKpi = p.summary.pending
    ? html`<div class="card kpi"><div class="label">未入帳</div>
        <div class="value dim">${p.summary.pending}</div></div>`
    : '';

  mount($('#imp-result'), html`
    <section class="card">
      <div class="step done"><span class="step-no">3</span><span class="step-label">欄位對應</span></div>
      <div class="muted small">
        編碼判讀為 <code>${p.encoding}</code>，分隔符 <code>${p.delimiter === '\t' ? '\\t' : p.delimiter}</code>。下方是檔案原始前幾行，藍色那行是被當成標題列的。
      </div>
      <div class="table-wrap">
        <table class="grid-preview"><tbody>${p.grid_preview.map((r, i) => html`
          <tr class="${i === m.headerRow - 1 ? 'header-row' : ''}">
            <td class="dim">${i + 1}</td>${r.map((c) => html`<td>${c}</td>`)}
          </tr>`)}</tbody></table>
      </div>

      <div class="row">
        <label class="field"><span>標題列在第幾行</span><input id="m-header" type="number" min="1" value="${m.headerRow}"></label>
        <label class="field"><span>日期欄</span><select id="m-date">${colOpts(m.dateCol)}</select></label>
        <label class="field"><span>日期格式</span><select id="m-datefmt">
          ${[['auto', '自動'], ['roc', '民國年 114/09/20'], ['ymd', '西元 2026-09-20'], ['mdy', '美式 09/20/2026'], ['dmy', '歐式 20/09/2026']]
            .map(([v, l]) => html`<option value="${v}" ${v === m.dateFormat ? 'selected' : ''}>${l}</option>`)}
        </select></label>
      </div>

      <div class="row">
        <label class="field"><span>金額欄位形式</span><select id="m-mode">
          <option value="inout" ${m.amountMode === 'inout' ? 'selected' : ''}>支出／存入 分兩欄（台灣銀行常見）</option>
          <option value="single" ${m.amountMode === 'single' ? 'selected' : ''}>單一欄含正負號（美國常見）</option>
          <option value="typed" ${m.amountMode === 'typed' ? 'selected' : ''}>單一欄不含正負號，方向看另一欄</option>
        </select></label>
        ${m.amountMode === 'inout'
          ? html`<label class="field"><span>支出／提出欄</span><select id="m-out">${colOpts(m.outCol)}</select></label>
                 <label class="field"><span>存入／轉入欄</span><select id="m-in">${colOpts(m.inCol)}</select></label>`
          : m.amountMode === 'typed'
            ? html`<label class="field"><span>金額欄</span><select id="m-amount">${colOpts(m.amountCol)}</select></label>
                   <label class="field"><span>收支別欄</span><select id="m-type">${colOpts(m.typeCol)}</select></label>`
            : html`<label class="field"><span>金額欄</span><select id="m-amount">${colOpts(m.amountCol)}</select></label>
                   <label class="field"><span><input type="checkbox" id="m-invert" ${m.invert ? 'checked' : ''}> 正負相反</span></label>`}
      </div>

      <div class="row">
        <label class="field"><span>摘要欄（可複選，會用 / 串起來）</span>
          <select id="m-desc" multiple size="${Math.min(5, Math.max(3, headers.length))}">
            ${headers.map((h, i) => html`<option value="${i}" ${(m.descCols || []).includes(i) ? 'selected' : ''}>${i + 1}. ${h || '(空欄)'}</option>`)}
          </select></label>
        <label class="field"><span>交易序號欄（有的話去重更準）</span><select id="m-extid">${colOpts(m.externalIdCol)}</select></label>
        <label class="field"><span>餘額欄（有的話逐行對帳）</span><select id="m-balance">${colOpts(m.balanceCol)}</select></label>
        <label class="field"><span>分類欄（信用卡常有）</span><select id="m-category">${colOpts(m.categoryCol)}</select></label>
        <label class="field"><span>狀態欄（Pending 的不匯入）</span><select id="m-status">${colOpts(m.statusCol)}</select></label>
      </div>
      <button class="sm" id="m-apply">套用對應，重新預覽</button>
    </section>

    <section class="card">
      <div class="step done"><span class="step-no">4</span><span class="step-label">預覽與確認</span></div>
      <div class="grid g4">
        <div class="card kpi"><div class="label">將匯入</div><div class="value pos">${p.summary.new}</div></div>
        <div class="card kpi"><div class="label">重複略過</div><div class="value dim">${p.summary.duplicate}</div></div>
        ${pendingKpi}
        <div class="card kpi"><div class="label">解析失敗</div><div class="value ${p.summary.error ? 'neg' : 'dim'}">${p.summary.error}</div></div>
        ${p.reconcile ? html`<div class="card kpi">
          <div class="label">匯入後餘額</div>
          <div class="value ${level(p.reconcile.after)}">${money(p.reconcile.after, cur)}</div>
          <div class="meta">${money(p.reconcile.before, cur)} ${signed(p.summary.net, cur)}</div>
        </div>` : html`<div class="card kpi"><div class="label">淨額</div>
          <div class="value ${cls(p.summary.net)}">${signed(p.summary.net, cur)}</div>
          <div class="meta">${p.summary.date_min || '—'} → ${p.summary.date_max || '—'}</div></div>`}
      </div>

      ${p.reconcile && p.reconcile.stated !== null ? (
        p.reconcile.matches
          ? html`<div class="note">
              ✓ 匯入後餘額 <b>${money(p.reconcile.after, cur)}</b> 與對帳單在 ${p.reconcile.stated_on}
              的餘額一致。這個檔案的每一筆都落地了。
            </div>`
          : html`<div class="note warn">
              匯入後餘額 <b>${money(p.reconcile.after, cur)}</b>，但對帳單在 ${p.reconcile.stated_on}
              寫的是 <b>${money(p.reconcile.stated, cur)}</b>，差 <b>${signed(p.reconcile.drift, cur)}</b>。
              常見原因：期初餘額填錯、這個帳戶還有這份對帳單以外的交易、或是檔案漏了幾行。
            </div>`
      ) : ''}

      ${p.summary.error ? html`<div class="note warn">有幾行解析不出來（紅底那幾行）。通常是檔案尾端的合計列、或是日期／金額欄選錯了。解析失敗的行不會被匯入。</div>` : ''}

      ${p.summary.repaired ? html`<div class="note warn">
        有 ${p.summary.repaired} 行的欄位數比標題列多，已自動修復（黃底那幾行）：銀行把描述欄裡的引號寫壞了，
        使得描述中的逗號被當成欄位分隔。多出來的片段已經接回摘要欄。<b>請點開確認金額對不對再匯入。</b>
      </div>` : ''}

      ${p.summary.sign_suspect ? html`<div class="note warn">
        這是負債帳戶（信用卡／貸款），但這個檔案<b>流入的筆數比流出還多</b>，正負號很可能是反的。
        對帳單上寫的是「你欠多少」，所以有些發卡機構把消費記成正數——那樣匯進來每筆消費都會變成收入。
        卡片檔沒有餘額欄可以逐行驗證，所以只能靠這個提醒。<b>看一下下面的金額，需要的話勾「正負相反」。</b>
        （Bank of America 的 CSV 不用勾，雖然它網頁上顯示的正負號剛好相反。）
      </div>` : ''}

      ${p.summary.balance_breaks ? html`<div class="note warn">
        有 ${p.summary.balance_breaks} 行對不上檔案自己的餘額欄（上一行餘額 ＋ 本行金額 ≠ 本行餘額）。
        通常代表這個檔案漏了幾行、或是兩段區間中間有缺口。這些行還是會匯入，但數字可能不完整。
      </div>` : ''}

      ${p.summary.pending ? html`<div class="note">
        有 ${p.summary.pending} 行的狀態欄寫著「未入帳」（Citi 寫 <code>Pending</code>），這次不匯入。
        未入帳的交易金額、日期、店家名稱三樣都還會變（小費、預授權、入帳日跟消費日不同天），
        而去重指紋正好就是這三樣組成的——現在匯進來，等它入帳後再下載一次，同一筆會變成兩筆。
        等它入帳之後再下載一次，就會自動補進來。
      </div>` : ''}

      <div class="table-wrap scroll">
        <table>
          <thead><tr><th class="col-check"></th><th>行</th><th>日期</th><th class="num">金額</th><th>摘要</th><th>狀態</th></tr></thead>
          <tbody>${p.rows.map((r) => html`
            <tr class="${r.status === 'duplicate' ? 'dup'
              : r.status === 'error' ? 'err'
              : r.status === 'pending' ? 'pend'
              : r.repaired || r.balanceBreak !== undefined ? 'fixed' : ''}">
              <td>${r.status === 'new'
                ? html`<input type="checkbox" class="skip" data-line="${r.lineNo}" ${imp.skip.has(r.lineNo) ? '' : 'checked'}>`
                : ''}</td>
              <td class="dim small">${r.lineNo}</td>
              <td class="nowrap">${r.date || html`<span class="neg">?</span>`}</td>
              <td class="num ${r.amount === null ? 'neg' : cls(r.amount)}">${r.amount === null ? "?" : signed(r.amount, cur)}</td>
              <td class="truncate" title="${r.description}">${r.description || html`<span class="dim">（無）</span>`}</td>
              <td class="small">${
                r.status === 'new' ? html`<span class="pill green">新</span>`
                : r.status === 'duplicate' ? html`<span class="pill">重複</span> <span class="dim">${r.dupReason || ''}</span>`
                : r.status === 'pending' ? html`<span class="pill amber">未入帳</span> <span class="dim">等它入帳再匯</span>`
                : html`<span class="pill rose">錯誤</span> <span class="dim">${(r.errors || []).join('；')}</span>`
              }${r.repaired ? html` <span class="pill amber">已修復欄位</span>` : ''
              }${r.balanceBreak !== undefined ? html` <span class="pill amber">餘額差 ${signed(r.balanceBreak, cur)}</span>` : ''}</td>
            </tr>`)}</tbody>
        </table>
      </div>
      ${p.truncated ? html`<div class="muted small spaced">預覽只顯示前 500 行，匯入時會處理整個檔案。</div>` : ''}

      <div class="row spaced">
        <label class="field"><span>這份檔案涵蓋的期間</span><select id="c-period">
          ${Object.entries(PERIOD_PRESETS).map(([k, label]) => html`
            <option value="${k}" ${k === period.kind ? 'selected' : ''}>${label}</option>`)}
        </select></label>
        <label class="field"><span>從</span>
          <input id="c-from" type="date" value="${period.from || ''}" ${period.kind === 'derived' ? 'disabled' : ''}></label>
        <label class="field"><span>到</span>
          <input id="c-to" type="date" value="${period.to || ''}" ${period.kind === 'derived' ? 'disabled' : ''}></label>
      </div>
      <div class="note small">${period.kind === 'derived'
        ? html`只會拿檔案裡最早到最晚那筆當作涵蓋範圍，所以只有<b>完整被蓋到的月份</b>算確認過。
            如果你在網銀是選「整個年度」或某一期帳單下載的，在這裡說出來，沒有交易的那些月份
            也會被認成已確認，而不是缺口。`
        : html`你說這份檔案涵蓋 ${period.from || '—'} 到 ${period.to || '—'}。
            有任何一行落在期間外就會擋下來 —— 那表示期間填錯了，或這不是你以為的那份檔案。`}
      </div>

      <div class="row spaced">
        <label class="field"><span>預設交易類型</span><select id="c-kind">
          ${['other', 'expense', 'income', 'trade', 'dividend', 'fee'].map((k) => html`<option value="${k}">${kindName(k)}</option>`)}
        </select></label>
        <label class="field"><span>把這組欄位對應記起來（下次一鍵套用）</span>
          <input id="c-savename" placeholder="例如：玉山銀行 活存"></label>
        <button class="primary shrink" id="c-commit" ${p.summary.new ? '' : 'disabled'}>匯入 ${p.summary.new} 筆</button>
      </div>
      <div class="muted small spaced">匯入前會自動把整個資料庫存一份快照到 <code>data/backups/</code>，對應選錯了可以整個換回去。</div>
    </section>
  `);

  $$('.skip').forEach((c) => (c.onchange = () => {
    const line = +c.dataset.line;
    c.checked ? imp.skip.delete(line) : imp.skip.add(line);
  }));

  $('#m-mode').onchange = () => { imp.mapping = readMapping(); renderPreview(); runPreview(); };
  $('#m-apply').onclick = () => { imp.mapping = readMapping(); runPreview(); };

  // The preset only fills the two dates; the dates are what gets sent. A
  // preset that sent its own name would need the server to know what "year to
  // date" means on the day the file was downloaded, which it cannot.
  $('#c-period').onchange = () => {
    const kind = $('#c-period').value;
    const span = { from: p.summary.span_from, to: p.summary.span_to };
    const year = (span.to || today()).slice(0, 4);
    imp.period =
      kind === 'derived' ? { kind, ...span }
      : kind === 'ytd' ? { kind, from: `${year}-01-01`, to: today() }
      : kind === 'year' ? { kind, from: `${year}-01-01`, to: `${year}-12-31` }
      : { kind, ...span };
    renderPreview();
  };
  const syncPeriod = () => {
    if (imp.period.kind === 'derived') return;
    imp.period = { ...imp.period, from: $('#c-from').value, to: $('#c-to').value };
  };
  $('#c-from').onchange = syncPeriod;
  $('#c-to').onchange = syncPeriod;

  $('#c-commit').onclick = async () => {
    try {
      const r = await post('/api/import/commit', {
        account_id: imp.accountId,
        content_base64: imp.base64,
        filename: imp.file?.name || 'upload.csv',
        mapping: imp.mapping,
        skip_lines: [...imp.skip],
        default_kind: $('#c-kind').value,
        save_mapping_as: $('#c-savename').value.trim() || undefined,
        // Only when the user actually answered. Sending the derived span as
        // if it were declared would dress an inference up as a statement,
        // and the server would then trust its edges.
        period_from: imp.period.kind === 'derived' ? undefined : imp.period.from,
        period_to: imp.period.kind === 'derived' ? undefined : imp.period.to,
      });
      toast(`已匯入 ${r.imported} 筆${r.transfer_candidates ? `，另有 ${r.transfer_candidates} 組疑似轉帳待配對` : ''}`, 'ok');
      imp.file = null; imp.base64 = null; imp.preview = null; imp.skip = new Set(); imp.period = null;
      render();
    } catch (e) { toast(e.message, 'err'); }
  };
}

function readMapping() {
  const val = (id) => { const el = $(id); return el && el.value !== '' ? Number(el.value) : null; };
  const mode = $('#m-mode').value;
  return {
    ...imp.mapping,
    headerRow: Math.max(1, Number($('#m-header').value || 1)),
    dateCol: val('#m-date'),
    dateFormat: $('#m-datefmt').value,
    amountMode: mode,
    amountCol: mode === 'single' || mode === 'typed' ? val('#m-amount') : imp.mapping.amountCol,
    outCol: mode === 'inout' ? val('#m-out') : imp.mapping.outCol,
    inCol: mode === 'inout' ? val('#m-in') : imp.mapping.inCol,
    typeCol: mode === 'typed' ? val('#m-type') : imp.mapping.typeCol,
    descCols: $('#m-desc') ? [...$('#m-desc').selectedOptions].map((o) => Number(o.value)) : [],
    externalIdCol: val('#m-extid'),
    balanceCol: val('#m-balance'),
    categoryCol: val('#m-category'),
    statusCol: val('#m-status'),
    invert: $('#m-invert') ? $('#m-invert').checked : false,
  };
}
