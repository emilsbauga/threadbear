// node --test web/src/command.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMAND_SLOW_MS, STOP_HOLD_MS, commandNote, idle, locked, step, type CommandState } from './command.ts';

type P = { text: string };
const start: CommandState<P> = idle();
const sent = (at = 0) => step(start, { kind: 'send', payload: { text: 'hi' }, at });

test('a send goes sending, then waiting once the backend has queued it', () => {
  const s = sent(100);
  assert.equal(s.kind, 'sending');
  assert.deepEqual(s.kind === 'sending' && s.payload, { text: 'hi' });
  const w = step(s, { kind: 'queued', attempt: 1, id: 'c1', at: 200 });
  assert.deepEqual(w, { kind: 'waiting', attempt: 1, id: 'c1', since: 200, taken: false, payload: { text: 'hi' } });
});

test('the runner taking it, then finishing it, ends at done with the thread it made', () => {
  let s = step(sent(), { kind: 'queued', attempt: 1, id: 'c1', at: 0 });
  s = step(s, { kind: 'report', id: 'c1', report: { state: 'pending' }, at: 10 });
  assert.equal(s.kind === 'waiting' && s.taken, false);
  s = step(s, { kind: 'report', id: 'c1', report: { state: 'taken', threadId: 't9' }, at: 500 });
  assert.equal(s.kind, 'waiting');
  assert.equal(s.kind === 'waiting' && s.taken, true);
  assert.equal(s.kind === 'waiting' && s.since, 500);
  assert.equal(s.kind === 'waiting' && s.threadId, 't9');
  s = step(s, { kind: 'report', id: 'c1', report: { state: 'done', threadId: 't9' }, at: 600 });
  assert.deepEqual(s, { kind: 'done', attempt: 1, id: 'c1', threadId: 't9', payload: { text: 'hi' } });
  // Still locked a moment, until the rows it changed have caught up.
  assert.equal(locked(s), true);
  const settled = step(s, { kind: 'settle' });
  assert.deepEqual(settled, { kind: 'idle', attempt: 1 });
  assert.equal(locked(settled), false);
});

test('a send the backend refuses fails with its error and keeps what was sent', () => {
  const s = step(sent(), { kind: 'queueFailed', attempt: 1, error: 'expired' });
  assert.deepEqual(s, { kind: 'failed', attempt: 1, error: 'expired', payload: { text: 'hi' } });
  assert.equal(locked(s), false);
});

test('a command the runner reports failed (or lapsed, which reads as failed) ends with its note', () => {
  const w = step(sent(), { kind: 'queued', attempt: 1, id: 'c1', at: 0 });
  const f = step(w, { kind: 'report', id: 'c1', report: { state: 'failed', note: 'Its runner never said how it went' }, at: 5 });
  assert.equal(f.kind, 'failed');
  assert.equal(f.kind === 'failed' && f.error, 'Its runner never said how it went');
  assert.equal(f.kind === 'failed' && f.id, 'c1');
  const noNote = step(w, { kind: 'report', id: 'c1', report: { state: 'failed' }, at: 5 });
  assert.equal(noNote.kind === 'failed' && noNote.error, 'unknown error');
});

test('a second press while one is on its way is ignored', () => {
  const s = sent();
  assert.equal(step(s, { kind: 'send', payload: { text: 'again' }, at: 1 }), s);
  const w = step(s, { kind: 'queued', attempt: 1, id: 'c1', at: 2 });
  assert.equal(step(w, { kind: 'send', payload: { text: 'again' }, at: 3 }), w);
  assert.equal(locked(s), true);
  assert.equal(locked(w), true);
});

test('a composer may send the next message once the last is queued, but never while it is still sending', () => {
  const s = sent();
  assert.equal(step(s, { kind: 'send', payload: { text: 'b' }, at: 1, again: true }), s);
  const w = step(s, { kind: 'queued', attempt: 1, id: 'c1', at: 2 });
  const next = step(w, { kind: 'send', payload: { text: 'b' }, at: 3, again: true });
  assert.equal(next.kind, 'sending');
  assert.equal(next.attempt, 2);
  // The first one's late answers no longer move it.
  assert.equal(step(next, { kind: 'report', id: 'c1', report: { state: 'failed' }, at: 4 }), next);
});

test('nothing heard in time goes slow, still locked, and still listening', () => {
  const w = step(sent(0), { kind: 'queued', attempt: 1, id: 'c1', at: 0 });
  assert.equal(step(w, { kind: 'tick', at: COMMAND_SLOW_MS - 1 }), w);
  const slow = step(w, { kind: 'tick', at: COMMAND_SLOW_MS });
  assert.deepEqual(slow, { kind: 'slow', attempt: 1, id: 'c1', taken: false, payload: { text: 'hi' } });
  assert.equal(locked(slow), true);
  assert.equal(step(slow, { kind: 'send', payload: { text: 'x' }, at: 1 }), slow);
  assert.equal(step(slow, { kind: 'report', id: 'c1', report: { state: 'done' }, at: 9 }).kind, 'done');
  assert.equal(step(slow, { kind: 'report', id: 'c1', report: { state: 'failed', note: 'gone' }, at: 9 }).kind, 'failed');
  // Dismissing it lets go: the button can be pressed again.
  assert.deepEqual(step(slow, { kind: 'dismiss' }), { kind: 'idle', attempt: 1 });
});

