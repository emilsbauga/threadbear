// deploy.mjs's build steps (scripts/deploy-steps.mjs) with fake processes in
// place of npm: what a step says when its process never ran or was killed,
// and when the unit tests get a second go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';

// A .mjs with no types, so imported by URL (typed any) rather than by name.
const steps = await import(pathToFileURL(path.join(import.meta.dirname, '..', '..', 'scripts', 'deploy-steps.mjs')).href);

type Run = { status: number | null; signal?: string | null; error?: Error; output?: string };

// Fake spawnSync: plays the runs in order, writing each one's output to the
// step's log as the real process would.
function fakeIo(runs: Run[]) {
  const said: string[] = [];
  const calls: { cmd: string; args: string[] }[] = [];
  const io = {
    tmpdir: tmpDir(),
    say: (s: string) => said.push(s),
    write: (s: string) => said.push(s),
    error: () => {},
    spawn: (cmd: string, args: string[], opts: { stdio: [unknown, number, number] }) => {
      calls.push({ cmd, args });
      const r = runs.shift();
      assert.ok(r, `no run left for ${cmd} ${args.join(' ')}`);
      if (r.output) fs.writeSync(opts.stdio[1], r.output);
      return { status: r.status, signal: r.signal ?? null, error: r.error };
    },
  };
  return { io, said, calls };
}

const c = { npm: '/opt/node/bin/npm', node: '/opt/node/bin/node' };

test('step: a process that never started says why, in the error and its log', () => {
  const { io } = fakeIo([{ status: null, error: Object.assign(new Error('spawn /opt/node/bin/npm EAGAIN'), { code: 'EAGAIN' }) }]);
  assert.throws(
    () => steps.step('Unit tests', c.npm, ['test'], {}, io),
    (e: Error & { logFile: string }) => {
      assert.match(e.message, /Unit tests failed \(npm couldn't run: spawn \/opt\/node\/bin\/npm EAGAIN\); the whole output is in \S+$/);
      assert.match(fs.readFileSync(e.logFile, 'utf8'), /npm couldn't run: spawn \/opt\/node\/bin\/npm EAGAIN/);
      return true;
    },
  );
});

test('step: a killed process says which signal', () => {
  const { io } = fakeIo([{ status: null, signal: 'SIGKILL' }]);
  assert.throws(() => steps.step('Unit tests', c.npm, ['test'], {}, io), /Unit tests failed \(npm was stopped by SIGKILL\)/);
});

test('step: a plain failure says the exit code', () => {
  const { io } = fakeIo([{ status: 1, output: 'boom\n' }]);
  assert.throws(() => steps.step('Typecheck', c.npm, ['run', 'typecheck'], {}, io), /Typecheck failed \(npm exited with 1\); the whole output is in /);
});

test('unitTests: a run that failed without naming a test file gets the whole suite once more', () => {
  // As on 4 Nov (THREADBEAR-M): npm test died in 0.1s with an empty log.
  const { io, said, calls } = fakeIo([{ status: null, signal: 'SIGKILL' }, { status: 0 }]);
  steps.unitTests(c, {}, io);
  assert.deepEqual(calls.map((x) => [x.cmd, ...x.args]), [[c.npm, 'test'], [c.npm, 'test']]);
  assert.ok(said.some((s) => /running them once more/.test(s)), said.join('\n'));
});

test('unitTests: a break that fails both whole runs still stops the build', () => {
  const { io, calls } = fakeIo([{ status: 1, output: 'Error: Cannot find module\n' }, { status: 1, output: 'Error: Cannot find module\n' }]);
  assert.throws(() => steps.unitTests(c, {}, io), /Unit tests, again failed \(npm exited with 1\)/);
  assert.equal(calls.length, 2);
});

test('unitTests: failed files are rerun alone, not the whole suite', () => {
  const output = 'not ok 1 - thing\ntest at test/unit/flaky.test.ts:12:3\n';
  const { io, said, calls } = fakeIo([{ status: 1, output }, { status: 0 }]);
  steps.unitTests(c, {}, io);
  assert.equal(calls[1].cmd, c.node);
  assert.ok(calls[1].args.includes('test/unit/flaky.test.ts'));
  assert.ok(calls[1].args.includes('--test-concurrency=1'));
  assert.ok(said.some((s) => /^Flaky: test\/unit\/flaky\.test\.ts/.test(s)), said.join('\n'));
});

test('unitTests: a test that fails twice stops the build', () => {
  const output = 'test at test/unit/broken.test.ts:1:1\n';
  const { io } = fakeIo([{ status: 1, output }, { status: 1, output }]);
  assert.throws(() => steps.unitTests(c, {}, io), /Rerunning test\/unit\/broken\.test\.ts failed \(node exited with 1\)/);
});

// CPU load alone does not describe memory or I/O stalls during startup.
test('the smoke test gives startup a bounded budget even with low CPU load', () => {
  assert.equal(steps.smokeTimedOut(89_000, 0.5), false);
  assert.equal(steps.smokeTimedOut(91_000, 0.5), false);
  assert.equal(steps.smokeTimedOut(91_000, 1.0), false);
  assert.equal(steps.smokeTimedOut(91_000, 5.2), false);
  assert.equal(steps.smokeTimedOut(9 * 60_000, 5.2), false);
  assert.equal(steps.smokeTimedOut(10 * 60_000 + 1, 5.2), true);
});

test('smoke hello tolerates slow answers within the shared startup budget', async () => {
  let now = 0;
  let attempts = 0;
  const result = await steps.smokeHello({
    probe: async () => { now += 7_000; return ++attempts < 3 ? { state: attempts === 1 ? 'unknown' : 'down' } : { state: 'up', version: 'release' }; },
    waited: () => now, load: () => 0.5, exited: () => null,
    sleep: async () => { now += 100; },
  });
  assert.equal(result.version, 'release');
  assert.equal(attempts, 3);
});

test('smoke hello stops on exit or a bounded timeout', async () => {
  const io = {
    probe: async () => ({ state: 'unknown' }), waited: () => 601_000,
    load: () => 0.5, exited: () => null, sleep: async () => {},
  };
  await assert.rejects(steps.smokeHello(io), /hello got no answer after 601 s/);
  await assert.rejects(steps.smokeHello({ ...io, exited: () => ({ code: 1 }) }), /it exited \(1\)/);
  await assert.rejects(steps.smokeHello({ ...io, waited: () => 600_001, load: () => 5 }), /hello got no answer/);
});


test('smoke hello keeps waiting when CPU load misses startup pressure', async () => {
  let attempts = 0;
  const result = await steps.smokeHello({
    probe: async () => (++attempts === 1 ? { state: 'unknown' } : { state: 'up' }),
    waited: () => 120_000, load: () => 0.5, exited: () => null, sleep: async () => {},
  });
  assert.equal(result.state, 'up');
  assert.equal(attempts, 2);
});

test('sleep-interrupted failures defer the update instead of rerunning tests or marking code broken', () => {
  const { io, calls } = fakeIo([{ status: 1, output: 'test at test/unit/upstream.test.ts:227:1\n' }]);
  let reads = 0;
  assert.throws(() => steps.unitTests(c, {}, { ...io, sleepCount: () => ++reads }), /Mac slept during Unit tests; retry after wake/);
  assert.equal(calls.length, 1);
});

test('a failed step with no system sleep still reports the real failure', () => {
  const { io } = fakeIo([{ status: 1 }]);
  assert.throws(() => steps.step('Typecheck', c.npm, [], {}, { ...io, sleepCount: () => 4 }), /npm exited with 1/);
});
