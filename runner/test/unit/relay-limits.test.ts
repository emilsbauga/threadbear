// Daybreak 144 (16 Nov 2026): the push relay's limits were all per
// deployment or per install, and anyone can make Convex deployments that
// pass the registration check (relay/convex/verify.ts), so each made-up
// deployment was another install, another 120 sends an hour and another row
// kept for ever. These play that against relay/convex/relay.ts on an
// in-memory database checked against relay/convex/schema.ts.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome, RELAY } from '../helpers/convex-memory.ts';

const relay = load('relay', RELAY);
const { ALL_SENDS_PER_HOUR, RESERVED_SENDS_PER_HOUR, NEW_INSTALLS_PER_DAY, NEW_INSTALL_MS, NEW_INSTALL_SENDS_PER_HOUR, SENDS_PER_HOUR, BAD_TOKEN_SENDS_PER_HOUR, IDLE_INSTALL_MS, EXPIRED_KEEP_MS, EXPIRE_BATCH } = relay;

const T0 = Date.parse('2026-11-16T01:00:00Z');
let clock = T0;
mock.method(Date, 'now', () => clock);
afterEach(() => (clock = T0));

const site = (n: number) => `https://made-up-${n}.convex.site`;
const register = (ctx: unknown, deployment: string) => call(ctx, relay.registerVerified, { deployment });
// 'ok' for an admitted send, whose hour counted then gets (as /send does).
const lastHour = new Map<string, string>();
async function admit(ctx: unknown, i: { installId: string; installKey: string }): Promise<string> {
  const r = await call(ctx, relay.admit, { installId: i.installId, installKey: i.installKey });
  if (typeof r !== 'object') return r;
  lastHour.set(i.installId, r.hour);
  return 'ok';
}
const count = (ctx: unknown, a: { ok: boolean; status?: number; reason?: string; installId: string; hour?: string }) => call(ctx, relay.counted, { ...a, hour: a.hour ?? lastHour.get(a.installId) });
// A send that Apple or Firebase took: admitted, then its outcome counted.
async function send(ctx: unknown, i: { installId: string; installKey: string }): Promise<string> {
  const a = await admit(ctx, i);
  if (a === 'ok') await count(ctx, { ok: true, status: 200, installId: i.installId });
  return a;
}

test('made-up deployments get only so many new installs a day, relay-wide', async () => {
  const b = memoryBackend(RELAY);
  for (let n = 0; n < NEW_INSTALLS_PER_DAY; n++) await register(b.ctx, site(n));
  assert.equal(await outcome(register(b.ctx, site(NEW_INSTALLS_PER_DAY))), 'busy');
  assert.equal(b.rows('installs').length, NEW_INSTALLS_PER_DAY);
  // The next UTC day there's room again.
  clock = T0 + 86_400_000;
  assert.equal(await outcome(register(b.ctx, site(NEW_INSTALLS_PER_DAY))), 'ok');
});

test('an existing install can always register again, whatever the cap says', async () => {
  const b = memoryBackend(RELAY);
  const mine = await register(b.ctx, 'https://real-backend-1.convex.site');
  for (let n = 0; n < NEW_INSTALLS_PER_DAY - 1; n++) await register(b.ctx, site(n));
  assert.equal(await outcome(register(b.ctx, site(999))), 'busy');
  const again = await register(b.ctx, 'https://real-backend-1.convex.site');
  assert.equal(again.installId, mine.installId);
  assert.equal(await admit(b.ctx, again), 'ok');
  assert.equal(await admit(b.ctx, mine), 'auth', 'the old key stops working');
});

test('young installs share one hourly pool; an established one keeps its own allowance', async () => {
  const b = memoryBackend(RELAY);
  const old = await register(b.ctx, 'https://real-backend-1.convex.site');
  clock = T0 + NEW_INSTALL_MS + 3_600_000;
  const young = [];
  const needed = Math.ceil(NEW_INSTALL_SENDS_PER_HOUR / SENDS_PER_HOUR) + 2;
  for (let n = 0; n < needed; n++) young.push(await register(b.ctx, site(n)));
  let admitted = 0;
  for (const i of young) for (let k = 0; k < SENDS_PER_HOUR; k++) if ((await send(b.ctx, i)) === 'ok') admitted++;
  // The pool, then only the reserved few of each install that hadn't had them.
  assert.ok(admitted >= NEW_INSTALL_SENDS_PER_HOUR && admitted <= NEW_INSTALL_SENDS_PER_HOUR + needed * RESERVED_SENDS_PER_HOUR, `${admitted}`);
  assert.ok(admitted < needed * SENDS_PER_HOUR, 'many young installs together get one pool, not one allowance each');
  for (let k = 0; k < SENDS_PER_HOUR; k++) assert.equal(await send(b.ctx, old), 'ok', `established send ${k}`);
  assert.equal(await send(b.ctx, old), 'limited');
  // The pool fills again the next hour.
  clock += 3_600_000;
  assert.equal(await send(b.ctx, young[0]!), 'ok');
});

