'use strict';

// The AI modes behind the `modes` flag: that the flag is wired before the
// first render, that with it off modes.css and the theme files apply nothing,
// and that every mode's tokens — and tokens.css's own — clear the same
// contrast bar.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Only for REACH. server/ai.js opens nothing at load, and the vault is the
// in-memory one, as in every test, so nothing here can reach a keychain.
process.env.FINANCE_AI_VAULT = 'memory';
const { REACH } = require('../server/ai');

const ROOT = path.join(__dirname, '..');
const FLAGS_JS = fs.readFileSync(path.join(ROOT, 'web', 'flags.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const { parse, rules } = require('./css-tree');

// The modes chrome and one file per theme: every stylesheet in the modes layer.
const MODE_FILES = fs.readdirSync(path.join(ROOT, 'web'))
  .filter((f) => f === 'modes.css' || /^theme-\w+\.css$/.test(f)).sort();
const read = (f) => fs.readFileSync(path.join(ROOT, 'web', f), 'utf8');
const CSS = MODE_FILES.map(read).join('\n');
const MODE_RULES = MODE_FILES.flatMap((f) => [...rules(parse(read(f)))].map((r) => ({ ...r, file: f })));
const TOKEN_RULES = [...rules(parse(read('tokens.css')))];

const lum = (hex) => {
  const c = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('實驗功能旗標', () => {
  it('modes 在 flags.js 的清單裡，由 setModes 套用', () => {
    assert.match(FLAGS_JS, /id: 'modes'[\s\S]*?apply: \(on\) => setModes\(on\)/);
  });

  it('app.js 在第一次 render 之前套用旗標，畫面不會先閃一下沒開的樣子', () => {
    const boot = APP_JS.slice(APP_JS.lastIndexOf("window.addEventListener('popstate'"));
    assert.ok(boot.indexOf('applyFlags()') >= 0, 'boot 沒有呼叫 applyFlags()');
    assert.ok(boot.indexOf('applyFlags()') < boot.indexOf('render()'), 'applyFlags() 要在 render() 之前');
  });
});

describe('模式就是 server 的 reach', () => {
  // A mode is the server's reach drawn, so the page, the stylesheet and the
  // server must name the same three — one more on any side would be a look
  // the server never enforces, or a reach nothing draws.
  it('側欄的模式、modes.css 的主題、server 的 reach 是同一組名字，順序也一樣', () => {
    const start = APP_JS.indexOf('const PRIVACY_MODES = [');
    const block = APP_JS.slice(start, APP_JS.indexOf('\n];', start));
    assert.deepEqual([...block.matchAll(/\{ id: '(\w+)'/g)].map((m) => m[1]), REACH);
    const themes = new Set([...CSS.matchAll(/:root\[data-mode="(\w+)"\]/g)].map((m) => m[1]));
    assert.deepEqual([...themes].sort(), [...REACH].sort());
  });

  // The switch's promise: what is on screen is what the server took.
  it('切換鈕先寫 server，成功了才換樣子；不再用 localStorage 記模式', () => {
    assert.match(APP_JS, /await put\('\/api\/ai', \{ reach: next\.id \}\);[\s\S]*?catch[\s\S]*?return;[\s\S]*?switchWithReveal/);
    assert.ok(!/'ai-mode'/.test(APP_JS), "localStorage 的 'ai-mode' 不該再出現");
  });
});

describe('modes.css 和主題檔只在旗標開啟時生效', () => {
  it('四個檔案都在：modes.css 加上每個 reach 一個主題檔', () => {
    assert.deepEqual(MODE_FILES, ['modes.css', ...REACH.map((r) => `theme-${r}.css`).sort()]);
  });

  // Selectors as they apply once nesting is resolved, so a nested rule that
  // escaped its :root[data-mode] parent would show up here bare.
  it('每一條規則（巢狀展開之後）都掛在 :root[data-mode] 底下', () => {
    assert.ok(MODE_RULES.length > 20, 'parser 讀到的規則太少，大概讀錯了');
    for (const r of MODE_RULES) {
      for (const one of r.selector.split(',').map((s) => s.trim())) {
        assert.ok(one.startsWith(':root[data-mode'), `${r.file} 沒有 scope 的規則：${one}`);
      }
    }
  });

  it('每個主題檔只畫自己那個模式', () => {
    for (const r of MODE_RULES.filter((x) => x.file.startsWith('theme-'))) {
      const mode = r.file.match(/^theme-(\w+)\.css$/)[1];
      assert.ok(r.selector.startsWith(`:root[data-mode="${mode}"]`), `${r.file}：${r.selector}`);
    }
  });

  it('模式鈕和橫幅在 index.html 預設是 hidden', () => {
    assert.match(INDEX, /<button class="mode-switch"[^>]*\shidden[\s>]/);
    assert.match(INDEX, /<div class="mode-bar"[^>]*\shidden[\s>]/);
  });
});

describe('每一組 token 的對比度', () => {
  const tokensOf = (r) => Object.fromEntries(r.decls
    .map((d) => d.match(/^--([\w-]+):\s*(#[0-9a-f]{6})\b/i)).filter(Boolean).map((m) => [m[1], m[2]]));
  // Each theme's block, and the default palette every view starts from — its
  // ratios were only ever comments beside the values until this checked them.
  const blocks = [
    ['default', tokensOf(TOKEN_RULES.find((r) => r.selector === ':root'))],
    ...MODE_RULES
      .filter((r) => /^:root\[data-mode="\w+"\]$/.test(r.selector) && r.decls.some((d) => d.startsWith('--bg:')))
      .map((r) => [r.selector.match(/"(\w+)"/)[1], tokensOf(r)]),
  ];

  it('預設一組，三個模式各一組', () => {
    assert.deepEqual(blocks.map(([m]) => m).sort(), ['cloud', 'default', 'local', 'none']);
  });

  // Every surface, the row hover included: a bordered button sits inside a
  // hovered row. The default --line-strong was 3.4:1 on --surface, as its
  // comment said, and 2.95:1 on --surface-3, until this checked both.
  for (const [mode, t] of blocks) {
    it(`${mode}：文字 ≥ 4.5:1、邊框和圖表 ≥ 3:1`, () => {
      const surfaces = ['bg', 'surface', 'surface-2', 'surface-3'];
      const worst = (k) => Math.min(...surfaces.map((s) => ratio(t[k], t[s])));
      for (const k of ['ink', 'ink-2', 'ink-3', 'brand', 'up', 'down', 'warn']) {
        assert.ok(worst(k) >= 4.5, `--${k} ${worst(k).toFixed(2)}:1`);
      }
      assert.ok(worst('line-strong') >= 3, `--line-strong ${worst('line-strong').toFixed(2)}:1`);
      assert.ok(ratio(t.brand, t['brand-tint']) >= 4.5, '--brand on --brand-tint');
      assert.ok(ratio(t['brand-ink'], t['brand-solid']) >= 4.5, '--brand-ink on --brand-solid');
      assert.ok(ratio(t['chart-4'], t['surface-2']) >= 3, '--chart-4 on --surface-2');
    });
  }
});
