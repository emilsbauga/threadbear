// How tb reaches the runner. Inside a thread that's with the thread's own key
// (docs/protocol/connection.md, "A thread's own key"), never the token. Outside one, or
// pointed at another runner's data dir (a dev runner, whose token it reads and
// whose threads it doesn't belong to), it's that data dir's token.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { psTable } from './proc.ts';
import { DEFAULT_PORT, paths, readRunnerJson, readToken, runnerUrl, type Config } from './config.ts';
import os from 'node:os';
import { dataDirFor } from './platform.ts';
import { MARK_NAMES, procTable, psEnvLines, threadMarksIn } from './peer.ts';
import { ErrorCode } from './protocol.ts';
import { RunnerClient, type RunnerClientOptions } from './client.ts';
import { isThreadId, isThreadKey, threadKey } from './rpc-auth.ts';

// Links followed: THREADBEAR_HOME through a link is still this runner. As
// the disk spells it, so a Windows path's case or short name doesn't make
// a thread's own runner look like another (Gemini's review of finding 177).
const real = (p: string) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
const sameDir = (a: string, b: string) => real(a) === real(b);

export type TbCredential = { token: string; threadId?: string };

export function tbCredential(home: string, env: NodeJS.ProcessEnv = process.env): TbCredential {
  const key = env.THREADBEAR_THREAD_KEY;
  const threadId = env.THREADBEAR_THREAD_ID;
  if (isThreadKey(key) && threadId && sameDir(env.THREADBEAR_RUNNER_HOME ?? home, home)) return { token: key, threadId };
  return { token: readToken(home) };
}

const options = (c: TbCredential, opts: RunnerClientOptions): RunnerClientOptions => ({ ...opts, ...(c.threadId ? { threadId: c.threadId } : {}) });

export async function connectTb(cfg: Config, url: string = runnerUrl(cfg), opts: RunnerClientOptions = {}): Promise<RunnerClient> {
  const why = await crossHomeRefusal(cfg.home);
  if (why) throw new Error(why);
  const c = tbCredential(cfg.home);
  return RunnerClient.connect(url, c.token, options(c, opts));
}

// For a caller that drives `opened` itself, with its own timeout. Only ever
// a nicety (titles, a log's path), so where connectTb would ask (a thread's
// tb on Windows pointed at another runner) it doesn't connect.
export function newTbClient(cfg: Config, url: string = runnerUrl(cfg), opts: RunnerClientOptions = {}): RunnerClient {
  if (crossHome(cfg.home, process.env, process.platform)) throw new Error("A thread's tb doesn't use another runner's token here.");
  const c = tbCredential(cfg.home);
  return new RunnerClient(url, c.token, options(c, opts));
}

// A thread's tb (its key in its environment) pointed at another runner's
// data dir, on Windows (Daybreak finding 177). A Mac's or Linux's runner
// looks at the environments above a connection and turns away one under
// another runner's thread itself (peer.ts, ForeignPeer); Windows can't read
// another process's environment, so there tb asks first.
// A thread id with no key (a CLI from before thread keys, or a patch's
// action) can't ask, so it's refused.
function crossHome(home: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): { key?: string; threadId: string; mine: string } | undefined {
  const key = env.THREADBEAR_THREAD_KEY;
  const threadId = env.THREADBEAR_THREAD_ID;
  const mine = env.THREADBEAR_RUNNER_HOME;
  if (platform !== 'win32' || !isThreadId(threadId) || !mine || sameDir(mine, home)) return undefined;
  return { ...(isThreadKey(key) ? { key } : {}), threadId, mine };
}

