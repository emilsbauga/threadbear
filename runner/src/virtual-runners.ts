// Virtual runners from the Mac (docs/virtual-runners.md, slice 5; docs/protocol.md,
// Virtual runners, "Starting from the Mac" and "Cloud tokens on the Mac"):
// starting a thread on one (threads.create with serviceId), and a Claude
// login's cloud token for its boxes, made here with `claude setup-token`,
// pasted, or this Mac's own year-long token for that login. Only the main
// Mac's runner (the owner key) does any of it, with the virtualRunners
// experiment on and a backend of API 94.
//
// A token is never logged, written to disk, put in an error or an event, or
// sent anywhere but boxes:setCloudToken. It's known to the scrubber
// (year-token.ts rememberToken) from the moment it's read.
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import type { Account } from './protocol.ts';
import { ErrorCode, RpcError, remoteCreateMode } from './protocol.ts';
import type { Logger } from './log.ts';
import { cloneableUrl, originUrl, repoTop, withoutCredentials } from './move-git.ts';
import { realpath } from './worktrees.ts';
import { readYearToken, rememberToken } from './year-token.ts';

export const VIRTUAL_RUNNERS_API = 94;
// Making one waits on Mike in the browser; past this the CLI is stopped.
export const MAKE_TOKEN_MS = 10 * 60_000;
const TOKEN = /^sk-ant-oat01-[A-Za-z0-9_-]{40,300}$/;
export const HELPER = path.join(import.meta.dirname, 'cloud-token-helper.py');

export type Repo = { origin: string; subfolder: string; baseBranch: string };

export type VirtualRunnerDeps = {
  // The experiment on, a backend of API 94 and the owner key: else every call is refused.
  on(): boolean;
  // An action, query or mutation on the owner key, the key added here by the caller.
  call(kind: 'action' | 'query' | 'mutation', fn: string, args: Record<string, unknown>): Promise<unknown>;
  accounts(): Account[];
  // The login a new thread with only a pool would start on (Runner's pool pick).
  poolLogin?(poolId: string): Account | undefined;
  claudePath(): string;
  // The new thread, listed and openable at once, before the sidebar's list has its row (relay.ts made).
  made(row: { runnerId: string; threadId: string; cwd: string; accountId: string; title: string; preview: string; createdAt: string }): void;
  log: Logger;
  now(): number;
  // Tests: the helper run, and its time limit.
  runHelper?: (cli: string, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<string | undefined>;
  makeTimeoutMs?: number;
  // Tests: the OS, for Make one's refusal on Windows.
  platform?: NodeJS.Platform;
};

const bad = (message: string) => new RpcError(ErrorCode.badParams, message);

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 10_000 }, (err, stdout) => resolve(err ? undefined : stdout.trim() || undefined));
  });
}

// GitHub's names: an owner and a repo, letters, digits, `.`, `_` and `-`.
const GH_PATH = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

/**
 * The address a box clones an origin from, or undefined when a box can't
 * reach it (Codex's review of slice 5, 6). A box clones over https only,
 * with no ssh key of Mike's: an https address the box's clone takes
 * (move-git.ts cloneableUrl, as cloneRepo checks it there), or GitHub's ssh
 * forms (`git@github.com:o/r.git`, `ssh://git@github.com/o/r.git`) as their
 * https address. A folder, `file://`, plain http, git:// and another host's
 * ssh are refused.
 */
