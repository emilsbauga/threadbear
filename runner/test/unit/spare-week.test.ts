import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { SpareWeek, brief, burnRate, dueWindows, looksByItself, projections, samplesFrom, spareWeekBinding } from '../../src/spare-week.ts';
import type { Account, Pool, UsageWindow } from '../../src/protocol.ts';
import type { HistoryRow } from '../../src/usage-history.ts';

const H = 3_600_000;
const NOW = Date.parse('2026-11-18T04:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function login(id: string, windows: UsageWindow[], extra: Partial<Account> = {}): Account {
  return { id, provider: 'claude', title: id, configDir: `/x/${id}`, email: `${id}@example.com`, usage: { windows, readAt: iso(NOW), source: 'live' }, ...extra };
}

// A week that started (168 - hoursLeft) hours ago, with `left` % remaining.
function week(left: number, hoursLeft: number, kind: 'weekly' | 'weekly_model' = 'weekly', title = 'Weekly'): UsageWindow {
  return { kind, title, remainingPercent: left, resetsAt: iso(NOW + hoursLeft * H) };
}

test('burn rate is the larger of the last day and the whole week so far', () => {
  const start = NOW - 100 * H;
  // 50% gone over 100 h is 0.5%/h; the last day's readings say 2%/h.
  const samples: [number, number][] = [
    [NOW - 10 * H, 70],
    [NOW, 50],
  ];
  assert.equal(burnRate(samples, start, 50, NOW), 2);
  // A quiet last day doesn't make it look slower than the week's average.
  assert.equal(burnRate([[NOW - 10 * H, 50], [NOW, 50]], start, 50, NOW), 0.5);
  // Too early in the window, with no readings: nothing to go on.
  assert.equal(burnRate([], NOW - 2 * H, 99, NOW), 0);
});

test('a week due within a day with 30% or more spare is due, once per stage', () => {
  // 150 h in, 60% left, using 40/150 %/h: ~55% left at the reset in 18 h.
  const a = login('claude-1', [week(60, 18)]);
  const due = dueWindows([a], () => [], {}, NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.stage, 'early');
  assert.ok(due[0]!.leftAtReset > 50);
  const key = `claude-1|weekly|${a.usage!.windows[0]!.resetsAt}`;
  assert.equal(dueWindows([a], () => [], { [key]: ['early'] }, NOW).length, 0);
  // Further out than a day: not yet (Mike, 18 Nov).
  assert.equal(dueWindows([login('c', [week(60, 30)])], () => [], {}, NOW).length, 0);
  // Little left over: nothing.
  assert.equal(dueWindows([login('c', [week(25, 18)])], () => [], {}, NOW).length, 0);
});

test('the last call is 8 hours out, at 20%, and an early one is skipped after it', () => {
  const a = login('claude-1', [week(24, 6)]);
  const due = dueWindows([a], () => [], {}, NOW);
  assert.equal(due[0]?.stage, 'last-call');
  const key = `claude-1|weekly|${a.usage!.windows[0]!.resetsAt}`;
  assert.equal(dueWindows([a], () => [], { [key]: ['last-call'] }, NOW).length, 0);
});

test('reset readings a second apart keep the stages already said, across a minute boundary', () => {
  const reset = NOW + 18 * H;
  const w = { ...week(83, 18), resetsAt: iso(reset - 1_000) };
  const a = login('codex-1', [w]);
  const key = `codex-1|weekly|${iso(reset)}`;
  const done = { [key]: ['early'] as ('early' | 'last-call')[] };
  assert.deepEqual(dueWindows([a], () => [], done, NOW), []);
  w.resetsAt = iso(reset + 1_000);
  assert.deepEqual(dueWindows([a], () => [], done, NOW), []);
  // An early nudge still leaves one last call, even when another reading
  // of this same reset differs by a second.
  assert.equal(dueWindows([a], () => [], done, NOW + 12 * H)[0]?.stage, 'last-call');
  assert.deepEqual(dueWindows([a], () => [], {
    [key]: ['early'],
    [`codex-1|weekly|${iso(reset - 1_000)}`]: ['last-call'],
  }, NOW + 12 * H), []);
});

