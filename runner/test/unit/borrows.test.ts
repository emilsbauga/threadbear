// borrows.ts: the runner taking back worktrees borrowed with
// borrow-worktree.sh and never given back. On 17 Nov 2026 25 such slots
// filled threadbear-threads to borrow-worktree's cap, and sync-main couldn't
// borrow one to check in, so main wasn't pushed.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BORROW_FILE, readBorrower, sweepBorrows, type SweepOptions } from '../../src/borrows.ts';
import { addBorrowScript, commit, isLocked, makeRepo, sh, write } from '../helpers/worktrees-harness.ts';

const DAY = 24 * 3_600_000;
// borrow-worktree.sh is bash, and on Windows the sweep can't list processes'
// folders, so it takes nothing back there.
const test = (name: string, fn: () => void | Promise<void>) => nodeTest(name, { skip: process.platform === 'win32' && 'bash scripts; no sweep on Windows' }, fn);

function borrow(main: string, env = ''): string {
  return sh(main, `${env} ./borrow-worktree.sh 2>/dev/null`);
}
const admin = (wt: string) => sh(wt, 'git rev-parse --absolute-git-dir');
const branchOf = (wt: string) => sh(wt, 'git rev-parse --abbrev-ref HEAD');
// Lands what's on the borrow, as tb land would: main fast-forwards to it.
const landIt = (main: string, wt: string) => sh(main, `git merge -q --ff-only $(git -C ${wt} rev-parse HEAD) >/dev/null`);

function opts(o: Partial<SweepOptions> = {}): SweepOptions {
  return { thread: () => 'unknown', held: new Set(), cwds: async () => [], pidAlive: () => false, ...o };
}

test('borrow-worktree.sh records who borrowed, and --give-back clears it', () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const wt = borrow(main, 'THREADBEAR_THREAD_ID=t-1 THREADBEAR_BORROW_PID=4242 THREADBEAR_BORROW_SCRATCH=1');
  const who = readBorrower(admin(wt))!;
  assert.equal(who.thread, 't-1');
  assert.equal(who.pid, 4242);
  assert.equal(who.scratch, true);
  assert.ok(who.at && Math.abs(who.at - Date.now()) < 60_000);
  const a = admin(wt);
  assert.match(sh(main, `./borrow-worktree.sh --give-back ${wt}`), /is a spare again/);
  assert.ok(!fs.existsSync(path.join(a, BORROW_FILE)));
});

test('borrow-worktree.sh has no cap on slots: it takes the first free one past any number', () => {
  const { root, main } = makeRepo();
  addBorrowScript(main);
  const threads = path.join(root, 'proj-threads');
  for (let n = 1; n <= 52; n++) fs.mkdirSync(path.join(threads, `slot-${n}`), { recursive: true });
  assert.equal(borrow(main), path.join(threads, 'slot-53'));
});

test('a landed borrow whose thread is archived goes back as a spare; one whose thread is open stays', async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const gone = borrow(main, 'THREADBEAR_THREAD_ID=archived-1');
  const open = borrow(main, 'THREADBEAR_THREAD_ID=open-1');
  const goneBranch = branchOf(gone);
  commit(gone, { 'runner/b.ts': '2\n' }, 'Landed');
  landIt(main, gone);
  write(gone, { 'node_modules/x.js': 'ignored files are fine\n' });
  const r = await sweepBorrows(main, opts({ thread: (id) => (id === 'archived-1' ? 'archived' : 'open') }));
  assert.deepEqual(r.reclaimed, [{ path: gone, branch: goneBranch, to: 'spare', why: 'the thread that borrowed it is archived', thread: 'archived-1' }]);
  assert.ok(isLocked(main, gone));
  assert.equal(sh(main, `git branch --list '${goneBranch}'`), '');
  assert.ok(!fs.existsSync(path.join(admin(gone), BORROW_FILE)));
  assert.ok(!isLocked(main, open));
  assert.match(branchOf(open), /^thread\/borrow-/);
  // The next borrow takes the spare.
  assert.equal(borrow(main), gone);
});

