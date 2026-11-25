import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { AgentArchive, BACKUP_STALE_MS, LOW_DISK_BYTES, SERVER_SERVICE, serverProblems, archiveMcpServer, archiveMethods, buildLockOf, formatArchive, readSyncState, runtimeOf, sessionsFor, SESSIONS_FILE, STALE_MS, type SessionsFile } from '../../src/agent-archive.ts';
import { mcpServerConfig } from '../../src/adapters/codex/adapter.ts';
import type { ThreadRecord } from '../../src/store.ts';
import { tmpDir } from '../helpers/fakes.ts';

const T0 = new Date('2026-11-20T00:00:00.000Z');
const T1 = new Date('2026-11-20T01:00:00.000Z');

function rec(over: Partial<ThreadRecord>): ThreadRecord {
  return { id: 't1', title: 'Fix the thing', cwd: '/repo', provider: 'claude', nativeSessionId: 's1', sessionUsed: true, ...over } as ThreadRecord;
}

const noLog = { info() {}, warn() {}, error() {}, debug() {} };

test('a thread used session goes in the file with its title, project and folder', () => {
  const f = sessionsFor([rec({ projects: [{ id: 'p1', by: 'mike', at: '' }] as ThreadRecord['projects'] })], (id) => (id === 'p1' ? 'Threadbear' : undefined), 'M5', undefined, T0);
  assert.deepEqual(f, { version: 1, runner: 'M5', sessions: [{ sessionId: 's1', agent: 'claude', threadId: 't1', title: 'Fix the thing', project: 'Threadbear', folder: '/repo', updatedAt: T0.toISOString() }] });
});

test('a session the CLI never started, and other CLIs, are left out', () => {
  const f = sessionsFor([rec({ sessionUsed: false }), rec({ id: 't2', provider: 'grok' as ThreadRecord['provider'], nativeSessionId: 's2' })], () => undefined, 'M5', undefined, T0);
  assert.deepEqual(f.sessions, []);
});

test('a project the thread left is not named', () => {
  const f = sessionsFor([rec({ projects: [{ id: 'p1', by: 'mike', at: '' }] as ThreadRecord['projects'], projectsLeft: ['p1'] })], () => 'Threadbear', 'M5', undefined, T0);
  assert.equal(f.sessions[0]!.project, undefined);
});

test('an old session is kept after a clear, and follows a rename; untouched entries keep their time', () => {
  const first = sessionsFor([rec({}), rec({ id: 't2', title: 'Other', nativeSessionId: 's9' })], () => undefined, 'M5', undefined, T0);
  const after = sessionsFor([rec({ nativeSessionId: 's2', title: 'Fixed the thing' }), rec({ id: 't2', title: 'Other', nativeSessionId: 's9' })], () => undefined, 'M5', first, T1);
  const by = new Map(after.sessions.map((s) => [s.sessionId, s]));
  assert.equal(by.get('s1')?.title, 'Fixed the thing');
  assert.equal(by.get('s1')?.updatedAt, T1.toISOString());
  assert.equal(by.get('s2')?.threadId, 't1');
  assert.equal(by.get('s9')?.updatedAt, T0.toISOString());
});

test('a Codex sub-agent thread is listed under its parent thread', () => {
  const f = sessionsFor([rec({ provider: 'codex', subagents: [{ sessionId: 'sub1' }] as ThreadRecord['subagents'] })], () => undefined, 'M5', undefined, T0);
  assert.deepEqual(f.sessions.map((s) => [s.sessionId, s.agent, s.threadId]), [['s1', 'codex', 't1'], ['sub1', 'codex', 't1']]);
});

test("every login's sessions folder is listed for the sync, once each", () => {
  const f = sessionsFor([], () => undefined, 'M5', undefined, T0, { claude: ['/b/projects', '/a/projects', '/b/projects'], codex: ['/c/sessions'] });
  assert.deepEqual(f.claudeRoots, ['/a/projects', '/b/projects']);
  assert.deepEqual(f.codexRoots, ['/c/sessions']);
  const none = sessionsFor([], () => undefined, 'M5', undefined, T0);
  assert.equal('claudeRoots' in none || 'codexRoots' in none, false);
});

test('a broken or unknown previous file is started over', () => {
  const f = sessionsFor([rec({})], () => undefined, 'M5', { version: 2 } as unknown as SessionsFile, T0);
  assert.equal(f.sessions.length, 1);
});

