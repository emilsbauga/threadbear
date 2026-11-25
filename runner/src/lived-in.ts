// Which slot folders of a repo's <repo>-threads an open thread works in, from
// the runners' thread records (docs/thread-worktrees.md, "A folder a thread
// works in is never lent").
//
// A thread can work in a slot with no worktree record of its own: one
// started outside the repo borrows a slot with borrow-worktree.sh and moves
// itself there (move_thread). On 22 Nov 2026 the Canvas thread gave its
// borrowed slot-32 back and stayed in it; the next morning borrow-worktree.sh
// lent slot-32 to another thread, and the Canvas thread's next turn committed
// on the borrower's branch. So nothing hands out a slot an open thread's
// folder is in: the runner asks its own records (makeWorktree's inUse), and
// borrow-worktree.sh asks this.
//
//   node runner/src/lived-in.ts <repo>-threads
//
// prints each slot folder there an open thread works in (its first folder
// under <repo>-threads, written with the folder as given), one a line. It
// reads every runner data dir it knows of: THREADBEAR_RUNNER_HOME (a thread's
// own runner), THREADBEAR_HOME and the default one.
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, realPath } from './platform.ts';

export function runnerHomes(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Map<string, string>();
  for (const h of [env.THREADBEAR_RUNNER_HOME, env.THREADBEAR_HOME, env.THREADBEAR_DATA_DIR, dataDirFor()]) {
    if (h) out.set(realPath(path.resolve(h)), h);
  }
  return [...out.values()];
}

// Each open (not archived) thread's folder, as its record has it. Not one
// still in its own worktree that was removed or handed on: its next turn
// starts elsewhere whatever is there (leavesRemovedWorktree). A record that
// can't be read is skipped: one being written now is read again by the next
// borrow, and the runner checks again before a turn (lentFolder).
//
// Throws when a runner's records are there but can't be read, so the
// borrow takes no spare rather than one a thread it couldn't read is in.
// Every record is parsed, none skipped by its text: a folder reached
// through a link, or written with JSON's escapes, wouldn't match.
export function openThreadFolders(homes: string[]): string[] {
  const out: string[] = [];
  for (const home of homes) {
    const dir = path.join(home, 'threads');
    let ids: string[];
    try {
      ids = fs.readdirSync(dir);
    } catch (e) {
      if (missing(e)) continue;
      throw e;
    }
    for (const id of ids) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, id, 'thread.json'), 'utf8');
      } catch (e) {
        // Deleted as it was read, or a folder with no record.
        if (missing(e)) continue;
        throw e;
      }
      // Written whole (store.ts renames a finished file into place), so one
      // that doesn't parse is a fault, not a write under way.
      const rec = JSON.parse(text) as { cwd?: unknown; archivedAt?: unknown; worktree?: { path?: unknown; removedAt?: unknown } };
      if (typeof rec.cwd !== 'string' || rec.archivedAt) continue;
      const w = rec.worktree;
      if (w?.removedAt && typeof w.path === 'string' && inside(rec.cwd, w.path)) continue;
      out.push(rec.cwd);
    }
  }
  return out;
}

function missing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function inside(dir: string, parent: string): boolean {
  const rel = path.relative(parent, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// The slot folders under `threads` that hold one of `folders`.
export function slotsLivedIn(threads: string, folders: string[]): string[] {
  const forms = [...new Set([path.resolve(threads), realPath(path.resolve(threads))])];
  const out = new Set<string>();
  for (const f of folders) {
    for (const p of new Set([path.resolve(f), realPath(path.resolve(f))])) {
      for (const t of forms) {
        const rel = path.relative(t, p);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
        out.add(path.join(threads, rel.split(path.sep)[0]!));
      }
    }
  }
  return [...out].sort();
}

if (import.meta.main) {
  const threads = process.argv[2];
  if (!threads) {
    console.error('usage: node lived-in.ts <repo>-threads');
    process.exit(2);
  }
  for (const s of slotsLivedIn(threads, openThreadFolders(runnerHomes()))) console.log(s);
}
