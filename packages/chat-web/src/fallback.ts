import type { NostrTransport } from '../../core/src';

/**
 * Bluetooth first. In "auto" the internet fallback (Nostr relays) is switched on when no Bluetooth peer has been
 * around for a while, and switched off again once peers have been in range for a good minute and nobody depends
 * on the relays any more. "on" and "off" are the user's override.
 */
export type NetMode = 'auto' | 'on' | 'off';

const TICK_MS = 5_000;
const GRACE_MS = 30_000; // no peer in range for this long before the relays come on
const STABLE_MS = 60_000; // peers in range for this long before the relays go off again

export interface FallbackSource {
  mode(): NetMode;
  /** Neighbours reached by radio right now. */
  range(): number;
  /** Neighbours reachable only through the relays right now. */
  viaNetOnly(): number;
}

/** Returns a function that stops the controller. */
export function runFallback(net: NostrTransport, src: FallbackSource): () => void {
  const t0 = Date.now();
  let noRangeSince = t0;
  let rangeSince = 0;
  let owned = false; // the controller, not the user, switched the relays on
  let lastMode: NetMode | undefined;

  const tick = () => {
    const now = Date.now();
    const mode = src.mode();
    if (mode !== lastMode) {
      // leaving a manual mode while the relays are on: the controller takes over and may switch them off later
      owned = mode === 'auto' && net.running;
      lastMode = mode;
    }
    if (mode === 'on') {
      if (!net.running) net.start();
      return;
    }
    if (mode === 'off') {
      if (net.running) net.stop();
      return;
    }
    if (src.range() === 0) {
      rangeSince = 0;
      if (!noRangeSince) noRangeSince = now;
      if (!net.running && now - noRangeSince >= GRACE_MS) {
        net.start();
        owned = true;
      }
    } else {
      noRangeSince = 0;
      if (!rangeSince) rangeSince = now;
      if (net.running && owned && now - rangeSince >= STABLE_MS && src.viaNetOnly() === 0) {
        net.stop();
        owned = false;
      }
    }
  };

  // no tick before the first interval: the caller may still be setting its node up
  const id = setInterval(tick, TICK_MS);
  return () => clearInterval(id);
}
