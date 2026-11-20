import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir } from '../helpers/fakes.ts';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { SpareWeek, brief, burnRate, dueWindows, projections, samplesFrom } from '../../src/spare-week.ts';
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

function rig(accounts: Account[], opts: { on?: boolean; looks?: boolean } = {}) {
  const clock = new FakeClock(NOW);
  const started: { text: string; title: string; accountId: string; cwd?: string; why: string }[] = [];
  const sent: { threadId: string; text: string }[] = [];
  const archived = new Set<string>();
  const s = { on: opts.on ?? true, looks: opts.looks ?? true, accounts };
  const sw = new SpareWeek({
    home: tmpDir('tb-spare-week-'),
    clock,
    log: nullLogger,
    on: () => s.on,
    looks: () => s.looks,
    accounts: () => s.accounts,
    pools: () => [{ id: 'misc', title: 'Misc', accountIds: accounts.map((a) => a.id), folders: ['~/dev'] }],
    history: () => [],
    start: (r) => {
      started.push(r);
      return `t${started.length}`;
    },
    open: (id) => !archived.has(id),
    send: (threadId, text) => sent.push({ threadId, text }),
  });
  return { sw, clock, started, sent, archived, s };
}

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
