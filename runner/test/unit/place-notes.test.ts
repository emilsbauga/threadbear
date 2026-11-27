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

// 25 Nov 2026: an agent's 6 h fallback snooze ran out next to its
// every-10-minutes check. It came back unread to the inbox, with a line
// saying no schedule was booked, and dropped out the moment Mike opened it.
const HOUR = 3_600_000;
function booked(id: string, at: string): Schedule[] {
  return [{ id: 's1', title: 'Threadbear release today', text: 'look again', whenText: 'every 10 minutes', threadId: id, nextRunAt: at } as Schedule];
}
async function read(h: ReturnType<typeof makeHarness>, id: string): Promise<void> {
  h.runner.markSeen(id, h.runner.get(id).lastSeq);
  await until(() => h.runner.get(id).waitState !== 'needsYou', 'read');
}

test("its agent's snooze running out with a schedule due soon stays under Hibernating, quietly", async () => {
  const h = makeHarness(tmpDir());
  let schedules: Schedule[] = [];
  h.runner.schedulesFor = () => schedules;
  const id = finished(h);
  await read(h, id);
  h.runner.update({ threadId: id, snoozedUntil: new Date(h.clock.now() + 6 * HOUR).toISOString(), byAgent: true });
  schedules = booked(id, new Date(h.clock.now() + 6 * HOUR + 600_000).toISOString());
  h.runner.publish({ method: 'schedules.updated', params: { schedules } });
  h.clock.advance(6 * HOUR);
  await new Promise((r) => setImmediate(r));
  const t = h.runner.get(id);
  assert.equal(t.waitState, 'scheduled');
  assert.equal(t.needsYou, false);
  assert.equal(t.woke, undefined);
  await new Promise((r) => setImmediate(r));
  assert.equal(notes(h, id).filter((x) => x.startsWith('Back in the inbox')).length, 0);
  // One line says where it is: no "Woke up" above it.
  assert.equal(notes(h, id).filter((x) => x.startsWith('Woke up')).length, 0);
  assert.match(notes(h, id).at(-1)!, /^Moved to Hibernating on .+ for "Threadbear release today"\.$/);
});

test("its agent's snooze on a thread that still asks Mike something comes back unread", async () => {
  const h = makeHarness(tmpDir());
  const { thread } = h.runner.create({ text: 'Fix it', accountId: 'claude-main' });
  const s = h.adapter.sessions.at(-1)!;
  s.init();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'you', asks: [{ question: 'Ship it?' }] } } });
  s.text('m1', 'Ship it?');
  s.result('completed');
  const id = thread.id;
  h.runner.markSeen(id, h.runner.get(id).lastSeq);
  h.runner.schedulesFor = () => booked(id, new Date(h.clock.now() + 2 * HOUR).toISOString());
  h.runner.update({ threadId: id, snoozedUntil: new Date(h.clock.now() + HOUR).toISOString(), byAgent: true });
  h.clock.advance(HOUR);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.runner.get(id).needsYou, true);
  assert.equal(h.runner.get(id).waitState, 'needsYou');
});

test("Mike's own snooze still comes back unread, schedule or not", async () => {
  const h = makeHarness(tmpDir());
  let schedules: Schedule[] = [];
  h.runner.schedulesFor = () => schedules;
  const id = finished(h);
  await read(h, id);
  schedules = booked(id, new Date(h.clock.now() + 2 * HOUR).toISOString());
  h.runner.publish({ method: 'schedules.updated', params: { schedules } });
  h.runner.update({ threadId: id, snoozedUntil: new Date(h.clock.now() + HOUR).toISOString() });
  h.clock.advance(HOUR);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.runner.get(id).needsYou, true);
  assert.equal(h.runner.get(id).waitState, 'needsYou');
  // Read, it goes under Hibernating for its schedule, and its line doesn't
  // say the schedule is gone.
  await read(h, id);
  assert.equal(h.runner.get(id).waitState, 'scheduled');
  await new Promise((r) => setImmediate(r));
  assert.equal(notes(h, id).filter((x) => x.startsWith('Back in the inbox')).length, 0);
});

