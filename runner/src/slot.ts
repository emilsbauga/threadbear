// A thread's worktree slot (docs/thread-worktrees.md): what the thread's
// record says of its worktree, as one state type with every move in
// `moveSlot`, and what a slot folder is on disk, read from one snapshot by
// `slotOnDisk`. Before 21 Nov 2026 the record's four fields (removedAt,
// cleanupOwed, spare, tornDownAt) and the worktree itself were written by
// hand at fourteen sites in runner.ts and its parts, and "whose is this
// slot" was worked out again from git at each place that asked.
//
// Two halves, as a slot's truth is in two places:
//
// - The record (stored, in thread.json, handed over and moved with the
//   thread, and read by older runners and forks): `slotOf` reads the
//   fields as a Slot, `slotFields` writes one back, and every write to them
//   goes through `writeSlot(holder, event, now)`, the only writer, which
//   slot.test.ts holds the rest of runner/src to. Reads that just want one
//   field stay on the field (`w && !w.removedAt` is "the thread's own").
// - The folder (git's worktree list, its lock, the borrow record and tb
//   land's marker in its git dir, and which records name it): `readSlots`
//   takes the snapshot, and `slotOnDisk` says what it is. Pure, so it can
//   be wrong by the time anything acts on it: everything that changes a
//   folder still checks it again just before (worktreeFolderNow in
//   worktrees.ts, `still` in borrows.ts), and nothing here replaces that.
//   What it gives is one answer, with names, to whose a folder is, where
//   each site used to have its own (spares, the borrow sweep).
//
// The record's states, and how a worktree moves between them:
//
//   none ──made──▶ held ──archived──▶ owed ──cleaned, it stays──▶ held
//                   │                  │       (work not on main: the
//                   │                  │        archived thread keeps it)
//                   │                  ├──cleaned, removed──▶ removed
//                   │                  └──cleaned, a spare or another's──▶ handedOn
//                   └──owe (a box's save holds it)──▶ owed
//   removed / handedOn ──made (a fresh one, brought back)──▶ held (or owed,
//                         archived again while it was made)
//   any ──foundGone (at start: its branch and folder went unrecorded)──▶
//         removed, or handedOn when its folder is another checkout's now
//   any ──arrived (a move or a box's restore brings the record)──▶ as it came
//
//   held      the thread's own: it works there (no removedAt, no cleanupOwed).
//             Archived with work that isn't on main, it stays held.
//   owed      archived (or held by a box's save): the cleanup is still to
//             run, by this runner once the CLI and hooks let go, or by the
//             next one (settleLostCleanups).
//   removed   the folder and branch went (removedAt).
//   handedOn  set aside as a spare, or found to be another checkout's
//             (removedAt and spare): brought back, the thread never goes
//             back in, whatever is at that path now.
//
// Marks every state with a worktree carries: tornDownAt, when the patch's
// teardown ran at the last archive (the next turn in it says so), and
// `stray`, any of the four fields as found that the state doesn't explain
// (cleanupOwed left on a removed one by an older settleLostCleanups, a
// non-boolean, an empty removedAt), kept until an event that writes that
// field does.
//
// Events, from where, and what each refuses (refused: the record is left
// as it was; the callers check first, so none is ever sent):
//
//   made        prepareWorktreeNow, a thread brought back to a removed one
//               (leaveRemovedWorktreeNow): `owed` when it's archived by then.
//               Refused while it has one (held or owed): that one would be
//               lost track of, a slot nobody frees.
//   arrived     a move placing the thread here (moves.ts), a box's restore
//               (box-save.ts): the record's worktree as it came, or none.
//   archived    Runner.update archiving: held → owed, the teardown due again.
//   owe         cleanUpWorktree while a box's save holds the thread.
//   tornDown    tearDownWorktree, once the teardown ran.
//   toldTornDown  tellTornDown, the next turn in it.
//   cleaned     cleanUpWorktree's result: removed, handed on, or it stays.
//   foundGone   settleLostCleanups: gone, or taken by another checkout.
//
// What isn't an event: the in-memory guards on the Runtime that keep two
// of these from running at once (rt.preparing while a worktree is made and
// set up, rt.cleaning while a cleanup runs, rt.archivePending until the
// CLI lets go), and the record's other worktree fields, written once when
// it's made (repo, mainCheckout, path, branch, base, keep, patchFile,
// movedIn, unvouched).
import fs from 'node:fs';
import path from 'node:path';
import { BORROW_FILE, BORROW_PREFIX, parseBorrower, type Borrower } from './borrows.ts';
import { listCheckouts, readPlainFile, realpath, SPARE, type Checkout, type WorktreeRecord } from './worktrees.ts';

