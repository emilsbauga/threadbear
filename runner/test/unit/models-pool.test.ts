// Small-model calls on a Claude pool (models/claude-pool.ts and the pool
// routes in models/index.ts): which login answers, moving on when one is
// out of room, saying why when none can, and the CLI's own arguments and
// answers. The CLI is a fake: a function here, and a script standing in
// for the claude binary for askCli itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, testConfig } from '../helpers/fakes.ts';
import { FakeClock } from '../../src/clock.ts';
import { ensureHome, readRunnerJson } from '../../src/config.ts';
import { nullLogger } from '../../src/log.ts';
import { Models } from '../../src/models/index.ts';
import type { ModelSettings } from '../../src/models/index.ts';
import { askCli, cliArgs, readReply } from '../../src/models/claude-pool.ts';
import type { CliRequest, CliResponse } from '../../src/models/claude-pool.ts';
import { ledgerPath } from '../../src/models/ledger.ts';
import { SettingsService, settingsMethods } from '../../src/settings.ts';
import type { Account, Pool, Provider } from '../../src/protocol.ts';
import type { Asker } from '../../src/models/acp-oneshot.ts';
import { skipOnWindows } from '../helpers/platform.ts';

function acct(id: string, opts: { provider?: Provider; room?: number; blocked?: boolean } = {}): Account {
  const a: Account = { id, provider: opts.provider ?? 'claude', title: id, configDir: `/tmp/no-such/${id}` };
  if (opts.room !== undefined || opts.blocked) {
    a.usage = {
      windows: opts.room === undefined ? [] : [{ kind: 'five_hour', title: '5-hour', remainingPercent: opts.room }],
      readAt: new Date().toISOString(),
      source: 'live',
      ...(opts.blocked ? { blocked: true } : {}),
    };
  }
  return a;
}

type Reply = CliResponse | ((req: CliRequest) => CliResponse | Promise<CliResponse>);

