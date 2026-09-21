'use strict';

// Run with:  node --test
//
// The file somebody else opens. `shared/export.js` is pure — rows in, a
// string out — so the bytes can be asserted directly instead of through a
// download, and the browser will produce the same ones from the same
// function when there is no server to stream them.
//
// Until this existed only the transactions export was covered, and only for
// its BOM. That is how an always-empty `折基準幣` column survived in the
// accounts sheet: nothing ever read the header row back.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { toCsv, csvEscape, exportCsv } = require('../shared/export');

const BOM = '﻿';
const lines = (body) => body.replace(/^﻿/, '').replace(/\r\n$/, '').split('\r\n');

describe('CSV 的位元組', () => {
  it('開頭有 BOM，換行是 CRLF，結尾也有一個', () => {
    const body = toCsv(['a', 'b'], [[1, 2]]);
    assert.ok(body.startsWith(BOM), 'Excel 沒有 BOM 就把中文開成亂碼');
    assert.equal(body, `${BOM}a,b\r\n1,2\r\n`);
  });

  it('逗號、引號、換行都包起來，引號加倍', () => {
    assert.equal(csvEscape('plain'), 'plain');
    assert.equal(csvEscape('a,b'), '"a,b"');
    assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
    assert.equal(csvEscape('two\nlines'), '"two\nlines"');
    assert.equal(csvEscape(null), '');
    assert.equal(csvEscape(undefined), '');
    assert.equal(csvEscape(0), '0', '零是零，不是空字串');
  });

  it('摘要裡帶逗號的那一行不會把欄位撞開', () => {
    // The shape this project spends most of its parsing budget on, now from
    // the writing end: a description that contains the delimiter.
    const { body } = exportCsv({
      type: 'txns',
      txns: [{ date: '2026-09-21', account_name: '活存', currency: 'TWD', amount: -1234.5,
        description: 'CAFE, TAIPEI', category: '', kind: 'expense', transfer_group: null,
        source: 'csv', note: '' }],
    });
    const row = lines(body)[1];
    assert.ok(row.includes('"CAFE, TAIPEI"'));
    assert.equal(row.split(',').length, 11, '一個被引號包住的逗號不該多切出一欄以外的東西');
  });
});

describe('三張表的欄位', () => {
  const accounts = [{ name: '台幣活存', kind: 'cash', currency: 'TWD', opening_balance: 1000,
    opening_date: '2026-01-01', balance: 1234.56 }];
  const holdings = [{ account_name: '券商', market: 'US', symbol: 'VTI', name: 'Vanguard Total',
    shares: 10, avg_cost: 200, last_price: 250, market_value: 2500, cost_total: 2000,
    unrealized: 500, roi_pct: 25, currency: 'USD' }];
  const txns = [{ date: '2026-09-21', account_name: '活存', currency: 'TWD', amount: -100,
    description: '午餐', category: '食', kind: 'expense', transfer_group: null, source: 'csv', note: '' }];

  // The regression. `折基準幣` read `a.balance_base`, which nothing has set
  // since conversion was removed — `test/api.test.js` separately asserts the
  // field is gone from the API — so every exported row carried an empty cell
  // under a header promising a converted figure.
  it('帳戶表沒有「折基準幣」那一欄', () => {
    const { body, name } = exportCsv({ type: 'accounts', accounts });
    assert.equal(name, 'accounts');
    assert.deepEqual(lines(body)[0].split(','),
      ['帳戶', '類型', '幣別', '期初餘額', '期初日期', '目前餘額']);
    assert.deepEqual(lines(body)[1].split(','),
      ['台幣活存', 'cash', 'TWD', '1000', '2026-01-01', '1234.56']);
    assert.ok(!body.includes('折基準幣'), '這個欄位永遠是空的，而且標題在說謊');
    assert.ok(!lines(body)[1].endsWith(','), '不該有一個懸空的空欄位');
  });

  it('持股表帶市值與報酬率', () => {
    const { body, name } = exportCsv({ type: 'holdings', holdings });
    assert.equal(name, 'holdings');
    assert.equal(lines(body)[0].split(',').length, 12);
    assert.deepEqual(lines(body)[1].split(','),
      ['券商', 'US', 'VTI', 'Vanguard Total', '10', '200', '250', '2500', '2000', '500', '25', 'USD']);
  });

  it('交易表的轉帳群組是空的就寫空字串，不是 null', () => {
    const { body, name } = exportCsv({ type: 'txns', txns });
    assert.equal(name, 'transactions', '檔名是 transactions，不是 txns');
    assert.ok(!body.includes('null'), 'null 會被使用者當成一個真的值');
    assert.equal(lines(body)[1].split(',')[7], '');
  });

  it('不認得的 type 當成交易，跟網址的預設一致', () => {
    const a = exportCsv({ type: 'nonsense', txns });
    const b = exportCsv({ type: 'txns', txns });
    assert.equal(a.body, b.body);
    assert.equal(a.name, 'transactions');
  });

  it('沒有資料時只剩標題列', () => {
    const { body } = exportCsv({ type: 'accounts' });
    assert.deepEqual(lines(body), ['帳戶,類型,幣別,期初餘額,期初日期,目前餘額']);
  });
});
