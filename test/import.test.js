'use strict';

// Run with:  node --test
//
// The rule deciding whether a file goes straight into the ledger, over plain
// rows. The page writes a clean file without asking, so everything a person
// used to catch by looking at the preview has to be caught here instead —
// and the failure this guards against is the quiet one: a file that parses
// perfectly and is still wrong.
//
// The rows are read by shared/csv.js where a statement's shape is the point,
// and written by hand where only the status matters.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const csv = require('../shared/csv');
const I = require('../shared/import');

// Read a little CSV the way the server does, against an empty account.
const read = (text, mapping = null) => {
  const grid = csv.parseCsv(text, ',');
  const headerRow = csv.detectHeaderRow(grid);
  const m = mapping || { ...csv.guessMapping(grid[headerRow - 1], grid.slice(headerRow)), headerRow };
  const { rows } = csv.extractRows(grid, m, 1);
  csv.markDuplicates(rows, { fingerprints: new Map(), externalIds: new Set() });
  return { rows, mapping: m };
};

// Summary and issues for a reading, with the two balances the loader would
// have fetched.
const judge = ({ rows, mapping }, { account = { id: 1, kind: 'cash' }, before = 0, ledgerOn = 0 } = {}) => {
  const { summary, reconcile } = I.computeImportSummary({ rows, account, before, ledgerOn });
  return { summary, reconcile, issues: I.importIssues({ summary, reconcile, rows, mapping }) };
};
const codes = (j) => j.issues.map((i) => i.code);

const STMT = 'Date,Description,Amount,Balance\n2026-03-02,PAY,100,1100\n2026-03-05,RENT,-400,700\n2026-03-09,COFFEE,-5,695\n';

describe('對帳單自己寫的合計與期初餘額', () => {
  it('玉山的「合計」是合計列，不是解析失敗', () => {
    const { rows } = read('交易日期,摘要,支出金額,存入金額,餘額\n115/07/01,薪資,,"1,000",2000\n合計,,0,1000,\n');
    const footer = rows[rows.length - 1];
    assert.equal(footer.status, 'summary_line');
    assert.equal(footer.fingerprint, null, '它從頭到尾都不會被匯入');
  });

  it('英文的 Total 也是', () => {
    const { rows } = read('Date,Description,Amount\n2026-03-02,A,-1\nTotal,,-1\n');
    assert.equal(rows[1].status, 'summary_line');
  });

  it('有日期、有餘額、沒有金額、而且自己說是 balance 的那行是期初餘額列', () => {
    const { rows } = read('Date,Description,Amount,Running Bal.\n04/01/2025,Beginning balance as of 04/01/2025,,"48,250.00"\n04/02/2025,X,-1,"48,249.00"\n');
    assert.equal(rows[0].status, 'summary_line');
  });

  it('沒有說自己是什麼的壞行還是解析失敗', () => {
    const { rows } = read('Date,Description,Amount,Balance\n2026-03-02,SOMETHING,,500\nnot a date,B,-2,498\n');
    assert.deepEqual(rows.map((r) => r.status), ['error', 'error']);
  });

  // A real transaction whose amount cell is mangled, described with the word
  // balance in it. Relabelled, it would vanish from the import with the result
  // calling it the statement's own line — so it has to stay a refusal, which
  // is what makes somebody look at it.
  it('金額欄壞掉、摘要剛好有 balance 的真交易，還是讀不出來，不是期初餘額列', () => {
    const { rows } = read('Date,Description,Amount,Balance\n2026-03-01,A,-1,999\n2026-03-02,MINIMUM BALANCE FEE,12O.00,987\n2026-03-03,B,-2,985\n');
    assert.equal(rows[1].status, 'error');
  });

  it('金額欄空著、但描述不是在講餘額的行，也還是讀不出來', () => {
    const { rows } = read('Date,Description,Amount,Balance\n2026-03-01,A,-1,999\n2026-03-02,BALANCE TRANSFER,,999\n');
    assert.equal(rows[1].status, 'error');
  });

  it('期末餘額、期初餘額這種中文寫法也認得', () => {
    const { rows } = read('交易日期,摘要,支出金額,存入金額,餘額\n115/07/01,期初餘額,,,1000\n115/07/02,薪資,,"1,000",2000\n');
    assert.equal(rows[0].status, 'summary_line');
  });

  it('「Balance transfer」這種有金額的交易就是交易', () => {
    const { rows } = read('Date,Description,Amount\n2026-03-02,BALANCE TRANSFER,-300\n');
    assert.equal(rows[0].status, 'new');
  });

  it('欄位數不對的行，就算寫著合計、就算修得回來，也不能被當成合計列', () => {
    // Every cell of a shifted row started out as somebody else's; it stays a
    // refusal, whether or not the overflow folded back into the description.
    const { rows } = read('Date,Description,Amount\n2026-03-02,A,-1\n2026-03-02,A,-1\n合計,,,-2,\n');
    assert.ok(rows[2].repaired, '多出來的欄位被接回摘要了');
    assert.equal(rows[2].status, 'error');
  });
});

