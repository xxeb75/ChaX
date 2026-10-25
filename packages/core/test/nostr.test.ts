import { describe, expect, it } from 'vitest';
import { ChaxNode, MultiTransport, NostrTransport, SimNetwork, toHex, type ChatMessage, type SocketLike } from '../src';

/** In-memory Nostr relay: honours the two REQ filters (#t, #p) and fans EVENTs out to matching subscribers. */
class FakeRelay {
  clients = new Set<FakeSocket>();
  events: any[] = [];
  connect(): SocketLike {
    const s = new FakeSocket(this);
    this.clients.add(s);
    queueMicrotask(() => s.onopen?.({}));
    return s;
  }
  publish(ev: any, from: FakeSocket): void {
    this.events.push(ev);
    for (const c of this.clients) if (c !== from && c.matches(ev)) c.deliver(ev);
  }
}

class FakeSocket implements SocketLike {
  readyState = 1;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  filters: any[] = [];
  constructor(private relay: FakeRelay) {}
  send(data: string): void {
    const m = JSON.parse(data);
    if (m[0] === 'REQ') {
      this.filters = m.slice(2);
      for (const ev of this.relay.events) if (this.matches(ev)) this.deliver(ev);
    } else if (m[0] === 'EVENT') this.relay.publish(m[1], this);
  }
  matches(ev: any): boolean {
    return this.filters.some((f) =>
      Object.entries(f).every(([k, v]: [string, any]) => {
        if (k === 'kinds') return v.includes(ev.kind);
        if (k.startsWith('#')) return ev.tags.some((t: string[]) => t[0] === k.slice(1) && v.includes(t[1]));
        return true;
      }),
    );
  }
  deliver(ev: any): void {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(['EVENT', 'chax', ev]) }));
  }
  close(): void {
    this.readyState = 3;
    this.relay.clients.delete(this);
    this.onclose?.({});
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

function peer(relay: FakeRelay, name: string) {
  const net = new SimNetwork({ seed: 1 });
  const identityHolder: { id?: string } = {};
  const placeholder = net.createTransport(name);
  // create the node first with a proxy transport so its peer id is known before the Nostr transport subscribes
  const proxy: { nostr?: NostrTransport } = {};
  const nodeT = {
    mtu: 200,
    send: (l: string, b: Uint8Array) => multi?.send(l, b),
    broadcast: (b: Uint8Array) => multi?.broadcast(b),
    links: () => multi?.links() ?? [],
    onReceive: (cb: any) => lateRx.push(cb),
    onLinkUp: (cb: any) => lateUp.push(cb),
    onLinkDown: (cb: any) => lateDown.push(cb),
  };
  const lateRx: any[] = [];
  const lateUp: any[] = [];
  const lateDown: any[] = [];
  let multi: MultiTransport | undefined;
  const node = new ChaxNode({ transport: nodeT, nickname: name, clock: net, rng: net.rng });
  identityHolder.id = toHex(node.identity.peerId);
  proxy.nostr = new NostrTransport({ selfId: identityHolder.id, relays: ['ws://r1'], socket: () => relay.connect() });
  multi = new MultiTransport([
    { name: 'ble', transport: placeholder },
    { name: 'net', transport: proxy.nostr },
  ]);
  multi.onReceive((l, b) => lateRx.forEach((cb) => cb(l, b)));
  multi.onLinkUp((l) => lateUp.forEach((cb) => cb(l)));
  multi.onLinkDown((l) => lateDown.forEach((cb) => cb(l)));
  const inbox: ChatMessage[] = [];
  node.onMessage((m) => inbox.push(m));
  return { node, nostr: proxy.nostr, multi, inbox, id: identityHolder.id };
}

describe('nostr fallback', () => {
  it('delivers a public message and a direct message through a relay', async () => {
    const relay = new FakeRelay();
    const a = peer(relay, 'Ana');
    const b = peer(relay, 'Ben');
    a.nostr.start();
    b.nostr.start();
    await tick();
    expect(a.nostr.connected).toBe(1);
    a.node.announce();
    b.node.announce();
    await tick();
    a.node.sendBroadcast('bonjour internet');
    await tick();
    expect(b.inbox.some((m) => m.text === 'bonjour internet' && !m.direct)).toBe(true);
    expect(b.multi.links().some((l) => l === `net|p:${a.id}`)).toBe(true);
    a.node.sendDirect(b.id, 'secret');
    await tick();
    expect(b.inbox.some((m) => m.text === 'secret' && m.direct)).toBe(true);
    // the relay only ever saw opaque base64 (no plaintext)
    expect(JSON.stringify(relay.events)).not.toContain('secret');
  });

  it('does nothing while stopped, and drops links when it stops', async () => {
    const relay = new FakeRelay();
    const a = peer(relay, 'Ana');
    a.node.announce();
    await tick();
    expect(relay.events.length).toBe(0);
    a.nostr.start();
    await tick();
    expect(a.multi.links()).toContain('net|lobby');
    a.nostr.stop();
    expect(a.multi.links().filter((l) => l.startsWith('net|'))).toEqual([]);
  });
});