test('a send that never reaches the backend goes slow too, and its late answer still lands', () => {
  const s = sent(0);
  const slow = step(s, { kind: 'tick', at: COMMAND_SLOW_MS });
  assert.deepEqual(slow, { kind: 'slow', attempt: 1, taken: false, payload: { text: 'hi' } });
  assert.equal(step(slow, { kind: 'queued', attempt: 1, id: 'c1', at: 50_000 }).kind, 'waiting');
  assert.equal(step(slow, { kind: 'queueFailed', attempt: 1, error: 'offline' }).kind, 'failed');
  // No letting go of it: the client is still retrying, so pressing again would send it twice.
  assert.equal(step(slow, { kind: 'dismiss' }), slow);
  assert.equal(locked(slow), true);
  assert.equal(commandNote(slow)?.dismiss, false);
});

test('only a slow command the backend has can be dismissed, and sending says so only when asked', () => {
  const w = step(sent(0), { kind: 'queued', attempt: 1, id: 'c1', at: 0 });
  assert.equal(commandNote(step(w, { kind: 'tick', at: COMMAND_SLOW_MS }))?.dismiss, true);
  assert.equal(commandNote(sent()), null);
  assert.equal(commandNote(sent(), { sending: true })?.text, 'Sending…');
  assert.equal(step(start, { kind: 'settle' }), start);
});

test('answers from an earlier attempt, or another command, are ignored', () => {
  const s = sent();
  assert.equal(step(s, { kind: 'queued', attempt: 0, id: 'old', at: 0 }), s);
  assert.equal(step(s, { kind: 'queueFailed', attempt: 7, error: 'x' }), s);
  const w = step(s, { kind: 'queued', attempt: 1, id: 'c1', at: 0 });
  assert.equal(step(w, { kind: 'report', id: 'c2', report: { state: 'done' }, at: 0 }), w);
  // Dismissed while still sending is refused: there's no taking it back.
  assert.equal(step(s, { kind: 'dismiss' }), s);
  // A late report after a dismiss doesn't bring the old command back.
  const q = step(s, { kind: 'queued', attempt: 1, id: 'c1', at: 0 });
  const gone = step(step(step(q, { kind: 'tick', at: COMMAND_SLOW_MS }), { kind: 'dismiss' }), { kind: 'report', id: 'c1', report: { state: 'failed' }, at: 0 });
  assert.equal(gone.kind, 'idle');
});

test('failed can be pressed again, done once it settles, and both dismissed', () => {
  const f = step(sent(), { kind: 'queueFailed', attempt: 1, error: 'x' });
  assert.equal(step(f, { kind: 'send', payload: { text: 'again' }, at: 0 }).kind, 'sending');
  assert.equal(step(f, { kind: 'dismiss' }).kind, 'idle');
  const d = step(step(sent(), { kind: 'queued', attempt: 1, id: 'c1', at: 0 }), { kind: 'report', id: 'c1', report: { state: 'done' }, at: 0 });
  // Done is locked until it settles; a composer's next message isn't held up.
  assert.equal(step(d, { kind: 'send', payload: { text: 'again' }, at: 0 }), d);
  assert.equal(step(d, { kind: 'send', payload: { text: 'again' }, at: 0, again: true }).attempt, 2);
  assert.equal(step(step(d, { kind: 'settle' }), { kind: 'send', payload: { text: 'again' }, at: 0 }).attempt, 2);
});

// The same machine the phones run (PendingCommand in each kit), against the
// cases all three share (shared/cases/pending-commands.json). The website's
// waiting is the phones' queued or taken, and its slow their timedOut.
type SharedEvent = { event: string; at?: number; id?: string; reason?: string; state?: string | null; note?: string; threadId?: string };
type SharedCase = { name: string; input: SharedEvent[]; expect: Record<string, unknown>; differs?: Record<string, string> };

function shared(s: CommandState<P>): Record<string, unknown> {
  const out: Record<string, unknown> = { locked: locked(s) };
  switch (s.kind) {
    case 'idle':
    case 'sending':
      out.state = s.kind;
      break;
    case 'waiting':
      out.state = s.taken ? 'taken' : 'queued';
      out.id = s.id;
      break;
    case 'slow':
      out.state = 'timedOut';
      out.taken = s.taken;
      if (s.id) out.id = s.id;
      break;
    case 'done':
      out.state = 'done';
      out.id = s.id;
      if (s.threadId) out.threadId = s.threadId;
      break;
    case 'failed':
      out.state = 'failed';
      if (s.id) out.id = s.id;
      out.reason = s.error;
      break;
  }
  return out;
}

