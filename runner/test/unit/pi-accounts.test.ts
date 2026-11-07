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

test('a Pi-only runner creates a runnable Pi thread with the configured model and normal completion events', async t => {
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
  const { thread } = h.runner.create({ text: 'hello', accountId: account.id, model: 'model-one' });
  assert.throws(() => h.runner.update({ threadId: thread.id, permissionMode: 'plan' }), /Plan first is not available for Pi/);
  assert.equal(h.runner.get(thread.id).permissionMode, 'full');
  assert.match(initialInstructions, /Keep the shared instructions/);
  assert.equal(thread.provider, 'pi'); assert.equal(thread.model, 'model-one');
  const end = Date.now() + 4000;
  while (!h.events(thread.id).some(e => e.type === 'turn.completed')) { if (Date.now() > end) throw new Error('Pi runner did not finish'); await new Promise(r => setTimeout(r, 5)); }
  assert.ok(h.events(thread.id).some(e => e.type === 'assistant.text' && e.text === 'final:hello'));
  await h.runner.shutdown(); await live?.end({ hard: true }); assert.equal(owned.size, 0);
});
