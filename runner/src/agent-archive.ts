import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { inBackground } from './background.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import { acquireLock } from './lock.ts';
import type { Logger } from './log.ts';
import { ErrorCode, RpcError } from './protocol.ts';
import type { ThreadRecord } from './store.ts';

// Agent Archive through Threadbear (docs/agent-archive-plan.md), behind the
// `archive` experiment. Agent Archive (Mike's, private until he releases it)
// keeps every agent session forever on an archive host and searches it; its
// sync is a background service of its own, reading the CLIs' folders. This
// is the runner's side of it, every ten minutes:
//
//   1. archive-sessions.json in the runner's home: which CLI session is which
//      Threadbear thread (title, project, folder). The archive's sync reads it
//      and sends it up with its own token, so search results and the reader
//      can open the thread. The runner never holds an archive credential.
//   2. The sync's state (`agent-archive status --json`), for tb status.
//   3. The archive server's health (`/api/health` at the sync's archive URL),
//      for tb status: whether it answers, and its deploys, backups and disk.
//      On the server's own machine (Bruce) the runner starts it again when
//      it has stopped and launchd hasn't (stage 3 of the plan).
//   4. Keeping this machine's sync on agent-archive's main, when runner.json
//      names the repo, and installing each new build on machines that can't
//      reach the private repo themselves (`archive.pushTo`). Bruce's archive
//      server has a deployer that already does this for Bruce's sync, so a
//      machine with the server leaves it to that.
//
// With the experiment on it also answers the sidebar's search of the archive
// (archive.search and archive.read, through the archive's own command and
// key), and every thread gets the archive's MCP server (archiveMcpServer).
//
// The sync stays a LaunchAgent (systemd on Linux) rather than a child of the
// runner: the runner moves to a new release several times an hour, and each
// move would stop an upload half done (Mike, 20 Nov, in b2612e00).

export const ARCHIVE_EXPERIMENT = 'archive';
export const SESSIONS_FILE = 'archive-sessions.json';
const UPDATE_FILE = 'agent-archive-update.json';
const EVERY_MS = 10 * 60_000;
// The sync polls every ten minutes, and a backlog or a sleeping Mac can hold
// one up a while, so only past this is it said to have stopped.
export const STALE_MS = 3 * 3_600_000;
const STATUS_TIMEOUT_MS = 30_000;
const HEALTH_TIMEOUT_MS = 15_000;
// A backup runs nightly, so only past two days is it said to be behind.
export const BACKUP_STALE_MS = 2 * 86_400_000;
export const LOW_DISK_BYTES = 10 * 1024 ** 3;
// The server's LaunchAgent, as the archive's installer names it. Started
// again only after two checks in a row found it down (a deploy swaps
// releases in between), and at most once an hour.
export const SERVER_SERVICE = 'app.mikecann.agent-archive-server';
const DOWN_CHECKS_BEFORE_START = 2;
const START_EVERY_MS = 3_600_000;
// The sidebar waits on a search, so it gets less than the sync's status.
const QUERY_TIMEOUT_MS = 20_000;
// The archive's own thread ids (its MCP refuses anything else).
const ARCHIVE_THREAD_ID = /^[a-z0-9]{31,37}$/;

// runner.json's `archive`. Everything here is Mike's own setup, so none of
// it is in the code (docs/forking.md).
export type ArchiveSettings = {
  // agent-archive's git URL. With it, this machine's sync follows its main.
  repo?: string;
  // Machines the build is installed on over ssh after this one's, with the
  // node to run its installer (a Linux box can't use the Mac's).
  pushTo?: { host: string; node: string }[];
};

export type SessionAgent = 'claude' | 'codex';
export type SessionEntry = {
  sessionId: string;
  agent: SessionAgent;
  threadId: string;
  title: string;
  project?: string;
  folder?: string;
  updatedAt: string;
};
// claudeRoots and codexRoots: where every login this runner runs keeps its
// sessions (a Claude login's projects folder, a Codex login's sessions
// folder), which the sync reads as well as its own list. A login added to
// Threadbear was otherwise never archived until someone listed it there by
// hand: on 20 Nov the M5's fourth Claude login had 762 sessions since
// 12 Nov that weren't, and its Codex login's were never read.
export type SessionsFile = { version: 1; runner: string; claudeRoots?: string[]; codexRoots?: string[]; sessions: SessionEntry[] };

