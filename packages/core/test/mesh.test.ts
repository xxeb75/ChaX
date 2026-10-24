import { describe, expect, it } from 'vitest';
import {
  ChaxNode,
  Flags,
  MAX_TTL,
  PacketType,
  SIG_LEN,
  SimNetwork,
  Store,
  VERSION,
  accept,
  createIdentity,
  decode,
  decrypt as ratchetDecrypt,
  encrypt as ratchetEncrypt,
  initiate,
  sessionFromJson,
  sessionToJson,
  encode,
  open,
  seal,
  sign,
  signedBytes,
  toHex,
  verify,
  type ChatMessage,
  type Packet,
} from '../src';

interface Rig {
  net: SimNetwork;
  nodes: ChaxNode[];
  inbox: ChatMessage[][];
}

function rig(n: number, opts: ConstructorParameters<typeof SimNetwork>[0] = {}): Rig {
  const net = new SimNetwork({ seed: 7, ...opts });
  const nodes: ChaxNode[] = [];
  const inbox: ChatMessage[][] = [];
  for (let i = 0; i < n; i++) {
    const t = net.createTransport(`n${i}`);
    const node = new ChaxNode({ transport: t, nickname: `node${i}`, clock: net, rng: net.rng });
    const box: ChatMessage[] = [];
    node.onMessage((m) => box.push(m));
    nodes.push(node);
    inbox.push(box);
  }
  return { net, nodes, inbox };
}

function chain(r: Rig): void {
  for (let i = 0; i + 1 < r.nodes.length; i++) r.net.link(`n${i}`, `n${i + 1}`);
}

describe('packet', () => {
  const base = (): Packet => ({
    version: VERSION,
    type: PacketType.MSG,
    ttl: MAX_TTL,
    flags: Flags.SIGNED,
    msgId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    timestamp: 1_700_000_000_000,
    expiry: 60,
    src: new Uint8Array(8).fill(1),
    dst: new Uint8Array(8).fill(2),
    payload: new TextEncoder().encode('salut'),
    signature: new Uint8Array(SIG_LEN),
  });

  it('round-trips through encode/decode', () => {
    const p = base();
    expect(decode(encode(p))).toEqual(p);
  });

  it('rejects truncated or wrong-version frames', () => {
    const b = encode(base());
    expect(() => decode(b.slice(0, 10))).toThrow();
    expect(() => decode(b.slice(0, b.length - 1))).toThrow();
    const v = b.slice();
    v[0] = 99;
    expect(() => decode(v)).toThrow();
  });

  it('signature survives a ttl change but not a payload change', () => {
    const id = createIdentity();
    const p = base();
    p.signature = sign(id, signedBytes(p));
    expect(verify(id.edPub, signedBytes({ ...p, ttl: 2 }), p.signature)).toBe(true);
    expect(verify(id.edPub, signedBytes({ ...p, payload: new Uint8Array([0]) }), p.signature)).toBe(false);
  });
});

describe('crypto', () => {
  it('sealed box opens only for the recipient', () => {
    const a = createIdentity();
    const b = createIdentity();
    const sealed = seal(a.xPub, new TextEncoder().encode('secret'));
    expect(new TextDecoder().decode(open(a, sealed)!)).toBe('secret');
    expect(open(b, sealed)).toBeNull();
    const tampered = sealed.slice();
    tampered[tampered.length - 1]! ^= 1;
    expect(open(a, tampered)).toBeNull();
  });
});

describe('store', () => {
  const pkt = (id: number, over: Partial<Packet> = {}): Packet => ({
    version: VERSION,
    type: PacketType.MSG,
    ttl: 3,
    flags: Flags.STORE_FORWARD,
    msgId: new Uint8Array(8).fill(id),
    timestamp: 0,
    expiry: 10,
    src: new Uint8Array(8),
    dst: new Uint8Array(8),
    payload: new Uint8Array(100),
    signature: new Uint8Array(SIG_LEN),
    ...over,
  });

  it('drops expired packets', () => {
    const s = new Store(10_000);
    expect(s.put(pkt(1), 0)).toBe(true);
    expect(s.size).toBe(1);
    expect(s.all(11_000)).toHaveLength(0);
    expect(s.put(pkt(2), 11_000)).toBe(false);
  });

  it('evicts low priority first and refuses to evict higher priority', () => {
    const s = new Store(450); // fits two 220-byte entries
    expect(s.put(pkt(1, { type: PacketType.ALERT, expiry: 0 }), 0)).toBe(true);
    expect(s.put(pkt(2, { expiry: 0 }), 0)).toBe(true);
    expect(s.put(pkt(3, { expiry: 0 }), 1)).toBe(true); // evicts 2, not the alert
    expect(s.has(new Uint8Array(8).fill(1))).toBe(true);
    expect(s.has(new Uint8Array(8).fill(2))).toBe(false);
    expect(s.put(pkt(4, { expiry: 0 }), 2)).toBe(true);
    // a regular message cannot push out the alert when only the alert + 1 slot remain
    expect(s.has(new Uint8Array(8).fill(1))).toBe(true);
  });
});