function setup(o: { accounts?: Account[]; pools?: Pool[]; pool?: string | null; providers?: Provider[] | null; replies?: Reply[]; askers?: Partial<Record<Provider, Asker>> } = {}) {
  const home = tmpDir();
  ensureHome(home);
  let accounts = o.accounts ?? [acct('claude-main', { room: 50 }), acct('claude-1', { room: 80 }), acct('claude-2', { room: 90 }), acct('codex-main', { provider: 'codex', room: 90 })];
  const pools = o.pools ?? [
    { id: 'claude', title: 'Claude', accountIds: ['claude-main', 'claude-1'] },
    { id: 'work', title: 'Work', accountIds: ['claude-2'] },
    { id: 'everything', title: 'Everything', accountIds: ['codex-main', 'claude-main'] },
  ];
  const settings: ModelSettings = { privateFolders: [], pool: o.pool === undefined ? 'claude' : o.pool, ...(o.providers !== undefined ? { providers: o.providers } : {}) };
  const cli: CliRequest[] = [];
  const ranDry: string[] = [];
  const replies = [...(o.replies ?? [])];
  const models = new Models({
    home,
    clock: new FakeClock(),
    log: nullLogger,
    settings: () => settings,
    claudePath: '/fake/claude',
    askers: o.askers,
    poolHost: {
      pool: (id) => {
        const pool = pools.find((p) => p.id === id);
        return pool ? { pool, accounts: pool.accountIds.map((x) => accounts.find((a) => a.id === x)).filter((a): a is Account => !!a) } : undefined;
      },
      ranDry: (id) => {
        ranDry.push(id);
        accounts = accounts.map((a) => (a.id === id ? { ...a, usage: { windows: [], readAt: '', source: 'live' as const, blocked: true } } : a));
      },
    },
    askCli: async (req) => {
      cli.push(req);
      const r = replies.shift() ?? { ok: true, text: 'ok' };
      return typeof r === 'function' ? r(req) : r;
    },
  });
  const ledger = () => (fs.existsSync(ledgerPath(home)) ? fs.readFileSync(ledgerPath(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { home, settings, models, cli, ranDry, ledger, setAccounts: (a: Account[]) => (accounts = a) };
}

test('pool: a call runs on the pool login with the most room, and the usage file says which, without the text', async () => {
  const s = setup({ replies: [{ ok: true, text: ' Librarian picks a pool \n', inputTokens: 667, outputTokens: 15, notionalUsd: 0.00026 }] });
  const r = await s.models.generate({ feature: 'titles', prompt: 'secret words', system: 'Name it' });
  assert.ok(r.ok);
  assert.equal(r.value, 'Librarian picks a pool');
  assert.equal(r.model, 'claude-haiku-5-5 on claude-1');
  assert.equal(r.tokens, 682);
  assert.equal(r.notionalUsd, 0.00026);
  assert.equal(s.cli.length, 1);
  assert.equal(s.cli[0].account.id, 'claude-1');
  assert.equal(s.cli[0].model, 'claude-haiku-5-5');
  assert.equal(s.cli[0].system, 'Name it');
  assert.equal(s.cli[0].user, 'secret words');
  assert.equal(s.cli[0].cwd, path.join(s.home, 'models', 'cli'));
  const lines = s.ledger();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].accountId, 'claude-1');
  assert.equal(lines[0].notionalUsd, 0.00026);
  assert.equal(lines[0].costUsd, undefined, 'not spent');
  assert.ok(!JSON.stringify(lines).includes('secret'));
});

test('pool: it stays on the login it used last while that has room, then moves', async () => {
  const s = setup();
  await s.models.generate({ feature: 'titles', prompt: 'a' });
  assert.equal(s.cli[0].account.id, 'claude-1');
  // claude-main now has more room, but claude-1 is still fine: stay.
  s.setAccounts([acct('claude-main', { room: 95 }), acct('claude-1', { room: 40 })]);
  await s.models.generate({ feature: 'titles', prompt: 'b' });
  assert.equal(s.cli[1].account.id, 'claude-1');
  // Under 1%: move.
  s.setAccounts([acct('claude-main', { room: 95 }), acct('claude-1', { room: 0.5 })]);
  await s.models.generate({ feature: 'titles', prompt: 'c' });
  assert.equal(s.cli[2].account.id, 'claude-main');
});

test('pool: a login that answers it is out of room counts as run dry, and the next one answers', async () => {
  const s = setup({ replies: [{ ok: false, timedOut: false, limit: true, message: "claude: You've hit your limit" }, { ok: true, text: 'Title' }] });
  const r = await s.models.generate({ feature: 'titles', prompt: 'a' });
  assert.ok(r.ok);
  assert.deepEqual(s.cli.map((c) => c.account.id), ['claude-1', 'claude-main']);
  assert.deepEqual(s.ranDry, ['claude-1']);
  const lines = s.ledger();
  assert.deepEqual(lines.map((l) => [l.accountId, l.ok]), [['claude-1', false], ['claude-main', true]]);
});

test('pool: with every login out of room it says no-room, though a pool is there', async () => {
  const s = setup({ accounts: [acct('claude-main', { room: 0.3 }), acct('claude-1', { blocked: true })] });
  const r = await s.models.generate({ feature: 'projects', prompt: 'a' });
  assert.equal(r.ok ? 'sent' : r.reason, 'no-room');
  assert.match(r.ok ? '' : r.message, /Every login in Claude is out of room/);
  assert.equal(s.cli.length, 0);
  assert.equal(s.models.unavailable(), undefined, 'a pool with a Claude login is there, just out of room');
});

test('pool: a login that fails some other way says so, and is not counted as run dry', async () => {
  const s = setup({ replies: [{ ok: false, timedOut: false, limit: false, message: 'claude: something broke' }] });
  const r = await s.models.generate({ feature: 'titles', prompt: 'a' });
  assert.equal(r.ok ? 'sent' : r.reason, 'provider');
  assert.match(r.ok ? '' : r.message, /something broke/);
  assert.equal(s.cli.length, 1);
  assert.equal(s.ranDry.length, 0);

  const slow = setup({ replies: [{ ok: false, timedOut: true, limit: false, message: 'claude: timed out' }] });
  const r2 = await slow.models.generate({ feature: 'titles', prompt: 'a' });
  assert.equal(r2.ok ? 'sent' : r2.reason, 'timeout');
});

test('pool: null, a pool that is gone or one with no small-job login says no-pool, and unavailable() says so', async () => {
  for (const pool of [null, 'nope', 'cursor-only']) {
    const s = setup({
      pool,
      accounts: [acct('claude-main', { room: 50 }), acct('cursor-main', { provider: 'cursor' })],
      pools: [{ id: 'claude', title: 'Claude', accountIds: ['claude-main'] }, { id: 'cursor-only', title: 'Cursor', accountIds: ['cursor-main'] }],
    });
    assert.equal(s.models.unavailable(), 'Needs a pool to run on', String(pool));
    const r = await s.models.generate({ feature: 'titles', prompt: 'a' });
    assert.equal(r.ok ? 'sent' : r.reason, 'no-pool', String(pool));
    assert.equal(s.cli.length, 0);
  }
  assert.equal(setup().models.unavailable(), undefined, 'a pool with a Claude login is enough');
});

test('pool: only the pool\'s Claude logins are used, never a noted login outside it or a Codex one', async () => {
  const s = setup({ pool: 'everything' });
  await s.models.generate({ feature: 'titles', prompt: 'a' });
  assert.deepEqual(s.cli.map((c) => c.account.id), ['claude-main']);
  const work = setup({ pool: 'work' });
  await work.models.generate({ feature: 'titles', prompt: 'a' });
  assert.deepEqual(work.cli.map((c) => c.account.id), ['claude-2'], 'only when Alex picks that pool');
});

test('pool: when Claude logins in a mixed pool are out of room, small jobs spill over in pool order and return to Claude once it has room', async () => {
  const grokSeen: string[] = [];
  const ocSeen: string[] = [];
  let grokReply: CliResponse = { ok: true, text: 'From Grok' };
  const s = setup({
    pool: 'main',
    pools: [
      { id: 'main', title: 'Main', accountIds: ['claude-1', 'claude-3', 'antigravity-main', 'grok-main', 'codex-main', 'opencode-main'] },
      // Separate pool (e.g. Work): must never be touched even when Main is dry.
      { id: 'work', title: 'Work', accountIds: ['claude-2'] },
    ],
    accounts: [
      acct('claude-1', { blocked: true }),
      acct('claude-3', { room: 0.4 }),
      acct('antigravity-main', { provider: 'antigravity', room: 50 }),
      acct('grok-main', { provider: 'grok', room: 100 }),
      acct('codex-main', { provider: 'codex', room: 80 }),
      acct('opencode-main', { provider: 'opencode' }),
      acct('claude-2', { room: 90 }),
    ],
    askers: {
      grok: async (req) => {
        grokSeen.push(req.account.id);
        return grokReply;
      },
      opencode: async (req) => {
        ocSeen.push(req.account.id);
        return { ok: true, text: 'From OpenCode' };
      },
      // Defense in depth: an asker for a smallJobs: false provider is never called.
      antigravity: async () => {
        throw new Error('antigravity must never take small jobs');
      },
    },
  });

  // 1. Both Claude logins are out of room -> spills to Grok (first small-job provider in Main after Claude).
  const r1 = await s.models.generate({ feature: 'wake-when', prompt: 'after Christmas', strong: true });
  assert.ok(r1.ok);
  assert.equal(r1.value, 'From Grok');
  assert.equal(r1.model, 'grok default on grok-main', 'non-Claude answer never claims OPUS');
  assert.equal(s.cli.length, 0);
  assert.deepEqual(grokSeen, ['grok-main']);
  assert.deepEqual(ocSeen, []);
  assert.equal(s.ledger().at(-1).model, 'grok default');

  // 2. Grok hits its limit -> marked ranDry and spills on to OpenCode in Main.
  grokReply = { ok: false, timedOut: false, limit: true, message: 'grok-main is out of Grok usage (402)' };
  const r2 = await s.models.generate({ feature: 'titles', prompt: 'hello' });
  assert.ok(r2.ok);
  assert.equal(r2.value, 'From OpenCode');
  assert.equal(r2.model, 'opencode default on opencode-main');
  assert.deepEqual(s.ranDry, ['grok-main']);
  assert.deepEqual(ocSeen, ['opencode-main']);
  assert.equal(s.ledger().at(-1).model, 'opencode default');

  // 3. Once a Claude login in Main has room again, small jobs return to Claude first.
  s.setAccounts([
    acct('claude-1', { room: 60 }),
    acct('claude-3', { room: 0.4 }),
    acct('grok-main', { provider: 'grok', room: 100 }),
    acct('opencode-main', { provider: 'opencode' }),
    acct('claude-2', { room: 90 }),
  ]);
  const r3 = await s.models.generate({ feature: 'titles', prompt: 'back on claude' });
  assert.ok(r3.ok);
  assert.equal(r3.model, 'claude-haiku-5-5 on claude-1');
  assert.deepEqual(s.cli.map((c) => c.account.id), ['claude-1']);
});

test('pool: a non-limit error on one provider spills to the next small-job provider in the pool, never into another pool', async () => {
  const ocSeen: string[] = [];
  const s = setup({
    pool: 'main',
    pools: [
      { id: 'main', title: 'Main', accountIds: ['claude-1', 'claude-3', 'grok-main', 'opencode-main'] },
      { id: 'work', title: 'Work', accountIds: ['claude-2'] },
    ],
    accounts: [
      acct('claude-1', { blocked: true }),
      acct('claude-3', { blocked: true }),
      acct('grok-main', { provider: 'grok', room: 100 }),
      acct('opencode-main', { provider: 'opencode' }),
      acct('claude-2', { room: 90 }),
    ],
    askers: {
      grok: async () => ({ ok: false, timedOut: false, limit: false, message: 'Grok needs a sign-in: grok login.' }),
      opencode: async (req) => {
        ocSeen.push(req.account.id);
        return { ok: true, text: 'Recovered on OpenCode' };
      },
    },
  });

  const r = await s.models.generate({ feature: 'titles', prompt: 'a' });
  assert.ok(r.ok);
  assert.equal(r.value, 'Recovered on OpenCode');
  assert.equal(r.model, 'opencode default on opencode-main');
  assert.deepEqual(s.ranDry, [], 'non-limit error does not mark login ranDry');
  assert.deepEqual(ocSeen, ['opencode-main']);
  assert.deepEqual(s.cli, [], 'work pool claude-2 was never touched');

  // If every small-job login in Main is out of room, it fails with no-room rather than touching Work.
  const dry = setup({
    pool: 'main',
    pools: [
      { id: 'main', title: 'Main', accountIds: ['claude-1', 'codex-main'] },
      { id: 'work', title: 'Work', accountIds: ['claude-2'] },
    ],
    accounts: [acct('claude-1', { blocked: true }), acct('codex-main', { provider: 'codex', room: 90 }), acct('claude-2', { room: 95 })],
  });
  const rDry = await dry.models.generate({ feature: 'titles', prompt: 'a' });
  assert.equal(rDry.ok ? 'sent' : rDry.reason, 'no-room');
  assert.match(rDry.ok ? '' : rDry.message, /Every login in Main is out of room/);
  assert.deepEqual(dry.cli, []);
});

test('pool: classify and extract ask for structured output and read it', async () => {
  const s = setup({ replies: [{ ok: true, text: '{"label":"bug"}' }, { ok: true, text: '{"name":"Walkies","owner":null}' }] });
  const c = await s.models.classify({ feature: 't', text: 'Fix the login bug', labels: ['bug', 'feature'] });
  assert.ok(c.ok);
  assert.equal(c.value, 'bug');
  assert.deepEqual((s.cli[0].jsonSchema as any).properties.label.enum, ['bug', 'feature']);
  const e = await s.models.extract({ feature: 't', text: 'Walkies', fields: { name: 'the app', owner: 'who owns it' } });
  assert.ok(e.ok);
  assert.deepEqual(e.value, { name: 'Walkies', owner: null });
  assert.deepEqual((s.cli[1].jsonSchema as any).required, ['name', 'owner']);
});

test('pool: private folders never reach the pool either', async () => {
  const s = setup();
  s.settings.privateFolders = ['/work/client'];
  const r = await s.models.generate({ feature: 'titles', prompt: 'a', cwd: '/work/client/app' });
  assert.equal(r.ok ? 'sent' : r.reason, 'private');
  assert.equal(s.cli.length, 0);
});

test('pool: at most 2 CLIs at once', async () => {
  let live = 0;
  let most = 0;
  const releases: (() => void)[] = [];
  const slow: Reply = () =>
    new Promise<CliResponse>((resolve) => {
      live++;
      most = Math.max(most, live);
      releases.push(() => {
        live--;
        resolve({ ok: true, text: 'x' });
      });
    });
  const s = setup({ replies: [slow, slow, slow, slow] });
  const calls = [1, 2, 3, 4].map((i) => s.models.generate({ feature: 't', prompt: String(i) }));
  for (let i = 0; i < 20 && releases.length < 4; i++) {
    await new Promise((r) => setImmediate(r));
    releases.splice(0).forEach((f) => f());
  }
  const results = await Promise.all(calls);
  assert.ok(results.every((r) => r.ok));
  assert.equal(most, 2);
});

test('pool: Codex answers after Claude by default even when listed later in the pool, and custom models.providers controls the exact order and inclusion', async () => {
  const seen: string[] = [];
  let codexReply: CliResponse = { ok: true, text: 'From Codex' };
  const s = setup({
    pool: 'main',
    pools: [{ id: 'main', title: 'Main', accountIds: ['claude-1', 'grok-main', 'codex-main', 'opencode-main'] }],
    accounts: [
      acct('claude-1', { blocked: true }),
      acct('grok-main', { provider: 'grok', room: 100 }),
      acct('codex-main', { provider: 'codex', room: 80 }),
      acct('opencode-main', { provider: 'opencode' }),
    ],
    askers: {
      codex: async (req) => {
        seen.push(`codex:${req.account.id}`);
        return codexReply;
      },
      grok: async (req) => {
        seen.push(`grok:${req.account.id}`);
        return { ok: true, text: 'From Grok' };
      },
      opencode: async (req) => {
        seen.push(`opencode:${req.account.id}`);
        return { ok: true, text: 'From OpenCode' };
      },
    },
  });

  // Default order: Claude -> Codex -> pool order (Grok, OpenCode).
  const r1 = await s.models.generate({ feature: 'titles', prompt: 'hello' });
  assert.ok(r1.ok);
  assert.equal(r1.value, 'From Codex');
  assert.equal(r1.model, 'codex default on codex-main');
  assert.deepEqual(seen, ['codex:codex-main']);

  // Custom order: Grok first, then Codex (omitting OpenCode and Claude).
  s.settings.providers = ['grok', 'codex'];
  s.setAccounts([
    acct('claude-1', { room: 90 }),
    acct('grok-main', { provider: 'grok', room: 100 }),
    acct('codex-main', { provider: 'codex', room: 80 }),
    acct('opencode-main', { provider: 'opencode' }),
  ]);
  const r2 = await s.models.generate({ feature: 'titles', prompt: 'custom first' });
  assert.ok(r2.ok);
  assert.equal(r2.value, 'From Grok');
  assert.equal(s.cli.length, 0, 'Claude was omitted from custom models.providers');

  // If both listed providers are dry, omitted providers (Claude, OpenCode) are not touched.
  s.setAccounts([
    acct('claude-1', { room: 90 }),
    acct('grok-main', { provider: 'grok', blocked: true }),
    acct('codex-main', { provider: 'codex', blocked: true }),
    acct('opencode-main', { provider: 'opencode' }),
  ]);
  const r3 = await s.models.generate({ feature: 'titles', prompt: 'all listed dry' });
  assert.equal(r3.ok ? 'sent' : r3.reason, 'no-room');
  assert.equal(s.cli.length, 0);

  // Explicit empty custom list reports no-pool.
  s.settings.providers = [];
  assert.equal(s.models.unavailable(), 'Needs a pool to run on');
  const r4 = await s.models.generate({ feature: 'titles', prompt: 'empty' });
  assert.equal(r4.ok ? 'sent' : r4.reason, 'no-pool');

  // Resetting to null restores default order (Claude first when it has room).
  s.settings.providers = null;
  codexReply = { ok: true, text: 'Unused' };
  const r5 = await s.models.generate({ feature: 'titles', prompt: 'reset' });
  assert.ok(r5.ok);
  assert.equal(r5.model, 'claude-haiku-5-5 on claude-1');
});

test('settings: models.pool is a pool id or null, and models.providers validates, deduplicates and resets', () => {
  const home = tmpDir();
  ensureHome(home);
  const cfg = testConfig(home);
  const svc = new SettingsService({ config: cfg, publish: () => {}, poolIds: () => ['claude', 'work'] });
  const m = settingsMethods(svc);
  assert.equal(svc.get().models.pool, 'claude');
  assert.equal(svc.get().models.providers, null);
  assert.throws(() => m['settings.update']({ models: { pool: 'nope' } }), /No pool called nope. Pools: claude, work/);
  assert.throws(() => m['settings.update']({ models: { pool: 3 } }), /pool id or null/);
  assert.throws(() => m['settings.update']({ models: { providers: 'codex' } }), /list of providers or null/);
  assert.throws(() => m['settings.update']({ models: { providers: ['cursor'] } }), /models\.providers entries must be one of/);
  assert.throws(() => m['settings.update']({ models: { providers: ['antigravity'] } }), /models\.providers entries must be one of/);
  m['settings.update']({ models: { pool: 'work', providers: ['codex', 'claude', 'codex', 'grok'] } });
  assert.equal(cfg.models.pool, 'work');
  assert.deepEqual(cfg.models.providers, ['codex', 'claude', 'grok']);
  assert.deepEqual(svc.get().models.providers, ['codex', 'claude', 'grok']);
  assert.equal(readRunnerJson(home).models?.pool, 'work');
  assert.deepEqual(readRunnerJson(home).models?.providers, ['codex', 'claude', 'grok']);
  m['settings.update']({ models: { pool: null, providers: null } });
  assert.equal(svc.get().models.pool, null);
  assert.equal(svc.get().models.providers, null);
  assert.equal(readRunnerJson(home).models?.pool, null);
  assert.equal(readRunnerJson(home).models?.providers, undefined);
});

test('cli: the arguments keep everything of Alex\'s setup out and never use --bare', () => {
  const args = cliArgs({ model: 'claude-haiku-5-5', system: 'Name it', jsonSchema: { type: 'object' } });
  for (const flag of ['-p', '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(args.includes(flag), flag);
  const after = (f: string) => args[args.indexOf(f) + 1];
  assert.equal(after('--model'), 'claude-haiku-5-5');
  assert.equal(after('--mcp-config'), '{"mcpServers":{}}');
  assert.equal(after('--tools'), '');
  assert.equal(after('--setting-sources'), '');
  assert.equal(after('--effort'), 'low');
  assert.equal(after('--output-format'), 'json');
  assert.equal(after('--system-prompt'), 'Name it');
  assert.equal(after('--json-schema'), '{"type":"object"}');
  assert.ok(!args.includes('--bare'), '--bare skips the keychain, where the login is');
  assert.notEqual(cliArgs({ model: 'm' })[cliArgs({ model: 'm' }).indexOf('--system-prompt') + 1], '', 'never the CLI\'s own long system prompt');
});

test('cli: readReply reads answers, structured output, limits and errors', () => {
  const ok = readReply('{"subtype":"success","is_error":false,"result":"Title","total_cost_usd":0.0003,"usage":{"input_tokens":2,"cache_read_input_tokens":665,"output_tokens":15}}\n', '', 0);
  assert.deepEqual(ok, { ok: true, text: 'Title', inputTokens: 667, outputTokens: 15, notionalUsd: 0.0003 });
  const structured = readReply('{"subtype":"success","is_error":false,"result":"{\\"label\\":\\"bug\\"}","structured_output":{"label":"bug"}}', '', 0);
  assert.equal(structured.ok && structured.text, '{"label":"bug"}');
  const limit = readReply('{"subtype":"success","is_error":true,"result":"You\'ve hit your limit · resets 5am"}', '', 1);
  assert.equal(!limit.ok && limit.limit, true);
  const status = readReply('{"subtype":"success","is_error":true,"result":"Rate limited","api_error_status":429}', '', 1);
  assert.equal(!status.ok && status.limit, true);
  const bad = readReply('[claude-code:unrecognized_model] {"model":"x"}\n{"subtype":"success","is_error":true,"result":"There\'s an issue with the selected model","api_error_status":404}', '', 0);
  assert.equal(!bad.ok && bad.limit, false);
  assert.match(!bad.ok ? bad.message : '', /issue with the selected model/);
  const garbage = readReply('', 'Error: not logged in\n', 1);
  assert.equal(garbage.ok, false);
  assert.match(!garbage.ok ? garbage.message : '', /exited 1 with no answer: Error: not logged in/);
});

// A stand-in for the claude binary: echoes what it was given as a CLI
// answer, or sleeps for ever when told to.
function fakeClaude(dir: string): string {
  const file = path.join(dir, 'claude');
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (input === 'hang') return setInterval(() => {}, 1000);
  const answer = { input, args: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR ?? null, cwd: process.cwd() };
  console.log(JSON.stringify({ subtype: 'success', is_error: false, result: JSON.stringify(answer), usage: { input_tokens: 1, output_tokens: 1 } }));
});
`,
    { mode: 0o755 },
  );
  return file;
}

test('cli: askCli sends the prompt on stdin, runs in the empty folder on the login\'s config dir, and times out', skipOnWindows('askCli starts claude itself, and Windows cannot start a script as a program (the real one is claude.exe)'), async () => {
  const dir = tmpDir();
  const claudePath = fakeClaude(dir);
  const added: number[] = [];
  const removed: number[] = [];
  const registry = { add: (pid: number) => added.push(pid), remove: (pid: number) => removed.push(pid) };
  const cwd = path.join(dir, 'models', 'cli');
  const account = { ...acct('claude-1'), configDir: path.join(dir, 'claude-1') };
  const r = await askCli({ claudePath, account, model: 'claude-haiku-5-5', system: 'S', user: 'a long thread\nwith lines', cwd, timeoutMs: 10_000, registry });
  assert.ok(r.ok, !r.ok ? r.message : '');
  const seen = JSON.parse(r.text);
  assert.equal(seen.input, 'a long thread\nwith lines');
  assert.ok(!seen.args.includes('a long thread\nwith lines'), 'the prompt is not an argument');
  assert.equal(seen.configDir, account.configDir);
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(cwd));
  assert.equal(added.length, 1);
  assert.deepEqual(removed, added);

  const hung = await askCli({ claudePath, account, model: 'm', user: 'hang', cwd, timeoutMs: 300, registry });
  assert.equal(!hung.ok && hung.timedOut, true);
  assert.equal(removed.length, 2);
});
