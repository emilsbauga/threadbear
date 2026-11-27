// Wake when… (docs/protocol/settings.md, "Hibernate in words"): Mike says in his own
// words when a hibernating thread should come back ("at the weekend", "in
// a few weeks", "next time I talk about woodworking") and the strong model
// turns that into a time, a topic to listen for, or both. A time is an
// ordinary snoozedUntil; a topic is the librarian's to notice, in the next
// thread Mike talks about it in (librarian.ts).

import { trimEndOfOrSpace } from './linear-text.ts';
import { cutSafely, safeEnd } from './safe-cut.ts';
import { parseIsoTime } from './when.ts';

export type WakeWhen = {
  // What Mike typed.
  said: string;
  // What to listen for, when it's a topic ("woodworking").
  topic?: string;
  // Set while the model works it out. A runner that restarts meanwhile
  // puts the thread back in the inbox, as the answer is lost.
  pending?: true;
  // Set by the thread's own agent (end_turn's snooze in words), waiting for
  // something to happen before it carries on: the topic is then what has to
  // have happened, and waking hands the agent a turn to check it really
  // has, and go back to sleep if not. Mike's own Wake when… only brings the
  // thread back for him. The apps see only that its agent set it (`agent`).
  // Before 13 Nov 2026 an agent's "until the GPUI app replaces the Swift
  // app" was read as a topic, woke on the first talk of the plan, and sat
  // in the inbox with nothing done.
  by?: 'agent';
};

export type WakeAnswer = { until?: string; topic?: string; why: string };

export type WakeInput = {
  said: string;
  now: number;
  timeZone: string;
  title: string;
  first?: string;
  brief?: string;
  by?: 'agent';
};

// What Mike can type, and how far ahead a time can be.
export const SAID_MAX = 300;
export const TOPIC_MAX = 80;
const LATEST_MS = 2 * 365 * 86_400_000;

export const WAKE_SYSTEM = [
  "You work out when a hibernating thread should wake up, in Threadbear, the user's app for running AI agents in threads. The user has put a thread away and said in their own words when they want it back.",
  'Answer with a time, a topic, or both:',
  '- A time when they name one, however loosely: "at the weekend" is Saturday 9 am, "tonight" 7 pm, "in a few weeks" three weeks on at 9 am, "after Christmas" 27 December 9 am. Pick a sensible hour when they give none: 9 am for a day. Never a time that has already passed.',
  '- A topic when they want it back the next time they bring something up ("next time I talk about woodworking", "when I get back to the shed"): a few words for what to listen for, as you would say it in "when the user talks about …" ("woodworking", "the shed build"). Add a time as well only when they give a limit ("or in a month at the latest").',
  "- Something you can't watch for (a reply from someone, a PR merging, a delivery): the time it's most likely to have happened by, and say so in why.",
  "When it's the thread's own agent asking, it is waiting for something to happen before it carries on (\"until the GPUI app replaces the Swift app\"). Then a topic is that thing, said as done (\"the GPUI app has replaced the Swift app\"), which another thread's messages will show once it has, not a subject to listen for; add a time only when they give a limit.",
  'Reply with JSON only, no prose and no code fence: {"until": "an ISO 8601 time with its UTC offset, or null", "topic": "a few words, or null", "why": "one short line, in plain words"}',
].join('\n\n');

export function wakePrompt(input: WakeInput): string {
  const parts = [
    `Now: ${localNow(input.now, input.timeZone)} (${input.timeZone})`,
    `The thread: "${input.title}"`,
  ];
  if (input.first) parts.push(`How it started (the user): ${cut(input.first, 800)}`);
  if (input.brief) parts.push(`Where it's up to:\n${cut(input.brief, 600)}`);
  parts.push(input.by === 'agent' ? `The thread's agent is waiting: ${input.said.trim()}` : `The user wants it back: ${input.said.trim()}`);
  return parts.join('\n\n');
}

