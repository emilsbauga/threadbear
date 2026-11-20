// Virtual runners from the Mac (virtual-runners.ts; docs/protocol.md, Virtual
// runners, "Starting from the Mac" and "Cloud tokens on the Mac"): the repo a
// box clones read from a folder here, a thread started through
// boxes:startThread, and a login's cloud token made with `claude setup-token`
// (a fake CLI through the real helper), pasted, or this Mac's year-long
// token, never logged and never in an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Account } from '../../src/protocol.ts';
import type { Logger } from '../../src/log.ts';
import { TOKEN_FILE, onYearToken } from '../../src/year-token.ts';
import { boxOrigin, repoOf, runTokenHelper, VirtualRunners, type VirtualRunnerDeps } from '../../src/virtual-runners.ts';

const TOKEN = `sk-ant-oat01-${'Ab1_-'.repeat(19)}xyz`;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}

// A repo with an origin (a bare one next to it, its address carrying a token as some do).
function repo(): { dir: string; bare: string } {
  const root = tmp('tb-vr-');
  const bare = path.join(root, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'trunk', bare]);
  const dir = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '-b', 'trunk', dir]);
  fs.mkdirSync(path.join(dir, 'runner', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runner', 'src', 'a.ts'), 'x');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'one');
  sh(dir, 'remote', 'add', 'origin', bare);
  sh(dir, 'push', '-q', '-u', 'origin', 'trunk');
  return { dir, bare };
}

type Logged = { level: string; msg: string; data?: unknown }[];
function logger(lines: Logged): Logger {
  const at = (level: string) => (msg: string, data?: unknown) => void lines.push({ level, msg, data });
  return { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') } as unknown as Logger;
}

const ACCOUNTS: Account[] = [
  { id: 'claude-main', provider: 'claude', title: 'me@example.com', configDir: '', email: 'me@example.com' },
  { id: 'claude-2', provider: 'claude', title: 'two@example.com', configDir: '', email: 'two@example.com' },
  { id: 'codex-main', provider: 'codex', title: 'Codex · me@example.com', configDir: '' },
];

function harness(extra: Partial<VirtualRunnerDeps> = {}) {
  const calls: { kind: string; fn: string; args: Record<string, unknown> }[] = [];
  const made: unknown[] = [];
  const lines: Logged = [];
  const deps: VirtualRunnerDeps = {
    on: () => true,
    call: async (kind, fn, args) => {
      calls.push({ kind, fn, args });
      if (fn === 'boxes:startThread') return { runnerId: 'abcdef012345', commandId: 'commands:1' };
      if (fn === 'boxes:cloudTokens') return [{ login: 'me@example.com', madeAt: 1, setAt: 2, state: 'dead' }];
      return null;
    },
    accounts: () => ACCOUNTS,
    claudePath: () => '/nowhere/claude',
    made: (row) => void made.push(row),
    log: logger(lines),
    now: () => Date.parse('2026-11-19T00:00:00Z'),
    // Make one's own refusal on Windows has a test of its own.
    platform: 'darwin',
    ...extra,
  };
  return { v: new VirtualRunners(deps), calls, made, lines };
}

test('a folder on this Mac is the repo its origin names, without credentials, its subfolder and its upstream branch', async () => {
  const { dir } = repo();
  sh(dir, 'remote', 'set-url', 'origin', 'https://mike:ghp_SECRETSECRETSECRET@github.com/mikecann/threadbear.git');
  assert.deepEqual(await repoOf(path.join(dir, 'runner')), { origin: 'https://github.com/mikecann/threadbear.git', subfolder: 'runner', baseBranch: 'trunk' });
  assert.deepEqual(await repoOf(dir), { origin: 'https://github.com/mikecann/threadbear.git', subfolder: '', baseBranch: 'trunk' });
  // A branch with no upstream: origin's default branch, else main.
  sh(dir, 'checkout', '-q', '-b', 'local-only');
  assert.equal((await repoOf(dir)).baseBranch, 'main');
  sh(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  assert.equal((await repoOf(dir)).baseBranch, 'trunk');
});

// Codex's review of slice 5 (6): a box clones over https with no ssh key of
// Mike's, so only what it can reach starts a thread; GitHub's ssh forms go as
// its https address; anything else is refused before the backend hears of it.
test('only an origin a box can clone over https starts one; GitHub ssh addresses go as https', async () => {
  assert.equal(boxOrigin('https://github.com/mikecann/threadbear.git'), 'https://github.com/mikecann/threadbear.git');
  assert.equal(boxOrigin('https://gitlab.com/a/b'), 'https://gitlab.com/a/b');
  assert.equal(boxOrigin('git@github.com:mikecann/threadbear.git'), 'https://github.com/mikecann/threadbear.git');
  assert.equal(boxOrigin('github.com:mikecann/threadbear'), 'https://github.com/mikecann/threadbear');
  assert.equal(boxOrigin('ssh://git@github.com/mikecann/threadbear.git'), 'https://github.com/mikecann/threadbear.git');
  for (const bad of ['/Users/me/repos/source.git', 'file:///Users/me/repos/source.git', '../source', 'git@gitlab.com:a/b.git', 'ssh://git@example.com/a/b.git', 'http://github.com/a/b', 'git://github.com/a/b', 'https://-x/a', '', 'git@github.com:a/b/c'])
    assert.equal(boxOrigin(bad), undefined, bad);
});

test("a repo whose origin a box can't reach is refused before anything is started, saying so", async () => {
  const { dir } = repo();
  await assert.rejects(repoOf(dir), /a box can't reach .*origin\.git: it clones over https/i);
  sh(dir, 'remote', 'set-url', 'origin', 'git@gitlab.com:a/b.git');
  await assert.rejects(repoOf(dir), /a box can't reach git@gitlab\.com:a\/b\.git/i);
  const { v, calls } = harness();
  await assert.rejects(v.start({ serviceId: 'runnerServices:1', cwd: dir, accountId: 'claude-2', text: 'go' }), (e: { code?: number }) => e.code === -32602);
  assert.equal(calls.length, 0, 'the backend never hears of it');
});

test("a folder that isn't a repo, or has no origin, is refused saying why", async () => {
  await assert.rejects(repoOf(tmp('tb-vr-plain-')), /isn't in a git repo/);
  const dir = tmp('tb-vr-noorigin-');
  execFileSync('git', ['init', '-q', dir]);
  await assert.rejects(repoOf(dir), /has no origin/);
});

test('starting a thread: boxes:startThread with the repo, the login by email and the first message; listed at once as starting', async () => {
  const { dir } = repo();
  sh(dir, 'remote', 'set-url', 'origin', 'git@github.com:mikecann/threadbear.git');
  const { v, calls, made } = harness();
  const res = await v.start({ serviceId: 'runnerServices:1', cwd: path.join(dir, 'runner'), accountId: 'claude-2', text: 'Fix the thing\nwith detail', model: 'claude-opus-5-5', permissionMode: 'plan' });
  assert.equal(calls.length, 1);
  const c = calls[0]!;
  assert.deepEqual({ kind: c.kind, fn: c.fn }, { kind: 'action', fn: 'boxes:startThread' });
  assert.match(String(c.args.threadId), /^[0-9a-f-]{36}$/);
  assert.deepEqual(c.args.repo, { origin: 'https://github.com/mikecann/threadbear.git', subfolder: 'runner', baseBranch: 'trunk' }, "GitHub's ssh form as the box clones it, over https");
  assert.equal(c.args.login, 'two@example.com');
  assert.equal(c.args.accountId, 'claude-2');
  assert.equal(c.args.text, 'Fix the thing\nwith detail');
  assert.equal(c.args.model, 'claude-opus-5-5');
  // Plan first goes as Ask plus a flag, as any remote create's does.
  assert.equal(c.args.permissionMode, 'ask');
  assert.equal(c.args.plan, true);
  assert.equal(res.thread.runnerId, 'abcdef012345');
  assert.equal(res.thread.id, c.args.threadId);
  assert.equal(res.thread.status, 'starting');
  assert.equal(res.thread.title, 'Fix the thing');
  assert.equal((made[0] as { runnerId: string }).runnerId, 'abcdef012345');
});

test('a start is refused for pictures, another provider, a missing login, or with virtual runners off; the backend\'s refusal comes back as said', async () => {
  const { dir } = repo();
  sh(dir, 'remote', 'set-url', 'origin', 'https://github.com/mikecann/threadbear.git');
  const { v, calls } = harness();
  const base = { serviceId: 's', cwd: dir, accountId: 'claude-main', text: 'hi' };
  await assert.rejects(v.start({ ...base, images: [{ path: '/x.png' }] }), /Pictures can't go/);
  await assert.rejects(v.start({ ...base, accountId: 'codex-main' }), /isn't a Claude login/);
  await assert.rejects(v.start({ ...base, accountId: 'claude-9' }), /no login claude-9/);
  await assert.rejects(v.start({ ...base, cwd: '' }), /cwd is required/);
  assert.equal(calls.length, 0);
  await assert.rejects(harness({ on: () => false }).v.start(base), /aren't on/);
  const limited = harness({ call: async () => { throw new Error('Cloud (Fly) has 5 boxes up or starting, its limit.'); } });
  await assert.rejects(limited.v.start(base), /5 boxes up or starting/);
  // A pool's pick when only a pool is named.
  const pooled = harness({ poolLogin: (id) => (id === 'claude' ? ACCOUNTS[1] : undefined) });
  await pooled.v.start({ serviceId: 's', cwd: dir, poolId: 'claude', text: 'hi' });
  assert.equal(pooled.calls[0]!.args.login, 'two@example.com');
});

// The helper's pseudo-terminal (Python's pty) and the fake CLI's #! script are Unix only; Make one refuses on Windows.
const unixOnly = { skip: process.platform === 'win32' && 'no pty on Windows' };

// A fake `claude` that prints what setup-token does: escapes, a box, the token wrapped over two lines, then prose.
function fakeClaude(body: string): string {
  const dir = tmp('tb-vr-cli-');
  const file = path.join(dir, 'claude');
  fs.writeFileSync(file, `#!/bin/sh\n[ "$1" = setup-token ] || exit 3\n[ -t 1 ] || exit 4\n${body}\n`, { mode: 0o755 });
  return file;
}
const wrapped = (t: string) => `printf '\\033[2J\\033[1mYour OAuth token:\\033[0m\\n\\n\\033[32m│ ${t.slice(0, 60)}\\n│ ${t.slice(60)}\\033[0m\\n\\nStore this token securely. You won'"'"'t see it again.\\n'`;

test('the helper reads the token from a pseudo-terminal, escapes and wrapping taken out, and nothing of the prose after it', unixOnly, async () => {
  const cli = fakeClaude(wrapped(TOKEN));
  assert.equal(await runTokenHelper(cli, { ...process.env }, 20_000), TOKEN);
  // One line, too.
  assert.equal(await runTokenHelper(fakeClaude(`printf 'Token: ${TOKEN}\\nDone\\n'`), { ...process.env }, 20_000), TOKEN);
  assert.equal(await runTokenHelper(fakeClaude(`printf 'no token here\\n'`), { ...process.env }, 20_000), undefined);
  // The CLI's environment: the login's own folder.
  const seen = tmp('tb-vr-env-');
  const cli2 = fakeClaude(`echo "$CLAUDE_CONFIG_DIR" > ${seen}/dir\nprintf '${TOKEN}\\n'`);
  assert.equal(await runTokenHelper(cli2, { ...process.env, CLAUDE_CONFIG_DIR: '/tmp/login-two' }, 20_000), TOKEN);
  assert.equal(fs.readFileSync(path.join(seen, 'dir'), 'utf8').trim(), '/tmp/login-two');
});

test('a helper that never finishes is stopped at its time limit', async () => {
  const at = Date.now();
  assert.equal(await runTokenHelper(fakeClaude('sleep 30'), { ...process.env }, 1000), undefined);
  assert.ok(Date.now() - at < 10_000);
});

test('Make one: the token goes to setCloudToken for that login, the scrubber knows it first, and nothing logs it', unixOnly, async () => {
  const dir = tmp('tb-vr-two-');
  const accounts: Account[] = [{ ...ACCOUNTS[1]!, configDir: dir }];
  const seenEnv: NodeJS.ProcessEnv[] = [];
  const known: string[] = [];
  const stop = onYearToken((t) => known.push(t));
  const { v, calls, lines } = harness({
    accounts: () => accounts,
    claudePath: () => fakeClaude(wrapped(TOKEN)),
    runHelper: async (cli, env, ms) => {
      seenEnv.push(env);
      return runTokenHelper(cli, env, ms);
    },
  });
  // Two clicks make one run.
  const [a, b] = await Promise.all([v.make('two@example.com'), v.make('two@example.com')]);
  stop();
  assert.deepEqual(a, {});
  assert.deepEqual(b, {});
  assert.equal(seenEnv.length, 1);
  assert.equal(seenEnv[0]!.CLAUDE_CONFIG_DIR, dir);
  assert.ok(known.includes(TOKEN));
  assert.deepEqual(calls.map((c) => [c.kind, c.fn, c.args.login, c.args.token === TOKEN]), [['action', 'boxes:setCloudToken', 'two@example.com', true]]);
  assert.ok(!JSON.stringify(lines).includes(TOKEN.slice(13, 50)), 'never logged');
  await assert.rejects(v.make('nobody@example.com'), /no Claude login/);
});

test("a failure never carries the token: the backend's refusal is said with the token taken out", async () => {
  const lines: Logged = [];
  const { v } = harness({
    log: logger(lines),
    runHelper: async () => TOKEN,
    call: async (_k, _f, args) => {
      throw new Error(`could not set ${String(args.token)} for you`);
    },
  });
  const err = await v.make('me@example.com').catch((e: Error) => e);
  assert.ok(err instanceof Error);
  assert.ok(!err.message.includes(TOKEN.slice(13)), 'not in the error');
  assert.match(err.message, /couldn't be set/);
  assert.ok(!JSON.stringify(lines).includes(TOKEN.slice(13)), 'not in the log');
  const none = await harness({ runHelper: async () => undefined }).v.make('me@example.com').catch((e: Error) => e);
  assert.match((none as Error).message, /No token came back/);
});

test("Make one on Windows says to paste a token instead, without running anything", async () => {
  let ran = false;
  const { v, calls } = harness({ platform: 'win32', runHelper: async () => ((ran = true), TOKEN) });
  await assert.rejects(v.make('me@example.com'), /can't run on Windows\. Run claude setup-token in a terminal and paste/);
  assert.equal(ran, false);
  assert.equal(calls.length, 0);
});

test("Paste a token and Use this Mac's: only a token's shape, and only a login that has one here", async () => {
  const { v, calls } = harness();
  await assert.rejects(v.set('me@example.com', 'sk-ant-api03-nope'), /doesn't look like/);
  await v.set('me@example.com', `  ${TOKEN.slice(0, 50)}\n${TOKEN.slice(50)}  `);
  assert.equal(calls[0]!.args.token, TOKEN, 'whitespace from a wrapped copy taken out');
  const dir = tmp('tb-vr-year-');
  fs.writeFileSync(path.join(dir, TOKEN_FILE), JSON.stringify({ token: TOKEN, madeAt: '2026-11-17T07:00:00.000Z' }), { mode: 0o600 });
  const withYear = harness({ accounts: () => [{ ...ACCOUNTS[0]!, configDir: dir }] });
  await withYear.v.useMac('me@example.com');
  assert.deepEqual(withYear.calls.map((c) => [c.fn, c.args.token === TOKEN, c.args.madeAt]), [['boxes:setCloudToken', true, Date.parse('2026-11-17T07:00:00.000Z')]]);
  await assert.rejects(harness({ accounts: () => [{ ...ACCOUNTS[0]!, configDir: tmp('tb-vr-none-') }] }).v.useMac('me@example.com'), /no year-long token/);
  assert.deepEqual(await v.list(), { tokens: [{ login: 'me@example.com', madeAt: 1, setAt: 2, state: 'dead' }] });
});
