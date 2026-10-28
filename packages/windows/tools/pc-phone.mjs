// End-to-end Bluetooth check between the Windows app (started with --debug) and a USB-connected phone:
// public message and private message in both directions.
// usage: ADB=<adb.exe> node tools/pc-phone.mjs <phone serial> <phone nickname as seen on the PC> <PC nickname as seen on the phone>
import { Phone, sleep, ui } from '../../android/tools/phone.mjs';

const [serial, phoneName, pcName] = process.argv.slice(2);

const tabs = await (await fetch('http://localhost:9222/json')).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
const pc = (expression) => new Promise((res) => {
  const id = ++n;
  pending.set(id, (m) => res(m.result?.result?.value));
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
});

const phone = new Phone('phone', serial, 9301);
await phone.attach();
// rows read "<glyph> name , status ..." : match the name at the start, so message previews cannot match
const openPeer = (name) => `(() => { const r=[...document.querySelectorAll('#convs .row')].find(b=>b.innerText.replace(/^[^a-z0-9]+/i,'').toLowerCase().startsWith(${JSON.stringify(name.toLowerCase())})); if(!r) return false; r.click(); return document.getElementById('title').textContent; })()`;
const stamp = Date.now() % 100000;
const wait = async (read, want) => { for (let i = 0; i < 25; i++) { if ((await read()).some((t) => t.includes(want))) return i + 1; await sleep(1000); } return false; };

console.log('PC   voit :', await pc(ui.mesh));
console.log('phone voit:', await phone.eval(ui.mesh));

// public, PC -> phone
await pc(ui.open('public')); await pc(ui.say(`pc>pub ${stamp}`));
await phone.eval(ui.open('public'));
console.log('public PC -> phone   :', await wait(() => phone.eval(ui.lastTexts), `pc>pub ${stamp}`), 's');
// public, phone -> PC
await phone.eval(ui.say(`ph>pub ${stamp}`));
console.log('public phone -> PC   :', await wait(() => pc(ui.lastTexts), `ph>pub ${stamp}`), 's');
// private, PC -> phone
console.log('PC ouvre', await pc(openPeer(phoneName))); await sleep(500); await pc(ui.say(`pc>dm ${stamp}`));
console.log('phone ouvre', await phone.eval(openPeer(pcName))); await sleep(500);
console.log('privé PC -> phone    :', await wait(() => phone.eval(ui.lastTexts), `pc>dm ${stamp}`), 's');
// private, phone -> PC
await phone.eval(ui.say(`ph>dm ${stamp}`));
console.log('privé phone -> PC    :', await wait(() => pc(ui.lastTexts), `ph>dm ${stamp}`), 's');
console.log('statuts côté PC      :', await pc(ui.statuses));

phone.close();
ws.close();
process.exit(0);
