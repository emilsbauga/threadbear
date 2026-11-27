// A thread's CLI (src/cli-session.ts): every state against every event, and
// long random walks, checked against the hand-written field writes in
// runner.ts and its parts that it replaced (kept below as the reference),
// and the fields read as a state and written back unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CLI_FIELDS, STALE, cliFields, cliHears, cliKind, cliOf, cliRuntime, moveCli, runningSession, type CliEvent, type CliFields, type CliOut } from '../../src/cli-session.ts';
import type { AgentSession, BackgroundTask } from '../../src/adapters/types.ts';
import type { Spare } from '../../src/runner/warm-start.ts';

type F = CliFields & Record<string, unknown>;

// Stand-ins: only their identity matters here.
const session = (name: string) => ({ name }) as unknown as AgentSession;
const spareOf = (name: string) => ({ id: name }) as unknown as Spare;
const dones = new Map<string, Promise<void>>();
const done = (name: string): Promise<void> => {
  if (!dones.has(name)) dones.set(name, Promise.resolve());
  return dones.get(name)!;
};
const task = (id: string): BackgroundTask => ({ id, type: 'shell', kind: 'shell', description: `job ${id}` });

const A = session('A');
const B = session('B');
const S1 = spareOf('s1');
const S2 = spareOf('s2');

// What the old code handed on, the same for both: what a release ends and
// says it stopped, what delete stops, the spare startSession takes, and the
// flags onExited and the version output read before writing.
type Outcome = { end?: { session: AgentSession; hard: boolean; stopped: string[] }; forgot?: AgentSession; spare?: Spare; released?: boolean; reportStart?: boolean; stale?: true };

// ---- The reference: the writes by hand before cli-session.ts ----
// (as they were at d32fa7944: startSession, onOutput's session, cliVersion
// and tasks cases, onExited, releaseSession and its finally, releaseIdle,
// update's and the parts' releaseWhenIdle, sendTo's and the review answer's,
// delete, letGo, shutdown, threads.create's claim, warm start's claim timer
// and takeSpare), on a copy.
function byHand(rt: F, e: CliEvent): Outcome {
  switch (e.kind) {
    case 'claim':
      rt.spare = e.spare;
      return {};
    case 'spareGone':
      if (rt.spare !== e.spare) return {};
      rt.spare = undefined;
      return {};
    case 'begin':
      ++rt.generation;
      rt.resumed = e.resume;
      rt.versionMove = false;
      rt.releaseWhenIdle = false;
      rt.started = false;
      return {};
    case 'takeSpare': {
      const spare = rt.spare;
      if (!spare) return {};
      rt.spare = undefined;
      return { spare };
    }
    case 'spawned':
      rt.session = e.session;
      return {};
    case 'init':
      if (rt.generation !== e.gen) return { stale: true };
      rt.retriedFresh = false;
      return {};
    case 'version': {
      if (rt.generation !== e.gen) return { stale: true };
      const o: Outcome = {};
      // onOutput's cliVersion: tellStarted(…, true) the first time.
      if (!rt.started) {
        rt.started = true;
        o.reportStart = true;
      }
      if (e.atWanted) rt.versionMove = false;
      return o;
    }
    case 'tasks':
      if (rt.generation !== e.gen) return { stale: true };
      rt.tasks = e.tasks;
      return {};
    case 'exited': {
      if (rt.generation !== e.gen) return { stale: true };
      const o: Outcome = { released: rt.releasedGen === e.gen };
      // onExited: `if (err && !started && !missing && !released)
      // tellStarted(…, false)`, with failed for err && !missing.
      if (e.failed && !rt.started && !o.released) o.reportStart = false;
      rt.session = undefined;
      if (rt.releasedGen === e.gen) rt.releasedGen = undefined;
      return o;
    }
    case 'retryFresh':
      rt.retriedFresh = true;
      return {};
    case 'leave':
      rt.releaseWhenIdle = true;
      return {};
    case 'stay':
      rt.releaseWhenIdle = false;
      return {};
    case 'versionMove':
      rt.versionMove = e.move;
      return {};
    case 'release': {
      if (!rt.session) rt.releaseWhenIdle = false;
      if (!rt.session || rt.closing) return {};
      const s = rt.session;
      const hard = rt.tasks.length > 0;
      const stopped = rt.tasks.map((t) => t.id);
      if (hard) rt.tasks = [];
      rt.releaseWhenIdle = false;
      rt.releasedGen = rt.generation;
      rt.closing = e.done;
      return { end: { session: s, hard, stopped } };
    }
    case 'closed':
      rt.closing = undefined;
      if (rt.session === e.session) rt.session = undefined;
      return {};
    case 'drop': {
      rt.generation++;
      if (!e.forget) return {};
      const s = rt.session;
      rt.session = undefined;
      return s ? { forgot: s } : {};
    }
    case 'stopTasks':
      // shutdown's (only with work) and onExited's (always: the same).
      rt.tasks = [];
      return {};
  }
}

