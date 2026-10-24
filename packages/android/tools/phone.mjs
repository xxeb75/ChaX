// Drive the ChaX WebView on a USB-connected phone through the Chrome DevTools protocol.
// Used by the field tests: no taps, the app is controlled like a browser tab.
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';

const PKG = 'app.chax.mesh';

// Another adb (version 40, started by the desktop app) can restart the server under us: retry.
function adb(serial, ...args) {
  for (let i = 0; ; i++) {
    try {
      return execFileSync(process.env.ADB ?? 'adb', ['-s', serial, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (e) {
      const msg = String(e.stderr ?? '');
      if (i >= 8 || !/doesn't match|unknown host service|not found|offline/.test(msg)) throw e;
      execFileSync('node', ['-e', 'setTimeout(()=>{},1500)']);
    }
  }
}

export class Phone {
  constructor(name, serial, port) {
    this.name = name;
    this.serial = serial;
    this.port = port;
    this.nextId = 1;
    this.pending = new Map();
  }

  sh(cmd) {
    return adb(this.serial, 'shell', cmd);
  }

  launch() {
    this.sh(`am start -n ${PKG}/.MainActivity`);
  }

  async attach() {
    let sock = '';
    for (let i = 0; i < 20 && !sock; i++) {
      const pid = this.sh(`pidof ${PKG}`).split(/\s+/)[0];
      const unix = this.sh('cat /proc/net/unix');
      sock = (unix.match(new RegExp(`webview_devtools_remote_${pid}`)) || [''])[0];
      if (!sock) await sleep(500);
    }
    if (!sock) throw new Error(`${this.name}: no WebView devtools socket`);
    adb(this.serial, 'forward', `tcp:${this.port}`, `localabstract:${sock}`);
    const list = await (await fetch(`http://127.0.0.1:${this.port}/json`)).json();
    const page = list.find((p) => p.type === 'page');
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
    this.ws.on('close', () => {
      for (const cb of this.pending.values()) cb({ result: { exceptionDetails: { exception: { description: `${this.name}: devtools socket closed` } } } });
      this.pending.clear();
    });
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    });
  }

  /** Evaluates JS in the page; the expression may be async. */
  eval(expression) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => {
        if (m.result?.exceptionDetails) reject(new Error(m.result.exceptionDetails.exception?.description ?? 'eval failed'));
        else resolve(m.result?.result?.value);
      });
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Page-side helpers, injected as one expression. */
export const ui = {
  mesh: `document.getElementById('meshTxt').textContent`,
  me: `document.getElementById('meName').textContent`,
  open: (name) => `(() => { const r=[...document.querySelectorAll('#convs .row')].find(b=>b.innerText.toLowerCase().includes(${JSON.stringify(name.toLowerCase())})); if(!r) return false; r.click(); return true; })()`,
  say: (text) => `(() => { const t=document.getElementById('text'); t.value=${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); return true; })()`,
  statuses: `[...document.querySelectorAll('#log .st')].map(x=>x.innerText.replace(/\\s+/g,' ').trim())`,
  lastTexts: `[...document.querySelectorAll('#log .txt')].map(x=>x.innerText)`,
  hidden: `document.hidden`,
};
