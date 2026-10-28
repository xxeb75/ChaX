import { createIdentity, fromHex, identityFromSecrets, toHex, type Identity } from '../../core/src';

// What the visible page and the headless node (src/headless.ts) share: one WebView origin, one set of keys.

export type Status = 'pending' | 'transit' | 'delivered' | 'read';

export interface Line {
  id?: string; // hex msgId
  mine: boolean;
  from: string;
  text: string;
  at: number;
  alert?: boolean;
  status?: Status; // our own direct messages
  readSent?: boolean; // a received direct message we already acknowledged as read
  file?: { name: string; mime: string; size: number }; // bytes live in IndexedDB under `id`
}

export const PUBLIC = 'public';
export const ALERTS = 'alerts';
export const MAX_LINES = 200;
export const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

// ---- storage -------------------------------------------------------------------
// Native app: one WebView origin, so identity and history must outlive the process (localStorage).
// Browser tabs: sessionStorage, so several tabs act as distinct nodes.

export const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, any> } }).Capacitor;
export const native = !!cap?.isNativePlatform?.() || !!(window as unknown as { ChaxNative?: unknown }).ChaxNative;
// A browser tab forgets everything on close; the phone app and the Windows app keep their identity and history.
const persistent = native || (window as unknown as { __chaxHost?: string }).__chaxHost === 'windows';
const store = (): Storage => (persistent ? localStorage : sessionStorage);

export function load<T>(key: string): T | undefined {
  try {
    const v = store().getItem(key);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}
export function save(key: string, v: unknown): void {
  try {
    store().setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

export function loadIdentity(): Identity {
  const s = load<{ ed: string; x: string }>('chax.identity');
  if (s) return identityFromSecrets(fromHex(s.ed), fromHex(s.x));
  const id = createIdentity();
  save('chax.identity', { ed: toHex(id.edPriv), x: toHex(id.xPriv) });
  return id;
}

// ---- attachments: bytes in IndexedDB, only metadata in the history ---------------------

let dbp: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('chax-files', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('f');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
export async function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  return new Promise((res, rej) => {
    const r = run(d.transaction('f', mode).objectStore('f'));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export const putFile = (id: string, b: Blob) => idb('readwrite', (s) => s.put(b, id)).catch(() => undefined);

/** Internet fallback (Nostr relays): "auto" switches it on when no Bluetooth peer is around, "on" always, "off" never. */
export type NetMode = 'auto' | 'on' | 'off';
export interface NetCfg {
  mode: NetMode;
  relays: string[];
  /** The user's answer to "may the app use public relays by itself?". Unset until asked; "on" mode counts as a yes. */
  consent?: 'yes' | 'no';
}
export const loadNet = (): NetCfg => {
  const c = load<{ mode?: NetMode; on?: boolean; relays?: string[]; consent?: 'yes' | 'no' }>('chax.net');
  // builds before the automatic mode stored an on/off flag
  const mode: NetMode = c?.mode === 'on' || c?.mode === 'off' || c?.mode === 'auto' ? c.mode : c?.on ? 'on' : 'auto';
  const consent = c?.consent === 'yes' || c?.consent === 'no' ? c.consent : mode === 'on' ? 'yes' : undefined;
  return { mode, relays: Array.isArray(c?.relays) && c.relays.length ? c.relays : [], consent };
};
