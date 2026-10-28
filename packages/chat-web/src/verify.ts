import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';

/**
 * Face-to-face verification. The QR code carries a peer id, which is the hash of that person's signing key:
 * announcements are only accepted when they match it, so scanning the code in person pins "this key is Marc".
 */

export interface Trusted {
  name: string;
  at: number;
  /** Accepted without scanning their code: allowed to write, but not proven to be who they claim. */
  accepted?: boolean;
}

const ID_HEX = /^[0-9a-f]{16}$/;

export const encodeCode = (peerId: string, nick: string): string => `chax:1:${peerId}:${encodeURIComponent(nick)}`;

export function parseCode(raw: string): { peerId: string; name: string } | undefined {
  const m = /^chax:1:([0-9a-f]{16}):(.*)$/.exec(raw.trim());
  if (!m || !ID_HEX.test(m[1]!)) return undefined;
  try {
    return { peerId: m[1]!, name: decodeURIComponent(m[2]!).slice(0, 24) };
  } catch {
    return undefined;
  }
}

const SVG = 'http://www.w3.org/2000/svg';

/** Dark modules on an ivory block: the contrast every scanner expects. */
export function qrElement(text: string): SVGSVGElement {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n + quiet * 2} ${n + quiet * 2}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Code de vérification à faire scanner');
  const bg = document.createElementNS(SVG, 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', '#f1efe9');
  svg.append(bg);
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  const p = document.createElementNS(SVG, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', '#0a0a0c');
  svg.append(p);
  return svg;
}

/** Reads QR codes from the camera until stopped. Rejects when there is no camera or no permission. */
export async function scanCamera(video: HTMLVideoElement, onText: (t: string) => void): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('caméra indisponible');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  video.srcObject = stream;
  video.setAttribute('playsinline', 'true');
  await video.play();
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  let live = true;
  const tick = () => {
    if (!live) return;
    if (video.videoWidth) {
      const k = Math.min(1, 480 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * k);
      canvas.height = Math.round(video.videoHeight * k);
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = g.getImageData(0, 0, canvas.width, canvas.height);
      const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      if (hit?.data) onText(hit.data);
    }
    setTimeout(tick, 150);
  };
  tick();
  return () => {
    live = false;
    stream.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  };
}
