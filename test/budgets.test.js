'use strict';

// Run with:  node --test
//
// A budget is a number the user typed; the only thing worth testing is what
// "spent" means against it, and the answer is meant to be "whatever the
// breakdown on the same page says for that month". So most of these hold
// computeBudgets against computeSpending over the same window rather than
// against numbers worked out by hand — the claim is that there is one set of
// filters, and a second one that agreed today would pass a hand-worked test
// just as well.
//
// Pure, like everything in shared/: rows in, an answer out, no database.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SP = require('../shared/spending');

const accounts = [
  { id: 1, name: '活存', currency: 'TWD' },
  { id: 2, name: '信用卡', currency: 'TWD' },
  { id: 3, name: 'Checking', currency: 'USD' },
];

const t = (account_id, date, amount, category = '', extra = {}) => ({
  account_id, date, amount, description: `${category || 'row'} ${date}`, category,
  kind: 'expense', transfer_group: null, ...extra,
});

// August is the month under test; July and September are the neighbours a
// wrong window would pick up.
const txns = [
  t(2, '2026-07-31', -900, '外食'),
  t(2, '2026-08-01', -420, '外食'),
  t(2, '2026-08-15', -380, '外食'),
  t(2, '2026-08-31', -250, '外食'),
  t(2, '2026-09-01', -700, '外食'),
  // A refund is an inflow, the way the breakdown counts it: it does not shrink
  // what was spent, and it is not a negative expense.
  t(2, '2026-08-20', 150, '外食', { kind: 'income' }),
  t(2, '2026-08-05', -1850, '食品雜貨'),
  t(2, '2026-08-19', -2150, '食品雜貨'),
  // The same category name in dollars is a different budget, not this one.
  t(3, '2026-08-10', -84.2, '外食'),
  t(3, '2026-08-11', -46.8, 'Gas'),
  // Neither of these is spending: a transfer's leg and a change in value.
  t(1, '2026-08-12', -5000, '外食', { kind: 'transfer', transfer_group: 'g1' }),
  t(1, '2026-08-13', -3000, '外食', { kind: 'transfer' }),
  t(1, '2026-08-31', -4200, '外食', { kind: 'valuation' }),
  // Nothing budgets these, so they are the unbudgeted figure: rent with no
  // category, and a category nobody set a budget for.
  t(1, '2026-08-06', -28000, ''),
  t(2, '2026-08-21', -799, '電信'),
];

const budgets = [
  { id: 1, category: '外食', currency: 'TWD', amount: 1000 },
  { id: 2, category: '食品雜貨', currency: 'TWD', amount: 5000 },
  { id: 3, category: '外食', currency: 'USD', amount: 120 },
  { id: 4, category: 'Travel', currency: 'USD', amount: 100 },
];

const august = SP.computeBudgets({ budgets, txns, accounts, month: '2026-08', today: '2026-09-25' });
const item = (res, cur, category) => res.currencies[cur].items.find((i) => i.category === category);

