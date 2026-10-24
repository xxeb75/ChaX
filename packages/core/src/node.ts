import { concat, equal, randomBytes, toHex } from './bytes';
import { createIdentity, open, peerIdOf, seal, sign, verify, type Identity } from './crypto';
import {
  BROADCAST,
  Flags,
  ID_LEN,
  MAX_TTL,
  PacketType,
  SIG_LEN,
  VERSION,
  decode,
  encode,
  isBroadcast,
  signedBytes,
  type Packet,
} from './packet';
import { Store, isExpired } from './store';
import { systemClock, type Clock, type Transport } from './transport';

const DEFAULT_EXPIRY_S = 72 * 3600;
const SYNC_TTL = 3;
const MAX_SEEN = 20000;
const RELAY_JITTER_MS = 40;

export interface ChatMessage {
  from: string; // hex peerId
  nickname?: string;
  text: string;
  direct: boolean;
  alert: boolean;
  timestamp: number;
}

export interface Peer {
  peerId: Uint8Array;
  edPub: Uint8Array;
  xPub: Uint8Array;
  nickname?: string;
  lastSeen: number;
}

export interface NodeOptions {
  transport: Transport;
  identity?: Identity;
  nickname?: string;
  clock?: Clock;
  rng?: () => number;
  storeQuotaBytes?: number;
}

export class ChaxNode {
  readonly identity: Identity;
  readonly nickname: string;
  readonly store: Store;
  readonly peers = new Map<string, Peer>();
  readonly neighbors = new Map<string, string>(); // link -> peerId hex (direct neighbors)
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly rng: () => number;
  private readonly seen = new Map<string, number>(); // msgId -> highest ttl seen
  private readonly pendingRelay = new Map<string, () => void>();
  private handlers: ((m: ChatMessage) => void)[] = [];

  constructor(opts: NodeOptions) {
    this.transport = opts.transport;
    this.identity = opts.identity ?? createIdentity();
    this.nickname = opts.nickname ?? 'anon';
    this.clock = opts.clock ?? systemClock;
    this.rng = opts.rng ?? Math.random;
    this.store = new Store(opts.storeQuotaBytes ?? 5 * 1024 * 1024);
    this.transport.onReceive((link, bytes) => this.handle(link, bytes));
    this.transport.onLinkUp((link) => this.linkUp(link));
    this.transport.onLinkDown((link) => this.neighbors.delete(link));
  }

  get peerId(): string {
    return toHex(this.identity.peerId);
  }

  onMessage(cb: (m: ChatMessage) => void): void {
    this.handlers.push(cb);
  }

  // ---- sending -------------------------------------------------------

  announce(): void {
    this.emit(PacketType.ANNOUNCE, BROADCAST, this.announcePayload(), Flags.SIGNED | Flags.STORE_FORWARD, DEFAULT_EXPIRY_S);
  }

  /** Public chat message to everyone in range of the mesh. */
  sendBroadcast(text: string): Uint8Array {
    return this.emit(PacketType.MSG, BROADCAST, utf8(text), Flags.SIGNED, 0);
  }

  /** Emergency alert: signed, priority, carried by relays until it expires. */
  sendAlert(text: string, expirySeconds = 24 * 3600): Uint8Array {
    return this.emit(
      PacketType.ALERT,
      BROADCAST,
      utf8(text),
      Flags.SIGNED | Flags.PRIORITY | Flags.STORE_FORWARD,
      expirySeconds,
    );
  }

  /** Encrypted message to a known peer; carried by relays if the peer is out of reach. */
  sendDirect(to: string, text: string, expirySeconds = DEFAULT_EXPIRY_S): Uint8Array {
    const peer = this.peers.get(to);
    if (!peer) throw new Error('unknown peer: no public key');
    return this.emit(
      PacketType.MSG,
      peer.peerId,
      seal(peer.xPub, utf8(text)),
      Flags.SIGNED | Flags.ENCRYPTED | Flags.STORE_FORWARD,
      expirySeconds,
    );
  }

  private announcePayload(): Uint8Array {
    return concat(this.identity.edPub, this.identity.xPub, utf8(this.nickname));
  }

  private emit(type: PacketType, dst: Uint8Array, payload: Uint8Array, flags: number, expiry: number): Uint8Array {
    const p: Packet = {
      version: VERSION,
      type,
      ttl: MAX_TTL,
      flags,
      msgId: randomBytes(ID_LEN),
      timestamp: Math.floor(this.clock.now()),
      expiry,
      src: this.identity.peerId,
      dst,
      payload,
      signature: new Uint8Array(SIG_LEN),
    };
    p.signature = sign(this.identity, signedBytes(p));
    this.markSeen(toHex(p.msgId));
    if (flags & Flags.STORE_FORWARD) this.store.put(p, this.clock.now());
    this.forward(p, undefined, 0);
    return p.msgId;
  }

  // ---- receiving -----------------------------------------------------

  private linkUp(link: string): void {
    // Announce ourselves on the new link first, then offer what we carry.
    const p = this.build(PacketType.ANNOUNCE, BROADCAST, this.announcePayload(), Flags.SIGNED | Flags.STORE_FORWARD, DEFAULT_EXPIRY_S);
    this.markSeen(toHex(p.msgId));
    this.store.put(p, this.clock.now());
    this.transport.send(link, encode(p));
    const ids = this.store.ids(this.clock.now());
    const sync = this.build(PacketType.SYNC, BROADCAST, concat(...ids), Flags.SIGNED, 0);
    this.transport.send(link, encode(sync));
  }

