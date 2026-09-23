'use strict';

// Run with:  node --test
//
// shared/kinds.js is a list, so the tests are about the list being complete
// and about the rules encoded in it rather than about arithmetic. The reason
// it exists is that the list used to be seven copies and nothing failed when
// one was missed; these are the assertions that make a miss fail.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const K = require('../shared/kinds');
const M = require('../shared/money');
const C = require('../shared/currency');

describe('帳戶與交易類型', () => {
  it('每一種帳戶類型都有標籤、順序、以及是不是負債', () => {
    assert.ok(K.ACCOUNT_KINDS.length >= 5);
    for (const k of K.ACCOUNT_KINDS) {
      assert.match(k.key, /^[a-z]+$/, `${k.key} 的 key 要是小寫英文`);
      assert.ok(k.label && k.label !== k.key, `${k.key} 沒有中文標籤`);
      assert.equal(typeof k.order, 'number', `${k.key} 沒有排序`);
      assert.equal(typeof k.liability, 'boolean', `${k.key} 沒說是不是負債`);
      assert.equal(typeof k.holds, 'boolean', `${k.key} 沒說能不能放持股`);
      assert.ok(K.ACCESS_KEYS.includes(k.access), `${k.key} 的預設 access「${k.access}」不在清單上`);
      assert.equal(typeof k.taxAdvantaged, 'boolean', `${k.key} 沒說有沒有稅務性質`);
      assert.equal(typeof k.statements, 'boolean', `${k.key} 沒說有沒有對帳單可以匯`);
      assert.equal(K.kindName(k.key), k.label);
    }
  });

  // The kind only says where a new account starts; the account's own access
  // is what counts. Retirement is the one kind that starts behind a rule.
  it('退休金一開始就是受限制，其他類型一開始可動用，不認得的類型也是', () => {
    assert.equal(K.defaultAccessFor('retirement'), 'restricted');
    for (const k of K.ACCOUNT_KINDS.filter((x) => x.key !== 'retirement')) {
      assert.equal(K.defaultAccessFor(k.key), 'liquid', k.key);
    }
    assert.equal(K.defaultAccessFor('nope'), K.DEFAULT_ACCESS);
    assert.equal(K.defaultAccessFor(undefined), K.DEFAULT_ACCESS);
  });

  // What leaves the coverage grid. Derived from the flag, like every other set
  // here, so a kind added without statements leaves the grid too.
  it('沒有對帳單的類型是從旗標推出來的：目前只有錢包', () => {
    const flagged = K.ACCOUNT_KINDS.filter((k) => !k.statements).map((k) => k.key).sort();
    assert.deepEqual([...K.NO_STATEMENT_KINDS].sort(), flagged);
    assert.deepEqual([...K.NO_STATEMENT_KINDS], ['wallet']);
  });

  it('有稅務性質的類型是從旗標推出來的', () => {
    const flagged = K.ACCOUNT_KINDS.filter((k) => k.taxAdvantaged).map((k) => k.key).sort();
    assert.deepEqual([...K.TAX_ADVANTAGED_KINDS].sort(), flagged);
    assert.ok(K.TAX_ADVANTAGED_KINDS.has('retirement'));
  });

  it('稅務性質只有三種，各有標籤；認不得的回傳原字串', () => {
    assert.deepEqual(K.TAX_STATUS_KEYS, ['pretax', 'roth', 'aftertax']);
    for (const t of K.TAX_STATUS) assert.ok(t.label, `${t.key} 沒有標籤`);
    assert.equal(K.taxStatusName('pretax'), '稅前');
    assert.equal(K.taxStatusName('401k'), '401k');
  });

  // The holdings page used to hardcode `kind === 'brokerage'`, so the first
  // account of another kind that held something could not be given a holding.
  it('能放持股的帳戶類型是從 holds 旗標推出來的，錢包是其中之一', () => {
    const flagged = K.ACCOUNT_KINDS.filter((k) => k.holds).map((k) => k.key).sort();
    assert.deepEqual([...K.HOLDING_KINDS].sort(), flagged);
    assert.ok(K.HOLDING_KINDS.has('brokerage') && K.HOLDING_KINDS.has('wallet'));
    assert.ok(!K.HOLDING_KINDS.has('cash'), '活存不放持股');
  });

  it('排序沒有並列，不然側邊欄的群組順序會看載入順序決定', () => {
    const orders = K.ACCOUNT_KINDS.map((k) => k.order);
    assert.equal(new Set(orders).size, orders.length);
  });

  it('KIND_ORDER 就是那份清單，不是另一份手寫的', () => {
    const expected = [...K.ACCOUNT_KINDS].sort((a, b) => a.order - b.order).map((k) => k.key);
    assert.deepEqual(K.KIND_ORDER, expected);
    assert.ok(K.KIND_ORDER.includes(K.DEFAULT_ACCOUNT_KIND), '預設的類型要在選單裡');
  });

  // The sign convention, not a display choice: a balance is what the account
  // is worth to you, so one you owe on is negative. Deriving the set from the
  // flag is what stops a new liability kind being added without it.
  it('負債的集合是從 liability 旗標推出來的', () => {
    const flagged = K.ACCOUNT_KINDS.filter((k) => k.liability).map((k) => k.key).sort();
    assert.deepEqual([...K.LIABILITY_KINDS].sort(), flagged);
    assert.ok(K.LIABILITY_KINDS.has('card') && K.LIABILITY_KINDS.has('loan'));
  });

  it('shared/money.js 匯出的是同一個集合，不是複製品', () => {
    assert.equal(M.LIABILITY_KINDS, K.LIABILITY_KINDS, '應該是同一個 Set 實例');
  });

  // Pairing decides this, and unlinking removes it. A per-row picker offering
  // it would let one transaction claim to be half of a pair that does not
  // exist — and transfers are excluded from spending, so the row would quietly
  // leave the totals.
  it('轉帳不能手動選，它是配對得出的結論', () => {
    assert.ok(!K.TXN_KIND_ORDER.includes('transfer'));
    assert.equal(K.TXN_KINDS.find((k) => k.key === 'transfer').pickable, false);
    assert.equal(K.kindName('transfer'), '轉帳', '不能選不代表不用顯示');
  });

  it('交易類型選單以「其他」開頭，因為那是不知道時的誠實答案', () => {
    assert.equal(K.TXN_KIND_ORDER[0], K.DEFAULT_TXN_KIND);
    assert.equal(K.DEFAULT_TXN_KIND, 'other');
  });

  it('每一種交易類型都有標籤', () => {
    for (const k of K.TXN_KINDS) {
      assert.ok(k.label && k.label !== k.key, `${k.key} 沒有中文標籤`);
      assert.equal(typeof k.pickable, 'boolean', `${k.key} 沒說能不能手動選`);
    }
  });

  it('認不得的類型回傳原字串，而不是假裝它是「其他」', () => {
    assert.equal(K.kindName('crypto-wallet'), 'crypto-wallet');
    assert.equal(K.kindName(''), '');
  });

  it('access 只有兩個值，預設是 liquid，而且各有標籤', () => {
    assert.deepEqual(K.ACCESS_KEYS, ['liquid', 'restricted']);
    assert.ok(K.ACCESS_KEYS.includes(K.DEFAULT_ACCESS));
    assert.equal(K.DEFAULT_ACCESS, 'liquid', '既有帳戶都是 liquid，預設換掉會讓升級改變數字');
    for (const k of K.ACCESS_KEYS) assert.notEqual(K.accessName(k), k, `${k} 沒有中文標籤`);
    assert.equal(K.accessName('nope'), 'nope');
  });

  // `/api/prices` upper-cases the market and holdings now do too. A key that
  // was not already upper case would be stored in one case and looked up in
  // another, and its price history would silently never apply.
  it('每個市場的 key 都是大寫，而且預設幣別是教過的幣別', () => {
    assert.ok(K.MARKETS.length >= 3);
    for (const m of K.MARKETS) {
      assert.equal(m.key, m.key.toUpperCase(), `${m.key} 要是大寫`);
      assert.ok(m.label && m.unit && m.per, `${m.key} 少了標籤`);
      assert.ok(C.CURRENCY_CODES.includes(m.currency), `${m.key} 的 ${m.currency} 不在幣別清單裡，表單選不到`);
      assert.ok(Number.isInteger(m.decimals) && m.decimals >= 0 && m.decimals <= C.MAX_DECIMALS,
        `${m.key} 的小數位數 ${m.decimals} 超出範圍`);
    }
    assert.deepEqual(K.MARKET_KEYS, K.MARKETS.map((m) => m.key));
    assert.ok(K.MARKET_KEYS.includes(K.DEFAULT_MARKET));
  });

  it('幣的數量是八位，台股是整股', () => {
    assert.equal(K.marketInfo('CRYPTO').decimals, 8);
    assert.equal(K.marketInfo('TW').decimals, 0);
    assert.equal(K.marketInfo('crypto'), null, '查詢不幫你轉大寫——那是 API 的事，這裡只認清單上的');
  });

  it('持股市值和未歸屬有標籤，但不是任何一種類型', () => {
    assert.equal(K.kindName('securities'), '持股市值');
    assert.equal(K.kindName('unvested'), '未歸屬');
    for (const extra of ['securities', 'unvested']) {
      assert.ok(!K.KIND_ORDER.includes(extra), `${extra} 沒有帳戶，不該出現在選單`);
      assert.ok(!K.TXN_KIND_ORDER.includes(extra));
    }
  });
});
