// A thread's in-memory state when it's first loaded. Split out of runner.ts
// (24 Nov 2026) so its parts under runner/ can make one without importing
// runner.ts back (mikecann-lint's no-import-cycle).
import type { Runtime } from '../runner.ts';

export function newRuntime(activeAt: number): Runtime {
  return {
    generation: 0,
    resumed: false,
    retriedFresh: false,
    tasks: [],
    finished: [],
    activeAt,
    approvals: new Map(),
    releaseWhenIdle: false,
    inProgress: new Map(),
    pendingDeltas: new Map(),
  };
}