export function boxOrigin(url: string): string | undefined {
  const s = url.trim();
  if (/^https:\/\//i.test(s)) return cloneableUrl(s) ? s : undefined;
  const ssh = /^ssh:\/\/(?:git@)?github\.com\/(.+)$/i.exec(s) ?? (s.includes('://') ? null : /^(?:git@)?github\.com:(.+)$/i.exec(s));
  if (!ssh) return undefined;
  const p = GH_PATH.exec(ssh[1]!);
  if (!p) return undefined;
  const https = `https://github.com/${p[1]}/${p[2]}`;
  return cloneableUrl(https) ? https : undefined;
}

/**
 * Which repo a folder on this Mac is, for a box to clone: its origin without
 * credentials (one with none is refused), the folder's path from the repo's
 * top, and the branch to start from: the current branch's upstream on
 * origin, else origin's default branch, else main.
 */
export async function repoOf(cwd: string): Promise<Repo> {
  const top = await repoTop(cwd);
  if (!top) throw bad(`${cwd} isn't in a git repo, so a box can't clone it. Pick a repo's folder.`);
  const raw = await originUrl(top);
  const origin = raw ? withoutCredentials(raw) : '';
  if (!origin) throw bad(`${path.basename(top)} has no origin a box can clone from. Push it somewhere first.`);
  const reachable = boxOrigin(origin);
  if (!reachable) throw bad(`A box can't reach ${origin}: it clones over https. Use a repo whose origin is an https address, or on GitHub.`);
  const rel = path.relative(realpath(top), realpath(cwd)).split(path.sep).join('/');
  const upstream = await git(top, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const fromOrigin = (ref: string | undefined) => (ref?.startsWith('origin/') ? ref.slice('origin/'.length) : undefined);
  const baseBranch = fromOrigin(upstream) ?? fromOrigin(await git(top, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])) ?? 'main';
  return { origin: reachable, subfolder: rel === '' || rel === '.' ? '' : rel, baseBranch };
}

/** The headless helper: its one line of output, or undefined when no token came back. */
export function runTokenHelper(cli: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    // Its own process group, so the CLI it started goes with it on a timeout.
    const child = spawn('python3', ['-I', HELPER, cli], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout.on('data', (b: Buffer) => {
      bytes += b.length;
      if (bytes <= 64 * 1024) chunks.push(b);
    });
    const kill = () => {
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(undefined);
      try {
        const token = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { token?: unknown }).token;
        resolve(typeof token === 'string' ? token : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

export class VirtualRunners {
  private making = new Map<string, Promise<Record<string, never>>>();
  private deps: VirtualRunnerDeps;
  constructor(deps: VirtualRunnerDeps) {
    this.deps = deps;
  }

  private mustBeOn(): void {
    if (!this.deps.on()) throw bad("Virtual runners aren't on for this runner (the virtualRunners experiment, a backend of API 94 and the main Mac's key).");
  }

  // This Mac's Claude login a cloud token is for: by its email, or its id when it has none.
  private loginAccount(login: string): Account {
    const a = this.deps.accounts().find((x) => x.provider === 'claude' && (x.email ?? x.id) === login);
    if (!a) throw bad(`There's no Claude login ${login} on this Mac.`);
    return a;
  }

  /** threads.create with serviceId. */
  async start(p: Record<string, unknown>): Promise<{ thread: Record<string, unknown> }> {
    this.mustBeOn();
    const serviceId = String(p.serviceId ?? '');
    if (!serviceId) throw bad('serviceId is required');
    if (Array.isArray(p.images) && p.images.length) throw bad("Pictures can't go with a thread's first message on a virtual runner yet.");
    const text = typeof p.text === 'string' ? p.text : '';
    if (!text.trim()) throw bad('text required');
    const cwd = typeof p.cwd === 'string' ? p.cwd : '';
    if (!cwd) throw bad('cwd is required: the folder of a repo on this Mac, which the box clones');
    const repo = await repoOf(cwd);
    const accountId = typeof p.accountId === 'string' && p.accountId ? p.accountId : undefined;
    const poolId = typeof p.poolId === 'string' && p.poolId ? p.poolId : undefined;
    const account = accountId ? this.deps.accounts().find((a) => a.id === accountId) : poolId ? this.deps.poolLogin?.(poolId) : undefined;
    if (!account) throw bad(accountId ? `There's no login ${accountId} on this Mac.` : 'Pick a Claude login for the thread.');
    if (account.provider !== 'claude') throw bad(`${account.title} isn't a Claude login: a virtual runner runs Claude Code.`);
    const login = account.email ?? account.id;
    const threadId = crypto.randomUUID();
    const mode = remoteCreateMode(p.permissionMode);
    const args: Record<string, unknown> = { serviceId, threadId, repo, login, text, cwd, accountId: account.id, ...mode };
    for (const k of ['model', 'effort'] as const) if (typeof p[k] === 'string' && p[k]) args[k] = p[k];
    let res: { runnerId: string };
    try {
      res = (await this.deps.call('action', 'boxes:startThread', args)) as { runnerId: string };
    } catch (e) {
      throw new RpcError(ErrorCode.other, (e as Error)?.message ?? String(e));
    }
    const now = new Date(this.deps.now()).toISOString();
    const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    this.deps.made({ runnerId: res.runnerId, threadId, cwd, accountId: account.id, title: line.slice(0, 120), preview: line.slice(0, 300), createdAt: now });
    this.deps.log.info('started a thread on a virtual runner', { threadId, runnerId: res.runnerId, serviceId, origin: repo.origin, subfolder: repo.subfolder, baseBranch: repo.baseBranch });
    return {
      thread: {
        id: threadId,
        title: line.slice(0, 120),
        cwd,
        accountId: account.id,
        provider: 'claude',
        ...(typeof p.model === 'string' && p.model ? { model: p.model } : {}),
        status: 'starting',
        needsYou: false,
        createdAt: now,
        lastActivityAt: now,
        lastSeq: 0,
        lastSeenSeq: 0,
        preview: line.slice(0, 300),
        runnerId: res.runnerId,
      },
    };
  }

  // The one way a token leaves: sealed by the backend. Its errors never carry it.
  private async setToken(login: string, token: string, madeAt: number): Promise<void> {
    rememberToken(token);
    try {
      await this.deps.call('action', 'boxes:setCloudToken', { login, token, madeAt });
    } catch (e) {
      const message = String((e as Error)?.message ?? e).split(token).join('[REDACTED]');
      throw new RpcError(ErrorCode.other, `The cloud token couldn't be set: ${message}`);
    }
  }

  /** cloudTokens.make: `claude setup-token` for this Mac's login, headless; a second call for the same login joins the first. */
  async make(login: string): Promise<Record<string, never>> {
    this.mustBeOn();
    const account = this.loginAccount(login);
    // The helper runs the CLI in a pseudo-terminal (Python's pty), which Windows hasn't got.
    if ((this.deps.platform ?? process.platform) === 'win32') {
      throw new RpcError(ErrorCode.other, "Make one can't run on Windows. Run claude setup-token in a terminal and paste the token it prints.");
    }
    const going = this.making.get(login);
    if (going) return going;
    const run = (async () => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      // claude-main is the login with no folder of its own (as the runner starts it).
      if (account.id !== 'claude-main' && account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
      else delete env.CLAUDE_CONFIG_DIR;
      for (const k of Object.keys(env)) if (k.startsWith('THREADBEAR_') || k.startsWith('THREADBARE_') || k === 'CLAUDE_CODE_OAUTH_TOKEN') delete env[k];
      this.deps.log.info('making a cloud token', { login: account.id });
      const token = await (this.deps.runHelper ?? runTokenHelper)(this.deps.claudePath(), env, this.deps.makeTimeoutMs ?? MAKE_TOKEN_MS);
      if (!token || !TOKEN.test(token)) {
        this.deps.log.warn('no cloud token came back from claude setup-token', { login: account.id });
        throw new RpcError(ErrorCode.other, "No token came back from claude setup-token. Approve it in the browser when it opens, or paste one.");
      }
      await this.setToken(login, token, this.deps.now());
      this.deps.log.info('cloud token set', { login: account.id, how: 'made' });
      return {} as Record<string, never>;
    })().finally(() => this.making.delete(login));
    this.making.set(login, run);
    return run;
  }

  /** cloudTokens.set: one Mike pasted. */
  async set(login: string, token: string): Promise<Record<string, never>> {
    this.mustBeOn();
    const t = token.replace(/\s+/g, '');
    if (!TOKEN.test(t)) throw bad("That doesn't look like a token from claude setup-token (sk-ant-oat01-…).");
    await this.setToken(login, t, this.deps.now());
    this.deps.log.info('cloud token set', { how: 'pasted' });
    return {};
  }

  /** cloudTokens.useMac: this Mac's year-long token for that login, which Mike picked on the card. */
  async useMac(login: string): Promise<Record<string, never>> {
    this.mustBeOn();
    const account = this.loginAccount(login);
    const year = readYearToken(account.configDir);
    if (!year) throw bad(`${account.title} has no year-long token on this Mac.`);
    const made = year.madeAt ? Date.parse(year.madeAt) : NaN;
    await this.setToken(login, year.token, Number.isFinite(made) && made <= this.deps.now() ? made : this.deps.now());
    this.deps.log.info('cloud token set', { login: account.id, how: "this Mac's year-long token" });
    return {};
  }

  /** cloudTokens.list: never a token. */
  async list(): Promise<{ tokens: { login: string; madeAt: number; setAt: number; state: string }[] }> {
    this.mustBeOn();
    const rows = (await this.deps.call('query', 'boxes:cloudTokens', {})) as { login: string; madeAt: number; setAt: number; state?: string }[];
    return { tokens: rows.map((r) => ({ login: r.login, madeAt: r.madeAt, setAt: r.setAt, state: r.state ?? 'valid' })) };
  }
}
