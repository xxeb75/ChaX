import { ChaxNode, PacketType, SimNetwork, decode, Flags, type ChatMessage } from '../../core/src';

interface Vis {
  id: string;
  node: ChaxNode;
  x: number;
  y: number;
  flash: number; // ms of remaining delivery flash
}

interface Pulse {
  from: Vis;
  to: Vis;
  color: string;
  lost: boolean;
  t: number; // 0..1
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cv = $<HTMLCanvasElement>('cv');
const ctx = cv.getContext('2d')!;

const net = new SimNetwork({ seed: 42, latencyMs: 60 });
const vis: Vis[] = [];
const pulses: Pulse[] = [];
let selected: Vis | undefined;
let dragging: Vis | undefined;
let range = 240;

const NAMES = ['Ada', 'Bob', 'Cleo', 'Dan', 'Eve', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kim', 'Lou', 'Max', 'Noa'];

function log(html: string): void {
  const el = document.createElement('div');
  el.innerHTML = html;
  $('log').prepend(el);
  while ($('log').children.length > 60) $('log').lastChild?.remove();
}

function addNode(x?: number, y?: number): Vis {
  const i = vis.length;
  const id = `n${i}`;
  const node = new ChaxNode({
    transport: net.createTransport(id),
    nickname: NAMES[i % NAMES.length]! + (i >= NAMES.length ? i : ''),
    clock: net,
    rng: net.rng,
  });
  const v: Vis = {
    id,
    node,
    x: x ?? 80 + Math.random() * (cv.clientWidth - 160),
    y: y ?? 80 + Math.random() * (cv.clientHeight - 160),
    flash: 0,
  };
  node.onMessage((m: ChatMessage) => {
    v.flash = 900;
    const kind = m.alert ? '⚠ alerte' : m.direct ? '🔒 privé' : 'message';
    log(`<b>${node.nickname}</b> ← ${m.nickname ?? m.from.slice(0, 6)} · ${kind} : ${escapeHtml(m.text)}`);
  });
  vis.push(v);
  refreshTargets();
  return v;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function byId(id: string): Vis | undefined {
  return vis.find((v) => v.id === id);
}

net.onFrame = (from, to, bytes, lost) => {
  const a = byId(from);
  const b = byId(to);
  if (!a || !b) return;
  let color = '#8b93a5';
  try {
    const p = decode(bytes);
    if (p.type === PacketType.MSG) color = p.flags & Flags.ENCRYPTED ? '#9b7bff' : '#4ea1ff';
    else if (p.type === PacketType.ALERT) color = '#ffb84e';
    else if (p.type === PacketType.ANNOUNCE) color = '#5fd38d';
  } catch {
    /* keep default */
  }
  if (pulses.length < 400) pulses.push({ from: a, to: b, color, lost, t: 0 });
};

function updateLinks(): void {
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i]!;
      const b = vis[j]!;
      const near = Math.hypot(a.x - b.x, a.y - b.y) <= range;
      const linked = net.isLinked(a.id, b.id);
      if (near && !linked) net.link(a.id, b.id);
      else if (!near && linked) net.unlink(a.id, b.id);
    }
  }
}

function layout(): void {
  for (const v of vis) {
    v.x = 80 + Math.random() * Math.max(10, cv.clientWidth - 160);
    v.y = 80 + Math.random() * Math.max(10, cv.clientHeight - 160);
  }
}

function refreshTargets(): void {
  const sel = $<HTMLSelectElement>('target');
  const cur = sel.value;
  sel.innerHTML = '';
  for (const v of vis) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = v.node.nickname;
    sel.append(o);
  }
  sel.value = cur;
  updateSel();
}

function updateSel(): void {
  $('sel').textContent = selected ? selected.node.nickname : '—';
  for (const id of ['bcast', 'alert', 'dm']) ($(id) as HTMLButtonElement).disabled = !selected;
}

// ---- controls ---------------------------------------------------------

