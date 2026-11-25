// Moving a thread to another runner (docs/protocol/moves.md, "Moving a thread to
// another runner", API 64). The main Mac's runner (the owner key) starts a
// move; after that each runner watches the moves it's in (`moves`) and
// takes its step when the state says it's its turn: the runner that has the
// thread (S) describes it (moveInfo), the runner taking it (T) says it can
// (moveReady), the runner that has it (S) freezes
// it, packs it and uploads it sealed to T's key (moveFrozen, moveChunkUrl,
// movePacked), and T downloads, unpacks and takes it (moveChunks,
// moveClaim, moveDone). moveClaim is the one mutation where the thread
// changes hands, so at any moment one runner has it.
//
// Runners never talk to each other, and nothing here can read the bundle:
// it's sealed on S to the key T put on the move.
//
// The move's lifecycle is a state machine (moveMachine.ts): each function
// checks its caller, then sends the machine the step's event, which says
// whether the move is in a state that takes it.
import { ConvexError, v } from 'convex/values';
import type { WithoutSystemFields } from 'convex/server';
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { boxOfRunner, boxStateReachable, checkRunnerId, forbidden, hasAllowance, hasLiveKey, runnerAuth, sha256, withoutCredentials } from './lib';
import { buryIndexRows, countBodyBytes, countMessageBytes, deleteIfUnused, MAX_RUNNER_UPLOAD_BYTES, MIN_UPLOAD_CHARGE, RUNNER_KEY_CAPS as CAP, moveView, letGo, roomForBody, roomForMessage, roomToStore, type RowAge, storageInUse, storedBytes, ticketKey } from './sync';
import { docBytes, ownThreadOnly, type Caller } from './runnerAccess';
import { machines, move as moveMachine } from './machines';
import { dropChunks } from './moveMachine';
import { moveStateFrom } from './moveStates';
import { steppingFor } from './stepping';
import { wakeIfAsleep } from './boxHooks';

// A runner heard from this recently is online (as phone.ts has it).
const ONLINE_MS = 3 * 60_000;
// A move T hasn't answered fails after MOVE_ASK_MS; one frozen and not yet
// claimed after MOVE_FROZEN_MS (moveStates.ts, the machine's timers). Ended
// moves are listed for a day and kept a week.
// A ready move waits for S's thread to finish its turn before freezing it, so
// it has no short limit while S is online. It fails once S has been gone this
// long (a Mac asleep or switched off), or after MOVE_READY_MS whatever S says:
// left ready, it would block every later move of the thread (startMove's
// "already moving").
export const MOVE_READY_OFFLINE_MS = 10 * 60_000;
export const MOVE_LISTED_MS = 24 * 60 * 60_000;
const MOVE_KEPT_MS = 7 * 24 * 60 * 60_000;
// 12 chunks of at most 10 MB: the 100 MB a bundle may be, with room.
export const MAX_MOVE_CHUNKS = 12;
const MOVE_TICKETS = MAX_MOVE_CHUNKS * 2;
const PLAN_MAX_BYTES = 16 * 1024;
const PICK_CHARS = 1024;
const LISTED = 50;
// Rows handed over a run at a time (rehomeRows), as a thread can have more
// than one mutation may read: few enough of each table's that a page of its
// largest rows, with the destination's room-making on top (REHOME_EVICT),
// stays well inside Convex's 16 MiB a mutation reads. A tool output is up
// to 512 KB (CAP.bodyDoc) and a plan's message 84 KB (CAP.planDoc): 8 of
// the one and 50 of the other are about 4 MB a page; each row's look at
// T's oldest (one read when T is full) and the 4 and 30 rows room-making
// may delete, each read once more by handedOn, about 8 MB more (Codex's
// reviews, 24 Nov 2026: 200 tool outputs a page could be 100 MB, so the
// page failed every time and the move stayed claimed).
const REHOME_PAGE: Record<(typeof REHOME_TABLES)[number], number> = { messages: 50, eventBodies: 8, shareImages: 200, replyImages: 200, heldPictures: 200 };
const REHOME_EVICT = { messages: 30, eventBodies: 4 };
// A claimed move T has said is done but whose rows haven't all gone over
// after this has them sent again (expireMoves).
const REHOME_STUCK_MS = 10 * 60_000;

type Move = Doc<'threadMoves'>;
type MoveState = Move['state'];
const GOING: readonly MoveState[] = ['asking', 'ready', 'packing', 'unpacking', 'claimed'];
// A move still going, for a box's thread (boxes.ts activeMove).
export const MOVE_GOING: readonly string[] = GOING;

const bad = (message: string) => new ConvexError({ kind: 'badArgs', message });
const conflict = (message: string) => new ConvexError({ kind: 'conflict', message });

async function moveRow(ctx: QueryCtx | MutationCtx, moveId: string): Promise<Move> {
  const m = await ctx.db
    .query('threadMoves')
    .withIndex('by_moveId', (q) => q.eq('moveId', moveId))
    .unique();
  if (!m) throw new ConvexError({ kind: 'notFound', message: 'no such move' });
  return m;
}

