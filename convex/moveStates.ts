// A move's state as its state machine holds it (convex/moveMachine.ts,
// docs/lifecycles.md): one member per state, each with only its own data.
// `threadMoves.state` stays as the eight strings runners have always read
// (moves:moves) and the indexes use; the machine writes it from this on
// every move, so the two never disagree.
//
// Every deadline is a time in the state's data, so a row the backfill
// (migrations.ts) brings over keeps the deadline it had, and the timer that
// sends it is armed for that time (moves.ts expireMoves, armTimers).
import { v, type Infer } from 'convex/values';

// How long each step may take (moves.ts says why each is what it is).
export const MOVE_ASK_MS = 10 * 60_000;
export const MOVE_FROZEN_MS = 30 * 60_000;
export const MOVE_READY_MS = 12 * 60 * 60_000;

export const moveStateV = v.union(
  // The runner taking it (T) hasn't said it can yet. `askBy` moves on when
  // the runner that has it (S) describes the thread.
  v.object({ kind: v.literal('asking'), askBy: v.number() }),
  // T can take it; S freezes the thread once its turn is over.
  v.object({ kind: v.literal('ready'), readyAt: v.number(), giveUpAt: v.number() }),
  // S has frozen the thread and is packing it.
  v.object({ kind: v.literal('packing'), frozenAt: v.number(), giveUpAt: v.number() }),
  // S has uploaded it; T is unpacking it.
  v.object({ kind: v.literal('unpacking'), frozenAt: v.number(), giveUpAt: v.number() }),
  // T has the thread. Its rows are still going over to T, and `doneAsked`
  // says T has already said it's running it.
  v.object({ kind: v.literal('claimed'), claimedAt: v.number(), doneAsked: v.boolean() }),
  // Every row has gone to T; waiting for T to say it's running it.
  v.object({ kind: v.literal('handedOver'), claimedAt: v.number(), rehomedAt: v.number() }),
  v.object({ kind: v.literal('done'), endedAt: v.number() }),
  v.object({ kind: v.literal('failed'), endedAt: v.number() }),
  v.object({ kind: v.literal('cancelled'), endedAt: v.number() }),
);
export type MoveState = Infer<typeof moveStateV>;
export type LegacyMoveState = 'asking' | 'ready' | 'packing' | 'unpacking' | 'claimed' | 'done' | 'failed' | 'cancelled';

/** The string runners read for a state. */
export function legacyMoveState(s: MoveState): LegacyMoveState {
  return s.kind === 'handedOver' ? 'claimed' : s.kind;
}

/** A row's state from its old fields: for rows written before moveState (migrations.ts). */
export function moveStateFrom(row: { state: LegacyMoveState; createdAt: number; updatedAt: number; frozenAt?: number; rehomedAt?: number; doneAsked?: boolean }): MoveState {
  switch (row.state) {
    case 'asking':
      return { kind: 'asking', askBy: row.updatedAt + MOVE_ASK_MS };
    case 'ready':
      return { kind: 'ready', readyAt: row.updatedAt, giveUpAt: row.updatedAt + MOVE_READY_MS };
    case 'packing':
    case 'unpacking': {
      const frozenAt = row.frozenAt ?? row.updatedAt;
      return { kind: row.state, frozenAt, giveUpAt: frozenAt + MOVE_FROZEN_MS };
    }
    case 'claimed':
      // A claimed row's updatedAt is when it was claimed, or when T said done.
      return row.rehomedAt !== undefined ? { kind: 'handedOver', claimedAt: row.updatedAt, rehomedAt: row.rehomedAt } : { kind: 'claimed', claimedAt: row.updatedAt, doneAsked: row.doneAsked === true };
    default:
      return { kind: row.state, endedAt: row.updatedAt };
  }
}
