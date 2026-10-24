// Dumb frame relay for ChaX: every connected client is a link-level neighbour of every other.
// It never reads packets: frames are opaque, already signed and (for direct messages) encrypted.
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const MAX_FRAME_BYTES = 128 * 1024;

const http = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`Relais ChaX actif (${clients.size} connecté(s)).
Ce port est réservé aux clients WebSocket.
Ouvrez le chat : http://localhost:5174/?relay
`);
});
const wss = new WebSocketServer({ server: http, maxPayload: MAX_FRAME_BYTES });
http.listen(port, host);
const clients = new Map(); // link id -> socket

function sendAll(msg, exceptId) {
  const text = JSON.stringify(msg);
  for (const [id, ws] of clients) if (id !== exceptId && ws.readyState === ws.OPEN) ws.send(text);
}

wss.on('connection', (ws) => {
  let id;

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof m?.from !== 'string' || m.from.length > 32) return;
    if (!id) {
      id = m.from;
      clients.get(id)?.close(); // same id reconnecting
      clients.set(id, ws);
      console.log(`+ ${id} (${clients.size} connected)`);
    }
    if (m.from !== id) return; // no spoofing another link
    if (m.t === 'hello' || m.t === 'bye') sendAll(m, id);
    else if (m.t === 'frame' && typeof m.to === 'string') {
      const dst = clients.get(m.to);
      if (dst?.readyState === dst.OPEN) dst.send(JSON.stringify(m));
    }
  });

  ws.on('close', () => {
    if (id && clients.get(id) === ws) {
      clients.delete(id);
      sendAll({ t: 'bye', from: id });
      console.log(`- ${id} (${clients.size} connected)`);
    }
  });
  ws.on('error', () => {});
});

console.log(`ChaX relay on ws://${host}:${port}`);