// The caller is the move's runner on that side: a runner key its own, the
// owner key one with no key of its own (lib.ts actAs's rule).
async function mustBe(ctx: QueryCtx | MutationCtx, caller: Caller, m: Move, side: 'from' | 'to' | 'either'): Promise<void> {
  const ids = side === 'either' ? [m.from, m.to] : [m[side]];
  if (!caller.owner) {
    if (!ids.includes(caller.runnerId)) throw forbidden(`act on a move ${side === 'from' ? 'from' : side === 'to' ? 'to' : 'between'} other runners`);
    // A box key: only its own thread's moves (runnerAccess.ts ownThreadOnly).
    if (!ownThreadOnly(caller, m.threadId)) throw forbidden("act on another thread's move");
    return;
  }
  for (const id of ids) if (!(await hasLiveKey(ctx, id))) return;
  throw forbidden('act on a move between runners with keys of their own with the main key');
}

type MoveEvent = Parameters<typeof moveMachine.send>[2];

// The machine's step, or the conflict a runner has always been told when the
// move's state doesn't take it (the guard's reason, if one refused it).
async function step(ctx: MutationCtx, m: Move, event: MoveEvent, what: string) {
  const r = await moveMachine.send(ctx, m._id, event);
  if (r.status === 'done') {
    // The other side's turn: a sleeping box there wakes to take it.
    for (const runnerId of [m.from, m.to]) await wakeIfAsleep(ctx, runnerId, 'move');
    return r;
  }
  if (r.code === 'GUARD_BLOCKED') throw conflict(r.reasons.join(' '));
  throw conflict(`The move is ${m.state}, so it can't ${what}.`);
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}


function cleanPick(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || value.length > PICK_CHARS || /[\u0000-\u001f]/.test(value)) throw bad(`${what} must be 1 to ${PICK_CHARS} characters, with no control characters`);
  return value;
}

const listedMove = v.object({
  moveId: v.string(),
  threadId: v.string(),
  from: v.string(),
  to: v.string(),
  state: v.string(),
  cwd: v.optional(v.string()),
  accountId: v.optional(v.string()),
  expect: v.optional(v.string()),
  info: v.optional(v.any()),
  plan: v.optional(v.any()),
  key: v.optional(v.string()),
  sha256: v.optional(v.string()),
  bytes: v.optional(v.number()),
  chunks: v.optional(v.number()),
  note: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
  frozenAt: v.optional(v.number()),
});

function listed(m: Move) {
  const { _id, _creationTime, chunks, rehomedAt: _r, doneAsked: _d, moveState: _s, moveStateTimers: _t, ...rest } = m;
  return { ...rest, ...(chunks ? { chunks: chunks.length } : {}) };
}

/** Starts a move: the main Mac's runner, for Mike or one of its agents. */
export const startMove = mutation({
  // `expect`: the digest of what the Move sheet's preview showed
  // (runner/src/moves.ts moveBinding), which the runner it goes to checks
  // its plan against before it takes anything (Daybreak 142, 16 Nov 2026).
  args: { key: v.string(), threadId: v.string(), to: v.string(), cwd: v.optional(v.string()), accountId: v.optional(v.string()), expect: v.optional(v.string()) },
  returns: v.object({ moveId: v.string() }),
  handler: async (ctx, { key, ...a }) => {
    await runnerAuth(ctx, key, 'startMove');
    checkRunnerId(a.to);
    if (a.expect !== undefined && !/^[0-9a-f]{64}$/.test(a.expect)) throw bad('expect must be 64 hex characters');
    const cwd = cleanPick(a.cwd, 'cwd');
    const accountId = cleanPick(a.accountId, 'accountId');
    const t = await ctx.db
      .query('threads')
      .withIndex('by_threadId', (q) => q.eq('threadId', a.threadId))
      .unique();
    if (!t) throw new ConvexError({ kind: 'notFound', message: 'no such thread' });
    if (t.runnerId === a.to) throw bad('The thread is on that runner already.');
    const r = await ctx.db
      .query('runners')
      .withIndex('by_runnerId', (q) => q.eq('runnerId', a.to))
      .unique();
    if (!r) throw new ConvexError({ kind: 'notFound', message: 'no such runner' });
    const now = Date.now();
    // A thread's box on a virtual runner takes only its own thread, and is
    // reachable while it starts or sleeps, as its first message wakes it
    // (docs/virtual-runners.md, decision 6).
    const box = await boxOfRunner(ctx, r);
    if (r.box && box?.threadId !== a.threadId) throw conflict(`${r.name} is another thread's box.`);
    if ((r.draining || now - r.lastSeenAt > ONLINE_MS) && !boxStateReachable(box?.boxState.kind)) throw conflict(`${r.name} is offline.`);
    for (const m of await ctx.db.query('threadMoves').withIndex('by_thread', (q) => q.eq('threadId', a.threadId)).collect()) {
      if (GOING.includes(m.state)) throw conflict('This thread is already moving.');
    }
    const moveId = randomId();
    const fields: Omit<WithoutSystemFields<Move>, 'moveState' | 'moveStateTimers'> = { moveId, threadId: a.threadId, from: t.runnerId, to: a.to, state: 'asking', ...(cwd ? { cwd } : {}), ...(accountId ? { accountId } : {}), ...(a.expect ? { expect: a.expect } : {}), createdAt: now, updatedAt: now };
    const made = await moveMachine.create(ctx, fields as never, { type: 'START' });
    if (made.status !== 'done') throw conflict(`The move couldn't be started: ${made.reasons.join(' ')}`);
    // A sleeping box on either side takes its part once it's woken (within its maxBoxes).
    for (const runnerId of [t.runnerId, a.to]) await wakeIfAsleep(ctx, runnerId, 'move');
    return { moveId };
  },
});

