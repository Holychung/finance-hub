'use strict';

// Pack the browser demo into a directory a static host can serve.
//
//     node scripts/pack-demo.js              → ./dist
//     node scripts/pack-demo.js --out=/tmp/x
//
// **This is not a build step and must not become one.** Every file is copied
// byte for byte out of `web/` and `shared/`. The only things written that
// were not already in the repo are two `<meta>` tags in `index.html` and a
// `_headers` file, and both are printed in full at the end so what is being
// served can be compared against what is committed. The moment this starts
// transforming source — minifying, inlining, templating — "read the repo,
// that is what is running" stops being true, and that sentence is most of
// what this project is.
//
// Two of those additions are obligations rather than conveniences:
//
// **The CSP.** The hosted demo talks to no server at all, so it ships
// `connect-src 'none'` and the page becomes incapable of sending anything
// anywhere. It goes out as a real header via `_headers` *and* as a `<meta>`,
// because they fail in opposite directions: a host that ignores `_headers`
// still gets the meta, and the meta cannot carry `frame-ancestors`. See
// `server/csp.js`.
//
// **The source link.** The repo is AGPL-3.0, and a hosted copy is a modified
// version — different CSP, a demo adapter, seed data — offered to users over
// a network. Section 13 says those users must be prominently offered the
// Corresponding Source *of the version they are running*, so the stamp is the
// commit, not a branch: `<meta name="source-commit">`, which the sidebar
// turns into a link. That is also why a dirty tree is refused below. A commit
// id that does not describe what is being served is not an offer of source,
// it is a guess pointing at somebody else's code.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { csp, cspMeta, HOSTED } = require('../server/csp');

const ROOT = path.join(__dirname, '..');
const REPO = 'https://github.com/Holychung/finance-hub';

// Written into the output directory, and required to be there before this
// will delete anything. `--out` is a path somebody typed; `rm -rf` on a path
// somebody typed is how a home directory goes.
const MARKER = '.finance-hub-pack';

const args = process.argv.slice(2);
const flag = (name) => args.some((a) => a === `--${name}`);
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim();

function die(...lines) {
  console.error('');
  for (const l of lines) console.error(`  ${l}`);
  console.error('');
  process.exit(1);
}

// --- what version is this ---------------------------------------------------

function stamp() {
  let commit;
  try {
    commit = git('rev-parse', 'HEAD');
  } catch {
    die('這裡不是 git checkout，抓不到 commit。',
      'AGPL §13 要求提供「使用者正在跑的這個版本」的原始碼，所以沒有 commit 就不打包。');
  }
  const dirty = git('status', '--porcelain') !== '';
  if (dirty && !flag('allow-dirty')) {
    die('工作目錄有未提交的改動。',
      '打包出去的 commit 會指向 GitHub 上的某個版本，而那個版本不是現在這份程式碼——',
      '那不是提供原始碼，那是指著別人的程式碼說「這就是你在跑的東西」。',
      '',
      '  先 commit，或者 --allow-dirty（標記會變成 <sha>-dirty，連結一樣不準）。');
  }
  return {
    commit: dirty ? `${commit}-dirty` : commit,
    short: `${commit.slice(0, 10)}${dirty ? '-dirty' : ''}`,
    // The commit's own date, not the clock: two packs of the same commit
    // should differ in nothing at all.
    date: git('show', '-s', '--format=%cI', 'HEAD'),
  };
}

// --- the output directory ---------------------------------------------------

function prepare(out) {
  if (fs.existsSync(out)) {
    const entries = fs.readdirSync(out);
    if (entries.length && !entries.includes(MARKER)) {
      die(`${out} 已經有東西了，而且不是這支腳本打包出來的（沒有 ${MARKER}）。`,
        '不刪別人的目錄。換一個 --out，或者自己清掉。');
    }
    fs.rmSync(out, { recursive: true, force: true });
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, MARKER),
    'Written by scripts/pack-demo.js. Its presence is what allows a repack to delete this directory.\n');
}