test('installs a week old or more share a relay-wide ceiling, and past it each keeps a reserved few', async () => {
  const b = memoryBackend(RELAY);
  const mine = await register(b.ctx, 'https://real-backend-1.convex.site');
  const aged = [];
  const needed = Math.ceil(ALL_SENDS_PER_HOUR / SENDS_PER_HOUR) + 3;
  for (let n = 0; n < needed; n++) {
    clock = T0 + n * 86_400_000;
    aged.push(await register(b.ctx, site(n)));
  }
  clock = T0 + needed * 86_400_000 + NEW_INSTALL_MS;
  let admitted = 0;
  for (const i of aged) for (let k = 0; k < SENDS_PER_HOUR; k++) if ((await send(b.ctx, i)) === 'ok') admitted++;
  // Up to the ceiling, then each one left gets its reserved few.
  assert.ok(admitted <= ALL_SENDS_PER_HOUR + needed * RESERVED_SENDS_PER_HOUR, `${admitted}`);
  assert.ok(admitted < needed * SENDS_PER_HOUR, 'not one full allowance each');
  // A real backend that hadn't sent yet this hour still gets its reserved few.
  for (let k = 0; k < RESERVED_SENDS_PER_HOUR; k++) assert.equal(await send(b.ctx, mine), 'ok', `reserved send ${k}`);
  assert.equal(await send(b.ctx, mine), 'limited');
  clock += 3_600_000;
  assert.equal(await send(b.ctx, mine), 'ok');
});

test('an install sending to made-up device tokens is stopped after a few an hour', async () => {
  const b = memoryBackend(RELAY);
  const i = await register(b.ctx, site(1));
  clock = T0 + NEW_INSTALL_MS + 1;
  for (let k = 0; k < BAD_TOKEN_SENDS_PER_HOUR; k++) {
    assert.equal(await admit(b.ctx, i), 'ok');
    await count(b.ctx, { ok: false, status: k % 2 ? 400 : 410, reason: 'BadDeviceToken', installId: i.installId });
  }
  assert.equal(await admit(b.ctx, i), 'limited', 'no more calls to Apple or Firebase this hour');
  clock += 3_600_000;
  assert.equal(await admit(b.ctx, i), 'ok', 'a new hour, a new allowance');
});

test("the relay's own trouble (a revoked key, a timeout) doesn't use up a real backend's allowance", async () => {
  const b = memoryBackend(RELAY);
  const i = await register(b.ctx, site(1));
  clock = T0 + NEW_INSTALL_MS + 1;
  for (let k = 0; k < BAD_TOKEN_SENDS_PER_HOUR * 2; k++) {
    assert.equal(await admit(b.ctx, i), 'ok');
    await count(b.ctx, { ok: false, status: k % 2 ? 403 : 0, reason: 'InvalidProviderToken', installId: i.installId });
  }
  assert.equal(await admit(b.ctx, i), 'ok');
});

