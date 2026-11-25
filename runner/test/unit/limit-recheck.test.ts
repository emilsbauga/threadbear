// A login whose last reading says it's out of room is read again now and
// then (src/limit-recheck.ts). On 17 Nov 2026 Mike's codex-main still read
// "0% left, back tomorrow" a day after he used a reset in Codex: readings
// only came from Threadbear's own Codex turns, and pools skip a login at
// 0%, so nothing ever read it again until the old reset time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AFTER_TURN_DELAY_MS, AFTER_TURN_GAP_MS, dueForRecheck, FIRST_RECHECK_MS, LimitRecheck, READ_DEADLINE_MS, RECHECK_MS } from '../../src/limit-recheck.ts';
import { parseAgyUsage } from '../../src/adapters/acp/agy-usage.ts';
import { limitsFromRateLimits } from '../../src/adapters/codex/normalize.ts';
import { accountRoom, UsageStore } from '../../src/usage.ts';
import type { Account, UsageWindow } from '../../src/protocol.ts';
import type { AgentAdapter } from '../../src/adapters/types.ts';
import type { UsageReading } from '../../src/usage.ts';

const T0 = Date.parse('2026-11-17T00:00:00.000Z');

function codex(id: string, o: { week?: number; blocked?: boolean; readAt?: number; signedOut?: boolean; provider?: 'claude' | 'codex' } = {}): Account {
  const windows: UsageWindow[] = o.week === undefined ? [] : [{ kind: 'weekly', title: 'Weekly', remainingPercent: o.week, resetsAt: '2026-11-18T07:36:48.000Z' }];
  return {
    id,
    provider: o.provider ?? 'codex',
    title: id,
    configDir: `/tmp/${id}`,
    ...(o.signedOut ? { signedOut: true } : {}),
    usage: { windows, readAt: new Date(o.readAt ?? T0 - 2 * 86_400_000).toISOString(), source: 'live', ...(o.blocked ? { blocked: true } : {}) },
  } as Account;
}

test("a login that read 0% two days ago is due; one with room, or read just now, or signed out isn't", () => {
  assert.equal(dueForRecheck(codex('codex-main', { week: 0 }), true, T0, undefined), true);
  assert.equal(dueForRecheck(codex('codex-main', { week: 40, blocked: true }), true, T0, undefined), true, 'blocked whatever its percent');
  assert.equal(dueForRecheck(codex('codex-main', { week: 40 }), true, T0, undefined), false);
  assert.equal(dueForRecheck(codex('codex-main', { week: 0, readAt: T0 - 60_000 }), true, T0, undefined), false);
  assert.equal(dueForRecheck(codex('codex-main', { week: 0, signedOut: true }), true, T0, undefined), false);
  assert.equal(dueForRecheck(codex('codex-main', { week: 0 }), false, T0, undefined), false, 'a provider that can only read in a turn');
  assert.equal(dueForRecheck(codex('codex-main', { week: 0 }), true, T0, T0 - 60_000), false, 'tried a minute ago');
  assert.equal(dueForRecheck(codex('codex-main', { week: 0 }), true, T0, T0 - RECHECK_MS), true);
});

function setup(accounts: Account[], answer: () => Promise<unknown>) {
  const clock = new FakeClock(T0);
  const reads: string[] = [];
  const recorded: { id: string; reading: UsageReading }[] = [];
  const adapter = { provider: 'codex', readLimits: async (a: Account) => (reads.push(a.id), answer()) } as unknown as AgentAdapter;
  const r = new LimitRecheck({ clock, log: nullLogger, accounts: () => accounts, adapters: { codex: adapter }, record: (id, reading) => recorded.push({ id, reading }) });
  return { clock, reads, recorded, r };
}

const settle = () => new Promise((res) => setImmediate(res));

test('a reset made outside Threadbear lifts the login on the next look', async () => {
  const accounts = [codex('codex-main', { week: 0 }), codex('codex-1', { week: 60 }), codex('claude-1', { week: 0, provider: 'claude' })];
  const fresh = { kind: 'limits', windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 100 }], blocked: false, resets: { available: 1 } };
  const { clock, reads, recorded, r } = setup(accounts, async () => fresh);
  r.start();
  clock.advance(FIRST_RECHECK_MS);
  await settle();
  assert.deepEqual(reads, ['codex-main'], 'only the Codex login that reads as out');
  assert.deepEqual(recorded, [{ id: 'codex-main', reading: { windows: fresh.windows, blocked: false, resets: { available: 1 } } }]);
  r.stop();
});

