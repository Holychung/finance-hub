'use strict';

// web/*.css held to the rules CLAUDE.md "Styling" states, as mechanisms. With
// one stylesheet these were checked by reading it; with ten they are checked
// here: every file linked in order, every rule in a declared layer, colour
// only in the token blocks, !important only where reduced motion needs it,
// and nesting never under a selector list.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, rules } = require('./css-tree');

const WEB = path.join(__dirname, '..', 'web');
const INDEX = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const FILES = fs.readdirSync(WEB).filter((f) => f.endsWith('.css')).sort();
const read = (f) => fs.readFileSync(path.join(WEB, f), 'utf8');
const TREES = Object.fromEntries(FILES.map((f) => [f, parse(read(f))]));
const LINKED = [...INDEX.matchAll(/<link rel="stylesheet" href="\/([^"]+)">/g)].map((m) => m[1]);

// Which layer each file's rules belong in. A new stylesheet is a line here,
// which is the decision being made: where it sits in the cascade.
const LAYER_OF = {
  'tokens.css': 'tokens',
  'base.css': 'app', 'chrome.css': 'app', 'components.css': 'app', 'charts.css': 'app', 'views.css': 'app',
  'modes.css': 'modes', 'theme-none.css': 'modes', 'theme-local.css': 'modes', 'theme-cloud.css': 'modes',
};
const ORDER = ['tokens', 'app', 'modes'];

describe('樣式表：檔案和順序', () => {
  it('web/ 裡每一個 .css 都由 index.html 載入，剛好一次；沒有載入不存在的檔', () => {
    assert.deepEqual([...LINKED].sort(), FILES);
    assert.equal(new Set(LINKED).size, LINKED.length);
  });

  it('每個檔案都知道自己在哪一層', () => {
    assert.deepEqual(Object.keys(LAYER_OF).sort(), FILES);
  });

  // The link order is the cascade order inside a layer, and tokens.css has to
  // come first because it is the one that declares the layers.
  it('載入順序：tokens.css 第一個，同一層的檔案排在一起，層的順序跟宣告一樣', () => {
    assert.equal(LINKED[0], 'tokens.css');
    const layers = LINKED.map((f) => LAYER_OF[f]);
    const runs = layers.filter((l, i) => l !== layers[i - 1]);
    assert.deepEqual(runs, ORDER);
  });
});

describe('樣式表：@layer', () => {
  it('層的順序只在 tokens.css 宣告一次，而且是它的第一句', () => {
    for (const f of FILES) {
      const statements = TREES[f].children.filter((n) => n.statement);
      if (f === 'tokens.css') {
        assert.equal(TREES[f].children[0].prelude, `@layer ${ORDER.join(', ')}`);
        assert.equal(statements.length, 1);
      } else {
        assert.deepEqual(statements.map((n) => n.prelude), [], `${f} 不該有 @layer 宣告或 @import`);
      }
    }
  });

  // A rule outside every layer beats all of them, whatever its specificity:
  // one stray block at the top of a file would quietly win everywhere.
  it('每一條規則都在這個檔案該在的那一層裡，最外層沒有別的東西', () => {
    for (const f of FILES) {
      for (const n of TREES[f].children.filter((x) => !x.statement)) {
        assert.equal(n.prelude, `@layer ${LAYER_OF[f]}`, `${f} 的最外層有「${n.prelude}」`);
      }
      assert.deepEqual(TREES[f].decls, [], `${f} 的最外層有宣告`);
    }
  });
});

describe('樣式表：token 的紀律', () => {
  const tokenBlock = (r) => /^:root(\[data-mode="\w+"\])?$/.test(r.selector);

  // A colour written anywhere else is a decision buried where nobody finds it
  // again, and the one place a theme cannot reach.
  it('顏色值只出現在 :root 的 token 區塊裡，而且只寫在 --token 上', () => {
    const stray = [];
    for (const f of FILES) {
      for (const r of rules(TREES[f])) {
        for (const d of r.decls) {
          if (!/#[0-9a-f]{3,8}\b/i.test(d.replace(/url\([^)]*\)/g, ''))) continue;
          if (!tokenBlock(r) || !d.startsWith('--')) stray.push(`${f}：${r.selector} { ${d} }`);
        }
      }
    }
    assert.deepEqual(stray, []);
  });

  it('!important 只用在減少動態效果那一條', () => {
    const found = [];
    for (const f of FILES) {
      for (const r of rules(TREES[f])) {
        if (r.decls.some((d) => /!important/.test(d))) found.push(`${f}：${r.selector}`);
      }
    }
    assert.deepEqual(found, ['base.css：*']);
    assert.match(read('base.css'), /@media \(prefers-reduced-motion: reduce\) \{\s*\* \{ transition-duration: 0ms !important; animation-duration: 0ms !important; \}/);
  });

  it('沒有 outline: none（焦點只有一條規則）', () => {
    for (const f of FILES) {
      for (const r of rules(TREES[f])) {
        assert.ok(!r.decls.some((d) => /^outline\s*:\s*(none|0)\b/.test(d)), `${f}：${r.selector}`);
      }
    }
  });
});

describe('樣式表：巢狀', () => {
  // Under a list, `&` is :is(…), which takes its most specific member's
  // weight: nested under `button, .btn`, a `button:hover` would weigh as
  // `.btn:hover` and start beating rules it used to lose to.
  it('巢狀只掛在單一 selector 底下，不掛在 selector 清單底下', () => {
    const lists = [];
    for (const f of FILES) {
      for (const r of rules(TREES[f])) {
        const nestsRules = r.children.some((c) => !c.statement && !c.prelude.startsWith('@'));
        if (nestsRules && r.own.split(',').length > 1) lists.push(`${f}：${r.own}`);
      }
    }
    assert.deepEqual(lists, []);
  });

  // The parser has to be reading nesting for the check above to mean
  // anything: these are rules that exist only as nested ones.
  it('parser 真的有展開巢狀：#nav a:hover、.todo-item.err .todo-label 都讀得到', () => {
    const all = FILES.flatMap((f) => [...rules(TREES[f])].map((r) => r.selector));
    assert.ok(all.includes('#nav a:hover'));
    assert.ok(all.includes('.todo-item.err .todo-label'));
    assert.ok(all.includes(':root[data-mode] .mode-switch:hover'));
  });
});
