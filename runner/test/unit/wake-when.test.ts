import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { checkSummary } from '../helpers/protocol-check.ts';
import { RpcError } from '../../src/protocol.ts';
import { NO_WAKE_TIME } from '../../src/runner.ts';
import { awayFor, hibernateNote, localWhen, parseWakeTime, readWakeAnswer, wakePrompt } from '../../src/wake-when.ts';
import type { GenerateParams, ModelResult } from '../../src/models/index.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-29T06:00:00Z');

test('awayFor: rounded minutes, hours and days', () => {
  const MIN = 60_000;
  assert.deepEqual([10_000, MIN, 45 * MIN, 59 * MIN, 60 * MIN, 100 * MIN, 23 * 60 * MIN, 30 * 60 * MIN, 40 * 60 * MIN, 12 * 1440 * MIN].map(awayFor),
    ['a minute', 'a minute', '45 minutes', '59 minutes', 'an hour', '2 hours', '23 hours', 'a day', '2 days', '12 days']);
});

test('readWakeAnswer: a time, a topic, both, and what it refuses', () => {
  assert.deepEqual(readWakeAnswer('{"until":"2026-10-31T09:00:00+08:00","topic":null,"why":"Saturday morning"}', NOW), { until: '2026-10-31T01:00:00.000Z', why: 'Saturday morning' });
  assert.deepEqual(readWakeAnswer('```json\n{"until":null,"topic":"woodworking.","why":"A topic"}\n```', NOW), { topic: 'woodworking', why: 'A topic' });
  assert.deepEqual(readWakeAnswer('{"until":"2026-11-28T09:00:00+08:00","topic":"the shed","why":"x"}', NOW), { until: '2026-11-28T01:00:00.000Z', topic: 'the shed', why: 'x' });
  assert.match((readWakeAnswer('not json', NOW) as { error: string }).error, /wasn't JSON/);
  assert.match((readWakeAnswer('{"until":"2026-10-01T00:00:00Z","why":""}', NOW) as { error: string }).error, /already passed/);
  assert.match((readWakeAnswer('{"until":"2031-01-01T00:00:00Z"}', NOW) as { error: string }).error, /two years/);
  assert.equal((readWakeAnswer('{"until":null,"topic":"","why":"No idea what that means"}', NOW) as { error: string }).error, 'No idea what that means');
});

test('the prompt gives the local time, the thread and his words; the note says when', () => {
  const p = wakePrompt({ said: ' at the weekend ', now: NOW, timeZone: 'Australia/Perth', title: 'Workbench drawers', brief: '- Cut list done' });
  assert.match(p, /^Now: Thursday,? 29 October 2026,? (at )?2:00 pm \(Australia\/Perth\)/);
  assert.match(p, /The thread: "Workbench drawers"/);
  assert.match(p, /- Cut list done/);
  assert.match(p, /The user wants it back: at the weekend$/);
  const sat = Date.parse('2026-10-31T01:00:00Z');
  assert.equal(localWhen(sat, 'Australia/Perth'), 'Saturday 31 October, 9 am');
  assert.equal(localWhen(sat + 30 * 60_000, 'Australia/Perth'), 'Saturday 31 October, 9:30 am');
  assert.equal(hibernateNote({ until: new Date(sat).toISOString(), why: '' }, 'at the weekend', 'Australia/Perth'), 'Hibernating until Saturday 31 October, 9 am. You said "at the weekend".');
  assert.equal(
    hibernateNote({ topic: 'woodworking', until: new Date(sat).toISOString(), why: '' }, 'next time I do woodworking, or Saturday', 'Australia/Perth'),
    'Hibernating until you next talk about woodworking, or Saturday 31 October, 9 am at the latest. You said "next time I do woodworking, or Saturday".',
  );
});

function setup(answer: (p: GenerateParams) => ModelResult<string> | Promise<ModelResult<string>>) {
  const asked: GenerateParams[] = [];
  // Titles ask the model too; only wake-when gets an answer.
  const generate = async (p: GenerateParams): Promise<ModelResult<string>> => {
    if (p.feature !== 'wake-when') return { ok: false, reason: 'off', message: 'off' };
    asked.push(p);
    return answer(p);
  };
  const h = makeHarness(undefined, {}, { models: { generate } });
  const { thread } = h.runner.create({ text: 'Plan the workbench drawers', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  s.result();
  return { h, thread, asked, s };
}

const ok = (v: unknown): ModelResult<string> => ({ ok: true, value: JSON.stringify(v), model: 'opus' });

test('hibernateWhen: away at once, then until the time Opus gives, with a note', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { h, thread, asked, s } = setup(async () => {
    await gate;
    return ok({ until: new Date(h.clock.now() + 2 * DAY).toISOString(), topic: null, why: 'After Christmas' });
  });
  const call = h.runner.hibernateWhen({ threadId: thread.id, said: 'after Christmas' });
  // Away before the model answers, saying it's being worked out.
  const away = h.runner.get(thread.id);
  assert.deepEqual(checkSummary(away), []);
  assert.equal(away.snoozedUntil, NO_WAKE_TIME);
  assert.deepEqual(away.wakeWhen, { said: 'after Christmas', pending: true });
  assert.deepEqual(h.runner.list().map((t) => t.id), []);
  assert.equal(s.ended, true);
  release();
  const res = await call;
  assert.equal(asked[0].strong, true);
  assert.equal(asked[0].feature, 'wake-when');
  assert.match(asked[0].prompt, /The thread: "Plan the workbench drawers"/);
  assert.match(asked[0].prompt, /How it started \(the user\): Plan the workbench drawers/);
  assert.equal(res.until, new Date(h.clock.now() + 2 * DAY).toISOString());
  assert.equal(res.thread.snoozedUntil, res.until);
  assert.deepEqual(res.thread.wakeWhen, { said: 'after Christmas' });
  assert.deepEqual(checkSummary(res.thread), []);
  assert.match(h.events(thread.id).at(-1).text, /^Hibernating until .+\. You said "after Christmas"\.$/);
  // Comes back as any snooze does, and forgets the words.
  h.clock.advance(2 * DAY);
  const back = h.runner.get(thread.id);
  assert.equal(back.snoozedUntil, undefined);
  assert.equal(back.wakeWhen, undefined);
  assert.equal(back.needsYou, true);
});

test('hibernateWhen: a model that fails or says nothing usable puts it back, unread as it was', async () => {
  const { h, thread } = setup(() => ok({ until: null, topic: null, why: "That isn't a time" }));
  await assert.rejects(h.runner.hibernateWhen({ threadId: thread.id, said: 'banana' }), (e: RpcError) => /Couldn't work out when to wake it: That isn't a time/.test(e.message));
  const t = h.runner.get(thread.id);
  assert.equal(t.snoozedUntil, undefined);
  assert.equal(t.wakeWhen, undefined);
  assert.deepEqual(h.runner.list().map((x) => x.id), [thread.id]);
  await assert.rejects(h.runner.hibernateWhen({ threadId: thread.id, said: '  ' }), (e: RpcError) => e.code === -32602);
  const off = setup(() => ({ ok: false, reason: 'no-room', message: 'Every login in Claude is out of room.' }));
  await assert.rejects(off.h.runner.hibernateWhen({ threadId: off.thread.id, said: 'after Christmas' }), /out of room/);
  assert.equal(off.h.runner.get(off.thread.id).snoozedUntil, undefined);
});

test('parseWakeTime: common time phrases are parsed locally, while topics and fuzzy phrases return undefined', () => {
  // Thursday 29 October 2026, 10:00 local time (timezone-independent).
  const thu10am = new Date(2026, 9, 29, 10, 0, 0, 0).getTime();
  const iso = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m, d, h, min, 0, 0).toISOString();
  const okUntil = (said: string, at = thu10am) => {
    const r = parseWakeTime(said, at);
    assert.ok(r && 'until' in r, `expected local time for "${said}", got ${JSON.stringify(r)}`);
    return r.until;
  };

  // Relative durations
  assert.equal(okUntil('30m'), new Date(thu10am + 30 * 60_000).toISOString());
  assert.equal(okUntil('2h'), new Date(thu10am + 2 * 3_600_000).toISOString());
  assert.equal(okUntil('in 2 hours'), new Date(thu10am + 2 * 3_600_000).toISOString());
  assert.equal(okUntil('in an hour'), new Date(thu10am + 3_600_000).toISOString());
  assert.equal(okUntil('in half an hour'), new Date(thu10am + 30 * 60_000).toISOString());
  assert.equal(okUntil('1h 30m'), new Date(thu10am + 90 * 60_000).toISOString());
  assert.equal(okUntil('1.5 hours'), new Date(thu10am + 90 * 60_000).toISOString());
  assert.equal(okUntil('in 2 weeks'), iso(2026, 10, 12, 10, 0));
  assert.equal(okUntil('in a couple of days'), iso(2026, 9, 31, 10, 0));
  assert.equal(okUntil('in a month'), iso(2026, 10, 29, 10, 0));

  // Relative days and clock times
  assert.equal(okUntil('tomorrow'), iso(2026, 9, 30, 9, 0));
  assert.equal(okUntil('until tomorrow'), iso(2026, 9, 30, 9, 0));
  assert.equal(okUntil('tomorrow morning'), iso(2026, 9, 30, 9, 0));
  assert.equal(okUntil('tomorrow afternoon'), iso(2026, 9, 30, 14, 0));
  assert.equal(okUntil('tomorrow at 2:30pm'), iso(2026, 9, 30, 14, 30));
  assert.equal(okUntil('day after tomorrow'), iso(2026, 9, 31, 9, 0));
  assert.equal(okUntil('tonight'), iso(2026, 9, 29, 19, 0));
  assert.equal(okUntil('tonight at 8pm'), iso(2026, 9, 29, 20, 0));
  assert.equal(okUntil('this afternoon'), iso(2026, 9, 29, 14, 0));
  assert.equal(okUntil('today 5pm'), iso(2026, 9, 29, 17, 0));
  assert.equal(okUntil('5pm'), iso(2026, 9, 29, 17, 0));
  assert.equal(okUntil('8am'), iso(2026, 9, 30, 8, 0), 'earlier clock time rolls to tomorrow');
  assert.equal(okUntil('14:30'), iso(2026, 9, 29, 14, 30));

  // Weekend, next week, next month
  assert.equal(okUntil('at the weekend'), iso(2026, 9, 31, 9, 0));
  assert.equal(okUntil('this weekend'), iso(2026, 9, 31, 9, 0));
  assert.equal(okUntil('next weekend'), iso(2026, 10, 7, 9, 0));
  assert.equal(okUntil('next week'), iso(2026, 10, 2, 9, 0));
  assert.equal(okUntil('next month'), iso(2026, 10, 1, 9, 0));

  // Weekdays
  assert.equal(okUntil('Friday'), iso(2026, 9, 30, 9, 0));
  assert.equal(okUntil('Friday 9am'), iso(2026, 9, 30, 9, 0));
  assert.equal(okUntil('Monday 10:30am'), iso(2026, 10, 2, 10, 30));
  assert.equal(okUntil('next Monday'), iso(2026, 10, 2, 9, 0));
  assert.equal(okUntil('next Friday'), iso(2026, 10, 6, 9, 0));
  assert.equal(okUntil('on Wednesday at 2pm'), iso(2026, 10, 4, 14, 0));
  assert.equal(okUntil('Thursday'), iso(2026, 10, 5, 9, 0), 'same weekday without time is next week');
  assert.equal(okUntil('Thursday 5pm'), iso(2026, 9, 29, 17, 0), 'same weekday with future time is today');

  // Calendar dates & ISO
  assert.equal(okUntil('15 Dec'), iso(2026, 11, 15, 9, 0));
  assert.equal(okUntil('Dec 15 at 2pm'), iso(2026, 11, 15, 14, 0));
  assert.equal(okUntil('2026-11-28'), iso(2026, 10, 28, 9, 0));
  assert.equal(okUntil('2026-11-28T09:00:00+08:00'), '2026-11-28T01:00:00.000Z');

  // Bounds and invalid dates
  assert.match((parseWakeTime('2020-01-01T00:00:00Z', thu10am) as { error: string }).error, /already passed/);
  assert.match((parseWakeTime('0m', thu10am) as { error: string }).error, /already passed/);
  assert.match((parseWakeTime('2031-01-01', thu10am) as { error: string }).error, /two years/);
  assert.match((parseWakeTime('2026-02-30', thu10am) as { error: string }).error, /doesn't exist/);

  // Topics, compound phrases and fuzzy expressions must fall through to the model
  for (const fuzzy of [
    'woodworking',
    'next time I talk about woodworking',
    'woodworking, or tomorrow',
    'next time I talk about woodworking, or in two days',
    'when the parts arrive',
    'until the GPUI app replaces the Swift app',
    'MACG-3843',
    'after PR 123',
    'after Christmas',
    'in a few weeks',
    'tomorrow if it stops raining',
    'Friday after the release',
    'later',
    'whenever',
    'banana',
  ]) {
    assert.equal(parseWakeTime(fuzzy, thu10am), undefined, `should defer "${fuzzy}" to model`);
  }
});

test('hibernateWhen: plain times hibernate locally with no model call, even when out of room or models are off', async () => {
  const off = setup(() => ({ ok: false, reason: 'no-room', message: 'Every login in Main is out of room.' }));
  const res = await off.h.runner.hibernateWhen({ threadId: off.thread.id, said: 'tomorrow morning' });
  assert.equal(off.asked.length, 0, 'model was never called');
  assert.ok(res.until);
  assert.equal(res.thread.snoozedUntil, res.until);
  assert.deepEqual(res.thread.wakeWhen, { said: 'tomorrow morning' });
  assert.deepEqual(checkSummary(res.thread), []);
  assert.match(off.h.events(off.thread.id).at(-1).text, /^Hibernating until .+\. You said "tomorrow morning"\.$/);

  // Even with no Models layer at all, plain times still work.
  const bare = makeHarness();
  const { thread } = bare.runner.create({ text: 'Fix it later', accountId: 'claude-3' });
  const r2 = await bare.runner.hibernateWhen({ threadId: thread.id, said: 'in 2 hours' });
  assert.equal(r2.until, new Date(bare.clock.now() + 2 * 3_600_000).toISOString());
  assert.equal(bare.runner.get(thread.id).snoozedUntil, r2.until);

  // Agent end_turn snooze with a natural time phrase also skips the model.
  const agent = setup(() => ({ ok: false, reason: 'no-room', message: 'Every login in Main is out of room.' }));
  turnWithSnooze(agent.h, agent.thread.id, { needs: 'nothing', snooze: 'in 2 hours' });
  await tick();
  assert.equal(agent.asked.length, 0);
  assert.equal(agent.h.runner.get(agent.thread.id).snoozedUntil, new Date(agent.h.clock.now() + 2 * 3_600_000).toISOString());
});

test('hibernateWhen: a private folder sends his words alone', async () => {
  const { h, thread, asked } = setup((p) => (p.cwd ? { ok: false, reason: 'private', message: 'private' } : ok({ until: null, topic: 'woodworking', why: 'topic' })));
  const res = await h.runner.hibernateWhen({ threadId: thread.id, said: 'next time I talk about woodworking' });
  assert.equal(asked.length, 2);
  assert.doesNotMatch(asked[1].prompt, /workbench/);
  assert.deepEqual(res.thread.wakeWhen, { said: 'next time I talk about woodworking', topic: 'woodworking' });
  assert.equal(res.thread.snoozedUntil, NO_WAKE_TIME);
});

test('a topic waits for the librarian: waitingTopics lists it, wakeForTopic brings it back unread with where', async () => {
  const { h, thread } = setup(() => ok({ until: null, topic: 'woodworking', why: 'topic' }));
  await h.runner.hibernateWhen({ threadId: thread.id, said: 'next time I talk about woodworking' });
  assert.deepEqual(h.runner.waitingTopics(), [{ threadId: thread.id, title: 'Plan the workbench drawers', topic: 'woodworking' }]);
  // A month on it's still waiting.
  h.clock.advance(30 * DAY);
  assert.deepEqual(h.runner.list(['snoozed']).map((t) => t.id), [thread.id]);
  const other = h.runner.create({ text: 'Router table jig', accountId: 'claude-3' }).thread;
  assert.equal(h.runner.wakeForTopic(thread.id, thread.id), false);
  assert.equal(h.runner.wakeForTopic(thread.id, other.id), true);
  assert.equal(h.events(thread.id).at(-1).text, 'Woke up after 30 days: you talked about woodworking in "Router table jig".');
  const t = h.runner.get(thread.id);
  assert.equal(t.snoozedUntil, undefined);
  assert.equal(t.needsYou, true);
  assert.deepEqual(h.runner.waitingTopics(), []);
  assert.equal(h.runner.wakeForTopic(thread.id, other.id), false);
});

test('a plain snooze clears the words, and a restart mid-answer brings the thread back', async () => {
  const { h, thread } = setup(() => ok({ until: null, topic: 'woodworking', why: 'topic' }));
  await h.runner.hibernateWhen({ threadId: thread.id, said: 'woodworking' });
  h.runner.update({ threadId: thread.id, snoozedUntil: new Date(h.clock.now() + DAY).toISOString() });
  assert.equal(h.runner.get(thread.id).wakeWhen, undefined);
  // Pending when the runner stops: it comes back on the next start.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const p = setup(async () => (await gate, ok({ until: null, topic: 'x', why: '' })));
  const call = p.h.runner.hibernateWhen({ threadId: p.thread.id, said: 'later' });
  await tick();
  p.h.runner.flush();
  const h2 = p.h.restart();
  const t = h2.runner.get(p.thread.id);
  assert.equal(t.snoozedUntil, undefined);
  assert.equal(t.wakeWhen, undefined);
  release();
  await call.catch(() => undefined);
});

// end_turn's snooze: a thread hibernates itself once its turn is over.
const END_TURN = 'mcp__threadbear__end_turn';
function turnWithSnooze(h: ReturnType<typeof makeHarness>, threadId: string, input: Record<string, unknown>, outcome: 'completed' | 'interrupted' = 'completed') {
  h.runner.send(threadId, 'hibernate this until the parts arrive');
  const s = h.adapter.last;
  s.text('m1', 'Hibernating.');
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input } });
  // Not mid-turn: snoozing stops the CLI.
  assert.equal(h.runner.get(threadId).snoozedUntil, undefined);
  s.result(outcome);
}

