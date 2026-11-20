// Moving a thread to another runner, on each runner (docs/protocol.md,
// "Moving a thread to another runner"). The backend's threadMoves rows say
// whose turn it is (convex/moves.ts); this watches the ones this runner is
// in and takes its step on each, so a restart carries on from the state:
//
//   S (has the thread)          T (takes it)
//   asking:   describe it   ->  plan where it goes, say ready
//   ready:    wait for the turn, freeze it
//   packing:  pack, seal, upload
//                               unpacking: download, open, place it beside
//                                          the live threads, then the switch
//                               claimed:   adopt it, say done
//   done:     put its copy away
//
// failed or cancelled before the switch: S unfreezes it, T throws its
// staging away. The runner-specific work is MovesHost's (runner/moves.ts).
import type { PackEntry } from './move-pack.ts';
import { archive, chunks, MAX_SEALED_BYTES, sealInfo, sha256, unarchive, biggest } from './move-pack.ts';
import { sealBytes } from './secrets.ts';
import { createHash, randomBytes } from 'node:crypto';
import { withoutCredentials } from './move-git.ts';

export type MoveState = 'asking' | 'ready' | 'packing' | 'unpacking' | 'claimed' | 'done' | 'failed' | 'cancelled';

// What S says about the thread, for T to plan from (moves:moveInfo).
export type MoveInfo = {
  title: string;
  cwd: string;
  home: string;
  provider: string;
  accountId: string;
  email?: string;
  model?: string;
  effort?: string;
  permissionMode: string;
  origin?: string;
  repoTop?: string;
  subdir?: string;
  worktree: boolean;
  sessionId?: string;
  schedules: number;
};

// A MoveInfo from what the thread's runner said (a `moves.preview` call
// over the relay, or the move's row as moves:moveInfo stored it), with only
// its own fields, each of the right type and size and with no control
// characters; undefined if a needed one is missing or any is malformed.
// That runner may be an extra Mac, and the backend isn't trusted to have
// checked the shape (Daybreak 136, 16 Nov 2026: planMove read the row's
// info as it came).
const INFO_CHARS = 4096;
export function moveInfoFrom(raw: unknown): MoveInfo | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  let bad = false;
  const s = (k: string) => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length > INFO_CHARS || /[\u0000-\u001f\u007f]/.test(v)) {
      bad = true;
      return undefined;
    }
    return v;
  };
  const title = s('title') ?? '';
  const cwd = s('cwd');
  const home = s('home');
  const provider = s('provider');
  const accountId = s('accountId');
  const permissionMode = s('permissionMode');
  if (!cwd || !home || !provider || !accountId || !permissionMode) return undefined;
  const info: MoveInfo = { title, cwd, home, provider, accountId, permissionMode, worktree: o.worktree === true, schedules: typeof o.schedules === 'number' && Number.isFinite(o.schedules) ? o.schedules : 0 };
  for (const k of ['email', 'model', 'effort', 'origin', 'repoTop', 'subdir', 'sessionId'] as const) {
    const v = s(k);
    if (v !== undefined) info[k] = v;
  }
  if (bad) return undefined;
  if (info.subdir !== undefined && cleanSubdir(info.subdir) === undefined) return undefined;
  return info;
}

// The thread's folder inside its repo, as the old runner says it: '' or
// plain names joined by `/`, never absolute, `.`, `..`, an empty or
// encoded one, or a backslash, so it can only name a folder under the
// repo it's joined to. Undefined if it isn't (Daybreak 136, 16 Nov 2026:
// `../../elsewhere` put the moved thread outside its repo).
export function cleanSubdir(subdir: string): string | undefined {
  if (subdir === '') return '';
  if (subdir.length > 1024 || subdir.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(subdir)) return undefined;
  const parts = subdir.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || /%(?:2e|2f|5c|00)/i.test(p))) return undefined;
  return subdir;
}

