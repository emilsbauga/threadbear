// The sidebar's sections. The runner works out what each thread waits on and
// sends it as `waitState` (runner/src/wait-state.ts, docs/protocol/needs-you.md
// "Wait state"); this draws it, with the same map as every app, kept to it by
// shared/cases/wait-states.json. No React here, so the tests can run it bare.
import { folderName } from './format.ts';

export type SectionKey = 'starred' | 'coordinators' | 'backlog' | 'inbox' | 'running' | 'hibernating' | 'archived';
export const SECTIONS: SectionKey[] = ['starred', 'coordinators', 'backlog', 'inbox', 'running', 'hibernating', 'archived'];

export type InboxOrder = 'needsYou' | 'newest' | 'oldest';

// The fields of a phone:threads row that decide where it goes.
export type ThreadRow = {
  threadId: string;
  // Whose thread it is: a project is only its runner's (placeKeysOf).
  runnerId?: string;
  title: string;
  preview: string;
  cwd: string;
  status: string;
  needsYou: boolean;
  unread: boolean;
  lastActivityMs: number;
  starredAt?: string;
  backlogged?: boolean;
  backlog?: { text: string; revision: number; imageCount: number };
  coordinatorProjectId?: string;
  archivedAt?: string;
  snoozedUntil?: string;
  snoozedUntilRestart?: boolean;
  wakeNote?: string;
  needs?: 'you' | 'nothing';
  pendingReviews?: number;
  pendingApproval?: unknown;
  waitingForRoom?: unknown;
  working?: string;
  asks?: { ticked?: boolean }[];
  projects?: { id: string; title: string }[];
  share?: { access?: string };
  // What it waits on, from the runner (API from 23 Nov). Absent from older
  // runners, whose rows go through the legacy rule below.
  waitState?: string;
};

// ------------------------------------------------------------ wait state

export type WaitState = 'working' | 'job' | 'onThreads' | 'landing' | 'appRestart' | 'sending' | 'card' | 'review' | 'needsYou' | 'limit' | 'done' | 'scheduled' | 'hibernating' | 'archived';

// Each state's section, as runner/src/wait-state.ts's WAIT_STATES. `sending`
// is only an app's own guess while a message is on its way; the runner never
// sends it.
const WAIT_SECTION: Record<WaitState, 'inbox' | 'running' | 'hibernating' | 'archived'> = {
  working: 'running',
  job: 'running',
  onThreads: 'running',
  landing: 'running',
  appRestart: 'running',
  sending: 'running',
  card: 'inbox',
  review: 'inbox',
  needsYou: 'inbox',
  limit: 'inbox',
  done: 'inbox',
  scheduled: 'hibernating',
  hibernating: 'hibernating',
  archived: 'archived',
};

// The row's state, or undefined for a row from a runner that doesn't send
// one. A value this build doesn't know is drawn as done.
export function waitStateOf(r: ThreadRow): WaitState | undefined {
  if (r.waitState === undefined) return undefined;
  return r.waitState in WAIT_SECTION ? (r.waitState as WaitState) : 'done';
}

// Still at its own work (a turn, a job, waiting on other threads, to land or
// for the app): drawn under Running, and its card doesn't say Done. False for
// a row with no state, whose own fields say it.
export function stillWorking(r: ThreadRow): boolean {
  const state = waitStateOf(r);
  return state !== undefined && WAIT_SECTION[state] === 'running';
}

// How much a state wants Mike, lowest first, as the runner's urgencyOf: 0
// stuck on him (a card, a review), 1 asking him after a failed or stopped
// turn, 2 asking him (read or not: Mike, 23 Nov) or out of usage, 3 done
// after a failed or stopped turn, 4 done or not in the Inbox.
function urgencyOfState(state: WaitState, status: string): number {
  const broken = status === 'error' || status === 'stopped';
  switch (state) {
    case 'card':
    case 'review':
      return 0;
    case 'needsYou':
      return broken ? 1 : 2;
    case 'limit':
      return 2;
    case 'done':
      return broken ? 3 : 4;
    default:
      return 4;
  }
}

export type ScheduleRow = { threadId?: string; nextRunAt?: string; paused?: boolean; finishedAt?: string };

// ------------------------------------------------------------ legacy rule
// Only for rows without `waitState`, from a runner before 23 Nov: the old copy
// of the Mac's rule. Goes once every runner sends waitState.

