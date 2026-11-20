// How much of a free Convex plan this runner uses (src/convex-use.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConvexUseTally, estimate, FREE_IO_BYTES, FREE_STORAGE_BYTES, WARN_AT } from '../../src/convex-use.ts';

const DAY = 24 * 60 * 60_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'convex-use-'));

test('light use warns nothing; a month heading past 70% of Free warns, as an estimate', () => {
  const quiet = estimate({ sent: 50e6, bodies: 20e6, since: 'x', days: 30 });
  assert.equal(quiet.io, 100e6);
  assert.equal(quiet.warning, undefined);
  const busy = estimate({ sent: (FREE_IO_BYTES * WARN_AT) / 2, bodies: 0, since: 'x', days: 30 });
  assert.match(busy.warning ?? '', /I\/O/);
  assert.match(busy.warning ?? '', /estimate/);
  assert.match(busy.warning ?? '', /"full": false/);
  assert.match(busy.warning ?? '', /usageWarning/);
  const stored = estimate({ sent: 0, bodies: (FREE_STORAGE_BYTES * WARN_AT) / 1.3 + 1, since: 'x', days: 30 });
  assert.match(stored.warning ?? '', /stored tool output/);
});

test("a busy first week is scaled to a month, so it warns before the month's out", () => {
  const week = estimate({ sent: 100e6, bodies: 0, since: 'x', days: 7 });
  assert.equal(week.io, Math.round(100e6 * 2 * (30 / 7)));
  assert.ok(week.warning);
  // A first day counts as a whole one, not a fraction that would blow it up.
  assert.equal(estimate({ sent: 1e6, bodies: 0, since: 'x', days: 0.01 }).io, 60e6);
});

test('the counts survive a restart and only the last 30 days count', () => {
  const home = tmp();
  let now = Date.parse('2026-11-01T12:00:00Z');
  const a = new ConvexUseTally({ home, now: () => now });
  a.record(1000, true);
  a.record(500, false);
  a.save();
  now += 10 * DAY;
  const b = new ConvexUseTally({ home, now: () => now });
  b.record(200, false);
  assert.deepEqual([b.use().sent, b.use().bodies], [1700, 1000]);
  assert.equal(b.use().since, '2026-11-01T00:00:00.000Z');
  now += 25 * DAY;
  assert.deepEqual([b.use().sent, b.use().bodies], [200, 0], 'the first day has dropped out');
  b.save();
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'convex-use.json'), 'utf8')) as { days: Record<string, unknown> };
  assert.deepEqual(Object.keys(saved.days), ['2026-11-11']);
});

test('nothing sent leaves no file, and a broken file starts the count again', () => {
  const home = tmp();
  new ConvexUseTally({ home }).save();
  assert.equal(fs.existsSync(path.join(home, 'convex-use.json')), false);
  for (const broken of ['{not json', '{"days":null}', '{"days":[1]}', '{"days":{"x":{"sent":"a"},"2026-11-01":null}}', '{"days":{"2026-99-99":{"sent":1,"bodies":0}}}']) {
    fs.writeFileSync(path.join(home, 'convex-use.json'), broken);
    assert.equal(new ConvexUseTally({ home }).use().sent, 0, broken);
  }
});
