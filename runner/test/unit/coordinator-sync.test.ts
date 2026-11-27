import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/fakes.ts';
import { COORDINATORS_API_VERSION, forBackend, toThreadDoc } from '../../src/sync.ts';
import { toIndexRow } from '../../src/thread-index.ts';

test('coordinator metadata reaches phones and remote Macs, and old backends receive normal rows', () => {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'Coordinate the project', accountId: 'claude-3' });
  const t = { ...thread, coordinatorProjectId: 'p_threadbear', snoozedUntil: new Date(h.clock.now() + 3600_000).toISOString() };
  const doc = toThreadDoc(t, 'r1', h.clock.now());
  assert.equal(doc.coordinatorProjectId, 'p_threadbear');
  assert.equal(doc.view, 'inbox');
  assert.equal(forBackend(doc, COORDINATORS_API_VERSION, h.clock.now()).coordinatorProjectId, 'p_threadbear');
  const old = forBackend(doc, COORDINATORS_API_VERSION - 1, h.clock.now());
  assert.equal(old.coordinatorProjectId, undefined);
  assert.equal(old.view, 'hibernating');
  assert.equal(toIndexRow(t).coordinatorProjectId, 'p_threadbear');
  assert.equal(toIndexRow(t, true, true, true, true, true, true, true, false).coordinatorProjectId, undefined);
  assert.equal(toThreadDoc({ ...t, archivedAt: t.lastActivityAt }, 'r1', h.clock.now()).view, 'den');
});

test('bad coordinator hints are omitted rather than moving an ordinary thread', () => {
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'Ordinary work', accountId: 'claude-3' });
  for (const bad of ['', '  ', 12, null, {}]) {
    const t = { ...thread, coordinatorProjectId: bad as string };
    assert.equal(toThreadDoc(t, 'r1', h.clock.now()).coordinatorProjectId, undefined);
    assert.equal(toIndexRow(t).coordinatorProjectId, undefined);
  }
});