const isBusy = (r: ThreadRow) => r.status === 'running' || r.status === 'starting';
const reviewWaiting = (r: ThreadRow) => (r.pendingReviews ?? 0) > 0 && !isBusy(r) && r.working === undefined;
const needsAnswer = (r: ThreadRow) => !!r.pendingApproval || r.status === 'waiting';

// The last turn ended asking Mike for something and he hasn't done it all.
function legacyWaitingOnMike(r: ThreadRow): boolean {
  if (r.needs !== 'you' || isBusy(r)) return false;
  const asks = r.asks ?? [];
  return asks.length === 0 || asks.some((a) => a.ticked !== true);
}

// Legacy: how much an inbox thread wants Mike, as the Mac and phone had it
// (shared/cases/inbox-urgency.json). Unread alone isn't wanting him: a turn
// that said "nothing" is done (Mike, 9 Nov).
function legacyUrgency(r: ThreadRow): number {
  const broken = r.status === 'error' || r.status === 'stopped';
  if (reviewWaiting(r) || needsAnswer(r)) return 0;
  if (r.needsYou) return broken ? 1 : 2;
  return broken ? 3 : 4;
}

// Legacy: which heading an inbox-list row goes under, or 'skip' for one
// snoozed (the backend's Hibernating list has it).
function legacySection(r: ThreadRow, now: number, wakes: Map<string, number>): 'inbox' | 'running' | 'scheduled' | 'skip' {
  if (isSnoozed(r, now)) return 'skip';
  // A question or approval goes in the inbox even while background work
  // runs: the thread is stuck until he answers.
  if (reviewWaiting(r) || needsAnswer(r) || legacyWaitingOnMike(r) || (r.needsYou && r.working === undefined)) return 'inbox';
  if (isBusy(r) || r.working !== undefined) return 'running';
  if (r.status === 'idle' && r.needs !== 'you' && !r.waitingForRoom && wakes.has(r.threadId)) return 'scheduled';
  return 'inbox';
}

// Legacy: whether it counts in the Needs you filter, before the live check.
const legacyCounts = (r: ThreadRow) => legacyUrgency(r) === 0 || r.needsYou || legacyWaitingOnMike(r);

// Missing or malformed metadata keeps an ordinary thread in its usual section.
export function isCoordinator(r: ThreadRow): boolean {
  return typeof r.coordinatorProjectId === 'string' && r.coordinatorProjectId.trim().length > 0;
}

// ------------------------------------------------------------ headings

// The sub line of a hibernating row that waits for more than a time:
// "Until "Convex I/O" finishes · misc". Undefined otherwise.
export function wakeLine(r: ThreadRow, places: string[], now: number): string | undefined {
  if (!r.wakeNote || !isSnoozed(r, now)) return undefined;
  return [`Until ${r.wakeNote}`, ...places].join(' · ');
}

export function isSnoozed(r: ThreadRow, now: number): boolean {
  if (r.snoozedUntilRestart) return true;
  return !!r.snoozedUntil && Date.parse(r.snoozedUntil) > now;
}

// How much an inbox thread wants Mike, lowest first (the Needs you order).
export function urgency(r: ThreadRow): number {
  const state = waitStateOf(r);
  return state ? urgencyOfState(state, r.status) : legacyUrgency(r);
}

// Stuck on a card only Mike can answer: first in every order.
const isCard = (r: ThreadRow) => {
  const state = waitStateOf(r);
  return state ? state === 'card' : needsAnswer(r);
};
const cardFirst = (a: ThreadRow, b: ThreadRow) => Number(isCard(b)) - Number(isCard(a));
const newestFirst = (a: ThreadRow, b: ThreadRow) => b.lastActivityMs - a.lastActivityMs || a.threadId.localeCompare(b.threadId);

// For each thread a schedule will message by itself, when the soonest is due.
// Paused and finished ones don't count, nor ones that start a new thread.
export function wakesOf(schedules: ScheduleRow[]): Map<string, number> {
  const soonest = new Map<string, number>();
  for (const s of schedules) {
    if (s.paused || s.finishedAt || !s.threadId || !s.nextRunAt) continue;
    const at = Date.parse(s.nextRunAt);
    const current = soonest.get(s.threadId);
    if (current === undefined || at < current) soonest.set(s.threadId, at);
  }
  return soonest;
}

