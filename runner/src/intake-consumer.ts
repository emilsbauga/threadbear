import crypto from 'node:crypto';
import type { Clock, TimerHandle } from './clock.ts';
import { intakeThreadId, type IntakeRecord } from './intake-record.ts';

type Deps = {
  clock: Clock; runnerId: string; enabled(): boolean;
  post(kind: 'query' | 'mutation', fn: string, args: Record<string, unknown>): Promise<unknown>;
  importDraft(item: IntakeRecord): string;
  failed(): void;
};
export class IntakeConsumer {
  private running = false;
  private timer?: TimerHandle;
  private inFlight?: Promise<void>;
  private warned = false;
  private stopped = false;
  private deps: Deps;
  constructor(deps: Deps) { this.deps = deps; }
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    void this.loop();
  }
  async stop(): Promise<void> {
    this.running = false;
    this.stopped = true;
    this.timer?.cancel();
    await this.inFlight;
  }
  private async loop(): Promise<void> {
    await this.poll();
    if (this.running) this.timer = this.deps.clock.setTimeout(() => { void this.loop(); }, 15_000);
  }
  poll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.consume().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }
  private async consume(): Promise<void> {
    if (this.stopped || !this.deps.enabled()) return;
    const args = { runnerId: this.deps.runnerId };
    try {
      const items = await this.deps.post('query', 'intakeConsumer:pendingIntake', args) as IntakeRecord[];
      let failed = false;
      for (const item of items) {
        if (this.stopped || !this.deps.enabled()) return;
        try {
          const claim = { ...args, receiptId: item.receiptId, leaseToken: crypto.randomBytes(16).toString('hex') };
          const taken = await this.deps.post('mutation', 'intakeConsumer:claimIntake', claim) as { state: string; threadId?: string };
          if (this.stopped || !this.deps.enabled()) return;
          if (taken.state !== 'claimed') continue;
          const expected = intakeThreadId(item.clientId, item.receiptId);
          if (taken.threadId !== expected) throw new Error('Intake identity mismatch');
          const threadId = this.deps.importDraft(item);
          if (threadId !== expected) throw new Error('Intake draft identity mismatch');
          if (!await this.deps.post('mutation', 'intakeConsumer:finishIntake', claim)) throw new Error('Intake completion not confirmed');
        } catch { failed = true; this.reportFailure(); }
      }
      if (!failed) this.warned = false;
    } catch { this.reportFailure(); }
  }
  private reportFailure(): void {
    if (!this.warned) this.deps.failed();
    this.warned = true;
  }
}
