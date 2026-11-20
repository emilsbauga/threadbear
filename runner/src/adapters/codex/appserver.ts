// One `codex app-server` process and the JSON-RPC it speaks over stdio.
// Threadbear runs one of these per live Codex thread (docs/step4-plan.md,
// "Why one process per thread"): released threads never unload inside an
// app-server, so sharing one would only grow. Closing stdin ends the
// process in milliseconds, with its MCP servers and running commands.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import type { Account } from '../../protocol.ts';
import type { Logger } from '../../log.ts';
import { groupSpawner, groupAlive, killGroup, type ProcessRegistry } from '../../proc.ts';
import { RUNNER_VERSION } from '../../config.ts';
import { codexBeside, exeName } from '../../platform.ts';
import { cliEnv } from '../claude/adapter.ts';
import { refusal } from './approvals.ts';
import { OVERSIZED_LINE } from './normalize.ts';
import type {
  GetAccountRateLimitsResponse,
  InitializeParams,
  InitializeResponse,
  RateLimitSnapshot,
  RequestId,
  RpcErrorBody,
} from './types.ts';

// ---- Which binary

const PLATFORM: Record<string, { pkg: string; triple: string }> = {
  'darwin-arm64': { pkg: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin' },
  'darwin-x64': { pkg: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin' },
  'linux-arm64': { pkg: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl' },
  'linux-x64': { pkg: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl' },
  // As @openai/codex's own bin/codex.js has them, with codex.exe.
  'win32-x64': { pkg: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { pkg: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' },
};

export type CodexBinary = {
  // What to spawn, and the arguments that go before `app-server`.
  command: string;
  args: string[];
  // True when command is the native binary behind the npm launcher.
  native: boolean;
  // The @openai/codex package folder, when known (CODEX_MANAGED_PACKAGE_ROOT).
  packageRoot?: string;
};

// The codex next to the runner's own Node: the npm copy Threadbear falls
// back to until it has a copy of its own (section E), or when updates are
// off. Never ~/.local/bin/codex, a standalone build nothing updates.
export function fallbackCodexPath(execPath: string = process.execPath, platform: NodeJS.Platform = process.platform): string {
  return codexBeside(execPath, platform);
}

// Finds the native Codex binary behind a launcher, so each thread doesn't
// also pay for the launcher's own Node process (about 50 MB). `start` can be
// the npm launcher (`bin/codex`, a link to `@openai/codex/bin/codex.js`),
// codex.js itself, an `npm install --prefix` folder (Threadbear's own copies,
// `<home>/tools/codex/<v>` or its `current` link), or a native binary set by
// hand. Resolved again on every spawn, so a new process picks up a new
// `current`. When the native binary can't be found, the launcher itself is
// spawned (through Node, so it works without node on PATH).
export function resolveCodexBinary(start: string, execPath: string = process.execPath): CodexBinary {
  const launcher = findLauncher(start);
  if (launcher) {
    const native = nativeBinaryFor(launcher);
    const packageRoot = path.dirname(path.dirname(launcher));
    if (native) return { command: native, args: [], native: true, packageRoot };
    return { command: execPath, args: [launcher], native: false, packageRoot };
  }
  // Not an npm launcher: a native binary (or a stand-in) used as is. A path
  // that doesn't exist is spawned as given, so the spawn reports ENOENT and
  // is retried (an npm reinstall leaves no binary for a second or two).
  return { command: start, args: [], native: false };
}

// The real path of @openai/codex's bin/codex.js for `start`, or null.
function findLauncher(start: string): string | null {
  const candidates = [start];
  // npm's codex.cmd on Windows (a codexPath set by hand) is a batch file
  // Node can't start without a shell; the package sits beside it.
  if (/\.cmd$/i.test(start)) candidates.unshift(path.join(path.dirname(start), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  try {
    if (fs.statSync(start).isDirectory()) {
      candidates.unshift(
        path.join(start, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
        path.join(start, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
        path.join(start, 'bin', 'codex.js'),
      );
    }
  } catch {
    return null;
  }
  for (const c of candidates) {
    try {
      const real = fs.realpathSync(c);
      if (path.basename(real) !== 'codex.js' || !fs.statSync(real).isFile()) continue;
      const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(real)), 'package.json'), 'utf8')) as { name?: string };
      if (pkg.name === '@openai/codex') return real;
    } catch {
      // try the next
    }
  }
  return null;
}

// Resolves the platform package the way the launcher does, whether npm
// hoisted it next to @openai/codex or nested it inside.
export function nativeBinaryFor(launcher: string, platform = `${process.platform}-${process.arch}`): string | null {
  const p = PLATFORM[platform];
  if (!p) return null;
  try {
    const pkgJson = createRequire(launcher).resolve(`${p.pkg}/package.json`);
    const bin = path.join(path.dirname(pkgJson), 'vendor', p.triple, 'bin', exeName('codex', platform.split('-')[0] as NodeJS.Platform));
    fs.accessSync(bin, fs.constants.X_OK);
    return bin;
  } catch {
    return null;
  }
}

// ---- Environment

// Variables a Codex session sets for the commands it runs. A runner started
// from inside one (a test run from a Codex thread) would pass them on.
const INHERITED_CODEX_VARS = [
  'CODEX_HOME',
  'CODEX_THREAD_ID',
  'CODEX_TOOL_CALL_ID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_CI',
  'CODEX_MANAGED_BY_NPM',
  'CODEX_MANAGED_BY_BUN',
  'CODEX_MANAGED_BY_PNPM',
  'CODEX_MANAGED_BY_VITE_PLUS',
  'CODEX_MANAGED_PACKAGE_ROOT',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
];

export function codexEnv(
  account: Account,
  threadEnv: Record<string, string> | undefined,
  packageRoot: string | undefined,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  // cliEnv drops the variables a parent Claude Code session sets; the two
  // it adds are Claude's own and don't belong here.
  const env = cliEnv(account, base);
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CLAUDE_AGENT_SDK_CLIENT_APP;
  for (const k of INHERITED_CODEX_VARS) delete env[k];
  // Set for codex-main too, so nothing inherited can point it elsewhere.
  env.CODEX_HOME = account.configDir;
  // What the npm launcher would set, since the native binary is started
  // without it.
  env.CODEX_MANAGED_BY_NPM = '1';
  if (packageRoot) env.CODEX_MANAGED_PACKAGE_ROOT = packageRoot;
  // As T3 does: the model catalogue refresh before initialize, and the
  // threads Codex records, carry Threadbear's name.
  env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = 'Threadbear';
  return { ...env, ...threadEnv };
}

// "threadbear/0.164.0 (Mac OS 26.6.2; arm64) unknown (threadbear; 0.1.0)"
// -> "0.164.0": the part after the first "/", up to the space.
export function parseUserAgentVersion(userAgent: unknown): string | undefined {
  if (typeof userAgent !== 'string') return undefined;
  const m = /^[^/\s]+\/([^\s]+)/.exec(userAgent);
  return m ? m[1] : undefined;
}

// ---- Line reading

// Biggest line read. Real lines reach several MB (a generated image's
// item/completed carries its base64; mcpServerStatus/list with Mike's config
// is 2.5 MB), so this is only a guard against something runaway.
export const MAX_LINE_BYTES = 256 * 1024 * 1024;
const PEEK = 64 * 1024;

// What could be read from the ends of a line over the guard. The adapter
// hands it to the normaliser as OVERSIZED_LINE, so the item it completed is
// closed as "Too large to show" and nothing else fails.
export type OversizedLine = { bytes: number; method?: string; threadId?: string; turnId?: string; itemId?: string; itemType?: string };
export { OVERSIZED_LINE };

export class LineReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private skipping = false;
  private head: Buffer | null = null;
  private tail: Buffer = Buffer.alloc(0);
  private max: number;
  private onLine: (line: Buffer) => void;
  private onOversize: (info: OversizedLine) => void;

  constructor(max: number, onLine: (line: Buffer) => void, onOversize: (info: OversizedLine) => void) {
    this.max = max;
    this.onLine = onLine;
    this.onOversize = onOversize;
  }

  push(data: Buffer): void {
    while (data.length) {
      const nl = data.indexOf(10);
      const part = nl < 0 ? data : data.subarray(0, nl);
      if (!this.skipping && this.size + part.length > this.max) {
        // Over the guard: keep only the two ends, to say what it was.
        const joined = Buffer.concat([...this.chunks, part.subarray(0, PEEK)]);
        this.head = joined.subarray(0, PEEK);
        this.chunks = [];
        this.skipping = true;
      }
      if (this.skipping) {
        this.size += part.length;
        this.tail = Buffer.concat([this.tail, part.subarray(Math.max(0, part.length - PEEK))]);
        if (this.tail.length > PEEK) this.tail = this.tail.subarray(this.tail.length - PEEK);
      } else if (part.length) {
        this.chunks.push(part);
        this.size += part.length;
      }
      if (nl < 0) return;
      if (this.skipping) this.onOversize(describeLine(this.head!, this.tail, this.size));
      else if (this.size) this.onLine(this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks));
      this.chunks = [];
      this.size = 0;
      this.skipping = false;
      this.head = null;
      this.tail = Buffer.alloc(0);
      data = data.subarray(nl + 1);
    }
  }
}

function describeLine(head: Buffer, tail: Buffer, bytes: number): OversizedLine {
  const h = head.toString('utf8');
  const t = tail.toString('utf8');
  const out: OversizedLine = { bytes };
  const pick = (re: RegExp): string | undefined => {
    const all = [...h.matchAll(re), ...t.matchAll(re)];
    return all.length ? all[all.length - 1][1] : undefined;
  };
  const method = /"method"\s*:\s*"([^"]+)"/.exec(h)?.[1];
  if (method) out.method = method;
  const item = /"item"\s*:\s*\{\s*"type"\s*:\s*"([^"]+)"\s*,\s*"id"\s*:\s*"([^"]+)"/.exec(h);
  if (item) {
    out.itemType = item[1];
    out.itemId = item[2];
  }
  const threadId = pick(/"threadId"\s*:\s*"([^"]+)"/g);
  if (threadId) out.threadId = threadId;
  const turnId = pick(/"turnId"\s*:\s*"([^"]+)"/g);
  if (turnId) out.turnId = turnId;
  return out;
}

// ---- The process

export class CodexRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(method: string, body: RpcErrorBody) {
    super(typeof body?.message === 'string' ? body.message : `${method} failed`);
    this.name = 'CodexRpcError';
    this.code = typeof body?.code === 'number' ? body.code : -32603;
    this.data = body?.data;
  }
}

