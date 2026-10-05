'use strict';

// Run with:  node --test
//
// scripts/ai-key.js, the one thing in the repo that writes an AI key. Every
// case here runs against a stand-in for /usr/bin/security or with
// FINANCE_AI_VAULT=memory, so no case can reach a real keychain — set before
// the require, because server/ai.js picks its vault at load.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

process.env.FINANCE_AI_VAULT = 'memory';
const AI = require('../server/ai');
const CLI = require('../scripts/ai-key');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'ai-key.js');
const KEY = 'sk-ant-test-0123456789abcdwxyz';

// A stand-in for /usr/bin/security that keeps items in a Map and answers the
// way the real tool does: 44 for an item that is not there, and `-i` exiting 0
// whether or not its command worked.
function fakeSecurity({ silentlyFails = false } = {}) {
  const items = new Map();
  const calls = [];
  const run = (args, input) => {
    calls.push({ args, input });
    const id = () => `${args[args.indexOf('-s') + 1]}|${args[args.indexOf('-a') + 1]}`;
    const missing = { status: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' };
    if (args[0] === 'find-generic-password') {
      return items.has(id()) ? { status: 0, stdout: `${items.get(id())}\n`, stderr: '' } : missing;
    }
    if (args[0] === 'delete-generic-password') {
      return items.delete(id()) ? { status: 0, stdout: '', stderr: '' } : missing;
    }
    if (args[0] === '-i') {
      const m = input.match(/^add-generic-password -U -s (\S+) -a (\S+) -l "[^"]+" -w (\S+)\n$/);
      if (m && !silentlyFails) items.set(`${m[1]}|${m[2]}`, m[3]);
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected security call: ${args.join(' ')}`);
  };
  return { run, calls, items };
}

const sink = () => ({ text: '', write(s) { this.text += s; } });

// main() in-process: a fake store, a reader that returns `typed`, and the
// keys the server would read — the fake keychain's items, then `env`.
async function cli(argv, { sec = fakeSecurity(), typed = KEY, env = {}, store } = {}) {
  const out = sink();
  const err = sink();
  const s = store === undefined ? CLI.keychainStore({ run: sec.run }) : store;
  const keys = { vault: AI.keychainVault({ run: sec.run }), env };
  const code = await CLI.main(argv, { store: s, keys, read: async () => typed, out, err });
  return { code, out: out.text, err: err.text, sec };
}

describe('輸入 key 的按鍵（不需要終端機）', () => {
  const type = (...chunks) => chunks.reduce((s, c) => CLI.keystrokes(s, c), { text: '', esc: false });

  it('打完按 Enter；一次貼上整串、尾巴帶換行也一樣', () => {
    assert.deepEqual(type('sk-1', '2', '3\r'), { text: 'sk-123', esc: false, done: true });
    assert.equal(type(`${KEY}\r\n`).text, KEY);
  });

  it('Backspace 刪一個字、Ctrl-U 清掉重來、Ctrl-C 取消', () => {
    assert.equal(type('sk-12x\u007f3\r').text, 'sk-123');
    assert.equal(type('wrong\u0015sk-ok\r').text, 'sk-ok');
    assert.deepEqual(type('sk-12', '\u0003'), { text: '', esc: false, cancelled: true });
  });

  it('方向鍵這類跳脫序列整段略過，不會打進 key 裡', () => {
    assert.equal(type('sk-1\u001b[D2\u001b[3~3\r').text, 'sk-123');
  });
});

describe('寫進 macOS 鑰匙圈（假的 security）', () => {
  it('key 走 stdin，從來不在命令列參數上；伺服器讀得到', () => {
    const sec = fakeSecurity();
    CLI.keychainStore({ run: sec.run }).set('anthropic', KEY);
    for (const c of sec.calls) assert.ok(!c.args.join(' ').includes(KEY), `命令列上出現了 key：${c.args.join(' ')}`);
    assert.ok(sec.calls.some((c) => c.args[0] === '-i' && c.input.includes(KEY)));
    assert.equal(AI.keychainVault({ run: sec.run }).get('anthropic'), KEY, '寫的地方就是伺服器讀的地方');
  });

  it('security -i 回 0 但其實沒寫進去：讀回來比對，報錯而不是說存好了', () => {
    const store = CLI.keychainStore({ run: fakeSecurity({ silentlyFails: true }).run });
    assert.throws(() => store.set('anthropic', KEY), (e) => /讀不回/.test(e.message) && !e.message.includes(KEY));
  });

  it('刪掉存在的是 true，不存在的是 false', () => {
    const sec = fakeSecurity();
    const store = CLI.keychainStore({ run: sec.run });
    store.set('openai', KEY);
    assert.equal(store.remove('openai'), true);
    assert.equal(store.remove('openai'), false);
  });

  it('預設存放處：macOS 是鑰匙圈，別的系統和 FINANCE_AI_VAULT=memory 都是「沒有」', () => {
    assert.equal(CLI.defaultStore({}, 'darwin').where, 'macOS 鑰匙圈', '建出來而已，沒有呼叫 security');
    assert.equal(CLI.defaultStore({}, 'linux'), null);
    assert.equal(CLI.defaultStore({}, 'win32'), null);
    assert.equal(CLI.defaultStore({ FINANCE_AI_VAULT: 'memory' }, 'darwin'), null);
  });
});

describe('指令本身', () => {
  it('set：存起來，只印最後四碼', async () => {
    const r = await cli(['set', 'anthropic'], { typed: `  ${KEY}\n` });
    assert.equal(r.code, 0);
    assert.equal([...r.sec.items.values()][0], KEY, '頭尾空白去掉');
    assert.match(r.out, /已存進 macOS 鑰匙圈（…wxyz）/);
    assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
  });

  it('set：不像 key 的東西拒絕，什麼都沒存', async () => {
    for (const bad of ['', 'short', 'sk-with space-12345678', '"sk-12345678"', 'sk-1234\\5678', 'sk-中文-12345678']) {
      const r = await cli(['set', 'anthropic'], { typed: bad });
      assert.equal(r.code, 1, JSON.stringify(bad));
      assert.match(r.err, /不像 API key/);
      assert.equal(r.sec.items.size, 0);
    }
  });

  it('set：沒有安全的存放處，就拒絕並叫人用環境變數', async () => {
    const r = await cli(['set', 'gemini'], { store: null });
    assert.equal(r.code, 1);
    assert.match(r.err, /不會把它寫成明文檔案/);
    assert.match(r.err, /GEMINI_API_KEY/);
  });

  it('set：環境變數也有的話，說伺服器會用鑰匙圈這把', async () => {
    const r = await cli(['set', 'openai'], { env: { OPENAI_API_KEY: 'sk-env-0000000000' } });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.out, /注意/, '鑰匙圈優先，所以不用警告');
  });

  it('status：每家一行，有的只給最後四碼和來源', async () => {
    const sec = fakeSecurity();
    CLI.keychainStore({ run: sec.run }).set('anthropic', KEY);
    const r = await cli(['status'], { sec, env: { GEMINI_API_KEY: 'AIza-env-00001234' } });
    assert.equal(r.code, 0);
    const lines = r.out.trim().split('\n');
    assert.equal(lines.length, AI.PROVIDERS.length);
    assert.match(lines[0], /Anthropic Claude\s+已設定 …wxyz（鑰匙圈）/);
    assert.match(lines[1], /OpenAI\s+未設定/);
    assert.match(lines[2], /Gemini\s+已設定 …1234（環境變數 GEMINI_API_KEY）/);
    assert.ok(!r.out.includes(KEY));
  });

  it('delete：刪掉；本來就沒有也說清楚；環境變數還在的話提醒', async () => {
    const sec = fakeSecurity();
    CLI.keychainStore({ run: sec.run }).set('anthropic', KEY);
    let r = await cli(['delete', 'anthropic'], { sec });
    assert.match(r.out, /已從 macOS 鑰匙圈刪除/);
    r = await cli(['delete', 'anthropic'], { sec, env: { ANTHROPIC_API_KEY: 'sk-env-0000005678' } });
    assert.match(r.out, /什麼都沒刪/);
    assert.match(r.out, /仍然讀得到環境變數 ANTHROPIC_API_KEY（…5678）/);
  });

  it('不認得的供應商是 1，不認得的指令是 2，help 是 0', async () => {
    assert.equal((await cli(['set', 'mistral'])).code, 1);
    assert.equal((await cli(['set'])).code, 1);
    assert.equal((await cli(['rotate'])).code, 2);
    const help = await cli(['help']);
    assert.equal(help.code, 0);
    assert.match(help.err, /node scripts\/ai-key\.js set/);
  });
});

// The real entry point, as a person runs it, with FINANCE_AI_VAULT=memory so
// it can neither read nor write a keychain.
describe('真的跑這個腳本（FINANCE_AI_VAULT=memory）', () => {
  const run = (args, { input, env = {} } = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env, FINANCE_AI_VAULT: 'memory',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', ...env,
    },
  });

  it('status 讀環境變數，只印最後四碼', () => {
    const r = run(['status'], { env: { ANTHROPIC_API_KEY: KEY } });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /已設定 …wxyz（環境變數 ANTHROPIC_API_KEY）/);
    assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  });

  it('set 從管線讀 key，但測試模式不寫任何地方', () => {
    const r = run(['set', 'anthropic'], { input: `${KEY}\n` });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ANTHROPIC_API_KEY/);
  });

  it('沒有參數就印用法', () => {
    const r = run([]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /用法/);
  });
});
