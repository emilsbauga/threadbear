// Re-reads a login that says it has no room, so a reset done outside
// Threadbear is seen (docs/protocol/settings.md, Pools, "Rechecking a login that's
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
//
// Grok's turns carry none either: since 24 Nov 2026 its _x.ai/billing is
// read the same way (acp/grok-billing.ts), and a login never read at all is
// read once, so it shows its room before its first turn here.
//
// Gemini's turns carry no reading at all (since 23 Nov 2026): its adapter
// reads the plan's usage with antigravity-acp's own /usage, which costs
// nothing either (acp/agy-usage.ts), and says how often (limitsPollMs). So
// a Gemini login is read whenever its reading is that old, whatever its
// room, and soon after each of its turns ends, at most every
// AFTER_TURN_GAP_MS.
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
// How often a login with no reading at all is tried again when a read failed.
export const FIRST_READ_RETRY_MS = 60 * 60_000;
// After a turn on a login read by polling: a few seconds, so the plan's
// server has counted it, and never sooner than this after the last read.
export const AFTER_TURN_DELAY_MS = 5_000;
export const AFTER_TURN_GAP_MS = 2 * 60_000;
// A read lands a few seconds after its pass starts (and a pass can start late,
// behind an after-turn read), so a reading or try one pass ago is that much
// short of a whole interval: it counts as due.
const POLL_SLACK_MS = 60_000;

// Whether a login is worth reading again now: its provider can read limits
// without a turn, its last reading says it's out of room, and that reading
// (and our last try) is at least RECHECK_MS old. A signed-out login or one
// whose plan ended isn't out of room, so a read wouldn't change anything.
// One with no reading at all is read once, so a login whose turns are few
// (Grok, which Token Stats doesn't read) shows its room before its first
// turn here.
// dry: a turn ran it dry and the runner still holds it out (ranDry); then
// only our own last try counts, as a turn's readings (on another model, or
// the 402's own) keep coming and say nothing about whether it's back.
// pollMs: the provider's turns bring no reading (Gemini), so it's read when
// the last reading, or try, is that old, out of room or not.
export function dueForRecheck(account: Account, canRead: boolean, now: number, lastTried: number | undefined, o: { dry?: boolean; pollMs?: number } = {}): boolean {
  if (!canRead || account.signedOut || account.planEnded) return false;
  if (o.dry) return lastTried === undefined || now - lastTried >= RECHECK_MS - POLL_SLACK_MS;
  if (o.pollMs) {
    const readAt = account.usage ? Date.parse(account.usage.readAt) : NaN;
    if (Number.isFinite(readAt) && now - readAt < o.pollMs - POLL_SLACK_MS) return false;
    return lastTried === undefined || now - lastTried >= o.pollMs - POLL_SLACK_MS;
  }
  // Tried again hourly if that read failed (offline at start, say).
  if (!account.usage) return lastTried === undefined || now - lastTried >= FIRST_READ_RETRY_MS;
  const room = accountRoom(account);
  const out = !!account.usage.blocked || (room !== undefined && room < MIN_ROOM_PERCENT);
  if (!out) return false;
  const readAt = Date.parse(account.usage.readAt);
  if (Number.isFinite(readAt) && now - readAt < RECHECK_MS - POLL_SLACK_MS) return false;
  return lastTried === undefined || now - lastTried >= RECHECK_MS - POLL_SLACK_MS;
}

export type LimitRecheckDeps = {
  clock: Clock;
  log: Logger;
  accounts: () => Account[];
  adapters: Record<string, AgentAdapter>;
  record: (accountId: string, reading: UsageReading) => void;
  // Whether the runner holds a login out after a turn ran it dry.
  dry?: (accountId: string) => boolean;
};

