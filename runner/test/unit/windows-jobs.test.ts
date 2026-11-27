// Windows' stand-in for a CLI's process group: a Job Object for each CLI
// (src/proc.ts, JobControl; made by win32-helper.ps1). Ending it ends
// everything the CLI left running, including processes whose parent has
// gone, which taskkill /T can't find.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nullLogger } from '../../src/log.ts';
import { ProcessRegistry, approxStartTime, helperJobs, newJobName, pidExists, processInfo, type JobControl } from '../../src/proc.ts';
import { tmpDir } from '../helpers/fakes.ts';
import { onlyOnWindows } from '../helpers/platform.ts';
import { PATIENCE_MS } from '../helpers/patience.ts';

// The start of a live process as the helper answers it: a FILETIME on
// Windows; on a Mac, where ps gives a date, any number (the start can't be
// compared there). PowerShell's probe fails now and then on a loaded CI
// machine, and an answer of '1' then looked like a reused pid, so the job
// was let go of and the test failed (GitHub's Windows, 18 Nov). It's asked
// again, and if it still can't say, the time now stands in: add() falls
// back to the same estimate when its own probe fails.
function startNow(pid: number): string {
  for (let i = 0; i < 3; i++) {
    const l = processInfo(pid)?.lstart ?? '';
    if (/^\d+$/.test(l)) return l;
    if (l && process.platform !== 'win32') return '1';
  }
  return process.platform === 'win32' ? approxStartTime(Date.now()).slice(1) : '1';
}

// A stand-in for the helper. assign answers the start of the process it
// was given, as the helper does (startNow), or `start`.
function recorder(start?: (pid: number) => string) {
  const calls: string[] = [];
  const jobs: JobControl = {
    assign: async (pid, name) => {
      calls.push(`assign ${pid} ${name}`);
      return start ? start(pid) : startNow(pid);
    },
    end: async (name) => void calls.push(`end ${name}`),
    forget: async (name) => void calls.push(`forget ${name}`),
  };
  return { calls, jobs };
}

const JOB = /^Local\\threadbear-job-[0-9a-f]{32}$/;
const tick = () => new Promise((r) => setTimeout(r, 50));
// Until cond holds, or a few seconds: the registry's answers chain a few promises.
async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await tick();
}

// A process to stand for a CLI: real, so its start can be read.
function sleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
}

test('job names are the runner\'s own: random, and only of the form the helper takes', () => {
  const a = newJobName();
  assert.match(a, JOB);
  assert.notEqual(a, newJobName());
});

test('a CLI goes in a job of its own as it starts, and the job ends when the CLI does', async () => {
  const { calls, jobs } = recorder();
  const dir = tmpDir();
  const reg = new ProcessRegistry(dir, nullLogger);
  reg.jobs = jobs;
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    assert.equal(calls.length, 1, 'asked straight away');
    const [, pid, name] = calls[0]!.split(' ');
    assert.equal(Number(pid), cli.pid);
    assert.match(name!, JOB);
    await until(() => !(reg as unknown as { assigning: Set<unknown> }).assigning.size);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'children.json'), 'utf8')) as { job?: string }[];
    assert.equal(saved[0]!.job, name, 'kept once the helper says it was the CLI, so the next runner can end it');
    reg.remove(cli.pid!);
    await tick();
    assert.deepEqual(calls.slice(1), [`end ${name}`]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'children.json'), 'utf8')), [], 'ended, so not kept');
    // Never the runner's own process.
    reg.add(process.pid, 'claude', 'th1');
    reg.remove(process.pid);
    assert.equal(calls.length, 2);
  } finally {
    cli.kill();
  }
});

test("a job that got a process which wasn't the CLI (its pid reused) is let go of, never ended", async () => {
  const { calls, jobs } = recorder(() => '5');
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.jobs = jobs;
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    const entry = (reg as unknown as { entries: Map<number, { lstart?: string }> }).entries.get(cli.pid!)!;
    if (!/^~?\d+$/.test(entry.lstart ?? '')) entry.lstart = '133761234567890123'; // a Mac's ps gives a date
    await tick();
    const name = calls[0]!.split(' ')[2];
    assert.deepEqual(calls.slice(1), [`forget ${name}`]);
    reg.remove(cli.pid!);
    await tick();
    assert.ok(!calls.some((c) => c.startsWith('end')), 'nothing ended');
  } finally {
    cli.kill();
  }
});

