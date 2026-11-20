import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { ProcessRegistry, approxStartTime, followUpKillDue, groupAlive, hasExited, groupSpawner, killGroup, ownStartTime, pidExists, processInfo, sameStart, sameStartTime, startOf } from '../../src/proc.ts';
import { acquireLock } from '../../src/lock.ts';
import { nullLogger } from '../../src/log.ts';
import { tmpDir } from '../helpers/fakes.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';
import { IS_WINDOWS, NO_SIGNALS_ON_WINDOWS, onlyOnWindows, skipOnWindows, withoutPowerShell } from '../helpers/platform.ts';
import { pathToFileURL } from 'node:url';

const RUNNER_DIR = path.join(import.meta.dirname, '..', '..');

// A detached process (its own group). With ignoreTerm, SIGTERM does nothing.
// Windows has no groups and no SIGTERM to ignore (it ends the process
// outright), so a node child that waits stands in there.
function group(ignoreTerm = false): ChildProcess {
  const script = ignoreTerm ? 'trap "" TERM; sleep 60' : 'sleep 60';
  const c = IS_WINDOWS ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) : spawn('/bin/bash', ['-c', script], { detached: true, stdio: 'ignore' });
  c.unref();
  return c;
}

async function until(fn: () => boolean, ms = PATIENCE_MS): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

// On Linux ps's lstart is the boot time plus the process's age, and the boot
// time moves when the clock is stepped (WSL, 17 Nov), so records there also
// keep the boot id and /proc's start ticks, which don't. lstart stays in them
// for older releases, and records older runners wrote still match.
test("a process's recorded start doesn't depend on the clock, and older records still match", skipOnWindows("lstart is ps's, and Windows records its own start time"), () => {
  const info = processInfo(process.pid)!;
  const ps = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim().replace(/\s+/g, ' ');
  assert.equal(info.lstart, ps, 'lstart is still what older releases compare');
  if (process.platform === 'linux') {
    const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    assert.equal(info.started, `${boot}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`);
    // A clock step moves lstart but not started: still the same process.
    assert.equal(sameStart({ lstart: 'Mon Jan 1 00:00:00 2001', started: info.started }, info), true);
    // Same ticks in another boot is another process.
    assert.equal(sameStart({ lstart: ps, started: `other-boot:${info.started!.split(':').pop()}` }, info), false);
  } else {
    assert.equal(info.started, undefined);
  }
  assert.deepEqual(startOf(info), info.started ? { lstart: ps, started: info.started } : { lstart: ps });
  assert.equal(sameStart(startOf(info), info), true);
  assert.equal(sameStart({ lstart: ps }, info), true, 'a record an older runner wrote');
  assert.equal(sameStart({ lstart: 'Mon Jan 1 00:00:00 2001' }, info), false);
  assert.equal(sameStart({}, info), false);
  assert.equal(sameStart({ lstart: ps }, null), false);
});

test('the startup sweep waits until old groups are gone, and leaves a recycled pid alone', async () => {
  const run = tmpDir();
  const stubborn = group(true);
  const other = group();
  await new Promise((r) => setTimeout(r, 200));
  try {
    const entries = [
      { pid: stubborn.pid, command: '/bin/bash', startedAt: new Date().toISOString(), lstart: processInfo(stubborn.pid!)!.lstart, groups: [] },
      // Same pid as something alive, but it started at another time: a recycled pid.
      { pid: other.pid, command: '/bin/bash', startedAt: new Date().toISOString(), lstart: 'Mon Jan  1 00:00:00 2001', groups: [] },
    ];
    fs.writeFileSync(path.join(run, 'children.json'), JSON.stringify(entries));
    const reg = new ProcessRegistry(run, nullLogger);
    const t0 = Date.now();
    assert.equal(await reg.sweepOrphans(300), 1);
    assert.equal(groupAlive(stubborn.pid!), false, 'gone by the time the sweep returns');
    if (!IS_WINDOWS) assert.ok(Date.now() - t0 >= 300, 'it ignored SIGTERM, so it took a SIGKILL');
    assert.equal(groupAlive(other.pid!), true, 'the recycled pid was not touched');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(run, 'children.json'), 'utf8')), []);
  } finally {
    killGroup(stubborn.pid!, 'SIGKILL');
    killGroup(other.pid!, 'SIGKILL');
  }
});

