// Which Claude logins are signed out and when each sign-in ends, from the
// CLI's own `claude auth status --json` (sign-in-state.ts), and what
// list_accounts says of them. Claude Code 2.1.325 ends a sign-in 28 days
// after it was made; claude-1 hit it on 14 Nov while list_accounts still
// showed it with room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../../src/clock.ts';
import { nullLogger } from '../../src/log.ts';
import { ENDING_SOON_MS, REFUSAL_HOLD_MS, SignInState, parseAuthStatus, signInWords, viewOf } from '../../src/sign-in-state.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backAt, loginOk, pickInPool, roomWord, standInFor } from '../../src/pools.ts';
import { readLoginProfile } from '../../src/accounts.ts';
import { pickAccount } from '../../src/usage.ts';
import type { Account } from '../../src/protocol.ts';

const NOW = Date.parse('2026-11-16T00:00:00.000Z');
const DAY = 24 * 3600_000;
const iso = (t: number) => new Date(t).toISOString();

const account = (id: string, extra: Partial<Account> = {}): Account => ({ id, provider: 'claude', title: `${id}@example.com`, configDir: `/tmp/${id}`, ...extra });

test('parses auth status: signed in with its end, signed out, and anything else', () => {
  assert.deepEqual(parseAuthStatus(JSON.stringify({ loggedIn: true, loginExpiresAt: '2026-12-10T08:22:36.854Z', email: 'x' })), { loggedIn: true, endsAt: Date.parse('2026-12-10T08:22:36.854Z') });
  assert.deepEqual(parseAuthStatus(JSON.stringify({ loggedIn: false, loginExpiresAt: null })), { loggedIn: false });
  // An older CLI with no end date.
  assert.deepEqual(parseAuthStatus(JSON.stringify({ loggedIn: true })), { loggedIn: true });
  assert.equal(parseAuthStatus('Not JSON'), undefined);
  assert.equal(parseAuthStatus(JSON.stringify({ email: 'x' })), undefined);
});

test('signed out when the CLI says so, once the end has passed (it still says loggedIn for hours), or after a refusal', () => {
  const r = (loggedIn: boolean, endsAt?: number) => ({ loggedIn, ...(endsAt !== undefined ? { endsAt } : {}), checkedAt: NOW });
  assert.deepEqual(viewOf(r(true, NOW + 9 * DAY), false, NOW), { loginEndsAt: iso(NOW + 9 * DAY) });
  assert.deepEqual(viewOf(r(false), false, NOW), { signedOut: true });
  // claude-2 on 16 Nov: loggedIn, its end 7 hours gone.
  assert.deepEqual(viewOf(r(true, NOW - 7 * 3600_000), false, NOW), { signedOut: true, loginEndsAt: iso(NOW - 7 * 3600_000) });
  assert.deepEqual(viewOf(r(true, NOW + DAY), true, NOW), { signedOut: true, loginEndsAt: iso(NOW + DAY) });
  assert.deepEqual(viewOf(undefined, false, NOW), {});
});

test('asks each Claude login in its own environment, tells listeners of a change, and asks again on a timer', async () => {
  const clock = new FakeClock(NOW);
  const answers: Record<string, object> = {
    'claude-main': { loggedIn: true, loginExpiresAt: iso(NOW + 2 * DAY) },
    'claude-1': { loggedIn: false, loginExpiresAt: null },
  };
  const asked: string[] = [];
  const accounts = [account('claude-main'), account('claude-1'), { ...account('codex-main'), provider: 'codex' as const }];
  const state = new SignInState({
    claudePath: '/bin/claude',
    accounts: () => accounts,
    env: (a) => ({ WHO: a.id }),
    clock,
    log: nullLogger,
    exec: async (file, args, env) => {
      assert.equal(file, '/bin/claude');
      assert.deepEqual(args, ['auth', 'status', '--json']);
      asked.push(env.WHO!);
      return JSON.stringify(answers[env.WHO!]);
    },
  });
  let changes = 0;
  state.onChange(() => changes++);
  await state.checkAll();
  assert.deepEqual(asked, ['claude-main', 'claude-1'], 'never Codex');
  assert.equal(changes, 1);
  assert.deepEqual(state.view(accounts[0]), { loginEndsAt: iso(NOW + 2 * DAY) });
  assert.deepEqual(state.view(accounts[1]), { signedOut: true });
  assert.deepEqual(state.view(accounts[2]), {});
  // Mike signs claude-1 back in; the next sweep sees it.
  answers['claude-1'] = { loggedIn: true, loginExpiresAt: iso(NOW + 28 * DAY) };
  clock.advance(10 * 60_000);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ['claude-main', 'claude-1', 'claude-main', 'claude-1']);
  assert.deepEqual(state.view(accounts[1]), { loginEndsAt: iso(NOW + 28 * DAY) });
  assert.equal(changes, 2);
  state.stop();
});

