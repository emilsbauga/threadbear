import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { markGood, readState, runnerVersion, statePath, takeRollbackNotice, type RunnerState } from '../../src/release.ts';
import { restartPath } from '../../src/restart.ts';
import { RunnerClient } from '../../src/client.ts';
import { nullLogger } from '../../src/log.ts';
import { PATIENCE_MS, patiently } from '../helpers/patience.ts';

const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, 'package.json'), 'utf8')).version as string;

function writeState(home: string, state: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(statePath(home)), { recursive: true });
  fs.writeFileSync(statePath(home), JSON.stringify(state));
}

test('the version is <package version>+<release id> in a release, +source otherwise', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  assert.deepEqual(runnerVersion(root), { version: '1.2.3+source' });
  fs.writeFileSync(path.join(root, 'release.json'), JSON.stringify({ id: '20261026T101500Z-abc1234', commit: 'abc1234', dirty: false, builtAt: '', node: 'v24' }));
  assert.deepEqual(runnerVersion(root), { version: '1.2.3+20261026T101500Z-abc1234', release: '20261026T101500Z-abc1234' });
  // A release.json with no id doesn't count.
  fs.writeFileSync(path.join(root, 'release.json'), '{}');
  assert.deepEqual(runnerVersion(root), { version: '1.2.3+source' });
});

test('lastGood is set in place, keeping everything else; a missing state.json is left alone', () => {
  const home = tmpDir();
  assert.equal(markGood(home, 'r2', nullLogger), false);
  assert.equal(fs.existsSync(path.join(home, 'runner')), false, 'no runner folder made for a source run');
  writeState(home, { current: 'r2', previous: 'r1', lastGood: 'r1', boots: [{ release: 'r2', at: 'x' }], somethingNew: 1 });
  assert.equal(markGood(home, undefined, nullLogger), false, 'nothing to mark from source');
  assert.equal(markGood(home, 'r2', nullLogger), true);
  const s = readState(home) as RunnerState & { somethingNew: number };
  assert.equal(s.lastGood, 'r2');
  assert.equal(s.previous, 'r1');
  assert.equal(s.somethingNew, 1);
  assert.deepEqual(s.boots, [{ release: 'r2', at: 'x' }]);
  assert.equal(markGood(home, 'r2', nullLogger), false, 'already good: no write');
  assert.deepEqual(fs.readdirSync(path.join(home, 'runner')), ['state.json'], 'no temp files left');
});

test('a rollback is reported once', () => {
  const home = tmpDir();
  assert.equal(takeRollbackNotice(home, nullLogger), undefined);
  writeState(home, { current: 'r1', previous: 'r2', lastGood: 'r1', boots: [], rolledBack: { from: 'r2', to: 'r1', at: '2026-10-26T10:00:00.000Z' } });
  assert.deepEqual(takeRollbackNotice(home, nullLogger, Date.parse('2026-10-26T10:01:00.000Z')), { message: 'Release r2 kept crashing at startup, so the runner went back to r1.', from: 'r2' });
  assert.equal(readState(home)?.rolledBack?.reportedAt, '2026-10-26T10:01:00.000Z');
  assert.equal(takeRollbackNotice(home, nullLogger), undefined);
});

// ------------------------------------------------- the real entry point

function cleanEnv(): NodeJS.ProcessEnv {
  // A test run from inside a Threadbear thread inherits that runner's
  // variables; none of them may reach the runner under test.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^THREADB(EAR|ARE)_/.test(k)) env[k] = v;
  return env;
}

function startRunner(entry: string, home: string, extra: Record<string, string> = {}) {
  let out = '';
  const proc: ChildProcess = spawn(process.execPath, [entry], {
    env: {
      ...cleanEnv(),
      THREADBEAR_HOME: home,
      THREADBEAR_PORT: '0',
      THREADBEAR_LOG: path.join(home, 'runner.log'),
      THREADBEAR_CLAUDE_PATH: '/nonexistent/claude',
      THREADBEAR_ACCOUNTS_DIR: path.join(home, 'no-accounts'),
      THREADBEAR_CLAUDE_MAIN_DIR: path.join(home, 'no-main'),
      THREADBEAR_CLAUDE_MAIN_JSON: path.join(home, 'no-main.json'),
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)));
  // Resolve from output already buffered or the next data event. Process
  // exit and test cancellation fail promptly; the overall test timeout
  // bounds a child that stays alive without ever becoming ready.
  function nextListening(n: number, signal?: AbortSignal): Promise<number> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        proc.stdout!.off('data', check);
        proc.off('exit', stopped);
        proc.off('error', failed);
        signal?.removeEventListener('abort', aborted);
      };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const stopped = () => failed(new Error(`exited before listening #${n}: ${out}`));
      const aborted = () => failed(new Error(`cancelled waiting for listening #${n}: ${out}`, { cause: signal?.reason }));
      const check = () => {
        const ports = [...out.matchAll(/listening on (\d+)/g)].map(m => Number(m[1]));
        if (ports.length >= n) { cleanup(); resolve(ports[n - 1]); }
        else if (proc.exitCode !== null || proc.signalCode !== null) stopped();
      };
      proc.stdout!.on('data', check);
      proc.once('exit', stopped);
      proc.once('error', failed);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted(); else check();
    });
  }
  const listening = nextListening(1);
  listening.catch(() => {});
  return { proc, out: () => out, listening, nextListening, exited };
}

