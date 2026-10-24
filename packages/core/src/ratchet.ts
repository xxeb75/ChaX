import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, equal, fromHex, toHex } from './bytes';

/**
 * Double ratchet between two long-term X25519 identities, built from audited primitives.
 *
 * The first root key mixes the two static keys; the first DH ratchet step mixes in the initiator's
 * ephemeral key. Every reply brings a new ratchet key, so from the second round trip on, past
 * messages cannot be decrypted even by someone who steals both devices' long-term keys
 * (forward secrecy), and a stolen session state heals at the next round trip (break-in recovery).
 * The very first message of a conversation is only protected by the long-term keys: no prekeys
 * exist in a serverless mesh.
 */

const MAX_SKIP = 200;
const MAX_SKIPPED_KEPT = 400;
const HEADER_LEN = 1 + 32 + 4 + 4;
const enc = new TextEncoder();
const INFO_INIT = enc.encode('chax-ratchet-init-v1');
const INFO_RK = enc.encode('chax-ratchet-rk-v1');
const INFO_MSG = enc.encode('chax-ratchet-msg-v1');
const ZERO = new Uint8Array(32);

export interface KeyPair {
  priv: Uint8Array;
  pub: Uint8Array;
}

export interface Session {
  rk: Uint8Array;
  dhs: KeyPair;
  dhr?: Uint8Array;
  cks?: Uint8Array;
  ckr?: Uint8Array;
  ns: number;
  nr: number;
  pn: number;
  skipped: Map<string, Uint8Array>; // hex(dh) + ':' + n -> message key
  updated: number;
}

export interface SessionJson {
  rk: string;
  dhsPriv: string;
  dhsPub: string;
  dhr?: string;
  cks?: string;
  ckr?: string;
  ns: number;
  nr: number;
  pn: number;
  skipped: [string, string][];
  updated: number;
}

function newKeyPair(): KeyPair {
  const priv = x25519.utils.randomSecretKey();
  return { priv, pub: x25519.getPublicKey(priv) };
}

function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(priv, pub);
}

function kdfRk(rk: Uint8Array, dhOut: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdf(sha256, dhOut, rk, INFO_RK, 64);
  return [out.slice(0, 32), out.slice(32)];
}

function kdfCk(ck: Uint8Array): [Uint8Array, Uint8Array] {
  return [hmac(sha256, ck, Uint8Array.of(2)), hmac(sha256, ck, Uint8Array.of(1))]; // [next chain key, message key]
}

function aead(mk: Uint8Array, ad: Uint8Array) {
  const kn = hkdf(sha256, mk, ZERO, INFO_MSG, 44);
  return chacha20poly1305(kn.slice(0, 32), kn.slice(32), ad);
}

function rootFromStatic(mine: Uint8Array, theirPub: Uint8Array): Uint8Array {
  return hkdf(sha256, dh(mine, theirPub), ZERO, INFO_INIT, 32);
}

/** We write first: we know their static key, so we can already derive a sending chain. */
export function initiate(myXPriv: Uint8Array, theirXPub: Uint8Array, now: number): Session {
  const dhs = newKeyPair();
  const [rk, cks] = kdfRk(rootFromStatic(myXPriv, theirXPub), dh(dhs.priv, theirXPub));
  return { rk, dhs, dhr: theirXPub, cks, ns: 0, nr: 0, pn: 0, skipped: new Map(), updated: now };
}

/** They wrote first: our static key is our first ratchet key, the chains appear with their first message. */
export function accept(myX: KeyPair, theirXPub: Uint8Array, now: number): Session {
  return { rk: rootFromStatic(myX.priv, theirXPub), dhs: myX, ns: 0, nr: 0, pn: 0, skipped: new Map(), updated: now };
}

export const canSend = (s: Session) => s.cks !== undefined;

function clone(s: Session): Session {
  return { ...s, skipped: new Map(s.skipped) };
}

