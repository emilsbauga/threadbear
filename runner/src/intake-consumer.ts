import type { AttachmentRef } from './protocol.ts';
import crypto from 'node:crypto';
import type { Clock, TimerHandle } from './clock.ts';
import { intakeThreadId, type IntakeRecord } from './intake-record.ts';

type Deps = {
  clock: Clock; runnerId: string; enabled(): boolean;
  post(kind: 'query' | 'mutation', fn: string, args: Record<string, unknown>): Promise<unknown>;
  importDraft(item: IntakeRecord, files?: AttachmentRef[]): string;
  supportsFiles?(): boolean;
  prepareFiles?(item: IntakeRecord, leaseToken: string, signal: AbortSignal): Promise<AttachmentRef[]>;
  failed(receiptId?: string): void;
};
export class IntakeConsumer {
  private running = false;
  private timer?: TimerHandle;
  private inFlight?: Promise<void>;
  private abort?: AbortController;
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
    this.abort?.abort();
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
      const items = await this.deps.post('query', 'intakeConsumer:pendingIntake', { ...args, ...(this.deps.supportsFiles?.() ? { includeAttachments: true } : {}) }) as IntakeRecord[];
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
          let files: AttachmentRef[] | undefined;
          if (item.attachments?.length) {
            if (!this.deps.prepareFiles) throw new Error('Attachment transport unavailable');
            const abort = new AbortController(); this.abort = abort;
            let renewal: TimerHandle | undefined, renewing: Promise<void> | undefined, done = false;
            const renew = () => { renewal = this.deps.clock.setTimeout(() => {
              renewing = (async () => {
                try {
                  const renewed = await this.deps.post('mutation', 'intakeConsumer:claimIntake', claim) as { state: string };
                  if (renewed.state !== 'claimed' || this.stopped || !this.deps.enabled()) throw new Error('Lease lost');
                  if (!done) renew();
                } catch { abort.abort(); }
              })();
            }, 20_000); };
            renew();
            try { files = await this.deps.prepareFiles(item, claim.leaseToken, abort.signal); abort.signal.throwIfAborted(); }
            finally { done = true; renewal?.cancel(); await renewing; this.abort = undefined; }
            abort.signal.throwIfAborted();
          }
          if (this.stopped || !this.deps.enabled()) return;
          const threadId = this.deps.importDraft(item, files);
          if (threadId !== expected) throw new Error('Intake draft identity mismatch');
          if (!await this.deps.post('mutation', 'intakeConsumer:finishIntake', claim)) throw new Error('Intake completion not confirmed');
        } catch { failed = true; this.reportFailure(item.receiptId); }
      }
      if (!failed) this.warned = false;
    } catch { this.reportFailure(); }
  }
  private reportFailure(receiptId?: string): void {
    if (!this.warned) this.deps.failed(receiptId);
    this.warned = true;
  }
}
