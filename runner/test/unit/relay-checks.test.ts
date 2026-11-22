// Codex Security, 21 Nov 2026 (finding 156): the push relay's /register
// called the deployment it was given back (relay/convex/verify.ts
// deploymentVouches) after only a read-only check, and a call-back that
// said no charged nothing, so anyone could have it make outbound requests
// as fast and as many at once as they liked. Now each call-back is charged
// to the relay's own budget first (relay.ts startCheck), never to a
// deployment's registrations. These play /register's steps
// (verify.ts checkRegistration, as http.ts wires them) against
// relay/convex/relay.ts on an in-memory database.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, outcome, RELAY } from '../helpers/convex-memory.ts';
import { checkRegistration } from '../../../relay/convex/verify.ts';

const relay = load('relay', RELAY);
const { MAX_KNOWN_CHECKS_IN_FLIGHT, MAX_NEW_CHECKS_IN_FLIGHT, NO_COOLDOWN_MS, NEW_CHECKS_PER_HOUR, KNOWN_CHECKS_PER_HOUR, RESERVED_CHECKS_PER_HOUR, CHECK_LEASE_MS, REGISTRATIONS_PER_DEPLOYMENT_PER_DAY, NEW_INSTALLS_PER_DAY, NEW_INSTALL_MS } = relay;

const T0 = Date.parse('2026-11-21T01:00:00Z');
let clock = T0;
mock.method(Date, 'now', () => clock);
afterEach(() => (clock = T0));

const site = (n: number | string) => `https://made-up-${n}.convex.site`;

// Convex runs each mutation as one serializable transaction; the
// in-memory database doesn't, so the steps here take turns.
let turn: Promise<unknown> = Promise.resolve();
const serial = (ctx: unknown, fn: unknown, args: Record<string, unknown>): ReturnType<typeof call> => {
  const next = turn.then(() => call(ctx, fn as never, args));
  turn = next.catch(() => {});
  return next;
};

// /register's steps for `deployment`, with the call-back answered by
// `answer` (counted in `calls`), then registerVerified on a yes, as http.ts does.
function registrar(ctx: unknown) {
  const calls: string[] = [];
  const attempt = async (deployment: string, answer: () => Promise<boolean> = async () => false) => {
    const r = await checkRegistration({
      mayRegister: () => serial(ctx, relay.mayRegister, { deployment }),
      startCheck: () => serial(ctx, relay.startCheck, { deployment }),
      endCheck: (check, vouched) => serial(ctx, relay.endCheck, { check, vouched }),
      vouches: () => {
        calls.push(deployment);
        return answer();
      },
    });
    if (r === 'yes') await serial(ctx, relay.registerVerified, { deployment });
    return r;
  };
  return { calls, attempt };
}

test('a burst of made-up registrations at once: only so many call-backs go at a time', async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  // Call-backs that hang (a deployment taking its time) until let go.
  let release!: () => void;
  const held = new Promise<boolean>((res) => (release = () => res(false)));
  const burst = Array.from({ length: 50 }, (_, n) => r.attempt(site(n), () => held));
  // Let every attempt get as far as it can.
  for (let i = 0; i < 200; i++) await new Promise((res) => setImmediate(res));
  assert.equal(r.calls.length, MAX_NEW_CHECKS_IN_FLIGHT, 'call-backs to unknown deployments in flight at once');
  release();
  const results = await Promise.all(burst);
  assert.equal(results.filter((x) => x === 'limited').length, 50 - MAX_NEW_CHECKS_IN_FLIGHT);
  assert.equal(results.filter((x) => x === 'no').length, MAX_NEW_CHECKS_IN_FLIGHT);
  // Answered, they stop counting.
  assert.equal(b.rows('checks').length, 0);
  assert.equal(await r.attempt(site('later')), 'no');
});

test('one deployment gets one call-back at a time, and none for a while after a no', async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  let release!: () => void;
  const held = new Promise<boolean>((res) => (release = () => res(false)));
  const first = r.attempt(site('x'), () => held);
  for (let i = 0; i < 50; i++) await new Promise((res) => setImmediate(res));
  assert.equal(await r.attempt(site('x')), 'limited', 'a second one while the first is going');
  release();
  assert.equal(await first, 'no');
  assert.equal(await r.attempt(site('x')), 'limited', 'straight after a no');
  assert.deepEqual(r.calls, [site('x')]);
  clock += NO_COOLDOWN_MS;
  assert.equal(await r.attempt(site('x')), 'no');
  assert.equal(r.calls.length, 2);
});

// Gemini's review: a per-deployment hourly cap let someone naming a real
// backend keep it locked out for the rest of the hour after they stopped.
test('someone naming a real backend holds it up only while they keep at it', async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  const real = 'https://real-backend-1.convex.site';
  await call(b.ctx, relay.registerVerified, { deployment: real });
  clock += NEW_INSTALL_MS;
  // An hour of a no every cool-down.
  for (let i = 0; i < 3_600_000 / NO_COOLDOWN_MS; i++) {
    await r.attempt(real);
    clock += NO_COOLDOWN_MS;
  }
  // They stop: the backend registers again straight away.
  assert.equal(await r.attempt(real, async () => true), 'yes');
});

