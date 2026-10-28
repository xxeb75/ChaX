import { BleTransport, ChaxNode, DEFAULT_RELAYS, MultiTransport, NostrTransport, toHex, type BleBridge, type ChatMessage } from '../../core/src';
import { runFallback } from './fallback';
import { ALERTS, IMAGE_MIMES, MAX_LINES, PUBLIC, idb, load, loadIdentity, loadNet, putFile, save, type Line, type Status } from './store';

/**
 * The mesh node without a window. The Android foreground service loads this page in a WebView when the app is
 * closed: same core, same identity, same encryption sessions, same history as src/main.ts, so a message that
 * arrives now is simply there when the app opens. It only listens and records; replies and read receipts
 * stay with the visible page.
 */

interface Native {
  ready(): void;
  send(link: string, base64: string): boolean;
  notify(key: string, title: string, body: string, alert: boolean): void;
  log(line: string): void;
}
const nat = (window as unknown as { ChaxNative: Native }).ChaxNative;

function bridge(): BleBridge {
  let up: (l: string) => void = () => undefined;
  let down: (l: string) => void = () => undefined;
  let frame: (l: string, b: Uint8Array) => void = () => undefined;
  let error: (m: string) => void = () => undefined;
  (window as unknown as { __chax: unknown }).__chax = {
    up: (l: string) => up(l),
    down: (l: string) => down(l),
    frame: (l: string, b64: string) => frame(l, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
    error: (m: string) => error(m),
  };
  return {
    start: async () => undefined, // the service already runs the radio
    stop: async () => undefined,
    send: async (link, bytes) => {
      let t = '';
      for (const x of bytes) t += String.fromCharCode(x);
      if (!nat.send(link, btoa(t))) throw new Error('unknown link or queue full');
    },
    onLinkUp: (cb) => (up = cb),
    onLinkDown: (cb) => (down = cb),
    onFrame: (cb) => (frame = cb),
    onError: (cb) => (error = cb),
  };
}

function run(nickname: string): void {
  const history: Record<string, Line[]> = load('chax.history') ?? {};
  const names: Record<string, string> = load('chax.names') ?? {};

  const ble = new BleTransport(bridge());
  const identity = loadIdentity();
  const cfg = loadNet();
  const net = new NostrTransport({ selfId: toHex(identity.peerId), relays: cfg.relays.length ? cfg.relays : DEFAULT_RELAYS });
  const node = new ChaxNode({
    transport: new MultiTransport([
      { name: 'ble', transport: ble },
      { name: 'net', transport: net },
    ]),
    identity,
    nickname,
  });
  node.loadSessions(load('chax.sessions') ?? {});
  // saved at once: this page can be destroyed the moment the user opens the app
  node.onSessionsChanged(() => save('chax.sessions', node.exportSessions()));

  const add = (key: string, line: Line): void => {
    const list = (history[key] ??= []);
    list.push(line);
    if (list.length > MAX_LINES) {
      const old = list.shift()!;
      if (old.file && old.id) void idb('readwrite', (s) => s.delete(old.id!)).catch(() => undefined);
    }
    save('chax.history', history);
    const unread: Record<string, number> = load('chax.unread') ?? {};
    unread[key] = (unread[key] ?? 0) + 1;
    save('chax.unread', unread);
    if (key === PUBLIC) return; // public chatter would bury the notifications that matter
    const body = line.file ? `Pièce jointe : ${line.file.name}` : line.text;
    nat.notify(key, key === ALERTS ? `Alerte · ${line.from}` : line.from, body, !!line.alert);
  };

  node.onMessage((m: ChatMessage) => {
    const who = m.nickname || m.from.slice(0, 8);
    const key = m.alert ? ALERTS : m.direct ? m.from : PUBLIC;
    if ((history[key] ?? []).some((l) => l.id === m.id)) return; // neighbours still carry what we already hold
    if (m.nickname) {
      names[m.from] = m.nickname;
      save('chax.names', names);
    }
    const line: Line = { id: m.id, mine: false, from: who, text: m.text, at: Date.now() };
    if (m.alert) line.alert = true;
    if (m.attachment) {
      const a = m.attachment;
      const mime = IMAGE_MIMES.has(a.mime) ? a.mime : 'application/octet-stream';
      line.file = { name: a.name || 'fichier', mime, size: a.data.length };
      void putFile(m.id, new Blob([a.data as BlobPart], { type: mime })).then(() => add(key, line));
      return;
    }
    add(key, line);
  });

  const mark = (status: Status) => (id: string) => {
    for (const list of Object.values(history)) {
      const l = list.find((x) => x.id === id);
      if (l && l.status !== 'read') l.status = status;
    }
    save('chax.history', history);
  };
  node.onDelivered(mark('delivered'));
  node.onRead(mark('read'));

  ble.onError((m) => nat.log(`ble: ${m}`));
  void ble.start();
  // Bluetooth first; the relays come on when nobody is in range (or always, or never, as the user chose)
  const radio = () => [...node.neighbors].filter(([l]) => l.startsWith('ble|')).map(([, p]) => p);
  runFallback(net, {
    mode: () => loadNet().mode,
    range: () => new Set(radio()).size,
    viaNetOnly: () => new Set([...node.neighbors.values()]).size - new Set(radio()).size,
  });
  setInterval(() => net.running && node.announce(), 5 * 60 * 1000); // keeps us visible to peers reached through the relays
  nat.log(`headless node up as ${nickname} ${node.peerId.slice(0, 8)}`);
}

const nick = load<string>('chax.nick');
if (nick) run(nick);
nat.ready();
