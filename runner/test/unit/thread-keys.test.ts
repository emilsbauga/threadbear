// A thread's own key on the RPC, and what it can't do with it
// (docs/protocol/connection.md, "A thread's own key"). The tests go through a real
// server and the real tb, as an agent's shell would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PATIENCE_MS } from '../helpers/patience.ts';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { makeHarness } from '../helpers/fakes.ts';
import { RpcServer } from '../../src/rpc.ts';
import { RunnerClient } from '../../src/client.ts';
import { readToken } from '../../src/config.ts';
import { nullLogger } from '../../src/log.ts';
import { threadKey } from '../../src/rpc-auth.ts';
import { GATED_READS, CallerGate } from '../../src/rpc-gate.ts';
import { Scheduler, scheduleMethods } from '../../src/schedules.ts';
import type { PermissionMode } from '../../src/protocol.ts';

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
  const { h, server, token, url } = await serve({ callerOf: async () => from });
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
  const { h, server, token, url } = await serve({ callerOf: async () => from });
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
    const { h, server, token, url } = await serve({ callerOf: async () => from });
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
  const { h, server, token, url } = await serve({ callerOf: async () => { await held; return from; } });
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
  const { threadOfSocket, AmbiguousPeer } = await import('../../src/peer.ts');
  const sock = { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 8797 };
  const threadOfPort = (_port: number, deps: Parameters<typeof threadOfSocket>[1]) => threadOfSocket(sock, deps);
  const table = async () => [
    { pid: 500, ppid: 400 }, // tb
    { pid: 400, ppid: 300 }, // zsh
    { pid: 300, ppid: 1 }, // the CLI
    { pid: 700, ppid: 1 }, // tb in a terminal
  ];
  const registry = { threadOfPid: (p: number) => (p === 300 ? 'th1' : p === 700 ? 'models:acct' : undefined) };
  const look = (pids: number[], known: (id: string) => boolean = (id) => id === 'th1') => threadOfPort(1234, { registry, known, log: nullLogger, lsof: async () => pids, table });
  assert.equal(await look([process.pid, 500]), 'th1', 'skips the runner itself');
  assert.equal(await look([500], () => false), undefined, 'not a thread this runner has');
  assert.equal(await look([700]), undefined, "a job's label isn't a thread");
  assert.equal(await look([]), undefined);
  const orphan = { pid: 900, ppid: 1, pgid: 77 };
  const grouped = await threadOfPort(1234, { registry: { ...registry, threadOfGroup: (g: number) => (g === 77 ? 'th1' : undefined) }, known: (id) => id === 'th1', log: nullLogger, lsof: async () => [900], table: async () => [orphan] });
  assert.equal(grouped, 'th1', 'lost its parents, still in the tool command\'s group');
  const failing = await threadOfPort(1234, { registry, known: () => true, log: nullLogger, lsof: async () => { throw new Error('no lsof'); }, table });
  assert.equal(failing, undefined, 'a failed lookup falls back to the credential');
  // A socket held by processes under two threads (handed to a child): no guessing.
  const two = { threadOfPid: (p: number) => (p === 300 ? 'th1' : p === 800 ? 'th2' : undefined) };
  const both = async () => [...(await table()), { pid: 800, ppid: 1 }];
  await assert.rejects(threadOfSocket(sock, { registry: two, known: () => true, log: nullLogger, lsof: async () => [500, 800], table: both }), (e) => e instanceof AmbiguousPeer);
  // Two holders under the same thread (a fork) are that thread.
  assert.equal(await threadOfSocket(sock, { registry: two, known: () => true, log: nullLogger, lsof: async () => [500, 400], table: both }), 'th1');
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
    assert.equal(await threadOfSocket(sock, { registry, known: () => true, log: nullLogger, lookupMs }), 'th9');
    // Under another process: its parent (this test) is the CLI.
    const up = { threadOfPid: (p: number) => (p === process.pid ? 'th8' : undefined) };
    assert.equal(await threadOfSocket(sock, { registry: up, known: () => true, log: nullLogger, lookupMs }), 'th8');
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
    assert.equal(await threadOfSocket(sock, { registry, known: () => true, log: nullLogger, lookupMs: PATIENCE_MS }), 'ask-thread');
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
  const { h, server, token, url } = await serve({ callerOf: async () => from });
  const me = thread(h, 'auto');
  try {
    const key = threadKey(token, me.id);
    const r = await tb(h, url, me.id, key, ['runner']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Auto|Full access/);
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

test("tb runner can't be talked past its check by pointing at no runner", async () => {
  const { ownerOnly, underThread } = await import('../../src/tb-connect.ts');
  const h = makeHarness();
  const cfg = { home: h.home, host: '127.0.0.1', port: 1 } as Parameters<typeof ownerOnly>[0];
  // The key's still in the environment, the runner's unreachable.
  assert.match((await ownerOnly(cfg, { THREADBEAR_THREAD_KEY: 'a'.repeat(64) })) ?? '', /Full access/);
  // A stand-in server on THREADBEAR_URL can't say it's fine.
  assert.match((await ownerOnly(cfg, { THREADBEAR_THREAD_KEY: 'a'.repeat(64), THREADBEAR_URL: 'ws://127.0.0.1:1/rpc' })) ?? '', /Full access/);
  // Wiped from this process, but a parent still has it.
  const table = async () => [{ pid: process.ppid, ppid: 300 }, { pid: 300, ppid: 1 }];
  assert.equal(await underThread(table, (p) => (p === 300 ? `claude THREADBEAR_THREAD_KEY=${'b'.repeat(64)} X=1` : 'zsh')), true);
  assert.equal(await underThread(table, () => 'zsh THREADBEAR_THREAD_KEY= X=1'), false, 'an empty key is no key');
  assert.equal(await underThread(async () => { throw new Error('no ps'); }, () => ''), false);
});

test('a draining server takes the same care with a thread as the main one', async () => {
  let from: string | undefined;
  const { h, server, token, url } = await serve({ onlyOwn: true, callerOf: async () => from });
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