test('one reset history does not silence another account, model or a genuinely different reset', () => {
  const w = week(83, 18);
  const said = { [`a|weekly|${w.resetsAt}`]: ['early'] as ('early' | 'last-call')[] };
  assert.equal(dueWindows([login('b', [w])], () => [], said, NOW).length, 1);
  assert.equal(dueWindows([login('a', [{ ...w, kind: 'weekly_model', title: 'Weekly Fable' }])], () => [], said, NOW).length, 1);
  const models = { [`a|weekly_model:Weekly Fable|${w.resetsAt}`]: ['early'] as ('early' | 'last-call')[] };
  assert.equal(dueWindows([login('a', [{ ...w, kind: 'weekly_model', title: 'Weekly Opus' }])], () => [], models, NOW).length, 1);
  const nextWeek = { ...w, resetsAt: iso(NOW + (18 + 168) * H) };
  assert.equal(dueWindows([login('a', [nextWeek])], () => [], said, NOW + 168 * H).length, 1);
  assert.equal(dueWindows([login('a', [{ ...w, resetsAt: iso(NOW + 20 * H) }])], () => [], said, NOW).length, 1);
});

test("signed out, ended, blocked or unread logins are passed over", () => {
  const w = [week(60, 18)];
  for (const extra of [{ signedOut: true }, { planEnded: true }] as Partial<Account>[]) {
    assert.equal(dueWindows([login('x', w, extra)], () => [], {}, NOW).length, 0);
  }
  const blocked = login('x', w);
  blocked.usage!.blocked = true;
  assert.equal(dueWindows([blocked], () => [], {}, NOW).length, 0);
  assert.equal(dueWindows([{ ...login('x', w), usage: undefined }], () => [], {}, NOW).length, 0);
});

test("a model's own week can't be left with more than the main week will have", () => {
  // The main week resets later and is nearly gone; Fable's resets in 10 h
  // with 80% left, but only the main week's few % can spend it.
  const a = login('claude-1', [week(5, 30), week(80, 10, 'weekly_model', 'Weekly Fable')]);
  const p = projections(a, () => [], NOW);
  const fable = p.find((x) => x.window.kind === 'weekly_model')!;
  assert.ok(fable.leftAtReset <= 5);
  assert.equal(dueWindows([a], () => [], {}, NOW).length, 0);
  // One that resets with the main week is said by the main week's line.
  const same = login('claude-1', [week(60, 18), week(80, 18, 'weekly_model', 'Weekly Fable')]);
  assert.deepEqual(projections(same, () => [], NOW).map((x) => x.window.kind), ['weekly']);
  same.usage!.windows[0]!.resetsAt = iso(NOW + 18 * H - 1_000);
  assert.deepEqual(projections(same, () => [], NOW).map((x) => x.window.kind), ['weekly']);
  same.usage!.windows[0]!.remainingPercent = 5;
  assert.deepEqual(dueWindows([same], () => [], {}, NOW), []);
});

test('history samples are matched by kind, and a model week by its title', () => {
  const rows: HistoryRow[] = [
    { accountId: 'a', kind: 'weekly', samples: [[1, 50]] },
    { accountId: 'a', kind: 'weekly_model', title: 'Weekly Fable', samples: [[2, 70]] },
  ];
  const s = samplesFrom(rows);
  assert.deepEqual(s('a', week(50, 10)), [[1, 50]]);
  assert.deepEqual(s('a', week(50, 10, 'weekly_model', 'Weekly Fable')), [[2, 70]]);
  assert.deepEqual(s('b', week(50, 10)), []);
});

