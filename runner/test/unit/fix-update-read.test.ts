// What the main Mac reads of the other runners' failed updates
// (sync.ts readFailedRunners, for fix-update.ts): Codex Security finding 152,
// 21 Nov 2026, asked that stale and malformed reports stay out, and that
// only the main Mac's own key reads them at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/fakes.ts';
import { ConvexSync, UPDATE_FAILED_API_VERSION } from '../../src/sync.ts';
import { nullLogger } from '../../src/log.ts';

function setup(key: string, rowsAt: (now: number) => unknown[]) {
  const h = makeHarness();
  const rows = rowsAt(h.clock.now());
  const post = async (_kind: 'mutation' | 'query', fn: string) => (fn === 'sync:otherRunnersList' ? rows : null);
  const sync = new ConvexSync({ config: { enabled: true, url: 'https://x.convex.cloud', runnerId: 'main' }, key, runner: h.runner, version: '0.1.0+test', startedAt: '2026-11-21T00:00:00.000Z', clock: h.clock, log: nullLogger, post });
  (sync as unknown as { backendApiVersion: number }).backendApiVersion = UPDATE_FAILED_API_VERSION;
  return { sync };
}

const failed = { kind: 'build', commit: 'a'.repeat(40) };

test('a report from a runner not heard from in the last few minutes, or a row that isn\'t one, is left out', async () => {
  const rows = (now: number) => [
    { runnerId: 'fresh', name: 'Fresh', lastSeenAt: now - 60_000, updateFailed: failed },
    { runnerId: 'stale', name: 'Stale', lastSeenAt: now - 10 * 60_000, updateFailed: failed },
    { runnerId: 'nameless', lastSeenAt: now, updateFailed: failed },
    { runnerId: 'odd', name: 'Odd', lastSeenAt: now, updateFailed: 'yes' },
    { runnerId: 'through', name: 'Through', lastSeenAt: now },
  ];
  const { sync } = setup('owner-key', rows);
  const r = await sync.readFailedRunners();
  assert.deepEqual(r?.failed.map((f) => f.id), ['fresh']);
  assert.deepEqual(r?.through, ['through']);
});

test('only the main Mac\'s own key reads them: a runner key or a box key gets nothing', async () => {
  for (const key of ['tbr_mini', 'tbb_box']) {
    const { sync } = setup(key, (now) => [{ runnerId: 'x', name: 'X', lastSeenAt: now, updateFailed: failed }]);
    assert.equal(await sync.readFailedRunners(), undefined, key);
  }
});
