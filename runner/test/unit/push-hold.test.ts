// A push held while Mike is at the Mac (convex/push.ts notify, holdPush) goes
// when he leaves (sync:setPresence). A Mac whose lid closed never says he
// left, as its runner sleeps with it, so the push waited for good and the
// phone never buzzed (13 Nov 2026, the implicit state machines scan). The
// cron sends the held pushes of a runner that said he's there but has
// stopped checking in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';

const sync = load('sync');
const { PRESENCE_FRESH_MS } = load('lib') as { PRESENCE_FRESH_MS: number };

async function world(lastSeenAgo: number) {
  const b = memoryBackend();
  const now = Date.now();
  await b.ctx.db.insert('runners', { runnerId: 'mac1', name: 'Laptop', version: '1', lastSeenAt: now - lastSeenAgo, startedAt: new Date().toISOString(), draining: false, threadCount: 2, atMac: true, atMacAt: now - lastSeenAgo });
  await b.ctx.db.insert('threads', { threadId: 'needs', runnerId: 'mac1', ...THREAD_BASICS, title: 'Needs him', view: 'inbox', needsYou: true, pushHeldAt: now - lastSeenAgo });
  await b.ctx.db.insert('threads', { threadId: 'seen', runnerId: 'mac1', ...THREAD_BASICS, title: 'Seen since', view: 'inbox', needsYou: false, pushHeldAt: now - lastSeenAgo });
  return b;
}

const notified = (b: ReturnType<typeof memoryBackend>) => b.scheduled.filter((s: any) => String(s.fn).endsWith('push.notify')).map((s: any) => s.args);

// The cron, then the drains it hands on, as the scheduler would run them.
async function cron(b: ReturnType<typeof memoryBackend>) {
  const from = b.scheduled.length;
  await call(b.ctx, sync.sendStaleHeldPushes, {});
  for (let i = from; i < b.scheduled.length; i++) {
    const s = b.scheduled[i] as any;
    if (String(s.fn).endsWith('drainHeldPushes')) await call(b.ctx, sync.drainHeldPushes, s.args);
  }
}

test("a held push goes once its Mac has stopped checking in, as one whose lid closed with Alex at it", async () => {
  const b = await world(PRESENCE_FRESH_MS + 60_000);
  await cron(b);
  assert.deepEqual(notified(b), [{ threadId: 'needs', held: true }]);
  assert.ok(b.rows('threads').every((t: any) => t.pushHeldAt === undefined), 'nothing still held');
  assert.equal(b.rows('runners')[0].atMac, true, 'he is there again when it wakes and checks in');
  await cron(b);
  assert.equal(notified(b).length, 1, 'once');
});

test('a Mac still checking in with Alex at it keeps its pushes held', async () => {
  const b = await world(30_000);
  await cron(b);
  assert.deepEqual(notified(b), []);
  assert.ok(b.rows('threads').every((t: any) => t.pushHeldAt !== undefined));
});


// Daybreak 119 (13 Nov 2026): a secondary runner's key may keep 3,000 rows
// of up to 8 KB and hold a push on each (needsYou flipped ten a minute while
// it says Mike is there). The cron read every held row of every stale runner
// in one mutation: past Convex's 16 MiB, so it failed every two minutes and
// another Mac's held push never went. Now the cron only hands each runner's
// drain to a mutation of its own, and each drain reads a small batch.
test("a runner's huge held backlog can't stop another Mac's held push, and drains a batch at a time", async () => {
  const b = memoryBackend();
  const now = Date.now();
  const stale = now - PRESENCE_FRESH_MS - 60_000;
  const runner = (runnerId: string) => b.ctx.db.insert('runners', { runnerId, name: runnerId, version: '1', lastSeenAt: stale, startedAt: new Date().toISOString(), draining: false, threadCount: 1, atMac: true, atMacAt: stale });
  await runner('bad');
  await runner('mac1');
  const big = 'q'.repeat(7_600);
  for (let i = 0; i < 3000; i++) await b.ctx.db.insert('threads', { threadId: `bad-${i}`, runnerId: 'bad', ...THREAD_BASICS, title: 'x', asked: big, view: 'inbox', needsYou: true, pushHeldAt: stale });
  await b.ctx.db.insert('threads', { threadId: 'needs', runnerId: 'mac1', ...THREAD_BASICS, title: 'Needs him', view: 'inbox', needsYou: true, pushHeldAt: stale });
  const LIMIT = 16 * 1024 * 1024;
  const run = async (fn: any, args: Record<string, unknown>) => {
    b.resetReads();
    await call(b.ctx, fn, args);
    assert.ok(b.bytesRead() < 1024 * 1024, `${b.bytesRead()} bytes read in one mutation`);
    assert.ok(b.bytesRead() < LIMIT);
  };
  await run(sync.sendStaleHeldPushes, {});
  const drains = () => b.scheduled.filter((s: any) => String(s.fn).endsWith('drainHeldPushes'));
  assert.deepEqual(drains().map((s: any) => s.args.runnerId).sort(), ['bad', 'mac1'], 'one drain each');
  assert.deepEqual(notified(b), [], 'the cron itself sends nothing');
  // Each runner's drain on its own: mac1's push goes whatever bad's does.
  await run(sync.drainHeldPushes, { runnerId: 'mac1' });
  assert.deepEqual(notified(b), [{ threadId: 'needs', held: true }]);
  // bad's goes a batch at a time, each scheduling the next, until none are held.
  let done = 0;
  while (done < drains().length) {
    const next = drains()[done++] as any;
    if (next.args.runnerId !== 'bad') continue;
    await run(sync.drainHeldPushes, next.args);
  }
  assert.equal(notified(b).length, 3001);
  assert.ok(b.rows('threads').every((t: any) => t.pushHeldAt === undefined));
  // A cron with nothing held hands nothing on.
  const before = drains().length;
  await run(sync.sendStaleHeldPushes, {});
  assert.equal(drains().length, before);
});

