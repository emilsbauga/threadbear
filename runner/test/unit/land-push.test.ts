// tb land pushing main to GitHub once it has landed (worktrees.ts, pushMain;
// docs/thread-worktrees.md, "Syncing main with GitHub"). On 17 Nov GitHub's
// main had three commits of its own, so scripts/sync-main.sh waited for the
// landing lock behind an afternoon of landings and never got it: main here
// was 36 commits ahead and GitHub's 9 hours stale. Now the landing that
// holds the lock pushes, merging GitHub's in (checked) when it has moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { land, pushLimits } from '../../src/worktrees.ts';
import { pushAfterLanding } from '../../src/follow-origin.ts';
import { capture, commit, makeBranch, makeRepo, sh, write } from '../helpers/worktrees-harness.ts';

// A repo with a bare "GitHub" as origin, main pushed there, and another
// clone of it to make commits on GitHub's side.
function withOrigin() {
  const { root, main } = makeRepo();
  const bare = path.join(root, 'github.git');
  sh(root, `git init -q --bare -b main ${bare}`);
  sh(main, `git remote add origin ${bare} && git push -q origin main`);
  const other = path.join(root, 'other');
  sh(root, `git clone -q ${bare} ${other}`);
  return { root, main, bare, other };
}
const rev = (dir: string, ref: string): string => sh(dir, `git rev-parse ${ref}`);
const onGitHub = (fx: { bare: string }): string => rev(fx.bare, 'main');

test('after landing, main is pushed when GitHub has nothing of its own', async () => {
  const fx = withOrigin();
  const t = makeBranch(fx.main);
  commit(t.path, { 'a.txt': 'a\n' }, 'Add a');
  const c = capture();
  assert.equal(await land({ ...t, check: 'true' }, { ...c.opts, push: true }), 0, c.err.join('\n'));
  assert.equal(onGitHub(fx), rev(fx.main, 'main'));
  assert.match(c.out.join('\n'), /Pushed main to GitHub \(1 commits\)/);
});

test('without push, nothing goes to GitHub', async () => {
  const fx = withOrigin();
  const before = onGitHub(fx);
  const t = makeBranch(fx.main);
  commit(t.path, { 'a.txt': 'a\n' }, 'Add a');
  assert.equal(await land({ ...t, check: 'true' }, capture().opts), 0);
  assert.equal(onGitHub(fx), before);
});