// What `agent-archive status --json` prints. Every field may be missing:
// an older sync knows fewer.
export type ArchiveSyncState = {
  service?: 'running' | 'stopped' | 'paused' | 'not-installed';
  archiveUrl?: string;
  deviceName?: string;
  lastSuccessAt?: number | null;
  lastRunAt?: number | null;
  lastError?: string | null;
  failingFiles?: number;
  oversizedFiles?: number;
  pendingFiles?: number | null;
  runtimeRelease?: string | null;
};

export type ArchiveUpdateState = {
  // What updates this machine's sync: this runner from the repo, Bruce's
  // archive server deployer, or nothing (no repo in runner.json).
  by: 'runner' | 'server' | 'nobody';
  sha?: string; // main's commit installed last
  at?: string;
  failedSha?: string; // not tried again: a new commit on main is
  error?: string;
  pushed?: Record<string, string>; // host: "ok" or what went wrong
};

// docs/protocol.md, "Searching Agent Archive". The archive's command makes
// these; only what the app needs to find is checked, the rest passed on.
export type ArchiveHit = {
  threadId: string;
  title: string;
  agent: string;
  folder?: string;
  machine?: string;
  updatedAt: number;
  sequence: number;
  snippet: string;
  threadbear?: { threadId: string; title: string };
};
export type ArchiveOff = 'experiment' | 'not_installed';
export type ArchiveSearch = { hits: ArchiveHit[]; more: boolean } | { hits: []; off: ArchiveOff };
export type ArchiveRead = { thread: Record<string, unknown>; items: unknown[] };

// The archive server, as this runner last saw it (checkServer).
export type ArchiveServerHealth = {
  url: string;
  checkedAt: number;
  up: boolean; // answered /api/health at all
  // Since when it hasn't answered, through every check since.
  downSince?: number;
  error?: string;
  release?: string;
  // What its answer says is wrong: a failed deploy or backup, little disk.
  problems?: string[];
  // On the server's machine: when this runner last started it again.
  startedAt?: number;
  startError?: string;
};

export type ArchiveStatus = {
  installed: boolean;
  server?: ArchiveServerHealth;
  sessions: number;
  sync?: ArchiveSyncState;
  syncError?: string;
  update?: ArchiveUpdateState;
  updating?: boolean;
};

// Where Agent Archive keeps its config and runtime: the same places its
// daemon picks (daemon/config.ts defaultConfigPath there).
export function archiveDir(platform: NodeJS.Platform = process.platform, home = os.homedir(), env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Agent Archive');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'agent-archive');
}

// The lock beside the build folder. Every runner on the machine builds in the
// same folder, and a handover leaves the old release running beside the new
// one, so two builds at once clashed there (THREADBEAR-2J).
export function buildLockOf(cacheDir: string): { dir: string; name: string } {
  return { dir: path.dirname(cacheDir), name: `${path.basename(cacheDir)}.lock` };
}

export function runtimeOf(dir: string): { node: string; cli: string } {
  const current = path.join(dir, 'runtime', 'current');
  return { node: path.join(current, 'bin', 'node'), cli: path.join(current, 'agent-archive.js') };
}

// The archive's own MCP server, the command its installer puts in Mike's
// Claude and Codex config. With the experiment on, every thread's session
// gets it (main.ts), so a login whose config doesn't name it still has the
// archive's tools: the cloud box's Threadbear login didn't (23 Nov).
export const ARCHIVE_MCP_NAME = 'agent-archive';
export function archiveMcpServer(dir = archiveDir()): { command: string; args: string[] } | undefined {
  const { node, cli } = runtimeOf(dir);
  return fs.existsSync(cli) && fs.existsSync(node) ? { command: node, args: [cli, 'mcp'] } : undefined;
}

// Bruce's archive server, whose deployer keeps Bruce's sync on main.
export function serverDir(platform: NodeJS.Platform = process.platform, home = os.homedir()): string | undefined {
  return platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Agent Archive Server') : undefined;
}

// The archive's names for the CLIs. Others (Grok, Cursor) aren't sent yet:
// the archive only matches Claude's and Codex's session ids so far.
function agentOf(rec: ThreadRecord): SessionAgent | undefined {
  return rec.provider === 'claude' || rec.provider === 'codex' ? rec.provider : undefined;
}

