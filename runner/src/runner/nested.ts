// Nested threads (experiment nestedThreads; docs/protocol/threads.md, "Nested
// threads"): the runner's half. The sidebar's half (threads under the one
// that started them) is the GPUI app's.
//
// Mike, 13 Nov 2026, of "GPUI Port Coordinator": in 24 hours it woke 79
// times for reports from threads it had started, 47 of them only to retell
// a report to him. He chose "only at the end": a starter wakes once, when
// the threads it started have all finished, or as soon as one fails.
//
// So an agent's send_message to the thread that started it is held while
// the starter is between turns and any thread it started is still working
// (the sender is, as it's mid-turn), and the held reports go to it together
// once none is. Each method's `this` is the Runner; runner.ts puts them on
// its prototype.
import type { Runner, SendOptions, ThreadState } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { ImageRef } from '../protocol.ts';
import { AGENT_MESSAGE_PREFIX } from '../protocol.ts';
import { experimentOn } from '../experiments.ts';
import { lowerMode } from '../access.ts';

export const NESTED_THREADS = 'nestedThreads';

// What the starter is handed with the reports (deliverHeld, and with a
// wait's wake in hibernation.ts).
export const HELD_HEAD = 'While the threads you started were working, they sent you these. Threadbear kept them until they had all finished, so they come together:';

// The thread an agent message is from, by the id in its first line:
// `[Sent by the agent in the thread "<title>" (<id8>)]`. Read from the text
// rather than passed along, so it holds across a handover and the backend
// as the words do. Someone could write that line by hand; the worst it does
// is hold their message until the starter's threads finish.
export function senderPrefix(text: string): string | undefined {
  if (!text.startsWith(AGENT_MESSAGE_PREFIX)) return undefined;
  const line = text.slice(0, text.indexOf('\n') < 0 ? text.length : text.indexOf('\n'));
  return /\(([0-9a-f]{8})\)\]$/.exec(line)?.[1];
}

