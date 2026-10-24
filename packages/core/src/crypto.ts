import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { concat, randomBytes } from './bytes';
import { ID_LEN } from './packet';

export interface Identity {
  edPriv: Uint8Array;
  edPub: Uint8Array;
  xPriv: Uint8Array;
  xPub: Uint8Array;
  peerId: Uint8Array;
}

export interface PublicIdentity {
  edPub: Uint8Array;
  xPub: Uint8Array;
  peerId: Uint8Array;
}

export function peerIdOf(edPub: Uint8Array): Uint8Array {
  return sha256(edPub).slice(0, ID_LEN);
}

export function createIdentity(): Identity {
  const edPriv = ed25519.utils.randomSecretKey();
  const xPriv = x25519.utils.randomSecretKey();
  const edPub = ed25519.getPublicKey(edPriv);
  return { edPriv, edPub, xPriv, xPub: x25519.getPublicKey(xPriv), peerId: peerIdOf(edPub) };
}

export function sign(id: Identity, msg: Uint8Array): Uint8Array {
  return ed25519.sign(msg, id.edPriv);
}

export function verify(edPub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, msg, edPub);
  } catch {
    return false;
  }
}

const SEAL_INFO = new TextEncoder().encode('chax-seal-v1');

function sealKey(shared: Uint8Array, eph: Uint8Array, recipient: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concat(eph, recipient), SEAL_INFO, 32);
}

/** Sealed box: anyone can encrypt to xPub; only the holder of xPriv can read. Output: eph(32)|nonce(12)|ct. */
export function seal(recipientXPub: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const ephPriv = x25519.utils.randomSecretKey();
  const eph = x25519.getPublicKey(ephPriv);
  const key = sealKey(x25519.getSharedSecret(ephPriv, recipientXPub), eph, recipientXPub);
  const nonce = randomBytes(12);
  return concat(eph, nonce, chacha20poly1305(key, nonce).encrypt(plaintext));
}

export function open(id: Identity, sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < 32 + 12 + 16) return null;
  try {
    const eph = sealed.slice(0, 32);
    const nonce = sealed.slice(32, 44);
    const key = sealKey(x25519.getSharedSecret(id.xPriv, eph), eph, id.xPub);
    return chacha20poly1305(key, nonce).decrypt(sealed.slice(44));
  } catch {
    return null;
  }
}

export function identityFromSecrets(edPriv: Uint8Array, xPriv: Uint8Array): Identity {
  const edPub = ed25519.getPublicKey(edPriv);
  return { edPriv, edPub, xPriv, xPub: x25519.getPublicKey(xPriv), peerId: peerIdOf(edPub) };
}