describe('預算：花掉的就是分類明細那一格', () => {
  it('每一條預算的「已花」跟同一個月的分類明細一模一樣', () => {
    const sp = SP.computeSpending({ txns, accounts, from: '2026-08-01', to: '2026-08-31' });
    for (const b of budgets) {
      const want = (sp.currencies[b.currency].categories.find((c) => c.category === b.category) || { total: 0, count: 0 });
      const got = item(august, b.currency, b.category);
      assert.equal(got.spent, want.total, `${b.currency} ${b.category}`);
      assert.equal(got.count, want.count, `${b.currency} ${b.category} 的筆數`);
    }
  });

  it('只算那一個月：前一天、後一天都不算', () => {
    assert.equal(item(august, 'TWD', '外食').spent, 1050, '420 + 380 + 250，7/31 和 9/1 不在裡面');
  });

  it('轉帳和市值變動不算，不管它們掛在哪個分類', () => {
    // 5000 + 3000 + 4200 would all land on 外食 if either filter were skipped.
    assert.equal(item(august, 'TWD', '外食').count, 3);
  });

  it('退款是收入，不會從已花扣掉', () => {
    assert.equal(item(august, 'TWD', '外食').spent, 1050, '不是 900');
  });

  it('同一個分類名稱，另一個幣別的預算各算各的', () => {
    assert.equal(item(august, 'USD', '外食').spent, 84.2);
    assert.equal(item(august, 'TWD', '外食').spent, 1050, '美元那筆沒有混進來');
  });

  it('剩多少：超支是負的，百分比不會被壓在 100', () => {
    const over = item(august, 'TWD', '外食');
    assert.equal(over.remaining, -50);
    assert.equal(over.used_pct, 105);
    const under = item(august, 'TWD', '食品雜貨');
    assert.equal(under.remaining, 1000, '1850 + 2150 = 4000，預算 5000');
    assert.equal(under.used_pct, 80);
    const none = item(august, 'USD', 'Travel');
    assert.deepEqual([none.spent, none.count, none.remaining, none.used_pct], [0, 0, 100, 0],
      '那個月一毛都沒花的預算還是要列出來');
  });

  it('沒編預算的支出另外給一個數字，未分類也在裡面', () => {
    assert.deepEqual(august.currencies.TWD.unbudgeted, { total: 28799, count: 2 }, '房租 28000 + 電信 799');
    assert.deepEqual(august.currencies.USD.unbudgeted, { total: 46.8, count: 1 });
    assert.equal(august.currencies.TWD.budgeted, 6000);
    assert.equal(august.currencies.TWD.spent, 5050);
  });

  it('幣別各自一塊，沒有任何跨幣別的總數', () => {
    assert.deepEqual(Object.keys(august).sort(),
      ['currencies', 'days_elapsed', 'days_in_month', 'from', 'month', 'order', 'running', 'to']);
    assert.deepEqual(august.order, ['USD', 'TWD']);
  });

  it('大的預算排前面，一樣大就照名稱', () => {
    const tie = SP.computeBudgets({
      budgets: [
        { id: 1, category: 'b', currency: 'TWD', amount: 500 },
        { id: 2, category: 'a', currency: 'TWD', amount: 500 },
        { id: 3, category: 'c', currency: 'TWD', amount: 900 },
      ],
      txns: [], accounts, month: '2026-08', today: '2026-09-25',
    });
    assert.deepEqual(tie.currencies.TWD.items.map((i) => i.category), ['c', 'a', 'b']);
  });

  it('有支出但還沒編預算的幣別也在，只是沒有任何一條', () => {
    const res = SP.computeBudgets({ budgets: [], txns, accounts, month: '2026-08', today: '2026-09-25' });
    assert.deepEqual(res.currencies.TWD.items, []);
    assert.equal(res.currencies.TWD.unbudgeted.total, 28799 + 1050 + 4000);
  });
});

describe('預算：本月進行中', () => {
  it('過完的月份沒有「過了幾天」，進行中的才有', () => {
    assert.equal(august.running, false);
    assert.equal(august.days_elapsed, null);
    assert.equal(august.days_in_month, 31);

    const sept = SP.computeBudgets({ budgets, txns, accounts, month: '2026-09', today: '2026-09-25' });
    assert.equal(sept.running, true);
    assert.equal(sept.days_elapsed, 25);
    assert.equal(sept.days_in_month, 30);
    assert.equal(sept.to, '2026-09-25', '進行中的月份算到今天，跟消費頁的窗口一樣');
  });

  it('今天之後的列不算：還沒發生的不是已花', () => {
    const sept = SP.computeBudgets({
      budgets, accounts, month: '2026-09', today: '2026-09-10',
      txns: [t(2, '2026-09-09', -300, '外食'), t(2, '2026-09-11', -400, '外食')],
    });
    assert.equal(item(sept, 'TWD', '外食').spent, 300);
  });

  it('還沒開始的月份什麼都不算，也沒有刻度', () => {
    const later = SP.computeBudgets({ budgets, txns, accounts, month: '2026-11', today: '2026-09-25' });
    assert.equal(later.running, false);
    assert.equal(later.days_elapsed, null);
    assert.ok(later.currencies.TWD.items.every((i) => i.spent === 0));
  });

  it('二月有二十八天，閏年二十九天', () => {
    assert.equal(SP.computeBudgets({ budgets: [], txns: [], accounts, month: '2026-02', today: '2026-09-25' }).days_in_month, 28);
    assert.equal(SP.computeBudgets({ budgets: [], txns: [], accounts, month: '2028-02', today: '2026-09-25' }).days_in_month, 29);
  });
});
