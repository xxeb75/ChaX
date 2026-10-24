import { toHex } from './bytes';
import { Flags, PacketType, type Packet } from './packet';

interface Entry {
  packet: Packet;
  size: number;
  storedAt: number;
}

export function isExpired(p: Packet, now: number): boolean {
  return p.expiry > 0 && p.timestamp + p.expiry * 1000 < now;
}

function priority(p: Packet): number {
  if (p.type === PacketType.ALERT) return 3;
  if (p.type === PacketType.ANNOUNCE) return 2;
  if (p.flags & Flags.PRIORITY) return 2;
  return 1;
}

/** Bounded store for packets carried on behalf of absent peers. */
export class Store {
  private entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(private quotaBytes: number) {}

  get size(): number {
    return this.entries.size;
  }

  has(msgId: Uint8Array): boolean {
    return this.entries.has(toHex(msgId));
  }

  ids(now: number): Uint8Array[] {
    this.purgeExpired(now);
    return [...this.entries.values()].map((e) => e.packet.msgId);
  }

  all(now: number): Packet[] {
    this.purgeExpired(now);
    return [...this.entries.values()].map((e) => e.packet);
  }

  remove(msgId: Uint8Array): boolean {
    return this.removeHex(toHex(msgId));
  }

  private removeHex(hex: string): boolean {
    const e = this.entries.get(hex);
    if (!e) return false;
    this.bytes -= e.size;
    this.entries.delete(hex);
    return true;
  }

  purgeExpired(now: number): void {
    for (const [k, e] of [...this.entries]) if (isExpired(e.packet, now)) this.removeHex(k);
  }

  /** Stores a packet; an ANNOUNCE replaces the previous one from the same source. Returns false if rejected. */
  put(p: Packet, now: number): boolean {
    if (isExpired(p, now)) return false;
    const hex = toHex(p.msgId);
    if (this.entries.has(hex)) return true;
    if (p.type === PacketType.ANNOUNCE) {
      const src = toHex(p.src);
      for (const [k, e] of [...this.entries]) {
        if (e.packet.type === PacketType.ANNOUNCE && toHex(e.packet.src) === src) this.removeHex(k);
      }
    }
    const size = p.payload.length + 120;
    if (size > this.quotaBytes) return false;
    this.purgeExpired(now);
    while (this.bytes + size > this.quotaBytes) {
      let victim: string | undefined;
      let vp = Infinity;
      let vt = Infinity;
      for (const [k, e] of this.entries) {
        const pr = priority(e.packet);
        if (pr < vp || (pr === vp && e.storedAt < vt)) {
          victim = k;
          vp = pr;
          vt = e.storedAt;
        }
      }
      if (victim === undefined || vp > priority(p)) return false;
      this.removeHex(victim);
    }
    this.entries.set(hex, { packet: p, size, storedAt: now });
    this.bytes += size;
    return true;
  }
}