// The model's answer, or why it can't be used.
export function readWakeAnswer(text: string, now: number): WakeAnswer | { error: string } {
  const obj = parseObject(text);
  if (!obj) return { error: "The model's answer wasn't JSON." };
  const why = typeof obj.why === 'string' ? cutSafely(obj.why.trim(), 200) : '';
  const topic = typeof obj.topic === 'string' && obj.topic.trim() ? cutSafely(trimEndOfOrSpace(obj.topic.trim(), '.'), TOPIC_MAX) : undefined;
  let until: string | undefined;
  if (typeof obj.until === 'string' && obj.until.trim()) {
    const t = Date.parse(obj.until);
    if (Number.isNaN(t)) return { error: `The model gave a time that couldn't be read: ${obj.until}` };
    if (t <= now + 60_000) return { error: why || 'That time has already passed.' };
    if (t > now + LATEST_MS) return { error: 'That is more than two years away.' };
    until = new Date(t).toISOString();
  }
  if (!until && !topic) return { error: why || "Couldn't work out when from that." };
  return { ...(until ? { until } : {}), ...(topic ? { topic } : {}), why };
}

// ---- Local time parsing (no model needed) ----

type TimeOfDay = { hour: number; minute: number; explicitClock: boolean };

const WORD_NUMS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const DAY_DEFAULT: TimeOfDay = { hour: 9, minute: 0, explicitClock: false };

function parseTimeOfDay(raw: string): TimeOfDay | undefined {
  const s = raw.trim().replace(/^at\s+/i, '').trim().toLowerCase();
  if (!s) return undefined;
  if (s === 'morning') return { hour: 9, minute: 0, explicitClock: false };
  if (s === 'noon' || s === 'midday') return { hour: 12, minute: 0, explicitClock: true };
  if (s === 'lunch' || s === 'lunchtime') return { hour: 12, minute: 0, explicitClock: false };
  if (s === 'afternoon') return { hour: 14, minute: 0, explicitClock: false };
  if (s === 'evening') return { hour: 18, minute: 0, explicitClock: false };
  if (s === 'night') return { hour: 19, minute: 0, explicitClock: false };
  if (s === 'midnight') return { hour: 0, minute: 0, explicitClock: true };
  const m12 = /^(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)$/.exec(s);
  if (m12) {
    const h = Number(m12[1]);
    const minute = m12[2] ? Number(m12[2]) : 0;
    if (h < 1 || h > 12 || minute > 59) return undefined;
    const pm = m12[3].startsWith('p');
    const hour = pm ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
    return { hour, minute, explicitClock: true };
  }
  const m24 = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m24) {
    const hour = Number(m24[1]);
    const minute = Number(m24[2]);
    if (hour > 23 || minute > 59) return undefined;
    return { hour, minute, explicitClock: true };
  }
  return undefined;
}

function localAt(year: number, month: number, day: number, hour: number, minute: number): number | undefined {
  const d = new Date(year, month, day, hour, minute, 0, 0);
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return undefined;
  return d.getTime();
}

function addLocalDays(now: number, days: number, tod?: TimeOfDay): number {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  if (tod) d.setHours(tod.hour, tod.minute, 0, 0);
  return d.getTime();
}

