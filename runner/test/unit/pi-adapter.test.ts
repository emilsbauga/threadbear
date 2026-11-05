import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiAdapter } from '../../src/adapters/pi/adapter.ts';
import { SessionNotFoundError, type AdapterOutput, type SessionSink } from '../../src/adapters/types.ts';
import { nullLogger } from '../../src/log.ts';
import type { PiProfile } from '../../src/protocol.ts';
import { tmpDir } from '../helpers/fakes.ts';

const fixture = fileURLToPath(new URL('../fixtures/pi-rpc.mjs', import.meta.url));
async function until(check: () => boolean, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for Pi fixture'); await new Promise(r => setTimeout(r, 5)); }
}
function setup(t: { after(fn: () => Promise<void>): void }, extra: { mode?: string; resume?: boolean; root?: string; timeout?: number; maxLineBytes?: number; requestQuestion?: SessionSink['requestQuestion'] } = {}) {
  const root = extra.root ?? tmpDir();
  const profile: PiProfile = { id: 'pi-test', engine: 'pi', title: 'Pi', executable: process.execPath, configDir: path.join(root, 'config'), connection: { provider: 'test-provider', model: 'test-model' }, capabilities: { threads: false } };
  const outputs: AdapterOutput[] = [], exits: (Error | undefined)[] = [], owned = new Set<number>();
  const sink: SessionSink = { output: o => outputs.push(o), exited: e => exits.push(e), requestApproval: async () => { throw new Error('No tools'); }, requestQuestion: extra.requestQuestion ?? (async () => { throw new Error('No UI'); }) };
  const adapter = new PiAdapter({ args: [fixture], log: nullLogger, registry: { add: pid => { owned.add(pid); }, remove: pid => { owned.delete(pid); } }, requestTimeoutMs: extra.timeout ?? 1500, shutdownTimeoutMs: 150, maxLineBytes: extra.maxLineBytes });
  const session = adapter.start({ threadId: 'thread-one', sessionId: 'session-one', resume: extra.resume ?? false, account: profile, cwd: root, permissionMode: 'ask', tmpDir: path.join(root, 'tmp'), mediaDir: root, blobsDir: root, env: { PI_RPC_TEST_MODE: extra.mode ?? '', PI_CODING_AGENT_DIR: '/wrong', PI_TELEMETRY: '1' } }, sink);
  t.after(() => session.end({ hard: true }));
  const results = () => outputs.filter(o => o.kind === 'result').map(o => o.result);
  return { root, profile, outputs, exits, owned, session, results };
}

test('Pi streams stable blocks, waits for acknowledgment and settles before completing', async t => {
  const h = setup(t);
  h.session.send({ id: 'm1', text: 'settled-before-ack\u2028literal', images: [] });
  await until(() => h.results().length === 1);
  assert.deepEqual(h.results()[0].answered, ['m1']);
  assert.equal(h.results()[0].outcome, 'completed');
  assert.ok(fs.existsSync(path.join(h.profile.configDir, 'ack-marker')), 'settled event must not complete an unacknowledged prompt');
  const delta = h.outputs.find(o => o.kind === 'delta' && o.delta.type === 'assistant.text.delta');
  const final = h.outputs.find(o => o.kind === 'event' && o.event.type === 'assistant.text');
  assert.ok(delta?.kind === 'delta' && final?.kind === 'event' && 'itemId' in final.event);
  assert.equal(delta.delta.itemId, final.event.itemId);
  assert.equal('text' in final.event && final.event.text, 'final:settled-before-ack\u2028literal');
  const launch = JSON.parse(fs.readFileSync(path.join(h.profile.configDir, 'launch.json'), 'utf8'));
  for (const flag of ['--no-tools', '--no-mcp', '--no-extensions', '--no-context-files', '--no-approve']) assert.ok(launch.args.includes(flag));
  assert.equal(launch.telemetry, '0'); assert.equal(launch.offline, '1');
  assert.equal(fs.statSync(path.join(h.root, 'tmp/pi-stderr.log')).mode & 0o777, 0o600);
  assert.equal(h.exits.length, 0);
});

test('Pi forwards extension questions and Stop cancels an unanswered dialog', async t => {
  let asked = '';
  const answered = setup(t, { requestQuestion: async req => {
    asked = req.questions[0].question;
    return { answers: { [asked]: 'Yes' } };
  } });
  answered.session.send({ id: 'q1', text: 'question', images: [] });
  await until(() => answered.results().length === 1);
  assert.equal(asked, 'Continue?\n\nThis is a Pi question.');
  assert.ok(answered.outputs.some(o => o.kind === 'event' && o.event.type === 'assistant.text' && o.event.text === 'final:question:yes'));
  let waiting = false, aborted = false;
  const held = setup(t, { requestQuestion: req => new Promise(resolve => {
    waiting = true;
    req.signal.addEventListener('abort', () => { aborted = true; resolve({ answers: null }); });
  }) });
  held.session.send({ id: 'q2', text: 'question-hang', images: [] });
  await until(() => waiting);
  await held.session.interrupt();
  assert.equal(aborted, true);
  assert.equal(held.results()[0].outcome, 'interrupted');
});

test('Pi queues prompts and stop clears the queue before abort, then accepts a new prompt', async t => {
  const h = setup(t);
  h.session.send({ id: 'm1', text: 'hang', images: [] });
  h.session.send({ id: 'm2', text: 'must not run', images: [] });
  await until(() => h.outputs.some(o => o.kind === 'delta'));
  await h.session.interrupt();
  assert.equal(h.results()[0].outcome, 'interrupted');
  h.session.send({ id: 'm3', text: 'next', images: [] });
  await until(() => h.results().length === 2);
  assert.deepEqual(h.results()[1].answered, ['m3']);
  const file = path.join(h.profile.configDir, 'sessions/threadbear/thread-one/session-one.jsonl');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((m: { text: string }) => m.text), ['hang', 'next']);
});