function viaModule(rt: F, e: CliEvent): Outcome {
  const res = cliRuntime(rt, e);
  if (!res.ok) {
    assert.equal(res.reason, STALE);
    return { stale: true };
  }
  return outcome(e, res.out);
}

// The module's out, in the reference's terms.
function outcome(e: CliEvent, out: CliOut): Outcome {
  const o: Outcome = {};
  if (out.end) o.end = { session: out.end.session, hard: out.end.hard, stopped: out.end.stopped.map((t) => t.id) };
  if (out.forgot) o.forgot = out.forgot;
  if (out.spare) o.spare = out.spare;
  if (e.kind === 'exited') o.released = out.released;
  if (out.reportStart !== undefined) o.reportStart = out.reportStart;
  return o;
}

// The fields as their readers see them: by truth for the flags, and
// releasedGen only when it's this generation's (every reader checks the
// generation first: onExited returns on an older one).
function norm(rt: F): Record<string, unknown> {
  return {
    session: rt.session,
    spare: rt.spare,
    generation: rt.generation,
    closing: rt.closing,
    released: rt.releasedGen !== undefined && rt.releasedGen === rt.generation,
    resumed: rt.resumed,
    retriedFresh: rt.retriedFresh,
    started: Boolean(rt.started),
    releaseWhenIdle: Boolean(rt.releaseWhenIdle),
    versionMove: Boolean(rt.versionMove),
    tasks: rt.tasks.map((t) => t.id),
  };
}

const fresh = (): F => ({ generation: 0, resumed: false, retriedFresh: false, tasks: [], releaseWhenIdle: false });

// Every event, against a state's fields (for its generation).
function events(rt: F): Record<string, CliEvent> {
  const g = rt.generation;
  return {
    claim: { kind: 'claim', spare: S1 },
    claimOther: { kind: 'claim', spare: S2 },
    spareGone: { kind: 'spareGone', spare: S1 },
    spareGoneOther: { kind: 'spareGone', spare: S2 },
    beginFresh: { kind: 'begin', resume: false },
    beginResume: { kind: 'begin', resume: true },
    takeSpare: { kind: 'takeSpare' },
    spawnedA: { kind: 'spawned', session: A },
    spawnedB: { kind: 'spawned', session: B },
    init: { kind: 'init', gen: g },
    initStale: { kind: 'init', gen: g - 1 },
    version: { kind: 'version', gen: g, atWanted: false },
    versionWanted: { kind: 'version', gen: g, atWanted: true },
    versionStale: { kind: 'version', gen: g - 1, atWanted: true },
    tasks: { kind: 'tasks', gen: g, tasks: [task('t1')] },
    tasksNone: { kind: 'tasks', gen: g, tasks: [] },
    tasksStale: { kind: 'tasks', gen: g - 1, tasks: [task('t9')] },
    exited: { kind: 'exited', gen: g },
    exitedFailed: { kind: 'exited', gen: g, failed: true },
    exitedStale: { kind: 'exited', gen: g - 1 },
    exitedFailedStale: { kind: 'exited', gen: g - 1, failed: true },
    retryFresh: { kind: 'retryFresh' },
    leave: { kind: 'leave' },
    stay: { kind: 'stay' },
    versionMove: { kind: 'versionMove', move: true },
    versionStays: { kind: 'versionMove', move: false },
    release: { kind: 'release', done: done(`d${g}`) },
    closedA: { kind: 'closed', session: A },
    closedB: { kind: 'closed', session: B },
    drop: { kind: 'drop', forget: false },
    dropForget: { kind: 'drop', forget: true },
    stopTasks: { kind: 'stopTasks' },
  };
}

