import type { Clock, Transport } from './transport';

function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Event {
  at: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

export interface SimOptions {
  seed?: number;
  latencyMs?: number;
  loss?: number; // 0..1 per frame
  mtu?: number;
}

/** Deterministic virtual-time network: it is the Clock for every node attached to it. */
export class SimNetwork implements Clock {
  private time = 0;
  private seq = 0;
  private queue: Event[] = [];
  private transports = new Map<string, SimTransport>();
  private edges = new Set<string>();
  readonly rng: () => number;
  readonly latencyMs: number;
  loss: number;
  readonly mtu: number;
  framesSent = 0;

  constructor(opts: SimOptions = {}) {
    this.rng = mulberry32(opts.seed ?? 1);
    this.latencyMs = opts.latencyMs ?? 20;
    this.loss = opts.loss ?? 0;
    this.mtu = opts.mtu ?? 512;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const ev: Event = { at: this.time + Math.max(0, ms), seq: this.seq++, fn, cancelled: false };
    this.queue.push(ev);
    return () => {
      ev.cancelled = true;
    };
  }

  createTransport(id: string): SimTransport {
    const t = new SimTransport(this, id);
    this.transports.set(id, t);
    return t;
  }

  private key(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`;
  }

  isLinked(a: string, b: string): boolean {
    return this.edges.has(this.key(a, b));
  }

  link(a: string, b: string): void {
    if (this.isLinked(a, b)) return;
    this.edges.add(this.key(a, b));
    this.setTimeout(() => {
      this.transports.get(a)?.up(b);
      this.transports.get(b)?.up(a);
    }, 0);
  }

  unlink(a: string, b: string): void {
    if (!this.edges.delete(this.key(a, b))) return;
    this.transports.get(a)?.down(b);
    this.transports.get(b)?.down(a);
  }

  /** Move a node out of range of everyone. */
  isolate(a: string): void {
    for (const l of this.transports.get(a)?.links() ?? []) this.unlink(a, l);
  }

  deliver(from: string, to: string, bytes: Uint8Array): void {
    if (!this.isLinked(from, to)) return;
    this.framesSent++;
    if (this.rng() < this.loss) return;
    this.setTimeout(() => {
      if (this.isLinked(from, to)) this.transports.get(to)?.recv(from, bytes);
    }, this.latencyMs);
  }

  /** Advance virtual time by ms, running all events due. */
  run(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const e = this.queue[i]!;
        if (e.cancelled || e.at > end) continue;
        const b = best >= 0 ? this.queue[best]! : undefined;
        if (!b || e.at < b.at || (e.at === b.at && e.seq < b.seq)) best = i;
      }
      if (best < 0) break;
      const ev = this.queue.splice(best, 1)[0]!;
      this.time = Math.max(this.time, ev.at);
      ev.fn();
      this.queue = this.queue.filter((e) => !e.cancelled);
    }
    this.time = end;
  }
}

export class SimTransport implements Transport {
  private rx: ((l: string, b: Uint8Array) => void)[] = [];
  private upCb: ((l: string) => void)[] = [];
  private downCb: ((l: string) => void)[] = [];
  private peers = new Set<string>();

  constructor(private net: SimNetwork, readonly id: string) {}

  get mtu(): number {
    return this.net.mtu;
  }

  send(link: string, bytes: Uint8Array): void {
    this.net.deliver(this.id, link, bytes);
  }

  broadcast(bytes: Uint8Array): void {
    for (const p of this.peers) this.net.deliver(this.id, p, bytes);
  }

  links(): string[] {
    return [...this.peers];
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

  /** @internal */
  up(l: string): void {
    this.peers.add(l);
    this.upCb.forEach((cb) => cb(l));
  }
  /** @internal */
  down(l: string): void {
    this.peers.delete(l);
    this.downCb.forEach((cb) => cb(l));
  }
  /** @internal */
  recv(from: string, bytes: Uint8Array): void {
    this.rx.forEach((cb) => cb(from, bytes));
  }
}
