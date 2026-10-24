import { Phone, sleep, ui } from './phone.mjs';
for (const [n, s, port] of [['A', 'a5ec29df', 9301], ['B', '3A231FDJH002KC', 9302]]) {
  const p = new Phone(n, s, port);
  try { p.sh('am start -n app.chax.mesh/.MainActivity'); } catch {}
  await sleep(2500);
  await p.attach();
  console.log(n, await p.eval(ui.me), '|', await p.eval(ui.mesh), '| bt:', p.sh('settings get global bluetooth_on'));
  p.close();
}
process.exit(0);
