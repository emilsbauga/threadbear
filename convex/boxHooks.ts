// Where the rest of the backend tells a thread's box on a virtual runner
// (docs/virtual-runners.md, decisions 6 and 7) that something happened to
// its thread: a command queued for it (wake it), or the thread archived or
// deleted (delete its box). Each only schedules the box's own step, in an
// internal mutation of boxes.ts: the functions that call these are plain
// mutations, which can't send a box's `server` events.
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';

// The states a command for the box's runner wakes it from: asleep (resume
// it, or a new box from the save), failed (try a new box), saving and
// archiving (it stays up, boxMachine.ts), gone (unarchived: a new box from
// the save) and shelved (unarchived: its kept box resumed). From expired
// the command fails, saying the thread can't come back.
export const WAKES_FROM: readonly string[] = ['asleep', 'failed', 'saving', 'archiving', 'gone', 'shelved', 'expired'];
// A thread whose box never started: no box, no runner to take its commands.
export const UNSTARTED: readonly string[] = ['needsToken', 'waitingForRoom'];
// Archived: woken only for what needs it running (wakesArchived).
const ARCHIVED: readonly string[] = ['gone', 'shelved', 'archiving'];

// Long enough for the box's runner to finish the command that archived its
// thread before its key stops working.
export const ARCHIVE_GRACE_MS = 60_000;

/**
 * A command was queued for `runnerId` (machines.ts queued, both insert
 * sites): if that's a box that's asleep, wake it. Two quick sends both see
 * it asleep and both schedule boxes:wakeFor; only the first's WAKE is
 * taken, so they make one wake. A box's `save` (boxService.ts askToSave)
 * isn't a reason to wake it.
 */
export async function wakeIfAsleep(ctx: MutationCtx, runnerId: string, kind: string, args?: unknown, commandId?: Id<'commands'>): Promise<void> {
  if (kind === 'save') return;
  const row = await ctx.db
    .query('boxes')
    .withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId))
    .first();
  if (!row) return;
  // Never started (waiting for its login's cloud token, or for room): nothing
  // to wake, but archiving it ends the wait (boxMachine.ts ARCHIVE), and that
  // archive is done there and then, as no runner will ever take it.
  if (UNSTARTED.includes(row.boxState.kind)) {
    if (endsWait(kind, args)) await ctx.scheduler.runAfter(0, internal.boxes.archiveUnstarted, { threadId: row.threadId, ...(commandId ? { commandId } : {}) });
    return;
  }
  if (!WAKES_FROM.includes(row.boxState.kind)) return;
  // An archived one comes back only for what needs it running (unarchiving
  // it, a message), not for marking it seen or a title.
  if (ARCHIVED.includes(row.boxState.kind) && !wakesArchived(kind, args)) return;
  await ctx.scheduler.runAfter(0, internal.boxes.wakeFor, { runnerId, ...(commandId ? { commandId } : {}) });
}

/**
 * A box just went to a state a command wakes it from (asleep, gone,
 * shelved): if a command that would have woken it is already waiting (an
 * unarchive sent while it was being deleted), it wakes now.
 */
export async function wakeIfPending(ctx: MutationCtx, runnerId: string, as: 'asleep' | 'gone' | 'shelved'): Promise<void> {
  // Found by what each would wake (wakeLevelOf), however many are waiting.
  const need = as === 'asleep' ? 1 : 2;
  const waking = await ctx.db.query('commands').withIndex('by_runner_wake', (q) => q.eq('runnerId', runnerId).eq('state', 'pending').gte('wakeLevel', need)).first();
  if (waking) await ctx.scheduler.runAfter(0, internal.boxes.wakeFor, { runnerId });
}

/** What a command wakes of a sleeping box: 1 an asleep one, 2 an archived one too; nothing for a box's own save. */
export function wakeLevelOf(kind: string, args: unknown): number | undefined {
  if (kind === 'save') return undefined;
  return wakesArchived(kind, args) ? 2 : 1;
}

// An archive of a thread whose box never started.
function endsWait(kind: string, args: unknown): boolean {
  return kind === 'update' && (args as { archive?: unknown } | null)?.archive === true;
}

export function wakesArchived(kind: string, args: unknown): boolean {
  if (kind === 'update') return (args as { unarchive?: unknown } | null)?.unarchive === true;
  return ['send', 'respond', 'press', 'move'].includes(kind);
}

/**
 * The thread was archived or deleted: if it has a box, the box is deleted
 * (ARCHIVE, then boxService.ts destroyBox) after ARCHIVE_GRACE_MS, unless
 * it's back out of the archive by then.
 */
export async function archiveSoon(ctx: MutationCtx, threadId: string): Promise<void> {
  const row = await ctx.db
    .query('boxes')
    .withIndex('by_threadId', (q) => q.eq('threadId', threadId))
    .first();
  if (row && !['archiving', 'shelved', 'destroying', 'gone', 'expired'].includes(row.boxState.kind)) await ctx.scheduler.runAfter(ARCHIVE_GRACE_MS, internal.boxes.archiveIfStill, { threadId });
}