test("a CLI that dies hard has its tool commands' process groups stopped too", NO_SIGNALS_ON_WINDOWS, async () => {
  const run = tmpDir();
  const reg = new ProcessRegistry(run, nullLogger);
  const spawnCli = groupSpawner(reg, nullLogger, () => {});
  // A stand-in CLI that runs a "tool command" in a group of its own, as
  // Claude Code's Bash tool does.
  const script = `const c = require('node:child_process').spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);`;
  const cli = spawnCli({ command: process.execPath, args: ['-e', script], cwd: run, env: process.env, signal: new AbortController().signal } as any) as unknown as ChildProcess;
  const toolPid = await new Promise<number>((resolve) => cli.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
  try {
    await reg.scan();
    assert.deepEqual(reg.toolGroups(cli.pid!), [toolPid]);
    const saved = JSON.parse(fs.readFileSync(path.join(run, 'children.json'), 'utf8'));
    assert.equal(saved[0].groups[0].pgid, toolPid, 'recorded for a runner restart too');
    process.kill(cli.pid!, 'SIGKILL');
    assert.ok(await until(() => !groupAlive(toolPid)), 'the tool command was stopped');
    assert.deepEqual(reg.pids(), []);
  } finally {
    killGroup(toolPid, 'SIGKILL');
    killGroup(cli.pid!, 'SIGKILL');
  }
});

test('only one runner holds the data dir lock; a dead or recycled holder is taken over', async () => {
  const run = tmpDir();
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(pathToFileURL(path.join(RUNNER_DIR, 'src', 'lock.ts')).href)}; acquireLock(process.argv[1]); console.log('held'); setInterval(() => {}, 1000);`, run], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((r) => holder.stdout!.once('data', r));
    const second = acquireLock(run);
    assert.deepEqual(second, { heldBy: holder.pid });
    holder.kill('SIGKILL');
    await new Promise((r) => holder.once('exit', r));
    const mine = acquireLock(run);
    assert.ok('release' in mine, 'a dead holder is taken over');
    mine.release();
    assert.equal(fs.existsSync(path.join(run, 'runner.pid')), false);
    // A live pid that started at a different time isn't the old runner.
    fs.writeFileSync(path.join(run, 'runner.pid'), JSON.stringify({ pid: process.ppid, lstart: 'Mon Jan  1 00:00:00 2001' }));
    const again = acquireLock(run);
    assert.ok('release' in again);
    again.release();
  } finally {
    holder.kill('SIGKILL');
  }
});

test('a lock with no start time still counts while a runner under launch.mjs holds it', async () => {
  const run = tmpDir();
  // A release runs as `node <home>/runner/launch.mjs`, not main.ts.
  const script = path.join(tmpDir(), 'launch.mjs');
  fs.writeFileSync(script, "console.log('up'); setInterval(() => {}, 1000);\n");
  const holder = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((r) => holder.stdout!.once('data', r));
    fs.writeFileSync(path.join(run, 'runner.pid'), JSON.stringify({ pid: holder.pid, lstart: '' }));
    assert.deepEqual(acquireLock(run), { heldBy: holder.pid });
  } finally {
    holder.kill('SIGKILL');
  }
});

// Takes the lock in a child process and says what happened. With
// `powershell: false` the child can't run PowerShell, so on Windows it can't
// read start times (the way policy, AppLocker or a timeout under load stop it).
// A child that got the lock keeps it until it is killed.
async function takeLock(run: string, powershell: boolean): Promise<{ result: string; proc: ChildProcess }> {
  const code = `import { acquireLock } from ${JSON.stringify(pathToFileURL(path.join(RUNNER_DIR, 'src', 'lock.ts')).href)}; const l = acquireLock(process.argv[1]); console.log('heldBy' in l ? 'heldBy ' + l.heldBy : 'acquired'); if ('heldBy' in l) process.exit(0); setInterval(() => {}, 1000);`;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code, run], { stdio: ['ignore', 'pipe', 'inherit'], env: powershell ? process.env : withoutPowerShell() });
  const result = await new Promise<string>((resolve) => {
    proc.stdout!.once('data', (d) => resolve(String(d).trim()));
    proc.once('exit', (code) => resolve(`exited ${code}`));
  });
  return { result, proc };
}

const WITH_AND_WITHOUT = [true, false];

for (const holderHasPowerShell of WITH_AND_WITHOUT) {
  for (const checkerHasPowerShell of WITH_AND_WITHOUT) {
    test(
      `a second runner is refused whether or not PowerShell can be run (holder ${holderHasPowerShell ? 'with' : 'without'}, second ${checkerHasPowerShell ? 'with' : 'without'})`,
      onlyOnWindows('Only Windows reads start times through PowerShell'),
      async () => {
        const run = tmpDir();
        const first = await takeLock(run, holderHasPowerShell);
        let second: { result: string; proc: ChildProcess } | undefined;
        try {
          assert.equal(first.result, 'acquired');
          second = await takeLock(run, checkerHasPowerShell);
          assert.equal(second.result, `heldBy ${first.proc.pid}`);
        } finally {
          second?.proc.kill('SIGKILL');
          first.proc.kill('SIGKILL');
        }
      },
    );
  }
}

test('a holder that is gone is taken over even when PowerShell can not be run', onlyOnWindows('Only Windows reads start times through PowerShell'), async () => {
  const run = tmpDir();
  const first = await takeLock(run, false);
  assert.equal(first.result, 'acquired');
  first.proc.kill('SIGKILL');
  await new Promise((r) => first.proc.once('exit', r));
  const second = await takeLock(run, false);
  try {
    assert.equal(second.result, 'acquired');
  } finally {
    second.proc.kill('SIGKILL');
  }
});

const READS_START_TIMES = onlyOnWindows('Only Windows reads start times through PowerShell');

test('a start time worked out in-process is close to the one the system reports, and a different one is not the same process', READS_START_TIMES, () => {
  const real = processInfo(process.pid)!.lstart;
  assert.match(ownStartTime(), /^~\d+$/);
  assert.ok(sameStartTime(ownStartTime(), real), 'the estimate matches this process');
  assert.ok(sameStartTime(real, real));
  const hourAgo = approxStartTime(Date.now() - 3_600_000);
  assert.equal(sameStartTime(hourAgo, real), false, 'a process an hour older is another one');
  assert.equal(sameStartTime(approxStartTime(Date.now() + 60_000), real), false);
  // A real reading is never matched loosely, and junk matches nothing.
  assert.equal(sameStartTime(String(BigInt(real) + 1n), real), false);
  assert.equal(sameStartTime('Mon Jan  1 00:00:00 2001', real), false);
  assert.equal(sameStartTime('', real), false);
  assert.equal(sameStartTime('~12abc', real), false);
});

test('pidExists says whether a process is there without touching it', () => {
  assert.equal(pidExists(process.pid), true);
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  return new Promise<void>((resolve) =>
    gone.once('exit', () => {
      assert.equal(pidExists(gone.pid!), false);
      resolve();
    }),
  );
});

test('a lock whose estimated start time is far from the live process it names is taken over', READS_START_TIMES, () => {
  const run = tmpDir();
  fs.writeFileSync(path.join(run, 'runner.pid'), JSON.stringify({ pid: process.ppid, lstart: approxStartTime(Date.now() - 86_400_000) }));
  const taken = acquireLock(run);
  assert.ok('release' in taken, 'another program now has that pid');
  taken.release();
});

test('a runner that could not read its start time still leaves one in the lock', READS_START_TIMES, async () => {
  const run = tmpDir();
  const first = await takeLock(run, false);
  try {
    assert.equal(first.result, 'acquired');
    const held = JSON.parse(fs.readFileSync(path.join(run, 'runner.pid'), 'utf8')) as { pid: number; lstart: string };
    assert.equal(held.pid, first.proc.pid);
    assert.match(held.lstart, /^~\d+$/);
    assert.ok(sameStartTime(held.lstart, processInfo(first.proc.pid!)!.lstart), 'it is the start time the system gives that process');
  } finally {
    first.proc.kill('SIGKILL');
  }
});

test("a CLI added while PowerShell can't be run is recorded with a start time, and the next runner's sweep still stops it and leaves a reused pid alone", READS_START_TIMES, async () => {
  const run = tmpDir();
  const cli = group();
  const bystander = group();
  await new Promise((r) => setTimeout(r, 200));
  const was = process.env.PATH;
  try {
    // PowerShell can't be run for the duration of the add only.
    const noPs = withoutPowerShell();
    const key = Object.keys(noPs).find((k) => k.toLowerCase() === 'path')!;
    process.env[key] = noPs[key];
    if (noPs.THREADBEAR_NO_POWERSHELL) process.env.THREADBEAR_NO_POWERSHELL = noPs.THREADBEAR_NO_POWERSHELL;
    const reg = new ProcessRegistry(run, nullLogger);
    try {
      reg.add(cli.pid!, process.execPath);
    } finally {
      process.env[key] = was;
      delete process.env.THREADBEAR_NO_POWERSHELL;
    }
    const saved = JSON.parse(fs.readFileSync(path.join(run, 'children.json'), 'utf8')) as { pid: number; lstart?: string }[];
    assert.match(saved[0].lstart ?? '', /^~\d+$/, 'the entry kept a start time');
    // Another live process's pid with a start time of the same kind but far off: not ours.
    saved.push({ pid: bystander.pid!, lstart: approxStartTime(Date.now() - 86_400_000) } as never);
    fs.writeFileSync(path.join(run, 'children.json'), JSON.stringify(saved));
    const next = new ProcessRegistry(run, nullLogger);
    assert.equal(await next.sweepOrphans(300), 1);
    assert.equal(groupAlive(cli.pid!), false, 'the CLI the first runner left was stopped');
    assert.equal(groupAlive(bystander.pid!), true, 'the reused pid was not touched');
  } finally {
    process.env.PATH = was;
    killGroup(cli.pid!, 'SIGKILL');
    killGroup(bystander.pid!, 'SIGKILL');
  }
});

test('the SIGKILL that follows a SIGTERM is skipped on Windows once the process has exited, and sent on a Mac whatever its exit', async () => {
  const live = group();
  await new Promise((r) => setTimeout(r, 200));
  try {
    assert.equal(followUpKillDue(live.pid!, false), true, 'a group that is there and not seen to exit is killed');
    // On a Mac the group is what counts: a CLI that exited with a code after SIGTERM can
    // leave a member that ignored it, and the SIGKILL still has to reach that.
    assert.equal(followUpKillDue(live.pid!, true), !IS_WINDOWS, 'an exited process: the pid may be someone else\'s on Windows');
    assert.equal(hasExited({ exitCode: null, signalCode: null }), false);
    assert.equal(hasExited({ exitCode: 0, signalCode: null }), true);
    assert.equal(hasExited({ exitCode: null, signalCode: 'SIGTERM' }), true);
  } finally {
    killGroup(live.pid!, 'SIGKILL');
  }
  // A killed process is a zombie until node reaps it, and a zombie still counts as a group.
  assert.ok(await until(() => !groupAlive(live.pid!), 5000), 'the group is gone');
  assert.equal(followUpKillDue(live.pid!, false), false, 'nothing there, nothing to kill');
});

test('a member of a CLI\'s group that ignores SIGTERM is still killed when the CLI exits cleanly on SIGTERM', NO_SIGNALS_ON_WINDOWS, async () => {
  const run = tmpDir();
  const spawnCli = groupSpawner(new ProcessRegistry(run, nullLogger), nullLogger, () => {});
  // A stand-in CLI that exits with a code on SIGTERM, with a program in its group that ignores it.
  // The pid is printed only once the program has said its trap is set (echo ready): a SIGTERM
  // that arrives before the trap would end it, which a slow macOS runner showed.
  const script = `const c = require('node:child_process').spawn('/bin/sh', ['-c', 'trap "" TERM; echo ready; sleep 60'], { stdio: ['ignore', 'pipe', 'ignore'] }); c.stdout.once('data', () => console.log(c.pid)); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
  const abort = new AbortController();
  const cli = spawnCli({ command: process.execPath, args: ['-e', script], cwd: run, env: process.env, signal: abort.signal } as any) as unknown as ChildProcess;
  const straggler = await new Promise<number>((resolve) => cli.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
  try {
    abort.abort();
    await new Promise((r) => cli.once('exit', r));
    assert.equal(cli.exitCode, 0, 'the CLI went on SIGTERM, with a code');
    assert.equal(groupAlive(cli.pid!), true, 'the straggler holds the group');
    assert.ok(await until(() => !groupAlive(cli.pid!), 8000), 'the SIGKILL 3 s on reached it');
  } finally {
    killGroup(cli.pid!, 'SIGKILL');
    try {
      process.kill(straggler, 'SIGKILL');
    } catch {
      // gone
    }
  }
});