/** Mike changed his mind, before anything was unpacked. */
export const cancelMove = mutation({
  args: { key: v.string(), moveId: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, moveId }) => {
    await runnerAuth(ctx, key, 'cancelMove');
    const m = await moveRow(ctx, moveId);
    if (m.state === 'cancelled') return null;
    await step(ctx, m, { type: 'CANCEL' }, 'be cancelled');
    return null;
  },
});

/** The moves a runner is in: still going, or ended in the last day. */
export const moves = query({
  args: { key: v.string(), runnerId: v.string() },
  returns: v.array(listedMove),
  handler: async (ctx, { key, runnerId }) => {
    const caller = await runnerAuth(ctx, key, 'moves');
    checkRunnerId(runnerId);
    if (!caller.owner && caller.runnerId !== runnerId) throw forbidden(`act as runner ${runnerId}`);
    const since = Date.now() - MOVE_LISTED_MS;
    const out = new Map<string, Move>();
    const fromHere = await ctx.db
      .query('threadMoves')
      .withIndex('by_from', (q) => q.eq('from', runnerId).gte('updatedAt', since))
      .order('desc')
      .take(LISTED);
    const toHere = await ctx.db
      .query('threadMoves')
      .withIndex('by_to', (q) => q.eq('to', runnerId).gte('updatedAt', since))
      .order('desc')
      .take(LISTED);
    for (const m of [...fromHere, ...toHere]) if (ownThreadOnly(caller, m.threadId)) out.set(m.moveId, m);
    return [...out.values()].sort((a, b) => a.createdAt - b.createdAt).map(listed);
  },
});

function smallObject(x: unknown, what: string): void {
  if (x === null || typeof x !== 'object' || Array.isArray(x) || docBytes(x) > PLAN_MAX_BYTES) throw bad(`${what} must be an object of at most ${PLAN_MAX_BYTES} bytes`);
}

// S's description as stored for T: only a MoveInfo's own fields, each
// of its type, a string at most INFO_CHARS with no control characters,
// and the repo's address without a password or token (an older runner
// sends it whole). Anything else isn't kept; a field of the wrong shape
// refuses the whole description. T checks it again (runner/src/moves.ts
// moveInfoFrom), and the runner's own subdir and path rules are its
// (Daybreak 136, 16 Nov 2026).
const INFO_CHARS = 4096;
const INFO_STRINGS = ['title', 'cwd', 'home', 'provider', 'accountId', 'email', 'model', 'effort', 'permissionMode', 'origin', 'repoTop', 'subdir', 'sessionId'] as const;
function describedThread(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of INFO_STRINGS) {
    const x = o[k];
    if (x === undefined) continue;
    if (typeof x !== 'string' || x.length > INFO_CHARS || /[\u0000-\u001f\u007f]/.test(x)) throw bad(`info.${k} must be a string of at most ${INFO_CHARS} characters, with no control characters`);
    const kept = k === 'origin' ? withoutCredentials(x) : x;
    // An address that can't be told from a login is left out.
    if (kept) out[k] = kept;
  }
  if (o.worktree !== undefined) {
    if (typeof o.worktree !== 'boolean') throw bad('info.worktree must be true or false');
    out.worktree = o.worktree;
  }
  if (o.schedules !== undefined) {
    if (typeof o.schedules !== 'number' || !Number.isFinite(o.schedules)) throw bad('info.schedules must be a number');
    out.schedules = o.schedules;
  }
  return out;
}

/** S describes the thread (its folder, repo, login), for T to plan from. */
export const moveInfo = mutation({
  args: { key: v.string(), moveId: v.string(), info: v.any() },
  returns: v.null(),
  handler: async (ctx, { key, moveId, info }) => {
    const caller = await runnerAuth(ctx, key, 'moveInfo');
    const m = await moveRow(ctx, moveId);
    await mustBe(ctx, caller, m, 'from');
    if (m.state === 'asking' && m.info !== undefined) return null;
    if (m.state === 'asking') smallObject(info, 'info');
    await step(ctx, m, { type: 'DESCRIBE', info: m.state === 'asking' ? describedThread(info as Record<string, unknown>) : {} }, 'be described');
    return null;
  },
});

const SEAL_KEY = /^[A-Za-z0-9+/]{43}=$/;