test('a job the helper refuses (a name someone else made first) is never ended, and the CLI stays recorded for taskkill /T', async () => {
  const calls: string[] = [];
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.jobs = { assign: async () => { throw new Error('a job by that name already exists'); }, end: async (n) => void calls.push(`end ${n}`), forget: async () => {} };
  reg.killUnjobbed = (pid) => void calls.push(`kill ${pid}`);
  const cli = sleeper();
  try {
    // Not a thread's (a job's label): left running, as before.
    reg.add(cli.pid!, 'claude');
    await tick();
    assert.deepEqual(reg.pids(), [cli.pid]);
    reg.remove(cli.pid!);
    await tick();
    assert.deepEqual(calls, []);
  } finally {
    cli.kill();
  }
});

// Daybreak finding 177: on Windows the RPC places a thread's processes by
// its CLI's job, so a thread's CLI that couldn't be put in one is stopped
// rather than left running where its processes can't be placed.
test("a thread's CLI the helper couldn't put in a job is stopped", async () => {
  const calls: string[] = [];
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  let asked = 0;
  reg.jobs = { assign: async () => { asked++; throw new Error('the helper didn\'t answer jobAssign in time'); }, end: async (n) => void calls.push(`end ${n}`), forget: async () => {} };
  reg.killUnjobbed = (pid) => void calls.push(`kill ${pid}`);
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    await tick();
    await tick();
    // Tried twice (the second under a new name), then stopped.
    assert.deepEqual(calls, [`kill ${cli.pid}`]);
    assert.equal(asked, 2);
  } finally {
    reg.remove(cli.pid!);
    cli.kill();
  }
});

test('a CLI that exits before the helper has answered has its job ended once it does', async () => {
  let answer!: (s: string) => void;
  const calls: string[] = [];
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.jobs = { assign: () => new Promise((r) => (answer = r)), end: async (n) => void calls.push(`end ${n}`), forget: async () => {} };
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    const l = startNow(cli.pid!);
    reg.remove(cli.pid!);
    answer(l);
    await until(() => calls.length > 0);
    assert.equal(calls.length, 1);
  } finally {
    cli.kill();
  }
});

test("the next runner ends the jobs the last one's CLIs had, keeps any it can't end for the start after, and leaves their pids alone", async () => {
  const dir = tmpDir();
  const name = newJobName();
  const stuck = newJobName();
  // CLIs that are gone (pids nothing has): their jobs may still hold what they started.
  fs.writeFileSync(
    path.join(dir, 'children.json'),
    JSON.stringify([
      { pid: 999_999_999, command: 'claude', startedAt: new Date().toISOString(), lstart: '1', job: name },
      { pid: 999_999_998, command: 'claude', startedAt: new Date().toISOString(), lstart: '1', job: stuck, exited: true },
      { pid: 999_999_997, command: 'claude', startedAt: new Date().toISOString(), lstart: '1', job: 'Global\\someone-else' },
    ]),
  );
  const calls: string[] = [];
  const reg = new ProcessRegistry(dir, nullLogger);
  reg.jobs = {
    assign: async () => '1',
    end: async (n) => {
      calls.push(`end ${n}`);
      if (n === stuck) throw new Error('the helper exited');
    },
    forget: async () => {},
  };
  await reg.sweepOrphans(10);
  assert.deepEqual(calls.sort(), [`end ${name}`, `end ${stuck}`].sort(), 'only names of the runner\'s own form');
  const kept = JSON.parse(fs.readFileSync(path.join(dir, 'children.json'), 'utf8')) as { job?: string; exited?: boolean }[];
  assert.deepEqual(kept.map((e) => [e.job, e.exited]), [[stuck, true]]);
});

