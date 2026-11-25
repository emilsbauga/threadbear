// The virtual runners' service (docs/virtual-runners.md, decisions 2, 7, 8,
// 9 and 12): the actions that call a box's provider, and the crons that
// sleep idle boxes, reap ones nobody wants and delete old saves.
//
// Each action is told only a box row's id. It reads the row again, acts on
// the row's newest attempt at a box only, and reports what the provider
// did through the box's machine (boxes.ts report), naming that attempt, so
// one run twice or late changes nothing of a newer box (boxMachine.ts
// newestAttempt, stale). The machine schedules them (boxMachine.ts
// provide): wakeBox when a box is wanted back, sleepBox once it has slept,
// destroyBox when its thread is archived, createBox for a box lost while
// it was made; and boxes.ts addBox the first box's createBox.
//
// One action at a time calls the provider for a box: each holds the row's
// `op` lease while it does (claimOp), and one that finds it held runs again
// OP_RETRY_MS later. So a sleep's suspend and a wake's start never overlap,
// and after its calls each reads the row again and puts the machine right
// if the row moved on meanwhile (a box woken while it paused is resumed).
//
// A provider's error is tried again twice in the action, after RETRY_MS,
// when it's worth it (unreachable, rate limited, a 5xx). Then: a box that
// couldn't be made or brought back reports FAILED, which keeps the thread
// and its save, and the next message tries again; a sleep or delete that
// didn't happen is left for the reaper, which finds the box still running.
import { v, type Infer } from 'convex/values';
import { internalAction, internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { box as boxMachine, machines } from './machines';
import { newestAttempt } from './boxMachine';
import { SAVE_MS, WAKE_GRACE_MS } from './boxStates';
import { activeMove, archive, askToSave, BOOT_PREFIX, BOX_LIMITS, isKeyMachine, mayMintAttempt, newAttempt, overHours, randomHex, usedTodayMs } from './boxes';
import { sha256 } from './lib';
import { deleteIfUnused, purgeRunnerRows } from './sync';
import { FLY_SUSPEND_MAX_MB, flyFromEnv } from './boxProviders/fly';
import { notFound, transient } from './boxProviders/types';
import { bootImage } from './boxImage';
import type { BoxProvider, ListedBox } from './boxProviders/types';

export const RETRY_MS = [300, 1500];
// How long an action may hold a box's op lease (a Fly wait is 60 s at most,
// tried three times), and how soon one that found it held tries again.
// Each provider call checks and renews it, and has a deadline of its own
// (CALL_MS) well inside it, so a lease can only lapse under a run that's died.
export const OP_LEASE_MS = 3 * 60_000;
export const OP_RETRY_MS = 5_000;
export const CALL_MS = 40_000;
// A box being deleted this long is deleted again by the reaper.
export const DESTROY_AGAIN_MS = 10 * 60_000;
// Each cron's work per run, so none outgrows a function's limits; what's
// left goes on in a run of its own from where this one stopped.
export const IDLE_BATCH = 200;
export const REAP_CHUNK = 100;
export const PRUNE_BATCH = 100;
const DAY_MS = 24 * 60 * 60_000;
// A thread working, or waiting on Mike's answer to an approval, isn't idle.
const BUSY: readonly string[] = ['starting', 'running', 'waiting'];
// A size we don't know (a box made before sizes were kept, or one the
// reaper took in): treated as too big to pause.
const UNKNOWN_MB = Number.MAX_SAFE_INTEGER;

/** Whether the provider can pause a box of `memoryMb`, by its size alone (Fly: 2048 MB or less). */
export function pauseSupported(provider: string, memoryMb: number): boolean {
  return provider === 'fly' && memoryMb <= FLY_SUSPEND_MAX_MB;
}

/** The provider for a virtual runner's box of `memoryMb` (its pause support), from this deployment's environment (docs/forking.md lists them). */
export function providerFor(provider: string, memoryMb: number): BoxProvider {
  // BOX_CALL_TIMEOUT_MS: a shorter deadline per call, for tests; never longer than CALL_MS.
  const timeoutMs = Math.min(CALL_MS, Number(process.env.BOX_CALL_TIMEOUT_MS) || CALL_MS);
  switch (provider) {
    case 'fly':
      return flyFromEnv(process.env, memoryMb, undefined, timeoutMs);
  }
  throw new Error(`There's no provider called ${provider}.`);
}

async function retrying<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (e instanceof LeaseLost || e instanceof OutOfTime || i >= RETRY_MS.length || !transient(e)) throw e;
      await new Promise((r) => setTimeout(r, RETRY_MS[i]));
    }
  }
}

const message = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 400);

type Event =
  | { type: 'CREATED'; providerBoxId: string; attempt: number }
  | { type: 'RESUMED'; attempt: number }
  | { type: 'LOST'; attempt?: number; providerBoxId?: string }
  | { type: 'DESTROYED' }
  | { type: 'FAILED'; error: string; attempt: number }
  | { type: 'PAUSED'; attempt?: number; providerBoxId?: string }
  | { type: 'RETIRED' };
// `op`: the reporting run's op lease; one that has lost it is told no (boxes.ts report).
const report = (ctx: ActionCtx, threadId: string, event: Event, op?: string): Promise<boolean> => ctx.runMutation(internal.boxes.report, { threadId, event, ...(op ? { op } : {}) });

// ------------------------------------------------------------ reading a box

const seenV = v.object({
  threadId: v.string(),
  runnerId: v.string(),
  serviceId: v.id('runnerServices'),
  kind: v.string(),
  newest: v.number(),
  hasKey: v.boolean(),
  keyAttempt: v.optional(v.number()),
  // The key holder's machine, if its exchange said (boxes.ts claimBoot).
  keyMachineId: v.optional(v.string()),
  // The key holder's machine isn't made sure of yet (boxes.unsure).
  unsure: v.boolean(),
  providerBoxId: v.optional(v.string()),
  providerAttempt: v.optional(v.number()),
  // The provider box's memory, as made (boxes.size), if it's that attempt's.
  memoryMb: v.number(),
  provider: v.union(v.null(), v.string()),
  // Asleep or shelved with work newer than its save (slept unsaved at its
  // day's hours, or archived and its save never came).
  unsaved: v.boolean(),
  // Kept running though asleep or shelved (keepRunning).
  keptRunning: v.boolean(),
  // Attempts whose boxes may hold work newer than the last save (boxMachine.ts holdsWork).
  workAttempts: v.array(v.number()),
  // A retirement's: the attempts it named when it began (boxMachine.ts beginRetire).
  retireAttempts: v.array(v.number()),
  // The size the newest attempt was made at (boxes.size), whether or not it's the provider box's.
  size: v.optional(v.object({ attempt: v.number(), memoryMb: v.number() })),
  // The machine whose pause is backing off now (suspendFails), if any; by attempt for one recorded without its id.
  suspendBackoff: v.optional(v.object({ attempt: v.number(), providerBoxId: v.optional(v.string()) })),
});
type Seen = Infer<typeof seenV>;

/** What an action needs of a box row, read now. Never its hashes or sealed values. */
export const boxFor = internalQuery({
  args: { boxId: v.id('boxes') },
  returns: v.union(v.null(), seenV),
  handler: async (ctx, { boxId }) => {
    const row = await ctx.db.get(boxId);
    if (!row) return null;
    const s = await ctx.db.get(row.serviceId);
    return {
      threadId: row.threadId,
      runnerId: row.runnerId,
      serviceId: row.serviceId,
      kind: row.boxState.kind,
      newest: newestAttempt(row),
      hasKey: row.boxKeyHash !== undefined,
      ...(row.keyAttempt !== undefined ? { keyAttempt: row.keyAttempt } : {}),
      ...(row.keyMachineId !== undefined ? { keyMachineId: row.keyMachineId } : {}),
      unsure: row.unsure !== undefined,
      ...(row.providerBoxId !== undefined ? { providerBoxId: row.providerBoxId } : {}),
      ...(row.providerAttempt !== undefined ? { providerAttempt: row.providerAttempt } : {}),
      memoryMb: row.size && row.size.attempt === row.providerAttempt ? row.size.memoryMb : UNKNOWN_MB,
      provider: s ? s.provider : null,
      // Invariant W's one record: the key holder's box may hold work newer than its save.
      unsaved: row.keyAttempt !== undefined && (row.workAttempts ?? []).includes(row.keyAttempt),
      keptRunning: row.keptRunningSince !== undefined,
      workAttempts: row.workAttempts ?? [],
      retireAttempts: row.boxState.kind === 'retiring' ? row.boxState.attempts : [],
      ...(row.size ? { size: { attempt: row.size.attempt, memoryMb: row.size.memoryMb } } : {}),
      ...(row.suspendFails && row.suspendFails.next > Date.now() ? { suspendBackoff: { attempt: row.suspendFails.attempt, ...(row.suspendFails.providerBoxId !== undefined ? { providerBoxId: row.suspendFails.providerBoxId } : {}) } } : {}),
    };
  },
});

// ------------------------------------------------------------ which machine holds the key

/**
 * The key holder's machine, made sure of before a wake, a lease check or
 * the reconciler decides anything about it (Codex's fourteenth round). One
 * listing of the box's machines; one not in it is gone.
 *
 * - Known (the exchange said, `keyMachineId`): there, and the row names
 *   another (or none): taken in. Gone: its loss, which ends its key and its
 *   attempt's protection in one step.
 * - Not known: the row's machine of that attempt there, alone: nothing to
 *   do; with others: `several`. The row's machine gone (or never named):
 *   none left is a loss, one left is taken in as a guess (the row's
 *   machine, `unsure`, never keyMachineId: a guess deletes nothing and
 *   refuses nothing), several left is `several`, which a wake resolves by
 *   trying them in turn (tryNext). Any of these is resumed as a trial
 *   (bringBack) until a key heartbeat makes sure.
 *
 * `changed`: the row was changed (read it again). `listed`: the attempt's
 * machines, as listed, when it got that far.
 */
type Identified = { kind: 'same' | 'changed' | 'several'; of?: ListedBox[] };
async function identify(op: Op, p: BoxProvider, seen: Seen): Promise<Identified> {
  const k = seen.keyAttempt;
  if (!seen.hasKey || k === undefined) return { kind: 'same' };
  // Known and the row's: the usual paths (lease check, resume) find its loss.
  if (seen.keyMachineId !== undefined && seen.keyMachineId === seen.providerBoxId && !seen.unsure) return { kind: 'same' };
  let listed: ListedBox[];
  try {
    listed = await retrying(() => p.list({ tb_box: op.boxId }));
  } catch (e) {
    if (e instanceof LeaseLost || e instanceof OutOfTime) throw e;
    console.warn("the box's machines weren't listed; tried again later", message(e));
    return { kind: 'same' };
  }
  // Gone is not listed: a stopped one is still tried (a resume starts it), as everywhere a wake resumes.
  const of = listed.filter((b) => Number(b.tags.tb_attempt) === k);
  // Gone, asked by its id (where the provider can be): a listing missing it isn't enough to give up its work.
  const gone = async (id: string) => {
    if (!p.get) return true;
    try {
      return (await retrying(() => p.get!(id))) === null;
    } catch (e) {
      if (e instanceof LeaseLost || e instanceof OutOfTime) throw e;
      return false;
    }
  };
  const lost = async (id?: string) => {
    await report(op.ctx, seen.threadId, { type: 'LOST', attempt: k, ...(id !== undefined ? { providerBoxId: id } : {}) }, op.id);
    return { kind: 'changed' as const, of };
  };
  const takeIn = async (id: string, keyHolder: boolean) => ((await op.ctx.runMutation(internal.boxService.takeIn, { boxId: op.boxId, op: op.id, providerBoxId: id, attempt: k, keyHolder })) ? { kind: 'changed' as const, of } : { kind: 'same' as const, of });
  if (seen.keyMachineId !== undefined) {
    const id = seen.keyMachineId;
    if (!of.some((b) => b.providerBoxId === id)) return (await gone(id)) ? lost(id) : { kind: 'same', of };
    return seen.providerBoxId === id ? { kind: 'same', of } : takeIn(id, false);
  }
  const own = seen.providerAttempt === k ? seen.providerBoxId : undefined;
  if (own !== undefined && of.some((b) => b.providerBoxId === own)) return { kind: of.length > 1 ? 'several' : 'same', of };
  if (own !== undefined && !(await gone(own))) return { kind: 'same', of };
  if (of.length === 0) return lost(own);
  if (of.length === 1) return takeIn(of[0]!.providerBoxId, true);
  return { kind: 'several', of };
}

/**
 * A machine of the key holder's attempt taken in as the row's (identify):
 * the known key holder's, or (`keyHolder`) the one left by elimination, a
 * guess until a key heartbeat after its resume, or the box's own word,
 * makes sure (boxes.unsure).
 */