/** T can take the thread: where and on what (`plan`), and the key to seal it to. */
export const moveReady = mutation({
  args: { key: v.string(), moveId: v.string(), plan: v.any(), sealKey: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, moveId, plan, sealKey }) => {
    const caller = await runnerAuth(ctx, key, 'moveReady');
    const m = await moveRow(ctx, moveId);
    await mustBe(ctx, caller, m, 'to');
    if (m.state === 'ready' && m.key === sealKey) return null;
    if (m.state === 'asking') {
      if (!SEAL_KEY.test(sealKey)) throw bad('sealKey must be a raw X25519 key in base64');
      if (m.info !== undefined) smallObject(plan, 'plan');
    }
    await step(ctx, m, { type: 'READY', plan, sealKey }, 'be made ready');
    return null;
  },
});

/** S's thread has finished its turn and is frozen: packing starts. */
export const moveFrozen = mutation({
  args: { key: v.string(), moveId: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, moveId }) => {
    const caller = await runnerAuth(ctx, key, 'moveFrozen');
    const m = await moveRow(ctx, moveId);
    await mustBe(ctx, caller, m, 'from');
    if (m.state === 'packing') return null;
    await step(ctx, m, { type: 'FREEZE' }, 'start packing');
    return null;
  },
});

/**
 * Where S uploads one chunk. A runner key's goes through /runner/upload
 * with a ticket for this move, outside its picture allowances (the move
 * bounds it, and its chunks go when it ends); the owner's is Convex's own.
 */
export const moveChunkUrl = mutation({
  args: { key: v.string(), moveId: v.string() },
  returns: v.string(),
  handler: async (ctx, { key, moveId }) => {
    const caller = await runnerAuth(ctx, key, 'moveChunkUrl');
    const m = await moveRow(ctx, moveId);
    await mustBe(ctx, caller, m, 'from');
    if (m.state !== 'packing') throw conflict(`The move is ${m.state}, so it can't take chunks.`);
    if (caller.owner) return ctx.storage.generateUploadUrl();
    const tickets = await ctx.db.query('uploadTickets').withIndex('by_move', (q) => q.eq('moveId', moveId)).take(MOVE_TICKETS + 1);
    if (tickets.length >= MOVE_TICKETS) throw new ConvexError({ kind: 'tooMany', message: `A move may have at most ${MOVE_TICKETS} upload URLs` });
    const site = process.env.CONVEX_SITE_URL;
    if (!site) throw new ConvexError({ kind: 'config', message: 'CONVEX_SITE_URL is not set' });
    const ticket = randomId() + randomId().slice(0, 16);
    await ctx.db.insert('uploadTickets', { ticketHash: await sha256(ticket), runnerId: caller.runnerId, ...ticketKey(caller), issuedAt: Date.now(), moveId });
    return `${site.replace(/\/+$/, '')}/runner/upload?ticket=${ticket}`;
  },
});

/** S has uploaded the sealed bundle: T's turn to unpack it. */
export const movePacked = mutation({
  args: { key: v.string(), moveId: v.string(), chunks: v.array(v.id('_storage')), sha256: v.string(), bytes: v.number() },
  returns: v.null(),
  handler: async (ctx, { key, ...a }) => {
    const caller = await runnerAuth(ctx, key, 'movePacked');
    const m = await moveRow(ctx, a.moveId);
    await mustBe(ctx, caller, m, 'from');
    if (m.state === 'unpacking' && m.sha256 === a.sha256) return null;
    if (m.state !== 'packing') throw conflict(`The move is ${m.state}, so it can't be packed.`);
    if (a.chunks.length < 1 || a.chunks.length > MAX_MOVE_CHUNKS) throw bad(`a move has 1 to ${MAX_MOVE_CHUNKS} chunks`);
    if (new Set(a.chunks).size !== a.chunks.length) throw bad('a chunk is named twice');
    if (!/^[0-9a-f]{64}$/.test(a.sha256)) throw bad('sha256 must be 64 hex characters');
    if (!Number.isSafeInteger(a.bytes) || a.bytes < 1 || a.bytes > MAX_MOVE_CHUNKS * MAX_RUNNER_UPLOAD_BYTES) throw bad('bytes is out of range');
    for (const id of a.chunks) {
      if (!(await ctx.db.system.get(id))) throw bad('a chunk is not stored');
      const owners = await ctx.db.query('storageOwners').withIndex('by_storageId', (q) => q.eq('storageId', id)).collect();
      if (!caller.owner && !owners.some((o) => o.runnerId === caller.runnerId)) throw forbidden("use a stored file its runner didn't upload");
      // The main key's own chunks have no record: one with a keyed runner's is that runner's upload (Gemini's review of Daybreak 178).
      for (const o of owners) if (caller.owner && (await hasLiveKey(ctx, o.runnerId))) throw forbidden("use a stored file its runner didn't upload");
    }
    await step(ctx, m, { type: 'PACK', chunks: a.chunks, sha256: a.sha256, bytes: a.bytes }, 'be packed');
    return null;
  },
});

