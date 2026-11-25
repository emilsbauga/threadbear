// A sleeping thread woken for its agent to check whether what it waits for
// has happened, because the librarian thinks another thread shows it has
// (Runner.wakeForTopic, wakeToCheck): quiet while it checks, as a check at
// a wait's latest time is (wake-latest.test.ts).
//
// 20 Nov 2026: the librarian read a thread about something else as showing
// that an email a thread waited on had come. The waiting thread woke,
// marked unread and with a push to Mike's phone, checked, found it hadn't,
// and was asleep again 26 seconds later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { CARRY_ON_NETWORK } from '../../src/runner.ts';
import type { GenerateParams, ModelResult } from '../../src/models/index.ts';

const DAY = 86_400_000;
const END_TURN = 'mcp__threadbear__end_turn';
const SAID = 'until the supplier sends the test results';
const TOPIC = 'the supplier has sent the test results';

const ok = (v: unknown): ModelResult<string> => ({ ok: true, value: JSON.stringify(v), model: 'opus' });

type H = ReturnType<typeof makeHarness>;

// A thread whose agent has hibernated it until something happens (a topic,
// with a latest time `latest` ms off if given), seen by Alex, and another
// thread for the librarian to have read.
async function setup(latest?: number, mode?: 'ask' | 'full') {
  let fail = false;
  const generate = async (p: GenerateParams): Promise<ModelResult<string>> => {
    if (p.feature !== 'wake-when') return { ok: false, reason: 'off', message: 'off' };
    if (fail) return { ok: false, reason: 'provider', message: 'down' };
    return ok({ why: 'x', topic: TOPIC, until: latest ? new Date(h.clock.now() + latest).toISOString() : null });
  };
  const h = makeHarness(undefined, {}, { models: { generate } });
  const { thread } = h.runner.create({ text: 'Order the parts', accountId: 'claude-3', ...(mode ? { permissionMode: mode } : {}) });
  h.adapter.last.init();
  h.adapter.last.result();
  h.runner.send(thread.id, 'wait for the supplier');
  await tick();
  h.adapter.last.init();
  await endTurn(h, { needs: 'nothing', snooze: SAID });
  const other = h.runner.create({ text: 'Lost parcel', accountId: 'claude-3', ...(mode ? { permissionMode: mode } : {}) }).thread;
  h.runner.markSeen(thread.id, h.runner.get(thread.id).lastSeq);
  assert.equal(h.runner.get(thread.id).needsYou, false);
  assert.ok(asleep(h, thread.id));
  return { h, id: thread.id, other: other.id, failModel: () => (fail = true) };
}

async function endTurn(h: H, input: Record<string, unknown>, said = 'Still waiting.') {
  const s = h.adapter.last;
  s.text(`m${Math.random()}`, said);
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: `e${Math.random()}`, name: END_TURN, kind: 'mcp', title: 'end_turn', input } });
  s.result('completed');
  await tick();
  await tick();
}

const notes = (h: H, id: string) => h.events(id).filter((e) => e.type === 'system.note').map((e) => String(e.text));
const turns = (h: H, id: string) => h.events(id).filter((e) => e.type === 'turn.started').length;
const asleep = (h: H, id: string) => h.runner.list(['snoozed']).some((t) => t.id === id);

test("a false alarm is silent: the librarian's check doesn't mark the thread as needing Alex, and it goes back to sleep unnoticed", async () => {
  const { h, id, other } = await setup();
  const before = turns(h, id);
  assert.equal(h.runner.wakeForTopic(id, other, { topic: TOPIC, happened: true }), true);
  await tick();
  assert.equal(turns(h, id), before + 1, 'a turn to check');
  assert.match(notes(h, id).filter((t) => t.startsWith('Woke up')).at(-1)!, /^Woke up.*: to check whether the supplier has sent the test results, from "Lost parcel"\.$/);
  assert.match(h.adapter.last.sent.at(-1)!.text, /^You hibernated this thread until: until the supplier sends the test results\n\nThreadbear woke it because another thread/);
  // Checking: no dot, no "Woke up" on its row, no notification or phone push.
  const checking = h.runner.get(id);
  assert.equal(checking.needsYou, false, 'not while it checks');
  assert.equal(checking.woke, undefined);
  h.adapter.last.init();
  await endTurn(h, { needs: 'nothing', snooze: SAID }, 'Not yet: that thread was about a parcel.');
  assert.ok(asleep(h, id));
  assert.equal(h.runner.get(id).needsYou, false, 'nor once it is asleep again');
  assert.equal(h.runner.threads.get(id)!.rec.wakeNews, undefined);
});

