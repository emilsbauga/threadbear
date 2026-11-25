// A login's week going unused (docs/guide.md, "Accounts, pools and Usage";
// docs/protocol.md, `accounts.findWork`).
//
// Mike, 17 Nov 2026: when a login is heading for its weekly reset with lots
// of its limit still unused, tell me and suggest work that would use it,
// rather than letting it go to waste. It started as one of his schedules (a
// Python check in his misc folder); on 18 Nov he asked for it in Threadbear
// for everyone, two ways in:
// - the Usage panel's Find work for it, on a login whose week will go
//   unused: starts the suggestion thread there and then;
// - by itself, while Settings' "Tell me when a week's about to go unused"
//   is on (runner.json `spareWeek`, on unless it says false): a day before a
//   login's week resets, when at its current rate 30% or more of it would be
//   left, and again 8 hours out (20% or more) as a last call.
//
// Either way the thread is pinned to that login (so working out what to
// suggest spends the spare week, not another's), suggests 2 to 4 jobs and
// asks before starting any. Mike, 18 Nov: "only when we're very sure the
// tokens would go unused", so not earlier than a day out, and never anything
// that posts, sends, deploys or spends money.
//
// Only the main Mac's runner (or one with no other runners) looks by itself:
// every runner sees the same shared readings, and two runners each starting
// a thread about the same login would be one too many. Nor does a runner
// handing over to a new release: it can't start threads, and the new one
// looks from then on (THREADBEAR-2H).
import fs from 'node:fs';
import path from 'node:path';
import type { Clock, TimerHandle } from './clock.ts';
import type { Logger } from './log.ts';
import type { Account, Pool, UsageWindow } from './protocol.ts';
import type { HistoryRow, Sample } from './usage-history.ts';
import type { Runner } from './runner.ts';

export const LOOKAHEAD_H = 24; // starts saying so this long before a reset
export const LAST_CALL_H = 8; // a second nudge this close to it
export const MIN_LEFTOVER = 30; // % of the week left at the reset, at the current rate
export const MIN_LEFTOVER_LAST = 20;
export const OLD_READING_H = 6; // older than this, the thread checks it first
export const CHECK_MS = 30 * 60_000;
const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
// Providers can reconstruct the same reset from a rounded countdown: live
// Codex readings have differed by one second. Compare dates, not rounded
// buckets (which split a reset on the bucket boundary).
const RESET_JITTER_MS = 60_000;

function sameReset(a: string | undefined, b: string | undefined): boolean {
  return Math.abs(Date.parse(a ?? '') - Date.parse(b ?? '')) <= RESET_JITTER_MS;
}

export type Stage = 'early' | 'last-call';

// One weekly window and where it's heading.
export type Projection = {
  window: UsageWindow;
  hoursLeft: number;
  // Percentage points an hour.
  rate: number;
  leftAtReset: number;
};

// A window worth a thread, with why.
export type SpareWindow = Projection & { accountId: string; stage: Stage };

// % an hour: the larger of the last day's and the average since the week
// began, so a quiet afternoon doesn't make the leftover look bigger than it
// is (check.py's burn_rate).
export function burnRate(samples: readonly Sample[], windowStart: number, remaining: number, now: number): number {
  const rates: number[] = [];
  const elapsedH = (now - windowStart) / HOUR_MS;
  if (elapsedH > 6) rates.push(Math.max(0, (100 - remaining) / elapsedH));
  // First to last reading of the last day, within this window, so there's no
  // reset in between. Readings jitter by a point or so, which this rides over.
  const recent = samples.filter(([at]) => at >= Math.max(windowStart, now - 24 * HOUR_MS) && at <= now);
  if (recent.length >= 2) {
    const first = recent[0]!;
    const last = recent[recent.length - 1]!;
    const hours = (last[0] - first[0]) / HOUR_MS;
    if (hours >= 3) rates.push(Math.max(0, (first[1] - last[1]) / hours));
  }
  return rates.length ? Math.max(...rates) : 0;
}

export function project(window: UsageWindow, samples: readonly Sample[], now: number): Projection | undefined {
  const reset = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (!Number.isFinite(reset)) return undefined;
  const hoursLeft = (reset - now) / HOUR_MS;
  const rate = burnRate(samples, reset - WEEK_MS, window.remainingPercent, now);
  return { window, hoursLeft, rate, leftAtReset: Math.max(0, window.remainingPercent - rate * Math.max(hoursLeft, 0)) };
}

// The history's samples for one window of one login.
export type SamplesFor = (accountId: string, window: UsageWindow) => readonly Sample[];