test('status JSON is read, and anything else is no status', () => {
  assert.equal(readSyncState('{"service":"running","failingFiles":2}')?.failingFiles, 2);
  assert.equal(readSyncState('Agent Archive service: running'), undefined);
  assert.equal(readSyncState('[1]'), undefined);
});

test('tb status says when the sync has stopped, and not before', () => {
  const now = T1.getTime();
  const ago = (ms: number) => `${Math.round(ms / 60_000)}m`;
  const ok = formatArchive({ installed: true, sessions: 3, sync: { service: 'running', archiveUrl: 'https://bruce', lastSuccessAt: now - 5 * 60_000 }, update: { by: 'server' } }, now, ago);
  assert.match(ok, /syncing to https:\/\/bruce, last synced 5m ago, 3 Threadbear sessions/);
  const stale = formatArchive({ installed: true, sessions: 3, sync: { service: 'running', lastSuccessAt: now - STALE_MS - 60_000, lastError: 'Bruce unreachable' } }, now, ago);
  assert.match(stale, /nothing synced for \d+m \(Bruce unreachable\)/);
  assert.match(formatArchive({ installed: true, sessions: 0, sync: { service: 'paused' } }, now, ago), /its sync is paused/);
  assert.match(formatArchive({ installed: true, sessions: 0, syncError: 'its sync is too old to report its status' }, now, ago), /too old/);
  assert.match(formatArchive({ installed: true, sessions: 0, sync: {}, update: { by: 'runner', failedSha: 'abcdef1234', error: 'npm ci failed' } }, now, ago), /building abcdef1 from its main failed \(npm ci failed\)/);
});

type Call = { bin: string; args: string[] };

