// Year-long token… for another runner's login through the backend
// (convex/relay.ts CALLS, accounts.yearToken): only the owner key queues it,
// only its own fields are kept, and its code goes once it's finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from '../helpers/convex-memory.ts';

const STATE = 'Y1Miuwn1u5kKwrI7dwuczDg09inC94FeD8_utBRyPZ0';
const CODE = `6rrspdXVUDGfsF4pr2VwiXJRNecXr1rliqAIdoQm#${STATE}`;
const { commandArgs } = load('relay') as { commandArgs: (kind: string, a: unknown) => Record<string, unknown> };

test("the backend keeps only a yearToken call's own fields, and refuses a code of the wrong shape", () => {
  assert.deepEqual(commandArgs('call', { method: 'accounts.yearToken', params: { accountId: 'claude-1', code: CODE, check: true, other: 'x', token: 'sk-ant-oat01-x' } }), { method: 'accounts.yearToken', params: { accountId: 'claude-1', code: CODE, check: true } });
  assert.deepEqual(commandArgs('call', { method: 'accounts.yearToken', params: { accountId: 'claude-main', cancel: true } }), { method: 'accounts.yearToken', params: { accountId: 'claude-main', cancel: true } });
  assert.throws(() => commandArgs('call', { method: 'accounts.yearToken', params: {} }), /needs a login/);
  assert.throws(() => commandArgs('call', { method: 'accounts.yearToken', params: { accountId: '../x' } }), /needs a login/);
  assert.throws(() => commandArgs('call', { method: 'accounts.yearToken', params: { accountId: 'claude-1', code: `${CODE}\r\u001b` } }), /isn't a code/);
});

test("only the owner key queues one, the code's gone once it's done, and a login row takes its sign-in", async () => {
  const { memoryBackend, call } = await import('../helpers/convex-memory.ts');
  const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
  const sync = load('sync');
  const relay = load('relay');
  process.env.RUNNER_KEY = 'owner-key';
  delete process.env.RUNNER_KEY_NEXT;
  const MINI = 'cb921b2447ea';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256('tbr_mac-mini'), name: 'mac-mini', createdAt: 1 });
  await b.ctx.db.insert('runners', { runnerId: MINI, name: 'mac-mini', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  const args = { method: 'accounts.yearToken', params: { accountId: 'claude-main', code: CODE } };
  await assert.rejects(call(b.ctx, relay.queueCommand, { key: 'tbr_mac-mini', runnerId: MINI, kind: 'call', args }));
  const id = await call(b.ctx, relay.queueCommand, { key: 'owner-key', runnerId: MINI, kind: 'call', args });
  const row = () => b.rows('commands').find((c: any) => c._id === id)! as any;
  assert.equal(row().args.params.code, CODE);
  assert.equal(row().args.from, 'mac');
  await call(b.ctx, sync.takeCommand, { key: 'tbr_mac-mini', commandId: id });
  await call(b.ctx, sync.finishCommand, { key: 'tbr_mac-mini', commandId: id, ok: true, result: JSON.stringify({ state: 'checking' }) });
  assert.ok(!JSON.stringify(row()).includes(CODE.split('#')[0]!), 'the code goes with the finished args');
  assert.equal(JSON.parse(row().result).state, 'checking');
  await call(b.ctx, sync.upsertAccounts, { key: 'tbr_mac-mini', runnerId: MINI, removed: [], accounts: [{ id: 'claude-main', provider: 'claude', title: 'me', loginEndsAt: '2027-11-18T00:00:00.000Z', signedOut: true, yearToken: { madeAt: '2026-11-18T00:00:00.000Z' } }] });
  const rows = await call(b.ctx, relay.remoteAccounts, { key: 'owner-key', runnerId: MINI });
  assert.deepEqual((rows as any[])[0].yearToken, { madeAt: '2026-11-18T00:00:00.000Z' });
});
