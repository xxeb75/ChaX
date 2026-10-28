import { load, save } from './store';

declare const __APP_VERSION__: string;

/**
 * Update check against the public GitHub releases of the project. It is the only place the app talks to a server
 * that is not a mesh peer, so it is automatic at most once a day, can be switched off, and a plain "no" on any
 * failure: a missing network must never look like an error.
 */
export const REPO = 'xxeb75/ChaX';
export const VERSION = __APP_VERSION__;
const DAY_MS = 6 * 3600 * 1000; // a new build should reach testers the same day

export interface Update {
  version: string;
  url: string;
}

interface State {
  auto: boolean;
  at: number;
  found?: Update;
}

const state = (): State => {
  const s = load<Partial<State>>('chax.update');
  return { auto: s?.auto !== false, at: s?.at ?? 0, found: s?.found };
};

export const autoCheck = (): boolean => state().auto;
export function setAutoCheck(on: boolean): void {
  save('chax.update', { ...state(), auto: on });
}

/** 1 if a is newer than b, -1 if older, 0 if equal. Pre-release suffixes are ignored. */
export function compare(a: string, b: string): number {
  const n = (v: string) => (v.replace(/^v/, '').split('-')[0] ?? '').split('.').map((x) => parseInt(x, 10) || 0);
  const x = n(a);
  const y = n(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Asks GitHub for the latest release. Resolves to the update if it is newer than this build, else undefined. */
let failed = false;
/** True when the last check could not reach GitHub, as opposed to finding nothing newer. */
export const checkFailed = (): boolean => failed;

export async function check(): Promise<Update | undefined> {
  failed = false;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(String(r.status));
    const rel = (await r.json()) as { tag_name?: string; html_url?: string; assets?: { name: string; browser_download_url: string }[] };
    const version = String(rel.tag_name ?? '').replace(/^v/, '');
    const apk = rel.assets?.find((a) => a.name.endsWith('.apk'));
    const found = version && compare(version, VERSION) > 0 ? { version, url: apk?.browser_download_url ?? rel.html_url ?? '' } : undefined;
    save('chax.update', { ...state(), at: Date.now(), found });
    return found?.url.startsWith('https://') ? found : undefined;
  } catch {
    failed = true;
    return undefined;
  }
}

/** Launch-time check: at most one request a day, and none if the user turned it off. Falls back to the last answer. */
export async function checkOnLaunch(): Promise<Update | undefined> {
  const s = state();
  const cached = s.found && compare(s.found.version, VERSION) > 0 ? s.found : undefined;
  if (!s.auto || Date.now() - s.at < DAY_MS) return cached;
  return check();
}