export function samplesFrom(rows: readonly HistoryRow[]): SamplesFor {
  return (accountId, w) => rows.find((r) => r.accountId === accountId && r.kind === w.kind && (w.kind !== 'weekly_model' || r.title === w.title))?.samples ?? [];
}

// A login's weekly windows (its main week and any model's own week), each
// projected to its reset. A model's own week can only be spent while the
// main week has room too, so its leftover is no more than the main week's
// by then, unless the main week resets first and refills.
export function projections(account: Account, samples: SamplesFor, now: number): Projection[] {
  const windows = (account.usage?.windows ?? []).filter((w) => (w.kind === 'weekly' || w.kind === 'weekly_model') && w.resetsAt);
  const main = windows.find((w) => w.kind === 'weekly');
  const mainP = main ? project(main, samples(account.id, main), now) : undefined;
  const out: Projection[] = [];
  for (const w of windows) {
    const p = w === main ? mainP : project(w, samples(account.id, w), now);
    if (!p || p.hoursLeft <= 0) continue;
    if (w.kind === 'weekly_model' && main && mainP) {
      // Resets with the main week: that one says it all.
      if (sameReset(w.resetsAt, main.resetsAt)) continue;
      if (mainP.hoursLeft >= p.hoursLeft) p.leftAtReset = Math.min(p.leftAtReset, Math.max(0, main.remainingPercent - mainP.rate * p.hoursLeft));
    }
    out.push(p);
  }
  return out;
}

// Whether a login can be offered work at all: signed in, on a plan, with a
// reading, and not at its limit.
export function usable(a: Account): boolean {
  return !a.signedOut && !a.planEnded && !a.usage?.blocked && Boolean(a.usage?.windows.length);
}

function windowKey(accountId: string, w: UsageWindow): string {
  return `${accountId}|${w.kind === 'weekly' ? 'weekly' : `${w.kind}:${w.title}`}|${w.resetsAt}`;
}

function saidStages(accountId: string, w: UsageWindow, done: Record<string, Stage[]>): Stage[] {
  const key = windowKey(accountId, w);
  const prefix = key.slice(0, key.lastIndexOf('|') + 1);
  // Read the old on-disk keys too, including multiple readings saved before
  // this fix. Keep their stage history rather than issuing a new nudge.
  return Object.entries(done).flatMap(([k, stages]) =>
    k.startsWith(prefix) && sameReset(k.slice(prefix.length), w.resetsAt) ? stages : [],
  );
}

// The windows due a thread now, and the stage each is at. `done` is each
// window's stages already said, by windowKey.
export function dueWindows(accounts: readonly Account[], samples: SamplesFor, done: Record<string, Stage[]>, now: number): SpareWindow[] {
  const out: SpareWindow[] = [];
  for (const a of accounts) {
    if (!usable(a)) continue;
    for (const p of projections(a, samples, now)) {
      if (p.hoursLeft > LOOKAHEAD_H) continue;
      const stage: Stage = p.hoursLeft <= LAST_CALL_H ? 'last-call' : 'early';
      const said = saidStages(a.id, p.window, done);
      if (said.includes(stage) || (stage === 'early' && said.includes('last-call'))) continue;
      if (p.leftAtReset < (stage === 'last-call' ? MIN_LEFTOVER_LAST : MIN_LEFTOVER)) continue;
      out.push({ ...p, accountId: a.id, stage });
    }
  }
  return out;
}

function when(iso: string | undefined, now: number): string {
  if (!iso) return 'at its reset';
  const h = Math.max(0, (Date.parse(iso) - now) / HOUR_MS);
  const around = h < 1 ? 'in under an hour' : h < 48 ? `in about ${Math.round(h)} hours` : `in about ${Math.round(h / 24)} days`;
  return `${iso} (${around})`;
}

function windowWords(p: Projection, now: number): string {
  const w = p.window;
  const what = w.kind === 'weekly' ? 'Its weekly limit' : `Its ${w.title} limit (only that model's work spends it)`;
  const rate = p.rate > 0 ? `, being used at about ${p.rate.toFixed(1)}% an hour, so about ${Math.round(p.leftAtReset)}% will go unused` : `, with nothing used lately, so about ${Math.round(p.leftAtReset)}% will go unused`;
  return `${what} has ${Math.round(w.remainingPercent)}% left and resets ${when(w.resetsAt, now)}${rate}.`;
}

