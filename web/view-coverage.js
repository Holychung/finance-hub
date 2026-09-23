'use strict';

// /coverage — 帳戶 × 月份。每一格回答的是「這個月帳本知不知道發生了什麼」，
// 不是「這個月有沒有花錢」。四種狀態的理由寫在 server/money.js 的
// computeCoverage 上面。
//
// 沒有對帳單可匯的帳戶（錢包）不在表上，但會在最下面點名：從表上消失而沒有
// 一句話，比留著一排補不了的缺口還讓人困惑。
//
// 格子裡是字不是只有顏色：有資料的顯示筆數，確認過的安靜月份是 `–`，缺口是
// `?`，帳戶還沒開始的留白。顏色只是讓它掃得快，拿掉顏色這張表照樣讀得懂。

// 這個頁面自己的狀態，不進網址：router 只看 pathname，推一個 ?months= 進去
// 不會觸發重繪。改完呼叫 render()，焦點和捲動位置就由它那對括號負責。
let coverageMonths = 24;

const COV_STATE = {
  data: '有資料',
  quiet: '沒有交易，但確認過',
  partial: '只涵蓋到這個月的一部分，其餘不知道',
  gap: '沒有資料',
  outside: '帳戶那時還沒開始，或已經停用',
};

// 安靜的月份有兩種來源，而且說得出是哪一種。對帳是銀行給了一個數字；對帳單涵蓋
// 是「檔案問過那段期間，它說沒有交易」。兩種都比「沒有資料」強得多。
const COV_REASON = {
  check: '那個月有對帳紀錄',
  import: '有對帳單涵蓋整個月，裡面沒有交易',
};