// Walks of the old writes from a fresh Runtime: each state the code
// reaches, by the events that reach it.
function walk(...names: string[]): F {
  const rt = fresh();
  for (const n of names) byHand(rt, events(rt)[n]);
  return rt;
}

const STATES: Record<string, () => F> = {
  fresh: () => fresh(),
  spare: () => walk('claim'),
  afterBegin: () => walk('beginFresh'),
  starting: () => walk('beginFresh', 'spawnedA'),
  startingResumed: () => walk('beginResume', 'spawnedA'),
  startingFromSpare: () => walk('claim', 'beginFresh', 'takeSpare', 'spawnedA'),
  live: () => walk('beginFresh', 'spawnedA', 'init', 'version'),
  liveLeave: () => walk('beginFresh', 'spawnedA', 'init', 'version', 'leave'),
  liveVersionMove: () => walk('beginFresh', 'spawnedA', 'version', 'versionMove'),
  liveTasks: () => walk('beginFresh', 'spawnedA', 'version', 'tasks'),
  liveRetried: () => walk('beginResume', 'spawnedA', 'exited', 'retryFresh', 'beginFresh', 'spawnedB'),
  closing: () => walk('beginFresh', 'spawnedA', 'version', 'release'),
  closingUnstarted: () => walk('beginFresh', 'spawnedA', 'release'),
  closingHard: () => walk('beginFresh', 'spawnedA', 'version', 'tasks', 'release'),
  closingExited: () => walk('beginFresh', 'spawnedA', 'version', 'release', 'exited'),
  closingTasksAfter: () => walk('beginFresh', 'spawnedA', 'version', 'release', 'tasks'),
  closingLeave: () => walk('beginFresh', 'spawnedA', 'version', 'release', 'exited', 'leave'),
  released: () => walk('beginFresh', 'spawnedA', 'version', 'release', 'exited', 'closedA'),
  // The release settled before the exit was heard: the exit is still owed.
  closedFirst: () => walk('beginFresh', 'spawnedA', 'version', 'release', 'closedA'),
  closedFirstTasks: () => walk('beginFresh', 'spawnedA', 'version', 'release', 'tasks', 'closedA'),
  crashed: () => walk('beginFresh', 'spawnedA', 'version', 'tasks', 'exited'),
  crashedLeave: () => walk('beginFresh', 'spawnedA', 'version', 'leave', 'exited'),
  noneLeave: () => walk('leave'),
  dropped: () => walk('beginFresh', 'spawnedA', 'version', 'dropForget'),
  droppedClosing: () => walk('beginFresh', 'spawnedA', 'version', 'release', 'dropForget'),
  // Shapes no event sequence the runner sends makes, kept as found.
  spareBesideLive: () => walk('beginFresh', 'spawnedA', 'version', 'claim'),
  spareBesideClosing: () => walk('beginFresh', 'spawnedA', 'release', 'claim'),
  twoStarts: () => walk('beginFresh', 'spawnedA', 'beginFresh', 'spawnedB'),
};

const KINDS: Record<string, string> = {
  fresh: 'none', spare: 'spare', afterBegin: 'none', starting: 'starting', startingResumed: 'starting', startingFromSpare: 'starting',
  live: 'live', liveLeave: 'live', liveVersionMove: 'live', liveTasks: 'live', liveRetried: 'starting',
  closing: 'closing', closingUnstarted: 'closing', closingHard: 'closing', closingExited: 'closing', closingTasksAfter: 'closing', closingLeave: 'closing',
  released: 'none', closedFirst: 'none', closedFirstTasks: 'none', crashed: 'none', crashedLeave: 'none', noneLeave: 'none',
  dropped: 'none', droppedClosing: 'closing', spareBesideLive: 'live', spareBesideClosing: 'closing', twoStarts: 'starting',
};

