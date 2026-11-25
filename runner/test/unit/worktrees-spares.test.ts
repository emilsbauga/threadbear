// worktrees: spares, handovers and turn-end hooks (helpers/worktrees-harness.ts says why it's several files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness } from '../helpers/fakes.ts';
import { findWorktreePatch } from '../../src/patches.ts';
import { cleanUpWorktree, clearBuildCaches, land, makeWorktree, MAX_SPARES } from '../../src/worktrees.ts';
import { HOOK_PATCH, KEEP, addBorrowScript, archiveAfterEdit, wrapGit, capture, commit, harness, hookRuns, isLocked, makeBranch, makeRepo, notes, sh, slowWorktreeRemoval, threadWithWorktree, toldAgent, until, write } from '../helpers/worktrees-harness.ts';

test('with keep, an archived landed worktree is kept as a spare, and the next thread takes it, build cache and all', async () => {
  const { root, main } = makeRepo(KEEP);
  const h = harness();
  const a = await threadWithWorktree(h, main);
  const slot = path.join(root, 'proj-threads', 'slot-1');
  assert.equal(a.w.path, slot, 'named for the slot, not the thread, as it outlives it');
  assert.deepEqual(h.store.load(a.id)?.worktree?.keep, ['app/.build']);
  commit(slot, { 'runner/b.ts': '2\n' }, 'Landed work');
  assert.equal(await land({ path: slot, branch: a.w.branch, mainCheckout: main }, capture().opts), 0);
  write(slot, { 'app/.build/cache.o': 'warm\n', 'node_modules/old.js': 'stale\n', 'scratch.txt': 'untracked\n' });

  h.runner.update({ threadId: a.id, archived: true });
  await until(() => notes(h, a.id).some((n) => n.includes('for the next thread')), 'the cleanup');
  assert.equal(notes(h, a.id).at(-1), `Deleted this thread's branch ${a.w.branch} (everything on it is on main) and kept its worktree, build caches and all, for the next thread.`);
  assert.ok(isLocked(main, slot), 'locked as a spare');
  assert.equal(sh(main, `git branch --list ${a.w.branch}`), '');
  assert.equal(h.runner.get(a.id).worktree, undefined);

  const b = await threadWithWorktree(h, main);
  assert.equal(b.w.path, slot, 'took the spare');
  assert.equal(h.adapter.last.opts.cwd, path.join(slot, 'runner'));
  assert.ok(!isLocked(main, slot));
  assert.equal(sh(slot, 'git rev-parse --abbrev-ref HEAD'), b.w.branch);
  assert.equal(sh(slot, 'git rev-parse HEAD'), sh(main, 'git rev-parse main'));
  assert.equal(fs.readFileSync(path.join(slot, 'app/.build/cache.o'), 'utf8'), 'warm\n', 'the kept folder stays');
  assert.ok(!fs.existsSync(path.join(slot, 'node_modules')), "ignored files that aren't kept go");
  assert.ok(!fs.existsSync(path.join(slot, 'scratch.txt')));
  assert.ok(fs.existsSync(path.join(slot, '.setup-ran')), 'setup ran again');
  assert.equal(sh(slot, 'git status --porcelain'), '');

  // The first thread, brought back, never carries on in what's now b's
  // folder: it gets another of its own.
  h.runner.send(a.id, 'More please');
  await until(() => h.adapter.sessions.filter((s) => s.opts.threadId === a.id).length === 2, "a's new CLI");
  const again = h.runner.get(a.id).worktree!;
  assert.ok(again && again.path !== slot, 'not b\'s folder');
  assert.equal(h.adapter.last.opts.cwd, path.join(again.path, 'runner'));
  assert.ok(notes(h, a.id).includes(`This thread's worktree was handed on to other threads when it was archived, so it carries on in a fresh one at ${again.path}, on the branch ${again.branch}, made from main. tb land puts it on main.`));
  assert.match(h.adapter.last.sent.at(-1)!.text, new RegExp(`Your worktree at ${slot} was handed on to other threads after its work landed on main`));
});

test('with keep, two threads at once never share a spare, and an unlanded worktree is never kept', async () => {
  const { root, main } = makeRepo(KEEP);
  const patch = (await findWorktreePatch(main, root))!;
  const one = await makeWorktree({ cwd: main, threadId: 'aaaaaaaa-1', patch });
  assert.ok(one.ok);
  assert.deepEqual(await cleanUpWorktree(one.worktree), { removed: true, spare: true });
  const [x, y] = await Promise.all([
    makeWorktree({ cwd: main, threadId: 'bbbbbbbb-1', patch }),
    makeWorktree({ cwd: main, threadId: 'cccccccc-1', patch }),
  ]);
  assert.ok(x.ok && y.ok);
  assert.deepEqual([x.worktree.path, y.worktree.path].sort(), [path.join(root, 'proj-threads', 'slot-1'), path.join(root, 'proj-threads', 'slot-2')]);

  commit(x.worktree.path, { 'runner/b.ts': '2\n' }, 'Not landed');
  assert.deepEqual(await cleanUpWorktree(x.worktree), { removed: false, reason: `${x.worktree.branch} has commits that aren't on main` });
  assert.ok(!isLocked(main, x.worktree.path));
});

