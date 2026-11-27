import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  BuildCacheCleaner,
  findCargoBuildDirs,
  hasCacheDirTag,
  LOW_DISK_FREE_BYTES,
  OPEN_WORKTREE_IDLE_MS,
  OPEN_WORKTREE_LOW_IDLE_MS,
  QUIET_WINDOW_MS,
  SHARED_CACHE_MAX_AGE_MS,
  TARGET_DISK_FREE_BYTES,
  type ThreadSummaryLike,
} from '../../src/build-cache-cleanup.ts';
import { nullLogger } from '../../src/log.ts';
import { LANDING_MARKER } from '../../src/slot.ts';
import { SPARE } from '../../src/worktrees.ts';
import { tmpDir } from '../helpers/fakes.ts';

const TAG = 'Signature: 8a477f597d28d172789f06886806bc55\n# Created by cargo\n';
const NOW = Date.parse('2026-11-26T12:00:00Z');
const OLD = NOW - SHARED_CACHE_MAX_AGE_MS - 3_600_000;
const QUIET = NOW - QUIET_WINDOW_MS - 60_000;
const FRESH = NOW - 5 * 60_000;

function setMtimeRecursive(dir: string, ms: number): void {
  const sec = ms / 1000;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) setMtimeRecursive(p, ms);
    else fs.utimesSync(p, sec, sec);
  }
  fs.utimesSync(dir, sec, sec);
}

