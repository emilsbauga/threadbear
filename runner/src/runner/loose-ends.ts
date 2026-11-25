// Loose ends on the done card (loose-ends.ts;
// docs/protocol/threads.md, "Loose ends"). Checked when a turn ends with needs
// "nothing", and again when something they depend on may have moved: an
// action ran (Land), Mike opened the thread, or a thread it started
// finished a turn or was archived. Each method's `this` is the Runner;
// runner.ts puts them on its prototype.
import type { Runner, ThreadState } from '../runner.ts';
import type { RunnerPart } from './part.ts';
import type { LooseEnd } from '../protocol.ts';
import { WAIT_STATES } from '../wait-state.ts';
import { childLooseEnds, editedLooseEnds, runningLooseEnds, scheduleLooseEnds, worktreeLooseEnds, type ChildThread } from '../loose-ends.ts';

// Opening a thread checks again at most this often: a click between
// threads shouldn't run git each time.
const RECHECK_ON_OPEN_MS = 5_000;
// A thread hibernating to wait for its own landing is checked again this
// often, so it leaves Running soon after its commits reach main even when
// nothing wakes it (a detached tb land tells nobody).
export const WAITING_TO_LAND_RECHECK_MS = 5 * 60_000;

export const looseEndsPart = {
  // Whether the thread's last turn left a done card the check is for.
  looseEndsCard(this: Runner, st: ThreadState): number | undefined {
    const { rec } = st;
    if (rec.archivedAt || rec.turnId || rec.status === 'running' || rec.status === 'starting') return undefined;
    if (!rec.needs || rec.needs.needs !== 'nothing' || rec.needs.seq !== rec.lastTurnCompletedSeq) return undefined;
    return rec.needs.seq;
  },

  // What a finished thread has left open, as the done card lists it. Runs
  // git (and gh, for a pushed branch), so it takes a moment; throws if
  // one of those does.
  async gatherLooseEnds(this: Runner, st: ThreadState): Promise<LooseEnd[]> {
    const { rec } = st;
    const ends: LooseEnd[] = [];
    const w = rec.worktree;
    const own = w && !w.removedAt ? w : undefined;
    if (own) ends.push(...(await worktreeLooseEnds(own)));
    // What it changed anywhere else, and the commits it made there.
    this.catchUpHighlights(st);
    const hl = rec.highlights;
    const made = (hl?.items ?? []).filter((h) => h.kind === 'commit' && h.sha);
    const commits = made.filter((h) => !h.pushed).map((h) => h.sha!);
    const pushed = made.filter((h) => h.pushed).map((h) => h.sha!);
    ends.push(...(await editedLooseEnds(hl?.edited ?? [], commits, own?.path, { pushed, dirs: [rec.cwd] })));
    ends.push(...runningLooseEnds(this.background(st)));
    ends.push(...this.childEnds(st));
    ends.push(...scheduleLooseEnds(rec.id, this.schedulesFor?.(rec.id) ?? []));
    return ends;
  },

  // The threads it started that are still working or waiting on Mike.
  // Nothing here waits, so it's as things stand now.
  childEnds(this: Runner, st: ThreadState): LooseEnd[] {
    const children: ChildThread[] = [];
    for (const other of this.threads.values()) {
      const o = other.rec;
      if (o.startedBy?.threadId !== st.rec.id || o.archivedAt || other.rt.deleted) continue;
      const s = this.summary(other);
      // As its row has it: under Running is still working (a turn, a job,
      // waiting on other threads, to land or for the app), and a card, a
      // review or an ask is waiting on Mike (wait-state.ts).
      const state = s.waitState ?? 'done';
      const working = WAIT_STATES[state].section === 'running';
      children.push({ id: o.id, title: o.title, working, needsYou: state === 'card' || state === 'review' || state === 'needsYou' });
    }
    return childLooseEnds(children);
  },

  // Checks the thread's loose ends for its done card and puts them on its
  // summary. Quiet on failure: a card that says nothing is today's card.
  async checkLooseEnds(this: Runner, st: ThreadState): Promise<void> {
    const seq = this.looseEndsCard(st);
    if (seq === undefined) return;
    const { rec, rt } = st;
    const run = (rt.looseEndsRun ?? 0) + 1;
    rt.looseEndsRun = run;
    rt.looseEndsAt = this.clock.now();
    rt.looseEndsBusy = true;
    let ends: LooseEnd[];
    // Kept while it runs, so the quiet inbox's look at the same card
    // (runner/quiet-inbox.ts) reads this one's answer and git runs once.
    const gather = this.gatherLooseEnds(st);
    rt.looseEndsGather = gather;
    try {
      ends = await gather;
    } catch (e) {
      this.log.warn("couldn't check a thread's loose ends", { threadId: rec.id, error: String(e) });
      return;
    } finally {
      if (rt.looseEndsGather === gather) delete rt.looseEndsGather;
      if (rt.looseEndsRun === run) rt.looseEndsBusy = false;
    }
    // A newer check started, or the card it was for has gone.
    if (rt.deleted || rt.looseEndsRun !== run || this.looseEndsCard(st) !== seq) return;
    const before = rec.looseEnds;
    if (before && before.seq === seq && JSON.stringify(before.ends) === JSON.stringify(ends)) return;
    const unlanded = (list?: LooseEnd[]) => Boolean(list?.some((e) => e.kind === 'unlanded'));
    const landedNow = unlanded(before?.seq === seq ? before.ends : undefined) !== unlanded(ends);
    rec.looseEnds = { seq, ends, at: this.isoNow() };
    this.markDirty(st);
    // Its starter's card counts it as working while it waits to land, so
    // it hears when that starts or ends.
    if (landedNow && rec.snoozedUntil && rec.wakeWhen?.by === 'agent' && rec.wakeWhen.topic) this.recheckStarter(st);
  },

  // Again, if the thread already has a check for its card (so it's on and
  // the card is still there). `opened`: only if the last was a while ago.
  recheckLooseEnds(this: Runner, st: ThreadState | undefined, opened = false): void {
    if (!st || !st.rec.looseEnds || this.looseEndsCard(st) !== st.rec.looseEnds.seq) return;
    // Nor while one is still going: a slow git or gh would pile them up.
    if (opened && (st.rt.looseEndsBusy || this.clock.now() - (st.rt.looseEndsAt ?? 0) < RECHECK_ON_OPEN_MS)) return;
    void this.checkLooseEnds(st);
  },

  // Threads hibernating with their own agent's wake condition and commits
  // not on main yet: the sidebar has them under Running ("Waiting to
  // land"), so each is checked again in case the landing has happened.
  recheckWaitingToLand(this: Runner): void {
    for (const st of this.threads.values()) {
      const { rec } = st;
      if (rec.snoozedUntil && rec.wakeWhen?.by === 'agent' && rec.wakeWhen.topic && rec.looseEnds?.ends.some((e) => e.kind === 'unlanded')) this.recheckLooseEnds(st, true);
    }
  },

  // A thread that changed in a way its starter's card cares about.
  recheckStarter(this: Runner, st: ThreadState): void {
    const parent = st.rec.startedBy?.threadId;
    if (!parent) return;
    const up = this.threads.get(parent);
    this.recheckLooseEnds(up);
    // A finished helper held back only by threads it started goes once
    // they're done, if its card is still the one it finished with.
    if (up && up.rt.quietOnceChildrenDone !== undefined && up.rt.quietOnceChildrenDone === this.looseEndsCard(up)) void this.settleQuietly(up, false);
  },
};

export type LooseEndsPart = RunnerPart<typeof looseEndsPart>;
