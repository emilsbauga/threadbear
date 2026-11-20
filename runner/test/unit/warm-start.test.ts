// Warm start (runner/warm-start.ts): a new thread's CLI started while its
// first message is still being written, and taken by the thread when it's
// sent with the same settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir, type Harness } from '../helpers/fakes.ts';
import { CallerGate } from '../../src/rpc-gate.ts';

function setup(on = true): Harness & { work: string } {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ experiments: { warmStart: on } }));
  const h = makeHarness(home);
  const work = tmpDir('tb-warm-work-');
  return { ...h, work };
}

test('with the experiment off, warming starts nothing', () => {
  const h = setup(false);
  assert.deepEqual(h.runner.warm({ cwd: h.work }, 1), {});
  assert.equal(h.adapter.sessions.length, 0);
});

test('a new thread sent with the warm id takes the CLI started for it', async () => {
  const h = setup();
  const { warmId } = h.runner.warm({ cwd: h.work, permissionMode: 'full' }, 1);
  assert.ok(warmId);
  assert.equal(h.adapter.sessions.length, 1);
  const spare = h.adapter.last;
  assert.equal(spare.opts.threadId, warmId);
  // What the CLI says before the thread exists reaches it once it does.
  spare.init();
  const { thread } = h.runner.create({ text: 'hi', cwd: h.work, permissionMode: 'full', warmId });
  assert.equal(thread.id, warmId);
  await tick(10);
  assert.equal(h.adapter.sessions.length, 1, 'no second CLI');
  assert.equal(spare.killed, false);
  assert.equal(spare.sent.length, 1);
  assert.match(spare.sent[0].text, /hi/);
  assert.equal(h.runner.get(thread.id).nativeSessionId, spare.opts.sessionId);
  assert.equal(h.runner.spare, undefined);
});

test('a thread sent with other settings than the warm one starts its own CLI', async () => {
  const h = setup();
  const { warmId } = h.runner.warm({ cwd: h.work, permissionMode: 'full' }, 1);
  const spare = h.adapter.last;
  const { thread } = h.runner.create({ text: 'hi', cwd: h.work, permissionMode: 'ask', warmId });
  assert.equal(thread.id, warmId);
  await tick(10);
  assert.equal(spare.killed, true);
  assert.equal(h.adapter.sessions.length, 2);
  assert.equal(h.adapter.last.sent.length, 1);
});

test('a thread sent without the warm id leaves the spare alone and starts as before', async () => {
  const h = setup();
  const { warmId } = h.runner.warm({ cwd: h.work }, 1);
  const { thread } = h.runner.create({ text: 'hi', cwd: h.work });
  assert.notEqual(thread.id, warmId);
  await tick(10);
  assert.equal(h.adapter.sessions.length, 2);
  assert.equal(h.runner.spare?.id, warmId);
});

test('warming again with the same settings keeps the spare; other settings replace it', () => {
  const h = setup();
  const a = h.runner.warm({ cwd: h.work, permissionMode: 'full' }, 1);
  const first = h.adapter.last;
  const b = h.runner.warm({ cwd: h.work, permissionMode: 'full' }, 1);
  assert.equal(b.warmId, a.warmId);
  assert.equal(h.adapter.sessions.length, 1);
  const c = h.runner.warm({ cwd: h.work, permissionMode: 'ask' }, 1);
  assert.notEqual(c.warmId, a.warmId);
  assert.equal(h.adapter.sessions.length, 2);
  assert.equal(first.ended, true);
});

test("the spare stops when the app's connection goes, not another's", () => {
  const h = setup();
  h.runner.warm({ cwd: h.work }, 1);
  const spare = h.adapter.last;
  h.runner.dropSpare('app disconnected', 2);
  assert.equal(spare.ended, false);
  h.runner.dropSpare('app disconnected', 1);
  assert.equal(spare.ended, true);
  assert.equal(h.runner.spare, undefined);
});

test('a folder that is not there, or a project, warms nothing', () => {
  const h = setup();
  assert.deepEqual(h.runner.warm({ cwd: path.join(h.work, 'missing') }, 1), {});
  assert.deepEqual(h.runner.warm({ cwd: h.work, projectIds: ['p1'] }, 1), {});
  assert.equal(h.adapter.sessions.length, 0);
});

test('a spare whose CLI died before the thread came is not taken', async () => {
  const h = setup();
  const { warmId } = h.runner.warm({ cwd: h.work }, 1);
  const spare = h.adapter.last;
  spare.kill();
  h.runner.create({ text: 'hi', cwd: h.work, warmId });
  await tick(10);
  assert.equal(h.adapter.sessions.length, 2);
  assert.equal(h.adapter.last.sent.length, 1);
});

test("a thread's own connection can't start a spare or take the app's", () => {
  const gate = new CallerGate({
    runner: { has: (id) => id === 'me', get: (id) => ({ permissionMode: 'full', title: id }), accessOf: () => 'full' },
  });
  assert.throws(() => gate.check('me', 'threads.warm', { cwd: '/tmp' }), /app's to do/);
  const made = gate.check('me', 'threads.create', { text: 'x', warmId: 'abc' });
  assert.equal(made.warmId, undefined);
});

test('a create that fails after taking the spare stops it', () => {
  const h = setup();
  const { warmId } = h.runner.warm({ cwd: h.work }, 1);
  const spare = h.adapter.last;
  assert.throws(() => h.runner.create({ text: 'hi', cwd: path.join(h.work, 'gone'), warmId }));
  assert.equal(spare.killed, true);
});