export const SLOT_FIELDS = ['removedAt', 'cleanupOwed', 'spare', 'tornDownAt'] as const;
export type SlotField = (typeof SLOT_FIELDS)[number];
type Raw = Partial<Record<SlotField, unknown>>;

export type SlotMarks = {
  tornDownAt?: string;
  stray?: Raw;
};

export type Slot =
  | { kind: 'none' }
  | { kind: 'held'; marks: SlotMarks }
  | { kind: 'owed'; marks: SlotMarks }
  | { kind: 'removed'; at: string; marks: SlotMarks }
  | { kind: 'handedOn'; at: string; marks: SlotMarks };

export type SlotEvent =
  | { kind: 'made'; worktree: WorktreeRecord; owed: boolean }
  | { kind: 'arrived'; worktree?: WorktreeRecord }
  | { kind: 'archived' }
  | { kind: 'owe' }
  | { kind: 'tornDown' }
  | { kind: 'toldTornDown' }
  | { kind: 'cleaned'; removed: boolean; handedOn?: boolean }
  | { kind: 'foundGone'; taken: boolean };

export type SlotMove = { ok: true; slot: Slot; worktree?: WorktreeRecord } | { ok: false; reason: string };

// ---- Reading and writing the fields ----

// The fields, read as a Slot. Truthiness, as the code reading them always
// has: an empty removedAt is not removed. What the state wouldn't write
// back as it is goes in `stray`, so slotFields(slotOf(w)) is w's own.
export function slotOf(w: WorktreeRecord | undefined): Slot {
  if (!w) return { kind: 'none' };
  const raw = w as Raw;
  let slot: Slot;
  const marks: SlotMarks = typeof raw.tornDownAt === 'string' ? { tornDownAt: raw.tornDownAt } : {};
  if (raw.removedAt) slot = { kind: raw.spare ? 'handedOn' : 'removed', at: String(raw.removedAt), marks };
  else if (raw.cleanupOwed) slot = { kind: 'owed', marks };
  else slot = { kind: 'held', marks };
  const plain = slotFields(slot);
  const stray: Raw = {};
  for (const k of SLOT_FIELDS) if (k in raw && raw[k] !== plain[k]) stray[k] = raw[k];
  if (Object.keys(stray).length) marks.stray = stray;
  return slot;
}

// A Slot as the four fields, undefined where absent. Nothing for none.
export function slotFields(slot: Slot): Record<SlotField, unknown> {
  const out: Record<SlotField, unknown> = { removedAt: undefined, cleanupOwed: undefined, spare: undefined, tornDownAt: undefined };
  if (slot.kind === 'none') return out;
  out.tornDownAt = slot.marks.tornDownAt;
  switch (slot.kind) {
    case 'held':
      break;
    case 'owed':
      out.cleanupOwed = true;
      break;
    case 'removed':
      out.removedAt = slot.at;
      break;
    case 'handedOn':
      out.removedAt = slot.at;
      out.spare = true;
      break;
    default:
      return unreachable(slot);
  }
  return Object.assign(out, slot.marks.stray);
}

// ---- The moves ----

