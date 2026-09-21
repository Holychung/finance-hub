'use strict';

// Turning the ledger into a file somebody else can open.
//
// Pure: rows in, a string out. It is here rather than in `server/index.js`
// because a browser with no server behind it still has to produce the same
// bytes — there the string becomes a Blob instead of a response body, and
// the one thing that must not differ between the two is the file.
//
// UTF-8 BOM and CRLF, both for Excel: without the BOM it opens a Chinese
// column as mojibake, and it is the one program most of these files are
// opened in.

(function (root) {
  function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCsv(headers, rows) {
    const lines = [headers.map(csvEscape).join(',')];
    for (const r of rows) lines.push(r.map(csvEscape).join(','));
    return `﻿${lines.join('\r\n')}\r\n`;
  }

  // `accounts` and `holdings` arrive already valued — the output of
  // `computeAccountsWithBalances` and `computeHoldingsValued` — and `txns`
  // already carries `account_name` and `currency`. Whoever calls this did the
  // loading; nothing here knows where a row came from.
  const SHEETS = {
    accounts: {
      name: 'accounts',
      // No 折基準幣 column. It used to be here reading `a.balance_base`, a
      // field nothing has set since conversion was removed — every row
      // exported an empty cell under a header promising a converted figure,
      // and `test/api.test.js` separately asserts the field is gone from the
      // API. An always-empty column headed with a number that does not exist
      // is worse than no column.
      headers: ['帳戶', '類型', '幣別', '期初餘額', '期初日期', '目前餘額'],
      row: (a) => [a.name, a.kind, a.currency, a.opening_balance, a.opening_date, a.balance],
    },
    holdings: {
      name: 'holdings',
      headers: ['帳戶', '市場', '代號', '名稱', '股數', '平均成本', '現價', '市值', '成本', '未實現損益', 'ROI%', '幣別'],
      row: (h) => [h.account_name, h.market, h.symbol, h.name, h.shares, h.avg_cost,
        h.last_price, h.market_value, h.cost_total, h.unrealized, h.roi_pct, h.currency],
    },
    txns: {
      name: 'transactions',
      headers: ['日期', '帳戶', '幣別', '金額', '摘要', '分類', '類型', '轉帳群組', '來源', '備註'],
      row: (t) => [t.date, t.account_name, t.currency, t.amount, t.description,
        t.category, t.kind, t.transfer_group || '', t.source, t.note],
    },
  };

  // Anything unrecognised is transactions, which is what the URL defaults to
  // and what somebody asking for "the export" means.
  function exportCsv({ type, accounts = [], holdings = [], txns = [] }) {
    const sheet = SHEETS[type] || SHEETS.txns;
    const rows = type === 'accounts' ? accounts : type === 'holdings' ? holdings : txns;
    return { name: sheet.name, body: toCsv(sheet.headers, rows.map(sheet.row)) };
  }

  // Dual-environment, the same three lines `web/html.js` ends with: onto the
  // global for the browser's classic scripts, onto module.exports for Node.
  const api = { csvEscape, toCsv, exportCsv, SHEETS };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