// Every session a thread has had is kept once written, as a thread only
// remembers its current one (a clear starts another), so the file is the
// record of the old ones. Their titles and projects follow the thread's.
export function sessionsFor(
  records: readonly ThreadRecord[],
  projectTitle: (id: string) => string | undefined,
  runner: string,
  prev: SessionsFile | undefined,
  now: Date,
  roots: { claude?: readonly string[]; codex?: readonly string[] } = {},
): SessionsFile {
  const at = now.toISOString();
  const byThread = new Map<string, Omit<SessionEntry, 'sessionId' | 'agent' | 'updatedAt'>>();
  const out = new Map<string, SessionEntry>();
  for (const e of prev?.version === 1 && Array.isArray(prev.sessions) ? prev.sessions : []) {
    if (e && typeof e.sessionId === 'string' && typeof e.threadId === 'string') out.set(e.sessionId, e);
  }
  for (const rec of records) {
    const agent = agentOf(rec);
    if (!agent) continue;
    const left = new Set(rec.projectsLeft ?? []);
    const project = (rec.projects ?? []).filter((p) => !left.has(p.id)).map((p) => projectTitle(p.id)).find(Boolean);
    const about = { threadId: rec.id, title: rec.title, ...(project ? { project } : {}), ...(rec.cwd ? { folder: rec.cwd } : {}) };
    byThread.set(rec.id, about);
    const ids = new Set<string>();
    if (rec.nativeSessionId && rec.sessionUsed) ids.add(rec.nativeSessionId);
    // A Codex sub-agent is a thread of its own in Codex's folders; Claude's
    // share the parent's session id, which the archive matches by itself.
    for (const s of rec.subagents ?? []) if (s.sessionId) ids.add(s.sessionId);
    for (const sessionId of ids) {
      if (!out.has(sessionId)) out.set(sessionId, { sessionId, agent, ...about, updatedAt: at });
    }
  }
  // A renamed or moved thread changes all its sessions' entries, and only
  // those get a new updatedAt, so the sync re-sends just what changed.
  for (const [id, e] of out) {
    const about = byThread.get(e.threadId);
    if (!about) continue;
    const next: SessionEntry = { sessionId: e.sessionId, agent: e.agent, ...about, updatedAt: e.updatedAt };
    if (next.title !== e.title || next.project !== e.project || next.folder !== e.folder) out.set(id, { ...next, updatedAt: at });
  }
  const sessions = [...out.values()].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const listed = (r: readonly string[] = []) => [...new Set(r)].sort();
  const claudeRoots = listed(roots.claude);
  const codexRoots = listed(roots.codex);
  return { version: 1, runner, ...(claudeRoots.length ? { claudeRoots } : {}), ...(codexRoots.length ? { codexRoots } : {}), sessions };
}

// What /api/health's answer says is wrong, in tb status's words. Every field
// may be missing (an older server says less), and then nothing is said.
export function serverProblems(body: unknown, now: number, ago: (ms: number) => string): string[] {
  const o = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
  if (!body || typeof body !== 'object') return ["its health check didn't answer in JSON"];
  const b = o(body);
  const out: string[] = [];
  if (b.ok !== true) out.push('it says it is not healthy');
  const deploys = o(b.deploys);
  const deploy = o(deploys.lastDeploy);
  if (deploy.ok === false) out.push(`its last deploy${typeof deploy.sha === 'string' ? ` (${deploy.sha.slice(0, 7)})` : ''} failed`);
  if (o(deploys.lastPoll).ok === false) out.push("its deployer can't reach the archive's repo");
  const backups = o(b.backups);
  const backup = o(backups.lastBackup);
  if (backup.ok === false) out.push('its last backup failed');
  else if (typeof backup.finishedAt === 'number' && now - backup.finishedAt > BACKUP_STALE_MS) out.push(`its last backup was ${ago(now - backup.finishedAt)} ago`);
  if (o(backups.lastRestoreTest).ok === false) out.push('its last restore test failed');
  const free = o(b.disk).freeBytes;
  if (typeof free === 'number' && free < LOW_DISK_BYTES) out.push(`only ${(free / 1024 ** 3).toFixed(1)} GB of disk left`);
  return out;
}