test('Pi queues identical prompts without mixing their IDs and does not finish at agent_end', async t => {
  const h = setup(t);
  h.session.send({ id: 'one', text: 'retry', images: [] });
  h.session.send({ id: 'two', text: 'retry', images: [] });
  await until(() => h.results().length === 2);
  assert.deepEqual(h.results().map(r => r.answered), [['one'], ['two']]);
  assert.deepEqual(h.results().map(r => r.outcome), ['completed', 'completed']);
});

test('Pi resumes in a fresh process without replaying prior transcript events', async t => {
  const first = setup(t);
  first.session.send({ id: 'one', text: 'saved', images: [] });
  await until(() => first.results().length === 1);
  await first.session.end();
  assert.equal(first.owned.size, 0);
  const second = setup(t, { root: first.root, resume: true });
  await until(() => second.outputs.some(o => o.kind === 'session'));
  assert.equal(second.outputs.filter(o => o.kind === 'event').length, 0);
  second.session.send({ id: 'two', text: 'continued', images: [] });
  await until(() => second.results().length === 1);
  const file = path.join(first.profile.configDir, 'sessions/threadbear/thread-one/session-one.jsonl');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).map((m: { text: string }) => m.text), ['saved', 'continued']);
});

test('Pi rejects missing resumes, startup timeouts, bad framing and oversized records', async t => {
  for (const extra of [{ resume: true }, { mode: 'startup-hang', timeout: 200 }, { mode: 'malformed' }, { mode: 'mismatch' }, { mode: 'oversized', maxLineBytes: 1024 }]) {
    const h = setup(t, extra);
    await until(() => h.exits.length === 1);
    assert.ok(h.exits[0]);
    if ('resume' in extra) assert.ok(h.exits[0] instanceof SessionNotFoundError);
    await h.session.end({ hard: true });
    assert.equal(h.owned.size, 0);
  }
});

test('Pi reports prompt rejection and crashes once and forcibly stops an unresponsive abort', async t => {
  const rejected = setup(t); rejected.session.send({ id: 'r', text: 'reject', images: [] });
  await until(() => rejected.results().length === 1); assert.equal(rejected.results()[0].outcome, 'failed');
  const crashed = setup(t); crashed.session.send({ id: 'c', text: 'crash', images: [] });
  await until(() => crashed.exits.length === 1); assert.equal(crashed.results()[0].outcome, 'failed');
  const hung = setup(t, { mode: 'abort-hang', timeout: 200 }); hung.session.send({ id: 'h', text: 'hang', images: [] });
  await until(() => hung.outputs.some(o => o.kind === 'delta'));
  await hung.session.interrupt();
  await until(() => hung.exits.length === 1);
  assert.equal(hung.results().length, 1); assert.equal(hung.results()[0].outcome, 'interrupted');
  assert.equal(hung.owned.size, 0);
});

test('stop before startup cancels queued sends and end leaves no owned process', async t => {
  const h = setup(t);
  h.session.send({ id: 'cancel', text: 'never send', images: [] });
  await h.session.interrupt();
  await h.session.end();
  assert.equal(h.results()[0].outcome, 'interrupted');
  assert.equal(h.exits.length, 1); assert.equal(h.owned.size, 0);
});

test('Pi sends images and applies model/effort changes only between prompts', async t => {
  const h = setup(t);
  const image = path.join(h.root, 'image.png'); fs.writeFileSync(image, Buffer.from([1, 2, 3]));
  h.session.send({ id: 'one', text: 'hang', images: [] });
  await until(() => h.outputs.some(o => o.kind === 'delta'));
  await h.session.setModel('second-model'); await h.session.setEffort('high'); await h.session.setPermissionMode('full');
  const commands = () => fs.readFileSync(path.join(h.profile.configDir, 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(commands().some(c => c.type === 'set_model'), false);
  await h.session.interrupt();
  h.session.send({ id: 'two', text: 'image', images: [{ path: image, mediaType: 'image/png', width: 1, height: 1 }] });
  await until(() => h.results().length === 2);
  assert.deepEqual(commands().find(c => c.type === 'set_model').modelId, 'second-model');
  assert.equal(commands().find(c => c.type === 'set_thinking_level').level, 'high');
  assert.equal(commands().filter(c => c.type === 'prompt')[1].images[0].data, 'AQID');
  await assert.rejects(h.session.setEffort('ultra'), /ultra/);
});

test('Pi kills a process that ignores graceful stdin shutdown', async t => {
  const h = setup(t, { mode: 'end-hang' });
  await until(() => h.outputs.some(o => o.kind === 'session'));
  await h.session.end();
  assert.equal(h.exits.length, 1); assert.equal(h.owned.size, 0);
});

test('stop cancels a hung startup without waiting for its request deadline', async t => {
  const h = setup(t, { mode: 'startup-hang', timeout: 3000 });
  h.session.send({ id: 'cancel', text: 'never run', images: [] });
  await until(() => h.owned.size === 1);
  const before = Date.now();
  await h.session.interrupt();
  assert.ok(Date.now() - before < 1500);
  assert.equal(h.results()[0].outcome, 'interrupted');
  assert.equal(h.owned.size, 0); assert.equal(h.exits.length, 1);
});

test('Pi cleans up descendants that retain stdout after their parent crashes', async t => {
  const h = setup(t);
  h.session.send({ id: 'orphan', text: 'orphan', images: [] });
  await until(() => h.exits.length === 1);
  assert.equal(h.results()[0].outcome, 'failed');
  assert.equal(h.owned.size, 0);
});