describe('哪些情況要停下來問人', () => {
  it('對得上的檔案：什麼都不用問', () => {
    const j = judge(read(STMT), { before: 1000, ledgerOn: 1000 });
    assert.deepEqual(j.issues, []);
    assert.equal(j.reconcile.matches, true);
    assert.equal(j.reconcile.ledger, 695);
  });

  it('對帳單那天的帳面才是比較的對象，今天的餘額只是拿來顯示', () => {
    // The account already holds later months: today it stands at 2,000, but
    // on 03-09 it held what the statement says once these rows are in.
    const j = judge(read(STMT), { before: 2000, ledgerOn: 1000 });
    assert.deepEqual(j.issues, []);
    assert.equal(j.reconcile.after, 2000 + 100 - 400 - 5);
  });

  it('對不上：差多少就說多少', () => {
    const j = judge(read(STMT), { before: 0, ledgerOn: 0 });
    assert.deepEqual(codes(j), ['balance_mismatch']);
    assert.equal(j.reconcile.drift, -1000);
  });

  it('沒有餘額欄就沒得比，不算對不上', () => {
    const j = judge(read('Date,Description,Amount\n2026-03-02,A,-1\n'));
    assert.equal(j.reconcile.matches, null);
    assert.deepEqual(j.issues, []);
  });

  it('沒有日期欄就是讀不出來，而且不能被「照樣匯入」', () => {
    const reading = read(STMT);
    const j = judge({ ...reading, mapping: { ...reading.mapping, dateCol: null } });
    assert.deepEqual(codes(j), ['unreadable']);
    assert.equal(j.issues[0].acceptable, false);
    assert.equal(I.unansweredIssues(j.issues, j.issues.map((i) => i.key)).length, 1);
  });

  it('一半以上的行讀不出來是欄位對應的問題，不是檔案的', () => {
    const j = judge(read('Date,Description,Amount\n2026-03-02,A,-1\nx,B,-2\ny,C,-3\n'));
    assert.deepEqual(codes(j), ['unreadable']);
  });

  it('少數讀不出來的行：列出來，可以照樣匯入其他的', () => {
    const j = judge(read('Date,Description,Amount\n2026-03-02,A,-1\nx,B,-2\n2026-03-03,C,-3\n'));
    assert.deepEqual(codes(j), ['refused']);
    assert.deepEqual(j.issues[0].lines, [3]);
    assert.deepEqual(I.unansweredIssues(j.issues, [j.issues[0].key]), []);
    assert.equal(I.unansweredIssues(j.issues, ['refused']).length, 1, '只說類別不算回答：回答的是這幾行');
  });

  it('合計列不算進「讀不出來」的那一半', () => {
    // One real row and a footer: the footer must not make the file look half
    // broken, or every short 玉山 statement would be refused.
    const j = judge(read('交易日期,摘要,支出金額,存入金額\n115/07/01,薪資,,"1,000"\n合計,,0,1000\n'));
    assert.deepEqual(j.issues, []);
    assert.equal(j.summary.summary_line, 1);
  });

  it('修復過、沒有餘額能驗證的行要問；有餘額鏈確認的就不用', () => {
    const plain = judge(read('Date,Description,Amount\n2026-03-02,FOO, BAR,-5\n2026-03-03,BAZ,-7\n'));
    assert.deepEqual(codes(plain), ['repaired']);

    const chained = judge(
      read('Date,Description,Amount,Balance\n2026-03-01,OPEN,-1,999\n2026-03-02,FOO, BAR,-5,994\n2026-03-03,BAZ,-7,987\n'),
      { before: 1000, ledgerOn: 1000 }
    );
    assert.equal(chained.summary.repaired, 1);
    assert.deepEqual(chained.issues, [], '上一行的餘額加上它的金額等於它的餘額，修復就是對的');
  });

  it('餘額鏈的第一行沒有上一行可比，修復不算被確認', () => {
    const j = judge(
      read('Date,Description,Amount,Balance\n2026-03-02,FOO, BAR,-5,995\n2026-03-03,BAZ,-7,988\n'),
      { before: 1000, ledgerOn: 1000 }
    );
    assert.deepEqual(codes(j), ['repaired']);
  });

  it('餘額接不起來的行要問', () => {
    // 999 - 5 is 994, not 990: a row the file never had sits between them.
    // The ledger on the last day is set to agree, so the break is the only
    // thing wrong with it.
    const j = judge(
      read('Date,Description,Amount,Balance\n2026-03-01,A,-1,999\n2026-03-02,B,-5,990\n2026-03-03,C,-7,983\n'),
      { before: 996, ledgerOn: 996 }
    );
    assert.deepEqual(codes(j), ['balance_breaks']);
    assert.deepEqual(j.issues[0].lines, [3]);
  });

  // The strongest evidence the gate ever has that a repair went wrong: the
  // row was compared and disagreed. Telling the person "nothing could check
  // this, look at the amount" — and offering 金額沒錯 — would be the opposite
  // of what the file just proved.
  it('修復過、而餘額鏈證明修錯的行，是另一件事，不說成「沒有餘額能驗證」', () => {
    const j = judge(
      read('Date,Description,Amount,Balance\n2026-03-01,A,-1,999\n2026-03-02,FOO, BAR,-5,990\n'),
      { before: 996, ledgerOn: 996 }
    );
    assert.deepEqual(codes(j), ['repair_contradicted']);
    assert.deepEqual(j.issues[0].lines, [3]);
    assert.ok(!codes(j).includes('balance_breaks'), '同一行不問兩次');
  });

  it('答案綁著它看到的數字：差額變了，舊的「照樣匯入」就不算', () => {
    const small = judge(read(STMT), { before: 999.5, ledgerOn: 999.5 });
    const large = judge(read(STMT), { before: 0, ledgerOn: 0 });
    assert.deepEqual(codes(small), ['balance_mismatch']);
    assert.deepEqual(codes(large), ['balance_mismatch']);
    assert.notEqual(small.issues[0].key, large.issues[0].key);
    assert.equal(I.unansweredIssues(large.issues, [small.issues[0].key]).length, 1);
  });

  it('信用卡收到大多是流入的檔案，問正負號', () => {
    const j = judge(read('Date,Description,Amount\n2026-03-02,A,5\n2026-03-03,B,6\n2026-03-04,C,-11\n'),
      { account: { id: 1, kind: 'card' } });
    assert.deepEqual(codes(j), ['sign_suspect']);
  });

  it('沒有新的東西要寫，就沒什麼好問的', () => {
    const reading = read(STMT);
    for (const r of reading.rows) r.status = 'duplicate';
    const j = judge(reading, { before: 0, ledgerOn: 0 });
    assert.deepEqual(j.issues, [], '對不上也一樣：這次什麼都不會寫進去');
  });

  it('略過的行不匯入，也不再被問', () => {
    const reading = read('Date,Description,Amount\n2026-03-02,FOO, BAR,-5\n2026-03-03,BAZ,-7\n');
    I.skipImportRows(reading.rows, [2]);
    const j = judge(reading);
    assert.equal(j.summary.skipped, 1);
    assert.equal(j.summary.new, 1);
    assert.deepEqual(j.issues, []);
  });

  it('只有會被匯入的行能被略過', () => {
    const { rows } = read('Date,Description,Amount\n2026-03-02,A,-1\nx,B,-2\n');
    I.skipImportRows(rows, [2, 3]);
    assert.deepEqual(rows.map((r) => r.status), ['skipped', 'error']);
  });

  it('每一種狀態都有計數，零也算', () => {
    const { summary } = judge(read('Date,Description,Amount\n2026-03-02,A,-1\n'));
    for (const k of ['new', 'duplicate', 'pending', 'internal', 'summary_line', 'error', 'skipped']) {
      assert.equal(typeof summary[k], 'number', k);
    }
  });
});

