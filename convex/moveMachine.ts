// A thread's move to another runner as a state machine (docs/lifecycles.md,
// docs/protocol.md "Moving a thread to another runner"). The main Mac's
// runner starts and cancels it; the runner that has the thread (S) and the
// runner taking it (T) each take their own steps. Runners authenticate with
// keys in their args, not ctx.auth, so each function in moves.ts checks who's
// asking (runnerAuth, mustBe) before it sends: the roles say who sends what,
// and their checks pass.
//
// `threadMoves.state`, the strings runners read, is written by the effects
// from the state each one returns (moveStates.ts), so it can't drift from
// the machine. So are the fields runners read beside it (info, plan, key,
// chunks, frozenAt, note, updatedAt).
import { defineMachine } from '@convex-dev/state-machines';
import { v } from 'convex/values';
import { appSchema } from './schema';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { legacyMoveState, MOVE_ASK_MS, MOVE_FROZEN_MS, MOVE_READY_MS, type MoveState } from './moveStates';
import { unlessStepping } from './stepping';

type Move = Doc<'threadMoves'>;
const NOTE_CHARS = 500;
// 12 chunks of at most 10 MB, each with up to two upload records (moves.ts MOVE_TICKETS).
const MOVE_TICKETS = 24;

const ended = (description: string) => ({ to: 'failed', effect: 'fail', description }) as const;