// ---- The readers' reference: the checks by hand the machine answers now ----
// runningSession was `rt.session && !rt.closing` (makeRoomForCli, canSteer,
// needsPreLook, deliver, interrupt, update's setters, letGo, moves, the idle
// timer, releaseIdle, quietTurns, the wake grace); cliHears was the sink's
// `rt.generation !== gen` (stale), turnForRequest's and reviewThenCard's
// `rt.generation !== gen || rt.closing` (not current), and the compaction's
// `turn.precompact.gen === rt.generation` (not stale).
function readersByHand(rt: F): Record<string, unknown> {
  const g = rt.generation;
  return {
    running: rt.session && !rt.closing ? rt.session : undefined,
    kind: rt.closing ? 'closing' : rt.session ? (rt.started ? 'live' : 'starting') : rt.spare ? 'spare' : 'none',
    ...Object.fromEntries([g, g - 1, g + 1].map((gen, i) => [`gen${i}`, { sinkDrops: rt.generation !== gen, cardExpires: rt.generation !== gen || Boolean(rt.closing), compactionIsIt: gen === rt.generation }])),
  };
}

function readers(rt: F): Record<string, unknown> {
  const g = rt.generation;
  return {
    running: runningSession(rt),
    kind: cliKind(rt),
    ...Object.fromEntries([g, g - 1, g + 1].map((gen, i) => [`gen${i}`, { sinkDrops: cliHears(rt, gen) === 'stale', cardExpires: cliHears(rt, gen) !== 'current', compactionIsIt: cliHears(rt, gen) !== 'stale' }])),
  };
}

test('the readers see what the checks by hand saw, in every state', () => {
  for (const [name, make] of Object.entries(STATES)) {
    const rt = make();
    assert.deepEqual(readers(rt), readersByHand(rt), name);
    assert.equal(cliKind(rt), cliOf(rt).kind, name);
  }
});

// deliver's first release check read rt.session alone, so it also asked a
// closing CLI to go; it reads runningSession now. That only holds while a
// release of a closing CLI that still has its session does nothing.
test('a release asked of a CLI already closing with its session does nothing', () => {
  for (const [name, make] of Object.entries(STATES)) {
    const rt = make();
    if (!(rt.session && rt.closing)) continue;
    const before = norm(rt);
    const res = cliRuntime(rt, { kind: 'release', done: done('again') });
    assert.ok(res.ok && !res.out.end, name);
    assert.deepEqual(norm(rt), before, name);
  }
});

test('each state reads as its kind', () => {
  const kinds = Object.fromEntries(Object.entries(STATES).map(([n, f]) => [n, cliOf(f()).kind]));
  assert.deepEqual(kinds, KINDS);
});

test('every state, on every event, moves as the writes by hand did', () => {
  for (const [stateName, make] of Object.entries(STATES)) {
    for (const [eventName, e] of Object.entries(events(make()))) {
      const want = make();
      const got = make();
      const wantOut = byHand(want, e);
      const gotOut = viaModule(got, e);
      assert.deepEqual(norm(got), norm(want), `${stateName} + ${eventName}: the fields`);
      assert.deepEqual(gotOut, wantOut, `${stateName} + ${eventName}: what it hands on`);
    }
  }
});

// What the runner really sends in each state (its guards: deliver starts a
// CLI only with none, waits out closing; releaseIdle and the catch handlers
// only reach a CLI it has; threads.create claims only for a new thread),
// and anything a CLI may say whenever. Walks of these never meet a move
// the table marks unexpected but the closed-before-exit order, which the
// adapters don't make (their end() waits for the exit they report first).
function sendable(rt: F): string[] {
  const s = cliOf(rt);
  const said = ['init', 'initStale', 'version', 'versionWanted', 'versionStale', 'tasks', 'tasksNone', 'tasksStale', 'exitedStale', 'leave', 'stay', 'release', 'retryFresh'];
  const live = s.kind === 'starting' || s.kind === 'live';
  const out = [...said];
  if (s.kind === 'none' || s.kind === 'spare') out.push('beginFresh', 'beginResume');
  if (s.kind === 'none' && rt.generation === 0) out.push('claim');
  if (s.kind === 'spare') out.push('spareGone');
  if (live || s.kind === 'closing') out.push('exited', 'exitedFailed', 'stopTasks');
  if (live) out.push('versionMove', 'versionStays');
  if (s.kind === 'closing' && rt.closing) out.push(rt.session === B ? 'closedB' : 'closedA');
  return out;
}