/**
 * The main Mac's uploads for a move that ended before movePacked named
 * them (the other runner failed it while they went up): its own uploads
 * are Convex's, with no record dropChunks could find, so its runner names
 * them. Only once the move has ended, only files no move still going
 * names, and nothing else uses.
 */
export const moveDropChunks = mutation({
  args: { key: v.string(), moveId: v.string(), chunks: v.array(v.id('_storage')) },
  returns: v.null(),
  handler: async (ctx, { key, moveId, chunks }) => {
    await runnerAuth(ctx, key, 'moveDropChunks');
    const m = await moveRow(ctx, moveId);
    if (GOING.includes(m.state)) throw conflict(`The move is ${m.state}, so its chunks stay.`);
    if (chunks.length > MOVE_TICKETS) throw bad(`at most ${MOVE_TICKETS} chunks`);
    for (const id of chunks) {
      if (!(await ctx.db.system.get(id))) continue;
      if (await ctx.db.query('storageOwners').withIndex('by_storageId', (q) => q.eq('storageId', id)).first()) continue;
      if (await storageInUse(ctx, id)) continue;
      let named = false;
      for (const state of GOING) {
        for (const other of await ctx.db.query('threadMoves').withIndex('by_state', (q) => q.eq('state', state)).take(100)) if (other.chunks?.includes(id)) named = true;
      }
      if (!named) await ctx.storage.delete(id);
    }
    return null;
  },
});

/** Where T downloads the chunks from, in order. */
export const moveChunks = query({
  args: { key: v.string(), moveId: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { key, moveId }) => {
    const caller = await runnerAuth(ctx, key, 'moveChunks');
    const m = await moveRow(ctx, moveId);
    await mustBe(ctx, caller, m, 'to');
    if (m.state !== 'unpacking' && m.state !== 'claimed') throw conflict(`The move is ${m.state}, so it can't be downloaded.`);
    const urls: string[] = [];
    for (const id of m.chunks ?? []) {
      const url = await ctx.storage.getUrl(id);
      if (!url) throw conflict('A chunk has gone.');
      urls.push(url);
    }
    return urls;
  },
});

/**
 * The switch: from here the thread is T's. Its row, its Pocket cards and
 * its share link go to T, S's sidebar row for it goes, and its mirrored
 * rows follow in runs of their own (rehomeRows), so its history stays on
 * the phone. Commands for it go to T from now on, and S's writes under
 * the id are refused.
 */
export const moveClaim = mutation({
  args: { key: v.string(), moveId: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, moveId }) => {
    const caller = await runnerAuth(ctx, key, 'moveClaim');
    const m = await moveRow(ctx, moveId);
    await mustBe(ctx, caller, m, 'to');
    if (m.state === 'claimed') return null;
    // The machine fails it instead if the thread isn't on S any more.
    if ((await step(ctx, m, { type: 'CLAIM' }, 'be claimed')).to === 'claimed') await switchThread(ctx, m);
    return null;
  },
});

// The switch itself, in the claim's mutation: the thread, its Pocket cards
// and its share link to T, S's sidebar row for it gone, and its mirrored
// rows to follow in runs of their own (rehomeRows).
async function switchThread(ctx: MutationCtx, m: Move): Promise<void> {
  const t = (await ctx.db
    .query('threads')
    .withIndex('by_threadId', (q) => q.eq('threadId', m.threadId))
    .unique())!;
  const now = Date.now();
  // Its projects were the old Mac's (a project id is only its runner's
  // own, sync.ts heldElsewhere): it leaves them, and the new Mac puts it in
  // its own. Kept, they'd show the thread under the old Mac's project to
  // apps that look a project up by id alone, for as long as the new Mac
  // didn't write the row again (Daybreak 141, cross-lab review).
  await ctx.db.patch(t._id, { runnerId: m.to, pendingApproval: undefined, projects: undefined, updatedMs: now });
  for (const l of await ctx.db.query('projectThreads').withIndex('by_threadId', (q) => q.eq('threadId', m.threadId)).collect()) await ctx.db.delete(l._id);
  await moveView(ctx, m.from, t.view, undefined);
  await moveView(ctx, m.to, undefined, t.view);
  await buryIndexRows(ctx, m.threadId, m.to);
  for (const c of await ctx.db.query('pocketCards').withIndex('by_runnerId', (q) => q.eq('runnerId', m.from)).collect()) {
    if (c.threadId === m.threadId) await ctx.db.patch(c._id, { runnerId: m.to, updatedAt: new Date(now).toISOString() });
  }
  await ctx.scheduler.runAfter(0, internal.moves.rehomeRows, { moveId: m.moveId, threadId: m.threadId, from: m.from, to: m.to, table: 0, cursor: null });
}

/**
 * T has the thread running: the move is over once its rows have all gone
 * to T (rehomeRows ends it then, if they haven't yet). Until then it stays
 * claimed, so the thread can't start another move whose rows a late page
 * of this one would give to this one's T (Daybreak, 15 Nov 2026).
 */
