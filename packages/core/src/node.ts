import { concat, equal, fromHex, randomBytes, toHex } from './bytes';
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
export const FRAG_SIZE = 8 * 1024;
export const MAX_ATTACHMENT = 2 * 1024 * 1024;
const FRAG_HEADER = ID_LEN + 2 + 2; // objId, index, total
const MAX_FRAGS = Math.ceil((MAX_ATTACHMENT + 2048) / FRAG_SIZE) + 1;
const MAX_ASSEMBLIES = 16;
const FILE_EXPIRY_S = 6 * 3600;
const ASSEMBLY_TTL_MS = 6 * 3600 * 1000;

export interface Attachment {
  name: string;
  mime: string;
  data: Uint8Array;
}

export interface TransferProgress {
  id: string; // hex object id, same as ChatMessage.id once complete
  from: string;
  direct: boolean;
  received: number;
  total: number;
}

interface Assembly {
  from: string;
  direct: boolean;
  total: number;
  parts: Map<number, Uint8Array>;
  timestamp: number;
  startedAt: number;
}

export interface ChatMessage {
  id: string; // hex msgId (hex object id for attachments)
  from: string; // hex peerId
  nickname?: string;
  text: string; // empty for attachments
  attachment?: Attachment;
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
  private deliveredHandlers: ((msgId: string) => void)[] = [];
  private readHandlers: ((msgId: string) => void)[] = [];
  private awaitingRead = new Map<string, string>(); // msgId hex -> recipient peerId hex
  private awaitingAck = new Map<string, string>(); // msgId hex -> recipient peerId hex
  private readonly assemblies = new Map<string, Assembly>(); // object id hex -> fragments received so far
  private readonly finished = new Set<string>(); // object ids already delivered
  private transferHandlers: ((t: TransferProgress) => void)[] = [];

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

  /** Called with the hex msgId of a direct message once its recipient has acknowledged it. */
  onDelivered(cb: (msgId: string) => void): void {
    this.deliveredHandlers.push(cb);
  }

  /** Called with the hex msgId of a direct message once its recipient has read it. */
  onRead(cb: (msgId: string) => void): void {
    this.readHandlers.push(cb);
  }

  /** Called as fragments of an incoming attachment arrive. */
  onTransfer(cb: (t: TransferProgress) => void): void {
    this.transferHandlers.push(cb);
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
    const id = this.emit(
      PacketType.MSG,
      peer.peerId,
      seal(peer.xPub, utf8(text)),
      Flags.SIGNED | Flags.ENCRYPTED | Flags.STORE_FORWARD,
      expirySeconds,
    );
    this.awaitingAck.set(toHex(id), to);
    this.awaitingRead.set(toHex(id), to);
    return id;
  }

  /** File or image split into fragments flooded across the mesh (public, or sealed for `to`). Returns the object id. */
  sendFile(file: Attachment, to?: string, expirySeconds = FILE_EXPIRY_S): Uint8Array {
    if (file.data.length > MAX_ATTACHMENT) throw new Error('attachment too large');
    let blob: Uint8Array = encodeBlob(file);
    let dst: Uint8Array = BROADCAST;
    let flags = Flags.SIGNED | Flags.STORE_FORWARD;
    if (to !== undefined) {
      const peer = this.peers.get(to);
      if (!peer) throw new Error('unknown peer: no public key');
      blob = seal(peer.xPub, blob);
      dst = peer.peerId;
      flags |= Flags.ENCRYPTED;
    }
    const objId = randomBytes(ID_LEN);
    if (to !== undefined) {
      this.awaitingAck.set(toHex(objId), to);
      this.awaitingRead.set(toHex(objId), to);
    }
    const total = Math.max(1, Math.ceil(blob.length / FRAG_SIZE));
    for (let i = 0; i < total; i++) {
      const head = new Uint8Array(FRAG_HEADER);
      head.set(objId);
      new DataView(head.buffer).setUint16(ID_LEN, i);
      new DataView(head.buffer).setUint16(ID_LEN + 2, total);
      this.emit(PacketType.FRAG, dst, concat(head, blob.slice(i * FRAG_SIZE, (i + 1) * FRAG_SIZE)), flags, expirySeconds);
    }
    return objId;
  }

