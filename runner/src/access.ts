// How much one permission mode allows next to another, and the ceilings
// that hold words written by a thread with less access. Its own file so
// the ceiling checks (runner/ceiling.ts), the MCP server and the app
// restart queue can share them without importing each other
// (mikecann-lint's no-import-cycle).
import type { PermissionMode } from './protocol.ts';
import { isPermissionMode } from './protocol.ts';

// Permission modes by how much an agent may do in them without asking.
// Plan first ranks with ask: its agent changes nothing, and only Mike's
// approval takes it out of plan mode.
const ACCESS: Record<PermissionMode, number> = { ask: 0, plan: 0, auto: 1, full: 2 };

export const raises = (to: PermissionMode, from: PermissionMode): boolean => ACCESS[to] > ACCESS[from];

// What a thread's agent can do: its mode.
export type Authority = { mode: PermissionMode };

// The least there is, below even Ask and Plan, by this very object: a
// thread that isn't here (on another runner of this Mac's), or one an older
// release ran shut in the sandbox (ThreadRecord.confined), whose words are
// never passed up on a guess (hibernation.ts).
export const LEAST: Authority = Object.freeze({ mode: 'ask' as const });

// More than the caller has: a higher mode, or anything at all over LEAST.
export const above = (t: Authority, caller: Authority): boolean => (caller === LEAST && t !== LEAST) || raises(t.mode, caller.mode);

// What a draining runner says when a schedule's run is for a thread above
// its ceiling there (handover.ts, drain.sendScheduled; schedules.ts).
export const CEILING_REFUSED = 'Not sent: this thread has more access now than the thread that set the schedule up had.';

// A ceiling as saved: one that isn't a mode (a record from before, a moved
// thread's record from another Mac) counts as the least, Ask.
export function ceilingMode(v: unknown): PermissionMode {
  return isPermissionMode(v) ? (v === 'plan' ? 'ask' : v) : 'ask';
}

// The more of two modes.
export function higherMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return raises(a, b) ? a : b;
}

// The less of two modes.
export function lowerMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return raises(a, b) ? b : a;
}
