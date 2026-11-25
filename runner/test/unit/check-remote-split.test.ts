// A landing's check split across a Linux check host and a Mac one
// (scripts/check-remote.sh, split_run; check.sh --part). On 24 Nov 34 of 39
// landing checks went wholly to Tinker Desk, as nearly every group had a
// desktop/ or iPhone change, while the cloud box, twice as quick at the
// runner's unit tests, sat idle. Now the steps a Linux host can run go there
// and the Mac's go to the Mac, at the same time, and tb land reads the two
// as one check: one host line naming both, every step, one line of what
// failed (worktrees.ts, parseCheckTimes, onlyFailed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { linuxDf, GiB, setup, test } from '../helpers/check-remote-harness.ts';
import { onlyFailed, onlyRan, parseCheckTimes, sameCheckHost } from '../../src/worktrees.ts';

const ENV = { THREADBEAR_CHECK_POLL_SECS: '1', THREADBEAR_CHECK_MAX_SECS: '120' };
const LANDING = { ...ENV, THREADBEAR_CHECK_FIRST: '1' };
const linux = { os: 'Linux', df: linuxDf(50 * GiB) };
const LINUX_SAYS = 'ok    runner typecheck        1s\nok    runner unit tests     200s\n';
const MAC_SAYS = 'ok    iphone kit tests        9s\n';

// A change under ios/, which needs a Mac.
function iosChange(repo: string): void {
  fs.mkdirSync(path.join(repo, 'ios'));
  fs.writeFileSync(path.join(repo, 'ios', 'x.swift'), '\n');
}
// The --part each host's check was given.
// (The fake ssh logs a command over several lines: the guard goes inline.)
const parts = (ssh: string, host: string): string[] =>
  ssh.split(/\n(?=h\d+ )/).filter((c) => c.startsWith(`${host} `) && c.includes('host-turn.sh'))
    .map((c) => /--part (linux|mac)/.exec(c)?.[1] ?? 'none');

test("a landing's check that needs a Mac runs its Linux steps on the Linux host and the rest on the Mac, at once", () => {
  const s = setup({ h1: { state: 'free', says: MAC_SAYS }, h2: { state: 'free', ...linux, says: LINUX_SAYS } });
  iosChange(s.repo);
  const r = s.run('h1,h2', 3600, '', LANDING);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([...r.copies].sort(), ['h1', 'h2']);
  assert.deepEqual(parts(r.ssh, 'h2'), ['linux']);
  assert.deepEqual(parts(r.ssh, 'h1'), ['mac']);
  // Read as one check, on both hosts, with every step of both halves.
  const times = parseCheckTimes(r.stdout);
  assert.equal(times.host, 'h2+h1');
  assert.deepEqual(times.steps.map((x) => `${x.status} ${x.name}`), ['ok runner typecheck', 'ok runner unit tests', 'ok iphone kit tests']);
  // Each half's own lines are shown as they come, marked.
  assert.match(r.stdout, /^\[no Mac\] ok {4}runner unit tests/m);
  assert.match(r.stdout, /^\[Mac\] ok {4}iphone kit tests/m);
});

test('a split check fails if either half does, and names what failed in both', () => {
  const s = setup({
    h1: { state: 'free', exits: 1, says: 'FAIL  app mock tests         70s  /tmp/x.log\n\nTo run only what failed again: ./check.sh --only "app mock tests"\n' },
    h2: { state: 'free', ...linux, says: 'ok    runner typecheck        1s\n' },
  });
  iosChange(s.repo);
  const r = s.run('h1,h2', 3600, '', LANDING);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(onlyFailed(r.stdout), 'app mock tests');

  const both = setup({
    h1: { state: 'free', exits: 1, says: 'FAIL  app mock tests         70s  /tmp/x.log\nTo run only what failed again: ./check.sh --only "app mock tests"\n--only ran: "app mock tests"\n' },
    h2: { state: 'free', ...linux, exits: 1, says: 'FAIL  runner unit tests     200s  /tmp/y.log\nTo run only what failed again: ./check.sh --only "runner unit tests=test/unit/a.test.ts"\n--only ran: "runner unit tests"\n' },
  });
  iosChange(both.repo);
  const r2 = both.run('h1,h2', 3600, '', LANDING, ['--only', 'runner unit tests=test/unit/a.test.ts;app mock tests']);
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.equal(onlyFailed(r2.stdout), 'runner unit tests=test/unit/a.test.ts;app mock tests');
  assert.deepEqual([...(onlyRan(r2.stdout) ?? [])], ['runner unit tests', 'app mock tests']);
  assert.equal(parseCheckTimes(r2.stdout).host, 'h2+h1');
});