// The inbox list split into its headings. Hibernating and Archived are
// lists of their own from the backend, but a thread idle until a schedule
// messages it is in the inbox list and belongs under Hibernating: `scheduled`.
// A starred thread is in the inbox list even while hibernating (API 27), and
// so is one put away waiting on its own work (onThreads, landing,
// appRestart), which goes under Running though it has a snooze.
export function build<T extends ThreadRow>(rows: T[], now: number, wakes: Map<string, number>, order: InboxOrder) {
  const coordinators: T[] = [];
  const starred: T[] = [];
  const backlog: T[] = [];
  const inbox: T[] = [];
  const running: T[] = [];
  const scheduled: T[] = [];
  for (const r of rows) {
    const state = waitStateOf(r);
    if (r.archivedAt || state === 'archived') continue;
    if (r.backlog || r.backlogged) { backlog.push(r); continue; }
    if (isCoordinator(r)) {
      coordinators.push(r);
      continue;
    }
    if (r.starredAt) {
      starred.push(r);
      continue;
    }
    // A plain hibernating row is the backend's Hibernating list's to draw.
    const section = state ? (state === 'scheduled' ? 'scheduled' : state === 'hibernating' ? 'skip' : WAIT_SECTION[state]) : legacySection(r, now, wakes);
    if (section === 'inbox') inbox.push(r);
    else if (section === 'running') running.push(r);
    else if (section === 'scheduled') scheduled.push(r);
  }
  // Oldest star first, so they stay put while Mike goes back and forth.
  coordinators.sort((a, b) => a.coordinatorProjectId!.localeCompare(b.coordinatorProjectId!) || a.threadId.localeCompare(b.threadId));
  starred.sort((a, b) => a.starredAt!.localeCompare(b.starredAt!) || a.threadId.localeCompare(b.threadId));
  if (order === 'needsYou') inbox.sort((a, b) => urgency(a) - urgency(b) || newestFirst(a, b));
  // A card waiting on Mike (ask_secret, a question, a permission) goes first
  // in every order: it runs out, and oldest first had it at the bottom (19 Nov).
  else if (order === 'newest') inbox.sort((a, b) => cardFirst(a, b) || newestFirst(a, b));
  else inbox.sort((a, b) => cardFirst(a, b) || newestFirst(b, a));
  running.sort(newestFirst);
  return { coordinators, starred, backlog: backlog.sort(newestFirst), inbox, running, scheduled };
}

// The Hibernating heading's rows: soonest to wake first, each once (a thread
// can be in both lists for a moment while the runner moves it). Back on
// restart has no time, so it goes last.
export function hibernating<T extends ThreadRow>(scheduled: T[], snoozed: T[], wakes: Map<string, number>): T[] {
  const seen = new Set<string>();
  const wakesAt = (r: T) => (r.snoozedUntil ? Date.parse(r.snoozedUntil) : (wakes.get(r.threadId) ?? Infinity));
  return [...scheduled, ...snoozed].filter((r) => !isCoordinator(r) && !seen.has(r.threadId) && seen.add(r.threadId)).sort((a, b) => (wakesAt(a) === wakesAt(b) ? newestFirst(a, b) : wakesAt(a) - wakesAt(b)));
}

// Most recently archived first, as the Mac has it. The backend sends the den
// by last activity.
export function archived<T extends ThreadRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));
}

// ------------------------------------------------------------ search and filter

const folded = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

// A thread's place: its projects, or its folder when it's in none. What the
// row's second line says, and what a project filter picks from.
export function placesOf(r: ThreadRow): string[] {
  return r.projects?.length ? r.projects.map((p) => p.title) : [folderName(r.cwd)];
}

// What a project filter picks by: a project as its runner's (runnerId and id),
// never its title, which any runner can give its own thread (Daybreak 141),
// or a folder by name. Kept apart from placesOf, which is only words.
export function placeKeysOf(r: ThreadRow): { key: string; label: string }[] {
  return r.projects?.length ? r.projects.map((p) => ({ key: `project\n${r.runnerId ?? ''}\n${p.id}`, label: p.title })) : [{ key: `folder\n${folderName(r.cwd)}`, label: folderName(r.cwd) }];
}

// Part of the title or last reply, as on the Mac, or the place, as on the
// phone. Case and accent insensitive.
export function matches(r: ThreadRow, query: string): boolean {
  const q = folded(query.trim());
  return !q || [r.title, r.preview, ...placesOf(r)].some((s) => folded(s).includes(q));
}

