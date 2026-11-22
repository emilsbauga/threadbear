// What changed in a patch since the version last trusted in its folder
// (docs/protocol/trust.md, "Trusting a folder's patches", "What changed").
//
// A patch whose hash moved on is asked about again, but a hash alone can't
// say why: the patch file, a helper, a script it runs, the package.json a
// script runs from, or only how Threadbear checks. Mike was asked most days
// and said yes in a second without reading (nightly retro, 20 Nov 2026), so
// the ask stopped telling his own agent's merge from a stranger's code. So
// each trusted version's files are kept here, by their SHA-256 and with the
// repo's HEAD at the time, and a re-ask names the files that differ, the
// commits that changed them since, whether the change is committed at all,
// and the lines themselves.
//
// This only describes: nothing here trusts anything. The old side of a
// diff comes from git only when its bytes hash to what was trusted, and the
// new side only when the file still hashes to what the ask is for, so the
// lines shown are the lines that Trust would let run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './fsutil.ts';
import { untrustedGit } from './safe-git.ts';
import type { PatchChanges } from './protocol.ts';

// One trusted version of a patch: when, its files (relative to the folder
// holding `.threadbear/`, by SHA-256, null when named but missing) and the
// repo's HEAD then.
export type TrustedVersion = { hash: string; at: string; files: FileShas; head?: string };

export type { PatchChanges };
export type ChangedFile = NonNullable<PatchChanges['files']>[number];

// Versions kept per patch: the last trusted is what a re-ask compares with.
const KEPT = 5;
const FILE_VERSION = 1;
// Most commits named per file, and diff lines shown per file.
const MAX_COMMITS = 5;
const MAX_DIFF_LINES = 40;
const MAX_LINE = 200;
// Bigger files, or edits whose middles multiply past this, get no diff.
const MAX_DIFF_BYTES = 256 * 1024;
const MAX_CELLS = 2_000_000;
// A diff line longer than this is cut, and says so: never silently, as a
// payload could sit past the cut (Gemini's review, 20 Nov 2026).
const MAX_DIFF_LINE = 1000;
// A described change is kept this long before git is asked again (a commit
// can turn "not committed" into a commit without the hash moving).
const DESCRIBE_TTL_MS = 60_000;
// The longest a waiting patch's row waits for git to say where a change
// came from; past it, the files are named alone and git is asked no more.
const DESCRIBE_WAIT_MS = 5_000;

// Control, line-breaking and direction-changing characters.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

