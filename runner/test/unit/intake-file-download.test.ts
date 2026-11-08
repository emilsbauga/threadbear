import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { downloadIntakeFiles, BLOCK_BYTES } from '../../src/intake-files.ts';
import type { IntakeRecord } from '../../src/intake-record.ts';
const digest = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
test('large files resume verified blocks across restart and retain original names only as metadata', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-files-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const bytes = Buffer.alloc(26 * 1024 * 1024 + 17, 73);
  const item: IntakeRecord = { clientId: 'test', receiptId: 'receipt', receivedAt: 1, message: { messageId: '1', source: 'email', sourceMessageId: '1', text: '', sentAt: '2026-11-08T00:00:00Z' },
    attachments: [{ id: 'one', name: '../../outside.pdf', mediaType: 'application/pdf', size: bytes.length, sha256: digest(bytes) }] };
  const counts: number[] = []; let fail = true;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-runner-key');
    const u = new URL(String(input)); assert.equal(u.searchParams.has('key'), false);
    const i = Number(u.searchParams.get('index')); counts.push(i);
    if (i === 1 && fail) throw new Error('Offline');
    const b = bytes.subarray(i * BLOCK_BYTES, (i + 1) * BLOCK_BYTES);
    return new Response(b, { headers: { 'X-Chunk-SHA256': digest(b) } });
  };
  const args = { home, item, origin: 'https://example.convex.site', key: 'private-runner-key', runnerId: 'mac', leaseToken: 'lease', signal: new AbortController().signal, fetcher };
  await assert.rejects(downloadIntakeFiles(args), /Offline/);
  fail = false;
  const [file] = await downloadIntakeFiles(args);
  assert.deepEqual(counts, [0, 1, 1, 2, 3]);
  assert.equal(file.name, '../../outside.pdf');
  assert.ok(file.path.startsWith(path.join(home, 'threads')));
  assert.equal(digest(fs.readFileSync(file.path)), digest(bytes));
  assert.equal(fs.statSync(file.path).mode & 0o777, 0o600);
  const n = counts.length;
  await downloadIntakeFiles(args); assert.equal(counts.length, n);
  fs.writeFileSync(file.path, 'corrupt');
  await downloadIntakeFiles(args);
  assert.equal(digest(fs.readFileSync(file.path)), digest(bytes));
});
test('wrong checksum cannot publish a final attachment', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-bad-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const b = Buffer.from('abc');
  const item: IntakeRecord = { clientId: 'c', receiptId: 'r', receivedAt: 1, message: { messageId: 'm', source: 'telegram', sourceMessageId: '1', text: '', sentAt: '2026-11-08T00:00:00Z' }, attachments: [{ id: 'a', name: 'x', mediaType: 'application/octet-stream', size: 3, sha256: digest(b) }] };
  let requests = 0;
  const args = { home, item, origin: 'https://example.convex.site', key: 'key', runnerId: 'mac', leaseToken: 'l', signal: new AbortController().signal,
    fetcher: async () => { requests++; return new Response('bad', { headers: { 'X-Chunk-SHA256': digest(b) } }); } };
  await assert.rejects(downloadIntakeFiles(args), /checksum/i);
  await assert.rejects(downloadIntakeFiles(args), /held/i);
  assert.equal(requests, 1, 'corrupt transfers do not cause endless billable downloads');
});
