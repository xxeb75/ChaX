import { Phone, sleep } from './phone.mjs';
for (const [n, s, port] of [['Pixel', '3A231FDJH002KC', 9302]]) {
  const p = new Phone(n, s, port);
  try { p.sh('input keyevent KEYCODE_WAKEUP'); } catch {}
  p.launch(); await sleep(6000); await p.attach();
  await p.eval(`document.getElementById('fp').click()`);
  await sleep(1500); console.log(await p.eval(`!!document.querySelector('.verify')`));
  await p.eval(`[...document.querySelectorAll('.verify .vact button')][0].click()`);
  await sleep(3500);
  console.log(n, await p.eval(`JSON.stringify({res: document.querySelector('.verify .vres').textContent, vw: document.querySelector('.verify video').videoWidth, hidden: document.querySelector('.verify video').classList.contains('hide'), qr: !!document.querySelector('.verify .qr path')})`));
  p.close();
}
process.exit(0);
