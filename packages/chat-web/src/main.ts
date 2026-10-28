import {
  BleTransport,
  BroadcastChannelTransport,
  ChaxNode,
  DEFAULT_RELAYS,
  MAX_ATTACHMENT,
  MultiTransport,
  NostrTransport,
  PacketType,
  WebSocketTransport,
  toHex,
  type BleBridge,
  type ChatMessage,
  type Transport,
} from '../../core/src';
import { windowsBridge, windowsHost } from './windows';
import { VERSION, autoCheck, check, checkOnLaunch, setAutoCheck, type Update } from './update';
import { encodeCode, parseCode, qrElement, scanCamera, type Trusted } from './verify';
import { ALERTS, MAX_LINES, IMAGE_MIMES, PUBLIC, cap, idb, load, loadIdentity, loadNet, native, putFile, save, type Line, type Status } from './store';

interface Incoming {
  key: string;
  label: string;
  received: number;
  total: number;
  at: number;
  dismissed?: boolean;
}

const GROUP_GAP_MS = 2 * 60 * 1000; // a pause longer than this starts a new group, with its own time
const WIDE = '(min-width: 761px)';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- attachments: bytes in IndexedDB, only metadata in the history ---------------------

const MAX_SIDE = 1024;
const urls = new Map<string, string>();

