'use strict';

// Print a local HTML file to PDF the way Chrome's "Save as PDF" does, header and footer
// included. Statements that are web pages printed from Chrome (NetBenefits' Statement
// Details is one) come out of Skia's PDF writer, so a fixture printed here has the same
// kind of text layer a parser will meet in the real file.
//
// A developer tool, never part of the app: it starts a headless Chrome on a throwaway
// profile with background networking off, points it at the one local file, and deletes the
// profile afterwards. The header and footer text is supplied by the caller, so nothing of
// this machine — the date it ran, the path of the file — ends up printed in the fixture.
//
// Driven over the DevTools protocol with Node's own WebSocket; nothing is installed.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function printToPdf({ html, out, header, footer, scale }) {
  if (!fs.existsSync(CHROME)) {
    throw new Error(`Chrome not found at ${CHROME} — set CHROME to its executable`);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-hub-print-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-extensions', '--disable-default-apps', '--metrics-recording-only',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    // With port 0, Chrome picks one and writes it, with the browser's socket path, here.
    const portFile = path.join(profile, 'DevToolsActivePort');
    let lines = [];
    for (let i = 0; i < 200 && lines.length < 2; i++) {
      if (fs.existsSync(portFile)) lines = fs.readFileSync(portFile, 'utf8').trim().split('\n');
      if (lines.length < 2) await sleep(100);
    }
    if (lines.length < 2) throw new Error('Chrome did not open its debugging port');

    const ws = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let nextId = 1;
    const pending = new Map();
    const waiting = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const w of waiting) if (w.method === msg.method) w.resolve(msg.params);
      }
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const next = (method) => new Promise((resolve) => waiting.push({ method, resolve }));

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    const loaded = next('Page.loadEventFired');
    await send('Page.navigate', { url: `file://${path.resolve(html)}` }, sessionId);
    await loaded;
    await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => true)', awaitPromise: true }, sessionId);

    // Chrome's "Default" margins, and a scale standing in for "fit to page width": a web
    // page wider than the paper is shrunk the same way when a person prints it.
    const { data } = await send('Page.printToPDF', {
      paperWidth: 8.5, paperHeight: 11,
      marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4,
      scale, printBackground: true, displayHeaderFooter: true,
      headerTemplate: header, footerTemplate: footer,
    }, sessionId);
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    await send('Browser.close').catch(() => {});
    ws.close();
  } finally {
    chrome.kill();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

module.exports = { printToPdf };