test('it has happened: a check that carries on and ends in the inbox is unread, however it ends', async () => {
  // Done, with nothing needed.
  const a = await setup();
  a.h.runner.wakeForTopic(a.id, a.other, { topic: TOPIC, happened: true });
  await tick();
  a.h.adapter.last.init();
  await endTurn(a.h, { needs: 'nothing' }, 'The results are in. I have ordered the parts.');
  assert.equal(asleep(a.h, a.id), false);
  const done = a.h.runner.get(a.id);
  assert.equal(done.needsYou, true);
  assert.ok(done.woke, 'its row says it woke');
  // Asking him something.
  const b = await setup();
  b.h.runner.wakeForTopic(b.id, b.other, { topic: TOPIC, happened: true });
  await tick();
  b.h.adapter.last.init();
  await endTurn(b.h, { needs: 'you', asks: [{ question: 'Order the parts?', options: [{ label: 'Order' }, { label: 'Wait' }] }] }, 'The results are in.');
  assert.equal(b.h.runner.get(b.id).needsYou, true);
  // The same for a check at a wait's latest time.
  const c = await setup(DAY);
  c.h.clock.advance(DAY);
  await tick();
  assert.equal(c.h.runner.get(c.id).needsYou, false, 'not while it checks');
  c.h.adapter.last.init();
  await endTurn(c.h, { needs: 'nothing' }, 'The results came this morning. Parts ordered.');
  assert.equal(c.h.runner.get(c.id).needsYou, true);
});

test('a check that never reaches the agent leaves the thread awake, unread and saying why, and the next message tells its agent', async () => {
  const { h, id, other } = await setup();
  const cwd = h.runner.get(id).cwd;
  fs.renameSync(cwd, `${cwd}-away`);
  h.runner.wakeForTopic(id, other, { topic: TOPIC, happened: true });
  await tick();
  await tick();
  assert.equal(h.events(id).filter((e) => e.type === 'turn.completed').at(-1).outcome, 'failed');
  assert.equal(asleep(h, id), false);
  assert.equal(h.runner.get(id).needsYou, true);
  assert.ok(h.runner.get(id).woke, 'its row says it woke');
  assert.ok(notes(h, id).some((t) => /^Woke up.*: to check whether the supplier has sent the test results/.test(t)));
  fs.renameSync(`${cwd}-away`, cwd);
  h.runner.send(id, 'Any reason why this woke up?');
  await tick();
  const sent = h.adapter.last.sent.at(-1)!.text;
  assert.match(sent, /^Note from Threadbear: this thread woke by itself on .+\. You had hibernated it until: until the supplier sends the test results \(the supplier has sent the test results\)\. Another thread looked to show that has happened, which is a guess from reading one thread\. It sent you a message to check for yourself\./);
  assert.match(sent, /do that check now as well\.\n\nAny reason why this woke up\?$/);
});

test('a message queued ahead of the check goes first and is told the check comes next; the thread is unread while the check waits', async () => {
  const { h, id, other } = await setup();
  const st = h.runner.threads.get(id)!;
  st.rec.queue.push({ turnId: 'queued-1', text: 'A reminder left waiting', images: [], origin: 'schedule' });
  h.runner.wakeForTopic(id, other, { topic: TOPIC, happened: true });
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /^Note from Threadbear: this thread woke by itself on [\s\S]*comes after this one, so leave the check to it\.\n\nA reminder left waiting$/);
  assert.equal(st.rec.forceUnread, true);
  h.adapter.last.init();
  await endTurn(h, { needs: 'nothing' }, 'Noted.');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /^You hibernated this thread until: /);
  // Dropped from the queue instead, as a restart drops it: Alex's next message says to check.
  const lost = await setup();
  const st2 = lost.h.runner.threads.get(lost.id)!;
  st2.rec.queue.push({ turnId: 'queued-1', text: 'A reminder left waiting', images: [], origin: 'schedule' });
  lost.h.runner.wakeForTopic(lost.id, lost.other, { topic: TOPIC, happened: true });
  await tick();
  lost.h.adapter.last.init();
  st2.rec.queue = [];
  await endTurn(lost.h, { needs: 'nothing' }, 'Noted.');
  assert.equal(lost.h.runner.get(lost.id).needsYou, true, 'still marked: its check never ran');
  lost.h.runner.send(lost.id, 'Any reason why this woke up?');
  await tick();
  assert.match(lost.h.adapter.last.sent.at(-1)!.text, /do that check now as well\.\n\nAny reason why this woke up\?$/);
});