test('a login still out is asked again every ten minutes, not more', async () => {
  const accounts = [codex('codex-main', { week: 0 })];
  const { clock, reads, r } = setup(accounts, async () => null);
  r.start();
  clock.advance(FIRST_RECHECK_MS);
  await settle();
  clock.advance(RECHECK_MS - 1);
  await settle();
  assert.equal(reads.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(reads.length, 2);
  r.stop();
  clock.advance(RECHECK_MS * 3);
  await settle();
  assert.equal(reads.length, 2, 'nothing after stop');
});

test("a read that fails is logged and doesn't stop the next one", async () => {
  const accounts = [codex('codex-main', { week: 0 }), codex('codex-2', { week: 0 })];
  const { clock, reads, r } = setup(accounts, async () => {
    throw new Error('app-server went away');
  });
  r.start();
  clock.advance(FIRST_RECHECK_MS);
  await settle();
  assert.deepEqual(reads, ['codex-main', 'codex-2']);
  r.stop();
});

// From Codex's review of this fix (17 Nov 2026).

test('a read that comes back after a newer reading landed is dropped', async () => {
  const accounts = [codex('codex-main', { week: 0 })];
  let answer!: (v: unknown) => void;
  const { clock, recorded, r } = setup(accounts, () => new Promise((res) => (answer = res)));
  r.start();
  clock.advance(FIRST_RECHECK_MS);
  await settle();
  // Use a reset (or a turn) records a newer reading meanwhile.
  accounts[0] = { ...accounts[0]!, usage: { ...accounts[0]!.usage!, windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 100 }], readAt: new Date(clock.now()).toISOString() } };
  answer({ kind: 'limits', windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 0 }], blocked: true });
  await settle();
  assert.deepEqual(recorded, [], 'the older 0% would have undone the reset');
  r.stop();
});

test('stop() partway through a pass starts no more reads', async () => {
  const accounts = [codex('codex-main', { week: 0 }), codex('codex-2', { week: 0 })];
  let answer!: (v: unknown) => void;
  const { clock, reads, recorded, r } = setup(accounts, () => new Promise((res) => (answer = res)));
  r.start();
  clock.advance(FIRST_RECHECK_MS);
  await settle();
  r.stop();
  answer({ kind: 'limits', windows: [], blocked: false });
  await settle();
  assert.deepEqual(reads, ['codex-main']);
  assert.deepEqual(recorded, []);
});

test("a read that never answers doesn't hold up the others, or the next pass", async () => {
  const accounts = [codex('codex-main', { week: 0 }), codex('codex-2', { week: 0 })];
  const { clock, reads, r } = setup(accounts, () => new Promise(() => {}));
  r.start();
  clock.advance(FIRST_RECHECK_MS);
  await settle();
  assert.deepEqual(reads, ['codex-main']);
  clock.advance(READ_DEADLINE_MS);
  await settle();
  assert.deepEqual(reads, ['codex-main', 'codex-2']);
  clock.advance(READ_DEADLINE_MS);
  await settle();
  clock.advance(RECHECK_MS);
  await settle();
  assert.equal(reads.length, 3, 'the next pass came round');
  r.stop();
});

test("Codex's real answer, through the real parser and usage store, lifts a login that read 0%", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-recheck-'));
  try {
    const clock = new FakeClock(T0);
    const store = new UsageStore({ limitsFile: path.join(dir, 'limits.json'), dataDir: dir, clock, log: nullLogger });
    const known = { id: 'codex-main', provider: 'codex' as const, title: 'codex-main', configDir: path.join(dir, '.codex') };
    // What it read on 15 Nov: used up and blocked.
    clock.advance(-2 * 86_400_000);
    store.record('codex-main', limitsFromRateLimits({ ordinaryUsageAllowed: false, rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: Date.parse('2026-11-18T07:36:48Z') / 1000 }, rateLimitReachedType: 'primary' } } as never)! as never);
    clock.advance(2 * 86_400_000);
    const accounts = () => [{ ...known, usage: store.usageFor(known) } as Account];
    assert.equal(accounts()[0]!.usage!.blocked, true);
    // What Codex said on 17 Nov after the reset (its real shape).
    const now = { ordinaryUsageAllowed: true, rateLimits: { limitId: 'codex', primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: Date.parse('2026-11-23T03:07:41Z') / 1000 }, secondary: null, rateLimitReachedType: null } };
    const adapter = { provider: 'codex', readLimits: async () => limitsFromRateLimits(now as never) } as unknown as AgentAdapter;
    const r = new LimitRecheck({ clock, log: nullLogger, accounts, adapters: { codex: adapter }, record: (id, reading) => store.record(id, reading) });
    r.start();
    clock.advance(FIRST_RECHECK_MS);
    await settle();
    r.stop();
    const after = accounts()[0]!;
    assert.equal(after.usage!.blocked, undefined, 'the block lifts');
    assert.equal(accountRoom(after), 96);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Gemini: its turns carry no reading, so it's read by polling
