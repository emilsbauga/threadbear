// A login's cloud token as its state machine holds it (convex/cloudTokenMachine.ts,
// docs/virtual-runners.md decision 10, docs/lifecycles.md). No row is a
// login with none.
import { v, type Infer } from 'convex/values';

export const tokenStateV = v.union(
  // Set, and no box's turn on it has been refused since.
  v.object({ kind: v.literal('valid') }),
  // A box's turn on it was refused (a 401: revoked, or past its year).
  // `at`: when. Boxes waiting on the login wait for a new one.
  v.object({ kind: v.literal('dead'), at: v.number() }),
);
export type TokenState = Infer<typeof tokenStateV>;