const dropFile = (id: string) => {
  const u = urls.get(id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(id);
  return idb('readwrite', (s) => s.delete(id)).catch(() => undefined);
};
async function fileUrl(id: string): Promise<string | undefined> {
  const known = urls.get(id);
  if (known) return known;
  const b = (await idb<Blob | undefined>('readonly', (s) => s.get(id)).catch(() => undefined)) as Blob | undefined;
  if (!b) return undefined;
  const u = URL.createObjectURL(b);
  urls.set(id, u);
  return u;
}

const isImage = (mime: string) => IMAGE_MIMES.has(mime);
function size(n: number): string {
  return n < 1024 ? `${n} o` : n < 1024 * 1024 ? `${Math.round(n / 1024)} Ko` : `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

/** Downscales a photo so it crosses a Bluetooth mesh in seconds, not minutes. */
async function shrink(f: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(f);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.6));
  if (!out) throw new Error('encode failed');
  return out;
}

// ---- state ---------------------------------------------------------------------

const history: Record<string, Line[]> = load('chax.history') ?? {};
for (const list of Object.values(history)) {
  for (const l of list) if ((l.status as string) === 'sent') l.status = 'transit'; // older builds
}
const trust: Record<string, Trusted> = load('chax.trust') ?? {}; // peers whose code we scanned in person
const hidden: Record<string, true> = load('chax.hidden') ?? {}; // contacts the user deleted: out of the list until they write again
const unread: Record<string, number> = load('chax.unread') ?? {}; // the headless node counts messages while the app is closed
const incoming = new Map<string, Incoming>(); // object id -> transfer in progress
const STALL_MS = 15_000;
const names = new Map<string, string>(Object.entries(load<Record<string, string>>('chax.names') ?? {}));
let current = PUBLIC;
let cursor = PUBLIC; // keyboard cursor in the list
let query = '';
let node: ChaxNode;
let relay: WebSocketTransport | undefined;
let ble: BleTransport | undefined;
let net: NostrTransport | undefined;
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
/** Neighbours reached by radio, as opposed to the ones only reachable through the internet relays. */
const rangeIds = () => new Set([...node.neighbors].filter(([l]) => !l.startsWith('net|')).map(([, p]) => p));
const isVerified = (k: string) => !!trust[k];
/** Someone not verified who goes by the name of a contact we did verify: the classic impersonation. */
const lookalike = (k: string) => isPeerKey(k) && !trust[k] && Object.entries(trust).some(([id, t]) => id !== k && t.name === names.get(k));
function labelOf(k: string): string {
  if (k === PUBLIC) return 'public';
  if (k === ALERTS) return 'alertes';
  const nm = names.get(k) ?? k.slice(0, 8);
  const twin = lookalike(k) || [...names].some(([o, n]) => o !== k && n === nm);
  return twin ? `${nm} · ${k.slice(0, 4)}` : nm;
}

let noticeTimer: number | undefined;
/** An error the user must see, whichever pane is open: ivory block above the composer. */
function fail(msg: string): void {
  $('noticeTxt').textContent = msg;
  $('notice').classList.remove('hide');
  clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => $('notice').classList.add('hide'), 7000);
  flash(msg);
}
$('noticeX').onclick = () => {
  clearTimeout(noticeTimer);
  $('notice').classList.add('hide');
};

let flashTimer: number | undefined;
function flash(msg: string): void {
  $('flash').textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => ($('flash').textContent = ''), 2200);
}

function push(conv: string, line: Line): void {
  const list = (history[conv] ??= []);
  list.push(line);
  if (!line.mine && hidden[conv]) {
    delete hidden[conv];
    save('chax.hidden', hidden);
  }
  if (list.length > MAX_LINES) {
    const old = list.shift()!;
    if (old.file && old.id) void dropFile(old.id);
  }
  persist();
  const seen = conv === current && viewing();
  if (conv === current) renderChat(line.mine);
  if (!line.mine && !seen) {
    unread[conv] = (unread[conv] ?? 0) + 1;
    if (document.hidden && conv !== PUBLIC) notifyNative(conv, line);
  }
  renderList();
  updateTitle();
  if (seen) sendReceipts();
}

/** The page is open but out of sight (screen off, other app): ask the OS to tell the user. */
function notifyNative(conv: string, line: Line): void {
  const p = cap?.Plugins?.ChaxBle;
  if (!native || !p?.notify) return;
  const body = line.file ? `Pièce jointe : ${line.file.name}` : line.text;
  void p.notify({ key: conv, title: conv === ALERTS ? `Alerte · ${line.from}` : line.from, body, alert: !!line.alert }).catch(() => undefined);
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
  const range = rangeIds().size;
  const viaNet = neighborIds().size - range;
  const n = range + viaNet;
  const carried = node.store.all(Date.now()).filter((p) => p.type !== PacketType.ANNOUNCE).length;
  let txt: string;
  if (ble && bleError) txt = `bluetooth indisponible · ${bleError}`;
  else if (relay && !relay.connected) txt = 'relais injoignable · nouvelle tentative';
  else if (n) {
    txt = [range ? `${range} à portée` : '', viaNet ? `${viaNet} par internet` : ''].filter(Boolean).join(' · ');
    if (carried) txt += ` · ${carried} porté${carried > 1 ? 's' : ''}`;
  } else txt = net?.running ? (net.connected ? 'personne · internet actif' : 'internet : connexion…') : 'personne à portée';
  const nb = document.getElementById('netBtn');
  if (nb) {
    nb.classList.toggle('hide', !net);
    const t = net?.running ? 'internet ●' : 'internet ›';
    if (nb.textContent !== t) nb.textContent = t;
  }
  if ($('meshTxt').textContent !== txt) $('meshTxt').textContent = txt;
}

// ---- conversation list: the depth queue -----------------------------------------

interface Row {
  k: string;
  label: string;
  last?: Line;
  un: number;
  on?: boolean;
  v?: number; // 1 verified, 2 lookalike of a verified contact
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

  const peerKeys = [...new Set([...node.peers.keys()].filter((k) => k !== node.peerId).concat(Object.keys(history).filter(isPeerKey)))].filter((k) => !hidden[k] || history[k]?.length);
  const rows: Row[] = [PUBLIC, ALERTS, ...peerKeys].map((k) => ({
    k,
    label: labelOf(k),
    last: lastOf(k),
    un: unread[k] ?? 0,
    on: isPeerKey(k) ? online.has(k) : undefined,
    v: isVerified(k) ? 1 : lookalike(k) ? 2 : 0,
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
  if (isVerified(r.k)) {
    l1.append(span('chk', '✓'), span('sr', ', vérifié'));
  } else if (lookalike(r.k)) {
    l1.append(span('warnmark', '⚠'), span('sr', ', porte le pseudo d’un contact vérifié'));
  }
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
    b.append(span('pv', `${who} › ${r.last.file ? (isImage(r.last.file.mime) ? 'photo' : r.last.file.name) : r.last.text.replace(/\s+/g, ' ')}`));
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
window.addEventListener('popstate', () => {
  if (closeLightbox) closeLightbox();
  else backToList();
});

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
  const del = $<HTMLButtonElement>('delBtn');
  del.textContent = isPeerKey(current) ? 'supprimer' : 'vider';
  del.setAttribute('aria-label', isPeerKey(current) ? `Supprimer la conversation avec ${labelOf(current)}` : `Vider la conversation ${current === ALERTS ? 'des alertes' : 'publique'}`);
  del.classList.toggle('hide', !(history[current]?.length || isPeerKey(current)));
  const vbtn = $<HTMLButtonElement>('vbtn');
  vbtn.classList.toggle('hide', !isPeerKey(current));
  if (isPeerKey(current)) {
    vbtn.textContent = isVerified(current) ? '✓ vérifié' : 'vérifier ›';
    vbtn.classList.toggle('ok', isVerified(current));
    vbtn.setAttribute('aria-label', isVerified(current) ? 'Contact vérifié en personne : gérer' : 'Vérifier ce contact en personne');
  }
  const fake = lookalike(current);
  const left = fake
    ? span('warn', '⚠ porte le pseudo d’un contact vérifié')
    : current === PUBLIC
      ? span('', rangeIds().size || !node.neighbors.size ? `${rangeIds().size} à portée${node.neighbors.size > rangeIds().size ? ` · ${node.neighbors.size - rangeIds().size} par internet` : ''}` : `${node.neighbors.size} par internet`)
      : current === ALERTS
        ? span('', 'signées · prioritaires')
        : span(online.has(current) ? 'ivory' : '', online.has(current) ? (rangeIds().has(current) ? 'à portée' : 'par internet') : 'hors de portée');
  const right = fake
    ? ''
    : current === PUBLIC
      ? 'visible par tout le mesh'
      : current === ALERTS
        ? 'portées 24 h'
        : online.has(current)
          ? 'chiffré de bout en bout'
          : 'un relais portera vos messages';
  sub.append(left, span('fill', ''), span('', right));
}

function composer(): void {
  const alert = current === ALERTS;
  $('composer').classList.toggle('alert', alert);
  const input = $<HTMLTextAreaElement>('text');
  input.placeholder = alert ? 'lieu, danger, besoin' : !wide() ? 'écrire…' : current === PUBLIC ? 'écrire au mesh' : `écrire à ${labelOf(current)}`;
  const sendLabel = alert ? "Diffuser l'alerte" : 'Envoyer';
  $('sendBtn').setAttribute('aria-label', sendLabel);
  $('sendBtn').title = sendLabel;
  $('attach').classList.toggle('hide', alert);
  const hint = $('hint');
  hint.replaceChildren();
  hint.append(
    document.createTextNode(alert ? 'part chez tout le monde, même ceux qui arriveront plus tard' : isPeerKey(current) ? 'chiffré' : 'visible par tous'),
  );
  if (!alert) hint.append(span('kb', ' · entrée envoie, maj+entrée saute une ligne, coller ou déposer une image pour la joindre'));
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

  const lastMine = [...list].reverse().find((l) => l.mine && !l.alert);
  let prev: Line | undefined;
  list.forEach((l, i) => {
    const fromEnd = list.length - 1 - i;
    if (!prev || new Date(prev.at).toDateString() !== new Date(l.at).toDateString()) log.append(el('div', 'day', dayLabel(l.at)));
    const cont =
      !!prev && !l.alert && !prev.alert && prev.mine === l.mine && prev.from === l.from && l.at - prev.at < GROUP_GAP_MS && new Date(prev.at).toDateString() === new Date(l.at).toDateString();
    const tier = fromEnd === 0 ? 0 : fromEnd <= 2 ? 1 : 2;
    const m = el('div', `msg t${tier} ${l.mine ? 'mine' : 'theirs'}${l.alert ? ' alert' : ''}${cont ? ' cont' : ''}`);
    if (l.alert) m.append(span('who', `alerte · ${l.mine ? 'vous' : l.from} · ${clock(l.at)}`));
    else if (!cont) m.append(span('who', l.mine ? clock(l.at) : `${l.from} · ${clock(l.at)}`));
    if (l.file) m.append(fileEl(l));
    else m.append(span('txt', l.text));
    const st = statusOf(l);
    // one status for the thread, under the last message sent; a message still waiting for a neighbour always says so
    if (st && (st === 'pending' || l === lastMine)) m.append(statusEl(st));
    log.append(m);
    prev = l;
  });

  for (const [id, t] of incoming) {
    if (t.dismissed || Date.now() - t.at > 6 * 3600 * 1000) incoming.delete(id);
    else if (t.key === current) {
      const stalled = Date.now() - t.at > STALL_MS;
      const x = el('div', `xfer${stalled ? ' stalled' : ''}`);
      const pct = `${Math.round((t.received / t.total) * 100)} %`;
      if (stalled) {
        x.append(span('', `${t.label} › transfert interrompu à ${pct}, reprise dès qu'un appareil qui le porte repasse à portée`));
        const b = el('button', undefined, 'abandonner ›');
        b.type = 'button';
        b.onclick = () => {
          t.dismissed = true;
          renderChat();
        };
        x.append(b);
      } else {
        x.append(span('', `${t.label} › réception`), span('fill', ''), span('tnum', pct));
      }
      log.append(x);
    }
  }

  if (forceBottom || stick || nearBottom) {
    box.scrollTop = box.scrollHeight;
    $('jump').classList.add('hide');
  } else {
    $('jump').classList.remove('hide');
  }
}