async function connect(home: string, port: number) {
  const token = fs.readFileSync(path.join(home, 'secrets', 'runner-token'), 'utf8').trim();
  const c = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, token);
  const notices: string[] = [];
  c.onNotification((m, p) => m === 'runner.notice' && notices.push(p.message));
  const hello = await c.call('hello', { client: 'test', version: '1' });
  await new Promise((r) => setTimeout(r, 50));
  return { c, hello, notices };
}

// A release laid out the way deploy-runner.sh builds one, from this
// working tree's code.
function makeRelease(home: string, id: string, fixture = false): string {
  const dir = path.join(home, 'runner', 'releases', id);
  fs.mkdirSync(dir, { recursive: true });
  if (fixture) {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.copyFileSync(path.join(RUNNER_DIR, 'test/deploy/fake-runner.mjs'), path.join(dir, 'src/main.ts'));
    fs.copyFileSync(path.join(RUNNER_DIR, 'src/rpc-auth.ts'), path.join(dir, 'src/rpc-auth.ts'));
    fs.writeFileSync(path.join(dir, 'src/mode.json'), JSON.stringify({ goodAfterMs: -1 }));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  } else {
    fs.cpSync(path.join(RUNNER_DIR, 'src'), path.join(dir, 'src'), { recursive: true });
    fs.copyFileSync(path.join(RUNNER_DIR, 'package.json'), path.join(dir, 'package.json'));
    fs.symlinkSync(path.join(RUNNER_DIR, 'node_modules'), path.join(dir, 'node_modules'));
  }
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ id, commit: 'abc1234', dirty: false, builtAt: new Date().toISOString(), node: process.version }));
  return dir;
}