export const moveDone = mutation({
  args: { key: v.string(), moveId: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, moveId }) => {
    const caller = await runnerAuth(ctx, key, 'moveDone');
    const m = await moveRow(ctx, moveId);
    await mustBe(ctx, caller, m, 'to');
    if (steppingFor('moveState')) return await asBefore(ctx, m, 'done');
    if (m.state === 'done' || (m.moveState.kind === 'claimed' && m.moveState.doneAsked)) return null;
    await step(ctx, m, { type: 'DONE' }, 'be done');
    return null;
  },
});

/** S or T can't go on: the thread stays where it was. Only before the switch. */
export const moveFailed = mutation({
  args: { key: v.string(), moveId: v.string(), note: v.string() },
  returns: v.null(),
  handler: async (ctx, { key, moveId, note }) => {
    const caller = await runnerAuth(ctx, key, 'moveFailed');
    const m = await moveRow(ctx, moveId);
    await mustBe(ctx, caller, m, 'either');
    if (m.state === 'failed' || m.state === 'cancelled') return null;
    if (steppingFor('moveState')) return await asBefore(ctx, m, 'failed', note);
    await step(ctx, m, { type: 'FAIL', note }, 'fail');
    return null;
  },
});

/**
 * moveDone and moveFailed while the deploy's stepping stone has the
 * machine off (stepping.ts), the way they were before it: a runner from
 * before API 85's retries treats a refusal as final, and a refused done
 * would leave the move claimed, and the thread unable to move again, until
 * that runner restarted (Codex's review). The machine has never run on this
 * deployment then, so the old fields are the move's whole story; a row the
 * backfill has already reached gets its moveState again from them.
 */
async function asBefore(ctx: MutationCtx, m: Move, what: 'done' | 'failed', note?: string): Promise<null> {
  const now = Date.now();
  let fields: Partial<Move>;
  if (what === 'done') {
    if (m.state === 'done') return null;
    if (m.state !== 'claimed') throw conflict(`The move is ${m.state}, so it can't be done.`);
    if (m.rehomedAt) {
      await dropChunks(ctx, m);
      fields = { state: 'done', chunks: undefined, updatedAt: now };
    } else fields = { doneAsked: true, updatedAt: now };
  } else {
    if (!['asking', 'ready', 'packing', 'unpacking'].includes(m.state)) throw conflict(`The move is ${m.state}, so it can't fail.`);
    await dropChunks(ctx, m);
    fields = { state: 'failed', chunks: undefined, updatedAt: now, note: (note ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 500) || 'The move failed.' };
  }
  const backfilled = (m as Partial<Move>).moveState !== undefined;
  await ctx.db.patch(m._id, { ...fields, ...(backfilled ? { moveState: moveStateFrom({ ...m, ...fields }), moveStateTimers: [] } : {}) });
  return null;
}

const REHOME_TABLES = ['messages', 'eventBodies', 'shareImages', 'replyImages', 'heldPictures'] as const;

async function countStoredBytes(ctx: MutationCtx, runnerId: string, delta: number): Promise<void> {
  const usage = await ctx.db.query('runnerStorage').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
  if (usage) await ctx.db.patch(usage._id, { bytes: Math.max(0, usage.bytes + delta) });
  else if (delta > 0) await ctx.db.insert('runnerStorage', { runnerId, bytes: delta });
}

type PictureTable = 'shareImages' | 'replyImages' | 'heldPictures';
type PictureRow = { _id: Id<PictureTable>; storageId: Id<'_storage'> };

// A picture's file to T: S's upload record (and what it counts against)
// moves to T, or goes if T is the owner's, whose files have none; one with
// no record (the owner's, or one a move to the owner took its record from)
// gets one if T has an allowance (a key or a box), so T can delete it, and
// is charged to T at its size as an upload of T's would be, so a file can't
// reach T for free by way of the owner (Codex's review, 24 Nov 2026). A
// file T has no room to keep (sync.ts roomToStore, the limit on any upload
// of T's) isn't kept for it: the picture's row and the backend's copy go,
// and S is no longer charged for it. The picture itself moved with the
// thread, so T's runner sends it again when it has room, as it does any
// picture the backend lacks (Daybreak 181).
async function rehomeFile(ctx: MutationCtx, table: PictureTable, picture: PictureRow, from: string, to: string, toCharged: boolean): Promise<void> {
  const storageId = picture.storageId;
  const rows = await ctx.db.query('storageOwners').withIndex('by_storageId', (q) => q.eq('storageId', storageId)).collect();
  // Its size as stored, for a file whose record doesn't say (one from before records had it).
  const size = async () => Math.max(MIN_UPLOAD_CHARGE, (await ctx.db.system.get('_storage', storageId))?.size ?? 0);
  const notKept = async () => {
    await ctx.db.delete(table, picture._id as Id<'replyImages'>);
    // Its record and S's charge for it go with the file (unless another row still names it).
    await deleteIfUnused(ctx, storageId);
  };
  if (!rows.length) {
    if (!toCharged) return;
    const bytes = await size();
    if (!(await roomToStore(ctx, to, bytes))) return notKept();
    await ctx.db.insert('storageOwners', { storageId, runnerId: to, at: Date.now(), bytes, attachedAt: Date.now() });
    await countStoredBytes(ctx, to, bytes);
    return;
  }
  for (const row of rows) {
    if (row.runnerId !== from) continue;
    const bytes = row.bytes ?? 0;
    // A record of 0 bytes (from before records had sizes, or one an older move made) is charged at its size.
    const charge = row.bytes || (await size());
    if (toCharged && !(await roomToStore(ctx, to, charge))) return notKept();
    await countStoredBytes(ctx, from, -bytes);
    if (toCharged) {
      await ctx.db.patch(row._id, { runnerId: to, bytes: charge });
      await countStoredBytes(ctx, to, charge);
    } else await ctx.db.delete(row._id);
  }
}

