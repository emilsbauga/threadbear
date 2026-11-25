// This deployment's install with the push relay (convex/push.ts,
// relayInstallMachine.ts, docs/push-relay.md). Each registration makes the
// relay rotate the install's key, so the key from the last one is the only
// one that works. Before the machine, a send whose key the relay refused
// counted the push as failed, sent the rest of its phones with the same dead
// key, and cleared whatever key was saved then, even a newer one another send
// had just registered; two sends could register at once and save their keys
// in either order (docs/lifecycles.md, #1). The push actions run here against
// the in-memory backend and a fake relay that rotates keys as the real one
// does (relay/convex/relay.ts registerVerified, admit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';

const push = load('push');
const devices = load('devices');
const machinesModule = load('machines');
const RELAY = 'https://relay.example';
const DAY = 24 * 60 * 60_000;

type Answer = { status: number; body: unknown };
const json = ({ status, body }: Answer) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// The relay: one install for this deployment, a new key at each registration,
// /send taking only the newest. `hold`: registrations wait for it, so a test
// can have two sends overlap.
function fakeRelay() {
  const relay = { key: undefined as string | undefined, keys: 0, registers: 0, sends: [] as { key: string; ok: boolean }[], hold: undefined as Promise<void> | undefined, failRegister: false };
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${RELAY}/register`) {
      relay.registers++;
      if (relay.hold) await relay.hold;
      if (relay.failRegister) return json({ status: 429, body: { error: 'too many new installs today' } });
      relay.key = `k_${++relay.keys}`;
      return json({ status: 200, body: { installId: 'i_one', installKey: relay.key } });
    }
    if (url === `${RELAY}/send`) {
      const key = String((init?.headers as Record<string, string>).Authorization).replace('Bearer i_one.', '');
      const ok = key === relay.key;
      relay.sends.push({ key, ok });
      return ok ? json({ status: 200, body: { ok: true } }) : json({ status: 401, body: { error: 'unknown install' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return relay;
}

// Runs fn with the clock `ms` on.
async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

async function world(phones = 2) {
  process.env.PUSH_RELAY_URL = RELAY;
  delete process.env.PUSH_RELAY;
  for (const k of ['APNS_KEY_P8', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC', 'PUSH_VIA']) delete process.env[k];
  delete process.env.CONVEX_SITE_URL;
  const b = memoryBackend();
  const tokenId = await b.ctx.db.insert('tokens', { hash: 'h', name: 'iphone', kind: 'phone', expiresAt: Date.now() + 100 * DAY, createdAt: Date.now() });
  for (let i = 0; i < phones; i++) await b.ctx.db.insert('devices', { apnsToken: `${'a'.repeat(63)}${i}`, environment: 'production', tokenName: 'iphone', tokenId, updatedAt: Date.now() });
  // An action's runQuery and runMutation, one at a time, as Convex runs
  // mutations serializably (the fake's handlers would otherwise interleave).
  let queue: Promise<unknown> = Promise.resolve();
  const byRef = (ref: unknown) => {
    const [, mod, fn] = String(ref).split('.');
    return load(mod!)[fn!];
  };
  const serial = (ref: unknown, args: Record<string, unknown>) => {
    const p = queue.then(() => call(b.ctx, byRef(ref), args));
    queue = p.catch(() => undefined);
    return p;
  };
  const actionCtx = { runQuery: serial, runMutation: serial };
  const send = () => call(actionCtx, push.test, {}) as Promise<{ sent: number; failed: number }>;
  const state = () => b.rows('relayRegistrations')[0]?.installState;
  return { ...b, send, state, actionCtx };
}

test('a key the relay refuses is registered again and the push sent once more, and the rest go with the new key', async () => {
  const relay = fakeRelay();
  const w = await world(2);
  assert.deepEqual(await w.send(), { sent: 2, failed: 0 });
  assert.equal(relay.registers, 1);
  // The relay forgets the install (90 days unused), or something else registered as it: the key is dead.
  relay.key = 'k_elsewhere';
  assert.deepEqual(await later(3 * 60_000, () => w.send()), { sent: 2, failed: 0 }, 'neither phone misses it');
  assert.equal(relay.registers, 2, 'registered again once');
  assert.deepEqual(relay.sends.slice(2).map((s) => s.ok), [false, true, true], 'the first phone sent again, the second straight on the new key');
  assert.equal(w.state().kind, 'registered');
});

test('two sends at once register once: the second waits for the first one\'s key', async () => {
  const relay = fakeRelay();
  const w = await world(1);
  let open!: () => void;
  relay.hold = new Promise<void>((resolve) => (open = resolve));
  const both = Promise.all([w.send(), w.send()]);
  // The second finds the first registering, and waits rather than register too (which would kill the first's key).
  const asked = () => w.rows('relayRegistrations').length > 0 && relay.registers === 1;
  for (const until = Date.now() + 10_000; !asked() && Date.now() < until; ) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.state().kind, 'registering');
  open();
  assert.equal(relay.registers, 1);
  assert.deepEqual(await both, [{ sent: 1, failed: 0 }, { sent: 1, failed: 0 }]);
  assert.equal(relay.registers, 1, 'one registration');
  assert.ok(relay.sends.every((s) => s.ok), 'no push sent with a dead key');
});

test('a refusal of an older key clears nothing: the newer key another send saved is used', async () => {
  fakeRelay();
  const w = await world(1);
  await w.send();
  const first = w.state();
  assert.equal(first.kind, 'registered');
  await later(3 * 60_000, async () => {
    // Another send's 401 on that key registers again.
    const took = await call(w.ctx, devices.takeRelayInstall, { url: RELAY, attempt: 'second', refused: first.attempt });
    assert.deepEqual(took, { register: true });
    assert.equal(await call(w.ctx, devices.relayRegistered, { url: RELAY, attempt: 'second', installId: 'i_one', installKey: 'k_new' }), true);
    // A third send that also saw the first key refused, a moment later: it gets the new key, and nothing registers.
    const late = await call(w.ctx, devices.takeRelayInstall, { url: RELAY, attempt: 'third', refused: first.attempt });
    assert.deepEqual(late, { use: { attempt: 'second', installId: 'i_one', installKey: 'k_new' } });
    await call(w.ctx, devices.relayRefused, { url: RELAY, attempt: first.attempt });
  });
  assert.equal(w.state().kind, 'registered', 'still the new key');
  assert.equal(w.state().installKey, 'k_new');
});

test("a registration that never answers is given up on, and the next send registers", async () => {
  fakeRelay();
  const w = await world(1);
  assert.deepEqual(await call(w.ctx, devices.takeRelayInstall, { url: RELAY, attempt: 'lost' }), { register: true });
  assert.deepEqual(await call(w.ctx, devices.takeRelayInstall, { url: RELAY, attempt: 'other' }), { wait: true });
  // Its timer, once it's due.
  const timer = w.pendingTimers().find((t: any) => t.args.event === 'LAPSED')!;
  assert.ok(timer, 'armed');
  const realNow = Date.now;
  Date.now = () => timer.at + 1;
  try {
    await call(w.ctx, machinesModule.deliver, timer.args);
    assert.equal(w.state().kind, 'unregistered');
    // The lost send's answer, if it ever comes, isn't kept.
    assert.equal(await call(w.ctx, devices.relayRegistered, { url: RELAY, attempt: 'lost', installId: 'i_one', installKey: 'k_late' }), false);
    assert.deepEqual(await w.send(), { sent: 1, failed: 0 });
  } finally {
    Date.now = realNow;
  }
});

// Codex's review: a registration this deployment gave up on could still reach
// the relay after the next one had, and replace its key. The relay asks this
// deployment to confirm each registration before it gives a key
// (/relay/verify), and it's told yes only while that registration holds the
// install with time to spare.
test('the relay is told yes to a registration only while it holds the install, with time to spare', async () => {
  fakeRelay();
  const w = await world(1);
  const realNow = Date.now;
  const check = async (attempt: string, at = realNow()) => {
    const nonce = `${attempt}-nonce`;
    await call(w.ctx, devices.startRelayCheck, { nonce, attempt });
    Date.now = () => at;
    try {
      return await call(w.ctx, devices.takeRelayCheck, { nonce });
    } finally {
      Date.now = realNow;
    }
  };
  await call(w.ctx, devices.takeRelayInstall, { url: RELAY, attempt: 'a' });
  assert.equal(await check('a'), true, 'while it holds it');
  assert.equal(await check('a', realNow() + 25_000), false, 'not with less than eight seconds of its time left');
  assert.equal(await check('b'), false, "not another send's");
  // Once it's registered, a late confirmation of it is a no too: the key's already given.
  await call(w.ctx, devices.relayRegistered, { url: RELAY, attempt: 'a', installId: 'i_one', installKey: 'k' });
  assert.equal(await check('a'), false);
});

test('a registration with no answer keeps the install until its time is up, so no other send registers over it', async () => {
  const relay = fakeRelay();
  const w = await world(1);
  globalThis.fetch = (async (input: string | URL) => {
    if (String(input).endsWith('/register')) relay.registers++;
    throw new Error('The operation was aborted due to timeout');
  }) as typeof fetch;
  await call(w.actionCtx, push.test, {});
  assert.equal(w.state().kind, 'registering', 'still its own: the relay may yet register it');
  assert.deepEqual(await call(w.ctx, devices.takeRelayInstall, { url: RELAY, attempt: 'other' }), { wait: true });
});

test('a registration past its time is taken over before its timer has run', async () => {
  fakeRelay();
  const w = await world(1);
  await call(w.ctx, devices.takeRelayInstall, { url: RELAY, attempt: 'lost' });
  const realNow = Date.now;
  Date.now = () => realNow() + 41_000;
  try {
    assert.deepEqual(await call(w.ctx, devices.takeRelayInstall, { url: RELAY, attempt: 'next' }), { register: true });
  } finally {
    Date.now = realNow;
  }
  assert.equal(w.state().attempt, 'next');
});

test('a registration the relay turns down fails the push, and sends wait a few minutes before asking again', async () => {
  const relay = fakeRelay();
  const w = await world(1);
  relay.failRegister = true;
  assert.deepEqual(await w.send(), { sent: 0, failed: 1 });
  assert.equal(w.state().kind, 'unregistered');
  relay.failRegister = false;
  // Gemini's review: each waiting send registering in turn after a refusal used up the relay's 20 a day.
  assert.deepEqual(await w.send(), { sent: 0, failed: 1 }, 'not asked again straight away');
  assert.equal(relay.registers, 1);
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60_000;
  try {
    assert.deepEqual(await w.send(), { sent: 1, failed: 0 });
  } finally {
    Date.now = realNow;
  }
});

test('an install saved before the machine is taken over without registering again', async () => {
  const relay = fakeRelay();
  relay.key = 'k_saved';
  const w = await world(1);
  await w.ctx.db.insert('relayInstall', { installId: 'i_one', installKey: 'k_saved', url: RELAY, createdAt: 1 });
  assert.deepEqual(await w.send(), { sent: 1, failed: 0 });
  assert.equal(relay.registers, 0);
  assert.equal(w.rows('relayInstall').length, 0, 'the old row went');
  assert.equal(w.state().installKey, 'k_saved');
});

test('a relay that refuses every key registers once per send, not in a loop', async () => {
  const relay = fakeRelay();
  const w = await world(3);
  await w.send();
  // Every key refused from now on.
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith('/register')) {
      relay.registers++;
      return json({ status: 200, body: { installId: 'i_one', installKey: `k_${++relay.keys}` } });
    }
    return json({ status: 401, body: { error: 'unknown install' } });
  }) as typeof fetch;
  const before = relay.registers;
  // An old key refused: registered once more, and the new key refused too.
  assert.deepEqual(await later(3 * 60_000, () => w.send()), { sent: 0, failed: 3 });
  assert.equal(relay.registers - before, 1);
  assert.equal(w.state().kind, 'unregistered', 'cleared');
  // A key refused as soon as it was given: the next sends don't register for a while.
  assert.deepEqual(await later(4 * 60_000, () => w.send()), { sent: 0, failed: 3 });
  assert.equal(relay.registers - before, 1);
  assert.deepEqual(await later(9 * 60_000, () => w.send()), { sent: 0, failed: 3 });
  assert.equal(relay.registers - before, 2, 'then once more');
});

// Both reviews: a send that got another's new key (by waiting for it) and saw it refused registered again at once.
test("a key refused soon after any send registered it holds every send off, not only the registering one's", async () => {
  const relay = fakeRelay();
  const w = await world(1);
  await w.send();
  relay.key = 'k_elsewhere';
  assert.deepEqual(await w.send(), { sent: 0, failed: 1 });
  assert.equal(relay.registers, 1, 'not registered again');
  assert.equal(w.state().kind, 'unregistered');
});

test('a send that registered a key the relay then refuses registers no second time', async () => {
  const relay = fakeRelay();
  const w = await world(2);
  globalThis.fetch = (async (input: string | URL) => {
    if (String(input).endsWith('/register')) {
      relay.registers++;
      return json({ status: 200, body: { installId: 'i_one', installKey: `k_${++relay.keys}` } });
    }
    return json({ status: 401, body: { error: 'unknown install' } });
  }) as typeof fetch;
  assert.deepEqual(await w.send(), { sent: 0, failed: 2 });
  assert.equal(relay.registers, 1);
});

// Both reviews: an adopted key was taken for a new one, so its refusal held sends off rather than registering.
test('an install saved before the machine whose key the relay refuses is registered again at once', async () => {
  const relay = fakeRelay();
  relay.key = 'k_current';
  const w = await world(1);
  await w.ctx.db.insert('relayInstall', { installId: 'i_one', installKey: 'k_dead', url: RELAY, createdAt: 1 });
  assert.deepEqual(await w.send(), { sent: 1, failed: 0 });
  assert.equal(relay.registers, 1);
});

test("the Machines page never shows the install's key", () => {
  const { withoutSecrets } = load('viewer') as { withoutSecrets: <T>(x: T) => T };
  assert.deepEqual(withoutSecrets({ doc: { installState: { kind: 'registered', attempt: 'a', installId: 'i', installKey: 'k', at: 1 } } }), { doc: { installState: { kind: 'registered', attempt: 'a', installId: 'i', at: 1 } } });
});

// Codex review of Daybreak 169 (22 Nov 2026): a clear the relay answers
// "gone" (a phone uninstalled or a dead token) charges the relay's bad-token
// allowance, as it should, so the backend drops that phone as a send does,
// rather than clearing it again with every thread that stops needing Mike.
test('a phone the relay says is gone after a clear is dropped, so the next clear skips it', async () => {
  const relay = fakeRelay();
  const w = await world(2);
  assert.deepEqual(await w.send(), { sent: 2, failed: 0 });
  const dead = `${'a'.repeat(63)}0`;
  const cleared: string[] = [];
  const send = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    if (String(input) !== `${RELAY}/clear`) return send(input, init);
    const { deviceToken } = JSON.parse(String(init?.body)) as { deviceToken: string };
    cleared.push(deviceToken);
    return deviceToken === dead ? json({ status: 200, body: { ok: false, status: 410, reason: 'Unregistered', gone: true } }) : json({ status: 200, body: { ok: true, status: 200 } });
  }) as typeof fetch;
  assert.deepEqual(await call(w.actionCtx, push.clear, { threadId: 'T' }), { sent: 1, failed: 1 });
  assert.deepEqual(await call(w.actionCtx, push.clear, { threadId: 'T' }), { sent: 1, failed: 0 });
  assert.deepEqual(cleared.filter((t) => t === dead).length, 1, 'cleared once, then dropped');
  assert.equal(w.rows('devices').some((d) => d.apnsToken === dead), false);
  assert.equal(relay.registers, 1);
});

// Daybreak 169's reviews: only an alert some phone really got makes the
// thread's notification one to clear (devices:alerted), not a push that was
// held for "away" phones while Mike's at the Mac, or one with no phones.
test('push:notify marks a thread to clear only when an alert reached a phone', async () => {
  fakeRelay();
  const w = await world(2);
  const now = Date.now();
  await w.ctx.db.insert('threads', { threadId: 'T', runnerId: 'mac1', ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: true, pushedAt: now });
  const t = () => w.rows('threads').find((r) => r.threadId === 'T')!;
  // At the Mac, with only "away" phones (the default): held, nothing sent.
  await w.ctx.db.insert('runners', { runnerId: 'mac1', name: 'Laptop', version: '1', lastSeenAt: now, startedAt: new Date(now).toISOString(), draining: false, threadCount: 1, atMac: true, atMacAt: now });
  const atMac = await call(w.actionCtx, push.notify, { threadId: 'T' });
  assert.equal(atMac.sent, 0);
  assert.equal(t().alertedAt, undefined, 'held: nothing on any phone to clear');
  assert.ok(t().pushHeldAt);
  // He leaves: the held push goes to the away phones.
  await w.ctx.db.patch(w.rows('runners')[0]._id, { atMac: false, atMacAt: now });
  const away = await call(w.actionCtx, push.notify, { threadId: 'T', held: true });
  assert.equal(away.sent, 2);
  assert.ok(t().alertedAt, 'delivered: one clear may take it down');
});
