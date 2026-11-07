import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend } from '../helpers/convex-memory.ts';

const intake = load('intake');
const hash = 'a'.repeat(64);
const key = 'tbi_' + '1'.repeat(64);
const message = { messageId: 'telegram:chat:42', source: 'telegram', sourceMessageId: '42', text: 'Original\nmessage', sentAt: '2026-11-07T20:00:00+02:00', sender: 'Emīls' };
async function setup(clientId = 'nanobot') {
  const b = memoryBackend();
  await call(b.ctx, intake.provision, { clientId, keyHash: hash });
  return b;
}
const submit = (b: ReturnType<typeof memoryBackend>, m = message, keyHash = hash) => call(b.ctx, intake.accept, { keyHash, message: m });

test('intake stores exact content once and returns a durable receipt on retries', async () => {
  const b = await setup();
  const first = await submit(b);
  assert.equal(first.status, 201);
  assert.equal(first.receipt.state, 'received');
  assert.equal(first.receipt.messageId, message.messageId);
  const again = await submit(b);
  assert.equal(again.status, 200);
  assert.deepEqual(again.receipt, first.receipt);
  assert.equal(b.rows('intakeMessages').length, 1);
  assert.deepEqual(b.rows('intakeMessages')[0].message, message);
  assert.equal(b.rows('commands').length, 0);
  assert.equal(b.rows('threads').length, 0);
  assert.equal(b.rows('intakeClients')[0].hourCount, 1);
  assert.deepEqual((await call(b.ctx, intake.receipt, { keyHash: hash, messageId: message.messageId })).receipt, first.receipt);
});

test('conflicts never overwrite; namespaces and rotated credentials keep receipts isolated', async () => {
  const b = await setup();
  const first = await submit(b);
  assert.equal((await submit(b, { ...message, text: 'Changed' })).status, 409);
  const secondHash = 'b'.repeat(64);
  await call(b.ctx, intake.provision, { clientId: 'other', keyHash: secondHash });
  assert.equal((await call(b.ctx, intake.receipt, { keyHash: secondHash, messageId: message.messageId })).status, 404);
  const second = await submit(b, message, secondHash);
  assert.notEqual(second.receipt.receiptId, first.receipt.receiptId);
  const rotated = 'c'.repeat(64);
  await call(b.ctx, intake.provision, { clientId: 'nanobot', keyHash: rotated });
  assert.equal((await submit(b)).status, 401);
  assert.deepEqual((await submit(b, message, rotated)).receipt, first.receipt);
  await call(b.ctx, intake.revoke, { clientId: 'nanobot' });
  assert.equal((await submit(b, message, rotated)).status, 401);
  assert.equal((await call(b.ctx, intake.receipt, { keyHash: rotated, messageId: message.messageId })).status, 401);
  assert.equal(b.rows('intakeMessages').length, 2);
  await assert.rejects(call(b.ctx, intake.provision, { clientId: 'other', keyHash: rotated }), /already used/);
});

test('new-message allowance does not block receipts or identical retries; next hour recovers', async () => {
  const b = await setup();
  for (let n = 0; n < 120; n++) assert.equal((await submit(b, { ...message, messageId: `m${n}` })).status, 201);
  assert.equal((await submit(b)).status, 429);
  assert.equal((await submit(b, { ...message, messageId: 'm0' })).status, 200);
  assert.equal((await call(b.ctx, intake.receipt, { keyHash: hash, messageId: 'm0' })).status, 200);
  await b.ctx.db.patch(b.rows('intakeClients')[0]._id, { hourStart: 0 });
  assert.equal((await submit(b)).status, 201);
});

test('intake credentials cannot use runner/phone APIs and command pruning retains intake', async () => {
  const b = await setup();
  await submit(b);
  const lib = load('lib');
  await assert.rejects(lib.runnerAuth(b.ctx, key, 'pendingCommands'), /bad runner key/);
  await assert.rejects(lib.checkPhoneToken(b.ctx, key));
  const row = b.rows('intakeMessages')[0];
  await b.ctx.db.patch(row._id, { receivedAt: Date.now() - 7 * 86400000 });
  await call(b.ctx, load('sync').pruneOld, {});
  assert.equal(b.rows('intakeMessages').length, 1);
  assert.equal((await submit(b)).status, 200);
});

test('HTTP rejects bad auth/input, bounds streaming bodies, and never accepts state changes', async () => {
  const b = await setup();
  const realHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const keyHash = Array.from(new Uint8Array(realHash), n => n.toString(16).padStart(2, '0')).join('');
  await call(b.ctx, intake.provision, { clientId: 'nanobot', keyHash });
  const ctx = {
    runQuery: (ref: unknown, args: Record<string, unknown>) => call(b.ctx, intake[String(ref).split('.').at(-1)!], args),
    runMutation: (ref: unknown, args: Record<string, unknown>) => call(b.ctx, intake[String(ref).split('.').at(-1)!], args),
  };
  const request = (body: string, auth = key, type = 'application/json') => new Request('https://example.convex.site/intake/v1/messages', { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': type }, body });
  assert.equal((await intake.postMessage(ctx, request(JSON.stringify(message), 'wrong'))).status, 401);
  assert.equal((await intake.postMessage(ctx, request('{}', key, 'text/plain'))).status, 415);
  for (const body of ['{', 'null', '[]', '{}', JSON.stringify({ ...message, sentAt: 'yesterday' }), JSON.stringify({ ...message, sentAt: '2026-11-07' }), JSON.stringify({ ...message, messageId: 'has space' }), JSON.stringify({ ...message, source: 'other' })]) {
    assert.equal((await intake.postMessage(ctx, request(body))).status, 400, body);
  }
  assert.equal((await intake.postMessage(ctx, request(JSON.stringify({ ...message, text: 'ā'.repeat(25000) })))).status, 413);
  assert.equal((await intake.postMessage(ctx, request(' '.repeat(65537)))).status, 413);
  const first = await intake.postMessage(ctx, request(JSON.stringify({ ...message, state: 'saved', runnerId: 'any' })));
  assert.equal(first.status, 201);
  assert.match(first.headers.get('cache-control'), /no-store/);
  const firstReceipt = await first.json();
  assert.equal(firstReceipt.state, 'received');
  assert.equal((await intake.postMessage(ctx, request(JSON.stringify(message)))).status, 200);
  const get = await intake.getReceipt(ctx, new Request(`https://example.convex.site/intake/v1/receipt?messageId=${encodeURIComponent(message.messageId)}`, { headers: { Authorization: `Bearer ${key}` } }));
  assert.deepEqual(await get.json(), firstReceipt);
  assert.equal(b.rows('intakeMessages')[0].message.state, undefined);
  assert.ok(!JSON.stringify(b.rows('intakeClients')).includes(key));
  // The authorization query may succeed just before an administrator revokes
  // the key; the write must independently authenticate in its transaction.
  const revoking = { ...ctx, runQuery: async (ref: unknown, args: Record<string, unknown>) => {
    const result = await ctx.runQuery(ref, args);
    await call(b.ctx, intake.revoke, { clientId: 'nanobot' });
    return result;
  } };
  assert.equal((await intake.postMessage(revoking, request(JSON.stringify({ ...message, messageId: 'after-revoke' })))).status, 401);
  assert.equal(b.rows('intakeMessages').length, 1);
});