// The claimed move a rehome page is for, or null for a page that's no
// longer any move's to run (its move ended, or a page left over from a run
// that has finished). A page from before pages carried their move (a
// deploy in the middle of one) finds it by the thread and the two runners.
async function rehoming(ctx: MutationCtx, a: { moveId?: string; threadId: string; from: string; to: string }): Promise<Move | null> {
  let m: Move | null = null;
  if (a.moveId) {
    m = await ctx.db
      .query('threadMoves')
      .withIndex('by_moveId', (q) => q.eq('moveId', a.moveId!))
      .unique();
  } else {
    for (const x of await ctx.db.query('threadMoves').withIndex('by_thread', (q) => q.eq('threadId', a.threadId)).collect()) if (x.moveState.kind === 'claimed' && x.from === a.from && x.to === a.to) m = x;
  }
  if (!m || m.moveState.kind !== 'claimed' || m.threadId !== a.threadId || m.from !== a.from || m.to !== a.to) return null;
  return m;
}

/**
 * A moved thread's mirrored rows to T, a page at a time: a runner key's
 * messages and tool output carry its runnerId and count against its
 * allowances (CAP), the owner's carry none. Each page is its move's and
 * runs only while that move is claimed and the thread is T's, so a page
 * that runs late (Convex keeps scheduled jobs in no set order) can't give
 * rows to a runner the thread has since left; the move ends only after
 * the last page (moveDone), so no next move starts before then; and a
 * page run again finds nothing more of S's to give (Daybreak, 15 Nov 2026).
 */