function fileEl(l: Line): HTMLElement {
  const f = l.file!;
  if (isImage(f.mime)) {
    const b = el('button', 'img');
    b.type = 'button';
    b.setAttribute('aria-label', `Ouvrir la photo ${f.name}`);
    const img = el('img');
    img.alt = f.name;
    img.decoding = 'async';
    img.onload = () => {
      if (stick) $('msgs').scrollTop = $('msgs').scrollHeight;
    };
    void fileUrl(l.id!).then((u) => {
      if (u) img.src = u;
      else b.replaceWith(span('txt', `${f.name} · fichier introuvable`));
    });
    b.onclick = () => lightbox(l.id!, f.name, f.size);
    b.append(img);
    const wrap = el('div', 'imgwrap');
    wrap.append(b, span('cap', `${f.name} · ${size(f.size)}`));
    return wrap;
  }
  const b = el('button', 'file');
  b.type = 'button';
  const dot = f.name.lastIndexOf('.');
  const hasExt = dot > 0 && f.name.length - dot <= 8;
  const title = span('ttl', '');
  title.append(span('nm', hasExt ? f.name.slice(0, dot) : f.name));
  if (hasExt) title.append(span('ext', f.name.slice(dot)));
  b.append(title, span('act', `${size(f.size)} · enregistrer ›`));
  b.onclick = async () => {
    const u = await fileUrl(l.id!);
    if (!u) return fail('Fichier introuvable : il a été supprimé de cet appareil.');
    const a = el('a');
    a.href = u;
    a.download = f.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'fichier';
    a.click();
  };
  return b;
}

