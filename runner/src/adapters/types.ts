// The seam between the runner and a provider CLI. The runner owns threads,
// turns, persistence and the protocol; an adapter only drives one CLI
// process per live thread and reports normalised output. Claude and Codex
// are the two implementations of AgentAdapter.
import type {
  Account,
  BackgroundKind,
  DeltaBody,
  EffortLevel,
  EventBody,
  ImageRef,
  ModelChoice,
  PermissionMode,
  Provider,
  Question,
  SubagentStatus,
  TurnErrorKind,
  TurnOutcome,
  UsageWindow,
} from '../protocol.ts';

export type StartSessionOptions = {
  threadId: string;
  cwd: string;
  account: Account;
  model?: string;
  effort?: EffortLevel; // undefined: the model's own level
  permissionMode: PermissionMode;
  // Native session id. With resume=false it's pre-assigned to a brand new
  // session; with resume=true the CLI loads that session's transcript.
  // Codex assigns its own ids, so it ignores this when resume=false and
  // reports the real one through the `session` output.
  sessionId: string;
  resume: boolean;
  // With resume, Claude picks the session up at this transcript entry
  // rather than at its end: an edit cut the conversation back to it
  // (docs/protocol.md, "Editing a message"). Codex cuts its own history
  // in rewind(), so it never gets one.
  resumeAt?: string;
  mediaDir: string; // images from tool results are saved here
  blobsDir: string; // tool output over 64 KB is saved here
  tmpDir: string;
  // Permission rules the user chose "Always allow" for in this thread, in
  // the CLI's rule syntax ("Bash(npm test)", "Write"). Applied on start so
  // they outlast an idle release.
  allowRules?: string[];
  // Added to the CLI's environment (THREADBEAR_THREAD_ID and friends), so
  // the commands it runs know which thread they belong to.
  env?: Record<string, string>;
  // Said to the agent on top of the CLI's own system prompt: the thread's
  // projects (projects.ts). Claude appends it to the system prompt, Codex
  // takes it as developer instructions.
  instructions?: string;
  // Claude: the folder's Claude Code settings run commands it hasn't
  // trusted (claude-trust.ts), so the CLI starts without its project and
  // local settings and gets these instead: the same settings without the
  // parts that run anything.
  untrustedProjectSettings?: Record<string, unknown>;
};

export type TurnResult = {
  outcome: TurnOutcome;
  // The CLI ran this turn by itself (a background task or subagent
  // finished) rather than to answer a message the runner sent.
  own?: boolean;
  // The id (UserInput.id) of the message this turn answered, when the CLI
  // says (command_lifecycle frames). With a message folded into the turn
  // part way (sent while it ran), this is the last one folded in.
  answers?: string;
  // Every message this turn answered, in the order the CLI took them:
  // messages sent close together that ran as one turn, then any folded in
  // while it ran. Absent from CLIs that don't report it (then `answers`).
  answered?: string[];
  // Messages still waiting in the CLI's queue when this result was
  // produced, when the CLI reports it: it runs them next, without being
  // sent anything.
  queuedTurns?: number;
  durationMs: number;
  totalCostUsd?: number; // provider's running total for the native session
  usage?: Record<string, unknown>;
  error?: string;
  errorKind?: TurnErrorKind;
};

export type AdapterOutput =
  | { kind: 'event'; event: EventBody }
  | { kind: 'delta'; delta: DeltaBody }
  | { kind: 'session'; nativeSessionId: string; model?: string }
  // The effort level the CLI applied to the turn that just ended.
  | { kind: 'effort'; level: EffortLevel }
  | { kind: 'context'; contextTokens: number; contextWindow?: number }
  // A rate-limit reading for the session's account (D's UsageStore keeps
  // it). email and plan come with it when the CLI reports them.
  | { kind: 'limits'; windows: UsageWindow[]; blocked?: boolean; email?: string; plan?: string }
  // The version of the CLI process actually running this session (not the
  // one that created it).
  | { kind: 'cliVersion'; version: string }
  // The CLI started a turn of its own; `note` says why, when it's known.
  | { kind: 'cliTurn'; note?: string }
  // The Stop hook sent a turn back to call end_turn, as its message is the
  // reply (end_turn's handler then doesn't ask for another).
  | { kind: 'endTurnNudge' }
  // Background work the CLI is running (shells, async subagents). Replaces
  // the previous list.
  | { kind: 'tasks'; tasks: BackgroundTask[] }
  // A sub-agent started or changed. Only the fields that changed are set;
  // the runner keeps the list and stamps the times.
  | { kind: 'subagent'; update: SubagentUpdate }
  // "Always allow" rules to keep for this thread.
  | { kind: 'allowRules'; rules: string[] }
  // Files an Edit or Write call left, sent only for one the CLI says it
  // made, just before its successful tool.result. Never for a preview (an
  // edit.diff before approval) or a denied or failed edit: the runner
  // trusts patch files by these alone (patch-trust.ts). `sha256` is the
  // hash of the bytes the edit wrote, rebuilt from the result. Only
  // Claude's adapter sends it: a Codex patch's result doesn't say what it
  // wrote, so a patch file Codex writes waits for Mike.
  | { kind: 'wrote'; itemId: string; files: AgentWrite[] }
  | { kind: 'result'; result: TurnResult };