test('on Windows what a CLI left running ends with its job, even with its parent gone', onlyOnWindows('Job Objects are Windows'), async () => {
  const dir = tmpDir();
  const reg = new ProcessRegistry(dir, nullLogger);
  assert.equal(reg.jobs, helperJobs);
  const marker = path.join(dir, 'left.pid');
  const go = path.join(dir, 'go');
  // A "CLI" that starts a long-running process, writes its pid, and exits
  // straight away: the process is an orphan, as a nohup'd tool command is.
  // Once it's in its job, as a real CLI takes a while before its first tool
  // command. It waited a fixed second before, and on a loaded CI machine the
  // helper hadn't answered by then, so nothing held the orphan (18 Nov).
  const left = `const t = setInterval(() => { if (!require('fs').existsSync(${JSON.stringify(go)})) return; clearInterval(t); const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { detached: true, stdio: 'ignore', windowsHide: true }); require('fs').writeFileSync(${JSON.stringify(marker)}, String(c.pid)); c.unref(); process.exit(0); }, 50);`;
  // The runner starts its helper as it starts.
  await (await import('../../src/win32-helper.ts')).win32Helper().ask('ping');
  const cli = spawn(process.execPath, ['-e', left], { stdio: 'ignore', windowsHide: true });
  reg.add(cli.pid!, process.execPath, 'th1');
  const assigning = (reg as unknown as { assigning: Set<unknown> }).assigning;
  for (const deadline = Date.now() + PATIENCE_MS / 2; assigning.size && Date.now() < deadline; ) await tick();
  assert.equal(assigning.size, 0, 'the helper answered');
  assert.ok((reg as unknown as { entries: Map<number, { job?: string }> }).entries.get(cli.pid!)?.job, 'in a job of its own');
  fs.writeFileSync(go, '');
  const exited = new Promise((r) => cli.once('exit', r));
  await exited;
  const orphan = Number(fs.readFileSync(marker, 'utf8'));
  try {
    assert.ok(pidExists(orphan), 'its child outlived it');
    reg.remove(cli.pid!);
    const deadline = Date.now() + PATIENCE_MS;
    while (pidExists(orphan) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.equal(pidExists(orphan), false, 'ended with the job');
  } finally {
    try {
      process.kill(orphan);
    } catch {
      // gone
    }
    (await import('../../src/win32-helper.ts')).win32Helper().stop();
  }
});

// Codex's second review.
test("the helper is told the latest start the CLI can have, and an answer after it isn't the CLI", async () => {
  const seen: string[] = [];
  const calls: string[] = [];
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.jobs = {
    assign: async (_pid, _name, notAfter) => {
      seen.push(notAfter);
      return (BigInt(notAfter) + 1n).toString();
    },
    end: async (n) => void calls.push(`end ${n}`),
    forget: async (n) => void calls.push(`forget ${n}`),
  };
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    const now = (BigInt(Date.now()) + 11_644_473_600_000n) * 10_000n;
    assert.ok(/^\d+$/.test(seen[0]!) && BigInt(seen[0]!) >= now - 10_000_000n && BigInt(seen[0]!) <= now + 10_000_000n, 'about now, as a FILETIME');
    await until(() => calls.length > 0);
    assert.match(calls[0] ?? '', /^forget /);
    reg.remove(cli.pid!);
    await tick();
    assert.ok(!calls.some((c) => c.startsWith('end')));
  } finally {
    cli.kill();
  }
});

// Windows stamped CLIs up to 1.2 ms after node's Date.now() from just after
// they were spawned, and their jobs were refused (19 Nov).
test("a CLI stamped a little after node's now is still the CLI: Windows' clock isn't node's", async () => {
  let notAfter = '';
  let created = '';
  const calls: string[] = [];
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.jobs = {
    assign: async (_pid, _name, n) => {
      notAfter = n;
      // 2 ms after node's now as the runner asks.
      created = ((BigInt(Date.now()) + 2n + 11_644_473_600_000n) * 10_000n).toString();
      return created;
    },
    end: async (n) => void calls.push(`end ${n}`),
    forget: async (n) => void calls.push(`forget ${n}`),
  };
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    (reg as unknown as { entries: Map<number, { lstart?: string }> }).entries.get(cli.pid!)!.lstart = created;
    assert.ok(BigInt(created) <= BigInt(notAfter), 'the helper takes it too');
    await tick();
    reg.remove(cli.pid!);
    await until(() => calls.length > 0);
    assert.match(calls[0] ?? '', /^end /);
  } finally {
    cli.kill();
  }
});

// The slack mustn't let in a process that got the CLI's pid: the runner only
// lets go of the pid once its event loop has run, so add() holds it until
// notAfter has passed (Codex's review, 19 Nov).
test('add() returns only once notAfter has passed, so the pid can only be reused after it', async () => {
  let notAfter = '';
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.jobs = {
    assign: async (_pid, _name, n) => ((notAfter = n), '1'),
    end: async () => {},
    forget: async () => {},
  };
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    const back = (BigInt(Date.now()) + 11_644_473_600_000n) * 10_000n;
    assert.ok(back > BigInt(notAfter), `returned at ${back}, notAfter ${notAfter}`);
    reg.remove(cli.pid!);
  } finally {
    cli.kill();
  }
});