export const nestedPart = {
  // The threads `st` started that sit under it: started by its agent, not
  // detached, and not archived or deleted.
  nestedChildren(this: Runner, st: ThreadState): ThreadState[] {
    const out: ThreadState[] = [];
    for (const t of this.threads.values()) {
      const by = t.rec.startedBy;
      if (t.rt.deleted || t.rec.archivedAt || t.rec.detached || by?.kind !== 'thread' || by.threadId !== st.rec.id) continue;
      out.push(t);
    }
    return out;
  },

  // In a turn, about to start one, or with work of its own still going (a
  // background job or a sub-agent whose end starts its next turn). Waiting
  // on Mike, on a card or on other threads isn't working.
  stillWorking(this: Runner, t: ThreadState): boolean {
    return Boolean(t.rt.turn) || t.rec.queue.length > 0 || t.rt.tasks.length > 0 || Boolean(t.rec.subagents?.some((a) => a.status === 'running'));
  },

  // Called by send before anything else: true if the message was kept for
  // later rather than sent.
  holdReport(this: Runner, st: ThreadState, text: string, images: ImageRef[], opts: SendOptions): boolean {
    if (opts.origin || images.length || !experimentOn(this.cfg.home, NESTED_THREADS)) return false;
    const id8 = senderPrefix(text);
    if (!id8) return false;
    const hits = [...this.threads.values()].filter((t) => !t.rt.deleted && t.rec.id.startsWith(id8));
    const child = hits.length === 1 ? hits[0] : undefined;
    const by = child?.rec.startedBy;
    if (!child || child.rec.detached || by?.kind !== 'thread' || by.threadId !== st.rec.id) return false;
    // In a turn already: it goes into it, as any message would, at no cost.
    if (st.rt.turn || st.rec.queue.length || st.rt.deleted) return false;
    if (!this.nestedChildren(st).some((t) => this.stillWorking(t))) return false;
    // Its ceiling (runner/ceiling.ts): send_message let it reach the starter
    // as it is now (with no card, the starter had no more than the sender;
    // with one, Mike allowed it at the starter's access). Raised above that
    // before it's passed on, Mike reads it instead, unless its sender has
    // been raised as far (Daybreak finding 164).
    const ceiling = opts.ceiling ? lowerMode(opts.ceiling, this.agentCeiling(st)) : this.agentCeiling(st);
    (st.rec.heldReports ??= []).push({ from: child.rec.id, text, at: this.isoNow(), ceiling });
    this.markDirty(st);
    this.log.info('nested threads: held a report for the thread that started it', { threadId: st.rec.id, from: child.rec.id });
    return true;
  },

  // Something about the threads `starterId` started has changed (one's turn
  // ended, one was archived, detached or deleted). After the change has
  // settled (markFinished and the waits run later in completeTurn), so a
  // wake from waiting on them can carry the reports instead (takeHeld).
  settleHeldSoon(this: Runner, starterId: string | undefined, urgent = false): void {
    if (!starterId) return;
    setImmediate(() => {
      try {
        this.settleHeld(starterId, urgent);
      } catch (e) {
        this.log.warn('nested threads: settling held reports failed', { threadId: starterId, error: String(e) });
      }
    });
  },

  // `urgent`: one of its threads failed or was stopped, so the starter
  // hears now.
  settleHeld(this: Runner, starterId: string, urgent = false): void {
    const st = this.threads.get(starterId);
    if (!st || st.rt.deleted || !st.rec.heldReports?.length || this.stopping) return;
    // Busy now (Mike wrote, a wait woke it): they go into its turn.
    const busy = Boolean(st.rt.turn) || st.rec.queue.length > 0;
    if (!busy && !urgent && this.nestedChildren(st).some((t) => this.stillWorking(t))) return;
    this.deliverHeld(st);
  },

  // The held reports, taken off the record, as one message's text: those
  // the starter may still hear (runner/ceiling.ts, mayPassOn), whose
  // ceiling it hasn't been raised above since, or whose sender has as much
  // access as it has now. The rest are Mike's to read, with a note. One
  // saved before ceilings (22 Nov 2026) has only the second.
  takeHeld(this: Runner, st: ThreadState): string | undefined {
    const held = st.rec.heldReports;
    if (!held?.length) return undefined;
    delete st.rec.heldReports;
    this.markDirty(st);
    const me = this.authorityNow(st.rec.id);
    const pass = held.filter((h) => this.mayPassOn(me, h.ceiling, h.from));
    const kept = held.filter((h) => !pass.includes(h));
    if (kept.length) {
      const names = [...new Set(kept.map((h) => this.threads.get(h.from)?.rec.title ?? h.from.slice(0, 8)))].map((t) => `"${t}"`).join(', ');
      const one = kept.length === 1;
      this.withhold(
        st,
        'the threads it started reported back',
        `${one ? 'A report' : `${kept.length} reports`} from ${names}, a thread it started, ${one ? "wasn't" : "weren't"} passed to this thread's agent: this thread has more access now than it had when ${one ? 'it was' : 'they were'} sent. Read ${one ? 'it' : 'them'} in that thread, and send a message here to carry on.`,
      );
      this.log.info('nested threads: held back reports from threads with less access', { threadId: st.rec.id, from: kept.map((h) => h.from) });
    }
    if (!pass.length) return undefined;
    return `${HELD_HEAD}\n\n${pass.map((h) => h.text).join('\n\n')}`;
  },

  deliverHeld(this: Runner, st: ThreadState): void {
    const text = this.takeHeld(st);
    if (!text) return;
    this.log.info('nested threads: passed on held reports', { threadId: st.rec.id });
    // Checked against its access now (takeHeld): raised again while this
    // waits in the queue, it's held back as it leaves.
    this.sendTo(st, text, [], { origin: 'runner', queue: true, wakeReason: 'The threads it started reported back', ceiling: this.authorityNow(st.rec.id).mode });
  },

  // At a start: anything held while the runner was down, whose threads
  // have since finished.
  settleAllHeld(this: Runner): void {
    for (const st of this.threads.values()) if (st.rec.heldReports?.length) this.settleHeldSoon(st.rec.id);
  },
};

export type NestedPart = RunnerPart<typeof nestedPart>;
