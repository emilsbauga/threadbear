// The sandboxed-threads experiment (a thread in a runner.json `sandbox`
// folder ran its CLI in a container) was taken out on 16 Nov 2026, before
// anyone relied on it. What's left fails closed for a copy that had it on:
// a thread that ran shut in a container, or one in a folder the old key
// still names, doesn't quietly start on the machine instead. And the
// renaming check that was tested beside it still holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { CallerGate } from '../../src/rpc-gate.ts';
import { PROVIDER_INFO } from '../../src/providers.ts';
import { loadConfig } from '../../src/config.ts';
import type { ApprovalDecision } from '../../src/protocol.ts';

function folders() {
  const root = fs.realpathSync(tmpDir());
  const box = path.join(root, 'sandboxed');
  const demo = path.join(box, 'demo');
  const outside = path.join(root, 'elsewhere');
  for (const d of [demo, outside]) fs.mkdirSync(d, { recursive: true });
  return { root, box, demo, outside };
}

test("runner.json's old sandbox key: a thread there is refused, not started on the machine; elsewhere nothing changes", () => {
  const { box, demo, outside } = folders();
  const h = makeHarness(tmpDir(), { retiredSandboxFolders: [box] });
  assert.throws(() => h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: demo }), /no longer has a sandbox.*Take `sandbox` out of runner\.json/);
  assert.equal(h.adapter.sessions.length, 0, 'no CLI started');
  h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: outside });
  assert.equal(h.adapter.sessions.length, 1);
});

test('the key is read from runner.json as its folders, and nothing else of it is kept', () => {
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ sandbox: { folders: ['/tmp/sb'], image: 'threadbear-sandbox' } }));
  const cfg = loadConfig({ THREADBEAR_HOME: home } as NodeJS.ProcessEnv);
  assert.deepEqual(cfg.retiredSandboxFolders, [path.resolve('/tmp/sb')]);
  assert.equal((cfg as { sandbox?: unknown }).sandbox, undefined);
});

test('a thread that ran shut in a sandbox never starts on the machine, wherever its folder is', async () => {
  const { outside } = folders();
  const h = makeHarness();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: outside });
  h.adapter.last.init();
  h.adapter.last.result('completed');
  await tick();
  const st = h.runner.threads.get(thread.id)!;
  st.rec.confined = true; // as an older release left it
  (h.runner as unknown as { releaseSession(s: typeof st): void }).releaseSession(st);
  await tick();
  const before = h.adapter.sessions.length;
  await Promise.resolve(h.runner.send(thread.id, 'go on')).catch(() => undefined);
  await tick();
  assert.equal(h.adapter.sessions.length, before, 'no CLI for it');
  assert.ok(h.events(thread.id).some((e) => /ran in a sandbox, which Threadbear no longer has/.test(JSON.stringify(e))));
});

test("an older runner's create_thread for a sandboxed agent (confined) is refused, not started outside", async () => {
  const { RpcServer } = await import('../../src/rpc.ts');
  const { RunnerClient } = await import('../../src/client.ts');
  const { nullLogger } = await import('../../src/log.ts');
  const TOKEN = 'test-token-0123456789';
  const h = makeHarness();
  const server = new RpcServer({ host: '127.0.0.1', port: 0, token: TOKEN, runner: h.runner, log: nullLogger });
  const { port } = await server.listen();
  const client = await RunnerClient.connect(`ws://127.0.0.1:${port}/rpc`, TOKEN);
  try {
    await assert.rejects(client.call('threads.create', { text: 'x', accountId: 'claude-3', confined: true }), /no longer has/);
    assert.equal(h.runner.list().length, 0);
  } finally {
    client.close();
    await server.close();
  }
});

test("a thread's own call can't say unconfine, and an agent's move still tells an older runner it isn't the user's", () => {
  const gate = new CallerGate({
    runner: {
      has: (id) => id === 'me' || id === 'other',
      get: (id) => ({ permissionMode: id === 'me' ? 'auto' : 'auto', title: id }),
      accessOf: () => 'auto',
    },
  });
  const made = gate.check('me', 'threads.create', { text: 'x', unconfine: true });
  assert.equal(made.unconfine, undefined);
  const moved = gate.check('me', 'threads.update', { threadId: 'me', cwd: '/tmp' });
  assert.equal(moved.unconfine, false);
  assert.equal(moved.byAgent, true);
});

test("a caller the runner can't place gets no more than reads, though Ask and Plan are the lowest modes", () => {
  const gate = new CallerGate({ runner: { has: () => false, get: () => ({ title: 'x' }), accessOf: () => 'ask' } });
  assert.throws(() => gate.check('gone', 'threads.send', { threadId: 'some-ask-thread', text: 'hi' }), /only read/);
  assert.throws(() => gate.check('gone', 'threads.create', { text: 'x', permissionMode: 'ask' }), /only read/);
  assert.equal(gate.whoami('gone').limited, true);
});