// Files, not a directory tree: `web/` is flat and `shared/` is flat, and a
// recursive copy would happily carry along anything that had been left in
// either of them.
function copyFlat(from, to, accept) {
  fs.mkdirSync(to, { recursive: true });
  const taken = [];
  for (const name of fs.readdirSync(from).sort()) {
    const full = path.join(from, name);
    if (!fs.statSync(full).isFile() || !accept(name)) continue;
    fs.copyFileSync(full, path.join(to, name));
    taken.push(name);
  }
  return taken;
}

// --- the two additions ------------------------------------------------------

// Anchored on the charset line because it is the one tag whose position is
// fixed by the spec (it has to be in the first 1024 bytes), and it is already
// the first thing in <head>. If it ever moves this throws rather than
// silently writing a page with no policy on it.
const ANCHOR = '<meta charset="UTF-8">';

function patchHtml(html, version) {
  const hits = html.split(ANCHOR).length - 1;
  if (hits !== 1) {
    die(`web/index.html 裡的 \`${ANCHOR}\` 出現 ${hits} 次，預期剛好 1 次。`,
      'CSP 要插在那一行後面。index.html 改了的話，這支腳本也要跟著改。');
  }
  const added = [
    ANCHOR,
    '<!-- Added by scripts/pack-demo.js; everything else on this page is a byte-for-byte',
    '     copy of the repo. The header form in _headers is the real policy — this is the',
    '     floor for a host that does not read it. -->',
    `<meta http-equiv="Content-Security-Policy" content="${cspMeta(HOSTED)}">`,
    `<meta name="source-commit" content="${version.commit}">`,
    `<meta name="source-repo" content="${REPO}">`,
  ].join('\n');
  return html.replace(ANCHOR, added);
}

const headersFile = () => [
  '# Read by Cloudflare (Workers static assets and Pages) and by Netlify. A host',
  '# that ignores this file still gets the <meta> copy of the policy in',
  '# index.html — with the one directive the meta form cannot carry,',
  '# frame-ancestors, missing.',
  '#',
  '# no-transform is the half of "served bytes are the committed bytes" that',
  '# lives in the repo: Cloudflare documents that its proxy will not modify a',
  '# response carrying it, which keeps the analytics beacon and the email',
  '# obfuscation script it injects by default out of the page. The other half',
  '# is a Configuration Rule on the hostname — see docs/security.md.',
  '/*',
  `  Content-Security-Policy: ${csp(HOSTED)}`,
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  '  Cache-Control: public, max-age=0, must-revalidate, no-transform',
  '',
].join('\n');

// --- go ---------------------------------------------------------------------

function main() {
  const out = path.resolve(ROOT, value('out', 'dist'));
  if (out === ROOT) die('--out 不能是 repo 根目錄。');

  const version = stamp();
  prepare(out);

  const web = copyFlat(path.join(ROOT, 'web'), out, (n) => !n.startsWith('.'));
  const shared = copyFlat(path.join(ROOT, 'shared'), path.join(out, 'shared'), (n) => n.endsWith('.js'));

  const index = path.join(out, 'index.html');
  fs.writeFileSync(index, patchHtml(fs.readFileSync(index, 'utf8'), version));
  fs.writeFileSync(path.join(out, '_headers'), headersFile());

  console.log('');
  console.log(`  打包到 ${out}`);
  console.log(`  web/ ${web.length} 個檔 · shared/ ${shared.length} 個檔 · commit ${version.short}`);
  console.log('');
  console.log(`  CSP   ${csp(HOSTED)}`);
  console.log(`  原始碼 ${REPO}/tree/${version.commit.replace('-dirty', '')}`);
  console.log('');
  console.log('  放上去的時候：');
  console.log('    · 要放在網域根目錄。index.html 的 script 用的是 /html.js 這種絕對路徑，');
  console.log('      掛在 /finance-hub/ 這種子路徑底下會整頁載不起來。');
  console.log('    · 挑一個讀得到 _headers 的 host（Cloudflare Workers 靜態資產、Pages、Netlify）。');
  console.log('      讀不到的話 meta 那份還在，但擋不了別人把這頁包進 iframe。');
  console.log('    · 正式那份不是手動放的：merge 進 main 後由 Cloudflare 照 wrangler.jsonc 重跑');
  console.log('      這支腳本再部署。上線後的確認方式在 docs/security.md。');
  console.log('    · 這份是示範：沒有伺服器，也沒有任何一列真實資料。');
  console.log('');
}

main();
