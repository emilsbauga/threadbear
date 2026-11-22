// A box's save (docs/virtual-runners.md, decision 7; docs/protocol/boxes.md, "Box
// mode"): before its box sleeps or is archived, the backend sends the box's
// runner a `save` command, and the thread goes out of the box into Convex
// file storage. A new box for the thread restores it, so a box the provider
// loses loses nothing saved.
//
// What goes is what a move carries (runner/moves.ts packForMove, through
// the same move-pack.ts and move-git.ts): the thread's own folder in the
// data dir (its record and events), its Claude session's transcript, and
// its git work (the commits origin doesn't have, and one more of every
// uncommitted and untracked file), gzipped. Not the checkout itself: a new
// box clones the repo again and the git work goes on top, which keeps a
// save small. `.gitignore`d files (node_modules, build output) stay behind;
// the worktree's setup makes them again (Runner.setUpRestored).
//
// Sealed with AES-256-GCM under the thread's own key (handed only to boxes
// for that thread, by the boot exchange), bound to the thread's id. The
// spike proved the shape on Fly (runner/box/spike/box/lose.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archive, MAX_ENTRIES, readTree, safeEntryPath, treeStats, unarchive, unpackedSize, writeTree, type PackEntry } from './move-pack.ts';
import { packGit, underNodeModules, unpackGit, type GitMeta } from './move-git.ts';
import { paths } from './config.ts';
import { projectDirName, sessionTranscriptPath } from './transcripts.ts';
import { git, realpath, threadBranch } from './worktrees.ts';
import { writeSlot } from './slot.ts';
import type { ThreadRecord } from './store.ts';

// One upload: a box key's uploads are a runner key's, 10 MB at most
// (convex/sync.ts MAX_RUNNER_UPLOAD_BYTES). A save bigger than that, in
// parts as a move's chunks are, is a TODO (docs/virtual-runners.md).
export const SAVE_MAX_BYTES = 10 * 1024 * 1024;
// Unpacked, a save is held to this, by the box that writes it (before it's
// acknowledged) and the box that reads it (as it's gunzipped), the same
// number on both sides so a save one takes the other can read. A move may
// grow to 1 GB (move-pack.ts), but boxes are small: 1024 MB at the least
// (convex/boxes.ts setRunnerService). Writing a save holds about three
// copies of it unpacked (the files read, the archive, the read-back), and a
// restore one (gunzipped into one buffer, its files views of it), so 128 MB
// keeps the writer under 400 MB and the reader near 150 MB of the smallest box.
export const SAVE_MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
const SAVE_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// What the seal is bound to, so a save opens only as its own thread's.
function sealInfo(threadId: string): Buffer {
  return Buffer.from(`threadbear box save v1 ${threadId}`, 'utf8');
}

export function sealSave(threadKey: Buffer, threadId: string, plain: Buffer): Buffer {
  if (threadKey.length !== 32) throw new Error("The thread's key isn't 32 bytes.");
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', threadKey, iv);
  c.setAAD(sealInfo(threadId));
  return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
}

export function openSave(threadKey: Buffer, threadId: string, sealed: Buffer): Buffer {
  if (threadKey.length !== 32) throw new Error("The thread's key isn't 32 bytes.");
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error("The thread's save is too short to be one.");
  const d = crypto.createDecipheriv('aes-256-gcm', threadKey, sealed.subarray(0, IV_BYTES));
  d.setAAD(sealInfo(threadId));
  d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([d.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)), d.final()]);
  } catch {
    throw new Error("The thread's save doesn't open with its key: it's damaged, or another thread's.");
  }
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * The thread packed for a save: its folder, its transcript, its git work.
 * Installed packages (anything under node_modules), which a restore won't
 * bring in, are left out of the git work (the worktree's setup makes them
 * again, setUpRestored), and named in `leftOut`. Throws, before anything is
 * uploaded, for a save a restore would refuse: too many files, too big
 * unpacked, or a bundle that doesn't read back.
 */