test('a refusal holds until a new sign-in (another end date) or a turn that works', async () => {
  const clock = new FakeClock(NOW);
  let answer: object = { loggedIn: true, loginExpiresAt: iso(NOW + 5 * DAY) };
  const accounts = [account('claude-1')];
  const state = new SignInState({ claudePath: 'c', accounts: () => accounts, env: () => ({}), clock, log: nullLogger, exec: async () => JSON.stringify(answer) });
  await state.checkAll();
  state.noteRefused('claude-1');
  assert.equal(state.view(accounts[0]).signedOut, true);
  // Asked again at once: the same sign-in, so it stays signed out.
  await new Promise((r) => setImmediate(r));
  assert.equal(state.view(accounts[0]).signedOut, true);
  answer = { loggedIn: true, loginExpiresAt: iso(NOW + 28 * DAY) };
  await state.checkAll();
  assert.equal(state.view(accounts[0]).signedOut, undefined, 'a new sign-in');
  state.noteRefused('claude-1');
  state.noteWorked('claude-1');
  assert.equal(state.view(accounts[0]).signedOut, undefined);
  // A one-off refusal on a login the CLI still calls signed in, with its
  // end ahead, holds it out for an hour, not until that end.
  state.noteRefused('claude-1');
  await new Promise((r) => setImmediate(r));
  assert.equal(state.view(accounts[0]).signedOut, true);
  clock.advance(REFUSAL_HOLD_MS);
  assert.equal(state.view(accounts[0]).signedOut, undefined);
  state.stop();
});

test('a CLI that fails or prints something else changes nothing', async () => {
  const clock = new FakeClock(NOW);
  const accounts = [account('claude-1')];
  const state = new SignInState({ claudePath: 'c', accounts: () => accounts, env: () => ({}), clock, log: nullLogger, exec: async () => { throw new Error('ENOENT'); } });
  await state.checkAll();
  assert.deepEqual(state.view(accounts[0]), {});
  state.stop();
});

test('pools and new threads skip a signed-out login, whatever its room', () => {
  const usage: Account['usage'] = { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 71 }], readAt: iso(NOW), source: 'live' };
  const out = account('claude-1', { usage, signedOut: true });
  const ok = account('claude-3', { usage: { ...usage, windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 20 }] } });
  assert.equal(loginOk(out), false);
  assert.equal(roomWord(out, NOW), 'signed out');
  const pool = { id: 'claude', title: 'Claude', accountIds: ['claude-1', 'claude-3'] };
  assert.equal(pickInPool(pool, [out, ok], { provider: 'claude', prefer: 'claude-1' }), 'claude-3');
  assert.equal(pickInPool(pool, [out, ok], { provider: 'claude', current: 'claude-1' }), 'claude-3');
  assert.equal(pickInPool({ ...pool, accountIds: ['claude-1'] }, [out], { provider: 'claude' }), undefined);
  assert.equal(pickAccount([out, ok], undefined), 'claude-3');
});

test('pools and new threads skip a login whose paid plan has ended, and nothing promises it back', () => {
  const usage: Account['usage'] = { windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 71, resetsAt: iso(NOW + DAY) }], readAt: iso(NOW), source: 'live' };
  const ended = account('claude-main', { usage, planEnded: true });
  const ok = account('claude-3', { usage: { ...usage, windows: [{ kind: 'weekly', title: 'Weekly', remainingPercent: 20 }] } });
  assert.equal(loginOk(ended), false);
  assert.equal(roomWord(ended, NOW), 'plan ended');
  assert.equal(backAt(ended, NOW), undefined);
  const pool = { id: 'claude', title: 'Claude', accountIds: ['claude-main', 'claude-3'] };
  assert.equal(pickInPool(pool, [ended, ok], { provider: 'claude', prefer: 'claude-main' }), 'claude-3');
  assert.equal(pickAccount([ended, ok], 'claude-main'), 'claude-3');
  // With no reading anywhere, the last-used login used to win by default.
  const unread = account('claude-3', {});
  assert.equal(pickAccount([account('claude-main', { planEnded: true }), unread], 'claude-main'), 'claude-3');
  // A schedule pinned to it stands in on the pool, as for a signed-out one.
  assert.deepEqual(standInFor([pool], [ended, ok], 'claude-main', '/tmp'), { poolId: 'claude', accountId: 'claude-3' });
  assert.match(signInWords({ planEnded: true, signedOut: true, loginEndsAt: iso(NOW + DAY) }, NOW, (s) => s), /^its paid plan has ended/);
});