test("a call-back answered after its lease ran out doesn't hold off the deployment", async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  const slow = await call(b.ctx, relay.startCheck, { deployment: site('s') });
  clock += CHECK_LEASE_MS;
  assert.equal(await r.attempt(site('s'), async () => true), 'yes');
  await call(b.ctx, relay.endCheck, { check: slow.check, vouched: false });
  assert.ok(b.rows('checkHolds').every((h) => h.noUntil === undefined));
  assert.equal(b.rows('checks').length, 0);
});

test("call-backs never write /send's hourly row", async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  for (let n = 0; n < 5; n++) await r.attempt(site(n));
  assert.equal(b.rows('hours').length, 0);
  assert.equal(b.rows('checkHours')[0]!.checks, 5);
});

test('made-up names get only so many call-backs an hour relay-wide', async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  for (let n = 0; n < NEW_CHECKS_PER_HOUR; n++) assert.equal(await r.attempt(site(n)), 'no');
  assert.equal(await r.attempt(site('one-more')), 'limited');
  assert.equal(r.calls.length, NEW_CHECKS_PER_HOUR);
  clock += 3_600_000;
  assert.equal(await r.attempt(site('one-more')), 'no');
});

test("failed call-backs use only the relay's budget: a deployment's registrations and the day's new installs are untouched", async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  const real = 'https://real-backend-1.convex.site';
  // Someone naming the real backend with nonces it never made.
  assert.equal(await r.attempt(real), 'no');
  for (let n = 0; n < 50; n++) await r.attempt(site(n));
  assert.equal(b.rows('installs').length, 0);
  const day = b.rows('days')[0];
  assert.equal(day?.newInstalls ?? 0, 0);
  assert.equal(day?.registrations ?? 0, 0);
  // Once the cool-down is over the real one registers, and its own allowance is whole.
  clock += NO_COOLDOWN_MS;
  assert.equal(await r.attempt(real, async () => true), 'yes');
  const row = b.rows('installs').find((i) => i.deployment === real)!;
  assert.equal(row.registeredToday, 1);
  assert.ok(REGISTRATIONS_PER_DEPLOYMENT_PER_DAY > 1 && NEW_INSTALLS_PER_DAY > 1);
});

test("made-up names using up the hour's call-backs and slots can't stop an established backend registering again", async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  const real = 'https://real-backend-1.convex.site';
  await call(b.ctx, relay.registerVerified, { deployment: real });
  clock += NEW_INSTALL_MS;
  for (let n = 0; n < NEW_CHECKS_PER_HOUR; n++) await r.attempt(site(n));
  assert.equal(await r.attempt(site('one-more')), 'limited');
  // And with every slot for made-up names held.
  let release!: () => void;
  const held = new Promise<boolean>((res) => (release = () => res(false)));
  clock += 3_600_000;
  const burst = Array.from({ length: MAX_NEW_CHECKS_IN_FLIGHT }, (_, n) => r.attempt(site(`h${n}`), () => held));
  for (let i = 0; i < 200; i++) await new Promise((res) => setImmediate(res));
  assert.equal(await r.attempt(site('blocked')), 'limited');
  assert.equal(await r.attempt(real, async () => true), 'yes');
  release();
  await Promise.all(burst);
});

test("a call-back whose action died stops counting after its lease, and expire clears it", async () => {
  const b = memoryBackend(RELAY);
  const started = await call(b.ctx, relay.startCheck, { deployment: site('dead') });
  assert.equal(typeof started, 'object');
  assert.equal(await call(b.ctx, relay.startCheck, { deployment: site('dead') }), 'limited');
  clock += CHECK_LEASE_MS + 1;
  assert.equal(typeof (await call(b.ctx, relay.startCheck, { deployment: site('dead') })), 'object');
  clock += 3 * 86_400_000;
  await call(b.ctx, relay.expire, {});
  assert.equal(b.rows('checks').length, 0);
  assert.equal(b.rows('checkHolds').length, 0);
  assert.equal(b.rows('checkHours').length, 0);
});

test("endCheck for a check that's gone does nothing", async () => {
  const b = memoryBackend(RELAY);
  const started = await call(b.ctx, relay.startCheck, { deployment: site('gone') });
  await call(b.ctx, relay.endCheck, { check: started.check, vouched: false });
  assert.equal(await outcome(call(b.ctx, relay.endCheck, { check: started.check, vouched: false })), 'ok');
});