test(`with keep, past ${MAX_SPARES} spares an archived worktree is removed as before`, async () => {
  const { root, main } = makeRepo(KEEP);
  const patch = (await findWorktreePatch(main, root))!;
  const made = [];
  for (let i = 0; i <= MAX_SPARES; i++) {
    const m = await makeWorktree({ cwd: main, threadId: `${String(i).padStart(8, '0')}-x`, patch });
    assert.ok(m.ok);
    made.push(m.worktree);
  }
  for (const w of made.slice(0, MAX_SPARES)) assert.deepEqual(await cleanUpWorktree(w), { removed: true, spare: true });
  const last = made[MAX_SPARES];
  assert.deepEqual(await cleanUpWorktree(last), { removed: true });
  assert.ok(!fs.existsSync(last.path));
  assert.equal(sh(main, `git branch --list ${last.branch}`), '');
});

// ------------------------------------------------- handovers and stale records

// THREADBEAR-16 (6 Nov): a thread archived as a handover began. The cleanup
// was still running git when the draining runner saved the record and let
// the thread go, so its result (removedAt and the note) was lost, and the
// note's emit threw on the let-go thread.
test('a handover waits for an archived thread\'s worktree cleanup, so the saved record says it was removed', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const restore = slowWorktreeRemoval();
  try {
    h.runner.update({ threadId: id, archived: true });
    const rt = (h.runner as any).threads.get(id).rt;
    // The CLI has gone and the cleanup has started, but git hasn't finished.
    await until(() => rt.archivePending === false, 'the cleanup to start');
    assert.ok(fs.existsSync(w.path), 'still removing');
    const handed: string[] = [];
    await h.runner.beginDrain([], { onHandedOver: (t) => handed.push(t) });
    await until(() => handed.includes(id), 'the handover');
  } finally {
    restore();
  }
  assert.equal(h.runner.has(id), false);
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'threads', id, 'thread.json'), 'utf8'));
  assert.ok(saved.worktree.removedAt, 'removedAt was saved');
  assert.ok(!fs.existsSync(w.path));
  assert.ok(notes(h, id).includes(`Removed this thread's worktree and its branch ${w.branch}: everything on it is on main.`));
});

test('cleanUpWorktree leaves a folder that is now another thread\'s worktree, from a record that missed its removal', async () => {
  const { main } = makeRepo();
  const old = makeBranch(main, 'old00000');
  const rec = { repo: 'proj', mainCheckout: main, path: old.path, branch: old.branch, base: sh(main, 'git rev-parse main') };
  // Removed, but the record never heard; then a new thread took the folder.
  sh(main, `git worktree remove ${old.path} && git branch -D ${old.branch}`);
  sh(main, `git worktree add -q -b thread/new00000 ${old.path} main`);
  write(old.path, { 'scratch.txt': 'the new thread\'s untracked work\n' });
  assert.deepEqual(await cleanUpWorktree(rec), { removed: true, taken: true });
  assert.equal(fs.readFileSync(path.join(old.path, 'scratch.txt'), 'utf8'), 'the new thread\'s untracked work\n');
  assert.equal(sh(old.path, 'git rev-parse --abbrev-ref HEAD'), 'thread/new00000');

  // A spare (detached and locked) or a borrowed worktree is left alone too,
  // and a landed branch of ours that's still there goes.
  const other = makeBranch(main, 'oth00000');
  const rec2 = { repo: 'proj', mainCheckout: main, path: other.path, branch: other.branch, base: rec.base };
  sh(other.path, 'git checkout -q --detach');
  assert.deepEqual(await cleanUpWorktree(rec2), { removed: true, taken: true });
  assert.ok(fs.existsSync(other.path));
  assert.equal(sh(main, `git branch --list ${other.branch}`), '');
});

test('a thread brought back whose worktree folder is now another\'s carries on in the main checkout', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  // As THREADBEAR-16 left it: worktree and branch gone, record not told,
  // and then another thread took the folder.
  sh(main, `git worktree remove --force ${w.path} && git branch -D ${w.branch}`);
  sh(main, `git worktree add -q -b thread/zzzz0000 ${w.path} main`);
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.includes('another')), 'the cleanup');
  assert.ok(fs.existsSync(w.path), "the other thread's worktree stays");
  assert.equal(h.runner.get(id).worktree, undefined, 'no Land chip');
  h.runner.send(id, 'More please');
  await until(() => h.adapter.last.opts.cwd === path.join(main, 'runner'), 'a new CLI in the main checkout');
});