export class CodexExitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexExitedError';
  }
}

export type AppServerTimings = {
  requestMs: number; // per request
  turnStartMs: number; // turn/start, which waits for the turn to be set up
  spawnRetryMs: number; // between start attempts
  spawnRetryForMs: number; // how long to keep trying
  closeWaitMs: number; // after closing stdin, before killing the group
};
export const DEFAULT_TIMINGS: AppServerTimings = {
  requestMs: 30_000,
  turnStartMs: 60_000,
  spawnRetryMs: 1000,
  spawnRetryForMs: 10_000,
  closeWaitMs: 5000,
};

export type AppServerOptions = {
  binary: string; // resolved with resolveCodexBinary on every start
  args?: string[]; // extra `app-server` arguments (codexArgs)
  account: Account;
  env?: Record<string, string>; // the thread's THREADBEAR_* variables and PATH
  cwd: string;
  registry: ProcessRegistry;
  log: Logger;
  label: string; // the thread id, or "models:codex-main", for log lines
  maxLineBytes?: number;
  timings?: Partial<AppServerTimings>;
};

export type ServerRequestHandler = (id: RequestId, method: string, params: unknown) => void;

const OPT_OUT = ['turn/diff/updated', 'turn/moderationMetadata', 'remoteControl/status/changed'];