describe('mesh routing', () => {
  it('floods a broadcast across a chain, delivering once per node', () => {
    const r = rig(5);
    chain(r);
    r.net.run(500);
    r.nodes[0]!.sendBroadcast('hello mesh');
    r.net.run(2000);
    for (let i = 1; i < 5; i++) {
      expect(r.inbox[i]!.map((m) => m.text)).toEqual(['hello mesh']);
      expect(r.inbox[i]![0]!.nickname).toBe('node0');
    }
    expect(r.inbox[0]).toHaveLength(0);
  });

  it('stops at the ttl horizon', () => {
    const r = rig(12);
    chain(r);
    r.net.run(1000);
    r.nodes[0]!.sendBroadcast('far');
    r.net.run(5000);
    expect(r.inbox[MAX_TTL]!.length).toBe(1); // 7 hops away
    expect(r.inbox[MAX_TTL + 1]!.length).toBe(0);
  });

  it('delivers an encrypted direct message; relays cannot read it', () => {
    const r = rig(4);
    chain(r);
    r.net.run(1000);
    const a = r.nodes[0]!;
    const d = r.nodes[3]!;

    // hold the message at the relays first, so we can inspect what they carry
    r.net.unlink('n2', 'n3');
    a.sendDirect(d.peerId, 'rendez-vous a 18h');
    r.net.run(1000);
    const carried = r.nodes[1]!.store.all(r.net.now()).filter((p) => p.type === PacketType.MSG);
    expect(carried.length).toBe(1);
    expect(new TextDecoder().decode(carried[0]!.payload)).not.toContain('rendez-vous');

    r.net.link('n2', 'n3');
    r.net.run(2000);
    expect(r.inbox[3]!.map((m) => [m.text, m.direct])).toEqual([['rendez-vous a 18h', true]]);
    expect(r.inbox[1]).toHaveLength(0);
    expect(r.inbox[2]).toHaveLength(0);
  });

  it('drops forged packets', () => {
    const r = rig(2);
    chain(r);
    r.net.run(500);
    const [a, b] = r.nodes as [ChaxNode, ChaxNode];
    const mallory = createIdentity();
    const forged: Packet = {
      version: VERSION,
      type: PacketType.MSG,
      ttl: MAX_TTL,
      flags: Flags.SIGNED,
      msgId: new Uint8Array(8).fill(9),
      timestamp: r.net.now(),
      expiry: 0,
      src: a.identity.peerId, // pretends to be A
      dst: new Uint8Array(8).fill(0xff),
      payload: new TextEncoder().encode('fake'),
      signature: new Uint8Array(SIG_LEN),
    };
    forged.signature = sign(mallory, signedBytes(forged));
    (b as unknown as { handle(l: string, x: Uint8Array): void }).handle('n0', encode(forged));
    r.net.run(500);
    expect(r.inbox[1]).toHaveLength(0);
  });

  it('survives moderate packet loss thanks to redundant paths', () => {
    // 3x3 grid
    const r = rig(9, { loss: 0.2 });
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 3; x++) {
        const i = y * 3 + x;
        if (x < 2) r.net.link(`n${i}`, `n${i + 1}`);
        if (y < 2) r.net.link(`n${i}`, `n${i + 3}`);
      }
    }
    r.net.run(1000);
    r.nodes[0]!.sendBroadcast('grid');
    r.net.run(3000);
    const got = r.inbox.slice(1).filter((b) => b.length === 1).length;
    expect(got).toBeGreaterThanOrEqual(6);
    for (const b of r.inbox) expect(b.length).toBeLessThanOrEqual(1);
  });
});

