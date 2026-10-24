export interface Clock {
  now(): number;
  /** Returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};

/** A link-level transport (BLE, Wi-Fi, WebSocket...). Link ids are opaque and local to the transport. */
export interface Transport {
  readonly mtu: number;
  send(link: string, bytes: Uint8Array): void;
  broadcast(bytes: Uint8Array): void;
  links(): string[];
  onReceive(cb: (link: string, bytes: Uint8Array) => void): void;
  onLinkUp(cb: (link: string) => void): void;
  onLinkDown(cb: (link: string) => void): void;
}