test("a check that isn't a landing's, or needs no Mac, still runs whole on one host", () => {
  const s = setup({ h1: { state: 'free' }, h2: { state: 'free', ...linux } });
  iosChange(s.repo);
  const r = s.run('h1,h2', 3600, '', ENV);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.copies, ['h1']);
  assert.doesNotMatch(r.ssh, /--part/);

  const n = setup({ h1: { state: 'free' }, h2: { state: 'free', ...linux } });
  fs.writeFileSync(path.join(n.repo, 'change.ts'), '\n');
  const r2 = n.run('h1,h2', 3600, '', LANDING);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.equal(r2.copies.length, 1);
  assert.doesNotMatch(r2.ssh, /--part/);
});

test('with no Linux host answering it runs whole on the Mac, and with one out of room its half goes to the Mac too', () => {
  const s = setup({ h1: { state: 'free' } });
  iosChange(s.repo);
  const r = s.run('h1,gone', 3600, '', LANDING);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.copies, ['h1']);
  assert.doesNotMatch(r.ssh, /--part/);

  const low = setup({ h1: { state: 'free', says: MAC_SAYS }, h2: { state: 'free', os: 'Linux', df: linuxDf(0.5 * GiB) } });
  iosChange(low.repo);
  const r2 = low.run('h1,h2', 3600, '', LANDING);
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.deepEqual(r2.copies, ['h1', 'h1']);
  assert.deepEqual(parts(r2.ssh, 'h1').sort(), ['linux', 'mac']);
  assert.equal(parseCheckTimes(r2.stdout).host, 'h1');
});