// Repo text (paths, commit subjects, names) shown as one plain line: no
// control or direction-changing characters, and capped.
export function plainLine(s: string, max = MAX_LINE): string {
  const flat = s.replace(/\t/g, '  ').replace(CONTROL, '?').replace(/\n/g, ' ');
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

// A diff line: as plainLine, but a cut says how much it left out.
function diffLine(s: string): string {
  const flat = s.replace(/\t/g, '  ').replace(CONTROL, '?');
  if (flat.length <= MAX_DIFF_LINE) return flat;
  return `${flat.slice(0, MAX_DIFF_LINE)} [line cut: ${flat.length - MAX_DIFF_LINE} more characters, open the file]`;
}

// Files by path, with no prototype: a file named `__proto__` or
// `toString` is a file like any other (Codex's and Gemini's reviews).
export type FileShas = Record<string, string | null>;
export function fileShas(entries: Iterable<[string, string | null]> = []): FileShas {
  const out = Object.create(null) as FileShas;
  for (const [k, v] of entries) out[k] = v;
  return out;
}

// The key a patch's versions are kept under: its folder's trust key and the
// patch's path inside its folder, so a worktree and its main checkout share
// them.
export function versionKey(folderKey: string, rel: string): string {
  return `${folderKey}\0${rel}`;
}

export class TrustedVersions {
  private patches = new Map<string, TrustedVersion[]>();
  private mtime?: number | null;
  private described = new Map<string, { at: number; changes: Promise<PatchChanges | undefined> }>();
  private pending = new Set<Promise<void>>();
  private file?: string;

  constructor(file?: string) {
    this.file = file;
  }

  private load(): void {
    if (!this.file) return;
    let mtime: number | null;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      mtime = null;
    }
    if (mtime === this.mtime) return;
    this.mtime = mtime;
    this.patches.clear();
    if (mtime === null) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { patches?: Record<string, unknown> };
      for (const [key, list] of Object.entries(raw.patches ?? {})) {
        if (!Array.isArray(list)) continue;
        const ok: TrustedVersion[] = [];
        for (const v of list as Partial<TrustedVersion>[]) {
          if (!v || typeof v !== 'object' || typeof v.hash !== 'string' || typeof v.at !== 'string' || !v.files || typeof v.files !== 'object') continue;
          const files = fileShas(Object.entries(v.files).filter((e): e is [string, string | null] => typeof e[1] === 'string' || e[1] === null));
          ok.push({ hash: v.hash, at: v.at, files, ...(typeof v.head === 'string' ? { head: v.head } : {}) });
        }
        if (ok.length) this.patches.set(key, ok);
      }
    } catch {
      // Unreadable: nothing on record, so re-asks say less. It only ever
      // describes, so this trusts nothing.
    }
  }

  private save(): void {
    if (!this.file) return;
    atomicWriteFileSync(this.file, JSON.stringify({ version: FILE_VERSION, patches: Object.fromEntries(this.patches) }) + '\n');
    try {
      this.mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      this.mtime = undefined;
    }
  }

  // Whether any version of this patch is on record.
  any(key: string): boolean {
    this.load();
    return (this.patches.get(key)?.length ?? 0) > 0;
  }

  // Keeps a trusted version, newest last, and then the repo's HEAD with it
  // once git has said (never waiting on git here: a planted FIFO in .git
  // would hold the runner). `folder`: the folder holding `.threadbear/`.
  record(key: string, version: { hash: string; files: FileShas }, folder: string, at = new Date()): void {
    this.load();
    const entry: TrustedVersion = { ...version, at: at.toISOString() };
    const list = (this.patches.get(key) ?? []).filter((v) => v.hash !== version.hash);
    list.push(entry);
    this.patches.set(key, list.slice(-KEPT));
    this.save();
    const job = headOf(folder, Date.now() + 10_000).then((head) => {
      if (!head) return;
      this.load();
      const kept = this.patches.get(key)?.find((v) => v.hash === entry.hash && v.at === entry.at);
      if (!kept) return;
      kept.head = head;
      this.save();
    });
    this.pending.add(job);
    void job.catch(() => {}).finally(() => this.pending.delete(job));
  }

  // Every record's HEAD written (tests).
  async settled(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  last(key: string): TrustedVersion | undefined {
    this.load();
    return this.patches.get(key)?.at(-1);
  }

  // What changed from the last version trusted to `now` (the files the ask
  // is for), in `folder` (a worktree or the main checkout: each its own),
  // described once a minute at most.
  describe(key: string, hash: string, now: FileShas, folder: string): Promise<PatchChanges | undefined> {
    const last = this.last(key);
    if (!last || last.hash === hash) return Promise.resolve(undefined);
    const k = `${key}\0${folder}\0${hash}\0${last.hash}\0${last.at}\0${last.head ?? ''}`;
    const hit = this.described.get(k);
    if (hit && Date.now() - hit.at < DESCRIBE_TTL_MS) return hit.changes;
    const names = (): PatchChanges => ({ since: last.at, files: fileList(last.files, now).map(shown) });
    const deadline = Date.now() + DESCRIBE_WAIT_MS;
    let timer: NodeJS.Timeout | undefined;
    const slow = new Promise<PatchChanges>((resolve) => {
      timer = setTimeout(() => resolve(names()), DESCRIBE_WAIT_MS + 250);
      timer.unref?.();
    });
    const changes = Promise.race([describeChanges(last, now, folder, deadline).catch(names), slow]).finally(() => clearTimeout(timer));
    this.described.set(k, { at: Date.now(), changes });
    if (this.described.size > 200) this.described.delete(this.described.keys().next().value!);
    return changes;
  }
}

function fileList(was: FileShas, now: FileShas): ChangedFile[] {
  const out: ChangedFile[] = [];
  for (const p of new Set([...Object.keys(was), ...Object.keys(now)])) {
    const a = Object.hasOwn(was, p) ? was[p] : undefined;
    const b = Object.hasOwn(now, p) ? now[p] : undefined;
    // Named but missing then and not named now, or the other way round:
    // nothing ran either side.
    if (a === b || ((a === undefined || a === null) && (b === undefined || b === null))) continue;
    const kind: ChangedFile['was'] = a === undefined || a === null ? 'added' : b === undefined || b === null ? 'removed' : 'changed';
    out.push({ path: p, was: kind });
  }
  // The patch file first, then by path.
  return out.sort((x, y) => Number(!x.path.includes('.threadbear/')) - Number(!y.path.includes('.threadbear/')) || x.path.localeCompare(y.path));
}

