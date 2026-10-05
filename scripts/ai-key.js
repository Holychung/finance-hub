'use strict';

// Set, check or remove the API key AI 健檢 uses, on this machine.
//
//     node scripts/ai-key.js set anthropic      asks for the key; nothing echoes
//     node scripts/ai-key.js status             which providers have one, and where
//     node scripts/ai-key.js delete anthropic
//
// **This is the only thing in the repo that writes a key.** The server only
// reads one (`keyFor` in server/ai.js): the page has no field for it and the
// API no route that takes one, so a key goes from the owner's terminal into
// the operating system's own store and never passes through the app.
//
// **Where it goes is decided here, per platform**, so that the instructions —
// the page's, the docs' — are this one command on every machine:
//
//     macOS      the login keychain, item finance-hub / <provider>, which is
//                where server/ai.js looks
//     elsewhere  refused for now: no store that is not plain text is wired up
//                yet, and the provider's environment variable is the way
//
// A store for Windows (DPAPI) or Linux (secret-tool) is a new entry in
// `defaultStore()`, and nobody's instructions change.
//
// **The key is never on a command line**, where any process can read it from
// the process table: `security -i` takes its command on stdin. KEY_RE keeps
// quotes, backslashes and whitespace out of that line, and reading the item
// back is the only proof it was written — interactive mode exits 0 when its
// command failed, sometimes without a word on stderr.

const { spawnSync } = require('node:child_process');
const AI = require('../server/ai');

// Letters, digits and the few symbols the three providers' keys use. A key
// pasted with a newline on the end or a space in the middle is refused here
// with a message, rather than at the provider with a 401.
const KEY_RE = /^[A-Za-z0-9._~+/=-]{8,512}$/;

class KeyError extends Error {}
const fail = (message) => { throw new KeyError(message); };

function runSecurity(args, input) {
  const r = spawnSync('/usr/bin/security', args, { input, encoding: 'utf8', timeout: 10000 });
  if (r.error) fail(`叫不動 /usr/bin/security：${r.error.message}`);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function keychainStore({ run = runSecurity } = {}) {
  const S = AI.KEYCHAIN_SERVICE;
  const read = AI.keychainVault({ run });
  const said = (r) => r.stderr.trim() || `security 結束碼 ${r.status}`;
  return {
    where: 'macOS 鑰匙圈',
    set(p, key) {
      const r = run(['-i'], `add-generic-password -U -s ${S} -a ${p} -l "${S} (${p})" -w ${key}\n`);
      if (r.status !== 0) fail(`寫進鑰匙圈失敗：${said(r).split(key).join('…')}`);
      if (read.get(p) !== key) fail('寫進鑰匙圈失敗：寫完讀不回同一把 key。鑰匙圈可能鎖著，或這個項目被別的程式占用。');
    },
    remove(p) {
      const r = run(['delete-generic-password', '-s', S, '-a', p]);
      if (r.status === 44) return false; // errSecItemNotFound
      if (r.status !== 0) fail(`從鑰匙圈刪除失敗：${said(r)}`);
      return true;
    },
  };
}

// null means "nowhere that is not plain text", and `set` says so. Tests run
// with FINANCE_AI_VAULT=memory, which server/ai.js already validates; here it
// means writing nowhere at all, so no test can reach a real keychain.
function defaultStore(env = process.env, platform = process.platform) {
  if (env.FINANCE_AI_VAULT === 'memory') return null;
  return platform === 'darwin' ? keychainStore() : null;
}

// Raw-mode keystrokes in, the key so far out. Pure, so what a terminal sends —
// a paste in one chunk, backspace, Ctrl-C, an arrow key — is testable without
// one. An escape sequence is skipped whole, not typed into the key.
function keystrokes(state, chunk) {
  let { text, esc } = state;
  for (const ch of chunk) {
    if (esc) { if (/[A-Za-z~]/.test(ch)) esc = false; continue; }
    if (ch === '\r' || ch === '\n' || ch === '\u0004') return { text, esc, done: true };
    if (ch === '\u0003') return { text: '', esc, cancelled: true };
    if (ch === '\u001b') { esc = true; continue; }
    if (ch === '\u007f' || ch === '\b') { text = text.slice(0, -1); continue; }
    if (ch === '\u0015') { text = ''; continue; } // Ctrl-U
    if (ch >= ' ') text += ch;
  }
  return { text, esc };
}

// From a terminal, with echo off. From a pipe, the whole of stdin — for
// scripting, and the reason a key on the command line is never needed.
function readHidden(prompt, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    input.setEncoding('utf8');
    if (!input.isTTY) {
      let all = '';
      input.on('data', (c) => { all += c; });
      input.on('end', () => resolve(all));
      return;
    }
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    let state = { text: '', esc: false };
    const onData = (chunk) => {
      state = keystrokes(state, chunk);
      if (!state.done && !state.cancelled) return;
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (state.cancelled) reject(new KeyError('取消了，什麼都沒存。'));
      else resolve(state.text);
    };
    input.on('data', onData);
  });
}