export const takeIn = internalMutation({
  args: { boxId: v.id('boxes'), op: v.string(), providerBoxId: v.string(), attempt: v.number(), keyHolder: v.boolean() },
  returns: v.boolean(),
  handler: async (ctx, { boxId, op, providerBoxId, attempt, keyHolder }) => {
    const row = await ctx.db.get(boxId);
    if (!row || !(row.op?.id === op && row.op.until > Date.now()) || row.keyAttempt !== attempt) return false;
    if (keyHolder ? row.keyMachineId !== undefined : row.keyMachineId !== providerBoxId) return false;
    await ctx.db.patch(boxId, {
      providerBoxId,
      providerAttempt: attempt,
      // A guess (by elimination): the row's machine, and unsure, never keyMachineId, which only a box's own word sets.
      ...(keyHolder ? { unsure: { since: row.unsure?.since ?? Date.now(), tried: [providerBoxId], pickedFor: wakeOf(row), ...(row.unsure?.surfaced ? { surfaced: true } : {}) } } : {}),
    });
    return true;
  },
});

const wakeOf = (row: Doc<'boxes'>) => (row.boxState.kind === 'waking' ? row.boxState.since : undefined);

/**
 * A wake with several machines of the key holder's attempt and no word of
 * which holds the key: the one it resumes, made the row's. One at a time:
 * the row's own first, then each not yet tried; a wake keeps its pick
 * through its retries. Each tried, the round starts again, and it's said on
 * the thread (`surfaced`). Returns the pick, or null if the row changed.
 */
export const tryNext = internalMutation({
  args: { boxId: v.id('boxes'), op: v.string(), attempt: v.number(), machines: v.array(v.object({ id: v.string(), state: v.string() })) },
  // previous: the trial it moved on from, for the caller to pause.
  returns: v.union(v.null(), v.object({ pick: v.string(), previous: v.optional(v.string()) })),
  handler: async (ctx, { boxId, op, attempt, machines }) => {
    const row = await ctx.db.get(boxId);
    if (!row || !(row.op?.id === op && row.op.until > Date.now()) || row.keyAttempt !== attempt || row.keyMachineId !== undefined || row.boxState.kind !== 'waking' || !machines.length) return null;
    const now = Date.now();
    const u = row.unsure ?? { since: now, tried: [] };
    const wake = wakeOf(row);
    const current = row.providerBoxId !== undefined && u.tried.includes(row.providerBoxId) ? machines.find((m) => m.id === row.providerBoxId) : undefined;
    // This wake's pick, kept through its retries while it's still a trial:
    // not stopped, and not resumed TRIAL_MS ago with no key heartbeat since.
    const failed = current !== undefined && (current.state === 'stopped' || (u.resumed?.machine === current.id && now >= u.resumed.at + TRIAL_MS));
    if (current && u.pickedFor === wake && !failed) return { pick: current.id };
    const own = row.providerAttempt === attempt ? row.providerBoxId : undefined;
    const order = machines.map((m) => m.id).sort((a, b) => Number(b === own) - Number(a === own));
    let left = order.filter((m) => !u.tried.includes(m));
    let { tried } = u;
    // A trial that failed, or every one tried: said on the thread.
    let surfaced = u.surfaced === true || failed;
    if (!left.length) {
      left = order;
      tried = [];
      surfaced = true;
    }
    const pick = left[0]!;
    await ctx.db.patch(boxId, { providerBoxId: pick, providerAttempt: attempt, unsure: { since: u.since, tried: [...tried, pick], pickedFor: wake, ...(surfaced ? { surfaced: true } : {}) } });
    return { pick, ...(current && current.id !== pick && current.state === 'running' ? { previous: current.id } : {}) };
  },
});

/**
 * The row's machine resumed while its key holder isn't made sure of: noted
 * if no other of its attempt was running, so a key heartbeat from now on can
 * only be its (sync.ts heartbeat records it as the key holder's).
 */
export const markResumed = internalMutation({
  args: { boxId: v.id('boxes'), providerBoxId: v.string() },
  returns: v.null(),
  handler: async (ctx, { boxId, providerBoxId }) => {
    const row = await ctx.db.get(boxId);
    if (row?.unsure && row.providerBoxId === providerBoxId && row.unsure.resumed?.machine !== providerBoxId) await ctx.db.patch(boxId, { unsure: { ...row.unsure, resumed: { machine: providerBoxId, at: Date.now() } } });
    return null;
  },
});

/**
 * Whether the row's machine of this attempt may be reported lost: always,
 * unless it's the key holder's attempt and the exchange didn't say which
 * machine took the key, while another of that attempt is listed (it may be
 * the one holding the key's work, so the attempt's protection stays).
 */
function lossMayBeReported(seen: Seen, attempt: number | undefined, listed: ListedBox[], id?: string): boolean {
  if (attempt === undefined || attempt !== seen.keyAttempt || seen.keyMachineId !== undefined) return true;
  return !listed.some((b) => b.providerBoxId !== (id ?? seen.providerBoxId) && Number(b.tags.tb_attempt) === attempt);
}

// lossMayBeReported, listing the box's machines only when it needs to.
async function mayReportLoss(p: BoxProvider, boxId: string, seen: Seen, attempt: number | undefined, id: string): Promise<boolean> {
  if (attempt === undefined || attempt !== seen.keyAttempt || seen.keyMachineId !== undefined) return true;
  return lossMayBeReported(seen, attempt, await retrying(() => p.list({ tb_box: boxId })), id);
}

function provider(name: string | null, memoryMb: number): BoxProvider | null {
  if (!name) return null;
  try {
    return providerFor(name, memoryMb);
  } catch (e) {
    console.warn('box provider not set up', message(e));
    return null;
  }
}

// ------------------------------------------------------------ one provider call at a time per box

type OpName = 'createBox' | 'wakeBox' | 'sleepBox' | 'destroyBox' | 'checkBox' | 'retireBox';

/** The box's op lease for this action run, unless another run holds it. */
export const claimOp = internalMutation({
  args: { boxId: v.id('boxes'), id: v.string(), name: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { boxId, id, name }) => {
    const row = await ctx.db.get(boxId);
    if (!row) return true;
    if (row.op && row.op.id !== id && row.op.until > Date.now()) return false;
    await ctx.db.patch(boxId, { op: { id, name, until: Date.now() + OP_LEASE_MS } });
    return true;
  },
});

/** Whether this run still holds the box's op lease; if so it runs OP_LEASE_MS from now. */
export const holdOp = internalMutation({
  args: { boxId: v.id('boxes'), id: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { boxId, id }) => {
    const row = await ctx.db.get(boxId);
    if (!row || row.op?.id !== id || row.op.until <= Date.now()) return false;
    await ctx.db.patch(boxId, { op: { ...row.op, until: Date.now() + OP_LEASE_MS } });
    return true;
  },
});

export const releaseOp = internalMutation({
  args: { boxId: v.id('boxes'), id: v.string() },
  returns: v.null(),
  handler: async (ctx, { boxId, id }) => {
    const row = await ctx.db.get(boxId);
    if (row?.op?.id === id) await ctx.db.patch(boxId, { op: undefined });
    return null;
  },
});

// This run's lease went (it ran past OP_LEASE_MS between checks): it stops, acting on nothing more.
class LeaseLost extends Error {}

// `deadline`: when the run must stop calling the provider and carry on in a
// run of its own (Rule 2: no action outruns Convex's limit).
type Op = { ctx: ActionCtx; boxId: Id<'boxes'>; id: string; deadline: number };

// An action's budget for provider calls, well inside Convex's ten minutes:
// a try of a call isn't started unless its worst case is left (its HTTP
// requests' deadlines; retrying checks again before each try).
export const ACTION_BUDGET_MS = 6 * 60_000;
// HTTP requests a try of each provider call makes at most (Fly: a pause is
// a suspend, a state read if that fails, and a wait; a create lists, makes
// the app if need be, and posts).
const REQUESTS = { list: 1, get: 1, destroy: 1, pause: 3, resume: 3, create: 4 } as const;
// `progress`: what the run got done, carried into its continuation's
// arguments so it picks up from there rather than repeating it.
class OutOfTime extends Error {
  progress: Record<string, unknown>;
  constructor(progress: Record<string, unknown> = {}) {
    super('out of its time budget');
    this.progress = progress;
  }
}
const newOp = (ctx: ActionCtx, boxId: Id<'boxes'>, id: string): Op => ({ ctx, boxId, id, deadline: Date.now() + ACTION_BUDGET_MS });

async function stillHeld(op: Op): Promise<void> {
  if (!(await op.ctx.runMutation(internal.boxService.holdOp, { boxId: op.boxId, id: op.id }))) throw new LeaseLost();
}

/**
 * The provider, fenced by the op lease: each call checks (and renews) the
 * lease before and after it, and each call has its own deadline well
 * inside the lease (providerFor), so a run that has lost the lease never
 * calls the provider again, nor reports what it saw.
 */
function fenced(op: Op, p: BoxProvider): BoxProvider {
  const wrap = <A extends unknown[], R>(f: (...a: A) => Promise<R>, requests: number) => async (...a: A): Promise<R> => {
    if (Date.now() + requests * CALL_MS + 2_000 > op.deadline) throw new OutOfTime();
    await stillHeld(op);
    const out = await f(...a);
    await stillHeld(op);
    return out;
  };
  return {
    name: p.name,
    caps: p.caps,
    create: wrap(p.create.bind(p), REQUESTS.create),
    list: wrap(p.list.bind(p), REQUESTS.list),
    destroy: wrap(p.destroy.bind(p), REQUESTS.destroy),
    ...(p.get ? { get: wrap(p.get.bind(p), REQUESTS.get) } : {}),
    ...(p.pause ? { pause: wrap(p.pause.bind(p), REQUESTS.pause) } : {}),
    ...(p.resume ? { resume: wrap(p.resume.bind(p), REQUESTS.resume) } : {}),
  };
}

// Runs `f` holding the box's op lease, or runs this action again shortly if another holds it.
// `args`: the action's own, so a run that waits for the lease runs again with all of them (retireBox's sleep too).
async function withOp(ctx: ActionCtx, boxId: Id<'boxes'>, name: OpName, f: (op: Op) => Promise<void>, args: Record<string, unknown> = { boxId }): Promise<void> {
  const id = randomHex(8);
  if (!(await ctx.runMutation(internal.boxService.claimOp, { boxId, id, name }))) {
    await ctx.scheduler.runAfter(OP_RETRY_MS, internal.boxService[name] as never, args as never);
    return;
  }
  try {
    await f(newOp(ctx, boxId, id));
  } catch (e) {
    if (e instanceof OutOfTime) {
      // Out of its budget: it carries on in a run of its own, with all its
      // arguments and what it got done (so it picks up from there).
      await ctx.scheduler.runAfter(0, internal.boxService[name] as never, { ...args, ...e.progress } as never);
    } else if (e instanceof LeaseLost) console.warn(`${name} lost its op lease, so it stopped`);
    else throw e;
  } finally {
    await ctx.runMutation(internal.boxService.releaseOp, { boxId, id });
  }
}

/**
 * The provider's box `id` brought in line with the row: running while the
 * thread is up, paused while it's asleep or shelved (if it can pause).
 * Asked again after each call, a few times, since the row may move on
 * while one is on its way; it stops when they match or the lease goes.
 */
async function reconcile(op: Op, p: BoxProvider, id: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const row = await op.ctx.runQuery(internal.boxService.boxFor, { boxId: op.boxId });
    if (!row || row.providerBoxId !== id) return;
    const want = ['waking', 'awake', 'saving', 'archiving'].includes(row.kind) || row.keptRunning ? 'running' : ['asleep', 'shelved'].includes(row.kind) && row.hasKey && p.caps.pause ? 'paused' : null;
    if (!want) return;
    const have = (await retrying(() => p.list({ tb_box: op.boxId }))).find((b) => b.providerBoxId === id)?.state;
    if (!have || have === want) return;
    // Resumed only if it may run now; else the row follows the provider (it's paused).
    if (want === 'running' && !row.keptRunning && !(await op.ctx.runQuery(internal.boxService.mayRunNow, { boxId: op.boxId, providerBoxId: id }))) {
      await report(op.ctx, row.threadId, { type: 'PAUSED', providerBoxId: id, ...(row.providerAttempt !== undefined ? { attempt: row.providerAttempt } : {}) }, op.id);
      return;
    }
    if (want === 'running' && p.resume) await retrying(() => p.resume!(id));
    else if (want === 'paused' && p.pause) await retrying(() => p.pause!(id));
    else return;
  }
}

// ------------------------------------------------------------ making and waking a box

/**
 * A new attempt at a box, if the row still wants one (creating or waking),
 * none is on its way (an attempt whose boot token is still live is), and
 * this run still holds the op lease. A run that dies after this leaves its
 * token to lapse, and the box machine's boot timer then fails the box; the
 * next message tries again. The size it's made at is kept for the attempt
 * (boxes.size), as the virtual runner's may change.
 */
