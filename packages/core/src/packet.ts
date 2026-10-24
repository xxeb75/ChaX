import { concat, equal } from './bytes';

export const VERSION = 1;
export const MAX_TTL = 7;
export const ID_LEN = 8;
export const SIG_LEN = 64;
export const BROADCAST = new Uint8Array(ID_LEN).fill(0xff);

export enum PacketType {
  MSG = 1,
  ACK = 2,
  ANNOUNCE = 3,
  FRAG = 4,
  SYNC = 5,
  ALERT = 6,
  READ = 7,
}

export const Flags = {
  ENCRYPTED: 1,
  SIGNED: 2,
  PRIORITY: 4,
  STORE_FORWARD: 8,
  RATCHET: 16, // ENCRYPTED payload is a double-ratchet message, not a sealed box
} as const;

export interface Packet {
  version: number;
  type: PacketType;
  ttl: number;
  flags: number;
  msgId: Uint8Array;
  timestamp: number; // ms epoch
  expiry: number; // seconds of validity, 0 = none
  src: Uint8Array;
  dst: Uint8Array;
  payload: Uint8Array;
  signature: Uint8Array; // SIG_LEN bytes, zero-filled when unsigned
}

// version, type, ttl, flags, msgId, timestamp, expiry, src, dst, payloadLen
const HEADER_LEN = 1 + 1 + 1 + 1 + ID_LEN + 8 + 4 + ID_LEN + ID_LEN + 2;
export const MAX_PAYLOAD = 0xffff;

export function encode(p: Packet): Uint8Array {
  if (p.payload.length > MAX_PAYLOAD) throw new Error('payload too large');
  const out = new Uint8Array(HEADER_LEN + p.payload.length + SIG_LEN);
  const dv = new DataView(out.buffer);
  let o = 0;
  out[o++] = p.version;
  out[o++] = p.type;
  out[o++] = p.ttl;
  out[o++] = p.flags;
  out.set(p.msgId, o);
  o += ID_LEN;
  dv.setBigUint64(o, BigInt(p.timestamp));
  o += 8;
  dv.setUint32(o, p.expiry);
  o += 4;
  out.set(p.src, o);
  o += ID_LEN;
  out.set(p.dst, o);
  o += ID_LEN;
  dv.setUint16(o, p.payload.length);
  o += 2;
  out.set(p.payload, o);
  o += p.payload.length;
  out.set(p.signature, o);
  return out;
}

export function decode(b: Uint8Array): Packet {
  if (b.length < HEADER_LEN + SIG_LEN) throw new Error('packet too short');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const version = b[o++]!;
  if (version !== VERSION) throw new Error(`unsupported version ${version}`);
  const type = b[o++]!;
  const ttl = b[o++]!;
  const flags = b[o++]!;
  const msgId = b.slice(o, o + ID_LEN);
  o += ID_LEN;
  const timestamp = Number(dv.getBigUint64(o));
  o += 8;
  const expiry = dv.getUint32(o);
  o += 4;
  const src = b.slice(o, o + ID_LEN);
  o += ID_LEN;
  const dst = b.slice(o, o + ID_LEN);
  o += ID_LEN;
  const len = dv.getUint16(o);
  o += 2;
  if (b.length !== HEADER_LEN + len + SIG_LEN) throw new Error('bad packet length');
  const payload = b.slice(o, o + len);
  o += len;
  const signature = b.slice(o, o + SIG_LEN);
  return { version, type, ttl, flags, msgId, timestamp, expiry, src, dst, payload, signature };
}

/** Bytes covered by the signature: everything except ttl (relays decrement it) and the signature. */
export function signedBytes(p: Packet): Uint8Array {
  const meta = new Uint8Array(1 + 1 + 1 + 8 + 4);
  const dv = new DataView(meta.buffer);
  meta[0] = p.version;
  meta[1] = p.type;
  meta[2] = p.flags;
  dv.setBigUint64(3, BigInt(p.timestamp));
  dv.setUint32(11, p.expiry);
  return concat(meta, p.msgId, p.src, p.dst, p.payload);
}

export function isBroadcast(id: Uint8Array): boolean {
  return equal(id, BROADCAST);
}
