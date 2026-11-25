// What perf-lock's tests share: real kernel locks and harmless sleeping
// children, never a build or a window. The tests are five files
// (perf-lock*.test.ts), not one: in one file their 57 tests ran one after
// another for two to four and a half minutes, the longest file of the
// suite, and with every other file done the check sat waiting on it
// (24 Nov 2026). Apart, the check runs them side by side.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PATIENCE_MS } from './patience.ts';
import type { TestContext } from 'node:test';

export const root = path.resolve(import.meta.dirname, '../../..');
export const helper = path.join(root, 'scripts/perf-lock.pl');
export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Perl that's true while this test process lives, for stand-in failures and
// leftover children that would otherwise never end if the run is killed.
export const TEST_ALIVE = `kill(0, ${process.pid})`;
// The scripts' own TERM grace, for a test of work that stops itself on TERM:
// at a load of 100 its handler mightn't run inside host()'s 1 s.
export const GRACEFUL = { THREADBEAR_STOP_GRACE_SECS: '5' };
// By the clock, with the suite's patience, not 500 polls (about 20 s): at a
// load of 100 a perl child took longer than that to start (a fork, 15 Nov).
export async function until(check: () => boolean, message: string) {
  const end = Date.now() + PATIENCE_MS;
  while (Date.now() < end) {
    if (check()) return;
    await pause(40);
  }
  if (!check()) assert.fail(message);
}
// A process's exit within the suite's patience, failing rather than hanging.
export async function within<T>(done: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), PATIENCE_MS); });
  try { return await Promise.race([done, late]); } finally { clearTimeout(timer); }
}
// When a process started, as perf-children.pl records it: lstart on macOS,
// and on Linux seconds since boot, as lstart there moves with the clock's
// boot time when the clock is stepped (WSL, 17 Nov).
export function born(pid: number | string): string {
  const bootTime = () => {
    if (process.platform !== 'linux') return 0;
    const m = fs.readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)/m);
    return m ? Number(m[1]) : 0;
  };
  // Like perf-children.pl, only trust a read with the same boot time either side.
  for (;;) {
    const boot = bootTime();
    const lstart = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).stdout.trim();
    if (!boot || !lstart) return lstart;
    if (bootTime() !== boot) continue;
    const at = Date.parse(`${lstart.replace(/\s+/g, ' ')} UTC`);
    return Number.isNaN(at) ? lstart : `boot+${at / 1000 - boot}`;
  }
}
export function host(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-perf-lock-'));
  // One give-up limit whatever the shell running the suite exports, well
  // past PATIENCE_MS so no test that waits on a failing probe meets it.
  // And a 1 s TERM grace, not the scripts' 5 s: the stand-ins here mostly
  // ignore TERM on purpose, so each waited the whole grace out, twice where
  // the guard and the reaper each gave one, and this file took over three
  // minutes, the longest of the suite (24 Nov). What they test is that the
  // KILL comes after it, not how long it is; the tests of a graceful stop
  // keep the 5 s (GRACEFUL).
  const env = { ...process.env, HOME: home, THREADBEAR_PERF_LOCK_OWNER: '', THREADBEAR_PERF_REAP_LIMIT: '300', THREADBEAR_STOP_GRACE_SECS: '1' };
  const children: (ChildProcess & { done: Promise<number | null> })[] = [];
  t.after(async () => {
    fs.writeFileSync(path.join(home, 'resume-scan'), '');
    fs.rmSync(path.join(home, 'fail-scan'), { force: true });
    fs.rmSync(path.join(home, 'blocked-probe'), { force: true });
    for (const child of children) child.stdin?.end();
    for (const child of children) await child.done;
    fs.rmSync(home, { recursive: true, force: true });
  });
  function run(args: string[], extra: NodeJS.ProcessEnv = {}, deskPid?: string, detached = false, program = helper) {
    const child = spawn('perl', [program, ...(deskPid ? ['--desk', deskPid] : ['-']), ...args], { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'], detached });
    const result = child as ChildProcess & { output: string; done: Promise<number | null> };
    result.output = '';
    child.stdout!.on('data', (s) => { result.output += s; });
    child.stderr!.on('data', (s) => { result.output += s; });
    result.done = new Promise((r) => child.on('exit', r));
    children.push(result);
    return result;
  }
  return { home, env, run };
}

export function pausedSnapshot(home: string) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), `#!/usr/bin/perl
    use strict; use warnings;
    my $base = $ENV{HOME};
    # Every stand-in failure here ends with the test process, so a killed test run can't leave a cleanup stuck behind it for good:
    # 33 of them ran for hours on Seth's Mac at a load of 159 (20 Nov).
    if ($ARGV[0] eq '-axo' && $ARGV[1] eq 'pid=,ppid=,pgid=,uid=,stat=,lstart=' && -e "$base/fail-scan" && ${TEST_ALIVE}) {
      open(my $seen, '>', "$base/scan-failed"); close $seen; exit 1;
    }
    if ($ARGV[0] eq '-axo' && $ARGV[1] eq 'pid=,ppid=,pgid=,uid=,stat=,lstart=' && unlink("$base/pause-scan")) {
      open(my $ps, '-|', '/bin/ps', @ARGV) or die $!;
      my $rows = do { local $/; <$ps> }; close $ps or die 'ps failed';
      open(my $out, '>', "$base/snapshot") or die $!; print {$out} $rows; close $out;
      open(my $ready, '>', "$base/scan-ready") or die $!; close $ready;
      select(undef, undef, undef, 0.02) until -e "$base/resume-scan" || !${TEST_ALIVE};
      open(my $saved, '<', "$base/snapshot") or die $!; print while <$saved>; exit;
    }
    exec '/bin/ps', @ARGV;
  `, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'pause-scan'), '');
  return { PATH: `${bin}:${process.env.PATH}` };
}