test('an install idle for 90 days is removed, its key stops working, and its backend can register again', async () => {
  const b = memoryBackend(RELAY);
  const idle = await register(b.ctx, site(1));
  const busy = await register(b.ctx, 'https://real-backend-1.convex.site');
  // A send while it's young leaves this hour's pool row, which goes too.
  assert.equal(await admit(b.ctx, idle), 'ok');
  clock = T0 + IDLE_INSTALL_MS - 86_400_000;
  assert.equal(await admit(b.ctx, busy), 'ok');
  clock = T0 + IDLE_INSTALL_MS + 1;
  assert.deepEqual(await call(b.ctx, relay.expire, {}), { installs: 1, removed: 0, hours: 1 });
  assert.equal(await admit(b.ctx, idle), 'auth');
  assert.equal(await admit(b.ctx, busy), 'ok');
  assert.equal((await call(b.ctx, relay.stats, {})).installs, 1, 'stats leaves the keyless row out');
  // Made-up deployments use up the day's new installs...
  for (let n = 100; n < 100 + NEW_INSTALLS_PER_DAY; n++) await register(b.ctx, site(n));
  assert.equal(await call(b.ctx, relay.mayRegister, { deployment: site(999) }), false);
  // ...but the expired backend is still known, so what convex/push.ts does
  // on that 401 (register again) works, as the same install, not a young one.
  assert.equal(await call(b.ctx, relay.mayRegister, { deployment: site(1) }), true);
  const back = await register(b.ctx, site(1));
  assert.equal(back.installId, idle.installId);
  assert.equal(await admit(b.ctx, back), 'ok');
  assert.equal(b.rows('installs').find((r) => r.installId === idle.installId)!.expiredAt, undefined);
});

test('a keyless expired row goes for good a year later', async () => {
  const b = memoryBackend(RELAY);
  const i = await register(b.ctx, site(1));
  clock = T0 + IDLE_INSTALL_MS + 1;
  await call(b.ctx, relay.expire, {});
  assert.equal(b.rows('installs').length, 1);
  clock += EXPIRED_KEEP_MS + 1;
  assert.equal((await call(b.ctx, relay.expire, {})).removed, 1);
  assert.equal(b.rows('installs').length, 0);
  assert.equal(await admit(b.ctx, i), 'auth');
});

test('a real install under a week old still gets its reserved few when made-up ones filled the young pool', async () => {
  const b = memoryBackend(RELAY);
  const mine = await register(b.ctx, 'https://real-backend-1.convex.site');
  const young = [];
  for (let n = 0; n < Math.ceil(NEW_INSTALL_SENDS_PER_HOUR / SENDS_PER_HOUR) + 1; n++) young.push(await register(b.ctx, site(n)));
  for (const i of young) for (let k = 0; k < SENDS_PER_HOUR; k++) await send(b.ctx, i);
  for (let k = 0; k < RESERVED_SENDS_PER_HOUR; k++) assert.equal(await send(b.ctx, mine), 'ok', `reserved send ${k}`);
  assert.equal(await send(b.ctx, mine), 'limited');
});

test('sends still out count against the bad-token allowance, so a burst at once is held to it', async () => {
  const b = memoryBackend(RELAY);
  const i = await register(b.ctx, site(1));
  clock = T0 + NEW_INSTALL_MS + 1;
  // 60 admitted before any has an answer (in turn: the in-memory fake can't play overlapping mutations, which Convex runs one after another).
  const results = [];
  for (let k = 0; k < 60; k++) results.push(await admit(b.ctx, i));
  assert.equal(results.filter((r) => r === 'ok').length, BAD_TOKEN_SENDS_PER_HOUR);
});

test('a send that went through, or failed for the relay\'s own reasons, gives its charge back', async () => {
  const b = memoryBackend(RELAY);
  const i = await register(b.ctx, site(1));
  clock = T0 + NEW_INSTALL_MS + 1;
  const outcomes = [{ ok: true, status: 200 }, { ok: false, status: 400, reason: 'UNAUTHENTICATED' }, { ok: false, status: 403, reason: 'InvalidProviderToken' }, { ok: false, status: 0, reason: 'timeout' }];
  for (let k = 0; k < SENDS_PER_HOUR; k++) {
    assert.equal(await admit(b.ctx, i), 'ok', `send ${k}`);
    await count(b.ctx, { ...outcomes[k % outcomes.length]!, installId: i.installId });
  }
});

test('a token from a Firebase project the relay doesn\'t serve counts as a bad token', async () => {
  const b = memoryBackend(RELAY);
  const i = await register(b.ctx, site(1));
  clock = T0 + NEW_INSTALL_MS + 1;
  for (let k = 0; k < BAD_TOKEN_SENDS_PER_HOUR; k++) {
    assert.equal(await admit(b.ctx, i), 'ok');
    await count(b.ctx, { ok: false, status: 403, reason: 'SENDER_ID_MISMATCH', installId: i.installId });
  }
  assert.equal(await admit(b.ctx, i), 'limited');
});

