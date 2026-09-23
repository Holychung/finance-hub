'use strict';

// /settings — FX rates, saved column mappings, backups, and where on this
// machine the book actually lives.

views.settings = async () => {
  const [fx, settings, mappings, backups] = await Promise.all([
    api('/api/fx'), api('/api/settings'), api('/api/mappings'), api('/api/backups'),
  ]);

  mount(main, html`
    <div class="page-head"><div><h1>設定</h1><div class="sub">匯率、備份、欄位對應</div></div></div>

    <section class="card">
      <h2 class="sec">USD／TWD 匯率（只用於轉帳配對）</h2>
      <div class="note">
        <b>金額一律用原幣顯示，不會被折算</b>——匯入是什麼就是什麼。匯率現在只剩一個用途：
        判斷「台幣帳戶轉出」和「外幣帳戶轉入」是不是同一筆轉帳。沒有匯率的話，跨幣別的轉帳
        認不出來，兩隻腳會各自被算成一筆支出和一筆收入。只有台幣或只有外幣帳戶的話，這裡可以留空。
        每筆匯率綁在它自己的日期上，比對時用的是<b>那天（或之前最近一天）</b>的。
      </div>
      <div class="row constrained">
        <label class="field"><span>日期</span><input id="fx-date" type="date" value="${today()}"></label>
        <label class="field"><span>1 USD = ? TWD</span><input id="fx-rate" type="number" step="0.001" placeholder="32.150"></label>
        <button class="primary shrink" id="fx-add">新增</button>
      </div>
      <div class="table-wrap scroll">${
        fx.length
          ? html`<table>
              <thead><tr><th>日期</th><th>幣別對</th><th class="num">匯率</th><th></th></tr></thead>
              <tbody>${fx.map((r) => html`<tr>
                <td>${r.date}</td><td class="dim">${r.pair}</td><td class="num">${nf(r.rate, 4)}</td>
                <td class="num"><button class="sm danger" data-fxdel="${r.date}" data-pair="${r.pair}">刪</button></td>
              </tr>`)}</tbody>
            </table>`
          : empty('還沒有任何匯率。上面新增一筆。')
      }</div>
    </section>

    ${settings.db_path ? html`
    <section class="card">
      <h2 class="sec">自動更新收盤價</h2>
      <div class="note warn">
        這是這個 app <b>唯一會對外連線</b>的功能，<b>預設關閉</b>。打開後，每天第一次啟動服務時會到
        Yahoo 抓你每一檔持股的<b>最新收盤價</b>（收盤後更新最準）——抓取在後端進行，你這個網頁本身仍然不外連。
        過程會把<b>代號</b>送到 Yahoo，所以它會知道你持有哪些股（不含股數、金額）。抓不到的檔維持你手動填的價。
      </div>
      <label class="check">
        <input type="checkbox" id="auto-prices" ${settings.auto_prices ? 'checked' : ''}>
        <span>開啟自動抓收盤價（需連網）</span>
      </label>
      <div class="muted small">
        ${settings.prices_fetched_at
          ? `上次更新：${localTime(settings.prices_fetched_at)}`
          : '尚未抓過。'}
        ${settings.auto_prices ? html` · <button class="sm" id="prices-now">立即更新</button>` : ''}
      </div>
    </section>` : ''}

    ${settings.db_path ? '' : html`
    <section class="card">
      <h2 class="sec">你正在看的是示範資料</h2>
      <div class="note warn">
        這裡的每一個數字都是編出來的——帳戶、商家、金額、日期，沒有一筆來自任何人的對帳單。
        資料只存在這個分頁裡：改得動、匯得進，重新整理就全部回到原狀。
      </div>
      <div class="muted small">
        想真的記帳的話，把這個專案抓回去，<code>node server/index.js</code>，資料就在你自己的
        <code>~/.finance-hub/</code> 裡，一樣不會離開你的電腦。
      </div>
      <div class="toolbar">
        <button id="demo-reset">重設示範資料</button>
      </div>
    </section>`}

    <section class="card">
      <h2 class="sec">備份與匯出</h2>
      <div class="muted small">${settings.db_path
        ? html`資料庫本身就是一個檔：<code>${settings.db_path}</code>。直接複製它就是完整備份。下面是給人看／給 Excel 用的匯出。`
        : html`示範資料沒有檔案可以複製，但下面的匯出是真的——按下去拿到的就是這本帳的內容。`}
      </div>
      <div class="toolbar">
        ${exportLink('完整 JSON 備份', '/api/export/json', 'finance_backup.json')}
        ${exportLink('交易 CSV', '/api/export/csv?type=txns')}
        ${exportLink('持股 CSV', '/api/export/csv?type=holdings')}
        ${exportLink('帳戶 CSV', '/api/export/csv?type=accounts')}
      </div>
    </section>

    <section class="card">
      <h2 class="sec">匯入前自動快照</h2>
      <div class="note">${settings.db_path
        ? html`每次 CSV 匯入前會自動存一份完整資料庫快照到 <code>backups/</code>。
            欄位對應選錯往往是事後才發現，有快照的話回復就只是複製一個檔回去。保留最近 10 份。`
        // Not "backups are disabled" — there is no filesystem to put one in.
        // The import view says the same thing at the moment it matters.
        : html`示範資料沒有檔案系統可以寫，所以匯入前不會有快照。真的在跑的時候會，每次匯入前一份，
            保留最近 10 份——欄位對應選錯往往是事後才發現。`}
      </div>
      <div class="table-wrap">${
        backups.length
          ? html`<table>
              <thead><tr><th>檔名</th><th>建立時間</th><th class="num">大小</th></tr></thead>
              <tbody>${backups.map((b) => html`<tr>
                <td class="small"><code>${b.name}</code></td>
                <td class="dim small">${b.created_at.slice(0, 16).replace('T', ' ')}</td>
                <td class="num dim">${nf(b.bytes / 1024, 1)} KB</td>
              </tr>`)}</tbody>
            </table>`
          // The demo's list is empty and always will be, so the local empty
          // state is a promise it cannot keep: import a CSV here and nothing
          // appears. One sentence up the note says there is nowhere to write
          // one; this used to say a snapshot would show up on the first
          // import, three lines below it.
          : empty(settings.db_path
            ? '還沒有快照。第一次匯入 CSV 時就會產生。'
            : '示範資料不會有快照。')
      }</div>
    </section>

    <section class="card">
      <h2 class="sec">已記住的欄位對應</h2>
      <div class="table-wrap">${
        mappings.length
          ? html`<table>
              <thead><tr><th>名稱</th><th>形式</th><th>日期格式</th><th>最後使用</th><th></th></tr></thead>
              <tbody>${mappings.map((m) => html`<tr>
                <td>${m.name}</td>
                <td class="dim small">${m.config.amountMode === 'inout' ? '支出／存入兩欄' : '單一金額欄'}</td>
                <td class="dim small">${m.config.dateFormat}</td>
                <td class="dim small">${m.used_at ? m.used_at.slice(0, 10) : '—'}</td>
                <td class="num"><button class="sm danger" data-mapdel="${m.id}">刪</button></td>
              </tr>`)}</tbody>
            </table>`
          : empty('還沒有記住任何對應。匯入時在最後一步填名稱就會存起來。')
      }</div>
    </section>

    <section class="card">
      <h2 class="sec">關於</h2>
      <div class="muted small">
        金額一律用原幣顯示，不折算 · schema v${settings.schema_version}<br>
        只監聽 127.0.0.1；預設不對外連線，只有你開啟上面的「自動更新收盤價」後才會（在後端抓）。
        沒有帳號密碼，沒有雲端。關掉這個 terminal 就整個停了。
      </div>
    </section>
  `);

  // Only rendered on the demo, so only wired there.
  const reset = $('#demo-reset');
  if (reset) {
    reset.onclick = () => {
      resetDemo();
      toast('示範資料已重設', 'ok');
      render();
    };
  }

  const auto = $('#auto-prices');
  if (auto) auto.onchange = async () => {
    try {
      await put('/api/settings', { auto_prices: auto.checked });
      toast(auto.checked ? '已開啟自動抓價' : '已關閉', 'ok');
      render();
    } catch (e) { toast(e.message, 'err'); }
  };
  const pricesNow = $('#prices-now');
  if (pricesNow) pricesNow.onclick = async () => {
    pricesNow.disabled = true;
    toast('更新中…');
    try {
      const r = await post('/api/prices/refresh');
      toast(`收盤價：更新 ${r.updated.length} 檔${r.failed.length ? `，${r.failed.length} 檔未更新` : ''}`, 'ok');
      render();
    } catch (e) { toast(e.message, 'err'); }
  };

  $('#fx-add').onclick = async () => {
    const date = $('#fx-date').value;
    const rate = Number($('#fx-rate').value);
    if (!date || !rate) return toast('日期和匯率都要填', 'err');
    try { await post('/api/fx', { date, pair: 'USDTWD', rate }); toast('已新增', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  };
  $$('[data-fxdel]').forEach((b) => (b.onclick = async () => {
    await del(`/api/fx/${b.dataset.fxdel}?pair=${b.dataset.pair}`);
    toast('已刪除', 'ok'); render();
  }));
  $$('[data-mapdel]').forEach((b) => (b.onclick = async () => {
    await del(`/api/mappings/${b.dataset.mapdel}`);
    toast('已刪除', 'ok'); render();
  }));
};
