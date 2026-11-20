import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { call, load, memoryBackend } from './convex-memory.ts';
import { makeHarness, tick } from './fakes.ts';
import { makePng } from './png.ts';
import { ConvexSync, type Command } from '../../src/sync.ts';
import { nullLogger } from '../../src/log.ts';
import { phoneCommands } from '../../src/handover.ts';
import { phoneReview } from '../../src/phone-reviews.ts';

// Real runner -> real backend validators -> phone command -> runner. Only
// the model, clock, storage and network are fakes; no private thread data.
export async function phoneReviewScenario() {
  const owner = 'review-owner', token = 'review-phone';
  process.env.RUNNER_KEY = owner;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  const modules = { sync: load('sync'), phone: load('phone') };
  const { sha256 } = load('lib');
  await b.ctx.db.insert('tokens', { hash: await sha256(token), name: 'phone', kind: 'phone', createdAt: Date.now(), expiresAt: Date.now() + 100000 });
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'Compare layouts', accountId: 'claude-3' });
  h.adapter.last.init();
  const file = path.join(h.home, 'preview.png');
  fs.writeFileSync(file, makePng(120, 80));
  const review = h.runner.createReview(thread.id, { title: 'Layout', recommended: 'A', options: [
    { id: 'A', title: 'First', path: file, shots: [{ path: file, title: 'Detail' }] },
    { id: 'Café', title: 'Today', path: file, reference: true },
  ] }).review;
  h.adapter.last.result();
  let push: ((value: unknown) => void) | undefined;
  let uploads = 0;
  const refused: string[] = [];
  const sync = new ConvexSync({
    config: { enabled: true, url: 'https://example.convex.cloud', runnerId: 'reviewrunner', name: 'Test' },
    key: owner, home: h.home, runner: h.runner, commands: phoneCommands(h.runner), version: 'test', startedAt: new Date(h.clock.now()).toISOString(),
    clock: h.clock, log: nullLogger,
    post: async (_kind, fn, args) => {
      const [mod, name] = fn.split(':') as ['sync' | 'phone', string];
      try { return await call(b.ctx, modules[mod][name], args); }
      catch (error) { refused.push(`${fn}: ${error}`); throw error; }
    },
    upload: async (_url, bytes) => { uploads++; return b.ctx.storage.store(new Blob([Uint8Array.from(bytes)])); },
    subscriber: { subscribe: (fn, _args, onUpdate) => {
      if (fn === 'sync:pendingCommands') push = onUpdate;
      return () => {};
    }, close: () => {} },
  });
  sync.start();
  try {
    await sync.flushNow();
    await sync.flushNow();
    assert.ok(push);
    const request = async (name: string, args: Record<string, unknown>) => {
      const commandId = await call(b.ctx, modules.phone[name], { token, threadId: thread.id, ...args });
      const pending = await call(b.ctx, modules.sync.pendingCommands, { key: owner, runnerId: 'reviewrunner' }) as Command[];
      push!(pending);
      for (let i = 0; i < 100; i++) {
        await tick();
        const status = await call(b.ctx, modules.phone.command, { token, commandId });
        if (status.state === 'done' || status.state === 'failed') return status;
      }
      throw new Error('command did not finish');
    };
    const list = await request('designReviews', {});
    assert.equal(list.state, 'done');
    assert.equal(JSON.parse(list.result).reviews[0].id, review.id);
    await sync.flushNow();
    const sources = phoneReview(review).options.flatMap(o => o.shots.map(s => s.src));
    // Nothing of the review's goes up until the phone opens it.
    assert.equal(uploads, 0, 'no stills before the phone asks for the review');
    assert.deepEqual(await call(b.ctx, modules.phone.reviewImages, { token, threadId: thread.id, sources }), []);
    const read = await request('designReviews', { reviewId: review.id.slice(0, 8) });
    assert.equal(read.state, 'done');
    // As JSON text: its notes are keyed by option ids Convex can't take as keys.
    assert.deepEqual(JSON.parse(read.result).review, phoneReview(review));
    await sync.flushNow();
    const images = await call(b.ctx, modules.phone.reviewImages, { token, threadId: thread.id, sources });
    assert.equal(images.length, new Set(sources).size, JSON.stringify({ refused, uploads, expected: sources.length }));
    assert.ok(images.every((i: { url: string }) => i.url));
    // Named in Convex by src alone: no path on the Mac goes up.
    for (const row of await b.ctx.db.query('replyImages').collect()) assert.ok(row.src?.startsWith('review:') && row.path === row.src, JSON.stringify(row));
    await assert.rejects(call(b.ctx, modules.phone.designReviews, { token: 'invalid', threadId: thread.id }));
    await assert.rejects(call(b.ctx, modules.phone.reviewImages, { token, threadId: 'missing', sources }));
    assert.equal((await request('respondReview', { reviewId: review.id, revision: 0, draft: { pickedId: 'Café', notes: [] } })).state, 'failed');
    const saved = h.runner.saveReview(thread.id, review.id, 0, { notes: { A: 'Saved on the Mac' } }).review;
    assert.equal((await request('respondReview', { reviewId: review.id, revision: 0, draft: { pickedId: 'A', notes: [] } })).state, 'failed');
    const response = { pickedIds: ['A'], notes: [{ id: 'Café', text: 'Keep its spacing' }], reply: 'Build the first one' };
    assert.equal((await request('respondReview', { reviewId: review.id, revision: saved.revision, draft: response })).state, 'done');
    const count = () => h.runner.events(thread.id, {}).events.filter(e => e.type === 'user.message' && e.reviewId === review.id).length;
    const before = count();
    assert.equal((await request('respondReview', { reviewId: review.id, revision: saved.revision, draft: response })).state, 'done');
    assert.equal(count(), before, 'retry does not deliver another answer');
    assert.equal(h.runner.getReview(thread.id, review.id).review.status, 'answered');
    assert.equal(h.runner.getReview(thread.id, review.id).review.response?.notes['Café'], 'Keep its spacing');
    assert.equal(JSON.parse((await request('designReviews', {})).result).reviews.length, 0);
    // An answered review's short link still opens it, read-only.
    const old = await request('designReviews', { reviewId: review.id.slice(0, 8) });
    assert.equal(old.state, 'done');
    const answered = JSON.parse(old.result).review;
    assert.equal(answered.status, 'answered');
    assert.deepEqual(answered.draft.notes, { 'Café': 'Keep its spacing' });
    // A review's stills aren't the thread's own pictures.
    assert.ok((await call(b.ctx, modules.phone.images, { token, threadId: thread.id, from: 0 }) as { src?: string }[]).every((i) => !i.src?.startsWith('review:')));
    assert.deepEqual(refused, [], 'all sync writes satisfy the backend schema and validators');
  } finally { await sync.stop(); }
}