describe('commit 的拒絕', () => {
  const issues = [
    { code: 'refused', acceptable: true, lines: [3], key: 'refused:3:' },
    { code: 'sign_suspect', acceptable: true, key: 'sign_suspect::2/3' },
  ];

  it('全部回答了就放行', () => assert.equal(I.commitRefusal(issues, ['refused:3:', 'sign_suspect::2/3']), null));

  it('沒回答的，用畫面上的同一個名字講出來', () => {
    const msg = I.commitRefusal(issues, ['refused:3:']);
    assert.ok(msg.includes(I.IMPORT_ISSUE_TITLES.sign_suspect));
    assert.ok(!msg.includes(I.IMPORT_ISSUE_TITLES.refused));
  });

  it('答案和略過的行要是陣列，不是就說清楚，不是丟一個 TypeError', () => {
    assert.deepEqual(I.importListParam(undefined, 'accept'), []);
    assert.deepEqual(I.importListParam(['a'], 'accept'), ['a']);
    assert.match(I.importListParam({ 0: 'a' }, 'accept').error, /accept 要是陣列/);
    assert.match(I.importListParam('refused', 'skip_lines').error, /skip_lines 要是陣列/);
  });

  it('每一種問題都有名字', () => {
    for (const code of ['unreadable', 'refused', 'repaired', 'repair_contradicted', 'balance_breaks', 'balance_mismatch', 'sign_suspect']) {
      assert.ok(I.IMPORT_ISSUE_TITLES[code], code);
    }
  });
});

describe('宣告的期間要包住整個檔案', () => {
  const span = { from: '2026-03-02', to: '2026-03-09' };
  it('包住了', () => assert.equal(I.periodProblem({ from: '2026-03-01', to: '2026-03-31' }, span), null));
  it('剛好等於檔案的範圍也算', () => assert.equal(I.periodProblem(span, span), null));
  it('起日太晚', () => assert.match(I.periodProblem({ from: '2026-03-05', to: '2026-03-31' }, span), /落在期間外/));
  it('迄日太早', () => assert.match(I.periodProblem({ from: '2026-03-01', to: '2026-03-08' }, span), /落在期間外/));
  it('起日晚於迄日', () => assert.match(I.periodProblem({ from: '2026-03-31', to: '2026-03-01' }, span), /起日不能晚於迄日/));
  it('檔案的範圍是每一行，不只會匯入的那些', () => {
    assert.deepEqual(I.fileSpan([{ date: '2026-03-09' }, { date: null }, { date: '2026-03-02' }]), span);
  });
});