  private build(type: PacketType, dst: Uint8Array, payload: Uint8Array, flags: number, expiry: number): Packet {
    const p: Packet = {
      version: VERSION,
      type,
      ttl: MAX_TTL,
      flags,
      msgId: randomBytes(ID_LEN),
      timestamp: Math.floor(this.clock.now()),
      expiry,
      src: this.identity.peerId,
      dst,
      payload,
      signature: new Uint8Array(SIG_LEN),
    };
    p.signature = sign(this.identity, signedBytes(p));
    return p;
  }

  private handle(link: string, bytes: Uint8Array): void {
    let p: Packet;
    try {
      p = decode(bytes);
    } catch {
      return;
    }
    const hex = toHex(p.msgId);
    if (p.type === PacketType.SYNC) return this.handleSync(link, p);

    const prevTtl = this.seen.get(hex);
    if (prevTtl !== undefined && p.ttl <= prevTtl) {
      // A neighbour already relayed it: no need for us to.
      this.pendingRelay.get(hex)?.();
      this.pendingRelay.delete(hex);
      return;
    }
    if (isExpired(p, this.clock.now())) return;

    const srcHex = toHex(p.src);
    let edPub: Uint8Array | undefined;
    if (p.type === PacketType.ANNOUNCE) {
      if (p.payload.length < 64) return;
      edPub = p.payload.slice(0, 32);
      if (!equal(peerIdOf(edPub), p.src)) return;
    } else {
      edPub = this.peers.get(srcHex)?.edPub;
    }
    if (!edPub || !verify(edPub, signedBytes(p), p.signature)) return;
    this.markSeen(hex, p.ttl);

    if (prevTtl !== undefined) {
      // Same packet, but this copy has more hops left (e.g. the first came from a clipped sync): relay only.
      this.pendingRelay.get(hex)?.();
      if (!equal(p.dst, this.identity.peerId)) {
        this.forward({ ...p, ttl: p.ttl - 1 }, link, 1 + Math.floor(this.rng() * RELAY_JITTER_MS));
      }
      return;
    }

    switch (p.type) {
      case PacketType.ANNOUNCE:
        this.peers.set(srcHex, {
          peerId: p.src,
          edPub,
          xPub: p.payload.slice(32, 64),
          nickname: new TextDecoder().decode(p.payload.slice(64)),
          lastSeen: this.clock.now(),
        });
        if (p.ttl === MAX_TTL) this.neighbors.set(link, srcHex); // sent by the originator itself
        this.store.put(p, this.clock.now());
        break;
      case PacketType.ACK:
        this.store.remove(p.payload.slice(0, ID_LEN));
        break;
      case PacketType.MSG:
      case PacketType.ALERT:
        if (isBroadcast(p.dst)) {
          this.deliver(p, p.payload, false);
        } else if (equal(p.dst, this.identity.peerId)) {
          const plain = p.flags & Flags.ENCRYPTED ? open(this.identity, p.payload) : p.payload;
          if (plain) {
            this.deliver(p, plain, true);
            this.sendAck(p);
          }
          return; // unicast ends here
        }
        if (p.flags & Flags.STORE_FORWARD) this.store.put(p, this.clock.now());
        break;
      default:
        return;
    }
    this.forward({ ...p, ttl: p.ttl - 1 }, link, 1 + Math.floor(this.rng() * RELAY_JITTER_MS));
  }

  private handleSync(link: string, p: Packet): void {
    const edPub = this.peers.get(toHex(p.src))?.edPub;
    if (!edPub || !verify(edPub, signedBytes(p), p.signature)) return;
    const have = new Set<string>();
    for (let i = 0; i + ID_LEN <= p.payload.length; i += ID_LEN) have.add(toHex(p.payload.slice(i, i + ID_LEN)));
    const missing = this.store
      .all(this.clock.now())
      .filter((q) => !have.has(toHex(q.msgId)))
      .sort((a, b) => Number(b.type === PacketType.ANNOUNCE) - Number(a.type === PacketType.ANNOUNCE));
    for (const q of missing) this.transport.send(link, encode({ ...q, ttl: Math.min(q.ttl, SYNC_TTL) }));
  }

  private sendAck(orig: Packet): void {
    const ack = this.build(PacketType.ACK, orig.src, orig.msgId, Flags.SIGNED, 0);
    this.markSeen(toHex(ack.msgId));
    this.forward(ack, undefined, 0);
  }

  private deliver(p: Packet, plain: Uint8Array, direct: boolean): void {
    const srcHex = toHex(p.src);
    const msg: ChatMessage = {
      from: srcHex,
      nickname: this.peers.get(srcHex)?.nickname,
      text: new TextDecoder().decode(plain),
      direct,
      alert: p.type === PacketType.ALERT,
      timestamp: p.timestamp,
    };
    this.handlers.forEach((h) => h(msg));
  }

  // ---- relaying ------------------------------------------------------

  private forward(p: Packet, from: string | undefined, delayMs: number): void {
    if (p.ttl <= 0) return;
    const hex = toHex(p.msgId);
    const go = () => {
      this.pendingRelay.delete(hex);
      const bytes = encode(p);
      if (!isBroadcast(p.dst)) {
        const dstHex = toHex(p.dst);
        for (const [l, peer] of this.neighbors) {
          if (peer === dstHex) return this.transport.send(l, bytes);
        }
      }
      for (const l of this.transport.links()) if (l !== from) this.transport.send(l, bytes);
    };
    if (delayMs <= 0) return go();
    this.pendingRelay.set(hex, this.clock.setTimeout(go, delayMs));
  }

  private markSeen(hex: string, ttl = MAX_TTL): void {
    this.seen.delete(hex);
    this.seen.set(hex, ttl);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.keys().next().value!);
  }
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