test("at start, an archived thread whose worktree and branch went unrecorded is told; one that's still there isn't", async () => {
  const { main } = makeRepo();
  const h = harness();
  const lost = await threadWithWorktree(h, main);
  const kept = await threadWithWorktree(h, main);
  sh(main, `git worktree remove --force ${lost.w.path} && git branch -D ${lost.w.branch}`);
  const threads = (h.runner as any).threads;
  for (const id of [lost.id, kept.id]) threads.get(id).rec.archivedAt = new Date(h.clock.now()).toISOString();
  await h.runner.settleLostCleanups();
  assert.ok(threads.get(lost.id).rec.worktree.removedAt);
  assert.equal(h.runner.get(lost.id).worktree, undefined, 'no Land chip');
  assert.equal(threads.get(kept.id).rec.worktree.removedAt, undefined);
  assert.equal(notes(h, lost.id).filter((n) => n.includes('worktree')).length, 1, 'quietly: only the note from when it was made');
});

test('a message sent while the archive cleanup runs waits for it, then starts in a fresh worktree', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const restore = slowWorktreeRemoval();
  try {
    h.runner.update({ threadId: id, archived: true });
    const rt = (h.runner as any).threads.get(id).rt;
    await until(() => rt.archivePending === false, 'the cleanup to start');
    assert.ok(fs.existsSync(w.path), 'still removing');
    h.runner.send(id, 'More please');
    await until(() => h.adapter.sessions.length === 2, 'a new CLI');
  } finally {
    restore();
  }
  const fresh = h.runner.get(id).worktree!;
  assert.ok(fresh, 'a fresh one, with its Land chip');
  assert.equal(h.adapter.last.opts.cwd, path.join(fresh.path, 'runner'), 'not the folder being removed');
  assert.notEqual(fs.realpathSync(fresh.path), fs.realpathSync(main));
});

test('a thread deleted while a handover waits for its cleanup stays deleted', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id } = await threadWithWorktree(h, main);
  // So the delete really lands while the handover waits on git.
  const restore = slowWorktreeRemoval();
  try {
    h.runner.update({ threadId: id, archived: true });
    const rt = (h.runner as any).threads.get(id).rt;
    await until(() => rt.archivePending === false, 'the cleanup to start');
    const drained = h.runner.beginDrain([], { onHandedOver: () => undefined });
    h.runner.delete(id);
    await drained;
  } finally {
    restore();
  }
  assert.ok(!fs.existsSync(path.join(h.home, 'threads', id)), 'not saved back');
});

test("a handover doesn't wait on a thread's cleanup to let the rest go, nor for ever on one that never finishes", async () => {
  const h = harness();
  const { thread } = h.runner.create({ text: 'Go', accountId: 'claude-3' });
  h.adapter.last.init();
  h.adapter.last.result();
  const other = h.runner.create({ text: 'Other', accountId: 'claude-3' }).thread;
  h.adapter.last.init();
  h.adapter.last.result();
  const rt = (h.runner as any).threads.get(thread.id).rt;
  rt.cleaning = new Promise(() => undefined);
  const handed: string[] = [];
  await h.runner.beginDrain([], { onHandedOver: (id) => handed.push(id) });
  assert.equal(h.runner.has(other.id), false, 'the rest go at once');
  assert.deepEqual(h.runner.keeping(), [thread.id]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.runner.has(thread.id), true, 'waits a while');
  h.clock.advance(10 * 60_000);
  await until(() => handed.includes(thread.id), 'the handover past the limit');
  assert.equal(h.runner.has(thread.id), false);
});

test('at start, an archived thread whose slot folder another thread has since taken is marked as handed on', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  sh(main, `git worktree remove --force ${w.path} && git branch -D ${w.branch}`);
  sh(main, `git worktree add -q -b thread/yyyy0000 ${w.path} main`);
  const rec = (h.runner as any).threads.get(id).rec;
  rec.archivedAt = new Date(h.clock.now()).toISOString();
  await h.runner.settleLostCleanups();
  assert.ok(rec.worktree.removedAt);
  assert.equal(rec.worktree.spare, true, 'so it never carries on in the other thread\'s folder');
  assert.ok(fs.existsSync(w.path));
});