function addLocalMonths(now: number, months: number): number {
  const d = new Date(now);
  const total = d.getFullYear() * 12 + d.getMonth() + months;
  const year = Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const day = Math.min(d.getDate(), lastDay);
  return new Date(year, month, day, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
}

// Deterministic local parsing for plain time expressions in Wake when…
// ("tomorrow", "2h", "in 2 hours", "tonight", "tomorrow morning",
// "Friday 9am", "at the weekend", "in 2 weeks", "15 Dec 2pm", ISO times).
// Returns undefined for topics, events or fuzzy words ("woodworking",
// "woodworking, or tomorrow", "when the parts arrive", "after Christmas",
// "in a few weeks"), so those go to the model.
export function parseWakeTime(said: string, now: number): { until: string; why: string } | { error: string } | undefined {
  let s = said.trim().replace(/[.!?]+$/, '').trim();
  if (!s) return undefined;
  s = s.replace(/^(?:until|till|til)\s+/i, '').trim();
  if (!s) return undefined;

  const finish = (t: number, why: string): { until: string; why: string } | { error: string } => {
    if (!Number.isFinite(t)) return { error: "Couldn't read that time." };
    if (t < now + 60_000) return { error: 'That time has already passed.' };
    if (t > now + LATEST_MS) return { error: 'That is more than two years away.' };
    return { until: new Date(t).toISOString(), why };
  };

  // ISO date ("2026-11-28" -> local 9 am) or full ISO timestamp.
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (isoDate) {
    const t = localAt(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]), 9, 0);
    if (t === undefined) return { error: `That date doesn't exist: ${s}` };
    return finish(t, s);
  }
  const isoTs = parseIsoTime(s);
  if (isoTs !== undefined) return finish(isoTs, s);

  const lower = s.toLowerCase().replace(/\s+/g, ' ');

  // "in half an hour" / "half an hour".
  if (/^(?:in\s+)?half\s+an?\s+hour$/.test(lower)) return finish(now + 30 * 60_000, 'In 30 minutes');

  // Compound hours + minutes: "1h 30m", "1h30m", "in 1 hour 30 minutes", "in 2 hours and 15 mins".
  const hm = /^(?:in\s+)?(\d+)\s*(?:h|hr|hrs|hour|hours)\s*(?:and\s+)?(\d+)\s*(?:m|min|mins|minute|minutes)$/.exec(lower);
  if (hm) return finish(now + (Number(hm[1]) * 60 + Number(hm[2])) * 60_000, s);

  // Relative durations with digits ("30m", "2h", "in 2 hours", "1.5 hours", "in 2 weeks", "3 months").
  const relNum = /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|mos|month|months)$/.exec(lower);
  // Relative durations with word numbers ("in an hour", "in two weeks", "a couple of days").
  const relWord = !relNum
    ? /^(?:in\s+)?(a couple(?: of)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(min|mins|minute|minutes|hr|hrs|hour|hours|day|days|wk|wks|week|weeks|month|months)$/.exec(lower)
    : null;
  const rel = relNum ?? relWord;
  if (rel) {
    const n = relNum ? Number(rel[1]) : rel[1].startsWith('a couple') ? 2 : WORD_NUMS[rel[1]];
    const unit = rel[2];
    if (unit === 'm' || unit.startsWith('min')) return finish(now + Math.round(n * 60_000), s);
    if (unit === 'h' || unit.startsWith('hr') || unit.startsWith('hour')) return finish(now + Math.round(n * 3_600_000), s);
    if (unit === 'd' || unit.startsWith('day')) {
      const t = Number.isInteger(n) ? addLocalDays(now, n) : now + Math.round(n * 86_400_000);
      return finish(t, s);
    }
    if (unit === 'w' || unit.startsWith('wk') || unit.startsWith('week')) {
      const t = Number.isInteger(n) ? addLocalDays(now, n * 7) : now + Math.round(n * 7 * 86_400_000);
      return finish(t, s);
    }
    if (unit.startsWith('mo')) {
      if (!Number.isInteger(n)) return undefined;
      return finish(addLocalMonths(now, n), s);
    }
  }

  // "tonight" or "tonight at 8pm".
  const tonight = /^tonight(?:\s+(?:at\s+)?(.+))?$/.exec(lower);
  if (tonight) {
    const tod = tonight[1] ? parseTimeOfDay(tonight[1]) : { hour: 19, minute: 0, explicitClock: false };
    if (!tod) return undefined;
    const t = addLocalDays(now, 0, tod);
    if (!tod.explicitClock && t < now + 60_000) return undefined;
    return finish(t, s);
  }

  // "this morning" / "this afternoon" / "this evening" / "today 5pm".
  const todayPart = /^(?:this\s+(morning|afternoon|evening)|today\s+(?:at\s+)?(.+))$/.exec(lower);
  if (todayPart) {
    const tod = parseTimeOfDay(todayPart[1] ?? todayPart[2]);
    if (!tod) return undefined;
    const t = addLocalDays(now, 0, tod);
    if (!tod.explicitClock && t < now + 60_000) return undefined;
    return finish(t, s);
  }

  // Bare clock time ("5pm", "at 5pm", "9:30 am", "14:30", "noon", "midnight"):
  // today if still ahead, else tomorrow.
  const bareClock = parseTimeOfDay(lower);
  if (bareClock?.explicitClock) {
    let t = addLocalDays(now, 0, bareClock);
    if (t < now + 60_000) t = addLocalDays(now, 1, bareClock);
    return finish(t, s);
  }

  // "tomorrow", "tomorrow morning", "tomorrow at 2pm".
  const tomorrow = /^(?:tomorrow|tmrw)(?:\s+(?:at\s+)?(.+))?$/.exec(lower);
  if (tomorrow) {
    const tod = tomorrow[1] ? parseTimeOfDay(tomorrow[1]) : DAY_DEFAULT;
    if (!tod) return undefined;
    return finish(addLocalDays(now, 1, tod), s);
  }

  // "the day after tomorrow" / "day after tomorrow".
  const dayAfter = /^(?:the\s+)?day\s+after\s+tomorrow(?:\s+(?:at\s+)?(.+))?$/.exec(lower);
  if (dayAfter) {
    const tod = dayAfter[1] ? parseTimeOfDay(dayAfter[1]) : DAY_DEFAULT;
    if (!tod) return undefined;
    return finish(addLocalDays(now, 2, tod), s);
  }

  const dNow = new Date(now);
  const nowDow = dNow.getDay();
  const nowMonDow = (nowDow + 6) % 7;

  // "at the weekend", "this weekend", "the weekend", "weekend", "next weekend".
  const weekend = /^(?:(next)|(?:at\s+the|on\s+the|this|the))?\s*weekend(?:\s+(?:at\s+)?(.+))?$/.exec(lower);
  if (weekend) {
    const tod = weekend[2] ? parseTimeOfDay(weekend[2]) : DAY_DEFAULT;
    if (!tod) return undefined;
    let daysAhead: number;
    if (weekend[1] === 'next') {
      daysAhead = (7 - nowMonDow) + 5;
    } else {
      daysAhead = (6 - nowDow + 7) % 7;
      if (daysAhead === 0 && addLocalDays(now, 0, tod) < now + 60_000) daysAhead = 7;
    }
    return finish(addLocalDays(now, daysAhead, tod), s);
  }

  // "next week" (Monday 9 am, or given time).
  const nextWeek = /^next\s+week(?:\s+(?:at\s+)?(.+))?$/.exec(lower);
  if (nextWeek) {
    const tod = nextWeek[1] ? parseTimeOfDay(nextWeek[1]) : DAY_DEFAULT;
    if (!tod) return undefined;
    return finish(addLocalDays(now, 7 - nowMonDow, tod), s);
  }

  // "next month" (1st of next month, 9 am or given time).
  const nextMonth = /^next\s+month(?:\s+(?:at\s+)?(.+))?$/.exec(lower);
  if (nextMonth) {
    const tod = nextMonth[1] ? parseTimeOfDay(nextMonth[1]) : DAY_DEFAULT;
    if (!tod) return undefined;
    const nextM = dNow.getMonth() + 1;
    const t = localAt(dNow.getFullYear() + Math.floor(nextM / 12), nextM % 12, 1, tod.hour, tod.minute);
    if (t === undefined) return undefined;
    return finish(t, s);
  }

  // Weekday: "Friday", "Friday 9am", "this Monday morning", "next Tuesday", "on Wednesday at 2pm".
  const weekday = /^(?:(this|next|on)\s+)?(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)(?:\s+(?:at\s+)?(.+))?$/.exec(lower);
  if (weekday) {
    const prefix = weekday[1];
    const targetDow = WEEKDAYS[weekday[2]];
    const hasTime = Boolean(weekday[3]);
    const tod = weekday[3] ? parseTimeOfDay(weekday[3]) : DAY_DEFAULT;
    if (!tod) return undefined;
    let daysAhead: number;
    if (prefix === 'next') {
      const targetMonDow = (targetDow + 6) % 7;
      daysAhead = (7 - nowMonDow) + targetMonDow;
    } else {
      daysAhead = (targetDow - nowDow + 7) % 7;
      if (daysAhead === 0 && (!hasTime || addLocalDays(now, 0, tod) < now + 60_000)) daysAhead = 7;
    }
    return finish(addLocalDays(now, daysAhead, tod), s);
  }

  // Calendar date: "15 Dec", "15 December 2pm", "Dec 15", "December 15, 2026 at 9am".
  const dmy = /^(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)(?:,?\s+(\d{4}))?(?:\s+(?:at\s+)?(.+))?$/.exec(lower);
  const mdy = !dmy
    ? /^(?:on\s+)?(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?:\s+(?:at\s+)?(.+))?$/.exec(lower)
    : null;
  if (dmy || mdy) {
    const day = Number(dmy ? dmy[1] : mdy![2]);
    const month = MONTHS[dmy ? dmy[2] : mdy![1]];
    const yearStr = dmy ? dmy[3] : mdy![3];
    const timeStr = dmy ? dmy[4] : mdy![4];
    const tod = timeStr ? parseTimeOfDay(timeStr) : DAY_DEFAULT;
    if (!tod) return undefined;
    if (yearStr) {
      const t = localAt(Number(yearStr), month, day, tod.hour, tod.minute);
      if (t === undefined) return { error: `That date doesn't exist: ${s}` };
      return finish(t, s);
    }
    const baseYear = dNow.getFullYear();
    // Try this year, then subsequent years (handles Feb 29 in non-leap years).
    for (let dy = 0; dy <= 4; dy++) {
      const t = localAt(baseYear + dy, month, day, tod.hour, tod.minute);
      if (t !== undefined && t >= now + 60_000) return finish(t, s);
    }
    return undefined;
  }

  return undefined;
}

