import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiAdapter } from '../../src/adapters/pi/adapter.ts';
import { nullLogger } from '../../src/log.ts';
import type { Account, PiProfile } from '../../src/protocol.ts';
import { tmpDir } from '../helpers/fakes.ts';

const fixture = fileURLToPath(new URL('../fixtures/pi-rpc.mjs', import.meta.url));
function setup(mode = '') {
  const root = tmpDir(), configDir = path.join(root, 'config'), owned = new Set<number>();
  const account: Account = { id: 'pi:router', provider: 'pi', title: 'Pi', configDir };
  const profile: PiProfile = { id: 'router', engine: 'pi', title: 'Pi', executable: process.execPath, configDir, connection: { provider: 'openrouter', model: 'vendor/one' }, capabilities: { threads: true } };
  const adapter = new PiAdapter({ profileFor: id => id === account.id ? profile : undefined, args: [fixture, '--fixture-mode', mode], requestTimeoutMs: 200, shutdownTimeoutMs: 100, log: nullLogger, registry: { add: p => owned.add(p), remove: p => owned.delete(p) } });
  return { account, adapter, configDir, owned };
}

test('Pi discovers all models for one inference provider, with safe metadata and no prompt/tools/session', async () => {
  const h = setup();
  assert.deepEqual(await h.adapter.models(h.account), [
    { id: 'vendor/one', model: 'vendor/one', title: 'Model One', effortLevels: [] },
    { id: 'vendor/two', model: 'vendor/two', title: 'Model Two', effortLevels: [] },
  ]);
  const launch = JSON.parse(fs.readFileSync(path.join(h.configDir, 'launch.json'), 'utf8'));
  for (const flag of ['--no-tools', '--no-mcp', '--no-extensions', '--no-skills', '--no-context-files', '--no-session', '--offline']) assert.ok(launch.args.includes(flag), flag);
  const commands = fs.readFileSync(path.join(h.configDir, 'commands.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s).type);
  assert.deepEqual(commands, ['get_available_models']);
  assert.equal(fs.existsSync(launch.cwd), false, 'temporary discovery folder is removed');
  assert.equal(h.owned.size, 0);
});

test('Pi model probes fail cleanly on malformed responses, timeout or unavailable profiles', async () => {
  for (const mode of ['models-malformed', 'models-hang']) {
    const h = setup(mode);
    await assert.rejects(h.adapter.models(h.account), /no model list|timed out/);
    assert.equal(h.owned.size, 0);
    const launch = JSON.parse(fs.readFileSync(path.join(h.configDir, 'launch.json'), 'utf8'));
    assert.equal(fs.existsSync(launch.cwd), false);
  }
  const h = setup();
  await assert.rejects(h.adapter.models({ ...h.account, id: 'pi:missing' }), /unavailable/);
});