let closeLightbox: (() => void) | undefined;

function lightbox(id: string, name: string, bytes: number): void {
  void fileUrl(id).then((u) => {
    if (!u) return fail('Photo introuvable : elle a été supprimée de cet appareil.');
    const back = document.activeElement as HTMLElement | null;
    const o = el('div', 'lightbox');
    o.setAttribute('role', 'dialog');
    o.setAttribute('aria-modal', 'true');
    o.setAttribute('aria-label', name);
    const bar = el('div', 'bar');
    const save = el('a');
    save.href = u;
    save.download = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'photo';
    save.textContent = 'enregistrer ›';
    const x = el('button', undefined, 'fermer ×');
    x.type = 'button';
    bar.append(span('', `${name} · ${size(bytes)}`), save, x);
    const stage = el('div', 'stage');
    const img = el('img');
    img.src = u;
    img.alt = name;
    stage.append(img);
    o.append(bar, stage);
    const shut = () => {
      if (closeLightbox !== shut) return;
      closeLightbox = undefined;
      o.remove();
      document.removeEventListener('keydown', onKey, true);
      back?.focus?.();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        window.history.state?.lb ? window.history.back() : shut();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === x ? save : x).focus();
      }
    };
    closeLightbox = shut;
    try {
      window.history.pushState({ ...(window.history.state ?? {}), lb: true }, '');
    } catch {
      /* ignore */
    }
    document.addEventListener('keydown', onKey, true);
    x.onclick = () => (window.history.state?.lb ? window.history.back() : shut());
    stage.onclick = x.onclick;
    document.body.append(o);
    x.focus();
  });
}

/** Removes a conversation from this device: messages, attachments, unread count and, for a contact, the verified mark. */
function deleteConversation(key: string): void {
  for (const l of history[key] ?? []) if (l.file && l.id) void dropFile(l.id);
  delete history[key];
  unread[key] = 0;
  persist();
  save('chax.unread', unread);
  for (const [id, t] of incoming) if (t.key === key) incoming.delete(id);
  if (isPeerKey(key)) {
    delete trust[key];
    save('chax.trust', trust);
    hidden[key] = true;
    save('chax.hidden', hidden);
  }
  listSig = '';
  if (isPeerKey(key)) {
    if (wide()) open(PUBLIC);
    else backToList();
  } else renderChat(true);
  renderList();
  header();
}

