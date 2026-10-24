import type { Transport } from './transport';

type Wire =
  | { t: 'hello'; from: string; reply: boolean }
  | { t: 'bye'; from: string }
  | { t: 'frame'; from: string; to: string; data: Uint8Array };

const HELLO_EVERY_MS = 2000;
const PEER_TIMEOUT_MS = 7000;

/**
 * Transport over BroadcastChannel: every tab of the same browser profile is a neighbour.
 * Meant for demos and tests of the chat UI without radio hardware.
 */
export class BroadcastChannelTransport implements Transport {
  readonly mtu = 64 * 1024;
  readonly id = Math.random().toString(36).slice(2, 10);
  private ch: BroadcastChannel;
  private peers = new Map<string, number>(); // link -> last hello
  private rx: ((l: string, b: Uint8Array) => void)[] = [];
  private upCb: ((l: string) => void)[] = [];
  private downCb: ((l: string) => void)[] = [];
  private timer: ReturnType<typeof setInterval>;

  constructor(name = 'chax-mesh') {
    this.ch = new BroadcastChannel(name);
    this.ch.onmessage = (ev: MessageEvent<Wire>) => this.onWire(ev.data);
    this.timer = setInterval(() => this.tick(), HELLO_EVERY_MS);
    this.post({ t: 'hello', from: this.id, reply: false });
    globalThis.addEventListener?.('pagehide', () => this.close());
  }

  send(link: string, bytes: Uint8Array): void {
    this.post({ t: 'frame', from: this.id, to: link, data: bytes });
  }

  broadcast(bytes: Uint8Array): void {
    for (const l of this.peers.keys()) this.send(l, bytes);
  }

  links(): string[] {
    return [...this.peers.keys()];
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

  close(): void {
    clearInterval(this.timer);
    this.post({ t: 'bye', from: this.id });
    this.ch.close();
  }

  private post(w: Wire): void {
    try {
      this.ch.postMessage(w);
    } catch {
      /* channel closed */
    }
  }

  private seen(from: string): void {
    const isNew = !this.peers.has(from);
    this.peers.set(from, Date.now());
    if (isNew) this.upCb.forEach((cb) => cb(from));
  }

  private drop(from: string): void {
    if (this.peers.delete(from)) this.downCb.forEach((cb) => cb(from));
  }

  private onWire(w: Wire): void {
    if (w.from === this.id) return;
    switch (w.t) {
      case 'hello':
        this.seen(w.from);
        if (!w.reply) this.post({ t: 'hello', from: this.id, reply: true });
        break;
      case 'bye':
        this.drop(w.from);
        break;
      case 'frame':
        if (w.to !== this.id) return;
        this.seen(w.from);
        this.rx.forEach((cb) => cb(w.from, w.data));
        break;
    }
  }

  private tick(): void {
    this.post({ t: 'hello', from: this.id, reply: true });
    const now = Date.now();
    for (const [l, t] of [...this.peers]) if (now - t > PEER_TIMEOUT_MS) this.drop(l);
  }
}
