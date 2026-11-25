// A thread that stops needing Mike after a push went out for it sends the
// phones a silent push:clear, so they take its notification down rather than
// leaving a pile of ones he's already dealt with (20 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';
import { toThreadDoc } from '../../src/sync.ts';

const sync = load('sync');
const devices = load('devices');
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const MINI = 'cb921b2447ea';
const MINI_KEY = 'tbr_mac-mini';
const OWNER = 'owner-key';
process.env.RUNNER_KEY = OWNER;

const scheduled = (b: ReturnType<typeof memoryBackend>, name: string) => (b.scheduled as { fn: unknown; args: unknown }[]).filter((s) => String(s.fn).endsWith(name)).map((s) => s.args);
const write = (b: ReturnType<typeof memoryBackend>, needsYou: boolean) =>
  call(b.ctx, sync.upsertThreads, { key: OWNER, threads: [{ threadId: 'T', runnerId: 'mac1', ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou }] });

// push:notify delivering the alert to a phone (devices:alerted), which is
// what makes a thread's notification one to clear.
const delivered = (b: ReturnType<typeof memoryBackend>, threadId = 'T') => call(b.ctx, devices.alerted, { threadId });

test('a pushed thread that stops needing him clears its notification, once', async () => {
  const b = memoryBackend();
  await write(b, false);
  await write(b, true);
  assert.deepEqual(scheduled(b, 'push.notify'), [{ threadId: 'T' }]);
  await delivered(b);
  assert.deepEqual(scheduled(b, 'push.clear'), []);
  await write(b, false);
  assert.deepEqual(scheduled(b, 'push.clear'), [{ threadId: 'T' }]);
  await write(b, false);
  assert.equal(scheduled(b, 'push.clear').length, 1, 'only on the change');
});

test('no clear for a thread whose alert never reached a phone, or reached one over a day ago', async () => {
  const b = memoryBackend();
  await b.ctx.db.insert('threads', { threadId: 'T', runnerId: 'mac1', ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: true, pushedAt: Date.now() });
  await write(b, false);
  assert.deepEqual(scheduled(b, 'push.clear'), [], 'pushed, but nothing delivered (held, refused, no phones)');
  const row = b.rows('threads')[0] as { _id: string };
  await b.ctx.db.patch(row._id, { needsYou: true, alertedAt: Date.now() - 25 * 60 * 60_000 });
  await write(b, false);
  assert.deepEqual(scheduled(b, 'push.clear'), [], 'delivered too long ago');
});

// Codex Security, 22 Nov 2026 (finding 169) and the cross-lab reviews of its
// fix: every needsYou true-to-false flip within a day of a push cleared it
// again, and a flip back that sends no alert (inside the push cooldown, past
// a runner's allowance, every phone holding it while he's at the Mac) left
// it clearable, so a runner could keep a thread toggling and make a silent
// clear for every phone each time, using up the backend's relay allowance
// with nothing on any screen. Now a clear needs an alert some phone got,
// and uses it up.
test('one delivered alert takes one clear: toggling the thread without another clears nothing more', async () => {
  const b = memoryBackend();
  await write(b, false);
  await write(b, true);
  await delivered(b);
  await write(b, false);
  assert.equal(scheduled(b, 'push.clear').length, 1);
  for (let k = 0; k < 5; k++) {
    await write(b, true);
    await write(b, false);
  }
  assert.equal(scheduled(b, 'push.notify').length, 1, 'within the cooldown: no new push');
  assert.equal(scheduled(b, 'push.clear').length, 1, 'nothing new on the phone to take down');
  const row = b.rows('threads')[0]!;
  await b.ctx.db.patch(row._id, { pushedAt: row.pushedAt - 60_000 });
  await write(b, true);
  assert.equal(scheduled(b, 'push.notify').length, 2, 'a new push after the cooldown');
  await write(b, false);
  assert.equal(scheduled(b, 'push.clear').length, 1, 'not delivered yet, so nothing to clear');
  await write(b, true);
  await delivered(b);
  await write(b, false);
  assert.equal(scheduled(b, 'push.clear').length, 2, 'an alert that went out gets its clear');
});

