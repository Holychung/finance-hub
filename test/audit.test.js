'use strict';

// 月度審計 over plain arrays: each rule finds what it is for and stays quiet
// on the case that only looks like it — the café twice a day, COFFEE that is
// not a fee, a twin already refunded, a month with no history behind it.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeAudit, computeSubscriptions, isFee, parseAnswers, answerOk, answerCancelled } = require('../shared/audit');

const ACCOUNTS = [
  { id: 1, name: '玉山 信用卡', currency: 'TWD' },
  { id: 2, name: 'Chase Sapphire', currency: 'USD' },
];
const TODAY = '2026-10-12';

let nextId = 1;
const t = (account_id, date, amount, description, extra = {}) =>
  ({ id: nextId++, account_id, date, amount, description, category: '', kind: 'expense', transfer_group: null, ...extra });

const audit = (txns, extra = {}) =>
  computeAudit({ txns, accounts: ACCOUNTS, month: '2026-09', today: TODAY, ...extra });
const ofKind = (r, kind) => r.findings.filter((f) => f.kind === kind);

// Ordinary spending in the months before, so the history-based rules have
// something to compare with: three months of groceries on the TWD card.
const history = () => ['2026-06', '2026-07', '2026-08'].flatMap((m) => [
  t(1, `${m}-08`, -2000, '全聯福利中心', { category: '日用' }),
  t(1, `${m}-18`, -1000, '全聯福利中心', { category: '日用' }),
]);

describe('可能重複扣款', () => {
  it('同一帳戶、同一商家、同金額、隔天又扣一次：問，兩筆都列出來', () => {
    // Case and punctuation do not matter; the grouping is computeRecurring's.
    const [a, b] = [t(1, '2026-09-10', -1290, 'MOMO購物網'), t(1, '2026-09-11', -1290, 'momo購物網.')];
    const [f] = ofKind(audit([...history(), a, b]), 'duplicate');
    assert.equal(f.key, `duplicate|${a.id}|${b.id}`);
    assert.equal(f.severity, 'warn');
    assert.equal(f.amount, 1290);
    assert.deepEqual(f.rows.map((r) => r.id), [a.id, b.id]);
    assert.equal(f.account_name, '玉山 信用卡');
  });

  it('隔了三天就不算；金額差一塊也不算', () => {
    const r = audit([
      t(1, '2026-09-10', -1290, 'MOMO購物網'), t(1, '2026-09-13', -1290, 'MOMO購物網'),
      t(1, '2026-09-20', -500, 'PCHOME'), t(1, '2026-09-20', -501, 'PCHOME'),
    ]);
    assert.deepEqual(ofKind(r, 'duplicate'), []);
  });

  // The café on the way to work: two a day is a habit, not a bank error.
  it('過去一年同一天買兩次已經發生過兩回：是習慣，不問', () => {
    const r = audit([
      t(1, '2026-03-05', -150, '星巴克'), t(1, '2026-03-05', -150, '星巴克'),
      t(1, '2026-05-06', -150, '星巴克'), t(1, '2026-05-06', -150, '星巴克'),
      t(1, '2026-09-09', -150, '星巴克'), t(1, '2026-09-09', -150, '星巴克'),
    ]);
    assert.deepEqual(ofKind(r, 'duplicate'), []);
  });

  it('銀行已經全額退回其中一筆：不問', () => {
    const r = audit([
      t(1, '2026-09-10', -1290, 'MOMO購物網'), t(1, '2026-09-10', -1290, 'MOMO購物網'),
      t(1, '2026-09-24', 1290, 'MOMO購物網 退款'),
    ]);
    assert.deepEqual(ofKind(r, 'duplicate'), []);
  });

  it('轉帳和市值變動不是消費，兩筆一樣也不問', () => {
    const r = audit([
      t(1, '2026-09-10', -5000, '轉出', { transfer_group: 'g1' }), t(1, '2026-09-10', -5000, '轉出', { transfer_group: 'g2' }),
      t(1, '2026-09-30', -80, 'Valuation', { kind: 'valuation' }), t(1, '2026-09-30', -80, 'Valuation', { kind: 'valuation' }),
    ]);
    assert.deepEqual(r.findings, []);
  });
});

