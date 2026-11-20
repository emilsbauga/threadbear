// Warm start (experiment warmStart): the CLI for a new thread starts while
// Mike is still writing its first message, so the message goes to a CLI
// that's ready rather than one that still has to boot.
//
// Claude Code takes about half a second from spawn to its first request
// (0.56 s on Tinker Desk's M2 in ADEMark's A4, 20 Nov 2026; 0.8 s cold
// against 0.05 s pre-started on the M5), and every new thread paid it after
// Enter. The app asks for one with `threads.warm` when its new-thread page
// opens (docs/protocol.md, "Warm start"); the runner starts a session under
// an id it keeps for the thread, with the options the page's settings work
// out to. `threads.create` with that `warmId` makes the thread under the id,
// and its first start takes the running CLI if every option still matches,
// else stops it and starts as before.
//
// One at a time, for one connection: a second warm replaces the first, and
// it's stopped when that connection closes (the app quitting leaves nothing
// behind), when the runner stops, and after SPARE_MS unused.
import type { Runner, ThreadState } from '../runner.ts';
import { newRuntime } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { AdapterOutput, AgentSession, QuestionAnswer, QuestionRequest, SessionSink, StartSessionOptions, ToolApprovalAnswer, ToolApprovalRequest } from '../adapters/types.ts';
import type { EffortLevel, PermissionMode } from '../protocol.ts';
import { experimentOn } from '../experiments.ts';

export const WARM_START = 'warmStart';
// Unused this long, a spare is stopped: a page left open over lunch
// shouldn't hold a CLI.
export const SPARE_MS = 10 * 60_000;
// A claimed spare its thread never started (the first turn failed before
// startSession, or was stopped): stopped after this.
export const CLAIMED_MS = 60_000;

export type WarmParams = {
  cwd?: string;
  accountId?: string;
  poolId?: string;
  model?: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  projectIds?: string[];
  worktree?: boolean;
};

// Holds what the CLI says before the thread exists, and hands it all on
// once the thread takes the session.
export class RelaySink implements SessionSink {
  private target?: SessionSink;
  private held: AdapterOutput[] = [];
  private waiting: (() => void)[] = [];
  exitedEarly = false;

  attach(sink: SessionSink): void {
    this.target = sink;
    for (const o of this.held.splice(0)) sink.output(o);
    for (const go of this.waiting.splice(0)) go();
  }

  output(o: AdapterOutput): void {
    if (this.target) this.target.output(o);
    else this.held.push(o);
  }

  private async attached(): Promise<SessionSink> {
    if (!this.target) await new Promise<void>((r) => this.waiting.push(r));
    return this.target!;
  }

  // Nothing asks before a message has gone in; should anything, it waits
  // for the thread.
  async requestApproval(req: ToolApprovalRequest): Promise<ToolApprovalAnswer> {
    return (await this.attached()).requestApproval(req);
  }

  async requestQuestion(req: QuestionRequest): Promise<QuestionAnswer> {
    return (await this.attached()).requestQuestion(req);
  }

  exited(error?: Error): void {
    if (this.target) this.target.exited(error);
    else this.exitedEarly = true;
  }
}

export type Spare = {
  id: string; // the thread id it was started for
  sessionId: string;
  key: string;
  session: AgentSession;
  relay: RelaySink;
  conn?: number;
  timer: ReturnType<typeof setTimeout>;
};

// What a session was started with, minus what can't be compared (the
// callbacks) and with the login by id: two equal keys start the same CLI.
export function spareKey(opts: StartSessionOptions): string {
  return JSON.stringify({ ...opts, account: opts.account.id }, (_k, v: unknown) => (typeof v === 'function' ? undefined : v));
}