export class AppServerProcess {
  readonly label: string;
  // The binary actually started (the native one when found), so E can tell
  // which version folders are in use.
  binaryPath?: string;
  // The Codex version this process runs, from initialize's userAgent.
  version?: string;
  codexHome?: string;
  pid?: number;
  // Set by the session. A request from Codex with no handler (before a
  // session attaches, after it ends) is refused at once.
  onRequest: ServerRequestHandler | null = null;
  onNotification: ((method: string, params: unknown) => void) | null = null;
  onOversize: ((info: OversizedLine) => void) | null = null;
  // Once, when the process is gone (closed, killed or crashed) after start
  // succeeded. error is set unless it was closed or killed on purpose.
  onExit: ((error?: Error) => void) | null = null;

  private opts: AppServerOptions;
  private t: AppServerTimings;
  private child?: ChildProcess;
  private abort?: AbortController;
  private nextId = 1;
  private pending = new Map<RequestId, { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stderrTail: string[] = [];
  private exited = true;
  private exitWaiters: (() => void)[] = [];
  private closing = false;
  private started = false;

  constructor(opts: AppServerOptions) {
    this.opts = opts;
    this.label = opts.label;
    this.t = { ...DEFAULT_TIMINGS, ...opts.timings };
  }

  get alive(): boolean {
    return !this.exited;
  }

  // Spawns the process and completes the handshake. A spawn that finds no
  // binary, or a process that exits before initialize answers, is retried
  // every second for ten seconds: the npm fallback copy has no binary for a
  // second or two while Token Stats reinstalls it.
  async start(): Promise<InitializeResponse> {
    const deadline = Date.now() + this.t.spawnRetryForMs;
    const closed = () => new CodexExitedError('codex app-server was closed while it started');
    for (;;) {
      // close() during the retry wait: never spawn again.
      if (this.closing) throw closed();
      try {
        const init = await this.startOnce();
        if (this.closing) {
          // close() came while this one was starting and found it not yet
          // spawned (or between attempts): don't leave it running.
          await this.stop();
          throw closed();
        }
        this.started = true;
        return init;
      } catch (e) {
        const retryable = e instanceof CodexExitedError || (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'EACCES';
        if (!retryable || this.closing || Date.now() + this.t.spawnRetryMs > deadline) throw e;
        this.opts.log.info('codex app-server did not start; retrying', { threadId: this.label, error: (e as Error).message });
        await new Promise((r) => setTimeout(r, this.t.spawnRetryMs));
      }
    }
  }

  private startOnce(): Promise<InitializeResponse> {
    const { opts } = this;
    const bin = resolveCodexBinary(opts.binary);
    const env = codexEnv(opts.account, opts.env, bin.packageRoot);
    this.abort = new AbortController();
    this.stderrTail = [];
    const spawn = groupSpawner(opts.registry, opts.log, (line) => this.stderr(line), opts.label);
    const child = spawn({
      command: bin.command,
      args: [...bin.args, 'app-server', ...(opts.args ?? [])],
      cwd: opts.cwd,
      env,
      signal: this.abort.signal,
    } as never) as unknown as ChildProcess;
    this.child = child;
    this.pid = child.pid;
    this.binaryPath = bin.native ? bin.command : (bin.args[0] ?? bin.command);
    this.exited = false;
    return new Promise<InitializeResponse>((resolve, reject) => {
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        reject(e);
      };
      child.on('error', (e) => {
        // ENOENT and friends: the spawn itself failed and no exit follows.
        this.markExited();
        fail(e);
      });
      child.stdin?.on('error', () => {
        // EPIPE when it died; the exit handler reports it.
      });
      const reader = new LineReader(
        opts.maxLineBytes ?? MAX_LINE_BYTES,
        (line) => this.onLine(line),
        (info) => {
          opts.log.warn('skipped a line from codex over the size guard', { threadId: opts.label, ...info });
          this.onOversize?.(info);
        },
      );
      child.stdout?.on('data', (d: Buffer) => reader.push(d));
      child.once('exit', (code, signal) => {
        const tail = this.stderrTail.slice(-5).join('\n');
        this.markExited();
        const what = `codex app-server exited (${signal ?? `code ${code}`})${tail ? `\n${tail}` : ''}`;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new CodexExitedError(what));
        }
        this.pending.clear();
        if (!settled) return fail(new CodexExitedError(what));
        const onExit = this.onExit;
        this.onExit = null;
        onExit?.(this.closing ? undefined : new Error(what));
      });
      const params: InitializeParams = {
        clientInfo: { name: 'threadbear', title: 'Threadbear', version: RUNNER_VERSION },
        capabilities: { experimentalApi: true, optOutNotificationMethods: OPT_OUT },
      };
      this.request<InitializeResponse>('initialize', params)
        .then((init) => {
          this.version = parseUserAgentVersion(init?.userAgent);
          this.codexHome = init?.codexHome;
          this.notify('initialized');
          settled = true;
          resolve(init);
        })
        .catch(fail);
    });
  }

  private markExited(): void {
    this.exited = true;
    const ws = this.exitWaiters;
    this.exitWaiters = [];
    ws.forEach((w) => w());
  }

  private stderr(line: string): void {
    if (!line.trim()) return;
    this.stderrTail.push(line);
    if (this.stderrTail.length > 20) this.stderrTail.shift();
    this.opts.log.debug('codex stderr', { threadId: this.label, line: line.slice(0, 500) });
  }

  stderrLines(): string[] {
    return [...this.stderrTail];
  }

  private onLine(line: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line.toString('utf8'));
    } catch {
      this.opts.log.warn('unparseable line from codex', { threadId: this.label, bytes: line.length });
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const hasId = typeof msg.id === 'number' || typeof msg.id === 'string';
    if (typeof msg.method === 'string') {
      // A request from Codex (its own id space, from 0 in each process), or
      // a notification. emittedAtMs, next to params, is ignored.
      if (hasId) this.dispatchRequest(msg.id as RequestId, msg.method, msg.params);
      else this.onNotification?.(msg.method, msg.params);
      return;
    }
    if (hasId) {
      const p = this.pending.get(msg.id as RequestId);
      if (!p) return;
      this.pending.delete(msg.id as RequestId);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CodexRpcError(p.method, msg.error as RpcErrorBody));
      else p.resolve(msg.result);
    }
  }

  private dispatchRequest(id: RequestId, method: string, params: unknown): void {
    if (this.onRequest) {
      try {
        this.onRequest(id, method, params);
      } catch (e) {
        this.opts.log.error('codex request handler threw', { threadId: this.label, method, error: String(e) });
        this.respondError(id, -32603, 'Threadbear could not handle this request.');
      }
      return;
    }
    // Nothing is attached to answer it: refuse straight away, so Codex
    // never waits on us.
    this.opts.log.warn('refused a codex request with no session attached', { threadId: this.label, method });
    const r = refusal(method);
    if ('result' in r) this.respond(id, r.result);
    else this.respondError(id, r.error.code, r.error.message);
  }

  private write(msg: Record<string, unknown>): boolean {
    const stdin = this.child?.stdin;
    if (this.exited || !stdin || stdin.destroyed || stdin.writableEnded) return false;
    stdin.write(JSON.stringify(msg) + '\n');
    return true;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const id = this.nextId++;
    const ms = timeoutMs ?? (method === 'turn/start' ? this.t.turnStartMs : this.t.requestMs);
    return new Promise<T>((resolve, reject) => {
      if (this.exited) return reject(new CodexExitedError('codex app-server is not running'));
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex didn't answer ${method} within ${Math.round(ms / 1000)} s`));
      }, ms);
      timer.unref();
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      const msg: Record<string, unknown> = { id, method };
      if (params !== undefined) msg.params = params;
      if (!this.write(msg)) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CodexExitedError('codex app-server is not running'));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: Record<string, unknown> = { method };
    if (params !== undefined) msg.params = params;
    this.write(msg);
  }

  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      t.unref();
      this.exitWaiters.push(() => {
        clearTimeout(t);
        resolve(true);
      });
    });
  }

  // Ends stdin, which ends the process (13 to 52 ms measured) along with
  // its MCP servers and running commands. If it hasn't gone after
  // closeWaitMs, its process group is killed.
  async close(): Promise<void> {
    this.closing = true;
    await this.stop();
  }

  private async stop(): Promise<void> {
    if (this.exited) return;
    this.child?.stdin?.end();
    if (await this.waitExit(this.t.closeWaitMs)) return;
    this.opts.log.warn('codex app-server did not exit after stdin closed; killing it', { threadId: this.label, pid: this.pid });
    if (this.pid) killGroup(this.pid, 'SIGKILL');
    await this.waitExit(2000);
  }

  // Stops the process group straight away (SIGTERM, then SIGKILL).
  kill(): void {
    this.closing = true;
    if (this.exited) return;
    if (this.pid) {
      const pid = this.pid;
      killGroup(pid, 'SIGTERM');
      setTimeout(() => {
        if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
      }, 3000).unref();
    } else {
      this.abort?.abort();
    }
  }

  get wasStarted(): boolean {
    return this.started;
  }
}

