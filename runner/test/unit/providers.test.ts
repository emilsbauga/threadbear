// The table of what each provider is called and can do (providers.ts). The
// runner's checks and the app read this rather than comparing provider names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverAccounts } from '../../src/accounts.ts';
import { readPools } from '../../src/pools.ts';
import { cliName, PROVIDER_INFO, providerInfo, providerName, providersForHello } from '../../src/providers.ts';
import { PROVIDERS, type Account } from '../../src/protocol.ts';
import { FakeAccounts, makeHarness, withCodex } from '../helpers/fakes.ts';

test('every provider has a row, under its own id', () => {
  for (const p of PROVIDERS) assert.equal(PROVIDER_INFO[p].id, p);
  assert.equal(Object.keys(PROVIDER_INFO).length, PROVIDERS.length);
});

test('names stay as they were before the table', () => {
  assert.equal(providerName('claude'), 'Claude');
  assert.equal(providerName('codex'), 'Codex');
  assert.equal(cliName('claude'), 'Claude Code');
  assert.equal(cliName('codex'), 'Codex');
});

test('what Claude and Codex can each do', () => {
  assert.equal(PROVIDER_INFO.claude.autoMode, 'classifier');
  assert.equal(PROVIDER_INFO.codex.autoMode, 'asks');
  assert.equal(PROVIDER_INFO.claude.smallJobs, true);
  assert.equal(PROVIDER_INFO.codex.smallJobs, true);
  assert.equal(PROVIDER_INFO.claude.loginCommand, 'claude auth login');
  assert.equal(PROVIDER_INFO.codex.loginCommand, 'codex login');
});

test("a provider the table doesn't know can do nothing, and never reads as Claude", () => {
  // A record or another runner's hello from a build that has one more.
  const info = providerInfo('mystery');
  assert.equal(info.name, 'mystery');
  assert.equal(info.effort, 'none');
  assert.equal(info.autoMode, 'asks');
  for (const can of [info.rewind, info.smallJobs, info.usageReadings]) assert.equal(can, false);
});

test("names from Object.prototype aren't providers", () => {
  // A plain lookup would hand back the function and read its `rewind`.
  assert.equal(providerInfo('constructor').rewind, false);
  assert.equal(providerInfo('constructor').name, 'constructor');
});

test('a thread with no provider is a Claude one, as a record from before Codex', () => {
  assert.equal(providerName(undefined), 'Claude');
  assert.equal(providerName(''), 'Claude');
});

test('an installed ACP agent adds its account', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-disc-'));
  const bin = path.join(d, 'oc');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const cfg = { userHome: d, pathEnv: '', claudeMainDir: path.join(d, 'none'), claudeMainJson: path.join(d, 'none.json'), tokenStatsAccountsDir: path.join(d, 'none2'), opencodePath: bin, cursorPath: path.join(d, 'no-cursor') };
  assert.deepEqual(discoverAccounts(cfg).map((a) => a.id), ['opencode-main']);
});

test('an ACP model is only ever the one its account lists', () => {
  const oc: Account = { id: 'opencode-main', provider: 'opencode', title: 'OpenCode', configDir: '/x', models: [{ id: 'fake/one', model: 'fake/one', title: 'One' }, { id: 'gpt-9', model: 'gpt-9', title: 'G' }] };
  const h = makeHarness(undefined, {}, { accounts: new FakeAccounts([...withCodex(), oc]) });
  const claude = h.runner.hello().accounts.find((a) => a.provider === 'claude')!;
  assert.equal(h.runner.modelFits(oc, 'fake/one'), true);
  assert.equal(h.runner.modelFits(oc, 'claude-opus-5-5'), false, 'not by its name');
  assert.equal(h.runner.modelFits(claude, 'fake/one'), false);
});

test('a saved pool of only an agent this runner does not offer is gone', () => {
  const accounts: Account[] = [{ id: 'claude-main', provider: 'claude', title: 'c', configDir: '/c' }];
  const pools = [{ id: 'oc', title: 'OC', accountIds: ['opencode-main'] }, { id: 'mine', title: 'Mine', accountIds: ['claude-main', 'opencode-main'] }];
  assert.deepEqual(readPools({ pools }, accounts, {}).map((p) => p.id), ['mine']);
});