// The note the thread gets: "Hibernating until Saturday 1 November, 9 am."
export function hibernateNote(answer: WakeAnswer, said: string, timeZone: string, by?: 'agent'): string {
  const when = answer.until ? localWhen(Date.parse(answer.until), timeZone) : undefined;
  const latest = when ? `, or ${when} at the latest` : '';
  if (by === 'agent') {
    const head = answer.topic ? `Hibernating until ${answer.topic}${latest}.` : `Hibernating until ${when}.`;
    return `${head} The agent said "${cut(said.trim(), 120)}".`;
  }
  const head = answer.topic ? `Hibernating until you next talk about ${answer.topic}${latest}.` : `Hibernating until ${when}.`;
  return `${head} You said "${cut(said.trim(), 120)}".`;
}

// ---- The latest time passing (runner/hibernation.ts, wakeAtTime) ----
//
// A wait in words with a time as well ("…, or Sunday at the latest") whose
// time comes with nothing seen. Before 22 Nov 2026 it woke as a plain snooze
// does: in the inbox, unread, "Woke up after hibernating for 17 hours.",
// with no turn. A thread waiting on an email did that every morning, and its
// agent, asked why it had woken, couldn't say. Now the note says what it
// waited for and that the time ran out, the agent hears the same with the
// thread's next message, and a wait its own agent set gets a turn to check
// for itself, as it does when the librarian thinks the thing has happened.
//
// A check on a long thread costs a turn (about $1.50 on that one), so they
// are held to these, the only place the numbers are:
// - LATE_CHECKS_MAX in a row, counted since Mike last wrote to the thread.
//   At the next latest time after that it lands in his inbox with no turn,
//   saying how long it has waited and for what. Three, so that he hears
//   within a fortnight of a wait that began with a day.
// - Each sleep after a check lasts at least LATE_BACKOFF times the one
//   before it, up to LATE_SLEEP_MAX_MS: from a day, checks on days 1, 3 and
//   7, then his inbox on day 14. From the last sleep rather than fixed
//   days, so a wait of minutes ("or 10 minutes at the latest") keeps its
//   scale. The model's own latest time stands when it is later.
export const LATE_CHECKS_MAX = 3;
export const LATE_BACKOFF = 2;
export const LATE_SLEEP_MAX_MS = 7 * 86_400_000;

