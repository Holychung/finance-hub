'use strict';

// /holdings — positions and their market value. Deliberately not folded
// into any account balance: buying a stock is cash out plus shares in, and
// adding the market value back would count it twice.

views.holdings = async () => {
  const [holdings, accounts] = await Promise.all([api('/api/holdings'), api('/api/accounts')]);
  const brokerages = accounts.filter((a) => a.kind === 'brokerage');
  const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);

  const section = (mkt, label) => {
    // Sorted by market value so the biggest position leads — the allocation
    // chart below reads top-down and its colours run largest-first.
    const rows = holdings.filter((h) => h.market === mkt)
      .slice().sort((a, b) => b.market_value - a.market_value);
    if (!rows.length) return '';
    const mv = sum(rows, 'market_value');
    const cost = sum(rows, 'cost_total');
    const cur = rows[0].currency;
    return html`<section class="card">
      <h2 class="sec">${label} — 市值 ${money(mv, cur)} ／ 成本 ${money(cost, cur)} ／ 損益
        <span class="${cls(mv - cost)}">${signed(mv - cost, cur)}</span></h2>

      <h2 class="sec">配置</h2>
      ${barBreakdown(rows.map((h) => [h.symbol, h.market_value]), mv, cur)}

      <div class="table-wrap"><table>
        <thead><tr>
          <th>代號</th><th>名稱</th><th>帳戶</th><th class="num">股數</th><th class="num">均價</th>
          <th class="num">現價</th><th class="num">市值</th><th class="num">未實現</th><th class="num">ROI</th><th></th>
        </tr></thead>
        <tbody>${rows.map((h) => html`<tr>
          <td><b>${h.symbol}</b></td>
          <td class="dim truncate">${h.name}</td>
          <td class="dim small">${h.account_name}</td>
          <td class="num">${quantity(h.shares)}</td>
          <td class="num dim">${nf(h.avg_cost, 2)}</td>
          <td class="num">${nf(h.last_price, 2)}${h.price_date ? html`<br><span class="dim small">${h.price_date}</span>` : ''}</td>
          <td class="num">${money(h.market_value, h.currency)}</td>
          <td class="num ${cls(h.unrealized)}">${signed(h.unrealized, h.currency)}</td>
          <td class="num ${cls(h.roi_pct)}">${h.roi_pct > 0 ? '+' : ''}${nf(h.roi_pct, 2)}%</td>
          <td class="num nowrap row-actions">
            <button class="icon-btn" data-hist="${h.id}" title="價格歷史" aria-label="${h.symbol} 價格歷史">${icon('chart')}</button>
            <button class="icon-btn" data-edit="${h.id}" title="編輯" aria-label="編輯 ${h.symbol}">${icon('edit')}</button>
            <button class="icon-btn danger" data-del="${h.id}" title="刪除" aria-label="刪除 ${h.symbol}">${icon('trash')}</button>
          </td>
        </tr>`)}</tbody>
      </table></div>
    </section>`;
  };

  mount(main, html`
    <div class="page-head">
      <div><h1>持股</h1><div class="sub">${holdings.length} 檔 · 現價取每檔最新一筆報價（可存歷史）</div></div>
      <div class="row shrink">
        ${exportLink('匯出 CSV', '/api/export/csv?type=holdings')}
        <button class="primary" id="add-h" ${brokerages.length ? '' : 'disabled'}>新增持股</button>
      </div>
    </div>

    ${brokerages.length ? '' : html`<section><div class="note warn">還沒有「證券」類型的帳戶。先到「帳戶」頁新增一個類型為證券的帳戶。</div></section>`}

    <section><div class="note">
      持股跟券商帳戶的<b>現金餘額是分開的</b>：買股票時，現金從券商帳戶流出（一筆交易），股票進到這張表（股數與成本）。
      這樣同一個幣別的淨值 ＝ 該幣別所有帳戶餘額 ＋ 該幣別所有持股市值，不會重複計算。第二階段接券商 API 後，這張表就會自動同步。
    </div></section>

    ${section('TW', '台股')}
    ${section('US', '美股')}
    ${holdings.length ? '' : html`<section class="card">${empty('還沒有持股。')}</section>`}
  `);

  if ($('#add-h')) $('#add-h').onclick = () => holdingForm(null, brokerages);
  $$('[data-hist]').forEach((b) => (b.onclick = () => holdingPrices(holdings.find((h) => h.id === +b.dataset.hist))));
  $$('[data-edit]').forEach((b) => (b.onclick = () => holdingForm(holdings.find((h) => h.id === +b.dataset.edit), brokerages)));
  $$('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('刪除這檔持股？')) return;
    await del(`/api/holdings/${b.dataset.del}`);
    toast('已刪除', 'ok'); render();
  }));
};

