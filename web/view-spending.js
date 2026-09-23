'use strict';

// /spending — 錢花到哪去了：每月進出、分類佔比、固定扣款，還有決定分類的規則。
//
// 一個幣別一組數字，跟總覽同一條規則：USD 和 TWD 沒有匯率加不起來，湊一個
// 「這個月花了 84,000」出來是把估計值講成事實。所以幣別是分頁不是加總。
//
// 轉帳不算消費。自己的錢在自己的帳戶之間搬，兩隻腳會同時灌大收入和支出，而淨額
// 還是對的 —— 這就是它能安靜活很久的原因。伺服器那邊已經濾掉，這裡不用再想。

let spendingYears = 1;
let spendingCur = null;

const CADENCE_LABEL = { weekly: '每週', monthly: '每月', quarterly: '每季', yearly: '每年' };
// 圖只畫得下四種顏色（--chart-1..4），第五條開始會從最亮的重新來過，看起來像
// 又變大了。所以圖只放前四名＋其他，完整的清單在下面的表格裡，一行都不少。
const BREAKDOWN_TOP = 4;

views.spending = async () => {
  const [sp, rec, rules] = await Promise.all([
    api(`/api/spending?years=${spendingYears}`),
    api('/api/recurring'),
    api('/api/rules'),
  ]);

  if (!sp.order.length) {
    mount(main, html`
      <div class="page-head"><div><h1>消費分析</h1><div class="sub">錢花到哪去了</div></div></div>
      ${empty('這段期間還沒有任何非轉帳的交易。先去匯入一份對帳單。')}
      ${rulesSection(rules)}`);
    wireRules(rules);
    return;
  }

  const cur = sp.order.includes(spendingCur) ? spendingCur : sp.order[0];
  const d = sp.currencies[cur];
  const label = (c) => c || '未分類';

  // 圖只放前四名，其餘合併。表格在下面，一行都不少。
  const top = d.categories.slice(0, BREAKDOWN_TOP);
  const rest = d.categories.slice(BREAKDOWN_TOP);
  const restTotal = round2(rest.reduce((n, c) => n + c.total, 0));
  const bars = top.map((c) => [label(c.category), c.total])
    .concat(restTotal ? [[`其他（${rest.length} 類）`, restTotal]] : []);

  const series = d.months.map((m) => ({ date: `${m.month}-01`, value: m.expense }));
  const mine = rec.items.filter((r) => r.currency === cur);
  const active = mine.filter((r) => r.active);
  const uncatShare = d.expense ? (d.uncategorised.total / d.expense) * 100 : 0;

  mount(main, html`
    <div class="page-head">
      <div><h1>消費分析</h1><div class="sub">${sp.from} 到 ${sp.to}，不含轉帳</div></div>
      <div class="seg" role="group" aria-label="看幾年">${[1, 2, 3].map((y) => html`<button
        data-years="${y}" aria-pressed="${ariaBool(y === spendingYears)}">${y} 年</button>`)}</div>
    </div>

    ${sp.order.length > 1 ? html`<section>
      <div class="seg" role="group" aria-label="看哪個幣別">${sp.order.map((c) => html`<button
        data-cur="${c}" aria-pressed="${ariaBool(c === cur)}">${c}</button>`)}</div>
      <div class="note spaced">幣別是分頁不是加總。${sp.order.join('、')} 之間沒有匯率就加不起來，
        所以這裡不會給你一個跨幣別的總數 —— 那個數字不存在。</div>
    </section>`
      : ''}

    <div class="grid g4">
      <div class="card kpi"><div class="label">支出</div>
        <div class="value neg">${money(d.expense, cur)}</div>
        <div class="meta">${d.months.length} 個月</div></div>
      <div class="card kpi"><div class="label">收入</div>
        <div class="value pos">${money(d.income, cur)}</div></div>
      <div class="card kpi"><div class="label">淨額</div>
        <div class="value ${cls(d.net)}">${signed(d.net, cur)}</div></div>
      <div class="card kpi"><div class="label">固定扣款</div>
        <div class="value ${active.length ? 'neg' : 'dim'}">${money(rec.monthly_total[cur] || 0, cur)}</div>
        <div class="meta">${active.length} 筆，每月等值</div></div>
    </div>

    ${d.uncategorised.count ? html`
      <div class="note warn">
        ${nf(d.uncategorised.count)} 筆、${money(d.uncategorised.total, cur)}（佔支出
        ${nf(uncatShare, 1)}%）沒有分類。八種支援的對帳單裡只有兩種自己帶分類欄，其餘都要靠
        下面的規則補上。
        <button class="sm" id="go-rules">去設規則</button>
      </div>` : ''}

    <section class="card">
      <h2 class="sec">每月支出</h2>
      ${lineChart(series, cur)}
    </section>

    <div class="grid g2">
      <section class="card">
        <h2 class="sec">分類佔比</h2>
        ${barBreakdown(bars, d.expense, cur)}
      </section>

      <section class="card">
        <h2 class="sec">固定扣款</h2>
        ${mine.length ? html`
          <div class="note">連續出現三次以上、間隔穩定、金額接近的支出。金額區間一起列出來，
            要不要算它是訂閱由你判斷。</div>
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th>項目</th><th>週期</th><th class="num">金額</th><th>下次約在</th>
              </tr></thead>
              <tbody>${mine.map((r) => html`
                <tr class="${r.active ? '' : 'dim'}">
                  <td>
                    <span class="truncate">${r.label}</span>
                    <span class="sub-line">${r.account_name}${r.category ? ` · ${r.category}` : ''}${r.active ? '' : ' · 好像停了'}</span>
                  </td>
                  <td>${CADENCE_LABEL[r.cadence] || r.cadence}<span class="sub-line">${r.occurrences} 次</span></td>
                  <td class="num">${money(r.median_amount, cur)}${r.min_amount !== r.max_amount
                    ? html`<span class="sub-line">${money(r.min_amount, cur)}–${money(r.max_amount, cur)}</span>` : ''}</td>
                  <td class="dim">${r.active ? r.next_expected : `最後 ${r.last}`}</td>
                </tr>`)}
              </tbody>
            </table>
          </div>` : empty('還沒有看得出規律的重複扣款。至少要連續三次才算得準。')}
      </section>
    </div>

    <section class="card">
      <h2 class="sec">分類明細</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>分類</th><th class="num">筆數</th><th class="num">支出</th><th class="num">佔比</th></tr></thead>
          <tbody>${d.categories.map((c) => html`
            <tr>
              <td class="${c.category ? '' : 'dim'}">${label(c.category)}</td>
              <td class="num dim">${nf(c.count)}</td>
              <td class="num">${money(c.total, cur)}</td>
              <td class="num dim">${nf(d.expense ? (c.total / d.expense) * 100 : 0, 1)}%</td>
            </tr>`)}
          </tbody>
        </table>
      </div>
    </section>

    ${rulesSection(rules)}
  `);

  $$('[data-years]').forEach((b) => (b.onclick = () => { spendingYears = Number(b.dataset.years); render(); }));
  $$('[data-cur]').forEach((b) => (b.onclick = () => { spendingCur = b.dataset.cur; render(); }));
  if ($('#go-rules')) $('#go-rules').onclick = () => $('#rules').scrollIntoView({ behavior: 'smooth' });
  wireRules(rules);
};

