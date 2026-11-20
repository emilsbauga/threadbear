// A real handover (docs/protocol.md, "Handovers"): launch.mjs supervises
// the runner from a temp data dir, a real Claude turn on the cheapest model
// is busy when an idle restart is asked for, and the new runner takes over
// at once while the old one finishes that turn and hands the thread across.
// Run with `npm run test:e2e`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { RunnerClient } from '../../src/client.ts';
import { testLogin } from '../../src/test-login.ts';

const ACCOUNT = testLogin();
const MODEL = process.env.TB_E2E_MODEL ?? 'claude-haiku-5-5';
const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');

type Ev = Record<string, any>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let root: string;
let supervisor: ChildProcess | undefined;
let output = '';

after(async () => {
  if (supervisor && supervisor.exitCode === null) {
    const gone = new Promise((r) => supervisor!.once('exit', r));
    supervisor.kill('SIGTERM');
    await gone;
  }
  if (root && !process.env.TB_E2E_KEEP) fs.rmSync(root, { recursive: true, force: true });
});

test('a busy turn finishes on the old runner while the new one takes everything else, then moves across', { timeout: 300_000 }, async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-handover-e2e-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  // A data dir laid out as install-runner.sh makes it, with this checkout
  // as its one release.
  const rdir = path.join(home, 'runner');
  fs.mkdirSync(path.join(rdir, 'releases'), { recursive: true });
  fs.copyFileSync(path.join(RUNNER_DIR, 'launch.mjs'), path.join(rdir, 'launch.mjs'));
  fs.symlinkSync(RUNNER_DIR, path.join(rdir, 'releases', 'r1'));
  fs.symlinkSync(path.join('releases', 'r1'), path.join(rdir, 'current'));
  const port = await freePort();

  supervisor = spawn(process.execPath, [path.join(rdir, 'launch.mjs')], {
    env: {
      ...process.env,
      THREADBEAR_HOME: home,
      THREADBEAR_PORT: String(port),
      THREADBEAR_LOG: path.join(root, 'runner.log'),
      THREADBEAR_CLI_UPDATES: 'off', THREADBEAR_TOKEN_TALLY: 'off',
      THREADBEAR_FOLLOW_MAIN: '0',
      THREADBEAR_DEBUG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  supervisor.stdout!.on('data', (d) => (output += d));
  supervisor.stderr!.on('data', (d) => (output += d));
  await waitFor('the first runner', () => /listening on \d+/.test(output), 30_000);
  const token = fs.readFileSync(path.join(home, 'secrets', 'runner-token'), 'utf8').trim();

  // One client that reconnects, as the app does, and keeps every event.
  const events = new Map<string, Ev[]>();
  const seen = (id: string) => events.get(id) ?? [];
  let client: RunnerClient;
  const connect = async () => {
    client = await waitFor(
      'the runner to answer',
      async () => {
        try {
          const c = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, token);
          await c.call('hello', { client: 'handover-e2e', version: '1' });
          return c;
        } catch {
          return undefined;
        }
      },
      60_000,
    );
    client.onNotification((method, params) => {
      if (method !== 'thread.event') return;
      const list = events.get(params.threadId) ?? [];
      if (params.event.seq === undefined || !list.some((e) => e.seq === params.event.seq)) list.push(params.event);
      events.set(params.threadId, list);
    });
  };
  const subscribe = async (id: string) => {
    const after = Math.max(0, ...seen(id).map((e) => e.seq ?? 0));
    const { events: backlog } = await client.call('threads.subscribe', { threadId: id, afterSeq: after });
    const list = events.get(id) ?? [];
    for (const e of backlog) if (!list.some((x) => x.seq === e.seq)) list.push(e);
    events.set(id, list.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)));
  };
  await connect();
  const first = await client!.call('runner.status');

  // An idle thread, and a busy one.
  const idle = (await client!.call('threads.create', { text: 'Reply with just the word OK.', cwd, accountId: ACCOUNT, model: MODEL })).thread.id;
  await subscribe(idle);
  await waitFor('the idle thread to finish', () => seen(idle).some((e) => e.type === 'turn.completed'));
  const busy = (
    await client!.call('threads.create', {
      text: 'Run the shell command `sleep 15` in the foreground (not in the background), wait for it, then reply with just the word DONE.',
      cwd,
      accountId: ACCOUNT,
      model: MODEL,
    })
  ).thread.id;
  await subscribe(busy);
  await waitFor('the sleep to start', () => seen(busy).some((e) => e.type === 'tool.call'));

  const res = await client!.call('runner.restart', {
    when: 'idle',
    reason: 'handover e2e',
    resume: { threadId: busy, text: 'Reply with just the word RESUMED.' },
  });
  assert.deepEqual(res.waitingFor, []);
  assert.deepEqual(res.handover, { keeps: [busy] });

  // The old runner lets go of the port; the new one answers on it.
  await client!.waitClosed();
  await connect();
  const second = await waitFor('the new runner', async () => {
    const s = await client.call('runner.status');
    return s.pid !== first.pid && s.draining?.length ? s : undefined;
  });
  assert.equal(second.draining[0].pid, first.pid);
  assert.deepEqual(second.draining[0].threads, [busy]);
  // Both threads are listed, the busy one still running over there.
  const { threads } = await client!.call('threads.list', { include: ['inbox'] });
  assert.deepEqual(new Set(threads.map((t: Ev) => t.id)), new Set([idle, busy]));
  assert.equal(threads.find((t: Ev) => t.id === busy).status, 'running');

  // Its turn ends over there and comes through the new runner.
  await subscribe(busy);
  await waitFor('the busy turn to end', () => seen(busy).find((e) => e.type === 'turn.completed'));
  const done = seen(busy).filter((e) => e.type === 'assistant.text').map((e) => e.text).join(' ');
  assert.match(done, /DONE/);
  // Then it moves across: the old runner exits and the resume runs here.
  await waitFor('the old runner to exit', () => !alive(first.pid), 60_000);
  await waitFor('the resume', () => seen(busy).some((e) => e.type === 'user.message' && e.origin === 'runner'));
  await waitFor('the resumed turn', () => seen(busy).filter((e) => e.type === 'turn.completed').length >= 2);
  assert.match(seen(busy).filter((e) => e.type === 'assistant.text').at(-1)!.text, /RESUMED/);
  const after = await client!.call('runner.status');
  assert.equal(after.pid, second.pid);
  assert.equal(after.draining, undefined);
  // Seqs went on without a gap or a repeat across the move.
  const seqs = seen(busy).map((e) => e.seq).filter((s) => s !== undefined);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));

  // The idle thread carries on here too.
  await subscribe(idle);
  await client!.call('threads.send', { threadId: idle, text: 'Reply with just the word AGAIN.' });
  await waitFor('the idle thread again', () => seen(idle).filter((e) => e.type === 'turn.completed').length >= 2);
  client!.close();
});