// Starts a process for an account with no thread (so no MCP servers), makes
// its calls and closes it: models() and archive().
export async function withShortLivedProcess<T>(opts: AppServerOptions, fn: (p: AppServerProcess) => Promise<T>, track?: (p: AppServerProcess, live: boolean) => void): Promise<T> {
  const p = new AppServerProcess(opts);
  track?.(p, true);
  try {
    await p.start();
    return await fn(p);
  } finally {
    await p.close().catch(() => undefined);
    track?.(p, false);
  }
}

// ---- Rate limits

// account/rateLimits/updated is partial (one bucket at a time, with nulls
// for what it doesn't know) and carries no thread id, so the process keeps
// the merged picture: the account/rateLimits/read taken at start, with each
// update laid over it. The normaliser turns the merged snapshot into a
// `limits` reading.
//
// The read's reply can arrive after an update that Codex sent later than it
// took the reading, so a read is applied as of when it was asked for: the
// updates received since then are laid over it again (mark() before the
// request, read(r, mark) with the reply).
export class RateLimitTracker {
  private seq = 0;
  private recent: { seq: number; snap: RateLimitSnapshot }[] = [];
  private snapshot: { ordinaryUsageAllowed: boolean | null; rateLimits: RateLimitSnapshot | null; rateLimitsByLimitId: Record<string, RateLimitSnapshot> } = {
    ordinaryUsageAllowed: null,
    rateLimits: null,
    rateLimitsByLimitId: {},
  };
  // The read's usage-limit resets. Only a read carries them, so each
  // reading after it repeats the read's count.
  private resetCredits: GetAccountRateLimitsResponse['rateLimitResetCredits'];