test("GitHub's own commits are merged in, checked, and main goes to GitHub with both", async () => {
  const fx = withOrigin();
  commit(fx.other, { 'gh.txt': 'from github\n' }, 'Made on GitHub');
  sh(fx.other, 'git push -q origin main');
  const t = makeBranch(fx.main);
  commit(t.path, { 'a.txt': 'a\n' }, 'Add a');
  const landedFrom = rev(fx.main, 'main');
  const c = capture();
  // The check notes what it saw: the landing alone, then the merge.
  const check = `ls *.txt | tr '\\n' ' ' >> '${fx.root}/checks'; echo >> '${fx.root}/checks'`;
  assert.equal(await land({ ...t, check }, { ...c.opts, push: true }), 0, c.err.join('\n'));
  const top = rev(fx.main, 'main');
  assert.equal(onGitHub(fx), top);
  // Main only fast-forwarded here: what landed is under the merge.
  sh(fx.main, `git merge-base --is-ancestor ${landedFrom} main`);
  assert.equal(sh(fx.main, 'git log -1 --format=%P main').split(' ').length, 2);
  assert.ok(fs.existsSync(path.join(fx.main, 'gh.txt')) && fs.existsSync(path.join(fx.main, 'a.txt')));
  assert.deepEqual(fs.readFileSync(path.join(fx.root, 'checks'), 'utf8').trim().split('\n').map((l) => l.trim()), ['a.txt', 'a.txt gh.txt']);
  assert.match(c.out.join('\n'), /Brought GitHub's commits into main, checked, and pushed it to GitHub/);

  // The next landing goes on top as usual, and is pushed straight on.
  const u = makeBranch(fx.main, 'efef0000');
  commit(u.path, { 'b.txt': 'b\n' }, 'Add b');
  const c2 = capture();
  assert.equal(await land({ ...u, check: 'true' }, { ...c2.opts, push: true }), 0, c2.err.join('\n'));
  assert.equal(onGitHub(fx), rev(fx.main, 'main'));
  assert.equal(rev(fx.main, 'main^'), top);
});

test("a failed check on the merge leaves main as it landed, and isn't tried again for the same GitHub main", async () => {
  const fx = withOrigin();
  commit(fx.other, { 'gh.txt': 'from github\n' }, 'Made on GitHub');
  sh(fx.other, 'git push -q origin main');
  const github = onGitHub(fx);
  const check = 'test ! -f gh.txt';
  const t = makeBranch(fx.main);
  commit(t.path, { 'a.txt': 'a\n' }, 'Add a');
  const c = capture();
  assert.equal(await land({ ...t, check }, { ...c.opts, push: true }), 0);
  assert.equal(rev(fx.main, 'main'), rev(t.path, t.branch));
  assert.equal(onGitHub(fx), github);
  assert.match(c.out.join('\n'), /the check failed on the merge/);

  commit(t.path, { 'b.txt': 'b\n' }, 'Add b');
  const c2 = capture();
  assert.equal(await land({ ...t, check }, { ...c2.opts, push: true }), 0);
  assert.match(c2.out.join('\n'), /bringing them in failed at/);
  assert.doesNotMatch(c2.out.join('\n'), /Running the check on the merge/);

  // GitHub moving again is worth another try, as is time passing.
  const old = pushLimits.retryMs;
  pushLimits.retryMs = 0;
  try {
    commit(t.path, { 'c.txt': 'c\n' }, 'Add c');
    const c3 = capture();
    assert.equal(await land({ ...t, check }, { ...c3.opts, push: true }), 0);
    assert.match(c3.out.join('\n'), /Running the check on the merge/);
  } finally {
    pushLimits.retryMs = old;
  }
});

test("a conflict with GitHub's commits is said, and the landing still lands", async () => {
  const fx = withOrigin();
  commit(fx.other, { 'README.md': 'github\n' }, 'GitHub edit');
  sh(fx.other, 'git push -q origin main');
  const github = onGitHub(fx);
  const t = makeBranch(fx.main);
  commit(t.path, { 'README.md': 'here\n' }, 'Local edit');
  const c = capture();
  assert.equal(await land({ ...t, check: 'true' }, { ...c.opts, push: true }), 0);
  assert.equal(rev(fx.main, 'main'), rev(t.path, t.branch));
  assert.equal(onGitHub(fx), github);
  assert.match(c.out.join('\n'), /they conflict with it in README\.md/);
});

test('pushAfterLanding is on only for the repos runner.json lists', () => {
  const fx = withOrigin();
  const home = path.join(fx.root, 'home');
  fs.mkdirSync(home);
  assert.equal(pushAfterLanding(home, fx.main), false);
  write(home, { 'runner.json': JSON.stringify({ pushAfterLanding: [fx.other] }) });
  assert.equal(pushAfterLanding(home, fx.main), false);
  write(home, { 'runner.json': JSON.stringify({ pushAfterLanding: [fx.main] }) });
  assert.equal(pushAfterLanding(home, fx.main), true);
  // A worktree of it names the same repo.
  assert.equal(pushAfterLanding(home, makeBranch(fx.main).path), true);
});

// A check that fixes things up as it runs passed on files that aren't the
// merge's, so main doesn't move to the merge (Codex's review, 17 Nov).
test("a check that changes files on the merge doesn't count for it", async () => {
  const fx = withOrigin();
  commit(fx.other, { 'gh.txt': 'from github\n' }, 'Made on GitHub');
  sh(fx.other, 'git push -q origin main');
  const github = onGitHub(fx);
  const t = makeBranch(fx.main);
  commit(t.path, { 'a.txt': 'a\n' }, 'Add a');
  const c = capture();
  assert.equal(await land({ ...t, check: 'if test -f gh.txt; then echo fixed > gh.txt; fi' }, { ...c.opts, push: true }), 0);
  assert.equal(rev(fx.main, 'main'), rev(t.path, t.branch));
  assert.equal(onGitHub(fx), github);
  assert.match(c.out.join('\n'), /the check changed files or HEAD/);
});

// A push GitHub refuses for some other reason than having moved (a rule on
// the branch, credentials) is said as it is: no merge, no second check.
test("a push refused while GitHub hasn't moved is said, with no merge made", async () => {
  const fx = withOrigin();
  write(fx.bare, { 'hooks/pre-receive': '#!/bin/sh\necho "protected branch" >&2\nexit 1\n' });
  fs.chmodSync(path.join(fx.bare, 'hooks', 'pre-receive'), 0o755);
  const github = onGitHub(fx);
  const t = makeBranch(fx.main);
  commit(t.path, { 'a.txt': 'a\n' }, 'Add a');
  const c = capture();
  assert.equal(await land({ ...t, check: 'true' }, { ...c.opts, push: true }), 0);
  assert.equal(rev(fx.main, 'main'), rev(t.path, t.branch));
  assert.equal(onGitHub(fx), github);
  assert.match(c.out.join('\n'), /GitHub refused the push/);
  assert.doesNotMatch(c.out.join('\n'), /merging them in/);
});