/** Asks before deleting: it cannot be undone and the other side keeps its own copy. */
function deleteDialog(key: string): void {
  const back = document.activeElement as HTMLElement | null;
  const peer = isPeerKey(key);
  const o = el('div', 'lightbox verify');
  o.setAttribute('role', 'dialog');
  o.setAttribute('aria-modal', 'true');
  o.setAttribute('aria-label', peer ? 'Supprimer la conversation' : 'Vider la conversation');
  const bar = el('div', 'bar');
  const x = el('button', undefined, 'fermer ×');
  x.type = 'button';
  bar.append(span('', peer ? `supprimer ${labelOf(key)}` : 'vider la conversation'), x);
  const n = history[key]?.length ?? 0;
  const body = el('div', 'vbody');
  const intro = el(
    'p',
    'vintro',
    peer
      ? `Les ${n} message${n > 1 ? 's' : ''} et les pièces jointes échangés avec ${labelOf(key)} seront effacés de cet appareil${isVerified(key) ? ', ainsi que sa vérification' : ''}. Cela ne peut pas être annulé, et ${labelOf(key)} garde sa propre copie. Il réapparaîtra dans la liste s’il vous écrit.`
      : `Les ${n} message${n > 1 ? 's' : ''} ${key === ALERTS ? 'd’alertes' : 'du canal public'} seront effacés de cet appareil. Cela ne peut pas être annulé ; les autres gardent les leurs.`,
  );
  const act = el('div', 'vact');
  const yes = el('button', 'danger', peer ? 'supprimer ›' : 'vider ›');
  yes.type = 'button';
  const no = el('button', undefined, 'annuler');
  no.type = 'button';
  act.append(no, yes);
  body.append(intro, act);
  o.append(bar, body);

  const shut = () => {
    if (closeLightbox !== shut) return;
    closeLightbox = undefined;
    o.remove();
    document.removeEventListener('keydown', onKey, true);
    back?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      window.history.state?.lb ? window.history.back() : shut();
    }
  };
  closeLightbox = shut;
  try {
    window.history.pushState({ ...(window.history.state ?? {}), lb: true }, '');
  } catch {
    /* ignore */
  }
  document.addEventListener('keydown', onKey, true);
  const close = () => (window.history.state?.lb ? window.history.back() : shut());
  x.onclick = close;
  no.onclick = close;
  yes.onclick = () => {
    close();
    deleteConversation(key);
    flash(peer ? 'conversation supprimée' : 'conversation vidée');
  };
  document.body.append(o);
  no.focus();
}

/** The banner at the top of the list when a newer build exists. It opens the download in the browser. */
function offerUpdate(u: Update): void {
  const b = $<HTMLButtonElement>('upd');
  b.textContent = `version ${u.version} disponible · télécharger ›`;
  b.classList.remove('hide');
  b.onclick = () => window.open(u.url, '_blank', 'noopener');
}

