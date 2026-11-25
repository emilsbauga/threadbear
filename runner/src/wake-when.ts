// Wake when… (docs/protocol/settings.md, "Hibernate in words"): Mike says in his own
// words when a hibernating thread should come back ("at the weekend", "in
// a few weeks", "next time I talk about woodworking") and the strong model
// turns that into a time, a topic to listen for, or both. A time is an
// ordinary snoozedUntil; a topic is the librarian's to notice, in the next
// thread Mike talks about it in (librarian.ts).

import { trimEndOfOrSpace } from './linear-text.ts';
import { cutSafely, safeEnd } from './safe-cut.ts';

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
