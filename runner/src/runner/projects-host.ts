// What projects.ts and the librarian read and change through the Runner: thread records, gists and edits.
// Part of the Runner (runner.ts), split out on 4 Nov 2026 as a plain move so a
// fork's change to one area doesn't clash with another's. Each method's `this`
// is the Runner; runner.ts puts them on its prototype.
import type { Runner } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { ThreadSummary } from '../protocol.ts';
import { ErrorCode, RpcError } from '../protocol.ts';
import type { ThreadRecord } from '../store.ts';
import { cutOut } from '../store.ts';

export const projectsHostPart = {
  // Every thread's record, put away ones included. Read only.
  threadRecords(this: Runner): ThreadRecord[] {
    return [...this.threads.values()].filter((t) => !t.rt.deleted).map((t) => t.rec);
  },

  // A thread id from a full id or unique prefix; -32004 otherwise.
  resolveThread(this: Runner, idOrPrefix: string): string {
    const t = typeof idOrPrefix === 'string' && idOrPrefix ? this.findThread(idOrPrefix) : undefined;
    if (!t) throw new RpcError(ErrorCode.threadNotFound, `Thread not found: ${idOrPrefix}`);
    return t.id;
  },

  // Changes a thread's record for projects.ts, saves it and sends its
  // summary; `note` goes in the transcript. The agent hears about a new
  // project with its next message (projectNews).
  editThread(this: Runner, threadId: string, edit: (rec: ThreadRecord) => void, say: { note?: string } = {}): ThreadSummary {
    const st = this.mustGet(threadId);
    edit(st.rec);
    if (say.note) this.emit(st, { type: 'system.note', text: say.note }, st.rt.turn?.turnId);
    this.markDirty(st);
    return this.summary(st);
  },

  // Sends these threads' summaries again; their patches are read again on
  // the way, since a project's folders may have changed.
  touchThreads(this: Runner, threadIds: string[]): void {
    this.forgetFolders();
    for (const id of threadIds) {
      const st = this.threads.get(id);
      if (!st) continue;
      if (st.rt.patches) st.rt.patches.at = -Infinity;
      this.markDirty(st);
    }
  },

  // The first user message and the last few messages of a thread, as plain
  // text, for the librarian.
  // `images` counts what a message had attached: the librarian only gets the
  // words, so it has to know when they're pointing at a picture.
  threadGist(this: Runner, threadId: string, opts: { recent?: number; chars?: number } = {}): { first?: string; firstImages?: number; recent: { who: 'user' | 'assistant'; text: string; images?: number }[] } {
    const st = this.mustGet(threadId);
    const chars = opts.chars ?? 600;
    const cut = (t: string) => (t.length > chars ? t.slice(0, chars) + '…' : t);
    const opening = this.opening(st.rec.id, st.rec);
    const first = opening.text;
    const log = this.store.log(st.rec.id);
    const recent: { who: 'user' | 'assistant'; text: string; images?: number }[] = [];
    const want = opts.recent ?? 6;
    // Back from the end a page at a time until there are enough.
    for (let to = log.lastSeq; to >= 1 && recent.length < want; to -= 200) {
      const page = log.read(Math.max(1, to - 199), to);
      for (const e of page.reverse()) {
        if (recent.length >= want) break;
        if (cutOut(st.rec, e.seq)) continue;
        // From the phone is still Mike talking.
        if (e.type === 'user.message' && (e.origin === undefined || e.origin === 'phone')) recent.unshift({ who: 'user', text: cut(e.text), ...(e.images?.length ? { images: e.images.length } : {}) });
        else if (e.type === 'assistant.text' && e.text.trim()) recent.unshift({ who: 'assistant', text: cut(e.text) });
      }
    }
    return { first: first ? cut(first) : undefined, ...(opening.images ? { firstImages: opening.images } : {}), recent };
  },

  // The seq ranges edits cut out of the thread (docs/protocol/threads.md, "Editing
  // a message").
  cuts(this: Runner, threadId: string): { from: number; to: number }[] {
    return [...(this.mustGet(threadId).rec.rewinds ?? [])];
  },

  // What a thread has said since `seq`: how much of Mike's and the
  // agent's text, and whether any of it has a link. The librarian skips a
  // catch-up look when there's little.
  threadSince(this: Runner, threadId: string, seq: number): { chars: number; links: boolean } {
    const st = this.mustGet(threadId);
    const log = this.store.log(st.rec.id);
    let chars = 0;
    let links = false;
    for (let from = seq + 1; from <= log.lastSeq; from += 500) {
      for (const e of log.read(from, Math.min(log.lastSeq, from + 499))) {
        if (cutOut(st.rec, e.seq)) continue;
        const text = e.type === 'user.message' && (e.origin === undefined || e.origin === 'phone') ? e.text : e.type === 'assistant.text' ? e.text : '';
        chars += text.trim().length;
        if (!links && /https?:\/\//.test(text)) links = true;
      }
    }
    return { chars, links };
  },
};

export type ProjectsHostPart = RunnerPart<typeof projectsHostPart>;
