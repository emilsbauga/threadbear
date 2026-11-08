import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend } from '../helpers/convex-memory.ts';
const files = load('intakeFiles'), intake = load('intake'), consumer = load('intakeConsumer');
const hash = 'e'.repeat(64), owner = 'file-owner';
const message = { messageId: 'file-message', source: 'email', sourceMessageId: 'm1', text: '', sentAt: '2026-11-08T09:00:00Z' };
const attachment = { id: 'a1', name: 'original.pdf', mediaType: 'application/pdf', size: 3, sha256: 'a'.repeat(64) };
async function setup() {
  process.env.RUNNER_KEY = owner;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  await call(b.ctx, intake.provision, { clientId: 'nanobot', keyHash: hash });
  await call(b.ctx, consumer.bindConsumer, { clientId: 'nanobot', runnerId: 'mac' });
  return b;
}
test('file intake remains invisible until complete, preserves receipt and deletes blobs only after local confirmation', async () => {
  const b = await setup();
  const args = { keyHash: hash, message, attachments: [attachment] };
  const prepared = await call(b.ctx, files.prepare, args);
  assert.equal(prepared.status, 201);
  assert.equal((await call(b.ctx, files.prepare, args)).status, 200);
  const reordered = Object.fromEntries(Object.entries(attachment).reverse());
  assert.equal((await call(b.ctx, files.prepare, { ...args, attachments: [reordered] })).status, 200);
  assert.equal((await call(b.ctx, files.prepare, { ...args, attachments: [{ ...attachment, name: 'changed.pdf' }] })).status, 409);
  assert.deepEqual(await call(b.ctx, consumer.pendingIntake, { key: owner, runnerId: 'mac', includeAttachments: true }), []);
  assert.equal((await call(b.ctx, files.finalize, { keyHash: hash, messageId: message.messageId })).status, 409);
  const storageId = b.file('file:chunk');
  const put = { keyHash: hash, messageId: message.messageId, attachmentId: 'a1', index: 0, storageId, bytes: 3, sha256: 'b'.repeat(64) };
  assert.equal((await call(b.ctx, files.putChunk, put)).status, 201);
  assert.equal((await call(b.ctx, files.putChunk, put)).status, 200);
  assert.equal((await call(b.ctx, files.putChunk, { ...put, sha256: 'c'.repeat(64) })).status, 409);
  const ready = await call(b.ctx, files.finalize, { keyHash: hash, messageId: message.messageId });
  assert.equal(ready.status, 201);
  assert.deepEqual(await call(b.ctx, consumer.pendingIntake, { key: owner, runnerId: 'mac' }), [], 'old runners never see file messages');
  assert.deepEqual((await call(b.ctx, files.finalize, { keyHash: hash, messageId: message.messageId })).body, ready.body);
  const [item] = await call(b.ctx, consumer.pendingIntake, { key: owner, runnerId: 'mac', includeAttachments: true });
  assert.deepEqual(item.attachments, [attachment]);
  const lease = { key: owner, runnerId: 'mac', receiptId: item.receiptId, leaseToken: 'c'.repeat(32) };
  await call(b.ctx, consumer.claimIntake, lease);
  const access = await call(b.ctx, files.intakeChunkAccess, { ...lease, attachmentId: 'a1', index: 0 });
  assert.equal(access?.storageId, storageId);
  assert.equal((await call(b.ctx, files.status, { keyHash: hash, messageId: message.messageId })).body.localSaved, false);
  assert.ok(b.hasFile(storageId));
  await call(b.ctx, consumer.finishIntake, lease);
  assert.ok(b.scheduled.some(x => String((x as any).fn).endsWith('cleanDelivered')));
  await call(b.ctx, files.cleanDelivered, { transferId: prepared.body.transferId });
  assert.equal(b.hasFile(storageId), false);
  const delivered = await call(b.ctx, files.status, { keyHash: hash, messageId: message.messageId });
  assert.equal(delivered.body.localSaved, true);
  assert.equal(delivered.body.cloudDeleted, true);
  assert.deepEqual((await call(b.ctx, intake.receipt, { keyHash: hash, messageId: message.messageId })).receipt, ready.body);
});
test('ownership, cancelled uploads, exact block sizes and large manifests', async () => {
  const b = await setup();
  const large = { ...attachment, size: 33 * 1024 * 1024 };
  assert.equal((await call(b.ctx, files.prepare, { keyHash: hash, message, attachments: [large] })).status, 201);
  const other = 'f'.repeat(64);
  await call(b.ctx, intake.provision, { clientId: 'other', keyHash: other });
  assert.equal((await call(b.ctx, files.status, { keyHash: other, messageId: message.messageId })).status, 404);
  assert.equal((await call(b.ctx, files.putChunk, { keyHash: hash, messageId: message.messageId, attachmentId: 'a1', index: 0, storageId: b.file('file:short'), bytes: 3, sha256: 'b'.repeat(64) })).status, 400);
  assert.equal((await call(b.ctx, files.cancel, { keyHash: hash, messageId: message.messageId })).status, 200);
  assert.equal((await call(b.ctx, files.finalize, { keyHash: hash, messageId: message.messageId })).status, 409);
  await call(b.ctx, files.cleanDelivered, { transferId: b.rows('intakeTransfers')[0]._id });
  assert.equal((await call(b.ctx, files.prepare, { keyHash: hash, message, attachments: [large] })).status, 200);
  await assert.rejects(call(b.ctx, files.intakeChunkAccess, { key: 'tbi_not-owner', runnerId: 'mac', receiptId: 'intakeMessages:missing', attachmentId: 'a1', index: 0, leaseToken: 'a'.repeat(32) }));
});