// The first message of the suggestion thread. Nothing in it is anyone's own
// setup: the agent finds the work in this person's projects and threads.
export function brief(o: { account: Account; pools: readonly Pool[]; projections: readonly Projection[]; stage?: Stage; byHand: boolean; now: number }): string {
  const { account: a, now } = o;
  const pools = o.pools.filter((p) => p.accountIds.includes(a.id)).map((p) => p.title);
  const name = a.email ?? a.title;
  const lines: string[] = [];
  lines.push(
    o.byHand
      ? `I pressed Find work for it on ${name} in Usage. Its week will go partly unused, so suggest worthwhile work to spend it on.`
      : `${name}'s week is about to go partly unused (Threadbear's check, as "Tell me when a week's about to go unused" is on in Settings). Suggest worthwhile work to spend it on.`,
  );
  lines.push('');
  lines.push(`The login: ${a.id} (${a.provider}${a.note ? `, "${a.note}"` : ''}${pools.length ? `, in ${pools.length > 1 ? 'pools' : 'pool'} ${pools.join(', ')}` : ''}).`);
  for (const p of o.projections) lines.push(windowWords(p, now));
  if (!o.projections.length) lines.push("There's no projection for its week yet, so check how much it has left with list_accounts.");
  const read = a.usage?.readAt ? Date.parse(a.usage.readAt) : NaN;
  if (Number.isFinite(read) && now - read > OLD_READING_H * HOUR_MS) lines.push(`That reading is ${Math.round((now - read) / HOUR_MS)} hours old.`);
  if (o.stage === 'last-call') lines.push('This is the last call: it resets within hours.');
  const model = o.projections.find((p) => p.window.kind === 'weekly_model' && p.leftAtReset >= MIN_LEFTOVER_LAST);
  lines.push('');
  lines.push('What to do:');
  lines.push(
    "1. Confirm the numbers with list_accounts. If it has much less room than this says, or is used up, there's nothing to suggest: say so in one line and end the turn with archive: true and needs \"nothing\".",
  );
  lines.push(
    "2. Find candidate jobs that fit this login: what its note says it's for, and its pool's folders. Look at list_projects (goals, state and next steps an agent could pick up alone) and list_threads (done cards with follow-ups never ticked, things left to come back to; skip anything another thread is already on), and any report-only reviews or audits those projects point to.",
  );
  lines.push(
    "3. Pick the best 2 to 4: token-hungry, able to run unattended, and worth having even if only read, like a deep review or test-gap pass on a repo that matters, fixing what an earlier report found, research that was asked about, rough options for something being explored, or a cleanup. Nothing that posts, sends, deploys to production or spends money. Size the list to the leftover: a big job at max effort uses very roughly 5 to 10% of a weekly limit.",
  );
  lines.push(
    `4. Ask, don't start: end_turn with one ask per job (options Start it and Skip, needs "you"). In the reply, a line per job on what it would do and why it's worth it now, with a link to where it came from, and say how much of ${name}'s week would otherwise go unused and when it resets.`,
  );
  lines.push(
    `5. When I answer, start each job I picked with create_thread: account "${a.id}" (so it spends this week), effort "max", nested false, in the right folder, with a complete brief, as the new thread knows nothing else.${model ? ` A job meant to spend ${model.window.title} runs on that model, as only its work spends that week.` : ''}`,
  );
  return lines.join('\n');
}

type State = {
  // Stages said for each window, by windowKey; dropped once it has reset.
  windows: Record<string, Stage[]>;
  // The open suggestion thread for each login.
  threads: Record<string, string>;
};

// Whether this runner looks by itself (SpareWeekDeps.looks).
export function looksByItself(r: { draining: boolean; secondRunner: boolean }): boolean {
  return !r.draining && !r.secondRunner;
}

export type SpareWeekDeps = {
  home: string;
  clock: Clock;
  log: Logger;
  // runner.json `spareWeek`: on unless it's false.
  on: () => boolean;
  // Whether this runner is the one that looks by itself.
  looks: () => boolean;
  accounts: () => Account[];
  pools: () => Pool[];
  history: (since: number) => HistoryRow[];
  start: (r: { text: string; title: string; accountId: string; cwd?: string; why: string; origin?: 'runner' }) => string;
  open: (threadId: string) => boolean;
  send: (threadId: string, text: string) => void;
};

export function spareWeekBinding(runner: Pick<Runner, 'create' | 'send'>): Pick<SpareWeekDeps, 'start' | 'send'> {
  return {
    start: (r) => runner.create({ text: r.text, title: r.title, cwd: r.cwd, accountId: r.accountId, origin: r.origin, wakeReason: r.origin === 'runner' ? 'Its weekly allowance is about to reset' : undefined, startedBy: { kind: 'runner', label: 'Threadbear', why: r.why } }).thread.id,
    send: (threadId, text) => void runner.send(threadId, text, [], { queue: true, origin: 'runner', wakeReason: 'Its weekly allowance resets within hours' }),
  };
}