test('nothing with work in it is taken back: unlanded commits, changes, untracked files, a rebase half done, a process in it', async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const t = 'archived-1';
  const unlanded = borrow(main, `THREADBEAR_THREAD_ID=${t}`);
  commit(unlanded, { 'runner/c.ts': '3\n' }, 'Not landed');
  const changed = borrow(main, `THREADBEAR_THREAD_ID=${t}`);
  write(changed, { 'README.md': 'edited\n' });
  const untracked = borrow(main, `THREADBEAR_THREAD_ID=${t}`);
  write(untracked, { 'new.txt': 'new\n' });
  const rebasing = borrow(main, `THREADBEAR_THREAD_ID=${t}`);
  fs.mkdirSync(path.join(admin(rebasing), 'rebase-merge'));
  const busy = borrow(main, `THREADBEAR_THREAD_ID=${t}`);
  const r = await sweepBorrows(main, opts({ thread: () => 'archived', cwds: async () => [path.join(fs.realpathSync(busy), 'runner')] }));
  assert.deepEqual(r.reclaimed, []);
  assert.deepEqual(
    Object.fromEntries(r.skipped.map((s) => [path.basename(s.path), s.why])),
    {
      [path.basename(unlanded)]: "it has commits that aren't on main",
      [path.basename(changed)]: 'it has changes or untracked files',
      [path.basename(untracked)]: 'it has changes or untracked files',
      [path.basename(rebasing)]: 'something is half done there (a rebase, a merge)',
      [path.basename(busy)]: 'a process is working in it',
    },
  );
  assert.equal(sh(unlanded, 'git log -1 --format=%s'), 'Not landed');
  assert.equal(fs.readFileSync(path.join(changed, 'README.md'), 'utf8'), 'edited\n');
  // And when the processes can't be read, nothing at all.
  const blind = await sweepBorrows(main, opts({ thread: () => 'archived', cwds: async () => undefined }));
  assert.deepEqual(blind, { reclaimed: [], branches: [], skipped: [] });
});

test("a borrow with no borrower recorded goes back after a quiet day, not before; a thread's worktree and an open thread's folder never", async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const old = borrow(main);
  fs.rmSync(path.join(admin(old), BORROW_FILE));
  const held = borrow(main);
  fs.rmSync(path.join(admin(held), BORROW_FILE));
  const soon = await sweepBorrows(main, opts());
  assert.deepEqual(soon.reclaimed, []);
  const later = await sweepBorrows(main, opts({ now: Date.now() + DAY + 60_000, held: new Set([path.join(fs.realpathSync(held), 'runner')]) }));
  assert.deepEqual(later.reclaimed.map((x) => [x.path, x.why]), [[old, 'unused for a day']]);
  assert.ok(!isLocked(main, held));
  // A thread/<id8> worktree, however old, isn't a borrow.
  sh(main, `git worktree add -q -b thread/abcd1234 ${path.join(path.dirname(main), 'proj-threads', 'abcd1234')} main`);
  const again = await sweepBorrows(main, opts({ now: Date.now() + 9 * DAY }));
  assert.ok(!again.reclaimed.some((x) => x.path.endsWith('abcd1234')));
});

test("sync-main's scratch borrow, its process killed mid-check, is reset and taken back; a live one isn't", async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const wt = borrow(main, 'THREADBEAR_BORROW_PID=999999 THREADBEAR_BORROW_SCRATCH=1');
  // What a killed sync-main leaves: GitHub's commits under this Mac's, not on main.
  commit(wt, { 'runner/github.ts': 'theirs\n' }, 'From GitHub');
  write(wt, { 'check-output.txt': 'left by the check\n' });
  const live = await sweepBorrows(main, opts({ pidAlive: () => true }));
  assert.deepEqual(live.reclaimed, []);
  const r = await sweepBorrows(main, opts({ pidAlive: () => false }));
  assert.deepEqual(r.reclaimed.map((x) => [x.path, x.why, x.to]), [[wt, 'the script that borrowed it has ended', 'spare']]);
  assert.equal(sh(wt, 'git rev-parse HEAD'), sh(main, 'git rev-parse main'));
  assert.ok(!fs.existsSync(path.join(wt, 'check-output.txt')));
  assert.equal(sh(main, 'git log -1 --format=%s main'), 'scripts', "main isn't touched");
});

test("a borrow that isn't scratch keeps its unlanded work even once its process has gone", async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const wt = borrow(main, 'THREADBEAR_BORROW_PID=999999');
  commit(wt, { 'runner/mine.ts': '1\n' }, 'Mine');
  const r = await sweepBorrows(main, opts());
  assert.deepEqual(r.reclaimed, []);
  assert.equal(sh(wt, 'git log -1 --format=%s'), 'Mine');
});