test('a check whose snooze does not take leaves the thread marked for Alex', async () => {
  const { h, id, other, failModel } = await setup();
  h.runner.wakeForTopic(id, other, { topic: TOPIC, happened: true });
  await tick();
  h.adapter.last.init();
  failModel();
  await endTurn(h, { needs: 'nothing', snooze: SAID });
  assert.equal(asleep(h, id), false);
  assert.match(notes(h, id).at(-1)!, /^Not hibernated, as the agent was asked to: /);
  assert.equal(h.runner.get(id).needsYou, true);
});

test('given more access while it slept: the check is still held for Alex, with no turn', async () => {
  const { h, id, other } = await setup(undefined, 'ask');
  h.runner.update({ threadId: id, permissionMode: 'full' });
  const before = turns(h, id);
  h.runner.wakeForTopic(id, other, { topic: TOPIC, happened: true });
  await tick();
  assert.equal(turns(h, id), before, 'no turn');
  assert.equal(asleep(h, id), false);
  assert.equal(h.runner.get(id).needsYou, true);
  assert.match(notes(h, id).at(-1)!, /wasn't passed to this thread's agent/);
});

test("Alex's own topic still wakes the thread for him: unread, with no turn", async () => {
  const generate = async (p: GenerateParams): Promise<ModelResult<string>> => (p.feature === 'wake-when' ? ok({ why: 'x', topic: 'woodworking', until: null }) : { ok: false, reason: 'off', message: 'off' });
  const h = makeHarness(undefined, {}, { models: { generate } });
  const { thread } = h.runner.create({ text: 'Plan the drawers', accountId: 'claude-3' });
  h.adapter.last.init();
  h.adapter.last.result();
  await h.runner.hibernateWhen({ threadId: thread.id, said: 'next time I talk about woodworking' });
  h.runner.markSeen(thread.id, h.runner.get(thread.id).lastSeq);
  const other = h.runner.create({ text: 'Router table jig', accountId: 'claude-3' }).thread;
  const before = turns(h, thread.id);
  assert.equal(h.runner.wakeForTopic(thread.id, other.id), true);
  await tick();
  assert.equal(turns(h, thread.id), before);
  const t = h.runner.get(thread.id);
  assert.equal(t.needsYou, true);
  assert.ok(t.woke);
});

// From Codex's review of the fix (23 Nov 2026).
test('Stop as the check finishes, with nothing needed and no snooze: still marked, as nothing else says it is awake', async () => {
  const { h, id, other } = await setup();
  h.runner.wakeForTopic(id, other, { topic: TOPIC, happened: true });
  await tick();
  const s = h.adapter.last;
  s.init();
  s.text('m-stop', 'The results are in.');
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e-stop', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  h.runner.interrupt(id);
  s.result('completed');
  await tick();
  assert.equal(asleep(h, id), false);
  assert.equal(h.runner.get(id).needsYou, true);
});