// Built with the machines' catalog, as REHOMED is the server's to send.
export const rehomeRows = machines.internalMutation({
  args: { moveId: v.optional(v.string()), threadId: v.string(), from: v.string(), to: v.string(), table: v.number(), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (machineCtx, { moveId, threadId, from, to, table, cursor }) => {
    const ctx = machineCtx as unknown as MutationCtx;
    // Every row has gone to T: T's done (if it has said so) ends the move.
    const rehomed = async (m: Move) => void (await moveMachine.send(machineCtx, m._id, { type: 'REHOMED' }));
    const m = await rehoming(ctx, { moveId, threadId, from, to });
    if (!m) return null;
    const name = REHOME_TABLES[table];
    const t = await ctx.db
      .query('threads')
      .withIndex('by_threadId', (q) => q.eq('threadId', threadId))
      .unique();
    // Nothing more to give: past the last table, the thread gone (its rows
    // go with it), or not T's (which a claimed move's can't be).
    if (!name || !t || t.runnerId !== to) {
      await rehomed(m);
      return null;
    }
    // Who counts T's rows (lib.ts hasAllowance): a runner key's runner or a
    // box, never mistaken for the owner's because a box's key isn't a
    // runnerKeys row (Daybreak 181, 24 Nov 2026).
    const toCharged = await hasAllowance(ctx, to);
    // A box makes room among its own thread's rows only, and its one thread is this one.
    const onlyThread = toCharged && !(await hasLiveKey(ctx, to)) ? threadId : undefined;
    // Every one of these tables has by_thread_seq, from threadId.
    const page = await ctx.db
      .query(name as 'messages')
      .withIndex('by_thread_seq', (q) => q.eq('threadId', threadId))
      .paginate({ numItems: REHOME_PAGE[name], cursor });
    // T takes S's rows as if it had written them when they were written:
    // within its allowances, its oldest going first to make room (sync.ts
    // roomForMessage, roomForBody), so a move never puts it past them. A row
    // keeps its age (a message its _creationTime, a tool output its `at`),
    // so when T is full one older than anything T has is the one that would
    // go first, and goes rather than come over; a newer one comes over in
    // place of T's older rows only, never its newer ones (Gemini's review,
    // 24 Nov 2026: given rows taken for room-making's "this call's own"
    // could be the oldest, which sent it reading all of T's rows). Out of
    // room for now, the page stops there and runs again with a fresh
    // allowance of room-making; the rows not yet given stay S's and the
    // move stays claimed, so nothing is lost meanwhile. Room-making is held
    // to REHOME_EVICT rows a run (budget starts that far below the call's cap).
    const evictFrom = name === 'messages' ? Math.max(0, CAP.evictPerWrite - REHOME_EVICT.messages) : Math.max(0, CAP.bodyEvictPerWrite - REHOME_EVICT.eventBodies);
    const budget = { evicted: evictFrom, owners: new Map<string, string | null>() };
    let moved = 0;
    let full = false;
    for (const row of page.page as Record<string, any>[]) {
      if (name === 'messages' || name === 'eventBodies') {
        // S's, or nobody's (the owner's, or one an older move or a runner's
        // time on the main key left uncounted): all of the thread's rows end
        // up counted against the runner it's on (Codex's review). A row under
        // a third runner's id isn't S's to give.
        const owner = row.runnerId as string | undefined;
        if (owner !== undefined && owner !== from) continue;
        const { _id, _creationTime, runnerId: _r, ...rest } = row;
        const count = name === 'messages' ? countMessageBytes : countBodyBytes;
        if (toCharged) {
          const size = docBytes({ ...rest, runnerId: to });
          // Room among T's rows older than this one only (sync.ts RowAge).
          const age: RowAge = { before: name === 'messages' ? _creationTime : row.at };
          const room = name === 'messages' ? await roomForMessage(ctx, to, size, new Set(), budget, undefined, onlyThread, age) : await roomForBody(ctx, to, size, null, budget, onlyThread, age);
          if (!room && age.oldest) {
            // What T's allowance would let go first: it goes, rather than come over.
            await letGo(ctx, name, row as Doc<'messages'>);
            moved++;
            continue;
          }
          if (!room) {
            full = true;
            break;
          }
          if (owner !== undefined) await count(ctx, from, -storedBytes(row));
          await ctx.db.patch(_id, { runnerId: to });
          moved++;
        } else {
          if (owner !== undefined) await count(ctx, from, -storedBytes(row));
          await ctx.db.patch(_id, { runnerId: undefined });
        }
      } else await rehomeFile(ctx, name as PictureTable, row as PictureRow, from, to, toCharged);
    }
    if (full) {
      // Again from this page, which gives only what's still S's. Only while
      // this run got somewhere (gave a row or made room): one that couldn't
      // waits for the sweep (expireMoves), rather than running for ever.
      if (moved || budget.evicted > evictFrom) await ctx.scheduler.runAfter(0, internal.moves.rehomeRows, { moveId: m.moveId, threadId, from, to, table, cursor });
      return null;
    }
    const next = page.isDone ? { table: table + 1, cursor: null } : { table, cursor: page.continueCursor };
    if (REHOME_TABLES[next.table]) await ctx.scheduler.runAfter(0, internal.moves.rehomeRows, { moveId: m.moveId, threadId, from, to, ...next });
    else await rehomed(m);
    return null;
  },
});

/**
 * The sweep, every few minutes. The machine's timers end a move T never
 * answered, a ready one that has waited MOVE_READY_MS and one frozen and not
 * claimed after MOVE_FROZEN_MS; this ends a ready one whose S has gone
 * (which no timer can know), arms the timers of a move the backfill brought
 * over, sends a stuck claimed move's rows again, and deletes ended moves
 * after a week.
 */
export const expireMoves = machines.internalMutation({
  args: {},
  returns: v.null(),
  handler: async (machineCtx) => {
    const ctx = machineCtx as unknown as MutationCtx;
    const now = Date.now();
    // A handful at most in each: one per thread moving.
    for (const state of ['asking', 'ready', 'packing', 'unpacking'] as const) {
      for (const m of await ctx.db.query('threadMoves').withIndex('by_state', (q) => q.eq('state', state)).take(100)) {
        // A move from before its machine (migrations.ts) has a deadline and no timer yet.
        if (!m.moveStateTimers.length) await moveMachine.armTimers(machineCtx, m._id);
        if (state !== 'ready') continue;
        const s = await ctx.db
          .query('runners')
          .withIndex('by_runnerId', (q) => q.eq('runnerId', m.from))
          .unique();
        const seen = Math.max(s?.lastSeenAt ?? 0, m.updatedAt);
        if (seen < now - MOVE_READY_OFFLINE_MS) await moveMachine.send(machineCtx, m._id, { type: 'SOURCE_GONE' });
      }
    }
    // A claimed move T said was done whose rows still haven't all gone over
    // (a page lost, or a move claimed before pages carried their move):
    // its rows go again from the start, which gives only what's still S's,
    // and the last page ends it.
    for (const m of await ctx.db.query('threadMoves').withIndex('by_state', (q) => q.eq('state', 'claimed').lt('updatedAt', now - REHOME_STUCK_MS)).take(100)) {
      if (m.moveState.kind !== 'claimed' || !m.moveState.doneAsked) continue;
      await ctx.db.patch(m._id, { updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.moves.rehomeRows, { moveId: m.moveId, threadId: m.threadId, from: m.from, to: m.to, table: 0, cursor: null });
    }
    for (const state of ['done', 'failed', 'cancelled'] as const) {
      for (const m of await ctx.db.query('threadMoves').withIndex('by_state', (q) => q.eq('state', state).lt('updatedAt', now - MOVE_KEPT_MS)).take(100)) await moveMachine.purge(machineCtx, m._id);
    }
    return null;
  },
});
