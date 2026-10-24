import {
  BroadcastChannelTransport,
  ChaxNode,
  PacketType,
  createIdentity,
  fromHex,
  identityFromSecrets,
  toHex,
  type ChatMessage,
  type Identity,
} from '../../core/src';

type Status = 'pending' | 'sent' | 'delivered';

interface Line {
  id?: string; // hex msgId, for direct messages we sent
  mine: boolean;
  from: string;
  text: string;
  at: number;
  alert?: boolean;
  status?: Status;
}

const PUBLIC = 'public';
const ALERTS = 'alerts';
const GROUP_GAP_MS = 5 * 60 * 1000;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- storage (per tab, so several tabs act as distinct nodes; best effort) ------

function load<T>(key: string): T | undefined {
  try {
    const v = sessionStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}
function save(key: string, v: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

function loadIdentity(): Identity {
  const s = load<{ ed: string; x: string }>('chax.identity');
  if (s) return identityFromSecrets(fromHex(s.ed), fromHex(s.x));
  const id = createIdentity();
  save('chax.identity', { ed: toHex(id.edPriv), x: toHex(id.xPriv) });
  return id;
}

// ---- state --------------------------------------------------------------------

const history: Record<string, Line[]> = load('chax.history') ?? {};
const unread: Record<string, number> = {};
const names = new Map<string, string>(Object.entries(load<Record<string, string>>('chax.names') ?? {}));
let current = PUBLIC;
let node: ChaxNode;
let stick = true;

function persist(): void {
  save('chax.history', history);
}

function push(conv: string, line: Line): void {
  const list = (history[conv] ??= []);
  list.push(line);
  if (list.length > 200) list.shift();
  persist();
  const visible = conv === current && !document.hidden && $('app').dataset.view === 'chat';
  if (conv === current) renderChat(line.mine);
  if (!line.mine && !visible) unread[conv] = (unread[conv] ?? 0) + 1;
  renderList();
  updateTitle();
}

// ---- small helpers ------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function icon(name: string, small = false): SVGSVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', small ? 'i s' : 'i');
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', `#i-${name}`);
  s.append(u);
  return s;
}

function hue(key: string): number {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function avatar(key: string, label: string, presence?: boolean): HTMLElement {
  const a = el('span', 'av');
  if (key === PUBLIC) {
    a.classList.add('room');
    a.append(icon('hash'));
  } else if (key === ALERTS) {
    a.classList.add('room', 'alert');
    a.append(icon('alert'));
  } else {
    a.style.setProperty('--h', String(hue(key)));
    a.append(document.createTextNode((label.trim()[0] ?? '?').toUpperCase()));
    if (presence !== undefined) a.append(el('span', `pres${presence ? ' on' : ''}`));
  }
  return a;
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function stamp(t: number): string {
  const d = new Date(t);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(t);
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function dayLabel(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === y.toDateString()) return 'Hier';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

function spaced(hex: string): string {
  return hex.replace(/(.{4})/g, '$1 ').trim();
}

let toastTimer: number | undefined;
function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 1800);
}

function neighborIds(): Set<string> {
  return new Set(node.neighbors.values());
}

function isPeerKey(k: string): boolean {
  return k !== PUBLIC && k !== ALERTS;
}

// ---- conversation list ---------------------------------------------------------

let listSig = '';
function renderList(): void {
  const online = neighborIds();
  const hasNeighbors = node.neighbors.size > 0;
  let renamed = false;
  for (const [id, p] of node.peers) {
    const nm = p.nickname || id.slice(0, 8);
    if (id !== node.peerId && names.get(id) !== nm) {
      names.set(id, nm);
      renamed = true;
    }
  }
  if (renamed) save('chax.names', Object.fromEntries(names));

  // mesh status
  const mesh = $('mesh');
  mesh.classList.toggle('on', hasNeighbors);
  const n = node.neighbors.size;
  const carried = node.store.all(Date.now()).filter((p) => p.type !== PacketType.ANNOUNCE).length;
  $('meshTitle').textContent = hasNeighbors ? `${n} appareil${n > 1 ? 's' : ''} à portée` : 'Personne à portée';
  $('meshSub').textContent = hasNeighbors
    ? carried > 0
      ? `${carried} message${carried > 1 ? 's' : ''} porté${carried > 1 ? 's' : ''} pour d’autres`
      : 'Vos messages partent tout de suite'
    : 'Vos messages privés attendent un voisin';

  const keys = [...new Set([...node.peers.keys()].filter((k) => k !== node.peerId).concat(Object.keys(history).filter(isPeerKey)))];
  const last = (k: string) => history[k]?.[history[k]!.length - 1];
  keys.sort((a, b) => (last(b)?.at ?? 0) - (last(a)?.at ?? 0) || (names.get(a) ?? '').localeCompare(names.get(b) ?? ''));

  const rows = [PUBLIC, ALERTS, ...keys].map((k) => ({
    k,
    label: k === PUBLIC ? 'Public' : k === ALERTS ? 'Alertes' : (names.get(k) ?? k.slice(0, 8)),
    pv: last(k),
    un: unread[k] ?? 0,
    on: isPeerKey(k) ? online.has(k) : undefined,
    cur: k === current,
  }));
  const sig = JSON.stringify(rows);
  if (sig === listSig) return;
  listSig = sig;

  const nav = $('convs');
  const hadFocus = nav.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.k : undefined;
  nav.replaceChildren();
  nav.append(el('div', 'group', 'Salons'));
  for (const r of rows.slice(0, 2)) nav.append(row(r));
  nav.append(el('div', 'group', `Personnes (${keys.length})`));
  if (!keys.length) {
    nav.append(el('p', 'empty-list', 'Personne pour l’instant. Les appareils proches apparaîtront ici dès qu’ils seront détectés.'));
  }
  for (const r of rows.slice(2)) nav.append(row(r));
  if (hadFocus) nav.querySelector<HTMLElement>(`[data-k="${CSS.escape(hadFocus)}"]`)?.focus();
}

function row(r: { k: string; label: string; pv?: Line; un: number; on?: boolean; cur: boolean }): HTMLButtonElement {
  const b = el('button', `conv${r.un ? ' unread' : ''}`);
  b.type = 'button';
  b.dataset.k = r.k;
  if (r.cur) b.setAttribute('aria-current', 'true');
  b.append(avatar(r.k, r.label, r.on));
  const txt = el('span', 'txt');
  const top = el('span', 'row');
  top.append(el('span', 'nm', r.label));
  if (r.pv) top.append(el('span', 'tm', stamp(r.pv.at)));
  const bottom = el('span', 'row');
  const preview = r.pv ? `${r.pv.mine ? 'Vous : ' : r.k === PUBLIC || r.k === ALERTS ? `${r.pv.from} : ` : ''}${r.pv.text}` : emptyPreview(r.k, r.on);
  bottom.append(el('span', 'pv', preview));
  if (r.un) bottom.append(el('span', `badge${r.k === ALERTS ? ' alert' : ''}`, String(r.un)));
  txt.append(top, bottom);
  b.append(txt);
  b.onclick = () => open(r.k);
  return b;
}

function emptyPreview(k: string, on?: boolean): string {
  if (k === PUBLIC) return 'Visible par tout le mesh';
  if (k === ALERTS) return 'Urgences signées';
  return on ? 'À portée · dites bonjour' : 'Hors de portée';
}

// ---- chat pane -----------------------------------------------------------------

function open(key: string): void {
  const wasList = $('app').dataset.view === 'list';
  current = key;
  unread[key] = 0;
  stick = true;
  $('app').dataset.view = 'chat';
  if (wasList && window.matchMedia('(max-width: 760px)').matches) history_push();
  renderChat(true);
  renderList();
  updateTitle();
  if (!window.matchMedia('(max-width: 760px)').matches) ($('text') as HTMLTextAreaElement).focus();
}

function history_push(): void {
  try {
    window.history.pushState({ chat: true }, '');
  } catch {
    /* ignore */
  }
}

function backToList(): void {
  $('app').dataset.view = 'list';
}
$('back').onclick = () => {
  if (window.history.state?.chat) window.history.back();
  else backToList();
};
window.addEventListener('popstate', backToList);

function statusOf(l: Line): Status | undefined {
  if (!l.mine || !l.status) return undefined;
  if (l.status === 'pending' && node.neighbors.size > 0) return 'sent';
  return l.status;
}

function metaFor(l: Line): HTMLElement {
  const m = el('span', 'meta');
  const st = statusOf(l);
  m.append(document.createTextNode(clock(l.at)));
  if (st === 'delivered') {
    m.classList.add('ok');
    m.append(icon('checks', true), document.createTextNode('Remis'));
  } else if (st === 'sent') {
    m.append(icon('check', true), document.createTextNode('Envoyé'));
  } else if (st === 'pending') {
    m.classList.add('pending');
    m.append(icon('clock', true), document.createTextNode('En attente d’un voisin'));
  }
  return m;
}

function renderChat(forceBottom = false): void {
  const box = $('msgs');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const list = history[current] ?? [];
  box.replaceChildren();
  header();
  composer();

  if (!list.length) {
    const e = el('div', 'empty');
    e.append(icon(current === ALERTS ? 'alert' : current === PUBLIC ? 'radio' : 'lock'));
    if (current === PUBLIC) {
      e.append(el('b', undefined, 'Le salon de tout le mesh'));
      e.append(el('span', undefined, 'Chaque appareil à portée reçoit vos messages et les fait suivre. Ouvrez ChaX dans un autre onglet pour essayer.'));
    } else if (current === ALERTS) {
      e.append(el('b', undefined, 'Aucune alerte'));
      e.append(el('span', undefined, 'Une alerte est signée, prioritaire, et portée par les relais jusqu’à 24 h : même ceux qui arrivent plus tard la reçoivent.'));
    } else {
      e.append(el('b', undefined, `Dites bonjour à ${names.get(current) ?? 'ce contact'}`));
      e.append(el('span', undefined, 'Vos messages sont chiffrés. Si la personne est hors de portée, un relais les porte jusqu’à son retour.'));
    }
    box.append(e);
  }

  let prev: Line | undefined;
  for (const l of list) {
    if (!prev || new Date(prev.at).toDateString() !== new Date(l.at).toDateString()) box.append(el('div', 'day', dayLabel(l.at)));
    const cont = !!prev && prev.mine === l.mine && prev.from === l.from && l.at - prev.at < GROUP_GAP_MS && new Date(prev.at).toDateString() === new Date(l.at).toDateString();
    const m = el('div', `m${l.mine ? ' mine' : ''}${l.alert ? ' alert' : ''}${cont ? ' cont' : ''}`);
    if (!l.mine && !cont && current !== names.get(current)) {
      if (!isPeerKey(current)) m.append(el('span', 'who', l.from));
    }
    m.append(el('div', 'b', l.text));
    const nextSame = list[list.indexOf(l) + 1];
    const lastOfGroup = !nextSame || nextSame.mine !== l.mine || nextSame.from !== l.from || nextSame.at - l.at >= GROUP_GAP_MS;
    if (lastOfGroup || statusOf(l) === 'pending') m.append(metaFor(l));
    box.append(m);
    prev = l;
  }

  if (forceBottom || stick || nearBottom) {
    box.scrollTop = box.scrollHeight;
    $('jump').classList.add('hide');
  } else {
    $('jump').classList.remove('hide');
  }
}

$('msgs').addEventListener('scroll', () => {
  const b = $('msgs');
  stick = b.scrollHeight - b.scrollTop - b.clientHeight < 80;
  if (stick) $('jump').classList.add('hide');
});
$('jump').onclick = () => {
  const b = $('msgs');
  b.scrollTop = b.scrollHeight;
};

function header(): void {
  const online = neighborIds();
  $('chAv').replaceWith(Object.assign(avatar(current, names.get(current) ?? '', isPeerKey(current) ? online.has(current) : undefined), { id: 'chAv' }));
  const title = current === PUBLIC ? 'Public' : current === ALERTS ? 'Alertes' : (names.get(current) ?? current.slice(0, 8));
  $('title').textContent = title;
  let sub = '';
  if (current === PUBLIC) sub = `${node.neighbors.size} à portée · visible par tout le mesh`;
  else if (current === ALERTS) sub = 'Signées, prioritaires, portées par les relais';
  else sub = online.has(current) ? 'À portée · chiffré de bout en bout' : 'Hors de portée · un relais portera vos messages';
  $('sub').textContent = sub;
}

function composer(): void {
  const form = $('composer');
  const alert = current === ALERTS;
  form.classList.toggle('alert', alert);
  const input = $<HTMLTextAreaElement>('text');
  input.placeholder = alert ? 'Lieu, danger, besoin : soyez précis et bref' : current === PUBLIC ? 'Écrire au mesh' : `Message à ${names.get(current) ?? 'ce contact'}`;
  const lbl = $('sendLbl');
  lbl.textContent = alert ? 'Diffuser l’alerte' : 'Envoyer';
  $('sendBtn').setAttribute('aria-label', alert ? 'Diffuser l’alerte' : 'Envoyer');
  const hint = $('hint');
  hint.replaceChildren();
  if (alert) hint.append(icon('alert', true), document.createTextNode('Part chez tout le monde, y compris les appareils qui arriveront plus tard (24 h).'));
  else if (current === PUBLIC) hint.append(icon('radio', true), document.createTextNode('Entrée pour envoyer · Maj+Entrée pour un retour à la ligne'));
  else hint.append(icon('lock', true), document.createTextNode('Chiffré de bout en bout · Entrée pour envoyer'));
  syncSend();
}

function syncSend(): void {
  ($('sendBtn') as HTMLButtonElement).disabled = !$<HTMLTextAreaElement>('text').value.trim();
}

function autosize(): void {
  const t = $<HTMLTextAreaElement>('text');
  t.style.height = 'auto';
  t.style.height = `${Math.min(140, t.scrollHeight)}px`;
}

function updateTitle(): void {
  const total = Object.values(unread).reduce((a, b) => a + b, 0);
  document.title = total ? `(${total}) ChaX` : 'ChaX';
}

// ---- actions -------------------------------------------------------------------

function submit(): void {
  const input = $<HTMLTextAreaElement>('text');
  const text = input.value.trim();
  if (!text) return;
  const base = { mine: true, from: node.nickname, text, at: Date.now() };
  if (current === PUBLIC) {
    node.sendBroadcast(text);
    push(PUBLIC, base);
  } else if (current === ALERTS) {
    node.sendAlert(text);
    push(ALERTS, { ...base, alert: true });
  } else {
    try {
      const id = toHex(node.sendDirect(current, text));
      push(current, { ...base, id, status: node.neighbors.size ? 'sent' : 'pending' });
    } catch {
      toast('Clé de ce contact inconnue : réessayez dans un instant');
      return;
    }
  }
  input.value = '';
  autosize();
  syncSend();
  stick = true;
}

$('composer').onsubmit = (ev) => {
  ev.preventDefault();
  submit();
};
$('text').addEventListener('input', () => {
  autosize();
  syncSend();
});
$('text').addEventListener('keydown', (ev) => {
  const e = ev as KeyboardEvent;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});
$('fp').onclick = async () => {
  try {
    await navigator.clipboard.writeText(node.peerId);
    toast('Empreinte copiée');
  } catch {
    toast(`Empreinte : ${spaced(node.peerId)}`);
  }
};
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && $('app').dataset.view === 'chat') {
    unread[current] = 0;
    renderList();
    updateTitle();
  }
});