export const claimAttempt = internalMutation({
  args: { boxId: v.id('boxes'), bootHash: v.string(), op: v.optional(v.string()) },
  returns: v.union(v.null(), v.object({ attempt: v.number(), image: v.string(), cpus: v.number(), memoryMb: v.number(), region: v.optional(v.string()) }), v.object({ attempt: v.number(), refused: v.string() })),
  handler: async (ctx, { boxId, bootHash, op }) => {
    const row = await ctx.db.get(boxId);
    if (!row || (row.boxState.kind !== 'creating' && row.boxState.kind !== 'waking')) return null;
    if (op !== undefined && !(row.op?.id === op && row.op.until > Date.now())) return null;
    if (!mayMintAttempt(row)) return null;
    if (row.bootTokenHash && row.bootAttempt === newestAttempt(row) && (row.bootExpiresAt ?? 0) > Date.now()) return null;
    const service = await ctx.db.get(row.serviceId);
    if (!service) return null;
    // Only an image pinned by digest, worked out now, in the same
    // transaction as the attempt: never a tag Fly resolves later (boxImage.ts).
    const boots = await bootImage(ctx, service.image);
    const { attempt } = await newAttempt(ctx, row, bootHash);
    if ('why' in boots) return { attempt, refused: boots.why };
    await ctx.db.patch(boxId, { size: { attempt, cpus: service.box.cpus, memoryMb: service.box.memoryMb } });
    return { attempt, image: boots.image, cpus: service.box.cpus, memoryMb: service.box.memoryMb, ...(service.region !== undefined ? { region: service.region } : {}) };
  },
});

/** The thread's first box (boxes.ts addBox), or another for one lost while it was made. */
export const createBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await withOp(ctx, boxId, 'createBox', (op) => bringBack(op));
    return null;
  },
});

/**
 * The thread wants its box back (a message, or its box lost): its paused
 * box resumed, if it can pause and holds the thread's key with no newer
 * attempt asked for; otherwise a new attempt's box, which restores the
 * last save through its exchange.
 */
export const wakeBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await withOp(ctx, boxId, 'wakeBox', (op) => bringBack(op));
    return null;
  },
});

async function bringBack(op: Op): Promise<void> {
  const { ctx, boxId } = op;
  let seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
  if (!seen || (seen.kind !== 'creating' && seen.kind !== 'waking')) return;
  const raw = provider(seen.provider, seen.memoryMb);
  // Invariant W(d): no provider set up (or no address to give a box): nothing
  // changes, and it's tried again shortly. Never FAILED, never a new attempt.
  const site = process.env.CONVEX_CLOUD_URL;
  if (!raw || !site) {
    console.warn(!raw ? `the ${seen.provider ?? 'box'} provider isn't set up on this deployment; trying again shortly` : "CONVEX_CLOUD_URL isn't set; trying again shortly");
    await ctx.scheduler.runAfter(WAKE_RETRY_MS, internal.boxService.wakeBox, { boxId });
    return;
  }
  // Which machine holds the key, made sure of first (identify): taken in,
  // its loss reported, or (several, none known) the next one to try.
  let identified: Identified = { kind: 'same' };
  if (seen.hasKey && seen.keyAttempt !== undefined && seen.keyAttempt === seen.newest) {
    identified = await identify(op, fenced(op, raw), seen);
    if (identified.kind === 'several' && seen.kind === 'waking') {
      const next = await ctx.runMutation(internal.boxService.tryNext, { boxId, op: op.id, attempt: seen.keyAttempt, machines: identified.of!.map((b) => ({ id: b.providerBoxId, state: b.state })) });
      if (next) {
        // One at a time: the trial it moves on from is paused first (if it can be), so the next is alone.
        const p = fenced(op, raw);
        const prev = next.previous;
        let pausedPrev = false;
        if (prev !== undefined && p.pause) {
          try {
            await retrying(() => p.pause!(prev));
            pausedPrev = true;
          } catch (e) {
            if (e instanceof LeaseLost || e instanceof OutOfTime) throw e;
            console.warn("a tried machine didn't pause", message(e));
          }
        }
        identified = { kind: 'changed', of: identified.of!.map((b) => (pausedPrev && b.providerBoxId === prev ? { ...b, state: 'paused' as const } : b)) };
      }
    }
    if (identified.kind === 'changed') {
      seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      if (!seen || (seen.kind !== 'creating' && seen.kind !== 'waking')) return;
    }
  }
  // The box that slept, still holding the thread's key: resume it.
  const keyHolder = seen.hasKey && seen.keyAttempt !== undefined && seen.keyAttempt === seen.newest && seen.providerAttempt === seen.keyAttempt;
  // A trial: which machine holds the key isn't made sure of (boxes.unsure),
  // so the one resumed is only provisional: the thread stays waking until a
  // key heartbeat after its resume says it's the holder (sync.ts heartbeat,
  // which wakes it again to finish), or the next is tried (tryNext).
  const trial = seen.unsure && seen.keyMachineId === undefined;
  // Kept running (it couldn't pause with unsaved work in it): it's up already.
  if (seen.kind === 'waking' && keyHolder && seen.keptRunning && !trial) {
    if (await report(ctx, seen.threadId, { type: 'RESUMED', attempt: seen.keyAttempt! }, op.id)) return;
    seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
    if (!seen || seen.kind !== 'waking') return;
  }
  if (seen.kind === 'waking' && keyHolder && seen.providerBoxId && raw?.caps.pause && raw.resume) {
    const paused = fenced(op, raw);
    const attempt = seen.keyAttempt!;
    const id = seen.providerBoxId;
    let taken = false;
    try {
      await retrying(() => paused.resume!(id));
      if (trial) {
        // Alone among its attempt's machines, a key heartbeat from now on is its.
        if (identified.of && !identified.of.some((b) => b.providerBoxId !== id && b.state === 'running')) await ctx.runMutation(internal.boxService.markResumed, { boxId, providerBoxId: id });
        await ctx.scheduler.runAfter(TRIAL_MS, internal.boxService.wakeBox, { boxId });
        return;
      }
      taken = await report(ctx, seen.threadId, { type: 'RESUMED', attempt }, op.id);
    } catch (e) {
      if (e instanceof LeaseLost) throw e;
      console.warn('a paused box did not resume', message(e));
      // Only the provider saying it's gone (or has lost its disk) gives it up:
      // anything else, and it may still hold work newer than the save, so
      // the wake tries it again shortly (and the boot timer keeps trying).
      if (!notFound(e) && (await providerState(paused, boxId, id)) !== 'gone') {
        await ctx.scheduler.runAfter(WAKE_RETRY_MS, internal.boxService.wakeBox, { boxId });
        return;
      }
      // Another machine of its attempt may be the one holding the key (the
      // exchange didn't say): the wake waits instead, as for any hiccup.
      if (!(await mayReportLoss(paused, boxId, seen, attempt, id))) {
        await ctx.scheduler.runAfter(WAKE_RETRY_MS, internal.boxService.wakeBox, { boxId });
        return;
      }
      await report(ctx, seen.threadId, { type: 'LOST', attempt, providerBoxId: id }, op.id);
    }
    if (taken) {
      await reconcile(op, paused, id);
      return;
    }
    // Not resumed (it was lost, or its key went meanwhile): if the thread
    // still wants a box, it gets a new one, here and now.
    seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
    if (!seen || seen.kind !== 'waking') return;
  }
  // Invariant W(c): a box that may hold work newer than its save is waited
  // on (the wake tries it again, within its grace), never replaced.
  if (seen.workAttempts.length) {
    if (seen.kind === 'waking') await ctx.scheduler.runAfter(WAKE_RETRY_MS, internal.boxService.wakeBox, { boxId });
    return;
  }
  // A claimed attempt's boot token lives only in this run: claimed only with
  // the time left to make its box, so a continuation never strands one.
  if (Date.now() + REQUESTS.create * CALL_MS + 5_000 > op.deadline) throw new OutOfTime();
  const bootToken = BOOT_PREFIX + randomHex(32);
  const claim = await ctx.runMutation(internal.boxService.claimAttempt, { boxId, bootHash: await sha256(bootToken), op: op.id });
  if (!claim) return;
  const { attempt } = claim;
  if ('refused' in claim) {
    await report(ctx, seen.threadId, { type: 'FAILED', error: claim.refused ?? 'no image to boot', attempt }, op.id);
    return;
  }
  const made = provider(seen.provider, claim.memoryMb)!;
  const p = fenced(op, made);
  let providerBoxId: string;
  try {
    ({ providerBoxId } = await retrying(() =>
      p.create({
        image: claim.image,
        cpus: claim.cpus,
        memoryMb: claim.memoryMb,
        ...(claim.region ? { region: claim.region } : {}),
        // Nothing reusable (decision 5): the boot token works once, for BOOT_MS.
        // And which variable holds the machine's own id (BoxProvider.machineIdEnv), for its exchange.
        env: { THREADBEAR_SYNC_URL: site, THREADBEAR_BOX_BOOT: bootToken, ...(made.machineIdEnv ? { THREADBEAR_MACHINE_ID_ENV: made.machineIdEnv } : {}) },
        name: `tb-${boxId}-${attempt}`,
        tags: { tb_box: boxId, tb_attempt: String(attempt), tb_service: seen!.serviceId },
        // One box per attempt, however often this is tried.
        idempotencyKey: `${boxId}-${attempt}`,
      }),
    ));
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    await report(ctx, seen.threadId, { type: 'FAILED', error: `${made.name}: ${message(e)}`, attempt }, op.id);
    return;
  }
  // Not taken: the thread was archived meanwhile, a newer attempt has its
  // box, or it's a duplicate. A refusal alone deletes nothing: the machine
  // goes only if the reaper's own plan and fence would delete it now.
  if (!(await report(ctx, seen.threadId, { type: 'CREATED', providerBoxId, attempt }, op.id))) await deleteIfReaperWould(ctx, seen.serviceId, p, boxId, providerBoxId).catch((e) => {
    if (e instanceof LeaseLost) throw e;
    console.warn('an unwanted box was not deleted; the reaper will', message(e));
  });
}

/**
 * A machine some step found unwanted, deleted only as the reaper would:
 * its plan for it, from a listing now, must be `destroy`, and the reaper's
 * step (reapStep: the same check again, and its fence) must agree in one
 * mutation. Never the key holder's machine, nor one of an attempt that may
 * hold work unless the key holder's is known and it isn't that.
 */
async function deleteIfReaperWould(ctx: ActionCtx, serviceId: Id<'runnerServices'>, p: BoxProvider, boxId: Id<'boxes'>, id: string): Promise<void> {
  const listed = (await retrying(() => p.list({ tb_box: boxId }))).map((b) => ({ providerBoxId: b.providerBoxId, state: b.state, boxId: b.tags.tb_box ?? '', attempt: Number(b.tags.tb_attempt) || 0 }));
  const box = listed.find((b) => b.providerBoxId === id);
  if (!box) return;
  const step = (await ctx.runQuery(internal.boxService.reapPlan, { serviceId, boxes: listed })).find((s) => s.box.providerBoxId === id);
  if (step?.do !== 'destroy') return;
  if (!(await ctx.runMutation(internal.boxService.reapStep, { serviceId, box, do: 'destroy', seen: step.seen, siblings: siblingsOf(listed, box) }))) return;
  await retrying(() => p.destroy(id));
  await ctx.runMutation(internal.boxService.deleteDone, { providerBoxId: id, boxId });
}

// ------------------------------------------------------------ sleeping and deleting

/**
 * The thread is asleep or shelved (boxMachine.ts sleep, sleepUnsaved,
 * shelve): pause its box if that box can pause (by the size it was made
 * at) and holds the key, else delete it and report it LOST, so the next
 * wake makes a new box from the save. A box the provider no longer has is
 * LOST too, and one whose pause is refused is deleted instead. Then the
 * box is brought in line with the row (reconcile): one woken while it
 * paused is resumed.
 */
export const sleepBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await withOp(ctx, boxId, 'sleepBox', async (op) => {
      const seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      if (!seen || (seen.kind !== 'asleep' && seen.kind !== 'shelved') || !seen.providerBoxId) return;
      const raw = provider(seen.provider, seen.memoryMb);
      if (!raw) return;
      const p = fenced(op, raw);
      const id = seen.providerBoxId;
      const lost = { type: 'LOST' as const, providerBoxId: id, ...(seen.providerAttempt !== undefined ? { attempt: seen.providerAttempt } : {}) };
      const keyHolder = seen.hasKey && seen.keyAttempt === seen.providerAttempt;
      // Only the box holding the key is paused; any other is no use asleep.
      // Whether it can pause is the size it was made at (boxes.size), never
      // one refusal: a pause that fails, refused or not, is the billing
      // guard's to try again, every pass with a backoff (suspendFailed).
      // While that backoff is on, a sleep (or its continuation) doesn't try.
      if (p.caps.pause && p.pause && p.resume && keyHolder) {
        if (seen.suspendBackoff && sameMachine(seen.suspendBackoff, { attempt: seen.providerAttempt ?? 0, providerBoxId: id })) return;
        try {
          await retrying(() => p.pause!(id));
        } catch (e) {
          if (e instanceof LeaseLost) throw e;
          if (notFound(e)) {
            if (await mayReportLoss(p, boxId, seen, seen.providerAttempt, id)) await report(ctx, seen.threadId, lost, op.id);
          }
          else {
            console.warn('a box did not pause; the billing guard will try again', message(e));
            await ctx.runMutation(internal.boxService.suspendFailed, { boxId, attempt: seen.providerAttempt ?? 0, providerBoxId: id });
          }
          return;
        }
        await reconcile(op, p, id);
        return;
      }
      // Work newer than its save is never deleted with the box (only once
      // its days are up, or the thread is): it's kept running, asked to save.
      if (seen.unsaved && keyHolder) await keepRunning(op);
      else await deleteAsleep(op, p, seen, id);
    });
    return null;
  },
});