  // Where the updates stand now, for a read about to be requested.
  mark(): number {
    return this.seq;
  }

  read(r: GetAccountRateLimitsResponse, since = this.seq): GetAccountRateLimitsResponse {
    if (r && typeof r === 'object') {
      if (typeof r.ordinaryUsageAllowed === 'boolean') this.snapshot.ordinaryUsageAllowed = r.ordinaryUsageAllowed;
      if (r.rateLimitResetCredits && typeof r.rateLimitResetCredits === 'object') this.resetCredits = r.rateLimitResetCredits;
      for (const [id, snap] of Object.entries(r.rateLimitsByLimitId ?? {})) if (snap) this.merge(snap, id);
      if (r.rateLimits) this.merge(r.rateLimits);
      // Newer than the reading: put back on top.
      for (const u of this.recent) if (u.seq > since) this.merge(u.snap);
    }
    return this.current();
  }

  update(params: unknown): GetAccountRateLimitsResponse {
    const p = params as { rateLimits?: RateLimitSnapshot; ordinaryUsageAllowed?: unknown } | undefined;
    const snap = p?.rateLimits;
    if (typeof p?.ordinaryUsageAllowed === 'boolean') this.snapshot.ordinaryUsageAllowed = p.ordinaryUsageAllowed;
    else if (snap && (snap.limitId ?? 'codex') === 'codex' && snap.rateLimitReachedType === null && this.snapshot.ordinaryUsageAllowed === false) {
      // Updates don't carry ordinaryUsageAllowed. The start-up read's
      // "false" mustn't outlive a main bucket that now says it isn't at its
      // limit, or the account would look blocked until the next process.
      this.snapshot.ordinaryUsageAllowed = null;
    }
    if (snap && typeof snap === 'object') {
      this.merge(snap);
      this.recent.push({ seq: ++this.seq, snap });
      if (this.recent.length > 50) this.recent.shift();
    }
    return this.current();
  }