test("a CLI that exited before its job was made keeps its record when the job can't be ended", async () => {
  let answer!: (s: string) => void;
  const dir = tmpDir();
  const reg = new ProcessRegistry(dir, nullLogger);
  reg.jobs = { assign: () => new Promise((r) => (answer = r)), end: async () => { throw new Error('the helper exited'); }, forget: async () => {} };
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    const l = processInfo(cli.pid!)?.lstart ?? '';
    reg.remove(cli.pid!);
    answer(/^\d+$/.test(l) ? l : '1');
    await tick();
    await tick();
    const kept = JSON.parse(fs.readFileSync(path.join(dir, 'children.json'), 'utf8')) as { job?: string; exited?: boolean }[];
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.exited, true);
    assert.match(kept[0]!.job ?? '', JOB);
  } finally {
    cli.kill();
  }
});

test("jobs that can't be ended at shutdown are kept, and a draining runner's go where the next start finds them", async () => {
  const dir = tmpDir();
  let failing = true;
  const ended: string[] = [];
  const jobs: JobControl = {
    assign: async (pid) => {
      const l = processInfo(pid)?.lstart ?? '';
      return /^\d+$/.test(l) ? l : '1';
    },
    end: async (n) => {
      if (failing) throw new Error('the helper exited');
      ended.push(n);
    },
    forget: async () => {},
  };
  const draining = new ProcessRegistry(dir, nullLogger, 'children-1234.json');
  draining.jobs = jobs;
  const cli = sleeper();
  try {
    draining.add(cli.pid!, 'claude', 'th1');
    await tick();
    const name = JSON.parse(fs.readFileSync(path.join(dir, 'children-1234.json'), 'utf8'))[0].job as string;
    cli.kill();
    await draining.killAll(10);
    draining.removeFile();
    assert.equal(fs.existsSync(path.join(dir, 'children-1234.json')), false);
    assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('job-leftovers-')).length, 1, 'a file of its own');
    failing = false;
    const next = new ProcessRegistry(dir, nullLogger);
    next.jobs = jobs;
    await next.sweepOrphans(10);
    assert.deepEqual(ended, [name]);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('job-leftovers-')), [], 'handled, so gone');
  } finally {
    cli.kill();
  }
});

test('shutdown waits for a job still being made, and ends it', async () => {
  let answer!: (s: string) => void;
  const ended: string[] = [];
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  reg.jobs = { assign: () => new Promise((r) => (answer = r)), end: async (n) => void ended.push(n), forget: async () => {} };
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    const l = processInfo(cli.pid!)?.lstart ?? '';
    setTimeout(() => answer(/^\d+$/.test(l) ? l : '1'), 100);
    await reg.killAll(10);
    assert.equal(ended.length, 1);
  } finally {
    cli.kill();
  }
});

// Codex's fourth review.
test("a job's name is saved as soon as it's asked for, so a runner that stops before the helper answers leaves it", async () => {
  const dir = tmpDir();
  const reg = new ProcessRegistry(dir, nullLogger);
  reg.jobs = { assign: () => new Promise(() => {}), end: async () => {}, forget: async () => {} };
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'children.json'), 'utf8')) as { job?: string }[];
    assert.match(saved[0]!.job ?? '', JOB);
  } finally {
    cli.kill();
  }
});

test("a start keeps the leftovers' files when it can't save what's still to do from them", async () => {
  const dir = tmpDir();
  const leftover = path.join(dir, 'job-leftovers-abc.json');
  fs.writeFileSync(leftover, JSON.stringify([{ pid: 999_999_999, command: 'claude', startedAt: '', job: newJobName(), exited: true }]));
  // Its own list can't be written.
  fs.mkdirSync(path.join(dir, 'children.json'));
  const reg = new ProcessRegistry(dir, nullLogger);
  reg.jobs = { assign: async () => '1', end: async () => { throw new Error('the helper exited'); }, forget: async () => {} };
  await reg.sweepOrphans(10);
  assert.ok(fs.existsSync(leftover));
});

