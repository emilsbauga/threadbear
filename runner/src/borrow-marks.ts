// How a borrowed worktree is marked: the branch borrow-worktree.sh makes and
// the `threadbear-borrow` file it writes beside git's own, saying who has it.
// Its own file so the slots (slot.ts) can tell a borrow without needing the
// sweep that takes borrows back (borrows.ts), which reads the slots
// (mikecann-lint's no-import-cycle).
export const BORROW_FILE = 'threadbear-borrow';
export const BORROW_PREFIX = 'thread/borrow-';

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