// Gemini's review: an install made today counted as known, so deployments
// someone registered could take the slots and pool kept for real backends.
test("an install under a week old shares the made-up names' slots and pool", async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  const young = 'https://registered-today.convex.site';
  await call(b.ctx, relay.registerVerified, { deployment: young });
  for (let n = 0; n < NEW_CHECKS_PER_HOUR; n++) await r.attempt(site(n));
  assert.equal(await r.attempt(young), 'limited');
  const started = await call(b.ctx, relay.startCheck, { deployment: site('fresh') });
  assert.equal(started, 'limited');
});

test('established backends have their own slots at once, apart from made-up names', async () => {
  const b = memoryBackend(RELAY);
  const known: string[] = [];
  for (let n = 0; n < MAX_KNOWN_CHECKS_IN_FLIGHT + 1; n++) {
    known.push(`https://known-${n}.convex.site`);
    await call(b.ctx, relay.registerVerified, { deployment: known[n]! });
  }
  clock += NEW_INSTALL_MS;
  const held = [];
  for (let n = 0; n < MAX_KNOWN_CHECKS_IN_FLIGHT; n++) held.push(await call(b.ctx, relay.startCheck, { deployment: known[n]! }));
  assert.ok(held.every((h) => typeof h === 'object'));
  assert.equal(await call(b.ctx, relay.startCheck, { deployment: known[MAX_KNOWN_CHECKS_IN_FLIGHT]! }), 'limited');
  // Made-up names still get theirs, and use none of the established ones'.
  for (let n = 0; n < MAX_NEW_CHECKS_IN_FLIGHT; n++) assert.equal(typeof (await call(b.ctx, relay.startCheck, { deployment: site(n) })), 'object');
  assert.equal(await call(b.ctx, relay.startCheck, { deployment: site('x') }), 'limited');
  await call(b.ctx, relay.endCheck, { check: held[0]!.check, vouched: true });
  assert.equal(typeof (await call(b.ctx, relay.startCheck, { deployment: known[MAX_KNOWN_CHECKS_IN_FLIGHT]! })), 'object');
});

// Codex's second review: an hourly pool shared by established backends let
// someone naming twenty of them use it up and lock every other one out
// until the hour turned, after they'd stopped.
test('naming many established backends for an hour leaves an unrelated one free to register the moment it stops', async () => {
  const b = memoryBackend(RELAY);
  const r = registrar(b.ctx);
  const named = Array.from({ length: 20 }, (_, n) => `https://named-${n}.convex.site`);
  const other = 'https://unrelated-backend.convex.site';
  for (const d of [...named, other]) await call(b.ctx, relay.registerVerified, { deployment: d });
  clock += NEW_INSTALL_MS;
  const start = clock;
  while (clock < start + 3_000_000) {
    for (const d of named) await r.attempt(d);
    clock += NO_COOLDOWN_MS + 1_000;
  }
  assert.ok(r.calls.length >= 1_200, `${r.calls.length}`);
  assert.equal(await r.attempt(other, async () => true), 'yes');
  // A named one, with the pool drained and its own few used, waits for the next hour.
  assert.equal(await r.attempt(named[0]!, async () => true), 'limited');
  clock += 3_600_000;
  assert.equal(await r.attempt(named[0]!, async () => true), 'yes');
});

// verify-fix (third pass): established backends had no hourly cap at all.
// They share one an hour; past it, each still gets its own first few, so
// draining it with names someone knows can't stop one they didn't name.
test('established backends share an hourly pool, and past it each keeps a reserved few', async () => {
  const b = memoryBackend(RELAY);
  const many = Array.from({ length: 70 }, (_, n) => `https://est-${n}.convex.site`);
  const other = 'https://not-named.convex.site';
  for (const d of [...many, other]) await call(b.ctx, relay.registerVerified, { deployment: d });
  clock += NEW_INSTALL_MS;
  let made = 0;
  let refused = 0;
  for (let round = 0; round < 40 && refused < many.length; round++) {
    refused = 0;
    for (const d of many) {
      const h = await call(b.ctx, relay.startCheck, { deployment: d });
      if (h === 'limited') {
        refused++;
        continue;
      }
      made++;
      await call(b.ctx, relay.endCheck, { check: h.check, vouched: true });
    }
  }
  assert.ok(made >= KNOWN_CHECKS_PER_HOUR && made <= KNOWN_CHECKS_PER_HOUR + many.length * RESERVED_CHECKS_PER_HOUR, `${made}`);
  assert.ok(made < 40 * many.length, 'the pool stops them');
  for (let k = 0; k < RESERVED_CHECKS_PER_HOUR; k++) {
    const h = await call(b.ctx, relay.startCheck, { deployment: other });
    assert.equal(typeof h, 'object', `reserved ${k}`);
    await call(b.ctx, relay.endCheck, { check: h.check, vouched: true });
  }
  assert.equal(await call(b.ctx, relay.startCheck, { deployment: other }), 'limited');
  clock += 3_600_000;
  assert.equal(typeof (await call(b.ctx, relay.startCheck, { deployment: other })), 'object');
});