$<HTMLInputElement>('range').oninput = (e) => (range = +(e.target as HTMLInputElement).value);
$<HTMLInputElement>('loss').oninput = (e) => {
  const v = +(e.target as HTMLInputElement).value;
  net.loss = v / 100;
  $('lossV').textContent = `${v}%`;
};
let speed = 4;
$<HTMLInputElement>('speed').oninput = (e) => {
  speed = +(e.target as HTMLInputElement).value;
  $('speedV').textContent = `×${speed}`;
};
$('shuffle').onclick = layout;
$('addNode').onclick = () => addNode();
$('bcast').onclick = () => selected?.node.sendBroadcast($<HTMLInputElement>('text').value);
$('alert').onclick = () => selected?.node.sendAlert($<HTMLInputElement>('text').value);
$('dm').onclick = () => {
  const t = byId($<HTMLSelectElement>('target').value);
  if (!selected || !t || t === selected) return;
  try {
    selected.node.sendDirect(t.node.peerId, $<HTMLInputElement>('text').value);
    log(`<b>${selected.node.nickname}</b> → ${t.node.nickname} · privé envoyé`);
  } catch {
    log(`<b>${selected.node.nickname}</b> ne connaît pas encore la clé de ${t.node.nickname} (jamais croisé)`);
  }
};

// ---- pointer ----------------------------------------------------------

function pick(ev: PointerEvent): Vis | undefined {
  const r = cv.getBoundingClientRect();
  const x = ev.clientX - r.left;
  const y = ev.clientY - r.top;
  return vis.find((v) => Math.hypot(v.x - x, v.y - y) < 16);
}
cv.onpointerdown = (ev) => {
  const v = pick(ev);
  if (v) {
    dragging = v;
    selected = v;
    updateSel();
    cv.setPointerCapture(ev.pointerId);
  }
};
cv.onpointermove = (ev) => {
  if (!dragging) return;
  const r = cv.getBoundingClientRect();
  dragging.x = Math.min(r.width - 10, Math.max(10, ev.clientX - r.left));
  dragging.y = Math.min(r.height - 10, Math.max(10, ev.clientY - r.top));
};
cv.onpointerup = () => (dragging = undefined);

// ---- render loop ------------------------------------------------------

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  cv.width = cv.clientWidth * dpr;
  cv.height = cv.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.onresize = resize;

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(50, now - last);
  last = now;
  updateLinks();
  net.run(dt * speed);
  draw(dt);
  requestAnimationFrame(frame);
}

function draw(dt: number): void {
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  ctx.clearRect(0, 0, w, h);

  // links
  ctx.lineWidth = 1;
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i]!;
      const b = vis[j]!;
      if (!net.isLinked(a.id, b.id)) continue;
      ctx.strokeStyle = 'rgba(139,147,165,.35)';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // selected range
  if (selected) {
    ctx.strokeStyle = 'rgba(78,161,255,.35)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(selected.x, selected.y, range, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // pulses (animation speed follows the sim speed, 60 ms of sim latency)
  const step = (dt * speed) / 60;
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i]!;
    p.t += step;
    if (p.t >= 1) {
      pulses.splice(i, 1);
      continue;
    }
    const t = p.lost ? Math.min(p.t, 0.6) : p.t;
    const x = p.from.x + (p.to.x - p.from.x) * t;
    const y = p.from.y + (p.to.y - p.from.y) * t;
    ctx.fillStyle = p.lost ? '#ff5d5d' : p.color;
    ctx.globalAlpha = p.lost ? 1 - p.t : 1;
    ctx.beginPath();
    ctx.arc(x, y, p.lost ? 3 : 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // nodes
  for (const v of vis) {
    v.flash = Math.max(0, v.flash - dt * speed);
    const carried = v.node.store.all(net.now()).filter((p) => p.type !== PacketType.ANNOUNCE).length;
    if (carried > 0) {
      ctx.strokeStyle = '#ffd24e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(v.x, v.y, 17, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = v.flash > 0 ? '#5fd38d' : v === selected ? '#4ea1ff' : '#2d3548';
    ctx.strokeStyle = v === selected ? '#9fd0ff' : '#586178';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(v.x, v.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e6e9ef';
    ctx.font = '12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText(v.node.nickname, v.x, v.y - 22);
    if (carried > 0) {
      ctx.fillStyle = '#ffd24e';
      ctx.fillText(String(carried), v.x, v.y + 4);
    }
  }
}

function init(): void {
  resize();
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  for (let i = 0; i < 7; i++) {
    addNode(W * (0.15 + 0.12 * i), H * (0.3 + 0.4 * (((i * 37) % 10) / 10)));
  }
  selected = vis[0];
  updateSel();
  last = performance.now();
  requestAnimationFrame(frame);
}
// wait until the stage has its real size, then keep the canvas in sync with it
let started = false;
new ResizeObserver(() => {
  if (!cv.clientWidth || !cv.clientHeight) return;
  if (!started) {
    started = true;
    init();
  } else {
    resize();
  }
}).observe($('stage'));
