import type { BleBridge } from '../../core/src';

interface WebView {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', cb: (e: { data: any }) => void): void;
}

/** The WebView2 host the Windows app wraps this page in, if any (it sets __chaxHost before the page loads). */
export const windowsHost = (): WebView | undefined =>
  (window as unknown as { __chaxHost?: string }).__chaxHost === 'windows'
    ? (window as unknown as { chrome?: { webview?: WebView } }).chrome?.webview
    : undefined;

const toB64 = (b: Uint8Array) => {
  let t = '';
  for (const x of b) t += String.fromCharCode(x);
  return btoa(t);
};
const fromB64 = (t: string) => Uint8Array.from(atob(t), (c) => c.charCodeAt(0));

/** Bluetooth through the Windows host: same bridge as the phones, carried by WebView2 messages. */
export function windowsBridge(host: WebView): BleBridge {
  let up: (l: string) => void = () => undefined;
  let down: (l: string) => void = () => undefined;
  let frame: (l: string, b: Uint8Array) => void = () => undefined;
  let error: (m: string) => void = () => undefined;
  host.addEventListener('message', (e) => {
    const m = e.data;
    if (m.t === 'up') up(m.link);
    else if (m.t === 'down') down(m.link);
    else if (m.t === 'frame') frame(m.link, fromB64(m.data));
    else if (m.t === 'error' || m.t === 'state') error(m.message ?? ''); // an empty message means all is well
  });
  return {
    start: async (nodeId) => host.postMessage({ t: 'start', id: nodeId }),
    stop: async () => host.postMessage({ t: 'stop' }),
    send: async (link, bytes) => host.postMessage({ t: 'send', link, data: toB64(bytes) }),
    onLinkUp: (cb) => (up = cb),
    onLinkDown: (cb) => (down = cb),
    onFrame: (cb) => (frame = cb),
    onError: (cb) => (error = cb),
  };
}
