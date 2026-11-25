// Small helpers for the messages a thread is sent and the titles it gets.
// Split out of runner.ts (24 Nov 2026) so its parts under runner/ can use them
// without importing runner.ts back (mikecann-lint's no-import-cycle).
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { DesignReview, EventBody, ImageRef, MessageOrigin, Question, ReviewDraft } from '../protocol.ts';
import { ErrorCode, LIMITS, RpcError, sentByAgent } from '../protocol.ts';
import type { QueuedSend } from '../store.ts';
import type { SendOptions } from '../runner.ts';
import { cutSafely, firstLineSafely, isSafeSlice, safeEndOfPartial } from '../safe-cut.ts';

export function isAutomaticInput(q: Pick<QueuedSend, 'origin' | 'retryAfterInterrupt'>): boolean {
  return q.origin === 'schedule' || q.origin === 'runner' || q.retryAfterInterrupt === true;
}

// A UUID-shaped id in the existing message/turn field, so it survives every
// runner handover and crash without adding metadata for clients to mirror.
export function scheduledMessageId(threadId: string, scheduleId: string, run: string): string {
  const hex = crypto.createHash('sha256').update(JSON.stringify([threadId, scheduleId, run])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// Typed by Mike, at the Mac or on his phone: not the runner's, a
// schedule's or an agent's (another thread's, or this one's own `then`
// from move_thread, which once stopped the turn that sent it on a move to
// another login).
export function fromMike(text: string, opts: SendOptions): boolean {
  if (opts.origin && opts.origin !== 'phone') return false;
  return !sentByAgent(text);
}

export function userMessage(msg: QueuedSend): EventBody {
  return {
    type: 'user.message',
    text: msg.text,
    images: msg.images,
    ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
    ...(msg.origin ? { origin: msg.origin } : {}),
    ...(msg.wakeReason ? { wakeReason: msg.wakeReason } : {}),
    ...(msg.scheduleId ? { scheduleId: msg.scheduleId } : {}),
    ...(msg.reviewId ? { reviewId: msg.reviewId, reviewResponse: msg.reviewResponse } : {}),
    ...(msg.answers?.length ? { answers: msg.answers } : {}),
    ...(msg.editOf ? { editOf: msg.editOf } : {}),
  };
}

export function checkImages(images: ImageRef[]): void {
  for (const img of images) {
    if (!img || typeof img.path !== 'string' || !fs.existsSync(img.path)) {
      throw new RpcError(ErrorCode.badParams, `Image not found: ${img?.path}`);
    }
  }
}

export function titleFrom(text: string): string {
  if (!(text ?? '').trim()) return 'Image';
  return firstLineSafely(text, LIMITS.titleChars);
}

// What the runner asks a small model for a thread's title. The examples
// do more than the rules: without them Haiku drifts into Title Case and
// sometimes describes the naming job itself.
export const TITLE_PROMPT = [
  'You name threads in Threadbear, an app for running AI agents, mostly for coding.',
  'Reply with the title only: 2 to 6 words saying what the thread is about.',
  'Sentence case: a capital for the first word and for names only. No quotes, no full stop, no dashes, no emoji.',
  'Never mention titles, threads or the person asking.',
  '',
  'Message: can you look at why the upload test keeps failing on CI',
  'Title: Fix the flaky upload test on CI',
  '',
  'Message: Hey, does the runner keep running even if we restart the UI?',
  'Title: Does the runner outlive the app',
  '',
  'Message: hello there',
  'Title: Hello',
].join('\n');

// A model's title, tidied: first line, no wrapping quotes or full stop,
// nothing after a dash. One that runs long (rambling, or cut off by the
// token limit) is no title at all, so the first line stays.
export function cleanTitle(text: string): string {
  let t = (text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  t = t.replace(/^(title:\s*)/i, '').split(/\s[—–-]\s/)[0];
  t = t.replace(/^\*+|\*+$/g, '').trim();
  // Quotes only when they wrap the whole title; ones inside it stay.
  if (/^(["'`]).*\1$/.test(t)) t = t.slice(1, -1);
  t = t.replace(/\.$/, '').trim();
  if (t.length > LIMITS.titleChars || t.split(/\s+/).length > 10) return '';
  // Each tidy-up (its first line, before a dash, without quotes or a full
  // stop) is a cut of the model's text: one through a secret is no title
  // (safe-cut.ts), and the thread keeps the one titleFrom made.
  const at = (text ?? '').indexOf(t);
  if (t && (at < 0 || !isSafeSlice(text, at, at + t.length))) return '';
  return t;
}

// The sidebar's "You: ..." line: what Mike last said to a thread, in one
// line. Not the runner's, a schedule's or another agent's messages, which
// he didn't write. A design review's reply is his words (reply, then
// notes), or which ones he picked, without the "Review: <title> (<id>)" heading.
export function askedLine(m: { text: string; origin?: MessageOrigin; reviewId?: string; reviewResponse?: ReviewDraft }, reviews?: DesignReview[], max = LIMITS.previewChars): string | undefined {
  if (!fromMike(m.text, m)) return undefined;
  let text = m.text;
  if (m.reviewId && m.reviewResponse) {
    const r = m.reviewResponse;
    const words = [r.reply, ...Object.values(r.notes)].filter(Boolean);
    const options = reviews?.find(v => v.id === m.reviewId)?.options ?? [];
    const picked = (r.pickedIds ?? (r.pickedId ? [r.pickedId] : [])).map(id => options.find(o => o.id === id)?.title).filter(Boolean);
    const marks = Array.isArray(r.marks) ? r.marks.length : 0;
    text = words.length ? words.join(' ') : picked.length ? `Picked ${picked.join(' + ')}` : r.none ? 'None of them' : marks ? `Marked ${marks === 1 ? 'a part' : `${marks} parts`}` : '';
  }
  return oneLine(text, max) || undefined;
}

export function oneLine(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  // Never through a secret: these lines go to Convex (safe-cut.ts).
  return cutSafely(s, max, '…');
}

// Maps answers keyed by question text, header or index to question text,
// which is what the CLI's AskUserQuestion expects.
export function matchAnswers(questions: Question[], answers: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  questions.forEach((q, i) => {
    const v = answers[q.question] ?? (q.header ? answers[q.header] : undefined) ?? answers[String(i)];
    if (typeof v === 'string') out[q.question] = v;
  });
  if (questions.length && Object.keys(out).length === 0) return null;
  return out;
}

// What the recap box says: the sentence on what the thread is for, on a line
// of its own above the librarian's bullets.
// The most setBrief keeps of each (runner/titles.ts). Before 10 Nov it cut
// both to 200 and 600 with a plain slice, and those records are still about.
export const RECAP_PURPOSE_CHARS = 199;
export const RECAP_BRIEF_CHARS = 600;
export function recapText(brief: { text: string; purpose?: string }): string {
  // An old purpose of 200 may have been cut partway through a secret whose
  // end (a URL's "@", a closing quote) was never kept, and mid-recap the
  // scrub can't tell. What's left of it can't be found either (a quoted
  // password with a space in it), so one that long is left out: a new one is
  // never more than 199 (Codex's review of Daybreak's 75). The brief comes
  // last, where the scrub's rules for a value cut off at the end apply, and
  // loses its last unseen run too, as text read up to a limit does.
  const purpose = brief.purpose && brief.purpose.length <= RECAP_PURPOSE_CHARS ? brief.purpose : '';
  const text = brief.text.length >= RECAP_BRIEF_CHARS ? brief.text.slice(0, safeEndOfPartial(brief.text, brief.text.length)).trimEnd() : brief.text;
  return purpose ? `${purpose}\n${text}` : text;
}
