// Automatic cleanup for Threadbear's own build caches (the buildCacheCleanup
// experiment, runner/src/experiments/buildCacheCleanup.md).
//
// Desktop Rust targets, update build caches, iPhone derived data and check.sh's
// shared cargo folders can add up to tens of gigabytes over a few days. Left
// unchecked, a Mac with little free space fills up and breaks atomic thread
// saves and runner updates. This sweeps idle and stale caches hourly, and
// sweeps aggressively whenever free disk drops below 10 GiB (checked every 10
// minutes and right before each runner update build).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pidAlive, processCwds } from './borrows.ts';
import type { Logger } from './log.ts';
import { claimsOf, LANDING_MARKER, readSlots, type ReadSlot } from './slot.ts';
import type { ThreadRecord } from './store.ts';
import { git, realpath, SPARE } from './worktrees.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;

export const LOW_DISK_FREE_BYTES = 10 * GIB;
export const TARGET_DISK_FREE_BYTES = 20 * GIB;
export const QUIET_WINDOW_MS = 30 * MINUTE;
export const OPEN_WORKTREE_IDLE_MS = 48 * HOUR;
export const OPEN_WORKTREE_LOW_IDLE_MS = 2 * HOUR;
export const SHARED_CACHE_MAX_AGE_MS = 7 * DAY;
export const SWEEP_INTERVAL_MS = HOUR;
export const LOW_DISK_POLL_MS = 10 * MINUTE;

const CACHEDIR_TAG_SIGNATURE = 'Signature: 8a477f597d28d172789f06886806bc55';
const CLEARING_PREFIX = '.threadbear-clearing-';
const SKIP_TOP_DIRS = new Set(['node_modules', '.git']);

export type CleanupReason = 'hourly' | 'low disk' | 'before a build';
export type ThreadSummaryLike = Pick<ThreadRecord, 'id' | 'status' | 'archivedAt' | 'lastActivityAt' | 'worktree'>;
export type ClearedCache = { path: string; why: string };

export type BuildCacheCleanerDeps = {
  home: string;
  log: Logger;
  // Real primary data dir only: dev runners and boxes don't own host caches.
  enabled: boolean;
  // Read each time (experimentOn(home, 'buildCacheCleanup')).
  on: () => boolean;
  records: () => ThreadSummaryLike[];
  // Overridable in tests.
  cacheRoot?: string;
  sharedBuildsRoot?: string;
  now?: () => number;
  freeBytes?: () => number | undefined;
  cwds?: () => Promise<string[] | undefined>;
  lockHeld?: (file: string) => Promise<boolean | undefined>;
  moveUnderLock?: (lock: string, from: string, to: string) => Promise<boolean>;
};

export function defaultCacheRoot(): string {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Caches', 'Threadbear')
    : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'threadbear');
}

// check.sh's shared cargo folders on Macs without a check host
// (desktop/scripts/shared-cargo/cargo): shared-<n>/ guarded by shared-<n>.lock.
export function defaultSharedBuildsRoot(): string {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'threadbear-check', 'local-builds');
}

function freeDiskBytes(dir: string): number | undefined {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

function readSmallText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function isRealDir(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory() && realpath(dir) === path.resolve(dir);
  } catch {
    return false;
  }
}

function mtimeMs(p: string): number {
  try {
    return fs.lstatSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

// Non-blocking BSD flock probe, matching cargo (.cargo-lock), one-build.sh
// (build.lock) and shared-cargo (shared-<n>.lock). undefined when the OS tool
// isn't available, which callers treat as held.
export function lockHeldByOther(file: string): Promise<boolean | undefined> {
  if (!fs.existsSync(file)) return Promise.resolve(false);
  const cmd: [string, string[]] | undefined =
    process.platform === 'darwin' ? ['/usr/bin/lockf', ['-k', '-s', '-t', '0', file, 'true']]
    : process.platform === 'linux' ? ['flock', ['-n', file, 'true']]
    : undefined;
  if (!cmd) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(cmd[0], cmd[1], { timeout: 10_000 }, (err) => {
      if (!err) return resolve(false);
      const code = (err as { code?: unknown }).code;
      resolve(code === 'ENOENT' ? undefined : true);
    });
  });
}