function setup(opts: { health?: (url: string) => Promise<unknown>; platform?: string; server?: boolean; repo?: boolean; fail?: (c: Call) => boolean; hang?: (c: Call) => boolean; onLsRemote?: (home: string) => void; pushTo?: { host: string; node: string }[]; on?: () => boolean; answer?: (c: Call) => string | undefined } = {}) {
  const root = tmpDir();
  const home = path.join(root, 'home');
  const dir = path.join(root, 'aa');
  const sdir = path.join(root, 'server');
  fs.mkdirSync(home, { recursive: true });
  const { cli } = runtimeOf(dir);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(cli, '');
  if (opts.server) fs.mkdirSync(sdir);
  const calls: Call[] = [];
  let sha = 'a'.repeat(40);
  const onLsRemote = opts.onLsRemote;
  const clock = { now: T1 };
  const a = new AgentArchive({
    home,
    log: noLog,
    on: opts.on ?? (() => true),
    records: () => [rec({})],
    projectTitles: () => new Map(),
    runnerName: () => 'M5',
    loginDirs: () => [{ provider: 'claude', configDir: '/a/claude-4' }, { provider: 'codex', configDir: '/a/codex-1' }],
    settings: () => (opts.repo === false ? undefined : { repo: 'git@example:aa.git', ...(opts.pushTo ? { pushTo: opts.pushTo } : {}) }),
    dir,
    serverDir: sdir,
    cacheDir: path.join(root, 'cache'),
    now: () => clock.now,
    uid: 501,
    health: opts.health ?? (async () => ({ ok: true, release: 'c'.repeat(40) })),
    run: async (bin, args, o) => {
      const c = { bin, args };
      calls.push(c);
      if (opts.fail?.(c)) throw new Error('it broke');
      if (opts.hang?.(c)) await new Promise((_, reject) => o.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      const said = opts.answer?.(c);
      if (said !== undefined) return said;
      if (bin === 'git' && args[0] === 'ls-remote') {
        onLsRemote?.(home);
        return `${sha}\trefs/heads/main\n`;
      }
      if (args.includes('status')) return '{"service":"running","archiveUrl":"https://bruce:9443"}';
      return '';
    },
  });
  return { a, home, dir, clock, cacheDir: path.join(root, 'cache'), calls, setSha: (s: string) => (sha = s) };
}

const isInstall = (c: Call) => c.args.some((x) => x === 'install-runtime' || x.includes('install-runtime'));

test('a new commit on main is built and installed once, then pushed', async () => {
  const s = setup({ pushTo: [{ host: 'cloud', node: '/n/node' }] });
  await s.a.tick();
  const written = JSON.parse(fs.readFileSync(path.join(s.home, SESSIONS_FILE), 'utf8')) as SessionsFile;
  // Joined as the runner joins them, so Windows' backslashes match.
  assert.deepEqual([written.claudeRoots, written.codexRoots], [[path.join('/a/claude-4', 'projects')], [path.join('/a/codex-1', 'sessions')]]);
  assert.equal(s.a.status()?.sync?.service, 'running');
  assert.equal(s.calls.filter(isInstall).length, 2, 'here and on cloud');
  assert.equal(s.a.status()?.update?.sha, 'a'.repeat(40));
  assert.deepEqual(s.a.status()?.update?.pushed, { cloud: 'ok' });
  s.calls.length = 0;
  await s.a.tick();
  assert.equal(s.calls.filter(isInstall).length, 0, 'the same commit again does nothing');
});

test('a failed commit is not tried again, but the next one is', async () => {
  let failing = true;
  const s = setup({ fail: (c) => failing && c.args.includes('build:daemon') });
  await s.a.tick();
  assert.equal(s.a.status()?.update?.failedSha, 'a'.repeat(40));
  s.calls.length = 0;
  await s.a.tick();
  assert.equal(s.calls.filter((c) => c.args.includes('ci')).length, 0);
  failing = false;
  s.setSha('b'.repeat(40));
  await s.a.tick();
  assert.equal(s.a.status()?.update?.sha, 'b'.repeat(40));
});

test("a machine with the archive server leaves updates to its deployer, and no repo means no updates", async () => {
  for (const opts of [{ server: true }, { repo: false }]) {
    const s = setup(opts);
    await s.a.tick();
    assert.equal(s.calls.filter((c) => c.bin === 'git').length, 0);
  }
});

const AID = 'jx7dxftq67r8tcqe3rn7c4ehmh8gtjeb';
const hit = { threadId: AID, title: 'Move Agent Archive to Bruce', agent: 'claude', updatedAt: 1, sequence: 243, snippet: 'search in LanceDB' };

test("the sidebar's archive search runs the archive's own command, and passes its hits on", async () => {
  const s = setup({ answer: (c) => (c.args.includes('search') ? JSON.stringify({ hits: [hit, { nope: 1 }], more: true }) : undefined) });
  const m = archiveMethods(s.a);
  assert.deepEqual(await m['archive.search']!({ query: '  --lancedb ', limit: 99 }), { hits: [hit], more: true });
  const call = s.calls.find((c) => c.args.includes('search'))!;
  assert.deepEqual(call.args.slice(1), ['search', '--json', '--limit', '50', '--', '--lancedb'], 'the words after --, the limit capped');
  assert.deepEqual(await m['archive.search']!({ query: '   ' }), { hits: [], more: false });
});

test('with the experiment off or the archive not installed, the search says so and runs nothing', async () => {
  const off = setup({ on: () => false });
  assert.deepEqual(await off.a.search('x'), { hits: [], off: 'experiment' });
  const gone = setup();
  fs.rmSync(runtimeOf(gone.dir).cli);
  assert.deepEqual(await gone.a.search('x'), { hits: [], off: 'not_installed' });
  await assert.rejects(gone.a.read(AID), /isn't installed/);
  assert.equal(off.calls.length + gone.calls.length, 0);
});

test("a failed search says why in the archive's own words", async () => {
  const s = setup({ fail: (c) => c.args.includes('search') });
  s.a['d'].run = async () => {
    throw Object.assign(new Error('Command failed: node cli search'), { stderr: 'loading\nAgent Archive at https://bruce is unreachable (network)\n', code: 1 });
  };
  await assert.rejects(s.a.search('x'), /^Error: Agent Archive at https:\/\/bruce is unreachable \(network\)$/);
  s.a['d'].run = async () => '<html>';
  await assert.rejects(s.a.search('x'), /didn't answer in JSON/);
});

test('reading an archived session asks around the hit, and an unknown one is a bad request', async () => {
  const page = { thread: { threadId: AID, title: 'Move', agent: 'claude', updatedAt: 1, messages: 2 }, items: [{ sequence: 243, role: 'assistant', text: 'hi' }] };
  const s = setup({ answer: (c) => (c.args.includes('read') ? JSON.stringify(page) : undefined) });
  assert.deepEqual(await archiveMethods(s.a)['archive.read']!({ threadId: AID, around: 243 }), page);
  assert.deepEqual(s.calls.find((c) => c.args.includes('read'))!.args.slice(1), ['read', '--json', AID, '--around', '243']);
  await assert.rejects(s.a.read('../etc'), /must be an Agent Archive thread id/);
  s.a['d'].run = async () => {
    throw Object.assign(new Error('x'), { stderr: 'not_found: no thread ' + AID, code: 2 });
  };
  await assert.rejects(s.a.read(AID), (e: Error & { code?: number }) => e.code === -32602 && /doesn't have that session/.test(e.message));
});

test("every thread gets the archive's MCP server once it's installed, Codex's as config overrides", () => {
  const dir = path.join(tmpDir(), 'aa');
  assert.equal(archiveMcpServer(dir), undefined);
  const { node, cli } = runtimeOf(dir);
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(node, '');
  fs.writeFileSync(cli, '');
  const server = archiveMcpServer(dir)!;
  assert.deepEqual(server, { command: node, args: [cli, 'mcp'] });
  assert.deepEqual(mcpServerConfig({ 'agent-archive': server }), { 'mcp_servers.agent-archive.command': node, 'mcp_servers.agent-archive.args': [cli, 'mcp'] });
  assert.deepEqual(mcpServerConfig(), {});
});

// THREADBEAR-2J: after a handover, the draining runner and the new one both
// built the same commit in the one cache folder; npm ci's renames clashed
// (ENOTEMPTY) and the loser marked a commit the winner had installed as failed.
const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');

test('while another runner is building the sync, this one leaves it alone and marks nothing failed', async () => {
  const s = setup();
  const { dir, name } = buildLockOf(s.cacheDir);
  const code = `import { acquireLock } from ${JSON.stringify(pathToFileURL(path.join(RUNNER_DIR, 'src', 'lock.ts')).href)}; acquireLock(process.argv[1], process.argv[2]); console.log('held'); setInterval(() => {}, 1000);`;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', code, dir, name], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((r) => holder.stdout!.once('data', r));
    await s.a.tick();
    assert.equal(s.calls.filter((c) => c.args.includes('ci')).length, 0, 'no second build in the same folder');
    assert.equal(s.a.status()?.update?.failedSha, undefined);
    holder.kill('SIGKILL');
    await new Promise((r) => holder.once('exit', r));
    await s.a.tick();
    assert.equal(s.calls.filter(isInstall).length, 1, 'built once the other runner has gone');
    assert.equal(s.a.status()?.update?.sha, 'a'.repeat(40));
    assert.equal(fs.existsSync(path.join(dir, name)), false, 'the lock is let go');
  } finally {
    holder.kill('SIGKILL');
  }
});

test('a commit another runner installed meanwhile is not built again', async () => {
  // Another runner finishes installing it between this one's look at the
  // saved state and taking the lock.
  const s = setup({ onLsRemote: (home) => fs.writeFileSync(path.join(home, 'agent-archive-update.json'), JSON.stringify({ by: 'runner', sha: 'a'.repeat(40) })) });
  await s.a.tick();
  assert.equal(s.calls.filter((c) => c.args.includes('ci')).length, 0);
  assert.equal(s.a.status()?.update?.sha, 'a'.repeat(40));
});

test('a stopped archive never ticks, not even the first time', () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  try {
    const s = setup();
    s.a.start();
    s.a.stop();
    mock.timers.tick(30 * 60_000);
    assert.equal(fs.existsSync(path.join(s.home, SESSIONS_FILE)), false);
    assert.equal(s.calls.length, 0);
  } finally {
    mock.timers.reset();
  }
});

test('a runner stopping for good stops its build, lets the lock go and marks nothing failed', async () => {
  const s = setup({ hang: (c) => c.args.includes('ci') });
  const ticked = s.a.tick();
  const { dir, name } = buildLockOf(s.cacheDir);
  while (!s.calls.some((c) => c.args.includes('ci'))) await new Promise((r) => setImmediate(r));
  assert.equal(fs.existsSync(path.join(dir, name)), true, 'held while building');
  s.a.shutdown();
  await ticked;
  assert.equal(fs.existsSync(path.join(dir, name)), false);
  assert.equal(s.a.status()?.update?.failedSha, undefined);
  assert.equal(s.calls.filter(isInstall).length, 0);
});

test("the archive server's health: what's wrong is said, and a healthy one says nothing", () => {
  const now = T1.getTime();
  const ago = (ms: number) => `${Math.round(ms / 86_400_000)} days`;
  assert.deepEqual(serverProblems({ ok: true, disk: { freeBytes: 29e9 }, backups: { lastBackup: { ok: true, finishedAt: now - 3_600_000 } } }, now, ago), []);
  assert.deepEqual(serverProblems({ ok: true }, now, ago), [], 'an older server that says less');
  assert.deepEqual(
    serverProblems({ ok: false, deploys: { lastDeploy: { ok: false, sha: 'abcdef123456' }, lastPoll: { ok: false } }, backups: { lastBackup: { ok: true, finishedAt: now - BACKUP_STALE_MS - 86_400_000 }, lastRestoreTest: { ok: false } }, disk: { freeBytes: LOW_DISK_BYTES / 2 } }, now, ago),
    ['it says it is not healthy', 'its last deploy (abcdef1) failed', "its deployer can't reach the archive's repo", 'its last backup was 3 days ago', 'its last restore test failed', 'only 5.0 GB of disk left'],
  );
  assert.deepEqual(serverProblems({ ok: true, backups: { lastBackup: { ok: false } } }, now, ago), ['its last backup failed']);
  assert.deepEqual(serverProblems('nope', now, ago), ["its health check didn't answer in JSON"]);
});

test("tb status says whether the sync's archive server answers", async () => {
  const ago = (ms: number) => `${Math.round(ms / 60_000)}m`;
  const ok = setup({ repo: false });
  await ok.a.tick();
  assert.match(formatArchive(ok.a.status()!, T1.getTime(), ago), /Its archive server is healthy on ccccccc\.$/);
  const sick = setup({ repo: false, health: async () => ({ ok: true, disk: { freeBytes: 1024 ** 3 } }) });
  await sick.a.tick();
  assert.match(formatArchive(sick.a.status()!, T1.getTime(), ago), /Its archive server answers, but only 1\.0 GB of disk left\./);
  const down = setup({ repo: false, health: async () => { throw new Error('ECONNREFUSED'); } });
  await down.a.tick();
  down.clock.now = new Date(T1.getTime() + 10 * 60_000);
  await down.a.tick();
  assert.equal(down.a.status()!.server?.downSince, T1.getTime(), 'down since the first failed check');
  assert.match(formatArchive(down.a.status()!, down.clock.now.getTime(), ago), /Its archive server isn't answering, for 10m \(ECONNREFUSED\)\./);
  assert.equal(down.calls.some((c) => c.bin === 'launchctl'), false, 'not its machine, so never started from here');
});

test("on the server's own machine, a server down two checks running and not running is started, once an hour", { skip: process.platform !== 'darwin' }, async () => {
  let running = false;
  const t = setup({ server: true, repo: false, health: async () => { throw new Error('ECONNREFUSED'); }, answer: (c) => (c.bin === 'launchctl' && c.args[0] === 'print' ? (running ? 'state = running\n\tpid = 123\n' : 'state = not running\n') : undefined) });
  const kicks = () => t.calls.filter((c) => c.bin === 'launchctl' && c.args[0] === 'kickstart');
  await t.a.tick();
  assert.equal(kicks().length, 0, 'one failed check could be a deploy swapping releases');
  t.clock.now = new Date(T1.getTime() + 10 * 60_000);
  await t.a.tick();
  assert.deepEqual(kicks().map((c) => c.args), [['kickstart', `gui/501/${SERVER_SERVICE}`]], 'never -k: a running server is never stopped');
  t.clock.now = new Date(T1.getTime() + 20 * 60_000);
  await t.a.tick();
  assert.equal(kicks().length, 1, 'not again within the hour');
  assert.match(formatArchive(t.a.status()!, t.clock.now.getTime(), (ms) => `${Math.round(ms / 60_000)}m`), /started it again 10m ago/);
  running = true;
  t.clock.now = new Date(T1.getTime() + 90 * 60_000);
  await t.a.tick();
  assert.equal(kicks().length, 1, 'running but not answering is left alone');
});

test("on the server's own machine, a service that isn't loaded is left out, and says so", { skip: process.platform !== 'darwin' }, async () => {
  const t = setup({ server: true, repo: false, health: async () => { throw new Error('ECONNREFUSED'); }, fail: (c) => c.bin === 'launchctl' });
  await t.a.tick();
  t.clock.now = new Date(T1.getTime() + 10 * 60_000);
  await t.a.tick();
  assert.equal(t.calls.some((c) => c.args[0] === 'kickstart'), false);
  assert.match(formatArchive(t.a.status()!, t.clock.now.getTime(), (ms) => `${Math.round(ms / 60_000)}m`), /Starting it again failed: its service isn't loaded/);
});