// `limits`: smaller ones, for tests.
export type SaveLimits = { maxEntries?: number; maxUnpacked?: number };
export async function packSave(o: { home: string; claudeDir: string; rec: ThreadRecord; limits?: SaveLimits }): Promise<{ packed: Buffer; leftOut: string[] }> {
  const maxEntries = o.limits?.maxEntries ?? MAX_ENTRIES;
  const maxUnpacked = o.limits?.maxUnpacked ?? SAVE_MAX_UNPACKED_BYTES;
  const { rec } = o;
  // The reader's limits, checked from sizes on disk before anything is read
  // into memory: a save over them is refused without allocating it.
  const budget = { files: 1, bytes: 0, header: 64 }; // box.json, and the archive's own
  const add = (t: { files: number; bytes: number; header: number }) => {
    budget.files += t.files;
    budget.bytes += t.bytes;
    budget.header += t.header;
    if (budget.files > maxEntries) throw new Error(`The thread's save has more than ${maxEntries} files, more than a restore takes.`);
    if (budget.bytes + budget.header > maxUnpacked) throw new Error(`The thread's save is more than ${mb(maxUnpacked)} before it's compressed, more than a restore takes.`);
  };
  const threadDir = paths.thread(o.home, rec.id);
  add(treeStats(threadDir, 'thread', ['panels']));
  const sid = rec.nativeSessionId;
  const transcript = rec.provider === 'claude' && rec.sessionUsed && sid ? sessionTranscriptPath(o.claudeDir, rec.cwd, sid) : null;
  const transcriptDir = transcript && sid ? path.join(path.dirname(transcript), sid) : undefined;
  if (transcript && sid && transcriptDir) {
    add({ files: 1, bytes: fs.statSync(transcript).size, header: sid.length + 60 });
    add(treeStats(transcriptDir, `transcript/${sid}`));
  }
  const work = rec.worktree && !rec.worktree.removedAt ? rec.worktree.path : rec.cwd;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-save-'));
  let leftOut: string[] = [];
  const entries: PackEntry[] = [];
  try {
    const g = await packGit(work, rec.cwd, path.join(scratch, 'save.bundle'), { leaveOut: underNodeModules });
    if (!g.ok) throw new Error(`Couldn't save the thread's git work: ${g.reason}`);
    leftOut = g.leftOut ?? [];
    const meta = Buffer.from(JSON.stringify(g.meta));
    add({ files: g.bundle ? 2 : 1, bytes: meta.length + (g.bundle ? fs.statSync(g.bundle).size : 0), header: 120 });
    // Within budget: read.
    entries.push(...readTree(threadDir, 'thread', ['panels']));
    if (transcript && sid && transcriptDir) {
      entries.push({ path: `transcript/${sid}.jsonl`, data: fs.readFileSync(transcript) });
      entries.push(...readTree(transcriptDir, `transcript/${sid}`));
    }
    entries.push({ path: 'git/meta.json', data: meta });
    if (g.bundle) entries.push({ path: 'git/save.bundle', data: fs.readFileSync(g.bundle) });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  entries.push({ path: 'box.json', data: Buffer.from(JSON.stringify({ version: SAVE_VERSION, threadId: rec.id, savedAt: new Date().toISOString() })) });
  // The reader's limits, checked here first.
  if (entries.length > maxEntries) throw new Error(`The thread's save has ${entries.length} files, more than a restore takes (${maxEntries}).`);
  const size = unpackedSize(entries);
  if (size > maxUnpacked) throw new Error(`The thread's save is ${mb(size)} before it's compressed, more than a restore takes (${mb(maxUnpacked)}).`);
  const packed = archive(entries);
  // And read back as a restore will: never acknowledge a save it would refuse.
  checkRestorable(unarchive(packed, { maxUnpacked }), rec.id);
  return { packed, leftOut };
}

// What restoreSave needs before it changes anything, checked by the writer
// too: its manifest, the thread's record, and git work it can put back.
function checkRestorable(entries: PackEntry[], threadId: string): { rec: ThreadRecord & Record<string, unknown>; meta: GitMeta } {
  const json = (p: string): any => {
    const e = entries.find((x) => x.path === p);
    if (!e) return undefined;
    try {
      return JSON.parse(e.data.toString('utf8'));
    } catch {
      throw new Error(`The thread's save has a damaged ${p}.`);
    }
  };
  const box = json('box.json');
  if (!box || box.version !== SAVE_VERSION || box.threadId !== threadId) throw new Error("The save isn't one of this thread's that this runner can read.");
  const rec = json('thread/thread.json') as (ThreadRecord & Record<string, unknown>) | undefined;
  if (!rec || rec.id !== threadId) throw new Error("The save's thread record is missing or another thread's.");
  const meta = json('git/meta.json') as GitMeta | undefined;
  if (!meta) throw new Error("The save has no git work in it.");
  return { rec, meta };
}

// `rel` under `top`, or `top` when it's empty, leads out or isn't there.
function under(top: string, rel: string | undefined): string {
  if (!rel || !safeEntryPath(rel)) return top;
  const p = path.join(top, ...rel.split('/'));
  return fs.existsSync(p) ? p : top;
}

/**
 * Puts a save back in a new box: the thread's folder into the data dir, its
 * git work on top of `checkout` (a fresh clone of its repo on the base
 * branch), in a worktree again if it had one, and its transcript where
 * Claude Code looks for the folder it now runs in. Returns that folder.
 * The thread's record keeps its session id, so its next turn resumes the
 * same session.
 */
export async function restoreSave(o: { home: string; claudeDir: string; threadId: string; checkout: string; packed: Buffer; limits?: SaveLimits }): Promise<{ cwd: string; worktree: boolean }> {
  const entries = unarchive(o.packed, { maxUnpacked: o.limits?.maxUnpacked ?? SAVE_MAX_UNPACKED_BYTES });
  const { rec, meta } = checkRestorable(entries, o.threadId);
  const checkout = realpath(o.checkout);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-restore-'));
  let cwd: string;
  try {
    const bundle = entries.find((e) => e.path === 'git/save.bundle');
    const bundleFile = bundle ? path.join(scratch, 'save.bundle') : undefined;
    if (bundle && bundleFile) fs.writeFileSync(bundleFile, bundle.data);
    const w = rec.worktree && !rec.worktree.removedAt ? rec.worktree : undefined;
    if (w) {
      // In the same place a new thread's worktree would be (worktrees.ts
      // makeWorktree), under the folder name it had, on its own branch.
      const name = path.basename(w.path);
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) throw new Error("The save's worktree has a folder name this runner won't make.");
      const where = path.join(path.dirname(checkout), `${path.basename(checkout)}-threads`, name);
      const branch = threadBranch(o.threadId);
      fs.mkdirSync(path.dirname(where), { recursive: true });
      const add = await git(checkout, ['worktree', 'add', '-b', branch, where, 'HEAD']);
      if (!add.ok) throw new Error(`Couldn't make the thread's worktree again: ${add.stderr.trim().split('\n')[0] ?? 'git failed'}`);
      const r = await unpackGit(where, meta, bundleFile);
      if (!r.ok) throw new Error(r.reason);
      writeSlot(rec, { kind: 'arrived', worktree: { ...w, repo: path.basename(checkout), mainCheckout: checkout, path: where, branch } }, Date.now());
      cwd = under(where, meta.subdir);
    } else {
      const r = await unpackGit(checkout, meta, bundleFile);
      if (!r.ok) throw new Error(r.reason);
      writeSlot(rec, { kind: 'arrived' }, Date.now());
      cwd = under(checkout, meta.subdir);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  rec.cwd = cwd;
  const dir = paths.thread(o.home, o.threadId);
  writeTree(entries, 'thread', dir);
  fs.writeFileSync(path.join(dir, 'thread.json'), JSON.stringify(rec, null, 2));
  const transcript = entries.filter((e) => e.path.startsWith('transcript/'));
  if (transcript.length) writeTree(transcript, 'transcript', path.join(o.claudeDir, 'projects', projectDirName(realpath(cwd))));
  return { cwd, worktree: Boolean(rec.worktree) };
}

/**
 * The rule for a box's save (Codex's review, 19 Nov 2026): once a stopping
 * save has started, the thread runs nothing until the backend has said it
 * may, positively: a command other than a save taken after the save's
 * outcome is known, or a heartbeat sent after that finding the box awake
 * (and so still holding its key, or it would have been refused). Nothing
 * local lets it go: not a clock jump, a timeout or an error. An outcome
 * that can't be known (boxSaved's answer lost, every retry too) leaves it
 * held until the backend asks for another save.
 */
//
// It's kept on disk too (`persist`, box.json's `saveHold`), written before
// the thread is touched, so a runner that restarts mid-save, or after one
// whose outcome it never learned, starts held (`initial`): a heartbeat from
// the new process counts as after the outcome, as it is.
export type SaveHoldState = 'saving' | 'settled';
export class SaveHold {
  private state: 'free' | SaveHoldState;
  private settledAt = -Infinity;
  private readonly hold: () => void;
  private readonly release: () => void;
  private readonly now: () => number;
  private readonly persist: (state: SaveHoldState | undefined) => void;

  constructor(o: { hold: () => void; release: () => void; now?: () => number; initial?: SaveHoldState; persist?: (state: SaveHoldState | undefined) => void }) {
    this.hold = o.hold;
    this.release = o.release;
    this.now = o.now ?? (() => performance.now());
    this.persist = o.persist ?? (() => {});
    this.state = o.initial ?? 'free';
  }

  get held(): boolean {
    return this.state !== 'free';
  }

  get saving(): boolean {
    return this.state === 'saving';
  }

  begin(): void {
    this.persist('saving');
    this.state = 'saving';
    this.hold();
  }

  // The save's outcome is known: in, or refused, or never sent.
  settled(): void {
    if (this.state !== 'saving') return;
    this.persist('settled');
    this.state = 'settled';
    this.settledAt = this.now();
  }

  // A command taken (sync.ts SyncDeps.box.taken).
  taken(kind: string): void {
    if (kind !== 'save' && this.state === 'settled') this.free();
  }

  // A heartbeat's answer (sync.ts SyncDeps.box.heard), sent at `sentAt`.
  heard(state: string, sentAt: number): void {
    if (state === 'awake' && this.state === 'settled' && sentAt > this.settledAt) this.free();
  }

  private free(): void {
    this.persist(undefined);
    this.state = 'free';
    this.release();
  }
}

const kindOf = (e: unknown): unknown => (e as { data?: { kind?: unknown } } | null)?.data?.kind;

/**
 * The `save` command (docs/protocol/boxes.md, "Box mode"): the thread stopped
 * (Runner.quiesceForSave), packed, sealed, uploaded through the box key's
 * upload URL (sync:iconUploadUrl) and named in boxes:boxSaved, which
 * replaces the last save. A save past one upload fails the command, saying
 * so. A boxSaved whose answer doesn't come (the network, not a refusal) is
 * sent again with the same file, which the backend takes as the same save,
 * until it answers or `retryForMs` is up; then the outcome is unknown and
 * the thread stays held (SaveHold).
 */
export async function saveThread(o: {
  home: string;
  claudeDir: string;
  threadId: string;
  threadKey: Buffer;
  boxKey: string;
  // The thread stopped and its record written out (Runner.quiesceForSave):
  // nothing changes its folder from here.
  quiesce: (threadId: string) => Promise<ThreadRecord>;
  hold: SaveHold;
  // Before boxSaved: what the thread's stop wrote (its notes, its row) goes
  // up first, all of it (ConvexSync.flushAll), so nothing sent after the
  // save marks the box as working again; if it can't, the save fails.
  beforeSaved?: () => Promise<void>;
  post: (kind: 'mutation', fn: string, args: Record<string, unknown>) => Promise<unknown>;
  upload: (url: string, bytes: Uint8Array, mediaType: string) => Promise<string>;
  limits?: SaveLimits;
  sleep?: (ms: number) => Promise<void>;
  retryForMs?: number;
  // Box mode's spawn gate (spawn-gate.ts): the packing's own git, let by
  // while every other process start is refused.
  asSave?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<{ bytes: number; leftOut?: string[] }> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  o.hold.begin();
  let stored: { storageId: string; bytes: number; leftOut: string[] };
  try {
    const rec = await o.quiesce(o.threadId);
    const pack = () => packSave({ home: o.home, claudeDir: o.claudeDir, rec, ...(o.limits ? { limits: o.limits } : {}) });
    const { packed, leftOut } = await (o.asSave ? o.asSave(pack) : pack());
    const sealed = sealSave(o.threadKey, o.threadId, packed);
    if (sealed.length > SAVE_MAX_BYTES) {
      throw new Error(`The thread's save is ${mb(sealed.length)}, more than one upload takes (${mb(SAVE_MAX_BYTES)}), and saves in parts aren't built yet. Commit less, or take big untracked files out of its folder, and it can save.`);
    }
    const url = await o.post('mutation', 'sync:iconUploadUrl', { key: o.boxKey });
    if (typeof url !== 'string') throw new Error("The backend didn't give the box an upload URL.");
    stored = { storageId: await o.upload(url, sealed, 'application/octet-stream'), bytes: sealed.length, leftOut };
    // Required: a mirror write still to come after boxSaved would mark the
    // box as working again. One that can't go fails the save (held).
    await o.beforeSaved?.();
  } catch (e) {
    // Nothing named in boxSaved: the backend has no save of this, for sure.
    o.hold.settled();
    throw e;
  }
  const end = Date.now() + (o.retryForMs ?? 10 * 60_000);
  for (let wait = 1_000; ; wait = Math.min(wait * 2, 60_000)) {
    try {
      await o.post('mutation', 'boxes:boxSaved', { key: o.boxKey, storageId: stored.storageId, bytes: stored.bytes });
      o.hold.settled();
      return { bytes: stored.bytes, ...(stored.leftOut.length ? { leftOut: stored.leftOut.slice(0, 20) } : {}) };
    } catch (e) {
      // The backend's answer, a refusal: known.
      if (kindOf(e) !== undefined) {
        o.hold.settled();
        throw e;
      }
      if (Date.now() + wait > end) throw new Error(`Couldn't tell whether the backend took the thread's save (${String((e as Error)?.message ?? e)}), so the thread stays stopped until the backend says.`);
      await sleep(wait);
    }
  }
}