test('random walks move as the writes by hand did, and the ones the runner sends are never unexpected', () => {
  let seed = 11;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let steps = 0;
  const seen = new Set<string>();
  for (let walkNo = 0; walkNo < 4000; walkNo++) {
    const real = walkNo % 2 === 0;
    const want = fresh();
    const got = fresh();
    const trail: string[] = [];
    const len = 1 + Math.floor(rand() * 16);
    let sessions = 0;
    for (let i = 0; i < len; i++) {
      const all = events(want);
      let names = real ? sendable(want) : Object.keys(all);
      // A real start is begin, takeSpare and spawned in one go.
      if (real && cliOf(want).kind !== 'none' && cliOf(want).kind !== 'spare') names = names.filter((n) => !n.startsWith('begin'));
      const name = names[Math.floor(rand() * names.length)];
      // onExited sends stopTasks after the cards close.
      const steps1 = real && name.startsWith('begin') ? [name, 'takeSpare', sessions++ % 2 ? 'spawnedB' : 'spawnedA'] : real && name.startsWith('exited') && !name.endsWith('Stale') ? [name, 'stopTasks'] : [name];
      for (const n of steps1) {
        trail.push(n);
        const e = events(want)[n];
        const genBefore = got.generation;
        const wantOut = byHand(want, e);
        const res = cliRuntime(got, e);
        const gotOut = res.ok ? outcome(e, res.out) : { stale: true as const };
        assert.deepEqual(norm(got), norm(want), trail.join(' > '));
        assert.deepEqual(gotOut, wantOut, `${trail.join(' > ')}: what it hands on`);
        assert.ok(got.generation >= genBefore, `${trail.join(' > ')}: the generation went down`);
        assert.deepEqual(readers(got), readersByHand(got), `${trail.join(' > ')}: what the readers see`);
        if (real && res.ok && res.unexpected) assert.equal(res.unexpected, 'an exit heard after its release had settled', trail.join(' > '));
        // A release leaves no work on the books.
        if (res.ok && res.out.end) assert.deepEqual(got.tasks, [], trail.join(' > '));
        seen.add(cliOf(got).kind);
        steps++;
      }
      // Real walks keep no spare beside a CLI.
      if (real) {
        assert.ok(!(got.spare && got.session), `${trail.join(' > ')}: a spare beside a CLI`);
      }
    }
  }
  assert.ok(steps > 30_000, `only ${steps} steps`);
  assert.deepEqual([...seen].sort(), ['closing', 'live', 'none', 'spare', 'starting']);
});

// Nothing older moves it: an event for an older generation is refused and
// changes nothing, whatever state it lands in.
test('an older CLI`s output, exit or refused setting changes nothing', () => {
  for (const [name, make] of Object.entries(STATES)) {
    for (const e of [
      { kind: 'init', gen: -1 }, { kind: 'version', gen: -1, atWanted: true }, { kind: 'tasks', gen: -1, tasks: [task('x')] },
      { kind: 'exited', gen: -1 }, { kind: 'exited', gen: -1, failed: true }, { kind: 'leave', gen: -1 },
    ] satisfies CliEvent[]) {
      const rt = make();
      const before = { ...rt };
      const res = cliRuntime(rt, e);
      assert.deepEqual(res, { ok: false, reason: STALE }, `${name} + ${e.kind}`);
      assert.deepEqual(rt, before, `${name} + ${e.kind}: a refused move leaves the fields`);
    }
  }
});

// A refused setting for this CLI still asks it to go once idle.
test('a setting this CLI refuses asks it to leave', () => {
  const rt = STATES.live();
  assert.ok(cliRuntime(rt, { kind: 'leave', gen: rt.generation }).ok);
  assert.equal(rt.releaseWhenIdle, true);
});