function rulesSection(rules) {
  return html`
    <section class="card" id="rules">
      <h2 class="sec">分類規則</h2>
      <div class="note">比對是忽略大小寫、標點和空白的：<code>7-ELEVEN #1234</code> 和
        <code>7 eleven</code> 算同一件事。<b>由上往下，第一個對上的就決定分類</b> —— 不是
        「最像的贏」，因為「最像」是程式的猜測，順序是你看得到也改得動的東西。</div>

      <div class="row">
        <label class="field"><span>描述包含</span><input id="r-pattern" placeholder="UBER EATS"></label>
        <label class="field"><span>分類</span><input id="r-category" placeholder="外食"></label>
        <label class="field shrink"><span>優先度</span><input id="r-priority" type="number" value="0"></label>
        <div class="shrink"><button class="primary" id="r-add">新增規則</button></div>
      </div>

      ${rules.length ? html`
        <div class="table-wrap">
          <table>
            <thead><tr><th class="num">優先</th><th>描述包含</th><th>分類</th><th></th></tr></thead>
            <tbody>${rules.map((r) => html`
              <tr>
                <td class="num dim">${r.priority}</td>
                <td><code>${r.pattern}</code></td>
                <td>${r.category}</td>
                <td class="num row-actions">
                  <button class="icon-btn danger" data-rule-del="${r.id}" title="刪除"
                          aria-label="刪除規則「${r.pattern}」">${icon('trash')}</button>
                </td>
              </tr>`)}
            </tbody>
          </table>
        </div>
        <div class="row shrink">
          <button class="sm" id="r-apply">套用到現有交易…</button>
        </div>`
        : empty('還沒有規則。上面加一條，之後匯入的交易就會自動帶分類。')}
    </section>`;
}

