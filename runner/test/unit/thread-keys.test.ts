// A thread's own key on the RPC, and what it can't do with it
// (docs/protocol/connection.md, "A thread's own key"). The tests go through a real
// server and the real tb, as an agent's shell would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATIENCE_MS, patiently } from '../helpers/patience.ts';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { makeHarness } from '../helpers/fakes.ts';
import { RpcServer } from '../../src/rpc.ts';
import { RunnerClient } from '../../src/client.ts';
import { readRunnerJson, readToken, writeRunnerJson } from '../../src/config.ts';
import { nullLogger } from '../../src/log.ts';
import { threadKey } from '../../src/rpc-auth.ts';
import { GATED_READS, CallerGate } from '../../src/rpc-gate.ts';
import { Scheduler, scheduleMethods } from '../../src/schedules.ts';
import type { PermissionMode } from '../../src/protocol.ts';
import type { PeerCaller } from '../../src/peer.ts';

const TB = path.join(import.meta.dirname, '..', '..', 'bin', 'tb');

type Opts = Partial<ConstructorParameters<typeof RpcServer>[0]>;

async function serve(extra: Opts = {}) {
  const h = makeHarness();
  const token = readToken(h.home);
  const scheduler = new Scheduler({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, zone: () => 'UTC' });
  const gate = new CallerGate({ runner: h.runner, schedules: scheduler });
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token, runner: h.runner, log: nullLogger, gate, methods: { ...scheduleMethods(scheduler), 'runner.restart': () => ({}), 'runner.reinstall': () => ({ reinstall: null }), 'instructions.set': () => ({}), 'settings.update': () => ({}), 'pools.save': () => ({}), 'devices.pair': () => ({}) }, ...extra });
  const { port } = await server.listen();
  return { h, server, token, port, url: `ws://127.0.0.1:${port}/rpc`, scheduler };
}

const thread = (h: ReturnType<typeof makeHarness>, mode: PermissionMode, title: string = mode) =>
  h.runner.create({ text: title, accountId: 'claude-3', permissionMode: mode }).thread;

// A connection as that thread: with its key, the way tb connects.
const as = (url: string, token: string, id: string) => RunnerClient.connect(url, threadKey(token, id), { threadId: id });

function tb(h: { home: string }, url: string, id: string | undefined, key: string | undefined, args: string[], env: Record<string, string> = {}) {
  let out = '';
  const p = spawn(process.execPath, [TB, ...args], {
    env: {
      ...process.env,
      THREADBEAR_HOME: h.home,
      THREADBEAR_RUNNER_HOME: h.home,
      THREADBEAR_URL: url,
      THREADBEAR_THREAD_ID: id ?? '',
      THREADBEAR_THREAD_KEY: key ?? '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const code = new Promise<number | null>((r) => p.once('exit', (c) => r(c)));
  return code.then((c) => ({ code: c, out }));
}

const refused = (e: { code?: number }) => e.code === -32060;
// What a lookup that found the client says: under that thread's CLI, or under none.
const peerOf = (threadId: string | undefined): PeerCaller => (threadId ? { kind: 'thread', threadId } : { kind: 'owner' });
// A lookup's answer as a word: the thread, or 'owner' for under none.
const who = (c: PeerCaller) => (c.kind === 'thread' ? c.threadId : 'owner');
const MODES: PermissionMode[] = ['ask', 'auto'];

test('a key only works for its own thread, and is not the token', async () => {
  const { h, server, token, url } = await serve();
  const a = thread(h, 'auto', 'a');
  const b = thread(h, 'full', 'b');
  try {
    assert.notEqual(threadKey(token, a.id), token);
    assert.match(threadKey(token, a.id), /^[0-9a-f]{64}$/);
    // Thread a's key doesn't prove thread b.
    await assert.rejects(RunnerClient.connect(url, threadKey(token, a.id), { threadId: b.id }));
    // Nor is a key the token: without the id it's just a wrong token.
    await assert.rejects(RunnerClient.connect(url, threadKey(token, a.id)));
    // And the token can't pretend to be a thread's key.
    await assert.rejects(RunnerClient.connect(url, token, { threadId: a.id }));
    const c = await as(url, token, a.id);
    assert.equal((await c.call<{ threadId: string; limited: boolean; mode: string }>('auth.whoami')).threadId, a.id);
    c.close();
    const owner = await RunnerClient.connect(url, token);
    assert.deepEqual(await owner.call('auth.whoami'), {});
    owner.close();
  } finally {
    await server.close();
  }
});

for (const mode of MODES) {
  test(`${mode}: tb new --full is refused, and a thread it may start goes no higher than the caller`, async () => {
    const { h, server, token, url } = await serve();
    const me = thread(h, mode);
    try {
      const key = threadKey(token, me.id);
      const r = await tb(h, url, me.id, key, ['new', '--full', '--account', 'claude-3', 'do anything']);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /create_thread/, 'says which tool can ask');
      assert.equal(h.runner.list(['inbox']).length, 1, 'no thread started');
      // No flag at all: the runner's default may be Full, so it takes the caller's.
      const fine = await tb(h, url, me.id, key, ['new', '--account', 'claude-3', 'harmless']);
      assert.equal(fine.code, 0, fine.out);
      const made = h.runner.list(['inbox']).find((t) => t.id === fine.out.trim());
      assert.equal(made?.permissionMode, mode);
    } finally {
      await server.close();
    }
  });

  test(`${mode}: tb send to a higher thread is refused, to one no higher goes through`, async () => {
    const { h, server, token, url } = await serve();
    const me = thread(h, mode);
    const full = thread(h, 'full', 'full one');
    const low = thread(h, 'ask', 'low one');
    try {
      const key = threadKey(token, me.id);
      const r = await tb(h, url, me.id, key, ['send', full.id, 'run this']);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /send_message/);
      assert.equal(h.adapter.sessions.length, 3, 'nothing sent on');
      const ok = await tb(h, url, me.id, key, ['send', low.id, 'hello']);
      assert.equal(ok.code, 0, ok.out);
    } finally {
      await server.close();
    }
  });

  test(`${mode}: tb approve on its own card (or any card) is refused`, async () => {
    const { h, server, token, url } = await serve();
    const me = thread(h, mode);
    try {
      const c = await as(url, token, me.id);
      await assert.rejects(c.call('approvals.respond', { threadId: me.id, approvalId: 'x', decision: 'allow' }), refused);
      await assert.rejects(c.call('plans.approve', { threadId: me.id, itemId: 'x' }), refused);
      await assert.rejects(c.call('secrets.answer', { threadId: me.id, approvalId: 'x', decline: true }), refused);
      c.close();
    } finally {
      await server.close();
    }
  });

  test(`${mode}: tb schedule --full is refused, a check too, and a plain one takes the caller's mode`, async () => {
    const { h, server, token, url } = await serve();
    const me = thread(h, mode);
    try {
      const key = threadKey(token, me.id);
      const r = await tb(h, url, me.id, key, ['schedule', 'do it', '--at', '30m', '--full', '--cwd', h.home]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /schedule_message/);
      const c = await as(url, token, me.id);
      await assert.rejects(c.call('schedules.create', { text: 'x', at: new Date(Date.now() + 60_000).toISOString(), threadId: me.id, check: 'true' }), refused);
      const ok = await c.call<{ schedule: { permissionMode?: string; createdBy?: string } }>('schedules.create', { text: 'x', at: new Date(Date.now() + 60_000).toISOString(), cwd: h.home, accountId: 'claude-3' });
      assert.equal(ok.schedule.permissionMode, mode);
      assert.equal(ok.schedule.createdBy, me.id);
      c.close();
    } finally {
      await server.close();
    }
  });

  test(`${mode}: a raw RPC call with the key can't get round it`, async () => {
    const { h, server, token, url } = await serve();
    const me = thread(h, mode);
    const full = thread(h, 'full', 'higher');
    try {
      const c = await as(url, token, me.id);
      const denied: [string, Record<string, unknown>][] = [
        ['threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' }],
        ['threads.send', { threadId: full.id, text: 'x' }],
        ['threads.update', { threadId: me.id, permissionMode: 'full' }],
        ['threads.update', { threadId: full.id, cwd: h.home }],
        ['threads.update', { threadId: me.id, archived: true }],
        ['threads.delete', { threadId: full.id }],
        ['threads.edit', { threadId: me.id, seq: 1, text: 'x' }],
        ['threads.share', { threadId: me.id, access: 'link' }],
        ['buttons.press', { threadId: me.id, buttonId: 'x' }],
        ['patches.trust', { threadId: me.id, files: [{ file: 'a', hash: 'b' }] }],
        ['actions.run', { threadId: me.id, actionId: 'x' }],
        ['instructions.set', { text: 'x' }],
        ['settings.update', { }],
        ['runner.restart', {}],
        ['pools.save', { pools: [] }],
        ['devices.pair', {}],
        ['clis.update', { provider: 'claude' }],
        ['accounts.useReset', { accountId: 'codex-main' }],
        ['accounts.findWork', { accountId: 'codex-main' }],
        ['accounts.recheck', {}],
        ['accounts.yearToken', { accountId: 'claude-main' }],
        ['accounts.yearToken', { accountId: 'claude-main', runnerId: 'cb921b2447ea', code: 'abcdefgh#ijklmnop' }],
        ['panels.convexKey', { threadId: me.id, panelId: 'x' }],
        ['no.such.method', {}],
      ];
      for (const [method, params] of denied) {
        await assert.rejects(c.call(method, params), refused, method);
      }
      // Reads still work.
      const listed = await c.call<{ threads: { id: string }[] }>('threads.list', {});
      assert.ok(listed.threads.some((t) => t.id === full.id));
      assert.ok(await c.call('threads.events', { threadId: full.id, limit: 1 }));
      // Lowering is free.
      const lowered = await c.call<{ thread: { permissionMode: string } }>('threads.update', { threadId: me.id, permissionMode: 'ask' });
      assert.equal(lowered.thread.permissionMode, 'ask');
      c.close();
    } finally {
      await server.close();
    }
  });
}

test('every read the gate lets through is a real read, not a change', () => {
  for (const m of GATED_READS) assert.doesNotMatch(m.split('.').pop()!, /^(create|update|delete|set|save|respond|press|trust|run|pair|revoke|restart|answer|edit|share|move|merge|send)/i, m);
});

test('a thread on Full access still has the lot, through its key', async () => {
  const { h, server, token, url } = await serve();
  const me = thread(h, 'full');
  try {
    const key = threadKey(token, me.id);
    const r = await tb(h, url, me.id, key, ['new', '--full', '--account', 'claude-3', 'go']);
    assert.equal(r.code, 0, r.out);
    const made = h.runner.list(['inbox']).find((t) => t.id === r.out.trim());
    assert.equal(made?.permissionMode, 'full');
    const c = await as(url, token, me.id);
    assert.equal((await c.call<{ limited: boolean }>('auth.whoami')).limited, false);
    // Except reinstalling the runner, which stops every thread: the user's,
    // from the Updates panel, on any mode.
    await assert.rejects(c.call('runner.reinstall'), (e: { code?: number; message?: string }) => refused(e) && /Updates panel/.test(e.message ?? ''));
    c.close();
  } finally {
    await server.close();
  }
});