// The checks so far (ThreadRecord.lateChecks): how many in a row, how long
// the sleep before the last one was meant to be, and when the first of
// them began. `backOff`: the last check's message, while the sleep that
// follows it hasn't been set: a snooze in words at the end of that turn
// (or of one the runner carried it on with) is held to lateSleepMs. Only
// that one: it goes when a turn with new work in it ends
// (Runner.settleInstructionsNews), so a later wait with a short limit of
// its own keeps it (Gemini's and Codex's reviews, 22 Nov 2026).
export type LateChecks = { n: number; waitedMs: number; since: string; backOff?: string };

// What a thread whose time has come was waiting for, when that was more
// than the time: `by` as WakeWhen's, `latest` its snoozedUntil.
export type LateWait = { said: string; topic: string; by?: 'agent'; latest: number };

// A sleeping record's wait, if its time is the latest for a wait in words.
// A time alone, in words or not, is a plain snooze.
export function lateWait(rec: { wakeWhen?: WakeWhen; snoozedUntil?: string }): LateWait | undefined {
  const w: unknown = rec.wakeWhen;
  if (!w || typeof w !== 'object') return undefined;
  const { said, topic, pending, by } = w as Partial<WakeWhen>;
  if (pending || typeof said !== 'string' || typeof topic !== 'string' || !topic.trim()) return undefined;
  const latest = Date.parse(rec.snoozedUntil ?? '');
  if (Number.isNaN(latest)) return undefined;
  return { said, topic, ...(by === 'agent' ? { by } : {}), latest };
}