export class SpareWeek {
  private readonly d: SpareWeekDeps;
  private timer?: TimerHandle;
  constructor(deps: SpareWeekDeps) {
    this.d = deps;
  }

  private file(): string {
    return path.join(this.d.home, 'runner', 'spare-week.json');
  }

  private read(): State {
    try {
      const s = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as Partial<State>;
      return { windows: s.windows && typeof s.windows === 'object' ? s.windows : {}, threads: s.threads && typeof s.threads === 'object' ? s.threads : {} };
    } catch {
      return { windows: {}, threads: {} };
    }
  }

  private write(s: State): void {
    fs.mkdirSync(path.dirname(this.file()), { recursive: true });
    fs.writeFileSync(this.file(), JSON.stringify(s, null, 2) + '\n');
  }

  start(): void {
    const tick = () => {
      try {
        this.check();
      } catch (e) {
        this.d.log.warn('spare week check failed', { error: String(e) });
      }
      this.timer = this.d.clock.setTimeout(tick, CHECK_MS);
    };
    // A few minutes in, once readings have come in.
    this.timer = this.d.clock.setTimeout(tick, 5 * 60_000);
  }

  stop(): void {
    this.timer?.cancel();
  }

  private samples(): SamplesFor {
    return samplesFrom(this.d.history(this.d.clock.now() - WEEK_MS));
  }

  private cwdFor(accountId: string): string | undefined {
    return this.d.pools().find((p) => p.accountIds.includes(accountId) && p.folders?.length)?.folders?.[0];
  }

  // The login's open suggestion thread, if there is one.
  private openThread(s: State, accountId: string): string | undefined {
    const id = s.threads[accountId];
    return id && this.d.open(id) ? id : undefined;
  }

  // By itself, every half hour. Returns the windows it spoke about.
  check(): SpareWindow[] {
    if (!this.d.on() || !this.d.looks()) return [];
    const now = this.d.clock.now();
    const s = this.read();
    // Forget windows that reset over an hour ago.
    for (const k of Object.keys(s.windows)) {
      const at = Date.parse(k.slice(k.lastIndexOf('|') + 1));
      if (!(at > now - HOUR_MS)) delete s.windows[k];
    }
    const accounts = this.d.accounts();
    const due = dueWindows(accounts, this.samples(), s.windows, now);
    const byLogin = new Map<string, SpareWindow[]>();
    for (const w of due) byLogin.set(w.accountId, [...(byLogin.get(w.accountId) ?? []), w]);
    for (const [accountId, windows] of byLogin) {
      const account = accounts.find((a) => a.id === accountId)!;
      const stage: Stage = windows.some((w) => w.stage === 'last-call') ? 'last-call' : 'early';
      const text = brief({ account, pools: this.d.pools(), projections: windows, stage, byHand: false, now });
      const open = this.openThread(s, accountId);
      if (open) {
        // Still being talked about: the last call goes there, not to a
        // second thread.
        this.d.send(open, text);
        this.d.log.info('told the spare week thread again', { accountId, threadId: open, stage });
      } else {
        s.threads[accountId] = this.d.start({ text, title: title(account), accountId, cwd: this.cwdFor(accountId), why: "a login's week going unused", origin: 'runner' });
        this.d.log.info('started a spare week thread', { accountId, threadId: s.threads[accountId], stage });
      }
      for (const w of windows) {
        const k = windowKey(accountId, w.window);
        s.windows[k] = [...(s.windows[k] ?? []), w.stage];
      }
    }
    for (const [id, threadId] of Object.entries(s.threads)) if (!this.d.open(threadId)) delete s.threads[id];
    this.write(s);
    return due;
  }

  // The Usage panel's Find work for it: the login's open suggestion thread,
  // or a new one. Whatever the setting and the thresholds say, as it's a
  // click.
  findWork(accountId: string): { threadId: string; started: boolean } {
    const account = this.d.accounts().find((a) => a.id === accountId);
    if (!account) throw Object.assign(new Error(`No login ${accountId} on this runner.`), { notFound: true });
    const s = this.read();
    const open = this.openThread(s, accountId);
    if (open) return { threadId: open, started: false };
    const now = this.d.clock.now();
    const projected = projections(account, this.samples(), now);
    const text = brief({ account, pools: this.d.pools(), projections: projected, byHand: true, now });
    const threadId = this.d.start({ text, title: title(account), accountId, cwd: this.cwdFor(accountId), why: 'Find work for it in Usage' });
    s.threads[accountId] = threadId;
    this.write(s);
    this.d.log.info('started a spare week thread by hand', { accountId, threadId });
    return { threadId, started: true };
  }
}

function title(a: Account): string {
  return `Ideas for ${a.email ?? a.title}'s spare week`;
}