// A pause that failed is tried again by the guard after PASS_MS, doubling, at most an hour.
export const SUSPEND_BACKOFF_MAX_MS = 60 * 60_000;
export const suspendFailed = internalMutation({
  args: { boxId: v.id('boxes'), attempt: v.number(), providerBoxId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { boxId, attempt, providerBoxId }) => {
    const row = await ctx.db.get(boxId);
    if (!row) return null;
    const prev = row.suspendFails;
    const same = prev !== undefined && (providerBoxId !== undefined ? prev.providerBoxId === providerBoxId : prev.providerBoxId === undefined && prev.attempt === attempt);
    const n = same ? prev.n + 1 : 1;
    await ctx.db.patch(boxId, { suspendFails: { attempt, ...(providerBoxId !== undefined ? { providerBoxId } : {}), n, next: Date.now() + Math.min(PASS_MS * 2 ** (n - 1), SUSPEND_BACKOFF_MAX_MS) } });
    return null;
  },
});

// A box that can't pause, asleep or shelved with unsaved work: kept running
// (its time counts toward its day's hours) and asked to save again on a
// backoff (retryKeptSaves) until it does, or its days run out.
async function keepRunning(op: Op): Promise<void> {
  await op.ctx.runMutation(internal.boxService.markKept, { boxId: op.boxId, op: op.id });
}

export const markKept = internalMutation({
  args: { boxId: v.id('boxes'), op: v.string() },
  returns: v.null(),
  handler: async (ctx, { boxId, op }) => {
    const row = await ctx.db.get(boxId);
    if (!row || row.op?.id !== op || row.keptRunningSince !== undefined) return null;
    const now = Date.now();
    // Running, and counted so (boxes.ts countRunning) until the guard sees otherwise.
    await ctx.db.patch(boxId, { keptRunningSince: now, saveAsks: { n: 0, next: now }, seenRunningAt: now });
    return null;
  },
});

// The backoff between asking a kept-running box to save: 10 minutes, doubling, at most 6 hours.
export const SAVE_ASK_MS = 10 * 60_000;
export const SAVE_ASK_MAX_MS = 6 * 60 * 60_000;

/**
 * Boxes kept running with unsaved work (keepRunning): each is asked to save
 * again once its backoff is up. A page a run, the rest in a run of its own.
 */
export const retryKeptSaves = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.number(),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    let asked = 0;
    const page = await ctx.db.query('boxes').withIndex('by_kept', (q) => q.gt('keptRunningSince', 0)).paginate({ numItems: IDLE_BATCH, cursor: cursor ?? null });
    for (const row of page.page) {
      const asks = row.saveAsks ?? { n: 0, next: now };
      if (asks.next > now) continue;
      await askToSave(ctx, row);
      await ctx.db.patch(row._id, { saveAsks: { n: asks.n + 1, next: now + Math.min(SAVE_ASK_MS * 2 ** asks.n, SAVE_ASK_MAX_MS) } });
      asked++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.boxService.retryKeptSaves, { cursor: page.continueCursor });
    return asked;
  },
});

// How soon a wake whose resume failed (not for the box being gone) tries again.
export const WAKE_RETRY_MS = 60_000;
// How long a trial's machine (bringBack, trial) has for its key heartbeat before the next is tried.
export const TRIAL_MS = 3 * 60_000;

/**
 * The provider's word on box `id`: 'gone' if it no longer has it or the box
 * has lost its disk (a stopped Fly Machine's rootfs is reset), its state if
 * it has it, or 'unknown' if it couldn't be asked: only 'gone' ever lets a
 * box be given up.
 */
async function providerState(p: BoxProvider, boxId: Id<'boxes'>, id: string): Promise<'gone' | 'running' | 'paused' | 'unknown'> {
  let listed;
  try {
    listed = await retrying(() => p.list({ tb_box: boxId }));
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    return 'unknown';
  }
  const b = listed.find((x) => x.providerBoxId === id);
  return !b || b.state === 'stopped' ? 'gone' : b.state;
}

/**
 * A box that's stopped heartbeating (boxMachine.ts unheard): the provider is
 * asked. Gone (or its disk lost): LOST, and a new box restores the save.
 * Paused: resumed. Running: kept as it is, its key working, the row marked
 * unreachable (until it heartbeats again), and asked again in five minutes.
 */
/** Whether the row's current box may run now (entitled), for a box it found paused. */
export const mayRunNow = internalQuery({
  args: { boxId: v.id('boxes'), providerBoxId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { boxId, providerBoxId }) => {
    const row = await ctx.db.get(boxId);
    if (!row || row.providerBoxId !== providerBoxId) return false;
    const limits = (await ctx.db.get(row.serviceId))?.limits ?? BOX_LIMITS;
    const now = Date.now();
    return entitled(row, limits, { providerBoxId, state: 'running', boxId, attempt: row.providerAttempt ?? newestAttempt(row) }, await activeMove(ctx, row.threadId, now), now);
  },
});

export const checkBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await withOp(ctx, boxId, 'checkBox', async (op) => {
      let seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      if (!seen || !['awake', 'saving'].includes(seen.kind)) return;
      const raw = provider(seen.provider, seen.memoryMb);
      if (!raw) return;
      const p = fenced(op, raw);
      // Which machine holds the key, made sure of first (identify).
      if ((await identify(op, p, seen)).kind === 'changed') {
        seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
        if (!seen || !['awake', 'saving'].includes(seen.kind)) return;
      }
      if (!seen.providerBoxId) return;
      const id = seen.providerBoxId;
      const state = await providerState(p, boxId, id);
      if (state === 'gone') {
        if (await mayReportLoss(p, boxId, seen, seen.providerAttempt, id)) await report(ctx, seen.threadId, { type: 'LOST', providerBoxId: id, ...(seen.providerAttempt !== undefined ? { attempt: seen.providerAttempt } : {}) }, op.id);
      }
      else if (state === 'paused') {
        // Paused (by the guard, its wait lost on the way back, say): resumed
        // only if it may run now; else the row follows the provider.
        if (p.resume && (await ctx.runQuery(internal.boxService.mayRunNow, { boxId, providerBoxId: id }))) await retrying(() => p.resume!(id)).catch((e) => console.warn("an unreachable box didn't resume", message(e)));
        else await report(ctx, seen.threadId, { type: 'PAUSED', providerBoxId: id, ...(seen.providerAttempt !== undefined ? { attempt: seen.providerAttempt } : {}) }, op.id);
      }
    });
    return null;
  },
});

/**
 * Deletes these machines, each in turn, skipping one whose delete failed
 * lately (its backoff, boxDeleteBackoff) so a broken one doesn't hold up
 * the rest, and pausing a running one first when `pause` (its size) says it
 * can. True if every one is gone; false if any is left for the next run.
 */
// `pause`: the size its attempt was made at, and whether that attempt's
// pause is backing off. `pauseTried`: machines a run before this one already
// tried to pause (its continuation's progress): not tried again, so the
// delete is always reached.
async function deleteEach(op: Op, p: BoxProvider, serviceId: Id<'runnerServices'>, machines: ListedBox[], pause?: { attempt: number; memoryMb: number; provider: string; backoff: { attempt: number; providerBoxId?: string } | null } | null, pauseTried: string[] = []): Promise<boolean> {
  let all = true;
  const tried = new Set(pauseTried);
  const waiting = new Set(await op.ctx.runQuery(internal.boxService.backedOff, { providerBoxIds: machines.map((b) => b.providerBoxId) }));
  try {
    for (const b of machines) {
      if (waiting.has(b.providerBoxId)) {
        all = false;
        continue;
      }
      // One try only, and a failure backs that attempt's pause off (suspendFailed).
      const attempt = Number(b.tags.tb_attempt);
      if (pause && !(pause.backoff && sameMachine(pause.backoff, { attempt, providerBoxId: b.providerBoxId })) && !tried.has(b.providerBoxId) && b.state === 'running' && p.pause && attempt === pause.attempt && pauseSupported(pause.provider, pause.memoryMb)) {
        tried.add(b.providerBoxId);
        await p.pause(b.providerBoxId).catch(async (e) => {
          if (e instanceof LeaseLost || e instanceof OutOfTime) throw e;
          await op.ctx.runMutation(internal.boxService.suspendFailed, { boxId: op.boxId, attempt, providerBoxId: b.providerBoxId });
        });
      }
      try {
        await retrying(() => p.destroy(b.providerBoxId));
        await op.ctx.runMutation(internal.boxService.deleteDone, { providerBoxId: b.providerBoxId, boxId: op.boxId });
      } catch (e) {
        if (e instanceof LeaseLost || e instanceof OutOfTime) throw e;
        console.warn('a machine was not deleted; tried again after a backoff', message(e));
        await op.ctx.runMutation(internal.boxService.deleteFailed, { serviceId, providerBoxId: b.providerBoxId });
        all = false;
      }
    }
  } catch (e) {
    if (e instanceof OutOfTime) throw new OutOfTime({ ...e.progress, ...(pause ? { pauseTried: [...tried] } : {}) });
    throw e;
  }
  return all;
}

// A failed delete is tried again after PASS_MS, doubling, at most an hour.
export const deleteFailed = internalMutation({
  args: { serviceId: v.id('runnerServices'), providerBoxId: v.string() },
  returns: v.null(),
  handler: async (ctx, { serviceId, providerBoxId }) => {
    const row = await ctx.db.query('boxDeleteBackoff').withIndex('by_box', (q) => q.eq('providerBoxId', providerBoxId)).first();
    const n = (row?.n ?? 0) + 1;
    const next = Date.now() + Math.min(PASS_MS * 2 ** (n - 1), SUSPEND_BACKOFF_MAX_MS);
    if (row) await ctx.db.patch(row._id, { n, next });
    else await ctx.db.insert('boxDeleteBackoff', { serviceId, providerBoxId, n, next });
    return null;
  },
});

export const deleteDone = internalMutation({
  // boxId: kept for callers; the provider's delete succeeded, so its condemned mark goes (boxCondemned).
  args: { providerBoxId: v.string(), boxId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { providerBoxId }) => {
    for (const r of await ctx.db.query('boxDeleteBackoff').withIndex('by_box', (q) => q.eq('providerBoxId', providerBoxId)).collect()) await ctx.db.delete(r._id);
    for (const r of await ctx.db.query('boxCondemned').withIndex('by_machine', (q) => q.eq('providerBoxId', providerBoxId)).collect()) await ctx.db.delete(r._id);
    return null;
  },
});

// A machine a fence decided to delete, marked in that same step (boxCondemned), with when.
async function condemn(ctx: MutationCtx, row: Doc<'boxes'>, providerBoxId: string, attempt: number): Promise<void> {
  const marks = await ctx.db.query('boxCondemned').withIndex('by_machine', (q) => q.eq('providerBoxId', providerBoxId)).collect();
  // Decided again: `at` moves on, so no listing older than this decision clears it.
  for (const m of marks) if (m.boxId === row._id) return void (await ctx.db.patch(m._id, { at: Date.now() }));
  await ctx.db.insert('boxCondemned', { boxId: row._id, providerBoxId, attempt, at: Date.now() });
}

/** Of these machines, those whose last delete failed and whose backoff isn't out. */
export const backedOff = internalQuery({
  args: { providerBoxIds: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, { providerBoxIds }) => {
    const now = Date.now();
    const out = [];
    for (const id of providerBoxIds) {
      const r = await ctx.db.query('boxDeleteBackoff').withIndex('by_box', (q) => q.eq('providerBoxId', id)).first();
      if (r && r.next > now) out.push(id);
    }
    return out;
  },
});

async function deleteAsleep(op: Op, p: BoxProvider, seen: Seen, id: string): Promise<void> {
  if (!(await op.ctx.runMutation(internal.boxService.deleteFence, { boxId: op.boxId, providerBoxId: id, op: op.id }))) return;
  try {
    await retrying(() => p.destroy(id));
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    console.warn('a sleeping box was not deleted; the reaper will try again', message(e));
    return;
  }
  await op.ctx.runMutation(internal.boxService.deleteDone, { providerBoxId: id, boxId: op.boxId });
  await report(op.ctx, seen.threadId, { type: 'LOST', providerBoxId: id, ...(seen.providerAttempt !== undefined ? { attempt: seen.providerAttempt } : {}) }, op.id);
}

