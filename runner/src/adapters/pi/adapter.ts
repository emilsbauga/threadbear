import fs from 'node:fs/promises';
import path from 'node:path';
import type { EffortLevel, PermissionMode, PiProfile } from '../../protocol.ts';
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
};
type PiStartOptions = StartSessionOptions<PiProfile>;
type Turn = { input: UserInput; started: number; normalizer: PiNormalizer; acknowledged: boolean; settled: boolean; interrupted: boolean; cancelled: string[] };

// Staged, profile-backed adapter. Register runnable Pi accounts only after
// the tool/approval bridge is supplied; all executable tools are disabled.
export class PiAdapter implements AgentAdapter<PiProfile> {
  readonly provider = 'pi';
  readonly settingsApplyNextTurn = true;
  readonly wakesAfterTasks = false;
  private deps: PiAdapterDeps;
  constructor(deps: PiAdapterDeps) { this.deps = deps; }
  start(options: PiStartOptions, sink: SessionSink): AgentSession { return new PiSession(options, sink, this.deps); }
}

class PiSession implements AgentSession {
  private rpc?: PiRpc;
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
    this.opts = opts; this.sink = sink; this.deps = deps;
    this.model = this.appliedModel = opts.model ?? opts.account.connection.model;
    this.effort = opts.effort;
    this.ready = this.initialize();
    void this.ready.then(() => this.pump()).catch(error => this.fail(error));
  }

  private async initialize(): Promise<void> {
    const { opts, deps } = this;
    if (opts.resumeAt) throw new Error('Pi conversation rewind is not implemented yet.');
    for (const id of [opts.threadId, opts.sessionId]) if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,126}[a-zA-Z0-9])?$/.test(id)) throw new Error('Pi requires a safe thread and session ID.');
    if (opts.effort === 'ultra') throw new Error('Pi does not support ultra effort.');
    const sessionDir = path.join(opts.account.configDir, 'sessions', 'threadbear', opts.threadId);
    await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
    if (this.ending || this.ended) return;
    const args = [...(deps.args ?? []), '--mode', 'rpc', '--provider', opts.account.connection.provider, '--model', this.model,
      '--session-dir', sessionDir, opts.resume ? '--session' : '--session-id', opts.sessionId,
      '--no-tools', '--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve', '--offline'];
    if (opts.instructions) args.push('--append-system-prompt', opts.instructions);
    this.rpc = new PiRpc({ command: opts.account.executable, args, cwd: opts.cwd,
      env: { ...process.env, ...opts.env, PI_CODING_AGENT_DIR: opts.account.configDir, PI_OFFLINE: '1', PI_TELEMETRY: '0' },
      diagnosticsDir: opts.tmpDir, registry: deps.registry, log: deps.log,
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
    const turn: Turn = { input, started: Date.now(), normalizer: new PiNormalizer(this.sink), acknowledged: false, settled: false, interrupted: false, cancelled: [] };
    this.turn = turn;
    try {
      if (this.model !== this.appliedModel) {
        const model = this.model;
        await this.rpc!.request('set_model', { provider: this.opts.account.connection.provider, modelId: model });
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
    if (record.type === 'extension_ui_request') return this.fail(new Error('Pi requested interactive UI before the approval bridge is available.'));
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
    this.model = model ?? this.opts.account.connection.model;
  }
  async setEffort(effort: EffortLevel | undefined): Promise<void> {
    if (effort === 'ultra') throw new Error('Pi does not support ultra effort.');
    this.effort = effort;
  }
  async setPermissionMode(_mode: PermissionMode): Promise<void> { /* All tools stay disabled in this staged adapter. */ }

  async end(options: { hard?: boolean } = {}): Promise<void> {
    this.ending = true;
    this.queue = [];
    if (this.turn) this.turn.interrupted = true;
    if (options.hard) this.rpc?.kill();
    await this.ready.catch(() => {});
    if (this.rpc) await this.rpc.end(options.hard);
    else this.onExit();
  }
  kill(): void {
    this.ending = true; this.queue = [];
    if (this.turn) this.turn.interrupted = true;
    if (this.rpc) this.rpc.kill(); else this.onExit();
  }

  private fail(error: Error): void {
    if (this.ended) return;
    if (this.rpc) this.rpc.terminate(error);
    else this.onExit(error);
  }
  private onExit(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.queue = [];
    if (this.turn) {
      this.turn.normalizer.error ??= error?.message ?? 'Pi closed before the response settled.';
      this.turn.acknowledged = this.turn.settled = true;
      this.finish();
    }
    const missing = this.opts.resume && error instanceof PiMissingSessionError;
    this.sink.exited(missing ? new SessionNotFoundError(error.message) : error);
  }
}
