// Takes back worktrees borrowed with borrow-worktree.sh and never given back
// (docs/thread-worktrees.md, "Borrows nobody gives back").
//
// On 17 Nov 2026 all 50 slots of Mike's threadbear-threads were taken: 25
// were on thread/borrow-* branches from the six days before, landed and
// left (threads that borrow, land and never run --give-back, and a
// sync-main killed mid-check), and the next sync-main couldn't borrow one,
// so main wasn't pushed. Asking every borrower to remember hasn't worked,
// so the runner takes them back, hourly, once that's safe.
//
// A borrow is a checkout in the repo's <repo>-threads folder that isn't
// locked and is on a thread/borrow-* branch, or detached (a spare claimed
// and never set up, a borrow given back half way), and that no thread's
// record holds. It goes back when its borrower has gone and nothing in it
// would be lost:
//
// - The borrower, from the `threadbear-borrow` file borrow-worktree.sh
//   writes beside git's own: a process (sync-main's) that has ended, a
//   thread that's archived, or, with neither recorded or the thread not
//   one of this runner's, a day with nothing done there (git's HEAD log).
//   A thread still open keeps its borrow however long it's quiet.
// - Nothing lost: no rebase, merge or the like half done, no changes or
//   untracked files, HEAD all on main, and no process working in it (its
//   current folder inside). Detached ones always need the quiet day too.
//   A scratch borrow (sync-main's, whose script throws its work away) is
//   the exception: once its process has gone, what it left is aborted and
//   reset to main first.
//
// Then, like --give-back: detached, its borrow branch deleted, and locked as
// a spare, or removed when the repo has MAX_SPARES already. Borrow branches
// nobody has checked out and that are all on main are deleted too.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { git, listCheckouts, MAIN, MAX_SPARES, readPlainFile, realpath, SPARE } from './worktrees.ts';

export const BORROW_FILE = 'threadbear-borrow';
export const BORROW_PREFIX = 'thread/borrow-';
// How long a borrow nobody's said is still theirs sits unused before it
// goes back. A day: a thread that borrowed and is still working commits,
// rebases or lands well inside that.
export const BORROW_IDLE_MS = 24 * 3_600_000;
// Git's own markers of something half done in a checkout.
const HALF_DONE = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer', 'BISECT_LOG'];

export type Borrower = { thread?: string; home?: string; branch?: string; pid?: number; scratch?: boolean; at?: number };

export function parseBorrower(text: string): Borrower {
  const b: Borrower = {};
  for (const line of text.split('\n')) {
    const [k, v = ''] = line.split(/=(.*)/s, 2).map((s) => s.trim());
    if (!v) continue;
    if (k === 'thread') b.thread = v;
    else if (k === 'home') b.home = v;
    else if (k === 'branch') b.branch = v;
    else if (k === 'pid' && /^\d+$/.test(v)) b.pid = Number(v);
    else if (k === 'scratch') b.scratch = v === '1';
    else if (k === 'at' && /^\d+$/.test(v)) b.at = Number(v) * 1000;
  }
  return b;
}

// Never a blocking read: a fifo in its place would hold the runner up.
export function readBorrower(admin: string): Borrower | undefined {
  const text = readPlainFile(path.join(admin, BORROW_FILE), 8192);
  return text === undefined ? undefined : parseBorrower(text);
}

export type SweepOptions = {
  now?: number;
  // This runner's data dir: a borrow recorded from another runner's thread
  // (a dev runner's) is that runner's to judge, while its data dir is there.
  home?: string;
  // The thread's state on this runner: 'unknown' for an id it doesn't have.
  thread: (id: string) => 'open' | 'archived' | 'unknown';
  // Folders threads use (realpaths): their worktrees and current folders.
  // A borrow with one of them in it is never touched.
  held: Set<string>;
  pidAlive?: (pid: number) => boolean;
  // Every process's current folder; undefined when that can't be read in
  // full, and then nothing is taken back.
  cwds?: () => Promise<string[] | undefined>;
};

export type Reclaimed = { path: string; branch?: string; to: 'spare' | 'removed'; why: string; thread?: string };
export type SweepResult = { reclaimed: Reclaimed[]; branches: string[]; skipped: { path: string; why: string }[] };