/**
 * The thread is archived (boxMachine.ts archive, savedAndGo), or its kept
 * box's days are up (expireShelf): every box the provider has for it is
 * deleted, older attempts' too, then DESTROYED. One that fails stays as it
 * is, and the reaper runs this again.
 */
export const destroyBox = internalAction({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    await withOp(ctx, boxId, 'destroyBox', async (op) => {
      const seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      if (!seen || !(seen.kind === 'destroying' || (seen.kind === 'expired' && seen.providerBoxId))) return;
      const raw = provider(seen.provider, seen.memoryMb);
      if (!raw) return;
      const p = fenced(op, raw);
      try {
        // Not one that may hold work newer than the save (an older attempt's,
        // kept): the reaper deletes that once the thread's days run out.
        const keep = (attempt: number | undefined) => seen.kind !== 'expired' && attempt !== undefined && seen.workAttempts.includes(attempt);
        const listed = (await retrying(() => p.list({ tb_box: boxId }))).filter((b) => !keep(Number(b.tags.tb_attempt)));
        if (!(await deleteEach(op, p, seen.serviceId, listed))) return;
      } catch (e) {
        if (e instanceof LeaseLost || e instanceof OutOfTime) throw e;
        console.warn('a box was not deleted; the reaper will try again', message(e));
        return;
      }
      await report(ctx, seen.threadId, { type: 'DESTROYED' }, op.id);
    });
    return null;
  },
});

// ------------------------------------------------------------ the crons

/**
 * Sleeps awake boxes (decisions 7 and 12). Its day's hours come first: one
 * up its maxAwakeHoursPerDay today is sent IDLE `capped` and a `save`
 * command whatever's waiting for it (what's waiting waits for tomorrow's
 * hours, or Mike's wakePastHours), and sleeps all the same if no save comes
 * (boxMachine.ts sleepUnsaved). Otherwise one whose thread has been idle
 * the virtual runner's idleSleepMinutes, with no command waiting, gets IDLE
 * and a `save`. A thread moving (a move going, either way) is neither: the
 * cap waits for the move to end. A page of `numItems` a run, the rest in a
 * run of its own from `cursor`; the first page also wakes any box waiting
 * for room or a new day (boxes.ts wakeAllWaiting).
 */
export const sleepIdleBoxes = machines.internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  returns: v.number(),
  handler: async (machineCtx, { cursor, numItems }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const now = Date.now();
    const batch = numItems ?? IDLE_BATCH;
    const services = new Map<string, Doc<'runnerServices'> | null>();
    let asked = 0;
    const page = await ctx.db.query('boxes').withIndex('by_box_state', (q) => q.eq('boxState.kind', 'awake')).paginate({ numItems: batch, cursor: cursor ?? null });
    for (const row of page.page) {
      if (row.boxState.kind !== 'awake') continue;
      if (!services.has(row.serviceId)) services.set(row.serviceId, await ctx.db.get(row.serviceId));
      const limits = services.get(row.serviceId)?.limits ?? BOX_LIMITS;
      if (await activeMove(ctx, row.threadId)) continue;
      const capped = overHours(row, limits.maxAwakeHoursPerDay, now);
      if (!capped) {
        if (await waitingFor(ctx, row.runnerId)) continue;
        const thread = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', row.threadId)).unique();
        const last = Math.max(row.boxState.since, thread?.lastActivityMs ?? 0);
        if ((thread && BUSY.includes(thread.status)) || now - last < limits.idleSleepMinutes * 60_000) continue;
      }
      const r = await boxMachine.send(machineCtx, row._id, { type: 'IDLE', ...(row.keyAttempt !== undefined ? { attempt: row.keyAttempt } : {}), ...(capped ? { capped: true } : {}) });
      if (r.status !== 'done') continue;
      await askToSave(ctx, row);
      asked++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.boxService.sleepIdleBoxes, { cursor: page.continueCursor, numItems: batch });
    if (!cursor) {
      await ctx.scheduler.runAfter(0, internal.boxes.wakeAllWaiting, {});
      await ctx.scheduler.runAfter(0, internal.boxService.retryKeptSaves, {});
    }
    return asked;
  },
});

// A command waiting for, or being run by, the box's runner: a reason to stay up. Its own save isn't.
async function waitingFor(ctx: MutationCtx, runnerId: string): Promise<boolean> {
  for (const state of ['pending', 'taken'] as const) {
    for await (const c of ctx.db.query('commands').withIndex('by_runner_state', (q) => q.eq('runnerId', runnerId).eq('state', state))) if (c.kind !== 'save') return true;
  }
  return false;
}

// ------------------------------------------------------------ the reaper and the billing guard

const listedV = v.object({ providerBoxId: v.string(), state: v.string(), boxId: v.string(), attempt: v.number() });
type Listed = Infer<typeof listedV>;
const doV = v.union(v.literal('destroy'), v.literal('adopt'), v.literal('lost'), v.literal('suspend'), v.literal('paused'), v.literal('keep'));
type Do = Infer<typeof doV>;
// What a step's row was when it was planned: a step whose row has moved on since is dropped.
const snapV = v.union(v.null(), v.object({ kind: v.string(), newest: v.number(), providerBoxId: v.optional(v.string()), keyAttempt: v.optional(v.number()), since: v.optional(v.number()) }));
type Snap = Infer<typeof snapV>;

function snapOf(row: Doc<'boxes'> | null): Snap {
  if (!row) return null;
  const since = (row.boxState as { since?: number }).since;
  return { kind: row.boxState.kind, newest: newestAttempt(row), ...(row.providerBoxId !== undefined ? { providerBoxId: row.providerBoxId } : {}), ...(row.keyAttempt !== undefined ? { keyAttempt: row.keyAttempt } : {}), ...(since !== undefined ? { since } : {}) };
}
const sameSnap = (a: Snap, b: Snap) => JSON.stringify(a) === JSON.stringify(b);

// The guard's pass (reapBoxes, every PASS_MS), and how long a box that's
// up may go unheard before it isn't entitled to run (the lease is 5 minutes;
// checkBox asks the provider meanwhile).
export const PASS_MS = 5 * 60_000;
export const SILENT_MS = 15 * 60_000;
// States a box is charged for by its row (since it came up); in any other,
// by the guard seeing its machine run (observe).
const UP: readonly string[] = ['awake', 'saving', 'archiving'];
type Limits = Doc<'runnerServices'>['limits'];

/**
 * Invariant M, the one place it's decided: whether a machine the provider
 * has running is entitled to run now. Only the row's current attempt, in a
 * running state: booting within its boot timer; waking within
 * WAKE_GRACE_MS; up, heard from within SILENT_MS, and within its day's hours
 * (with SAVE_MS for the cron's capped save; a save asked for, or an
 * archive's, until its saveBy; Mike's wakePastHours; or its thread
 * moving). Anything else the guard pauses.
 */
export function entitled(row: Doc<'boxes'>, limits: Limits, b: Listed, moving: boolean, now: number): boolean {
  // The row's machine, by its id: a duplicate of the same attempt never is.
  if (b.attempt !== newestAttempt(row) || (row.providerBoxId !== undefined && row.providerBoxId !== b.providerBoxId)) return false;
  const s = row.boxState;
  const heard = (row.lastHeartbeatAt ?? 0) > now - SILENT_MS;
  const hoursOk = moving || usedTodayMs(row, now) < limits.maxAwakeHoursPerDay * 60 * 60_000 + SAVE_MS || !overHours(row, limits.maxAwakeHoursPerDay, now);
  switch (s.kind) {
    case 'creating':
    case 'starting':
      return now < s.bootBy;
    case 'waking':
      return now < (s.since ?? 0) + WAKE_GRACE_MS;
    case 'awake':
      return heard && hoursOk;
    case 'saving':
    case 'archiving':
      return heard && (hoursOk || now < s.saveBy);
    default:
      return false;
  }
}

/**
 * What the reaper and guard do with a machine the provider has (decisions
 * 12, invariants W and M). Thread deletion (no row) and retention's end
 * (expired) are the only things that delete a machine that may hold work.
 * - no row, another virtual runner's, a bogus attempt, or expired: destroy;
 * - stopped (on Fly its disk is reset) while it held the thread's work or
 *   key: lost, the provider's word;
 * - the current attempt's box the row doesn't know yet: adopt, work or
 *   not (a second for an attempt the row knows another of: destroy, unless
 *   it may hold work);
 * - holding no work newer than a save: an older attempt's, or a current
 *   one no state wants (gone, failed, or resting without the key): destroy;
 * - running and not entitled (entitled): suspend, never delete; one known
 *   not to pause is left running and counted (observe);
 * - anything else, one that may hold work newer than its save among them: kept.
 */
// `siblings`: how many other listed machines carry this one's box and attempt.
function planFor(row: Doc<'boxes'> | null, serviceId: string, limits: Limits, provider: string, b: Listed, moving: boolean, now: number, siblings = 0): Do {
  if (!row || row.serviceId !== serviceId || !Number.isSafeInteger(b.attempt) || b.attempt < 1 || b.attempt > newestAttempt(row) || row.boxState.kind === 'expired') return 'destroy';
  const kind = row.boxState.kind;
  // Its retirement deletes the machines it named (retireBox); but one running
  // meanwhile is never entitled to, so the guard pauses it as any other.
  if (kind === 'retiring') return b.state === 'running' && mayTrySuspend(row, provider, b, now) ? 'suspend' : 'keep';
  const work = row.workAttempts?.includes(b.attempt) ?? false;
  const current = b.attempt === newestAttempt(row);
  // Machines are told apart by their id: the row's own, or another (an older
  // attempt's, or a duplicate of its attempt that the provider made twice).
  // For the key holder's attempt, its own is the machine that traded the key
  // (keyMachineId). Not known (it didn't say) with several of that attempt
  // listed: none can be told for the key holder's, so all are kept, and a
  // stopped one (its disk gone) deleted without a loss.
  if (b.attempt === row.keyAttempt && row.keyMachineId !== undefined) {
    // Known: the key holder's machine is the row's (taken in if it was
    // recorded as another); any other of its attempt never had the key, so
    // holds nothing, and is deleted.
    if (b.providerBoxId !== row.keyMachineId) return 'destroy';
    if (row.providerBoxId !== b.providerBoxId) return 'adopt';
  } else if (b.attempt === row.keyAttempt && siblings > 0) {
    // Not known, with others of its attempt: any of them may hold the key's
    // work, so none is lost, taken in or deleted (a stopped one that isn't
    // the row's has no disk, so holds nothing). Pausing loses nothing: the
    // row's own as any machine, the others as duplicates.
    if (b.state === 'stopped') return row.providerBoxId === b.providerBoxId ? 'keep' : 'destroy';
    if (b.state !== 'running') return 'keep';
    const mayRun = row.providerBoxId === b.providerBoxId && entitled(row, limits, b, moving, now);
    return !mayRun && mayTrySuspend(row, provider, b, now) ? 'suspend' : 'keep';
  }
  const own = row.providerBoxId === b.providerBoxId;
  const duplicate = !own && row.providerBoxId !== undefined && row.providerAttempt === b.attempt;
  if (b.state === 'stopped') {
    // Its disk is gone. The row's own: lost, on the provider's word. Any other holds nothing: deleted.
    if (own && (work || (current && row.keyAttempt === b.attempt && kind !== 'destroying'))) return 'lost';
    if (!own && (duplicate || !current || !work)) return 'destroy';
  }
  // The current attempt's machine the row doesn't know (its CREATED never came): taken in, work or not.
  if (current && !own && !duplicate) return 'adopt';
  // A duplicate is never entitled to run: paused if it can be, then kept if
  // its attempt may hold work (which of the two holds it can't be told), else deleted.
  if (duplicate) {
    if (b.state === 'running' && mayTrySuspend(row, provider, b, now)) return 'suspend';
    return work ? 'keep' : 'destroy';
  }
  // The provider has the current box paused while the row says it's up: the row follows the provider.
  if (own && current && b.state === 'paused' && UP.includes(kind) && row.keyAttempt === b.attempt) return 'paused';
  if (!work) {
    if (!current) return 'destroy';
    if (kind === 'gone' || kind === 'failed') return 'destroy';
    if ((kind === 'asleep' || kind === 'shelved') && row.keyAttempt !== b.attempt) return 'destroy';
  }
  if (b.state === 'running' && !entitled(row, limits, b, moving, now)) return mayTrySuspend(row, provider, b, now) ? 'suspend' : 'keep';
  return 'keep';
}

// A suspend backoff is the machine's (by id; by attempt for one recorded without).
const sameMachine = (sf: { attempt: number; providerBoxId?: string }, b: { attempt: number; providerBoxId: string }) => (sf.providerBoxId !== undefined ? sf.providerBoxId === b.providerBoxId : sf.attempt === b.attempt);

