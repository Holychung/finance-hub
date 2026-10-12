'use strict';

// The AI modes behind the `modes` flag: that the flag is wired before the
// first render, that with it off web/modes.css applies nothing, and that
// every mode's tokens clear the same contrast bar style.css's do.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const FLAGS_JS = fs.readFileSync(path.join(ROOT, 'web', 'flags.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'web', 'modes.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const INDEX = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

// Every rule in the file as [selector, body], @media unwrapped, @keyframes
// left out — a keyframe's selectors are percentages, not elements.
function rules(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    for (; j < text.length && depth; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
    }
    const body = text.slice(open + 1, j - 1);
    if (prelude.startsWith('@media')) out.push(...rules(body));
    else if (!prelude.startsWith('@keyframes')) out.push([prelude, body]);
    i = j;
  }
  return out;
}

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

describe('modes.css 只在旗標開啟時生效', () => {
  const all = rules(CSS);

  it('每一條規則都掛在 :root[data-mode] 底下', () => {
    assert.ok(all.length > 10, 'parser 讀到的規則太少，大概讀錯了');
    for (const [selector] of all) {
      for (const one of selector.split(',').map((s) => s.trim())) {
        assert.ok(one.startsWith(':root[data-mode'), `沒有 scope 的規則：${one}`);
      }
    }
  });

  it('模式鈕和橫幅在 index.html 預設是 hidden', () => {
    assert.match(INDEX, /<button class="mode-switch"[^>]*\shidden[\s>]/);
    assert.match(INDEX, /<div class="mode-bar"[^>]*\shidden[\s>]/);
  });
});

describe('每個模式的對比度', () => {
  const blocks = rules(CSS)
    .filter(([sel, body]) => /^:root\[data-mode="\w+"\]$/.test(sel) && body.includes('--bg:'))
    .map(([sel, body]) => [sel.match(/"(\w+)"/)[1],
      Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]))]);

  it('三個模式都有自己的一組 token', () => {
    assert.deepEqual(blocks.map(([m]) => m).sort(), ['cloud', 'local', 'solo']);
  });

  for (const [mode, t] of blocks) {
    it(`${mode}：文字 ≥ 4.5:1、邊框和圖表 ≥ 3:1`, () => {
      const surfaces = ['bg', 'surface', 'surface-2', 'surface-3'].map((k) => t[k]);
      const worst = (fg) => Math.min(...surfaces.map((s) => ratio(fg, s)));
      for (const k of ['ink', 'ink-2', 'ink-3', 'brand', 'up', 'down', 'warn']) {
        assert.ok(worst(t[k]) >= 4.5, `--${k} ${worst(t[k]).toFixed(2)}:1`);
      }
      assert.ok(worst(t['line-strong']) >= 3, `--line-strong ${worst(t['line-strong']).toFixed(2)}:1`);
      assert.ok(ratio(t.brand, t['brand-tint']) >= 4.5, '--brand on --brand-tint');
      assert.ok(ratio(t['brand-ink'], t['brand-solid']) >= 4.5, '--brand-ink on --brand-solid');
      assert.ok(ratio(t['chart-4'], t['surface-2']) >= 3, '--chart-4 on --surface-2');
    });
  }
});