test('end_turn snooze: a time hibernates the thread once the turn is over, with a note', () => {
  const { h, thread, asked } = setup(() => ok({}));
  turnWithSnooze(h, thread.id, { needs: 'nothing', snooze: '2026-11-05T17:00:00+08:00' });
  const t = h.runner.get(thread.id);
  assert.equal(t.snoozedUntil, '2026-11-05T09:00:00.000Z');
  assert.deepEqual(checkSummary(t), []);
  assert.match(h.events(thread.id).at(-1).text, /^Hibernating until .*5 November.*, as the agent was asked to\.$/);
  assert.equal(asked.length, 0, 'a time needs no model');
});

test('end_turn snooze: "restart" and relative times', () => {
  const { h, thread } = setup(() => ok({}));
  turnWithSnooze(h, thread.id, { needs: 'nothing', snooze: '2h' });
  assert.equal(h.runner.get(thread.id).snoozedUntil, new Date(h.clock.now() + 2 * 3_600_000).toISOString());
  const { h: h2, thread: t2 } = setup(() => ok({}));
  turnWithSnooze(h2, t2.id, { needs: 'nothing', snooze: 'restart' });
  assert.equal(h2.runner.get(t2.id).snoozedUntilRestart, true);
});

test('end_turn snooze: words are read as Hibernate in words reads them', async () => {
  const { h, thread, asked } = setup(() => ok({ until: null, topic: 'the parts arriving', why: 'when they come' }));
  turnWithSnooze(h, thread.id, { needs: 'nothing', snooze: 'when the parts arrive' });
  await tick();
  await tick();
  assert.equal(asked.length, 1);
  assert.match(asked[0].prompt, /when the parts arrive/);
  const t = h.runner.get(thread.id);
  assert.equal(t.snoozedUntil, NO_WAKE_TIME);
  assert.deepEqual(t.wakeWhen, { said: 'when the parts arrive', topic: 'the parts arriving', agent: true });
});