export function readSyncState(stdout: string): ArchiveSyncState | undefined {
  try {
    const v = JSON.parse(stdout) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as ArchiveSyncState) : undefined;
  } catch {
    return undefined;
  }
}

type Run = (bin: string, args: string[], opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal }) => Promise<string>;
// What a failed command rejects with: its own stderr and exit code as well,
// for archive.search and archive.read to say why in the archive's words.
type RunError = Error & { stderr?: string; code?: number | string; killed?: boolean };

const run: Run = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeoutMs, signal: opts.signal, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(lastLines(`${stderr}\n${err.message}`)), { stderr, code: err.code ?? undefined, killed: err.killed }));
      else resolve(stdout);
    });
  });

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function isHit(h: unknown): h is ArchiveHit {
  const x = h as Partial<ArchiveHit> | null;
  return !!x && typeof x === 'object' && typeof x.threadId === 'string' && typeof x.title === 'string';
}

function lastLines(text: string): string {
  return text.trim().split('\n').filter(Boolean).slice(-3).join(' / ').slice(0, 400);
}

// A Logger-safe one-liner for an error, which may hold a path but never a
// token: the archive's CLI redacts credentials from what it prints.
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type AgentArchiveDeps = {
  home: string;
  log: Logger;
  on: () => boolean;
  records: () => readonly ThreadRecord[];
  // Project ids to titles, archived ones too, asked once a write.
  projectTitles: () => ReadonlyMap<string, string>;
  runnerName: () => string;
  // Each login's config folder: a Claude login's `projects` folder and a
  // Codex login's `sessions` folder (CODEX_HOME's) are the ones read.
  loginDirs: () => readonly { provider: string; configDir: string }[];
  settings: () => ArchiveSettings | undefined;
  dir?: string;
  serverDir?: string;
  cacheDir?: string;
  run?: Run;
  // /api/health's answer, or a throw when the server doesn't answer.
  health?: (url: string) => Promise<unknown>;
  // The server's machine only: whether launchd has the server running.
  uid?: number;
  now?: () => Date;
};

async function fetchHealth(url: string): Promise<unknown> {
  const res = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  // A server that answers at all is up, even unhealthy: its body says why.
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`HTTP ${res.status} without its health in JSON`);
  }
}

export class AgentArchive {
  private readonly d: Required<Omit<AgentArchiveDeps, 'serverDir' | 'uid'>> & { serverDir?: string; uid?: number };
  private server: ArchiveServerHealth | undefined;
  private downChecks = 0;
  private first: NodeJS.Timeout | undefined;
  private timer: NodeJS.Timeout | undefined;
  private sync: ArchiveSyncState | undefined;
  private syncError: string | undefined;
  private sessions = 0;
  private updating = false;
  // Ends a build's commands when the runner stops for good, so none goes on
  // in the folder after its lock is gone.
  private building: AbortController | undefined;