// (23 Nov 2026: Mike's Gemini login showed in Usage with no figures).

const POLL = 10 * 60_000;

function gemini(o: { week?: number; readAt?: number; signedOut?: boolean } = {}): Account {
  return {
    id: 'antigravity-main',
    provider: 'antigravity',
    title: 'Gemini',
    configDir: '/tmp/.gemini/antigravity-acp',
    ...(o.signedOut ? { signedOut: true } : {}),
    ...(o.week === undefined ? {} : { usage: { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: o.week }], readAt: new Date(o.readAt ?? T0).toISOString(), source: 'live' } }),
  } as Account;
}

const AGY_SAMPLE = `### Quota Limits
- **Gemini Models**
  - **Weekly Limit Remaining:** 55% remaining (resets Nov 28, 2026, 08:49 UTC)
  - **Five Hour Limit Remaining:** 91% remaining (resets Nov 23, 2026, 09:35 UTC)
`;

function geminiSetup(accounts: Account[]) {
  const clock = new FakeClock(T0);
  const reads: string[] = [];
  const recorded: { id: string; reading: UsageReading }[] = [];
  const answer = { kind: 'limits', windows: parseAgyUsage(AGY_SAMPLE)!.windows, blocked: false, plan: 'Google AI Ultra' };
  const adapter = { provider: 'antigravity', limitsPollMs: POLL, readLimits: async (a: Account) => (reads.push(a.id), answer) } as unknown as AgentAdapter;
  const r = new LimitRecheck({ clock, log: nullLogger, accounts: () => accounts, adapters: { antigravity: adapter }, record: (id, reading) => recorded.push({ id, reading }) });
  return { clock, reads, recorded, r };
}

test('a polled login is due with no reading, or one a poll old, whatever its room; not signed out', () => {
  assert.equal(dueForRecheck(gemini(), true, T0, undefined, { pollMs: POLL }), true, 'never read');
  assert.equal(dueForRecheck(gemini({ week: 80, readAt: T0 - POLL }), true, T0, undefined, { pollMs: POLL }), true, 'room, but old');
  assert.equal(dueForRecheck(gemini({ week: 80, readAt: T0 - 60_000 }), true, T0, undefined, { pollMs: POLL }), false, 'read a minute ago');
  assert.equal(dueForRecheck(gemini(), true, T0, T0 - 60_000, { pollMs: POLL }), false, 'tried a minute ago');
  assert.equal(dueForRecheck(gemini({ signedOut: true }), true, T0, undefined, { pollMs: POLL }), false);
  // A reading taken a few seconds into the last pass still counts as a pass old.
  assert.equal(dueForRecheck(gemini({ week: 80, readAt: T0 - POLL + 7_000 }), true, T0, T0 - POLL, { pollMs: POLL }), true);
});

test('Gemini is read a minute after start, then every poll, with its plan', async () => {
  const accounts = [gemini()];
  const { clock, reads, recorded, r } = geminiSetup(accounts);
  r.start();
  clock.advance(FIRST_RECHECK_MS);
  await settle();
  assert.deepEqual(reads, ['antigravity-main']);
  assert.equal(recorded[0]!.reading.plan, 'Google AI Ultra');
  assert.deepEqual(recorded[0]!.reading.windows.map((w) => [w.kind, w.remainingPercent]), [['weekly', 55], ['five_hour', 91]]);
  assert.equal(recorded[0]!.reading.blocked, false);
  // What the store now says, as the accounts list would.
  accounts[0] = gemini({ week: 55, readAt: clock.now() });
  clock.advance(RECHECK_MS);
  await settle();
  assert.equal(reads.length, 2, 'read again a poll later, with room');
  r.stop();
});

