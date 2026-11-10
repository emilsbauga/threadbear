import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IntakeConsumer } from '../../src/intake-consumer.ts';
import { intakeThreadId, type IntakeRecord } from '../../src/intake-record.ts';
import { FakeClock } from '../../src/clock.ts';
import { scrubDoc } from '../../src/redaction.ts';
const item: IntakeRecord = { clientId: 'nanobot', receiptId: 'receipt123', receivedAt: 1,
  message: { messageId: 'm1', source: 'email', sourceMessageId: '1', text: 'Task', sentAt: '2026-11-08T09:00:00Z' } };
test('receipt and lease identities survive the sync scrubber unchanged', () => {
  const protocol = { receiptId: 'opaque-receipt-id', leaseToken: 'a'.repeat(32), key: 'owner-key', runnerId: 'mac' };
  assert.deepEqual(scrubDoc(protocol, () => '[masked]'), protocol);
});
test('lost acknowledgement retries the same local result; import failures never acknowledge; switches and stop gate work', async () => {
  const clock = new FakeClock();
  let enabled = false, imported = 0, acknowledgements = 0, failImport = false;
  const calls: string[] = [];
  const consumer = new IntakeConsumer({ clock, enabled: () => enabled, runnerId: 'mac',
    post: async (_kind, fn) => {
      calls.push(fn);
      if (fn.endsWith('pendingIntake')) return [item];
      if (fn.endsWith('claimIntake')) return { state: 'claimed', threadId: intakeThreadId(item.clientId, item.receiptId) };
      acknowledgements++;
      if (acknowledgements === 1) throw new Error('Lost response');
      return true;
    },
    importDraft: () => { if (failImport) throw new Error('Disk full'); imported++; return intakeThreadId(item.clientId, item.receiptId); },
    failed: () => {},
  });
  await consumer.poll();
  assert.equal(calls.length, 0);
  enabled = true;
  await consumer.poll();
  assert.equal(imported, 1);
  await consumer.poll();
  assert.equal(imported, 2, 'runner import is itself idempotent');
  assert.equal(acknowledgements, 2);
  failImport = true;
  await consumer.poll();
  assert.equal(acknowledgements, 2);
  consumer.start();
  await consumer.stop();
  const stopped = calls.length;
  clock.advance(30000);
  await Promise.resolve();
  assert.equal(calls.length, stopped);
});
test('a disabled consumer cannot import after an in-flight backend request returns', async () => {
  let enabled = true;
  let imported = false;
  const consumer = new IntakeConsumer({ clock: new FakeClock(), enabled: () => enabled, runnerId: 'mac',
    post: async () => { enabled = false; return [item]; },
    importDraft: () => { imported = true; return ''; }, failed: () => {},
  });
  await consumer.poll();
  assert.equal(imported, false);
});

test('file transfers renew their lease and stop without acknowledgement after a lost lease', async () => {
  const clock = new FakeClock(); let claims = 0, acks = 0, imported = 0, preparing = false;
  const fileItem = { ...item, attachments: [{ id: 'a', name: 'x', mediaType: 'text/plain', size: 1, sha256: 'a'.repeat(64) }] };
  const consumer = new IntakeConsumer({ clock, enabled: () => true, supportsFiles: () => true, runnerId: 'mac',
    post: async (_kind, fn, args) => {
      if (fn.endsWith('pendingIntake')) { assert.equal(args.includeAttachments, true); return [fileItem]; }
      if (fn.endsWith('claimIntake')) { claims++; return { state: claims > 1 ? 'busy' : 'claimed', threadId: intakeThreadId(item.clientId, item.receiptId) }; }
      acks++; return true;
    },
    prepareFiles: (_item, _token, signal) => new Promise((_, reject) => { preparing = true; signal.addEventListener('abort', () => reject(new Error('Lease lost'))); }),
    importDraft: () => { imported++; return ''; }, failed: () => {},
  });
  const poll = consumer.poll();
  for (let n = 0; n < 8 && !preparing; n++) await Promise.resolve();
  assert.equal(preparing, true); clock.advance(20000); await poll;
  assert.equal(claims, 2); assert.equal(acks, 0); assert.equal(imported, 0);
});

test('poll outages retry quietly and do not claim a message failed to save', async () => {
  let offline = true, imported = 0, failures = 0;
  const consumer = new IntakeConsumer({ clock: new FakeClock(), runnerId: 'mac', enabled: () => true,
    post: async (_kind, fn) => {
      if (offline) throw new TypeError('fetch failed');
      if (fn.endsWith('pendingIntake')) return [item];
      if (fn.endsWith('claimIntake')) return { state: 'claimed', threadId: intakeThreadId(item.clientId, item.receiptId) };
      return true;
    },
    importDraft: () => { imported++; return intakeThreadId(item.clientId, item.receiptId); },
    failed: () => { failures++; },
  });
  await consumer.poll();
  await consumer.poll();
  assert.equal(failures, 0, 'no message was received or imported during the failed poll');
  offline = false;
  await consumer.poll();
  assert.equal(imported, 1);
});

test('poll diagnostics are private, once per outage, and reset after recovery', async () => {
  let offline = true;
  const diagnostics: unknown[] = [];
  const consumer = new IntakeConsumer({ clock: new FakeClock(), runnerId: 'mac', enabled: () => true,
    post: async () => {
      if (offline) throw Object.assign(new TypeError('fetch failed: private URL and credentials'), { cause: { code: 'ECONNRESET' } });
      return [];
    }, importDraft: () => '', failed: () => assert.fail('poll is not delivery'),
    pollFailed: detail => diagnostics.push(detail),
  });
  await consumer.poll(); await consumer.poll();
  assert.deepEqual(diagnostics, [{ stage: 'poll', error: 'TypeError', code: 'ECONNRESET' }]);
  offline = false; await consumer.poll(); offline = true; await consumer.poll();
  assert.equal(diagnostics.length, 2);
});

test('delivery diagnostics identify import versus acknowledgement failures without logging payloads', async () => {
  const diagnostics: unknown[] = [];
  const consumer = new IntakeConsumer({ clock: new FakeClock(), runnerId: 'mac', enabled: () => true,
    post: async (_kind, fn) => {
      if (fn.endsWith('pendingIntake')) return [item];
      if (fn.endsWith('claimIntake')) return { state: 'claimed', threadId: intakeThreadId(item.clientId, item.receiptId) };
      return false;
    },
    importDraft: () => {
      throw Object.assign(new Error('private message'), { code: 'ENOSPC' });
    },
    failed: (receiptId, detail) => diagnostics.push({ receiptId, ...detail }),
  });
  await consumer.poll();
  assert.deepEqual(diagnostics[0], { receiptId: item.receiptId, stage: 'import', error: 'Error', code: 'ENOSPC' });
  await consumer.stop();
  const other = new IntakeConsumer({ clock: new FakeClock(), runnerId: 'mac', enabled: () => true,
    post: async (_kind, fn) => fn.endsWith('pendingIntake') ? [item] : fn.endsWith('claimIntake')
      ? { state: 'claimed', threadId: intakeThreadId(item.clientId, item.receiptId) } : false,
    importDraft: () => intakeThreadId(item.clientId, item.receiptId),
    failed: (receiptId, detail) => diagnostics.push({ receiptId, ...detail }),
  });
  await other.poll();
  assert.deepEqual(diagnostics[1], { receiptId: item.receiptId, stage: 'finish', error: 'Intake completion not confirmed' });
});