  constructor(deps: AgentArchiveDeps) {
    const cacheRoot = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'Threadbear') : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'threadbear');
    this.d = {
      dir: archiveDir(),
      serverDir: serverDir(),
      cacheDir: path.join(cacheRoot, 'agent-archive'),
      run,
      health: fetchHealth,
      now: () => new Date(),
      ...(process.getuid ? { uid: process.getuid() } : {}),
      ...deps,
    };
  }

  start(): void {
    const tick = () => void this.tick().catch((e) => this.d.log.warn('agent archive: tick failed', { error: errText(e) }));
    this.first = setTimeout(tick, 60_000);
    this.timer = setInterval(tick, EVERY_MS);
    this.first.unref();
    this.timer.unref();
  }

  // A draining runner stops here: the new release keeps the list and the
  // sync from then on. A build under way finishes, under its lock.
  stop(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = this.timer = undefined;
  }

  // The runner stopping for good: a build under way is stopped too, as its
  // commands would outlive the runner and the lock it holds.
  shutdown(): void {
    this.stop();
    this.building?.abort();
  }

  installed(): boolean {
    return fs.existsSync(runtimeOf(this.d.dir).cli);
  }

  async tick(): Promise<void> {
    if (!this.d.on()) return;
    this.writeSessions();
    if (!this.installed()) return;
    await this.readStatus();
    await this.checkServer();
    await this.followMain();
  }

  writeSessions(): void {
    const file = path.join(this.d.home, SESSIONS_FILE);
    const prev = readJsonSync<SessionsFile>(file);
    const titles = this.d.projectTitles();
    const logins = this.d.loginDirs();
    const roots = {
      claude: logins.filter((l) => l.provider === 'claude').map((l) => path.join(l.configDir, 'projects')),
      codex: logins.filter((l) => l.provider === 'codex').map((l) => path.join(l.configDir, 'sessions')),
    };
    const next = sessionsFor(this.d.records(), (id) => titles.get(id), this.d.runnerName(), prev, this.d.now(), roots);
    this.sessions = next.sessions.length;
    const text = JSON.stringify(next) + '\n';
    if (prev && JSON.stringify(prev) + '\n' === text) return;
    atomicWriteFileSync(file, text, 0o600);
  }

  async readStatus(): Promise<void> {
    const { node, cli } = runtimeOf(this.d.dir);
    try {
      const out = await this.d.run(node, [cli, 'status', '--json'], { timeoutMs: STATUS_TIMEOUT_MS });
      this.sync = readSyncState(out);
      this.syncError = this.sync ? undefined : 'its status was not JSON';
    } catch (e) {
      this.sync = undefined;
      // A sync from before `status --json` refuses the flag: the next update
      // brings it.
      this.syncError = /--json|Unknown option/i.test(errText(e)) ? 'its sync is too old to report its status' : errText(e);
    }
  }

  private isServerHost(): boolean {
    return !!this.d.serverDir && fs.existsSync(this.d.serverDir);
  }

  // The server at the sync's archive URL: up or not, and what its health
  // says. On its own machine, one that's down two checks running and not
  // running under launchd is started again (`kickstart` without -k, so a
  // running server is never stopped).
  async checkServer(): Promise<void> {
    const url = this.sync?.archiveUrl;
    if (!url) {
      this.server = undefined;
      return;
    }
    const now = this.d.now().getTime();
    const prev = this.server?.url === url ? this.server : undefined;
    const ago = (ms: number) => `${Math.round(ms / 86_400_000)} days`;
    try {
      const body = await this.d.health(url);
      const problems = serverProblems(body, now, ago);
      const release = (body as { release?: unknown } | null)?.release;
      if (prev && !prev.up) this.d.log.info('agent archive: its server answers again', { url });
      this.downChecks = 0;
      this.server = { url, checkedAt: now, up: true, ...(typeof release === 'string' ? { release } : {}), ...(problems.length ? { problems } : {}), ...(prev?.startedAt ? { startedAt: prev.startedAt } : {}) };
    } catch (e) {
      this.downChecks++;
      if (!prev || prev.up) this.d.log.warn('agent archive: its server is not answering', { url, error: errText(e) });
      this.server = { url, checkedAt: now, up: false, downSince: prev && !prev.up ? (prev.downSince ?? now) : now, error: errText(e), ...(prev?.startedAt ? { startedAt: prev.startedAt } : {}), ...(prev?.startError ? { startError: prev.startError } : {}) };
      await this.startServer(now);
    }
  }

  private async startServer(now: number): Promise<void> {
    const s = this.server;
    if (!s || process.platform !== 'darwin' || this.d.uid === undefined || !this.isServerHost()) return;
    if (this.downChecks < DOWN_CHECKS_BEFORE_START || (s.startedAt && now - s.startedAt < START_EVERY_MS)) return;
    const target = `gui/${this.d.uid}/${SERVER_SERVICE}`;
    let printed: string;
    try {
      printed = await this.d.run('launchctl', ['print', target], { timeoutMs: 15_000 });
    } catch (e) {
      // Not loaded at all: something took it out on purpose (a deploy, Mike).
      s.startError = `its service isn't loaded (${errText(e)})`;
      return;
    }
    if (/^\s*pid = \d+/m.test(printed)) return; // running, just not answering: said in tb status, left alone
    s.startedAt = now;
    try {
      await this.d.run('launchctl', ['kickstart', target], { timeoutMs: 30_000 });
      delete s.startError;
      this.d.log.warn('agent archive: started its server again', { service: SERVER_SERVICE });
    } catch (e) {
      s.startError = errText(e);
      this.d.log.warn('agent archive: could not start its server', { error: errText(e) });
    }
  }

  updateState(): ArchiveUpdateState {
    const saved = readJsonSync<ArchiveUpdateState>(path.join(this.d.home, UPDATE_FILE));
    if (this.isServerHost()) return { by: 'server' };
    if (!this.d.settings()?.repo) return { by: 'nobody' };
    return { ...saved, by: 'runner' };
  }

  private saveUpdate(s: ArchiveUpdateState): void {
    atomicWriteFileSync(path.join(this.d.home, UPDATE_FILE), JSON.stringify(s, null, 2) + '\n');
  }

  // Builds main's sync and installs it with the archive's own installer
  // (`install-runtime`, which swaps it in and restarts the service), then on
  // each pushTo machine. A commit that fails isn't tried again; the next one
  // is (as Bruce's deployer does).
  async followMain(): Promise<void> {
    const state = this.updateState();
    const repo = this.d.settings()?.repo;
    if (state.by !== 'runner' || !repo || this.updating) return;
    const r = this.d.run;
    let sha: string;
    try {
      sha = (await r('git', ['ls-remote', repo, 'refs/heads/main'], { timeoutMs: 60_000 })).split(/\s/)[0] ?? '';
    } catch (e) {
      this.d.log.info('agent archive: could not reach its repo', { error: errText(e) });
      return;
    }
    if (!/^[0-9a-f]{40}$/.test(sha) || sha === state.sha || sha === state.failedSha) return;
    // Another runner on this machine building now has the folder: its
    // result is saved for the next tick to read.
    const { dir: lockDir, name: lockName } = buildLockOf(this.d.cacheDir);
    let lock: ReturnType<typeof acquireLock>;
    try {
      lock = acquireLock(lockDir, lockName);
    } catch (e) {
      this.d.log.info('agent archive: could not take its build lock', { error: errText(e) });
      return;
    }
    if ('heldBy' in lock) return;
    try {
      // It may have installed this commit since the look above.
      const now = this.updateState();
      if (sha === now.sha || sha === now.failedSha) return;
      await this.build(sha, now, repo);
    } finally {
      lock.release();
    }
  }

  private async build(sha: string, state: ArchiveUpdateState, repo: string): Promise<void> {
    this.updating = true;
    const building = (this.building = new AbortController());
    const { signal } = building;
    const r: Run = (bin, args, opts) => this.d.run(bin, args, { ...opts, signal });
    const dir = this.d.cacheDir;
    const { node } = runtimeOf(this.d.dir);
    const bg = (bin: string, args: string[], timeoutMs: number) => {
      const [b, a] = inBackground(bin, args);
      return r(b, a, { cwd: dir, timeoutMs });
    };
    try {
      this.d.log.info('agent archive: building its sync', { sha: sha.slice(0, 12) });
      if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await r('git', ['clone', '--quiet', repo, dir], { timeoutMs: 5 * 60_000 });
      }
      await r('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: dir, timeoutMs: 5 * 60_000 });
      await r('git', ['checkout', '--quiet', '--force', '--detach', sha], { cwd: dir, timeoutMs: 60_000 });
      await r('git', ['clean', '-fdxq', '-e', 'node_modules'], { cwd: dir, timeoutMs: 60_000 });
      const npm = npmBeside(process.execPath);
      await bg(npm, ['ci', '--no-audit', '--no-fund'], 20 * 60_000);
      await bg(npm, ['run', 'build:daemon'], 10 * 60_000);
      // The runtime's own node, so an update never changes which Node the
      // sync runs on; the installer copies it into the new release.
      await bg(fs.existsSync(node) ? node : process.execPath, [path.join(dir, 'dist-daemon', 'cli.js'), 'install-runtime'], 10 * 60_000);
      const pushed: Record<string, string> = {};
      for (const p of this.d.settings()?.pushTo ?? []) pushed[p.host] = await this.push(p, sha, r).then(() => 'ok', errText);
      this.saveUpdate({ by: 'runner', sha, at: this.d.now().toISOString(), ...(Object.keys(pushed).length ? { pushed } : {}) });
      this.d.log.info('agent archive: its sync is on main', { sha: sha.slice(0, 12), pushed });
    } catch (e) {
      // Stopped with the runner: the next runner builds it again.
      if (signal.aborted) return;
      this.saveUpdate({ ...state, by: 'runner', failedSha: sha, error: errText(e), at: this.d.now().toISOString() });
      this.d.log.warn('agent archive: building its sync failed', { sha: sha.slice(0, 12), error: errText(e) });
    } finally {
      this.updating = false;
      this.building = undefined;
    }
  }

  // The built CLI and skills, copied over and installed there. The folder is
  // the commit's, so two pushes never mix.
  private async push(p: { host: string; node: string }, sha: string, r: Run): Promise<void> {
    const tmp = `/tmp/agent-archive-${sha.slice(0, 12)}`;
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    await r('ssh', [p.host, `rm -rf ${q(tmp)} && mkdir -p ${q(tmp + '/dist-daemon')}`], { timeoutMs: 60_000 });
    await r('scp', ['-q', path.join(this.d.cacheDir, 'dist-daemon', 'cli.js'), `${p.host}:${tmp}/dist-daemon/`], { timeoutMs: 5 * 60_000 });
    await r('scp', ['-q', '-r', path.join(this.d.cacheDir, 'skills'), `${p.host}:${tmp}/`], { timeoutMs: 5 * 60_000 });
    await r('ssh', [p.host, `${q(p.node)} ${q(tmp + '/dist-daemon/cli.js')} install-runtime && rm -rf ${q(tmp)}`], { timeoutMs: 10 * 60_000 });
  }

  private off(): ArchiveOff | undefined {
    if (!this.d.on()) return 'experiment';
    return this.installed() ? undefined : 'not_installed';
  }

  // The archive's command, answering for the app now: not at background
  // priority, and failing with the archive's own last line on stderr.
  private async ask(args: string[]): Promise<string> {
    const { node, cli } = runtimeOf(this.d.dir);
    try {
      return await this.d.run(node, [cli, ...args], { timeoutMs: QUERY_TIMEOUT_MS });
    } catch (e) {
      const x = e as RunError;
      if (x.killed) throw new Error(`Agent Archive didn't answer within ${QUERY_TIMEOUT_MS / 1000} seconds`);
      const said = (x.stderr ?? '').trim().split('\n').filter(Boolean).at(-1);
      throw Object.assign(new Error(said ?? errText(e)), { code: x.code });
    }
  }

  // The sidebar's search of the archive (docs/protocol.md, "Searching Agent
  // Archive"): one hit per archived session, best first.
  async search(query: string, limit = 20): Promise<ArchiveSearch> {
    const off = this.off();
    if (off) return { hits: [], off };
    const words = query.trim().slice(0, 500);
    if (!words) return { hits: [], more: false };
    const n = Math.min(Math.max(1, Math.floor(limit)), 50);
    // `--` first, so words starting with a dash aren't read as its options.
    const v = parseObject(await this.ask(['search', '--json', '--limit', String(n), '--', words]));
    if (!v || !Array.isArray(v.hits)) throw new Error("Agent Archive's search didn't answer in JSON");
    return { hits: v.hits.filter(isHit), more: v.more === true };
  }

  // An archived session's messages around one of them, for the read-only view.
  async read(threadId: string, around?: number, limit?: number): Promise<ArchiveRead> {
    if (!ARCHIVE_THREAD_ID.test(threadId)) throw new RpcError(ErrorCode.badParams, 'threadId must be an Agent Archive thread id');
    const off = this.off();
    if (off) throw new RpcError(ErrorCode.invalidRequest, off === 'experiment' ? 'Agent Archive is off on this runner' : "Agent Archive isn't installed on this runner's machine");
    const args = ['read', '--json', threadId];
    if (around !== undefined) args.push('--around', String(around));
    if (limit !== undefined) args.push('--limit', String(Math.min(Math.max(1, limit), 200)));
    let out: string;
    try {
      out = await this.ask(args);
    } catch (e) {
      if ((e as RunError).code === 2 && /^not_found/.test(errText(e))) throw new RpcError(ErrorCode.badParams, "Agent Archive doesn't have that session");
      throw e;
    }
    const v = parseObject(out);
    if (!v || !v.thread || typeof v.thread !== 'object' || !Array.isArray(v.items)) throw new Error("Agent Archive's reader didn't answer in JSON");
    return { thread: v.thread as Record<string, unknown>, items: v.items };
  }

  status(): ArchiveStatus | undefined {
    if (!this.d.on()) return undefined;
    return {
      installed: this.installed(),
      sessions: this.sessions,
      ...(this.sync ? { sync: this.sync } : {}),
      ...(this.server ? { server: this.server } : {}),
      ...(this.syncError ? { syncError: this.syncError } : {}),
      update: this.updateState(),
      ...(this.updating ? { updating: true } : {}),
    };
  }
}