export function encrypt(s: Session, plaintext: Uint8Array, ad: Uint8Array, now: number): Uint8Array {
  if (!s.cks) throw new Error('no sending chain yet');
  const [next, mk] = kdfCk(s.cks);
  const header = new Uint8Array(HEADER_LEN);
  header[0] = 1;
  header.set(s.dhs.pub, 1);
  const dv = new DataView(header.buffer);
  dv.setUint32(33, s.pn);
  dv.setUint32(37, s.ns);
  const ct = aead(mk, concat(header, ad)).encrypt(plaintext);
  s.cks = next;
  s.ns += 1;
  s.updated = now;
  return concat(header, ct);
}

function skipTo(s: Session, until: number): boolean {
  if (!s.ckr || !s.dhr) return true;
  if (until - s.nr > MAX_SKIP) return false;
  while (s.nr < until) {
    const [next, mk] = kdfCk(s.ckr);
    s.skipped.set(`${toHex(s.dhr)}:${s.nr}`, mk);
    s.ckr = next;
    s.nr += 1;
  }
  while (s.skipped.size > MAX_SKIPPED_KEPT) s.skipped.delete(s.skipped.keys().next().value!);
  return true;
}

/** Returns the plaintext, or null if this message does not belong to the session. The session only changes on success. */
export function decrypt(s: Session, msg: Uint8Array, ad: Uint8Array, now: number): Uint8Array | null {
  if (msg.length < HEADER_LEN + 16 || msg[0] !== 1) return null;
  const header = msg.slice(0, HEADER_LEN);
  const dhPub = header.slice(1, 33);
  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const pn = dv.getUint32(33);
  const n = dv.getUint32(37);
  const ct = msg.slice(HEADER_LEN);
  const fullAd = concat(header, ad);
  try {
    const key = `${toHex(dhPub)}:${n}`;
    const old = s.skipped.get(key);
    if (old) {
      const pt = aead(old, fullAd).decrypt(ct);
      s.skipped.delete(key);
      s.updated = now;
      return pt;
    }
    const t = clone(s);
    if (!t.dhr || !equal(dhPub, t.dhr)) {
      if (!skipTo(t, pn)) return null;
      t.pn = t.ns;
      t.ns = 0;
      t.nr = 0;
      t.dhr = dhPub;
      [t.rk, t.ckr] = kdfRk(t.rk, dh(t.dhs.priv, dhPub));
      t.dhs = newKeyPair();
      [t.rk, t.cks] = kdfRk(t.rk, dh(t.dhs.priv, dhPub));
    }
    if (!skipTo(t, n) || !t.ckr) return null;
    const [next, mk] = kdfCk(t.ckr);
    const pt = aead(mk, fullAd).decrypt(ct);
    t.ckr = next;
    t.nr = n + 1;
    t.updated = now;
    Object.assign(s, t);
    return pt;
  } catch {
    return null;
  }
}

export function sessionToJson(s: Session): SessionJson {
  return {
    rk: toHex(s.rk),
    dhsPriv: toHex(s.dhs.priv),
    dhsPub: toHex(s.dhs.pub),
    dhr: s.dhr && toHex(s.dhr),
    cks: s.cks && toHex(s.cks),
    ckr: s.ckr && toHex(s.ckr),
    ns: s.ns,
    nr: s.nr,
    pn: s.pn,
    skipped: [...s.skipped].map(([k, v]) => [k, toHex(v)]),
    updated: s.updated,
  };
}

export function sessionFromJson(j: SessionJson): Session {
  return {
    rk: fromHex(j.rk),
    dhs: { priv: fromHex(j.dhsPriv), pub: fromHex(j.dhsPub) },
    dhr: j.dhr ? fromHex(j.dhr) : undefined,
    cks: j.cks ? fromHex(j.cks) : undefined,
    ckr: j.ckr ? fromHex(j.ckr) : undefined,
    ns: j.ns,
    nr: j.nr,
    pn: j.pn,
    skipped: new Map(j.skipped.map(([k, v]) => [k, fromHex(v)])),
    updated: j.updated,
  };
}