// Daybreak 148 (17 Nov 2026): a drain never asked whether Mike was back, and
// push.notify holds a push again when he is (push.ts, the held branch), so a
// secondary runner that held 33 pushes, left (setPresence false), then said
// it was back while keeping its threads needing him fed the same rows to
// drain after drain, for ever. These play the scheduler one callback at a
// time, as Convex may, with notify's held branch as push.ts runs it.
const devices = load('devices');

async function secondary(b: ReturnType<typeof memoryBackend>, n: number, now: number) {
  await b.ctx.db.insert('runners', { runnerId: 'sec', name: 'Other', version: '1', lastSeenAt: now, startedAt: new Date(now).toISOString(), draining: false, threadCount: n, atMac: true, atMacAt: now });
  for (let i = 0; i < n; i++) await b.ctx.db.insert('threads', { threadId: `sec-${i}`, runnerId: 'sec', ...THREAD_BASICS, title: 'x', view: 'inbox', needsYou: true, pushHeldAt: now - 1000 });
}

// Runs what's been scheduled, oldest first, at most `limit` callbacks, with
// `between` called before each. Returns how many ran and what's left.
async function serial(b: ReturnType<typeof memoryBackend>, from: number, limit: number, between: (fn: string) => Promise<void>) {
  let i = from;
  let ran = 0;
  for (; i < b.scheduled.length && ran < limit; i++, ran++) {
    const s = b.scheduled[i] as any;
    const fn = String(s.fn);
    await between(fn);
    if (fn.endsWith('drainHeldPushes')) await call(b.ctx, sync.drainHeldPushes, s.args);
    else if (fn.endsWith('push.notify')) {
      // push.ts notify, held: true: sent while he's away, held again if he's back.
      const t = await call(b.ctx, devices.threadForPush, { threadId: s.args.threadId });
      if (t && t.needsYou && t.atMac) await call(b.ctx, devices.holdPush, { threadId: s.args.threadId });
    }
  }
  return { ran, left: b.scheduled.length - i };
}

function fakeClock(start: number) {
  const real = Date.now;
  let t = start;
  Date.now = () => t;
  return { tick: () => void (t += 1), set: (x: number) => void (t = x), restore: () => void (Date.now = real) };
}

test('Daybreak 148: a runner back at the Mac while its held pushes drain stops the drain, and it ends', async () => {
  const start = Date.now();
  const clock = fakeClock(start);
  try {
    const b = memoryBackend();
    await secondary(b, 33, start);
    const sec = () => b.rows('runners').find((r: any) => r.runnerId === 'sec')!;
    // It says he left (setPresence false, which sends the first batch as
    // this drain does), then that he's back, with fresh heartbeats.
    await b.ctx.db.patch(sec()._id, { atMac: false });
    const from = b.scheduled.length;
    await call(b.ctx, sync.drainHeldPushes, { runnerId: 'sec', before: start });
    await b.ctx.db.patch(sec()._id, { atMac: true });
    const { ran, left } = await serial(b, from, 1000, async () => {
      clock.tick();
      await b.ctx.db.patch(sec()._id, { lastSeenAt: Date.now() });
    });
    assert.equal(left, 0, `still ${left} queued after ${ran} callbacks`);
    assert.ok(ran < 100, `${ran} callbacks`);
  } finally {
    clock.restore();
  }
});

test('Daybreak 148: each drain only takes pushes held before it began, whatever presence does', async () => {
  const start = Date.now();
  const clock = fakeClock(start);
  try {
    const b = memoryBackend();
    await secondary(b, 33, start);
    const sec = () => b.rows('runners').find((r: any) => r.runnerId === 'sec')!;
    await b.ctx.db.patch(sec()._id, { atMac: false });
    const from = b.scheduled.length;
    await call(b.ctx, sync.drainHeldPushes, { runnerId: 'sec', before: start });
    // Away for each drain, back for each notify: the worst interleaving the
    // presence check alone can't stop.
    const { ran, left } = await serial(b, from, 1000, async (fn) => {
      clock.tick();
      await b.ctx.db.patch(sec()._id, { atMac: !fn.endsWith('drainHeldPushes'), lastSeenAt: Date.now() });
    });
    assert.equal(left, 0, `still ${left} queued after ${ran} callbacks`);
    assert.equal(b.scheduled.filter((s: any) => String(s.fn).endsWith('push.notify')).length, 33, 'each held push tried once');
    // The ones held again wait for his next leave.
    assert.ok(b.rows('threads').every((t: any) => t.pushHeldAt > start));
  } finally {
    clock.restore();
  }
});