test('moves match the cases the phones run too', () => {
  const file = new URL('../../shared/cases/pending-commands.json', import.meta.url);
  const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: SharedCase[] };
  const run = cases.filter((c) => !c.differs?.web);
  assert.ok(run.length > 10);
  for (const c of run) {
    let s: CommandState<P> = idle();
    for (const e of c.input) {
      const at = e.at ?? 0;
      const id = 'id' in s && s.id ? s.id : (e.id ?? 'c1');
      switch (e.event) {
        case 'tap': s = step(s, { kind: 'send', payload: { text: 'x' }, at }); break;
        case 'sent': s = step(s, { kind: 'queued', attempt: s.attempt, id: e.id!, at }); break;
        case 'sendFailed': s = step(s, { kind: 'queueFailed', attempt: s.attempt, error: e.reason! }); break;
        case 'row':
          assert.ok(e.state, `${c.name}: the website has no gone row`);
          s = step(s, { kind: 'report', id, report: { state: e.state as 'pending' | 'taken' | 'done' | 'failed', ...(e.note ? { note: e.note } : {}), ...(e.threadId ? { threadId: e.threadId } : {}) }, at });
          break;
        case 'deadline': s = step(s, { kind: 'tick', at }); break;
        case 'settle': s = step(s, { kind: 'settle' }); break;
        default: assert.fail(`${c.name}: the website has no ${e.event} event; say so in the case's differs`);
      }
    }
    assert.deepEqual(shared(s), c.expect, c.name);
  }
});

// Stop (bug 8, 23 Nov): the runner says done as soon as it has asked the CLI
// to stop, and the turn runs on for up to 10 s. Settling after the usual
// moment showed a pressable Stop again while it ran, and a second press sent
// a second interrupt. Now done holds until the turn is over, or STOP_HOLD_MS.
test('Stop holds after done until its turn is over, then takes clicks again', () => {
  let s = step(sent(), { kind: 'queued', attempt: 1, id: 'c1', at: 0 });
  s = step(s, { kind: 'report', id: 'c1', report: { state: 'done' }, at: 300 });
  assert.equal(locked(s), true, 'done: still stopping');
  // A second press while the turn runs on does nothing.
  assert.equal(step(s, { kind: 'send', payload: { text: 'hi' }, at: 1500 }), s);
  const over = step(s, { kind: 'over' });
  assert.deepEqual(over, { kind: 'idle', attempt: 1 });
  assert.equal(locked(over), false);
  // As long as the iPhone holds its Stop, and longer than the usual settle.
  assert.equal(STOP_HOLD_MS, 10_000);
});

test('the turn ending before the runner answers lets Stop go too, but a refusal stays said', () => {
  for (const s of [sent(), step(sent(), { kind: 'queued', attempt: 1, id: 'c1', at: 0 }), step(sent(), { kind: 'tick', at: COMMAND_SLOW_MS })]) {
    assert.deepEqual(step(s, { kind: 'over' }), { kind: 'idle', attempt: 1 }, s.kind);
  }
  // The send's answer coming after it's over moves nothing.
  const gone = step(sent(), { kind: 'over' });
  assert.equal(step(gone, { kind: 'queued', attempt: 1, id: 'c1', at: 10 }), gone);
  const refused = step(step(sent(), { kind: 'queued', attempt: 1, id: 'c1', at: 0 }), { kind: 'report', id: 'c1', report: { state: 'failed', note: 'not running' }, at: 50 });
  assert.equal(step(refused, { kind: 'over' }), refused);
  assert.equal(commandNote(refused)?.text, 'Didn’t work: not running');
  assert.equal(step(idle(), { kind: 'over' }).kind, 'idle');
});

test("the website's Stop holds for its turn: STOP_HOLD_MS and over, wired in the Dock", () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  assert.match(app, /useCommand\(token, \{ settleMs: STOP_HOLD_MS \}\)/);
  assert.match(app, /if \(turnOn\) return;\s*stopOver\(\);/);
  // A card waiting on Mike mid-turn isn't the turn's end.
  assert.match(app, /const turnOn = busy\(t\) \|\| t\.status === 'waiting'/);
});

test("a Stop pressed before the thread's page was made again still holds, until it runs out or the turn ends", async () => {
  const { holdStop, releaseStop, stopHeldFor } = await import('./stop-hold.ts');
  holdStop('t1', 1000);
  assert.equal(stopHeldFor('t1', 1000), STOP_HOLD_MS);
  assert.equal(stopHeldFor('t1', 6000), STOP_HOLD_MS - 5000, 'opened again 5 s later: 5 s left');
  assert.equal(stopHeldFor('t2', 6000), 0, 'another thread has none');
  assert.equal(stopHeldFor('t1', 1000 + STOP_HOLD_MS), 0, 'run out');
  holdStop('t1', 0);
  releaseStop('t1');
  assert.equal(stopHeldFor('t1', 1), 0, 'the turn ended');
});
