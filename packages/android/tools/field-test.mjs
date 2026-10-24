// Field test for the BLE mesh between two USB-connected phones.
//   node tools/field-test.mjs <serialA> <serialB>
// Both phones must run the debug APK, have a nickname, and sit next to each other.
import { Phone, sleep, ui } from './phone.mjs';

const [serialA, serialB] = process.argv.slice(2);
if (!serialA || !serialB) throw new Error('usage: field-test.mjs <serialA> <serialB>');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

async function until(fn, timeoutMs, stepMs = 500) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() > end) return false;
    await sleep(stepMs);
  }
}

const a = new Phone('A', serialA, 9301);
const b = new Phone('B', serialB, 9302);
const soft = (p, cmd) => { try { return p.sh(cmd); } catch { return null; } };
for (const p of [a, b]) {
  soft(p, 'input keyevent KEYCODE_WAKEUP'); // refused on Xiaomi without "USB debugging (security settings)"
  p.launch();
}
await sleep(3000);
await a.attach();
await b.attach();
const nameA = await a.eval(ui.me);
const nameB = await b.eval(ui.me);
console.log(`A = ${nameA} (${serialA})   B = ${nameB} (${serialB})`);

// 1. discovery
const met = await until(async () => /à portée/.test(await a.eval(ui.mesh)) && /à portée/.test(await b.eval(ui.mesh)) && !/personne/.test(await a.eval(ui.mesh)), 60000);
check('1. les deux téléphones se détectent en Bluetooth', !!met, `A: "${await a.eval(ui.mesh)}"  B: "${await b.eval(ui.mesh)}"`);
if (!met) {
  console.log('Arrêt : sans liaison, les tests suivants n’ont pas de sens.');
  process.exit(1);
}

// 2. public message
await a.eval(ui.open('public'));
await a.eval(ui.say('test public depuis A'));
await b.eval(ui.open('public'));
const gotPublic = await until(async () => (await b.eval(ui.lastTexts)).includes('test public depuis A'), 15000);
check('2. message public reçu', !!gotPublic);

// 3. direct message: delivered without the recipient touching anything
await sleep(1500);
await a.eval(ui.open(nameB));
await a.eval(ui.say('privé A vers B'));
const delivered = await until(async () => /remis|lu/.test((await a.eval(ui.statuses)).slice(-1)[0] ?? ''), 20000);
check('3. message privé : "remis" apparaît chez l’émetteur', !!delivered, JSON.stringify(await a.eval(ui.statuses)));

// 4. read receipt: B opens the conversation
await b.eval(ui.open(nameA));
const read = await until(async () => /lu/.test((await a.eval(ui.statuses)).slice(-1)[0] ?? ''), 20000);
check('4. accusé de lecture : "lu" apparaît quand B ouvre la conversation', !!read, JSON.stringify(await a.eval(ui.statuses)));

// 5. B in the background with the screen off: it must keep receiving and acknowledging
soft(b, 'input keyevent KEYCODE_HOME');
await sleep(1000);
soft(b, 'input keyevent KEYCODE_SLEEP');
await sleep(20000); // let Android doze a bit
await a.eval(ui.open(nameB));
await a.eval(ui.say('écran éteint chez B'));
const bgDelivered = await until(async () => {
  const st = await a.eval(ui.statuses);
  return /remis|lu/.test(st[st.length - 1] ?? '');
}, 40000);
check('5. écran éteint chez B : le message est quand même remis', !!bgDelivered, JSON.stringify(await a.eval(ui.statuses)));
soft(b, 'input keyevent KEYCODE_WAKEUP');
await sleep(1500);

// 6. Bluetooth off at B, message sent, Bluetooth back on
soft(b, 'svc bluetooth disable');
const lost = await until(async () => /personne/.test(await a.eval(ui.mesh)), 30000);
check('6a. Bluetooth coupé chez B : A voit B disparaître', !!lost, `A: "${await a.eval(ui.mesh)}"`);
await a.eval(ui.say('envoyé pendant la coupure'));
await sleep(1500);
const pendingState = JSON.stringify(await a.eval(ui.statuses));
check('6b. pendant la coupure le message est "en attente"', /attente/.test(pendingState), pendingState);
soft(b, 'svc bluetooth enable');
const back = await until(async () => !/personne/.test(await a.eval(ui.mesh)), 60000);
check('6c. Bluetooth rallumé : la liaison se rétablit toute seule', !!back, `A: "${await a.eval(ui.mesh)}"`);
const late = await until(async () => {
  const st = await a.eval(ui.statuses);
  return /remis|lu/.test(st[st.length - 1] ?? '');
}, 40000);
check('6d. le message en attente est livré après le retour', !!late, JSON.stringify(await a.eval(ui.statuses)));

// 7. attachments: a generated photo (downscaled and fragmented) and a 300 KB file, B -> A over BLE
const sendFile = (name, mime, bytes, kind) => `(async () => {
  let f;
  if (${JSON.stringify(kind)} === 'photo') {
    const c = document.createElement('canvas'); c.width = 2000; c.height = 1500;
    const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 2000, 1500); gr.addColorStop(0, '#ffb000'); gr.addColorStop(1, '#223'); g.fillStyle = gr; g.fillRect(0, 0, 2000, 1500); for (let i = 0; i < 120; i++) { g.fillStyle = 'hsl(' + Math.random() * 360 + ',60%,50%)'; g.beginPath(); g.arc(Math.random() * 2000, Math.random() * 1500, 20 + Math.random() * 120, 0, 7); g.fill(); }
    f = new File([await new Promise((r) => c.toBlob(r, 'image/png'))], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} });
  } else {
    f = new File([new Uint8Array(${bytes}).map((_, i) => i % 251)], ${JSON.stringify(name)}, { type: ${JSON.stringify(mime)} });
  }
  const dt = new DataTransfer(); dt.items.add(f);
  const inp = document.getElementById('pick'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
  return true;
})()`;
await b.eval(ui.open(nameA));
const t0 = Date.now();
await b.eval(sendFile('terrain.png', 'image/png', 0, 'photo'));
const imgs0 = await a.eval(`document.querySelectorAll('#log .img img').length`);
const files0 = await a.eval(`document.querySelectorAll('#log .file').length`);
const gotPhoto = await until(async () => (await a.eval(`document.querySelectorAll('#log .img img').length`)) > imgs0, 90000, 1000);
check('7a. photo reçue en Bluetooth', !!gotPhoto, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
const dim = await a.eval(`(() => { const i = document.querySelector('#log .img img:last-of-type'); return i ? i.naturalWidth + 'x' + i.naturalHeight : ''; })()`).catch(() => '');
check('7b. photo décodable côté récepteur', /^\d+x\d+$/.test(dim) && !dim.startsWith('0'), dim);
const t1 = Date.now();
await b.eval(sendFile('rapport.pdf', 'application/pdf', 300000, 'file'));
const gotFile = await until(async () => (await a.eval(`document.querySelectorAll('#log .file').length`)) > files0, 120000, 1000);
check('7c. fichier de 300 Ko reçu', !!gotFile, `${((Date.now() - t1) / 1000).toFixed(1)} s`);
const ackd = await until(async () => /remis|lu/.test((await b.eval(ui.statuses)).slice(-1)[0] ?? ''), 20000);
check('7d. l’émetteur voit « remis » pour le fichier', !!ackd, JSON.stringify(await b.eval(ui.statuses)));

a.close();
b.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} contrôles réussis`);
process.exit(failed ? 1 : 0);
