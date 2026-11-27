// The wait state (runner/src/wait-state.ts): the runner gets every case in
// shared/cases/wait-states.json, and every move the rule can make between two
// cases' threads is one the table lists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeHarness, tmpDir } from '../helpers/fakes.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';
import type { Schedule } from '../../src/protocol.ts';
import { WAIT_MOVES, WAIT_STATES, allowed, countsForMike, sectionOf, urgencyOf, waitStateOf, type WaitInputs, type WaitState } from '../../src/wait-state.ts';

type Case = { name: string; thread: Partial<WaitInputs> & { starredAt?: string }; scheduled?: boolean; state: WaitState; section: string; urgency: number; counted: boolean };
const file = JSON.parse(fs.readFileSync(new URL('../../../shared/cases/wait-states.json', import.meta.url), 'utf8')) as { now: string; cases: Case[] };
const now = Date.parse(file.now);

for (const c of file.cases) {
  test(`wait state: ${c.name}`, () => {
    const t: WaitInputs = { status: 'idle', needsYou: false, ...c.thread };
    const state = waitStateOf(t, { now, scheduled: Boolean(c.scheduled) });
    assert.equal(state, c.state);
    assert.equal(sectionOf(state, Boolean(c.thread.starredAt)), c.section);
    assert.equal(urgencyOf(state, t.status), c.urgency);
    assert.equal(countsForMike(state, t.status), c.counted);
  });
}

test('every state has a description, and every move names states that exist', () => {
  for (const [state, info] of Object.entries(WAIT_STATES)) assert.ok(info.description.length > 10, state);
  for (const m of WAIT_MOVES) {
    assert.ok(m.to in WAIT_STATES, m.to);
    if (m.from !== '*') for (const f of m.from) assert.ok(f in WAIT_STATES, f);
    assert.ok(m.on.length > 5);
  }
});

test('every state can be reached and left', () => {
  for (const s of Object.keys(WAIT_STATES) as WaitState[]) {
    assert.ok(WAIT_MOVES.some((m) => m.to === s), `nothing moves into ${s}`);
    assert.ok(WAIT_MOVES.some((m) => m.from === '*' || m.from.includes(s)), `nothing moves out of ${s}`);
  }
});

test('archiving is allowed from anywhere', () => {
  for (const s of Object.keys(WAIT_STATES) as WaitState[]) assert.ok(allowed(s, 'archived'));
});

test('a few moves the table refuses', () => {
  assert.equal(allowed('done', 'card'), false, 'a card needs a turn');
  assert.equal(allowed('scheduled', 'landing'), false);
  assert.equal(allowed('hibernating', 'job'), false);
});

test('a coordinator\'s helper keeps it busy, after anything asked of Mike', () => {
  const idle: WaitInputs = { status: 'idle', needsYou: false, needs: 'nothing' };
  assert.equal(waitStateOf(idle, { now, scheduled: true }), 'scheduled');
  assert.equal(waitStateOf(idle, { now, scheduled: true, helpers: 1 }), 'job');
  assert.equal(waitStateOf({ ...idle, needs: 'you', asks: [{}] }, { now, scheduled: true, helpers: 1 }), 'needsYou');
  assert.equal(waitStateOf({ ...idle, pendingReviews: 1 }, { now, scheduled: false, helpers: 1 }), 'review');
  assert.equal(waitStateOf({ ...idle, snoozedUntil: '2999-01-01T00:00:00Z' }, { now, scheduled: false, helpers: 1 }), 'hibernating');
  for (const from of ['done', 'scheduled', 'needsYou', 'review'] as WaitState[]) assert.ok(allowed(from, 'job'), from);
});

// ------------------------------------------------------------ on a real runner

const END_TURN = 'mcp__threadbear__end_turn';

async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + PATIENCE_MS;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('a thread summary says what it waits on, from its first turn to done, and a schedule booked re-sends it', async () => {
  const h = makeHarness(tmpDir());
  let schedules: Schedule[] = [];
  h.runner.schedulesFor = () => schedules;
  const sent: { id: string; state?: string }[] = [];
  h.runner.onNotification((n) => {
    if (n.method === 'thread.updated') sent.push({ id: n.params.thread.id, state: n.params.thread.waitState });
  });
  const { thread } = h.runner.create({ text: 'Fix it', accountId: 'claude-main' });
  assert.equal(thread.waitState, 'working');
  const s = h.adapter.sessions.at(-1)!;
  s.init();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  s.text('m1', 'Done.');
  s.result('completed');
  await until(() => h.runner.get(thread.id).waitState === 'done', 'done');
  h.runner.publish({ method: 'schedules.updated', params: { schedules } });
  await until(() => !h.runner.dirty.has(thread.id), 'the first list flushed');
  sent.length = 0;
  schedules = [{ id: 's1', title: 'Check in', text: 'look again', whenText: 'tomorrow', threadId: thread.id, nextRunAt: '2099-01-01T00:00:00Z' } as Schedule];
  // A summary made before the list goes out (Codex's review, 23 Nov) doesn't
  // stop the re-send.
  assert.equal(h.runner.get(thread.id).waitState, 'scheduled');
  h.runner.publish({ method: 'schedules.updated', params: { schedules } });
  await until(() => sent.some((x) => x.id === thread.id && x.state === 'scheduled'), 'the re-sent summary');
  // A change that moves nothing sends nothing: the next thing sent for the
  // thread is what a later change of its own sends.
  sent.length = 0;
  h.runner.publish({ method: 'schedules.updated', params: { schedules } });
  h.runner.markDirty(h.runner.threads.get(thread.id)!);
  await until(() => sent.length > 0, 'the marker');
  assert.equal(sent.length, 1);
});

test('the first schedule removed after a start re-sends its thread', async () => {
  const h = makeHarness(tmpDir());
  const { thread } = h.runner.create({ text: 'Fix it', accountId: 'claude-main' });
  const s = h.adapter.sessions.at(-1)!;
  s.init();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: END_TURN, kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  s.text('m1', 'Done.');
  s.result('completed');
  let schedules: Schedule[] = [{ id: 's1', title: 'Check in', text: 'look again', whenText: 'tomorrow', threadId: thread.id, nextRunAt: '2099-01-01T00:00:00Z' } as Schedule];
  h.runner.schedulesFor = () => schedules;
  await until(() => h.runner.get(thread.id).waitState === 'scheduled', 'scheduled');
  await until(() => !h.runner.dirty.has(thread.id), 'flushed');
  // No list went out yet; then the schedule goes.
  const sent: (string | undefined)[] = [];
  h.runner.onNotification((n) => {
    if (n.method === 'thread.updated' && n.params.thread.id === thread.id) sent.push(n.params.thread.waitState);
  });
  schedules = [];
  h.runner.publish({ method: 'schedules.updated', params: { schedules } });
  await until(() => sent.includes('done'), 'the re-sent summary');
});