// Why tb mustn't use another runner's token from here, or undefined. On
// Windows, a thread's tb pointed at another runner's data dir goes ahead
// only once its own runner, asked with its key, says it's on Full access (a
// thread that could read the token and run anything anyway): a limited
// thread, or no answer, is refused. Its environment can be wiped, so this
// stops ordinary tb, not a thread set on getting round it: SECURITY.md.
export async function crossHomeRefusal(home: string, env: NodeJS.ProcessEnv = process.env, deps: { platform?: NodeJS.Platform; connect?: (url: string, token: string, opts: RunnerClientOptions) => Promise<RunnerClient> } = {}): Promise<string | undefined> {
  const x = crossHome(home, env, deps.platform ?? process.platform);
  if (!x) return undefined;
  const cant = "This thread's runner couldn't be asked whether it's on Full access, which tb needs to use another runner's data folder from a thread.";
  if (!x.key) return cant;
  let client: RunnerClient;
  try {
    const url = `ws://127.0.0.1:${readRunnerJson(x.mine).port || DEFAULT_PORT}/rpc`;
    client = await (deps.connect ?? ((u, t, o) => RunnerClient.connect(u, t, o)))(url, x.key, { threadId: x.threadId });
  } catch {
    return cant;
  }
  try {
    const whoami = await client.call<{ threadId?: string; limited?: boolean; mode?: string }>('auth.whoami');
    if (whoami.threadId !== x.threadId) return cant;
    if (whoami.limited) return `This thread is on ${whoami.mode}, so its tb only talks to its own runner, not the one in ${home}.`;
    return undefined;
  } catch {
    return cant;
  } finally {
    client.close();
  }
}

// Who is running this tb, going by its own environment and its parents'
// (Daybreak finding 174): under a thread's CLI (every thread key found on
// the way up, each with the thread ids beside it), under none, or can't
// tell. A thread's shell can wipe its own environment but not its CLI's, so
// the walk reads each parent's. Every look uses a fixed program or /proc,
// never PATH, and one that fails makes the answer `unresolved`, never "under
// none". Windows can't read another process's environment: unresolved.
// `unresolved` keeps the keys found before the look failed: tb's own
// environment's at least.
export type TbCaller = { kind: 'thread'; keys: ThreadKeyFound[] } | { kind: 'owner' } | { kind: 'unresolved'; why: string; keys: ThreadKeyFound[] };
type ThreadKeyFound = { key: string; ids: string[] };

export type CallerDeps = {
  table?: () => Promise<{ pid: number; ppid: number; pgid?: number; sid?: number }[]>;
  self?: number;
  // A process's environment as text: Linux's /proc entries, a Mac's `ps eww`
  // line. Throws if it can't be read.
  envOf?: (pid: number) => string;
  platform?: NodeJS.Platform;
  ppid?: number;
};

export async function tbCaller(env: NodeJS.ProcessEnv = process.env, deps: CallerDeps = {}): Promise<TbCaller> {
  const keys: ThreadKeyFound[] = [];
  // Under a CLI from before thread keys (an id with no key variable beside
  // it; a patch's action has the variable, empty): a thread's, with no key
  // to say which, so no answer (Daybreak finding 177's reviews).
  let keyless = false;
  const take = (text: string) => {
    const marks = threadMarksIn(text);
    for (const key of marks.keys) keys.push({ key, ids: marks.ids });
    if (marks.ids.length && !marks.keys.length && !marks.emptyKey) keyless = true;
  };
  // tb's own environment, read as its parents' are.
  take(['', ...MARK_NAMES.filter((n) => env[n] !== undefined).map((n) => `${n}=${env[n]}`), ''].join('\0'));
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32' && !deps.envOf) return { kind: 'unresolved', why: "Windows can't show another process's environment", keys };
  const envOf = deps.envOf ?? (platform === 'linux' ? linuxEnv : psEnv);
  try {
    const rows: { pid: number; ppid: number; pgid?: number; sid?: number }[] = await (deps.table ?? (platform === 'linux' ? () => procTable() : psTable))();
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const self = deps.self ?? process.pid;
    const me = byPid.get(self);
    if (!me) throw new Error(`this process (${self}) isn't in the process table`);
    const seen = new Set<number>([self]);
    const look = (p: number) => {
      if (!byPid.has(p)) throw new Error(`process ${p} isn't in the process table`);
      seen.add(p);
      take(envOf(p));
    };
    const walk = (from: number | undefined): number[] => {
      const chain: number[] = [];
      for (let p = from; p !== undefined && p > 1 && !seen.has(p); p = byPid.get(p)?.ppid) {
        look(p);
        chain.push(p);
      }
      return chain;
    };
    // Its parents, then every leader of a group or (Linux) session that it
    // or one of them is in, with theirs: a process that left its parents
    // behind keeps its group, and on Linux its session (Gemini's second
    // review of finding 174), and on a Mac a tool command's group leader is
    // its shell, one of Apple's programs, which shows no environment, so the
    // thread's CLI above it says whose it is (finding 177's reviews). A
    // session's leader that has gone is no answer; so is a group's, for a
    // process orphaned in it (its parent launchd or init): one in a terminal
    // pipeline whose first command has exited still has its parents. Only a
    // process that sets up a group and session of its own gets past this,
    // as with the runner's own look (SECURITY.md). A gone session leader
    // above tb's own (a terminal app started from a shell since closed)
    // says nothing about tb, so only tb's own counts. The parents are the
    // table's, the same look as everything else (Gemini's review).
    const queue = [self, ...walk(deps.ppid ?? me.ppid)];
    for (let i = 0; i < queue.length; i++) {
      const row = byPid.get(queue[i]!)!;
      for (const [leader, kind] of [[row.pgid, 'group'], [row.sid, 'session']] as const) {
        if (leader === undefined || leader <= 1 || leader === row.pid || seen.has(leader)) continue;
        if (!byPid.has(leader)) {
          if ((kind === 'session' && row.pid === self) || (kind === 'group' && row.ppid <= 1)) throw new Error(`process ${row.pid}'s ${kind} leader (${leader}) has gone`);
          continue;
        }
        queue.push(...walk(leader));
      }
    }
  } catch (e) {
    return { kind: 'unresolved', why: String((e as Error)?.message ?? e), keys };
  }
  if (!keys.length && keyless) return { kind: 'unresolved', why: 'a thread from before thread keys is above this', keys };
  return keys.length ? { kind: 'thread', keys } : { kind: 'owner' };
}

