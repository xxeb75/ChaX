import type { Transport } from './transport';

/**
 * Runs several transports at once (Bluetooth, internet fallback...). Link ids become `<name>|<link>`, so the node
 * keeps one neighbour model and the UI can tell by the prefix how someone is reached.
 */
export class MultiTransport implements Transport {
  readonly mtu: number;

  constructor(private parts: { name: string; transport: Transport }[]) {
    this.mtu = Math.min(...parts.map((p) => p.transport.mtu));
  }

  private route(link: string): { transport: Transport; inner: string } | undefined {
    const i = link.indexOf('|');
    const part = this.parts.find((p) => p.name === link.slice(0, i));
    return part ? { transport: part.transport, inner: link.slice(i + 1) } : undefined;
  }

  send(link: string, bytes: Uint8Array): void {
    const r = this.route(link);
    r?.transport.send(r.inner, bytes);
  }

  broadcast(bytes: Uint8Array): void {
    for (const p of this.parts) p.transport.broadcast(bytes);
  }

  links(): string[] {
    return this.parts.flatMap((p) => p.transport.links().map((l) => `${p.name}|${l}`));
  }

  onReceive(cb: (link: string, bytes: Uint8Array) => void): void {
    for (const p of this.parts) p.transport.onReceive((l, b) => cb(`${p.name}|${l}`, b));
  }
  onLinkUp(cb: (link: string) => void): void {
    for (const p of this.parts) p.transport.onLinkUp((l) => cb(`${p.name}|${l}`));
  }
  onLinkDown(cb: (link: string) => void): void {
    for (const p of this.parts) p.transport.onLinkDown((l) => cb(`${p.name}|${l}`));
  }
}