type Params = Record<string, unknown>;

// archive.search and archive.read (docs/protocol.md, "Searching Agent Archive").
export function archiveMethods(a: Pick<AgentArchive, 'search' | 'read'>): Record<string, (p: Params) => unknown> {
  const str = (p: Params, k: string) => {
    const v = p[k];
    if (typeof v !== 'string') throw new RpcError(ErrorCode.badParams, `${k} must be a string`);
    return v;
  };
  const int = (p: Params, k: string) => {
    const v = p[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new RpcError(ErrorCode.badParams, `${k} must be a whole number`);
    return v;
  };
  return {
    'archive.search': (p) => a.search(str(p, 'query'), int(p, 'limit') ?? 20),
    'archive.read': (p) => a.read(str(p, 'threadId'), int(p, 'around'), int(p, 'limit')),
  };
}

function npmBeside(nodePath: string): string {
  const beside = path.join(path.dirname(nodePath), 'npm');
  return fs.existsSync(beside) ? beside : 'npm';
}

// tb status's line, said plainly.
export function formatArchive(a: ArchiveStatus, now: number, ago: (ms: number) => string): string {
  if (!a.installed) return `Agent Archive: not installed on this machine, so only the list of ${a.sessions} sessions is kept for it.`;
  const s = a.sync;
  const parts: string[] = [];
  if (!s) parts.push(`its sync didn't say how it's doing (${a.syncError ?? 'no answer'})`);
  else {
    const where = s.archiveUrl ? ` to ${s.archiveUrl}` : '';
    if (s.service && s.service !== 'running') parts.push(`its sync is ${s.service === 'not-installed' ? 'not installed as a service' : s.service}${where}`);
    else parts.push(`syncing${where}${s.deviceName ? ` as ${s.deviceName}` : ''}`);
    if (s.lastSuccessAt) {
      const since = now - s.lastSuccessAt;
      parts.push(since > STALE_MS ? `nothing synced for ${ago(since)}${s.lastError ? ` (${s.lastError})` : ''}` : `last synced ${ago(since)} ago`);
    } else parts.push(`no sync has finished yet${s.lastError ? ` (${s.lastError})` : ''}`);
    if (s.failingFiles) parts.push(`${s.failingFiles} ${s.failingFiles === 1 ? 'file' : 'files'} failing`);
    if (s.oversizedFiles) parts.push(`${s.oversizedFiles} too big to send`);
  }
  parts.push(`${a.sessions} Threadbear sessions listed for it`);
  const u = a.update;
  if (a.updating) parts.push('building the latest sync from its main');
  else if (u?.by === 'server') parts.push("its archive server's deployer keeps the sync on main");
  else if (u?.by === 'runner' && u.failedSha) parts.push(`building ${u.failedSha.slice(0, 7)} from its main failed (${u.error ?? 'no reason given'}); the next commit is tried`);
  else if (u?.by === 'runner' && u.sha) {
    const bad = Object.entries(u.pushed ?? {}).filter(([, v]) => v !== 'ok').map(([h, v]) => `${h}: ${v}`);
    parts.push(`its sync is on main (${u.sha.slice(0, 7)})${bad.length ? `, but installing it failed on ${bad.join('; ')}` : ''}`);
  }
  const server = a.server ? ` ${formatServer(a.server, now, ago)}` : '';
  return `Agent Archive: ${parts.join(', ')}.${server}`;
}

function formatServer(s: ArchiveServerHealth, now: number, ago: (ms: number) => string): string {
  const started = s.startedAt ? ` This runner started it again ${ago(now - s.startedAt)} ago.` : '';
  const couldnt = s.startError ? ` Starting it again failed: ${s.startError}.` : '';
  if (!s.up) return `Its archive server isn't answering, for ${ago(now - (s.downSince ?? s.checkedAt))} (${s.error ?? 'no reason given'}).${started}${couldnt}`;
  const release = s.release ? ` on ${s.release.slice(0, 7)}` : '';
  if (s.problems?.length) return `Its archive server answers${release}, but ${s.problems.join(', ')}.${started}`;
  return `Its archive server is healthy${release}.${started}`;
}
