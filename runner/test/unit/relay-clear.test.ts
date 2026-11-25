// Codex Security, 22 Nov 2026 (finding 169): the push relay's /clear (the
// silent push that takes a thread's notifications down) was admitted like a
// send, which charges the install's bad-token allowance up front, but didn't
// hand its install and hour to counted, so even a clear that went through
// never gave the charge back. A backend's phones then lost every push for
// the rest of the UTC hour after 20 clears, and a scoped extra runner can
// make clears at will by flipping needsYou on its own threads. These call
// relay/convex/http.ts's real /clear and /send handlers, with Apple and
// Firebase faked, against relay/convex/relay.ts on an in-memory database.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, RELAY } from '../helpers/convex-memory.ts';

const relay = load('relay', RELAY);
const http = load('http', RELAY).__default as { routes: { path: string; method: string; handler: (ctx: unknown, req: Request) => Promise<Response> }[] };
const { BAD_TOKEN_SENDS_PER_HOUR, NEW_INSTALL_MS } = relay;

const T0 = Date.parse('2026-11-22T01:00:00Z');
let clock = T0;
mock.method(Date, 'now', () => clock);
afterEach(() => (clock = T0));

type Answer = { status: number; reason?: string };

// An action ctx for http.ts: its mutations run on the in-memory relay, and
// Apple's (or Firebase's) answer to each send or clear is `answer`.
function relayHttp() {
  const b = memoryBackend(RELAY);
  let answer: Answer = { status: 200 };
  const actx = {
    runMutation: (fn: unknown, args: Record<string, unknown>) => {
      const name = String(fn).split('.').at(-1)!;
      assert.ok(String(fn).startsWith('internal.relay.') && relay[name], `unexpected mutation ${String(fn)}`);
      return call(b.ctx, relay[name], args);
    },
    runAction: async (fn: unknown) => {
      assert.match(String(fn), /^internal\.(apns|fcm)\.(send|clear)$/);
      return answer;
    },
  };
  const post = async (path: '/send' | '/clear', i: { installId: string; installKey: string }) => {
    const route = http.routes.find((r) => r.path === path && r.method === 'POST')!;
    const req = new Request(`https://relay.example${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${i.installId}.${i.installKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken: 'ab12', environment: 'production', threadId: 't1' }),
    });
    return (await route.handler(actx, req)).status;
  };
  const hourBad = (installId: string) => b.rows('installs').find((r) => r.installId === installId)?.hourBad ?? 0;
  return { b, post, hourBad, answer: (a: Answer) => (answer = a) };
}

async function install(r: ReturnType<typeof relayHttp>) {
  const i = await call(r.b.ctx, relay.registerVerified, { deployment: 'https://made-up-1.convex.site' });
  clock = T0 + NEW_INSTALL_MS + 1;
  return i as { installId: string; installKey: string };
}

test('a clear that went through gives back its bad-token charge', async () => {
  const r = relayHttp();
  const i = await install(r);
  // One bad token's charge already this hour, so a reset would show too.
  r.answer({ status: 400, reason: 'BadDeviceToken' });
  await r.post('/clear', i);
  const before = r.hourBad(i.installId);
  assert.equal(before, 1);
  r.answer({ status: 200 });
  assert.equal(await r.post('/clear', i), 200);
  assert.equal(r.hourBad(i.installId), before);
});

test("a clear that failed for the relay's own reasons gives back its charge", async () => {
  const r = relayHttp();
  const i = await install(r);
  for (const a of [{ status: 403, reason: 'InvalidProviderToken' }, { status: 0, reason: 'send threw' }, { status: 429, reason: 'TooManyRequests' }]) {
    r.answer(a);
    await r.post('/clear', i);
    assert.equal(r.hourBad(i.installId), 0, a.reason);
  }
});

test('a clear to a bad device token stays charged', async () => {
  const r = relayHttp();
  const i = await install(r);
  r.answer({ status: 400, reason: 'BadDeviceToken' });
  await r.post('/clear', i);
  assert.equal(r.hourBad(i.installId), 1);
  r.answer({ status: 410, reason: 'Unregistered' });
  await r.post('/clear', i);
  assert.equal(r.hourBad(i.installId), 2);
});

test('many clears that went through never stop the sends after them', async () => {
  const r = relayHttp();
  const i = await install(r);
  for (let k = 0; k < BAD_TOKEN_SENDS_PER_HOUR * 3; k++) assert.equal(await r.post('/clear', i), 200, `clear ${k}`);
  assert.equal(await r.post('/send', i), 200, 'a real notification still goes');
});