export class LimitRecheck {
  private timer?: TimerHandle;
  private tried = new Map<string, number>();
  private running = false;
  private stopped = false;
  // Logins to read soon because a turn on them just ended (afterTurn).
  // Each with when its turn ended plus AFTER_TURN_DELAY_MS: a pass before
  // then reads it as any other, and its after-turn read still follows.
  private wanted = new Map<string, number>();
  private again = false;
  private soonTimer?: TimerHandle;
  private soonAt = 0;

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
    this.soonTimer?.cancel();
  }

  // A turn on this login ended: read it soon if its provider is read by
  // polling (limitsPollMs), as the turn will have used some of the plan.
  afterTurn(accountId: string): void {
    if (this.stopped) return;
    const account = this.deps.accounts().find((a) => a.id === accountId);
    const adapter = account ? this.deps.adapters[account.provider] : undefined;
    if (!adapter?.limitsPollMs || !adapter.readLimits) return;
    const at = this.deps.clock.now() + AFTER_TURN_DELAY_MS;
    this.wanted.set(accountId, Math.max(at, this.wanted.get(accountId) ?? 0));
    this.soonFor(accountId);
  }

  private soonFor(accountId: string): void {
    const tried = this.tried.get(accountId);
    this.soon(Math.max(this.wanted.get(accountId) ?? this.deps.clock.now(), tried !== undefined ? tried + AFTER_TURN_GAP_MS : 0));
  }

  private soon(at: number): void {
    if (this.stopped) return;
    if (this.soonTimer && this.soonAt <= at) return;
    this.soonTimer?.cancel();
    this.soonAt = at;
    this.soonTimer = this.deps.clock.setTimeout(() => {
      this.soonTimer = undefined;
      void this.tick();
    }, Math.max(0, at - this.deps.clock.now()));
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer?.cancel();
    this.timer = this.deps.clock.setTimeout(() => void this.tick().finally(() => this.schedule(RECHECK_MS)), ms);
  }

  // One pass: each due login in turn, one read at a time.
  async tick(): Promise<void> {
    if (this.stopped) return;
    // A pass already out (an after-turn read, say): another follows it, so
    // a regular pass that came round meanwhile isn't put off a whole
    // RECHECK_MS (Gemini's review, 23 Nov 2026).
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      for (const account of this.deps.accounts()) {
        // stop() mid-pass: start no more Codex processes.
        if (this.stopped) break;
        const adapter = this.deps.adapters[account.provider];
        const now = this.deps.clock.now();
        const tried = this.tried.get(account.id);
        const polled = !!adapter?.limitsPollMs;
        // Signed out, or its plan ended, since the turn: nothing to read.
        if (!polled || !adapter?.readLimits || account.signedOut || account.planEnded) this.wanted.delete(account.id);
        const eligible = this.wanted.get(account.id);
        const afterTurn = polled && eligible !== undefined && now >= eligible && (tried === undefined || now - tried >= AFTER_TURN_GAP_MS);
        const dry = this.deps.dry?.(account.id) ?? false;
        if (!afterTurn && !dueForRecheck(account, !!adapter?.readLimits, now, tried, { dry, ...(adapter?.limitsPollMs ? { pollMs: adapter.limitsPollMs } : {}) })) continue;
        if (!adapter?.readLimits) continue;
        // A turn that ended only just now still gets its read after this one.
        if (eligible !== undefined && now >= eligible) this.wanted.delete(account.id);
        this.tried.set(account.id, now);
        const before = account.usage?.readAt;
        try {
          const l = await this.withDeadline(adapter.readLimits(account));
          if (this.stopped) break;
          if (!l) continue;
          // A turn's reading or a reset's that landed while this one was
          // out is newer than what it saw: keep that, drop this.
          const current = this.deps.accounts().find((a) => a.id === account.id);
          // Gone, signed out or ended meanwhile: nothing to record for it.
          if (!current || current.signedOut || current.planEnded || current.usage?.readAt !== before) continue;
          this.deps.record(account.id, {
            windows: l.windows,
            ...(l.blocked !== undefined ? { blocked: l.blocked } : {}),
            ...(l.plan ? { plan: l.plan } : {}),
            ...(l.resets ? { resets: l.resets } : {}),
            ...(l.aside ? { aside: l.aside } : {}),
          });
          if (polled) this.deps.log.debug("read a login's plan usage", { accountId: account.id, windows: l.windows.length });
          else this.deps.log.info(before === undefined ? "read a login's limits for the first time" : 'read a login that was out of room again', { accountId: account.id, blocked: l.blocked ?? null });
        } catch (e) {
          this.deps.log.warn("couldn't read a login's limits again", { accountId: account.id, error: String(e) });
        }
      }
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.soon(this.deps.clock.now());
      }
      // A turn that ended mid-pass, or too soon after the last read: its
      // read comes when it may.
      for (const id of this.wanted.keys()) {
        if (this.deps.accounts().some((a) => a.id === id)) this.soonFor(id);
        else this.wanted.delete(id);
      }
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