test("its agent's snooze that ran out while the runner was off goes quiet once the schedules load, and back if they go", async () => {
  const h = makeHarness(tmpDir());
  const id = finished(h);
  await read(h, id);
  h.runner.update({ threadId: id, snoozedUntil: new Date(h.clock.now() + HOUR).toISOString(), byAgent: true });
  // As on a start: no schedules hooked up yet when its time comes.
  h.runner.schedulesFor = undefined;
  h.clock.advance(HOUR);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.runner.get(id).needsYou, true);
  let schedules = booked(id, new Date(h.clock.now() + 600_000).toISOString());
  h.runner.schedulesFor = () => schedules;
  h.runner.recheckWaitStates();
  await until(() => h.runner.get(id).waitState === 'scheduled', 'scheduled');
  assert.equal(h.runner.get(id).needsYou, false);
  // Its schedule deleted (from the phone, say) before Mike looked: back
  // in the inbox unread, as its wake would have been.
  schedules = [];
  h.runner.publish({ method: 'schedules.updated', params: { schedules } });
  await until(() => h.runner.get(id).waitState === 'needsYou', 'needsYou');
  assert.equal(h.runner.get(id).needsYou, true);
  assert.ok(h.runner.get(id).woke);
  // Seen, the quiet wake is over.
  await read(h, id);
  assert.equal(h.runner.threads.get(id)!.rec.quietWake, undefined);
});

test("end_turn's own snooze, its reply unread, stays quiet with a schedule booked", async () => {
  const h = makeHarness(tmpDir());
  const { thread } = h.runner.create({ text: 'Watch the release', accountId: 'claude-main' });
  const id = thread.id;
  h.runner.schedulesFor = () => booked(id, new Date(h.clock.now() + 600_000).toISOString());
  const s = h.adapter.sessions.at(-1)!;
  s.init();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing', snooze: '6h' } } });
  s.text('m1', 'Watching it.');
  s.result('completed');
  await until(() => h.runner.get(id).waitState === 'hibernating', 'hibernating');
  h.clock.advance(6 * HOUR);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.runner.get(id).waitState, 'scheduled');
  assert.equal(h.runner.get(id).needsYou, false);
});

test('a quiet wake put away again is over: its schedule going later brings nothing back', async () => {
  const h = makeHarness(tmpDir());
  let schedules: Schedule[] = [];
  h.runner.schedulesFor = () => schedules;
  const id = finished(h);
  await read(h, id);
  schedules = booked(id, new Date(h.clock.now() + 7 * HOUR).toISOString());
  h.runner.publish({ method: 'schedules.updated', params: { schedules } });
  h.runner.update({ threadId: id, snoozedUntil: new Date(h.clock.now() + HOUR).toISOString(), byAgent: true });
  h.clock.advance(HOUR);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.runner.threads.get(id)!.rec.quietWake, true);
  // Mike hibernates it himself; then the schedule goes while it sleeps.
  h.runner.update({ threadId: id, snoozedUntil: new Date(h.clock.now() + 5 * HOUR).toISOString() });
  schedules = [];
  h.runner.publish({ method: 'schedules.updated', params: { schedules } });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.runner.get(id).needsYou, false);
  assert.equal(h.runner.get(id).waitState, 'hibernating');
  assert.equal(h.runner.threads.get(id)!.rec.quietWake, undefined);
});

test("while the runner starts, its agent's snooze waits for the schedules before waking", async () => {
  const h = makeHarness(tmpDir());
  const id = finished(h);
  await read(h, id);
  h.runner.update({ threadId: id, snoozedUntil: new Date(h.clock.now() + HOUR).toISOString(), byAgent: true });
  h.runner.schedulesFor = undefined;
  h.runner.holdWaits = true;
  h.clock.advance(HOUR);
  await new Promise((r) => setImmediate(r));
  // Not woken yet: nothing marks it unread.
  assert.equal(h.runner.get(id).needsYou, false);
  assert.equal(notes(h, id).filter((x) => x.startsWith('Woke up')).length, 0);
  const schedules = booked(id, new Date(h.clock.now() + 600_000).toISOString());
  h.runner.schedulesFor = () => schedules;
  h.runner.recheckWaitStates();
  h.runner.holdWaits = false;
  h.runner.armSnoozeTimer();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.runner.get(id).waitState, 'scheduled');
  assert.equal(notes(h, id).filter((x) => x.startsWith('Woke up')).length, 0);
});

test('a quiet wake left unread stays so through a message that sits queued', async () => {
  const h = makeHarness(tmpDir());
  h.runner.schedulesFor = () => [];
  const id = finished(h);
  await read(h, id);
  h.runner.update({ threadId: id, snoozedUntil: new Date(h.clock.now() + HOUR).toISOString(), byAgent: true });
  h.clock.advance(HOUR);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.runner.get(id).needsYou, true);
  // Moves that don't put it away leave the mark.
  h.runner.park(h.runner.threads.get(id)!, { kind: 'message', fromSchedule: true, fromMike: false });
  assert.equal(h.runner.threads.get(id)!.rec.quietWake, true);
  assert.equal(h.runner.get(id).needsYou, true);
});