const REV = /^[0-9a-f]{40,64}$/;

// Whether git can say anything about `rel`: inside the folder, and not a
// symlink (git holds a link's target path, not the bytes hashed).
function gitCanSay(folder: string, rel: string): boolean {
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('../')) return false;
  // No link anywhere on the way (a linked `.threadbear/patches` too): its
  // real path is the folder's real path and the same steps.
  try {
    return fs.realpathSync(path.resolve(folder, rel)) === path.join(fs.realpathSync(folder), rel);
  } catch {
    return false;
  }
}

// `deadline`: past it, git is asked no more, and the rest are named alone.
export async function describeChanges(last: TrustedVersion, now: FileShas, folder: string, deadline = Date.now() + DESCRIBE_WAIT_MS): Promise<PatchChanges> {
  const files = fileList(last.files, now);
  const left = () => deadline - Date.now();
  // Past the deadline git is asked nothing more: each call checks first.
  const git = (args: string[], bytes = false) => (left() <= 0 ? Promise.resolve({ ok: false, code: -1, stdout: '', stderr: 'out of time' }) : untrustedGit(folder, args, { timeoutMs: left(), bytes }));
  const head = await headOf(folder, deadline);
  const lastHead = last.head && REV.test(last.head) ? last.head : undefined;
  const blobs = new Map<string, Promise<Buffer | undefined>>();
  const blobAt = (rev: string, rel: string) => {
    const k = `${rev}:${rel}`;
    if (!blobs.has(k)) blobs.set(k, blob(git, rev, rel));
    return blobs.get(k)!;
  };
  for (const f of files) {
    if (left() <= 0) break;
    if (!gitCanSay(folder, f.path)) continue;
    const spec = `:(literal)${f.path}`;
    if (head && lastHead && head !== lastHead) {
      const r = await git(['rev-list', '--no-commit-header', `--format=%h%x09%s`, `${lastHead}..${head}`, '--', spec]);
      if (r.ok) {
        const lines = r.stdout.split('\n').filter(Boolean);
        const commits = lines.slice(0, MAX_COMMITS).map((l) => {
          const at = l.indexOf('\t');
          return { sha: plainLine(l.slice(0, at), 64), subject: plainLine(l.slice(at + 1), 120) };
        });
        if (commits.length) f.commits = commits;
        if (lines.length > MAX_COMMITS) f.moreCommits = lines.length - MAX_COMMITS;
      }
    }
    const nowSha = now[f.path];
    if (nowSha && head) {
      const atHead = await blobAt(head, f.path);
      // Only what git answered: HEAD has other bytes there, or git lists
      // the file as untracked. A failure, a timeout or a too-big blob says
      // nothing (a missing object in a partial clone, a submodule's file).
      if (atHead && sha(atHead) !== nowSha) f.uncommitted = true;
      else if (!atHead) {
        const r = await git(['ls-files', '-z', '--others', '--exclude-standard', '--', spec]);
        if (r.ok && r.stdout.split('\0').includes(f.path)) f.uncommitted = true;
      }
    }
    if (f.was !== 'changed' || !nowSha) continue;
    // The old bytes: the trusted commit's, or HEAD's, whichever hashes to
    // what was trusted. Nothing else can say what was there.
    const wasSha = last.files[f.path];
    let old: Buffer | undefined;
    for (const rev of new Set([lastHead, head])) {
      if (!rev) continue;
      const b = await blobAt(rev, f.path);
      if (b && sha(b) === wasSha) {
        old = b;
        break;
      }
    }
    let cur: Buffer | undefined;
    try {
      const st = fs.statSync(path.resolve(folder, f.path));
      if (st.isFile() && st.size <= MAX_DIFF_BYTES) cur = fs.readFileSync(path.resolve(folder, f.path));
    } catch {
      // gone since: no diff
    }
    if (old && cur && sha(cur) === nowSha) {
      const d = lineDiff(old.toString('utf8'), cur.toString('utf8'));
      if (d) f.diff = d;
    }
  }
  return { since: last.at, files: files.map(shown) };
}

// A path as shown: the repo's text, so one plain line.
function shown(f: ChangedFile): ChangedFile {
  return { ...f, path: plainLine(f.path) };
}

async function headOf(folder: string, deadline: number): Promise<string | undefined> {
  const r = await untrustedGit(folder, ['rev-parse', '--verify', '-q', 'HEAD'], { timeoutMs: Math.max(1, deadline - Date.now()) });
  const out = r.stdout.trim();
  return r.ok && REV.test(out) ? out : undefined;
}