  /** Tells `to` that the given messages (hex msgIds, as delivered in ChatMessage.id) were read. */
  sendRead(to: string, msgIds: string[]): void {
    const peer = this.peers.get(to);
    if (!peer || msgIds.length === 0) return;
    this.emit(
      PacketType.READ,
      peer.peerId,
      concat(...msgIds.map(fromHex)),
      Flags.SIGNED | Flags.STORE_FORWARD,
      24 * 3600,
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
        this.purgeFragments(p.payload.slice(0, ID_LEN), p.src);
        {
          const acked = toHex(p.payload.slice(0, ID_LEN));
          if (this.awaitingAck.get(acked) === srcHex) {
            this.awaitingAck.delete(acked);
            this.deliveredHandlers.forEach((h) => h(acked));
          }
        }
        break;
      case PacketType.READ:
        if (equal(p.dst, this.identity.peerId)) {
          for (let i = 0; i + ID_LEN <= p.payload.length; i += ID_LEN) {
            const id = toHex(p.payload.slice(i, i + ID_LEN));
            if (this.awaitingRead.get(id) !== srcHex) continue;
            this.awaitingRead.delete(id);
            if (this.awaitingAck.delete(id)) this.deliveredHandlers.forEach((h) => h(id)); // read implies delivered
            this.readHandlers.forEach((h) => h(id));
          }
          return; // unicast ends here
        }
        if (p.flags & Flags.STORE_FORWARD) this.store.put(p, this.clock.now());
        break;
      case PacketType.FRAG:
        if (isBroadcast(p.dst)) {
          this.collect(p);
        } else if (equal(p.dst, this.identity.peerId)) {
          this.collect(p);
          return; // unicast ends here
        }
        if (p.flags & Flags.STORE_FORWARD) this.store.put(p, this.clock.now());
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

  /** Drops relay copies of the fragments of an acknowledged object. */
  private purgeFragments(objId: Uint8Array, recipient: Uint8Array): void {
    for (const q of this.store.all(this.clock.now())) {
      if (q.type === PacketType.FRAG && equal(q.dst, recipient) && equal(q.payload.slice(0, ID_LEN), objId)) {
        this.store.remove(q.msgId);
      }
    }
  }

  private collect(p: Packet): void {
    if (p.payload.length < FRAG_HEADER) return;
    const objId = p.payload.slice(0, ID_LEN);
    const hex = toHex(objId);
    if (this.finished.has(hex)) return;
    const dv = new DataView(p.payload.buffer, p.payload.byteOffset, p.payload.byteLength);
    const index = dv.getUint16(ID_LEN);
    const total = dv.getUint16(ID_LEN + 2);
    if (total < 1 || total > MAX_FRAGS || index >= total) return;
    const now = this.clock.now();
    let a = this.assemblies.get(hex);
    if (!a) {
      for (const [k, x] of this.assemblies) if (now - x.startedAt > ASSEMBLY_TTL_MS) this.assemblies.delete(k);
      if (this.assemblies.size >= MAX_ASSEMBLIES) this.assemblies.delete(this.assemblies.keys().next().value!);
      a = { from: toHex(p.src), direct: !isBroadcast(p.dst), total, parts: new Map(), timestamp: p.timestamp, startedAt: now };
      this.assemblies.set(hex, a);
    }
    // One object, one sender, one fragment count.
    if (a.total !== total || a.from !== toHex(p.src)) return;
    a.parts.set(index, p.payload.slice(FRAG_HEADER));
    this.transferHandlers.forEach((h) => h({ id: hex, from: a.from, direct: a.direct, received: a.parts.size, total }));
    if (a.parts.size < total) return;

    this.assemblies.delete(hex);
    const blob = concat(...Array.from({ length: total }, (_, i) => a.parts.get(i)!));
    const plain = a.direct ? open(this.identity, blob) : blob;
    const file = plain && decodeBlob(plain);
    if (!file) return;
    this.finished.add(hex);
    if (this.finished.size > 500) this.finished.delete(this.finished.values().next().value!);
    const srcHex = a.from;
    this.handlers.forEach((h) =>
      h({
        id: hex,
        from: srcHex,
        nickname: this.peers.get(srcHex)?.nickname,
        text: '',
        attachment: file,
        direct: a.direct,
        alert: false,
        timestamp: a.timestamp,
      }),
    );
    if (a.direct) {
      const ack = this.build(PacketType.ACK, p.src, objId, Flags.SIGNED, 0);
      this.markSeen(toHex(ack.msgId));
      this.forward(ack, undefined, 0);
    }
  }

  private sendAck(orig: Packet): void {
    const ack = this.build(PacketType.ACK, orig.src, orig.msgId, Flags.SIGNED, 0);
    this.markSeen(toHex(ack.msgId));
    this.forward(ack, undefined, 0);
  }

  private deliver(p: Packet, plain: Uint8Array, direct: boolean): void {
    const srcHex = toHex(p.src);
    const msg: ChatMessage = {
      id: toHex(p.msgId),
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


/** [mimeLen, mime, nameLen(2), name, data] */
function encodeBlob(f: Attachment): Uint8Array {
  const mime = utf8(f.mime).slice(0, 255);
  const name = utf8(f.name).slice(0, 1000);
  const head = new Uint8Array(1 + mime.length + 2);
  head[0] = mime.length;
  head.set(mime, 1);
  new DataView(head.buffer).setUint16(1 + mime.length, name.length);
  return concat(head, name, f.data);
}

function decodeBlob(b: Uint8Array): Attachment | undefined {
  if (b.length < 3) return undefined;
  const ml = b[0]!;
  if (b.length < 1 + ml + 2) return undefined;
  const nl = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint16(1 + ml);
  const o = 1 + ml + 2;
  if (b.length < o + nl) return undefined;
  const dec = new TextDecoder();
  return { mime: dec.decode(b.slice(1, 1 + ml)), name: dec.decode(b.slice(o, o + nl)), data: b.slice(o + nl) };
}