views.coverage = async () => {
  const d = await api(`/api/coverage?months=${coverageMonths}`);
  const s = d.summary;

  // 年份橫跨好幾欄，所以標題是兩列：上面一列年、下面一列月。
  const years = [];
  for (const m of d.months) {
    const y = m.slice(0, 4);
    const last = years[years.length - 1];
    if (last && last.year === y) last.span++;
    else years.push({ year: y, span: 1 });
  }

  const worst = s.stale[0];

  mount(main, html`
    <div class="page-head">
      <div>
        <h1>帳本完整度</h1>
        <div class="sub">每個帳戶、每個月，帳本到底有沒有資料</div>
      </div>
      <div class="seg" role="group" aria-label="看幾個月">${[12, 24, 36].map((n) => html`<button
        data-months="${n}" aria-pressed="${n === coverageMonths}">${n} 個月</button>`)}</div>
    </div>

    ${d.accounts.length ? html`
      <div class="grid g3">
        <div class="card kpi">
          <div class="label">缺口月數</div>
          <div class="value ${s.gaps ? 'neg' : 'dim'}">${nf(s.gaps)}</div>
          <div class="meta">應該有資料的 ${nf(s.expected)} 個月裡${s.partials ? `，另有 ${nf(s.partials)} 個月只涵蓋一半` : ''}</div>
        </div>
        <div class="card kpi">
          <div class="label">有缺口的帳戶</div>
          <div class="value ${s.accounts_with_gaps ? 'neg' : 'dim'}">${nf(s.accounts_with_gaps)}</div>
          <div class="meta">共 ${nf(d.accounts.length)} 個帳戶</div>
        </div>
        <div class="card kpi">
          <div class="label">最久沒匯入</div>
          <div class="value ${worst ? 'neg' : 'dim'}">${worst ? `${worst.trailing_gap} 個月` : '—'}</div>
          <div class="meta">${worst ? worst.name : '每個帳戶都是最新的'}</div>
        </div>
      </div>

      ${s.gaps ? html`
        <div class="note warn">
          有 ${nf(s.gaps)} 個月，帳本沒有任何資料、沒有對帳紀錄，也沒有任何一份對帳單涵蓋到。
          餘額和淨值算的時候當作那些月份什麼都沒發生——可能真的沒發生，也可能只是沒匯。
          匯入一份涵蓋那段期間的對帳單就會自動變成已確認；或點一格 <code>?</code> 直接記一筆對帳。
        </div>`
        : html`<div class="note ok">每個應該有資料的月份都有資料，或都被對帳確認過了。</div>`}

      <section class="card">
        <div class="table-wrap">
          <table class="cov-table">
            <thead>
              <tr>
                <th class="cov-name"></th>
                ${years.map((y) => html`<th class="cov-year" colspan="${y.span}">${y.year}</th>`)}
                <th class="num">缺口</th>
              </tr>
              <tr>
                <th class="cov-name">帳戶</th>
                ${d.months.map((m) => html`<th class="cov-mon">${m.slice(5)}</th>`)}
                <th class="num"></th>
              </tr>
            </thead>
            <tbody>${d.accounts.map((a) => html`
              <tr>
                <td class="cov-name">
                  <a href="/account/${a.id}">${a.name}</a>
                  <span class="sub-line">${a.currency}${a.is_active ? '' : ' · 已停用'}</span>
                </td>
                ${a.cells.map((c) => covCell(a, c))}
                <td class="num ${a.gaps ? 'neg' : 'dim'}">${a.gaps || '—'}</td>
              </tr>`)}
            </tbody>
          </table>
        </div>

        <div class="cov-legend">
          <span><i class="cov cov-data">3</i> 有資料，數字是筆數</span>
          <span><i class="cov cov-quiet">–</i> 沒有交易，但對帳單涵蓋到或有對帳紀錄</span>
          <span><i class="cov cov-partial">◒</i> 只涵蓋到半個月</span>
          <span><i class="cov cov-gap">?</i> 沒有資料，也沒有東西涵蓋到</span>
          <span><i class="cov cov-outside"></i> 帳戶那時還沒開始</span>
          <span><i class="cov cov-data off">3</i> 那個月的對帳對不起來</span>
        </div>
      </section>`
      : d.manual.length ? '' : empty('還沒有帳戶，所以也還沒有東西可以缺。')}

    ${d.manual.length ? html`<div class="note">
      ${d.manual.map((a) => a.name).join('、')} 不列在這裡：這類帳戶沒有對帳單可以匯，價值是你手動填的，看最新的一筆就好。
    </div>` : ''}
  `);

  $$('[data-months]').forEach((b) => (b.onclick = () => {
    coverageMonths = Number(b.dataset.months);
    render();
  }));

  $$('[data-gap]').forEach((b) => (b.onclick = () => {
    const [id, month] = b.dataset.gap.split(':');
    const acct = d.accounts.find((a) => a.id === Number(id));
    // 那個月的最後一天：對帳記的是「到這天為止銀行說多少」，記在月底才蓋得住
    // 整個月。Date.UTC 的第 0 天就是上個月的最後一天。
    const [y, m] = month.split('-').map(Number);
    const eom = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    balanceCheckForm({ id: acct.id, name: acct.name, currency: acct.currency }, eom);
  }));
};

function covCell(acct, c) {
  const where = `${acct.name} ${c.month}`;
  const why = c.reason ? `（${COV_REASON[c.reason]}）` : '';
  const detail = c.state === 'data'
    ? `${where}：${c.txns} 筆，淨額 ${money(c.net, acct.currency)}`
    : `${where}：${COV_STATE[c.state]}${why}`;
  const title = c.check === 'off' ? `${detail}。那個月的對帳對不起來` : detail;
  const off = c.check === 'off' ? ' off' : '';

  if (c.state === 'gap') {
    return html`<td class="cov cov-gap${off}">
      <button class="cov-btn" data-gap="${acct.id}:${c.month}" title="${title}"
              aria-label="${title}。點一下記一筆對帳">?</button>
    </td>`;
  }
  const text = c.state === 'data' ? String(c.txns)
    : c.state === 'quiet' ? '–'
    : c.state === 'partial' ? (c.txns ? `${c.txns}` : '◒')
    : '';
  return html`<td class="cov cov-${c.state}${off}" title="${title}">${text}</td>`;
}