/** The internet fallback: what it is, what it costs in privacy, and the switch. */
function netDialog(): void {
  if (!net) return;
  const back = document.activeElement as HTMLElement | null;
  const o = el('div', 'lightbox verify');
  o.setAttribute('role', 'dialog');
  o.setAttribute('aria-modal', 'true');
  o.setAttribute('aria-label', 'Repli par internet');
  const bar = el('div', 'bar');
  const x = el('button', undefined, 'fermer ×');
  x.type = 'button';
  bar.append(span('', 'repli par internet'), x);
  const body = el('div', 'vbody');
  const state = el('p', 'vres');
  state.setAttribute('role', 'status');
  const cfg = loadNet();
  const draw = () => {
    state.textContent = net!.running
      ? net!.connected
        ? `Actif : ${net!.connected} relais sur ${net!.relayCount}.`
        : 'Actif, connexion aux relais…'
      : 'Désactivé : seul le Bluetooth est utilisé.';
    sw.textContent = net!.running ? 'désactiver ›' : 'activer ›';
  };
  const intro = el(
    'p',
    'vintro',
    'Quand le Bluetooth ne porte plus, les messages peuvent passer par des relais Nostr publics. Le contenu reste chiffré de bout en bout (messages privés) et signé ; les relais voient seulement votre adresse IP, l’heure et la taille des paquets. Les messages du canal public, eux, sont lisibles par n’importe qui sur ces relais.',
  );
  const sw = el('button', undefined, '');
  sw.type = 'button';
  sw.onclick = () => {
    if (net!.running) net!.stop();
    else net!.start();
    cfg.on = net!.running;
    save('chax.net', cfg);
    draw();
    renderList();
  };
  const relays = el('textarea');
  relays.rows = 3;
  relays.spellcheck = false;
  relays.value = (cfg.relays.length ? cfg.relays : DEFAULT_RELAYS).join('\n');
  relays.setAttribute('aria-label', 'Adresses des relais, une par ligne');
  relays.style.cssText = 'width:min(92vw,420px);font-size:var(--fs-dust);border-bottom:1px solid var(--dust-2);';
  relays.onchange = () => {
    const list = relays.value.split(/\s+/).filter((u) => /^wss:\/\/\S+$/.test(u));
    cfg.relays = list;
    save('chax.net', cfg);
    net!.setRelays(list.length ? list : DEFAULT_RELAYS);
    draw();
  };
  const act = el('div', 'vact');
  act.append(sw);
  net.onStatus(draw);
  const upState = el('p', 'vres');
  upState.setAttribute('role', 'status');
  const upAct = el('div', 'vact');
  const look = el('button', undefined, 'chercher une mise à jour ›');
  look.type = 'button';
  look.onclick = async () => {
    upState.textContent = 'Recherche…';
    const u = await check();
    if (u) offerUpdate(u);
    upState.textContent = u ? `La version ${u.version} est disponible.` : `Version ${VERSION} : à jour, ou GitHub injoignable.`;
  };
  const auto = el('button', undefined, '');
  auto.type = 'button';
  const drawAuto = () => (auto.textContent = autoCheck() ? 'vérification au lancement : oui ›' : 'vérification au lancement : non ›');
  auto.onclick = () => {
    setAutoCheck(!autoCheck());
    drawAuto();
  };
  drawAuto();
  upAct.append(look, auto);
  const upIntro = el('p', 'vintro', `Version ${VERSION}. La vérification contacte github.com (une fois par jour au plus) et lui révèle votre adresse IP ; rien d’autre n’est envoyé.`);
  body.append(intro, state, act, span('vfp', 'relais (wss://), un par ligne'), relays, upIntro, upAct, upState);
  o.append(bar, body);
  draw();

  const shut = () => {
    if (closeLightbox !== shut) return;
    closeLightbox = undefined;
    o.remove();
    document.removeEventListener('keydown', onKey, true);
    back?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      window.history.state?.lb ? window.history.back() : shut();
    }
  };
  closeLightbox = shut;
  try {
    window.history.pushState({ ...(window.history.state ?? {}), lb: true }, '');
  } catch {
    /* ignore */
  }
  document.addEventListener('keydown', onKey, true);
  x.onclick = () => (window.history.state?.lb ? window.history.back() : shut());
  document.body.append(o);
  x.focus();
}