// The one place a Slot moves. Pure: `now` is the clock's time. A move to a
// new worktree (made, arrived) says which in `worktree`.
export function moveSlot(slot: Slot, e: SlotEvent, now: number): SlotMove {
  const iso = new Date(now).toISOString();
  switch (e.kind) {
    case 'made': {
      if (slot.kind === 'held' || slot.kind === 'owed') return no('the thread already has a worktree of its own');
      const fresh = slotOf(e.worktree);
      if (fresh.kind !== 'held') return no("a worktree just made is the thread's own");
      // Archived while it was being made: that archive didn't know of it.
      const next = e.owed ? settle({ kind: 'owed', marks: tornDown(fresh) }, slotFields(fresh), ['cleanupOwed']) : fresh;
      return { ok: true, slot: next, worktree: e.worktree };
    }
    case 'arrived':
      return e.worktree ? { ok: true, slot: slotOf(e.worktree), worktree: e.worktree } : { ok: true, slot: { kind: 'none' } };
    case 'archived':
      // No worktree, or removed or handed on already: nothing to clean up.
      if (slot.kind === 'none' || slot.kind === 'removed' || slot.kind === 'handedOn') return ok(slot);
      // Each archive tears down again: a thread brought back may have made
      // its things again since the last one.
      return ok(settle({ kind: 'owed', marks: {} }, slotFields(slot), ['cleanupOwed', 'tornDownAt']));
    case 'owe':
      if (slot.kind === 'none') return no('the thread has no worktree');
      if (slot.kind === 'removed' || slot.kind === 'handedOn') return no('its worktree has already gone');
      return ok(settle({ kind: 'owed', marks: tornDown(slot) }, slotFields(slot), ['cleanupOwed']));
    case 'tornDown':
    case 'toldTornDown': {
      if (slot.kind === 'none') return no('the thread has no worktree');
      const marks = e.kind === 'tornDown' ? { tornDownAt: iso } : {};
      return ok(settle({ ...slot, marks }, slotFields(slot), ['tornDownAt']));
    }
    case 'cleaned': {
      if (slot.kind === 'none') return no('the thread has no worktree');
      const before = slotFields(slot);
      // It stays: the thread's own still (archived, it keeps its work).
      if (!e.removed) return ok(settle(slot.kind === 'removed' || slot.kind === 'handedOn' ? slot : { kind: 'held', marks: tornDown(slot) }, before, ['cleanupOwed']));
      const handedOn = e.handedOn || Boolean(before.spare);
      return ok(settle({ kind: handedOn ? 'handedOn' : 'removed', at: iso, marks: tornDown(slot) }, before, ['cleanupOwed', 'removedAt', ...(e.handedOn ? (['spare'] as const) : [])]));
    }
    case 'foundGone': {
      if (slot.kind === 'none') return no('the thread has no worktree');
      const before = slotFields(slot);
      const handedOn = e.taken || Boolean(before.spare);
      return ok(settle({ kind: handedOn ? 'handedOn' : 'removed', at: iso, marks: tornDown(slot) }, before, ['removedAt', ...(e.taken ? (['spare'] as const) : [])]));
    }
    default:
      return unreachable(e);
  }
}

// The teardown mark a state carries on.
function tornDown(slot: Slot): SlotMarks {
  return slot.kind !== 'none' && slot.marks.tornDownAt !== undefined ? { tornDownAt: slot.marks.tornDownAt } : {};
}

// `next`, with each field the event doesn't write kept as it was in
// `before`: where next wouldn't write it the same, it goes in stray (an
// undefined there keeps it absent).
function settle(next: Slot, before: Record<SlotField, unknown>, written: readonly SlotField[]): Slot {
  if (next.kind === 'none') return next;
  const plain = slotFields({ ...next, marks: tornDownOnly(next.marks) } as Slot);
  const stray: Raw = {};
  for (const k of SLOT_FIELDS) if (!written.includes(k) && before[k] !== plain[k]) stray[k] = before[k];
  const marks = tornDownOnly(next.marks);
  return { ...next, marks: Object.keys(stray).length ? { ...marks, stray } : marks } as Slot;
}

function tornDownOnly(marks: SlotMarks): SlotMarks {
  return marks.tornDownAt !== undefined ? { tornDownAt: marks.tornDownAt } : {};
}