test('a Gemini turn ending brings a read a few seconds later, but not more than once every two minutes', async () => {
  const accounts = [gemini({ week: 80 })];
  const { clock, reads, r } = geminiSetup(accounts);
  r.start();
  r.afterTurn('antigravity-main');
  clock.advance(AFTER_TURN_DELAY_MS - 1);
  await settle();
  assert.equal(reads.length, 0);
  clock.advance(1);
  await settle();
  assert.equal(reads.length, 1);
  accounts[0] = gemini({ week: 70, readAt: clock.now() });
  // Another turn ends 10 seconds later: its read waits for the gap.
  clock.advance(10_000);
  r.afterTurn('antigravity-main');
  r.afterTurn('antigravity-main');
  clock.advance(AFTER_TURN_GAP_MS - 10_000 - 1);
  await settle();
  assert.equal(reads.length, 1);
  clock.advance(1);
  await settle();
  assert.equal(reads.length, 2, 'one read for both turns, once the gap is up');
  clock.advance(AFTER_TURN_GAP_MS * 2);
  await settle();
  assert.equal(reads.length, 2, 'nothing more without another turn');
  r.stop();
});

test("a turn on a login that's read from its turns (Claude, Codex) brings no extra read", async () => {
  const accounts = [codex('codex-main', { week: 50 })];
  const { clock, reads, r } = setup(accounts, async () => null);
  r.afterTurn('codex-main');
  r.afterTurn('nobody');
  clock.advance(AFTER_TURN_GAP_MS);
  await settle();
  assert.deepEqual(reads, []);
  r.stop();
});

test("a signed-out Gemini login is never read, and a turn on it doesn't keep asking", async () => {
  const accounts = [gemini({ signedOut: true })];
  const { clock, reads, r } = geminiSetup(accounts);
  r.start();
  r.afterTurn('antigravity-main');
  clock.advance(FIRST_RECHECK_MS);
  await settle();
  clock.advance(RECHECK_MS);
  await settle();
  assert.deepEqual(reads, []);
  assert.equal(clock.pending(), 1, 'only the regular pass is waiting');
  r.stop();
});

