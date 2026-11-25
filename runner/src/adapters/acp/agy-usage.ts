// How much of a Google AI plan is left, from antigravity-acp's own `/usage`
// (docs/protocol/settings.md, Accounts, "Gemini's plan usage"). The server
// answers that command itself, in its ACP layer: no model turn, no quota.
// Threadbear never reads the login's token, so this is the only way in.
//
// Its answer is markdown for people, not a contract, so anything that doesn't
// read as expected is left out, and an answer with no Gemini windows in it is
// no reading at all. 1.4.5 (23 Nov 2026) answers:
//
//   ### Quota Limits
//   - **Gemini Models**
//     *(Models within this group: Gemini 4 Neon, ...)*
//     - **Weekly Limit Remaining:** 55% remaining (resets Nov 28, 2026, 08:49 UTC)
//     - **Five Hour Limit Remaining:** 91% remaining (resets Nov 23, 2026, 09:35 UTC)
//   - **Claude and GPT models**
//     ...
//
// The Gemini group's two windows are the login's 5-hour and weekly ones, the
// two that decide its room. Any other group's (Claude and GPT, which Gemini
// threads never use) are kept as extra windows that never decide it: its week
// as a model's own week, with a meter of its own like Claude's Weekly Fable,
// and its 5 hours as a quiet line.
import type { UsageWindow } from '../../protocol.ts';
import type { AdapterOutput } from '../types.ts';

// blocked is left out when it can't be told: only one of the two Gemini
// windows read, and it has room (the other might be the one at its limit).
// aside: the other groups' windows' titles, which never decide it.
export type AgyUsage = { windows: UsageWindow[]; blocked?: boolean; aside?: string[] };

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "Nov 28, 2026, 08:49 UTC" (or GMT, or Z). Only a time it says is UTC: one
// in another zone, or none, would be guessed wrong by hours.
export function agyResetTime(text: string): string | undefined {
  const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(UTC|GMT|Z)\s*$/i.exec(text.trim());
  if (!m) return undefined;
  const month = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase());
  const [day, year, hour, minute, second] = [m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number) as [number, number, number, number, number];
  if (month < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
  const t = Date.UTC(year, month, day, hour, minute, second);
  // Date.UTC rolls 31 Nov over into December: a date that doesn't exist isn't one.
  if (new Date(t).getUTCDate() !== day) return undefined;
  return new Date(t).toISOString();
}

// A group's name without "models": "Claude and GPT models" is "Claude and GPT".
function groupName(header: string): string {
  return header.replace(/\s+models?\s*$/i, '').trim() || header.trim();
}

// One window line: "**Weekly Limit Remaining:** 55% remaining (resets ...)".
// "used" instead of "remaining" is turned round.
const WINDOW_LINE = /^\s*[-*]\s+\*\*\s*(weekly|five[\s-]*hours?|5[\s-]*hours?|5h)\b[^*]*\*\*\s*(\d+(?:\.\d+)?)\s*%\s*(remaining|left|used)\b(?:[^(]*\(\s*resets?\s+([^)]*)\))?/i;
// A group's header: a bullet at the start of the line whose whole text is
// bold, "- **Gemini Models**", with or without a colon. Indented ones are
// lines inside a group.
const GROUP_LINE = /^[-*]\s+\*\*\s*([^*:]+?)\s*:?\s*\*\*\s*:?\s*$/;
// A bullet at the start of the line that isn't a header or a window: the
// group before it has ended (its windows are indented under it).
const TOP_BULLET = /^[-*]\s/;

type Found = { span: 'weekly' | 'five_hour'; remaining: number; resetsAt?: string };

export function parseAgyUsage(text: string): AgyUsage | undefined {
  if (typeof text !== 'string' || !text) return undefined;
  const groups: { name: string; windows: Found[] }[] = [];
  let group: { name: string; windows: Found[] } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const g = GROUP_LINE.exec(line);
    if (g) {
      group = { name: g[1]!, windows: [] };
      groups.push(group);
      continue;
    }
    if (/^\s*#/.test(line)) {
      // A new section (### Session Usage): its lines belong to no group.
      group = undefined;
      continue;
    }
    const w = WINDOW_LINE.exec(line);
    if (!w) {
      if (TOP_BULLET.test(line)) group = undefined;
      continue;
    }
    if (!group) continue;
    const span = /^w/i.test(w[1]!) ? 'weekly' : 'five_hour';
    const n = Number(w[2]);
    if (!Number.isFinite(n) || n < 0 || n > 100) continue;
    const remaining = /used/i.test(w[3]!) ? 100 - n : n;
    // One of each per group: a second would mean the format has changed
    // in a way this can't follow.
    if (group.windows.some((x) => x.span === span)) continue;
    const resetsAt = w[4] ? agyResetTime(w[4]) : undefined;
    group.windows.push({ span, remaining, ...(resetsAt ? { resetsAt } : {}) });
  }
  // Exactly one group of Gemini models, or which decides the room isn't clear.
  const gemini = groups.filter((x) => /\bgemini\b/i.test(x.name));
  if (gemini.length !== 1 || !gemini[0]!.windows.length) return undefined;
  const windows: UsageWindow[] = [];
  const at = (f: Found) => (f.resetsAt ? { resetsAt: f.resetsAt } : {});
  for (const f of gemini[0]!.windows) {
    windows.push(f.span === 'five_hour' ? { kind: 'five_hour', title: '5-hour', remainingPercent: f.remaining, ...at(f) } : { kind: 'weekly', title: 'Weekly', remainingPercent: f.remaining, ...at(f) });
  }
  for (const x of groups) {
    if (x === gemini[0]) continue;
    const name = groupName(x.name);
    for (const f of x.windows) {
      windows.push(f.span === 'weekly' ? { kind: 'weekly_model', title: `Weekly ${name}`, remainingPercent: f.remaining, ...at(f) } : { kind: 'other', title: `5-hour ${name}`, remainingPercent: f.remaining, ...at(f) });
    }
  }
  const main = windows.filter((w) => w.kind === 'five_hour' || w.kind === 'weekly');
  const others = windows.filter((w) => !main.includes(w)).map((w) => w.title);
  const aside = others.length ? { aside: others } : {};
  if (main.some((w) => w.remainingPercent < 1)) return { windows, blocked: true, ...aside };
  return main.length === 2 ? { windows, blocked: false, ...aside } : { windows, ...aside };
}

// The plan's name from session/new's result: _meta.antigravity.tier.name
// ("Google AI Ultra").
export function agyPlan(result: unknown): string | undefined {
  const r = result as { _meta?: { antigravity?: { tier?: { name?: unknown } } } } | null | undefined;
  const name = r?._meta?.antigravity?.tier?.name;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : undefined;
}

// The reading for AcpAgent.limits: /usage's answer with the plan's name from
// session/new's result, or nothing when the answer doesn't read (not even
// the plan's name: any reading stamps the login as read now).
export function agyLimits(text: string, session: unknown): Extract<AdapterOutput, { kind: 'limits' }> | undefined {
  const read = parseAgyUsage(text);
  if (!read) return undefined;
  const plan = agyPlan(session);
  return { kind: 'limits', windows: read.windows, ...(read.blocked !== undefined ? { blocked: read.blocked } : {}), ...(plan ? { plan } : {}), ...(read.aside ? { aside: read.aside } : {}) };
}
