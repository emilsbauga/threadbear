import { fileURLToPath } from 'node:url';
import { PiBridge } from './bridge.ts';
import { fileContext } from '../context.ts';
import type { ToolDefinition } from '../../agent-tools.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Account, EffortLevel, ModelChoice, PermissionMode, PiProfile } from '../../protocol.ts';
import type { Logger } from '../../log.ts';
import type { ProcessRegistry } from '../../proc.ts';
import { SessionNotFoundError, type AgentAdapter, type AgentSession, type SessionSink, type StartSessionOptions, type UserInput } from '../types.ts';
import { PiMissingSessionError, PiRpc, type RecordValue } from './rpc.ts';
import { PiNormalizer } from './normalize.ts';

export type PiAdapterDeps = {
  registry: Pick<ProcessRegistry, 'add' | 'remove'>;
  log: Logger;
  // Prefix arguments for a managed launcher or deterministic test process.
  args?: string[];
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxLineBytes?: number;
  profileFor?(accountId: string): PiProfile | undefined;
  toolsFor?(threadId: string): ToolDefinition[];
  instructionsFor?(threadId: string): string;
};
type PiStartOptions = StartSessionOptions<Account | PiProfile>;
type Turn = { input: UserInput; started: number; normalizer: PiNormalizer; acknowledged: boolean; settled: boolean; interrupted: boolean; cancelled: string[] };
const ISOLATION_ARGS = ['--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve', '--offline'];

// Profile-backed RPC sessions. Without a bridge, executable tools stay disabled.
export class PiAdapter implements AgentAdapter {
  readonly provider = 'pi';
  readonly settingsApplyNextTurn = true;
  readonly wakesAfterTasks = false;
  private deps: PiAdapterDeps;
  constructor(deps: PiAdapterDeps) { this.deps = deps; }
  start(options: PiStartOptions, sink: SessionSink): AgentSession { return new PiSession(options, sink, this.deps); }

