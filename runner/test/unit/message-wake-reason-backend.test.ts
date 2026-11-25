// A runner's own message says why it sent it (`wakeReason`, backend API 98),
// so the phones, the website and another Mac head the turn it starts with it
// ("Moments later · Codex answered") as the Mac does (nightly parity run,
// 23 Nov). Codex's review: the owner's key skipped the row cap, so the
// reason went in at any length. It's one short line from any key, and only
// on a runner's message. Played through the backend's own functions in the
// in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const TOKEN = 'phone-token';
const DAY = 24 * 60 * 60_000;

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');

test("a runner's message keeps one short line of why, from the owner's key too; anyone else's has none", async () => {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  const now = Date.now();
  await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'iphone', kind: 'phone', expiresAt: now + 100 * DAY, createdAt: now });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07' });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07-done' });
  await call(b.ctx, sync.upsertThreads, { key: OWNER, threads: [{ threadId: 'A', runnerId: 'laptop000001', ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const row = (seq: number, wakeReason: string, origin = 'runner') => ({ threadId: 'A', seq, role: 'user', text: 'For everyone: Codex answered.', origin, wakeReason, at: 'now' });
  await call(b.ctx, sync.appendMessages, {
    key: OWNER,
    messages: [row(1, 'Codex answered'), row(2, 'x'.repeat(1000)), row(3, 'Codex answered\nand more'), row(4, '   '), row(5, 'Codex answered', 'phone')],
  });
  const rows = (await call(b.ctx, phone.messages, { token: TOKEN, threadId: 'A' })).messages as { wakeReason?: string }[];
  assert.equal(rows[0]!.wakeReason, 'Codex answered');
  assert.ok(Buffer.byteLength(rows[1]!.wakeReason!) <= 200);
  assert.equal(rows[2]!.wakeReason, 'Codex answered…');
  assert.deepEqual([rows[3]!.wakeReason, rows[4]!.wakeReason], [undefined, undefined]);
});
