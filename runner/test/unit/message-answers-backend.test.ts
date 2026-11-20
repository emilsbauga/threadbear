// A message that answered a card's asks carries them (`answers`, backend API
// 89), so the phone draws each question small over its answer, as the Mac
// does (Mike, 18 Nov). Codex's review of that: the halves are scrubbed one by
// one, so a secret only the whole text's scrub catches could stay in them,
// and the copy could push a long message past a runner key's row cap and lose
// it. They're kept only as the stored text says them, and they're what goes
// when the row is too big. These play that through the backend's own
// functions in the in-memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const MINI = 'cb921b2447ea';
const TOKEN = 'phone-token';
const DAY = 24 * 60 * 60_000;

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  const now = Date.now();
  await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'iphone', kind: 'phone', expiresAt: now + 100 * DAY, createdAt: now });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07' });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07-done' });
  await b.ctx.db.insert('runners', { runnerId: MINI, name: MINI, version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: now });
  await call(b.ctx, sync.upsertThreads, { key: OWNER, threads: [{ threadId: 'A', runnerId: 'laptop000001', ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  await call(b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'B', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  return b;
}

const page = async (s: Awaited<ReturnType<typeof setup>>, threadId: string) => (await call(s.ctx, phone.messages, { token: TOKEN, threadId })).messages as { seq: number; text: string; answers?: { action: string; answer: string }[] }[];

test('answers the text starts with reach the phone; ones it does not say, or on a reply, are dropped', async () => {
  const s = await setup();
  const one = [{ action: 'Refuse the merge?', answer: 'Refuse it' }];
  const two = [{ action: 'Merge it?', answer: 'Not yet' }, { action: 'Add the key', answer: 'done\nin Settings' }];
  await call(s.ctx, sync.appendMessages, {
    key: OWNER,
    messages: [
      { threadId: 'A', seq: 1, role: 'user', text: 'Refuse the merge?\nRefuse it', answers: one, at: 'now' },
      { threadId: 'A', seq: 2, role: 'user', text: '1. Merge it?\n   Not yet\n\n2. Add the key\n   done\n   in Settings\n\nthanks\n\n[1 picture]', answers: two, at: 'now' },
      // What a whole-text scrub hid and the halves' didn't.
      { threadId: 'A', seq: 3, role: 'user', text: 'password:\n[redacted]', answers: [{ action: 'password:', answer: 'hunter2hunter2!' }], at: 'now' },
      { threadId: 'A', seq: 4, role: 'assistant', text: 'Refuse the merge?\nRefuse it', answers: one, at: 'now' },
      { threadId: 'A', seq: 5, role: 'user', text: 'Refuse the merge?\nRefuse it please', answers: one, at: 'now' },
    ],
  });
  const rows = await page(s, 'A');
  assert.deepEqual(rows.map((r) => r.answers), [one, two, undefined, undefined, undefined]);
  assert.ok(!JSON.stringify(s.rows('messages')).includes('hunter2'));
});

test("a runner key's long answered message is kept without its answers when they'd push it past the row cap", async () => {
  const s = await setup();
  const answer = 'x'.repeat(7_000);
  await call(s.ctx, sync.appendMessages, { key: MINI_KEY, messages: [{ threadId: 'B', seq: 1, role: 'user', text: `Why?\n${answer}`, answers: [{ action: 'Why?', answer }], at: 'now' }] });
  const rows = await page(s, 'B');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.text, `Why?\n${answer}`);
  assert.equal(rows[0]!.answers, undefined);
});

test('the stored-rows scrub drops answers its text no longer says, even when nothing else changed, and only when applied', async () => {
  const s = await setup();
  // A row from before the check, its answer saying what the text hid.
  const id = await s.ctx.db.insert('messages', { threadId: 'A', seq: 9, role: 'user', text: 'password:\n[redacted]', answers: [{ action: 'password:', answer: 'hunter2hunter2!' }], at: 'now' });
  const dry = await call(s.ctx, sync.scrubStoredBatch, { key: OWNER, table: 'messages', cursor: null, apply: false });
  assert.deepEqual(dry.changed, [String(id)]);
  assert.ok(JSON.stringify(s.rows('messages')).includes('hunter2'));
  await call(s.ctx, sync.scrubStoredBatch, { key: OWNER, table: 'messages', cursor: null, apply: true });
  assert.ok(!JSON.stringify(s.rows('messages')).includes('hunter2'));
  assert.equal(s.rows('messages').find((r) => r._id === id)?.text, 'password:\n[redacted]');
});