test('a thread lowered to Ask loses it at once: the mode is read at each call', async () => {
  const { h, server, token, url } = await serve();
  const me = thread(h, 'full');
  try {
    const c = await as(url, token, me.id);
    await c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' });
    h.runner.update({ threadId: me.id, permissionMode: 'ask' });
    await assert.rejects(c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' }), refused);
    c.close();
  } finally {
    await server.close();
  }
});

// Codex's review, 19 Nov: a Full access thread could ask another runner for
// a token page, approve it with an account of its own and send the code.
test("a Full access thread can't make a year-long token, here or on another runner", async () => {
  const { h, server, token, url } = await serve();
  const me = thread(h, 'full');
  try {
    const c = await as(url, token, me.id);
    for (const params of [{ accountId: 'claude-main' }, { accountId: 'claude-main', runnerId: 'cb921b2447ea', code: 'abcdefgh#ijklmnop' }]) {
      await assert.rejects(c.call('accounts.yearToken', params), /user's to do/);
    }
    c.close();
  } finally {
    await server.close();
  }
});

test('tb outside a thread uses the token and can do everything', async () => {
  const { h, server, url } = await serve();
  try {
    const r = await tb(h, url, undefined, undefined, ['new', '--full', '--account', 'claude-3', 'mine']);
    assert.equal(r.code, 0, r.out);
    assert.equal(h.runner.list(['inbox']).find((t) => t.id === r.out.trim())?.permissionMode, 'full');
  } finally {
    await server.close();
  }
});

test("the owner token from a thread's own process tree gets that thread's limits", async () => {
  // Stands in for the lsof/ps lookup: this connection comes from thread `me`'s CLI.
  let from: string | undefined;
  const { h, server, token, url } = await serve({ callerOf: async () => peerOf(from) });
  const me = thread(h, 'auto');
  try {
    from = me.id;
    const c = await RunnerClient.connect(url, token);
    const who = await c.call<{ threadId: string; limited: boolean }>('auth.whoami');
    assert.equal(who.threadId, me.id);
    assert.equal(who.limited, true);
    await assert.rejects(c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' }), refused);
    c.close();
    // tb with the key wiped, the way an agent would get round tb's own check.
    const r = await tb(h, url, '', '', ['new', '--full', '--account', 'claude-3', 'sneaky']);
    assert.equal(r.code, 1, r.out);
    assert.equal(h.runner.list(['inbox']).length, 1);
    // The same token not under any CLI is the owner again.
    from = undefined;
    const owner = await RunnerClient.connect(url, token);
    assert.deepEqual(await owner.call('auth.whoami'), {});
    owner.close();
  } finally {
    await server.close();
  }
});

test("another thread's key lifted from its environment is refused", async () => {
  let from: string | undefined;
  const { h, server, token, url } = await serve({ callerOf: async () => peerOf(from) });
  const thief = thread(h, 'ask');
  const victim = thread(h, 'full');
  try {
    from = thief.id;
    const c = await as(url, token, victim.id);
    await assert.rejects(c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' }));
    assert.equal(h.runner.list(['inbox']).length, 2, 'nothing made');
    c.close();
  } finally {
    await server.close();
  }
});

// Daybreak finding 137: the process lookup used to go by the client's port
// alone, and its answer replaced the thread the key had proved. A
// restricted thread that got the lookup to name a Full thread's process was
// Full. Now the lookup can only agree with a key; naming another thread
// closes the connection before any request runs.
for (const mode of MODES) {
  test(`${mode}: a thread's key whose process lookup names a Full thread can't act as it`, async () => {
    let from: string | undefined;
    const { h, server, token, url } = await serve({ callerOf: async () => peerOf(from) });
    const me = thread(h, mode);
    const full = thread(h, 'full', 'full one');
    try {
      from = full.id;
      const c = await as(url, token, me.id);
      await assert.rejects(c.call('threads.update', { threadId: me.id, permissionMode: 'full' }));
      assert.equal(h.runner.get(me.id).permissionMode, mode, 'still restricted');
      c.close();
      // The lookup agreeing, or not finding a thread, leaves the key's thread.
      for (const f of [me.id, undefined]) {
        from = f;
        const ok = await as(url, token, me.id);
        assert.equal((await ok.call<{ threadId: string }>('auth.whoami')).threadId, me.id);
        await assert.rejects(ok.call('threads.update', { threadId: me.id, permissionMode: 'full' }), refused);
        ok.close();
      }
    } finally {
      await server.close();
    }
  });
}

test("a lookup that can't say which thread holds the socket closes it, the owner token's too", async () => {
  const { AmbiguousPeer } = await import('../../src/peer.ts');
  const { h, server, token, url } = await serve({ callerOf: async () => { throw new AmbiguousPeer('two threads'); } });
  const me = thread(h, 'auto');
  try {
    const owner = await RunnerClient.connect(url, token);
    await assert.rejects(owner.call('threads.update', { threadId: me.id, permissionMode: 'full' }));
    owner.close();
    const c = await as(url, token, me.id);
    await assert.rejects(c.call('auth.whoami'));
    c.close();
    assert.equal(h.runner.get(me.id).permissionMode, 'auto');
  } finally {
    await server.close();
  }
});

// Daybreak finding 175: on a Mac or Linux a lookup that failed, ran out of
// time or found nobody let the owner token decide, and an undefined caller
// passed the gate as the owner. A thread that wiped its key and read the
// token through tb was then the owner whenever lsof or ps faltered.
test("the owner token's connection closes when its process lookup can't say who it is, before any request runs", async () => {
  const { threadOfSocket, UnresolvedPeer } = await import('../../src/peer.ts');
  const table = async () => [{ pid: 500, ppid: 1 }];
  const enoent = Object.assign(new Error('spawn /usr/sbin/lsof ENOENT'), { code: 'ENOENT' });
  const exit2 = Object.assign(new Error('Command failed: lsof'), { code: 2 });
  const faults: [string, Partial<Parameters<typeof threadOfSocket>[1]>][] = [
    ['lsof missing', { lsof: async () => { throw enoent; } }],
    ['lsof failing', { lsof: async () => { throw exit2; } }],
    ['lsof too slow', { lsof: () => new Promise(() => {}) }],
    ['nobody holds it', { lsof: async () => [] }],
    ['ps failing', { lsof: async () => [500], table: async () => { throw new Error('ps: exit 1'); } }],
    ['ps too slow', { lsof: async () => [500], table: () => new Promise(() => {}) }],
    ['holder not in the table', { lsof: async () => [501] }],
  ];
  for (const platform of ['darwin', 'linux'] as const) {
    for (const [what, fault] of faults) {
      const deps = { registry: { threadOfPid: () => undefined }, known: () => true, log: nullLogger, table, lookupMs: 50, platform, ...fault };
      const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
      await assert.rejects(threadOfSocket(sock, deps), (e) => e instanceof UnresolvedPeer, `${platform}, ${what}`);
    }
  }
  // Through a real server: every request waits for the lookup, which closes it.
  for (const [what, fault] of faults) {
    const { h, server, token, url } = await serve({ callerOf: (sock) => threadOfSocket(sock, { registry: { threadOfPid: () => undefined }, known: () => true, log: nullLogger, table, lookupMs: 50, ...fault }) });
    const me = thread(h, 'auto');
    try {
      const c = await RunnerClient.connect(url, token);
      const calls = [
        c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' }),
        c.call('threads.update', { threadId: me.id, permissionMode: 'full' }),
        c.call('patches.trust', { threadId: me.id }),
        c.call('actions.run', { threadId: me.id, actionId: 'x' }),
        c.call('accounts.yearToken', { accountId: 'claude-3' }),
        c.call('github.prAct', { url: 'https://github.com/a/b/pull/1', action: 'merge' }),
        c.call('auth.whoami'),
      ];
      for (const call of calls) await assert.rejects(call, what);
      c.close();
      assert.equal(h.runner.list(['inbox']).length, 1, `${what}: nothing made`);
      assert.equal(h.runner.get(me.id).permissionMode, 'auto', `${what}: not raised`);
      // A key-wiped tb new --full, as an agent would try it.
      const r = await tb(h, url, '', '', ['new', '--full', '--account', 'claude-3', 'sneaky']);
      assert.notEqual(r.code, 0, r.out);
      assert.equal(h.runner.list(['inbox']).length, 1, `${what}: tb made nothing`);
    } finally {
      await server.close();
    }
  }
});

test("an lsof that fails partway counts as no answer, whatever it printed", async () => {
  const { lsofAnswer } = await import('../../src/peer.ts');
  const want = '127.0.0.1:1234->127.0.0.1:8797';
  const partial = ['p500', 'f3', `n${want}`, ''].join('\n');
  assert.deepEqual(lsofAnswer(null, partial, want), [500]);
  assert.deepEqual(lsofAnswer(Object.assign(new Error('exit 1'), { code: 1 }), '', want), [], 'exit 1: nothing matched');
  for (const err of [Object.assign(new Error('exit 2'), { code: 2 }), Object.assign(new Error('killed'), { code: null, killed: true, signal: 'SIGTERM' })]) {
    assert.throws(() => lsofAnswer(err, partial, want));
  }
});

// Gemini's review of the fix for finding 175: a walk that stopped at a
// parent the table didn't have ended as "under no thread".
test('a parent missing from the process table is no answer, not the owner (except on Windows, which keeps dead parents\' ids)', async () => {
  const { threadOfSocket, UnresolvedPeer } = await import('../../src/peer.ts');
  const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
  const table = async () => [{ pid: 500, ppid: 450 }, { pid: 400, ppid: 300 }, { pid: 300, ppid: 1 }];
  const deps = { registry: { threadOfPid: (p: number) => (p === 300 ? 'th1' : undefined) }, known: () => true, log: nullLogger, lsof: async () => [500], table };
  for (const platform of ['darwin', 'linux'] as const) await assert.rejects(threadOfSocket(sock, { ...deps, platform }), (e) => e instanceof UnresolvedPeer, platform);
  assert.deepEqual(await threadOfSocket(sock, { ...deps, platform: 'win32' }), { kind: 'owner' });
});

test('while its process lookup runs, a connection hears no broadcasts', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let lookups = 0;
  // The first connection's lookup waits; the second's doesn't.
  const { h, server, token, url } = await serve({ callerOf: async () => { if (lookups++ === 0) await held; return peerOf(undefined); } });
  try {
    const c = await RunnerClient.connect(url, token);
    const heard: string[] = [];
    c.onNotification((m) => heard.push(m));
    const d = await RunnerClient.connect(url, token);
    await d.call('auth.whoami');
    const placed: string[] = [];
    d.onNotification((m) => placed.push(m));
    const t = thread(h, 'auto', 'a thread');
    const note = () => server.notifyClients({ method: 'thread.updated', params: { thread: h.runner.list(['inbox']).find((x) => x.id === t.id)! } });
    note();
    await patiently(() => placed.length > 0);
    release();
    // Anything sent to c before its lookup ended arrives before this answer.
    await c.call('auth.whoami');
    assert.deepEqual(heard, [], 'nothing while it waited');
    note();
    await patiently(() => heard.length > 0);
    assert.deepEqual(heard, ['thread.updated']);
    c.close();
    d.close();
  } finally {
    await server.close();
  }
});

test('on Linux the process table comes from /proc, with no ps', async (t) => {
  if (process.platform === 'win32') return t.skip('a stand-in /proc tree');
  const { procTable } = await import('../../src/peer.ts');
  const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-proc-'));
  try {
    const stat = (pid: number, comm: string, ppid: number, pgrp: number) => {
      fs.mkdirSync(path.join(root, String(pid)), { recursive: true });
      fs.writeFileSync(path.join(root, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} ${pgrp} ${pgrp} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0\n`);
    };
    stat(300, 'claude', 1, 300);
    stat(400, 'a) b (c', 300, 400); // brackets and spaces in the name
    fs.mkdirSync(path.join(root, 'self'));
    const rows = (await procTable(root)).sort((a, b) => a.pid - b.pid);
    assert.deepEqual(rows, [{ pid: 300, ppid: 1, pgid: 300, sid: 300 }, { pid: 400, ppid: 300, pgid: 400, sid: 400 }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tb runner's default data dir comes from the account, not variables the caller sets (Codex's third review)", async () => {
  const { realDefaultHome } = await import('../../src/tb-connect.ts');
  // Windows only: a Mac's or Linux's would be the real folder, which a unit test mustn't touch.
  const saved = process.env.LOCALAPPDATA;
  const before = realDefaultHome('win32');
  try {
    process.env.LOCALAPPDATA = 'C:\\attacker';
    assert.equal(realDefaultHome('win32'), before);
    assert.ok(!before.includes('attacker') && before.endsWith('Threadbear'), before);
  } finally {
    if (saved === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = saved;
  }
});

test('on Linux a process in a group the registry has not seen is still its CLI\'s, by session (Codex\'s third review)', async () => {
  const { threadOfSocket } = await import('../../src/peer.ts');
  const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
  // Orphaned (parent 1), its own new group, still in the CLI's (300's) session.
  const table = async () => [{ pid: 500, ppid: 1, pgid: 500, sid: 300 }, { pid: 300, ppid: 1, pgid: 300, sid: 300 }];
  const deps = { registry: { threadOfPid: (p: number) => (p === 300 ? 'th1' : undefined), threadOfGroup: () => undefined }, known: () => true, log: nullLogger, lsof: async () => [500], table, platform: 'linux' as const };
  assert.deepEqual(await threadOfSocket(sock, deps), { kind: 'thread', threadId: 'th1' });
  // A terminal's session leader isn't a CLI: the owner.
  assert.deepEqual(await threadOfSocket(sock, { ...deps, registry: { threadOfPid: () => undefined, threadOfGroup: () => undefined } }), { kind: 'owner' });
  // Its CLI killed after it left (Codex's fourth review): the session's leader is gone, so no answer.
  const { UnresolvedPeer } = await import('../../src/peer.ts');
  await assert.rejects(threadOfSocket(sock, { ...deps, registry: { threadOfPid: () => undefined, threadOfGroup: () => undefined }, table: async () => [{ pid: 500, ppid: 1, pgid: 500, sid: 300 }] }), (e) => e instanceof UnresolvedPeer);
});

test('a thread key whose lookup fails closes too, and a lookup that finds the client still works both ways', async () => {
  let fail = true;
  let from: string | undefined;
  const { UnresolvedPeer } = await import('../../src/peer.ts');
  const { h, server, token, url } = await serve({ callerOf: async () => { if (fail) throw new UnresolvedPeer('lsof timed out'); return peerOf(from); } });
  const me = thread(h, 'auto');
  try {
    const keyed = await as(url, token, me.id);
    await assert.rejects(keyed.call('auth.whoami'));
    keyed.close();
    fail = false;
    // Found under no thread: the owner, as a terminal or the app is.
    const owner = await RunnerClient.connect(url, token);
    assert.deepEqual(await owner.call('auth.whoami'), {});
    owner.close();
    // Found under a limited thread: that thread.
    from = me.id;
    const lowered = await RunnerClient.connect(url, token);
    assert.equal((await lowered.call<{ threadId: string; limited: boolean }>('auth.whoami')).limited, true);
    lowered.close();
  } finally {
    await server.close();
  }
});

test('on Linux the lookup reads /proc: the socket on exactly this connection, and the processes holding it', async (t) => {
  if (process.platform === 'win32') return t.skip('symlinks for the stand-in /proc');
  const { procPids, threadOfSocket } = await import('../../src/peer.ts');
  const os = await import('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-proc-'));
  try {
    const le = os.endianness() === 'LE';
    // 127.0.0.1 as the kernel prints it on this machine.
    const lo = le ? '0100007F' : '7F000001';
    const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
    const row = (n: number, l: string, r: string, st: string, inode: number) => `   ${n}: ${l} ${r} ${st} 00000000:00000000 00:00000000 00000000   501        0 ${inode} 1 0000000000000000 20 4 30 10 -1\n`;
    fs.mkdirSync(path.join(root, 'net'));
    fs.writeFileSync(path.join(root, 'net', 'tcp'), head +
      row(0, `${lo}:225D`, `00000000:0000`, '0A', 100) + // the runner listening on 8797
      row(1, `${lo}:04D2`, `${lo}:225D`, '01', 200) + // the client's end: 1234 -> 8797
      row(2, `${lo}:225D`, `${lo}:04D2`, '01', 201) + // the runner's end
      row(3, `${lo}:04D2`, `${lo}:1538`, '01', 300)); // a socket that shares the port number, to 5432
    const proc = (pid: number, inodes: number[]) => {
      fs.mkdirSync(path.join(root, String(pid), 'fd'), { recursive: true });
      inodes.forEach((i, n) => fs.symlinkSync(`socket:[${i}]`, path.join(root, String(pid), 'fd', String(n + 3))));
    };
    proc(4242, [200]);
    proc(4243, [300]);
    proc(4244, [201]);
    fs.mkdirSync(path.join(root, 'self'));
    const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
    assert.deepEqual(await procPids(sock, root), [4242]);
    assert.deepEqual(await procPids({ ...sock, remoteAddress: '::ffff:127.0.0.1', localAddress: '::ffff:127.0.0.1' }, root), [4242], 'dual-stack names');
    assert.deepEqual(await procPids({ ...sock, remotePort: 9999 }, root), []);
    const deps = { registry: { threadOfPid: (p: number) => (p === 4242 ? 'th1' : undefined) }, known: () => true, log: nullLogger, platform: 'linux' as const, procRoot: root, table: async () => [{ pid: 4242, ppid: 1 }, { pid: 4243, ppid: 1 }] };
    assert.deepEqual(await threadOfSocket(sock, deps), { kind: 'thread', threadId: 'th1' });
    // No /proc/net/tcp to read: no answer, not the owner.
    fs.rmSync(path.join(root, 'net'), { recursive: true });
    await assert.rejects(threadOfSocket(sock, deps), /could not tell/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Daybreak finding 138: deleting a schedule went straight through the gate.
for (const mode of MODES) {
  test(`${mode}: schedules.delete with a thread's key can't delete a Full schedule or one with a check`, async () => {
    const { h, server, token, url, scheduler } = await serve();
    const me = thread(h, mode);
    const full = thread(h, 'full', 'full one');
    const fullSc = await scheduler.create({ text: 'Tidy', cron: '0 9 * * *', title: 'Full one', cwd: h.home, accountId: 'claude-3', permissionMode: 'full' });
    const toFull = await scheduler.create({ text: 'Ping', cron: '0 9 * * *', title: 'To full', threadId: full.id });
    const checked = await scheduler.create({ text: 'Watch', cron: '0 * * * *', title: 'Checked', cwd: h.home, accountId: 'claude-3', permissionMode: mode, check: 'true' });
    const mine = await scheduler.create({ text: 'Later', cron: '0 9 * * *', title: 'Mine', threadId: me.id, createdBy: me.id });
    const c = await as(url, token, me.id);
    try {
      for (const sc of [fullSc, toFull, checked]) {
        await assert.rejects(c.call('schedules.delete', { scheduleId: sc.id }), (e: { code?: number; message?: string }) => refused(e) && /delete_schedule/.test(e.message ?? ''));
        assert.ok(scheduler.find(sc.id), `${sc.title} still there`);
      }
      // By a prefix too: what's compared is what's deleted.
      await assert.rejects(c.call('schedules.delete', { scheduleId: fullSc.id.slice(0, 8) }), refused);
      // Unknown here: refused, not passed on.
      await assert.rejects(c.call('schedules.delete', { scheduleId: 'nope-not-a-schedule' }), refused);
      // Nor by first lowering it or taking its check off (verify-fix of 138).
      await assert.rejects(c.call('schedules.update', { scheduleId: fullSc.id, permissionMode: mode }), refused);
      assert.equal(scheduler.find(fullSc.id).permissionMode, 'full');
      for (const off of [null, '']) {
        await assert.rejects(c.call('schedules.update', { scheduleId: checked.id, check: off }), refused);
        assert.equal(scheduler.find(checked.id).check, 'true');
      }
      await assert.rejects(c.call('schedules.delete', { scheduleId: checked.id }), refused);
      // Nor by moving it to a login, pool, model, effort or zone it doesn't
      // run on: a login another runner lacks stops it quietly (OpenCode's
      // review of the 138 fix).
      for (const sc of [fullSc, checked]) {
        for (const change of [{ model: 'haiku' }, { provider: 'codex' }, { effort: 'low' }, { timezone: 'Pacific/Kiritimati' }, { poolId: 'nope' }, { accountId: 'nonexistent-login' }]) {
          await assert.rejects(c.call('schedules.update', { scheduleId: sc.id, ...change }), refused, `${sc.title}: ${JSON.stringify(change)}`);
        }
        assert.equal(scheduler.find(sc.id).accountId, 'claude-3');
      }
      // Nor by lowering the Full thread a schedule sends to, so it no
      // longer looks above this one (OpenCode's review of the 138 fix).
      await assert.rejects(c.call('threads.update', { threadId: full.id, permissionMode: mode }), refused);
      assert.equal(h.runner.get(full.id).permissionMode, 'full');
      await assert.rejects(c.call('schedules.delete', { scheduleId: toFull.id }), refused);
      // Pausing one is still free.
      await c.call('schedules.update', { scheduleId: fullSc.id, paused: true });
      // One no higher than this thread, with no check, it may delete.
      await c.call('schedules.delete', { scheduleId: mine.id });
      assert.throws(() => scheduler.find(mine.id));
      // The owner still can.
      const owner = await RunnerClient.connect(url, token);
      await owner.call('schedules.delete', { scheduleId: fullSc.id });
      assert.throws(() => scheduler.find(fullSc.id));
      owner.close();
    } finally {
      c.close();
      await server.close();
    }
  });
}

test('a request frame sent before the process lookup finishes waits for it', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let from: string | undefined;
  const { h, server, token, url } = await serve({ callerOf: async () => { await held; return peerOf(from); } });
  const me = thread(h, 'auto');
  from = me.id;
  try {
    const c = await RunnerClient.connect(url, token);
    const pending = c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' });
    release();
    await assert.rejects(pending, refused);
    c.close();
  } finally {
    await server.close();
  }
});

// A connection closed straight after auth: its close code, whether or not the
// proof got there first.
const turnedAway = (p: Promise<RunnerClient>) =>
  p.then((c) => closedWithin(c), (e: Error) => Number(/\((\d+)\)/.exec(e.message)?.[1] ?? NaN));

// Until the server has seen every client close.
const patientlyClosed = (server: RpcServer) => patiently(() => (server as unknown as { conns: Set<unknown> }).conns.size === 0);

// The close code, or 'open' if it's still open after a few seconds.
const closedWithin = (c: RunnerClient, ms = 3000) =>
  Promise.race([c.waitClosed().then((i) => i.code), new Promise<string>((r) => setTimeout(() => r('open'), ms).unref())]);

// Daybreak finding 158: a thread's key used to raise the frame limit to 64 MiB
// before the process lookup had finished, and up to 256 whole frames could
// wait for it: about 16 GiB parked in the runner per connection.
test('while the process lookup runs, frames stay small and the queue has a byte budget', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let from: string | undefined;
  const { h, server, token, url } = await serve({ callerOf: async () => { await held; return peerOf(from); } });
  const me = thread(h, 'auto');
  from = me.id;
  try {
    // One frame over the pre-auth limit closes it with 1009.
    const big = await as(url, token, me.id);
    void big.call('threads.list', { pad: 'x'.repeat(100 * 1024) }).catch(() => {});
    assert.equal(await closedWithin(big), 1009);
    // Frames under it, but more than the budget in all, close it with 4408.
    const many = await as(url, token, me.id);
    for (let i = 0; i < 40; i++) void many.call('threads.list', { pad: 'x'.repeat(60 * 1024) }).catch(() => {});
    assert.equal(await closedWithin(many), 4408);
    // Once the lookup is done, a big frame is answered.
    const ok = await as(url, token, me.id);
    const first = ok.call('auth.whoami');
    release();
    await first;
    await ok.call('auth.whoami', { pad: 'y'.repeat(2 * 1024 * 1024) });
    assert.equal(ok.closeInfo, undefined);
    ok.close();
  } finally {
    release();
    await server.close();
  }
});

test('lookups still running are capped per thread key, even after their clients have gone, and never keep the owner out', async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let from: string | undefined;
  const { h, server, token, url } = await serve({ maxPendingAuth: 2, callerOf: async () => { await held; return peerOf(from); } });
  const me = thread(h, 'auto');
  const other = thread(h, 'auto', 'other');
  const open: RunnerClient[] = [];
  try {
    for (let i = 0; i < 4; i++) open.push(await as(url, token, me.id));
    // A fifth from the same thread is closed at once.
    assert.equal(await turnedAway(as(url, token, me.id)), 4429);
    // Leaving doesn't free one while its lookup still runs.
    for (const c of open.splice(0)) c.close();
    await patientlyClosed(server);
    assert.equal(await turnedAway(as(url, token, me.id)), 4429, 'lookups still running count after their clients have gone');
    // Another thread, and the owner, still get in.
    const theirs = await as(url, token, other.id);
    open.push(theirs);
    const owner = await RunnerClient.connect(url, token);
    open.push(owner);
    // The owner's own lookups take the waiting slots, a bearer client's too.
    const owner2 = await RunnerClient.connect(url, token);
    open.push(owner2);
    const bearer = await RunnerClient.connect(url, token, { legacyHeader: true }).catch(() => undefined);
    bearer?.close();
    assert.equal(bearer, undefined, 'a bearer client waits its turn behind two owner lookups');
    release();
    await Promise.all(open.map((c) => c.call('auth.whoami')));
    await patiently(() => (server as unknown as { ownerLookups: number; threadLookups: Map<string, number> }).threadLookups.size === 0);
    const after = await as(url, token, me.id);
    open.push(after);
    await after.call('auth.whoami');
  } finally {
    release();
    for (const c of open) c.close();
    await server.close();
  }
});

test('reading the runner token file: Claude tools are denied it outside Full access', async () => {
  const { denySecrets } = await import('../../src/secrets-guard.ts');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tb-keys-')));
  fs.mkdirSync(path.join(home, 'secrets'));
  fs.writeFileSync(path.join(home, 'secrets', 'runner-token'), 'x');
  fs.symlinkSync(path.join(home, 'secrets'), path.join(home, 'alias'));
  const deny = (tool: string, input: Record<string, unknown>) => denySecrets(tool, input, home);
  try {
    assert.ok(deny('Read', { file_path: path.join(home, 'secrets', 'runner-token') }));
    assert.ok(deny('Read', { file_path: path.join(home, 'alias', 'runner-token') }), 'through a link');
    assert.ok(deny('Grep', { path: path.join(home, 'secrets'), pattern: 'x' }));
    assert.ok(deny('Glob', { path: home, pattern: 'secrets/*' }));
    assert.ok(deny('Edit', { file_path: path.join(home, 'secrets', 'runner-token') }));
    assert.ok(deny('Bash', { command: `cat ${path.join(home, 'secrets', 'runner-token')}` }));
    assert.ok(deny('Bash', { command: 'cat "$THREADBEAR_HOME/secrets/runner-token"' }));
    assert.ok(deny('Bash', { command: 'cat ~/Library/Application\\ Support/Threadbear/secrets/runner-token' }));
    assert.ok(deny('Bash', { command: 'cat runner-token' }));
    assert.equal(deny('Read', { file_path: path.join(home, 'threads', 'a.txt') }), undefined);
    assert.equal(deny('Bash', { command: 'ls secrets' }), undefined, "someone else's secrets folder isn't this");
    assert.equal(deny('Bash', { command: 'tb status' }), undefined);
    assert.ok(deny('Bash', { command: 'cat "$THREADBEAR_HOME"/secr*/*token*' }), 'a wildcard after the data dir');
    assert.ok(deny('Grep', { path: home, pattern: '^[a-z]{40}$' }), 'from the data dir, whatever the pattern');
    // From higher up, a Grep reads every file under it whatever its pattern
    // says (cross-lab review of #54, 11 Nov 2026); one beside it is fine.
    assert.ok(deny('Grep', { path: path.dirname(home), pattern: 'hello' }), 'from higher up, whatever the pattern');
    const beside = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tb-beside-')));
    try {
      assert.equal(deny('Grep', { path: beside, pattern: 'hello' }), undefined, 'a folder beside it');
    } finally {
      fs.rmSync(beside, { recursive: true, force: true });
    }
    assert.ok(denySecrets('Read', { file_path: 'runner-token' }, home, path.join(home, 'secrets')), 'a relative path, against the call\'s cwd');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the process lookup walks parents to a CLI, and only a real thread counts', async () => {
  const { threadOfSocket, AmbiguousPeer, UnresolvedPeer } = await import('../../src/peer.ts');
  const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
  const threadOfPort = (_port: number, deps: Parameters<typeof threadOfSocket>[1]) => threadOfSocket(sock, deps);
  const table = async () => [
    { pid: 500, ppid: 400 }, // tb
    { pid: 400, ppid: 300 }, // zsh
    { pid: 300, ppid: 1 }, // the CLI
    { pid: 700, ppid: 1 }, // tb in a terminal
  ];
  const registry = { threadOfPid: (p: number) => (p === 300 ? 'th1' : p === 700 ? 'models:acct' : undefined) };
  const look = async (pids: number[], known: (id: string) => boolean = (id) => id === 'th1') => who(await threadOfPort(1234, { registry, known, log: nullLogger, lsof: async () => pids, table }));
  assert.equal(await look([process.pid, 500]), 'th1', 'skips the runner itself');
  assert.equal(await look([500], () => false), 'owner', 'not a thread this runner has');
  assert.equal(await look([700]), 'owner', "a job's label isn't a thread");
  assert.equal(await look([process.pid]), 'owner', 'the runner itself');
  // Nobody holding a socket the runner has open is the lookup missing it (finding 175).
  await assert.rejects(look([]), (e) => e instanceof UnresolvedPeer);
  const orphan = { pid: 900, ppid: 1, pgid: 77 };
  const grouped = await threadOfPort(1234, { registry: { ...registry, threadOfGroup: (g: number) => (g === 77 ? 'th1' : undefined) }, known: (id) => id === 'th1', log: nullLogger, lsof: async () => [900], table: async () => [orphan] });
  assert.equal(who(grouped), 'th1', 'lost its parents, still in the tool command\'s group');
  // An orphaned helper still in that group, which started it in a group of its own (Gemini's review of finding 177).
  const viaHelper = await threadOfPort(1234, { registry: { ...registry, threadOfGroup: (g: number) => (g === 77 ? 'th1' : undefined) }, known: (id) => id === 'th1', log: nullLogger, lsof: async () => [901], table: async () => [{ pid: 901, ppid: 900, pgid: 901 }, orphan] });
  assert.equal(who(viaHelper), 'th1', "its parent's group");
  await assert.rejects(threadOfPort(1234, { registry, known: () => true, log: nullLogger, lsof: async () => { throw new Error('no lsof'); }, table }), (e) => e instanceof UnresolvedPeer, 'a failed lookup is no answer, never the owner');
  // A socket held by processes under two threads (handed to a child): no guessing.
  const two = { threadOfPid: (p: number) => (p === 300 ? 'th1' : p === 800 ? 'th2' : undefined) };
  const both = async () => [...(await table()), { pid: 800, ppid: 1 }];
  await assert.rejects(threadOfSocket(sock, { registry: two, known: () => true, log: nullLogger, lsof: async () => [500, 800], table: both }), (e) => e instanceof AmbiguousPeer);
  // Two holders under the same thread (a fork) are that thread.
  assert.equal(who(await threadOfSocket(sock, { registry: two, known: () => true, log: nullLogger, lsof: async () => [500, 400], table: both })), 'th1');
});

test("lsof's answer counts only the process holding the client's end of exactly this connection", async () => {
  const { socketOwners } = await import('../../src/peer.ts');
  // A Full thread's process (100) talking to something on port 5432, a
  // restricted one's (200) on 127.0.0.2:5432 and the attacker's real
  // connection (300) from 127.0.0.1:5432; and the runner's own end (1).
  const out = [
    'p100', 'f10', 'n127.0.0.1:61000->127.0.0.1:5432',
    'p200', 'f11', 'n127.0.0.2:5432->127.0.0.1:8797',
    'p300', 'f12', 'n127.0.0.1:5432->127.0.0.1:8797', 'f13', 'n127.0.0.1:5432->127.0.0.1:8797',
    'p1', 'f14', 'n127.0.0.1:8797->127.0.0.1:5432',
    '',
  ].join('\n');
  assert.deepEqual(socketOwners(out, '127.0.0.1:5432->127.0.0.1:8797'), [300]);
  assert.deepEqual(socketOwners(out, '127.0.0.2:5432->127.0.0.1:8797'), [200]);
  assert.deepEqual(socketOwners(out, '127.0.0.1:9999->127.0.0.1:8797'), []);
});

test('the process lookup finds a real connection through lsof and ps', async () => {
  const { threadOfSocket } = await import('../../src/peer.ts');
  const net = await import('node:net');
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  const child = spawn(process.execPath, ['-e', `require('net').connect(${addr.port},'127.0.0.1');setTimeout(()=>{},600000)`], { stdio: 'ignore' });
  const peer = new Promise<import('node:net').Socket>((r) => server.once('connection', r));
  try {
    const s = await peer;
    const sock = { remoteAddress: s.remoteAddress!, remotePort: s.remotePort!, localAddress: s.localAddress!, localPort: s.localPort! };
    const registry = { threadOfPid: (p: number) => (p === child.pid ? 'th9' : undefined) };
    // The runner's 3 s limit is for live connections; on a loaded Mac lsof
    // alone took longer, so this real lookup gets the suite's patience.
    const lookupMs = PATIENCE_MS;
    assert.equal(who(await threadOfSocket(sock, { registry, known: () => true, log: nullLogger, lookupMs })), 'th9');
    // Under another process: its parent (this test) is the CLI.
    const up = { threadOfPid: (p: number) => (p === process.pid ? 'th8' : undefined) };
    assert.equal(who(await threadOfSocket(sock, { registry: up, known: () => true, log: nullLogger, lookupMs })), 'th8');
    // Under none: the owner, found, not assumed. Under no thread key but
    // the ones this test runs under (a thread's, when it runs in one), as a
    // runner started here would be (finding 177).
    const { ownThreadMarks } = await import('../../src/peer.ts');
    const own = await ownThreadMarks();
    assert.equal(who(await threadOfSocket(sock, { registry: { threadOfPid: () => undefined }, known: () => true, log: nullLogger, lookupMs, own })), 'owner');
    // Started under a thread key this runner wasn't: another runner's thread.
    const { ForeignPeer } = await import('../../src/peer.ts');
    const accepted = new Promise<import('node:net').Socket>((r) => server.once('connection', r));
    const stranger = spawn(process.execPath, ['-e', `require('net').connect(${addr.port},'127.0.0.1');setTimeout(()=>{},600000)`], { stdio: 'ignore', env: { ...process.env, THREADBEAR_THREAD_KEY: 'c'.repeat(64) } });
    try {
      const s2 = await accepted;
      const sock2 = { remoteAddress: s2.remoteAddress!, remotePort: s2.remotePort!, localAddress: s2.localAddress!, localPort: s2.localPort! };
      await assert.rejects(threadOfSocket(sock2, { registry: { threadOfPid: () => undefined }, known: () => true, log: nullLogger, lookupMs, own }), (e) => e instanceof ForeignPeer);
    } finally {
      stranger.kill();
    }
  } finally {
    child.kill();
    server.close();
  }
});

// Daybreak finding 137, for real: a Full thread's process talks to
// something on port P, and a restricted one connects to the runner from
// source port P. `lsof -iTCP:P` lists both; only the exact connection may count.
test('the process lookup names the process on this exact connection, not another sharing its port number', async (t) => {
  const { threadOfSocket } = await import('../../src/peer.ts');
  const net = await import('node:net');
  const listen = (srv: import('node:net').Server, host: string) => new Promise<void>((r, j) => { srv.once('error', j); srv.listen(0, host, () => r()); });
  // Something the Full thread's process talks to, on ::1 so its port can
  // also be bound on 127.0.0.1 (Linux could use 127.0.0.2; a Mac has only 127.0.0.1).
  const elsewhere = net.createServer();
  try {
    await listen(elsewhere, '::1');
  } catch {
    return t.skip('no IPv6 loopback here');
  }
  const P = (elsewhere.address() as { port: number }).port;
  const runner = net.createServer();
  await listen(runner, '127.0.0.1');
  const R = (runner.address() as { port: number }).port;
  const full = spawn(process.execPath, ['-e', `require('net').connect(${P},'::1');setTimeout(()=>{},600000)`], { stdio: 'ignore' });
  let restricted: ReturnType<typeof spawn> | undefined;
  try {
    await new Promise((r) => elsewhere.once('connection', r));
    const accepted = new Promise<import('node:net').Socket>((r) => runner.once('connection', r));
    restricted = spawn(process.execPath, ['-e', `require('net').connect({port:${R},host:'127.0.0.1',localAddress:'127.0.0.1',localPort:${P}}).on('error',()=>process.exit(3));setTimeout(()=>{},600000)`], { stdio: 'ignore' });
    const s = await accepted;
    assert.equal(s.remotePort, P, 'the restricted client really shares the port number');
    const sock = { remoteAddress: s.remoteAddress!, remotePort: s.remotePort!, localAddress: s.localAddress!, localPort: s.localPort! };
    const registry = { threadOfPid: (p: number) => (p === full.pid ? 'full-thread' : p === restricted!.pid ? 'ask-thread' : undefined) };
    assert.equal(who(await threadOfSocket(sock, { registry, known: () => true, log: nullLogger, lookupMs: PATIENCE_MS })), 'ask-thread');
  } finally {
    full.kill();
    restricted?.kill();
    runner.close();
    elsewhere.close();
  }
});

test('the registry names a thread only for a live CLI, and sees a draining runner\'s', async () => {
  const { ProcessRegistry } = await import('../../src/proc.ts');
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tb-reg-'));
  try {
    const r = new ProcessRegistry(dir, nullLogger);
    r.add(process.pid, 'test', 'th1');
    assert.equal(await r.threadOfPid(process.pid), 'th1');
    r.remove(process.pid);
    assert.equal(await r.threadOfPid(process.pid), undefined);
    // A draining runner's list is on disk beside this one's.
    const { processInfo } = await import('../../src/proc.ts');
    const lstart = processInfo(process.pid)!.lstart;
    fs.writeFileSync(path.join(dir, 'children-99.json'), JSON.stringify([{ pid: process.pid, command: 'x', startedAt: 'x', lstart, threadId: 'th2' }]));
    assert.equal(await r.threadOfPid(process.pid), 'th2');
    fs.writeFileSync(path.join(dir, 'children-99.json'), JSON.stringify([{ pid: process.pid, command: 'x', startedAt: 'x', lstart: 'some other start', threadId: 'th2' }]));
    assert.equal(await r.threadOfPid(process.pid), undefined, 'a recycled pid');
    // A draining runner's CLI whose start can't be read: no answer, not "not that thread" (finding 175 reviews).
    const { StaleProcess } = await import('../../src/proc.ts');
    fs.writeFileSync(path.join(dir, 'children-99.json'), JSON.stringify([{ pid: 2 ** 22 + 17, command: 'x', startedAt: 'x', lstart, threadId: 'th2' }]));
    await assert.rejects(r.threadOfPid(2 ** 22 + 17), (e) => e instanceof StaleProcess);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tb goes by its key only for its own runner, never the token next to it', async () => {
  const { tbCredential } = await import('../../src/tb-connect.ts');
  const h = makeHarness();
  const token = readToken(h.home);
  const key = threadKey(token, 'th1');
  assert.deepEqual(tbCredential(h.home, { THREADBEAR_THREAD_KEY: key, THREADBEAR_THREAD_ID: 'th1', THREADBEAR_RUNNER_HOME: h.home }), { token: key, threadId: 'th1' });
  // tb pointed at a dev runner from a thread of the real one.
  assert.deepEqual(tbCredential(h.home, { THREADBEAR_THREAD_KEY: key, THREADBEAR_THREAD_ID: 'th1', THREADBEAR_RUNNER_HOME: '/elsewhere' }), { token });
  // Outside a thread, or a patch's action (no key).
  assert.deepEqual(tbCredential(h.home, {}), { token });
  assert.deepEqual(tbCredential(h.home, { THREADBEAR_THREAD_ID: 'th1', THREADBEAR_THREAD_KEY: '' }), { token });
});

test('tb runner refuses in a limited thread, whatever its environment says', async () => {
  let from: string | undefined;
  const { h, server, token, url, port } = await serve({ callerOf: async () => peerOf(from) });
  const me = thread(h, 'auto');
  // tb runner asks the runner at the port its runner.json names.
  writeRunnerJson(h.home, { ...readRunnerJson(h.home), port });
  try {
    const key = threadKey(token, me.id);
    const r = await tb(h, url, me.id, key, ['runner']);
    assert.equal(r.code, 1, r.out);
    // (Run from a real thread's shell, that thread's key is found first.)
    assert.match(r.out, /on auto|Full access|isn't pointed|couldn't tell|own data folder/);
    from = me.id;
    const wiped = await tb(h, url, '', '', ['runner']);
    assert.equal(wiped.code, 1, wiped.out);
    from = undefined;
    assert.match((await tb(h, url, '', '', ['status'])).out, /Runner/);
  } finally {
    await server.close();
  }
});

test('Always allow on tb saves the exact command, never a prefix', async () => {
  const { alwaysAllow, isTbPrefixRule, mentionsTb } = await import('../../src/adapters/claude/adapter.ts');
  const prefix = { type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'tb new:*' }], behavior: 'allow' as const, destination: 'session' as const };
  const a = alwaysAllow('Bash', [prefix], { command: 'tb new --ask hello' });
  assert.deepEqual(a.rules, ['Bash(tb new --ask hello)']);
  assert.equal(a.updates.length, 1);
  assert.deepEqual((a.updates[0] as { rules: unknown[] }).rules, [{ toolName: 'Bash', ruleContent: 'tb new --ask hello' }]);
  // A wildcard or newline can't be made exact: allowed this once.
  for (const command of ['tb new --ask x*', 'tb new --ask x\ntb new --full y']) {
    const r = alwaysAllow('Bash', [prefix], { command });
    assert.deepEqual(r, { updates: [], rules: [] });
  }
  // Other commands keep the CLI's suggestion.
  const other = { ...prefix, rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }] };
  assert.deepEqual(alwaysAllow('Bash', [other], { command: 'npm test' }).rules, ['Bash(npm test:*)']);
  // A Bash card with no suggestion never becomes all of Bash.
  assert.deepEqual(alwaysAllow('Bash', undefined, { command: 'rm x' }).rules, ['Bash(rm x)']);
  assert.deepEqual(alwaysAllow('Read', undefined).rules, ['Read']);
  for (const c of ['tb new x', '"tb" new', './bin/tb new', 'cd a && tb send b c', 'tb', '\\tb new', "t'b' new"]) assert.equal(mentionsTb(c), true, c);
  for (const c of ['grep tb x.txt -l', 'ntb new', 'tbx new']) assert.equal(mentionsTb(c) && !c.startsWith('grep'), false, c);
  assert.equal(isTbPrefixRule('Bash(tb new:*)'), true);
  assert.equal(isTbPrefixRule('Bash(tb new --ask x)'), false);
  assert.equal(isTbPrefixRule('Bash(*tb new*)'), true);
  assert.equal(isTbPrefixRule('Bash(npm test:*)'), false);
});

test("a thread's connection can't pass as the Mac app in hello", async () => {
  const { h, server, token, url } = await serve();
  const me = thread(h, 'auto');
  try {
    const c = await as(url, token, me.id);
    await c.call('hello', { client: 'threadbear-mac', browserPanel: true });
    assert.equal(server.appConnected(), false);
    c.close();
    const app = await RunnerClient.connect(url, token);
    await app.call('hello', { client: 'threadbear-mac' });
    assert.equal(server.appConnected(), true);
    app.close();
  } finally {
    await server.close();
  }
});

test('the GPUI app counts as the app being open', async () => {
  const { server, token, url } = await serve();
  try {
    const app = await RunnerClient.connect(url, token);
    await app.call('hello', { client: 'threadbear-desktop' });
    assert.equal(server.appConnected(), true);
    assert.equal(server.appConnected(true), false, 'an older GPUI app has no Browser pane');
    app.close();
    // One that says it has the Browser pane counts for BrowserBear's handoff.
    const browsing = await RunnerClient.connect(url, token);
    await browsing.call('hello', { client: 'threadbear-desktop', browserPanel: true });
    assert.equal(server.appConnected(true), true);
    browsing.close();
  } finally {
    await server.close();
  }
});

// Daybreak finding 174: tb runner's check read its parents' environments
// with whatever `ps` was on PATH, counted a failed read as "not a thread",
// and then took a runner it couldn't reach (THREADBEAR_URL at a dead port)
// as no objection. Now: three answers, fixed tools, the runner's own
// address, and a thread's key must be its runner's.
test("tb runner's check: can't tell is refused, a thread needs its own runner to say Full, a terminal is fine", async () => {
  const { ownerOnly, tbCaller } = await import('../../src/tb-connect.ts');
  let from: string | undefined;
  const { h, server, token, port } = await serve({ callerOf: async () => peerOf(from) });
  const limited = thread(h, 'auto');
  const full = thread(h, 'full', 'full one');
  // THREADBEAR_PORT (cfg.port) is the caller's to set: the runner is asked
  // at the port in its runner.json.
  const cfg = { home: h.home, host: '127.0.0.1', port: 1 } as Parameters<typeof ownerOnly>[0];
  const setPort = (p: number) => writeRunnerJson(h.home, { ...readRunnerJson(h.home), port: p });
  setPort(port);
  // The runner stopped: nothing listening on its port.
  const down = async <T,>(f: () => Promise<T>) => {
    setPort(1);
    try {
      return await f();
    } finally {
      setPort(port);
    }
  };
  // tb (500), its parent (a shell, 400) and above it the thread's CLI (300).
  // The harness's data dir stands in for the default one.
  const table = async () => [{ pid: 500, ppid: 400, pgid: 500 }, { pid: 400, ppid: 300, pgid: 400 }, { pid: 300, ppid: 1, pgid: 300 }];
  const cliOf = (id: string, key = threadKey(token, id)) => (p: number) => (p === 300 ? `node claude THREADBEAR_THREAD_ID=${id} THREADBEAR_THREAD_KEY=${key} X=1` : 'zsh THREADBEAR_THREAD_KEY= X=1');
  const base = { table, self: 500, ppid: 400, platform: 'darwin' as const, defaultHome: h.home };
  const under = (id: string, key?: string) => ({ ...base, envOf: cliOf(id, key) });
  const terminal = { ...base, envOf: () => 'zsh HOME=/Users/x' };
  const wiped = { THREADBEAR_THREAD_KEY: '', THREADBEAR_THREAD_ID: '', THREADBEAR_URL: 'ws://127.0.0.1:1/rpc' };
  try {
    // Can't tell: the process table, a parent's environment, a parent missing.
    for (const deps of [
      { ...terminal, table: async () => { throw new Error('ps: not found'); } },
      { ...terminal, envOf: () => { throw new Error('ps exited 1'); } },
      { ...terminal, envOf: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } },
      { ...terminal, table: async () => [] },
      { platform: 'win32' as const, defaultHome: h.home },
    ]) {
      assert.equal((await tbCaller(wiped, deps)).kind, 'unresolved');
      // The runner can't be asked: refused.
      assert.match((await down(() => ownerOnly(cfg, wiped, deps))) ?? '', /couldn't tell/);
      // The runner places it under a limited thread: refused.
      from = limited.id;
      assert.match((await ownerOnly(cfg, wiped, deps)) ?? '', /on auto/);
      // The runner places it under none (a Windows terminal, say): fine.
      from = undefined;
      assert.equal(await ownerOnly(cfg, wiped, deps), undefined);
    }
    // A limited thread's shell with its key wiped and a dead THREADBEAR_URL:
    // the runner is asked at its own address and says Auto.
    from = limited.id;
    assert.match((await ownerOnly(cfg, wiped, under(limited.id))) ?? '', /on auto/);
    // The runner unreachable: refused, not waved through.
    assert.match((await down(() => ownerOnly(cfg, wiped, under(limited.id)))) ?? '', /Full access/);
    // A stand-in data dir, from a thread or where tb can't tell: only the default one is used.
    const fake = makeHarness();
    assert.match((await ownerOnly({ ...cfg, home: fake.home }, wiped, under(limited.id))) ?? '', /only uses the runner's own data folder/);
    assert.match((await ownerOnly({ ...cfg, home: fake.home }, wiped, { platform: 'win32', defaultHome: h.home })) ?? '', /only uses the runner's own data folder/);
    // Pointed at the default one, but its token isn't the one the CLI's key came from.
    assert.match((await ownerOnly({ ...cfg, home: fake.home }, wiped, { ...under(limited.id), defaultHome: fake.home })) ?? '', /isn't pointed at that thread's own runner/);
    // tb's own key, when a parent can't be read: still a thread (Linux over ssh, 23 Nov).
    const ownKey = { THREADBEAR_THREAD_KEY: threadKey(token, limited.id), THREADBEAR_THREAD_ID: limited.id };
    const blind = { ...terminal, envOf: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } };
    // Under a CLI from before thread keys (an id, no key variable): no answer (finding 177).
    assert.equal((await tbCaller(wiped, { ...base, envOf: (p: number) => (p === 300 ? 'node claude THREADBEAR_THREAD_ID=old X=1' : 'zsh X=1') })).kind, 'unresolved');
    // A patch's action (its thread's id, the key empty) is no thread: as before.
    assert.equal((await tbCaller(wiped, { ...base, envOf: () => 'node x THREADBEAR_THREAD_ID=t THREADBEAR_THREAD_KEY= X=1' })).kind, 'owner');
    const caller = await tbCaller(ownKey, blind);
    assert.deepEqual(caller.kind === 'unresolved' && caller.keys.length, 1);
    from = undefined; // even if the runner, asked, placed it as nobody's
    assert.match((await ownerOnly(cfg, ownKey, blind)) ?? '', /Full access/);
    from = limited.id;
    // Left its parents behind (its shell gone, tb now under launchd) but still
    // in the tool command's process group: that group's leader has the key.
    const orphanTable = async () => [{ pid: 500, ppid: 1, pgid: 400 }, { pid: 400, ppid: 300, pgid: 400 }, { pid: 300, ppid: 1, pgid: 300 }];
    const orphan = { ...base, table: orphanTable, ppid: 1, envOf: (p: number) => (p === 400 ? `zsh THREADBEAR_THREAD_ID=${limited.id} THREADBEAR_THREAD_KEY=${threadKey(token, limited.id)}` : 'x') };
    assert.equal((await tbCaller(wiped, orphan)).kind, 'thread');
    // A Mac's shell shows no environment: the leader's parent, the CLI, says whose it is (Gemini's review of finding 177).
    const hiddenShell = { ...orphan, envOf: (p: number) => (p === 300 ? `claude THREADBEAR_THREAD_ID=${limited.id} THREADBEAR_THREAD_KEY=${threadKey(token, limited.id)}` : 'zsh') };
    assert.equal((await tbCaller(wiped, hiddenShell)).kind, 'thread');
    assert.match((await down(() => ownerOnly(cfg, wiped, hiddenShell))) ?? '', /Full access/);
    // A helper (450) orphaned in the tool shell's group, tb in a group of its own under it: the helper's group's leader, then its CLI, are looked at.
    const helper = { ...base, ppid: 450, table: async () => [{ pid: 500, ppid: 450, pgid: 500 }, { pid: 450, ppid: 1, pgid: 400 }, { pid: 400, ppid: 300, pgid: 400 }, { pid: 300, ppid: 1, pgid: 300 }], envOf: hiddenShell.envOf };
    assert.equal((await tbCaller(wiped, helper)).kind, 'thread');
    // A terminal pipeline whose first command has exited (its group's leader gone, tb's parent the shell) is still a terminal.
    const pipeline = { ...terminal, table: async () => [{ pid: 500, ppid: 400, pgid: 499 }, { pid: 400, ppid: 1, pgid: 400 }] };
    assert.equal((await tbCaller(wiped, pipeline)).kind, 'owner');
    // tb's own environment counts by the old names too: an id with no key variable is no answer.
    assert.equal((await tbCaller({ THREADBARE_THREAD_ID: 'old' }, terminal)).kind, 'unresolved');
    // A key or id in a command's arguments isn't one (a Mac's ps -ww shows them; the environment follows).
    const { psEnvLines } = await import('../../src/peer.ts');
    const argv = `  400 sh -c echo THREADBEAR_THREAD_ID=foo`;
    assert.equal((await tbCaller(wiped, { ...terminal, envOf: () => psEnvLines(`${argv} HOME=/Users/x\n`, [400], `${argv}\n`).get(400)! })).kind, 'owner');
    assert.match((await down(() => ownerOnly(cfg, wiped, orphan))) ?? '', /Full access/, 'not a terminal, so the runner being unreachable is no pass');
    // Its group's leader gone too: can't tell.
    assert.equal((await tbCaller(wiped, { ...orphan, table: async () => [{ pid: 500, ppid: 1, pgid: 400 }, { pid: 300, ppid: 1, pgid: 300 }] })).kind, 'unresolved');
    // A new group, but Linux still has its session: the CLI's.
    const linuxOrphan = { ...base, platform: 'linux' as const, ppid: 1, table: async () => [{ pid: 500, ppid: 1, pgid: 500, sid: 300 }, { pid: 300, ppid: 1, pgid: 300, sid: 300 }], envOf: cliOf(limited.id) };
    assert.equal((await tbCaller(wiped, linuxOrphan)).kind, 'thread');
    // A stand-in data dir whose secrets link to the real ones, served by a
    // runner of its own (Codex's review): its secrets aren't its own.
    for (const link of ['symlink', 'hardlink', 'dir'] as const) {
      const standIn = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tb-standin-'));
      try {
        const real = path.join(h.home, 'secrets');
        if (link === 'dir') fs.symlinkSync(real, path.join(standIn, 'secrets'));
        else {
          fs.mkdirSync(path.join(standIn, 'secrets'));
          for (const f of fs.readdirSync(real)) (link === 'symlink' ? fs.symlinkSync : fs.linkSync)(path.join(real, f), path.join(standIn, 'secrets', f));
        }
        const standInCfg = { ...cfg, home: standIn };
        from = full.id; // what a runner on the stand-in, with a forged Full record, would say
        assert.match((await ownerOnly(standInCfg, wiped, under(limited.id))) ?? '', /own data folder/, link);
        assert.match((await ownerOnly(standInCfg, wiped, { platform: 'win32', defaultHome: h.home })) ?? '', /own data folder/, link);
        // Even were it the default data dir, links in its secrets are refused.
        assert.match((await ownerOnly(standInCfg, wiped, { ...under(limited.id), defaultHome: standIn })) ?? '', /isn't as Threadbear made it/, link);
        assert.match((await ownerOnly(standInCfg, wiped, { platform: 'win32', defaultHome: standIn })) ?? '', /isn't as Threadbear made it/, link);
        from = limited.id;
      } finally {
        fs.rmSync(standIn, { recursive: true, force: true });
      }
    }
    // A shell between that claims a key it made up is no better.
    const forged = { ...under(limited.id), envOf: (p: number) => (p === 400 ? `bash THREADBEAR_THREAD_ID=x THREADBEAR_THREAD_KEY=${'c'.repeat(64)}` : cliOf(limited.id)(p)) };
    assert.match((await ownerOnly(cfg, wiped, forged)) ?? '', /isn't pointed/);
    // Only the key in tb's own environment, no parents: still that thread.
    assert.match((await ownerOnly(cfg, { THREADBEAR_THREAD_KEY: threadKey(token, limited.id), THREADBEAR_THREAD_ID: limited.id }, terminal)) ?? '', /on auto/);
    // A Full thread, which the runner sees as it: fine.
    from = full.id;
    assert.equal(await ownerOnly(cfg, wiped, under(full.id)), undefined);
    // Under a thread the runner places as nobody's: not fine.
    from = undefined;
    assert.match((await ownerOnly(cfg, wiped, under(full.id))) ?? '', /Full access/);
    // A terminal: fine, with the runner up or down.
    assert.equal(await ownerOnly(cfg, {}, terminal), undefined);
    assert.equal(await down(() => ownerOnly(cfg, {}, terminal)), undefined);
    // But a runner that's there and won't answer (its slots full, a lookup it
    // couldn't finish) is no answer, even from a terminal by its parents: an
    // orphaned tb has none (Gemini's review).
    const busy = Object.assign(new Error('Unexpected server response: 503'), { code: undefined });
    assert.match((await ownerOnly(cfg, {}, { ...terminal, connect: async () => { throw busy; } })) ?? '', /didn't answer/);
    const dropped = { call: async () => { throw new Error("connection closed (4503): the runner couldn't tell which process this is; try again"); }, close: () => {} } as unknown as RunnerClient;
    assert.match((await ownerOnly(cfg, {}, { ...terminal, connect: async () => dropped })) ?? '', /didn't answer/);
    // An older runner with no auth.whoami: fine from a terminal only.
    const old = { call: async () => { throw Object.assign(new Error('Method not found'), { code: -32601 }); }, close: () => {} } as unknown as RunnerClient;
    assert.equal(await ownerOnly(cfg, {}, { ...terminal, connect: async () => old }), undefined);
    assert.match((await ownerOnly(cfg, wiped, { ...under(full.id), connect: async () => old })) ?? '', /Full access/);
    // Unless the runner, asked, says it's a limited thread after all.
    from = limited.id;
    assert.match((await ownerOnly(cfg, {}, terminal)) ?? '', /on auto/);
  } finally {
    await server.close();
  }
});

test("tb runner from a limited thread's CLI, its key wiped, no ps on PATH and THREADBEAR_URL at nothing, is refused before any key is read", async (t) => {
  if (process.platform === 'win32') return t.skip("Windows can't read a parent's environment: tb runner there is always refused, as above");
  let from: string | undefined;
  const { h, server, token, port } = await serve({ callerOf: async () => peerOf(from) });
  const me = thread(h, 'auto');
  // A fake ps that says nothing, and one that fails, on PATH.
  const bin = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tb-fakeps-'));
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const failing = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'tb-fakeps-'));
  fs.writeFileSync(path.join(failing, 'ps'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // The backend tb runner would use, which must hear nothing.
  const http = await import('node:http');
  let heard = 0;
  const backend = http.createServer((_q, r) => { heard++; r.end('{}'); });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
  fs.mkdirSync(path.join(h.home, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(h.home, 'secrets', 'convex-key'), 'owner-key\n', { mode: 0o600 });
  // The runner's port as its runner.json says; THREADBEAR_PORT, set below
  // to nothing, isn't taken.
  writeRunnerJson(h.home, { ...readRunnerJson(h.home), port });
  try {
    from = me.id;
    for (const pathDir of ['', bin, failing]) {
      for (const sub of [['list'], ['revoke', 'x', '--purge'], ['add', 'x'], ['rotate-owner'], ['logins']]) {
        // The "CLI": a process with the thread's key, which starts tb with it wiped.
        const script = `const {spawn}=require('child_process');const p=spawn(process.execPath,${JSON.stringify([TB, 'runner', ...sub])},{env:{...process.env,THREADBEAR_THREAD_KEY:'',THREADBEAR_THREAD_ID:'',PATH:${JSON.stringify(pathDir)},THREADBEAR_URL:'ws://127.0.0.1:1/rpc'},stdio:'inherit'});p.on('exit',(c)=>process.exit(c??9));`;
        let out = '';
        const cli = spawn(process.execPath, ['-e', script], {
          env: { ...process.env, THREADBEAR_HOME: h.home, THREADBEAR_RUNNER_HOME: h.home, THREADBEAR_PORT: '1', THREADBEAR_THREAD_ID: me.id, THREADBEAR_THREAD_KEY: threadKey(token, me.id), THREADBEAR_SYNC_URL: `http://127.0.0.1:${(backend.address() as { port: number }).port}` },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        cli.stdout.on('data', (d) => (out += d));
        cli.stderr.on('data', (d) => (out += d));
        const code = await new Promise<number | null>((r) => cli.once('exit', r));
        assert.equal(code, 1, `${pathDir || 'no PATH'} ${sub.join(' ')}: ${out}`);
        assert.match(out, /on auto|Full access|isn't pointed|couldn't tell|own data folder/, out);
      }
    }
    assert.equal(heard, 0, 'the backend heard nothing');
  } finally {
    await server.close();
    backend.close();
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(failing, { recursive: true, force: true });
  }
});

test('a draining server takes the same care with a thread as the main one', async () => {
  let from: string | undefined;
  const { h, server, token, url } = await serve({ onlyOwn: true, callerOf: async () => peerOf(from) });
  const me = thread(h, 'auto');
  try {
    from = me.id;
    const c = await RunnerClient.connect(url, token, { server: 'drain' });
    await assert.rejects(c.call('threads.create', { text: 'x', permissionMode: 'full', accountId: 'claude-3' }), refused);
    assert.equal((await c.call<{ limited: boolean }>('auth.whoami')).limited, true);
    c.close();
  } finally {
    await server.close();
  }
});

// Daybreak, 10 Nov (finding 71), through the RPC gate: a schedule that
// inherits an Ask default can't be switched to Auto with a thread's key.
test("ask: schedules.update can't raise a schedule that inherits an Ask default", async () => {
  const { h, server, token, url, scheduler } = await serve();
  h.runner.cfg.defaults.permissionMode = 'ask';
  const me = thread(h, 'ask');
  const sc = await scheduler.create({ text: 'Tidy', cron: '0 9 * * *', title: 'Inherits', cwd: h.home, accountId: 'claude-3' });
  try {
    const c = await as(url, token, me.id);
    await assert.rejects(c.call('schedules.update', { scheduleId: sc.id, permissionMode: 'auto' }), refused);
    assert.equal(scheduler.find(sc.id).permissionMode, undefined);
    await assert.rejects(c.call('schedules.update', { scheduleId: sc.id, permissionMode: 'full' }), refused);
    // Its runs have Ask, as this thread does: changing what it sends is fine, and so is setting Ask.
    await c.call('schedules.update', { scheduleId: sc.id, text: 'Tidy it', permissionMode: 'ask' });
    assert.equal(scheduler.find(sc.id).permissionMode, 'ask');
    c.close();
  } finally {
    await server.close();
  }
});

// Codex's review of the Daybreak fix for finding 111: a title reaches the
// renamed thread's agent, so tb renaming one above the caller is refused.
for (const mode of MODES) {
  test(`${mode}: renaming a thread with more access through tb is refused, its own or one no higher is not`, async () => {
    const { h, server, token, url } = await serve();
    const me = thread(h, mode);
    const full = thread(h, 'full', 'full one');
    const peer = thread(h, mode, 'peer');
    const c = await as(url, token, me.id);
    try {
      await assert.rejects(c.call('threads.update', { threadId: full.id, title: 'SECURITY_POC' }), refused);
      assert.equal(h.runner.get(full.id).title, 'full one');
      await c.call('threads.update', { threadId: me.id, title: 'mine' });
      await c.call('threads.update', { threadId: peer.id, title: 'renamed' });
      assert.equal(h.runner.get(peer.id).title, 'renamed');
    } finally {
      c.close();
      await server.close();
    }
  });
}

test("a login's cloud token and a thread on a virtual runner are the user's, from the app: refused to any thread's key, Full access too", async () => {
  const started: unknown[] = [];
  const tokens: unknown[] = [];
  const { h, server, token, url } = await serve({
    virtualStart: async (p) => {
      started.push(p);
      return { thread: { id: 'cloud-1', runnerId: 'abcdef012345' } };
    },
    methods: { 'cloudTokens.set': (p) => (tokens.push(p), {}), 'cloudTokens.make': (p) => (tokens.push(p), {}) },
  });
  const me = thread(h, 'full');
  try {
    const c = await as(url, token, me.id);
    await assert.rejects(c.call('cloudTokens.set', { login: 'me@example.com', token: 'sk-ant-oat01-x' }), (e: { code?: number; message?: string }) => refused(e) && /card in the app/.test(e.message ?? ''));
    await assert.rejects(c.call('cloudTokens.make', { login: 'me@example.com' }), refused);
    await assert.rejects(c.call('threads.create', { text: 'x', serviceId: 'runnerServices:1', cwd: '/x', accountId: 'claude-3' }), (e: { code?: number; message?: string }) => refused(e) && /Runs on/.test(e.message ?? ''));
    c.close();
    assert.deepEqual([started.length, tokens.length], [0, 0]);
    // The app, on the runner's token: through.
    const app = await RunnerClient.connect(url, token);
    assert.deepEqual(await app.call('threads.create', { text: 'x', serviceId: 'runnerServices:1', cwd: '/x', accountId: 'claude-3' }), { thread: { id: 'cloud-1', runnerId: 'abcdef012345' } });
    assert.deepEqual(await app.call('cloudTokens.make', { login: 'me@example.com' }), {});
    await assert.rejects(app.call('threads.create', { text: 'x', serviceId: 7 }), (e: { code?: number }) => e.code === -32602);
    app.close();
    assert.equal(started.length, 1);
  } finally {
    await server.close();
  }
});

// The reviews of the fix for finding 158: frames stay small until the lookup
// is done, so a client that sends a big call straight after auth could be cut
// off. A draining runner's link to the primary waits for hello's answer, which
// comes once the lookup is done.
test("a draining runner's link sends a big first call after a slow process lookup", async () => {
  const { PrimaryLink } = await import('../../src/handover.ts');
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const { server, token, port } = await serve({ callerOf: async () => { await held; return peerOf(undefined); } });
  const link = new PrimaryLink('127.0.0.1', port, token);
  try {
    const call = link.call('auth.whoami', { pad: 'x'.repeat(200 * 1024) });
    setTimeout(release, 100).unref();
    assert.deepEqual(await call, {});
  } finally {
    release();
    link.close();
    await server.close();
  }
});

// Daybreak finding 177: a limited thread pointed tb at another runner's data
// dir. tb dropped its key for that runner's token, and that runner, whose
// registry doesn't know the first runner's threads, found it under none of
// its own and took it as the owner. Now a runner reads the environments
// above a connection it can't place, and one under any thread key it wasn't
// started under is closed (4403).
const keyA = 'a'.repeat(64);
const keyF = 'f'.repeat(64);
const sockAt = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
// tb (500) under a shell (400) under another runner's thread's CLI (300),
// under that runner (200); a terminal's tb (700) under its shell (600).
const twoRunners = async () => [
  { pid: 500, ppid: 400, pgid: 500, sid: 300 },
  { pid: 400, ppid: 300, pgid: 400, sid: 300 },
  { pid: 300, ppid: 200, pgid: 300, sid: 300 },
  { pid: 200, ppid: 1, pgid: 200, sid: 200 },
  { pid: 700, ppid: 600, pgid: 700, sid: 600 },
  { pid: 600, ppid: 1, pgid: 600, sid: 600 },
];
const envsWith = (envs: Record<number, string>) => async (pids: number[]) => new Map(pids.filter((p) => p in envs).map((p) => [p, envs[p]!]));
// The CLI's environment has its key; tb's has been wiped; Apple's shell shows none.
const cliEnvs = { 500: '/usr/bin/node tb new --full', 400: '/bin/zsh', 300: `claude THREADBEAR_THREAD_ID=t1 THREADBEAR_THREAD_KEY=${keyA} PATH=/bin`, 200: 'node main.ts HOME=/Users/me', 700: '/usr/bin/node tb list', 600: '/bin/zsh' };

test("another runner's thread is turned away, not taken as the owner, wherever it left its key", async () => {
  const { threadOfSocket, ForeignPeer } = await import('../../src/peer.ts');
  const none = { threadOfPid: () => undefined, threadOfGroup: () => undefined };
  const base = { registry: none, known: () => false, log: nullLogger, table: twoRunners, envOf: envsWith(cliEnvs) };
  for (const platform of ['darwin', 'linux'] as const) {
    await assert.rejects(threadOfSocket(sockAt, { ...base, platform, lsof: async () => [500] }), (e) => e instanceof ForeignPeer, platform);
    // A terminal's tb is still the owner.
    assert.deepEqual(await threadOfSocket(sockAt, { ...base, platform, lsof: async () => [700] }), { kind: 'owner' }, platform);
    // The key in tb's own environment counts too, even with its CLI's unreadable.
    await assert.rejects(threadOfSocket(sockAt, { ...base, platform, lsof: async () => [500], envOf: envsWith({ ...cliEnvs, 500: `node tb THREADBEAR_THREAD_KEY=${keyA}`, 300: 'claude' }) }), (e) => e instanceof ForeignPeer);
    // The thread that started this runner (a dev runner) is its owner.
    assert.deepEqual(await threadOfSocket(sockAt, { ...base, platform, lsof: async () => [500], own: { keys: new Set([keyA]), ids: new Set(['t1']) } }), { kind: 'owner' });
    // ...but a dev runner another thread started isn't this one's.
    await assert.rejects(threadOfSocket(sockAt, { ...base, platform, lsof: async () => [500], own: { keys: new Set([keyF]), ids: new Set<string>() } }), (e) => e instanceof ForeignPeer);
  }
  // A CLI another runner started before thread keys has only its id: still another runner's thread.
  const keyless = { ...cliEnvs, 300: 'claude THREADBEAR_THREAD_ID=t1 THREADBARE_THREAD_ID=t1 PATH=/bin' };
  await assert.rejects(threadOfSocket(sockAt, { ...base, platform: 'darwin', lsof: async () => [500], envOf: envsWith(keyless) }), (e) => e instanceof ForeignPeer);
  // ...unless it's the thread this runner was started under, or one of its own (a patch's action, with an empty key).
  assert.deepEqual(await threadOfSocket(sockAt, { ...base, platform: 'darwin', lsof: async () => [500], envOf: envsWith(keyless), own: { keys: new Set<string>(), ids: new Set(['t1']) } }), { kind: 'owner' });
  const action = { ...cliEnvs, 300: 'sh THREADBEAR_THREAD_ID=t1 THREADBEAR_THREAD_KEY= PATH=/bin' };
  assert.deepEqual(await threadOfSocket(sockAt, { ...base, platform: 'darwin', self: 200, lsof: async () => [500], envOf: envsWith(action) }), { kind: 'owner' });
  // ...or one that left its tree (the Land chip's tb land worker, or one under a draining runner): its thread is this runner's.
  assert.deepEqual(await threadOfSocket(sockAt, { ...base, platform: 'darwin', known: (id) => id === 't1', lsof: async () => [500], envOf: envsWith(action) }), { kind: 'owner' });
  // A CLI from before thread keys has no key variable at all: having its
  // thread (a draining older runner's, a --clone-real copy's) is no pass for it.
  await assert.rejects(threadOfSocket(sockAt, { ...base, platform: 'darwin', known: () => true, lsof: async () => [500], envOf: envsWith(keyless) }), (e) => e instanceof ForeignPeer);
  // A key this runner was started under, kept by an older runner's CLI beside its own thread's id (Codex's second review): foreign.
  const inherited = { ...cliEnvs, 300: `claude THREADBEAR_THREAD_KEY=${keyA} THREADBEAR_THREAD_ID=x PATH=/bin` };
  await assert.rejects(threadOfSocket(sockAt, { ...base, platform: 'darwin', lsof: async () => [500], envOf: envsWith(inherited), own: { keys: new Set([keyA]), ids: new Set(['t1']) } }), (e) => e instanceof ForeignPeer);
  assert.deepEqual(await threadOfSocket(sockAt, { ...base, platform: 'darwin', lsof: async () => [500], envOf: envsWith(cliEnvs), own: { keys: new Set([keyA]), ids: new Set(['t1']) } }), { kind: 'owner' });
  // An environment stuffed with keys or ids isn't a CLI's, and isn't checked one by one.
  const stuffed = { ...cliEnvs, 500: Array.from({ length: 9 }, (_, i) => `THREADBEAR_THREAD_ID=x${i}`).join(' '), 300: 'claude' };
  await assert.rejects(threadOfSocket(sockAt, { ...base, platform: 'darwin', known: () => true, lsof: async () => [500], envOf: envsWith(stuffed) }), (e) => e instanceof ForeignPeer);
  // This runner's own thread is still that thread, found by its registry first.
  const mine = { threadOfPid: (p: number) => (p === 300 ? 'mine' : undefined), threadOfGroup: () => undefined };
  assert.deepEqual(await threadOfSocket(sockAt, { ...base, registry: mine, known: (id) => id === 'mine', platform: 'darwin', lsof: async () => [500] }), { kind: 'thread', threadId: 'mine' });
  // Its tb with its own key on it, too.
  const keyOf = (id: string) => (id === 'mine' ? keyF : 'e'.repeat(64));
  assert.deepEqual(await threadOfSocket(sockAt, { ...base, registry: mine, keyOf, known: (id) => id === 'mine', platform: 'darwin', lsof: async () => [500], envOf: envsWith({ ...cliEnvs, 500: `node tb THREADBEAR_THREAD_ID=mine THREADBEAR_THREAD_KEY=${keyF}` }) }), { kind: 'thread', threadId: 'mine' });
  // A thread of a dev runner that this runner's thread started (its CLI, 450,
  // nearer than 300) doesn't get the starting thread's access here.
  const nested = async () => [...(await twoRunners()).map((r) => (r.pid === 400 ? { ...r, ppid: 450 } : r)), { pid: 450, ppid: 300, pgid: 450, sid: 450 }];
  for (const env450 of [`claude THREADBEAR_THREAD_ID=g THREADBEAR_THREAD_KEY=${keyA}`, 'claude THREADBEAR_THREAD_ID=g']) {
    await assert.rejects(threadOfSocket(sockAt, { ...base, registry: mine, keyOf, known: (id) => id === 'mine', platform: 'darwin', table: nested, lsof: async () => [500], envOf: envsWith({ ...cliEnvs, 450: env450 }) }), (e) => e instanceof ForeignPeer, env450);
  }
});

test("one of this runner's own threads' processes that left its CLI's tree (tb land's worker) is that thread, found by its key", async () => {
  const { threadOfSocket, AmbiguousPeer } = await import('../../src/peer.ts');
  const { threadKey: makeKey } = await import('../../src/rpc-auth.ts');
  const token = 'tok';
  const none = { threadOfPid: () => undefined, threadOfGroup: () => undefined };
  // Orphaned in a session of its own (900), its key and thread id still on it.
  const table = async () => [{ pid: 900, ppid: 1, pgid: 900, sid: 900 }];
  const env = (id: string) => `node tb land THREADBEAR_THREAD_ID=${id} THREADBEAR_THREAD_KEY=${makeKey(token, id)}`;
  const base = { registry: none, log: nullLogger, table, lsof: async () => [900], keyOf: (id: string) => makeKey(token, id) };
  // On Linux the real worker is still in the session of the shell that
  // started it, whose leader has gone: no answer, before its key is read, as
  // a key in its own environment could be another thread's.
  const { UnresolvedPeer } = await import('../../src/peer.ts');
  await assert.rejects(threadOfSocket(sockAt, { ...base, table: async () => [{ pid: 900, ppid: 1, pgid: 850, sid: 850 }], platform: 'linux', known: () => true, envOf: envsWith({ 900: env('mine') }) }), (e) => e instanceof UnresolvedPeer);
  for (const platform of ['darwin', 'linux'] as const) {
    assert.deepEqual(await threadOfSocket(sockAt, { ...base, platform, known: (id) => id === 'mine', envOf: envsWith({ 900: env('mine') }) }), { kind: 'thread', threadId: 'mine' });
    // A key of this runner's for a thread it no longer has: no thread to give it, so turned away.
    const { ForeignPeer } = await import('../../src/peer.ts');
    await assert.rejects(threadOfSocket(sockAt, { ...base, platform, known: () => false, envOf: envsWith({ 900: env('gone') }) }), (e) => e instanceof ForeignPeer);
    // Another thread's id beside a key: the key is for neither, so it's no key of this runner's.
    await assert.rejects(threadOfSocket(sockAt, { ...base, platform, known: () => true, envOf: envsWith({ 900: env('mine').replace('_ID=mine', '_ID=other') }) }), (e) => e instanceof ForeignPeer);
  }
  // Two of its threads' keys above one connection: no guessing.
  const two = async () => [{ pid: 900, ppid: 800, pgid: 900, sid: 900 }, { pid: 800, ppid: 1, pgid: 800, sid: 800 }];
  await assert.rejects(threadOfSocket(sockAt, { ...base, table: two, platform: 'darwin', known: () => true, envOf: envsWith({ 900: env('a'), 800: env('b') }) }), (e) => e instanceof AmbiguousPeer);
});

test("a lookup that can't read the environments above a connection can't say who it is", async () => {
  const { threadOfSocket, UnresolvedPeer } = await import('../../src/peer.ts');
  const none = { threadOfPid: () => undefined, threadOfGroup: () => undefined };
  const base = { registry: none, known: () => false, log: nullLogger, table: twoRunners, lsof: async () => [500], platform: 'darwin' as const };
  // The read failing, running out of time, or a process gone before it was read.
  await assert.rejects(threadOfSocket(sockAt, { ...base, envOf: async () => { throw new Error('ps failed'); } }), (e) => e instanceof UnresolvedPeer);
  await assert.rejects(threadOfSocket(sockAt, { ...base, lookupMs: 50, envOf: () => new Promise(() => {}) }), (e) => e instanceof UnresolvedPeer);
  const { 300: _gone, ...rest } = cliEnvs;
  await assert.rejects(threadOfSocket(sockAt, { ...base, envOf: envsWith(rest) }), (e) => e instanceof UnresolvedPeer);
  // Held by a process under two threads of this runner: still ambiguous, before any of this.
  const { AmbiguousPeer } = await import('../../src/peer.ts');
  const two = { threadOfPid: (p: number) => (p === 300 ? 'a' : p === 600 ? 'b' : undefined), threadOfGroup: () => undefined };
  await assert.rejects(threadOfSocket(sockAt, { ...base, registry: two, known: () => true, lsof: async () => [500, 700], envOf: envsWith(cliEnvs) }), (e) => e instanceof AmbiguousPeer);
  // A holder of this runner's thread beside one under another runner's: turned away.
  const { ForeignPeer } = await import('../../src/peer.ts');
  const one = { threadOfPid: (p: number) => (p === 600 ? 'b' : undefined), threadOfGroup: () => undefined };
  await assert.rejects(threadOfSocket(sockAt, { ...base, registry: one, known: () => true, lsof: async () => [500, 700], envOf: envsWith(cliEnvs) }), (e) => e instanceof ForeignPeer);
});

test("a process that left another runner's thread's shell is found by its group's leader, its session's on Linux, or is no answer", async () => {
  const { threadOfSocket, ForeignPeer, UnresolvedPeer } = await import('../../src/peer.ts');
  const none = { threadOfPid: () => undefined, threadOfGroup: () => undefined };
  // tb (900) orphaned, still in the tool command's group (400), whose leader
  // (the thread's shell) is still there under the CLI.
  const orphan = async () => [...(await twoRunners()), { pid: 900, ppid: 1, pgid: 400, sid: 300 }];
  const base = { registry: none, known: () => false, log: nullLogger, lsof: async () => [900], envOf: envsWith({ ...cliEnvs, 900: 'node tb' }) };
  await assert.rejects(threadOfSocket(sockAt, { ...base, platform: 'darwin', table: orphan }), (e) => e instanceof ForeignPeer, 'by its group');
  // Its group's leader gone too: on Linux its session's leader is the CLI,
  // and a session whose leader has gone is no answer.
  const leaderGone = async () => (await orphan()).filter((r) => r.pid !== 400);
  await assert.rejects(threadOfSocket(sockAt, { ...base, platform: 'linux', table: leaderGone }), (e) => e instanceof ForeignPeer, 'by its session');
  const cliGone = async () => (await leaderGone()).filter((r) => r.pid !== 300 && r.pid !== 200);
  await assert.rejects(threadOfSocket(sockAt, { ...base, platform: 'linux', table: cliGone }), (e) => e instanceof UnresolvedPeer, 'its session gone');
  // A pipeline's tb in a terminal, whose group's first command has exited, has its parents: the owner.
  const pipeline = async () => [...(await twoRunners()), { pid: 950, ppid: 600, pgid: 949, sid: 600 }];
  assert.deepEqual(await threadOfSocket(sockAt, { ...base, platform: 'darwin', table: pipeline, lsof: async () => [950], envOf: envsWith({ ...cliEnvs, 950: 'node tb' }) }), { kind: 'owner' });
  // Windows can't read another process's environment: as before (SECURITY.md).
  assert.deepEqual(await threadOfSocket(sockAt, { ...base, platform: 'win32', table: twoRunners, lsof: async () => [500], envOf: undefined }), { kind: 'owner' });
});

test("ps's environments: one line a process, a line break in a value can't make another, and arguments aren't the environment", async () => {
  const { psEnvLines, threadMarksIn } = await import('../../src/peer.ts');
  const out = `  300 claude THREADBEAR_THREAD_KEY=${keyA} THREADBEAR_THREAD_ID=t1 THREADBARE_THREAD_ID=t1 X=a\\012  500 fake\n  500 node tb\n`;
  const envs = psEnvLines(out, [300, 500], '  300 claude\n  500 node tb\n');
  assert.deepEqual(threadMarksIn(envs.get(300)!), { keys: [keyA], ids: ['t1'], emptyKey: false });
  assert.deepEqual(threadMarksIn(envs.get(500)!), { keys: [], ids: [], emptyKey: false });
  assert.throws(() => psEnvLines(`  300 a\n  300 b\n`, [300]), /twice/);
  // A prompt that mentions a key is an argument, not the environment.
  const prompt = `  700 node tb new THREADBEAR_THREAD_KEY=${keyF} THREADBEAR_THREAD_ID=x`;
  assert.deepEqual(threadMarksIn(psEnvLines(`${prompt} HOME=/Users/me\n`, [700], `${prompt}\n`).get(700)!), { keys: [], ids: [], emptyKey: false });
  // Arguments that grew into the environment between the two looks aren't cut there.
  assert.deepEqual(threadMarksIn(psEnvLines(`  300 claude THREADBEAR_THREAD_KEY=${keyA}\n`, [300], '  300 claude T\n').get(300)!).keys, [keyA]);
  // Arguments that changed between the two looks: read whole, so it can only add.
  assert.deepEqual(threadMarksIn(psEnvLines(`${prompt} HOME=/Users/me\n`, [700], '  700 other\n').get(700)!).keys, [keyF]);
  // An empty key (a patch action's) or a short one isn't a key.
  assert.deepEqual(threadMarksIn('x THREADBEAR_THREAD_KEY= THREADBEAR_THREAD_KEY=abc THREADBEAR_THREAD_ID='), { keys: [], ids: [], emptyKey: true });
  // Linux's /proc environ is read entry by entry: a value that mentions one isn't one.
  assert.deepEqual(threadMarksIn(`\0NOTE=debug THREADBEAR_THREAD_ID=abc THREADBEAR_THREAD_KEY=${keyA}\0THREADBEAR_THREAD_ID=t2\0`), { keys: [], ids: ['t2'], emptyKey: false });
});

// The remediation's test, for real: two runners, a limited thread's "CLI" on
// A (a process with its key) starting ordinary tb with THREADBEAR_HOME at B.
test('two runners: tb from a limited thread on A pointed at B is turned away by B; a terminal, and the thread on A, still work', async (t) => {
  if (process.platform === 'win32') return t.skip("Windows can't read another process's environment (the client asks instead, below)");
  const { threadOfSocket, ownThreadMarks } = await import('../../src/peer.ts');
  const own = await ownThreadMarks();
  // Runner A knows its CLIs' pids; B knows none of them.
  const cliPids = new Map<number, string>();
  let tokenA = '';
  const a = await serve({ callerOf: (sock) => threadOfSocket(sock, { registry: { threadOfPid: (p) => cliPids.get(p) }, known: () => true, log: nullLogger, own, keyOf: (id) => threadKey(tokenA, id), lookupMs: PATIENCE_MS }) });
  tokenA = a.token;
  const b = await serve({ callerOf: (sock) => threadOfSocket(sock, { registry: { threadOfPid: () => undefined }, known: () => false, log: nullLogger, own: { keys: new Set([...own.keys, keyF]), ids: new Set([...own.ids, 'dev-starter']) }, lookupMs: PATIENCE_MS }) });
  const run = async (cliEnv: Record<string, string>, tbEnv: Record<string, string>, args: string[], threadId?: string) => {
    const script = `const {spawn}=require('child_process');const p=spawn(process.execPath,${JSON.stringify([TB, ...args])},{env:{...process.env,...${JSON.stringify(tbEnv)}},stdio:'inherit'});p.on('exit',(c)=>process.exit(c??9));`;
    let out = '';
    const cli = spawn(process.execPath, ['-e', script], { env: { ...process.env, THREADBEAR_THREAD_KEY: '', THREADBEAR_THREAD_ID: '', ...cliEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    if (threadId && cli.pid) cliPids.set(cli.pid, threadId);
    cli.stdout.on('data', (d) => (out += d));
    cli.stderr.on('data', (d) => (out += d));
    const code = await new Promise<number | null>((r) => cli.once('exit', r));
    return { code, out };
  };
  try {
    const limited = thread(a.h, 'ask');
    const key = threadKey(a.token, limited.id);
    const onA = { THREADBEAR_THREAD_ID: limited.id, THREADBEAR_THREAD_KEY: key, THREADBEAR_RUNNER_HOME: a.h.home };
    const atB = { THREADBEAR_HOME: b.h.home, THREADBEAR_URL: b.url };
    const before = b.h.runner.list(['inbox']).length;
    // Its key as tb drops it for B's token, and wiped outright.
    for (const tbEnv of [atB, { ...atB, THREADBEAR_THREAD_KEY: '', THREADBEAR_THREAD_ID: '' }]) {
      const r = await run(onA, tbEnv, ['new', '--full', '--account', 'claude-3', 'sneaky'], limited.id);
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, /another runner/, r.out);
    }
    assert.equal(b.h.runner.list(['inbox']).length, before, 'B made nothing');
    // A terminal (no thread key above it but this test's own) is B's owner.
    const mine = await run({}, atB, ['new', '--full', '--account', 'claude-3', 'mine']);
    assert.equal(mine.code, 0, mine.out);
    assert.equal(b.h.runner.list(['inbox']).find((x) => x.id === mine.out.trim())?.permissionMode, 'full');
    // The thread that started B (its key among B's own) is B's owner too.
    const dev = await run({ THREADBEAR_THREAD_ID: 'dev-starter', THREADBEAR_THREAD_KEY: keyF, THREADBEAR_RUNNER_HOME: a.h.home }, atB, ['new', '--account', 'claude-3', 'from the thread that started it']);
    assert.equal(dev.code, 0, dev.out);
    // The limited thread on its own runner: its own limits, as ever.
    const own = await run(onA, { THREADBEAR_HOME: a.h.home, THREADBEAR_URL: a.url }, ['new', '--full', '--account', 'claude-3', 'raise'], limited.id);
    assert.notEqual(own.code, 0, own.out);
    const ok = await run(onA, { THREADBEAR_HOME: a.h.home, THREADBEAR_URL: a.url }, ['new', '--account', 'claude-3', 'same mode'], limited.id);
    assert.equal(ok.code, 0, ok.out);
  } finally {
    await a.server.close();
    await b.server.close();
  }
});

test("on Windows a thread's tb asks its own runner before using another runner's token", async () => {
  const { crossHomeRefusal } = await import('../../src/tb-connect.ts');
  const { h: a, token } = await serve().then(async (s) => { await s.server.close(); return s; });
  const other = makeHarness();
  const env = { THREADBEAR_THREAD_KEY: threadKey(token, 't1'), THREADBEAR_THREAD_ID: 't1', THREADBEAR_RUNNER_HOME: a.home };
  const answering = (whoami: unknown) => async () => ({ call: async () => whoami, close: () => {} }) as unknown as RunnerClient;
  assert.match((await crossHomeRefusal(other.home, env, { platform: 'win32', connect: answering({ threadId: 't1', limited: true, mode: 'ask' }) }))!, /on ask/);
  assert.equal(await crossHomeRefusal(other.home, env, { platform: 'win32', connect: answering({ threadId: 't1', limited: false, mode: 'full' }) }), undefined);
  assert.match((await crossHomeRefusal(other.home, env, { platform: 'win32', connect: answering({}) }))!, /couldn't be asked/, 'not placed as the thread');
  assert.match((await crossHomeRefusal(other.home, env, { platform: 'win32', connect: async () => { throw new Error('ECONNREFUSED'); } }))!, /couldn't be asked/);
  // Its own runner, a Mac or Linux (whose runner checks itself), or no thread: nothing to ask.
  const never = async () => { throw new Error('asked'); };
  assert.equal(await crossHomeRefusal(a.home, env, { platform: 'win32', connect: never }), undefined);
  assert.equal(await crossHomeRefusal(other.home, env, { platform: 'darwin', connect: never }), undefined);
  assert.equal(await crossHomeRefusal(other.home, {}, { platform: 'win32', connect: never }), undefined);
  // A thread id with no key (an old CLI, a patch's action) can't ask: refused.
  assert.match((await crossHomeRefusal(other.home, { ...env, THREADBEAR_THREAD_KEY: '' }, { platform: 'win32', connect: never }))!, /couldn't be asked/);
});