// Writes an event's move onto the record: the one writer of the thread's
// worktree and its four fields. `w` is the worktree the caller is working
// on, which may since have been replaced on the record (a slow cleanup's):
// its fields are written as they always were, on that object. Only fields
// that change are touched, so thread.json keeps its order.
export function writeSlot(holder: { worktree?: WorktreeRecord }, e: SlotEvent, now: number, w: WorktreeRecord | undefined = holder.worktree): SlotMove {
  const res = moveSlot(e.kind === 'made' || e.kind === 'arrived' ? slotOf(holder.worktree) : slotOf(w), e, now);
  if (!res.ok) return res;
  let target = w;
  if (e.kind === 'made' || e.kind === 'arrived') {
    if (res.worktree) holder.worktree = target = res.worktree;
    else {
      delete holder.worktree;
      return res;
    }
  }
  if (!target || res.slot.kind === 'none') return res;
  const fields = slotFields(res.slot);
  const out = target as unknown as Record<string, unknown>;
  for (const k of SLOT_FIELDS) {
    const v = fields[k];
    if (v === undefined) {
      if (k in out) delete out[k];
    } else if (out[k] !== v) out[k] = v;
  }
  return res;
}

// ---- The folder ----

// One checkout in <repo>-threads as it is right now, and the live thread
// records (no removedAt) that name its path.
export type SlotSnapshot = {
  path: string;
  // Its folder is there (git keeps a checkout registered after its folder
  // goes, until a prune).
  folder: boolean;
  branch?: string; // checked out; undefined when detached
  locked?: string; // git's lock reason, '' for a lock with none
  borrower?: Borrower; // borrow-worktree.sh's record in its git dir
  landing?: boolean; // tb land's group check left it detached at the stack
  records: { thread: string; branch: string; archived: boolean }[];
};

export type SlotOnDisk =
  // Locked by a cleanup or a give-back: the next new thread or borrow takes it.
  | { kind: 'spare' }
  // A thread's own, on its branch (archived: work it couldn't land, kept).
  | { kind: 'held'; thread: string; archived: boolean }
  // A thread's own, detached by a tb land killed in a group check: its next
  // tb land checks the branch out again.
  | { kind: 'landing'; thread: string }
  // borrow-worktree.sh's, on its thread/borrow-* branch (borrower: who, if it
  // says; borrows from before 17 Nov don't).
  | { kind: 'borrowed'; branch: string; borrower?: Borrower }
  // Detached and unlocked, no thread's: a spare claimed and never set up,
  // or a give-back stopped half way. The borrow sweep takes it back.
  | { kind: 'loose' }
  // On a thread/<id8> branch no record here holds: a thread deleted (or
  // moved away) with its work kept, or another runner's on this Mac.
  | { kind: 'leftBehind'; branch: string }
  // On some other branch, switched to by hand.
  | { kind: 'byHand'; branch: string }
  // A record says it's a thread's, but git says otherwise: the folder is on
  // another branch, or detached with no landing. The record missed hearing
  // it went (THREADBEAR-16), or someone switched it.
  | { kind: 'taken'; thread: string }
  // More than one live record names it: two threads think it's theirs.
  | { kind: 'twoHolders'; threads: string[] }
  // Locked for some other reason, by hand.
  | { kind: 'locked'; reason: string }
  // Registered, but the folder has gone.
  | { kind: 'missing' };

const THREAD_BRANCH = /^thread\/[0-9a-f]{8}$/;

// What a slot is, from its snapshot. The order matters: what git says of
// the folder first (gone, locked), then the records that claim it, then
// its branch.
export function slotOnDisk(s: SlotSnapshot): SlotOnDisk {
  if (!s.folder) return { kind: 'missing' };
  if (s.locked !== undefined) return s.locked === SPARE ? { kind: 'spare' } : { kind: 'locked', reason: s.locked };
  if (s.records.length > 1) return { kind: 'twoHolders', threads: s.records.map((r) => r.thread) };
  const rec = s.records[0];
  if (rec) {
    if (s.branch === rec.branch) return { kind: 'held', thread: rec.thread, archived: rec.archived };
    if (s.branch === undefined && s.landing) return { kind: 'landing', thread: rec.thread };
    return { kind: 'taken', thread: rec.thread };
  }
  if (s.branch === undefined) return { kind: 'loose' };
  if (s.branch.startsWith(BORROW_PREFIX)) return { kind: 'borrowed', branch: s.branch, ...(s.borrower ? { borrower: s.borrower } : {}) };
  if (THREAD_BRANCH.test(s.branch)) return { kind: 'leftBehind', branch: s.branch };
  return { kind: 'byHand', branch: s.branch };
}