test("the brief names the login and its pool, asks before starting, and has nothing of anyone's own setup", () => {
  const a = login('claude-2', [week(60, 18)], { note: 'Convex work only' });
  const pools: Pool[] = [{ id: 'convex', title: 'Convex', accountIds: ['claude-2'] }];
  const text = brief({ account: a, pools, projections: projections(a, () => [], NOW), stage: 'last-call', byHand: false, now: NOW });
  assert.match(text, /claude-2@example\.com/);
  assert.match(text, /"Convex work only"/);
  assert.match(text, /pool Convex/);
  assert.match(text, /last call/);
  assert.match(text, /Ask, don't start/);
  assert.match(text, /account "claude-2"/);
  assert.doesNotMatch(text, /Mike|dev\/me|misc/);
});

function rig(accounts: Account[], opts: { on?: boolean; looks?: boolean; home?: string; startId?: number } = {}) {
  const clock = new FakeClock(NOW);
  const started: { text: string; title: string; accountId: string; cwd?: string; why: string }[] = [];
  const sent: { threadId: string; text: string }[] = [];
  const archived = new Set<string>();
  const s = { on: opts.on ?? true, looks: opts.looks ?? true, accounts };
  const home = opts.home ?? tmpDir('tb-spare-week-');
  const sw = new SpareWeek({
    home,
    clock,
    log: nullLogger,
    on: () => s.on,
    looks: () => s.looks,
    accounts: () => s.accounts,
    pools: () => [{ id: 'misc', title: 'Misc', accountIds: accounts.map((a) => a.id), folders: ['~/dev'] }],
    history: () => [],
    start: (r) => {
      started.push(r);
      return `t${(opts.startId ?? 0) + started.length}`;
    },
    open: (id) => !archived.has(id),
    send: (threadId, text) => sent.push({ threadId, text }),
  });
  return { sw, clock, started, sent, archived, s, home };
}

test('an archived suggestion stays said after a restart and a jittered reset reading', () => {
  const reset = NOW + 20 * H;
  const first = rig([login('codex-1', [{ ...week(83, 20), resetsAt: iso(reset + 1_000) }])]);
  assert.equal(first.sw.check().length, 1);
  first.archived.add('t1');
  const next = rig([login('codex-1', [week(83, 20)])], { home: first.home, startId: 1 });
  next.archived.add('t1');
  assert.deepEqual(next.sw.check(), []);
  assert.equal(next.started.length, 0);
  next.clock.advance(14 * H);
  assert.equal(next.sw.check()[0]?.stage, 'last-call');
  assert.equal(next.started.length, 1);
  next.s.accounts[0]!.usage!.windows[0]!.resetsAt = iso(reset + 1_000);
  assert.deepEqual(next.sw.check(), []);
  assert.equal(next.started.length, 1);
  assert.equal(next.sent.length, 0);
  // A deliberate click can still open a fresh suggestion after archiving.
  next.archived.add('t2');
  assert.equal(next.sw.findWork('codex-1').started, true);
});

test('a model week sharing the main reset does not gain another nudge when only the main reading jitters', () => {
  const a = login('claude-1', [week(60, 20), week(80, 20, 'weekly_model', 'Weekly Fable')]);
  const { sw, archived, started } = rig([a]);
  assert.equal(sw.check().length, 1);
  archived.add('t1');
  a.usage!.windows[0]!.resetsAt = iso(NOW + 20 * H - 1_000);
  assert.deepEqual(sw.check(), []);
  assert.equal(started.length, 1);
});

test('the check starts one thread pinned to the login, and the last call goes to it', () => {
  const { sw, clock, started, sent, s } = rig([login('claude-1', [week(60, 20)])]);
  assert.equal(sw.check().length, 1);
  assert.equal(started.length, 1);
  assert.equal(started[0]!.accountId, 'claude-1');
  assert.equal(started[0]!.cwd, '~/dev');
  // Again straight away: already said.
  assert.equal(sw.check().length, 0);
  // 14 hours on it's the last call, still with plenty left: to the same thread.
  clock.advance(14 * H);
  s.accounts = [{ ...login('claude-1', [week(55, 6)]) }];
  s.accounts[0]!.usage!.windows[0]!.resetsAt = iso(NOW + 20 * H);
  assert.equal(sw.check()[0]?.stage, 'last-call');
  assert.equal(started.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.threadId, 't1');
});

test('off, or on a second runner, the check starts nothing', () => {
  assert.equal(rig([login('claude-1', [week(60, 20)])], { on: false }).sw.check().length, 0);
  const second = rig([login('claude-1', [week(60, 20)])], { looks: false });
  second.sw.check();
  assert.equal(second.started.length, 0);
});

test('automatic nudges are runner messages in the event log, while Find work is a user action', async () => {
  const h = makeHarness();
  const clock = new FakeClock(NOW);
  const a = login('claude-3', [week(60, 20)]);
  const archived = new Set<string>();
  const sw = new SpareWeek({
    home: h.home, clock, log: nullLogger,
    on: () => true, looks: () => true,
    accounts: () => [a], pools: () => [], history: () => [],
    open: (id) => !archived.has(id),
    ...spareWeekBinding(h.runner),
  });
  sw.check();
  const id = h.runner.list()[0]!.id;
  assert.equal(h.events(id).find((e) => e.type === 'user.message')?.origin, 'runner');
  assert.equal(h.events(id).find((e) => e.type === 'user.message')?.wakeReason, 'Its weekly allowance is about to reset');
  h.adapter.last.init();
  h.adapter.last.result();
  await tick();
  clock.advance(14 * H);
  assert.equal(sw.check()[0]?.stage, 'last-call');
  await tick();
  assert.deepEqual(h.events(id).filter((e) => e.type === 'user.message').map((e) => e.origin), ['runner', 'runner']);
  assert.deepEqual(h.events(id).filter((e) => e.type === 'user.message').map((e) => e.wakeReason), ['Its weekly allowance is about to reset', 'Its weekly allowance resets within hours']);
  archived.add(id);
  const manual = sw.findWork('claude-3');
  assert.equal(manual.started, true);
  assert.equal(h.events(manual.threadId).find((e) => e.type === 'user.message')?.origin, undefined);
  assert.equal(h.events(manual.threadId).find((e) => e.type === 'user.message')?.wakeReason, undefined);
});

// THREADBEAR-2H: a runner handing over to a new release kept its half-hourly
// check going, and as a draining runner can't start threads, each check that
// found a week due failed. Wired as main.ts does: looks while not draining,
// and the handover stops the timer.
test('a runner handing over neither checks nor tries to start a thread', () => {
  const clock = new FakeClock(NOW);
  const r = { draining: false, tries: 0, accounts: [] as Account[] };
  const sw = new SpareWeek({
    home: tmpDir('tb-spare-week-'),
    clock,
    log: nullLogger,
    on: () => true,
    looks: () => looksByItself({ draining: r.draining, secondRunner: false }),
    accounts: () => r.accounts,
    pools: () => [],
    history: () => [],
    start: () => {
      r.tries++;
      // runner.create on a draining runner (new-threads.ts).
      if (r.draining) throw new Error('This runner is handing over to a new one; start the thread there.');
      return `t${r.tries}`;
    },
    open: () => false,
    send: () => {},
  });
  sw.start();
  // The timer is recurring by now: its first tick has run, with nothing due.
  clock.advance(6 * 60_000);
  // The handover: draining, and the timer stopped. Then a week comes due.
  r.draining = true;
  sw.stop();
  assert.equal(clock.pending(), 0);
  r.accounts = [login('claude-1', [week(60, 20)])];
  clock.advance(3 * H);
  assert.equal(r.tries, 0);
  // Called anyway, the check doesn't reach the refusal either.
  assert.deepEqual(sw.check(), []);
  assert.equal(r.tries, 0);
  assert.equal(looksByItself({ draining: false, secondRunner: true }), false);
  assert.equal(looksByItself({ draining: false, secondRunner: false }), true);
});

test('Find work for it starts a thread whatever the thresholds, and a second press opens the same one', () => {
  // Five days out: too early for the check, but it's a click.
  const { sw, started, archived } = rig([login('claude-1', [week(70, 120)])], { on: false });
  assert.deepEqual(sw.findWork('claude-1'), { threadId: 't1', started: true });
  assert.match(started[0]!.text, /Find work for it/);
  assert.deepEqual(sw.findWork('claude-1'), { threadId: 't1', started: false });
  archived.add('t1');
  assert.deepEqual(sw.findWork('claude-1'), { threadId: 't2', started: true });
  assert.throws(() => sw.findWork('nobody'));
});