// The checks a record has had, or undefined for none it can count on.
export function lateChecksOf(rec: { lateChecks?: unknown }): LateChecks | undefined {
  const c = rec.lateChecks as Partial<LateChecks> | undefined;
  if (!c || typeof c !== 'object' || !Number.isSafeInteger(c.n) || c.n! < 1) return undefined;
  const waitedMs = typeof c.waitedMs === 'number' && Number.isFinite(c.waitedMs) ? c.waitedMs : 0;
  const since = typeof c.since === 'string' && !Number.isNaN(Date.parse(c.since)) ? c.since : new Date(0).toISOString();
  return { n: c.n!, waitedMs, since, ...(typeof c.backOff === 'string' && c.backOff ? { backOff: c.backOff } : {}) };
}

// The least the next sleep lasts, after a check that followed one this long.
export function lateSleepMs(waitedMs: number): number {
  const last = Number.isFinite(waitedMs) && waitedMs > 60_000 ? waitedMs : 60_000;
  return Math.min(last * LATE_BACKOFF, LATE_SLEEP_MAX_MS);
}

const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();

// The rest of the note it wakes with, after "Woke up after 18 hours: "
// (Runner.wake adds the full stop). `how`: its agent is being given a turn
// to check, or has had all its checks (`stopped`), or neither (Mike's own).
export function lateWhy(w: LateWait, timeZone: string, how?: 'checking' | { stopped: LateChecks; now: number }): string {
  const latest = `this was the latest it would wait (${localWhen(w.latest, timeZone)})`;
  if (w.by !== 'agent') return `you haven't talked about ${w.topic}, and ${latest}`;
  const head = `still no sign that ${w.topic}, and ${latest}`;
  if (how === 'checking') return `${head}. Its agent is checking for itself`;
  if (!how) return head;
  const { stopped, now } = how;
  const waited = Date.parse(stopped.since) > 0 && Date.parse(stopped.since) <= now ? `waited ${awayFor(now - Date.parse(stopped.since))} and ` : '';
  return `${head}. It has ${waited}checked ${stopped.n === 1 ? 'once' : `${stopped.n} times`} by itself, so it's here for you to decide: chase it, give up on it, or tell it to keep waiting`;
}

// The runner's message that starts an agent's check at its latest time.
// `check`: which one this is, from 1.
export function lateCheckPrompt(w: LateWait, timeZone: string, check: number): string {
  const said = oneLine(w.said);
  const count = check >= LATE_CHECKS_MAX
    ? `This is check ${check} of ${LATE_CHECKS_MAX}, the last Threadbear gives a wait by itself: snooze again and the next latest time puts the thread in the user's inbox with no turn, for them to decide.`
    : `This is check ${check} of ${LATE_CHECKS_MAX} Threadbear gives a wait by itself, each after a longer sleep than the last. After them the thread goes to the user's inbox instead.`;
  return [
    `You hibernated this thread until: ${said}`,
    `Threadbear woke it because ${localWhen(w.latest, timeZone)} was the latest it would wait, and nothing it has seen says that has happened (${w.topic}). It only sees what other threads show, so check the work itself. If it has happened, carry on with what you meant to do. If it hasn't and waiting longer is still right, call end_turn with needs "nothing" and snooze "${said.replace(/"/g, "'")}" to go back to sleep (leave out any time in those words that has now passed), and say in a line what's still missing. If it now looks like it never will, or the user should chase it, end the turn with no snooze and needs "you", asking them what to do, so it stays in their inbox.`,
    count,
  ].join('\n\n');
}