// A thread's claim on a folder: its record's worktree, while it has one
// (no removedAt).
export type SlotClaim = { thread: string; path: string; branch: string; archived: boolean };

export type ReadSlot = { checkout: Checkout; admin?: string; snapshot: SlotSnapshot; is: SlotOnDisk };

// The one function that takes the snapshot: every checkout git lists in the
// repo's <repo>-threads folder, with what its git dir and the claims say.
// Reads only; no git beyond the list (`listed`, if the caller has it).
// undefined when git can't list them.
export async function readSlots(mainCheckout: string, claims: SlotClaim[], listed?: Checkout[]): Promise<ReadSlot[] | undefined> {
  const checkouts = listed ?? (await listCheckouts(mainCheckout));
  if (!checkouts) return undefined;
  const threads = realpath(path.join(path.dirname(mainCheckout), `${path.basename(mainCheckout)}-threads`));
  const byPath = new Map<string, SlotClaim[]>();
  for (const c of claims) {
    const p = realpath(c.path);
    byPath.set(p, [...(byPath.get(p) ?? []), c]);
  }
  const out: ReadSlot[] = [];
  for (const checkout of checkouts) {
    const real = realpath(checkout.path);
    if (path.dirname(real) !== threads) continue;
    const folder = isDir(checkout.path);
    const admin = folder ? gitDirOf(checkout.path) : undefined;
    const record = admin === undefined ? undefined : readPlainFile(path.join(admin, BORROW_FILE), 8192);
    const snapshot: SlotSnapshot = {
      path: checkout.path,
      folder,
      ...(checkout.branch !== undefined ? { branch: checkout.branch } : {}),
      ...(checkout.locked !== undefined ? { locked: checkout.locked } : {}),
      ...(record !== undefined ? { borrower: parseBorrower(record) } : {}),
      ...(admin !== undefined && fs.existsSync(path.join(admin, LANDING_MARKER)) ? { landing: true } : {}),
      records: (byPath.get(real) ?? []).map(({ thread, branch, archived }) => ({ thread, branch, archived })),
    };
    out.push({ checkout, ...(admin !== undefined ? { admin } : {}), snapshot, is: slotOnDisk(snapshot) });
  }
  return out;
}

// tb land's marker of a worktree it left detached at a group check's stack
// (worktrees.ts detachedMarker).
export const LANDING_MARKER = 'threadbear-land-checking.json';

// The claims of a set of thread records: each live worktree's.
export function claimsOf(records: Iterable<{ id: string; worktree?: WorktreeRecord; archivedAt?: string }>): SlotClaim[] {
  const out: SlotClaim[] = [];
  for (const r of records) {
    const w = r.worktree;
    if (w && !w.removedAt && typeof w.path === 'string') out.push({ thread: r.id, path: w.path, branch: w.branch, archived: Boolean(r.archivedAt) });
  }
  return out;
}

// The checkout's own git dir, from the .git file git wrote in it.
function gitDirOf(dir: string): string | undefined {
  const named = readPlainFile(path.join(dir, '.git'), 8192)?.split('\n').find((l) => l.startsWith('gitdir:'))?.slice('gitdir:'.length).trim();
  return named ? path.resolve(dir, named) : undefined;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function ok(slot: Slot): SlotMove {
  return { ok: true, slot };
}

function no(reason: string): SlotMove {
  return { ok: false, reason };
}

function unreachable(x: never): never {
  throw new Error(`Unknown slot event or state: ${JSON.stringify(x)}`);
}
