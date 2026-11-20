// setup's step 8 leaves the runner's unit tests out only for Mike's own
// code (scripts/checked-upstream.mjs): on Tinker Desk's second account they
// took 58 minutes and then failed on that Mac (19 Nov 2026).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a plain .mjs script, no types
import { checkedUpstream } from '../../../scripts/checked-upstream.mjs';

const MIKES = 'https://github.com/mikecann/threadbear.git';

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// Mike's repo (a bare one, standing in for GitHub) and a clone of it, with
// the clone's remote pointed back at it under his URL's name, so the URL
// matches while every fetch stays on this disk.
function setup(t: { after: (f: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tb-checked-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mikes = path.join(dir, 'mikes.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', mikes);
  git(dir, 'clone', '-q', mikes, work);
  fs.mkdirSync(path.join(work, 'runner'));
  fs.writeFileSync(path.join(work, 'runner', 'a.ts'), 'a\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'one');
  git(work, 'push', '-q', 'origin', 'main');
  // The remote says Mike's URL, and insteadOf sends its fetches here.
  git(work, 'config', `url.${mikes}.insteadOf`, MIKES);
  git(work, 'remote', 'set-url', 'origin', MIKES);
  return { work, mikes };
}

test("Mike's code as his repo has it leaves the checks out", (t) => {
  const { work } = setup(t);
  assert.deepEqual(checkedUpstream({ repo: work, mikesRepo: MIKES }), { checked: true, remote: 'origin' });
});

test("a branch of Mike's other than main runs them", (t) => {
  const { work } = setup(t);
  git(work, 'checkout', '-q', '-b', 'cloud/try');
  fs.writeFileSync(path.join(work, 'runner', 'c.ts'), 'c\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'unlanded');
  git(work, 'push', '-q', 'origin', 'cloud/try');
  assert.equal(checkedUpstream({ repo: work, mikesRepo: MIKES }).checked, false);
});

test('a commit of your own runs them', (t) => {
  const { work } = setup(t);
  fs.writeFileSync(path.join(work, 'runner', 'b.ts'), 'b\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'mine');
  assert.equal(checkedUpstream({ repo: work, mikesRepo: MIKES }).checked, false);
});

test("a fork: upstream is Mike's, fetched when nothing is", (t) => {
  const { work } = setup(t);
  git(work, 'remote', 'rename', 'origin', 'upstream');
  git(work, 'remote', 'add', 'origin', 'https://github.com/someone/threadbear.git');
  for (const ref of git(work, 'for-each-ref', '--format=%(refname)', 'refs/remotes/upstream/').split('\n').filter(Boolean)) git(work, 'update-ref', '-d', ref);
  assert.deepEqual(checkedUpstream({ repo: work, mikesRepo: MIKES }), { checked: true, remote: 'upstream' });
});

test("a main of someone else's left under Mike's remote isn't believed", (t) => {
  const { work } = setup(t);
  fs.writeFileSync(path.join(work, 'runner', 'd.ts'), 'd\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', "the fork's");
  git(work, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(checkedUpstream({ repo: work, mikesRepo: MIKES }).checked, false);
});

test("a fetch that fails runs them", (t) => {
  const { work, mikes } = setup(t);
  fs.rmSync(mikes, { recursive: true, force: true });
  const r = checkedUpstream({ repo: work, mikesRepo: MIKES });
  assert.equal(r.checked, false);
  assert.match(r.why, /couldn't fetch/);
});

test("no remote of Mike's runs them", (t) => {
  const { work } = setup(t);
  git(work, 'remote', 'set-url', 'origin', 'https://github.com/someone/else.git');
  const r = checkedUpstream({ repo: work, mikesRepo: MIKES });
  assert.equal(r.checked, false);
  assert.match(r.why, /no remote is Mike's/);
});
