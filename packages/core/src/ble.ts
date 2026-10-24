import type { Transport } from './transport';

/**
 * What a native BLE link layer must offer (see packages/android: ChaxBlePlugin).
 * Frames are whole packets: chunking to the radio MTU is the bridge's job.
 */
export interface BleBridge {
  start(nodeId: string): Promise<void>;
  stop(): Promise<void>;
  send(link: string, bytes: Uint8Array): Promise<void>;
  onLinkUp(cb: (link: string) => void): void;
  onLinkDown(cb: (link: string) => void): void;
  onFrame(cb: (link: string, bytes: Uint8Array) => void): void;
  onError(cb: (message: string) => void): void;
}

/** Transport over a Bluetooth LE mesh link layer. Each connected phone is one link. */
export class BleTransport implements Transport {
  readonly mtu = 64 * 1024;
  readonly id = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  private peers = new Set<string>();
  private rx: ((l: string, b: Uint8Array) => void)[] = [];
  private upCb: ((l: string) => void)[] = [];
  private downCb: ((l: string) => void)[] = [];
  private errCb: ((m: string) => void)[] = [];
  private active = false;

  constructor(private bridge: BleBridge) {
    bridge.onLinkUp((l) => {
      if (this.peers.has(l)) return;
      this.peers.add(l);
      this.upCb.forEach((cb) => cb(l));
    });
    bridge.onLinkDown((l) => {
      if (this.peers.delete(l)) this.downCb.forEach((cb) => cb(l));
    });
    bridge.onFrame((l, b) => this.rx.forEach((cb) => cb(l, b)));
    bridge.onError((m) => this.errCb.forEach((cb) => cb(m)));
  }

  /** Asks for the Bluetooth permissions if needed, then advertises and scans. */
  async start(): Promise<void> {
    await this.bridge.start(this.id);
    this.active = true;
  }

  get running(): boolean {
    return this.active;
  }

  async stop(): Promise<void> {
    this.active = false;
    await this.bridge.stop();
  }

  send(link: string, bytes: Uint8Array): void {
    void this.bridge.send(link, bytes).catch((e) => this.errCb.forEach((cb) => cb(String(e?.message ?? e))));
  }

  broadcast(bytes: Uint8Array): void {
    for (const l of this.peers) this.send(l, bytes);
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
  onError(cb: (m: string) => void): void {
    this.errCb.push(cb);
  }
}