test('a message sent to a stale archived thread while the start check runs waits for it, so never starts in the reused folder', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  sh(main, `git worktree remove --force ${w.path} && git branch -D ${w.branch}`);
  sh(main, `git worktree add -q -b thread/xxxx0000 ${w.path} main`);
  // As at a start: no CLI, archived.
  const st = (h.runner as any).threads.get(id);
  (h.runner as any).releaseSession(st);
  await st.rt.closing;
  st.rec.archivedAt = new Date(h.clock.now()).toISOString();
  const settled = h.runner.settleLostCleanups();
  h.runner.send(id, 'More please');
  await settled;
  await until(() => h.adapter.sessions.length === 2, 'a new CLI');
  assert.equal(h.adapter.last.opts.cwd, path.join(main, 'runner'));
});

test('cleanUpWorktree changes nothing once the thread has been handed to another runner', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  const rec = { repo: 'proj', mainCheckout: main, path: t.path, branch: t.branch, base: sh(main, 'git rev-parse main') };
  assert.deepEqual(await cleanUpWorktree(rec, () => false), { removed: false, reason: 'the thread was handed to another runner' });
  assert.ok(fs.existsSync(t.path));
  assert.ok(sh(main, `git branch --list ${t.branch}`).includes(t.branch));
});

test('an archive waits for a running turn.end hook: it sees the whole worktree, passes, and the thread stays archived', async () => {
  // Fails if a.ts has gone by the time it looks, as the typecheck did.
  const { main } = makeRepo(HOOK_PATCH('sleep 0.6; test -f a.ts'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const sessions = h.adapter.sessions.length;
  await archiveAfterEdit(h, id);
  await until(() => h.adapter.last.ended === true, 'the CLI to go');
  assert.equal(hookRuns(h, id).length, 0, 'the hook is still running');
  assert.ok(fs.existsSync(path.join(w.path, 'runner/a.ts')), 'and its files are still there');
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup, after the hook');
  assert.deepEqual(hookRuns(h, id).map((e) => e.ok), [true]);
  assert.equal(toldAgent(h, id).length, 0);
  assert.ok(h.runner.get(id).archivedAt, 'still archived');
  assert.equal(h.adapter.sessions.length, sessions, 'not woken');
  assert.ok(!fs.existsSync(w.path));
});

test('a real hook failure on a thread being archived brings it back in its own worktree, which stays', async () => {
  const { main } = makeRepo(HOOK_PATCH('sleep 0.3; echo really broken >&2; exit 1'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const sessions = h.adapter.sessions.length;
  await archiveAfterEdit(h, id);
  await until(() => h.adapter.sessions.length === sessions + 1, 'the thread to be told');
  assert.match(toldAgent(h, id)[0].text, /really broken/);
  const t = h.runner.get(id);
  assert.equal(t.archivedAt, undefined, 'back from the archive');
  assert.equal(h.adapter.last.opts.cwd, path.join(w.path, 'runner'), 'where its work is');
  assert.ok(fs.existsSync(w.path));
  assert.ok(!notes(h, id).some((n) => n.startsWith('Removed')));
});

test('a hook that tells the agent even when it passes leaves an archived thread archived', async () => {
  const { main } = makeRepo(HOOK_PATCH('sleep 0.3; echo fine', 'always'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const sessions = h.adapter.sessions.length;
  await archiveAfterEdit(h, id);
  await until(() => hookRuns(h, id).length === 1, 'the hook');
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup');
  assert.deepEqual(hookRuns(h, id).map((e) => e.ok), [true]);
  assert.equal(toldAgent(h, id).length, 0);
  assert.ok(h.runner.get(id).archivedAt);
  assert.equal(h.adapter.sessions.length, sessions);
  assert.ok(!fs.existsSync(w.path));
});

test('a hook whose folder went while it ran is not reported as a failure and wakes nothing', async () => {
  // Gone some other way than the archive, which now waits: by hand, say.
  const { main } = makeRepo(HOOK_PATCH('rm -rf "$PWD"; exit 1'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const sessions = h.adapter.sessions.length;
  await h.runner.patchesIdle();
  const s = h.adapter.last;
  h.runner.send(id, 'Edit');
  s.out({ kind: 'event', event: { type: 'edit.diff', itemId: 'e1', path: 'a.ts', hunks: [] } });
  s.result('completed');
  await until(() => notes(h, id).some((n) => n.includes('Check')), 'the note about the hook');
  assert.equal(notes(h, id).at(-1), `The hook "Check" had its folder ${path.join(w.path, 'runner')} removed while it ran, so its result says nothing about the code.`);
  assert.equal(hookRuns(h, id).length, 0);
  assert.equal(toldAgent(h, id).length, 0);
  assert.equal(h.adapter.sessions.length, sessions);
});

test('a handover that starts while a hook runs keeps the thread, so the archive\'s cleanup still happens and is saved', async () => {
  const { main } = makeRepo(HOOK_PATCH('sleep 0.6; test -f a.ts'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  await archiveAfterEdit(h, id);
  await until(() => h.adapter.last.ended === true, 'the CLI to go');
  const handed: string[] = [];
  // It has no turn, so the restarter doesn't count it as busy.
  await h.runner.beginDrain([], { onHandedOver: (t) => handed.push(t) });
  assert.equal(h.runner.has(id), true, 'held while its hook runs');
  await until(() => handed.includes(id), 'the handover');
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'threads', id, 'thread.json'), 'utf8'));
  assert.ok(saved.worktree.removedAt, 'removedAt was saved');
  assert.ok(saved.archivedAt, 'still archived');
  assert.equal(saved.queue?.length ?? 0, 0, 'nothing to wake it');
  assert.ok(!fs.existsSync(w.path));
});

test('a runner that stops while an archive waits for a hook leaves the cleanup to the next one', async () => {
  const { main } = makeRepo(HOOK_PATCH('sleep 0.3'));
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  await archiveAfterEdit(h, id);
  await until(() => h.adapter.last.ended === true, 'the CLI to go');
  await h.runner.shutdown();
  assert.ok(fs.existsSync(w.path), 'nothing removed it yet');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(fs.existsSync(w.path), 'nor as the hook ended, on a runner that was stopping');
  const next = makeHarness(h.home, {}, { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 10_000 });
  await until(() => notes(next, id).some((n) => n.startsWith('Removed')), 'the next runner to clean up');
  assert.ok(!fs.existsSync(w.path));
  assert.equal(next.runner.get(id).worktree, undefined);
  assert.ok(next.runner.get(id).archivedAt);
  // Once only: the runner after that has nothing owed.
  next.runner.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, 'threads', id, 'thread.json'), 'utf8')).worktree.cleanupOwed, undefined);
});

test('a cleanup that keeps the worktree is not owed again, so the next runner says nothing more', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  commit(w.path, { 'runner/b.ts': '2\n' }, 'Not landed');
  h.runner.update({ threadId: id, archived: true });
  await until(() => notes(h, id).some((n) => n.includes(' stay: ')), 'the cleanup');
  await h.runner.shutdown();
  const next = makeHarness(h.home, {}, { actionShell: ['/bin/sh', '-c'] });
  // Started as it loaded; this waits for it. A harness's events are what
  // happened since it started.
  await (next.runner as any).threads.get(id).rt.cleaning;
  assert.equal(notes(next, id).filter((n) => n.includes(' stay: ')).length, 0);
});

test('a hook that ignores SIGTERM still ends at the timeout, so the archive waiting for it is not held for ever', async () => {
  const { main } = makeRepo(HOOK_PATCH(`trap '' TERM; while :; do sleep 0.2; done`, 'never'));
  const h = makeHarness(undefined, {}, { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 300 });
  const { id, w } = await threadWithWorktree(h, main);
  await archiveAfterEdit(h, id);
  await until(() => notes(h, id).some((n) => n.startsWith('Removed')), 'the cleanup, past the hook');
  assert.deepEqual(hookRuns(h, id).map((e) => e.ok), [false]);
  assert.match(hookRuns(h, id)[0].text, /Stopped after/);
  assert.ok(!fs.existsSync(w.path));
});

test('adopting a thread still owed a cleanup leaves it, as the old runner\'s git may still be at it; the next start does it', async () => {
  const { main } = makeRepo();
  const h = harness();
  const { id, w } = await threadWithWorktree(h, main);
  const threads = (h.runner as any).threads;
  // As letGo leaves it when its wait for a hung cleanup runs out.
  const rec = threads.get(id).rec;
  rec.archivedAt = new Date(h.clock.now()).toISOString();
  rec.worktree.cleanupOwed = true;
  (h.runner as any).store.save(rec);
  threads.delete(id);
  h.runner.adopt(id);
  await threads.get(id).rt.cleaning;
  assert.ok(fs.existsSync(w.path));
  assert.equal(threads.get(id).rec.worktree.cleanupOwed, true, 'still owed');
  h.runner.flush();
  await h.runner.shutdown();
  const next = makeHarness(h.home, {}, { actionShell: ['/bin/sh', '-c'] });
  await until(() => notes(next, id).some((n) => n.startsWith('Removed')), 'the cleanup at the next start');
  assert.ok(!fs.existsSync(w.path));
});

test("with keep, an archived worktree that has to stay loses its build caches, as no other thread can use them", async () => {
  const { main } = makeRepo(KEEP);
  const h = harness();
  const a = await threadWithWorktree(h, main);
  commit(a.w.path, { 'runner/b.ts': '2\n' }, 'Not landed');
  write(a.w.path, { 'app/.build/cache.o': 'warm\n', 'scratch.txt': 'untracked\n' });
  h.runner.update({ threadId: a.id, archived: true });
  await until(() => notes(h, a.id).some((n) => n.includes(' stay: ')), 'the cleanup');
  assert.match(notes(h, a.id).at(-1)!, / Its build caches \(app\/\.build\) were cleared to save space, and get built again if it carries on\.$/);
  assert.ok(!fs.existsSync(path.join(a.w.path, 'app/.build')), 'the build cache went');
  assert.deepEqual(fs.readdirSync(a.w.path).filter((f) => f.startsWith('.threadbear-clearing')), [], 'nothing left set aside');
  assert.equal(fs.readFileSync(path.join(a.w.path, 'scratch.txt'), 'utf8'), 'untracked\n', 'the thread\'s own files stay');
  assert.equal(sh(a.w.path, 'git rev-parse --abbrev-ref HEAD'), a.w.branch, 'still on its branch, with its work');
  assert.ok(!isLocked(main, a.w.path), 'not a spare');
});

test('clearBuildCaches leaves a cache folder reached through a link, and a folder that is another checkout now', async () => {
  const { root, main } = makeRepo(KEEP);
  const t = makeBranch(main);
  const elsewhere = path.join(root, 'elsewhere');
  write(elsewhere, { 'precious.o': 'keep me\n' });
  fs.mkdirSync(path.join(t.path, 'app'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(t.path, 'app/.build'));
  const rec = { repo: 'proj', mainCheckout: main, path: t.path, branch: t.branch, base: sh(main, 'git rev-parse main'), keep: ['app/.build'] };
  assert.deepEqual(await clearBuildCaches(rec), []);
  assert.equal(fs.readFileSync(path.join(elsewhere, 'precious.o'), 'utf8'), 'keep me\n');
  assert.ok(fs.lstatSync(path.join(t.path, 'app/.build')).isSymbolicLink(), 'the link stays too');

  // The folder switched to another branch: someone else's now.
  fs.unlinkSync(path.join(t.path, 'app/.build'));
  write(t.path, { 'app/.build/theirs.o': 'in use\n' });
  sh(t.path, 'git checkout -q -b someone-else');
  assert.deepEqual(await clearBuildCaches(rec), []);
  assert.equal(fs.readFileSync(path.join(t.path, 'app/.build/theirs.o'), 'utf8'), 'in use\n');

  // Back on its own branch, a real folder: it goes.
  sh(t.path, `git checkout -q ${t.branch}`);
  assert.deepEqual(await clearBuildCaches(rec), ['app/.build']);
  assert.ok(!fs.existsSync(path.join(t.path, 'app/.build')));
});

// 21 Nov: a new slot took the first number with no folder, but git keeps a
// checkout registered after its folder goes (removed by hand, say) and
// refuses to add another there, after making the thread's branch. So every
// new thread with no spare to take got no worktree, started in the main
// checkout, and left a thread/<id8> branch that refused its next try.
// borrow-worktree.sh already passed such numbers over.
test('a new slot passes over a number git still has registered after its folder went, and one git refuses leaves no branch', async () => {
  const { root, main } = makeRepo(KEEP);
  const threads = path.join(root, 'proj-threads');
  const patch = (await findWorktreePatch(main, root))!;
  const one = await makeWorktree({ cwd: main, threadId: 'aaaaaaaa-1', patch });
  assert.ok(one.ok);
  fs.rmSync(one.worktree.path, { recursive: true, force: true });
  const two = await makeWorktree({ cwd: main, threadId: 'bbbbbbbb-1', patch });
  assert.ok(two.ok, two.ok ? '' : two.reason);
  assert.equal(two.worktree.path, path.join(threads, 'slot-2'));
  // A number git refuses though nothing was there (a borrow took it at that
  // moment), after making the branch as it does: the next, with no branch left.
  const once = path.join(root, 'refused-once');
  const restore = wrapGit('add', `if [ ! -e '${once}' ]; then touch '${once}'; "$REAL" -C '${main}' branch thread/cccccccc main; echo "fatal: '${path.join(threads, 'slot-3')}' already exists" >&2; exit 128; fi`);
  let three;
  try {
    three = await makeWorktree({ cwd: main, threadId: 'cccccccc-1', patch });
  } finally {
    restore();
  }
  assert.ok(fs.existsSync(once), 'git refused the first');
  assert.ok(three.ok, three.ok ? '' : three.reason);
  assert.equal(three.worktree.path, path.join(threads, 'slot-4'));
  const branches = sh(main, "git for-each-ref --format='%(refname:short)' refs/heads/thread/").split('\n').sort();
  assert.deepEqual(branches, ['thread/aaaaaaaa', 'thread/bbbbbbbb', 'thread/cccccccc'], 'one branch each, none left by a failed add');
  assert.equal(sh(three.worktree.path, 'git rev-parse --abbrev-ref HEAD'), 'thread/cccccccc');
});

// A spare with changes to tracked files has someone working in it (its
// cleanup saw it clean): the next thread's reset would take them.
test('a spare with edits to tracked files is passed over, edits kept, and stays out of the pool', async () => {
  const { root, main } = makeRepo(KEEP);
  const patch = (await findWorktreePatch(main, root))!;
  const one = await makeWorktree({ cwd: main, threadId: 'aaaaaaaa-1', patch });
  assert.ok(one.ok);
  assert.deepEqual(await cleanUpWorktree(one.worktree), { removed: true, spare: true });
  write(one.worktree.path, { 'README.md': 'someone is working here\n' });
  const two = await makeWorktree({ cwd: main, threadId: 'bbbbbbbb-1', patch });
  assert.ok(two.ok && two.worktree.path !== one.worktree.path, 'a new slot, not the spare');
  assert.equal(fs.readFileSync(path.join(one.worktree.path, 'README.md'), 'utf8'), 'someone is working here\n');
  assert.ok(!isLocked(main, one.worktree.path), 'out of the pool');
  const three = await makeWorktree({ cwd: main, threadId: 'cccccccc-1', patch });
  assert.ok(three.ok && three.worktree.path !== one.worktree.path);
  assert.equal(fs.readFileSync(path.join(one.worktree.path, 'README.md'), 'utf8'), 'someone is working here\n');
});

// 23 Nov 2026: the Canvas thread borrowed slot-32 and moved itself there,
// gave it back the day before and stayed in it; borrow-worktree.sh lent it to
// another thread, and the Canvas thread's next turn committed on that
// borrower's branch. A slot a thread works in is never lent, and a thread
// never carries on in a slot that's someone else's now.
// The runner's clock brought up to the real one, which borrow-worktree.sh
// stamps its borrows with, so which came first reads as it happened.
const realTime = (h: ReturnType<typeof harness>) => h.clock.advance(Math.max(0, Date.now() - h.clock.now()));

async function threadInItsBorrow(h: ReturnType<typeof harness>, root: string, main: string) {
  realTime(h);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const started = h.adapter.sessions.length;
  const { thread } = h.runner.create({ text: 'Go', accountId: 'claude-3', cwd: outside });
  await until(() => h.adapter.sessions.length === started + 1, 'the CLI to start');
  h.adapter.last.init();
  h.adapter.last.result();
  const wt = sh(main, `THREADBEAR_RUNNER_HOME='${h.home}' THREADBEAR_THREAD_ID=${thread.id} ./borrow-worktree.sh 2>/dev/null`);
  // move_thread, as the Canvas thread did.
  realTime(h);
  const movedAt = h.clock.now();
  h.runner.update({ threadId: thread.id, cwd: wt });
  h.runner.send(thread.id, 'Work here');
  await until(() => h.adapter.sessions.length === started + 2, 'a CLI in the borrow');
  assert.equal(h.adapter.last.opts.cwd, wt, 'its own borrow: it works there');
  h.adapter.last.init();
  h.adapter.last.result();
  return { id: thread.id, wt, movedAt };
}

const liveCli = (h: ReturnType<typeof harness>, id: string) => (h.runner as unknown as { threads: Map<string, { rt: { session?: unknown } }> }).threads.get(id)?.rt.session;

// Its CLI let go, as one is after half an hour idle.
async function letGo(h: ReturnType<typeof harness>, id: string) {
  h.clock.advance(31 * 60_000);
  await until(() => !liveCli(h, id), 'the idle CLI to go');
}

test('a thread brought back to a slot it moved into, lent to another borrower since, carries on in a fresh worktree', async () => {
  const { root, main } = makeRepo(KEEP);
  addBorrowScript(main);
  const h = harness();
  const t = await threadInItsBorrow(h, root, main);
  sh(main, `./borrow-worktree.sh --give-back ${t.wt}`);
  const borrowAs = (id: string) => sh(main, `THREADBEAR_RUNNER_HOME='${h.home}' THREADBEAR_THREAD_ID=${id} ./borrow-worktree.sh 2>/dev/null`);
  await until(() => fs.readFileSync(path.join(h.home, 'threads', t.id, 'thread.json'), 'utf8').includes(t.wt), 'the record saved');
  const passedOver = borrowAs('other-0');
  assert.notEqual(passedOver, t.wt, 'not lent while the open thread is in it');
  sh(main, `./borrow-worktree.sh --give-back ${passedOver}`);
  // Archived, it works nowhere, so the next borrow may have the slot.
  h.runner.update({ threadId: t.id, archived: true });
  await until(() => !liveCli(h, t.id) && fs.readFileSync(path.join(h.home, 'threads', t.id, 'thread.json'), 'utf8').includes('archivedAt'), 'the archived CLI to go');
  // Borrows are stamped to the second: this one comes clearly after the move.
  await until(() => Math.floor(Date.now() / 1000) * 1000 > t.movedAt, 'a second past the move', 5000);
  const other = borrowAs('other-1');
  assert.equal(other, t.wt);
  const theirs = sh(other, 'git rev-parse --abbrev-ref HEAD');
  h.runner.update({ threadId: t.id, archived: false });
  const before = h.adapter.sessions.length;
  // A slash command waits for a message, which makes the move: in front of
  // the notice it would reach the agent as words.
  h.runner.send(t.id, '/compact');
  await until(() => notes(h, t.id).some((n) => n.includes('Send one first, then /compact again')), 'the note');
  assert.equal(h.adapter.sessions.length, before, 'no CLI for it in the lent slot');
  h.runner.send(t.id, 'More please');
  await until(() => h.adapter.sessions.length === before + 1, 'its next CLI');
  const w = h.runner.get(t.id).worktree!;
  assert.ok(w && w.path !== t.wt, 'a worktree of its own, not the borrower\'s');
  assert.equal(h.adapter.last.opts.cwd, w.path);
  assert.ok(notes(h, t.id).includes(`This thread's folder ${t.wt} was lent to another borrower, so it carries on in a fresh worktree at ${w.path}, on the branch ${w.branch}, made from main. tb land puts it on main.`));
  assert.match(h.adapter.last.sent.at(-1)!.text, new RegExp(`Your folder ${t.wt} was lent to another borrower, so it isn't yours to work in any more`));
  assert.equal(sh(other, 'git rev-parse --abbrev-ref HEAD'), theirs, "the borrower's branch untouched");
});

test('a spare an open thread still works in is passed over for a new thread, and that thread takes it back as its own', async () => {
  const { root, main } = makeRepo(KEEP);
  addBorrowScript(main);
  const h = harness();
  const t = await threadInItsBorrow(h, root, main);
  sh(main, `./borrow-worktree.sh --give-back ${t.wt}`);
  assert.ok(isLocked(main, t.wt));
  const n = await threadWithWorktree(h, main);
  assert.notEqual(n.w.path, t.wt, 'not the folder the open thread is in');
  assert.ok(isLocked(main, t.wt), 'still a spare');
  // Its next turn, its CLI still live from the turn that gave it back, finds
  // its folder a spare: that CLI goes, and it takes the folder as a worktree
  // of its own rather than work in the pool.
  assert.ok(liveCli(h, t.id));
  const before = h.adapter.sessions.length;
  h.runner.send(t.id, 'More please');
  await until(() => h.adapter.sessions.length === before + 1, 'its next CLI');
  const w = h.runner.get(t.id).worktree!;
  assert.equal(w?.path, t.wt);
  assert.ok(!isLocked(main, t.wt));
  assert.equal(sh(t.wt, 'git rev-parse --abbrev-ref HEAD'), w.branch);
});

test("a thread put in another's worktree or borrow after it was theirs (a Lab review's reviewer) stays there", async () => {
  const { root, main } = makeRepo(KEEP);
  addBorrowScript(main);
  const h = harness();
  const a = await threadWithWorktree(h, main);
  const t = await threadInItsBorrow(h, root, main);
  for (const folder of [path.join(a.w.path, 'runner'), t.wt]) {
    const before = h.adapter.sessions.length;
    // Made the second after: one in the same second as the borrow counts as
    // before it, as the safe side.
    await until(() => Math.floor(Date.now() / 1000) * 1000 > t.movedAt, 'a second past the borrow', 5000);
    realTime(h);
    const { thread } = h.runner.create({ text: 'Review it', accountId: 'claude-3', cwd: folder, worktree: false });
    await until(() => h.adapter.sessions.length === before + 1, 'the reviewer CLI');
    assert.equal(h.adapter.last.opts.cwd, folder);
    assert.equal(h.runner.get(thread.id).worktree, undefined);
    h.adapter.last.init();
    h.adapter.last.result();
    await letGo(h, thread.id);
    h.runner.send(thread.id, 'And again');
    await until(() => h.adapter.sessions.length === before + 2, 'its next CLI');
    assert.equal(h.adapter.last.opts.cwd, folder, 'still there on its next turn');
  }
});
