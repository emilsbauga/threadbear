// A pause the process didn't see: a Mac waking from sleep, or a box its
// provider paused and resumed (docs/virtual-runners.md). The process carries
// on with a websocket whose other end is long gone, and the Convex client
// only notices when the socket times out: on Fly that took 60 s, against
// 3.3 s with this (the spike's agent.ts, 16 Nov 2026). A pause shows up as
// the wall clock jumping between two ticks, so then the sync's client is
// dropped and made again at once, and a heartbeat goes straight away
// (ConvexSync.reconnectNow).
export const TICK_MS = 2_000;
export const JUMP_MS = 15_000;
// A busy machine can starve the ticks too: never more than one reconnect in
// this long, so a host under load can't make it storm.
export const MIN_GAP_MS = 30_000;

export class ClockJumpWatch {
  private last: number;
  private lastJumpAt = -Infinity;
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  private readonly onJump: (gapMs: number) => void;

  constructor(opts: { onJump: (gapMs: number) => void; now?: () => number }) {
    this.onJump = opts.onJump;
    this.now = opts.now ?? Date.now;
    this.last = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.last = this.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Never what keeps the process alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // One tick: whether it saw a jump (and said so). Public for tests.
  tick(): boolean {
    const now = this.now();
    const gap = now - this.last;
    this.last = now;
    if (gap <= JUMP_MS || now - this.lastJumpAt < MIN_GAP_MS) return false;
    this.lastJumpAt = now;
    try {
      this.onJump(gap);
    } catch {
      // A reconnect that throws is the sync's to log; the watch goes on.
    }
    return true;
  }
}