function makeCargoDir(dir: string, mtime = QUIET): void {
  fs.mkdirSync(path.join(dir, 'debug', 'deps'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CACHEDIR.TAG'), TAG);
  fs.writeFileSync(path.join(dir, 'debug', 'deps', 'a.rlib'), 'x');
  setMtimeRecursive(dir, mtime);
}

function makeGitRepoWithSlots() {
  const base = tmpDir('tb-cache-clean-');
  const main = path.join(base, 'repo');
  const slotsDir = path.join(base, 'repo-threads');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(slotsDir, { recursive: true });
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const runGit = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  fs.writeFileSync(path.join(main, '.gitignore'), 'desktop/target/\napp/.build/\n');
  fs.mkdirSync(path.join(main, 'desktop'), { recursive: true });
  fs.writeFileSync(path.join(main, 'desktop', 'Cargo.toml'), '[package]\nname = "x"\n');
  runGit(main, 'init', '-q', '-b', 'main');
  runGit(main, 'add', '-A');
  runGit(main, 'commit', '-q', '-m', 'init');

  const addSlot = (name: string, branch?: string) => {
    const wt = path.join(slotsDir, name);
    if (branch) runGit(main, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
    else runGit(main, 'worktree', 'add', '-q', '--detach', wt, 'main');
    const admin = runGit(wt, 'rev-parse', '--absolute-git-dir');
    return { wt, admin };
  };
  return { base, main, addSlot, runGit };
}

test('hasCacheDirTag and findCargoBuildDirs detect Cargo caches only', () => {
  const wt = tmpDir('tb-cache-find-');
  makeCargoDir(path.join(wt, 'desktop', 'target'));
  fs.mkdirSync(path.join(wt, 'desktop', 'src'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'node_modules', 'pkg', 'CACHEDIR.TAG'), TAG);
  assert.equal(hasCacheDirTag(path.join(wt, 'desktop', 'target')), true);
  assert.equal(hasCacheDirTag(path.join(wt, 'desktop', 'src')), false);
  assert.deepEqual(findCargoBuildDirs(wt), ['desktop/target']);
});

test('does nothing when disabled or experiment is off', async () => {
  const home = tmpDir('tb-cache-off-');
  const cacheRoot = path.join(home, 'caches');
  makeCargoDir(path.join(cacheRoot, 'check-desktop-target'), OLD);
  const off = new BuildCacheCleaner({
    home,
    log: nullLogger,
    enabled: true,
    on: () => false,
    records: () => [],
    cacheRoot,
    sharedBuildsRoot: path.join(home, 'shared'),
    now: () => NOW,
    freeBytes: () => 1024,
    lockHeld: async () => false,
  });
  assert.deepEqual(await off.sweep('hourly'), []);
  assert.deepEqual(await off.ifLow('before a build'), []);
  assert.ok(fs.existsSync(path.join(cacheRoot, 'check-desktop-target')));
});

test('worktrees: cleans spare, archived, and idle open worktrees while protecting active, kept, locked, borrowed and busy ones', async () => {
  const { base, main, addSlot, runGit } = makeGitRepoWithSlots();
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });

  const spare = addSlot('slot-spare');
  runGit(main, 'worktree', 'lock', '--reason', SPARE, spare.wt);
  makeCargoDir(path.join(spare.wt, 'desktop', 'target'), QUIET);
  // Kept folder (e.g. app/.build) must be preserved even if tagged.
  makeCargoDir(path.join(spare.wt, 'app', '.build'), QUIET);
  // Untracked/tracked non-ignored folder must never be deleted.
  makeCargoDir(path.join(spare.wt, 'not-ignored'), QUIET);

  const archived = addSlot('slot-archived', 'thread/11111111');
  makeCargoDir(path.join(archived.wt, 'desktop', 'target'), QUIET);

  const openIdle = addSlot('slot-open-idle', 'thread/22222222');
  makeCargoDir(path.join(openIdle.wt, 'desktop', 'target'), QUIET);

  const openRecent = addSlot('slot-open-recent', 'thread/33333333');
  makeCargoDir(path.join(openRecent.wt, 'desktop', 'target'), QUIET);

  const openRunning = addSlot('slot-open-running', 'thread/44444444');
  makeCargoDir(path.join(openRunning.wt, 'desktop', 'target'), QUIET);

  const busyCwd = addSlot('slot-busy-cwd', 'thread/55555555');
  makeCargoDir(path.join(busyCwd.wt, 'desktop', 'target'), QUIET);

  const lockedCargo = addSlot('slot-locked', 'thread/66666666');
  makeCargoDir(path.join(lockedCargo.wt, 'desktop', 'target'), QUIET);
  const cargoLock = path.join(lockedCargo.wt, 'desktop', 'target', '.cargo-lock');
  fs.writeFileSync(cargoLock, '');

  const landing = addSlot('slot-landing', 'thread/77777777');
  makeCargoDir(path.join(landing.wt, 'desktop', 'target'), QUIET);
  fs.writeFileSync(path.join(landing.admin, LANDING_MARKER), '{}');

  const borrowed = addSlot('slot-borrow', 'thread/borrow-slot-9-20261126');
  makeCargoDir(path.join(borrowed.wt, 'desktop', 'target'), QUIET);

  // Main checkout target must never be touched.
  makeCargoDir(path.join(main, 'desktop', 'target'), QUIET);

  const makeRec = (id: string, slotPath: string, branch: string, extra: Partial<ThreadSummaryLike> = {}): ThreadSummaryLike => ({
    id,
    status: 'idle',
    lastActivityAt: new Date(NOW - OPEN_WORKTREE_IDLE_MS - 3_600_000).toISOString(),
    worktree: { repo: main, mainCheckout: main, path: slotPath, branch, base: 'HEAD', keep: ['app/.build'] },
    ...extra,
  });

  const records: ThreadSummaryLike[] = [
    makeRec('11111111-aaaa', archived.wt, 'thread/11111111', { archivedAt: new Date(NOW - 3_600_000).toISOString() }),
    makeRec('22222222-aaaa', openIdle.wt, 'thread/22222222'),
    makeRec('33333333-aaaa', openRecent.wt, 'thread/33333333', { lastActivityAt: new Date(NOW - 3 * 3_600_000).toISOString() }),
    makeRec('44444444-aaaa', openRunning.wt, 'thread/44444444', { status: 'running' }),
    makeRec('55555555-aaaa', busyCwd.wt, 'thread/55555555'),
    makeRec('66666666-aaaa', lockedCargo.wt, 'thread/66666666'),
    makeRec('77777777-aaaa', landing.wt, 'thread/77777777'),
  ];

  // If cwds cannot be enumerated, no worktree target is touched.
  const noCwds = new BuildCacheCleaner({
    home,
    log: nullLogger,
    enabled: true,
    on: () => true,
    records: () => records,
    cacheRoot: path.join(base, 'empty-caches'),
    sharedBuildsRoot: path.join(base, 'empty-shared'),
    now: () => NOW,
    freeBytes: () => 50 * 1024 ** 3,
    cwds: async () => undefined,
    lockHeld: async () => false,
  });
  assert.deepEqual(await noCwds.sweep('hourly'), []);
  assert.ok(fs.existsSync(path.join(spare.wt, 'desktop', 'target')));

  const cleaner = new BuildCacheCleaner({
    home,
    log: nullLogger,
    enabled: true,
    on: () => true,
    records: () => records,
    cacheRoot: path.join(base, 'empty-caches'),
    sharedBuildsRoot: path.join(base, 'empty-shared'),
    now: () => NOW,
    freeBytes: () => 50 * 1024 ** 3,
    cwds: async () => [path.join(busyCwd.wt, 'desktop')],
    lockHeld: async (file) => file === cargoLock,
  });

  const cleared = await cleaner.sweep('hourly');
  const paths = new Set(cleared.map((c) => path.basename(path.dirname(path.dirname(c.path)))));
  assert.deepEqual(paths, new Set(['slot-spare', 'slot-archived', 'slot-open-idle']));

  assert.equal(fs.existsSync(path.join(spare.wt, 'desktop', 'target')), false);
  assert.equal(fs.existsSync(path.join(spare.wt, 'app', '.build')), true, 'keep folder stays');
  assert.equal(fs.existsSync(path.join(spare.wt, 'not-ignored')), true, 'non-ignored folder stays');
  assert.equal(fs.existsSync(path.join(archived.wt, 'desktop', 'target')), false);
  assert.equal(fs.existsSync(path.join(openIdle.wt, 'desktop', 'target')), false);
  assert.equal(fs.existsSync(path.join(openRecent.wt, 'desktop', 'target')), true);
  assert.equal(fs.existsSync(path.join(openRunning.wt, 'desktop', 'target')), true);
  assert.equal(fs.existsSync(path.join(busyCwd.wt, 'desktop', 'target')), true);
  assert.equal(fs.existsSync(path.join(lockedCargo.wt, 'desktop', 'target')), true);
  assert.equal(fs.existsSync(path.join(landing.wt, 'desktop', 'target')), true);
  assert.equal(fs.existsSync(path.join(borrowed.wt, 'desktop', 'target')), true);
  assert.equal(fs.existsSync(path.join(main, 'desktop', 'target')), true);

  // Under low disk, an open thread idle > 2h is also cleared.
  const lowCleaner = new BuildCacheCleaner({
    home,
    log: nullLogger,
    enabled: true,
    on: () => true,
    records: () => records,
    cacheRoot: path.join(base, 'empty-caches'),
    sharedBuildsRoot: path.join(base, 'empty-shared'),
    now: () => NOW,
    freeBytes: () => LOW_DISK_FREE_BYTES - 1,
    cwds: async () => [path.join(busyCwd.wt, 'desktop')],
    lockHeld: async (file) => file === cargoLock,
  });
  const lowCleared = await lowCleaner.ifLow('low disk');
  assert.equal(lowCleared.length, 1);
  assert.equal(fs.existsSync(path.join(openRecent.wt, 'desktop', 'target')), false);
  assert.ok(3 * 3_600_000 >= OPEN_WORKTREE_LOW_IDLE_MS);
});

test('shared caches: cleans stale update-desktop, update/build, ios-builds, check-desktop-target and local-builds while honoring locks and appstore', async () => {
  const base = tmpDir('tb-cache-shared-');
  const home = path.join(base, 'home');
  const cacheRoot = path.join(base, 'caches');
  const sharedBuildsRoot = path.join(base, 'local-builds');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.mkdirSync(sharedBuildsRoot, { recursive: true });

  // update-desktop with a dead-PID stale lock
  const udTarget = path.join(cacheRoot, 'update-desktop', 'target');
  makeCargoDir(udTarget, OLD);
  fs.mkdirSync(path.join(cacheRoot, 'update-desktop', 'lock'), { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, 'update-desktop', 'lock', 'pid'), '999999\n');

  // Swift update/build (old)
  const swiftBuild = path.join(cacheRoot, 'update', 'build');
  fs.mkdirSync(swiftBuild, { recursive: true });
  fs.writeFileSync(path.join(swiftBuild, 'a'), '1');
  setMtimeRecursive(swiftBuild, OLD);

  // ios-builds: old dd-device should go, appstore must stay, fresh dd-sim must stay
  const iosDd = path.join(cacheRoot, 'ios-builds', 'dd-device');
  const iosAppstore = path.join(cacheRoot, 'ios-builds', 'appstore');
  const iosFresh = path.join(cacheRoot, 'ios-builds', 'dd-sim');
  for (const [d, m] of [[iosDd, OLD], [iosAppstore, OLD], [iosFresh, FRESH]] as const) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'x'), '1');
    setMtimeRecursive(d, m);
  }

  // check-desktop-target
  const checkTarget = path.join(cacheRoot, 'check-desktop-target');
  makeCargoDir(checkTarget, OLD);

  // local-builds: shared-1 (old, free) should go; shared-2 (old, locked) stays; other stays
  const s1 = path.join(sharedBuildsRoot, 'shared-1');
  const s2 = path.join(sharedBuildsRoot, 'shared-2');
  const other = path.join(sharedBuildsRoot, 'notes');
  for (const d of [s1, s2, other]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'x'), '1');
    setMtimeRecursive(d, OLD);
  }
  fs.writeFileSync(`${s1}.lock`, '');
  fs.writeFileSync(`${s2}.lock`, '');

  const cleaner = new BuildCacheCleaner({
    home,
    log: nullLogger,
    enabled: true,
    on: () => true,
    records: () => [],
    cacheRoot,
    sharedBuildsRoot,
    now: () => NOW,
    freeBytes: () => 50 * 1024 ** 3,
    lockHeld: async (file) => file === `${s2}.lock`,
    moveUnderLock: async (_lock, from, to) => {
      fs.renameSync(from, to);
      return true;
    },
  });

  const cleared = await cleaner.sweep('hourly');
  assert.equal(fs.existsSync(udTarget), false);
  assert.equal(fs.existsSync(path.join(cacheRoot, 'update-desktop', 'lock')), false);
  assert.equal(fs.existsSync(swiftBuild), false);
  assert.equal(fs.existsSync(iosDd), false);
  assert.equal(fs.existsSync(iosAppstore), true, 'appstore builds are never deleted');
  assert.equal(fs.existsSync(iosFresh), true, 'fresh ios build stays');
  assert.equal(fs.existsSync(checkTarget), false);
  assert.equal(fs.existsSync(s1), false);
  assert.equal(fs.existsSync(s2), true, 'locked shared-2 stays');
  assert.equal(fs.existsSync(other), true, 'non-shared folder stays');
  assert.equal(cleared.length, 5);
});

