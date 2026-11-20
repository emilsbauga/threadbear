// Backfills a later schema change needs before it can go out: a field that
// becomes required has to be on every row first, or Convex refuses the deploy.
// Every deployment (Mike's, and each self-hosted one) deploys convex/ from
// whatever commit it updates to, skipping commits, so the deploy script
// (runner/scripts/deploy-backend.mjs, "Stepping stones") runs these: a commit
// that needs one lists it in convex/migrations.json, and the script deploys
// the commit before that, runs `migrations:run` until it says done, then goes
// on. A backfill is safe to run again, and records that it finished in
// backendMarks, which `migrations:done` reads.
//
// Each one stays here until no deployment can still need it.
import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import { commandStateFrom } from './commandStates';
import { moveStateFrom } from './moveStates';
import { requestStateFrom } from './requestStates';
import { clearStateFrom } from './clearStates';

// Rows per run: each is a small patch, and a command's row can be a few hundred KB.
const PAGE = 100;
const PAGE_BYTES = 4 * 1024 * 1024;

type Step = (ctx: MutationCtx, cursor: string | null) => Promise<{ cursor: string; done: boolean }>;

// commands.commandState and commandStateTimers, from `state` and its fields
// (commandStates.ts). Rows written since the widen already have both.
const commandState: Step = async (ctx, cursor) => {
  const page = await ctx.db.query('commands').paginate({ numItems: PAGE, cursor, maximumBytesRead: PAGE_BYTES });
  for (const c of page.page) {
    if (c.commandState !== undefined && c.commandStateTimers !== undefined) continue;
    await ctx.db.patch(c._id, { commandState: c.commandState ?? commandStateFrom(c), commandStateTimers: c.commandStateTimers ?? [] });
  }
  return { cursor: page.continueCursor, done: page.isDone };
};

// threadMoves.moveState and moveStateTimers, from `state` and its fields
// (moveStates.ts). Rows written since have both. A row in a state with a
// deadline gets its timer once the machine is live (moves.ts expireMoves).
const moveState: Step = async (ctx, cursor) => {
  const page = await ctx.db.query('threadMoves').paginate({ numItems: PAGE, cursor, maximumBytesRead: PAGE_BYTES });
  for (const m of page.page) {
    if (m.moveState !== undefined && m.moveStateTimers !== undefined) continue;
    await ctx.db.patch(m._id, { moveState: m.moveState ?? moveStateFrom(m), moveStateTimers: m.moveStateTimers ?? [] });
  }
  return { cursor: page.continueCursor, done: page.isDone };
};

// runnerRequests.requestState, from `state` and its fields (requestStates.ts).
const requestState: Step = async (ctx, cursor) => {
  const page = await ctx.db.query('runnerRequests').paginate({ numItems: PAGE, cursor, maximumBytesRead: PAGE_BYTES });
  for (const r of page.page) if (r.requestState === undefined) await ctx.db.patch(r._id, { requestState: requestStateFrom(r) });
  return { cursor: page.continueCursor, done: page.isDone };
};

// threadClears.clearState and clearStateTimers, from `moving` and `done`
// (clearStates.ts). A clearing row's timer is armed once the machine is
// live (sync.ts armClears): its runs start again then.
const clearState: Step = async (ctx, cursor) => {
  const page = await ctx.db.query('threadClears').paginate({ numItems: PAGE, cursor, maximumBytesRead: PAGE_BYTES });
  for (const c of page.page) if (c.clearState === undefined) await ctx.db.patch(c._id, { clearState: clearStateFrom(c, Date.now()), clearStateTimers: c.clearStateTimers ?? [] });
  return { cursor: page.continueCursor, done: page.isDone };
};

// cloudTokens.tokenState (cloudTokenMachine.ts): a token set before API 94
// is valid, as no box had said otherwise.
const tokenState: Step = async (ctx, cursor) => {
  const page = await ctx.db.query('cloudTokens').paginate({ numItems: PAGE, cursor, maximumBytesRead: PAGE_BYTES });
  for (const t of page.page) {
    // eslint-disable-next-line machines/no-direct-state-writes, @convex-dev/explicit-table-ids -- a backfill writes the field before its machine is live (stepping.ts), as the others here do
    if (t.tokenState === undefined) await ctx.db.patch(t._id, { tokenState: { kind: 'valid' } });
  }
  return { cursor: page.continueCursor, done: page.isDone };
};

const BACKFILLS: Record<string, Step> = { commandState, moveState, requestState, clearState, tokenState };
const mark = (name: string) => `backfill-${name}-done`;

/** One run of a backfill from where the last left off. Run it until it says done. */
export const run = internalMutation({
  args: { name: v.string() },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, { name }) => {
    const step = BACKFILLS[name];
    if (!step) throw new ConvexError({ kind: 'badArgs', message: `no backfill called ${name}` });
    const done = await ctx.db.query('backendMarks').withIndex('by_name', (q) => q.eq('name', mark(name))).first();
    if (done?.at !== undefined) return { done: true };
    const { cursor, done: finished } = await step(ctx, done?.cursor ?? null);
    if (finished) {
      if (done) await ctx.db.patch(done._id, { at: Date.now(), cursor: undefined });
      else await ctx.db.insert('backendMarks', { name: mark(name), at: Date.now() });
    } else if (done) await ctx.db.patch(done._id, { cursor });
    else await ctx.db.insert('backendMarks', { name: mark(name), cursor });
    return { done: finished };
  },
});

/** Whether a backfill has finished on this deployment. */
export const done = internalQuery({
  args: { name: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { name }) => (await ctx.db.query('backendMarks').withIndex('by_name', (q) => q.eq('name', mark(name))).first())?.at !== undefined,
});