export const warmStartPart = {
  // threads.warm: starts (or keeps) the spare for a new thread with these
  // settings, and says its id. Nothing when the experiment is off, or the
  // thread wouldn't start straight away in the folder as it is (a worktree
  // first, a project's brief, another provider).
  warm(this: Runner, params: WarmParams, conn?: number): { warmId?: string } {
    if (!experimentOn(this.cfg.home, WARM_START) || params.projectIds?.length) {
      this.dropSpare();
      return {};
    }
    const spare = this.spare && !this.spare.relay.exitedEarly ? this.spare : undefined;
    // With the spare's ids first, to see whether it already fits; then
    // fresh ones for a new spare.
    const build = (ids?: { id: string; sessionId: string }) => {
      const { rec, account } = this.draftRecord({ ...params, text: '' }, ids);
      if (rec.provider !== 'claude' || rec.worktreePending || this.draining || !this.adapters[rec.provider]) return undefined;
      const st: ThreadState = { rec, rt: newRuntime(this.clock.now()) };
      return { rec, account, opts: this.sessionOptions(st, account, undefined, false).opts };
    };
    let made;
    try {
      made = build(spare ? { id: spare.id, sessionId: spare.sessionId } : undefined);
      if (made && spare && spare.key === spareKey(made.opts)) {
        spare.conn = conn;
        spare.timer.refresh();
        return { warmId: spare.id };
      }
      if (made && spare) made = build();
    } catch {
      // Whatever's wrong (a folder that isn't there) is said when it's sent.
      made = undefined;
    }
    if (!made) {
      this.dropSpare();
      return {};
    }
    const { rec, account, opts } = made;
    const adapter = this.adapters[rec.provider]!;
    this.dropSpare();
    const relay = new RelaySink();
    const session = adapter.start(opts, relay);
    const timer = setTimeout(() => {
      if (this.spare?.id === rec.id) this.dropSpare('unused');
    }, SPARE_MS);
    timer.unref?.();
    this.spare = { id: rec.id, sessionId: rec.nativeSessionId!, key: spareKey(opts), session, relay, conn, timer };
    this.log.info('started a CLI ahead of a new thread', { warmId: rec.id, cwd: rec.cwd, accountId: account.id });
    return { warmId: rec.id };
  },

  // Stops the spare, if there is one (for that connection, when one is named).
  dropSpare(this: Runner, why = 'replaced', conn?: number): void {
    const spare = this.spare;
    if (!spare || (conn !== undefined && spare.conn !== conn)) return;
    this.spare = undefined;
    clearTimeout(spare.timer);
    this.log.info('stopping the CLI started ahead of a new thread', { warmId: spare.id, why });
    void spare.session.end({ hard: true }).catch(() => spare.session.kill());
  },

  // threads.create with a warmId: the spare is this thread's from now on,
  // under its id and session id, until its first start takes it.
  claimSpare(this: Runner, warmId: string | undefined): Spare | undefined {
    const spare = this.spare;
    if (!warmId || !spare || spare.id !== warmId || this.threads.has(warmId)) return undefined;
    this.spare = undefined;
    clearTimeout(spare.timer);
    spare.timer = setTimeout(() => {
      // Taken (or found not to fit) by then; otherwise unused, including
      // when making the thread failed.
      const st = this.threads.get(spare.id);
      if (st && st.rt.spare !== spare) return;
      if (st) st.rt.spare = undefined;
      this.log.info('stopping the CLI started ahead of a thread that never used it', { threadId: spare.id });
      spare.session.kill();
    }, CLAIMED_MS);
    spare.timer.unref?.();
    return spare;
  },

  // From startSession: the spare's CLI when it was started with exactly
  // these options and is still running; otherwise it's stopped.
  takeSpare(this: Runner, st: ThreadState, opts: StartSessionOptions, sink: SessionSink): AgentSession | undefined {
    const spare = st.rt.spare;
    if (!spare) return undefined;
    st.rt.spare = undefined;
    clearTimeout(spare.timer);
    if (!spare.relay.exitedEarly && spare.key === spareKey(opts)) {
      spare.relay.attach(sink);
      this.log.info('took the CLI started ahead of it', { threadId: st.rec.id });
      return spare.session;
    }
    this.log.info('the CLI started ahead of it no longer fits; starting another', { threadId: st.rec.id, exited: spare.relay.exitedEarly });
    spare.session.kill();
    return undefined;
  },
};

export type WarmStartPart = RunnerPart<typeof warmStartPart>;