test('every state reads and writes back as it was', () => {
  for (const [name, make] of Object.entries(STATES)) {
    const rt = make();
    const back = cliFields(cliOf(rt));
    for (const k of CLI_FIELDS) {
      if (k === 'releasedGen') assert.equal(back[k] === rt.generation, rt.releasedGen === rt.generation, `${name}: ${k}`);
      else if (k === 'started' || k === 'versionMove' || k === 'releaseWhenIdle') assert.equal(Boolean(back[k]), Boolean(rt[k]), `${name}: ${k}`);
      else assert.equal(back[k], rt[k], `${name}: ${k}`);
    }
  }
});

test('an unchanged field keeps its object', () => {
  const rt = STATES.liveTasks();
  const tasks = rt.tasks;
  cliRuntime(rt, { kind: 'leave' });
  cliRuntime(rt, { kind: 'init', gen: rt.generation });
  assert.equal(rt.tasks, tasks);
});

test('a release hands on the work it stops, and a second one while it goes does nothing', () => {
  const rt = STATES.liveTasks();
  const first = cliRuntime(rt, { kind: 'release', done: done('d1') });
  assert.ok(first.ok);
  assert.deepEqual(first.out.end?.stopped.map((t) => t.id), ['t1']);
  assert.equal(first.out.end?.hard, true);
  assert.deepEqual(rt.tasks, []);
  const closing = rt.closing;
  const second = cliRuntime(rt, { kind: 'release', done: done('d2') });
  assert.ok(second.ok);
  assert.equal(second.out.end, undefined);
  assert.equal(rt.closing, closing);
});

// Both orders of a released CLI's exit and its release settling end with
// no CLI, nothing owed, and the next start free to go.
test('exit then settle, and settle then exit, both end with no CLI', () => {
  for (const order of [['exited', 'closedA'], ['closedA', 'exited']]) {
    const rt = STATES.closing();
    for (const n of order) cliRuntime(rt, events(rt)[n]);
    assert.equal(cliOf(rt).kind, 'none', order.join(' then '));
    assert.equal(rt.session, undefined);
    assert.equal(rt.closing, undefined);
    assert.notEqual(rt.releasedGen, rt.generation);
  }
});

// A start while the last CLI's exit is still owed: its exit then comes
// for an older generation and is refused, so the new CLI stays.
test('an exit owed by a released CLI never takes the next one', () => {
  const rt = STATES.closedFirst();
  const old = rt.generation;
  cliRuntime(rt, { kind: 'begin', resume: true });
  cliRuntime(rt, { kind: 'spawned', session: B });
  assert.equal(cliRuntime(rt, { kind: 'exited', gen: old }).ok, false);
  assert.equal(rt.session, B);
});

test('the moves the table says never happen are marked', () => {
  const marked = (make: () => F, e: CliEvent) => {
    const res = moveCli(cliOf(make()), e);
    return res.ok ? res.unexpected : res.reason;
  };
  assert.match(marked(STATES.live, { kind: 'spawned', session: B }) ?? '', /second CLI/);
  assert.match(marked(STATES.live, { kind: 'begin', resume: false }) ?? '', /while one was live/);
  assert.match(marked(STATES.live, { kind: 'claim', spare: S2 }) ?? '', /spare claimed/);
  assert.match(marked(STATES.fresh, { kind: 'closed', session: A }) ?? '', /settled/);
  assert.match(marked(STATES.fresh, { kind: 'versionMove', move: true }) ?? '', /version move/);
  assert.equal(marked(STATES.live, { kind: 'release', done: done('d') }), undefined);
  assert.equal(marked(STATES.fresh, { kind: 'begin', resume: false }), undefined);
});

test('moveCli is pure', () => {
  for (const make of Object.values(STATES)) {
    const s = cliOf(make());
    const before = { ...s, marks: { ...s.marks }, tasks: [...s.tasks] };
    for (const e of Object.values(events(make()))) moveCli(s, e);
    assert.deepEqual(s, before);
  }
});