// A Mac's: /bin/ps, never one found on PATH, with the arguments taken off
// (`ps -ww` gives those alone), so a key or id in a command's arguments
// isn't one. A process of another user, or one of Apple's own programs,
// shows no environment, as none of a thread's CLIs are.
function psEnv(pid: number): string {
  const run = (args: string[]) => execFileSync('/bin/ps', [...args, '-o', 'pid=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const env = psEnvLines(run(['eww']), [pid], run(['-ww'])).get(pid);
  if (env === undefined) throw new Error(`ps showed nothing for process ${pid}`);
  return env;
}

// Linux's, exactly as the process got it. One of another user's can't be
// read, and isn't a thread's: those run as this user.
function linuxEnv(pid: number): string {
  try {
    return '\0' + fs.readFileSync(`/proc/${pid}/environ`, 'latin1') + '\0';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if ((code === 'EACCES' || code === 'EPERM') && fs.statSync(`/proc/${pid}`).uid !== process.getuid?.()) return '';
    throw e;
  }
}

// Whether this data dir's secrets are its own: the folder and everything in
// it (to three levels) neither a symlink nor a file with another hard link.
// A stand-in data dir can't then hold the real token or Convex key without
// reading them, so a runner that proves this token is the real one, not
// one a thread started on a copy that links to them (Codex's review of
// finding 174). Threadbear never links its secrets itself.
export function ownSecrets(home: string): boolean {
  const walk = (p: string, depth: number): boolean => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      // No secrets folder at all: nothing in it to borrow.
      return depth === 0 && (e as NodeJS.ErrnoException).code === 'ENOENT';
    }
    if (st.isSymbolicLink()) return false;
    if (st.isFile()) return st.nlink === 1;
    if (!st.isDirectory()) return false;
    if (depth >= 3) return true;
    let names: string[];
    try {
      names = fs.readdirSync(p);
    } catch {
      return false;
    }
    return names.every((n) => walk(path.join(p, n), depth + 1));
  };
  return walk(paths.secrets(home), 0);
}

const sameKey = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type OwnerOnlyDeps = CallerDeps & { connect?: (url: string, token: string) => Promise<RunnerClient> };

// The data dir a runner keeps by default for this user: from the account's
// own home (the password database), not $HOME, which the caller sets.
// On Windows, without %LOCALAPPDATA% too, which the caller sets (Codex's
// third review): the account's own AppData\Local.
export function realDefaultHome(platform: NodeJS.Platform = process.platform): string {
  return onDisk(dataDirFor({ home: os.userInfo().homedir, env: {}, platform }));
}

