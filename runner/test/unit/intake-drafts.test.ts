import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from '../helpers/fakes.ts';
import { intakeThreadId } from '../../src/intake-record.ts';
const item = { clientId: 'nanobot', receiptId: 'receipt123', receivedAt: 1794129814723,
  message: { messageId: 'email:robby:INBOX:42:1', source: 'email' as const, sourceMessageId: '42:1', text: 'Subject: Task\n\nUnmodified text', sentAt: '2026-11-08T09:00:00Z', sender: 'Someone' } };
test('intake creates one complete dormant draft, with provenance and no session, turn or worktree', () => {
  const h = makeHarness();
  const id = h.runner.createIntakeDraft(item);
  assert.equal(id, intakeThreadId(item.clientId, item.receiptId));
  const thread = h.runner.get(id);
  assert.equal(thread.backlog?.text, item.message.text);
  assert.equal(thread.lastSeq, 0);
  assert.equal(thread.status, 'idle');
  assert.equal(thread.live, false);
  assert.ok(thread.highlightsAt);
  assert.equal(h.adapter.sessions.length, 0);
  assert.equal(h.store.load(id)?.intake?.receiptId, item.receiptId);
  assert.equal(h.store.load(id)?.sessionUsed, false);
  assert.equal(h.store.load(id)?.worktree, undefined);
  assert.equal(h.runner.highlights(id).highlights.some(x => x.title === 'Message source'), true);
  h.runner.saveDraft(id, 'User edited text', [], 1);
  assert.equal(h.runner.createIntakeDraft(item), id);
  assert.equal(h.runner.get(id).backlog?.text, 'User edited text');
  const restarted = h.restart();
  assert.equal(restarted.runner.createIntakeDraft(item), id);
  assert.equal(restarted.adapter.sessions.length, 0);
  restarted.runner.delete(id);
  assert.equal(restarted.runner.createIntakeDraft(item), id);
  assert.throws(() => restarted.runner.get(id), /not found/i);
});
test('crash after initial draft write but before completion marker recovers without a duplicate', () => {
  const h = makeHarness();
  const id = h.runner.createIntakeDraft(item);
  fs.rmSync(path.join(h.home, 'intake-imports'), { recursive: true });
  const next = h.restart();
  assert.equal(next.runner.createIntakeDraft(item), id);
  assert.equal(next.runner.list().length, 1);
  assert.equal(next.runner.get(id).backlog?.text, item.message.text);
  assert.equal(next.adapter.sessions.length, 0);
});
test('deletion after that crash preserves completion', () => {
  const h = makeHarness();
  const id = h.runner.createIntakeDraft(item);
  fs.rmSync(path.join(h.home, 'intake-imports'), { recursive: true });
  const next = h.restart();
  next.runner.delete(id);
  const third = next.restart();
  assert.equal(third.runner.createIntakeDraft(item), id);
  assert.equal(third.runner.list().length, 0);
});
test('thread ID collisions and corrupt completion markers fail without overwriting data', () => {
  const h = makeHarness();
  const ordinary = h.runner.createDraft({ text: 'Existing ordinary draft' }).thread;
  const original = h.store.load(ordinary.id)!;
  const id = intakeThreadId(item.clientId, item.receiptId);
  h.store.create({ ...original, id });
  assert.throws(() => h.runner.createIntakeDraft(item), /already in use/);
  assert.equal(h.store.load(id)?.backlog?.text, 'Existing ordinary draft');
  const other = makeHarness();
  const imported = other.runner.createIntakeDraft(item);
  fs.writeFileSync(path.join(other.home, 'intake-imports', imported + '.json'), '{broken');
  assert.throws(() => other.runner.createIntakeDraft(item));
  assert.equal(other.runner.list().length, 1);
});
test('atomic initial record creation never replaces an existing thread record', () => {
  const h = makeHarness();
  const id = h.runner.createIntakeDraft(item);
  const rec = h.store.load(id)!;
  assert.throws(() => h.store.create({ ...rec, title: 'Wrong replacement' }), /EEXIST/);
  assert.notEqual(h.store.load(id)?.title, 'Wrong replacement');
});

test('attachment-only intake owns files, keeps them through old-client autosave and supplies local paths only on send', async () => {
  const h = makeHarness();
  const incoming = { ...item, message: { ...item.message, text: '' }, attachments: [{ id: 'a', name: 'report.txt', mediaType: 'text/plain', size: 3, sha256: 'a'.repeat(64) }] };
  assert.throws(() => h.runner.createIntakeDraft(incoming), /attachment/i);
  const id = intakeThreadId(incoming.clientId, incoming.receiptId);
  const dir = path.join(h.home, 'threads', id, 'attachments'); fs.mkdirSync(dir, { recursive: true });
  const file = { ...incoming.attachments[0], path: path.join(dir, 'local.txt') }; fs.writeFileSync(file.path, 'abc');
  h.runner.createIntakeDraft(incoming, [file]);
  assert.deepEqual(h.runner.get(id).backlog?.attachments, [file]);
  assert.equal(h.adapter.sessions.length, 0);
  h.runner.saveDraft(id, '', [], 1);
  assert.deepEqual(h.runner.get(id).backlog?.attachments, [file]);
  h.runner.send(id, '', []);
  await Promise.resolve();
  assert.equal(h.runner.get(id).backlog, undefined);
  const events = h.events(id);
  const user = events.find(e => e.type === 'user.message');
  assert.equal(user?.text, '');
  assert.deepEqual(user?.attachments, [file]);
  assert.ok(h.runner.forAgent({ text: '', attachments: [file] }).includes(file.path));
});

test('explicit empty attachments removes them and missing files never promote a draft', () => {
  const h = makeHarness();
  const id = h.runner.createIntakeDraft(item);
  const file = { id: 'a', path: '/missing', name: 'missing.txt', mediaType: 'text/plain', size: 1, sha256: 'a'.repeat(64) };
  const rec = h.store.load(id)!; rec.backlog!.attachments = [file]; h.store.save(rec);
  const next = h.restart();
  assert.throws(() => next.runner.send(id, 'Start', []), /attachment|file/i);
  assert.ok(next.runner.get(id).backlog);
  next.runner.saveDraft(id, 'Start', [], 1, []);
  assert.deepEqual(next.runner.get(id).backlog?.attachments, []);
});

test('a supported image attachment reaches native provider image input only after Send', async () => {
  const h = makeHarness();
  const incoming = { ...item, attachments: [{ id: 'picture', name: 'picture.png', mediaType: 'image/png', size: 68, sha256: 'a'.repeat(64) }] };
  const id = intakeThreadId(item.clientId, item.receiptId);
  const dir = path.join(h.home, 'threads', id, 'attachments'); fs.mkdirSync(dir, { recursive: true });
  const file = { ...incoming.attachments[0], path: path.join(dir, 'picture.png') };
  fs.writeFileSync(file.path, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  h.runner.createIntakeDraft(incoming, [file]); assert.equal(h.adapter.sessions.length, 0);
  h.runner.send(id, item.message.text); await Promise.resolve();
  assert.equal(h.adapter.sessions[0].sent[0].images[0].path, file.path);
  assert.ok(h.adapter.sessions[0].sent[0].text.includes(file.path));
});