describe('固定扣款', () => {
  it('每月的扣款一週內扣了兩次：一期扣了兩次', () => {
    const rows = ['06-05', '07-05', '08-05', '09-05', '09-12'].map((d) => t(1, `2026-${d}`, -149, 'SPOTIFY P0000'));
    const [f] = ofKind(audit(rows), 'double');
    assert.ok(f, '應該要抓到');
    assert.deepEqual(f.rows.map((r) => r.date), ['2026-09-05', '2026-09-12']);
    assert.match(f.detail, /每月/);
  });

  it('價格一直沒變、這個月變貴：漲價，說從多少到多少', () => {
    const rows = [
      ...['06-03', '07-03', '08-03'].map((d) => t(1, `2026-${d}`, -390, 'NETFLIX.COM')),
      t(1, '2026-09-03', -450, 'NETFLIX.COM'),
    ];
    const [f] = ofKind(audit(rows), 'price_up');
    assert.ok(f);
    assert.equal(f.amount, 450);
    assert.match(f.detail, /之前每次 NT\$390，這次 NT\$450，多了 NT\$60/);
  });

  // A bill that follows the weather never holds one price, so a higher month
  // is the bill, not a price rise.
  it('本來就浮動的帳單變高：不算漲價', () => {
    const rows = [[6, -1200], [7, -1350], [8, -1100], [9, -1500]]
      .map(([m, a]) => t(1, `2026-0${m}-15`, a, '台灣電力公司'));
    assert.deepEqual(ofKind(audit(rows), 'price_up'), []);
  });

  it('這個月才湊滿三次：新的固定扣款；上個月還不是', () => {
    const rows = ['07-20', '08-20', '09-20'].map((d) => t(1, `2026-${d}`, -999, 'WORLD GYM'));
    const [f] = ofKind(audit(rows), 'new_series');
    assert.ok(f);
    assert.match(f.detail, /WORLD GYM/);
    const aug = computeAudit({ txns: rows, accounts: ACCOUNTS, month: '2026-08', today: TODAY });
    assert.deepEqual(ofKind(aug, 'new_series'), []);
  });

  it('標記取消之後還扣：取消了還在扣；取消之前的不算', () => {
    const rows = ['06-03', '07-03', '08-03', '09-03'].map((d) => t(1, `2026-${d}`, -390, 'NETFLIX.COM'));
    const r = audit(rows, { cancelled: { '1|netflix com': '2026-08-10' } });
    const [f] = ofKind(r, 'cancelled');
    assert.ok(f);
    assert.equal(f.rows[0].date, '2026-09-03');
    assert.match(f.detail, /2026-08-10/);
    const early = audit(rows, { cancelled: { '1|netflix com': '2026-09-20' } });
    assert.deepEqual(ofKind(early, 'cancelled'), []);
  });
});

describe('分類比平常高很多', () => {
  it('是前幾個月平均的 1.5 倍以上、又佔這個月一成以上：問', () => {
    const r = audit([...history(), t(1, '2026-09-08', -4000, '全聯福利中心', { category: '日用' }), t(1, '2026-09-20', -2500, '家樂福', { category: '日用' })]);
    const [f] = ofKind(r, 'spike');
    assert.ok(f);
    assert.equal(f.category, '日用');
    assert.equal(f.usual, 3000);
    assert.equal(f.amount, 6500);
  });

  // 未分類 grows with bookkeeping — rows not categorised yet, transfers not
  // paired — and those are asked about elsewhere.
  it('未分類不比，就算它多了很多', () => {
    const r = audit([...history(),
      ...['2026-06', '2026-07', '2026-08'].map((m) => t(1, `${m}-12`, -1000, '某筆沒分類的')),
      t(1, '2026-09-12', -9000, '轉出 永豐金證券')]);
    assert.deepEqual(ofKind(r, 'spike'), []);
  });

  // One month before is not a habit to compare against.
  it('前面只有一個月有資料：不說話', () => {
    const r = audit([
      t(1, '2026-08-08', -2000, '全聯福利中心', { category: '日用' }),
      t(1, '2026-09-08', -9000, '全聯福利中心', { category: '日用' }),
    ]);
    assert.deepEqual(ofKind(r, 'spike'), []);
  });
});

describe('大額支出', () => {
  it('比前六個月最大的一筆大兩倍以上：問', () => {
    const big = t(1, '2026-09-15', -48000, 'APPLE STORE');
    const [f] = ofKind(audit([...history(), big]), 'large');
    assert.equal(f.key, `large|${big.id}`);
    assert.match(f.detail, /最大的一筆支出（NT\$2,000）大 2 倍以上/);
  });

  // Two dollars over the biggest grocery run is the same grocery run.
  it('只比之前最大的多一點：不問', () => {
    assert.deepEqual(ofKind(audit([...history(), t(1, '2026-09-15', -2100, '全聯福利中心')]), 'large'), []);
  });

  // A transfer nobody paired yet is the month's biggest "purchase" until it is.
  it('還沒配對的轉帳：所有規則都不算，另外報幾筆', () => {
    const wire = t(1, '2026-09-16', -47611, '轉出 永豐金證券');
    const twin = t(1, '2026-09-16', -47611, '轉出 永豐金證券');
    const r = audit([...history(), wire, twin], { unpaired: [wire.id, twin.id] });
    assert.deepEqual(r.findings, []);
    assert.equal(r.unpaired_in_month, 2);
  });

  // Buying a fund moves money into something still owned; two lots on one
  // day are two lots. Its commission is still a fee.
  it('買賣不是消費：不算最大的一筆、不算重複；但交割手續費照樣列', () => {
    const r = audit([...history(),
      t(1, '2026-09-17', -38000, '證券交割 0050 買進', { kind: 'trade' }),
      t(1, '2026-09-17', -38000, '證券交割 0050 買進', { kind: 'trade' }),
      t(1, '2026-09-17', -54, '證券交割 手續費', { kind: 'trade' })]);
    assert.deepEqual(ofKind(r, 'large'), []);
    assert.deepEqual(ofKind(r, 'duplicate'), []);
    assert.deepEqual(ofKind(r, 'fee').map((f) => f.amount), [54]);
  });

  it('只跟同一個幣別比：沒有美元歷史就不判斷美元', () => {
    const r = audit([...history(), t(2, '2026-09-15', -900, 'BEST BUY')]);
    assert.deepEqual(ofKind(r, 'large').filter((f) => f.currency === 'USD'), []);
  });
});