// What the agent is told with the thread's next message about a wake at its
// latest time (Runner.takeWakeNews): the note is only for Mike, and asked
// "why did this wake?" the agent had nothing to go on. `how`: no turn ran,
// as it had had all its checks (`stopped`) or was Mike's own; or it was
// sent a check ('checking'), which says it all itself, so this goes only
// with another message, ending LATE_CHECK_QUEUED or LATE_CHECK_LOST.
export function lateNews(w: LateWait, timeZone: string, now: number, how?: 'checking' | { stopped: LateChecks }): string {
  const when = localWhen(now, timeZone);
  const latest = `${localWhen(w.latest, timeZone)} was the latest it would wait`;
  if (w.by !== 'agent') return `Note from Threadbear: this thread woke by itself on ${when}, and no turn ran. The user had hibernated it until they next talked about ${w.topic} (they said "${cut(oneLine(w.said), 120)}"). They hadn't, and ${latest}.`;
  const why = `You had hibernated it until: ${oneLine(w.said)} (${w.topic}). Nothing Threadbear saw says that has happened, and ${latest}.`;
  if (how === 'checking') return `Note from Threadbear: this thread woke by itself on ${when}. ${why}`;
  const head = `Note from Threadbear: this thread woke by itself on ${when}, and no turn ran. ${why}`;
  return how ? `${head} It had already woken you ${how.stopped.n === 1 ? 'once' : `${how.stopped.n} times in a row`} to check, so this time it went to the user's inbox for them to decide what next.` : head;
}

// The same for a check the librarian's guess started (Runner.wakeForTopic):
// another thread looked to show that what its agent waits for has happened.
export function topicCheckNews(w: { said: string; topic: string }, timeZone: string, now: number): string {
  return `Note from Threadbear: this thread woke by itself on ${localWhen(now, timeZone)}. You had hibernated it until: ${oneLine(w.said)} (${w.topic}). Another thread looked to show that has happened, which is a guess from reading one thread.`;
}

// How news of a check ends: its message is still waiting its turn behind
// this one (so the agent doesn't check twice), or it never got through.
export const LATE_CHECK_QUEUED = 'A message asking you to check for yourself is waiting its turn and comes after this one, so leave the check to it.';
export const LATE_CHECK_LOST = "It sent you a message to check for yourself. If that hasn't reached you, or the turn it started didn't finish, do that check now as well.";

// How long a completed turn's news of a wake is kept to tell a fresh
// session (a move to another login, a lost session): after that, why it
// woke is no longer a question anyone is asking.
export const LATE_NEWS_KEPT_MS = 3 * 86_400_000;

// How long a thread was away, for the note it wakes with: "5 minutes",
// "an hour", "3 hours", "a day", "12 days". Rounded, as Mike only wants
// a feel for it.
export function awayFor(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? 'a minute' : `${minutes} minutes`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return hours === 1 ? 'an hour' : `${hours} hours`;
  const days = Math.round(ms / 86_400_000);
  return days === 1 ? 'a day' : `${days} days`;
}

// "Thursday 29 October 2026, 2:05 pm"
function localNow(now: number, timeZone: string): string {
  return new Date(now).toLocaleString('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

// "Saturday 1 November, 9 am"; "9:30 am" when it isn't on the hour.
export function localWhen(t: number, timeZone: string): string {
  const d = new Date(t);
  const day = d.toLocaleDateString('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).replace(',', '');
  const time = d.toLocaleTimeString('en-GB', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).replace(':00', '').replace(/\s?([ap])\.?m\.?/i, ' $1m');
  return `${day}, ${time}`;
}

const cut = (t: string, n: number) => (t.length > n ? t.slice(0, safeEnd(t, n)) + '…' : t);

function parseObject(text: string): Record<string, unknown> | undefined {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const v = JSON.parse(t.slice(start, end + 1)) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