test('update-desktop skips when lock is held by a live PID, and low-disk stops once enough space is free', async () => {
  const base = tmpDir('tb-cache-live-');
  const home = path.join(base, 'home');
  const cacheRoot = path.join(base, 'caches');
  const sharedBuildsRoot = path.join(base, 'local-builds');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.mkdirSync(sharedBuildsRoot, { recursive: true });

  // Live PID holds update-desktop/lock
  const udTarget = path.join(cacheRoot, 'update-desktop', 'target');
  makeCargoDir(udTarget, OLD);
  fs.mkdirSync(path.join(cacheRoot, 'update-desktop', 'lock'), { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, 'update-desktop', 'lock', 'pid'), `${process.pid}\n`);

  // ios-builds clears first and simulates freeing enough disk to stop before local-builds.
  const iosDd = path.join(cacheRoot, 'ios-builds', 'dd-device');
  fs.mkdirSync(iosDd, { recursive: true });
  fs.writeFileSync(path.join(iosDd, 'x'), '1');
  setMtimeRecursive(iosDd, QUIET);

  const s1 = path.join(sharedBuildsRoot, 'shared-1');
  fs.mkdirSync(s1, { recursive: true });
  fs.writeFileSync(path.join(s1, 'x'), '1');
  setMtimeRecursive(s1, QUIET);

  const cleaner = new BuildCacheCleaner({
    home,
    log: nullLogger,
    enabled: true,
    on: () => true,
    records: () => [],
    cacheRoot,
    sharedBuildsRoot,
    now: () => NOW,
    freeBytes: () => (fs.existsSync(iosDd) ? LOW_DISK_FREE_BYTES - 1 : TARGET_DISK_FREE_BYTES),
    lockHeld: async () => false,
    moveUnderLock: async (_lock, from, to) => {
      fs.renameSync(from, to);
      return true;
    },
  });

  const cleared = await cleaner.ifLow('low disk');
  assert.equal(cleared.length, 1);
  assert.equal(fs.existsSync(udTarget), true, 'live lock protects update-desktop/target');
  assert.equal(fs.existsSync(iosDd), false);
  assert.equal(fs.existsSync(s1), true, 'stopped once free disk reached target');
});
