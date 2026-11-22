// A thread that stops needing Mike after a push went out for it sends the
// phones a silent push:clear, so they take its notification down rather than
// leaving a pile of ones he's already dealt with (20 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';

const sync = load('sync');
const OWNER = 'owner-key';
process.env.RUNNER_KEY = OWNER;

const scheduled = (b: ReturnType<typeof memoryBackend>, name: string) => b.scheduled.filter((s: any) => String(s.fn).endsWith(name)).map((s: any) => s.args);
const write = (b: ReturnType<typeof memoryBackend>, needsYou: boolean) =>
  call(b.ctx, sync.upsertThreads, { key: OWNER, threads: [{ threadId: 'T', runnerId: 'mac1', ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou }] });

test('a pushed thread that stops needing him clears its notification, once', async () => {
  const b = memoryBackend();
  await write(b, false);
  await write(b, true);
  assert.deepEqual(scheduled(b, 'push.notify'), [{ threadId: 'T' }]);
  assert.deepEqual(scheduled(b, 'push.clear'), []);
  await write(b, false);
  assert.deepEqual(scheduled(b, 'push.clear'), [{ threadId: 'T' }]);
  await write(b, false);
  assert.equal(scheduled(b, 'push.clear').length, 1, 'only on the change');
});

test('no clear for a thread that never had a push, or had one over a day ago', async () => {
  const b = memoryBackend();
  await b.ctx.db.insert('threads', { threadId: 'T', runnerId: 'mac1', ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: true });
  await write(b, false);
  assert.deepEqual(scheduled(b, 'push.clear'), [], 'never pushed');
  const row = b.rows('threads')[0] as any;
  await b.ctx.db.patch(row._id, { needsYou: true, pushedAt: Date.now() - 25 * 60 * 60_000 });
  await write(b, false);
  assert.deepEqual(scheduled(b, 'push.clear'), [], 'pushed too long ago');
});