test('an alert delivered after the thread stopped needing him is cleared right away', async () => {
  const b = memoryBackend();
  await write(b, false);
  await write(b, true);
  await write(b, false);
  assert.equal(scheduled(b, 'push.clear').length, 0, 'not delivered yet');
  await delivered(b);
  assert.deepEqual(scheduled(b, 'push.clear'), [{ threadId: 'T' }]);
  assert.equal(b.rows('threads')[0].alertedAt, undefined, 'and nothing left for a later flip to clear');
  await write(b, true);
  await write(b, false);
  assert.equal(scheduled(b, 'push.clear').length, 1);
  // One still marked from an earlier alert is used up by that clear too.
  const row = b.rows('threads')[0] as { _id: string };
  await b.ctx.db.patch(row._id, { needsYou: false, alertedAt: Date.now() });
  await delivered(b);
  assert.equal(scheduled(b, 'push.clear').length, 2);
  assert.equal(b.rows('threads')[0].alertedAt, undefined);
  await write(b, true);
  await write(b, false);
  assert.equal(scheduled(b, 'push.clear').length, 2, 'nothing left to clear');
});

// A runner key's pushes and clears share 10 a minute (sync.ts pushAllowed):
// a clear it's refused doesn't use the alert up, so a later one still can.
test('a runner past its push allowance keeps its alert to clear later', async (tc) => {
  let now = Date.parse('2026-11-22T10:00:05Z');
  tc.mock.method(Date, 'now', () => now);
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  const put = (threadId: string, needsYou: boolean) => call(b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId, runnerId: MINI, ...THREAD_BASICS, title: threadId, view: 'inbox', needsYou }] });
  await put('T', false);
  await put('T', true);
  await delivered(b);
  for (let k = 0; k < 9; k++) {
    await put(`x${k}`, false);
    await put(`x${k}`, true);
  }
  assert.equal(scheduled(b, 'push.notify').length, 10);
  await put('T', false);
  assert.equal(scheduled(b, 'push.clear').length, 0, 'refused');
  const t = () => b.rows('threads').find((r) => r.threadId === 'T')!;
  assert.notEqual(t().alertedAt, undefined, 'still there to clear');
  now += 60_000;
  await put('T', true);
  await put('T', false);
  assert.equal(scheduled(b, 'push.clear').length, 1, 'cleared the next minute');
});

// Review, 23 Nov 2026: archiving or hibernating a thread didn't change its
// row's needsYou, so a push held while Mike was at the Mac still reached his
// phone when he left, and one already delivered stayed. The runner's row
// now says a put-away thread doesn't need him (runner/src/sync.ts
// phoneNeedsYou), which the backend's push rules then follow.
test('a thread put away sends no push, its held push stays home, a delivered one comes down, and waking pushes again', async () => {
  const b = memoryBackend();
  const now = Date.now();
  await b.ctx.db.insert('runners', { runnerId: 'mac1', name: 'mac1', version: '1', lastSeenAt: now, startedAt: new Date(now).toISOString(), draining: false, threadCount: 2, atMac: true, atMacAt: now });
  const iso = (ms: number) => new Date(ms).toISOString();
  const summary = (id: string, extra: Record<string, unknown> = {}) => ({
    id, title: id, cwd: '/w', accountId: 'claude-3', provider: 'claude' as const, permissionMode: 'full' as const, status: 'idle' as const, live: false, needsYou: true,
    createdAt: iso(now - 60_000), updatedAt: iso(now), lastActivityAt: iso(now), preview: 'p', lastSeq: 3, lastSeenSeq: 1, ...extra,
  });
  const put = (id: string, extra: Record<string, unknown> = {}) => call(b.ctx, sync.upsertThreads, { key: OWNER, threads: [toThreadDoc(summary(id, extra), 'mac1', now)] });
  // Archived after a push reached the phone: it comes down.
  await put('A', { needsYou: false });
  await put('A');
  assert.deepEqual(scheduled(b, 'push.notify'), [{ threadId: 'A' }]);
  await delivered(b, 'A');
  await put('A', { archivedAt: iso(now) });
  assert.deepEqual(scheduled(b, 'push.clear'), [{ threadId: 'A' }]);
  // Hibernated with its push held while he's at the Mac: leaving sends nothing.
  await put('H', { needsYou: false });
  await b.ctx.db.patch((b.rows('threads') as unknown as { _id: string; threadId: string }[]).find((t) => t.threadId === 'H')!._id, { pushHeldAt: now - 1000 });
  await put('H', { snoozedUntil: iso(now + 3_600_000) });
  await call(b.ctx, sync.setPresence, { key: OWNER, runnerId: 'mac1', atMac: false });
  assert.deepEqual((scheduled(b, 'push.notify') as { threadId: string }[]).filter((a) => a.threadId === 'H'), [], 'hibernated: no push');
  // Woken (the runner clears snoozedUntil and writes the row): it pushes.
  await put('H');
  assert.deepEqual((scheduled(b, 'push.notify') as { threadId: string }[]).filter((a) => a.threadId === 'H'), [{ threadId: 'H' }]);
});