// What a move's preview showed, as one digest (docs/protocol.md, "Moving a
// thread to another runner", Preview binding): the thread, the runner it
// goes to, what was picked, the planning half of the old runner's
// description and the target's plan. The main Mac's runner works it out
// from the preview and puts it on the move (startMove's `expect`); the
// runner it goes to works it out again from the description it's given
// and its own plan, and refuses the move if the two differ, so the old
// runner can't describe one thing to the preview and another to the move
// (Daybreak 142, 16 Nov 2026).
export type MoveBindingPlan = { cwd?: string; accountId?: string; worktree?: boolean; clone?: string; cloneFrom?: string };
export function moveBinding(p: { threadId: string; to: string; cwd?: string; accountId?: string; info: MoveInfo; plan: MoveBindingPlan }): string {
  const i = p.info;
  const canonical = JSON.stringify([
    'threadbear-move-preview-1',
    p.threadId,
    p.to,
    p.cwd ?? null,
    p.accountId ?? null,
    // An empty field is the same as none: the backend leaves empty strings
    // out of the description on the move's row (convex/moves.ts
    // describedThread), while the preview's came over the relay with them,
    // so a thread at the top of its repo (subdir "") failed every move as
    // "changed since the Move sheet looked" (18 Nov 2026).
    [i.cwd, i.home, i.provider, i.email || null, (i.origin && withoutCredentials(i.origin)) || null, i.repoTop || null, i.subdir || null, i.worktree],
    [p.plan.cwd ?? null, p.plan.accountId ?? null, p.plan.worktree === true, p.plan.clone ?? null, p.plan.clone ? (p.plan.cloneFrom ?? null) : null],
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

// The binding of a plan the target made (MovePlan), as moveBinding takes it.
export function planBinding(plan: MovePlan): MoveBindingPlan {
  return { cwd: plan.cwd, accountId: plan.accountId, worktree: Boolean(plan.worktree), ...(plan.clone ? { clone: plan.clone.to, cloneFrom: plan.clone.url } : {}) };
}

// The runner `asked` names for move_thread: its id, its whole name, or a
// word in just one runner's name, or why none. A name is the runner's own
// word (another Mac's heartbeat sets it, and can change it while a card
// is up), so a word that's one runner's whole name and part of another's
// is ambiguous rather than the whole-name one: "cloud" with "Hetzner
// Cloud" and a runner that renamed itself "cloud" names neither. The move
// then goes by the id this picks, never the name again (security review,
// 10 Nov 2026).
export function pickRunner(asked: string, all: readonly { id: string; name: string }[]): { id: string; name: string } | { problem: string } {
  const want = asked.trim().toLowerCase();
  const byId = all.find((r) => r.id === asked.trim());
  if (byId) return byId;
  const matches = want ? all.filter((r) => r.name.toLowerCase().includes(want)) : [];
  const listed = all.map((r) => `${r.name} (${r.id})`).join(', ');
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) return { problem: `No runner called ${asked}. There are: ${listed}.` };
  return { problem: `${asked} could be ${matches.map((r) => `${r.name} (${r.id})`).join(' or ')}: name one by its id or its whole name, with no other runner's name containing it.` };
}

// The runner pickRunner chose, as the move goes: still there, under the
// name the card showed, or it throws and nothing moves.
export function stillRunner(runnerId: string, runnerName: string, all: readonly { id: string; name: string }[]): { id: string; name: string } {
  const to = all.find((r) => r.id === runnerId);
  if (!to) throw new Error(`The runner ${runnerName} (${runnerId}) isn't there any more, so the thread stays here.`);
  if (to.name !== runnerName) throw new Error(`The runner ${runnerId} is called ${to.name} now, not ${runnerName} as it was when the move was asked for, so the thread stays here. Ask again if it's still the one.`);
  return to;
}

// What T makes again of a moved thread's schedules (the bundle's
// schedules.json): only when and what each sends, to the moved thread.
// The bundle is the old runner's word, and that runner may be one of the
// owner's extra Macs, so nothing that runs or approves anything comes
// across: no shell check (Scheduler.create approves a check it's given
// without a card), no folder, login, model or mode (a schedule that sends
// to a thread runs on the thread's), no other runner. A check is set
// again on the runner that runs it, with its own card (security review,
// 10 Nov 2026). `dropped` counts the checks left off, for the thread's note.
export type MovedSchedule = { text: string; title?: string; cron?: string; at?: string; timezone?: string; paused?: boolean; createdBy?: string };
export function movedSchedules(raw: unknown, threadId: string): { schedules: MovedSchedule[]; dropped: number } {
  const schedules: MovedSchedule[] = [];
  let dropped = 0;
  for (const item of Array.isArray(raw) ? raw.slice(0, 100) : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const str = (k: string, max: number) => (typeof o[k] === 'string' && (o[k] as string).trim() && (o[k] as string).length <= max ? (o[k] as string) : undefined);
    if (o.check !== undefined || o.checkCard !== undefined) dropped++;
    const text = str('text', 100_000);
    const cron = str('cron', 200);
    const at = str('at', 100);
    if (!text || !cron === !at) continue;
    const title = str('title', 200);
    const timezone = str('timezone', 100);
    schedules.push({ text, ...(title ? { title } : {}), ...(cron ? { cron } : { at: at! }), ...(timezone ? { timezone } : {}), ...(o.paused === true ? { paused: true } : {}), ...(o.createdBy === threadId ? { createdBy: threadId } : {}) });
  }
  return { schedules, dropped };
}

// What the main Mac sends the runner a preview asks (threads.movePreview,
// a relay `moves.preview` call): only what planMove reads, and what a
// runner from before this needs to read it (moveInfoFrom wants a title,
// login and mode), scrubbed as sync scrubs. A relay command isn't scrubbed
// on its way (the phone's words go as typed), so this is where (security
// review, 10 Nov 2026).
export function previewInfo(info: MoveInfo, scrub: <T>(v: T) => T): Record<string, unknown> {
  const out: Record<string, unknown> = {
    title: '',
    cwd: info.cwd,
    home: info.home,
    provider: info.provider,
    accountId: info.accountId,
    permissionMode: info.permissionMode,
    worktree: info.worktree,
    schedules: 0,
    ...(info.email ? { email: info.email } : {}),
    ...(info.origin && withoutCredentials(info.origin) ? { origin: withoutCredentials(info.origin) } : {}),
    ...(info.repoTop ? { repoTop: info.repoTop } : {}),
    ...(info.subdir !== undefined ? { subdir: info.subdir } : {}),
  };
  return scrub(out);
}

// The previews the main Mac's runner has shown (the Move sheet, tb move,
// move_thread), by a one-use id threads.move takes: each remembers the
// thread, runner and picks it was asked with and the binding of what it
// showed (moveBinding), for ten minutes. `take` gives the binding once,
// for those same thread, runner and picks, or throws (Daybreak 142,
// 16 Nov 2026).
type Picks = { threadId: string; to: string; cwd?: string; accountId?: string };
export class MovePreviews {
  static readonly MS = 10 * 60_000;
  static readonly VOUCHED_MS = 24 * 60 * 60_000;
  private kept = new Map<string, Picks & { expect: string; at: number }>();
  // Bindings taken for a move, for a day, each for the one move that first
  // carries it (startedAs, or vouches): the ones a move coming to this
  // runner may carry. A cancelled move's binding under a new move's id is
  // no binding (security review, 17 Nov 2026).
  private taken = new Map<string, { at: number; moveId?: string }>();
  private now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  // A preview's answer as it goes back: a previewId when nothing in it
  // stops the move and it names the place and login, bound to `info` (the
  // description the target planned from).
  remember(picks: Picks, info: MoveInfo | undefined, answer: Record<string, unknown>): Record<string, unknown> {
    const { previewId: _theirs, ...out } = answer;
    const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const problems = Array.isArray(answer.problems) ? answer.problems : [];
    if (!info || problems.length || answer.checksPreview !== true || !text(answer.cwd) || !text(answer.accountId)) return out;
    const plan: MoveBindingPlan = { cwd: text(answer.cwd), accountId: text(answer.accountId), worktree: answer.worktree === true, ...(text(answer.clone) ? { clone: text(answer.clone), cloneFrom: text(answer.cloneFrom) ?? info.origin } : {}) };
    const expect = moveBinding({ ...picks, info, plan });
    for (const [id, v] of this.kept) if (this.now() - v.at > MovePreviews.MS) this.kept.delete(id);
    while (this.kept.size >= 200) this.kept.delete(this.kept.keys().next().value!);
    const previewId = randomBytes(16).toString('hex');
    this.kept.set(previewId, { ...picks, expect, at: this.now() });
    return { ...out, previewId };
  }

  take(previewId: string, picks: Picks): string {
    const seen = this.kept.get(previewId);
    this.kept.delete(previewId);
    if (!seen || this.now() - seen.at > MovePreviews.MS) throw new Error("That look at the move has run out or been used. Move it again to see where it would go now.");
    if (seen.threadId !== picks.threadId || seen.to !== picks.to || seen.cwd !== picks.cwd || seen.accountId !== picks.accountId) throw new Error('The move asked for differs from the one its preview showed. Move it again to see where it would go now.');
    for (const [e, t] of this.taken) if (this.now() - t.at > MovePreviews.VOUCHED_MS) this.taken.delete(e);
    while (this.taken.size >= 500) this.taken.delete(this.taken.keys().next().value!);
    this.taken.set(seen.expect, { at: this.now() });
    return seen.expect;
  }

  // The move a taken binding started (startMove's answer).
  startedAs(expect: string, moveId: string): void {
    const t = this.taken.get(expect);
    if (t && t.moveId === undefined) t.moveId = moveId;
  }

  vouches(expect: string, moveId: string): boolean {
    const t = this.taken.get(expect);
    if (!t || this.now() - t.at > MovePreviews.VOUCHED_MS) return false;
    // A move this runner takes in before startMove has answered is that one.
    t.moveId ??= moveId;
    return t.moveId === moveId;
  }
}

// Where T will run it (moves:moveReady).
export type MovePlan = {
  cwd: string; // the folder, or for a worktree the repo it's made from (+ subdir)
  accountId: string;
  worktree?: { repo: string; subdir: string };
  clone?: { url: string; to: string };
  // The folder the thread's own must stay inside, links followed: its
  // repo, Mike's pick, or the home folder (runner/moves.ts placeMove).
  within?: string;
  leftBehind: string[];
};

export type MoveRow = {
  moveId: string;
  threadId: string;
  from: string;
  to: string;
  state: MoveState;
  cwd?: string;
  accountId?: string;
  // What the preview showed (moveBinding), set by the main Mac's runner.
  expect?: string;
  info?: MoveInfo;
  plan?: MovePlan;
  key?: string;
  sha256?: string;
  bytes?: number;
  chunks?: number;
  note?: string;
  createdAt: number;
  updatedAt: number;
  frozenAt?: number;
};

// T's answer for the Mac's Move sheet (threads.movePreview): the folder
// and login it would use, its logins to pick from, what won't come, and
// what stops the move (empty when it can go). `worktree`: the thread gets
// a new worktree of its own in `cwd`'s repo; `clone`: that repo is cloned
// there first.
export type MovePreview = {
  cwd?: string;
  accountId?: string;
  accounts: { id: string; provider: string; title: string; email?: string }[];
  leftBehind: string[];
  problems: string[];
  worktree?: boolean;
  clone?: string;
  // The address it's cloned from, shown with `clone`.
  cloneFrom?: string;
  // The main Mac's runner's: Move passes it to threads.move, once, so the
  // move does what this showed or nothing (moveBinding).
  previewId?: string;
  // The target's own: it checks a move against its preview (mustMatchPreview).
  // The main Mac's runner gives no previewId without it, as a runner from
  // before that would do whatever the move's row said (security review,
  // 17 Nov 2026).
  checksPreview?: boolean;
};

// What ThreadSummary.moving says on S while it goes.
export type ThreadMoving = { moveId: string; to: string; toName: string; state: MoveState; note?: string };

export type MovesBackend = {
  // Every update of the moves this runner is in (moves:moves).
  watch(onMoves: (rows: MoveRow[]) => void, onError: (e: unknown) => void): () => void;
  call(fn: 'moveInfo' | 'moveReady' | 'moveFrozen' | 'moveChunkUrl' | 'movePacked' | 'moveChunks' | 'moveClaim' | 'moveDone' | 'moveFailed' | 'moveDropChunks', args: Record<string, unknown>): Promise<unknown>;
  upload(url: string, bytes: Buffer): Promise<string>;
  download(url: string): Promise<Buffer>;
};

export type MovesHost = {
  // S
  describe(threadId: string): Promise<MoveInfo | undefined>;
  idle(threadId: string): boolean;
  setMoving(threadId: string, moving: ThreadMoving | undefined): void;
  // Releases the thread's CLI and gathers what goes (its files, the
  // transcript, git work, schedules); `leftBehind` is what won't.
  pack(threadId: string, row: MoveRow): Promise<{ entries: PackEntry[]; leftBehind: string[] }>;
  putAway(threadId: string, row: MoveRow): Promise<void>;
  has(threadId: string): boolean;
  // T
  plan(row: MoveRow): Promise<MovePlan | { problem: string }>;
  // Places it beside the live threads (its staging folder, worktree, git
  // work and transcript), not yet one of them. Throws to fail the move.
  place(row: MoveRow, entries: PackEntry[]): Promise<void>;
  // After the switch: makes it one of this runner's threads. Idempotent.
  adopt(row: MoveRow): Promise<void>;
  // The move failed or was cancelled: what place() made goes.
  discard(row: MoveRow): Promise<void>;
  sealKey(): string;
  open(sealed: Buffer, info: string): Buffer;
  runnerName(runnerId: string): string;
};

export type MovesDeps = {
  self: () => string;
  backend: () => MovesBackend | undefined;
  host: MovesHost;
  log: { info(m: string, f?: Record<string, unknown>): void; warn(m: string, f?: Record<string, unknown>): void };
  // How often S looks again while a thread finishes its turn.
  idleCheckMs?: number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  // Every row as it's heard, for the main Mac to show a move coming to it of
  // a thread its sidebar lists as another runner's (main.ts remoteMoving).
  seen?: (row: MoveRow) => void;
  // On the main Mac's runner, which starts every move: whether it handed out
  // this binding itself (MovePreviews.vouches). The row's `expect` is the
  // backend's word like the rest of it, so a move coming here takes it only
  // as one of its own (security review, 17 Nov 2026).
  vouches?: (expect: string, moveId: string) => boolean;
};

const ENDED: MoveState[] = ['done', 'failed', 'cancelled'];
// A failed move's note stays on the thread this long.
export const FAILED_SHOWN_MS = 60_000;

export class Moves {
  private d: MovesDeps;
  private rows = new Map<string, MoveRow>();
  // Steps in flight, by move: one at a time each.
  private working = new Set<string>();
  // Moves whose row changed while a step ran: stepped again once it ends.
  private again = new Set<string>();
  // Steps done here (moveId:state), so an update that hasn't caught up yet
  // doesn't start the same one again.
  private done = new Set<string>();
  // Moves seen ended (done, failed, cancelled) or failed here: a row of one
  // later in an earlier state is the backend's word, and a move never comes
  // back from its end, so it's left alone (security review, 17 Nov 2026: a
  // cancelled move's row put back at unpacking).
  private ended = new Set<string>();
  private stop?: () => void;
  private idleTimer?: { cancel(): void };
  // Steps to try again (see `retry`), by move, with how many tries so far.
  private retries = new Map<string, { timer?: { cancel(): void }; tries: number }>();

  constructor(deps: MovesDeps) {
    this.d = deps;
  }

  start(): void {
    if (this.stop) return;
    const backend = this.d.backend();
    if (!backend) return;
    this.stop = backend.watch(
      (rows) => this.update(rows),
      (e) => this.d.log.warn('watching moves failed', { error: String(e) }),
    );
  }

  close(): void {
    this.stop?.();
    this.stop = undefined;
    this.idleTimer?.cancel();
    for (const r of this.retries.values()) r.timer?.cancel();
    this.retries.clear();
  }

  // Threads leaving this runner whose rows it must no longer write: past
  // the switch they're the other runner's. Only the thread's latest move
  // past its switch counts, so one moved away and back again is this
  // runner's again.
  gone(threadId: string): boolean {
    const last = this.lastSwitched(threadId);
    return !!last && last.from === this.d.self();
  }

  // A thread's latest move that got past its switch, of those heard of.
  private lastSwitched(threadId: string): MoveRow | undefined {
    let last: MoveRow | undefined;
    for (const m of this.rows.values()) {
      if (m.threadId !== threadId || (m.state !== 'claimed' && m.state !== 'done')) continue;
      if (!last || m.createdAt > last.createdAt) last = m;
    }
    return last;
  }

  // The move a thread here is in, for ThreadSummary.moving.
  movingOf(threadId: string): MoveRow | undefined {
    for (const m of this.rows.values()) if (m.threadId === threadId && !ENDED.includes(m.state)) return m;
    return undefined;
  }

  update(rows: MoveRow[]): void {
    // A move seen ended stays ended here, whatever a later row says (see
    // `ended`), so a cancel waiting on a step in flight isn't replaced.
    rows = rows.filter((r) => ENDED.includes(r.state) || !this.ended.has(r.moveId));
    for (const r of rows) this.rows.set(r.moveId, r);
    for (const r of rows) this.d.seen?.(r);
    for (const r of rows) void this.step(r);
  }

  private async step(row: MoveRow): Promise<void> {
    const me = this.d.self();
    const key = `${row.moveId}:${row.state}`;
    if (this.done.has(key)) return;
    if (ENDED.includes(row.state)) this.ended.add(row.moveId);
    else if (this.ended.has(row.moveId)) return;
    // A step is running: the row it's on may be stale by the time it ends
    // (cancelled while packing), and the backend says nothing more unless
    // the row changes again, so the newest one goes once it does.
    if (this.working.has(row.moveId)) {
      this.again.add(row.moveId);
      return;
    }
    this.working.add(row.moveId);
    try {
      if (row.from === me) await this.asSource(row);
      else if (row.to === me) await this.asTarget(row);
      this.done.add(key);
      this.retries.delete(row.moveId);
    } catch (e) {
      // Not yet (the turn isn't over, the thread isn't described): the
      // next update or look tries again.
      if (e instanceof Waiting) return;
      const note = e instanceof Error ? e.message : String(e);
      // T's adopt or done not going through after the switch, where there's
      // nothing to fail, and a move left claimed would keep the thread from
      // ever moving again: the same step again shortly (adopt can run
      // again), not the move given up.
      if (row.state === 'claimed') {
        this.d.log.warn('a move step will be tried again', { moveId: row.moveId, state: row.state, error: note });
        this.retry(row);
        return;
      }
      this.d.log.warn('a move step failed', { moveId: row.moveId, state: row.state, error: note });
      if (!ENDED.includes(row.state)) {
        this.ended.add(row.moveId);
        await this.backend()
          .call('moveFailed', { moveId: row.moveId, note })
          .catch((err) => this.d.log.warn("couldn't fail a move", { moveId: row.moveId, error: String(err) }));
      }
      this.done.add(key);
    } finally {
      this.working.delete(row.moveId);
      if (this.again.delete(row.moveId)) {
        const latest = this.rows.get(row.moveId);
        if (latest && latest.state !== row.state) void this.step(latest);
      }
    }
  }

  // The backend, with each call asked again while the backend says it's
  // being updated (a deploy's stepping stone, convex/stepping.ts: a minute
  // or so): only the call, so a step that has already uploaded a bundle or
  // placed a thread doesn't do it again (Codex's review).
  private over(moveId: unknown): boolean {
    const row = typeof moveId === 'string' ? this.rows.get(moveId) : undefined;
    return !!row && ENDED.includes(row.state);
  }

  private backend(): MovesBackend {
    const b = this.d.backend();
    if (!b) throw new Error("This runner isn't connected to Threadbear's backend.");
    return {
      ...b,
      call: async (fn, args) => {
        for (let tries = 1; ; tries++) {
          try {
            return await b.call(fn, args);
          } catch (e) {
            if (tries >= UPDATING_TRIES || !BEING_UPDATED.test(e instanceof Error ? e.message : String(e)) || this.over(args.moveId)) throw e;
            this.d.log.warn('the backend is being updated: asking again shortly', { fn });
            await new Promise<void>((done) => (this.d.setTimer ?? defaultTimer)(done, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (tries - 1))));
            // Ended while it waited (cancelled): its own row's step tidies up.
            if (this.over(args.moveId)) throw e;
          }
        }
      },
    };
  }

  private moving(row: MoveRow, note?: string): ThreadMoving {
    return { moveId: row.moveId, to: row.to, toName: this.d.host.runnerName(row.to), state: row.state, ...(note ? { note } : {}) };
  }

  private async asSource(row: MoveRow): Promise<void> {
    const { host } = this.d;
    const id = row.threadId;
    switch (row.state) {
      case 'asking': {
        if (row.info) return;
        const info = await host.describe(id);
        if (!info) throw new Error(`The thread isn't on ${host.runnerName(row.from)}.`);
        host.setMoving(id, this.moving(row));
        await this.backend().call('moveInfo', { moveId: row.moveId, info });
        return;
      }
      case 'ready': {
        host.setMoving(id, this.moving(row));
        if (!host.idle(id)) {
          this.lookAgain();
          throw new Waiting();
        }
        await this.backend().call('moveFrozen', { moveId: row.moveId });
        return;
      }
      case 'packing': {
        host.setMoving(id, this.moving(row));
        if (!row.key) throw new Error('The move has no key to seal to.');
        const { entries, leftBehind } = await host.pack(id, row);
        entries.push({ path: 'move.json', data: Buffer.from(JSON.stringify({ format: 'threadbear-move-1', moveId: row.moveId, threadId: id, from: row.from, fromName: host.runnerName(row.from), leftBehind })) });
        const sealed = sealBytes(row.key, archive(entries), sealInfo(row.moveId));
        if (sealed.length > MAX_SEALED_BYTES) throw new Error(`The thread is too big to move (${Math.round(sealed.length / 1024 / 1024)} MB, over 100): most of it is ${biggest(entries)}.`);
        const backend = this.backend();
        const ids: string[] = [];
        try {
          for (const part of chunks(sealed)) {
            const url = (await backend.call('moveChunkUrl', { moveId: row.moveId })) as string;
            ids.push(await backend.upload(url, part));
          }
          await backend.call('movePacked', { moveId: row.moveId, chunks: ids, sha256: sha256(sealed), bytes: sealed.length });
        } catch (e) {
          // The move ended meanwhile (the other runner failed it, say): the
          // main Mac's uploads have no record the backend's cleanup could
          // find, so it asks for them to go (a runner key's go with the move
          // by themselves; the backend refuses this for them).
          if (ids.length) await backend.call('moveDropChunks', { moveId: row.moveId, chunks: ids }).catch(() => undefined);
          throw e;
        }
        return;
      }
      case 'unpacking':
      case 'claimed':
        host.setMoving(id, this.moving(row));
        return;
      case 'done':
        // Not if it has come back since (a later move to here): heard again
        // after a restart, an old move's done would put the thread away.
        if (host.has(id) && this.lastSwitched(id)?.moveId === row.moveId) await host.putAway(id, row);
        return;
      case 'failed':
      case 'cancelled': {
        if (!host.has(id)) return;
        // Another move of the thread has started since (this one's step ran
        // late, after a wait): what the thread shows is that one's (Codex's review).
        const now = this.movingOf(id);
        if (now && now.moveId !== row.moveId) return;
        // A move that ended long ago (seen again after a restart) says nothing.
        if (Date.now() - row.updatedAt > FAILED_SHOWN_MS) host.setMoving(id, undefined);
        else {
          host.setMoving(id, this.moving(row, row.note));
          (this.d.setTimer ?? defaultTimer)(() => {
            if (this.movingOf(id) === undefined) host.setMoving(id, undefined);
          }, FAILED_SHOWN_MS);
        }
        return;
      }
    }
  }

  private async asTarget(row: MoveRow): Promise<void> {
    const { host } = this.d;
    switch (row.state) {
      case 'asking': {
        // S describes it first: the update that brings that tries again.
        if (!row.info) throw new Waiting();
        const plan = await host.plan(row);
        if ('problem' in plan) throw new Error(plan.problem);
        this.mustMatchPreview(row, plan);
        await this.backend().call('moveReady', { moveId: row.moveId, plan, sealKey: host.sealKey() });
        return;
      }
      case 'unpacking': {
        // Again before anything comes: placing plans afresh from the same
        // description (runner/moves.ts placeMove), never from the row's plan.
        const plan = await host.plan(row);
        if ('problem' in plan) throw new Error(plan.problem);
        this.mustMatchPreview(row, plan);
        const backend = this.backend();
        const urls = (await backend.call('moveChunks', { moveId: row.moveId })) as string[];
        const parts: Buffer[] = [];
        for (const url of urls) parts.push(await backend.download(url));
        const sealed = Buffer.concat(parts);
        if (row.sha256 && sha256(sealed) !== row.sha256) throw new Error("The moved thread's bundle didn't arrive whole.");
        const entries = unarchive(host.open(sealed, sealInfo(row.moveId)));
        // Cancelled while it downloaded: nothing placed.
        if (this.ended.has(row.moveId)) throw new Error('The move ended while its thread was on its way.');
        await host.place(row, entries);
        await backend.call('moveClaim', { moveId: row.moveId });
        return;
      }
      case 'claimed':
        await host.adopt(row);
        await this.backend().call('moveDone', { moveId: row.moveId });
        return;
      case 'failed':
      case 'cancelled':
        await host.discard(row);
        return;
      default:
        return;
    }
  }

  // The move does what its preview showed or nothing (moveBinding): the
  // description and this runner's plan from it, against the digest the
  // main Mac's runner put on the move. One with none was started by a
  // runner from before previews were bound, or not through a preview: it
  // fails, and Move asks again.
  private mustMatchPreview(row: MoveRow, plan: MovePlan): void {
    const info = moveInfoFrom(row.info);
    if (!info) throw new Error("The thread's runner didn't describe it properly, so it stays there.");
    if (!row.expect) throw new Error('The move was started without a preview, so the thread stays where it is. Move it again.');
    if (this.d.vouches && !this.d.vouches(row.expect, row.moveId)) throw new Error("This Mac's runner didn't start that move (or has restarted since), so the thread stays where it is. Move it again.");
    const now = moveBinding({ threadId: row.threadId, to: row.to, ...(row.cwd ? { cwd: row.cwd } : {}), ...(row.accountId ? { accountId: row.accountId } : {}), info, plan: planBinding(plan) });
    if (now !== row.expect) throw new Error('The thread or where it would go changed since the Move sheet looked, so it stays where it is. Move it again to see where it would go now.');
  }

  // While a thread finishes its turn: every few seconds, the moves waiting
  // on an idle thread are tried again.
  // The row's step again after a while, longer each time (20 s up to 5
  // minutes), while the row is still in that state.
  // A step that goes through forgets the tries (step).
  private retry(row: MoveRow): void {
    const r = this.retries.get(row.moveId) ?? { tries: 0 };
    r.timer?.cancel();
    r.tries++;
    r.timer = (this.d.setTimer ?? defaultTimer)(() => {
      r.timer = undefined;
      const latest = this.rows.get(row.moveId);
      if (latest && latest.state === row.state) void this.step(latest);
    }, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (r.tries - 1)));
    this.retries.set(row.moveId, r);
  }

  private lookAgain(): void {
    if (this.idleTimer) return;
    this.idleTimer = (this.d.setTimer ?? defaultTimer)(() => {
      this.idleTimer = undefined;
      for (const r of this.rows.values()) if (r.state === 'ready' && r.from === this.d.self()) void this.step(r);
    }, this.d.idleCheckMs ?? 3000);
  }
}

// What the backend says while a deploy's stepping stone has a machine off.
const BEING_UPDATED = /The backend is being updated/;
const RETRY_MS = 20_000;
const RETRY_MAX_MS = 5 * 60_000;
// 20 s, 40 s, 80 s, 160 s, then 5 minutes: about 20 minutes, far past a
// stepping stone's minute, before the step fails as any other error would.
const UPDATING_TRIES = 7;

// A step that can't be taken yet: not a failure.
class Waiting extends Error {
  constructor() {
    super('waiting');
  }
}

function defaultTimer(fn: () => void, ms: number): { cancel(): void } {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
}