  async models(account: Account): Promise<ModelChoice[]> {
    const profile = this.deps.profileFor?.(account.id);
    if (!profile) throw new Error('The Pi profile for this account is unavailable.');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'threadbear-pi-models-'));
    let rpc: PiRpc | undefined;
    try {
      rpc = new PiRpc({ command: profile.executable,
        args: [...(this.deps.args ?? []), '--mode', 'rpc', '--no-session', '--session-dir', path.join(root, 'sessions'), '--no-tools', ...ISOLATION_ARGS],
        cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: profile.configDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
        diagnosticsDir: root, registry: this.deps.registry, log: this.deps.log,
        requestTimeoutMs: this.deps.requestTimeoutMs ?? 15_000, shutdownTimeoutMs: this.deps.shutdownTimeoutMs ?? 3000,
        maxLineBytes: this.deps.maxLineBytes, event() {}, exited() {},
      });
      const result = await rpc.request('get_available_models');
      if (!Array.isArray(result.models)) throw new Error('Pi returned no model list.');
      const models = new Map<string, ModelChoice>();
      for (const model of result.models) {
        if (model?.provider !== profile.connection.provider || typeof model.id !== 'string' || !model.id.trim()) continue;
        if (!models.has(model.id)) models.set(model.id, { id: model.id, model: model.id, title: typeof model.name === 'string' && model.name.trim() ? model.name : model.id, effortLevels: [] });
      }
      return [...models.values()];
    } finally {
      await rpc?.end();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

class PiSession implements AgentSession {
  private rpc?: PiRpc;
  private profile: PiProfile;
  private bridge?: PiBridge;
  private cleanup: Promise<void> = Promise.resolve();
  private dialogs = new Set<AbortController>();
  private mode: PermissionMode;
  private nextMode: PermissionMode;
  private rules: Set<string>;
  private ready: Promise<void>;
  private initialized = false;
  private ending = false;
  private ended = false;
  private stopping = false;
  private queue: UserInput[] = [];
  private turn?: Turn;
  private model: string;
  private appliedModel: string;
  private effort?: EffortLevel;
  private appliedThinking?: string;
  private defaultThinking = 'off';

  private opts: PiStartOptions;
  private sink: SessionSink;
  private deps: PiAdapterDeps;
  constructor(opts: PiStartOptions, sink: SessionSink, deps: PiAdapterDeps) {
    if (opts.confined) throw new Error('Sandboxed threads are not available for Pi.');
    if (opts.permissionMode === 'plan') throw new Error('Plan first is not available for Pi threads.');
    this.opts = opts; this.sink = sink; this.deps = deps;
    const profile = 'engine' in opts.account ? opts.account : deps.profileFor?.(opts.account.id);
    if (!profile) throw new Error('The Pi profile for this account is unavailable.');
    this.profile = profile;
    this.mode = this.nextMode = opts.permissionMode;
    this.rules = new Set(opts.allowRules ?? []);
    this.model = this.appliedModel = opts.model ?? profile.connection.model;
    this.effort = opts.effort;
    this.ready = this.initialize();
    void this.ready.then(() => this.pump()).catch(error => this.fail(error));
  }

  private async initialize(): Promise<void> {
    const { opts, deps } = this;
    if (opts.resumeAt) throw new Error('Pi conversation rewind is not implemented yet.');
    for (const id of [opts.threadId, opts.sessionId]) if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,126}[a-zA-Z0-9])?$/.test(id)) throw new Error('Pi requires a safe thread and session ID.');
    if (opts.effort === 'ultra') throw new Error('Pi does not support ultra effort.');
    const sessionDir = path.join(this.profile.configDir, 'sessions', 'threadbear', opts.threadId);
    await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
    if (this.ending || this.ended) return;
    const bridgeEnv: Record<string, string> = {};
    if (deps.toolsFor) {
      this.bridge = new PiBridge({ toolContext: this.profile.toolContext, tools: deps.toolsFor(opts.threadId), sink: this.sink, runsAsCode: opts.runsAsCode, cwd: () => opts.cwd, mode: () => this.mode, rules: () => this.rules, addRules: rules => { for (const rule of rules) this.rules.add(rule); this.sink.output({ kind: 'allowRules', rules }); } });
      const address = await this.bridge.start();
      bridgeEnv.THREADBEAR_PI_BRIDGE_URL = address.url; bridgeEnv.THREADBEAR_PI_BRIDGE_TOKEN = address.token;
      if (this.ending || this.ended) { await this.bridge.close(); return; }
    }
    const args = [...(deps.args ?? []), '--mode', 'rpc', '--provider', this.profile.connection.provider, '--model', this.model,
      '--session-dir', sessionDir, opts.resume ? '--session' : '--session-id', opts.sessionId,
      ...(deps.toolsFor ? ['-e', 'builtin:tool-search', '-e', fileURLToPath(new URL('./extension.mjs', import.meta.url))] : ['--no-tools']), ...ISOLATION_ARGS];
    const instructions = [opts.instructions, deps.instructionsFor?.(opts.threadId)].filter(Boolean).join('\n\n');
    if (instructions) args.push('--append-system-prompt', instructions);
    this.rpc = new PiRpc({ command: this.profile.executable, args, cwd: opts.cwd,
      env: { ...process.env, ...opts.env, PI_CODING_AGENT_DIR: this.profile.configDir, PI_OFFLINE: '1', PI_TELEMETRY: '0', ...bridgeEnv },
      threadId: opts.threadId, diagnosticsDir: opts.tmpDir, registry: deps.registry, log: deps.log,
      requestTimeoutMs: deps.requestTimeoutMs ?? 15_000, shutdownTimeoutMs: deps.shutdownTimeoutMs ?? 3000, maxLineBytes: deps.maxLineBytes,
      event: record => this.event(record), exited: error => this.onExit(error) });
    const state = await this.rpc.request('get_state');
    if (this.ending || this.ended) return;
    if (state.sessionId !== opts.sessionId) {
      if (opts.resume) throw new SessionNotFoundError('Pi did not restore the requested session.');
      throw new Error('Pi did not use the requested session ID.');
    }
    if (state.isStreaming || state.isCompacting) throw new Error('Pi started with unexpected active work.');
    this.defaultThinking = this.appliedThinking = state.thinkingLevel ?? 'off';
    this.initialized = true;
    this.sink.output({ kind: 'session', nativeSessionId: state.sessionId, model: state.model?.id ?? this.model });
  }

  send(input: UserInput): void {
    if (this.ending || this.ended) throw new Error('The Pi session is closed.');
    this.queue.push(input);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (!this.initialized || this.turn || this.stopping || this.ending || this.ended || !this.queue.length) return;
    const input = this.queue.shift()!;
    const turn: Turn = { input, started: Date.now(), normalizer: new PiNormalizer(this.sink, fileContext(this.opts.cwd, this.opts.mediaDir, this.opts.blobsDir)), acknowledged: false, settled: false, interrupted: false, cancelled: [] };
    this.turn = turn;
    this.mode = this.nextMode;
    try {
      if (this.model !== this.appliedModel) {
        const model = this.model;
        await this.rpc!.request('set_model', { provider: this.profile.connection.provider, modelId: model });
        this.appliedModel = model;
        this.sink.output({ kind: 'session', nativeSessionId: this.opts.sessionId, model });
      }
      const thinking = this.effort ?? this.defaultThinking;
      if (thinking !== this.appliedThinking) { await this.rpc!.request('set_thinking_level', { level: thinking }); this.appliedThinking = thinking; }
      const images = await Promise.all(input.images.map(async image => {
        const stat = await fs.stat(image.path);
        if (stat.size > 20 * 1024 * 1024) throw new Error('Pi input image exceeds 20 MB.');
        return { type: 'image', mimeType: image.mediaType, data: (await fs.readFile(image.path)).toString('base64') };
      }));
      if (turn.interrupted || this.ending || this.ended || this.turn !== turn) return;
      const response = await this.rpc!.request('prompt', { message: input.text, ...(images.length ? { images } : {}) });
      if (this.turn !== turn) return;
      turn.acknowledged = true;
      if (response.disposition === 'handled') turn.settled = true;
      this.finish();
    } catch (error) {
      if (this.turn !== turn || !this.rpc?.alive) return;
      turn.normalizer.error = error instanceof Error ? error.message : 'Pi prompt failed.';
      turn.acknowledged = turn.settled = true;
      this.finish();
    }
  }

  private event(record: RecordValue): void {
    if (record.type === 'extension_ui_request') { void this.dialog(record).catch(error => this.fail(error)); return; }
    const turn = this.turn;
    if (!turn || this.ended) return;
    turn.normalizer.handle(record);
    if (record.type === 'agent_settled') {
      turn.settled = true;
      turn.interrupted ||= record.aborted === true;
      this.finish();
    }
  }

  private finish(): void {
    const turn = this.turn;
    if (!turn?.acknowledged || !turn.settled) return;
    this.turn = undefined;
    const interrupted = turn.interrupted || turn.normalizer.aborted;
    turn.normalizer.closeOpen();
    this.sink.output({ kind: 'result', result: {
      outcome: interrupted ? 'interrupted' : turn.normalizer.error ? 'failed' : 'completed',
      durationMs: Date.now() - turn.started,
      answered: [...(turn.input.id ? [turn.input.id] : []), ...turn.cancelled], queuedTurns: this.queue.length,
      ...(!interrupted && turn.normalizer.error ? { error: turn.normalizer.error } : {}),
    } });
    queueMicrotask(() => void this.pump());
  }

  async interrupt(): Promise<void> {
    if (this.ended) return;
    this.stopping = true;
    for (const dialog of this.dialogs) dialog.abort();
    const cancelled = this.queue.splice(0).flatMap(input => input.id ? [input.id] : []);
    if (this.turn) { this.turn.interrupted = true; this.turn.cancelled.push(...cancelled); }
    else if (cancelled.length) this.sink.output({ kind: 'result', result: { outcome: 'interrupted', durationMs: 0, answered: cancelled, queuedTurns: 0 } });
    // Startup may be waiting on a CLI that never becomes ready. Stop must
    // cancel that process now, rather than wait for its request deadline.
    if (!this.initialized) {
      this.ending = true;
      this.rpc?.kill();
      await this.ready.catch(() => {});
      if (this.rpc) await this.rpc.closed;
      else this.onExit();
      this.stopping = false;
      return;
    }
    try {
      await this.ready;
      if (!this.rpc?.alive) return;
      await this.rpc.request('clear_queue');
      await this.rpc.request('abort');
      if (this.turn) { this.turn.acknowledged = this.turn.settled = true; this.finish(); }
    } catch { this.rpc?.kill(); await this.rpc?.closed; }
    finally { this.stopping = false; if (!this.ending) void this.pump(); }
  }

  async setModel(model: string | undefined): Promise<void> {
    if (model !== undefined && !model.trim()) throw new Error('Pi model must not be empty.');
    this.model = model ?? this.profile.connection.model;
  }
  async setEffort(effort: EffortLevel | undefined): Promise<void> {
    if (effort === 'ultra') throw new Error('Pi does not support ultra effort.');
    this.effort = effort;
  }
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (mode === 'plan') throw new Error('Plan first is not available for Pi threads.');
    this.nextMode = mode;
  }

  async end(options: { hard?: boolean } = {}): Promise<void> {
    this.ending = true;
    this.queue = [];
    if (this.turn) this.turn.interrupted = true;
    if (options.hard) this.rpc?.kill();
    await this.ready.catch(() => {});
    if (this.rpc) await this.rpc.end(options.hard);
    else this.onExit();
    await this.cleanup;
  }
  kill(): void {
    this.ending = true; this.queue = [];
    if (this.turn) this.turn.interrupted = true;
    if (this.rpc) this.rpc.kill(); else this.onExit();
  }

  private async dialog(record: RecordValue): Promise<void> {
    if (!['select', 'confirm', 'input', 'editor'].includes(record.method) || typeof record.id !== 'string') return;
    const controller = new AbortController(); this.dialogs.add(controller);
    const question = [record.title, record.message].filter((s: unknown) => typeof s === 'string' && s).join('\n\n') || 'Pi has a question';
    const labels: string[] = record.method === 'confirm' ? ['Yes', 'No'] : Array.isArray(record.options) ? record.options.filter((s: unknown) => typeof s === 'string') : [];
    const timer = typeof record.timeout === 'number' ? setTimeout(() => controller.abort(), record.timeout) : undefined;
    try {
      const result = await this.sink.requestQuestion({ signal: controller.signal, questions: [{ question, multiSelect: false, options: labels.map(label => ({ label })) }] });
      const value = result.answers?.[question] ?? result.message;
      if (this.rpc?.alive) await this.rpc.respondUI(record.id, controller.signal.aborted || value === undefined ? { cancelled: true } : record.method === 'confirm' ? { confirmed: value === 'Yes' } : { value });
    } finally { if (timer) clearTimeout(timer); this.dialogs.delete(controller); }
  }

  private fail(error: Error): void {
    if (this.ended) return;
    if (this.rpc) this.rpc.terminate(error);
    else this.onExit(error);
  }
  private onExit(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    for (const dialog of this.dialogs) dialog.abort();
    this.queue = [];
    if (this.turn) {
      this.turn.normalizer.error ??= error?.message ?? 'Pi closed before the response settled.';
      this.turn.acknowledged = this.turn.settled = true;
      this.finish();
    }
    const missing = this.opts.resume && error instanceof PiMissingSessionError;
    this.cleanup = this.bridge?.close() ?? Promise.resolve();
    void this.cleanup.then(() => this.sink.exited(missing ? new SessionNotFoundError(error.message) : error));
  }
}
