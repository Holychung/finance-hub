'use strict';

// /import — drop a statement; it goes in unless something needs you.
//
// Every check still runs on every file, and shared/import.js decides which of
// their results need a person: a clean file is written straight away and the
// page says what happened, with 回復 beside it. That is safe because an import
// is one batch, a snapshot is taken first, and the commit itself refuses a
// file with an unanswered issue — the page skipping the question cannot skip
// the gate. What reaches the page is only what a check could not settle, each
// with the ways out it has.
//
// The only flow whose state outlives a render: `imp` holds the file, the
// mapping, the answers and the last result across the round trips.
// renderPreview() and renderResult() mount into #imp-result rather than
// re-running the view, which is why runPreview() does its own
// captureUi/restoreUi — render() never sees that path.

const imp = {
  file: null, base64: null, accountId: null, preview: null, mapping: null,
  // Rows the person chose to leave out, by line number.
  skip: new Set(),
  // Issues answered "import anyway", by their key — code, rows and figure —
  // so an answer lapses when a fresh reading says something different.
  accepted: new Set(),
  // The full column-mapping form: opened by hand, or by an unreadable file.
  mappingOpen: false,
  // A name to remember the mapping under, typed into that form.
  saveAs: '',
  // Set once the person has been shown issues for this file, or a commit was
  // refused: from then on a clean reading waits for 匯入 instead of writing
  // itself. Pressing 正負反過來 is asking to see the result, not to commit it,
  // and a page and a server that disagree cannot loop.
  hold: false,
  // Which reading is current. A preview still in flight when the account or
  // the mapping changes must not land on top of the newer one.
  seq: 0,
  committing: false,
  // The last commit's answer, shown until the next file, and the period form
  // while somebody is changing what that import is credited with.
  result: null, periodDraft: null,
  // Saved mappings, for the form's one-click buttons.
  saved: [],
};

// 銀行的下載頁會讓你選「Statement of 2026-08」「Year to date」「自訂區間」。
// 那個選擇就是這份檔案涵蓋的期間，而 CSV 本身不會寫。使用者記得自己按了什麼，
// 所以問他 —— 這是唯一誠實的來源，其餘都只能從資料列反推，而反推看不出「這個月
// 前半段有涵蓋、只是沒有消費」。
//
// 預設是「照檔案內容推算」，因為那是不必回答就正確的答案（只是保守），所以它在
// 匯入之後才問，放在結果上，要改再改。
const PERIOD_PRESETS = {
  derived: '照檔案內容推算（保守）',
  statement: '一期帳單／自訂區間',
  ytd: '年初至今',
  year: '整個年度',
};

// The date formats a mapping can name, as the form offers them.
const DATE_FORMATS = [
  ['auto', '自動'], ['roc', '民國年 114/09/20'], ['ymd', '西元 2026-09-20'],
  ['mdy', '美式 09/20/2026'], ['dmy', '歐式 20/09/2026'],
];

