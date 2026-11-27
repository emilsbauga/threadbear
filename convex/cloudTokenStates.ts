// A login's cloud token as its state machine holds it (convex/cloudTokenMachine.ts,
// docs/virtual-runners.md decision 10, docs/lifecycles.md). No row is a
// login with none.
import { v, type Infer } from 'convex/values';

export const tokenStateV = v.union(
  // Owner-set shared token; box refusals affect their grants only.
  v.object({ kind: v.literal('valid') }),
  // Legacy state from older backends that accepted login-wide box reports.
  // Kept until the owner sets a replacement; new reports cannot enter it.
  v.object({ kind: v.literal('dead'), at: v.number() }),
);
export type TokenState = Infer<typeof tokenStateV>;
