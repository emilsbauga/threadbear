// Stop pressed on a thread, kept outside the thread's page: the page is made
// again when Mike opens another thread and comes back, and its Stop started
// idle, so a second press sent a second interrupt while the turn ran on
// (Codex's review, 23 Nov). Each hold ends STOP_HOLD_MS after the press or the
// runner's done, or when the turn is over (release). No React here, so the
// tests can run it bare.
import { STOP_HOLD_MS } from './command.ts';

const holds = new Map<string, number>();

export function holdStop(threadId: string, now: number, ms = STOP_HOLD_MS): void {
  holds.set(threadId, now + ms);
}

// How long the thread's Stop stays held from now, or 0.
export function stopHeldFor(threadId: string, now: number): number {
  const until = holds.get(threadId);
  if (until === undefined) return 0;
  if (until <= now) {
    holds.delete(threadId);
    return 0;
  }
  return until - now;
}

export function releaseStop(threadId: string): void {
  holds.delete(threadId);
}