// The guard: nothing outside cli-session.ts writes these fields on a
// Runtime. `this.spare` in warm-start.ts is the runner's own spare, which
// no thread has until threads.create claims it.
test('only cli-session.ts writes a thread`s CLI', () => {
  const src = path.resolve(import.meta.dirname, '../../src');
  const fieldRe = CLI_FIELDS.join('|');
  const write = new RegExp(
    `(?:delete\\s+([\\w.!?\\[\\]]+?)\\.(${fieldRe})\\b)|(?:([\\w.!?\\[\\]]+?)\\.(${fieldRe})\\s*(?:=(?!=)|[-+*/%|&^]=|\\?\\?=|\\|\\|=|&&=|<<=|>>=|\\+\\+|--))|(?:(?:\\+\\+|--)\\s*([\\w.!?\\[\\]]+?)\\.(${fieldRe})\\b)`,
    'g',
  );
  // file: the receivers in it that aren't a Runtime.
  const notRuntimes: Record<string, string[]> = {
    'runner/warm-start.ts': ['this'], // Runner.spare, nobody's yet
    'slot.ts': ['out'], // a worktree slot's spare, as the record's fields
    'folder-cache.ts': ['this'],
    'projects.ts': ['out'],
    'coordinators.ts': ['row'], // a coordinator's project task records
    'handover.ts': ['this'],
    'adapters/codex/appserver.ts': ['this'],
    'adapters/acp/connection.ts': ['this'],
    'runner-stats.ts': ['this'],
    'adapters/codex/adapter.ts': ['this'],
    'adapters/acp/adapter.ts': ['this'],
    'adapters/claude/adapter.ts': ['this'],
  };
  // rt['session'] = …, delete rt['closing'].
  const ops = `(?:=(?!=)|[-+*/%|&^]=|\\?\\?=|\\|\\|=|&&=|<<=|>>=|\\+\\+|--)`;
  const bracket = new RegExp(`(?:delete\\s+[\\w.!?]+\\[['"\`](?:${fieldRe})['"\`]\\])|(?:\\[['"\`](?:${fieldRe})['"\`]\\]\\s*${ops})|(?:(?:\\+\\+|--)\\s*[\\w.!?]+\\[['"\`](?:${fieldRe})['"\`]\\])`, 'g');
  // (rt as Runtime).session = …, and Reflect.set(rt, 'session', …).
  const wrapped = new RegExp(`\\)\\s*\\.(?:${fieldRe})\\s*${ops}|Reflect\\.(?:set|deleteProperty|defineProperty)\\([^,]+,\\s*['"\`](?:${fieldRe})['"\`]`, 'g');
  // Object.assign(rt, …) or Object.assign(st.rt, …): a write of any field.
  const assign = /Object\.assign\(\s*(?:[\w.!?]+\.)?rt\b/g;
  // rt.tasks.push(…) and the like: the list changed in place.
  const mutate = /\brt\??\.tasks\??\.(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)\(|\brt\??\.tasks\.length\s*=(?!=)/g;
  const found: string[] = [];
  const walkDir = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walkDir(p);
      else if (e.name.endsWith('.ts') && e.name !== 'cli-session.ts') {
        const rel = path.relative(src, p).split(path.sep).join('/');
        // Comments out, so a line quoting the old code isn't a write.
        const text = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
        for (const m of text.matchAll(bracket)) found.push(`${rel}: ${m[0]}`);
        for (const m of text.matchAll(assign)) found.push(`${rel}: ${m[0]}`);
        for (const m of text.matchAll(mutate)) found.push(`${rel}: ${m[0]}`);
        for (const m of text.matchAll(wrapped)) found.push(`${rel}: ${m[0]}`);
        for (const m of text.matchAll(write)) {
          const receiver = (m[1] ?? m[3] ?? m[5]).split('.').at(-1)!;
          if (!(notRuntimes[rel] ?? []).includes(receiver)) found.push(`${rel}: ${m[0]}`);
        }
      }
    }
  };
  walkDir(src);
  assert.deepEqual(found, [], `A thread's CLI (${CLI_FIELDS.join(', ')}) is written only by cliRuntime in src/cli-session.ts (Runner.cli). ` +
    'Send it an event (add one to CliEvent and moveCli if none fits) rather than setting or deleting the field. ' +
    'If the object written isn\'t a Runtime, add its name to notRuntimes in this test.');
});
