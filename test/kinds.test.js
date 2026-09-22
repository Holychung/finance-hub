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

describe('帳戶與交易類型', () => {
  it('每一種帳戶類型都有標籤、順序、以及是不是負債', () => {
    assert.ok(K.ACCOUNT_KINDS.length >= 5);
    for (const k of K.ACCOUNT_KINDS) {
      assert.match(k.key, /^[a-z]+$/, `${k.key} 的 key 要是小寫英文`);
      assert.ok(k.label && k.label !== k.key, `${k.key} 沒有中文標籤`);
      assert.equal(typeof k.order, 'number', `${k.key} 沒有排序`);
      assert.equal(typeof k.liability, 'boolean', `${k.key} 沒說是不是負債`);
      assert.equal(K.kindName(k.key), k.label);
    }
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

  it('持股市值有標籤但不是任何一種類型', () => {
    assert.equal(K.kindName('securities'), '持股市值');
    assert.ok(!K.KIND_ORDER.includes('securities'), '它沒有帳戶，不該出現在選單');
    assert.ok(!K.TXN_KIND_ORDER.includes('securities'));
  });
});
