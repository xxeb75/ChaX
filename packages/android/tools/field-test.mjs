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
const delivered = await until(async () => (await a.eval(ui.statuses)).some((s) => /remis|lu/.test(s)), 20000);
check('3. message privé : "remis" apparaît chez l’émetteur', !!delivered, JSON.stringify(await a.eval(ui.statuses)));

// 4. read receipt: B opens the conversation
await b.eval(ui.open(nameA));
const read = await until(async () => (await a.eval(ui.statuses)).some((s) => /lu/.test(s)), 20000);
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

a.close();
b.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} contrôles réussis`);
process.exit(failed ? 1 : 0);
