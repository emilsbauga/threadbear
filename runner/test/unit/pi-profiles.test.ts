import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, writeRunnerJson } from '../../src/config.ts';
import { parsePiProfiles } from '../../src/pi-profiles.ts';
import { isAgentEngine, isProvider, PROVIDERS } from '../../src/protocol.ts';
import { FakeAccounts, makeHarness, tmpDir, withCodex } from '../helpers/fakes.ts';

const profile = () => ({ id: 'pi-local', connection: { provider: 'ollama', model: 'test/model' } });

test('Pi is a configured engine without changing runnable providers', () => {
  assert.equal(isAgentEngine('pi'), true);
  assert.equal(isAgentEngine('codex'), true);
  assert.equal(isAgentEngine('other'), false);
  assert.equal(isProvider('pi'), true);
  assert.deepEqual(PROVIDERS, ['claude', 'codex', 'pi', 'cursor', 'opencode']);
});

test('Pi configuration is opt-in and does not create or read profile files', () => {
  const home = tmpDir();
  assert.deepEqual(parsePiProfiles(undefined, home), []);
  assert.deepEqual(parsePiProfiles({ enabled: false, profiles: 'invalid' }, home), []);
  const profiles = parsePiProfiles({ profiles: [profile()] }, home);
  assert.deepEqual(profiles, [{ ...profile(), engine: 'pi', title: 'pi-local', executable: 'pi', configDir: path.join(home, 'pi/profiles/pi-local'), capabilities: { threads: true } }]);
  assert.equal(fs.existsSync(path.join(home, 'pi')), false);
});

test('Pi profiles keep connection/model identity separate and only expose allowlisted metadata', () => {
  const [p] = parsePiProfiles({ path: '~/bin/pi', profiles: [{ ...profile(), title: ' Local ', configDir: '~/custom-pi', apiKey: 'SECRET_SENTINEL', connection: { provider: 'openrouter', model: 'vendor/model', apiKey: 'SECRET_SENTINEL' } }] }, tmpDir());
  assert.equal(p.executable, path.join(os.homedir(), 'bin/pi'));
  assert.equal(p.configDir, path.join(os.homedir(), 'custom-pi'));
  assert.equal(p.title, 'Local');
  assert.deepEqual(p.connection, { provider: 'openrouter', model: 'vendor/model' });
  assert.equal(JSON.stringify(p).includes('SECRET_SENTINEL'), false);
});

test('invalid active profiles fail with a location, disabled profiles are ignored', () => {
  const home = tmpDir();
  for (const raw of [[], { profiles: {} }, { path: 'pi --unsafe', profiles: [profile()] }, { profiles: [profile(), profile()] }, { profiles: [{ ...profile(), id: '../escape' }] }, { profiles: [{ ...profile(), configDir: 'relative' }] }, { profiles: [{ ...profile(), connection: { provider: 'ollama', model: '' } }] }]) {
    assert.throws(() => parsePiProfiles(raw, home), /pi[.\[]/);
  }
  assert.deepEqual(parsePiProfiles({ profiles: [{ enabled: false }] }, home), []);
});

test('Pi tool context overrides are optional, allowlisted and validated', () => {
  for (const toolContext of ['auto', 'compact', 'full']) {
    assert.equal(parsePiProfiles({ profiles: [{ ...profile(), toolContext }] }, tmpDir())[0].toolContext, toolContext);
  }
  for (const toolContext of ['invalid', 1, ['auto'], null]) {
    assert.throws(() => parsePiProfiles({ profiles: [{ ...profile(), toolContext }] }, tmpDir()), /toolContext/);
  }
});

test('runner config advertises Pi profiles in hello without modifying Claude/Codex accounts or defaults', async () => {
  const home = tmpDir();
  writeRunnerJson(home, { pi: { profiles: [profile()] } });
  const cfg = loadConfig({ THREADBEAR_HOME: home, THREADBEAR_CONNECTORS_URL: 'off' });
  const h = makeHarness(home, { piProfiles: cfg.piProfiles }, { accounts: new FakeAccounts(withCodex()) });
  const hello = h.runner.hello();
  assert.equal(hello.piProfiles?.[0].engine, 'pi');
  assert.deepEqual([...new Set(hello.accounts.map(a => a.provider))], ['claude', 'codex']);
  const old = makeHarness(undefined, {}, { accounts: new FakeAccounts(withCodex()) });
  assert.deepEqual(hello.accounts, old.runner.hello().accounts);
  assert.deepEqual(hello.defaults, { ...old.runner.hello().defaults, cwd: h.cfg.defaults.cwd });
  assert.equal(h.adapter.sessions.length, 0);
  assert.equal(h.codex.sessions.length, 0);
  assert.equal('piProfiles' in old.runner.hello(), false);
  assert.equal(h.runner.create({ text: 'test', accountId: 'claude-main' }).thread.provider, 'claude');
  assert.equal(h.runner.create({ text: 'test', accountId: 'codex-main' }).thread.provider, 'codex');
  assert.equal(h.adapter.sessions.length, 1);
  assert.equal(h.codex.sessions.length, 1);
  await h.runner.shutdown();
  await old.runner.shutdown();
});
