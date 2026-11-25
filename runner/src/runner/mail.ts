// The email watcher's hands on threads (experiment mailWatch, mail-watch.ts):
// which threads an email might be for, waking one that waits on it, and
// passing one along quietly for the agent's next turn. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner, ThreadState } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { MailThread } from '../mail-watch.ts';
import { cutSafely } from '../safe-cut.ts';

// Threads worked in this recently are offered to the model as ones an email
// might be about, as well as every one hibernating.
export const MAIL_RECENT_MS = 14 * 86_400_000;
// At most this many, the most recent first, so the prompt stays small.
export const MAIL_THREADS_MAX = 80;
// Emails held for one thread before the oldest go.
export const HELD_MAIL_MAX = 10;

export const HELD_MAIL_HEAD = '[Threadbear] Emails came in while this thread was idle that look to be about its work. Threadbear kept them for this turn rather than starting one. Use them if they matter here; nothing has been done about them yet.';

export const mailPart = {
  // Threads an email might be for: hibernating ones (with what they wait
  // for) and ones worked in lately. Never an archived or deleted one, or a
  // sample; MailWatch leaves out private folders'.
  mailThreads(this: Runner): MailThread[] {
    const now = this.clock.now();
    const out: (MailThread & { at: number })[] = [];
    for (const { rec, rt } of this.threads.values()) {
      if (rt.deleted || rec.archivedAt || rec.sample) continue;
      const at = Date.parse(rec.lastActivityAt ?? rec.updatedAt ?? '') || 0;
      const snoozed = this.bucket(rec) === 'snoozed';
      if (!snoozed && now - at > MAIL_RECENT_MS) continue;
      const waits = snoozed ? (rec.wakeWhen?.said ?? (rec.waitingOn?.length ? 'other threads to finish' : 'a time')) : undefined;
      out.push({
        id: rec.id,
        title: rec.title,
        ...(rec.brief?.text ? { brief: cutSafely(rec.brief.text.replace(/\s+/g, ' ').trim(), 240) } : {}),
        ...(snoozed ? { hibernating: true as const, waits } : {}),
        cwd: rec.cwd,
        at,
      });
    }
    out.sort((a, b) => Number(Boolean(b.hibernating)) - Number(Boolean(a.hibernating)) || b.at - a.at);
    return out.slice(0, MAIL_THREADS_MAX).map(({ at: _at, ...t }) => t);
  },

  // An email a hibernating thread was waiting on: it wakes, with the email,
  // and its agent checks it really is what it waited for. False if the
  // thread isn't hibernating any more (woken meanwhile, archived, gone).
  wakeForMail(this: Runner, threadId: string, text: string): boolean {
    const st = this.threads.get(threadId);
    if (!st || st.rt.deleted || st.rec.archivedAt || this.bucket(st.rec) !== 'snoozed') return false;
    const said = st.rec.wakeWhen?.said?.replace(/\s+/g, ' ').trim();
    this.wake(st, { why: 'an email came in that looks like what it was waiting for' });
    this.armSnoozeTimer();
    const back = said ? `call end_turn with needs "nothing" and snooze "${said.replace(/"/g, "'")}" to go back to sleep` : 'call end_turn with needs "nothing" and a snooze to go back to sleep';
    this.sendTo(
      st,
      `${said ? `You hibernated this thread until: ${said}\n\n` : ''}Threadbear's email watcher woke it because this email looks like what it was waiting for. That's a guess from the email alone, so check it really is. If it is, carry on with what you meant to do. If it isn't, ${back}, and say in a line what's still missing.\n\n${text}`,
      [],
      // Its agent's own snooze words come back with it: held to the access
      // it had as it wrote them (runner/ceiling.ts).
      { origin: 'runner', queue: true, wakeReason: 'An email it was waiting for came in', ...(said && this.snoozeCeiling(st, st.rec.wakeWhen) ? { ceiling: this.snoozeCeiling(st, st.rec.wakeWhen) } : {}) },
    );
    this.log.info('woke for an email', { threadId });
    return true;
  },

  // An email about a thread's work, for its agent's next turn, without
  // starting one. A note in the thread says so, so Mike sees it too.
  holdMail(this: Runner, threadId: string, text: string, line: string): boolean {
    const st = this.threads.get(threadId);
    if (!st || st.rt.deleted || st.rec.archivedAt) return false;
    const held = (st.rec.heldMail ??= []);
    held.push({ text, at: this.isoNow() });
    if (held.length > HELD_MAIL_MAX) held.splice(0, held.length - HELD_MAIL_MAX);
    this.emit(st, { type: 'system.note', text: `${line} Its agent reads it on the thread's next turn.` });
    this.markDirty(st);
    this.log.info('held an email for a thread', { threadId });
    return true;
  },

  // The held emails, taken off the record, to go before the next message
  // the agent reads (deliver).
  takeHeldMail(this: Runner, st: ThreadState): string | undefined {
    const held = st.rec.heldMail;
    if (!held?.length) return undefined;
    delete st.rec.heldMail;
    this.markDirty(st);
    return `${HELD_MAIL_HEAD}\n\n${held.map((h) => h.text).join('\n\n')}`;
  },
};

export type MailPart = RunnerPart<typeof mailPart>;
