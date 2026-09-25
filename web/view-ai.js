'use strict';

// /ai — AI 健檢. The overview document, handed to the model the user chose,
// for an audit of the ledger or for observations about it.
//
// Off until the box is ticked, and even then nothing leaves until 送出 is
// pressed. The page shows the instruction and the document first, and those
// are exactly what server/ai.js sends. The key is pasted here and stored beside
// the book, never in it, and the page is only ever told whether one is set.

// Page state, like spendingYears: which question to ask, and the last answer,
// which has to survive the re-render that every setting change triggers.
let aiMode = 'audit';
let aiAnswer = null;
let aiBusy = false;

const AI_MODES = [
  { key: 'audit', label: '審計', about: '找帳本裡會讓數字出錯的地方：正負號、對不上的對帳、漏匯的月份、沒配對的轉帳、沒分類的支出。' },
  { key: 'advice', label: '建議', about: '根據這些數字給一般性的觀察：備用金撐幾個月、欠款、持股集中度、固定扣款。不是投資、稅務或法律建議。' },
];

views.ai = async () => {
  const s = await api('/api/ai');
  if (!s.available) {
    mount(main, html`
      <div class="page-head"><div><h1>AI 健檢</h1><div class="sub">請 AI 審計帳本，或根據帳本給建議</div></div></div>
      <section class="card">
        <div class="note warn">${s.reason}</div>
        <div class="muted small">會送出去的是資產全覽：總覽頁的「匯出全覽」可以先下載來看，內容一模一樣。</div>
      </section>`);
    return;
  }

  const preview = await api(`/api/ai/preview?mode=${aiMode}`);
  const provider = s.providers.find((p) => p.key === s.provider);
  const mode = AI_MODES.find((m) => m.key === aiMode);
  const ready = s.enabled && s.key.set;
  const blocker = !s.enabled ? '先打開上面的開關。' : !s.key.set ? `先設定 ${provider.label} 的 API key。` : '';

  mount(main, html`
    <div class="page-head"><div><h1>AI 健檢</h1><div class="sub">請 AI 審計帳本，或根據帳本給建議</div></div></div>

    <section class="card">
      <h2 class="sec">連線設定</h2>
      <div class="note warn">
        這是這個 app 第二個會對外連線的功能（第一個是自動抓收盤價），<b>預設關閉</b>。打開之後，也只有你按下
        「送出」的那一次，後端才會把下面預覽的內容——帳戶名稱、餘額、持股、近一年的消費分類——送到
        <b>${provider.label}</b>（<code>${provider.host}</code>）。瀏覽器這一頁本身仍然不對外連線。
        ${provider.privacy || ''}
      </div>
      <label class="check">
        <input type="checkbox" id="ai-enabled" ${s.enabled ? 'checked' : ''}>
        <span>開啟 AI 健檢（需連網）</span>
      </label>

      <div class="row spaced">
        <label class="field"><span>AI 供應商</span><select id="ai-provider">
          ${s.providers.map((p) => html`<option value="${p.key}" ${p.key === s.provider ? 'selected' : ''}>${p.label}</option>`)}
        </select></label>
        <label class="field"><span>模型</span><input id="ai-model" list="ai-models" value="${s.model}"
          autocomplete="off" spellcheck="false"></label>
        <div class="shrink"><button id="ai-model-save">儲存模型</button></div>
      </div>
      <datalist id="ai-models">${provider.models.map((m) => html`<option value="${m.id}">${m.note}</option>`)}</datalist>
      <div class="muted small spaced">建議的模型：${provider.models.map((m, i) => html`${i ? '、' : ''}<code>${m.id}</code>（${m.note}）`)}。
        也可以填這家供應商的其他模型名稱。</div>

      <h2 class="sec">${provider.label} 的 API key</h2>
      <div class="muted small">${keyLine(s.key)}</div>
      <div class="row spaced">
        <label class="field"><span>${s.key.set ? '換一個 key' : '貼上 key'}</span><input id="ai-key" type="password"
          autocomplete="off" spellcheck="false"></label>
        <div class="shrink"><button id="ai-key-save">儲存 key</button></div>
        ${s.key.source === 'file' ? html`<div class="shrink"><button class="danger" id="ai-key-del">刪除 key</button></div>` : ''}
      </div>
    </section>

    <section class="card">
      <h2 class="sec">要問什麼</h2>
      <div class="seg" role="group" aria-label="要 AI 做什麼">${AI_MODES.map((m) => html`<button
        data-aimode="${m.key}" aria-pressed="${ariaBool(m.key === aiMode)}">${m.label}</button>`)}</div>
      <div class="note spaced">${mode.about}</div>

      <details class="ai-preview">
        <summary>要送出的內容：給模型的說明，加上截至 ${preview.as_of} 的資產全覽，共 ${nf(preview.chars)} 字</summary>
        <h2 class="sec">給模型的說明</h2>
        <pre class="ai-text">${preview.system}</pre>
        <h2 class="sec">資產全覽</h2>
        <pre class="ai-text">${preview.document}</pre>
      </details>

      <div class="toolbar">
        <button class="primary" id="ai-send" ${ready && !aiBusy ? '' : 'disabled'}>${aiBusy ? '送出中…' : `送出到 ${provider.label}`}</button>
        <span class="muted small">${aiBusy
          ? '模型在讀整份全覽，可能要一兩分鐘。'
          : blocker || html`會送到 <code>${preview.host}</code>，模型 <code>${preview.model}</code>。`}</span>
      </div>
    </section>

    ${aiAnswer ? answerSection(aiAnswer) : ''}
  `);

  wireAi(s, provider, preview);
};