  private merge(snap: RateLimitSnapshot, idHint?: string): void {
    const id = (typeof snap.limitId === 'string' && snap.limitId) || idHint || 'codex';
    const prev = this.snapshot.rateLimitsByLimitId[id];
    const next: RateLimitSnapshot = { ...(prev ?? ({} as RateLimitSnapshot)) };
    // An explicit null clears what was known: rateLimitReachedType goes back
    // to null after a reset, and a block must lift with it.
    for (const [k, v] of Object.entries(snap)) if (v !== undefined) next[k] = v;
    // A bucket that has never reported a window keeps it null rather than
    // undefined, as Codex sends it.
    for (const k of ['limitId', 'limitName', 'primary', 'secondary', 'credits', 'planType', 'rateLimitReachedType'] as const) {
      if (next[k] === undefined) (next as Record<string, unknown>)[k] = null;
    }
    next.limitId = id;
    this.snapshot.rateLimitsByLimitId[id] = next;
    if (id === 'codex') this.snapshot.rateLimits = next;
  }

  current(): GetAccountRateLimitsResponse {
    const s = this.snapshot;
    const main = s.rateLimits ?? Object.values(s.rateLimitsByLimitId)[0] ?? null;
    return {
      ordinaryUsageAllowed: s.ordinaryUsageAllowed,
      rateLimits: main as RateLimitSnapshot,
      rateLimitsByLimitId: { ...s.rateLimitsByLimitId },
      ...(this.resetCredits ? { rateLimitResetCredits: this.resetCredits } : {}),
    };
  }
}