// A path as the disk spells it (case, 8.3 names and links resolved), so the
// default data dir compares equal however it was written (Gemini's review).
export function onDisk(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

// Why tb's commands that use this Mac's keys straight from disk (tb runner)
// shouldn't run here, or undefined if they may: they don't go through the
// RPC, so the runner can't refuse them itself (Daybreak finding 174, and
// three rounds of Codex's and Gemini's reviews).
// - A terminal (no thread key in tb's environment, its parents', its process
//   group leader's or, on Linux, its session leader's): asks the runner at
//   the port in its runner.json whether it's a limited thread after all, and
//   goes ahead if it says not, or if nothing at all is listening there (the
//   runner stopped). A runner that's there and won't answer is refused.
// - Anything else (in a thread, or can't tell: a look failing, always on
//   Windows): only with the default data dir, whose secrets are its own (no
//   links), so the token and keys are the runner's own and a stand-in data
//   dir, or a file swapped into one, can't take part. That runner, proved by
//   its token, must place the connection itself and say it isn't limited;
//   no answer is refused. With a thread key found, it must also name a
//   thread, and every key must be one this token made.
// THREADBEAR_URL and THREADBEAR_PORT aren't taken: the caller sets them.
export async function ownerOnly(cfg: Config, env: NodeJS.ProcessEnv = process.env, deps: OwnerOnlyDeps & { defaultHome?: string } = {}): Promise<string | undefined> {
  const who = await tbCaller(env, deps);
  const terminal = who.kind === 'owner';
  const keys = who.kind === 'owner' ? [] : who.keys;
  const cant =
    keys.length
      ? "This needs Full access and the runner can't be asked whether this thread has it."
      : who.kind === 'unresolved'
        ? `This uses the runner's own keys, so it has to know it isn't in a limited thread. It couldn't tell (${who.why}), and the runner couldn't be asked. Run it from a terminal with the runner going.`
        : "This uses the runner's own keys, and the runner didn't answer whether this is a limited thread. Try again, or stop the runner first.";
  let token = '';
  try {
    token = readToken(cfg.home);
  } catch {
    // No token yet: a terminal on a new runner; anything else is refused below.
  }
  if (!terminal) {
    if (onDisk(cfg.home) !== (deps.defaultHome ? onDisk(deps.defaultHome) : realDefaultHome())) return "From a thread's shell (or where tb can't tell it isn't one), tb runner only uses the runner's own data folder, not one named with THREADBEAR_HOME.";
    if (!token || !ownSecrets(cfg.home)) return "The runner's secrets folder isn't as Threadbear made it (missing, or a link in it), so tb runner won't use it from here.";
    if (!keys.every((k) => k.ids.some((id) => isThreadId(id) && sameKey(threadKey(token, id), k.key)))) {
      return "This is a thread's shell and tb isn't pointed at that thread's own runner, so it can't use a runner's keys from here.";
    }
  }
  const url = `ws://127.0.0.1:${readRunnerJson(cfg.home).port || DEFAULT_PORT}/rpc`;
  let client: RunnerClient;
  try {
    client = await (deps.connect ?? ((u, t) => RunnerClient.connect(u, t)))(url, token);
  } catch (e) {
    return terminal && (e as NodeJS.ErrnoException)?.code === 'ECONNREFUSED' ? undefined : cant;
  }
  try {
    const whoami = await client.call<{ threadId?: string; limited?: boolean; mode?: string }>('auth.whoami');
    if (whoami.limited) return `This thread is on ${whoami.mode}, and this command uses the runner's own keys. Ask the user to run it from a terminal.`;
    // The runner must see the thread this tb is under, on Full access.
    if (keys.length && !whoami.threadId) return cant;
    return undefined;
  } catch (e) {
    // An older runner has no auth.whoami: fine from a terminal, not otherwise.
    return terminal && (e as { code?: unknown })?.code === ErrorCode.methodNotFound ? undefined : cant;
  } finally {
    client.close();
  }
}
