import { Phone, sleep, ui } from './phone.mjs';
const p = new Phone('B', process.argv[2], 9302);
await p.attach();
console.log('titre:', await p.eval('document.title'));
console.log('historique:', await p.eval(`JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem('chax.history')||'{}')).map(([k,v])=>[k.slice(0,6),v.slice(-2).map(l=>l.text)])))`));
console.log('non-lus:', await p.eval(`localStorage.getItem('chax.unread')`));
console.log('mesh:', await p.eval(ui.mesh));
p.close(); process.exit(0);