// ---- Child threads

// Subagents run inside the parent's process, so their traffic arrives on
// this connection under their own thread ids. This maps each child to the
// session's own (root) thread. The main source is the parent's
// subAgentActivity {kind: "started", agentThreadId}, which arrives just
// before the child's first notification; thread/started.parentThreadId and
// collabAgentToolCall.receiverThreadIds are kept as extra sources.
export class ChildThreads {
  private children = new Set<string>();

  add(id: unknown): void {
    if (typeof id === 'string' && id) this.children.add(id);
  }

  has(id: string): boolean {
    return this.children.has(id);
  }

  ids(): string[] {
    return [...this.children];
  }

  // Learns children from a notification of the root thread or a known child.
  learn(method: string, params: Record<string, unknown> | undefined, rootId: string | undefined): void {
    if (!params) return;
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item as { type?: string; kind?: string; agentThreadId?: unknown; receiverThreadIds?: unknown } | undefined;
      if (item?.type === 'subAgentActivity' && item.kind === 'started') this.add(item.agentThreadId);
      if (item?.type === 'collabAgentToolCall' && Array.isArray(item.receiverThreadIds)) item.receiverThreadIds.forEach((id) => this.add(id));
    } else if (method === 'thread/started') {
      const t = params.thread as { id?: unknown; parentThreadId?: unknown } | undefined;
      if (t && typeof t.parentThreadId === 'string' && (t.parentThreadId === rootId || this.children.has(t.parentThreadId))) this.add(t.id);
    }
  }
}
