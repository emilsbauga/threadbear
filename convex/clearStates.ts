// A thread id's clear as its state machine holds it (convex/clearMachine.ts,
// docs/lifecycles.md): one member per state, each with only its own data.
// While a `threadClears` row exists the id is closed (sync.ts closedId):
// nothing is written under it.
import { v, type Infer } from 'convex/values';

// A clear no run has moved on for this long has its rows' runs started
// again (a run threw, or its scheduled job was lost).
export const CLEAR_RETRY_MS = 10 * 60_000;

export const clearStateV = v.union(
  // Its old rows going, a run at a time. `moving`: it's for the owner's
  // takeover of the thread. `retryAt`: when its runs start again if none
  // has moved it on by then.
  v.object({ kind: v.literal('clearing'), moving: v.boolean(), retryAt: v.number() }),
  // All gone, for a takeover: the id stays closed to its old runner until
  // the owner's next write of the thread goes through.
  v.object({ kind: v.literal('awaitingOwner') }),
  // Done with: the row is deleted in the same mutation.
  v.object({ kind: v.literal('cleared') }),
);
export type ClearState = Infer<typeof clearStateV>;

/** A row's state from its old fields: for rows written before clearState (migrations.ts). */
export function clearStateFrom(row: { moving?: boolean; done?: boolean }, now: number): ClearState {
  return row.done ? { kind: 'awaitingOwner' } : { kind: 'clearing', moving: row.moving === true, retryAt: now };
}