test('a login is plan-ended when its cached profile says the free plan, or a personal plan with no billing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const file = path.join(dir, '.claude.json');
  const write = (o: object) => fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com', ...o } }));
  write({ organizationType: 'claude_free', billingType: 'none' });
  assert.deepEqual(readLoginProfile(file), { email: 'a@example.com', planEnded: true });
  write({ organizationType: 'claude_max' });
  assert.deepEqual(readLoginProfile(file), { email: 'a@example.com' });
  // claude-main on 16 Nov 2026: refetched after the lapse, still claude_max.
  write({ organizationType: 'claude_max', billingType: 'none' });
  assert.deepEqual(readLoginProfile(file), { email: 'a@example.com', planEnded: true });
  write({ organizationType: 'claude_pro', billingType: 'none' });
  assert.deepEqual(readLoginProfile(file), { email: 'a@example.com', planEnded: true });
  write({ organizationType: 'claude_max', billingType: 'stripe_subscription' });
  assert.deepEqual(readLoginProfile(file), { email: 'a@example.com' });
  write({ organizationType: 'claude_max', billingType: 'apple_subscription' });
  assert.deepEqual(readLoginProfile(file), { email: 'a@example.com' });
  write({ organizationType: 'claude_team', billingType: 'none' });
  assert.deepEqual(readLoginProfile(file), { email: 'a@example.com' });
  write({});
  assert.deepEqual(readLoginProfile(file), { email: 'a@example.com' });
  assert.equal(readLoginProfile(path.join(dir, 'none.json')), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("list_accounts' words: signed out, ending within three days, or nothing", () => {
  const when = (s: string) => s.slice(0, 10);
  assert.match(signInWords({ signedOut: true }, NOW, when), /^signed out/);
  assert.equal(signInWords({ loginEndsAt: iso(NOW + 2 * DAY) }, NOW, when), 'sign-in ends 2026-11-18, then it needs the user to sign in again');
  assert.equal(signInWords({ loginEndsAt: iso(NOW + ENDING_SOON_MS + 1) }, NOW, when), '');
  assert.equal(signInWords({}, NOW, when), '');
});

test('a refusal with no reading yet holds its hour even when the first reading says signed in', async () => {
  const clock = new FakeClock(NOW);
  const accounts = [account('claude-1')];
  const state = new SignInState({ claudePath: 'c', accounts: () => accounts, env: () => ({}), clock, log: nullLogger, exec: async () => JSON.stringify({ loggedIn: true, loginExpiresAt: iso(NOW + 5 * DAY) }) });
  state.noteRefused('claude-1');
  await new Promise((r) => setImmediate(r));
  assert.equal(state.view(accounts[0]).signedOut, true);
  state.stop();
});

test('checkNow asks about one login straight away, without waiting for the sweep, and tells listeners', async () => {
  const clock = new FakeClock(NOW);
  const answers: Record<string, object> = { 'claude-main': { loggedIn: false }, 'claude-1': { loggedIn: false } };
  const asked: string[] = [];
  const accounts = [account('claude-main'), account('claude-1')];
  const state = new SignInState({ claudePath: 'c', accounts: () => accounts, env: (a) => ({ WHO: a.id }), clock, log: nullLogger, exec: async (_f, _a, env) => (asked.push(env.WHO!), JSON.stringify(answers[env.WHO!])) });
  await state.checkAll();
  let changes = 0;
  state.onChange(() => changes++);
  // The setup card's Sign in… finished in Terminal a moment ago.
  answers['claude-main'] = { loggedIn: true, loginExpiresAt: iso(NOW + 28 * DAY) };
  asked.length = 0;
  await state.checkNow('claude-main');
  assert.deepEqual(asked, ['claude-main'], 'only that login');
  assert.equal(state.view(accounts[0]).signedOut, undefined);
  assert.equal(changes, 1);
  asked.length = 0;
  await state.checkNow();
  assert.deepEqual(asked, ['claude-main', 'claude-1'], 'every Claude login without an id');
  state.stop();
});