describe('store-and-forward', () => {
  it('delivers a direct message after the recipient shows up later, then purges copies', () => {
    const r = rig(3); // A - B - C
    chain(r);
    r.net.run(1000);
    const [a, b, c] = r.nodes as [ChaxNode, ChaxNode, ChaxNode];

    // C walks away
    r.net.unlink('n1', 'n2');
    r.net.run(100);

    a.sendDirect(c.peerId, 'tu as raté le début');
    r.net.run(2000);
    expect(r.inbox[2]).toHaveLength(0);
    expect(b.store.size).toBeGreaterThan(0);

    // A leaves too: only B carries the message
    r.net.isolate('n0');
    r.net.run(100);

    // C comes back near B
    r.net.link('n1', 'n2');
    r.net.run(2000);
    expect(r.inbox[2]!.map((m) => m.text)).toEqual(['tu as raté le début']);

    // the ACK purged B's copy of the DM (only announces remain)
    const left = b.store.all(r.net.now()).filter((p) => p.type !== PacketType.ANNOUNCE);
    expect(left).toHaveLength(0);
  });

  it('tells the sender when a direct message was acknowledged', () => {
    const r = rig(3);
    chain(r);
    r.net.run(1000);
    const [a, , c] = r.nodes as [ChaxNode, ChaxNode, ChaxNode];
    const delivered: string[] = [];
    a.onDelivered((id) => delivered.push(id));
    const id = a.sendDirect(c.peerId, 'accuse moi');
    r.net.run(1000);
    expect(delivered).toEqual([toHex(id)]);
  });

  it('tells the sender when the recipient has read a message, even if they meet later', () => {
    const r = rig(3);
    chain(r);
    r.net.run(1000);
    const [a, b, c] = r.nodes as [ChaxNode, ChaxNode, ChaxNode];
    const read: string[] = [];
    a.onRead((id) => read.push(id));
    const id = a.sendDirect(c.peerId, 'lis moi');
    r.net.run(1000);
    expect(read).toEqual([]); // delivered, not read yet
    expect(r.inbox[2]![0]!.id).toBe(toHex(id));

    // the recipient reads it while the sender is away: the receipt waits at the relay
    r.net.isolate('n0');
    r.net.run(100);
    c.sendRead(a.peerId, [r.inbox[2]![0]!.id]);
    r.net.run(500);
    expect(read).toEqual([]);
    expect(b.store.all(r.net.now()).some((p) => p.type === PacketType.READ)).toBe(true);

    r.net.link('n0', 'n1');
    r.net.run(1500);
    expect(read).toEqual([toHex(id)]);
  });

  it('ignores a read receipt that does not come from the recipient', () => {
    const r = rig(3);
    chain(r);
    r.net.run(1000);
    const [a, b, c] = r.nodes as [ChaxNode, ChaxNode, ChaxNode];
    const read: string[] = [];
    a.onRead((id) => read.push(id));
    const id = a.sendDirect(c.peerId, 'prive');
    r.net.run(1000);
    b.sendRead(a.peerId, [toHex(id)]); // B claims C read it
    r.net.run(1000);
    expect(read).toEqual([]);
  });

  it('does not redeliver the same message on later meetings', () => {
    const r = rig(3);
    chain(r);
    r.net.run(1000);
    const [a, , c] = r.nodes as [ChaxNode, ChaxNode, ChaxNode];
    r.net.unlink('n1', 'n2');
    a.sendDirect(c.peerId, 'une seule fois');
    r.net.run(500);
    r.net.link('n1', 'n2');
    r.net.run(1000);
    r.net.unlink('n1', 'n2');
    r.net.run(100);
    r.net.link('n1', 'n2');
    r.net.run(1000);
    expect(r.inbox[2]).toHaveLength(1);
  });

  it('expired messages are never delivered', () => {
    const r = rig(3);
    chain(r);
    r.net.run(1000);
    const [a, , c] = r.nodes as [ChaxNode, ChaxNode, ChaxNode];
    r.net.unlink('n1', 'n2');
    a.sendDirect(c.peerId, 'trop tard', 10); // 10 s
    r.net.run(500);
    r.net.run(20_000);
    r.net.link('n1', 'n2');
    r.net.run(2000);
    expect(r.inbox[2]).toHaveLength(0);
  });

  it('an alert reaches a node that joins afterwards', () => {
    const r = rig(3);
    r.net.link('n0', 'n1');
    r.net.run(500);
    r.nodes[0]!.sendAlert('Evacuation zone nord');
    r.net.run(500);
    expect(r.inbox[1]![0]!.alert).toBe(true);
    r.net.isolate('n0');
    r.net.run(100);
    r.net.link('n1', 'n2');
    r.net.run(1000);
    expect(r.inbox[2]!.map((m) => [m.text, m.alert])).toEqual([['Evacuation zone nord', true]]);
  });

  describe('attachments', () => {
    const photo = (n: number) => ({ name: 'photo.jpg', mime: 'image/jpeg', data: Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255) });

    it('splits a file into fragments and reassembles it across relays', () => {
      const r = rig(3);
      chain(r);
      r.net.run(1000);
      const [a, , c] = r.nodes as [ChaxNode, ChaxNode, ChaxNode];
      const f = photo(60_000);
      a.sendFile(f);
      r.net.run(3000);
      for (const box of [r.inbox[1]!, r.inbox[2]!]) {
        expect(box).toHaveLength(1);
        expect(box[0]!.attachment?.name).toBe('photo.jpg');
        expect(box[0]!.attachment?.mime).toBe('image/jpeg');
        expect(Array.from(box[0]!.attachment!.data)).toEqual(Array.from(f.data));
      }
      expect(c.peerId).not.toBe(a.peerId);
    });

    it('seals a direct file, delivers it once, acknowledges it and purges relay copies', () => {
      const r = rig(3);
      chain(r);
      r.net.run(1000);
      const [a, b, c] = r.nodes as [ChaxNode, ChaxNode, ChaxNode];
      const delivered: string[] = [];
      const read: string[] = [];
      a.onDelivered((id) => delivered.push(id));
      a.onRead((id) => read.push(id));
      const f = photo(30_000);
      const id = a.sendFile(f, c.peerId);
      r.net.run(3000);
      expect(r.inbox[1]).toHaveLength(0); // the relay cannot read it
      expect(r.inbox[2]).toHaveLength(1);
      expect(r.inbox[2]![0]!.id).toBe(toHex(id));
      expect(r.inbox[2]![0]!.direct).toBe(true);
      expect(Array.from(r.inbox[2]![0]!.attachment!.data)).toEqual(Array.from(f.data));
      expect(delivered).toEqual([toHex(id)]);
      expect(b.store.all(r.net.now()).some((p) => p.type === PacketType.FRAG)).toBe(false);
      c.sendRead(a.peerId, [r.inbox[2]![0]!.id]);
      r.net.run(500);
      expect(read).toEqual([toHex(id)]);
    });

    it('completes a transfer interrupted by a lost link once the carrier meets the recipient', () => {
      const r = rig(3);
      chain(r);
      r.net.run(1000);
      const [a, , c] = r.nodes as [ChaxNode, ChaxNode, ChaxNode];
      r.net.unlink('n1', 'n2');
      a.sendFile(photo(40_000), c.peerId);
      r.net.run(2000);
      expect(r.inbox[2]).toHaveLength(0);
      r.net.link('n1', 'n2');
      r.net.run(3000);
      expect(r.inbox[2]).toHaveLength(1);
    });

    it('reports progress and rejects oversized or inconsistent fragments', () => {
      const r = rig(2);
      r.net.link('n0', 'n1');
      r.net.run(1000);
      const [a, b] = r.nodes as [ChaxNode, ChaxNode];
      const seen: number[] = [];
      b.onTransfer((t) => seen.push(t.received / t.total));
      a.sendFile(photo(30_000));
      r.net.run(2000);
      expect(seen.length).toBeGreaterThan(1);
      expect(seen[seen.length - 1]).toBe(1);
      expect(() => a.sendFile(photo(3 * 1024 * 1024))).toThrow();
    });
  });

  describe('double ratchet', () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const dec = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null);
    const ad = new Uint8Array([1, 2, 3]);
    const pair = () => {
      const a = createIdentity();
      const b = createIdentity();
      return { a, b, sa: initiate(a.xPriv, b.xPub, 1), sb: accept({ priv: b.xPriv, pub: b.xPub }, a.xPub, 1) };
    };

    it('talks both ways, with replies changing keys every round trip', () => {
      const { sa, sb } = pair();
      expect(dec(ratchetDecrypt(sb, ratchetEncrypt(sa, enc('un'), ad, 1), ad, 1))).toBe('un');
      const k0 = toHex(sa.dhs.pub);
      expect(dec(ratchetDecrypt(sa, ratchetEncrypt(sb, enc('deux'), ad, 1), ad, 1))).toBe('deux');
      expect(toHex(sa.dhs.pub)).not.toBe(k0); // A's ratchet key moved when B's reply arrived
      expect(dec(ratchetDecrypt(sb, ratchetEncrypt(sa, enc('trois'), ad, 1), ad, 1))).toBe('trois');
    });

    it('survives lost and reordered messages', () => {
      const { sa, sb } = pair();
      const m = ['a', 'b', 'c', 'd'].map((t) => ratchetEncrypt(sa, enc(t), ad, 1));
      expect(dec(ratchetDecrypt(sb, m[3]!, ad, 1))).toBe('d'); // arrives first, 'b' and 'c' skipped
      expect(dec(ratchetDecrypt(sb, m[1]!, ad, 1))).toBe('b');
      expect(dec(ratchetDecrypt(sb, m[0]!, ad, 1))).toBe('a');
      expect(dec(ratchetDecrypt(sb, m[1]!, ad, 1))).toBeNull(); // a replay is not accepted twice
    });

    it('rejects tampering and a wrong context without breaking the session', () => {
      const { sa, sb } = pair();
      const m = ratchetEncrypt(sa, enc('secret'), ad, 1);
      const bad = m.slice();
      bad[bad.length - 1]! ^= 1;
      expect(ratchetDecrypt(sb, bad, ad, 1)).toBeNull();
      expect(ratchetDecrypt(sb, m, new Uint8Array([9]), 1)).toBeNull();
      expect(dec(ratchetDecrypt(sb, m, ad, 1))).toBe('secret');
    });

    it('forward secrecy: a stolen session state cannot read what was said before the last round trip', () => {
      const { sa, sb } = pair();
      const old = ratchetEncrypt(sa, enc('avant'), ad, 1);
      ratchetDecrypt(sb, old, ad, 1);
      ratchetDecrypt(sa, ratchetEncrypt(sb, enc('reponse'), ad, 1), ad, 1);
      ratchetDecrypt(sb, ratchetEncrypt(sa, enc('encore'), ad, 1), ad, 1);
      // the thief gets B's whole state now, and had recorded the old ciphertext
      const stolen = sessionFromJson(sessionToJson(sb));
      expect(ratchetDecrypt(stolen, old, ad, 1)).toBeNull();
    });

    it('round-trips through its JSON form', () => {
      const { sa, sb } = pair();
      ratchetDecrypt(sb, ratchetEncrypt(sa, enc('x'), ad, 1), ad, 1);
      const sb2 = sessionFromJson(JSON.parse(JSON.stringify(sessionToJson(sb))));
      expect(dec(ratchetDecrypt(sa, ratchetEncrypt(sb2, enc('retour'), ad, 1), ad, 1))).toBe('retour');
    });

    it('end to end: both sides start talking at once, then keep going, across a restart', () => {
      const r = rig(2);
      r.net.link('n0', 'n1');
      r.net.run(1000);
      const [a, b] = r.nodes as [ChaxNode, ChaxNode];
      a.sendDirect(b.peerId, 'de A');
      b.sendDirect(a.peerId, 'de B'); // crossed first messages
      r.net.run(1000);
      expect(r.inbox[1]!.map((m) => m.text)).toEqual(['de A']);
      expect(r.inbox[0]!.map((m) => m.text)).toEqual(['de B']);
      a.sendDirect(b.peerId, 'suite A');
      b.sendDirect(a.peerId, 'suite B');
      r.net.run(1000);
      expect(r.inbox[1]!.map((m) => m.text)).toEqual(['de A', 'suite A']);
      expect(r.inbox[0]!.map((m) => m.text)).toEqual(['de B', 'suite B']);

      // B restarts with its saved sessions
      const saved = JSON.parse(JSON.stringify(b.exportSessions()));
      const t = r.net.createTransport('n1b');
      const b2 = new ChaxNode({ transport: t, identity: b.identity, nickname: 'node1', clock: r.net, rng: r.net.rng });
      b2.loadSessions(saved);
      const box: ChatMessage[] = [];
      b2.onMessage((m) => box.push(m));
      r.net.unlink('n0', 'n1');
      r.net.link('n0', 'n1b');
      r.net.run(1500);
      a.sendDirect(b2.peerId, 'apres redemarrage');
      r.net.run(1000);
      expect(box.map((m) => m.text)).toEqual(['apres redemarrage']);
    });

    it('relays only ever see ciphertext that differs for every message', () => {
      const r = rig(3);
      chain(r);
      r.net.run(1000);
      const [a, b, c] = r.nodes as [ChaxNode, ChaxNode, ChaxNode];
      r.net.unlink('n1', 'n2');
      a.sendDirect(c.peerId, 'meme texte');
      a.sendDirect(c.peerId, 'meme texte');
      r.net.run(500);
      const carried = b.store.all(r.net.now()).filter((p) => p.type === PacketType.MSG);
      expect(carried).toHaveLength(2);
      expect(toHex(carried[0]!.payload)).not.toBe(toHex(carried[1]!.payload));
      expect(carried[0]!.flags & Flags.RATCHET).toBeTruthy();
    });
  });
});
