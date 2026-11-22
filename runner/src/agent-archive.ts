import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { inBackground } from './background.ts';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';
import type { Logger } from './log.ts';
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
//   3. Keeping this machine's sync on agent-archive's main, when runner.json
//      names the repo, and installing each new build on machines that can't
//      reach the private repo themselves (`archive.pushTo`). Bruce's archive
//      server has a deployer that already does this for Bruce's sync, so a
//      machine with the server leaves it to that.
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

export type ArchiveStatus = {
  installed: boolean;
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

export function runtimeOf(dir: string): { node: string; cli: string } {
  const current = path.join(dir, 'runtime', 'current');
  return { node: path.join(current, 'bin', 'node'), cli: path.join(current, 'agent-archive.js') };
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

export function readSyncState(stdout: string): ArchiveSyncState | undefined {
  try {
    const v = JSON.parse(stdout) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as ArchiveSyncState) : undefined;
  } catch {
    return undefined;
  }
}

type Run = (bin: string, args: string[], opts: { cwd?: string; timeoutMs: number }) => Promise<string>;

const run: Run = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(lastLines(`${stderr}\n${err.message}`)));
      else resolve(stdout);
    });
  });

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
  now?: () => Date;
};

export class AgentArchive {
  private readonly d: Required<Omit<AgentArchiveDeps, 'serverDir'>> & { serverDir?: string };
  private timer: NodeJS.Timeout | undefined;
  private sync: ArchiveSyncState | undefined;
  private syncError: string | undefined;
  private sessions = 0;
  private updating = false;

  constructor(deps: AgentArchiveDeps) {
    const cacheRoot = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'Threadbear') : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'threadbear');
    this.d = {
      dir: archiveDir(),
      serverDir: serverDir(),
      cacheDir: path.join(cacheRoot, 'agent-archive'),
      run,
      now: () => new Date(),
      ...deps,
    };
  }

  start(): void {
    const tick = () => void this.tick().catch((e) => this.d.log.warn('agent archive: tick failed', { error: errText(e) }));
    const first = setTimeout(tick, 60_000);
    this.timer = setInterval(tick, EVERY_MS);
    first.unref();
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  installed(): boolean {
    return fs.existsSync(runtimeOf(this.d.dir).cli);
  }

  async tick(): Promise<void> {
    if (!this.d.on()) return;
    this.writeSessions();
    if (!this.installed()) return;
    await this.readStatus();
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

  updateState(): ArchiveUpdateState {
    const saved = readJsonSync<ArchiveUpdateState>(path.join(this.d.home, UPDATE_FILE));
    if (this.d.serverDir && fs.existsSync(this.d.serverDir)) return { by: 'server' };
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
    this.updating = true;
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
      for (const p of this.d.settings()?.pushTo ?? []) pushed[p.host] = await this.push(p, sha).then(() => 'ok', errText);
      this.saveUpdate({ by: 'runner', sha, at: this.d.now().toISOString(), ...(Object.keys(pushed).length ? { pushed } : {}) });
      this.d.log.info('agent archive: its sync is on main', { sha: sha.slice(0, 12), pushed });
    } catch (e) {
      this.saveUpdate({ ...state, by: 'runner', failedSha: sha, error: errText(e), at: this.d.now().toISOString() });
      this.d.log.warn('agent archive: building its sync failed', { sha: sha.slice(0, 12), error: errText(e) });
    } finally {
      this.updating = false;
    }
  }

  // The built CLI and skills, copied over and installed there. The folder is
  // the commit's, so two pushes never mix.
  private async push(p: { host: string; node: string }, sha: string): Promise<void> {
    const r = this.d.run;
    const tmp = `/tmp/agent-archive-${sha.slice(0, 12)}`;
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    await r('ssh', [p.host, `rm -rf ${q(tmp)} && mkdir -p ${q(tmp + '/dist-daemon')}`], { timeoutMs: 60_000 });
    await r('scp', ['-q', path.join(this.d.cacheDir, 'dist-daemon', 'cli.js'), `${p.host}:${tmp}/dist-daemon/`], { timeoutMs: 5 * 60_000 });
    await r('scp', ['-q', '-r', path.join(this.d.cacheDir, 'skills'), `${p.host}:${tmp}/`], { timeoutMs: 5 * 60_000 });
    await r('ssh', [p.host, `${q(p.node)} ${q(tmp + '/dist-daemon/cli.js')} install-runtime && rm -rf ${q(tmp)}`], { timeoutMs: 10 * 60_000 });
  }

  status(): ArchiveStatus | undefined {
    if (!this.d.on()) return undefined;
    return {
      installed: this.installed(),
      sessions: this.sessions,
      ...(this.sync ? { sync: this.sync } : {}),
      ...(this.syncError ? { syncError: this.syncError } : {}),
      update: this.updateState(),
      ...(this.updating ? { updating: true } : {}),
    };
  }
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
  return `Agent Archive: ${parts.join(', ')}.`;
}