export const move = unlessStepping('moveState', () => defineMachine(
  appSchema,
  {
    name: 'move',
    table: 'threadMoves',
    field: 'moveState',
    description: 'A thread moving from the runner that has it (S) to another (T): T says it can take it, S freezes and packs it sealed to T, and T unpacks and claims it. At any moment one runner has the thread.',
    callers: {
      owner: "Only the main Mac's runner starts or cancels a move.",
      runner: "Only the move's own runners take its steps, each its own side's.",
    },
    events: {
      owner: { START: {}, CANCEL: {} },
      runner: {
        DESCRIBE: { info: v.any() },
        READY: { plan: v.any(), sealKey: v.string() },
        FREEZE: {},
        PACK: { chunks: v.array(v.id('_storage')), sha256: v.string(), bytes: v.number() },
        CLAIM: {},
        DONE: {},
        FAIL: { note: v.string() },
      },
      server: { SOURCE_GONE: {}, REHOMED: {} },
    },
    guards: {
      described: "The move can't be made ready before its thread is described.",
      stillOnSource: "The thread isn't on the runner it's moving from any more.",
      doneAsked: "The runner it went to hasn't said it's running it yet.",
    },
    states: {
      start: {
        on: { START: { to: 'asking', effect: 'start', description: 'The main Mac starts a move, for Mike or an agent: to an online runner, one move per thread at a time.' } },
      },
      asking: {
        description: 'S describes the thread (its folder, repo, login), and T works out where it can put it.',
        timers: { NO_ANSWER: { at: 'askBy', description: "Ten minutes have passed since the move started, or since S described the thread, and T hasn't said it can take it." } },
        on: {
          DESCRIBE: { effect: 'describe', description: "S describes the thread once, and T's ten minutes start again." },
          READY: { to: 'ready', guard: 'described', effect: 'ready', description: 'T says where it will put the thread and gives the key to seal it to.' },
          CANCEL: { to: 'cancelled', effect: 'cancel', description: 'Mike changes his mind.' },
          FAIL: ended('S or T says it can\'t go on: the thread stays where it is.'),
          NO_ANSWER: { to: 'failed', effect: 'noAnswer', description: "T didn't answer in time." },
        },
      },
      ready: {
        description: "T can take it. S freezes the thread once its turn is over, which can take a while: there's no short limit while S is online.",
        timers: { WAITED_TOO_LONG: { at: 'giveUpAt', description: "Twelve hours have passed and S's thread is still busy." } },
        on: {
          FREEZE: { to: 'packing', effect: 'freeze', description: "S's thread has finished its turn and is frozen: packing starts." },
          CANCEL: { to: 'cancelled', effect: 'cancel', description: 'Mike changes his mind.' },
          FAIL: ended("S or T says it can't go on: the thread stays where it is."),
          SOURCE_GONE: { to: 'failed', effect: 'sourceGone', description: 'The sweep finds S has been offline ten minutes (asleep or switched off): the thread stays where it is.' },
          WAITED_TOO_LONG: { to: 'failed', effect: 'waitedTooLong', description: 'The thread stays where it is.' },
        },
      },
      packing: {
        description: 'The thread is frozen on S, which packs it and uploads it sealed to T.',
        timers: { TOO_SLOW: { at: 'giveUpAt', description: 'Thirty minutes have passed since S froze the thread.' } },
        on: {
          PACK: { to: 'unpacking', effect: 'pack', description: "S has uploaded the sealed bundle: T's turn." },
          CANCEL: { to: 'cancelled', effect: 'cancel', description: 'Mike changes his mind: S unfreezes the thread.' },
          FAIL: ended("S or T says it can't go on: S unfreezes the thread."),
          TOO_SLOW: { to: 'failed', effect: 'tooSlow', description: "The move is given up, so the thread isn't left frozen on S for good." },
        },
      },
      unpacking: {
        description: 'T downloads and unpacks the bundle. The thread is still S\'s, frozen, and Mike can no longer cancel.',
        timers: { TOO_SLOW: { at: 'giveUpAt', description: 'Thirty minutes have passed since S froze the thread.' } },
        on: {
          CLAIM: [
            { to: 'claimed', guard: 'stillOnSource', effect: 'claim', description: 'The switch: from here the thread, its Pocket cards and its share link are T\'s, commands for it go to T, and its rows start going over.' },
            { to: 'failed', effect: 'sourceLost', description: "The thread isn't on S any more (deleted, or moved some other way), so there's nothing to take." },
          ],
          FAIL: ended("S or T says it can't go on: S unfreezes the thread."),
          TOO_SLOW: { to: 'failed', effect: 'tooSlow', description: "The move is given up, so the thread isn't left frozen on S for good." },
        },
      },
      claimed: {
        description: "T has the thread. Its mirrored rows go over to T a page at a time; the move ends only after the last, so the thread can't start another move a late page would muddle.",
        on: {
          DONE: { effect: 'doneAsked', description: "T says it's running the thread, before every row has gone over: it ends once they have." },
          REHOMED: [
            { to: 'done', guard: 'doneAsked', effect: 'done', description: "The last row has gone to T, which has already said it's running the thread." },
            { to: 'handedOver', effect: 'rehomed', description: "The last row has gone to T, which hasn't said it's running the thread yet." },
          ],
        },
      },
      handedOver: {
        description: "Every row is T's. Waiting for T to say it's running the thread.",
        on: { DONE: { to: 'done', effect: 'done', description: "T says it's running the thread." } },
      },
      done: { description: 'The thread is on T, with its history.' },
      failed: { description: "The move didn't happen: the thread stays on S, unfrozen, and its uploads are deleted." },
      cancelled: { description: 'Mike cancelled it: the thread stays on S, and its uploads are deleted.' },
    },
  },
  {
    callers: { owner: () => true, runner: () => true },
    guards: {
      described: (_ctx, { row }) => row.info !== undefined,
      stillOnSource: async (ctx, { row }) => (await ctx.db.query('threads').withIndex('by_threadId', (q) => q.eq('threadId', row.threadId)).unique())?.runnerId === row.from,
      doneAsked: (_ctx, { state }) => state.doneAsked,
    },
    effects: {
      start: async () => ({ kind: 'asking' as const, askBy: Date.now() + MOVE_ASK_MS }),
      describe: async (ctx, { id, event }) => {
        await patch(ctx, id, { info: event.info });
        return { kind: 'asking' as const, askBy: Date.now() + MOVE_ASK_MS };
      },
      ready: async (ctx, { id, event }) => {
        const now = Date.now();
        return legacy(ctx, id, { kind: 'ready', readyAt: now, giveUpAt: now + MOVE_READY_MS }, { plan: event.plan, key: event.sealKey });
      },
      freeze: async (ctx, { id }) => {
        const now = Date.now();
        return legacy(ctx, id, { kind: 'packing', frozenAt: now, giveUpAt: now + MOVE_FROZEN_MS }, { frozenAt: now });
      },
      pack: async (ctx, { id, state, event }) => legacy(ctx, id, { kind: 'unpacking', frozenAt: state.frozenAt, giveUpAt: state.giveUpAt }, { chunks: [...event.chunks], sha256: event.sha256, bytes: event.bytes }),
      // moves.ts moveClaim hands the thread over in the same mutation.
      claim: async (ctx, { id }) => legacy(ctx, id, { kind: 'claimed', claimedAt: Date.now(), doneAsked: false }),
      doneAsked: async (ctx, { id, state }) => {
        await patch(ctx, id, {});
        return { ...state, doneAsked: true };
      },
      rehomed: async (ctx, { id, state }) => legacy(ctx, id, { kind: 'handedOver', claimedAt: state.claimedAt, rehomedAt: Date.now() }),
      done: async (ctx, { id, row }) => end(ctx, id, row, 'done'),
      cancel: async (ctx, { id, row }) => end(ctx, id, row, 'cancelled', 'Cancelled.'),
      fail: async (ctx, { id, row, event }) => end(ctx, id, row, 'failed', event.note.replace(/[\u0000-\u001f]+/g, ' ').trim() || 'The move failed.'),
      noAnswer: async (ctx, { id, row }) => end(ctx, id, row, 'failed', `${await runnerName(ctx, row.to)} didn't answer.`),
      sourceGone: async (ctx, { id, row }) => end(ctx, id, row, 'failed', `${await runnerName(ctx, row.from)} went offline before the thread could be packed, so it stays where it is.`),
      waitedTooLong: async (ctx, { id, row }) => end(ctx, id, row, 'failed', 'The thread was still busy 12 hours later, so it stays where it is.'),
      tooSlow: async (ctx, { id, row }) => end(ctx, id, row, 'failed', 'The move took more than 30 minutes.'),
      sourceLost: async (ctx, { id, row }) => end(ctx, id, row, 'failed', `The thread isn't on ${await runnerName(ctx, row.from)} any more.`),
    },
  },
));

