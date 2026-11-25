// How much of its plan a Grok login has left, from Grok's own ACP extension
// `_x.ai/billing` (Grok 1.0.92). It needs no session and costs nothing: Grok
// asks its billing service and answers in about 300 ms. `grok usage` on the
// command line can't show it (it needs Grok's background service), but this
// can, so Grok logins get readings like Claude's and Codex's (usage.ts).
//
// Its answer, as seen on 24 Nov 2026 (values are examples):
//   { config: { creditUsagePercent: 100,
//               currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end },
//               billingPeriodStart, billingPeriodEnd,
//               prepaidBalance: { val: 0 }, onDemandCap: { val: 0 }, onDemandUsed: { val: 0 },
//               isUnifiedBillingUser: true },
//     subscription_tier: "X Premium+" }
// Only the share used, the period's end and kind, whether money beyond the
// plan is there, and the tier are read.
import type { UsageWindow, UsageWindowKind } from '../../protocol.ts';
import type { AdapterOutput } from '../types.ts';
import { isPlainObject } from './normalize.ts';
import { MIN_ROOM_PERCENT } from '../../usage.ts';

export const GROK_BILLING_METHOD = '_x.ai/billing';
// The detail of a used-up plan's window while a balance keeps it going: the
// runner takes it as room after a run-dry (Runner.recordReading).
export const FUNDED_DETAIL = 'Plan used up, running on prepaid or on-demand balance';

type Limits = Extract<AdapterOutput, { kind: 'limits' }>;

const PERIODS: Record<string, { kind: UsageWindowKind; title: string }> = {
  USAGE_PERIOD_TYPE_WEEKLY: { kind: 'weekly', title: 'Weekly' },
  USAGE_PERIOD_TYPE_MONTHLY: { kind: 'monthly', title: 'Monthly' },
  USAGE_PERIOD_TYPE_DAILY: { kind: 'daily', title: 'Daily' },
};

function amount(v: unknown): number {
  const n = isPlainObject(v) ? v.val : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function iso(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// The reading `_x.ai/billing` gives, or undefined for an answer without a
// share used (a team's plan, "Usage limits are managed by your team", or a
// shape this doesn't know).
export function grokLimits(result: unknown): Limits | undefined {
  if (!isPlainObject(result) || !isPlainObject(result.config)) return undefined;
  const c = result.config;
  const used = c.creditUsagePercent;
  if (typeof used !== 'number' || !Number.isFinite(used)) return undefined;
  const period = isPlainObject(c.currentPeriod) ? c.currentPeriod : {};
  const shape = PERIODS[String(period.type ?? '')] ?? { kind: 'other' as const, title: 'Plan' };
  const window: UsageWindow = { kind: shape.kind, title: shape.title, remainingPercent: Math.max(0, Math.min(100, 100 - used)) };
  const resetsAt = iso(period.end) ?? iso(c.billingPeriodEnd);
  if (resetsAt) window.resetsAt = resetsAt;
  // A prepaid balance, or room under an on-demand cap, keeps a login going
  // past its plan's share, so the share running out isn't a block. Nothing
  // here says how much that money buys, so the window reads the least room
  // pools still use (MIN_ROOM_PERCENT) rather than 0%, which they'd pass
  // over until the reset, and its detail says why.
  const extra = amount(c.prepaidBalance) > 0 || amount(c.onDemandCap) > amount(c.onDemandUsed);
  if (extra && window.remainingPercent < MIN_ROOM_PERCENT) {
    window.remainingPercent = MIN_ROOM_PERCENT;
    window.detail = FUNDED_DETAIL;
  }
  const out: Limits = { kind: 'limits', windows: [window], blocked: window.remainingPercent < MIN_ROOM_PERCENT };
  if (typeof result.subscription_tier === 'string' && result.subscription_tier.trim()) out.plan = result.subscription_tier.trim();
  return out;
}