function keyLine(k) {
  if (k.source === 'file') {
    return html`已設定（${k.hint}），存在這台電腦的 <code>${k.path}</code>：只有你的帳號讀得到，不在帳本裡，
      不會進備份或匯出。`;
  }
  if (k.source === 'env') {
    return html`用的是環境變數 <code>${k.env}</code>（${k.hint}）。在這裡貼一個 key，就會改用貼上的那個。`;
  }
  return html`還沒有設定。貼在下面，或在啟動前設定環境變數 <code>${k.env}</code>。貼上的 key 存在
    <code>${k.path}</code>：只有你的帳號讀得到，不在帳本裡。`;
}

function answerSection(a) {
  const used = a.usage && a.usage.input !== null && a.usage.output !== null
    ? ` · 用了 ${nf(a.usage.input)} ＋ ${nf(a.usage.output)} tokens` : '';
  return html`<section class="card">
    <h2 class="sec">${a.mode_label}的結果 · ${a.provider_label} · ${a.model}</h2>
    ${a.truncated ? html`<div class="note warn">回答超過長度上限，後面被截掉了。可以再送一次，或換一個模型。</div>` : ''}
    <div class="ai-answer">${answerBlocks(a.text)}</div>
    <div class="muted small spaced">
      根據截至 ${a.as_of} 的資產全覽 · 送出 ${nf(a.sent_chars)} 字${used} · ${nf(a.elapsed_ms / 1000)} 秒。
      AI 的回答可能有錯，數字以帳本為準。
    </div>
  </section>`;
}

function wireAi(s, provider, preview) {
  // Every setting is one write and a redraw: the page is drawn from what the
  // server says the settings are, never from what the form last held.
  const save = async (path, body, done) => {
    try {
      await (body === null ? del(path) : put(path, body));
      if (done) toast(done, 'ok');
      render();
    } catch (e) { toast(e.message, 'err'); }
  };

  $('#ai-enabled').onchange = (e) => save('/api/ai', { enabled: e.target.checked },
    e.target.checked ? '已開啟 AI 健檢' : '已關閉');
  $('#ai-provider').onchange = (e) => save('/api/ai', { provider: e.target.value }, `改用 ${e.target.selectedOptions[0].text}`);
  $('#ai-model-save').onclick = () => save('/api/ai', { model: $('#ai-model').value }, '已儲存模型');
  $('#ai-key-save').onclick = () => save('/api/ai/key', { provider: provider.key, key: $('#ai-key').value }, '已儲存 key');
  if ($('#ai-key-del')) {
    $('#ai-key-del').onclick = () => save(`/api/ai/key?provider=${provider.key}`, null, '已刪除 key');
  }

  $$('[data-aimode]').forEach((b) => (b.onclick = () => { aiMode = b.dataset.aimode; render(); }));

  // One request at a time: the button is disabled while one is out, because a
  // second press would send the whole book a second time and pay for it twice.
  // The preview's day and digest go back with it, so the server sends the text
  // this page showed or refuses — and the redraw in `finally` then shows the
  // text as it is now.
  $('#ai-send').onclick = async () => {
    if (aiBusy) return;
    aiBusy = true;
    render();
    try {
      aiAnswer = await post('/api/ai/review', { mode: aiMode, as_of: preview.as_of, digest: preview.digest });
      toast('AI 回答好了', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      aiBusy = false;
      render();
    }
  };
}

// The answer is Markdown written by a model, about a book it was sent: text
// from somewhere this app does not control. So it never becomes markup. The
// few shapes an answer uses — headings, bullet and numbered lists, bold,
// inline code, paragraphs — are rebuilt as elements with html``, and
// everything else stays text. A link stays as the text the model wrote, with
// its address in plain sight: a ledger page is not where to discover where a
// link a model was talked into writing actually goes.
function answerBlocks(text) {
  const blocks = [];
  let para = [];
  let list = null;
  const endPara = () => {
    if (para.length) blocks.push(html`<p>${answerInline(para.join(' '))}</p>`);
    para = [];
  };
  const endList = () => {
    if (!list) return;
    const items = list.items.map((i) => html`<li>${answerInline(i)}</li>`);
    blocks.push(list.ordered ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`);
    list = null;
  };

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const item = /^(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (!line) { endPara(); endList(); }
    else if (heading) { endPara(); endList(); blocks.push(html`<h4>${answerInline(heading[1])}</h4>`); }
    else if (item) {
      endPara();
      const ordered = item[1] !== undefined;
      if (list && list.ordered !== ordered) endList();
      if (!list) list = { ordered, items: [] };
      list.items.push(item[2]);
    } else { endList(); para.push(line); }
  }
  endPara();
  endList();
  return blocks;
}

// `**bold**` and `` `code` ``, each as an element around escaped text. What
// the pattern does not match is left as text, a would-be link included.
function answerInline(s) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > at) out.push(s.slice(at, m.index));
    out.push(m[1] !== undefined ? html`<b>${m[1]}</b>` : html`<code>${m[2]}</code>`);
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push(s.slice(at));
  return out;
}