// The file's bytes in `rev`, as git holds them, or undefined when it
// couldn't say or the blob is too big to diff (its size is asked first, so
// a huge one is never read).
type Git = (args: string[], bytes?: boolean) => Promise<{ ok: boolean; stdout: string; bytes?: Buffer }>;
async function blob(git: Git, rev: string, rel: string): Promise<Buffer | undefined> {
  // `<rev>:./<path>`: relative to the folder git runs in, not the repo's top.
  const obj = `${rev}:./${rel}`;
  const size = await git(['cat-file', '-s', obj]);
  if (!size.ok || !(Number(size.stdout.trim()) <= MAX_DIFF_BYTES)) return undefined;
  const r = await git(['cat-file', 'blob', obj], true);
  return r.ok ? r.bytes : undefined;
}

function sha(b: Buffer): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}

// A short line diff: changed lines with `-`/`+`, a line of context either
// side, `…` between hunks, at most MAX_DIFF_LINES lines. Undefined when it's
// too big to work out.
export function lineDiff(a: string, b: string, max = MAX_DIFF_LINES): string | undefined {
  const x = a.split('\n');
  const y = b.split('\n');
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xs = x.slice(pre, x.length - suf);
  const ys = y.slice(pre, y.length - suf);
  if (!xs.length && !ys.length) return undefined;
  const n = xs.length;
  const m = ys.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return undefined;
  // LCS lengths from the end, then a walk from the start.
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = xs[i] === ys[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  type Op = { k: ' ' | '-' | '+'; s: string };
  const ops: Op[] = [];
  if (pre > 0) ops.push({ k: ' ', s: x[pre - 1] });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) {
      ops.push({ k: ' ', s: xs[i] });
      i++;
      j++;
    } else if (i < n && (j >= m || t[(i + 1) * w + j] >= t[i * w + j + 1])) ops.push({ k: '-', s: xs[i++] });
    else ops.push({ k: '+', s: ys[j++] });
  }
  if (suf > 0) ops.push({ k: ' ', s: x[x.length - suf] });
  // Context lines more than one away from a change fold into `…`.
  const changed = (k: number) => k >= 0 && k < ops.length && ops[k].k !== ' ';
  const near = ops.map((_, k) => changed(k) || changed(k - 1) || changed(k + 1));
  const lines: string[] = [];
  let skipped = false;
  for (let k = 0; k < ops.length; k++) {
    if (!near[k]) {
      skipped = true;
      continue;
    }
    if (skipped && lines.length) lines.push('…');
    skipped = false;
    lines.push(`${ops[k].k} ${diffLine(ops[k].s)}`);
  }
  if (lines.length > max) {
    const more = lines.length - max;
    return [...lines.slice(0, max), `… ${more} more line${more === 1 ? '' : 's'}`].join('\n');
  }
  return lines.join('\n');
}

// Why a waiting patch waits, in words for the thread's note: "package.json
// changed since you trusted it (in commit 2952b9c)".
export function waitingWhy(p: { untrusted?: 'new' | 'changed'; changes?: PatchChanges }): string {
  if (p.untrusted !== 'changed') return 'nothing from its folder is trusted yet';
  const c = p.changes;
  if (c?.recheck) return "its folder's trust is from before Threadbear changed how it checks patches on 6 Nov, so it can't say whether this patch was trusted before or what changed";
  const files = c?.files ?? [];
  if (!files.length) return 'it changed since you trusted it';
  const names = (list: ChangedFile[]) => {
    const shown = list.slice(0, 3).map((f) => plainLine(f.path, 80));
    return list.length > 3 ? `${shown.join(', ')} and ${list.length - 3} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
  };
  const edited = files.filter((f) => f.was !== 'added');
  const added = files.filter((f) => f.was === 'added');
  const parts: string[] = [];
  if (edited.length) parts.push(`${names(edited)} changed since you trusted it`);
  if (added.length) parts.push(`${edited.length ? 'and it' : 'it'} now also runs ${names(added)}`);
  const shas = [...new Set(files.flatMap((f) => (f.commits ?? []).map((x) => x.sha)))];
  const uncommitted = files.some((f) => f.uncommitted);
  const where = uncommitted ? 'not all of it committed' : shas.length ? `in ${shas.length === 1 ? 'commit' : 'commits'} ${shas.slice(0, 3).join(', ')}${shas.length > 3 ? '…' : ''}` : '';
  return parts.join(', ') + (where ? ` (${where})` : '');
}