// Renames `from` to `to` while holding the flock on `lock` without waiting.
export function renameUnderLock(lock: string, from: string, to: string): Promise<boolean> {
  const cmd: [string, string[]] | undefined =
    process.platform === 'darwin' ? ['/usr/bin/lockf', ['-k', '-s', '-t', '0', lock, 'mv', from, to]]
    : process.platform === 'linux' ? ['flock', ['-n', lock, 'mv', from, to]]
    : undefined;
  if (!cmd) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(cmd[0], cmd[1], { timeout: 60_000 }, (err) => resolve(!err && !fs.existsSync(from)));
  });
}

// Most recent mtime in `dir` up to two levels deep. A Cargo target holds
// hundreds of thousands of files, so walking deeper is too expensive, while
// two levels covers debug/, release/, debug/deps, debug/.fingerprint, etc.
export function latestMtime(dir: string): number {
  let latest = mtimeMs(dir);
  const walk = (current: string, depth: number) => {
    let entries: string[];
    try {
      entries = fs.readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const child = path.join(current, name);
      latest = Math.max(latest, mtimeMs(child));
      if (depth < 2 && isRealDir(child)) walk(child, depth + 1);
    }
  };
  walk(dir, 1);
  return latest;
}

// Standard Cache Directory Tag (written by Cargo in every target folder).
export function hasCacheDirTag(dir: string): boolean {
  try {
    const fd = fs.openSync(path.join(dir, 'CACHEDIR.TAG'), 'r');
    try {
      const buf = Buffer.alloc(CACHEDIR_TAG_SIGNATURE.length);
      fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8') === CACHEDIR_TAG_SIGNATURE;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function childRealDirs(parent: string): string[] {
  try {
    return fs.readdirSync(parent).filter((name) => !SKIP_TOP_DIRS.has(name) && !name.startsWith('.') && isRealDir(path.join(parent, name)));
  } catch {
    return [];
  }
}

// Finds Cargo-tagged build directories one or two levels inside a worktree
// (e.g. `target`, `desktop/target`), returned as forward-slash relative paths.
export function findCargoBuildDirs(worktree: string): string[] {
  const found: string[] = [];
  for (const a of childRealDirs(worktree)) {
    const dirA = path.join(worktree, a);
    if (hasCacheDirTag(dirA)) {
      found.push(a);
      continue;
    }
    for (const b of childRealDirs(dirA)) {
      if (hasCacheDirTag(path.join(dirA, b))) found.push(`${a}/${b}`);
    }
  }
  return found;
}

function anyInside(cwds: Iterable<string>, dir: string): boolean {
  const prefix = dir + path.sep;
  for (const c of cwds) if (c === dir || c.startsWith(prefix)) return true;
  return false;
}

export class BuildCacheCleaner {
  private activeSweep: Promise<ClearedCache[]> | undefined;
  private readonly cacheRoot: string;
  private readonly sharedBuildsRoot: string;
  private readonly deps: BuildCacheCleanerDeps;

  constructor(deps: BuildCacheCleanerDeps) {
    this.deps = deps;
    this.cacheRoot = deps.cacheRoot ?? defaultCacheRoot();
    this.sharedBuildsRoot = deps.sharedBuildsRoot ?? defaultSharedBuildsRoot();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private free(): number | undefined {
    return (this.deps.freeBytes ?? (() => freeDiskBytes(this.deps.home)))();
  }

  private isLockHeld(file: string): Promise<boolean | undefined> {
    return (this.deps.lockHeld ?? lockHeldByOther)(file);
  }

  // Runs a sweep only when free disk is under LOW_DISK_FREE_BYTES.
  async ifLow(why: CleanupReason = 'low disk'): Promise<ClearedCache[]> {
    if (!this.deps.enabled || !this.deps.on()) return [];
    const free = this.free();
    if (free === undefined || free >= LOW_DISK_FREE_BYTES) return [];
    return this.sweep(why);
  }

  // Runs one sweep at a time; concurrent callers share the in-flight promise.
  sweep(why: CleanupReason): Promise<ClearedCache[]> {
    if (!this.deps.enabled || !this.deps.on()) return Promise.resolve([]);
    if (this.activeSweep) return this.activeSweep;
    const run = this.runSweep(why).finally(() => {
      if (this.activeSweep === run) this.activeSweep = undefined;
    });
    this.activeSweep = run;
    return run;
  }

  private async runSweep(why: CleanupReason): Promise<ClearedCache[]> {
    const before = this.free();
    const low = before !== undefined && before < LOW_DISK_FREE_BYTES;
    const cleared: ClearedCache[] = [];
    const enoughFreed = () => low && (this.free() ?? 0) >= TARGET_DISK_FREE_BYTES;

    // Order: cheapest to lose first.
    const steps: (() => Promise<void>)[] = [
      () => this.cleanWorktrees(low, cleared, 'idle'),
      () => this.cleanSharedCaches(low, cleared, ['ios-builds', 'update-desktop', 'update']),
      () => this.cleanWorktrees(low, cleared, 'open'),
      () => this.cleanSharedCaches(low, cleared, ['check-desktop-target']),
      () => this.cleanLocalSharedBuilds(low, cleared),
    ];

    for (const step of steps) {
      if (enoughFreed()) break;
      try {
        await step();
      } catch (e) {
        this.deps.log.warn('build cache cleanup step failed', { error: String(e) });
      }
    }

    const after = this.free();
    if (cleared.length) {
      this.deps.log.info('cleared build caches', { why, low, freeBefore: before, freeAfter: after, cleared });
    } else if (low) {
      this.deps.log.warn('disk is low and no build caches could be cleared', { why, free: before });
    }
    return cleared;
  }

  private async removeLeftovers(parent: string): Promise<void> {
    let names: string[];
    try {
      names = fs.readdirSync(parent).filter((n) => n.startsWith(CLEARING_PREFIX));
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(parent, name);
      if (!isRealDir(full)) continue;
      if (this.now() - mtimeMs(full) < QUIET_WINDOW_MS) continue;
      await fs.promises.rm(full, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async cargoTargetBusy(dir: string): Promise<boolean> {
    if (this.now() - latestMtime(dir) < QUIET_WINDOW_MS) return true;
    return (await this.isLockHeld(path.join(dir, '.cargo-lock'))) !== false;
  }

  private async renameAndRemove(dir: string, stillSafe: () => boolean, why: string, cleared: ClearedCache[]): Promise<boolean> {
    if (!isRealDir(dir) || !stillSafe()) return false;
    const parent = path.dirname(dir);
    const aside = path.join(parent, `${CLEARING_PREFIX}${path.basename(dir)}-${this.now()}-${process.pid}`);
    try {
      fs.renameSync(dir, aside);
    } catch {
      return false;
    }
    cleared.push({ path: dir, why });
    await fs.promises.rm(aside, { recursive: true, force: true }).catch(() => undefined);
    return true;
  }

  private slotEligibility(
    slot: ReadSlot,
    pass: 'idle' | 'open',
    low: boolean,
    byId: Map<string, ThreadSummaryLike>,
  ): { why: string; still: (admin: string) => boolean } | undefined {
    const is = slot.is;
    if (pass === 'idle' && is.kind === 'spare') {
      return {
        why: 'spare worktree',
        still: (admin) => readSmallText(path.join(admin, 'locked'))?.trim() === SPARE,
      };
    }
    if (is.kind !== 'held') return undefined;
    const branch = slot.snapshot.branch;
    const onBranchAndNotLanding = (admin: string) =>
      readSmallText(path.join(admin, 'HEAD'))?.trim() === `ref: refs/heads/${branch}` &&
      !fs.existsSync(path.join(admin, LANDING_MARKER));
    if (pass === 'idle' && is.archived) {
      return {
        why: 'archived worktree',
        still: (admin) => onBranchAndNotLanding(admin) && Boolean(this.deps.records().find((r) => r.id === is.thread)?.archivedAt),
      };
    }
    if (pass === 'open' && !is.archived) {
      const idleMs = low ? OPEN_WORKTREE_LOW_IDLE_MS : OPEN_WORKTREE_IDLE_MS;
      const isIdle = (r: ThreadSummaryLike | undefined) =>
        Boolean(r) &&
        !r!.archivedAt &&
        r!.status !== 'running' &&
        r!.status !== 'starting' &&
        this.now() - Date.parse(r!.lastActivityAt ?? '') >= idleMs;
      if (!isIdle(byId.get(is.thread))) return undefined;
      return {
        why: `open worktree idle over ${Math.round(idleMs / HOUR)} hours`,
        still: (admin) => onBranchAndNotLanding(admin) && isIdle(this.deps.records().find((r) => r.id === is.thread)),
      };
    }
    return undefined;
  }

  private async cleanWorktrees(low: boolean, cleared: ClearedCache[], pass: 'idle' | 'open'): Promise<void> {
    const records = this.deps.records();
    const byId = new Map(records.map((r) => [r.id, r]));
    const mains = new Set<string>();
    const keeps = new Map<string, Set<string>>();
    for (const r of records) {
      const w = r.worktree;
      if (!w?.mainCheckout) continue;
      mains.add(w.mainCheckout);
      const set = keeps.get(w.mainCheckout) ?? new Set<string>();
      for (const k of w.keep ?? []) set.add(k.replace(/^\/+|\/+$/g, ''));
      keeps.set(w.mainCheckout, set);
    }
    const claims = claimsOf(records);
    let cwds: string[] | undefined;

    for (const main of mains) {
      const slots = await readSlots(main, claims).catch(() => undefined);
      if (!slots) continue;
      for (const slot of slots) {
        const match = this.slotEligibility(slot, pass, low, byId);
        if (!match || !slot.admin) continue;
        const wt = realpath(slot.checkout.path);
        if (!isRealDir(wt)) continue;
        await this.removeLeftovers(wt);
        for (const sub of childRealDirs(wt)) await this.removeLeftovers(path.join(wt, sub));

        const kept = keeps.get(main);
        const dirs = findCargoBuildDirs(wt).filter((rel) => !kept?.has(rel));
        if (!dirs.length) continue;

        cwds ??= (await (this.deps.cwds ?? processCwds)())?.map((c) => realpath(c));
        // If we cannot enumerate live process cwds, stop rather than risk deleting
        // a cache a running command is building into.
        if (!cwds) return;
        if (anyInside(cwds, wt)) continue;

        const admin = slot.admin;
        for (const rel of dirs) {
          const dir = path.join(wt, rel);
          if (!(await git(wt, ['check-ignore', '-q', '--', rel])).ok) continue;
          if (await this.cargoTargetBusy(dir)) continue;
          await this.renameAndRemove(dir, () => match.still(admin), match.why, cleared);
        }
      }
    }
  }

  private async cleanSharedCaches(low: boolean, cleared: ClearedCache[], which: string[]): Promise<void> {
    const root = this.cacheRoot;
    if (!isRealDir(root)) return;
    await this.removeLeftovers(root);
    const stale = (dir: string) => low || this.now() - latestMtime(dir) >= SHARED_CACHE_MAX_AGE_MS;
    const why = low ? 'low disk' : `unused for ${Math.round(SHARED_CACHE_MAX_AGE_MS / DAY)} days`;

    for (const name of which) {
      if (name === 'check-desktop-target') {
        const dir = path.join(root, name);
        if (isRealDir(dir) && hasCacheDirTag(dir) && stale(dir) && !(await this.cargoTargetBusy(dir))) {
          await this.renameAndRemove(dir, () => true, why, cleared);
        }
      } else if (name === 'update-desktop') {
        await this.cleanUpdateDesktop(path.join(root, name), stale, why, cleared);
      } else if (name === 'update') {
        await this.cleanSwiftUpdate(path.join(root, name), stale, why, cleared);
      } else if (name === 'ios-builds') {
        await this.cleanIosBuilds(root, path.join(root, name), stale, why, cleared);
      }
    }
  }

  private async cleanIosBuilds(cacheRoot: string, dir: string, stale: (d: string) => boolean, why: string, cleared: ClearedCache[]): Promise<void> {
    if (!isRealDir(dir)) return;
    if ((await this.isLockHeld(path.join(cacheRoot, 'build.lock'))) !== false) return;
    await this.removeLeftovers(dir);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => !n.startsWith('.') && n !== 'appstore');
    } catch {
      return;
    }
    for (const n of names) {
      const sub = path.join(dir, n);
      if (!isRealDir(sub) || !stale(sub)) continue;
      if (this.now() - latestMtime(sub) < QUIET_WINDOW_MS) continue;
      await this.renameAndRemove(sub, () => true, why, cleared);
    }
  }

  // desktop/scripts/stage-update.sh holds update-desktop/lock (a dir with a pid
  // file) while building into update-desktop/target.
  private async cleanUpdateDesktop(cacheDir: string, stale: (d: string) => boolean, why: string, cleared: ClearedCache[]): Promise<void> {
    const target = path.join(cacheDir, 'target');
    if (!isRealDir(target) || !hasCacheDirTag(target) || !stale(target) || (await this.cargoTargetBusy(target))) return;
    await this.removeLeftovers(cacheDir);
    const lock = path.join(cacheDir, 'lock');
    const holder = Number(readSmallText(path.join(lock, 'pid'))?.trim());
    if (fs.existsSync(lock)) {
      if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) return;
      if (!(Number.isInteger(holder) && holder > 0) && this.now() - mtimeMs(lock) < MINUTE) return;
      fs.rmSync(lock, { recursive: true, force: true });
    }
    try {
      fs.mkdirSync(lock);
    } catch {
      return;
    }
    let moved: string | undefined;
    try {
      fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}
`);
      if (isRealDir(target)) {
        moved = path.join(cacheDir, `${CLEARING_PREFIX}target-${this.now()}-${process.pid}`);
        fs.renameSync(target, moved);
      }
    } catch {
      moved = undefined;
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
    if (!moved) return;
    cleared.push({ path: target, why });
    await fs.promises.rm(moved, { recursive: true, force: true }).catch(() => undefined);
  }

  // app/stage-update.sh holds update/lock (a dir, considered stale after 60m)
  // while building into update/build.
  private async cleanSwiftUpdate(cacheDir: string, stale: (d: string) => boolean, why: string, cleared: ClearedCache[]): Promise<void> {
    const buildDir = path.join(cacheDir, 'build');
    if (!isRealDir(buildDir) || !stale(buildDir) || this.now() - latestMtime(buildDir) < QUIET_WINDOW_MS) return;
    await this.removeLeftovers(cacheDir);
    const lock = path.join(cacheDir, 'lock');
    if (fs.existsSync(lock)) {
      if (this.now() - mtimeMs(lock) < HOUR) return;
      fs.rmSync(lock, { recursive: true, force: true });
    }
    try {
      fs.mkdirSync(lock);
    } catch {
      return;
    }
    let moved: string | undefined;
    try {
      if (isRealDir(buildDir)) {
        moved = path.join(cacheDir, `${CLEARING_PREFIX}build-${this.now()}-${process.pid}`);
        fs.renameSync(buildDir, moved);
      }
    } catch {
      moved = undefined;
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
    if (!moved) return;
    cleared.push({ path: buildDir, why });
    await fs.promises.rm(moved, { recursive: true, force: true }).catch(() => undefined);
  }

  // check.sh's shared-<n> folders in ~/.cache/threadbear-check/local-builds.
  // Renamed aside while holding shared-<n>.lock so no build takes the slot
  // between checking the lock and moving the directory.
  private async cleanLocalSharedBuilds(low: boolean, cleared: ClearedCache[]): Promise<void> {
    const root = this.sharedBuildsRoot;
    if (!isRealDir(root)) return;
    await this.removeLeftovers(root);
    const why = low ? 'low disk' : `unused for ${Math.round(SHARED_CACHE_MAX_AGE_MS / DAY)} days`;
    let names: string[];
    try {
      names = fs.readdirSync(root).filter((n) => /^shared-\d+$/.test(n));
    } catch {
      return;
    }
    for (const name of names) {
      const dir = path.join(root, name);
      if (!isRealDir(dir)) continue;
      const age = this.now() - latestMtime(dir);
      if (!(low || age >= SHARED_CACHE_MAX_AGE_MS) || age < QUIET_WINDOW_MS) continue;
      if ((await this.isLockHeld(`${dir}.lock`)) !== false) continue;
      const aside = path.join(root, `${CLEARING_PREFIX}${name}-${this.now()}-${process.pid}`);
      if (!(await (this.deps.moveUnderLock ?? renameUnderLock)(`${dir}.lock`, dir, aside))) continue;
      cleared.push({ path: dir, why });
      await fs.promises.rm(aside, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  start(): () => void {
    const run = (why: CleanupReason) => {
      const p = why === 'hourly' ? this.sweep(why) : this.ifLow(why);
      void p.catch((e: unknown) => this.deps.log.warn('build cache cleanup failed', { error: String(e) }));
    };
    const first = setTimeout(() => run('hourly'), 5 * MINUTE);
    const hourly = setInterval(() => run('hourly'), SWEEP_INTERVAL_MS);
    const low = setInterval(() => run('low disk'), LOW_DISK_POLL_MS);
    for (const timer of [first, hourly, low]) timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(hourly);
      clearInterval(low);
    };
  }
}