test('HTTP rejects malformed requests and foreign credentials; duplicate uploads discard only their own extra blob', async () => {
  const b = await setup();
  const key = 'tbi_' + '1'.repeat(64);
  const keyHash = await load('lib').sha256(key);
  await call(b.ctx, intake.provision, { clientId: 'http-client', keyHash });
  const blobs = new Map<string, Blob>(); let next = 0;
  const ctx = { ...b.ctx, storage: {
    store: async (blob: Blob) => { const id = 'blob:' + ++next; blobs.set(id, blob); return id; },
    delete: async (id: string) => { blobs.delete(id); }, get: async (id: string) => blobs.get(id) ?? null,
  }, runQuery: (ref: unknown, args: any) => {
    const [module, name] = String(ref).split('.').slice(-2); return call(b.ctx, load(module)[name], args);
  }, runMutation: (ref: unknown, args: any) => {
    const [module, name] = String(ref).split('.').slice(-2); return call(b.ctx, load(module)[name], args);
  } };
  const request = (op: string, body?: string | Buffer, auth = key) => new Request('https://example.convex.site/intake/v2/' + op, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, body });
  assert.equal((await files.jsonRequest(ctx, request('prepare', '{}', 'wrong'))).status, 401);
  assert.equal((await files.jsonRequest(ctx, request('prepare', '{'))).status, 400);
  assert.equal((await files.jsonRequest(ctx, request('prepare', 'x'.repeat(65537)))).status, 413);
  assert.equal((await files.jsonRequest(ctx, request('prepare', JSON.stringify({ message, attachments: [{ ...attachment, size: '3' }] })))).status, 400);
  const prep = await files.jsonRequest(ctx, request('prepare', JSON.stringify({ message, attachments: [attachment] })));
  assert.equal(prep.status, 201);
  assert.equal((await files.upload(ctx, request('upload?messageId=file-message&attachmentId=a1&index=0', Buffer.from('a')))).status, 400);
  const url = 'upload?messageId=file-message&attachmentId=a1&index=0';
  assert.equal((await files.upload(ctx, request(url, Buffer.from('abc')))).status, 201);
  assert.equal(blobs.size, 1);
  assert.equal((await files.upload(ctx, request(url, Buffer.from('abc')))).status, 200);
  assert.equal(blobs.size, 1);
  assert.equal((await files.upload(ctx, request(url, Buffer.from('def')))).status, 409);
  assert.equal(blobs.size, 1);
  const receipt = await files.jsonRequest(ctx, request('finalize', JSON.stringify({ messageId: message.messageId })));
  assert.equal(receipt.status, 201);
  assert.equal((await files.upload(ctx, request(url, Buffer.from('abc')))).status, 409);
  assert.equal((await files.download(ctx, request('download?runnerId=mac&receiptId=invalid&attachmentId=a1&index=0'))).status, 403);
  await call(b.ctx, intake.revoke, { clientId: 'http-client' });
  assert.equal((await files.jsonRequest(ctx, request('status?messageId=file-message'))).status, 401);
});
