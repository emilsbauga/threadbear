// Use this Mac's Claude logins through the backend (convex/relay.ts CALLS,
// logins.sealKey and logins.share; login-share.ts): only the owner key
// queues them, a share keeps nothing but each login's email and sealed box,
// and the box is gone once the command is finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from '../helpers/convex-memory.ts';

const { commandArgs } = load('relay') as { commandArgs: (kind: string, a: unknown) => Record<string, unknown> };
const BOX = Buffer.alloc(200, 7).toString('base64');

test('the backend keeps only each shared login\'s email and sealed box, and refuses anything in the clear', () => {
  assert.deepEqual(commandArgs('call', { method: 'logins.sealKey', params: { anything: 'x' } }), { method: 'logins.sealKey', params: {} });
  assert.deepEqual(commandArgs('call', { method: 'logins.share', params: { logins: [{ email: 'a@example.com', box: BOX, token: 'sk-ant-oat01-x' }], other: 1 } }), { method: 'logins.share', params: { logins: [{ email: 'a@example.com', box: BOX }] } });
  assert.deepEqual(commandArgs('call', { method: 'logins.share', params: { logins: [] } }), { method: 'logins.share', params: { logins: [] } });
  assert.throws(() => commandArgs('call', { method: 'logins.share', params: {} }), /list/);
  assert.throws(() => commandArgs('call', { method: 'logins.share', params: { logins: Array.from({ length: 21 }, () => ({ email: 'a@example.com', box: BOX })) } }), /at most 20/);
  assert.throws(() => commandArgs('call', { method: 'logins.share', params: { logins: [{ email: 'a@example.com', box: '{"token":"sk-ant-oat01-x"}' }] } }), /sealed/);
  assert.throws(() => commandArgs('call', { method: 'logins.share', params: { logins: [{ email: 'a@example.com', box: 'A'.repeat(9000) }] } }), /sealed/);
  assert.throws(() => commandArgs('call', { method: 'logins.share', params: { logins: [{ email: 'nope', box: BOX }] } }), /email/);
});

test('only the owner key queues one, and its sealed boxes go once it is finished', async () => {
  const { memoryBackend, call } = await import('../helpers/convex-memory.ts');
  const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
  const sync = load('sync');
  const relay = load('relay');
  process.env.RUNNER_KEY = 'owner-key';
  delete process.env.RUNNER_KEY_NEXT;
  const MINI = 'cb921b2447ea';
  const CLOUD = 'befe8df8975c';
  const b = memoryBackend();
  for (const [id, key] of [[MINI, 'tbr_mac-mini'], [CLOUD, 'tbr_cloud']] as const) {
    await b.ctx.db.insert('runnerKeys', { runnerId: id, keyHash: await sha256(key), name: id, createdAt: 1 });
    await b.ctx.db.insert('runners', { runnerId: id, name: id, version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  }
  const args = { method: 'logins.share', params: { logins: [{ email: 'a@example.com', box: BOX }] } };
  // Another runner's key can't push logins to a runner, nor ask for its key.
  await assert.rejects(call(b.ctx, relay.queueCommand, { key: 'tbr_cloud', runnerId: MINI, kind: 'call', args }));
  await assert.rejects(call(b.ctx, relay.queueCommand, { key: 'tbr_mac-mini', runnerId: MINI, kind: 'call', args }));
  await assert.rejects(call(b.ctx, relay.queueCommand, { key: 'tbr_cloud', runnerId: MINI, kind: 'call', args: { method: 'logins.sealKey', params: {} } }));
  const id = await call(b.ctx, relay.queueCommand, { key: 'owner-key', runnerId: MINI, kind: 'call', args });
  type Row = { _id: unknown; args: { from?: string; params: { logins: { box: string }[] } }; result: string };
  const row = () => (b.rows('commands') as unknown as Row[]).find((c) => c._id === id)!;
  assert.equal(row().args.from, 'mac');
  assert.equal(row().args.params.logins[0].box, BOX);
  // Only that runner's key takes and finishes it.
  await assert.rejects(call(b.ctx, sync.takeCommand, { key: 'tbr_cloud', commandId: id }));
  await call(b.ctx, sync.takeCommand, { key: 'tbr_mac-mini', commandId: id });
  await call(b.ctx, sync.finishCommand, { key: 'tbr_mac-mini', commandId: id, ok: true, result: JSON.stringify({ logins: [{ email: 'a@example.com', state: 'added', accountId: 'claude-5' }], removed: [] }) });
  assert.ok(!JSON.stringify(row()).includes(BOX), 'the sealed box goes with the finished args');
  assert.equal(JSON.parse(row().result).logins[0].state, 'added');
});
