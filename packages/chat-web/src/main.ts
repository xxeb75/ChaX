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

interface Line {
  mine: boolean;
  from: string; // nickname shown for others
  text: string;
  at: number;
  alert?: boolean;
}

const PUBLIC = 'public';
const ALERTS = 'alerts';
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
const names = new Map<string, string>(); // peerId hex -> last known nickname
let current = PUBLIC;
let node: ChaxNode;

function push(conv: string, line: Line): void {
  const list = (history[conv] ??= []);
  list.push(line);
  if (list.length > 200) list.shift();
  save('chax.history', history);
  if (conv === current) renderMessages();
  else unread[conv] = (unread[conv] ?? 0) + 1;
  renderConvs();
}

// ---- rendering ----------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fmt(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderMessages(): void {
  const box = $('msgs');
  box.replaceChildren();
  const list = history[current] ?? [];
  if (!list.length) {
    const e = el('div', 'empty');
    e.textContent =
      current === PUBLIC
        ? "Salon public : tout nœud à portée du mesh le reçoit. Ouvrez ChaX dans un autre onglet pour discuter."
        : current === ALERTS
          ? 'Les alertes signées apparaissent ici. Elles sont portées par les relais jusqu’à expiration.'
          : 'Message privé chiffré de bout en bout. Il sera porté par les relais si la personne est hors de portée.';
    box.append(e);
  }
  for (const l of list) {
    const m = el('div', `m${l.mine ? ' mine' : ''}${l.alert ? ' alert' : ''}`);
    if (!l.mine) m.append(el('div', 'who', l.from));
    m.append(document.createTextNode(l.text));
    m.append(el('span', 't', fmt(l.at)));
    box.append(m);
  }
  box.scrollTop = box.scrollHeight;
  unread[current] = 0;
  const isPeer = current !== PUBLIC && current !== ALERTS;
  $('title').textContent = current === PUBLIC ? '# Public' : current === ALERTS ? '⚠ Alertes' : `🔒 ${names.get(current) ?? current.slice(0, 8)}`;
  $('sub').textContent = isPeer ? `empreinte ${current.slice(0, 8)}` : '';
  $('alertBtn').classList.toggle('hide', current !== ALERTS && current !== PUBLIC);
  ($('text') as HTMLInputElement).disabled = current === ALERTS;
}

function convButton(key: string, label: string, online?: boolean): HTMLButtonElement {
  const b = el('button', `conv${key === current ? ' active' : ''}`);
  if (online !== undefined) b.append(el('span', `dot${online ? ' on' : ''}`));
  b.append(el('span', 'name', label));
  const n = unread[key] ?? 0;
  if (n > 0) b.append(el('span', 'badge', String(n)));
  b.onclick = () => {
    current = key;
    renderMessages();
    renderConvs();
  };
  return b;
}

function renderConvs(): void {
  const nav = $('convs');
  nav.replaceChildren();
  nav.append(el('h3', undefined, 'Salons'));
  nav.append(convButton(PUBLIC, '# Public'), convButton(ALERTS, '⚠ Alertes'));
  const online = new Set(node.neighbors.values());
  const peers = [...node.peers.entries()].filter(([id]) => id !== node.peerId);
  nav.append(el('h3', undefined, `Contacts (${peers.length})`));
  for (const [id, p] of peers) {
    names.set(id, p.nickname || id.slice(0, 8));
    nav.append(convButton(id, p.nickname || id.slice(0, 8), online.has(id)));
  }
  $('nNeighbors').textContent = String(node.neighbors.size);
  $('nCarried').textContent = String(
    node.store.all(Date.now()).filter((p) => p.type !== PacketType.ANNOUNCE).length,
  );
}

// ---- actions ------------------------------------------------------------------

$('send').onsubmit = (ev) => {
  ev.preventDefault();
  const input = $<HTMLInputElement>('text');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  if (current === PUBLIC) {
    node.sendBroadcast(text);
    push(PUBLIC, { mine: true, from: node.nickname, text, at: Date.now() });
  } else if (current !== ALERTS) {
    try {
      node.sendDirect(current, text);
      push(current, { mine: true, from: node.nickname, text, at: Date.now() });
    } catch {
      push(current, { mine: false, from: 'ChaX', text: 'Clé inconnue : impossible de chiffrer pour le moment.', at: Date.now() });
    }
  }
};

$('alertBtn').onclick = () => {
  const input = $<HTMLInputElement>('text');
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }
  input.value = '';
  node.sendAlert(text);
  push(ALERTS, { mine: true, from: node.nickname, text, at: Date.now(), alert: true });
};

// ---- boot ---------------------------------------------------------------------

function start(nickname: string): void {
  const transport = new BroadcastChannelTransport();
  node = new ChaxNode({ transport, identity: loadIdentity(), nickname });
  $('meName').textContent = nickname;
  $('meId').textContent = `empreinte ${node.peerId}`;
  node.onMessage((m: ChatMessage) => {
    const who = m.nickname || m.from.slice(0, 8);
    if (m.alert) push(ALERTS, { mine: false, from: who, text: m.text, at: Date.now(), alert: true });
    else if (m.direct) push(m.from, { mine: false, from: who, text: m.text, at: Date.now() });
    else push(PUBLIC, { mine: false, from: who, text: m.text, at: Date.now() });
  });
  setInterval(renderConvs, 1000);
  renderConvs();
  renderMessages();
}

const saved = load<string>('chax.nick');
if (saved) {
  start(saved);
} else {
  $('setup').classList.remove('hide');
  $<HTMLInputElement>('nick').value = `anon-${Math.random().toString(36).slice(2, 6)}`;
  $('setupForm').onsubmit = (ev) => {
    ev.preventDefault();
    const n = $<HTMLInputElement>('nick').value.trim() || 'anon';
    save('chax.nick', n);
    $('setup').classList.add('hide');
    start(n);
  };
}