describe('手續費或利息', () => {
  it('中文的字出現在任何地方都算，英文要是完整的字', () => {
    assert.equal(isFee({ description: '國外交易手續費 0000' }), true);
    assert.equal(isFee({ description: '循環信用利息' }), true);
    assert.equal(isFee({ description: 'ANNUAL FEE' }), true);
    assert.equal(isFee({ description: 'LATE CHARGE' }), true);
    assert.equal(isFee({ description: 'COFFEE BEAN', kind: 'expense' }), false, 'COFFEE 裡的 fee 不算');
    assert.equal(isFee({ description: '轉帳', kind: 'fee' }), true, '類型是手續費也算');
  });

  it('只看支出：存款利息是收入，不問', () => {
    const r = audit([t(1, '2026-09-21', 12, '存款利息', { kind: 'income' }), t(1, '2026-09-25', -45, '國外交易手續費')]);
    assert.deepEqual(ofKind(r, 'fee').map((f) => f.amount), [45]);
  });
});

describe('回答與排序', () => {
  it('回答過沒問題的照樣列出，但標成 ok、排到最後、不算在待處理裡', () => {
    const [a, b] = [t(1, '2026-09-10', -1290, 'MOMO購物網'), t(1, '2026-09-11', -1290, 'MOMO購物網')];
    const fee = t(1, '2026-09-25', -45, '國外交易手續費');
    const before = audit([a, b, fee]);
    assert.equal(before.open, 2);
    assert.equal(before.findings[0].kind, 'duplicate', 'warn 排在 note 前面');
    const after = audit([a, b, fee], { ok: [`duplicate|${a.id}|${b.id}`] });
    assert.equal(after.open, 1);
    assert.equal(after.findings.at(-1).kind, 'duplicate');
    assert.equal(after.findings.at(-1).ok, true);
  });

  it('還沒過完的月份算到今天；還沒開始的月份什麼都沒有', () => {
    const run = computeAudit({ txns: [t(1, '2026-10-20', -45, '手續費')], accounts: ACCOUNTS, month: '2026-10', today: TODAY });
    assert.equal(run.running, true);
    assert.equal(run.to, TODAY);
    assert.deepEqual(run.findings, [], '今天之後的那一筆還不算');
    const later = computeAudit({ txns: [], accounts: ACCOUNTS, month: '2026-11', today: TODAY });
    assert.equal(later.future, true);
  });
});

describe('主人的回答', () => {
  it('讀不懂的存檔當成還沒有回答，不讓頁面掛掉', () => {
    assert.deepEqual(parseAnswers('', ''), { ok: [], cancelled: {} });
    assert.deepEqual(parseAnswers('{oops', '[1,2]'), { ok: [], cancelled: {} });
    assert.deepEqual(parseAnswers('["fee|3", 4]', '{"1|netflix com":"2026-08-10"}'),
      { ok: ['fee|3'], cancelled: { '1|netflix com': '2026-08-10' } });
  });

  it('沒問題：加上、拿掉；不認得的項目和不是布林的 ok 都拒絕', () => {
    assert.deepEqual(answerOk([], { key: 'fee|3', ok: true }), { value: ['fee|3'] });
    assert.deepEqual(answerOk(['fee|3'], { key: 'fee|3', ok: false }), { value: [] });
    assert.ok(answerOk([], { key: 'nope|3', ok: true }).error);
    assert.ok(answerOk([], { key: 'fee|3', ok: 'yes' }).error);
  });

  it('取消：記下日期、null 拿掉；壞日期和不像扣款的 series 都拒絕', () => {
    assert.deepEqual(answerCancelled({}, { series: '1|netflix com', since: '2026/08/10' }), { value: { '1|netflix com': '2026-08-10' } });
    assert.deepEqual(answerCancelled({ '1|netflix com': '2026-08-10' }, { series: '1|netflix com', since: null }), { value: {} });
    assert.match(answerCancelled({}, { series: '1|netflix com', since: 'soon' }).error, /日期無法解析/);
    assert.ok(answerCancelled({}, { series: 'netflix', since: '2026-08-10' }).error);
  });
});

describe('可以標記取消的訂閱', () => {
  it('列出還在扣的固定扣款，帶著 series 和取消的日期', () => {
    const rows = ['07-03', '08-03', '09-03', '10-03'].map((d) => t(1, `2026-${d}`, -390, 'NETFLIX.COM'));
    const { items } = computeSubscriptions({ txns: rows, accounts: ACCOUNTS, today: TODAY, cancelled: { '1|netflix com': '2026-10-05' } });
    assert.equal(items.length, 1);
    assert.equal(items[0].series, '1|netflix com');
    assert.equal(items[0].cancelled_since, '2026-10-05');
  });
});