test("Gemini at its limit is read again whatever its room, so the next reading after the reset lifts the block", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-recheck-'));
  try {
    const clock = new FakeClock(Date.parse('2026-11-23T05:00:00Z'));
    const store = new UsageStore({ limitsFile: path.join(dir, 'limits.json'), dataDir: dir, clock, log: nullLogger });
    const known = { id: 'antigravity-main', provider: 'antigravity' as const, title: 'Gemini', configDir: path.join(dir, 'agy') };
    // Its Claude and GPT week is at its limit too, and resets later.
    const out = AGY_SAMPLE.replace('91% remaining', '0% remaining') + `- **Claude and GPT models**
  - **Weekly Limit Remaining:** 0% remaining (resets Nov 30, 2026, 05:08 UTC)
`;
    let answer = out;
    const accounts = () => [{ ...known, usage: store.usageFor(known) } as Account];
    const adapter = { provider: 'antigravity', limitsPollMs: POLL, readLimits: async () => ({ kind: 'limits', ...parseAgyUsage(answer)! }) } as unknown as AgentAdapter;
    const r = new LimitRecheck({ clock, log: nullLogger, accounts, adapters: { antigravity: adapter }, record: (id, reading) => store.record(id, reading) });
    r.start();
    clock.advance(FIRST_RECHECK_MS);
    await settle();
    assert.equal(accounts()[0]!.usage!.blocked, true);
    // The 5-hour window resets at 9:35; the next poll after says so.
    answer = AGY_SAMPLE + `- **Claude and GPT models**
  - **Weekly Limit Remaining:** 0% remaining (resets Nov 30, 2026, 05:08 UTC)
`;
    clock.advance(Date.parse('2026-11-23T09:36:00Z') - clock.now());
    await settle();
    clock.advance(RECHECK_MS);
    await settle();
    r.stop();
    assert.equal(accounts()[0]!.usage!.blocked, undefined, 'lifted within a poll of the reset');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Gemini's block ends at its own window's reset, not at the Claude and GPT group's later one, even with no reading after", async () => {
  // Codex's merge review, 24 Nov 2026: the store took the block's end from
  // every window at its limit, so a read failing after the 5-hour reset
  // left Gemini blocked until the Claude and GPT week reset days later.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limit-recheck-'));
  try {
    const clock = new FakeClock(Date.parse('2026-11-23T05:00:00Z'));
    const store = new UsageStore({ limitsFile: path.join(dir, 'limits.json'), dataDir: dir, clock, log: nullLogger });
    const known = { id: 'antigravity-main', provider: 'antigravity' as const, title: 'Gemini', configDir: path.join(dir, 'agy') };
    const out = parseAgyUsage(AGY_SAMPLE.replace('91% remaining', '0% remaining') + `- **Claude and GPT models**
  - **Weekly Limit Remaining:** 0% remaining (resets Nov 30, 2026, 05:08 UTC)
`)!;
    assert.deepEqual(out.aside, ['Weekly Claude and GPT']);
    store.record(known.id, out);
    assert.equal(store.usageFor(known)?.blocked, true);
    clock.advance(Date.parse('2026-11-23T09:36:00Z') - clock.now());
    assert.equal(store.usageFor(known)?.blocked, undefined, 'its 5-hour window reset at 9:35');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a regular pass that comes round while an after-turn read is out runs straight after it, not a whole interval later", async () => {
  const clock = new FakeClock(T0);
  const reads: string[] = [];
  const accounts = [gemini({ week: 80 }), codex('codex-main', { week: 0 })];
  let release!: () => void;
  const slow = { kind: 'limits', windows: parseAgyUsage(AGY_SAMPLE)!.windows, blocked: false };
  const agy = { provider: 'antigravity', limitsPollMs: POLL, readLimits: (a: Account) => (reads.push(a.id), new Promise((res) => (release = () => res(slow)))) } as unknown as AgentAdapter;
  const cdx = { provider: 'codex', readLimits: async (a: Account) => (reads.push(a.id), null) } as unknown as AgentAdapter;
  const r = new LimitRecheck({ clock, log: nullLogger, accounts: () => accounts, adapters: { antigravity: agy, codex: cdx }, record: () => undefined });
  r.start();
  clock.advance(FIRST_RECHECK_MS - AFTER_TURN_DELAY_MS - 1);
  r.afterTurn('antigravity-main');
  clock.advance(AFTER_TURN_DELAY_MS);
  await settle();
  assert.deepEqual(reads, ['antigravity-main'], 'the after-turn read is out');
  clock.advance(1); // the regular pass's time
  await settle();
  release();
  await settle();
  clock.advance(0);
  await settle();
  assert.deepEqual(reads, ['antigravity-main', 'codex-main'], "Codex's recheck ran right after");
  r.stop();
});

test('a first read that lands after its login signed out is dropped', async () => {
  const accounts = [gemini()];
  let answer!: (v: unknown) => void;
  const clock = new FakeClock(T0);
  const recorded: string[] = [];
  const agy = { provider: 'antigravity', limitsPollMs: POLL, readLimits: () => new Promise((res) => (answer = res)) } as unknown as AgentAdapter;
  const r = new LimitRecheck({ clock, log: nullLogger, accounts: () => accounts, adapters: { antigravity: agy }, record: (id) => recorded.push(id) });
  r.start();
  clock.advance(FIRST_RECHECK_MS);
  await settle();
  accounts[0] = gemini({ signedOut: true });
  answer({ kind: 'limits', windows: [], blocked: false });
  await settle();
  assert.deepEqual(recorded, []);
  r.stop();
});

test("a regular pass just after a turn ended doesn't swallow that turn's own read", async () => {
  const accounts = [gemini({ week: 80, readAt: T0 - POLL })];
  const { clock, reads, r } = geminiSetup(accounts);
  r.start();
  clock.advance(FIRST_RECHECK_MS - 2_000);
  r.afterTurn('antigravity-main'); // 2 s before the regular pass
  clock.advance(2_000);
  await settle();
  assert.equal(reads.length, 1, 'the regular pass read it');
  accounts[0] = gemini({ week: 79, readAt: clock.now() });
  clock.advance(AFTER_TURN_GAP_MS);
  await settle();
  assert.equal(reads.length, 2, "and the turn's own read still came, once the gap was up");
  r.stop();
});
