// A command's state as its state machine holds it (convex/commandMachine.ts,
// docs/lifecycles.md): one member per state, each with only its own data.
// `commands.state` stays as the four strings clients have always read
// (phone:command, phone:waiting, relay:commandState) and the indexes use;
// the machine writes it from this on every move, so the two never disagree.
import { v, type Infer } from 'convex/values';

export const commandStateV = v.union(
  // Waiting for its runner to take it.
  v.object({ kind: v.literal('pending') }),
  // Its runner has it. `attempt` is the runner's id for the take (API 84).
  v.object({ kind: v.literal('taken'), takenAt: v.number(), attempt: v.optional(v.string()) }),
  // Its runner says it worked.
  v.object({ kind: v.literal('done'), doneAt: v.number() }),
  // It didn't happen, or didn't work: its runner said so, the phone took it
  // back, nobody took it in time, or its thread moved or went.
  v.object({ kind: v.literal('failed'), doneAt: v.number() }),
  // Its runner took it and never said how it went within the lease. Shown
  // as failed; its runner's late answer still settles it.
  v.object({ kind: v.literal('lapsed'), doneAt: v.number(), lapsedAt: v.number() }),
);
export type CommandState = Infer<typeof commandStateV>;
export type LegacyCommandState = 'pending' | 'taken' | 'done' | 'failed';

/** The string clients read for a state. */
export function legacyState(s: CommandState): LegacyCommandState {
  return s.kind === 'lapsed' ? 'failed' : s.kind;
}

/** A row's state from its old fields: for rows written before commandState (migrations.ts). */
export function commandStateFrom(row: { state: LegacyCommandState; createdAt: number; takenAt?: number; doneAt?: number; attempt?: string; lapsedAt?: number }): CommandState {
  switch (row.state) {
    case 'pending':
      return { kind: 'pending' };
    case 'taken':
      return { kind: 'taken', takenAt: row.takenAt ?? row.createdAt, ...(row.attempt !== undefined ? { attempt: row.attempt } : {}) };
    case 'done':
      return { kind: 'done', doneAt: row.doneAt ?? row.createdAt };
    case 'failed':
      return row.lapsedAt !== undefined ? { kind: 'lapsed', doneAt: row.doneAt ?? row.lapsedAt, lapsedAt: row.lapsedAt } : { kind: 'failed', doneAt: row.doneAt ?? row.createdAt };
  }
}
