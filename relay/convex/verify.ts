// How /register (http.ts) tells a real Threadbear backend from someone
// scripting it. Plain TypeScript with no Convex imports, so the runner's
// unit tests can check it.
//
// Every caller used to share one allowance of new installs a day, so one
// script could use it up and lock out every new backend. A backend from
// 5 Nov 2026 names its own deployment and a nonce, and the relay posts
// the nonce back to that deployment's /relay/verify (convex/http.ts),
// which only says yes to a nonce it made itself. That proves the caller
// runs the deployment, so it gets one install per deployment and no shared
// allowance to use up. Callers can't be told apart by address instead:
// every backend calls from Convex's own servers. There's no unchecked way
// in any more (http.ts says why).

// A Convex cloud deployment's HTTP address, `https://<name>.convex.site`
// or `https://<name>.<region>.convex.site`, as its CONVEX_SITE_URL says
// it. Anything else (a self-hosted backend, a custom domain) is null and
// can't register: the relay only ever calls back to Convex's own hosts,
// so it can't be pointed at anything else. Self-hosting? Run your own
// relay (docs/push-relay.md).
export function convexSite(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)?\.convex\.site$/.test(u.hostname)) return null;
  return `https://${u.hostname}`;
}

export const VERIFY_TIMEOUT_MS = 5_000;
// A yes is `{"ok":true}`; anything much longer isn't one.
const MAX_ANSWER_BYTES = 1_024;

// Whether the deployment says the nonce is its own: a 200 with
// `{ ok: true }` from its /relay/verify. A timeout, an error or any other
// answer is a no.
//
// Never follows a redirect (Daybreak 140, 16 Nov 2026): convexSite only
// checks the first address, and anyone can make a convex.site deployment
// answer 307 to somewhere else, which fetch would follow with the POST and
// its body, turning the relay into a way to post at hosts it should never
// call. `redirect: 'error'` makes Convex's fetch throw on any 3xx (checked
// on the relay's dev deployment: "fetch attempted redirect"), and the
// answer must still say it came from the address asked, in case a runtime
// ignores that option. Any other relay fetch whose address comes from a
// caller must do the same.
export async function deploymentVouches(site: string, nonce: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const url = `${site}/relay/verify`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce }), redirect: 'error', signal: abort.signal });
    if (res.redirected || res.url !== url || res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return false;
    }
    const text = await boundedText(res, MAX_ANSWER_BYTES);
    if (text === null) return false;
    const b = JSON.parse(text) as { ok?: unknown } | null;
    return b?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// The body as text, or null past `max` bytes (stops reading there).
async function boundedText(res: Response, max: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

// What /register (http.ts) does before it registers: the read-only check
// that a registration could succeed, then a call-back charged to the
// relay's budget first (relay.ts startCheck, which says why) and released
// once answered (endCheck, which also holds off a deployment that said no).
// Nothing is called back that wasn't charged. 'full': the deployment's or
// the day's registrations are used up; 'limited': the call-back budget is.
export type CheckDeps<Check> = {
  mayRegister: () => Promise<boolean>;
  startCheck: () => Promise<{ check: Check } | 'limited'>;
  endCheck: (check: Check, vouched: boolean) => Promise<unknown>;
  vouches: () => Promise<boolean>;
};
export async function checkRegistration<Check>(deps: CheckDeps<Check>): Promise<'full' | 'limited' | 'no' | 'yes'> {
  if (!(await deps.mayRegister())) return 'full';
  const started = await deps.startCheck();
  if (started === 'limited') return 'limited';
  let vouched = false;
  try {
    vouched = await deps.vouches();
  } finally {
    // If this fails, the check stops counting after CHECK_LEASE_MS anyway.
    await deps.endCheck(started.check, vouched).catch(() => {});
  }
  return vouched ? 'yes' : 'no';
}