// 20 Nov 2026: "MACG-3843" in an agent's snooze words went to Date.parse,
// which read it as the year 3843, and the thread showed "snoozed until
// 3843-01-01" rather than waiting for the ticket.
test('end_turn snooze: words naming a ticket number are words, not a year', async () => {
  const { h, thread, asked } = setup(() => ok({ until: null, topic: 'MACG-3843 merged', why: 'an event' }));
  turnWithSnooze(h, thread.id, { needs: 'nothing', snooze: 'MACG-3843' });
  await tick();
  await tick();
  assert.equal(asked.length, 1);
  assert.equal(h.runner.get(thread.id).snoozedUntil, NO_WAKE_TIME);
});

// 13 Nov 2026: an agent hibernated "until the GPUI app replaces the Swift
// app", the model made that a topic, the librarian woke it when Mike talked
// about the plan in another thread, and it sat in the inbox with nothing done.
test('end_turn snooze in words: an agent waiting for something wakes with a turn to check, and can go back to sleep', async () => {
  const { h, thread, asked } = setup(() => ok({ until: null, topic: 'the GPUI app has replaced the Swift app', why: 'an event' }));
  turnWithSnooze(h, thread.id, { needs: 'nothing', snooze: 'until the GPUI app replaces the Swift app' });
  await tick();
  await tick();
  assert.match(asked[0].prompt, /The thread's agent is waiting: until the GPUI app replaces the Swift app/);
  assert.match(asked[0].system!, /thread's own agent asking/);
  const t = h.runner.get(thread.id);
  // `agent`: its own agent set it, so with commits not on main the sidebar
  // shows it as waiting to land, not hibernating (Mike's own has no flag).
  assert.deepEqual(t.wakeWhen, { said: 'until the GPUI app replaces the Swift app', topic: 'the GPUI app has replaced the Swift app', agent: true });
  assert.deepEqual(checkSummary(t), []);
  assert.match(h.events(thread.id).at(-1).text, /^Hibernating until the GPUI app has replaced the Swift app\. The agent said "until the GPUI app replaces the Swift app"\.$/);
  assert.deepEqual(h.runner.waitingTopics(), [{ threadId: thread.id, title: 'Plan the workbench drawers', topic: 'the GPUI app has replaced the Swift app', happened: true }]);
  const sessions = h.adapter.sessions.length;
  const other = h.runner.create({ text: 'GPUI Port Coordinator', accountId: 'claude-3' }).thread;
  assert.equal(h.runner.wakeForTopic(thread.id, other.id), true);
  await tick();
  assert.match(h.events(thread.id).filter((e) => e.type === 'system.note' && String(e.text).startsWith('Woke up')).at(-1).text, /^Woke up.*: to check whether the GPUI app has replaced the Swift app, from "GPUI Port Coordinator"\.$/);
  const sent = h.events(thread.id).filter((e) => e.type === 'user.message').at(-1);
  assert.match(String(sent.text), /You hibernated this thread until: until the GPUI app replaces the Swift app/);
  assert.match(String(sent.text), new RegExp(`another thread \\(${other.id.slice(0, 8)}\\)`));
  assert.match(String(sent.text), /snooze "until the GPUI app replaces the Swift app" to go back to sleep/);
  assert.ok(h.adapter.sessions.length > sessions, 'a turn started');
});

test('an agent that checks and goes back to sleep is not woken again by the same claim, only by more from that thread', async () => {
  const { h, thread } = setup(() => ok({ until: null, topic: 'the GPUI app has replaced the Swift app', why: 'an event' }));
  const said = 'until the GPUI app replaces the Swift app';
  turnWithSnooze(h, thread.id, { needs: 'nothing', snooze: said });
  await tick();
  await tick();
  const other = h.runner.create({ text: 'GPUI Port Coordinator', accountId: 'claude-3' }).thread;
  const shown = { topic: 'the GPUI app has replaced the Swift app', happened: true };
  // A look that judged another wait (Mike's kind, or other words) wakes nothing.
  assert.equal(h.runner.wakeForTopic(thread.id, other.id, { topic: 'woodworking', happened: true }), false);
  assert.equal(h.runner.wakeForTopic(thread.id, other.id, { ...shown, happened: false }), false);
  assert.equal(h.runner.wakeForTopic(thread.id, other.id, shown), true);
  await tick();
  // The agent checks, finds it hasn't, and snoozes again with the same words.
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e2', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing', snooze: said } } });
  s.text('m2', 'Not yet: the Swift app is still the one installed.');
  s.result('completed');
  await tick();
  await tick();
  assert.deepEqual(h.runner.list(['snoozed']).map((t) => t.id).includes(thread.id), true);
  // The same claim, with nothing new in that thread, doesn't wake it again.
  assert.equal(h.runner.wakeForTopic(thread.id, other.id, shown), false);
  // More from that thread is new evidence.
  h.runner.send(other.id, 'The GPUI app is now the one we ship.');
  await tick();
  assert.equal(h.runner.wakeForTopic(thread.id, other.id, shown), true);
});

