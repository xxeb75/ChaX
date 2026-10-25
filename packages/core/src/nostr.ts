import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { MAX_TTL, decode, encode, isBroadcast } from './packet';
import { fromHex, toHex } from './bytes';
import type { Transport } from './transport';

/**
 * Optional internet fallback: ChaX packets, already signed and (for direct messages) encrypted, travel as opaque
 * Nostr events through public relays. Relays only see base64 blobs, an expiry, and a throwaway key per session.
 *
 * Addressing: broadcast packets (announces, public chat, alerts) carry the tag ["t", TOPIC]; direct packets carry
 * ["p", <recipient peer id>], so a node only downloads what concerns it plus the public stream.
 * Links: one `lobby` link while any relay is connected (everyone on the topic), and one `p:<peer>` link per peer
 * heard recently on the relays, which gives the node the same neighbour model as Bluetooth.
 */

export const NOSTR_KIND = 4242; // regular (stored) event kind
export const NOSTR_TOPIC = 'chax-mesh-v1';
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

const MAX_CONTENT = 60_000; // base64 chars: stays under the 64 KB most relays accept
const BACKLOG_S = 24 * 3600;
// A peer counts as reachable while fresh events keep coming from it; older ones (the relay backlog) still deliver
// messages and announces but never make someone look present.
const FRESH_S = 600;
const PEER_TTL_MS = 12 * 60 * 1000;
const PUBLISH_DEDUP_MS = 60_000;
const MAX_SEEN = 5000;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 60_000;

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface NostrOptions {
  /** Hex peer id of this node: used to subscribe to the direct packets addressed to it. */
  selfId: string;
  relays?: string[];
  /** Replaceable for tests. */
  socket?: (url: string) => SocketLike;
  now?: () => number;
}

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface Conn {
  ws: SocketLike;
  open: boolean;
}

function b64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const utf8 = (s: string) => new TextEncoder().encode(s);

export class NostrTransport implements Transport {
  readonly mtu = 32 * 1024;
  private sk = schnorr.utils.randomSecretKey();
  private pubkey = toHex(schnorr.getPublicKey(this.sk));
  private relays: string[];
  private socks = new Map<string, Conn>();
  private backoff = new Map<string, number>();
  private active = false;
  private lobby = false;
  private peers = new Map<string, number>(); // peer id -> last time a fresh event came from it
  private sweep?: ReturnType<typeof setInterval>;
  private published = new Map<string, number>();
  private seen = new Set<string>();
  private rx: ((l: string, b: Uint8Array) => void)[] = [];
  private upCb: ((l: string) => void)[] = [];
  private downCb: ((l: string) => void)[] = [];
  private statusCb: ((connected: number, total: number) => void)[] = [];
  private readonly selfId: string;
  private readonly makeSocket: (url: string) => SocketLike;
  private readonly clock: () => number;

  constructor(opts: NostrOptions) {
    this.selfId = opts.selfId;
    this.relays = opts.relays ?? DEFAULT_RELAYS;
    this.makeSocket = opts.socket ?? ((u) => new WebSocket(u) as unknown as SocketLike);
    this.clock = opts.now ?? (() => Date.now());
  }

  get running(): boolean {
    return this.active;
  }

  /** Number of relays currently connected. */
  get connected(): number {
    return [...this.socks.values()].filter((s) => s.open).length;
  }

  get relayCount(): number {
    return this.relays.length;
  }

  onStatus(cb: (connected: number, total: number) => void): void {
    this.statusCb.push(cb);
  }

  setRelays(urls: string[]): void {
    this.relays = urls;
    if (!this.active) return;
    for (const [u, c] of [...this.socks]) if (!urls.includes(u)) this.closeSocket(u, c);
    for (const u of urls) this.connect(u);
    this.refreshLinks();
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.sweep = setInterval(() => this.expirePeers(), 60_000);
    for (const u of this.relays) this.connect(u);
  }

  stop(): void {
    this.active = false;
    clearInterval(this.sweep);
    for (const [u, c] of [...this.socks]) this.closeSocket(u, c);
    this.refreshLinks();
  }

  // ---- Transport ---------------------------------------------------------

  send(link: string, bytes: Uint8Array): void {
    if (link !== 'lobby' && !link.startsWith('p:')) return;
    this.publish(bytes);
  }

  broadcast(bytes: Uint8Array): void {
    this.publish(bytes);
  }

  links(): string[] {
    return this.lobby ? ['lobby', ...[...this.peers.keys()].map((p) => `p:${p}`)] : [];
  }

  onReceive(cb: (l: string, b: Uint8Array) => void): void {
    this.rx.push(cb);
  }
  onLinkUp(cb: (l: string) => void): void {
    this.upCb.push(cb);
  }
  onLinkDown(cb: (l: string) => void): void {
    this.downCb.push(cb);
  }

  // ---- relays ------------------------------------------------------------