/** Face-to-face verification: show our code, scan theirs, pin their key to their name. */
function verifyDialog(focus?: string): void {
  const back = document.activeElement as HTMLElement | null;
  const o = el('div', 'lightbox verify');
  o.setAttribute('role', 'dialog');
  o.setAttribute('aria-modal', 'true');
  o.setAttribute('aria-label', 'Vérification en personne');
  const bar = el('div', 'bar');
  const x = el('button', undefined, 'fermer ×');
  x.type = 'button';
  bar.append(span('', focus ? `vérifier ${labelOf(focus)}` : 'vérification en personne'), x);

  const body = el('div', 'vbody');
  const code = encodeCode(node.peerId, node.nickname);
  const intro = el(
    'p',
    'vintro',
    focus
      ? `Face à ${labelOf(focus)}, scannez son code. Faites-lui scanner le vôtre pour qu’il vous vérifie à son tour.`
      : 'Face à face, scannez le code de l’autre pour le marquer vérifié, et faites-lui scanner le vôtre.',
  );
  const qr = el('div', 'qr');
  qr.append(qrElement(code));
  const res = el('p', 'vres');
  res.setAttribute('role', 'status');
  const video = el('video');
  video.muted = true;
  video.classList.add('hide');
  let stopCam: (() => void) | undefined;
  const say = (t: string, bad = false) => {
    res.textContent = t;
    res.classList.toggle('bad', bad);
  };

  const handle = (raw: string): boolean => {
    const c = parseCode(raw);
    if (!c) {
      say('Ce n’est pas un code ChaX.', true);
      return false;
    }
    if (c.peerId === node.peerId) {
      say('C’est votre propre code.', true);
      return false;
    }
    if (focus && c.peerId !== focus) {
      say(
        c.name === names.get(focus)
          ? `Ce code est celui d’un autre appareil nommé ${c.name} (${c.peerId.slice(0, 4)}), pas de ${labelOf(focus)}. L’un des deux se fait passer pour l’autre.`
          : `Ce code n’est pas celui de ${labelOf(focus)} : c’est celui de ${c.name} (${c.peerId.slice(0, 4)}).`,
        true,
      );
      return false;
    }
    trust[c.peerId] = { name: c.name, at: Date.now() };
    save('chax.trust', trust);
    if (!names.has(c.peerId)) {
      names.set(c.peerId, c.name);
      save('chax.names', Object.fromEntries(names));
    }
    listSig = '';
    renderList();
    header();
    stopCam?.();
    stopCam = undefined;
    // the dialog has done its job: close it and leave the confirmation behind on the page
    if (window.history.state?.lb) window.history.back();
    else shut();
    fail(`✓ ${c.name} est vérifié.`);
    return true;
  };

  const act = el('div', 'vact');
  const scan = el('button', undefined, 'scanner son code ›');
  scan.type = 'button';
  scan.onclick = async () => {
    if (stopCam) return;
    try {
      video.classList.remove('hide');
      say('Visez le code de l’autre téléphone.');
      stopCam = await scanCamera(video, (t) => void handle(t));
    } catch {
      video.classList.add('hide');
      say('Caméra inaccessible : autorisez-la, ou collez le code ci-dessous.', true);
    }
  };
  const copy = el('button', undefined, 'copier mon code ›');
  copy.type = 'button';
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      say('Code copié : envoyez-le par un canal que vous maîtrisez.');
    } catch {
      say(code);
    }
  };
  act.append(scan, copy);
  if (focus && isVerified(focus)) {
    const drop = el('button', undefined, 'retirer la vérification ›');
    drop.type = 'button';
    drop.onclick = () => {
      delete trust[focus];
      save('chax.trust', trust);
      listSig = '';
      renderList();
      header();
      say('Vérification retirée.');
      drop.remove();
    };
    act.append(drop);
  }

  const paste = el('form', 'vpaste');
  const field = el('input');
  field.placeholder = 'ou coller un code';
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.setAttribute('aria-label', 'Coller un code de vérification');
  const ok = el('button', undefined, 'valider ›');
  ok.type = 'submit';
  paste.onsubmit = (ev) => {
    ev.preventDefault();
    if (!field.value.trim()) {
      say('Le champ est vide : collez un code, ou touchez « scanner son code ».', true);
      return;
    }
    if (handle(field.value)) field.value = '';
  };
  paste.append(field, ok);

  body.append(intro, qr, span('vfp', spaced(node.peerId)), act, video, paste, res);
  o.append(bar, body);

  const shut = () => {
    if (closeLightbox !== shut) return;
    closeLightbox = undefined;
    stopCam?.();
    o.remove();
    document.removeEventListener('keydown', onKey, true);
    back?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      window.history.state?.lb ? window.history.back() : shut();
    }
  };
  closeLightbox = shut;
  try {
    window.history.pushState({ ...(window.history.state ?? {}), lb: true }, '');
  } catch {
    /* ignore */
  }
  document.addEventListener('keydown', onKey, true);
  x.onclick = () => (window.history.state?.lb ? window.history.back() : shut());
  document.body.append(o);
  x.focus();
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
  save('chax.unread', unread);
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
      fail("Message non envoyé : clé de ce contact inconnue. Rapprochez-vous de lui pour l'échanger, puis réessayez.");
      return;
    }
  }
  input.value = '';
  autosize();
  syncSend();
  stick = true;
}

async function attach(f: File): Promise<void> {
  if (current === ALERTS) return fail('Les alertes sont du texte : retirez la pièce jointe ou écrivez dans une conversation.');
  let blob: Blob = f;
  let mime = f.type || 'application/octet-stream';
  let name = f.name || 'fichier';
  if (isImage(mime) && mime !== 'image/gif') {
    try {
      const small = await shrink(f);
      if (small.size < f.size || f.size > MAX_ATTACHMENT - 4096) {
        blob = small;
        mime = 'image/jpeg';
        name = `${name.replace(/\.[^.]+$/, '')}.jpg`;
      }
    } catch {
      /* keep the original */
    }
  }
  if (blob.size > MAX_ATTACHMENT - 4096) return fail(`Fichier trop gros (${size(blob.size)}) : 2 Mo maximum. Réduisez-le puis réessayez.`);
  const key = current;
  const data = new Uint8Array(await blob.arrayBuffer());
  let id: string;
  try {
    id = toHex(key === PUBLIC ? node.sendFile({ name, mime, data }) : node.sendFile({ name, mime, data }, key));
  } catch {
    return fail("Clé de ce contact inconnue : rapprochez-vous de lui pour l'échanger, puis réessayez.");
  }
  await putFile(id, new Blob([data], { type: isImage(mime) ? mime : 'application/octet-stream' }));
  const line: Line = { id, mine: true, from: node.nickname, text: '', at: Date.now(), file: { name, mime, size: data.length } };
  if (key !== PUBLIC) line.status = node.neighbors.size ? 'transit' : 'pending';
  push(key, line);
  stick = true;
}

