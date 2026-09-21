'use strict';

// Run with:  node --test
//
// Two things are being pinned here, and they are the two the `shared/`
// arrangement rests on.
//
// **The hash has to be byte-identical to `node:crypto`.** Every fingerprint
// already sitting in somebody's ledger was computed with `createHash('sha1')`,
// and the dedup contract says the definition cannot change without migrating
// all of them. So the test is not "does this look like SHA-1" — it is the
// forty lines against the reference implementation, over the inputs that
// break hand-written ones. This can only run in Node, which is exactly where
// the reference lives.
//
// **A shared module has to behave the same loaded either way.** In Node it is
// a `require`; in the browser it is a classic `<script>` with no `require` and
// no `module`, reading its dependencies off the global. Those are two
// genuinely different code paths through the same file, so the second is run
// here in a `vm` context — no DOM, no module system — and its answers are
// compared against the required copy's.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SHARED = path.join(__dirname, '..', 'shared');
const { sha1Hex } = require('../shared/sha1.js');
const csv = require('../shared/csv.js');

const ref = (s) => crypto.createHash('sha1').update(s).digest('hex');

describe('SHA-1 跟 node:crypto 完全一致', () => {
  it('標準測試向量', () => {
    assert.equal(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
    assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    assert.equal(
      sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1'
    );
  });

  // Where a hand-written implementation goes wrong: the message is padded to
  // a multiple of 64 bytes with the length in the last 8, so 55/56 and
  // 63/64/65 straddle the block boundary and 56..63 force a second block of
  // nothing but padding.
  it('長度 0 到 200，每一個都對得上', () => {
    const wrong = [];
    for (let n = 0; n <= 200; n++) {
      const s = 'a'.repeat(n);
      if (sha1Hex(s) !== ref(s)) wrong.push(n);
    }
    assert.deepEqual(wrong, [], `這些長度算錯了：${wrong.join(', ')}`);
  });

  // A description holds whatever the bank wrote in it. UTF-8 is what
  // `hash.update(str)` uses when no encoding is given, so a multi-byte
  // character is several bytes to the hash and one to `String.length` —
  // getting that wrong passes every ASCII test.
  it('非 ASCII 的摘要也一致', () => {
    const samples = [
      '1|2026-09-21|-1234.56|starbucks',
      '7|2026-02-29|58420.15|玉山銀行台北分行',
      '3|2026-03-01|-0.01|for"mayrecital"',
      '9|2026-12-31|999999999.99|ＡＢＣ全形',
      '4|2026-06-15|-33.00|café☕naïve',
      '5|2026-06-15|-33.00|𝕦𝕥𝕗𝟠fourbyte😀',
      `6|2026-06-15|12.50|${'x'.repeat(5000)}`,
    ];
    for (const s of samples) assert.equal(sha1Hex(s), ref(s), s.slice(0, 40));
  });

  // Deterministic, so a failure can be reproduced rather than just reported.
  it('三千筆隨機 Unicode 語料', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 0x100000000;
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      let s = '';
      const n = Math.floor(rnd() * 120);
      for (let j = 0; j < n; j++) s += String.fromCodePoint(Math.floor(rnd() * 0x10ffff) || 65);
      assert.equal(sha1Hex(s), ref(s), `第 ${i} 筆`);
      checked++;
    }
    assert.equal(checked, 3000);
  });

  // The reason any of this exists: the fingerprint is what decides whether a
  // row has been imported before. If it moved, every ledger in the world
  // would re-import everything it already has.
  it('指紋跟舊的 createHash 寫法一模一樣', () => {
    const old = (accountId, date, amount, description) => {
      const desc = String(description || '').toLowerCase().replace(/[\s,.\-_/\\()（）【】「」*#]/g, '');
      return crypto.createHash('sha1').update(`${accountId}|${date}|${amount.toFixed(2)}|${desc}`).digest('hex');
    };
    const rows = [
      [1, '2026-09-21', -1234.56, 'Star bucks #7'],
      [42, '2026-01-01', 0, ''],
      [7, '2026-02-28', 58420.15, '玉山銀行  台北分行（活存）'],
      [3, '2025-12-31', -0.01, 'A/B\\C_D-E.F,G'],
    ];
    for (const [a, d, amt, desc] of rows) {
      assert.equal(csv.fingerprint(a, d, amt, desc), old(a, d, amt, desc), `${a}|${d}|${amt}|${desc}`);
    }
  });
});

describe('shared/ 的模組兩種載入方式都一樣', () => {
  // What the browser does: classic scripts, in index.html's order, into one
  // global scope. No `require`, no `module`, no DOM. TextEncoder and
  // TextDecoder are provided because a browser has them natively and a bare
  // vm context does not.
  const browser = () => {
    const ctx = vm.createContext({ TextEncoder, TextDecoder });
    const doc = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
    const order = [...doc.matchAll(/<script src="\/shared\/([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.ok(order.length >= 3, `index.html 只載了 ${order.length} 個 shared 檔`);
    for (const f of order) {
      vm.runInContext(fs.readFileSync(path.join(SHARED, f), 'utf8'), ctx, { filename: `shared/${f}` });
    }
    return ctx;
  };

  it('沒有 require、沒有 module 時，匯出的東西會掛到 global 上', () => {
    const ctx = browser();
    assert.equal(typeof ctx.sha1Hex, 'function');
    assert.equal(typeof ctx.fingerprint, 'function', 'csv.js 的匯出沒有掛上去');
    assert.equal(typeof ctx.computeNetWorth, 'function', 'money.js 的匯出沒有掛上去');
    assert.equal(typeof ctx.module, 'undefined', '這條路徑就是沒有 module 的那條');
  });

  it('同一個檔案在瀏覽器路徑上算出來的指紋跟 Node 一樣', () => {
    const ctx = browser();
    for (const args of [
      [1, '2026-09-21', -1234.56, 'Star bucks #7'],
      [7, '2026-02-28', 58420.15, '玉山銀行  台北分行（活存）'],
    ]) {
      assert.equal(ctx.fingerprint(...args), csv.fingerprint(...args));
      assert.equal(ctx.fingerprint(...args), ref(
        `${args[0]}|${args[1]}|${args[2].toFixed(2)}|${String(args[3]).toLowerCase().replace(/[\s,.\-_/\\()（）【】「」*#]/g, '')}`
      ));
    }
  });

  // Objects built inside a vm context have that context's Object prototype,
  // so assert.deepEqual compares them as different types however identical
  // their contents. What is being compared here is data, so it goes across
  // the boundary as JSON — which is also what the demo store will do with it.
  const same = (a, b, msg) => assert.equal(JSON.stringify(a), JSON.stringify(b), msg);

  it('解析一份真實形狀的對帳單，兩邊得到同一批資料列', () => {
    const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'esun-savings.csv'));
    const ctx = browser();
    ctx.BUF = buf;

    // 玉山's export has 民國 dates and two-column debit/credit, so this is
    // the encoding sniff, the date parser and the amount mode rather than
    // just proof the file loaded.
    const node = csv.decode(buf);
    const web = vm.runInContext('decode(BUF)', ctx);
    assert.equal(web.encoding, 'utf-8');
    same(web, node, '解碼結果不一致');

    ctx.TEXT = node.text;
    const grid = csv.parseCsv(node.text);
    same(vm.runInContext('parseCsv(TEXT)', ctx), grid);

    const mapping = csv.guessMapping(grid[0], grid.slice(1));
    same(
      vm.runInContext('(() => { const g = parseCsv(TEXT); return guessMapping(g[0], g.slice(1)); })()', ctx),
      mapping,
      '欄位自動對應在兩邊給了不同答案'
    );
    assert.equal(mapping.dateFormat, 'roc', '這份檔案就是要考民國年');
    assert.equal(mapping.amountMode, 'inout', '支出／存入兩欄');

    ctx.GRID = grid;
    ctx.MAPPING = mapping;
    const rows = csv.extractRows(grid, { ...mapping, headerRow: 1 }, 1);
    same(vm.runInContext('extractRows(GRID, { ...MAPPING, headerRow: 1 }, 1)', ctx), rows,
      '同一份檔案在兩條路徑上解析出不同的列');
    assert.ok(rows.rows.length > 0);
  });

  // The fixtures on disk are UTF-8, so the Big5 branch of the sniff is
  // reached with bytes that cannot be UTF-8 at all (0xa5 is a continuation
  // byte and never a lead). What they decode to is beside the point; that
  // both paths decode them the same way, through the same TextDecoder, is
  // not — a browser that fell back differently would silently mis-read every
  // Taiwanese statement.
  it('Big5 這條分支在兩邊也一致', () => {
    const bytes = Buffer.from([0xa5, 0xe6, 0xa9, 0xf6, 0x2c, 0xa4, 0xe9, 0xb4, 0xc1, 0x0a, 0x31, 0x2c, 0x32, 0x0a]);
    const ctx = browser();
    ctx.BUF = bytes;
    const node = csv.decode(bytes);
    assert.equal(node.encoding, 'big5', '這串就是要走 big5 分支');
    same(vm.runInContext('decode(BUF)', ctx), node);
  });

  it('淨值在兩邊算出同一個結果', () => {
    const ctx = browser();
    const input = {
      accounts: [
        { currency: 'TWD', kind: 'cash', balance: 500000 },
        { currency: 'USD', kind: 'card', balance: -1200 },
      ],
      holdings: [{ currency: 'USD', market_value: 58420.15 }],
      asOf: '2026-09-21',
    };
    ctx.INPUT = input;
    const money = require('../shared/money.js');
    same(vm.runInContext('computeNetWorth(INPUT)', ctx), money.computeNetWorth(input));
  });
});