  private connect(url: string): void {
    if (!this.active || this.socks.has(url)) return;
    let ws: SocketLike;
    try {
      ws = this.makeSocket(url);
    } catch {
      return;
    }
    const conn: Conn = { ws, open: false };
    this.socks.set(url, conn);
    ws.onopen = () => {
      conn.open = true;
      this.backoff.delete(url);
      const since = Math.floor(this.clock() / 1000) - BACKLOG_S;
      ws.send(
        JSON.stringify([
          'REQ',
          'chax',
          { kinds: [NOSTR_KIND], '#t': [NOSTR_TOPIC], since, limit: 500 },
          { kinds: [NOSTR_KIND], '#p': [this.selfId], since, limit: 500 },
        ]),
      );
      this.refreshLinks();
    };
    ws.onmessage = (ev) => this.onWire(String(ev.data));
    ws.onclose = () => {
      this.socks.delete(url);
      this.refreshLinks();
      if (this.active && this.relays.includes(url)) {
        const wait = this.backoff.get(url) ?? RECONNECT_MIN_MS;
        this.backoff.set(url, Math.min(wait * 2, RECONNECT_MAX_MS));
        setTimeout(() => this.connect(url), wait);
      }
    };
    ws.onerror = () => ws.close();
  }

  private closeSocket(url: string, c: Conn): void {
    this.socks.delete(url);
    c.ws.onclose = null;
    try {
      c.ws.close();
    } catch {
      /* ignore */
    }
  }

  private refreshLinks(): void {
    const n = this.connected;
    const lobby = this.active && n > 0;
    this.statusCb.forEach((cb) => cb(n, this.relays.length));
    if (lobby && !this.lobby) {
      this.lobby = true;
      this.upCb.forEach((cb) => cb('lobby'));
    } else if (!lobby && this.lobby) {
      this.lobby = false;
      for (const p of [...this.peers.keys()]) this.downCb.forEach((cb) => cb(`p:${p}`));
      this.peers.clear();
      this.downCb.forEach((cb) => cb('lobby'));
    }
  }

  private expirePeers(): void {
    const now = this.clock();
    for (const [p, t] of [...this.peers]) {
      if (now - t < PEER_TTL_MS) continue;
      this.peers.delete(p);
      this.downCb.forEach((cb) => cb(`p:${p}`));
    }
  }

  private onWire(text: string): void {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(m) || m[0] !== 'EVENT') return;
    const ev = m[2] as NostrEvent;
    if (!ev || ev.kind !== NOSTR_KIND || typeof ev.content !== 'string' || ev.content.length > MAX_CONTENT || typeof ev.id !== 'string') return;
    if (this.seen.has(ev.id)) return;
    this.seen.add(ev.id);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
    if (ev.pubkey === this.pubkey) return;
    const exp = ev.tags?.find((t) => t[0] === 'expiration')?.[1];
    if (exp && Number(exp) * 1000 < this.clock()) return;
    let bytes: Uint8Array;
    let packet;
    try {
      bytes = unb64(ev.content);
      packet = decode(bytes);
    } catch {
      return;
    }
    const src = toHex(packet.src);
    if (src === this.selfId) return;
    if (this.clock() / 1000 - ev.created_at > FRESH_S) {
      // Backlog: keys and messages are welcome, presence is not. A copy below full TTL is never taken by the node
      // as "sent by a direct neighbour".
      const copy = packet.ttl >= MAX_TTL ? encode({ ...packet, ttl: MAX_TTL - 1 }) : bytes;
      this.rx.forEach((cb) => cb('lobby', copy));
      return;
    }
    const link = `p:${src}`;
    const known = this.peers.has(src);
    this.peers.set(src, this.clock());
    if (!known) this.upCb.forEach((cb) => cb(link));
    this.rx.forEach((cb) => cb(link, bytes));
  }

  private publish(bytes: Uint8Array): void {
    if (!this.lobby) return;
    let packet;
    try {
      packet = decode(bytes);
    } catch {
      return;
    }
    const content = b64(bytes);
    if (content.length > MAX_CONTENT) return;
    const tag = isBroadcast(packet.dst) ? ['t', NOSTR_TOPIC] : ['p', toHex(packet.dst)];
    const key = `${toHex(packet.msgId)}:${tag[1]}`;
    const now = this.clock();
    const last = this.published.get(key);
    if (last !== undefined && now - last < PUBLISH_DEDUP_MS) return;
    this.published.set(key, now);
    if (this.published.size > 2000) for (const [k, t] of this.published) if (now - t > PUBLISH_DEDUP_MS) this.published.delete(k);
    const created = Math.floor(now / 1000);
    const life = packet.expiry > 0 ? Math.min(packet.expiry, BACKLOG_S) : 3600;
    const tags = [tag, ['expiration', String(created + life)]];
    const id = toHex(sha256(utf8(JSON.stringify([0, this.pubkey, created, NOSTR_KIND, tags, content]))));
    const ev: NostrEvent = {
      id,
      pubkey: this.pubkey,
      created_at: created,
      kind: NOSTR_KIND,
      tags,
      content,
      sig: toHex(schnorr.sign(fromHex(id), this.sk)),
    };
    this.seen.add(id);
    const text = JSON.stringify(['EVENT', ev]);
    for (const s of this.socks.values()) if (s.open) s.ws.send(text);
  }
}
