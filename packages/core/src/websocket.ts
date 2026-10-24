import type { Transport } from './transport';

type Wire =
  | { t: 'hello'; from: string; reply: boolean }
  | { t: 'bye'; from: string }
  | { t: 'frame'; from: string; to: string; data: string }; // data: base64

const HELLO_EVERY_MS = 2000;
const PEER_TIMEOUT_MS = 7000;
const RECONNECT_MS = 1500;

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

/**
 * Transport through a ChaX relay (packages/relay): every client of the relay is a neighbour.
 * Same semantics as the other transports, so routing and store-and-forward work unchanged.
 */
export class WebSocketTransport implements Transport {
  readonly mtu = 64 * 1024;
  readonly id = Math.random().toString(36).slice(2, 10);
  private ws?: WebSocket;
  private peers = new Map<string, number>();
  private rx: ((l: string, b: Uint8Array) => void)[] = [];
  private upCb: ((l: string) => void)[] = [];
  private downCb: ((l: string) => void)[] = [];
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private statusCb: ((connected: boolean) => void)[] = [];

  constructor(private url: string) {
    this.timer = setInterval(() => this.tick(), HELLO_EVERY_MS);
    this.connect();
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onStatus(cb: (connected: boolean) => void): void {
    this.statusCb.push(cb);
  }

  send(link: string, bytes: Uint8Array): void {
    this.post({ t: 'frame', from: this.id, to: link, data: b64(bytes) });
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
    this.closed = true;
    clearInterval(this.timer);
    this.post({ t: 'bye', from: this.id });
    this.ws?.close();
  }

  private connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      setTimeout(() => this.connect(), RECONNECT_MS);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.statusCb.forEach((cb) => cb(true));
      this.post({ t: 'hello', from: this.id, reply: false });
    };
    ws.onmessage = (ev) => {
      try {
        this.onWire(JSON.parse(String(ev.data)) as Wire);
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      this.statusCb.forEach((cb) => cb(false));
      for (const l of [...this.peers.keys()]) this.drop(l); // out of range of everyone
      if (!this.closed) setTimeout(() => this.connect(), RECONNECT_MS);
    };
    ws.onerror = () => ws.close();
  }

  private post(w: Wire): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(w));
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
        this.rx.forEach((cb) => cb(w.from, unb64(w.data)));
        break;
    }
  }

  private tick(): void {
    this.post({ t: 'hello', from: this.id, reply: true });
    const now = Date.now();
    for (const [l, t] of [...this.peers]) if (now - t > PEER_TIMEOUT_MS) this.drop(l);
  }
}
