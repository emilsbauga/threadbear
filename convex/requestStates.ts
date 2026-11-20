// A runner request's state as its state machine holds it
// (convex/requestMachine.ts, docs/lifecycles.md): one member per state, each
// with only its own data. `runnerRequests.state` stays as the five strings
// runners have always read (relay:runnerRequest) and the index uses, and
// `claim`, `result` and `decidedAt` stay on the row as they read them; the
// machine writes them from this on every move, so they never disagree.
import { v, type Infer } from 'convex/values';

export const requestStateV = v.union(
  // Filed, its card in front of Mike on the main Mac.
  v.object({ kind: v.literal('pending') }),
  // The main Mac's runner is starting it. `claim` is that runner's id for
  // the claim (API 85), absent from an older runner.
  v.object({ kind: v.literal('claimed'), claimedAt: v.number(), claim: v.optional(v.string()) }),
  // Started, where `result` on the row says.
  v.object({ kind: v.literal('allowed'), decidedAt: v.number() }),
  v.object({ kind: v.literal('denied'), decidedAt: v.number() }),
  // The asking runner gave up on it (its card expired, or was declined there).
  v.object({ kind: v.literal('closed'), decidedAt: v.number() }),
);
export type RequestState = Infer<typeof requestStateV>;
export type LegacyRequestState = RequestState['kind'];

/** A row's state from its old fields: for rows written before requestState (migrations.ts). */
export function requestStateFrom(row: { state: LegacyRequestState; createdAt: number; decidedAt?: number; claim?: string }): RequestState {
  const at = row.decidedAt ?? row.createdAt;
  switch (row.state) {
    case 'pending':
      return { kind: 'pending' };
    case 'claimed':
      return { kind: 'claimed', claimedAt: at, ...(row.claim !== undefined ? { claim: row.claim } : {}) };
    default:
      return { kind: row.state, decidedAt: at };
  }
}