test('providers no longer say whether they run in a sandbox', () => {
  for (const p of Object.values(PROVIDER_INFO)) assert.equal('sandbox' in p, false, p.id);
});

test('renaming a thread with more access asks first; its own title, or one no higher, does not', async () => {
  const { outside } = folders();
  const h = makeHarness();
  const host = h.runner.create({ text: 'Host work', accountId: 'claude-3', cwd: outside, permissionMode: 'ask' }).thread;
  h.adapter.last.init();
  const me = h.runner.create({ text: 'Me', accountId: 'claude-3', cwd: outside, permissionMode: 'ask' }).thread;
  h.adapter.last.init();
  const full = h.runner.create({ text: 'Full work', accountId: 'claude-3', cwd: outside, permissionMode: 'full' }).thread;
  h.adapter.last.init();
  const list = buildThreadbearTools(h.runner as never, me.id, () => h.clock.now(), undefined, undefined, undefined, { sleep: async () => {} });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await list.find((x) => x.name === name)!.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), error: Boolean(r.isError) };
  };
  const cards = () => h.events(me.id).filter((e) => e.type === 'approval.requested');
  const withCard = async (decision: ApprovalDecision | null, args: Record<string, unknown>) => {
    const before = cards().length;
    const p = call('update_thread', args);
    let card: any;
    for (let i = 0; i < 50 && !card; i++) {
      await tick();
      card = cards().length > before ? cards().at(-1) : undefined;
    }
    if (decision === null) {
      assert.equal(card, undefined);
      return { ...(await p), card };
    }
    assert.ok(card);
    h.runner.respondApproval({ threadId: me.id, approvalId: card.approvalId, decision });
    return { ...(await p), card };
  };
  const rec = (id: string) => h.store.loadAll().records.find((t) => t.id === id)!;
  const denied = await withCard('deny', { threadId: full.id, title: 'Selecting text\nSECURITY_POC' });
  assert.equal(denied.error, true);
  assert.match(denied.card.title, /^Rename "Full work", which has Full access/);
  assert.equal(rec(full.id).title, 'Full work');
  await withCard(null, { title: 'My own name' });
  assert.equal(rec(me.id).title, 'My own name');
  const fine = await withCard(null, { threadId: host.id, title: 'Renamed' });
  assert.equal(fine.error, false, fine.text);
  assert.equal(rec(host.id).title, 'Renamed');
});

// Grok's review of the removal: `confined` had also put a sandboxed
// thread below everyone, so with it gone a leftover sandboxed Full thread
// counted as Full, and its title and words could reach an Ask thread (its
// a quiet-inbox wait).
test("a thread an older release ran in the sandbox counts as the least, below even Ask, for what it says", async () => {
  const { above, LEAST } = await import('../../src/threadbear-mcp.ts');
  const { outside } = folders();
  const h = makeHarness();
  const boxed = h.runner.create({ text: 'Selecting text in the transcript', accountId: 'claude-3', cwd: outside, permissionMode: 'full' }).thread;
  h.adapter.last.init();
  h.adapter.last.result('completed');
  const ask = h.runner.create({ text: 'Plan', accountId: 'claude-3', cwd: outside, permissionMode: 'ask' }).thread;
  h.adapter.last.init();
  await tick();
  h.runner.threads.get(boxed.id)!.rec.confined = true;
  assert.equal(h.runner.authoritySaved(boxed.id), LEAST);
  assert.equal(h.runner.authorityNow(boxed.id), LEAST);
  assert.equal(h.runner.mayTellOf({ mode: 'ask' }, boxed.id), false);
  assert.equal(h.runner.mayTellOf({ mode: 'plan' }, boxed.id), false);
  assert.equal(above({ mode: 'ask' }, LEAST), true, 'an Ask thread is above it');
  assert.equal(above(LEAST, LEAST), false);
  assert.equal(h.runner.mayTellOf(h.runner.authorityNow(ask.id), ask.id), true, 'ordinary threads as before');
});

test("an agent's change from the phone path tells an older runner it isn't the user's", async () => {
  const { phoneCommands } = await import('../../src/handover.ts');
  const h = makeHarness();
  const sent: Record<string, unknown>[] = [];
  const host = phoneCommands(h.runner, { owns: () => true, call: async (_id: string, _m: string, p: Record<string, unknown>) => (sent.push(p), {}) } as never);
  await host.update({ threadId: 'elsewhere', accountId: 'codex-main', byAgent: true } as never);
  await host.update({ threadId: 'elsewhere', accountId: 'codex-main' } as never);
  assert.equal(sent[0]!.unconfine, false);
  assert.equal('unconfine' in sent[1]!, false, "the user's own, as before");
});