test("a split check's host pair sends each step back to the host of its kind, and nowhere else", () => {
  // tb land runs what failed in a group's check on each landing alone, on the
  // host it failed on (findBroken): for a split check, the pair.
  const run = (only: string, hosts: Parameters<typeof setup>[0] = { h1: { state: 'free' }, h2: { state: 'free', ...linux } }) => {
    const s = setup(hosts);
    const r = s.run('h2+h1', 3600, '', ENV, ['--only', only, '--all']);
    return { ...r, host: parseCheckTimes(r.stdout).host };
  };
  const unit = run('runner unit tests=test/unit/a.test.ts');
  assert.equal(unit.status, 0, unit.stdout + unit.stderr);
  assert.deepEqual(unit.copies, ['h2']);
  assert.ok(sameCheckHost(unit.host, 'h2+h1'), unit.stdout);
  const mock = run('app mock tests');
  assert.equal(mock.status, 0, mock.stdout + mock.stderr);
  assert.deepEqual(mock.copies, ['h1']);
  assert.ok(sameCheckHost(mock.host, 'h2+h1'), mock.stdout);
  // Both kinds: split again, not a landing's check or not.
  const both = run('runner unit tests;app mock tests');
  assert.equal(both.status, 0, both.stdout + both.stderr);
  assert.deepEqual([...both.copies].sort(), ['h1', 'h2']);
  assert.equal(both.host, 'h2+h1');
  // The pair's Linux host gone: its half doesn't move to the Mac, where it
  // didn't run before, and no host could run it.
  const gone = run('runner unit tests;app mock tests', { h1: { state: 'free' } });
  assert.equal(gone.status, 1, gone.stdout + gone.stderr);
  assert.deepEqual(gone.copies, ['h1']);
  assert.match(gone.stderr, /couldn't run on any host/);
  // And with the Mac's half failing: still no host's answer, not a failure
  // of main or a landing for steps of which only some ran (Gemini's review).
  const s = setup({ h1: { state: 'free', exits: 1, says: 'FAIL  app mock tests         70s  /tmp/x.log\nTo run only what failed again: ./check.sh --only "app mock tests"\n--only ran: "app mock tests"\n' } });
  const half = s.run('h2+h1', 3600, '', { ...ENV, THREADBEAR_CHECK_BUSY_EXIT: '69' }, ['--only', 'runner unit tests;app mock tests', '--all']);
  assert.equal(half.status, 69, half.stdout + half.stderr);
});

test('a run of what failed counts only when it went where the group ran it', () => {
  assert.ok(sameCheckHost('cloud', 'cloud'));
  assert.ok(sameCheckHost(undefined, undefined));
  assert.ok(sameCheckHost('cloud+tinker-desk', 'cloud+tinker-desk'));
  assert.ok(sameCheckHost('cloud', 'cloud+tinker-desk'));
  assert.ok(sameCheckHost('tinker-desk', 'cloud+tinker-desk'));
  assert.ok(!sameCheckHost('other', 'cloud+tinker-desk'));
  assert.ok(!sameCheckHost('cloud', 'tinker-desk'));
  assert.ok(!sameCheckHost('cloud', undefined));
  assert.ok(!sameCheckHost(undefined, 'cloud+tinker-desk'));
});

// check.sh --part, in a throwaway checkout whose steps are stand-ins (as
// check-only.test.ts has it).
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('check.sh --part runs just the Linux steps or just the Mac ones, which together are the whole check', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tb-check-part-'));
  try {
    const put = (rel: string, text: string, mode?: number) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
      if (mode) fs.chmodSync(path.join(root, rel), mode);
    };
    const copy = (rel: string, mode?: number) => put(rel, fs.readFileSync(path.join(repo, rel), 'utf8'), mode);
    copy('check.sh', 0o755);
    copy('scripts/check-remote.sh', 0o755);
    copy('scripts/swift-freeze.sh', 0o755);
    copy('runner/scripts/find-node.sh');
    copy('scripts/limit-step.mjs');
    copy('runner/test/helpers/failed-files-reporter.mjs');
    put('runner/package.json', JSON.stringify({ scripts: { typecheck: 'true' } }));
    put('runner/node_modules/.keep', '');
    put('runner/test/helpers/clean-env.ts', '');
    put('runner/test/unit/ok.test.ts', "import { test } from 'node:test';\ntest('ok', () => {});\n");
    put('package.json', JSON.stringify({ scripts: { 'convex:typecheck': 'true', 'web:typecheck': 'true', 'web:test': 'true', lint: 'true', 'lint:files': 'true' } }));
    put('node_modules/.keep', '');
    put('app/Tools/ok.mjs', '');
    put('mock-runner/ok.mjs', '');
    put('mock-runner/node_modules/.keep', '');
    put('desktop/.keep', '');
    put('ios/ThreadbearKit/.keep', '');
    put('bin/swift', '#!/bin/bash\n', 0o755);
    put('bin/cargo', '#!/bin/bash\n', 0o755);
    const list = path.join(root, '.changed');
    fs.writeFileSync(list, 'runner/src/x.ts\napp/Sources/X.swift\nios/ThreadbearKit/X.swift\ndesktop/core/src/x.rs\n');
    const check = (flags: string[]) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
        THREADBEAR_CHECK_CHANGED_FILE: list, THREADBEAR_NODE: process.execPath, TMPDIR: root, HOME: root,
      };
      for (const k of Object.keys(env)) if (/^THREAD(BEAR|BARE)_(CHECK_|HOME$)/.test(k) && k !== 'THREADBEAR_CHECK_CHANGED_FILE') delete env[k];
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync('bash', [path.join(root, 'check.sh'), '--quick', '--local', ...flags], { env, encoding: 'utf8', timeout: 120_000 });
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      return { status: r.status, out, steps: parseCheckTimes(out).steps.map((x) => x.name) };
    };
    const whole = check([]);
    const lin = check(['--part', 'linux']);
    const mac = check(['--part', 'mac']);
    assert.equal(whole.status, 0, whole.out);
    assert.equal(lin.status, 0, lin.out);
    assert.equal(mac.status, 0, mac.out);
    for (const name of ['runner typecheck', 'runner unit tests', 'lint', 'desktop core tests']) {
      assert.ok(lin.steps.includes(name), `${name}: ${lin.out}`);
      assert.ok(!mac.steps.includes(name), `${name}: ${mac.out}`);
    }
    for (const name of ['app release build', 'iphone kit tests']) {
      assert.ok(mac.steps.includes(name), `${name}: ${mac.out}`);
      assert.ok(!lin.steps.includes(name), `${name}: ${lin.out}`);
    }
    // Every step, skipped ones too, in exactly one part. And on a Mac, its
    // part checks the desktop app's macOS build, which the Linux host can't.
    const macOnly = process.platform === 'darwin' ? ['desktop macos check', 'desktop macos check as installed'] : [];
    assert.deepEqual(mac.steps.filter((x) => macOnly.includes(x)), macOnly, mac.out);
    assert.deepEqual([...lin.steps, ...mac.steps].filter((x) => !macOnly.includes(x)).sort(), [...whole.steps].sort());
    assert.notEqual(check(['--part', 'both']).status, 0);
    // tb land runs one that failed by itself, with no --part, on the Mac.
    if (process.platform === 'darwin') {
      const alone = check(['--only', 'desktop macos check']);
      assert.equal(alone.status, 0, alone.out);
      assert.deepEqual([...(onlyRan(alone.out) ?? [])], ['desktop macos check']);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every Swift step of check.sh is the Mac part's", () => {
  // A step check-remote.sh's LINUX_STEPS names goes to a Linux host in a
  // split check, where swift isn't.
  const text = fs.readFileSync(path.join(repo, 'check.sh'), 'utf8');
  const linuxSteps = new RegExp(/^LINUX_STEPS='(.*)'$/m.exec(fs.readFileSync(path.join(repo, 'scripts', 'check-remote.sh'), 'utf8'))?.[1] ?? '^$');
  const swift = [...text.matchAll(/^\s*(?:swift_test_step|step) "([^"]+)" .*\bswift (?:build|test)\b/gm)].map((m) => m[1]);
  assert.ok(swift.length >= 4, swift.join(', '));
  for (const name of swift) assert.ok(!linuxSteps.test(name), name);
});