test('past MAX_SPARES a borrow taken back is removed, and leftover borrow branches all on main are deleted', async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const wts = Array.from({ length: 7 }, () => borrow(main, 'THREADBEAR_THREAD_ID=gone'));
  sh(main, 'git branch thread/borrow-slot-99-20261101-000000 main');
  commit(main, { 'runner/z.ts': '1\n' }, 'Ahead');
  sh(main, 'git branch thread/borrow-slot-98-20261101-000000 main');
  sh(main, 'git reset -q --hard HEAD~1');
  const r = await sweepBorrows(main, opts({ thread: () => 'archived' }));
  assert.deepEqual(r.reclaimed.map((x) => x.to), ['spare', 'spare', 'spare', 'spare', 'spare', 'spare', 'removed']);
  assert.ok(!fs.existsSync(wts.at(-1)!));
  assert.deepEqual(r.branches, ['thread/borrow-slot-99-20261101-000000']);
  assert.notEqual(sh(main, 'git branch --list thread/borrow-slot-98-20261101-000000'), '', 'one with work not on main stays');
});

test("a live borrower keeps it however quiet, and a dev runner's thread's borrow is that runner's while its data dir is there", async () => {
  const { root, main } = makeRepo();
  addBorrowScript(main);
  const live = borrow(main, 'THREADBEAR_BORROW_PID=4242');
  const dev = path.join(root, 'dev-home');
  fs.mkdirSync(dev);
  const devs = borrow(main, `THREADBEAR_THREAD_ID=dev-1 THREADBEAR_RUNNER_HOME=${dev}`);
  const later = { now: Date.now() + 9 * DAY, home: path.join(root, 'real-home') };
  const r = await sweepBorrows(main, opts({ ...later, pidAlive: () => true }));
  assert.deepEqual(r.reclaimed, []);
  fs.rmSync(dev, { recursive: true });
  const gone = await sweepBorrows(main, opts({ ...later, pidAlive: () => true }));
  assert.deepEqual(gone.reclaimed.map((x) => x.path), [devs], 'its dev runner gone, it goes after a quiet day');
  assert.match(branchOf(live), /^thread\/borrow-/);
});

test("a commit made between the sweep's checks and its detach keeps the borrow and its branch", async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const wt = borrow(main, 'THREADBEAR_THREAD_ID=gone');
  const branch = branchOf(wt);
  // The borrower commits after the sweep has found it clean and all on main.
  let sneaked = false;
  const r = await sweepBorrows(main, opts({ thread: () => 'archived' }), {
    beforeDetach: () => {
      commit(wt, { 'runner/late.ts': '1\n' }, 'Late');
      sneaked = true;
    },
  });
  assert.ok(sneaked);
  assert.deepEqual(r.reclaimed, []);
  assert.equal(branchOf(wt), branch, 'put back on its branch');
  assert.equal(sh(wt, 'git log -1 --format=%s'), 'Late');
  assert.ok(!isLocked(main, wt));
});

test('a borrow folder swapped for a link to main is never touched', async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const wt = borrow(main, 'THREADBEAR_BORROW_PID=999999 THREADBEAR_BORROW_SCRATCH=1');
  write(main, { 'mine.txt': 'main checkout work\n' });
  const r = await sweepBorrows(main, opts(), {
    afterPick: () => {
      fs.renameSync(wt, `${wt}.moved`);
      fs.symlinkSync(main, wt);
    },
  });
  assert.deepEqual(r.reclaimed, []);
  assert.equal(fs.readFileSync(path.join(main, 'mine.txt'), 'utf8'), 'main checkout work\n');
  assert.equal(sh(main, 'git rev-parse --abbrev-ref HEAD'), 'main');
});

test("a dead script's record left in a folder someone switched to their own branch never touches their rebase", async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const wt = borrow(main, 'THREADBEAR_BORROW_PID=999999 THREADBEAR_BORROW_SCRATCH=1');
  sh(wt, 'git checkout -q -b feature');
  commit(wt, { 'README.md': 'feature\n' }, 'Feature');
  commit(main, { 'README.md': 'main\n' }, 'Main');
  sh(wt, 'git rebase -q main >/dev/null 2>&1 || true');
  assert.ok(fs.existsSync(path.join(admin(wt), 'rebase-merge')), 'a conflicted rebase in progress');
  const r = await sweepBorrows(main, opts({ now: Date.now() + 9 * DAY }));
  assert.deepEqual(r.reclaimed, []);
  assert.ok(fs.existsSync(path.join(admin(wt), 'rebase-merge')), 'their rebase is still there');
});

