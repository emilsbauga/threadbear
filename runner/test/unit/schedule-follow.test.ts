// Following the schedules table from what changed (src/schedule-follow.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { followSchedules, SCHEDULE_MARGIN_MS } from '../../src/schedule-follow.ts';

type Row = { id: string; title?: string };

function harness() {
  const subs: { args: Record<string, unknown>; update: (v: unknown) => void; fail: (e: Error) => void; closed: boolean }[] = [];
  const seen: Row[][] = [];
  const errors: Error[] = [];
  const waits: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const stop = followSchedules<Row>(
    (_fn, args, update, fail) => {
      const sub = { args, update, fail, closed: false };
      subs.push(sub);
      return () => {
        sub.closed = true;
      };
    },
    'k',
    (rows) => seen.push(rows),
    (e) => errors.push(e),
    (run, ms) => {
      const w = { run, ms, cancelled: false };
      waits.push(w);
      return () => {
        w.cancelled = true;
      };
    },
  );
  return { subs, seen, errors, waits, stop, last: () => subs.at(-1)! };
}

test('reads the whole table first, then asks only from a little before then', () => {
  const h = harness();
  assert.equal(h.subs[0]!.args.since, undefined);
  assert.equal(typeof h.subs[0]!.args.fresh, 'number');
  h.subs[0]!.update({ rows: [{ id: 'a' }, { id: 'b' }], gone: [], at: 100_000 });
  assert.deepEqual(h.seen.at(-1)!.map((r) => r.id), ['a', 'b']);
  assert.equal(h.subs[0]!.closed, true);
  assert.deepEqual(h.last().args, { key: 'k', since: 100_000 - SCHEDULE_MARGIN_MS });
});

test('merges rows and ids gone into what it holds, and moves on from the newest heard', () => {
  const h = harness();
  h.subs[0]!.update({ rows: [{ id: 'a', title: 'one' }, { id: 'b' }], gone: [], at: 100_000 });
  h.last().update({ rows: [{ id: 'a', title: 'two', updatedMs: 120_000 }], gone: ['b'], at: 120_001 });
  assert.deepEqual(h.seen.at(-1), [{ id: 'a', title: 'two' }]);
  assert.deepEqual(h.last().args, { key: 'k', since: 120_000 - SCHEDULE_MARGIN_MS });
});

test('nothing new: no new subscription and no telling the scheduler again', () => {
  const h = harness();
  h.subs[0]!.update({ rows: [{ id: 'a' }], gone: [], at: 100_000 });
  const subs = h.subs.length;
  const told = h.seen.length;
  // A re-read in the margin, of a row it already has.
  h.last().update({ rows: [{ id: 'a', updatedMs: 90_000 }], gone: [], at: 100_500 });
  h.last().update({ rows: [], gone: ['never-had'], at: 100_600 });
  assert.equal(h.subs.length, subs);
  assert.equal(h.seen.length, told);
});

test('told to start over: drops what it holds and reads the whole table again', () => {
  const h = harness();
  h.subs[0]!.update({ rows: [{ id: 'a' }], gone: [], at: 100_000 });
  h.last().update({ rows: [], gone: [], at: 200_000, more: true });
  assert.equal(h.last().args.since, undefined);
  h.last().update({ rows: [{ id: 'z' }], gone: [], at: 200_001 });
  assert.deepEqual(h.seen.at(-1), [{ id: 'z' }]);
});

test("a burst bigger than an answer is waited out, never skipped", () => {
  const h = harness();
  const whole = { rows: [{ id: 'a' }], gone: [], at: 100_000 };
  h.subs[0]!.update(whole);
  // The first "start over" reads the table straight away.
  h.last().update({ rows: [], gone: [], at: 100_100, more: true });
  assert.equal(h.waits.length, 0);
  h.last().update({ ...whole, at: 100_200 });
  // Follows from before the read, not past it: a row stamped before the read can
  // commit after it, and asking from past it would never hear of that row.
  assert.equal(h.last().args.since, 100_200 - SCHEDULE_MARGIN_MS);
  // Still inside the burst: no reading it all again until that's had time to pass.
  const subs = h.subs.length;
  h.last().update({ rows: [], gone: [], at: 100_300, more: true });
  assert.equal(h.subs.length, subs);
  assert.equal(h.waits.length, 1);
  assert.equal(h.waits[0]!.ms, SCHEDULE_MARGIN_MS);
  h.waits[0]!.run();
  assert.equal(h.last().args.since, undefined, 'then the whole table');
  h.last().update({ rows: [{ id: 'a' }, { id: 'b' }], gone: [], at: 105_400 });
  assert.equal(h.last().args.since, 105_400 - SCHEDULE_MARGIN_MS);
  assert.deepEqual(h.seen.at(-1), [{ id: 'a' }, { id: 'b' }]);
});

test('stopping while waiting out a burst cancels the wait', () => {
  const h = harness();
  h.subs[0]!.update({ rows: [], gone: [], at: 100_000 });
  h.last().update({ rows: [], gone: [], at: 100_100, more: true });
  h.last().update({ rows: [], gone: [], at: 100_200 });
  h.last().update({ rows: [], gone: [], at: 100_300, more: true });
  h.stop();
  assert.equal(h.waits[0]!.cancelled, true);
});

test('an answer to an ask that was replaced is ignored, and stopping stops', () => {
  const h = harness();
  const first = h.subs[0]!;
  first.update({ rows: [{ id: 'a' }], gone: [], at: 100_000 });
  const told = h.seen.length;
  first.update({ rows: [{ id: 'stale' }], gone: [], at: 90_000 });
  assert.equal(h.seen.length, told);
  h.stop();
  assert.equal(h.last().closed, true);
  h.last().update({ rows: [{ id: 'late', updatedMs: 300_000 }], gone: [], at: 300_001 });
  assert.equal(h.seen.length, told);
});

test('errors go to the caller', () => {
  const h = harness();
  h.subs[0]!.fail(new Error('nope'));
  assert.equal(h.errors[0]!.message, 'nope');
});
