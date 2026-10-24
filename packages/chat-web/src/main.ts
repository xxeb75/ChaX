import {
  BleTransport,
  BroadcastChannelTransport,
  ChaxNode,
  PacketType,
  WebSocketTransport,
  createIdentity,
  fromHex,
  identityFromSecrets,
  toHex,
  type BleBridge,
  type ChatMessage,
  type Identity,
  type Transport,
} from '../../core/src';

type Status = 'pending' | 'transit' | 'delivered' | 'read';

interface Line {
  id?: string; // hex msgId
  mine: boolean;
  from: string;
  text: string;
  at: number;
  alert?: boolean;
  status?: Status; // our own direct messages
  readSent?: boolean; // a received direct message we already acknowledged as read
}

const PUBLIC = 'public';
const ALERTS = 'alerts';
const GROUP_GAP_MS = 5 * 60 * 1000;
const WIDE = '(min-width: 761px)';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- storage -------------------------------------------------------------------
// Native app: one WebView, so identity and history must outlive the process (localStorage).
// Browser tabs: sessionStorage, so several tabs act as distinct nodes.

const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, any> } }).Capacitor;
const native = !!cap?.isNativePlatform?.();
const store = (): Storage => (native ? localStorage : sessionStorage);

function load<T>(key: string): T | undefined {
  try {
    const v = store().getItem(key);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}
function save(key: string, v: unknown): void {
  try {
    store().setItem(key, JSON.stringify(v));
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

// ---- state ---------------------------------------------------------------------

const history: Record<string, Line[]> = load('chax.history') ?? {};
for (const list of Object.values(history)) {
  for (const l of list) if ((l.status as string) === 'sent') l.status = 'transit'; // older builds
}
const unread: Record<string, number> = {};
const names = new Map<string, string>(Object.entries(load<Record<string, string>>('chax.names') ?? {}));
let current = PUBLIC;
let cursor = PUBLIC; // keyboard cursor in the list
let query = '';
let node: ChaxNode;
let relay: WebSocketTransport | undefined;
let ble: BleTransport | undefined;
let bleError = '';
let stick = true;

const wide = () => window.matchMedia(WIDE).matches;
const isPeerKey = (k: string) => k !== PUBLIC && k !== ALERTS;
const persist = () => save('chax.history', history);

// ---- helpers -------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function span(cls: string, text: string): HTMLSpanElement {
  return el('span', cls, text);
}

function clock(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function stamp(t: number): string {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? clock(t) : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function dayLabel(t: number): string {
  const d = new Date(t);
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "aujourd'hui";
  if (d.toDateString() === y.toDateString()) return 'hier';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
}

const spaced = (hex: string) => hex.replace(/(.{4})/g, '$1 ').trim();
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const neighborIds = () => new Set(node.neighbors.values());
const labelOf = (k: string) => (k === PUBLIC ? 'public' : k === ALERTS ? 'alertes' : (names.get(k) ?? k.slice(0, 8)));

let flashTimer: number | undefined;
function flash(msg: string): void {
  $('flash').textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => ($('flash').textContent = ''), 2200);
}

function push(conv: string, line: Line): void {
  const list = (history[conv] ??= []);
  list.push(line);
  if (list.length > 200) list.shift();
  persist();
  const seen = conv === current && viewing();
  if (conv === current) renderChat(line.mine);
  if (!line.mine && !seen) unread[conv] = (unread[conv] ?? 0) + 1;
  renderList();
  updateTitle();
  if (seen) sendReceipts();
}

/** The conversation is on screen and the app is in the foreground. */
function viewing(): boolean {
  return !document.hidden && (wide() || $('app').dataset.view === 'chat');
}

// ---- read receipts -------------------------------------------------------------

function sendReceipts(): void {
  if (!isPeerKey(current) || !viewing()) return;
  const fresh = (history[current] ?? []).filter((l) => !l.mine && l.id && !l.readSent);
  if (!fresh.length) return;
  node.sendRead(current, fresh.map((l) => l.id!));
  for (const l of fresh) l.readSent = true;
  persist();
}

// ---- sonde: one glyph per known device, bright when in range --------------------

let pingTimer: number | undefined;
let lastPing = 0;
function ping(): void {
  const now = Date.now();
  if (now - lastPing < 300) return;
  lastPing = now;
  const s = $('sonde');
  s.classList.remove('ping');
  void s.offsetWidth; // restart the animation
  s.classList.add('ping');
  clearTimeout(pingTimer);
  pingTimer = window.setTimeout(() => s.classList.remove('ping'), 1400);
}

function renderSonde(): void {
  const online = neighborIds();
  const ids = [...node.peers.keys()].filter((k) => k !== node.peerId).sort((a, b) => Number(online.has(b)) - Number(online.has(a)));
  const s = $('sonde');
  const shown = ids.slice(0, 12);
  const sig = shown.map((k) => (online.has(k) ? '1' : '0')).join('');
  if (s.dataset.sig !== sig) {
    s.dataset.sig = sig;
    s.replaceChildren();
    if (!shown.length) shown.push('');
    shown.forEach((k, i) => {
      const g = el('i', online.has(k) ? 'on' : '', online.has(k) ? '•' : '·');
      g.style.setProperty('--i', String(i));
      s.append(g);
    });
  }
  const n = node.neighbors.size;
  const carried = node.store.all(Date.now()).filter((p) => p.type !== PacketType.ANNOUNCE).length;
  let txt: string;
  if (ble && bleError) txt = `bluetooth indisponible · ${bleError}`;
  else if (relay && !relay.connected) txt = 'relais injoignable · nouvelle tentative';
  else if (n) txt = `${n} à portée${carried ? ` · ${carried} porté${carried > 1 ? 's' : ''}` : ''}`;
  else txt = 'personne à portée';
  if ($('meshTxt').textContent !== txt) $('meshTxt').textContent = txt;
}

// ---- conversation list: the depth queue -----------------------------------------

interface Row {
  k: string;
  label: string;
  last?: Line;
  un: number;
  on?: boolean;
}

function lastOf(k: string): Line | undefined {
  const l = history[k];
  return l?.[l.length - 1];
}

function buildRows(): Row[] {
  const online = neighborIds();
  let renamed = false;
  for (const [id, p] of node.peers) {
    const nm = p.nickname || id.slice(0, 8);
    if (id !== node.peerId && names.get(id) !== nm) {
      names.set(id, nm);
      renamed = true;
    }
  }
  if (renamed) save('chax.names', Object.fromEntries(names));

  const peerKeys = [...new Set([...node.peers.keys()].filter((k) => k !== node.peerId).concat(Object.keys(history).filter(isPeerKey)))];
  const rows: Row[] = [PUBLIC, ALERTS, ...peerKeys].map((k) => ({
    k,
    label: labelOf(k),
    last: lastOf(k),
    un: unread[k] ?? 0,
    on: isPeerKey(k) ? online.has(k) : undefined,
  }));
  const order = (r: Row) => (r.k === PUBLIC ? 0 : r.k === ALERTS ? 1 : 2);
  rows.sort(
    (a, b) =>
      (b.last?.at ?? 0) - (a.last?.at ?? 0) ||
      order(a) - order(b) ||
      Number(b.on ?? false) - Number(a.on ?? false) ||
      a.label.localeCompare(b.label),
  );
  const q = fold(query.trim());
  return q ? rows.filter((r) => fold(r.label).includes(q)) : rows;
}

let listSig = '';
function renderList(): void {
  renderSonde();
  const rows = buildRows();
  const typing = document.activeElement === $('q');
  const highlighted = typing ? cursor : wide() ? current : '';
  const sig = JSON.stringify([rows, highlighted, current, query]);
  $('count').textContent = String(rows.length);
  if (sig === listSig) return;
  listSig = sig;

  const nav = $('convs');
  const focused = nav.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.k : undefined;
  nav.replaceChildren();
  if (!rows.length) nav.append(el('p', 'none', 'Aucune conversation ne correspond. Effacez la recherche pour tout revoir.'));
  rows.forEach((r, i) => nav.append(rowEl(r, i, r.k === highlighted)));
  if (focused) nav.querySelector<HTMLElement>(`[data-k="${CSS.escape(focused)}"]`)?.focus();
}

function rowEl(r: Row, i: number, selected: boolean): HTMLButtonElement {
  const tier = i === 0 ? 0 : i <= 2 ? 1 : i <= 5 ? 2 : 3;
  const b = el('button', `row d${tier}${selected ? ' selected' : ''}${r.k === ALERTS ? ' alertRow' : ''}`);
  b.type = 'button';
  b.dataset.k = r.k;
  if (r.k === current) b.setAttribute('aria-current', 'true');

  const l1 = el('span', 'l1');
  const glyph = r.k === PUBLIC ? '#' : r.k === ALERTS ? '!' : r.on ? '•' : '·';
  const g = span(`glyph${r.on ? ' on' : ''}`, glyph);
  g.setAttribute('aria-hidden', 'true');
  l1.append(g, span('nm', r.label));
  if (isPeerKey(r.k)) l1.append(span('sr', r.on ? ', à portée' : ', hors de portée'));
  l1.append(span('fill', ''));

  const meta = span('meta', '');
  if (r.un) meta.append(span('n', `+${r.un}`));
  if (tier === 0 && !selected) meta.append(span('hint', 'ouvrir ›'));
  else if (r.last) meta.append(document.createTextNode(stamp(r.last.at)));
  l1.append(meta);
  b.append(l1);

  if (tier === 0 && r.last) {
    const who = r.last.mine ? 'vous' : r.last.from;
    b.append(span('pv', `${who} › ${r.last.text.replace(/\s+/g, ' ')}`));
  }
  b.onclick = () => open(r.k);
  return b;
}

// ---- chat pane --------------------------------------------------------------------

function open(key: string): void {
  const wasList = $('app').dataset.view === 'list';
  current = key;
  cursor = key;
  unread[key] = 0;
  stick = true;
  $('app').dataset.view = 'chat';
  if (wasList && !wide()) {
    try {
      window.history.pushState({ chat: true }, '');
    } catch {
      /* ignore */
    }
  }
  renderChat(true);
  renderList();
  updateTitle();
  sendReceipts();
  if (wide()) ($('text') as HTMLTextAreaElement).focus();
}

function backToList(): void {
  $('app').dataset.view = 'list';
  renderList();
}
$('back').onclick = () => {
  if (window.history.state?.chat) window.history.back();
  else backToList();
};
window.addEventListener('popstate', backToList);

function statusOf(l: Line): Status | undefined {
  if (!l.mine || !l.status) return undefined;
  if (l.status === 'pending' && node.neighbors.size > 0) return 'transit';
  return l.status;
}

function statusEl(st: Status): HTMLElement {
  const s = el('div', `st${st === 'read' ? ' read' : st === 'pending' ? ' wait' : ''}`);
  const glyph = st === 'pending' ? '…' : st === 'transit' ? '›' : '››';
  const word = st === 'pending' ? "en attente d'un voisin" : st === 'transit' ? 'en transit' : st === 'delivered' ? 'remis' : 'lu';
  const g = span('g', glyph);
  g.setAttribute('aria-hidden', 'true');
  s.append(g, span('w', word));
  return s;
}

function header(): void {
  const online = neighborIds();
  $('title').textContent = current === PUBLIC ? 'public' : current === ALERTS ? 'alertes' : labelOf(current);
  const sub = $('sub');
  sub.replaceChildren();
  const left =
    current === PUBLIC
      ? span('', `${node.neighbors.size} à portée`)
      : current === ALERTS
        ? span('', 'signées · prioritaires')
        : span(online.has(current) ? 'ivory' : '', online.has(current) ? 'à portée' : 'hors de portée');
  const right =
    current === PUBLIC
      ? 'visible par tout le mesh'
      : current === ALERTS
        ? 'portées 24 h par les relais'
        : online.has(current)
          ? 'chiffré de bout en bout'
          : 'un relais portera vos messages';
  sub.append(left, span('fill', ''), span('', right));
}

function composer(): void {
  const alert = current === ALERTS;
  $('composer').classList.toggle('alert', alert);
  const input = $<HTMLTextAreaElement>('text');
  input.placeholder = alert ? 'lieu, danger, besoin : bref et précis' : current === PUBLIC ? 'écrire au mesh' : `écrire à ${labelOf(current)}`;
  $('sendLbl').textContent = alert ? "diffuser l'alerte" : 'envoyer';
  const hint = $('hint');
  hint.replaceChildren();
  hint.append(
    document.createTextNode(alert ? 'part chez tout le monde, y compris ceux qui arriveront plus tard' : isPeerKey(current) ? 'chiffré' : 'visible par tous'),
  );
  if (!alert) hint.append(span('kb', ' · entrée envoie, maj+entrée saute une ligne'));
  syncSend();
}

function renderChat(forceBottom = false): void {
  const box = $('msgs');
  const log = $('log');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const list = history[current] ?? [];
  log.replaceChildren();
  header();
  composer();

  if (!list.length) {
    const e = el('div', 'empty');
    if (current === PUBLIC) {
      e.append(span('t', 'le salon de tout le mesh'));
      e.append(el('div', undefined, 'Chaque appareil à portée reçoit vos messages et les fait suivre.'));
    } else if (current === ALERTS) {
      e.append(span('t', 'aucune alerte'));
      e.append(el('div', undefined, 'Une alerte est signée et prioritaire. Les relais la portent 24 h : même ceux qui arrivent plus tard la reçoivent.'));
    } else {
      e.append(span('t', `dites bonjour à ${labelOf(current)}`));
      e.append(el('div', undefined, 'Vos messages sont chiffrés. Hors de portée, un relais les porte jusqu’au retour, et vous voyez où ils en sont : en transit, remis, lu.'));
    }
    log.append(e);
  }

  const lastRead = [...list].reverse().find((l) => statusOf(l) === 'read');
  let prev: Line | undefined;
  list.forEach((l, i) => {
    const fromEnd = list.length - 1 - i;
    if (!prev || new Date(prev.at).toDateString() !== new Date(l.at).toDateString()) log.append(el('div', 'day', dayLabel(l.at)));
    const cont =
      !!prev && !l.alert && !prev.alert && prev.mine === l.mine && prev.from === l.from && l.at - prev.at < GROUP_GAP_MS && new Date(prev.at).toDateString() === new Date(l.at).toDateString();
    const tier = fromEnd === 0 ? 0 : fromEnd <= 2 ? 1 : 2;
    const m = el('div', `msg t${tier} ${l.mine ? 'mine' : 'theirs'}${l.alert ? ' alert' : ''}${cont ? ' cont' : ''}`);
    if (l.alert) m.append(span('who', `alerte · ${l.mine ? 'vous' : l.from} · ${clock(l.at)}`));
    else if (!cont) m.append(span('who', `${l.mine ? 'vous' : l.from} · ${clock(l.at)}`));
    m.append(span('txt', l.text));
    const st = statusOf(l);
    if (st && (st !== 'read' || l === lastRead)) m.append(statusEl(st));
    log.append(m);
    prev = l;
  });

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

function syncSend(): void {
  ($('sendBtn') as HTMLButtonElement).disabled = !$<HTMLTextAreaElement>('text').value.trim();
}

function autosize(): void {
  const t = $<HTMLTextAreaElement>('text');
  t.style.height = 'auto';
  t.style.height = `${Math.min(144, t.scrollHeight)}px`;
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
      push(current, { ...base, id, status: node.neighbors.size ? 'transit' : 'pending' });
    } catch {
      flash('clé inconnue, réessayez');
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
  } else if (e.key === 'Escape') {
    ($('text') as HTMLTextAreaElement).blur();
    if (!wide()) $('back').click();
  }
});

$('q').addEventListener('input', () => {
  query = ($('q') as HTMLInputElement).value;
  const rows = buildRows();
  if (rows.length && !rows.some((r) => r.k === cursor)) cursor = rows[0]!.k;
  renderList();
});
$('q').addEventListener('focus', () => renderList());
$('q').addEventListener('blur', () => renderList());
$('q').addEventListener('keydown', (ev) => {
  const e = ev as KeyboardEvent;
  const rows = buildRows();
  const i = Math.max(0, rows.findIndex((r) => r.k === cursor));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (n) cursor = n.k;
    renderList();
    $('convs').querySelector<HTMLElement>('.selected')?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const target = rows.find((r) => r.k === cursor) ?? rows[0];
    if (target) {
      ($('q') as HTMLInputElement).value = '';
      query = '';
      open(target.k);
    }
  } else if (e.key === 'Escape') {
    ($('q') as HTMLInputElement).value = '';
    query = '';
    ($('q') as HTMLInputElement).blur();
    renderList();
  }
});
document.addEventListener('keydown', (ev) => {
  const t = ev.target as HTMLElement;
  if (ev.key === '/' && t.tagName !== 'INPUT' && t.tagName !== 'TEXTAREA') {
    ev.preventDefault();
    if (!wide() && $('app').dataset.view !== 'list') $('back').click();
    $('q').focus();
  }
});

$('fp').onclick = async () => {
  try {
    await navigator.clipboard.writeText(node.peerId);
    flash('empreinte copiée');
  } catch {
    flash(spaced(node.peerId));
  }
};
document.addEventListener('visibilitychange', () => {
  if (viewing()) {
    unread[current] = 0;
    renderList();
    updateTitle();
    sendReceipts();
  }
});
window.matchMedia(WIDE).addEventListener('change', () => {
  listSig = '';
  renderList();
});

// ---- boot ----------------------------------------------------------------------

function capacitorBridge(p: any): BleBridge {
  const toB64 = (b: Uint8Array) => {
    let t = '';
    for (const x of b) t += String.fromCharCode(x);
    return btoa(t);
  };
  const fromB64 = (t: string) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
  return {
    start: (nodeId) => p.start({ nodeId }),
    stop: () => p.stop(),
    send: (link, bytes) => p.send({ link, data: toB64(bytes) }),
    onLinkUp: (cb) => void p.addListener('linkUp', (e: { link: string }) => cb(e.link)),
    onLinkDown: (cb) => void p.addListener('linkDown', (e: { link: string }) => cb(e.link)),
    onFrame: (cb) => void p.addListener('frame', (e: { link: string; data: string }) => cb(e.link, fromB64(e.data))),
    onError: (cb) => void p.addListener('error', (e: { message: string }) => cb(e.message)),
  };
}

function setStatus(key: string, id: string, status: Status): void {
  const l = history[key]?.find((x) => x.id === id);
  if (l && l.status !== 'read') l.status = status;
}

function start(nickname: string): void {
  const param = new URLSearchParams(location.search).get('relay');
  if (param !== null) {
    relay = new WebSocketTransport(/^wss?:/.test(param) ? param : `ws://${location.hostname}:8787`);
    relay.onStatus(() => renderList());
  }
  if (native && cap?.Plugins?.ChaxBle) ble = new BleTransport(capacitorBridge(cap.Plugins.ChaxBle));
  const transport: Transport = ble ?? relay ?? new BroadcastChannelTransport();
  node = new ChaxNode({ transport, identity: loadIdentity(), nickname });
  transport.onReceive(() => ping());
  transport.onLinkUp((l) => console.info('[chax] link up', l));
  transport.onLinkDown((l) => console.info('[chax] link down', l));

  $('welcome').classList.add('hide');
  $('app').classList.remove('hide');
  $('meName').textContent = nickname;
  $('meFp').textContent = spaced(node.peerId);

  node.onMessage((m: ChatMessage) => {
    const who = m.nickname || m.from.slice(0, 8);
    console.info('[chax] message', m.direct ? 'direct' : m.alert ? 'alert' : 'public', who);
    const line: Line = { id: m.id, mine: false, from: who, text: m.text, at: Date.now() };
    if (m.alert) push(ALERTS, { ...line, alert: true });
    else if (m.direct) push(m.from, line);
    else push(PUBLIC, line);
  });
  const mark = (status: Status) => (id: string) => {
    for (const k of Object.keys(history)) setStatus(k, id, status);
    persist();
    renderChat();
  };
  node.onDelivered(mark('delivered'));
  node.onRead(mark('read'));

  if (ble) {
    ble.onError((m) => {
      bleError = m;
      renderList();
    });
    ble.start().then(
      () => (bleError = ''),
      (e: Error) => {
        bleError = e?.message ?? String(e);
        renderList();
      },
    );
  }

  setInterval(() => {
    renderList();
    header();
    sendReceipts();
    // pending -> in transit as soon as a neighbour shows up
    if (isPeerKey(current) && (history[current] ?? []).some((l) => l.status === 'pending')) renderChat();
  }, 1000);

  $('app').dataset.view = wide() ? 'chat' : 'list';
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