const USAGE = [
  '用法：',
  '  node scripts/ai-key.js set <供應商>      輸入 key（畫面不會顯示），存起來',
  '  node scripts/ai-key.js status            每家有沒有設定、從哪裡讀',
  '  node scripts/ai-key.js delete <供應商>',
  '',
  `供應商：${AI.PROVIDERS.map((p) => p.key).join('、')}`,
].join('\n');

const providerOf = (key) => AI.providerInfo(String(key || '')) || fail(`不認得的供應商：${key || '（沒寫）'}\n\n${USAGE}`);

const where = (s) => (s.source === 'keychain' ? '鑰匙圈' : `環境變數 ${s.env}`);

// Every outcome is a line on `out` or `err` and an exit code, so the whole
// command runs in-process under test with a fake store and a fake reader.
async function main(argv, {
  store = defaultStore(), keys, read = readHidden, out = process.stdout, err = process.stderr,
} = {}) {
  const say = (s) => out.write(`${s}\n`);
  const status = (p) => (keys ? AI.keyStatus(p, keys) : AI.keyStatus(p));
  const [cmd, name] = argv;
  try {
    if (cmd === 'status') {
      const width = Math.max(...AI.PROVIDERS.map((p) => p.label.length));
      for (const p of AI.PROVIDERS) {
        const s = status(p);
        say(`${p.label.padEnd(width)}  ${s.set ? `已設定 ${s.hint}（${where(s)}）` : '未設定'}`);
      }
      return 0;
    }
    if (cmd === 'set') {
      const p = providerOf(name);
      if (!store) {
        fail(`這台電腦還沒有能安全存放 key 的地方（目前只支援 macOS 鑰匙圈），不會把它寫成明文檔案。\n`
          + `請在啟動伺服器前設定環境變數 ${p.env}。`);
      }
      const key = String(await read(`貼上 ${p.label} 的 API key，按 Enter（畫面不會顯示）：`)).trim();
      if (!KEY_RE.test(key)) {
        fail('這看起來不像 API key：要是一串 8 到 512 個字的英數字，中間沒有空白，符號只能是 - _ . ~ + / =。什麼都沒存。');
      }
      store.set(p.key, key);
      say(`已存進 ${store.where}（…${key.slice(-4)}）。伺服器不必重開，下次讀取就拿得到。`);
      const s = status(p);
      if (s.set && s.source !== 'keychain') say(`注意：伺服器讀到的仍是${where(s)}。`);
      return 0;
    }
    if (cmd === 'delete') {
      const p = providerOf(name);
      const removed = store ? store.remove(p.key) : false;
      say(removed ? `已從 ${store.where}刪除 ${p.label} 的 key。` : `沒有存著的 ${p.label} key，什麼都沒刪。`);
      const s = status(p);
      if (s.set) say(`伺服器仍然讀得到${where(s)}（${s.hint}），要停用得把它也拿掉。`);
      return 0;
    }
    err.write(`${USAGE}\n`);
    return cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 2;
  } catch (e) {
    if (!(e instanceof KeyError) && !(e instanceof AI.AiError)) throw e;
    err.write(`${e.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { KEY_RE, keychainStore, defaultStore, keystrokes, readHidden, main };