// Tests' hooks into the moments a race would hit.
export type SweepHooks = { afterPick?: () => void; beforeDetach?: () => void };

export async function sweepBorrows(mainCheckout: string, opts: SweepOptions, hooks: SweepHooks = {}): Promise<SweepResult> {
  const result: SweepResult = { reclaimed: [], branches: [], skipped: [] };
  const now = opts.now ?? Date.now();
  const alive = opts.pidAlive ?? pidAlive;
  const threads = realpath(path.join(path.dirname(mainCheckout), `${path.basename(mainCheckout)}-threads`));
  const checkouts = await listCheckouts(mainCheckout);
  if (!checkouts || !checkouts.some((c) => c.branch === MAIN)) return result;
  const inThreads = (p: string) => path.dirname(realpath(p)) === threads;
  let spares = checkouts.filter((c) => c.locked === SPARE && inThreads(c.path)).length;

  const candidates = checkouts.filter(
    (c) => c.locked === undefined && inThreads(c.path) && (!c.branch || c.branch.startsWith(BORROW_PREFIX)) && !holds(opts.held, realpath(c.path)),
  );
  let cwds: string[] | undefined;
  if (candidates.length) {
    cwds = await (opts.cwds ?? processCwds)();
    if (!cwds) return result;
  }
  for (const c of candidates) {
    const skip = (why: string) => void result.skipped.push({ path: c.path, why });
    const admin = (await git(c.path, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
    if (!admin || !fs.existsSync(admin)) continue;
    const record = readPlainFile(path.join(admin, BORROW_FILE), 8192);
    const who = record === undefined ? {} : parseBorrower(record);
    const idle = now - lastUsed(admin) >= BORROW_IDLE_MS;
    const elsewhere = who.home !== undefined && opts.home !== undefined && realpath(who.home) !== realpath(opts.home) && fs.existsSync(who.home);
    let why: string | undefined;
    let scratch = false;
    if (who.pid !== undefined) {
      // A live borrower keeps it, however long it's quiet.
      if (alive(who.pid)) continue;
      why = 'the script that borrowed it has ended';
      scratch = who.scratch === true;
    } else if (elsewhere) {
      continue;
    } else if (who.thread && opts.thread(who.thread) === 'archived') {
      why = 'the thread that borrowed it is archived';
    } else if (who.thread && opts.thread(who.thread) === 'open') {
      continue;
    } else if (idle) {
      why = 'unused for a day';
    }
    if (!why) continue;
    if (!c.branch && !idle && !scratch) continue;
    if (holds(cwds!, realpath(c.path))) {
      skip('a process is working in it');
      continue;
    }
    // The branch being worked on there (a rebase's too) must be the one it
    // was borrowed on: a record left behind in a folder someone has since
    // switched to their own branch says nothing about them.
    const ours = () => {
      const wb = workingBranch(admin);
      // Detached with a branch recorded: a give-back stopped half way, so
      // only after a quiet day.
      return wb === undefined ? !scratch && (!who.branch || idle) : wb.startsWith(`refs/heads/${BORROW_PREFIX}`) && (!who.branch || wb === `refs/heads/${who.branch}`);
    };
    if (!ours()) continue;
    // Before each git that changes it: still the checkout git made there
    // (not a link to somewhere else, main say), still this borrow (its
    // record unchanged: given back and borrowed again, it's someone
    // else's), and, given `head`, still on that.
    const still = (head?: string) => {
      const here = checkoutItself(c.path, admin);
      if (!here || readPlainFile(path.join(admin, BORROW_FILE), 8192) !== record) return undefined;
      // Its borrower may have come back (the thread brought back) since.
      if (who.thread && !elsewhere && who.pid === undefined && opts.thread(who.thread) === 'open') return undefined;
      if (head !== undefined && readHead(admin) !== head) return undefined;
      return here;
    };
    const CHANGED = 'it changed while it was looked at';
    hooks.afterPick?.();
    let head = readHead(admin);
    if (scratch) {
      // Its script's work, thrown away as the script itself would have.
      let here: string | undefined;
      for (const args of [['rebase', '--abort'], ['merge', '--abort'], ['cherry-pick', '--abort']]) {
        if (!(here = still()) || !ours()) {
          here = undefined;
          break;
        }
        await git(here, args);
      }
      // Back on its borrow branch, as it always is outside a rebase.
      head = readHead(admin);
      if (!here || !head?.startsWith(`ref: refs/heads/${BORROW_PREFIX}`) || !(here = still(head))) {
        skip(CHANGED);
        continue;
      }
      if (!(await git(here, ['reset', '-q', '--hard', MAIN])).ok) {
        skip("git couldn't reset it");
        continue;
      }
      if ((here = still(head))) await git(here, ['clean', '-fdq']);
    }
    const branch = head?.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : undefined;
    if (branch !== undefined && !branch.startsWith(BORROW_PREFIX)) continue;
    // Clean, nothing half done, and all on main: asked again after the
    // detach, so a commit or an edit made meanwhile keeps it.
    const unsafe = async (): Promise<string | undefined> => {
      if (HALF_DONE.some((f) => fs.existsSync(path.join(admin, f)))) return 'something is half done there (a rebase, a merge)';
      const status = await git(c.path, ['status', '--porcelain', '--untracked-files=all']);
      if (!status.ok || status.stdout.trim()) return status.ok ? 'it has changes or untracked files' : "git couldn't read it";
      const tip = (await git(c.path, ['rev-parse', 'HEAD'])).stdout.trim();
      if (!tip || !(await landed(mainCheckout, tip))) return `it has commits that aren't on ${MAIN}`;
      return undefined;
    };
    const first = await unsafe();
    if (first) {
      skip(first);
      continue;
    }
    hooks.beforeDetach?.();
    let here = still(head);
    if (!here) {
      skip(CHANGED);
      continue;
    }
    if (branch && !(await git(here, ['checkout', '-q', '--detach'])).ok) {
      skip("git couldn't detach it");
      continue;
    }
    const tip = (await git(c.path, ['rev-parse', 'HEAD'])).stdout.trim();
    const second = await unsafe();
    if (second) {
      // A commit or an edit came in while it was looked at: back on its
      // branch, moved to what's there now so a new commit stays on it.
      if (branch && (here = still(tip))) await git(here, ['checkout', '-q', '-B', branch]);
      skip(second);
      continue;
    }
    // The branch itself landed too (nothing else has it checked out to
    // move it now).
    if (branch && !((await landed(mainCheckout, `refs/heads/${branch}`)) && (await git(mainCheckout, ['branch', '-q', '-D', branch])).ok)) {
      if ((here = still(tip))) await git(here, ['checkout', '-q', branch]);
      skip(`its branch has commits that aren't on ${MAIN}`);
      continue;
    }
    // Its status once more, then straight to the lock: once it's a spare,
    // the next borrower's reset would take an edit made before this.
    const last = await git(c.path, ['status', '--porcelain', '--untracked-files=all']);
    if (!last.ok || last.stdout.trim()) {
      if (branch && (here = still(tip))) await git(here, ['checkout', '-q', '-B', branch]);
      skip('it changed as it was being set aside');
      continue;
    }
    if (!still(tip)) {
      skip(CHANGED);
      continue;
    }
    let to: Reclaimed['to'];
    // Its record goes first: once locked, the next borrower may write its own.
    const recordFile = path.join(admin, BORROW_FILE);
    fs.rmSync(recordFile, { force: true });
    if (spares < MAX_SPARES && (await git(mainCheckout, ['worktree', 'lock', '--reason', SPARE, c.path])).ok) {
      spares++;
      to = 'spare';
    } else if ((await git(mainCheckout, ['worktree', 'remove', c.path])).ok) {
      // Without --force, git refuses one with changes or untracked files.
      to = 'removed';
    } else {
      if (record !== undefined && !fs.existsSync(recordFile)) fs.writeFileSync(recordFile, record);
      skip("git couldn't lock or remove it");
      continue;
    }
    result.reclaimed.push({ path: c.path, ...(branch ? { branch } : {}), to, why, ...(who.thread ? { thread: who.thread } : {}) });
  }

  // Borrow branches left behind with no checkout (their folder was reused
  // or removed by hand), all on main.
  const out = await listCheckouts(mainCheckout);
  const checkedOut = new Set((out ?? []).map((c) => c.branch).filter(Boolean));
  const refs = await git(mainCheckout, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${BORROW_PREFIX}*`]);
  if (out && refs.ok) {
    for (const b of refs.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      if (checkedOut.has(b)) continue;
      // Asked of main itself: -d alone goes by a branch's upstream when it
      // has one, and a pushed branch's work needn't be on main.
      if (!(await landed(mainCheckout, `refs/heads/${b}`))) continue;
      if ((await git(mainCheckout, ['branch', '-q', '-D', b])).ok) result.branches.push(b);
    }
  }
  return result;
}

// The folder as the checkout git made there, by its real path: a real
// folder, no link in its last part, whose .git names `admin`. Synchronous,
// so it's the last thing before the git it guards (worktreeFolderNow in
// worktrees.ts does the same for a thread's own).
function checkoutItself(dir: string, admin: string): string | undefined {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const real = realpath(dir);
  if (real !== path.join(realpath(path.dirname(dir)), path.basename(dir))) return undefined;
  const named = readPlainFile(path.join(real, '.git'), 8192)?.split('\n').find((l) => l.startsWith('gitdir:'))?.slice('gitdir:'.length).trim();
  return named && realpath(path.resolve(real, named)) === realpath(admin) ? real : undefined;
}

// Everything at `ref` is on main: as an ancestor, or by patch, as
// --give-back allows (a group check in tb land rebases a branch again before
// main moves, so main can have the same changes under new ids). `git cherry`
// marks each commit main has no equal of with "+".
async function landed(mainCheckout: string, ref: string): Promise<boolean> {
  if ((await git(mainCheckout, ['merge-base', '--is-ancestor', ref, MAIN])).ok) return true;
  const cherry = await git(mainCheckout, ['cherry', MAIN, ref]);
  return cherry.ok && !cherry.stdout.split('\n').some((l) => l.startsWith('+'));
}

function holds(folders: Iterable<string>, dir: string): boolean {
  for (const f of folders) if (f === dir || f.startsWith(dir + path.sep)) return true;
  return false;
}

// When anything last happened in the checkout: git appends to its HEAD log
// on every commit, checkout, reset and rebase step. Not the index, which a
// plain `git status` (this sweep's own) rewrites.
function lastUsed(admin: string): number {
  let last = 0;
  for (const f of [path.join(admin, 'logs', 'HEAD'), path.join(admin, 'HEAD'), path.join(admin, BORROW_FILE)]) {
    try {
      last = Math.max(last, fs.statSync(f).mtimeMs);
    } catch {
      // Not there.
    }
  }
  return last;
}

// The branch a checkout is working on: a rebase's own (HEAD is detached
// while it runs), or HEAD's. undefined when detached.
function workingBranch(admin: string): string | undefined {
  for (const d of ['rebase-merge', 'rebase-apply']) {
    const name = readPlainFile(path.join(admin, d, 'head-name'), 8192)?.trim();
    if (name) return name.startsWith('refs/heads/') ? name : undefined;
  }
  const head = readHead(admin);
  return head?.startsWith('ref: ') ? head.slice('ref: '.length) : undefined;
}

function readHead(admin: string): string | undefined {
  return readPlainFile(path.join(admin, 'HEAD'), 8192)?.trim();
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: there, but someone else's.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Every process's current folder (this user's, which is whose would be
// working in a borrow). /proc on Linux; lsof elsewhere.
export function processCwds(): Promise<string[] | undefined> {
  if (process.platform === 'linux') {
    try {
      const out: string[] = [];
      for (const p of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(p)) continue;
        try {
          out.push(fs.readlinkSync(`/proc/${p}/cwd`));
        } catch {
          // Gone, or not ours.
        }
      }
      return Promise.resolve(out);
    } catch {
      return Promise.resolve(undefined);
    }
  }
  if (process.platform === 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    // This user's processes only, so it can read them all and exits 0; any
    // failure (a timeout, too much output) means the list may be missing
    // the very process working in a borrow, so it counts as unknown.
    execFile('lsof', ['-n', '-P', '-a', '-u', String(process.getuid?.() ?? ''), '-d', 'cwd', '-Fn'], { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      resolve(String(stdout).split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)));
    });
  });
}