test("a draining runner that can't hand on its unended jobs keeps its list, and says so", { skip: process.platform === 'win32' ? 'chmod does nothing to a folder on Windows' : false }, async () => {
  const dir = tmpDir();
  const reg = new ProcessRegistry(dir, nullLogger, 'children-1234.json');
  reg.jobs = { assign: async (pid) => { const l = processInfo(pid)?.lstart ?? ''; return /^\d+$/.test(l) ? l : '1'; }, end: async () => { throw new Error('the helper exited'); }, forget: async () => {} };
  const cli = sleeper();
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    await tick();
    await reg.killAll(10);
    fs.chmodSync(dir, 0o555);
    try {
      assert.equal(reg.removeFile(), false);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
    assert.ok(fs.existsSync(path.join(dir, 'children-1234.json')));
  } finally {
    cli.kill();
  }
});

// Review, 23 Nov 2026: a job's name goes with its last handle, which only
// the helper held. Once the helper had stopped (a question timed out, the
// runner crashed), ending the job by name found nothing, and that counted
// as ended, so the pid fallback was skipped and the CLI, its MCP servers and
// tools went on running. Now the helper says 'missing', and those pids get
// the clean-up a CLI without a job gets, which checks each is still the
// process it was; a job really ended still leaves its pid alone.
function ownGroupSleeper() {
  // Its own process group on a Mac, as the runner starts a CLI, so killing
  // the group reaches only it.
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
}

test("a job the helper can't find any more (it restarted) isn't taken as ended: the next start stops the CLI by pid", async () => {
  const dir = tmpDir();
  const lost = ownGroupSleeper();
  const ended = ownGroupSleeper();
  try {
    const lostName = newJobName();
    const endedName = newJobName();
    const record = (pid: number, job: string) => ({ pid, command: 'node', startedAt: new Date().toISOString(), lstart: processInfo(pid)?.lstart ?? '', job });
    fs.writeFileSync(path.join(dir, 'children.json'), JSON.stringify([record(lost.pid!, lostName), record(ended.pid!, endedName)]));
    const reg = new ProcessRegistry(dir, nullLogger);
    reg.jobs = { assign: async () => '1', end: async (n) => (n === lostName ? 'missing' : 'ended'), forget: async () => {} };
    await reg.sweepOrphans(PATIENCE_MS);
    await until(() => !pidExists(lost.pid!));
    assert.equal(pidExists(lost.pid!), false, 'the CLI whose job had gone is stopped by its pid');
    assert.equal(pidExists(ended.pid!), true, "a job that ended leaves its pid alone (anyone's by now, on Windows)");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'children.json'), 'utf8')), [], 'nothing kept to end again: the name will never come back');
  } finally {
    lost.kill();
    ended.kill();
  }
});

test("at shutdown a CLI whose job can't be found any more is stopped by its pid, and nothing is kept for the next start", async () => {
  const dir = tmpDir();
  const reg = new ProcessRegistry(dir, nullLogger);
  reg.jobs = {
    assign: async (pid) => {
      const l = processInfo(pid)?.lstart ?? '';
      return /^\d+$/.test(l) ? l : '1';
    },
    end: async () => 'missing',
    forget: async () => {},
  };
  const cli = ownGroupSleeper();
  try {
    reg.add(cli.pid!, 'node', 'th1');
    await until(() => !(reg as unknown as { assigning: Set<unknown> }).assigning.size);
    await reg.killAll(PATIENCE_MS);
    await until(() => !pidExists(cli.pid!));
    assert.equal(pidExists(cli.pid!), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'children.json'), 'utf8')), []);
  } finally {
    cli.kill();
  }
});

test("a thread's CLI whose first try at a job fails gets one on the second, and isn't stopped", async () => {
  const calls: string[] = [];
  const reg = new ProcessRegistry(tmpDir(), nullLogger);
  let asked = 0;
  const cli = sleeper();
  const names: string[] = [];
  reg.jobs = { assign: async (_pid, n) => { names.push(n); if (++asked === 1) throw new Error('the helper was stopped'); return '0'; }, end: async (n) => void calls.push(`end ${n}`), forget: async () => void calls.push('forget') };
  reg.killUnjobbed = (pid) => void calls.push(`kill ${pid}`);
  try {
    reg.add(cli.pid!, 'claude', 'th1');
    await tick();
    await tick();
    assert.equal(asked, 2);
    assert.ok(!calls.some((c) => c.startsWith('kill')), 'not stopped');
    // The first try may have taken the CLI before it failed: its job is still the thread's.
    assert.equal(reg.threadOfJob(names[0]!), 'th1');
  } finally {
    reg.remove(cli.pid!);
    cli.kill();
  }
});
