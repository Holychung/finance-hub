'use strict';

// /holdings — positions and their market value. Deliberately not folded
// into any account balance: buying a stock is cash out plus shares in, and
// adding the market value back would count it twice.

views.holdings = async () => {
  const [holdings, accounts] = await Promise.all([api('/api/holdings'), api('/api/accounts')]);
  // Any account whose kind can hold positions. This used to be
  // `kind === 'brokerage'`, so a wallet could never be given a coin at all.
  const holders = accounts.filter((a) => HOLDING_KINDS.has(a.kind));
  const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);

  // One section per market and, within it, per currency. A section's header
  // is a sum, so it has to be a sum in one currency — and a coin can be priced
  // in USD in one wallet and TWD on a Taiwanese exchange. TW and US only ever
  // had one currency each, which is why this never needed saying.
  //
  // The sections used to be two hardcoded calls, `section('TW')` and
  // `section('US')`. A holding in any third market was left off this page
  // while still counting in net worth. Now every market present gets a
  // section, and one missing from MARKETS still renders under its own key
  // rather than disappearing.
  const orderOf = (m) => (MARKET_KEYS.includes(m) ? MARKET_KEYS.indexOf(m) : MARKET_KEYS.length);
  const groups = [...new Set(holdings.map((h) => `${h.market}\u0000${h.currency}`))]
    .map((k) => k.split('\u0000'))
    .sort(([ma, ca], [mb, cb]) => orderOf(ma) - orderOf(mb) || ma.localeCompare(mb) || ca.localeCompare(cb));
  const currenciesIn = (m) => new Set(holdings.filter((h) => h.market === m).map((h) => h.currency));

  const section = (mkt, cur) => {
    const rows = holdings.filter((h) => h.market === mkt && h.currency === cur);
    const u = unitsOf(mkt);
    const label = `${u.label}${currenciesIn(mkt).size > 1 ? `（${cur}）` : ''}`;
    const mv = sum(rows, 'market_value');
    const cost = sum(rows, 'cost_total');
    return html`<section class="card">
      <h2 class="sec">${label} — 市值 ${money(mv, cur)} ／ 成本 ${money(cost, cur)} ／ 損益
        <span class="${cls(mv - cost)}">${signed(mv - cost, cur)}</span></h2>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>代號</th><th>名稱</th><th>帳戶</th><th class="num">${u.unit}</th><th class="num">均價</th>
          <th class="num">現價</th><th class="num">市值</th><th class="num">未實現</th><th class="num">ROI</th><th></th>
        </tr></thead>
        <tbody>${rows.map((h) => html`<tr>
          <td><b>${h.symbol}</b></td>
          <td class="dim truncate">${h.name}</td>
          <td class="dim small">${h.account_name}</td>
          <td class="num">${quantity(h.shares, h.decimals)}</td>
          <td class="num dim">${unitPrice(h.avg_cost)}</td>
          <td class="num">${unitPrice(h.last_price)}${h.price_date ? html`<br><span class="dim small">${h.price_date}</span>` : ''}</td>
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
        <button class="primary" id="add-h" ${holders.length ? '' : 'disabled'}>新增持股</button>
      </div>
    </div>

    ${holders.length ? '' : html`<section><div class="note warn">還沒有可以放持股的帳戶。先到「帳戶」頁新增一個類型為「${KIND_ORDER.filter((k) => HOLDING_KINDS.has(k)).map(kindName).join('」或「')}」的帳戶。</div></section>`}

    <section><div class="note">
      持股跟券商帳戶的<b>現金餘額是分開的</b>：買股票時，現金從券商帳戶流出（一筆交易），股票進到這張表（股數與成本）。
      這樣同一個幣別的淨值 ＝ 該幣別所有帳戶餘額 ＋ 該幣別所有持股市值，不會重複計算。第二階段接券商 API 後，這張表就會自動同步。
    </div></section>

    ${groups.map(([mkt, cur]) => section(mkt, cur))}
    ${holdings.length ? '' : html`<section class="card">${empty('還沒有持股。')}</section>`}
  `);

  if ($('#add-h')) $('#add-h').onclick = () => holdingForm(null, accounts);
  $$('[data-hist]').forEach((b) => (b.onclick = () => holdingPrices(holdings.find((h) => h.id === +b.dataset.hist))));
  $$('[data-edit]').forEach((b) => (b.onclick = () => holdingForm(holdings.find((h) => h.id === +b.dataset.edit), accounts)));
  $$('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('刪除這檔持股？')) return;
    await del(`/api/holdings/${b.dataset.del}`);
    toast('已刪除', 'ok'); render();
  }));
};

// What a market's quantity is called and what its price is per. A market
// missing from MARKETS reads as a plain count rather than as shares.
const unitsOf = (m) => marketInfo(m) || { label: m, unit: '數量', per: '每單位' };

function holdingForm(h0, accounts) {
  // The account the holding is already in stays on the list even if its kind
  // no longer holds positions. Without it the select falls to the first
  // option, and saving moves the holding to some other account.
  const holders = accounts.filter((a) => HOLDING_KINDS.has(a.kind) || a.id === h0?.account_id);
  const first = marketInfo(DEFAULT_MARKET);
  const h = h0 || {
    account_id: holders[0]?.id, symbol: '', name: '', market: DEFAULT_MARKET,
    currency: first.currency, decimals: first.decimals,
    shares: '', avg_cost: '', last_price: '', price_date: today(), note: '',
  };
  const u = unitsOf(h.market);
  modal(h0 ? `編輯 ${h0.symbol}` : '新增持股', html`
    <div class="row">
      <label class="field"><span>帳戶</span><select id="h-acct">
        ${holders.map((a) => html`<option value="${a.id}" ${a.id === h.account_id ? 'selected' : ''}>${a.name}（${a.currency}）</option>`)}
      </select></label>
      <label class="field"><span>市場</span><select id="h-market">
        ${MARKETS.map((m) => html`<option value="${m.key}" ${m.key === h.market ? 'selected' : ''}>${m.label}</option>`)}
      </select></label>
    </div>
    <div class="row">
      <label class="field"><span>代號</span><input id="h-symbol" value="${h.symbol}" placeholder="0050 / VOO / BTC"></label>
      <label class="field"><span>名稱</span><input id="h-name" value="${h.name}" placeholder="元大台灣50"></label>
    </div>
    <div class="row">
      <label class="field"><span id="h-unit">${u.unit}</span><input id="h-shares" type="number" step="any" value="${h.shares}"></label>
      <label class="field"><span>小數位數</span><input id="h-dp" type="number" min="0" max="${MAX_DECIMALS}" step="1" value="${h.decimals}"></label>
      <label class="field"><span>幣別</span><select id="h-currency">
        ${CURRENCY_CODES.map((c) => html`<option ${c === h.currency ? 'selected' : ''}>${c}</option>`)}
      </select></label>
    </div>
    <div class="row">
      <label class="field"><span>平均成本（<span class="h-per">${u.per}</span>）</span><input id="h-cost" type="number" step="any" value="${h.avg_cost}"></label>
      <label class="field"><span>現價（<span class="h-per">${u.per}</span>）</span><input id="h-price" type="number" step="any" value="${h.last_price}"></label>
      <label class="field"><span>報價日期</span><input id="h-pdate" type="date" value="${h.price_date || today()}"></label>
    </div>
    <label class="field"><span>備註</span><input id="h-note" value="${h.note || ''}"></label>
    <div class="modal-foot">
      <button data-close-modal>取消</button><button class="primary" id="h-save">儲存</button>
    </div>
  `, (body) => {
    // Picking a market fills in its currency and its places. Both stay
    // editable, because a coin bought on a Taiwanese exchange is priced in TWD.
    //
    // The number inputs are `step="any"` because a step is also a validity
    // rule: 0.0001 marks an eight-place coin invalid, and 0.01 a price under
    // a cent. How many places a quantity is shown to is `decimals`, not this.
    $('#h-market', body).onchange = (e) => {
      const m = marketInfo(e.target.value);
      $('#h-unit', body).textContent = m.unit;
      $$('.h-per', body).forEach((el) => (el.textContent = m.per));
      $('#h-currency', body).value = m.currency;
      $('#h-dp', body).value = m.decimals;
    };

    $('#h-save', body).onclick = async () => {
      const market = $('#h-market').value;
      const payload = {
        account_id: Number($('#h-acct').value), market,
        symbol: $('#h-symbol').value.trim(), name: $('#h-name').value,
        shares: Number($('#h-shares').value || 0), avg_cost: Number($('#h-cost').value || 0),
        last_price: Number($('#h-price').value || 0), price_date: $('#h-pdate').value,
        currency: $('#h-currency').value, decimals: $('#h-dp').value, note: $('#h-note').value,
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
  const { per } = unitsOf(h.market);
  const open = async () => {
    const rows = await api(`/api/prices?${qs}`);
    modal(`${h.symbol} 價格歷史`, html`
      <div class="note">現價取「不晚於今天的最後一筆」，跟匯率一樣綁在各自的日期上；第一筆之前不往回推。買賣記在交易，這裡只記${per}的報價。</div>
      <div class="row shrink">
        <label class="field"><span>日期</span><input id="p-date" type="date" value="${today()}"></label>
        <label class="field"><span>價格（${per}）</span><input id="p-price" type="number" step="any" placeholder="${per}"></label>
        <button class="primary" id="p-add">新增</button>
      </div>
      ${rows.length ? html`<div class="table-wrap scroll"><table>
        <thead><tr><th>日期</th><th class="num">價格</th><th>來源</th><th></th></tr></thead>
        <tbody>${rows.map((r) => html`<tr>
          <td class="nowrap">${r.date}</td>
          <td class="num">${unitPrice(r.price)}</td>
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
