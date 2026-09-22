'use strict';

// Run with:  node --test
//
// Two decimal places used to be written into the arithmetic in three files and
// into the formatter as a ternary on 'USD'. These are the assertions that the
// scale is now a property of the currency, and that the arithmetic still does
// exactly what the three copies did.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const C = require('../shared/currency');
const M = require('../shared/money');

describe('幣別與精度', () => {
  it('小數位數跟著幣別，不是跟著「是不是美元」', () => {
    assert.equal(C.decimalsOf('TWD'), 0, '台幣報整數');
    assert.equal(C.decimalsOf('USD'), 2);
    assert.equal(C.decimalsOf('usd'), 2, '大小寫不該有差');
  });

  // The old ternary wrote NT$ for everything that was not USD, so a JPY
  // balance read as NT$1,234 — the right number in the wrong country.
  it('沒教過的幣別用自己的代號，不會假裝是台幣', () => {
    assert.equal(C.symbolOf('JPY'), 'JPY ');
    assert.equal(C.symbolOf('BTC'), 'BTC ');
    assert.notEqual(C.symbolOf('JPY'), C.symbolOf('TWD'));
    assert.equal(C.decimalsOf('JPY'), C.DEFAULT_DP, '不知道就用兩位，不是零位');
  });

  it('幣別清單是一份，表單從它來', () => {
    assert.deepEqual(C.CURRENCY_CODES, Object.keys(C.CURRENCIES));
    assert.ok(C.CURRENCY_CODES.includes('TWD') && C.CURRENCY_CODES.includes('USD'));
  });

  it('round2 跟它取代的那三份複本算出同一個答案', () => {
    const old = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    for (const n of [0, 1, -1, 1.005, 2.675, -1.005, 0.1 + 0.2, 1234.5678, -0.004, 1e6 + 0.555]) {
      assert.equal(C.round2(n), old(n), `round2(${n})`);
    }
  });

  it('round2 就是兩位的 roundTo', () => {
    for (const n of [1.005, 2.675, -1.005, 0.1 + 0.2]) {
      assert.equal(C.round2(n), C.roundTo(n, 2));
    }
  });

  // The reason the scale became a parameter at all.
  it('八位小數留得住，這是幣要用的', () => {
    assert.equal(C.roundTo(0.000000015, 8), 0.00000002);
    assert.equal(C.roundTo(0.00000001, 8), 0.00000001);
    assert.equal(C.roundTo(0.00000001, 2), 0, '兩位的話它就不見了，所以才要參數化');
    assert.equal(C.roundTo(1.123456789, 8), 1.12345679);
  });

  it('零位是整數，負數也照樣', () => {
    assert.equal(C.roundTo(1234.6, 0), 1235);
    assert.equal(C.roundTo(-1234.6, 0), -1235);
  });

  it('shared/money.js 用的是同一個 round2，不是自己一份', () => {
    assert.equal(M.round2, C.round2);
  });
});

describe('數量的顯示', () => {
  it('整數不加小數點', () => {
    assert.equal(C.quantity(3000), '3,000');
    assert.equal(C.quantity(0), '0');
  });

  it('尾隨的零去掉，有意義的位數留著', () => {
    assert.equal(C.quantity(1.5), '1.5');
    assert.equal(C.quantity(1.2500, 4), '1.25');
  });

  // The old rule showed four places whenever the number had any fraction.
  it('八位的幣不會被壓成四位', () => {
    assert.equal(C.quantity(0.00000001, 8), '0.00000001');
    assert.equal(C.quantity(0.00000001, 4), '0', '位數不夠時它就是 0 —— 所以位數要傳對');
    assert.equal(C.quantity(1.23456789, 8), '1.23456789');
  });

  it('沒有數字就是破折號，不是 0', () => {
    for (const n of [null, undefined, NaN]) assert.equal(C.quantity(n), '—');
  });

  // A whole-share market rounds a fractional count to a whole one — and at
  // zero places `toFixed` writes no point, so stripping trailing zeros anyway
  // turned 1,000 into 1.
  it('零位小數時，千位數的零不會被當成尾隨的零削掉', () => {
    assert.equal(C.quantity(1000.4, 0), '1,000');
    assert.equal(C.quantity(1200.6, 0), '1,201');
  });
});

describe('單價的顯示', () => {
  it('至少兩位，跟以前一樣', () => {
    assert.equal(C.unitPrice(612), '612.00');
    assert.equal(C.unitPrice(248.5), '248.50');
    assert.equal(C.unitPrice(63250.4), '63,250.40');
  });

  // The reason this is not `nf(price, 2)`: a coin under a dollar is quoted
  // past the cent, and two places reported it as 0.12 or as 0.00.
  it('兩位之後，數字本身帶幾位就顯示幾位', () => {
    assert.equal(C.unitPrice(0.1234), '0.1234');
    assert.equal(C.unitPrice(0.00001234), '0.00001234');
    assert.equal(C.unitPrice(51833.125), '51,833.125');
  });

  // Past a number's precision `toFixed` writes out the float's binary
  // expansion; measuring the places instead is what keeps that off screen.
  it('浮點數的雜訊不會變成多出來的位數', () => {
    assert.equal(C.unitPrice(1234567.891), '1,234,567.891');
    assert.equal(C.unitPrice(0.1 + 0.2), '0.30');
  });

  it('最多十位，而且沒有數字就是破折號', () => {
    assert.equal(C.unitPrice(1 / 3), '0.3333333333');
    for (const n of [null, undefined, NaN]) assert.equal(C.unitPrice(n), '—');
  });
});