test('Daybreak 148: a stale runner that checks in again before its drain runs keeps its pushes held', async () => {
  const b = memoryBackend();
  const now = Date.now();
  await secondary(b, 3, now - PRESENCE_FRESH_MS - 60_000);
  const from = b.scheduled.length;
  await call(b.ctx, sync.sendStaleHeldPushes, {});
  assert.equal(b.scheduled.length, from + 1, 'a drain was handed on');
  const sec = b.rows('runners').find((r: any) => r.runnerId === 'sec')!;
  await b.ctx.db.patch(sec._id, { lastSeenAt: Date.now() });
  await call(b.ctx, sync.drainHeldPushes, (b.scheduled[from] as any).args);
  assert.deepEqual(notified(b), []);
  assert.ok(b.rows('threads').every((t: any) => t.pushHeldAt !== undefined));
});

// Codex's review of the 148 fix: push.notify read that Mike was at the Mac,
// he left and the drain his leaving started finished, then notify held the
// push. Nothing would ever send it (the cron skips a runner that said he
// left). holdPush asks again and sends it to the away phones instead.
test('a push held just after Mike left goes to the away phones, not held for good', async () => {
  const b = memoryBackend();
  const now = Date.now();
  await secondary(b, 0, now);
  await b.ctx.db.insert('threads', { threadId: 'late', runnerId: 'sec', ...THREAD_BASICS, title: 'Late', view: 'inbox', needsYou: true });
  const t = await call(b.ctx, devices.threadForPush, { threadId: 'late' });
  assert.equal(t.atMac, true, 'notify read that he was there');
  const sec = b.rows('runners').find((r: any) => r.runnerId === 'sec')!;
  await b.ctx.db.patch(sec._id, { atMac: false });
  await call(b.ctx, devices.holdPush, { threadId: 'late' });
  assert.equal(b.rows('threads')[0].pushHeldAt, undefined, 'not held');
  assert.deepEqual(notified(b), [{ threadId: 'late', held: true, retried: true }]);
  // Still there: held as before.
  await b.ctx.db.patch(sec._id, { atMac: true });
  await call(b.ctx, devices.holdPush, { threadId: 'late' });
  assert.ok(b.rows('threads')[0].pushHeldAt > 0);
  assert.equal(notified(b).length, 1);
});

// verify-fix on that change: a runner there for every notify's read and away
// for every holdPush could keep one push bouncing between them. It goes back
// to notify once, and is held the second time.
test('a runner flipping presence between notify and holdPush bounces a push once at most', async () => {
  const b = memoryBackend();
  await secondary(b, 0, Date.now());
  await b.ctx.db.insert('threads', { threadId: 'flip', runnerId: 'sec', ...THREAD_BASICS, title: 'Flip', view: 'inbox', needsYou: true });
  const sec = () => b.rows('runners').find((r: any) => r.runnerId === 'sec')!;
  const from = b.scheduled.length;
  await b.ctx.scheduler.runAfter(0, { toString: () => 'internal.push.notify' }, { threadId: 'flip', held: true });
  let ran = 0;
  for (let i = from; i < b.scheduled.length && ran < 100; i++, ran++) {
    const s = b.scheduled[i] as any;
    // push.ts notify, held: there when it reads, gone by the hold.
    await b.ctx.db.patch(sec()._id, { atMac: true });
    const t = await call(b.ctx, devices.threadForPush, { threadId: s.args.threadId });
    await b.ctx.db.patch(sec()._id, { atMac: false });
    if (t.atMac) await call(b.ctx, devices.holdPush, { threadId: s.args.threadId, ...(s.args.retried ? { retried: true } : {}) });
  }
  assert.equal(ran, 2, 'the push and its one retry');
  assert.ok(b.rows('threads')[0].pushHeldAt > 0, 'then held, for his next leave');
});

// Codex's third review: a retried push held after Mike's leave's drain had
// finished (he's away, so nothing else drains it) goes with the next cron.
test('a push held for a runner that said Mike left goes with the next cron', async () => {
  const b = memoryBackend();
  const now = Date.now();
  await secondary(b, 0, now);
  await b.ctx.db.insert('threads', { threadId: 'late', runnerId: 'sec', ...THREAD_BASICS, title: 'Late', view: 'inbox', needsYou: true });
  const sec = b.rows('runners').find((r: any) => r.runnerId === 'sec')!;
  await b.ctx.db.patch(sec._id, { atMac: false });
  await call(b.ctx, devices.holdPush, { threadId: 'late', retried: true });
  assert.ok(b.rows('threads')[0].pushHeldAt > 0, 'held by the retry');
  await cron(b);
  assert.deepEqual(notified(b), [{ threadId: 'late', held: true }]);
  assert.equal(b.rows('threads')[0].pushHeldAt, undefined);
});
