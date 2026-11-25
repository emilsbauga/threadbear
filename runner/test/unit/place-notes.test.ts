// The grey lines a thread gets when it's put away or brought back
// (runner/src/place-notes.ts): who did it, when, and why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';
import type { Schedule } from '../../src/protocol.ts';
import { hibernatedNote, scheduledNote, shortWhen } from '../../src/place-notes.ts';

const END_TURN = 'mcp__threadbear__end_turn';

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + PATIENCE_MS;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const notes = (h: ReturnType<typeof makeHarness>, id: string): string[] =>
  h.events(id).filter((e) => e.type === 'system.note').map((e) => (e as { text: string }).text);

function finished(h: ReturnType<typeof makeHarness>): string {
  const { thread } = h.runner.create({ text: 'Fix it', accountId: 'claude-main' });
  const s = h.adapter.sessions.at(-1)!;
  s.init();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  s.text('m1', 'Done.');
  s.result('completed');
  return thread.id;
}

test('the words: short times, who, and until when', () => {
  const t = Date.parse('2026-11-24T13:45:00Z');
  assert.equal(shortWhen(t, 'Australia/Perth'), 'Tue 24 Nov, 9:45 pm');
  assert.equal(
    hibernatedNote({ who: 'mike', until: '2026-11-25T01:00:00Z', now: t, timeZone: 'Australia/Perth' }),
    'Hibernated by you on Tue 24 Nov, 9:45 pm, until Wed 25 Nov, 9:00 am.',
  );
  assert.equal(hibernatedNote({ who: 'agent', until: 'restart', now: t, timeZone: 'UTC' }), 'Hibernated by an agent on Tue 24 Nov, 1:45 pm, until the runner next starts.');
  assert.equal(
    scheduledNote({ title: 'Omi mic level check tonight', next: t, now: t, timeZone: 'Australia/Perth' }),
    'Moved to Hibernating on Tue 24 Nov, 9:45 pm: nothing needs you, and a schedule brings it back on Tue 24 Nov, 9:45 pm for "Omi mic level check tonight".',
  );
});

test("hibernating, waking, archiving and unarchiving by hand each leave a line saying who", async () => {
  const h = makeHarness(tmpDir());
  const id = finished(h);
  await until(() => h.runner.get(id).waitState === 'done', 'done');
  const later = new Date(h.clock.now() + 3_600_000).toISOString();
  h.runner.update({ threadId: id, snoozedUntil: later });
  assert.match(notes(h, id).at(-1)!, /^Hibernated by you on .+, until .+\.$/);
  h.runner.update({ threadId: id, snoozedUntil: null });
  assert.match(notes(h, id).at(-1)!, /^Woken by you on /);
  h.runner.update({ threadId: id, snoozedUntil: later, byAgent: true });
  assert.match(notes(h, id).at(-1)!, /^Hibernated by an agent on /);
  h.runner.update({ threadId: id, archived: true });
  assert.match(notes(h, id).at(-1)!, /^Archived by you on /);
  // Archiving again says nothing new.
  const n = notes(h, id).length;
  h.runner.update({ threadId: id, archived: true });
  assert.equal(notes(h, id).length, n);
  h.runner.update({ threadId: id, archived: false });
  assert.match(notes(h, id).at(-1)!, /^Brought back from the archive by you on /);
  // A verdict's own line stands in for the plain one.
  h.runner.update({ threadId: id, archived: true, verdict: 'worked' });
  assert.equal(notes(h, id).at(-1), 'Archived by you: it worked.');
  assert.equal(notes(h, id).filter((x) => x.startsWith('Archived by you on')).length, 1);
});

test('a caller that already said why gets no second line, and one that knows why says it', async () => {
  const h = makeHarness(tmpDir());
  const id = finished(h);
  await until(() => h.runner.get(id).waitState === 'done', 'done');
  const n = notes(h, id).length;
  h.runner.update({ threadId: id, archived: true, archivedBy: 'threadbear', noted: true });
  assert.equal(notes(h, id).length, n);
  h.runner.update({ threadId: id, archived: false });
  h.runner.update({ threadId: id, archived: true, archivedBy: 'threadbear', why: 'its review went back to the thread that asked for it' });
  assert.match(notes(h, id).at(-1)!, /^Archived by Threadbear on .+: its review went back to the thread that asked for it\.$/);
});

test('moving under Hibernating for a schedule says so, and its going says so too', async () => {
  const h = makeHarness(tmpDir());
  let schedules: Schedule[] = [];
  h.runner.schedulesFor = () => schedules;
  const id = finished(h);
  await until(() => h.runner.get(id).waitState === 'done', 'done');
  schedules = [{ id: 's1', title: 'Omi mic level check tonight', text: 'look again', whenText: 'tonight', threadId: id, nextRunAt: '2099-01-01T00:00:00Z' } as Schedule];
  h.runner.publish({ method: 'schedules.updated', params: { schedules } });
  await until(() => notes(h, id).some((x) => x.startsWith('Moved to Hibernating')), 'the scheduled line');
  assert.match(notes(h, id).at(-1)!, /a schedule brings it back on .+ for "Omi mic level check tonight"\.$/);
  // Summaries made again with nothing moved add nothing.
  h.runner.get(id);
  h.runner.get(id);
  // Its line is queued as a microtask: all have run by the next turn of the loop.
  await new Promise((r) => setImmediate(r));
  assert.equal(notes(h, id).filter((x) => x.startsWith('Moved to Hibernating')).length, 1);
  schedules = [];
  h.runner.publish({ method: 'schedules.updated', params: { schedules } });
  await until(() => notes(h, id).some((x) => x.startsWith('Back in the inbox')), 'the line for its going');
});

test('schedules arriving after the threads load, as on every start, say nothing', async () => {
  const h = makeHarness(tmpDir());
  // As main.ts starts: the threads load and get summaries before the
  // scheduler is hooked up, so a scheduled thread looks done for a moment.
  const id = finished(h);
  await until(() => h.runner.get(id).waitState === 'done', 'done');
  const schedules = [{ id: 's1', title: 'Omi wear-day review', text: 'look again', whenText: 'tomorrow', threadId: id, nextRunAt: '2099-01-01T00:00:00Z' } as Schedule];
  h.runner.schedulesFor = () => schedules;
  h.runner.recheckWaitStates();
  await until(() => h.runner.get(id).waitState === 'scheduled', 'scheduled');
  await new Promise((r) => setImmediate(r));
  assert.equal(notes(h, id).filter((x) => x.startsWith('Moved to Hibernating')).length, 0);
});