export type AgentWrite = { path: string; sha256: string };

// A background shell or subagent the CLI reports. `type` is the CLI's own
// name for it (Claude: local_bash, local_agent, ...), `kind` the protocol's.
export type BackgroundTask = { id: string; type: string; kind: BackgroundKind; description: string };

export type SubagentUpdate = {
  id: string;
  started?: boolean; // the first report of it
  itemId?: string;
  parentId?: string;
  description?: string;
  agentType?: string;
  status?: SubagentStatus;
  background?: boolean;
  activity?: string;
  summary?: string;
  toolUses?: number;
};

export type ToolApprovalRequest = {
  toolUseId?: string; // left out for a subagent's tools, which have no tool.call
  name: string;
  title: string;
  input: Record<string, unknown>;
  canAlwaysAllow: boolean;
  signal: AbortSignal;
};

export type ToolApprovalAnswer = { decision: 'allow' | 'allowAlways' | 'deny' | 'expired'; message?: string };

export type QuestionRequest = {
  toolUseId?: string;
  questions: Question[];
  signal: AbortSignal;
};

// answers: question text -> chosen label(s); null when dismissed or expired.
export type QuestionAnswer = { answers: Record<string, string> | null; message?: string };

export interface SessionSink {
  output(o: AdapterOutput): void;
  requestApproval(req: ToolApprovalRequest): Promise<ToolApprovalAnswer>;
  requestQuestion(req: QuestionRequest): Promise<QuestionAnswer>;
  // The CLI process is gone (input ended, crashed or killed).
  exited(error?: Error): void;
}

// id is the runner's turnId; the CLI echoes it so its turns can be told
// apart from ones it starts by itself.
export type UserInput = { id?: string; text: string; images: ImageRef[] };

// Passed to SessionSink.exited when the session to resume doesn't
// exist (never started, deleted in the CLI's own app, a moved home): the
// runner then starts a fresh session once, with a handoff note.
export class SessionNotFoundError extends Error {
  constructor(message = 'The session to resume was not found.') {
    super(message);
    this.name = 'SessionNotFoundError';
  }
}

export interface AgentSession {
  // Starts a turn, or, sent while one runs, goes into it (steering): the
  // CLI then lists it in TurnResult.answered or counts it in queuedTurns.
  send(input: UserInput): void;
  interrupt(): Promise<void>;
  setModel(model: string | undefined): Promise<void>;
  setEffort(effort: EffortLevel | undefined): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  // Moves the session to another folder from its next turn, in the same
  // native session. Only on adapters with movesFolders.
  setCwd?(cwd: string): Promise<void>;
  // Ends the input so the CLI finishes and exits. Resolves once it has.
  // With hard set it stops the CLI straight away instead (background work
  // it is waiting for would otherwise keep it alive).
  end(opts?: { hard?: boolean }): Promise<void>;
  // Hard stop: kills the CLI's process group.
  kill(): void;
}

// Cutting a native session back to just before one of the runner's
// messages (docs/protocol.md, "Editing a message"). The thread's CLI is
// never live while this runs.
export type RewindRequest = {
  threadId: string;
  account: Account;
  cwd: string;
  sessionId: string;
  messageId: string; // the id the message was sent under (its turnId)
};

export type RewindResult = {
  // Where the next start picks the session up (Claude): an entry to resume
  // at. Absent when the session itself is already cut (Codex).
  resumeAt?: string;
  // The message opened the session: start a fresh one instead.
  fresh?: boolean;
  // The files the CLI's own checkpoints put back. Absent when it has none
  // for this message, so the runner reverses the thread's diffs instead.
  files?: { undone: string[]; failed: { path: string; reason: string }[] };
};

// The session doesn't have the message (the thread moved to another login
// or provider since it was sent): there's nothing to cut back to.
export class RewindRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RewindRefusedError';
  }
}

export type SkillChoice = { name: string; title?: string; description: string; path: string; scope: string };
export type SkillList = { skills: SkillChoice[]; errors: string[] };

export interface AgentAdapter {
  readonly provider: Provider;
  start(opts: StartSessionOptions, sink: SessionSink): AgentSession;
  // What the account's CLI offers as models, without starting a turn.
  // Optional: a provider without a picker leaves it out.
  models?(account: Account): Promise<ModelChoice[]>;
  skills?(account: Account, cwd: string): Promise<SkillList>;
  // A same-account folder change calls setCwd on a live session, or passes
  // the folder to the next start or resume, instead of copying the
  // transcript and adding a handoff (Codex).
  readonly movesFolders?: boolean;
  // Model, effort and permission changes take effect from the next turn
  // only, so the runner says so when one arrives mid-turn (Codex).
  readonly settingsApplyNextTurn?: boolean;
  // Whether the CLI starts a turn of its own when background work ends
  // (default true). Codex doesn't, so the runner skips its wake grace.
  readonly wakesAfterTasks?: boolean;
  // Archives the native session in the CLI's own app when the thread is
  // archived or deleted here. Best effort.
  archive?(account: Account, nativeSessionId: string): Promise<void>;
  // Cuts the native session back to just before a message, and puts back
  // the files the CLI checkpointed since, where it can. Throws
  // RewindRefusedError when the session doesn't have the message.
  rewind?(req: RewindRequest): Promise<RewindResult>;
}