test('hello lists each provider this runner offers', () => {
  assert.deepEqual(providersForHello().map((p) => p.id), [...PROVIDERS]);
  const h = makeHarness(undefined, {}, { accounts: new FakeAccounts(withCodex()) });
  assert.deepEqual(h.runner.hello().providers.map((p) => p.name), ['Claude', 'Codex', 'Cursor', 'OpenCode', 'Grok', 'Gemini']);
});

test('what Grok can do', () => {
  const g = PROVIDER_INFO.grok;
  assert.equal(g.name, 'Grok');
  assert.equal(g.loginCommand, 'grok login');
  // Its models list their own levels, which narrow Codex's set.
  assert.equal(g.effort, 'codex');
  assert.equal(g.autoMode, 'asks');
  assert.equal(g.smallJobs, true, 'its hook denies every tool for one');
  assert.equal(g.rewind, false);
  assert.equal(g.usageReadings, true, 'its plan share, from _x.ai/billing');
});

test('a Grok thread takes an effort its model lists, and not one it does not', () => {
  const grok: Account = { id: 'grok-main', provider: 'grok', title: 'Grok', configDir: '/g', models: [{ id: 'grok-4.7', model: 'grok-4.7', title: 'Grok 4.7', effortLevels: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }, { id: 'grok-4.5', model: 'grok-4.5', title: 'Grok 4.5', effortLevels: ['low', 'medium', 'high'] }] };
  const h = makeHarness(undefined, {}, { accounts: new FakeAccounts([...withCodex(), grok]) });
  assert.deepEqual(h.runner.checkSettings(grok, 'grok-4.7', 'high'), { model: 'grok-4.7', effort: 'high', notes: [] });
  const r = h.runner.checkSettings(grok, 'grok-4.5', 'xhigh');
  assert.equal(r.effort, undefined);
  assert.equal(r.notes.length, 1);
  assert.equal(h.runner.modelFits(grok, 'claude-opus-5-5'), false);
});

test('Gemini and OpenCode threads take efforts their models list, and drop efforts for models without any', () => {
  assert.equal(PROVIDER_INFO.antigravity.effort, 'claude');
  assert.equal(PROVIDER_INFO.opencode.effort, 'claude');
  assert.equal(PROVIDER_INFO.cursor.effort, 'none');

  const agy: Account = {
    id: 'antigravity-main',
    provider: 'antigravity',
    title: 'Gemini',
    configDir: '/a',
    models: [
      { id: 'gemini-4-neon', model: 'gemini-4-neon', title: 'Gemini 4 Neon', effortLevels: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      { id: 'gemini-3.8-flash', model: 'gemini-3.8-flash', title: 'Gemini 3.8 Flash', effortLevels: ['low', 'medium', 'high'], defaultEffort: 'high' },
    ],
  };
  const oc: Account = {
    id: 'opencode-main',
    provider: 'opencode',
    title: 'OpenCode',
    configDir: '/o',
    models: [
      { id: 'opencode/gpt-6-astra', model: 'opencode/gpt-6-astra', title: 'GPT-6 Astra', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'opencode/big-pickle', model: 'opencode/big-pickle', title: 'Big Pickle' },
    ],
  };
  const h = makeHarness(undefined, {}, { accounts: new FakeAccounts([...withCodex(), agy, oc]) });
  assert.deepEqual(h.runner.checkSettings(agy, 'gemini-4-neon', 'xhigh'), { model: 'gemini-4-neon', effort: 'xhigh', notes: [] });
  const flashXhigh = h.runner.checkSettings(agy, 'gemini-3.8-flash', 'xhigh');
  assert.equal(flashXhigh.effort, undefined);
  assert.equal(flashXhigh.notes.length, 1);
  const agyUltra = h.runner.checkSettings(agy, 'gemini-4-neon', 'ultra');
  assert.equal(agyUltra.effort, undefined);
  assert.match(agyUltra.notes[0], /Codex only/);

  assert.deepEqual(h.runner.checkSettings(oc, 'opencode/gpt-6-astra', 'max'), { model: 'opencode/gpt-6-astra', effort: 'max', notes: [] });
  const pickleHigh = h.runner.checkSettings(oc, 'opencode/big-pickle', 'high');
  assert.equal(pickleHigh.effort, undefined);
  assert.match(pickleHigh.notes[0], /Big Pickle doesn't offer High effort/);
});