test('a release reports its id, marks itself good, reports a rollback, and restarts by exiting 0', async () => {
  const home = tmpDir();
  const id = '20261026T101500Z-abc1234';
  const dir = makeRelease(home, id);
  writeState(home, { current: id, previous: 'older', lastGood: 'older', boots: [{ release: id, at: new Date().toISOString() }], rolledBack: { from: 'broken', to: id, at: new Date().toISOString() } });
  // Long enough that a busy Mac still gets through the checks below before
  // the release marks itself good (3 s wasn't, at background priority).
  const a = startRunner(path.join(dir, 'src', 'main.ts'), home, { THREADBEAR_GOOD_AFTER_MS: '10000' });
  try {
    const port = await a.listening;
    const { c, hello, notices } = await connect(home, port);
    assert.equal(hello.runnerVersion, `${PKG_VERSION}+${id}`);
    const rollback = `Release broken kept crashing at startup, so the runner went back to ${id}.`;
    await patiently(() => notices.includes(rollback));
    assert.ok(notices.includes(rollback), notices.join('; '));
    const status = await c.call('runner.status');
    assert.equal(status.release, id);
    assert.equal(status.version, `${PKG_VERSION}+${id}`);
    assert.equal(status.home, home);
    assert.deepEqual(status.running, []);

    assert.equal(readState(home)?.lastGood, 'older', 'not good yet');
    for (const until = Date.now() + PATIENCE_MS; readState(home)?.lastGood !== id && Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const s = readState(home)!;
    assert.equal(s.lastGood, id);
    assert.ok(s.rolledBack?.reportedAt);
    assert.equal(s.previous, 'older');

    // Nothing running, so the restart is immediate: the reply, then exit 0.
    assert.deepEqual(await c.call('runner.restart', { reason: 'test' }), { scheduled: true, waitingFor: [] });
    assert.equal(await a.exited, 0);
    assert.match(a.out(), /listening/);
    const saved = JSON.parse(fs.readFileSync(restartPath(home), 'utf8'));
    assert.equal(saved.fromVersion, `${PKG_VERSION}+${id}`);
    assert.ok(saved.shutdownAt);
    c.close();

    // launchd would start it again: the restart is handled and the rollback
    // isn't reported a second time.
    const b = startRunner(path.join(dir, 'src', 'main.ts'), home);
    try {
      const port2 = await b.listening;
      const second = await connect(home, port2);
      assert.deepEqual(second.notices.filter((n) => /crashing/.test(n)), []);
      assert.equal(fs.existsSync(restartPath(home)), false);
      second.c.close();
      b.proc.kill('SIGTERM');
      assert.equal(await b.exited, 0);
    } finally {
      b.proc.kill('SIGKILL');
    }
  } finally {
    a.proc.kill('SIGKILL');
  }
});

test('a runner run from source says +source and leaves state.json alone', async () => {
  const home = tmpDir();
  const state = { current: 'r1', previous: null, lastGood: 'r1', boots: [] };
  writeState(home, state);
  const r = startRunner(path.join(RUNNER_DIR, 'src', 'main.ts'), home, { THREADBEAR_GOOD_AFTER_MS: '50' });
  try {
    const port = await r.listening;
    const { c, hello } = await connect(home, port);
    assert.equal(hello.runnerVersion, `${PKG_VERSION}+source`);
    assert.equal((await c.call('runner.status')).release, undefined);
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(readState(home), state);
    c.close();
    r.proc.kill('SIGTERM');
    assert.equal(await r.exited, 0);
  } finally {
    r.proc.kill('SIGKILL');
  }
});

// ------------------------------------------------- under launch.mjs

function installLaunch(home: string, current: string): string {
  const launch = path.join(home, 'runner', 'launch.mjs');
  fs.copyFileSync(path.join(RUNNER_DIR, 'launch.mjs'), launch);
  fs.symlinkSync(path.join('releases', current), path.join(home, 'runner', 'current'));
  return launch;
}

test('planned restarts under launch.mjs are clean stops, so several in a row are not a crash loop', { timeout: 300_000 }, async t => {
  const home = tmpDir();
  const older = '20261025T101500Z-0000001';
  const id = '20261026T101500Z-abc1234';
  // Exercise the real supervisor with the existing tiny authenticated runner
  // fixture. main.ts/restart RPC integration is covered by the tests above;
  // five complete app/SDK startups add no supervisor coverage here.
  makeRelease(home, older, true);
  makeRelease(home, id, true);
  const launch = installLaunch(home, id);
  writeState(home, { current: id, previous: older, lastGood: older, boots: [] });
  // The fixture never marks itself good, regardless of scheduling delays.
  const r = startRunner(launch, home, { THREADBEAR_RESTART_MS: '50' });
  t.after(() => { r.proc.kill('SIGKILL'); });
  try {
    for (let i = 0; i < 5; i++) {
      const port = await r.nextListening(i + 1, t.signal);
      const { c, hello } = await connect(home, port);
      assert.equal(hello.runnerVersion, `9.9.9+${id}`, `start ${i + 1} runs the new release`);
      if (i < 4) assert.deepEqual(await c.call('runner.restart', { reason: `restart ${i + 1}` }), { scheduled: true, waitingFor: [] });
      c.close();
    }
    // Stopping the supervisor stops its runner cleanly too.
    r.proc.kill('SIGTERM');
    assert.equal(await r.exited, 0);
  } finally {
    r.proc.kill('SIGKILL');
  }
  const s = readState(home)!;
  assert.equal(s.rolledBack, undefined);
  assert.equal(s.current, id);
  assert.equal(s.lastGood, older);
  assert.deepEqual(
    s.boots.map((b) => [b.release, b.clean]),
    Array.from({ length: 5 }, () => [id, true]),
  );
  // Each boot is the child's pid, not the supervisor's.
  assert.ok(s.boots.every((b) => typeof b.pid === 'number' && b.pid !== r.proc.pid));
});

test('launch.mjs stops a release that never starts listening, and that start counts as a crash', async () => {
  const home = tmpDir();
  const id = '20261026T101500Z-0000002';
  const dir = path.join(home, 'runner', 'releases', id);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  // Says it reports listening, then hangs at startup.
  fs.writeFileSync(path.join(dir, 'src', 'main.ts'), 'export const REPORTS_LISTENING = true;\nsetInterval(() => {}, 1000);\n');
  const launch = installLaunch(home, id);
  writeState(home, { current: id, previous: null, lastGood: null, boots: [] });
  const r = startRunner(launch, home, { THREADBEAR_START_TIMEOUT_MS: '300' });
  try {
    assert.equal(await r.exited, 1);
    assert.match(r.out(), new RegExp(`release ${id} wasn't listening after 0 s; stopping it so it counts as a failed start`));
    const s = readState(home)!;
    assert.equal(s.boots.length, 1);
    assert.equal(s.boots[0].clean, undefined);
  } finally {
    r.proc.kill('SIGKILL');
  }
});

// ------------------------------------------------- the supervisor channel

// Runs `code` (an ES module importing release.ts) as a child with an IPC
// channel, the way launch.mjs starts a runner.
function ipcChild(code: string, env: Record<string, string> = { THREADBEAR_SUPERVISED: '1' }) {
  const src = path.join(RUNNER_DIR, 'src', 'release.ts');
  const proc = spawn(process.execPath, ['--input-type=module', '-e', `import * as release from ${JSON.stringify(src)};\n${code}`], {
    env: { ...cleanEnv(), ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const messages: unknown[] = [];
  proc.on('message', (m) => messages.push(m));
  const exited = new Promise<number | null>((r) => proc.once('exit', (c) => r(c)));
  return { proc, out: () => out, messages, exited };
}

async function until(what: string, fn: () => boolean, ms = PATIENCE_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('supervised() needs both THREADBEAR_SUPERVISED and an IPC channel', async () => {
  const a = ipcChild('console.log(JSON.stringify(release.supervised())); process.disconnect();');
  assert.equal(await a.exited, 0, a.out());
  assert.equal(a.out().trim(), 'true');
  const b = ipcChild('console.log(JSON.stringify(release.supervised())); process.disconnect();', {});
  assert.equal(await b.exited, 0, b.out());
  assert.equal(b.out().trim(), 'false');
  const reply = ipcChild('const r = await release.requestHandover(); console.log(JSON.stringify(r)); process.disconnect();', {});
  assert.equal(await reply.exited, 0, reply.out());
  assert.deepEqual(JSON.parse(reply.out()), { ok: false, error: 'not started by a launch.mjs that supervises' });
});

test('tellLaunchListening tells the supervisor over IPC', async () => {
  const c = ipcChild('release.tellLaunchListening(); setTimeout(() => process.disconnect(), 100);');
  assert.equal(await c.exited, 0, c.out());
  assert.deepEqual(c.messages, [{ type: 'listening' }]);
});

test("requestHandover: the supervisor's answer, a refusal, and no answer in time", async () => {
  const code = 'const r = await release.requestHandover(Number(process.env.WAIT_MS)); console.log(JSON.stringify(r)); process.disconnect();';
  const ok = ipcChild(code, { THREADBEAR_SUPERVISED: '1', WAIT_MS: '5000' });
  await until('the handover request', () => ok.messages.length > 0);
  assert.deepEqual(ok.messages, [{ type: 'handover' }]);
  // Something else first is ignored.
  ok.proc.send({ type: 'other' });
  ok.proc.send({ type: 'handover', ok: true, pid: 4242 });
  assert.equal(await ok.exited, 0, ok.out());
  assert.deepEqual(JSON.parse(ok.out()), { ok: true, pid: 4242 });

  const no = ipcChild(code, { THREADBEAR_SUPERVISED: '1', WAIT_MS: '5000' });
  await until('the handover request', () => no.messages.length > 0);
  no.proc.send({ type: 'handover', ok: false, error: 'only the newest runner can hand over' });
  assert.equal(await no.exited, 0, no.out());
  assert.deepEqual(JSON.parse(no.out()), { ok: false, error: 'only the newest runner can hand over' });

  const slow = ipcChild(code, { THREADBEAR_SUPERVISED: '1', WAIT_MS: '200' });
  assert.equal(await slow.exited, 0, slow.out());
  assert.deepEqual(JSON.parse(slow.out()), { ok: false, error: 'no answer from the supervisor in 0 s' });
});

test('onSupervisorGone fires when the IPC channel closes', async () => {
  const c = ipcChild("release.onSupervisorGone(() => { console.log('gone'); process.exit(0); }); setInterval(() => {}, 1000);");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.out(), '');
  c.proc.disconnect();
  assert.equal(await c.exited, 0, c.out());
  assert.equal(c.out().trim(), 'gone');
});