function wireRules(rules) {
  const add = $('#r-add');
  if (!add) return;

  add.onclick = async () => {
    const pattern = $('#r-pattern').value.trim();
    const category = $('#r-category').value.trim();
    if (!pattern || !category) return toast('描述和分類都要填', 'err');
    try {
      await post('/api/rules', { pattern, category, priority: Number($('#r-priority').value || 0) });
      toast('已新增', 'ok');
      render();
    } catch (e) { toast(e.message, 'err'); }
  };

  $$('[data-rule-del]').forEach((b) => (b.onclick = async () => {
    const r = rules.find((x) => x.id === Number(b.dataset.ruleDel));
    await del(`/api/rules/${r.id}`);
    toast('已刪除', 'ok');
    render();
  }));

  // 先跑一次 dry run 再問。規則一套是掃過整本帳，不是事後才發現的那種動作。
  if ($('#r-apply')) $('#r-apply').onclick = async () => {
    let preview;
    try { preview = await post('/api/rules/apply', { dry: true }); }
    catch (e) { return toast(e.message, 'err'); }

    if (!preview.total) return toast('沒有需要改的交易 —— 現有的都已經有分類了', 'ok');

    modal('套用規則到現有交易', html`
      <div class="note">會改 <b>${nf(preview.total)}</b> 筆目前沒有分類的交易。
        已經有分類的不會動 —— 你手動填的是決定，規則不該把它蓋掉。</div>
      <div class="table-wrap scroll">
        <table>
          <thead><tr><th class="num">筆數</th><th>要變成的分類</th></tr></thead>
          <tbody>${summariseChanges(preview.changes).map(([category, n]) => html`
            <tr><td class="num">${nf(n)}</td><td>${category}</td></tr>`)}
          </tbody>
        </table>
      </div>
      ${preview.total > preview.changes.length
        ? html`<div class="note small">上面是前 ${nf(preview.changes.length)} 筆的統計，實際會套用全部
            ${nf(preview.total)} 筆。</div>`
        : ''}
      <div class="modal-foot">
        <button data-close-modal>取消</button>
        <button class="primary" id="r-confirm">套用</button>
      </div>
    `, (body) => {
      $('#r-confirm', body).onclick = async () => {
        try {
          const res = await post('/api/rules/apply', { dry: false });
          closeModal();
          toast(`已套用到 ${res.applied} 筆`, 'ok');
          render();
        } catch (e) { toast(e.message, 'err'); }
      };
    });
  };
}

function summariseChanges(changes) {
  const n = new Map();
  for (const c of changes) n.set(c.to, (n.get(c.to) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]);
}