views.import = async () => {
  const [accounts, mappings, imports] = await Promise.all([
    api('/api/accounts'), api('/api/mappings'), api('/api/imports'),
  ]);
  imp.saved = mappings;

  mount(main, html`
    <div class="page-head">
      <div><h1>匯入對帳單</h1><div class="sub">從網銀／券商下載 CSV 丟進來。沒問題就直接匯入，有問題才會問你</div></div>
    </div>

    <section class="card">
      <div class="dropzone" id="dropzone">
        ${imp.file
          ? html`<b>${imp.file.name}</b><div class="small dim">${nf(imp.file.size / 1024, 1)} KB · 點此換一個檔案</div>`
          : html`把檔案拖進來，或點一下選檔<div class="small">自動判讀 UTF-8 與 Big5，民國年也認得</div>`}
      </div>
      <input type="file" id="file-input" accept=".csv,.txt,text/csv" hidden>
      <div class="row spaced">
        <label class="field"><span>匯入到哪個帳戶</span><select id="imp-account" class="constrained">
          <option value="">丟檔案之後再選</option>
          ${accounts.map((a) => html`<option value="${a.id}" ${a.id === imp.accountId ? 'selected' : ''}>${a.name}（${a.currency}）</option>`)}
        </select></label>
      </div>
      ${accounts.length ? '' : html`<div class="note spaced">
        還沒有帳戶也沒關係。直接丟檔案進來，系統會從檔案內容把帳戶資料填好讓你確認——
        有餘額欄的對帳單連<b>期初餘額都算得出來</b>，不用去網銀查。
      </div>`}
      ${storage.name === 'demo' ? html`<div class="toolbar">
        <button class="sm" id="demo-statement">載入一份範例對帳單</button>
        <span class="muted small">玉山格式：民國年、支出／存入兩欄、有餘額欄可以逐行對帳。沒選帳戶的話，會問你匯進哪個現有帳戶，或照檔案建一個新的</span>
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
    forgetAnswers();
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

  $$('[data-revert]').forEach((b) => (b.onclick = () => revertImport(Number(b.dataset.revert))));

  if (imp.result) renderResult();
  else if (imp.preview) renderPreview();
};

// Everything about the file goes; the account choice goes too once a file has
// been written, so the next statement is matched afresh rather than landing
// silently where the last one did.
function clearImportFile() {
  imp.file = null; imp.base64 = null;
  imp.preview = null; imp.mapping = null;
  forgetAnswers();
  imp.mappingOpen = false; imp.saveAs = ''; imp.hold = false;
}

// What the person answered and which rows they left out were about this file
// against one account. Against another account they are a different
// question, and carried over they would decide it without anybody asking.
function forgetAnswers() {
  imp.accepted = new Set();
  imp.skip = new Set();
}

function loadFile(file) {
  clearImportFile();
  imp.file = file;
  imp.result = null; imp.periodDraft = null;
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
  // block can hold the mapping form — change 標題列, press 套用, and the field
  // you were in is a new node.
  const snap = captureUi();
  const seq = ++imp.seq;
  try {
    const p = await post('/api/import/preview', {
      account_id: imp.accountId || undefined,
      content_base64: imp.base64,
      filename: imp.file?.name,
      mapping: imp.mapping || undefined,
      skip_lines: [...imp.skip],
    });
    // A newer reading was asked for while this one was out; it decides.
    if (seq !== imp.seq || !imp.base64) return;
    imp.preview = p;
    imp.mapping = p.mapping;
    // No account yet: the file has just told us most of what one needs, so
    // offer the accounts there are and the one it describes, here.
    if (!imp.accountId && imp.preview.suggested_account) {
      renderPreview();
      await accountFromCsvForm(imp.preview.suggested_account);
      return;
    }
    if (imp.preview.issues.some((i) => i.code === 'unreadable')) imp.mappingOpen = true;
    // Nothing to ask and something to write: write it.
    if (!imp.hold && !imp.preview.issues.length && imp.preview.summary.new) {
      await commitImport();
      return;
    }
    renderPreview();
    restoreUi(snap);
  } catch (e) {
    // If the view already blew up, #imp-result is gone and mounting into it
    // throws again — reporting the missing element instead of what actually
    // failed. A toast always has somewhere to go.
    const slot = $('#imp-result');
    if (slot) mount(slot, html`<section class="card"><div class="note err">${e.message}</div></section>`);
    else toast(e.message, 'err');
  }
}

async function commitImport() {
  const p = imp.preview;
  // One commit per reading: a second click while the first is out would only
  // come back refused, with nothing new left to write.
  if (!p || imp.committing) return;
  imp.committing = true;
  try {
    const r = await post('/api/import/commit', {
      account_id: imp.accountId,
      content_base64: imp.base64,
      filename: imp.file?.name || 'upload.csv',
      mapping: imp.mapping,
      skip_lines: [...imp.skip],
      accept: p.issues.filter((i) => imp.accepted.has(i.key)).map((i) => i.key),
      save_mapping_as: imp.saveAs.trim() || undefined,
    });
    imp.result = r;
    imp.periodDraft = null;
    clearImportFile();
    imp.accountId = null;
    await render();
  } catch (e) {
    // Usually the reading went stale between the preview and the commit —
    // another import landed in between — so read the file again and show what
    // is open now, rather than trying again by itself.
    toast(e.message, 'err');
    imp.hold = true;
    await runPreview();
  } finally {
    imp.committing = false;
  }
}

async function revertImport(id) {
  if (!confirm('回復這次匯入？這一批新增的交易會全部刪除。')) return;
  try {
    const r = await del(`/api/imports/${id}`);
    toast(`已回復 ${r.reverted} 筆`, 'ok');
    if (imp.result && imp.result.import_id === id) imp.result = null;
    render();
  } catch (e) { toast(e.message, 'err'); }
}

// Everything is pre-filled and everything is editable; nothing is written
// until 建立 is pressed.
//
// Arriving here only means no account was chosen before the file was dropped.
// Once the book has accounts, that usually means the statement belongs to one
// of them, so they are offered first: with nothing but this form, the order of
// the page was a rule you had to know, and the one way on was a duplicate.
async function accountFromCsvForm(s) {
  const accounts = await api('/api/accounts');
  // The one the file's own name points at leads, then the file's currency.
  const existing = [...accounts].sort((x, y) =>
    (y.name === s.name) - (x.name === s.name) || (y.currency === s.currency) - (x.currency === s.currency));
  // A retirement plan's history gets examples of its own: a bank called
  // Chase and an account called "Chase ...0000" are the wrong hints there.
  // So does a Taiwanese statement, and its country follows its currency by
  // the rule suggestAccount already applies when it finds an institution.
  const plan = TAX_ADVANTAGED_KINDS.has(s.kind);
  const tw = s.currency === 'TWD';
  const hint = plan ? { inst: 'Fidelity', name: '401(k)' }
    : tw ? { inst: '玉山銀行', name: '玉山 活存' }
    : { inst: 'Chase', name: 'Chase ...0000' };
  const inst = s.institution || { name: '', kind: plan ? 'broker' : 'bank', country: tw ? 'TW' : 'US' };
  modal(existing.length ? '這份檔案要匯到哪個帳戶' : '從這個檔案建立帳戶', html`
    <div class="note small">
      下面是從 <code>${imp.file?.name || 'CSV'}</code> 讀出來的。有錯就直接改，按「建立」才會寫入。
      ${s.covers ? html`<br>檔案涵蓋 ${s.covers.from} → ${s.covers.to}，共 ${s.covers.rows} 筆。` : ''}
    </div>
    ${existing.length ? html`
      <div class="row">
        <label class="field"><span>匯入到現有帳戶</span><select id="a-existing">
          ${existing.map((a) => html`<option value="${a.id}">${a.name}（${a.currency}）</option>`)}
        </select></label>
        <div class="shrink"><button id="a-use">匯入到這個帳戶</button></div>
      </div>
      <h2 class="sec spaced">或照檔案內容建立新帳戶</h2>` : ''}
    ${s.notes.map((n) => html`<div class="note warn small">${n}</div>`)}

    <div class="row">
      <label class="field"><span>機構</span><input id="a-inst" value="${inst.name}" placeholder="${hint.inst}"></label>
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
      <label class="field"><span>帳戶名稱</span><input id="a-name" value="${s.name}" placeholder="${hint.name}"></label>
      <label class="field"><span>類型</span><select id="a-kind">
        ${KIND_ORDER.map((k) => html`<option value="${k}" ${k === s.kind ? 'selected' : ''}>${kindName(k)}</option>`)}
      </select></label>
      <label class="field"><span>幣別</span><select id="a-cur">
        ${CURRENCY_CODES.map((c) => html`<option ${c === s.currency ? 'selected' : ''}>${c}</option>`)}
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
    // Both ways out end the same, together: the preview held here was taken
    // without an account, so its dedup is meaningless now, and the mapping
    // will be guessed again against the real one.
    const continueInto = async (id) => {
      closeModal();
      imp.accountId = id;
      imp.preview = null;
      imp.mapping = null;
      forgetAnswers();
      await render();
      await runPreview();
    };
    const use = $('#a-use', body);
    if (use) {
      use.onclick = () => continueInto(Number($('#a-existing', body).value))
        .catch((e) => toast(e.message, 'err'));
    }

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
        toast(`已建立「${name}」`, 'ok');
        await continueInto(acct.id);
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// What a reading of the file needs from the person, when it needs anything:
// an account, answers to the issues, or the news that nothing in it is new.
function renderPreview() {
  const p = imp.preview;
  const slot = $('#imp-result');
  // The mapping is read out of `imp`, not out of the preview, so the two have
  // to be cleared together. views.import ends by calling this whenever a
  // preview is held, and a null mapping here throws *inside* the view — which
  // replaces the whole page with the error screen, taking #imp-result with it,
  // so the next mount fails on a missing element and reports that instead of
  // this. Never let a half-cleared state reach the template.
  if (!p || !imp.mapping || !slot) return;
  const m = imp.mapping;

  // Closed the account question without answering it.
  if (!p.account) {
    mount(slot, html`<section class="card"><div class="note">
      這份檔案還沒有帳戶：在上面選一個，或
      <button class="sm" id="imp-ask">從檔案內容挑帳戶</button>
    </div></section>`);
    $('#imp-ask').onclick = () => accountFromCsvForm(p.suggested_account);
    return;
  }

  // Every amount here is in the account's currency, not the base one.
  const cur = p.account.currency;
  const s = p.summary;

  if (!p.issues.length && !s.new) {
    mount(slot, html`<section class="card">
      <h2 class="sec">沒有新的交易</h2>
      <div class="note">${s.duplicate
        ? html`「${p.account.name}」已經有這份檔案裡的全部 ${s.duplicate} 筆交易，這次什麼都沒寫入。`
        : html`這份檔案裡沒有可以匯入的交易，這次什麼都沒寫入。`}</div>
      ${importLeftOut(s)}
      <div class="toolbar"><button class="sm" id="imp-done">好</button></div>
    </section>`);
    $('#imp-done').onclick = () => { clearImportFile(); imp.accountId = null; render(); };
    return;
  }

  const byLine = new Map(p.rows.map((r) => [r.lineNo, r]));
  const open = p.issues.filter((i) => !(i.acceptable && imp.accepted.has(i.key)));
  const ready = !open.length && s.new > 0;
  // Shown issues once: whatever the next reading says, it waits for 匯入.
  if (p.issues.length) imp.hold = true;

  mount(slot, html`
    <section class="card">
      <h2 class="sec">${p.issues.length
        ? html`這份檔案有 ${p.issues.length} 件事要你決定，還沒有寫入任何東西`
        : html`確認後匯入`}</h2>
      ${p.issues.map((i) => issueBlock(i, p, byLine, cur))}
      ${s.skipped ? html`<div class="note small">你略過了 ${s.skipped} 行，它們不會匯入。
        <button class="sm" id="imp-unskip">全部恢復</button></div>` : ''}
      ${imp.mappingOpen ? mappingForm(p, m) : ''}
      <div class="toolbar spaced">
        <button class="primary" id="imp-commit" ${ready ? '' : 'disabled'}>匯入 ${s.new} 筆到「${p.account.name}」</button>
        <button class="sm" id="imp-abandon">放棄這個檔案</button>
        ${imp.mappingOpen ? '' : html`<button class="sm" id="m-toggle" aria-expanded="false">調整欄位對應</button>`}
      </div>
    </section>
  `);

  $('#imp-commit').onclick = () => commitImport();
  // The account goes with the file, as it does after a commit: the usual
  // reason to give up is that it was the wrong one.
  $('#imp-abandon').onclick = () => {
    clearImportFile();
    imp.accountId = null;
    toast('已放棄這個檔案，什麼都沒寫入');
    render();
  };
  if ($('#imp-unskip')) $('#imp-unskip').onclick = () => { imp.skip = new Set(); runPreview(); };

  // Answering moves nothing on the server, so the panel redraws in place.
  // The rest change what the file says, and read it again.
  $$('[data-accept]').forEach((b) => (b.onclick = () => { imp.accepted.add(b.dataset.accept); redrawPreview(); }));
  $$('[data-unaccept]').forEach((b) => (b.onclick = () => { imp.accepted.delete(b.dataset.unaccept); redrawPreview(); }));
  $$('[data-skip]').forEach((b) => (b.onclick = () => {
    for (const n of b.dataset.skip.split(',')) imp.skip.add(Number(n));
    runPreview();
  }));
  $$('[data-flip]').forEach((b) => (b.onclick = () => {
    imp.mapping = { ...imp.mapping, invert: !imp.mapping.invert };
    runPreview();
  }));
  // Read without an account, which is what asks for one. Rendered first, so
  // the account select stops showing the account just let go of.
  $$('[data-reaccount]').forEach((b) => (b.onclick = () => {
    imp.accountId = null;
    imp.preview = null;
    forgetAnswers();
    render().then(runPreview);
  }));
  $$('[data-open-mapping]').forEach((b) => (b.onclick = () => { imp.mappingOpen = true; redrawPreview(); }));

  // One id in both states, so restoreUi() puts the focus back on the button
  // that was just pressed when the section redraws around it.
  if ($('#m-toggle')) $('#m-toggle').onclick = () => { imp.mappingOpen = !imp.mappingOpen; redrawPreview(); };
  if (imp.mappingOpen) wireMappingForm();
}

function redrawPreview() {
  const snap = captureUi();
  renderPreview();
  restoreUi(snap);
}

// The rows that would not import for a reason of their own, one line each.
// Plain text: every number in it is a count, and the reasons are this file's.
function importLeftOut(s) {
  const lines = [
    s.duplicate ? `${s.duplicate} 筆已經在帳上，沒有重複匯入` : '',
    s.pending ? `${s.pending} 筆銀行還沒入帳（Pending）：金額、日期、店名都還會變，等入帳後再下載一次就會補進來` : '',
    s.internal ? `${s.internal} 筆是基金之間的轉換或已實現損益，錢沒有進出，不匯入` : '',
    s.summary_line ? `${s.summary_line} 行是對帳單自己寫的合計或期初餘額，不是交易` : '',
    s.skipped ? `${s.skipped} 行你選了不匯入` : '',
    s.error ? `${s.error} 行讀不出來，沒有匯入` : '',
  ].filter(Boolean);
  return lines.length ? html`<ul class="import-facts">${lines.map((l) => html`<li>${l}</li>`)}</ul>` : '';
}

// One issue: what it is, the rows it is about, and its ways out.
function issueBlock(i, p, byLine, cur) {
  const key = i.key;
  const r = p.reconcile;
  const title = html`<b>${IMPORT_ISSUE_TITLES[i.code]}</b>`;
  if (i.acceptable && imp.accepted.has(key)) {
    return html`<div class="note small">${title} — 已確認，照樣匯入。
      <button class="sm" data-unaccept="${key}">改回</button></div>`;
  }
  const accept = (label) => html`<button class="sm" data-accept="${key}">${label}</button>`;
  const lines = (i.lines || []).join(',');
  const body = {
    unreadable: [
      html`${hasDateCol(p.mapping) ? '' : '找不到日期欄。'}照現在的欄位對應，${p.summary.total} 行裡有 ${p.summary.error} 行讀不出來，多半是日期欄或金額欄選錯了。
        在下面改好欄位對應，按「套用對應，重新讀一次」；或放棄這個檔案。`,
    ],
    refused: [
      html`這幾行讀不出日期或金額，不會匯入。通常是檔案本身這幾行壞了，也可能是欄位對應選錯。`,
      html`<div class="toolbar">${accept('這幾行不要，其他照樣匯入')}
        <button class="sm" data-open-mapping>調整欄位對應</button></div>`,
    ],
    repaired: [
      html`銀行把摘要欄裡的引號寫壞了，這幾行的欄位多出來，已經把多的接回摘要欄。
        檔案沒有餘額能逐行驗證修得對不對，<b>看一下金額</b>。`,
      html`<div class="toolbar">${accept('金額沒錯，照樣匯入')}
        <button class="sm" data-skip="${lines}">這幾行不要匯入</button></div>`,
    ],
    repair_contradicted: [
      html`銀行把摘要欄裡的引號寫壞了，這幾行的欄位多出來，已經把多的接回摘要欄——但檔案自己的餘額欄
        <b>證明修出來的金額不對</b>（說明欄寫著差多少）。建議這幾行不要匯入，到網銀確認之後手動記。`,
      html`<div class="toolbar"><button class="sm" data-skip="${lines}">這幾行不要匯入</button>
        ${accept('照樣匯入')}</div>`,
    ],
    balance_breaks: [
      html`這幾行「上一行餘額＋本行金額」不等於本行餘額。通常是檔案漏了幾行，或中間有一段缺口。
        匯入的話這些行照樣進來，但帳上可能少了檔案沒給的那幾筆。`,
      html`<div class="toolbar">${accept('照樣匯入')}</div>`,
    ],
    balance_mismatch: r ? [
      html`匯入之後，「${p.account.name}」在 ${r.stated_on} 的帳面是 <b>${money(r.ledger, cur)}</b>，
        對帳單寫的是 <b>${money(r.stated, cur)}</b>，差 <b>${signed(r.drift, cur)}</b>。
        常見原因：選錯帳戶、期初餘額填錯、或檔案漏了幾行。`,
      html`<div class="toolbar"><button class="sm" data-reaccount>換一個帳戶</button>${accept('照樣匯入')}</div>`,
    ] : [],
    sign_suspect: [
      html`這是信用卡／貸款帳戶，但這個檔案<b>流入比流出還多</b>，正負號很可能是反的——反了的話每筆消費都會變成收入。
        卡片檔沒有餘額欄可以驗證，只能靠這個提醒。（Bank of America 的 CSV 不用反，雖然它網頁上的正負號剛好相反。）`,
      html`<div class="toolbar"><button class="sm" data-flip>正負反過來</button>${accept('沒反，照樣匯入')}</div>`,
    ],
  }[i.code] || [];
  return html`<div class="note ${i.acceptable ? 'warn' : 'err'}">
    ${title}<div>${body[0] || ''}</div>
    ${i.lines && i.lines.length ? issueRows(i.lines, byLine, cur) : ''}
    ${body.slice(1)}
  </div>`;
}

const hasDateCol = (m) => m.dateCol !== null && m.dateCol !== undefined;

// The rows an issue is about, as the file has them.
function issueRows(lines, byLine, cur) {
  const shown = lines.map((n) => byLine.get(n)).filter(Boolean);
  const why = (r) => [
    ...(r.errors || []),
    r.repaired ? '多出來的欄位已接回摘要' : '',
    r.balanceBreak !== undefined ? `餘額差 ${signed(r.balanceBreak, cur)}` : '',
  ].filter(Boolean).join('；');
  return html`<div class="table-wrap scroll"><table>
      <thead><tr><th>行</th><th>日期</th><th class="num">金額</th><th>摘要</th><th>說明</th></tr></thead>
      <tbody>${shown.map((r) => html`<tr class="${r.status === 'error' ? 'err' : 'fixed'}">
        <td class="dim small">${r.lineNo}</td>
        <td class="nowrap">${r.date || html`<span class="neg">?</span>`}</td>
        <td class="num ${r.amount === null ? 'neg' : cls(r.amount)}">${r.amount === null ? '?' : signed(r.amount, cur)}</td>
        <td class="truncate" title="${r.description}">${r.description || html`<span class="dim">（無）</span>`}</td>
        <td class="small">${why(r)}</td>
      </tr>`)}</tbody>
    </table></div>
    ${lines.length > shown.length ? html`<div class="muted small">另外 ${lines.length - shown.length} 行在預覽的前 500 行之外。</div>` : ''}`;
}

function mappingForm(p, m) {
  const headers = p.headers;
  const colOpts = (sel) => html`
    <option value="">—</option>
    ${headers.map((h, i) => html`<option value="${i}" ${i === sel ? 'selected' : ''}>${i + 1}. ${h || '(空欄)'}</option>`)}`;
  return html`
    <h2 class="sec">欄位對應</h2>
    ${imp.saved.length ? html`<div class="toolbar">
      <span class="muted small">套用記住的對應：</span>
      ${imp.saved.map((s) => html`<button class="sm" data-mapping="${s.id}">${s.name}</button>`)}
    </div>` : ''}
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
        ${DATE_FORMATS.map(([v, l]) => html`<option value="${v}" ${v === m.dateFormat ? 'selected' : ''}>${l}</option>`)}
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
      <label class="field"><span>交易類型欄（退休計畫的轉換和損益不匯入）</span><select id="m-activity">${colOpts(m.activityCol)}</select></label>
    </div>
    <div class="row">
      <label class="field"><span>把這組欄位對應記起來（匯入時存，下次一鍵套用）</span>
        <input id="m-savename" value="${imp.saveAs}" placeholder="例如：玉山銀行 活存"></label>
    </div>
    <div class="toolbar">
      <button class="sm" id="m-apply">套用對應，重新讀一次</button>
      <button class="sm" id="m-toggle" aria-expanded="true">收起</button>
    </div>`;
}

function wireMappingForm() {
  $('#m-mode').onchange = () => { imp.mapping = readMapping(); redrawPreview(); runPreview(); };
  $('#m-apply').onclick = () => { imp.mapping = readMapping(); runPreview(); };
  $('#m-savename').oninput = (e) => { imp.saveAs = e.target.value; };
  $$('[data-mapping]').forEach((b) => (b.onclick = () => {
    const s = imp.saved.find((x) => x.id === +b.dataset.mapping);
    imp.mapping = { ...s.config };
    toast(`已套用「${s.name}」`, 'ok');
    runPreview();
  }));
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
    activityCol: val('#m-activity'),
    invert: $('#m-invert') ? $('#m-invert').checked : false,
  };
}

// What the last import did, from the commit's own answer: what went in, what
// stayed out and why, whether the account now agrees with the statement, and
// the period it is credited with — the one question that used to stand in
// front of every import, asked here instead, where the answer is optional.
function renderResult() {
  const r = imp.result;
  const slot = $('#imp-result');
  if (!r || !slot) return;
  const cur = r.account.currency;
  const rec = r.reconcile;
  const pd = r.period;
  const span = { from: r.summary.span_from, to: r.summary.span_to };

  mount(slot, html`
    <section class="card">
      <h2 class="sec">已匯入 ${r.imported} 筆到「${r.account.name}」</h2>
      ${rec && rec.stated !== null
        ? (rec.matches
          ? html`<div class="note ok">帳戶餘額 <b>${money(rec.after, cur)}</b>。跟對帳單 ${rec.stated_on} 的餘額
              <b>${money(rec.stated, cur)}</b> 一致，這份檔案的每一筆都在帳上了。</div>`
          : html`<div class="note warn">帳戶餘額 <b>${money(rec.after, cur)}</b>。帳本在 ${rec.stated_on} 是
              ${money(rec.ledger, cur)}，跟對帳單的 ${money(rec.stated, cur)} 差 <b>${signed(rec.drift, cur)}</b>
              （你選了照樣匯入）。</div>`)
        : html`<div class="note">帳戶餘額 <b>${money(rec ? rec.after : 0, cur)}</b>。這份檔案沒有餘額欄，對不了帳：
            跟網銀上的數字比一下——信用卡檔的正負號反了的時候，這裡是唯一看得出來的地方。</div>`}
      ${importLeftOut(r.summary)}
      ${imp.periodDraft ? periodForm(imp.periodDraft, span) : html`<div class="toolbar">
        <span class="muted small">涵蓋期間 ${pd.from || '—'} → ${pd.to || '—'}
          （${pd.kind === 'declared' ? '你說的' : '照檔案內容推算'}）</span>
        <button class="sm" id="res-period">改</button>
      </div>`}
      ${r.transfer_candidates ? html`<div class="muted small">另有 ${r.transfer_candidates} 組疑似轉帳待配對，
        到<a href="/transactions">交易</a>確認。</div>` : ''}
      ${r.backup ? html`<div class="muted small">匯入前的快照：<code>${r.backup}</code></div>` : ''}
      <div class="toolbar spaced">
        <a class="btn sm" href="/account/${r.account.id}">看這個帳戶</a>
        <button class="sm danger" id="res-revert">回復這次匯入</button>
      </div>
    </section>
  `);

  $('#res-revert').onclick = () => revertImport(r.import_id);
  if ($('#res-period')) {
    $('#res-period').onclick = () => {
      imp.periodDraft = { kind: pd.kind === 'derived' ? 'derived' : 'statement', from: pd.from, to: pd.to };
      renderResult();
    };
  }
  if (imp.periodDraft) wirePeriodForm(span);
}

// `draft` is what the form shows — a preset and its two dates. Nothing is
// written until 儲存期間, so cancelling is just dropping it.
function periodForm(draft, span) {
  const kind = draft.kind;
  return html`
    <div class="row">
      <label class="field"><span>這份檔案涵蓋的期間</span><select id="c-period">
        ${Object.entries(PERIOD_PRESETS).map(([k, label]) => html`
          <option value="${k}" ${k === kind ? 'selected' : ''}>${label}</option>`)}
      </select></label>
      <label class="field"><span>從</span>
        <input id="c-from" type="date" value="${draft.from || ''}" ${kind === 'derived' ? 'disabled' : ''}></label>
      <label class="field"><span>到</span>
        <input id="c-to" type="date" value="${draft.to || ''}" ${kind === 'derived' ? 'disabled' : ''}></label>
    </div>
    <div class="note small">${kind === 'derived'
      ? html`只會拿檔案裡最早到最晚那筆（${span.from || '—'} → ${span.to || '—'}）當作涵蓋範圍，所以只有<b>完整被蓋到的月份</b>算確認過。
          如果你在網銀是選「整個年度」或某一期帳單下載的，在這裡說出來，沒有交易的那些月份
          也會被認成已確認，而不是缺口。`
      : html`期間要包住檔案的每一行（${span.from || '—'} → ${span.to || '—'}），不然會被擋下來 ——
          那表示期間填錯了，或這不是你以為的那份檔案。`}
    </div>
    <div class="toolbar">
      <button class="sm primary" id="c-save">儲存期間</button>
      <button class="sm" id="c-cancel">取消</button>
    </div>`;
}

// The preset only fills the two dates; the dates are what gets sent. A preset
// that sent its own name would need the server to know what "year to date"
// meant on the day the file was downloaded, which it cannot.
function wirePeriodForm(span) {
  const r = imp.result;
  $('#c-period').onchange = () => {
    const kind = $('#c-period').value;
    const year = (span.to || today()).slice(0, 4);
    imp.periodDraft = kind === 'ytd' ? { kind, from: `${year}-01-01`, to: today() }
      : kind === 'year' ? { kind, from: `${year}-01-01`, to: `${year}-12-31` }
      : { kind, ...span };
    renderResult();
  };
  const sync = () => { imp.periodDraft = { ...imp.periodDraft, from: $('#c-from').value, to: $('#c-to').value }; };
  $('#c-from').onchange = sync;
  $('#c-to').onchange = sync;
  $('#c-cancel').onclick = () => { imp.periodDraft = null; renderResult(); };
  $('#c-save').onclick = async () => {
    const d = imp.periodDraft;
    try {
      const out = await put(`/api/imports/${r.import_id}`,
        d.kind === 'derived' ? {} : { period_from: d.from, period_to: d.to });
      r.period = out.period;
      imp.periodDraft = null;
      toast('涵蓋期間已更新', 'ok');
      renderResult();
    } catch (e) { toast(e.message, 'err'); }
  };
}