// Whether the guard pauses a machine it found running: not one that can't
// pause by the size its attempt was made at (left running, counted by
// observe), nor one whose last pause failed until its backoff is out.
function mayTrySuspend(row: Doc<'boxes'>, provider: string, b: Listed, now: number): boolean {
  if (!(row.size?.attempt === b.attempt && pauseSupported(provider, row.size.memoryMb))) return false;
  return !(row.suspendFails && sameMachine(row.suspendFails, b) && row.suspendFails.next > now);
}

async function rowOf(ctx: { db: MutationCtx['db'] }, boxId: string): Promise<Doc<'boxes'> | null> {
  const id = ctx.db.normalizeId('boxes', boxId);
  return id ? await ctx.db.get(id) : null;
}

async function planOf(ctx: QueryCtx, serviceId: Id<'runnerServices'>, b: Listed, now: number, siblings = 0): Promise<{ row: Doc<'boxes'> | null; do: Do }> {
  const row = await rowOf(ctx as never, b.boxId);
  const service = await ctx.db.get(serviceId);
  const moving = row ? await activeMove(ctx, row.threadId, now) : false;
  return { row, do: planFor(row, serviceId, service?.limits ?? BOX_LIMITS, service?.provider ?? '', b, moving, now, siblings) };
}

// Other listed machines with this one's box and attempt.
const siblingsOf = (boxes: Listed[], b: Listed) => boxes.filter((x) => x.boxId === b.boxId && x.attempt === b.attempt && x.providerBoxId !== b.providerBoxId).length;

/** The plan for a page of listed machines, with each row as it is now. */
export const reapPlan = internalQuery({
  args: { serviceId: v.id('runnerServices'), boxes: v.array(listedV) },
  returns: v.array(v.object({ box: listedV, do: doV, seen: snapV, boxId: v.optional(v.id('boxes')) })),
  handler: async (ctx, { serviceId, boxes }) => {
    const out = [];
    const now = Date.now();
    for (const b of boxes) {
      const { row, do: planned } = await planOf(ctx, serviceId, b, now, siblingsOf(boxes, b));
      // A machine whose delete failed lately waits out its backoff.
      const backoff = planned === 'destroy' ? await ctx.db.query('boxDeleteBackoff').withIndex('by_box', (q) => q.eq('providerBoxId', b.providerBoxId)).first() : null;
      out.push({ box: b, do: backoff && backoff.next > now ? ('keep' as const) : planned, seen: snapOf(row), ...(row ? { boxId: row._id } : {}) });
    }
    return out;
  },
});

/**
 * One step of the plan, checked again first: only if its row is as the
 * plan saw it and the step is still what it would plan, in this one step,
 * so a stale plan does nothing. A loss is reported here; an adoption too
 * (CREATED, which the machine checks). Answers whether the action should
 * now do the provider's part (destroy, or suspend).
 */
export const reapStep = machines.internalMutation({
  // siblings: other machines of its box and attempt, as the caller's listing showed them.
  args: { serviceId: v.id('runnerServices'), box: listedV, do: doV, seen: snapV, siblings: v.optional(v.number()) },
  returns: v.boolean(),
  handler: async (machineCtx, { serviceId, box: b, do: planned, seen, siblings }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const { row, do: now } = await planOf(ctx, serviceId, b, Date.now(), siblings ?? 0);
    if (!sameSnap(snapOf(row), seen) || now !== planned) return false;
    if (planned === 'suspend') return true;
    if (planned === 'destroy') {
      // A delete that failed since the plan was made waits out its backoff.
      const backoff = await ctx.db.query('boxDeleteBackoff').withIndex('by_box', (q) => q.eq('providerBoxId', b.providerBoxId)).first();
      if (backoff && backoff.next > Date.now()) return false;
      // The fence: the key of the machine it deletes goes in this same step
      // (the key holder's machine's: a duplicate of its attempt doesn't hold it).
      if (row && row.keyAttempt === b.attempt && (row.keyMachineId ?? row.providerBoxId) === b.providerBoxId) await ctx.db.patch(row._id, { boxKeyHash: undefined, keyAttempt: undefined, keyMachineId: undefined, unsure: undefined });
      // And it's condemned, so it can't take the key between this step and its delete.
      if (row) await condemn(ctx, row, b.providerBoxId, b.attempt);
      return true;
    }
    if (!row) return false;
    // Only the row's own machine's loss: a duplicate's says nothing of it.
    if (planned === 'lost') return row.providerBoxId === b.providerBoxId && isKeyMachine(row, b.attempt, b.providerBoxId) && (await boxMachine.send(machineCtx, row._id, { type: 'LOST', attempt: b.attempt })).status === 'done';
    // Not while an action holds the box's lease: it may be changing which machine is the row's.
    if (planned === 'adopt' && !(row.op && row.op.until > Date.now())) await boxMachine.send(machineCtx, row._id, { type: 'CREATED', providerBoxId: b.providerBoxId, attempt: b.attempt });
    if (planned === 'paused') await boxMachine.send(machineCtx, row._id, { type: 'PAUSED', attempt: b.attempt });
    return false;
  },
});

/**
 * Invariant M's count: running time as the provider shows it. Each pass,
 * each machine of a row the provider shows running, other than its current
 * one in a state charged by the row (UP), is charged the time since that
 * machine's last observation (at most two passes' worth, today's part
 * only), and the row marked `seenRunningAt`, which counts it toward
 * maxBoxes (boxes.ts countRunning).
 */
export const observe = internalMutation({
  args: { serviceId: v.id('runnerServices'), boxes: v.array(listedV) },
  returns: v.null(),
  handler: async (ctx, { serviceId, boxes }) => {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const byRow = new Map<string, Listed[]>();
    for (const b of boxes) byRow.set(b.boxId, [...(byRow.get(b.boxId) ?? []), b]);
    for (const [boxId, list] of byRow) {
      const row = await rowOf(ctx, boxId);
      if (!row || row.serviceId !== serviceId) continue;
      const byState = UP.includes(row.boxState.kind);
      const counted = (RUNNING_STATES as readonly string[]).includes(row.boxState.kind);
      // Each machine of the row is charged from its own last observation
      // (observedAt, by attempt), not from a stamp another machine moved.
      const last = new Map((row.observedAt ?? []).map((o) => [o.providerBoxId, o.at]));
      // The one machine whose time the row's state charges: the row's own
      // (the key holder's, if the exchange said; before its id is known, the
      // first of its newest attempt). Every other is charged by observation.
      const rowMachine = byState ? (row.keyAttempt === newestAttempt(row) ? row.keyMachineId : undefined) ?? row.providerBoxId ?? list.find((b) => b.state === 'running' && b.attempt === newestAttempt(row))?.providerBoxId : undefined;
      let charge = 0;
      let running = false;
      for (const b of list) {
        if (b.state === 'running' && b.providerBoxId !== rowMachine) {
          charge += Math.max(0, now - Math.max(last.get(b.providerBoxId) ?? now - PASS_MS, now - 2 * PASS_MS, dayStart));
          running = true;
        }
        last.set(b.providerBoxId, now);
      }
      // A few attempts' worth is all a row ever has running.
      const observedAt = [...last].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([providerBoxId, at]) => ({ providerBoxId, at }));
      const patchFields: Partial<Doc<'boxes'>> = { observedAt };
      // Not running: nothing for a pause's backoff to wait on.
      if (row.suspendFails && list.some((b) => sameMachine(row.suspendFails!, b) && b.state !== 'running')) patchFields.suspendFails = undefined;
      if (charge > 0) patchFields.awakeToday = { day, ms: (row.awakeToday?.day === day ? row.awakeToday.ms : 0) + charge };
      // Counted while seen running; driftPage, which sees the whole listing, stops counting it.
      if (running && !counted) patchFields.seenRunningAt = now;
      await ctx.db.patch(row._id, patchFields);
    }
    return null;
  },
});
const RUNNING_STATES = ['creating', 'starting', 'awake', 'saving', 'archiving', 'waking'] as const;

export const servicesToReap = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  returns: v.object({ ids: v.array(v.id('runnerServices')), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { cursor, numItems }) => {
    const page = await ctx.db.query('runnerServices').paginate({ numItems, cursor });
    return { ids: page.page.map((s) => s._id), next: page.isDone ? null : page.continueCursor };
  },
});

/** Every box stuck being deleted (DESTROY_AGAIN_MS) has its delete run again, a page a run, carrying on from `cursor` (Rule 3). */
export const retryDestroying = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { cursor, numItems }) => {
    const before = Date.now() - DESTROY_AGAIN_MS;
    const page = await ctx.db.query('boxes').withIndex('by_box_state', (q) => q.eq('boxState.kind', 'destroying')).paginate({ numItems: numItems ?? PRUNE_BATCH, cursor: cursor ?? null });
    for (const r of page.page) if (r.boxState.kind === 'destroying' && r.boxState.since < before) await ctx.scheduler.runAfter(0, internal.boxService.destroyBox, { boxId: r._id });
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.boxService.retryDestroying, { cursor: page.continueCursor, ...(numItems ? { numItems } : {}) });
    return null;
  },
});

/**
 * The reaper and billing guard (planFor), every PASS_MS: a run per virtual
 * runner, a page of virtual runners at a time carrying on from `cursor`;
 * and, on the first page, boxes stuck being deleted.
 */
export const reapBoxes = internalAction({
  args: { cursor: v.optional(v.string()), numItems: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { cursor, numItems }) => {
    const { ids, next } = await ctx.runQuery(internal.boxService.servicesToReap, { cursor: cursor ?? null, numItems: numItems ?? 50 });
    for (const serviceId of ids) await ctx.scheduler.runAfter(0, internal.boxService.reapService, { serviceId });
    if (next) await ctx.scheduler.runAfter(0, internal.boxService.reapBoxes, { cursor: next, ...(numItems ? { numItems } : {}) });
    if (!cursor) {
      await ctx.scheduler.runAfter(0, internal.boxService.retryDestroying, {});
      await ctx.scheduler.runAfter(0, internal.boxService.retryRetiring, {});
    }
    return null;
  },
});

/**
 * One virtual runner's machines, `chunk` of them by id after `after`, then
 * the next chunk in a run of its own: every machine is reached however
 * many there are. Each chunk is charged (observe), then planned and acted
 * on. A loss or a pause is only made under the box's op lease, after
 * asking the provider again; a pause that fails is tried again next pass.
 * With no provider set up, nothing changes.
 */
export const reapService = internalAction({
  args: { serviceId: v.id('runnerServices'), after: v.optional(v.string()), chunk: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { serviceId, after, chunk }) => {
    const size = chunk ?? REAP_CHUNK;
    const p = provider(await ctx.runQuery(internal.boxService.serviceProvider, { serviceId }), UNKNOWN_MB);
    if (!p) return null;
    let listed;
    // When the listing was asked for: it clears only marks made before (driftPage).
    const listedAt = Date.now();
    try {
      listed = (await retrying(() => p.list({ tb_service: serviceId }))).filter((b) => after === undefined || b.providerBoxId > after).sort((a, b) => (a.providerBoxId < b.providerBoxId ? -1 : 1));
    } catch (e) {
      console.warn("could not list a virtual runner's boxes", message(e));
      return null;
    }
    const boxes = listed.slice(0, size).map((b) => ({ providerBoxId: b.providerBoxId, state: b.state, boxId: b.tags.tb_box ?? '', attempt: Number(b.tags.tb_attempt) || 0 }));
    await ctx.runMutation(internal.boxService.observe, { serviceId, boxes });
    // Rule 2: each step that calls the provider is a run of its own (reapOne),
    // so none waits on another's slow call and every one is reached each pass.
    const toQueue = [];
    for (const step of await ctx.runQuery(internal.boxService.reapPlan, { serviceId, boxes })) {
      if (step.do === 'keep') continue;
      if (step.do === 'adopt' || step.do === 'paused') await ctx.runMutation(internal.boxService.reapStep, { serviceId, box: step.box, do: step.do, seen: step.seen, siblings: siblingsOf(boxes, step.box) });
      else toQueue.push(step);
    }
    // One step a machine at a time: one already queued isn't queued again (queueReaps).
    // Each step a job id of its own, which its queue mark keeps (a counter could repeat once a mark's gone).
    const jobs = toQueue.map((st) => ({ providerBoxId: st.box.providerBoxId, job: randomHex(8) }));
    const fresh = new Set(await ctx.runMutation(internal.boxService.queueReaps, { jobs }));
    for (const [i, step] of toQueue.entries()) {
      const { job } = jobs[i]!;
      if (fresh.has(job)) await ctx.scheduler.runAfter(0, internal.boxService.reapOne, { serviceId, box: step.box, do: step.do, seen: step.seen, job, siblings: siblingsOf(boxes, step.box), ...(step.boxId ? { boxId: step.boxId } : {}) });
    }
    if (listed.length > size) await ctx.scheduler.runAfter(0, internal.boxService.reapService, { serviceId, after: boxes[boxes.length - 1]!.providerBoxId, chunk: size });
    // Once a pass (its first chunk), the other way round: every row against the whole listing.
    if (after === undefined) await sweepDrift(ctx, serviceId, p, listed.map((b) => ({ providerBoxId: b.providerBoxId, boxId: b.tags.tb_box ?? '', running: b.state === 'running' })), listedAt);
    return null;
  },
});

