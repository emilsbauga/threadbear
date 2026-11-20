// Daybreak 140 (16 Nov 2026): the push relay's registration check
// (relay/convex/verify.ts deploymentVouches) posts a nonce back to the
// convex.site deployment a caller names. Only that first address was
// checked, and fetch follows redirects by default, so any deployment could
// answer 302/307/308 and have the relay post on to a host of its choosing
// (loopback, link-local, a private address), with the body for a 307 or 308.
// The check must send nothing past the first answer, and trust a yes only
// from the address it asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { deploymentVouches } from '../../../relay/convex/verify.ts';

const SITE = 'https://evil-otter-123.convex.site';
const VERIFY = `${SITE}/relay/verify`;

// On '::' (both v4 and v6), so a redirect to [::1] reaches it too.
async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '::', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// A stand-in for the attacker's deployment, answering `status` with a
// Location of `target`, and a trap that says yes to anything reaching it.
async function redirector(status: number, target: (trap: string) => string) {
  const hits: { method: string; path: string; body: string }[] = [];
  const trapServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', path: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  const trap = await listen(trapServer);
  const first = http.createServer((req, res) => {
    req.resume();
    res.writeHead(status, { location: target(trap) }).end();
  });
  const from = await listen(first);
  // Real fetch, with the convex.site address the relay checked swapped for
  // the local stand-in (the relay can't be pointed at 127.0.0.1 itself).
  const fetcher = ((url: string, init?: RequestInit) => fetch(url.replace(SITE, from), init)) as typeof fetch;
  return { fetcher, hits, close: () => Promise.all([first, trapServer].map((s) => new Promise((r) => (s.closeAllConnections(), s.close(r))))) };
}

for (const status of [301, 302, 303, 307, 308]) {
  test(`a ${status} from the deployment is a no, and nothing is sent on`, async () => {
    const r = await redirector(status, (trap) => `${trap}/internal-admin`);
    try {
      assert.equal(await deploymentVouches(SITE, 'n1', r.fetcher), false);
      assert.deepEqual(r.hits, [], 'the relay posted to the redirect target');
    } finally {
      await r.close();
    }
  });
}

// The targets the write-up names. Loopback (v4 and v6) and one with
// credentials in it reach a real trap here, so following would show.
for (const where of [(trap: string) => `${trap}/x`, (trap: string) => trap.replace('127.0.0.1', '[::1]') + '/x', (trap: string) => trap.replace('http://', 'http://user:pass@') + '/x']) {
  test(`a redirect to ${where('http://127.0.0.1:N')} reaches nothing`, async () => {
    const r = await redirector(307, where);
    try {
      assert.equal(await deploymentVouches(SITE, 'n1', r.fetcher), false);
      assert.deepEqual(r.hits, []);
    } finally {
      await r.close();
    }
  });
}

test('the check asks fetch not to follow redirects', async () => {
  let seen: RequestInit | undefined;
  await deploymentVouches(SITE, 'n1', (async (_url: string, init?: RequestInit) => ((seen = init), new Response('{}', { status: 404 }))) as typeof fetch);
  assert.equal(seen?.redirect, 'error');
});

// In case a runtime ignores `redirect`: a yes is believed only from the
// address the relay asked, not from wherever fetch ended up.
function answered(body: string, url: string, redirected: boolean): Response {
  const res = new Response(body, { status: 200 });
  Object.defineProperty(res, 'url', { value: url });
  Object.defineProperty(res, 'redirected', { value: redirected });
  return res;
}

// Link-local (cloud metadata) and private addresses can't be served here,
// so a runtime that followed anyway is played: its yes from there is a no.
for (const where of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://[fd00::1]/', 'http://[fe80::1]/']) {
  test(`a yes from ${where}, after a redirect the runtime followed, is a no`, async () => {
    assert.equal(await deploymentVouches(SITE, 'n1', (async () => answered('{"ok":true}', where, true)) as typeof fetch), false);
  });
}

test('a yes that came from anywhere but the deployment asked is a no', async () => {
  const yes = '{"ok":true}';
  const from = (url: string, redirected: boolean) => (async () => answered(yes, url, redirected)) as typeof fetch;
  assert.equal(await deploymentVouches(SITE, 'n1', from(VERIFY, false)), true);
  assert.equal(await deploymentVouches(SITE, 'n1', from('http://127.0.0.1/relay/verify', true)), false);
  assert.equal(await deploymentVouches(SITE, 'n1', from('https://other-otter-2.convex.site/relay/verify', true)), false);
  assert.equal(await deploymentVouches(SITE, 'n1', from(VERIFY, true)), false, 'redirected back to itself');
  assert.equal(await deploymentVouches(SITE, 'n1', from('http://127.0.0.1/relay/verify', false)), false);
  assert.equal(await deploymentVouches(SITE, 'n1', from('', false)), false, 'no address at all');
});

test('a long answer is a no, read no further than a small cap', async () => {
  const long = JSON.stringify({ ok: true, pad: 'x'.repeat(5_000) });
  assert.equal(await deploymentVouches(SITE, 'n1', (async () => answered(long, VERIFY, false)) as typeof fetch), false);
});
