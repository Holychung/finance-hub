'use strict';

// The two rules this project actually rests on — zero dependencies, and
// nothing reaches the network — were until now only written down.
//
// Both break quietly. An added `package.json` works fine; the app still runs,
// the tests still pass, and the supply chain is simply there from then on. An
// external `url()` in a stylesheet or a font import shows up as a request
// nobody is watching, on a page whose README promises it makes none. Neither
// announces itself, which is exactly the shape of rule that needs a mechanism
// rather than a paragraph — the same reason `LIABILITY_KINDS` and
// `APP_ROUTES` are pinned by tests instead of by a comment asking nicely.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Everything a package manager leaves behind. `pnpm-workspace.yaml` is in the
// list because it is where the settings that make dependencies survivable
// live — a repo that needs one has already lost this argument.
const DEPENDENCY_ARTEFACTS = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'bun.lockb',
  'node_modules',
]);

function walk(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (DEPENDENCY_ARTEFACTS.has(entry.name)) {
      found.push(path.relative(ROOT, full));
      // Do not descend into node_modules: the point is made, and walking it
      // would take longer than the rest of the suite put together.
      if (entry.isDirectory()) continue;
    }
    if (entry.isDirectory()) walk(full, found);
  }
  return found;
}

// Only the code that actually runs. `test/` is deliberately excluded: its job
// includes carrying hostile examples, and `api.test.js` has to name an
// off-origin host to prove the Origin guard rejects it.
const SOURCE_DIRS = ['web', 'shared', 'server', 'scripts'];

const ALLOWED_URLS = [
  [/^https?:\/\/127\.0\.0\.1(?:[:/]|$)/, 'loopback'],
  [/^https?:\/\/localhost(?:[:/]|$)/, 'loopback'],
  // `http://${HOST}:${PORT}` in the startup banner and `http://${req.headers.host}`
  // used to parse the request URL. Both take their host from a value the
  // ALLOWED_HOSTS guard has already vetted; neither is a destination.
  [/^https?:\/\/\$\{/, 'template literal, host comes from the guarded value'],
  // An XML namespace is an identifier, not an address — nothing fetches it.
  [/^http:\/\/www\.w3\.org\//, 'XML namespace'],
  // The repo: the sidebar's source offer, and the packer that stamps a commit
  // into it. This one is *required* to be there — AGPL §13 obliges the hosted
  // demo to offer its users the source of the version they are running — and
  // it is an `<a href>` somebody clicks, not a request the page makes.
  // Nothing is loaded from that host and `default-src 'none'` still forbids
  // it; the page reaches GitHub only if a person decides to go there.
  //
  // Anchored at both ends rather than a host prefix, because
  // `https://github.com/...` as a prefix would also wave through a
  // `<script src>` or a fetch. The `/tree/<commit>` link is built at runtime
  // from this base plus a commit read out of a <meta>, so the only literal
  // in the source is the base itself.
  [/^https:\/\/github\.com\/Holychung\/finance-hub$/, 'AGPL §13 source offer — a link, not a fetch'],
];

function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.(js|css|html)$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe('零依賴', () => {
  it('repo 裡沒有任何套件管理員的產物', () => {
    const found = walk(ROOT);
    assert.deepEqual(found, [],
      `這些檔案代表這個 repo 開始有依賴了：${found.join('、')}`);
  });
});

describe('不對外連線', () => {
  it('會跑的程式碼裡沒有任何外部網址', () => {
    const offenders = [];
    for (const dir of SOURCE_DIRS) {
      for (const file of sourceFiles(path.join(ROOT, dir))) {
        const src = fs.readFileSync(file, 'utf8');
        src.split('\n').forEach((line, i) => {
          for (const [url] of line.matchAll(/https?:\/\/[^\s"'`)>]*/g)) {
            if (ALLOWED_URLS.some(([re]) => re.test(url))) continue;
            offenders.push(`${path.relative(ROOT, file)}:${i + 1} ${url}`);
          }
        });
      }
    }
    assert.deepEqual(offenders, [],
      `這些網址會讓資料或使用痕跡離開這台機器：\n  ${offenders.join('\n  ')}`);
  });

  // A stylesheet reaches the network through url() and @import, which read as
  // styling rather than as a request. A single @font-face is enough to tell a
  // font host, on every page load, that this machine opened its ledger.
  it('樣式表沒有外部 url() 或 @import', () => {
    const css = fs.readFileSync(path.join(ROOT, 'web', 'style.css'), 'utf8');
    // Both spellings: `@import "x"` and `@import url("x")`, plus bare `url()`.
    const external = [...css.matchAll(/(?:@import\s+(?:url\()?|url\()\s*['"]?([^'")\s]+)/g)]
      .map((m) => m[1])
      // `url(#nwgrad)` points at a gradient in the same document, and a data:
      // URI is the bytes themselves — neither is a request.
      .filter((ref) => !ref.startsWith('#') && !ref.startsWith('data:'));
    assert.deepEqual(external, [],
      `style.css 參照了外部資源：${external.join('、')}`);
  });
});
