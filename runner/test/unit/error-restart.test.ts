// The real runner entry point after an uncaught error (src/error-exits.ts),
// thrown on purpose through the test-only THREADBEAR_TEST_THROW hook. No CLI
// is ever spawned: claudePath points nowhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { readToken } from '../../src/config.ts';
import { RunnerClient } from '../../src/client.ts';
import { patiently } from '../helpers/patience.ts';
import { ERROR_EXIT_CODE, ERROR_EXITS, errorExitsPath, readErrorExits, writeErrorExits } from '../../src/error-exits.ts';

const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');

// `supervised`: as launch.mjs starts it (THREADBEAR_SUPERVISED=1 and an IPC
// channel), so it restarts after an error rather than carrying on.
function startRunner(home: string, env: Record<string, string>, supervised: boolean): { proc: ChildProcess; out: () => string; listening: Promise<number>; exited: Promise<number | null> } {
  let out = '';
  const proc = spawn(process.execPath, ['src/main.ts'], {
    cwd: RUNNER_DIR,
    env: {
      ...process.env,
      THREADBEAR_HOME: home,
      THREADBEAR_PORT: '0',
      THREADBEAR_LOG: path.join(home, 'runner.log'),
      THREADBEAR_CLAUDE_PATH: path.join(home, 'no-claude'),
      THREADBEAR_ACCOUNTS_DIR: path.join(home, 'no-accounts'),
      THREADBEAR_CLAUDE_MAIN_DIR: path.join(home, 'no-main'),
      THREADBEAR_CLAUDE_MAIN_JSON: path.join(home, 'no-main.json'),
      THREADBEAR_CODEX_MAIN_DIR: path.join(home, 'no-codex-main'),
      THREADBEAR_TOKEN_STATS_LIMITS: path.join(home, 'no-limits.json'),
      THREADBEAR_CLI_UPDATES: 'off',
      THREADBEAR_SUPERVISED: supervised ? '1' : '',
      THREADBEAR_DEV_RUNNER: '',
      ...env,
    },
    stdio: supervised ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  // A stand-in for launch.mjs: it answers a handover request with no.
  proc.on('message', (m: { type?: string }) => {
    if (m?.type === 'handover') proc.send({ type: 'handover', ok: false, error: 'not in this test' });
  });
  const exited = new Promise<number | null>((r) => proc.once('exit', (code) => r(code)));
  const listening = new Promise<number>((resolve, reject) => {
    proc.stdout!.on('data', () => {
      const m = /listening on (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    void exited.then((code) => reject(new Error(`exited ${code}: ${out}`)));
  });
  listening.catch(() => {});
  return { proc, out: () => out, listening, exited };
}

const logOf = (home: string) => fs.readFileSync(path.join(home, 'runner.log'), 'utf8');

for (const kind of ['rejection', 'exception'] as const) {
  test(`a supervised runner restarts the planned way after an unhandled ${kind}, and counts it`, async () => {
    const home = tmpDir();
    const r = startRunner(home, { THREADBEAR_TEST_THROW: kind, THREADBEAR_TEST_THROW_MS: '200' }, true);
    try {
      await r.listening;
      assert.equal(await r.exited, 0, r.out());
      const log = logOf(home);
      assert.match(log, kind === 'rejection' ? /ERROR unhandled rejection/ : /ERROR uncaught exception/);
      assert.match(log, /restarting after an uncaught error/);
      // The same stop as a planned restart: runner.restart's own steps ran.
      assert.match(log, /"reason":"An unexpected error \(see the runner log\)"/);
      assert.match(log, /runner stopping \{"signal":"restart"\}/);
      assert.match(log, /runner stopped/);
      assert.equal(readErrorExits(home).exits.length, 1);
      assert.equal(fs.existsSync(path.join(home, 'run', 'runner.pid')), false, 'the lock is released, as on a clean stop');
    } finally {
      r.proc.kill('SIGKILL');
    }
  });
}

test('after ERROR_EXITS restarts in the window the next error is only logged, and every client is warned', async () => {
  const home = tmpDir();
  const now = Date.now();
  writeErrorExits(home, { exits: Array.from({ length: ERROR_EXITS }, (_, i) => new Date(now - (i + 1) * 60_000).toISOString()) });
  const r = startRunner(home, { THREADBEAR_TEST_THROW: 'rejection', THREADBEAR_TEST_THROW_MS: '200' }, true);
  let client: RunnerClient | undefined;
  try {
    const port = await r.listening;
    await patiently(() => Boolean(readErrorExits(home).tripped));
    assert.ok(readErrorExits(home).tripped, logOf(home));
    assert.match(logOf(home), /stopped restarting for uncaught errors/);
    // Still serving: a client connecting now hears the warning after hello.
    const notices: { level: string; message: string }[] = [];
    client = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, readToken(home));
    client.onNotification((method, params) => {
      if (method === 'runner.notice') notices.push(params);
    });
    await client.call('hello', { client: 'test', version: '1' });
    await patiently(() => notices.some((n) => /stopped restarting for them/.test(n.message)));
    const warned = notices.find((n) => /stopped restarting for them/.test(n.message));
    assert.equal(warned?.level, 'warning', JSON.stringify(notices));
    assert.equal(r.proc.exitCode, null, 'it carried on');
  } finally {
    client?.close();
    r.proc.kill('SIGTERM');
    await r.exited;
  }
});

test('a dev runner exits with an error code after an uncaught error, so dev-runner.sh does not start it again', async () => {
  const home = tmpDir();
  const r = startRunner(home, { THREADBEAR_TEST_THROW: 'exception', THREADBEAR_TEST_THROW_MS: '200', THREADBEAR_DEV_RUNNER: '1' }, false);
  try {
    await r.listening;
    assert.equal(await r.exited, ERROR_EXIT_CODE, r.out());
    assert.match(logOf(home), /exiting after an uncaught error/);
  } finally {
    r.proc.kill('SIGKILL');
  }
});

test('a dev runner exits however many errors it has had, and leaves the count alone', async () => {
  const home = tmpDir();
  const now = Date.now();
  writeErrorExits(home, { exits: [1, 2, 3].map((i) => new Date(now - i * 60_000).toISOString()), tripped: { at: new Date(now).toISOString(), lastErrorAt: new Date(now).toISOString(), errors: 1 } });
  const before = fs.readFileSync(errorExitsPath(home), 'utf8');
  const r = startRunner(home, { THREADBEAR_TEST_THROW: 'rejection', THREADBEAR_TEST_THROW_MS: '200', THREADBEAR_DEV_RUNNER: '1' }, false);
  try {
    await r.listening;
    assert.equal(await r.exited, ERROR_EXIT_CODE, r.out());
    assert.equal(fs.readFileSync(errorExitsPath(home), 'utf8'), before);
  } finally {
    r.proc.kill('SIGKILL');
  }
});

test("a supervised runner whose count can't be saved carries on rather than restart uncounted", async () => {
  const home = tmpDir();
  // A folder where the file goes: every write fails.
  fs.mkdirSync(errorExitsPath(home), { recursive: true });
  const r = startRunner(home, { THREADBEAR_TEST_THROW: 'exception', THREADBEAR_TEST_THROW_MS: '200' }, true);
  try {
    await r.listening;
    await patiently(() => /couldn't be saved/.test(logOf(home)));
    assert.match(logOf(home), /carrying on after an uncaught error: the restart guard's count couldn't be saved/);
    assert.doesNotMatch(logOf(home), /restarting after an uncaught error/);
    assert.equal(r.proc.exitCode, null);
  } finally {
    r.proc.kill('SIGTERM');
    await r.exited;
  }
});

test('a runner nothing supervises (a test, one started by hand) logs the error and carries on', async () => {
  const home = tmpDir();
  const r = startRunner(home, { THREADBEAR_TEST_THROW: 'rejection', THREADBEAR_TEST_THROW_MS: '100' }, false);
  try {
    await r.listening;
    await patiently(() => /ERROR unhandled rejection/.test(logOf(home)));
    assert.match(logOf(home), /nothing would start this runner again, so it carries on/);
    assert.equal(r.proc.exitCode, null);
    assert.deepEqual(readErrorExits(home), { exits: [] });
  } finally {
    r.proc.kill('SIGTERM');
    await r.exited;
  }
});