// (A turn that loses the network reads as unread by itself while it waits,
// as any thread's does: that is not the check's doing, and not changed here.)
test('a check cut off by a lost network gets no mark of its own while the runner is to carry it on, nor if the carry-on goes back to sleep', async () => {
  const { h, id, other } = await setup();
  h.runner.wakeForTopic(id, other, { topic: TOPIC, happened: true });
  await tick();
  h.adapter.last.init();
  h.adapter.last.result('failed', undefined, 'network', { errorKind: 'network' });
  await tick();
  assert.notEqual(h.runner.threads.get(id)!.rec.forceUnread, true);
  h.runner.send(id, CARRY_ON_NETWORK, [], { origin: 'runner', queue: true });
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /do that check now as well\./);
  h.adapter.last.init();
  await endTurn(h, { needs: 'nothing', snooze: SAID }, 'Not yet.');
  assert.ok(asleep(h, id));
  assert.notEqual(h.runner.threads.get(id)!.rec.forceUnread, true);
  assert.equal(h.runner.threads.get(id)!.rec.wakeNews, undefined);
});

test('a helper thread whose check finishes with nothing left archives itself without being marked for Alex', async () => {
  const generate = async (p: GenerateParams): Promise<ModelResult<string>> => (p.feature === 'wake-when' ? ok({ why: 'x', topic: TOPIC, until: null }) : { ok: false, reason: 'off', message: 'off' });
  const h = makeHarness(undefined, {}, { models: { generate } });
  const parent = h.runner.create({ text: 'Plan the order', accountId: 'claude-3' }).thread.id;
  const child = h.runner.create({ text: 'Wait for the supplier', accountId: 'claude-3', startedBy: { kind: 'thread', label: 'Agent', threadId: parent } }).thread.id;
  const session = () => h.adapter.sessions.filter((x) => x.opts.threadId === child).at(-1)!;
  session().init();
  session().out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing', snooze: SAID } } });
  session().text('m1', 'Waiting.');
  session().result('completed');
  await tick();
  await tick();
  assert.ok(asleep(h, child));
  const marks: boolean[] = [];
  h.runner.onNotification((n) => {
    if (n.method === 'thread.updated' && n.params.thread.id === child) marks.push(n.params.thread.needsYou);
  });
  h.runner.wakeForTopic(child, parent, { topic: TOPIC, happened: true });
  await tick();
  session().init();
  session().out({ kind: 'event', event: { type: 'tool.call', itemId: 'e2', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  session().text('m2', 'The results are in; told the thread that started me.');
  session().result('completed');
  const end = Date.now() + 10_000;
  while (!h.runner.get(child).archivedAt && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.runner.get(child).archivedAt, 'archived itself');
  h.runner.flush();
  assert.deepEqual(marks.filter(Boolean), [], 'never shown as needing Alex');
});

// From Gemini's review of the fix (23 Nov 2026).
test('a mark left from before it slept does not make the next false alarm loud', async () => {
  const { h, id, other } = await setup();
  // An earlier wake Alex never opened left it unread as it went back to sleep.
  h.runner.threads.get(id)!.rec.forceUnread = true;
  h.runner.wakeForTopic(id, other, { topic: TOPIC, happened: true });
  await tick();
  const checking = h.runner.get(id);
  assert.equal(checking.needsYou, false);
  assert.equal(checking.woke, undefined);
  h.adapter.last.init();
  await endTurn(h, { needs: 'nothing', snooze: SAID }, 'Not yet.');
  assert.ok(asleep(h, id));
  assert.equal(h.runner.get(id).needsYou, false);
});

test("a lost check that Alex's own message has done is not marked again once he has read it", async () => {
  const { h, id, other } = await setup();
  h.runner.wakeForTopic(id, other, { topic: TOPIC, happened: true });
  await tick();
  h.adapter.last.init();
  h.adapter.last.result('failed', undefined, 'API Error: overloaded');
  await tick();
  assert.equal(h.runner.get(id).needsYou, true);
  // He opens it and asks.
  h.runner.markSeen(id, h.runner.get(id).lastSeq);
  h.runner.send(id, 'Any reason why this woke up?');
  await tick();
  assert.match(h.adapter.last.sent.at(-1)!.text, /do that check now as well\./);
  h.adapter.last.init();
  await endTurn(h, { needs: 'nothing' }, 'Another thread looked to show the results had come. I checked: they have not.');
  assert.equal(h.runner.threads.get(id)!.rec.forceUnread, false, 'not marked again by the turn he asked for');
  assert.equal(h.runner.threads.get(id)!.rec.wakeNews, undefined);
});
