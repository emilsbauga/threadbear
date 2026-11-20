// scripts/sync-main.sh (docs/thread-worktrees.md, "Syncing main with
// GitHub"). On 13 Nov it waited 30 minutes and more for the landing lock
// behind queued landings, just to push a main that was only ahead of
// GitHub's, so GitHub's lagged. Only ahead now pushes straight away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { holdUntil } from '../helpers/patience.ts';
import { SHELL } from '../helpers/platform.ts';

const SCRIPT = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'sync-main.sh');
// Not the outer run's THREADBEAR_SYNC_LOCKED: when this suite runs as
// sync-main.sh's own check, that's set (the outer run holds the real lock),
// and the script under test then took it that it held this repo's lock too
// and never waited, failing the lock tests in every such sync (David, 19 Nov).
const { THREADBEAR_SYNC_LOCKED: _outer, ...outside } = process.env;
const env = { ...outside, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' };
const sh = (cwd: string, cmd: string) => execFileSync(SHELL[0], [SHELL[1], cmd], { cwd, env, encoding: 'utf8' }).trim();

function repos() {
  const root = fs.realpathSync(tmpDir('sync-main-'));
  sh(root, 'git init -q --bare -b main origin.git && git clone -q origin.git main 2>/dev/null');
  const main = path.join(root, 'main');
  sh(main, 'git checkout -q -B main && mkdir scripts && echo a > a && git add a && git commit -qm a && git push -q origin main');
  fs.copyFileSync(SCRIPT, path.join(main, 'scripts', 'sync-main.sh'));
  fs.chmodSync(path.join(main, 'scripts', 'sync-main.sh'), 0o755);
  sh(main, 'echo scripts/ > .git/info/exclude');
  return { root, main };
}

// Holds the landing lock, as a landing's check would, until `release` exists.
function holdLock(root: string, main: string) {
  const lock = path.join(main, '.git', 'threadbear-land.lock');
  const wait = `touch '${root}/held'; ${holdUntil(`${root}/release`)}`;
  const p = process.platform === 'darwin'
    ? spawn('/usr/bin/lockf', ['-k', lock, '/bin/sh', '-c', wait], { stdio: 'ignore' })
    : spawn('flock', ['-x', lock, '/bin/sh', '-c', wait], { stdio: 'ignore' });
  p.on('error', () => {});
  return new Promise<void>((r) => p.once('close', () => r()));
}

// THREADBEAR_HOME: a data dir of the test's own, so the real runner.json's
// pushAfterLanding never counts.
function run(main: string, home = path.join(path.dirname(main), 'home')) {
  const p = spawn(path.join(main, 'scripts', 'sync-main.sh'), [], { cwd: main, env: { ...env, THREADBEAR_HOME: home } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  return { done: new Promise<{ code: number | null; out: string }>((r) => p.once('close', (code) => r({ code, out }))), output: () => out, kill: () => p.kill() };
}

async function until(check: () => boolean, what: string) {
  const end = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('main only ahead of GitHub is pushed straight away, while a landing holds the lock', async () => {
  const { root, main } = repos();
  sh(main, 'echo b > b && git add b && git commit -qm b');
  const held = holdLock(root, main);
  await until(() => fs.existsSync(path.join(root, 'held')), 'lock held');
  try {
    const r = await run(main).done;
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Pushed main to GitHub \(1 commits\)/);
    assert.doesNotMatch(r.out, /Taking the landing lock/);
    assert.equal(sh(root, 'git --git-dir=origin.git rev-parse main'), sh(main, 'git rev-parse main'));
  } finally {
    fs.writeFileSync(path.join(root, 'release'), '');
    await held;
  }
  const same = await run(main).done;
  assert.match(same.out, /the same here and on GitHub/);
});

test('when GitHub has moved, it still waits for the landing lock before moving main', async () => {
  const { root, main } = repos();
  sh(root, 'git clone -q origin.git other 2>/dev/null && cd other && git checkout -q main && echo c > c && git add c && git commit -qm c && git push -q origin main');
  const held = holdLock(root, main);
  await until(() => fs.existsSync(path.join(root, 'held')), 'lock held');
  const before = sh(main, 'git rev-parse main');
  const r = run(main);
  await until(() => r.output().includes('Taking the landing lock'), 'waiting for the lock');
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(sh(main, 'git rev-parse main'), before, 'main untouched while a landing holds the lock');
  fs.writeFileSync(path.join(root, 'release'), '');
  await held;
  const done = await r.done;
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /fast-forwarded to GitHub's/);
  assert.equal(sh(main, 'git rev-parse main'), sh(root, 'git --git-dir=origin.git rev-parse main'));
});

// 17 Nov: with landings coming all afternoon it waited over an hour for the
// lock and never got it. With pushAfterLanding on, the landing holding the
// lock pushes once it lands (land-push.test.ts), so it doesn't wait.
test("when GitHub has moved and a landing holds the lock, pushAfterLanding leaves it to that landing", async () => {
  const { root, main } = repos();
  sh(root, 'git clone -q origin.git other 2>/dev/null && cd other && git checkout -q main && echo c > c && git add c && git commit -qm c && git push -q origin main');
  sh(main, 'echo b > b && git add b && git commit -qm b');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'runner.json'), JSON.stringify({ pushAfterLanding: [main] }));
  const held = holdLock(root, main);
  await until(() => fs.existsSync(path.join(root, 'held')), 'lock held');
  const before = sh(main, 'git rev-parse main');
  const queue = path.join(main, '.git', 'threadbear-land-queue');
  try {
    // Only the lock held (a dry run, say): no landing will push, so it waits.
    const alone = run(main, home);
    await until(() => alone.output().includes('Taking the landing lock'), 'waiting with no landing queued');
    alone.kill();
    // A landing in the line that won't push (started before the setting, or
    // by a tb from before it) changes nothing; one that will, does.
    fs.mkdirSync(queue, { recursive: true });
    fs.writeFileSync(path.join(queue, '1-1-a.json'), JSON.stringify({ id: '1-1-a', pid: process.pid, at: 1 }));
    const noPush = run(main, home);
    await until(() => noPush.output().includes('Taking the landing lock'), 'waiting with a landing that will not push');
    noPush.kill();
    fs.writeFileSync(path.join(queue, '1-1-a.json'), JSON.stringify({ id: '1-1-a', pid: process.pid, at: 1, push: true }));
    const r = await run(main, home).done;
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /a landing is going: when it lands it merges GitHub's in/);
    assert.doesNotMatch(r.out, /Taking the landing lock/);
    assert.equal(sh(main, 'git rev-parse main'), before);
    // Unless a landing's merge of this same GitHub main failed already.
    fs.writeFileSync(path.join(main, '.git', 'threadbear-land-push.json'), JSON.stringify({ github: sh(main, 'git rev-parse origin/main'), at: Date.now() }));
    const again = run(main, home);
    await until(() => again.output().includes('Taking the landing lock'), 'waiting after a failed merge');
    again.kill();
    assert.ok(fs.existsSync(path.join(main, '.git', 'threadbear-land.lock')), 'the probe leaves the lock file');
  } finally {
    fs.writeFileSync(path.join(root, 'release'), '');
    await held;
  }
});

// Both moved: the check runs in a worktree borrowed with borrow-worktree.sh.
// `check` is check.sh's body there.
function bothMoved(check: string) {
  const { root, main } = repos();
  fs.copyFileSync(path.join(import.meta.dirname, '..', '..', '..', 'borrow-worktree.sh'), path.join(main, 'borrow-worktree.sh'));
  fs.writeFileSync(path.join(main, 'worktree-setup.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(main, 'check.sh'), `#!/bin/sh\n${check}\n`);
  sh(main, 'chmod +x borrow-worktree.sh worktree-setup.sh check.sh && git add -A && git commit -qm scripts && git push -q origin main');
  sh(root, 'git clone -q origin.git other 2>/dev/null && cd other && git checkout -q main && echo c > c && git add c && git commit -qm c && git push -q origin main');
  sh(main, 'echo b > b && git add b && git commit -qm b');
  return { root, main, origin: () => sh(root, 'git --git-dir=origin.git rev-parse main') };
}
const borrowBranches = (main: string) => sh(main, "git branch --list 'thread/borrow-*'");
const spares = (main: string) => sh(main, 'git worktree list --porcelain').split('\n').filter((l) => l === 'locked threadbear spare').length;

test('both moved: checked in a borrowed worktree, pushed, and the worktree given back', async () => {
  const { main, origin } = bothMoved('true');
  const r = await run(main).done;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /checked and pushed/);
  assert.equal(origin(), sh(main, 'git rev-parse main'));
  assert.equal(borrowBranches(main), '');
  assert.equal(spares(main), 1);
});

test("both moved and no worktree can be borrowed: it fails, says nothing was pushed, and main isn't touched", async () => {
  const { main, origin } = bothMoved('true');
  const before = { main: sh(main, 'git rev-parse main'), origin: origin() };
  // On 17 Nov every slot was taken; here the borrow fails outright.
  fs.writeFileSync(path.join(main, 'borrow-worktree.sh'), "#!/bin/sh\necho \"Couldn't make a worktree in somewhere.\" >&2\nexit 1\n");
  const r = await run(main).done;
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /Couldn't borrow a worktree to check in, so main wasn't moved or pushed\./);
  assert.deepEqual({ main: sh(main, 'git rev-parse main'), origin: origin() }, before);
});

test('both moved and the check fails or the run is stopped: the borrowed worktree is given back either way', async () => {
  const failed = bothMoved('echo junk > check-junk.txt; exit 1');
  const r = await run(failed.main).done;
  assert.notEqual(r.code, 0);
  assert.match(r.out, /The check failed/);
  assert.equal(borrowBranches(failed.main), '', 'given back, untracked junk and all');
  assert.equal(spares(failed.main), 1);

  const { root, main, origin } = bothMoved('true');
  fs.writeFileSync(path.join(main, 'check.sh'), `#!/bin/sh\ntouch '${root}/checking'\nsleep 30\n`);
  sh(main, 'git commit -qam "slow check"');
  const before = origin();
  // Stopped as a background task is: its whole process group.
  const p = spawn(path.join(main, 'scripts', 'sync-main.sh'), [], { cwd: main, env, detached: true, stdio: 'ignore' });
  const closed = new Promise<void>((res) => p.once('close', () => res()));
  await until(() => fs.existsSync(path.join(root, 'checking')), 'the check to start');
  process.kill(-p.pid!, 'SIGTERM');
  await closed;
  await until(() => borrowBranches(main) === '' && spares(main) === 1, 'the borrow given back');
  assert.equal(origin(), before, 'nothing pushed');
});

test("a stopped run's give-back leaves alone a worktree that's no longer its borrow", async () => {
  const { root, main } = bothMoved('true');
  fs.writeFileSync(path.join(main, 'check.sh'), `#!/bin/sh\ntouch '${root}/checking'\nsleep 30\n`);
  sh(main, 'git commit -qam "slow check"');
  const p = spawn(path.join(main, 'scripts', 'sync-main.sh'), [], { cwd: main, env, detached: true, stdio: 'ignore' });
  const closed = new Promise<void>((res) => p.once('close', () => res()));
  await until(() => fs.existsSync(path.join(root, 'checking')), 'the check to start');
  // Meanwhile it's switched to someone else's branch, with their edit.
  const wt = path.join(root, 'main-threads', 'slot-1');
  sh(wt, 'git checkout -q -b someone-else && echo theirs > theirs.txt');
  process.kill(-p.pid!, 'SIGTERM');
  await closed;
  assert.equal(sh(wt, 'git rev-parse --abbrev-ref HEAD'), 'someone-else');
  assert.equal(fs.readFileSync(path.join(wt, 'theirs.txt'), 'utf8'), 'theirs\n');
});
