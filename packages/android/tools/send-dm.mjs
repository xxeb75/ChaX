import { Phone, sleep, ui } from './phone.mjs';
const [serial, to, text] = process.argv.slice(2);
const a = new Phone('A', serial, 9301);
await a.attach();
console.log(await a.eval(ui.mesh));
await a.eval(ui.open(to));
await a.eval(ui.say(text));
for (let i = 0; i < 30; i++) { await sleep(1000); const s = (await a.eval(ui.statuses)).slice(-1)[0]; if (/remis|lu/.test(s)) { console.log('A voit:', s, 'après', i + 1, 's'); break; } if (i === 29) console.log('A voit encore:', s); }
a.close(); process.exit(0);