test("Alex's own Wake when… still only brings the thread back, with no turn", async () => {
  const { h, thread } = setup(() => ok({ until: null, topic: 'woodworking', why: 'topic' }));
  await h.runner.hibernateWhen({ threadId: thread.id, said: 'next time I talk about woodworking' });
  assert.deepEqual(h.runner.waitingTopics(), [{ threadId: thread.id, title: 'Plan the workbench drawers', topic: 'woodworking' }]);
  const other = h.runner.create({ text: 'Router table jig', accountId: 'claude-3' }).thread;
  const before = h.events(thread.id).filter((e) => e.type === 'user.message').length;
  assert.equal(h.runner.wakeForTopic(thread.id, other.id), true);
  await tick();
  assert.equal(h.events(thread.id).filter((e) => e.type === 'user.message').length, before);
});

test('an agent woken from a thread with less access is told something happened, not which thread', async () => {
  const { h, thread } = setup(() => ok({ until: null, topic: 'the parts have arrived', why: 'an event' }));
  h.runner.update({ threadId: thread.id, permissionMode: 'full' });
  turnWithSnooze(h, thread.id, { needs: 'nothing', snooze: 'when the parts arrive' });
  await tick();
  await tick();
  const other = h.runner.create({ text: 'Parcel tracking', accountId: 'claude-3', permissionMode: 'ask' }).thread;
  assert.equal(h.runner.wakeForTopic(thread.id, other.id), true);
  await tick();
  const sent = String(h.events(thread.id).filter((e) => e.type === 'user.message').at(-1).text);
  assert.match(sent, /another thread looks to show it has/);
  assert.doesNotMatch(sent, new RegExp(other.id.slice(0, 8)));
});