function holdingForm(h0, brokerages) {
  const h = h0 || {
    account_id: brokerages[0]?.id, symbol: '', name: '', market: 'TW',
    shares: '', avg_cost: '', last_price: '', price_date: today(), note: '',
  };
  modal(h0 ? `編輯 ${h0.symbol}` : '新增持股', html`
    <div class="row">
      <label class="field"><span>券商帳戶</span><select id="h-acct">
        ${brokerages.map((a) => html`<option value="${a.id}" ${a.id === h.account_id ? 'selected' : ''}>${a.name}（${a.currency}）</option>`)}
      </select></label>
      <label class="field"><span>市場</span><select id="h-market">
        <option value="TW" ${h.market === 'TW' ? 'selected' : ''}>台股</option>
        <option value="US" ${h.market === 'US' ? 'selected' : ''}>美股</option>
      </select></label>
    </div>
    <div class="row">
      <label class="field"><span>代號</span><input id="h-symbol" value="${h.symbol}" placeholder="0050 / VOO"></label>
      <label class="field"><span>名稱</span><input id="h-name" value="${h.name}" placeholder="元大台灣50"></label>
    </div>
    <div class="row">
      <label class="field"><span>股數</span><input id="h-shares" type="number" step="0.0001" value="${h.shares}"></label>
      <label class="field"><span>平均成本／股</span><input id="h-cost" type="number" step="0.01" value="${h.avg_cost}"></label>
    </div>
    <div class="row">
      <label class="field"><span>現價／股</span><input id="h-price" type="number" step="0.01" value="${h.last_price}"></label>
      <label class="field"><span>報價日期</span><input id="h-pdate" type="date" value="${h.price_date || today()}"></label>
    </div>
    <label class="field"><span>備註</span><input id="h-note" value="${h.note || ''}"></label>
    <div class="modal-foot">
      <button data-close-modal>取消</button><button class="primary" id="h-save">儲存</button>
    </div>
  `, (body) => {
    $('#h-save', body).onclick = async () => {
      const market = $('#h-market').value;
      const payload = {
        account_id: Number($('#h-acct').value), market,
        symbol: $('#h-symbol').value.trim(), name: $('#h-name').value,
        shares: Number($('#h-shares').value || 0), avg_cost: Number($('#h-cost').value || 0),
        last_price: Number($('#h-price').value || 0), price_date: $('#h-pdate').value,
        currency: market === 'US' ? 'USD' : 'TWD', note: $('#h-note').value,
      };
      if (!payload.symbol) return toast('代號必填', 'err');
      try {
        h0 ? await put(`/api/holdings/${h0.id}`, payload) : await post('/api/holdings', payload);
        // The 現價 field is a price observation, so record it: the history grows
        // and valuation reads the series, not this one field. Upserts on
        // (symbol, market, date), so saving the same holding twice in a day is
        // one row, not two.
        if (payload.last_price > 0 && payload.price_date) {
          await post('/api/prices', {
            symbol: payload.symbol, market, date: payload.price_date, price: payload.last_price,
          });
        }
        closeModal(); toast('已儲存', 'ok'); render();
      } catch (e) { toast(e.message, 'err'); }
    };
  });
}

// The price history for one security — every observation, newest first, with a
// row to add one and a way to delete a wrong one. Current value comes from the
// latest observation at or before today (see computeHoldingsValued), so editing
// here moves the number on the list behind the modal, which is why every change
// re-renders the page as well as the panel.
function holdingPrices(h) {
  const qs = `symbol=${encodeURIComponent(h.symbol)}&market=${h.market}`;
  const open = async () => {
    const rows = await api(`/api/prices?${qs}`);
    modal(`${h.symbol} 價格歷史`, html`
      <div class="note">現價取「不晚於今天的最後一筆」，跟匯率一樣綁在各自的日期上；第一筆之前不往回推。買賣記在交易，這裡只記每股報價。</div>
      <div class="row shrink">
        <label class="field"><span>日期</span><input id="p-date" type="date" value="${today()}"></label>
        <label class="field"><span>價格／股</span><input id="p-price" type="number" step="0.01" placeholder="每股"></label>
        <button class="primary" id="p-add">新增</button>
      </div>
      ${rows.length ? html`<div class="table-wrap scroll"><table>
        <thead><tr><th>日期</th><th class="num">價格</th><th>來源</th><th></th></tr></thead>
        <tbody>${rows.map((r) => html`<tr>
          <td class="nowrap">${r.date}</td>
          <td class="num">${nf(r.price, 2)}</td>
          <td class="dim small">${r.source === 'api' ? '自動' : '手動'}</td>
          <td class="num row-actions">
            <button class="icon-btn danger" data-pdel="${r.date}" title="刪除" aria-label="刪除 ${r.date} 的價格">${icon('trash')}</button>
          </td>
        </tr>`)}</tbody>
      </table></div>` : empty('還沒有價格紀錄。')}
      <div class="modal-foot"><button data-close-modal>關閉</button></div>
    `, (body) => {
      $('#p-add', body).onclick = async () => {
        const date = $('#p-date', body).value;
        const price = Number($('#p-price', body).value || 0);
        if (!date) return toast('日期必填', 'err');
        if (!(price > 0)) return toast('價格要大於 0', 'err');
        try {
          await post('/api/prices', { symbol: h.symbol, market: h.market, date, price });
          toast('已新增', 'ok'); render(); open();
        } catch (e) { toast(e.message, 'err'); }
      };
      $$('[data-pdel]', body).forEach((b) => (b.onclick = async () => {
        await del(`/api/prices?${qs}&date=${b.dataset.pdel}`);
        toast('已刪除', 'ok'); render(); open();
      }));
    });
  };
  open();
}
