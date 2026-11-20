// Whether this runner has a Threadbear app of its own: one connected now,
// or one that was in the last APP_SEEN_DAYS. A card only an app connected
// straight to the runner can allow (tools.ts, remoteCardShowsAll) is put up
// only then. On a runner nobody runs an app on (the Dell XPS on Windows,
// Bruce, the cloud box) such a card could only ever be denied, so the call
// is refused at once and the agent is told what to do instead (Mike, 18 Nov
// 2026: "What's the point in having this box if the only option is to
// deny?").
//
// Kept in <home>/app-seen.json, so a runner that has just restarted (an
// update, a handover's draining runner) still knows its app is about to
// come back.
import path from 'node:path';
import { atomicWriteFileSync, readJsonSync } from './fsutil.ts';

export const APP_SEEN_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;
// Written at most this often while an app comes and goes.
const WRITE_EVERY_MS = 60 * 60_000;

export class AppSeen {
  private last: number | undefined;
  private written: number | undefined;
  private file: string;
  private now: () => number;

  constructor(home: string, now: () => number) {
    this.now = now;
    this.file = path.join(home, 'app-seen.json');
    this.read();
  }

  private read(): void {
    const at = readJsonSync<{ at?: unknown }>(this.file)?.at;
    if (typeof at === 'number' && Number.isFinite(at) && (this.last === undefined || at > this.last)) this.last = this.written = at;
  }

  /** An app said hello, or went: it was here now. */
  mark(): void {
    const now = this.now();
    this.last = now;
    if (this.written !== undefined && now - this.written < WRITE_EVERY_MS) return;
    try {
      atomicWriteFileSync(this.file, JSON.stringify({ at: now }));
      this.written = now;
    } catch {
      // Kept in memory; tried again on the next hello.
    }
  }

  /** Whether an app was here in the last APP_SEEN_DAYS. */
  recently(): boolean {
    const recent = () => this.last !== undefined && this.now() - this.last < APP_SEEN_DAYS * DAY_MS;
    if (recent()) return true;
    // Another process may have seen one since: a draining runner's app now
    // connects to the release that took over, which writes the file
    // (Codex's review, 18 Nov 2026). Read only when it would say no.
    this.read();
    return recent();
  }
}

// What the agent is told when a call needs such a card on a runner with no
// app (`what`: the reason the card would have given). Not "switch to Full
// access": the phone and other Macs can't change a thread's mode either.
export function noAppToAllow(what: string, runnerName?: string): string {
  const where = runnerName ? ` (${runnerName})` : '';
  return `Not done: ${what}. That needs the user's OK on a card that only a Threadbear app connected straight to this runner${where} can allow, and none has connected lately (the phone and other Macs can only deny such a card), so no card was put up and nothing changed. Do it a way that doesn't need the OK; if there isn't one, tell the user it needs a Threadbear app on this runner.`;
}
