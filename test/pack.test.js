'use strict';

// Run with:  node --test
//
// What `scripts/pack-demo.js` writes is what strangers get served, and it is
// the one artefact in this project that nobody reads before it ships —
// `node --test` does not look at it and a browser does not say which copy it
// loaded. So the checks here are about the gap between the repo and the
// directory: every file that `index.html` asks for is present, nothing that
// is not a frontend file came along, and the two things the packer adds are
// the two things it is supposed to add.
//
// Each case packs into its own mkdtemp directory. Nothing here writes into
// the checkout, and `dist/` is never touched.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PACK = path.join(ROOT, 'scripts', 'pack-demo.js');
const { csp, cspMeta, HOSTED, LOCAL } = require('../server/csp');

const tmpDirs = [];
function pack(args = []) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hub-pack-'));
  tmpDirs.push(out);
  // The suite runs against a checkout that usually has uncommitted work in
  // it — the packer's dirty-tree refusal has its own test below, and every
  // other case is about the output rather than about the guard.
  const r = spawnSync(process.execPath, [PACK, `--out=${out}`, '--allow-dirty', ...args], { encoding: 'utf8' });
  return { out, ...r };
}

describe('打包出去的那份', () => {
  let out;
  let r;

  before(() => {
    ({ out, ...r } = pack());
    assert.equal(r.status, 0, r.stderr);
  });

  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  // The failure this is really about: a `<script src>` that 404s leaves a
  // blank page with one line in a console nobody has open.
  it('index.html 要的每一支 script 和 stylesheet 都在裡面', () => {
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const refs = [
      ...[...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]),
      ...[...html.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]),
    ];
    assert.ok(refs.length > 20, `只找到 ${refs.length} 個引用，正則大概沒對上`);
    for (const ref of refs) {
      assert.ok(ref.startsWith('/'), `${ref} 不是根路徑絕對位址`);
      assert.ok(fs.existsSync(path.join(out, ref.slice(1))), `${ref} 沒有被複製進去`);
    }
  });

  it('web/ 和 shared/ 的每一個檔案都在，而且內容一模一樣', () => {
    const same = (rel, from) => {
      assert.deepEqual(
        fs.readFileSync(path.join(out, rel)),
        fs.readFileSync(from),
        `${rel} 跟 repo 裡的不一樣——打包只准複製，不准改`
      );
    };
    for (const name of fs.readdirSync(path.join(ROOT, 'web'))) {
      if (name === 'index.html') continue;   // the one file that is patched
      same(name, path.join(ROOT, 'web', name));
    }
    for (const name of fs.readdirSync(path.join(ROOT, 'shared'))) {
      same(path.join('shared', name), path.join(ROOT, 'shared', name));
    }
  });

  // A static host serves whatever is in the directory. Anything that is not
  // part of the page is either useless there or worse than useless.
  it('伺服器、測試、資料一律沒有跟著出去', () => {
    const shipped = [];
    const walk = (dir, prefix = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}${e.name}/`);
        else shipped.push(prefix + e.name);
      }
    };
    walk(out);

    for (const name of shipped) {
      assert.ok(!/\.(db|csv|env|md)$/.test(name), `${name} 不該被服務出去`);
    }
    assert.ok(!shipped.some((n) => n.startsWith('server/') || n.startsWith('test/') || n.startsWith('scripts/')),
      `多帶了不該帶的目錄：${shipped.filter((n) => n.includes('/') && !n.startsWith('shared/'))}`);
    // The whole directory, named. A new file appearing here should be a
    // decision somebody made, not something a copy loop swept up.
    const expected = new Set([
      '.finance-hub-pack', '_headers', 'index.html',
      ...fs.readdirSync(path.join(ROOT, 'web')).filter((n) => n !== 'index.html'),
      ...fs.readdirSync(path.join(ROOT, 'shared')).map((n) => `shared/${n}`),
    ]);
    assert.deepEqual(shipped.sort(), [...expected].sort());
  });

  it('CSP 是收緊過的那一份：connect-src 不准連任何地方', () => {
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
    assert.ok(meta, 'index.html 沒有 CSP meta');
    assert.equal(meta[1], cspMeta(HOSTED));
    assert.match(meta[1], /connect-src 'none'/);

    const headers = fs.readFileSync(path.join(out, '_headers'), 'utf8');
    assert.match(headers, /^\/\*$/m, '_headers 要有一條吃全部路徑的規則');
    assert.ok(headers.includes(`Content-Security-Policy: ${csp(HOSTED)}`), headers);

    // The two forms differ in exactly one directive, and only because the
    // HTML parser throws that one away. Any other gap is a policy that says
    // different things depending on where you read it.
    const only = (a, b) => a.split('; ').filter((d) => !b.split('; ').includes(d));
    assert.deepEqual(only(csp(HOSTED), cspMeta(HOSTED)), ["frame-ancestors 'none'"]);
    assert.deepEqual(only(cspMeta(HOSTED), csp(HOSTED)), []);
  });

  it('本機那份沒有被一起收緊：伺服器還是連得到自己的 /api', () => {
    assert.match(csp(LOCAL), /connect-src 'self'/);
    assert.notEqual(csp(LOCAL), csp(HOSTED));
  });

  // AGPL §13: the offer has to name the version being served. A link to a
  // branch is an offer of whatever is there later.
  it('打上去的是 commit，不是分支', () => {
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const stamp = /<meta name="source-commit" content="([^"]+)">/.exec(html);
    assert.ok(stamp, '沒有 source-commit');
    assert.match(stamp[1], /^[0-9a-f]{40}(-dirty)?$/, `不是一個 commit sha：${stamp[1]}`);
    assert.match(html, /<meta name="source-repo" content="https:\/\/github\.com\/[^"]+">/);
  });

  it('同一個 commit 打兩次，出來的東西一模一樣', () => {
    const again = pack();
    assert.equal(again.status, 0, again.stderr);
    const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
    for (const f of ['index.html', '_headers']) {
      assert.equal(read(out, f), read(again.out, f), `${f} 兩次打包不一樣`);
    }
  });
});

describe('打包腳本會拒絕的事', () => {
  after(() => {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  // The link would resolve to a commit that is not what is running, which is
  // worse than no link: it is an offer of source pointing at somebody else's
  // code.
  it('工作目錄髒的時候不打包', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hub-pack-'));
    tmpDirs.push(out);
    const r = spawnSync(process.execPath, [PACK, `--out=${out}`], { encoding: 'utf8' });
    const clean = spawnSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' }).stdout === '';
    if (clean) {
      assert.equal(r.status, 0, '乾淨的 checkout 應該打得起來');
      return;
    }
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /未提交/);
  });

  // `--out` is a path somebody typed, and this deletes what is there.
  it('不清掉不是自己打包出來的目錄', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hub-pack-'));
    tmpDirs.push(out);
    const precious = path.join(out, '不要刪我.txt');
    fs.writeFileSync(precious, 'x');
    const r = spawnSync(process.execPath, [PACK, `--out=${out}`, '--allow-dirty'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.ok(fs.existsSync(precious), '它把別人的檔案刪了');
  });

  it('自己打包過的目錄可以重打', () => {
    const first = pack();
    assert.equal(first.status, 0, first.stderr);
    const second = spawnSync(process.execPath, [PACK, `--out=${first.out}`, '--allow-dirty'], { encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
  });

  it('--out 不能是 repo 根目錄', () => {
    const r = spawnSync(process.execPath, [PACK, `--out=${ROOT}`, '--allow-dirty'], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /根目錄/);
  });
});
