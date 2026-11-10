import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick } from '../helpers/fakes.ts';

test('Backlog saves and restores an unsent prompt without starting a session or turn', async () => {
  const h = makeHarness();
  const { thread } = h.runner.createDraft({ text: 'Prepare a homepage plan', accountId: 'claude-3' });
  assert.deepEqual(thread.backlog, { text: 'Prepare a homepage plan', images: [], revision: 1 });
  assert.equal(thread.live, false);
  assert.equal(thread.needsYou, false);
  assert.equal(thread.status, 'idle');
  assert.equal(thread.lastSeq, 0);
  assert.equal(h.adapter.sessions.length, 0);
  assert.equal(h.runner.list().some(t => t.id === thread.id), true);
  const saved = h.runner.saveDraft(thread.id, 'Use the second design', [], 1).thread;
  assert.equal(saved.backlog?.revision, 2);
  assert.throws(() => h.runner.saveDraft(thread.id, 'stale', [], 1), /changed/);
  h.runner.flush();
  const next = h.restart();
  await tick();
  assert.deepEqual(next.runner.get(thread.id).backlog, saved.backlog);
  assert.equal(next.adapter.sessions.length, 0);
  next.runner.send(thread.id, 'Use the second design');
  assert.equal(next.runner.get(thread.id).backlog, undefined);
  assert.equal(next.adapter.sessions.length, 1);
  assert.equal(next.adapter.last.sent[0].text, 'Use the second design');
  assert.throws(() => next.runner.saveDraft(thread.id, 'too late', [], 2), /Backlog/);
});

test('Backlog owns its attachments and a failed first send leaves the draft intact', () => {
  const h = makeHarness();
  const image = path.join(h.home, 'capture.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=', 'base64'));
  const { thread } = h.runner.createDraft({ text: '[Picture 1] Check this', images: [{ path: image, mediaType: 'image/png' }] });
  const draft = thread.backlog!;
  assert.equal(path.dirname(draft.images[0].path), h.store.mediaDir(thread.id));
  fs.unlinkSync(image);
  assert.ok(fs.existsSync(draft.images[0].path));
  assert.throws(() => h.runner.send(thread.id, 'Check', [{path: image, mediaType: 'image/png'}]), /not found/);
  assert.deepEqual(h.runner.get(thread.id).backlog, draft);
  h.runner.update({ threadId: thread.id, archived: true });
  assert.deepEqual(h.runner.get(thread.id).backlog, draft);
  h.runner.update({ threadId: thread.id, archived: false });
  h.runner.send(thread.id, draft.text, [], { origin: 'phone' });
  assert.equal(h.runner.get(thread.id).backlog, undefined);
  assert.equal(h.adapter.last.sent[0].images.length, 1);
});


test('invalid draft creation does not leave an idle thread behind', () => {
  const h = makeHarness();
  const before = h.runner.list().length;
  assert.throws(() => h.runner.createDraft({ text: 'bad', images: [{path: h.home, mediaType: 'image/png'}] }));
  assert.equal(h.runner.list().length, before);
});

for (const archived of [false, true]) {
  test(`deleting ${archived ? 'archived' : 'Backlog'} draft removes its prompt and owned media from active storage`, async () => {
    const h = makeHarness();
    const image = path.join(h.home, 'delete-test.png');
    fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=', 'base64'));
    const { thread } = h.runner.createDraft({ text: 'Disposable draft', images: [{ path: image, mediaType: 'image/png' }] });
    if (archived) h.runner.update({ threadId: thread.id, archived: true });
    h.runner.flush();
    h.runner.delete(thread.id);
    h.runner.flush();
    assert.throws(() => h.runner.get(thread.id), /not found/i);
    assert.equal(fs.existsSync(h.store.threadDir(thread.id)), false);
    assert.equal(fs.existsSync(thread.backlog!.images[0].path), false);
    const trashed = fs.readdirSync(path.join(h.home, 'trash')).find(name => name.startsWith(thread.id));
    assert.ok(trashed);
    assert.ok(fs.existsSync(path.join(h.home, 'trash', trashed, 'media', path.basename(thread.backlog!.images[0].path))));
    const next = h.restart();
    await tick();
    assert.equal(next.runner.list(['inbox', 'archived']).some(t => t.id === thread.id), false);
    assert.equal(next.adapter.sessions.length, 0);
  });
}


test('existing inbox conversations move to Backlog durably without rewriting their prompt or history', async () => {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'Original request' });
  await tick();
  h.adapter.last.result();
  await tick();
  const before = h.runner.get(thread.id);
  const moved = h.runner.update({ threadId: thread.id, backlogged: true }).thread;
  assert.equal(moved.backlogged, true);
  assert.equal(moved.backlog, undefined);
  assert.equal(moved.lastSeq, before.lastSeq);
  assert.equal(moved.preview, before.preview);
  h.runner.flush();
  const next = h.restart();
  await tick();
  assert.equal(next.runner.get(thread.id).backlogged, true);
  assert.equal(next.adapter.sessions.length, 0);
  next.runner.update({ threadId: thread.id, archived: true });
  next.runner.update({ threadId: thread.id, archived: false });
  assert.equal(next.runner.get(thread.id).backlogged, true);
  next.runner.update({ threadId: thread.id, backlogged: false });
  assert.equal(next.runner.get(thread.id).backlogged, undefined);
  next.runner.update({ threadId: thread.id, backlogged: true });
  assert.throws(() => next.runner.send(thread.id, 'missing', [{ path: '/missing.png', mediaType: 'image/png' }]), /not found/);
  assert.equal(next.runner.get(thread.id).backlogged, true);
  next.runner.send(thread.id, 'Continue here');
  assert.equal(next.runner.get(thread.id).backlogged, undefined);
});

test('moving a busy thread or an unsent draft to Backlog is refused without mutation', () => {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'Working' });
  assert.throws(() => h.runner.update({ threadId: thread.id, backlogged: true, title: 'Changed' }), /idle|running|busy/i);
  assert.equal(h.runner.get(thread.id).title, thread.title);
  const draft = h.runner.createDraft({ text: 'Unsent' }).thread;
  assert.throws(() => h.runner.update({ threadId: draft.id, backlogged: false }), /draft|unsent/i);
});