test('an orphan borrow branch whose work is only on its upstream, not main, is kept', async () => {
  const { root, main } = makeRepo();
  addBorrowScript(main);
  sh(root, 'git init -q --bare -b main up.git');
  sh(main, `git remote add origin ${path.join(root, 'up.git')} && git push -q origin main`);
  sh(main, 'git checkout -q -b thread/borrow-slot-9-20261101-000000');
  commit(main, { 'runner/pushed.ts': '1\n' }, 'Pushed only');
  sh(main, 'git push -q -u origin thread/borrow-slot-9-20261101-000000 && git checkout -q main');
  const r = await sweepBorrows(main, opts());
  assert.deepEqual(r.branches, []);
  assert.notEqual(sh(main, 'git branch --list thread/borrow-slot-9-20261101-000000'), '');
});

test("borrow-worktree.sh passes over slots git still has registered after their folder went", () => {
  const { root, main } = makeRepo();
  addBorrowScript(main);
  const threads = path.join(root, 'proj-threads');
  for (let n = 1; n <= 6; n++) {
    sh(main, `git worktree add -q --detach ${path.join(threads, `slot-${n}`)} main`);
    fs.rmSync(path.join(threads, `slot-${n}`), { recursive: true });
  }
  assert.equal(borrow(main), path.join(threads, 'slot-7'));
});

test('a give-back stopped after its detach, record still there, goes back after a quiet day', async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const wt = borrow(main, 'THREADBEAR_THREAD_ID=gone');
  sh(wt, 'git checkout -q --detach');
  assert.deepEqual((await sweepBorrows(main, opts({ thread: () => 'archived' }))).reclaimed, []);
  const later = await sweepBorrows(main, opts({ thread: () => 'archived', now: Date.now() + DAY + 60_000 }));
  assert.deepEqual(later.reclaimed.map((x) => x.path), [wt]);
});

test('a thread brought back while the sweep works keeps its borrow', async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const wt = borrow(main, 'THREADBEAR_THREAD_ID=t-1');
  const branch = branchOf(wt);
  let state: 'archived' | 'open' = 'archived';
  const r = await sweepBorrows(main, opts({ thread: () => state }), { beforeDetach: () => void (state = 'open') });
  assert.deepEqual(r.reclaimed, []);
  assert.equal(branchOf(wt), branch);
});

test('a borrow landed under new commit ids (a group check rebased it) goes back too', async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const wt = borrow(main, 'THREADBEAR_THREAD_ID=gone');
  commit(wt, { 'runner/b.ts': '2\n' }, 'Landed by patch');
  commit(main, { 'runner/other.ts': '1\n' }, 'Someone else first');
  sh(main, `git cherry-pick $(git -C ${wt} rev-parse HEAD) >/dev/null`);
  const r = await sweepBorrows(main, opts({ thread: () => 'archived' }));
  assert.deepEqual(r.reclaimed.map((x) => x.path), [wt]);
});

test('borrow-worktree.sh passes over a spare with edits to tracked files, keeping them', () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const wt = borrow(main, 'THREADBEAR_THREAD_ID=t-1');
  assert.match(sh(main, `./borrow-worktree.sh --give-back ${wt}`), /is a spare again/);
  write(wt, { 'README.md': 'someone is working here\n' });
  const next = borrow(main, 'THREADBEAR_THREAD_ID=t-2');
  assert.notEqual(next, wt);
  assert.equal(fs.readFileSync(path.join(wt, 'README.md'), 'utf8'), 'someone is working here\n');
});

// Codex's review, 21 Nov: between claiming a spare (its lock renamed away)
// and checking out its branch, the folder is detached and unlocked, which
// the sweep took for a spare claimed and never set up after a quiet day,
// and locked back into the pool under the thread setting it up.
test('a spare being set up after its claim is not taken back; one claimed and left is, after a quiet day', async () => {
  const { main } = makeRepo();
  addBorrowScript(main);
  const wt = borrow(main, 'THREADBEAR_THREAD_ID=t-1');
  assert.match(sh(main, `./borrow-worktree.sh --give-back ${wt}`), /is a spare again/);
  const a = admin(wt);
  const later = Date.now() + 9 * DAY;
  const claim = path.join(a, `locked.claimed-4242-${Date.now()}`);
  fs.renameSync(path.join(a, 'locked'), claim);
  fs.utimesSync(claim, new Date(later), new Date(later));
  const mid = await sweepBorrows(main, opts({ now: later }));
  assert.deepEqual(mid.reclaimed, []);
  assert.ok(!isLocked(main, wt), 'left to its claimer');
  // Its claimer gone, the claim a day old: back in the pool.
  const after = await sweepBorrows(main, opts({ now: later + DAY + 60_000 }));
  assert.deepEqual(after.reclaimed.map((r) => r.to), ['spare']);
  assert.ok(isLocked(main, wt));
});
