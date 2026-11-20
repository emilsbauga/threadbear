// Re-reads a login that says it has no room, so a reset done outside
// Threadbear is seen (docs/protocol.md, Pools, "Rechecking a login that's
// out").
//
// Codex readings only ever came from Threadbear's own Codex turns and its
// Use a reset button. A login that read 0% was skipped by every pool, so no
// turn ran on it, so its reading never changed until the reset time it
// named: on 17 Nov 2026 Mike's codex-main still showed "Used up, back
// tomorrow" a day after he'd used a reset in Codex, while Codex itself ran
// four reviews on it that morning. A read of a login's limits costs nothing
// (Codex's account/rateLimits/read, in a short-lived app-server), so every
// RECHECK_MS each login that reads as out gets one, and its answer goes into
// the usage store like a turn's: room lifts the block, and threads waiting
// for room carry on by themselves.
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import type { Account } from './protocol.ts';
import type { AgentAdapter } from './adapters/types.ts';
import type { UsageReading } from './usage.ts';
import { accountRoom, MIN_ROOM_PERCENT } from './usage.ts';

export const RECHECK_MS = 10 * 60_000;
// How long one read may take before the pass moves on (limit-recheck's
// backstop; Codex's own read gives up at 30 seconds and closes its process).
export const READ_DEADLINE_MS = 60_000;
// The first look after the runner starts: soon, but not in the startup rush.
export const FIRST_RECHECK_MS = 60_000;

// Whether a login is worth reading again now: its provider can read limits
// without a turn, its last reading says it's out of room, and that reading
// (and our last try) is at least RECHECK_MS old. A signed-out login or one
// whose plan ended isn't out of room, so a read wouldn't change anything.
export function dueForRecheck(account: Account, canRead: boolean, now: number, lastTried: number | undefined): boolean {
  if (!canRead || !account.usage || account.signedOut || account.planEnded) return false;
  const room = accountRoom(account);
  const out = !!account.usage.blocked || (room !== undefined && room < MIN_ROOM_PERCENT);
  if (!out) return false;
  const readAt = Date.parse(account.usage.readAt);
  if (Number.isFinite(readAt) && now - readAt < RECHECK_MS) return false;
  return lastTried === undefined || now - lastTried >= RECHECK_MS;
}

export type LimitRecheckDeps = {
  clock: Clock;
  log: Logger;
  accounts: () => Account[];
  adapters: Record<string, AgentAdapter>;
  record: (accountId: string, reading: UsageReading) => void;
};

export class LimitRecheck {
  private timer?: TimerHandle;
  private tried = new Map<string, number>();
  private running = false;
  private stopped = false;

  private deps: LimitRecheckDeps;
  constructor(deps: LimitRecheckDeps) {
    this.deps = deps;
  }

  start(): void {
    this.schedule(FIRST_RECHECK_MS);
  }

  stop(): void {
    this.stopped = true;
    this.timer?.cancel();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer?.cancel();
    this.timer = this.deps.clock.setTimeout(() => void this.tick().finally(() => this.schedule(RECHECK_MS)), ms);
  }

  // One pass: each due login in turn, one read at a time.
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (const account of this.deps.accounts()) {
        // stop() mid-pass: start no more Codex processes.
        if (this.stopped) break;
        const adapter = this.deps.adapters[account.provider];
        const now = this.deps.clock.now();
        if (!dueForRecheck(account, !!adapter?.readLimits, now, this.tried.get(account.id))) continue;
        this.tried.set(account.id, now);
        const before = account.usage?.readAt;
        try {
          const l = await this.withDeadline(adapter!.readLimits!(account));
          if (this.stopped) break;
          if (!l) continue;
          // A turn's reading or a reset's that landed while this one was
          // out is newer than what it saw: keep that, drop this.
          const current = this.deps.accounts().find((a) => a.id === account.id);
          if (current?.usage?.readAt !== before) continue;
          this.deps.record(account.id, {
            windows: l.windows,
            ...(l.blocked !== undefined ? { blocked: l.blocked } : {}),
            ...(l.plan ? { plan: l.plan } : {}),
            ...(l.resets ? { resets: l.resets } : {}),
          });
          this.deps.log.info('read a login that was out of room again', { accountId: account.id, blocked: l.blocked ?? null });
        } catch (e) {
          this.deps.log.warn("couldn't read a login's limits again", { accountId: account.id, error: String(e) });
        }
      }
    } finally {
      this.running = false;
    }
  }

  // The adapter has its own deadline (and closes its process at it); this
  // one only makes sure a pass always ends, so the next is scheduled.
  private withDeadline<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = this.deps.clock.setTimeout(() => reject(new Error('the read took too long')), READ_DEADLINE_MS);
      p.then(
        (v) => (t.cancel(), resolve(v)),
        (e) => (t.cancel(), reject(e)),
      );
    });
  }
}