$('attach').onclick = () => $<HTMLInputElement>('pick').click();
$('pick').addEventListener('change', () => {
  const input = $<HTMLInputElement>('pick');
  for (const f of Array.from(input.files ?? [])) void attach(f);
  input.value = '';
});
$('text').addEventListener('paste', (ev) => {
  const f = Array.from((ev as ClipboardEvent).clipboardData?.files ?? [])[0];
  if (f) {
    ev.preventDefault();
    void attach(f);
  }
});
$('chat').addEventListener('dragover', (ev) => ev.preventDefault());
$('chat').addEventListener('drop', (ev) => {
  ev.preventDefault();
  for (const f of Array.from((ev as DragEvent).dataTransfer?.files ?? [])) void attach(f);
});

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

$('fp').onclick = () => verifyDialog();
$('netBtn').onclick = () => netDialog();
$('vbtn').onclick = () => verifyDialog(current);
$('delBtn').onclick = () => deleteDialog(current);
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
  const identity = loadIdentity();
  if (native && cap?.Plugins?.ChaxBle) ble = new BleTransport(capacitorBridge(cap.Plugins.ChaxBle));
  const winHost = windowsHost();
  if (winHost) ble = new BleTransport(windowsBridge(winHost));
  // The radio (or, in a browser, other tabs / the dev relay) plus the optional internet fallback. A browser cannot
  // speak Bluetooth, so for a PC the fallback is how it meets the phones.
  const cfg = loadNet();
  net = new NostrTransport({ selfId: toHex(identity.peerId), relays: cfg.relays.length ? cfg.relays : DEFAULT_RELAYS });
  net.onStatus(() => renderList());
  const transport: Transport = new MultiTransport([
    { name: ble ? 'ble' : 'local', transport: ble ?? relay ?? new BroadcastChannelTransport() },
    { name: 'net', transport: net },
  ]);
  if (cfg.on) net.start();
  // peers reached through relays only stay visible if we keep announcing ourselves
  setInterval(() => net?.running && node.announce(), 5 * 60 * 1000);
  node = new ChaxNode({ transport, identity, nickname });
  node.loadSessions(load('chax.sessions') ?? {});
  let sessionSave: number | undefined;
  node.onSessionsChanged(() => {
    clearTimeout(sessionSave);
    sessionSave = window.setTimeout(() => save('chax.sessions', node.exportSessions()), 150);
  });
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
    const key = m.alert ? ALERTS : m.direct ? m.from : PUBLIC;
    // a fresh node (after the headless one, or a restart) meets packets neighbours still carry
    if ((history[key] ?? []).some((l) => l.id === m.id)) return;
    if (m.attachment) {
      incoming.delete(m.id);
      const a = m.attachment;
      const safe = isImage(a.mime);
      line.file = { name: a.name || 'fichier', mime: safe ? a.mime : 'application/octet-stream', size: a.data.length };
      void putFile(m.id, new Blob([a.data as BlobPart], { type: line.file.mime })).then(() => push(key, line));
      return;
    }
    push(key, m.alert ? { ...line, alert: true } : line);
  });
  node.onTransfer((t) => {
    incoming.set(t.id, {
      key: t.direct ? t.from : PUBLIC,
      label: node.peers.get(t.from)?.nickname || t.from.slice(0, 8),
      received: t.received,
      total: t.total,
      at: Date.now(),
    });
    if ((t.direct ? t.from : PUBLIC) === current) renderChat();
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
    else if (incoming.size) renderChat();
  }, 1000);

  $('app').dataset.view = wide() ? 'chat' : 'list';
  renderChat(true);
  renderList();
  if (native) void checkOnLaunch().then((u) => u && offerUpdate(u));
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