// States a box's loss is taken in (boxMachine.ts LOST).
const LOSABLE: readonly string[] = ['creating', 'starting', 'awake', 'saving', 'archiving', 'asleep', 'waking', 'shelved', 'retiring'];

/**
 * The reconciler's other half (Framing B): every row of the virtual runner
 * against the provider's whole listing. One counted as running
 * (seenRunningAt) whose machine the listing doesn't show running stops
 * being counted. One whose machine is missing from the listing is asked
 * about directly (driftOne), and reported LOST if the provider has it no
 * more. A page of rows a call.
 */
export const driftPage = internalMutation({
  // listedAt: when the listing was asked for (a condemned mark made after it isn't cleared by it).
  args: { serviceId: v.id('runnerServices'), listed: v.array(v.object({ providerBoxId: v.string(), boxId: v.string(), running: v.boolean() })), cursor: v.union(v.string(), v.null()), listedAt: v.optional(v.number()) },
  returns: v.object({ missing: v.array(v.object({ boxId: v.id('boxes'), providerBoxId: v.string(), attempt: v.number() })), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { serviceId, listed, cursor, listedAt }) => {
    const byId = new Map(listed.map((b) => [b.providerBoxId, b.running]));
    const runningRows = new Set(listed.filter((b) => b.running).map((b) => b.boxId));
    const page = await ctx.db.query('boxes').withIndex('by_service_state', (q) => q.eq('serviceId', serviceId)).paginate({ numItems: PRUNE_BATCH, cursor });
    const missing = [];
    for (const row of page.page) {
      // Counted while any machine of it runs in the whole listing; none: not counted.
      if (row.seenRunningAt !== undefined && !runningRows.has(row._id)) await ctx.db.patch(row._id, { seenRunningAt: undefined });
      // Condemned machines the provider has no more, by a whole listing taken after they were condemned: unmarked.
      if (listedAt !== undefined) for (const c of await ctx.db.query('boxCondemned').withIndex('by_box_attempt', (q) => q.eq('boxId', row._id)).collect()) if (c.at < listedAt && !byId.has(c.providerBoxId)) await ctx.db.delete(c._id);
      if (row.providerBoxId && !byId.has(row.providerBoxId) && LOSABLE.includes(row.boxState.kind)) missing.push({ boxId: row._id, providerBoxId: row.providerBoxId, attempt: row.providerAttempt ?? newestAttempt(row) });
      // The key holder's machine, not the row's (not taken in yet), missing too.
      else if (row.keyMachineId !== undefined && row.keyAttempt !== undefined && row.keyMachineId !== row.providerBoxId && !byId.has(row.keyMachineId) && LOSABLE.includes(row.boxState.kind)) missing.push({ boxId: row._id, providerBoxId: row.keyMachineId, attempt: row.keyAttempt });
    }
    return { missing, next: page.isDone ? null : page.continueCursor };
  },
});

async function sweepDrift(ctx: ActionCtx, serviceId: Id<'runnerServices'>, _raw: BoxProvider, listed: { providerBoxId: string; boxId: string; running: boolean }[], listedAt: number): Promise<void> {
  let cursor: string | null = null;
  do {
    const page: { missing: { boxId: Id<'boxes'>; providerBoxId: string; attempt: number }[]; next: string | null } = await ctx.runMutation(internal.boxService.driftPage, { serviceId, listed, cursor, listedAt });
    for (const m of page.missing) await ctx.scheduler.runAfter(0, internal.boxService.driftOne, m);
    cursor = page.next;
  } while (cursor);
}

// A machine missing from the listing, asked about directly under the box's
// op lease (Rule 1: waiting for it if another run holds it), and reported
// LOST only if the provider has it no more and the row still names it.
export const driftOne = internalAction({
  args: { boxId: v.id('boxes'), providerBoxId: v.string(), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, m) => {
    const seen = await ctx.runQuery(internal.boxService.boxFor, { boxId: m.boxId });
    const raw = seen ? provider(seen.provider, UNKNOWN_MB) : null;
    if (!raw) return null;
    const id = randomHex(8);
    if (!(await ctx.runMutation(internal.boxService.claimOp, { boxId: m.boxId, id, name: 'drift' }))) {
      await ctx.scheduler.runAfter(OP_RETRY_MS, internal.boxService.driftOne, m);
      return null;
    }
    const op = newOp(ctx, m.boxId, id);
    const p = fenced(op, raw);
    try {
      // The key holder's attempt: made sure of which machine holds it (identify), which reports a loss only when that's sure.
      const now = await ctx.runQuery(internal.boxService.boxFor, { boxId: m.boxId });
      if (now && now.hasKey && now.keyAttempt === m.attempt) {
        await identify(op, p, now);
        return null;
      }
      const listed = await retrying(() => p.list({ tb_box: m.boxId }));
      if (listed.some((b) => b.providerBoxId === m.providerBoxId)) return null;
      if (!lossMayBeReported(seen!, m.attempt, listed)) return null;
      await ctx.runMutation(internal.boxService.driftLost, { ...m, op: id });
    } catch (e) {
      if (!(e instanceof LeaseLost)) console.warn("a drift check didn't happen; the next pass tries again", message(e));
    } finally {
      await ctx.runMutation(internal.boxService.releaseOp, { boxId: m.boxId, id });
    }
    return null;
  },
});

export const driftLost = machines.internalMutation({
  args: { boxId: v.id('boxes'), providerBoxId: v.string(), attempt: v.number(), op: v.string() },
  returns: v.boolean(),
  handler: async (machineCtx, { boxId, providerBoxId, attempt, op }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const row = await ctx.db.get(boxId);
    if (!row || row.op?.id !== op || row.providerBoxId !== providerBoxId || (row.providerAttempt ?? newestAttempt(row)) !== attempt || !isKeyMachine(row, attempt, providerBoxId)) return false;
    return (await boxMachine.send(machineCtx, boxId, { type: 'LOST', attempt })).status === 'done';
  },
});

/**
 * One step of the reaper's plan, a run of its own (Rule 2). A destroy:
 * checked again (reapStep, the fence) and the machine deleted, a failure
 * backing that machine off (deleteFailed). A loss or a pause: under the
 * box's op lease, run again shortly if another run holds it (Rule 1), and
 * only if the provider still shows the machine as the plan did and the step
 * still holds. A pause that fails, refused or not, is tried again after its
 * backoff (suspendFailed).
 */
export const REAP_PENDING_MS = 15 * 60_000;

/**
 * Of these steps, those whose machine has no step queued (or only a stale
 * one), now marked queued with the step's own job id. Returns their jobs.
 */
export const queueReaps = internalMutation({
  args: { jobs: v.array(v.object({ providerBoxId: v.string(), job: v.string() })) },
  returns: v.array(v.string()),
  handler: async (ctx, { jobs }) => {
    const now = Date.now();
    const out = [];
    for (const { providerBoxId, job } of jobs) {
      const row = await ctx.db.query('reapQueued').withIndex('by_box', (q) => q.eq('providerBoxId', providerBoxId)).first();
      if (row && row.at > now - REAP_PENDING_MS) continue;
      if (row) await ctx.db.patch(row._id, { at: now, job });
      else await ctx.db.insert('reapQueued', { providerBoxId, at: now, job });
      out.push(job);
    }
    return out;
  },
});

/** A queued step ended: its mark goes, if it's still that step's (a newer one's isn't touched). */
export const reapDone = internalMutation({
  args: { providerBoxId: v.string(), job: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { providerBoxId, job }) => {
    for (const r of await ctx.db.query('reapQueued').withIndex('by_box', (q) => q.eq('providerBoxId', providerBoxId)).collect()) if (job === undefined || r.job === job) await ctx.db.delete(r._id);
    return null;
  },
});

export const reapOne = internalAction({
  // job: its queued mark's (queueReaps). siblings: other machines of its box and attempt in the pass's listing.
  args: { serviceId: v.id('runnerServices'), box: listedV, do: doV, seen: snapV, boxId: v.optional(v.id('boxes')), job: v.optional(v.string()), siblings: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Its queued mark goes when it ends, unless it's run again (it stays queued then).
    let again = false;
    try {
      again = await reapStepRun(ctx, args);
    } finally {
      if (!again) await ctx.runMutation(internal.boxService.reapDone, { providerBoxId: args.box.providerBoxId, ...(args.job !== undefined ? { job: args.job } : {}) });
    }
    return null;
  },
});

// reapOne's work; true if it's run again (lease contention).
async function reapStepRun(ctx: ActionCtx, args: { serviceId: Id<'runnerServices'>; box: Listed; do: Do; seen: Snap; boxId?: Id<'boxes'>; job?: string; siblings?: number }): Promise<boolean> {
  {
    const { serviceId, box: b, do: planned, seen, boxId } = args;
    if (planned === 'destroy') {
      const p = provider(await ctx.runQuery(internal.boxService.serviceProvider, { serviceId }), UNKNOWN_MB);
      if (!p || !(await ctx.runMutation(internal.boxService.reapStep, { serviceId, box: b, do: planned, seen, siblings: args.siblings ?? 0 }))) return false;
      try {
        await retrying(() => p.destroy(b.providerBoxId));
        await ctx.runMutation(internal.boxService.deleteDone, { providerBoxId: b.providerBoxId, boxId: b.boxId });
      } catch (e) {
        console.warn('a machine was not deleted; tried again after a backoff', message(e));
        await ctx.runMutation(internal.boxService.deleteFailed, { serviceId, providerBoxId: b.providerBoxId });
      }
      return false;
    }
    if ((planned !== 'lost' && planned !== 'suspend') || !boxId) return false;
    const seenRow = await ctx.runQuery(internal.boxService.boxFor, { boxId });
    const raw = seenRow ? provider(seenRow.provider, seenRow.providerBoxId === b.providerBoxId ? seenRow.memoryMb : UNKNOWN_MB) : null;
    if (!raw) return false;
    const id = randomHex(8);
    if (!(await ctx.runMutation(internal.boxService.claimOp, { boxId, id, name: 'reap' }))) {
      await ctx.scheduler.runAfter(OP_RETRY_MS, internal.boxService.reapOne, args);
      return true;
    }
    const p = fenced(newOp(ctx, boxId, id), raw);
    try {
      const listed = await retrying(() => p.list({ tb_box: boxId }));
      const now = listed.find((x) => x.providerBoxId === b.providerBoxId);
      if (!now || now.state !== b.state) return false;
      const siblings = listed.filter((x) => x.providerBoxId !== b.providerBoxId && Number(x.tags.tb_attempt) === b.attempt).length;
      if (!(await ctx.runMutation(internal.boxService.reapStep, { serviceId, box: b, do: planned, seen, siblings }))) return false;
      if (planned === 'lost') {
        await p.destroy(b.providerBoxId);
        return false;
      }
      if (!p.pause) return false;
      try {
        await retrying(() => p.pause!(b.providerBoxId));
      } catch (e) {
        if (e instanceof LeaseLost || e instanceof OutOfTime || notFound(e)) throw e;
        // Refused or a hiccup alike: tried again after its backoff.
        await ctx.runMutation(internal.boxService.suspendFailed, { boxId, attempt: b.attempt, providerBoxId: b.providerBoxId });
        throw e;
      }
      await ctx.runMutation(internal.boxes.report, { threadId: seenRow!.threadId, event: { type: 'PAUSED', attempt: b.attempt, providerBoxId: b.providerBoxId }, op: id });
    } catch (e) {
      if (!(e instanceof LeaseLost)) console.warn("a guard step didn't happen; the next pass tries again", message(e));
    } finally {
      await ctx.runMutation(internal.boxService.releaseOp, { boxId, id });
    }
    return false;
  }
}

export const retireFence = machines.internalMutation({
  args: { boxId: v.id('boxes'), asleepSince: v.number(), op: v.string() },
  returns: v.boolean(),
  handler: async (machineCtx, { boxId, asleepSince, op }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const row = await ctx.db.get(boxId);
    if (!row || row.op?.id !== op || row.boxState.kind !== 'asleep' || row.boxState.since !== asleepSince) return false;
    const days = (await ctx.db.get(row.serviceId))?.limits.deleteAfterDays ?? BOX_LIMITS.deleteAfterDays;
    if (asleepSince > Date.now() - days * DAY_MS) return false;
    // RETIRE names the attempts and revokes their key in this one step (boxMachine.ts beginRetire).
    return (await boxMachine.send(machineCtx, boxId, { type: 'RETIRE', sleptAt: asleepSince })).status === 'done';
  },
});

/** Every retiring box's retirement run again (retireBox), a page a run, carrying on from `cursor`, so none waits behind others that are stuck. */
export const retryRetiring = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), numItems: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { cursor, numItems }) => {
    const page = await ctx.db.query('boxes').withIndex('by_box_state', (q) => q.eq('boxState.kind', 'retiring')).paginate({ numItems: numItems ?? PRUNE_BATCH, cursor: cursor ?? null });
    for (const r of page.page) await ctx.scheduler.runAfter(0, internal.boxService.retireBox, { boxId: r._id });
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.boxService.retryRetiring, { cursor: page.continueCursor, ...(numItems ? { numItems } : {}) });
    return null;
  },
});