test('end_turn snooze: words the model cannot read leave the thread in the inbox, saying why', async () => {
  const { h, thread } = setup(() => ({ ok: false, reason: 'provider', message: 'down' }));
  turnWithSnooze(h, thread.id, { needs: 'nothing', snooze: 'whenever' });
  await tick();
  await tick();
  assert.equal(h.runner.get(thread.id).snoozedUntil, undefined);
  assert.match(h.events(thread.id).at(-1).text, /^Not hibernated, as the agent was asked to: Couldn't work out when to wake it/);
});

test('end_turn snooze: not with needs "you", an interrupted turn, a past time, or archive as well', () => {
  const cases: [Record<string, unknown>, 'completed' | 'interrupted'][] = [
    [{ needs: 'you', asks: [{ question: 'Order the parts?' }], snooze: '1d' }, 'completed'],
    [{ needs: 'nothing', snooze: '1d' }, 'interrupted'],
    [{ needs: 'nothing', snooze: '2020-01-01T00:00:00Z' }, 'completed'],
  ];
  for (const [input, outcome] of cases) {
    const { h, thread } = setup(() => ok({}));
    turnWithSnooze(h, thread.id, input, outcome);
    assert.equal(h.runner.get(thread.id).snoozedUntil, undefined, JSON.stringify(input));
  }
  const { h, thread } = setup(() => ok({}));
  turnWithSnooze(h, thread.id, { needs: 'nothing', archive: true, snooze: '1d' });
  const t = h.runner.get(thread.id);
  assert.ok(t.archivedAt);
  assert.equal(t.snoozedUntil, undefined, 'archive wins');
});