test("an install's hour is the relay's UTC hour, so the reserve can't be taken twice across two windows", async () => {
  const b = memoryBackend(RELAY);
  const i = await register(b.ctx, site(1));
  clock = T0 + NEW_INSTALL_MS + 30 * 60_000; // hh:30
  for (let k = 0; k < SENDS_PER_HOUR; k++) assert.equal(await send(b.ctx, i), 'ok');
  assert.equal(await send(b.ctx, i), 'limited');
  clock += 30 * 60_000; // the next UTC hour, though not 60 minutes since the first send
  assert.equal(await send(b.ctx, i), 'ok');
});

test('/register asks before calling back: over the per-deployment or relay-wide cap is a no', async () => {
  const b = memoryBackend(RELAY);
  assert.equal(await call(b.ctx, relay.mayRegister, { deployment: site(1) }), true);
  for (let k = 0; k < 20; k++) await register(b.ctx, site(1));
  assert.equal(await call(b.ctx, relay.mayRegister, { deployment: site(1) }), false);
});

test("naming someone else's deployment over and over uses up nothing of theirs", async () => {
  // /register asks mayRegister before the call-back says who's calling,
  // so that ask must not count anything (Codex's third review).
  const b = memoryBackend(RELAY);
  await register(b.ctx, site(1));
  for (let k = 0; k < 500; k++) await call(b.ctx, relay.mayRegister, { deployment: site(1) });
  for (let k = 0; k < 500; k++) await call(b.ctx, relay.mayRegister, { deployment: site(1000 + k) });
  assert.equal(await call(b.ctx, relay.mayRegister, { deployment: site(1) }), true);
  assert.equal(await call(b.ctx, relay.mayRegister, { deployment: site(2) }), true);
  assert.equal(b.rows('installs').length, 1, 'no rows for names that never registered');
});

test("a send that was still out when the hour turned gives back to its own hour, not the new one", async () => {
  const b = memoryBackend(RELAY);
  const i = await register(b.ctx, site(1));
  clock = T0 + NEW_INSTALL_MS + 59 * 60_000; // hh:59
  const old = [];
  for (let k = 0; k < BAD_TOKEN_SENDS_PER_HOUR; k++) {
    assert.equal(await admit(b.ctx, i), 'ok');
    old.push(lastHour.get(i.installId)!);
  }
  clock += 2 * 60_000; // the next hour
  for (let k = 0; k < BAD_TOKEN_SENDS_PER_HOUR; k++) {
    assert.equal(await admit(b.ctx, i), 'ok');
    await count(b.ctx, { ok: false, status: 400, reason: 'BadDeviceToken', installId: i.installId });
  }
  // The last hour's sends come back fine now: nothing to give this hour.
  for (const hour of old) await count(b.ctx, { ok: true, status: 200, installId: i.installId, hour });
  assert.equal(await admit(b.ctx, i), 'limited');
});

test('rows from before the deployment check never expire', async () => {
  const b = memoryBackend(RELAY);
  await b.ctx.db.insert('installs', { installId: 'i_legacy', keyHash: 'x', createdAt: 0, lastSeenAt: 0, hourStart: 0, hourSends: 0 });
  clock = T0 + IDLE_INSTALL_MS * 3;
  assert.equal((await call(b.ctx, relay.expire, {})).installs, 0);
  assert.equal(b.rows('installs')[0]!.keyHash, 'x');
});

test('expiring a big backlog goes a batch at a time and schedules the rest', async () => {
  const b = memoryBackend(RELAY);
  for (let n = 0; n < EXPIRE_BATCH + 5; n++) await b.ctx.db.insert('installs', { installId: `i_${n}`, keyHash: 'x', createdAt: 0, lastSeenAt: 0, hourStart: 0, hourSends: 0 });
  for (let n = 0; n < EXPIRE_BATCH + 5; n++) b.rows('installs')[n]!.deployment = site(n);
  assert.equal((await call(b.ctx, relay.expire, {})).installs, EXPIRE_BATCH);
  assert.equal(b.scheduled.length, 1);
  assert.equal((await call(b.ctx, relay.expire, {})).installs, 5);
  assert.equal(b.scheduled.length, 1);
});

test('relay:stats shows how many new deployments came each day', async () => {
  const b = memoryBackend(RELAY);
  await register(b.ctx, site(1));
  await register(b.ctx, site(1));
  await register(b.ctx, site(2));
  const s = await call(b.ctx, relay.stats, {});
  assert.equal(s.days[0].registrations, 3);
  assert.equal(s.days[0].newInstalls, 2);
});