/**
 * The fence before a delete for sleep (deleteAsleep): the box still asleep
 * with that attempt's machine, that attempt holding no work newer than its
 * save, and its key revoked in the same step, so it can make none before
 * it's deleted.
 */
export const deleteFence = internalMutation({
  args: { boxId: v.id('boxes'), providerBoxId: v.string(), op: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { boxId, providerBoxId, op }) => {
    const row = await ctx.db.get(boxId);
    if (!row || row.op?.id !== op || row.boxState.kind !== 'asleep' || row.providerBoxId !== providerBoxId) return false;
    if (row.providerAttempt !== undefined && row.workAttempts?.includes(row.providerAttempt)) return false;
    if (row.keyAttempt !== undefined && row.keyAttempt === row.providerAttempt) await ctx.db.patch(boxId, { boxKeyHash: undefined, keyAttempt: undefined, keyMachineId: undefined, unsure: undefined });
    await condemn(ctx, row, providerBoxId, row.providerAttempt ?? newestAttempt(row));
    return true;
  },
});

export const serviceProvider = internalQuery({
  args: { serviceId: v.id('runnerServices') },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { serviceId }) => (await ctx.db.get(serviceId))?.provider ?? null,
});

/**
 * Retention (decision 12): a thread left past its virtual runner's
 * deleteAfterDays loses what it keeps. Archived (`gone`, `shelved`): its
 * save and any kept box are deleted and it's `expired`, so it says it
 * can't come back (what's waiting for it fails, boxes.ts failExpired).
 * Asleep (measured from when it slept): its box, kept running or paused,
 * is deleted (retireBox), and it comes back from its last save, losing any
 * work newer than that. `gone`, then `shelved`, then `asleep` rows, at most
 * PRUNE_BATCH a run, the rest in a run of its own.
 */
export const pruneSaves = machines.internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), kind: v.optional(v.union(v.literal('gone'), v.literal('shelved'), v.literal('asleep'))) },
  returns: v.number(),
  handler: async (machineCtx, { cursor, kind = 'gone' }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const now = Date.now();
    let pruned = 0;
    const page = await ctx.db.query('boxes').withIndex('by_box_state', (q) => q.eq('boxState.kind', kind)).paginate({ numItems: PRUNE_BATCH, cursor: cursor ?? null });
    for (const row of page.page) {
      const s = row.boxState;
      const at = s.kind === 'gone' || s.kind === 'shelved' ? s.at : s.kind === 'asleep' ? s.since : undefined;
      if (at === undefined) continue;
      const days = (await ctx.db.get(row.serviceId))?.limits.deleteAfterDays ?? BOX_LIMITS.deleteAfterDays;
      if (at > now - days * DAY_MS) continue;
      if (s.kind === 'asleep') {
        if (row.providerBoxId === undefined && !row.workAttempts?.length) {
          // No box to retire: its save is all it has. Kept while its thread
          // lives (it comes back from it); one archived or deleted whose box
          // missed it is archived now, so its save gets its days.
          const thread = await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', row.threadId)).unique();
          if (!thread || thread.view === 'den') {
            await archive(ctx, row);
            pruned++;
          }
          continue;
        }
        // With the sleep it's for: retireBox checks it's still that sleep, still past its days.
        await ctx.scheduler.runAfter(0, internal.boxService.retireBox, { boxId: row._id, asleepSince: s.since });
        pruned++;
        continue;
      }
      const save = row.save?.storageId;
      if ((await boxMachine.send(machineCtx, row._id, { type: 'EXPIRE' })).status !== 'done') continue;
      if (save) await deleteIfUnused(ctx, save);
      pruned++;
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.boxService.pruneSaves, { cursor: page.continueCursor, kind });
    else if (kind === 'gone') await ctx.scheduler.runAfter(0, internal.boxService.pruneSaves, { kind: 'shelved' });
    else if (kind === 'shelved') await ctx.scheduler.runAfter(0, internal.boxService.pruneSaves, { kind: 'asleep' });
    return pruned;
  },
});

/**
 * An expired box's last trace (decision 12): its row, and its runner's rows
 * (its thread, the thread's sidebar row, the `runners` row and the runner's
 * figures), which nothing removed before, so every virtual-runner thread
 * left a `runners` row for good that every full read of runners (the
 * held-push cron, each keyed heartbeat's name check, the runners lists)
 * went on reading. Expired means its save went after deleteAfterDays (or it
 * never had one): it can't come back, and a message to it fails saying so
 * (boxes.ts failExpired). That stays true for another deleteAfterDays, the
 * retention Mike set for the virtual runner, so the archived thread still
 * shows, and says why it can't come back, for as long again as its save
 * was kept; then it goes from every list with its runner. Not while the
 * provider may still have a box of it (providerBoxId: destroyBox is asked
 * again first, and its DESTROYED clears it; or seen running in the last day:
 * the reaper deletes it), an action holds its op lease, or the id is now a
 * keyed runner's. The cron, every 6 hours, pages the expired boxes and
 * hands each one due to purgeBox, in runs of its own.
 */
export const purgeExpiredBoxes = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    const page = await ctx.db.query('boxes').withIndex('by_box_state', (q) => q.eq('boxState.kind', 'expired')).paginate({ numItems: PRUNE_BATCH, cursor: cursor ?? null });
    for (const row of page.page) {
      const next = await purgeStep(ctx, row, now);
      // A box the provider may still have: destroyBox deletes it and says so
      // (DESTROYED), and a later run purges the row. A delete that failed
      // before (only retried for destroying rows) is tried again this way,
      // once a run.
      if (next === 'destroy') await ctx.scheduler.runAfter(0, internal.boxService.destroyBox, { boxId: row._id });
      // Each box in runs of its own: one that fails holds up no other.
      else if (next === 'purge') await ctx.scheduler.runAfter(0, internal.boxService.purgeBox, { boxId: row._id });
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.boxService.purgeExpiredBoxes, { cursor: page.continueCursor });
    return null;
  },
});

// What becomes of an expired box now: nothing yet, its provider box deleted
// first, or purged.
async function purgeStep(ctx: MutationCtx, row: Doc<'boxes'>, now: number): Promise<'wait' | 'destroy' | 'purge'> {
  if (row.boxState.kind !== 'expired' || (row.op && row.op.until > now)) return 'wait';
  const days = (await ctx.db.get('runnerServices', row.serviceId))?.limits.deleteAfterDays ?? BOX_LIMITS.deleteAfterDays;
  if (row.boxState.at > now - days * DAY_MS) return 'wait';
  if (row.providerBoxId !== undefined) return 'destroy';
  // Seen running lately (an unadopted machine): the reaper deletes it first.
  if (row.seenRunningAt !== undefined && row.seenRunningAt > now - DAY_MS) return 'wait';
  // Only the box's own runner: never one a runner key or the main key has
  // taken the id for since (its rows would be that runner's).
  const runner = await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', row.runnerId)).unique();
  if (runner && !runner.box) return 'wait';
  if (await ctx.db.query('runnerKeys').withIndex('by_runnerId', (q) => q.eq('runnerId', row.runnerId)).first()) return 'wait';
  if (await ctx.db.query('ownerRunnerIds').withIndex('by_runnerId', (q) => q.eq('runnerId', row.runnerId)).first()) return 'wait';
  return 'purge';
}

/**
 * One expired box's runner rows, a batch a run (sync.ts purgeRunnerRows),
 * checked again each run; then forgetBox. Built with Convex's own builder:
 * the runner's rows include rows of other machines (runner requests),
 * which go as purgeRunner deletes them.
 */
export const purgeBox = internalMutation({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (ctx, { boxId }) => {
    const row = await ctx.db.get('boxes', boxId);
    if (!row || (await purgeStep(ctx, row, Date.now())) !== 'purge') return null;
    if (await purgeRunnerRows(ctx, row.runnerId)) await ctx.scheduler.runAfter(0, internal.boxService.forgetBox, { boxId });
    else await ctx.scheduler.runAfter(0, internal.boxService.purgeBox, { boxId });
    return null;
  },
});

/** The box's own row last, once its runner's rows are gone: PURGE, to purged, and deleted. */
export const forgetBox = machines.internalMutation({
  args: { boxId: v.id('boxes') },
  returns: v.null(),
  handler: async (machineCtx, { boxId }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const row = await ctx.db.get('boxes', boxId);
    if (!row || (await purgeStep(ctx, row, Date.now())) !== 'purge') return null;
    // Anything of its runner written since (it can't be: no key works for it): back to purgeBox.
    if (await ctx.db.query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', row.runnerId)).first()) {
      await ctx.scheduler.runAfter(0, internal.boxService.purgeBox, { boxId });
      return null;
    }
    const condemned = await ctx.db.query('boxCondemned').withIndex('by_box_attempt', (q) => q.eq('boxId', boxId)).take(PRUNE_BATCH);
    for (const c of condemned) await ctx.db.delete('boxCondemned', c._id);
    if (condemned.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.boxService.forgetBox, { boxId });
      return null;
    }
    if ((await boxMachine.send(machineCtx, boxId, { type: 'PURGE' })).status !== 'done') return null;
    await boxMachine.purge(machineCtx, boxId);
    // Its storage count too: a box's runner id is never anyone else's
    // (purgeStep), so nothing goes on from it (purgeRunnerRows keeps it for
    // a runner key's).
    const usage = await ctx.db.query('runnerStorage').withIndex('by_runnerId', (q) => q.eq('runnerId', row.runnerId)).first();
    if (usage) await ctx.db.delete('runnerStorage', usage._id);
    // A message sent to it while its rows went fails, saying it can't come
    // back, rather than wait two weeks for a runner that's gone.
    await ctx.scheduler.runAfter(0, internal.boxes.failExpired, { runnerId: row.runnerId });
    return null;
  },
});

/**
 * An asleep thread past its retention (pruneSaves): durable once begun.
 * The fence (retireFence: RETIRE) checks it's still the sleep planned on
 * and still past the days set now, names the attempts whose boxes go, and
 * revokes their key, all in one step; the thread is `retiring`, which a
 * message doesn't wake (it waits). Then only the named attempts' machines
 * are deleted, and once the provider shows none of them, RETIRED: asleep
 * with no box, back to its last save. A run that fails part way is run
 * again by the reaper (retryRetiring) until it's done.
 */
export const retireBox = internalAction({
  // pauseTried: a continuation's progress (deleteEach).
  args: { boxId: v.id('boxes'), asleepSince: v.optional(v.number()), pauseTried: v.optional(v.array(v.string())) },
  returns: v.null(),
  handler: async (ctx, { boxId, asleepSince, pauseTried }) => {
    await withOp(ctx, boxId, 'retireBox', async (op) => {
      let seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      if (seen?.kind === 'asleep' && asleepSince !== undefined && !(await ctx.runMutation(internal.boxService.retireFence, { boxId, asleepSince, op: op.id }))) return;
      seen = await ctx.runQuery(internal.boxService.boxFor, { boxId });
      if (!seen || seen.kind !== 'retiring') return;
      const raw = provider(seen.provider, UNKNOWN_MB);
      if (!raw) return;
      const p = fenced(op, raw);
      const named = (b: { tags: Record<string, string> }) => seen!.retireAttempts.includes(Number(b.tags.tb_attempt) || 0);
      try {
        // Rule 1: holding the lease, it does the guard's part too: a running
        // machine is paused before its delete, so a delete that keeps failing
        // doesn't leave it billing.
        const size = seen.size && seen.provider ? { ...seen.size, provider: seen.provider, backoff: seen.suspendBackoff ?? null } : null;
        if (!(await deleteEach(op, p, seen.serviceId, (await retrying(() => p.list({ tb_box: boxId }))).filter(named), size, pauseTried))) return;
        // Gone, on the provider's word: only then is it asleep again.
        if ((await retrying(() => p.list({ tb_box: boxId }))).some(named)) return;
      } catch (e) {
        if (e instanceof LeaseLost || e instanceof OutOfTime) throw e;
        console.warn('a retirement was cut short; the next pass carries it on', message(e));
        return;
      }
      await report(ctx, seen.threadId, { type: 'RETIRED' }, op.id);
    }, { boxId, ...(asleepSince !== undefined ? { asleepSince } : {}), ...(pauseTried ? { pauseTried } : {}) });
    return null;
  },
});
