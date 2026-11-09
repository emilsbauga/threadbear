import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAccounts } from '../../src/accounts.ts';
import { loadConfig, writeRunnerJson } from '../../src/config.ts';
import { isCliProvider, type Account } from '../../src/protocol.ts';
import type { AgentSession } from '../../src/adapters/types.ts';
import { PiAdapter } from '../../src/adapters/pi/adapter.ts';
import { nullLogger } from '../../src/log.ts';
import { FakeAccounts, makeHarness, tmpDir } from '../helpers/fakes.ts';

test('configured Pi profiles register distinct accounts without reading a login or changing existing accounts', () => {
  const home = tmpDir();
  writeRunnerJson(home, { pi: { profiles: [{ id: 'local', connection: { provider: 'ollama', model: 'test-model' } }, { id: 'router', connection: { provider: 'openrouter', model: 'vendor/model' } }] } });
  const cfg = loadConfig({ THREADBEAR_HOME: home, THREADBEAR_CLAUDE_MAIN_DIR: path.join(home, 'no-claude'), THREADBEAR_CODEX_MAIN_DIR: path.join(home, 'no-codex'), THREADBEAR_ACCOUNTS_DIR: path.join(home, 'no-accounts'), THREADBEAR_CONNECTORS_URL: 'off' });
  const accounts = discoverAccounts(cfg);
  assert.deepEqual(accounts.map(a => a.id), ['pi:local', 'pi:router']);
  assert.equal(accounts[0].provider, 'pi'); assert.equal(accounts[1].defaultModel, 'vendor/model');
  assert.equal(fs.existsSync(accounts[0].configDir), false);
  assert.equal(isCliProvider('pi'), false);
});

test('a Pi-only runner creates a runnable Pi thread with the configured model and normal completion events', { timeout: 300_000 }, async t => {
  const home = tmpDir(), owned = new Set<number>();
  writeRunnerJson(home, { pi: { profiles: [{ id: 'test', connection: { provider: 'test', model: 'model-one' } }] } });
  const cfg = loadConfig({ THREADBEAR_HOME: home, THREADBEAR_CONNECTORS_URL: 'off' });
  const profile = cfg.piProfiles![0];
  profile.executable = process.execPath;
  const account: Account = { id: 'pi:test', provider: 'pi', title: 'Pi', configDir: profile.configDir, piProfileId: profile.id, connection: profile.connection, defaultModel: profile.connection.model, models: [{ id: 'model-one', model: 'model-one', title: 'Model one', effortLevels: [] }] };
  const adapter = new PiAdapter({ profileFor: () => profile, toolsFor: () => [], args: [fileURLToPath(new URL('../fixtures/pi-rpc.mjs', import.meta.url))], registry: { add: p => { owned.add(p); }, remove: p => { owned.delete(p); } }, log: nullLogger });
  let live: AgentSession | undefined;
  let initialInstructions = '';
  const start = adapter.start.bind(adapter);
  adapter.start = (opts, sink) => { initialInstructions = opts.instructions ?? ''; live = start(opts, sink); return live; };
  const h = makeHarness(home, { piProfiles: [profile] }, { accounts: new FakeAccounts([account]), adapters: { pi: adapter }, standingInstructions: () => 'Keep the shared instructions.' });
  t.after(async () => { await h.runner.shutdown(); await live?.end({ hard: true }); });
  assert.equal(h.runner.hello().defaults.accountId, 'pi:test');
  assert.ok(!h.runner.noticesForNewClient().some(n => n.message.includes('claude CLI')));
  assert.throws(() => h.runner.create({ text: 'plan', accountId: account.id, permissionMode: 'plan' }), /Plan first is not available for Pi/);
  // Subscribe before starting the fixture. A completion event, rather than
  // a four-second wall deadline, proves that the real adapter finished.
  const completed = Promise.withResolvers<void>();
  completed.promise.catch(() => {});
  const unsubscribe = h.runner.onNotification(n => {
    if (n.method !== 'thread.event') return;
    if (n.params.event.type === 'turn.completed') completed.resolve();
    if (n.params.event.type === 'error') completed.reject(new Error(n.params.event.message));
  });
  t.after(unsubscribe);
  t.signal.addEventListener('abort', () => completed.reject(t.signal.reason), { once: true });
  const { thread } = h.runner.create({ text: 'hello', accountId: account.id, model: 'model-one' });
  assert.throws(() => h.runner.update({ threadId: thread.id, permissionMode: 'plan' }), /Plan first is not available for Pi/);
  assert.equal(h.runner.get(thread.id).permissionMode, 'full');
  assert.match(initialInstructions, /Keep the shared instructions/);
  assert.equal(thread.provider, 'pi'); assert.equal(thread.model, 'model-one');
  await completed.promise; // The test's overall timeout still bounds a broken fixture.
  assert.ok(h.events(thread.id).some(e => e.type === 'assistant.text' && e.text === 'final:hello'));
  await h.runner.shutdown(); await live?.end({ hard: true }); assert.equal(owned.size, 0);
});

// Switching providers must not carry an unsupported mode into Pi or partly
// apply the rest of a rejected update. No model process starts for drafts.
test('moving a planned draft to Pi refuses before changing its title or login', async t => {
  const home = tmpDir();
  const account: Account = { id: 'pi:test', provider: 'pi', title: 'Local', configDir: home };
  const accounts = new FakeAccounts([...new FakeAccounts().list(), account]);
  const h = makeHarness(home, {}, { accounts });
  h.runner.adapters.pi = h.adapter as unknown as PiAdapter;
  t.after(() => h.runner.shutdown());
  const { thread } = h.runner.createDraft({ text: 'Plan only', accountId: 'claude-3', permissionMode: 'plan', title: 'Original' });
  assert.throws(() => h.runner.update({ threadId: thread.id, accountId: account.id, title: 'Changed' }), /Plan first is not available for Pi/);
  assert.equal(h.runner.get(thread.id).title, 'Original');
  assert.equal(h.runner.get(thread.id).accountId, 'claude-3');
  assert.equal(h.runner.update({ threadId: thread.id, accountId: account.id, permissionMode: 'ask' }).thread.provider, 'pi');
});