type Db = { db: unknown };
const db = (ctx: Db) => ctx.db as MutationCtx['db'];

// The row's own fields, never its machine's: the guarded db checks that.
async function patch(ctx: Db, id: unknown, fields: Partial<Move>): Promise<void> {
  await (ctx.db as { patch(id: unknown, value: object): Promise<void> }).patch(id, { ...fields, updatedAt: Date.now() });
}

// The state's string on the row, as runners and the indexes read it, with the fields that step sets.
async function legacy<S extends MoveState>(ctx: Db, id: unknown, next: S, fields: Partial<Move> = {}): Promise<S> {
  await patch(ctx, id, { state: legacyMoveState(next), ...fields });
  return next;
}

async function runnerName(ctx: Db, runnerId: string): Promise<string> {
  return (await db(ctx).query('runners').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique())?.name ?? runnerId;
}

// However a move ends, its chunks go: nothing else names them. Every upload
// made for the move (sync.ts redeemUpload names each with it), not just
// those PACK listed, and each runner gets its bytes back.
async function end<K extends 'done' | 'failed' | 'cancelled'>(ctx: Db & { storage: unknown }, id: unknown, m: Move, kind: K, note?: string): Promise<{ kind: K; endedAt: number }> {
  await dropChunks(ctx as unknown as MutationCtx, m);
  const now = Date.now();
  await patch(ctx, id, { state: kind, chunks: undefined, ...(note ? { note: note.slice(0, NOTE_CHARS) } : {}) });
  return { kind, endedAt: now };
}

export async function dropChunks(ctx: MutationCtx, m: Move): Promise<void> {
  const ids = new Set<Id<'_storage'>>(m.chunks ?? []);
  for (const row of await ctx.db.query('storageOwners').withIndex('by_move', (q) => q.eq('moveId', m.moveId)).take(MOVE_TICKETS * 2)) ids.add(row.storageId);
  for (const id of ids) {
    if (await ctx.db.system.get(id)) await ctx.storage.delete(id);
    for (const row of await ctx.db.query('storageOwners').withIndex('by_storageId', (q) => q.eq('storageId', id)).collect()) {
      await ctx.db.delete(row._id);
      if (!row.bytes) continue;
      const usage = await ctx.db.query('runnerStorage').withIndex('by_runnerId', (q) => q.eq('runnerId', row.runnerId)).unique();
      if (usage) await ctx.db.patch(usage._id, { bytes: Math.max(0, usage.bytes - row.bytes) });
    }
  }
}