// `place` is a placeKeysOf key, `placeLabel` its words for the menu.
export type Filter = { show: 'all' | 'needsYou' | 'unread' | 'shared'; place?: string; placeLabel?: string };
export const NO_FILTER: Filter = { show: 'all' };
export const isFiltering = (f: Filter) => f.show !== 'all' || f.place !== undefined;

export function passes(r: ThreadRow, f: Filter, now = Date.now()): boolean {
  if (f.place !== undefined && !placeKeysOf(r).some((p) => p.key === f.place)) return false;
  // A thread put away isn't waiting on Mike, whatever its last turn said: the
  // Mac's badge leaves those out too. Real archived threads keep a stale
  // `needs` and `unread` for good, which filled these with old work.
  const live = !r.archivedAt && !isSnoozed(r, now);
  if (f.show === 'needsYou') return live && (waitStateOf(r) ? urgency(r) <= 2 : legacyCounts(r));
  if (f.show === 'unread') return live && r.unread;
  if (f.show === 'shared') return r.share?.access === 'link';
  return true;
}

// Whether a row is drawn. The open thread stays while it's a status filter
// that it no longer passes: opening a thread reads it, and it shouldn't drop
// out from under Mike the moment he does.
export function shows(r: ThreadRow, query: string, f: Filter, selected?: string): boolean {
  if (!matches(r, query)) return false;
  return passes(r, f) || (r.threadId === selected && passes(r, { show: 'all', place: f.place }));
}

// The places to filter by, most threads first, from whatever's loaded.
// Two runners' projects with the same title are two choices.
export function placeChoices(rows: ThreadRow[]): { place: string; label: string; count: number }[] {
  const seen = new Set<string>();
  const counts = new Map<string, { label: string; count: number }>();
  for (const r of rows) {
    if (seen.has(r.threadId)) continue;
    seen.add(r.threadId);
    for (const p of placeKeysOf(r)) {
      const c = counts.get(p.key);
      if (c) c.count++;
      else counts.set(p.key, { label: p.label, count: 1 });
    }
  }
  return [...counts].map(([place, c]) => ({ place, ...c })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// ------------------------------------------------------------ what's drawn

// Which archived threads to draw. The archive runs to hundreds, more than a
// list under the inbox should scroll through, so the most recent few and more
// on asking. A search or filter draws every match, and the open thread is
// always in (a thread link can open an old one).
export const ARCHIVE_FIRST = 20;
export const ARCHIVE_STEP = 50;
export function archiveShown<T extends ThreadRow>(rows: T[], limit: number, narrowing: boolean, selected?: string): { rows: T[]; more: number } {
  if (narrowing) return { rows, more: 0 };
  const at = selected ? rows.findIndex((r) => r.threadId === selected) + 1 : 0;
  const count = Math.min(rows.length, Math.max(limit, at));
  return { rows: rows.slice(0, count), more: rows.length - count };
}

// The row under `step` from the selected one, for the arrow keys. With
// nothing selected, the first going down and the last going up.
export function neighbour(order: string[], selected: string | undefined, step: 1 | -1): string | undefined {
  const at = selected === undefined ? -1 : order.indexOf(selected);
  if (at < 0) return step === 1 ? order[0] : order.at(-1);
  return order[at + step];
}

// ------------------------------------------------------------ folds and width

// As the Mac starts: Hibernating and Archived folded, the rest open.
export const INITIAL_FOLDED: SectionKey[] = ['hibernating', 'archived'];

export function readFolded(saved: string | null): Set<SectionKey> {
  try {
    const list = JSON.parse(saved ?? 'null');
    if (Array.isArray(list)) return new Set(list.filter((s): s is SectionKey => SECTIONS.includes(s)));
  } catch {
    // A saved value this build can't read is the same as none.
  }
  return new Set(INITIAL_FOLDED);
}

export function readOrder(saved: string | null): InboxOrder {
  return saved === 'newest' || saved === 'oldest' ? saved : 'needsYou';
}

export const SIDEBAR_DEFAULT = 300;
export const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 600;
// However wide the sidebar goes, the thread keeps 420, beside the 44 of the rail.
const THREAD_MIN = 464;

export function clampWidth(width: number, windowWidth: number): number {
  const max = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, windowWidth - THREAD_MIN));
  return Math.round(Math.min(max, Math.max(SIDEBAR_MIN, width)));
}

export function readWidth(saved: string | null): number {
  const n = Number(saved);
  return saved !== null && Number.isFinite(n) && n > 0 ? n : SIDEBAR_DEFAULT;
}