// ---- boot ----------------------------------------------------------------------

function start(nickname: string): void {
  const transport = new BroadcastChannelTransport();
  node = new ChaxNode({ transport, identity: loadIdentity(), nickname });
  $('welcome').classList.add('hide');
  $('app').classList.remove('hide');
  $('meName').textContent = nickname;
  $('meFp').textContent = spaced(node.peerId);
  $('meAv').replaceWith(Object.assign(avatar(node.peerId, nickname), { id: 'meAv' }));

  node.onMessage((m: ChatMessage) => {
    const who = m.nickname || m.from.slice(0, 8);
    const line: Line = { mine: false, from: who, text: m.text, at: Date.now() };
    if (m.alert) push(ALERTS, { ...line, alert: true });
    else if (m.direct) push(m.from, line);
    else push(PUBLIC, line);
  });
  node.onDelivered((id) => {
    for (const list of Object.values(history)) {
      const l = list.find((x) => x.id === id);
      if (l) l.status = 'delivered';
    }
    persist();
    renderChat();
  });

  setInterval(() => {
    renderList();
    header();
    // pending -> sent as soon as a neighbour shows up
    if (isPeerKey(current) && (history[current] ?? []).some((l) => l.status === 'pending')) renderChat();
  }, 1000);

  const wide = !window.matchMedia('(max-width: 760px)').matches;
  $('app').dataset.view = wide ? 'chat' : 'list';
  renderChat(true);
  renderList();
}

const saved = load<string>('chax.nick');
if (saved) {
  start(saved);
} else {
  $('welcome').classList.remove('hide');
  const nick = $<HTMLInputElement>('nick');
  nick.value = `anon-${Math.random().toString(36).slice(2, 6)}`;
  nick.focus();
  nick.select();
  $('welcomeForm').onsubmit = (ev) => {
    ev.preventDefault();
    const n = nick.value.trim() || 'anon';
    save('chax.nick', n);
    start(n);
  };
}
