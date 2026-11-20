// `tb land` runs its landing in a process of its own, and the tb you ran only
// follows its output (docs/thread-worktrees.md, "A landing outlives its tb").
//
// On 18 Nov a tb land waited 1 h 55 min in the line, took the lock and
// started the group check for nine branches, and a few minutes in the agent's
// two-hour tool limit killed it: the check was lost for all nine, and the
// next holder started again without it. The group's check runs in the
// holder's tb, so whatever stops that tb stopped everyone's landing.
//
// So the landing runs in a worker started through a shell that exits at once:
// the worker belongs to no one's process group or tree, so a time limit
// killing the tb you ran (and everything under it) never reaches it. The
// follower copies its output through and exits with its exit code.
//
// Stopped while the worker is still waiting for the lock, the follower passes
// the signal on, and the worker leaves the line and says so, as before: a
// landing stopped while it waits may have been stopped on purpose, and nobody
// would hear how it went. Once the worker holds the lock, its check and the
// fast-forward (and push) finish whatever happens to the follower, which says
// so and where the output goes. A worker whose follower vanished without a
// signal (SIGKILL) notices within a second and does the same as if it had
// been passed one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WORKER_ENV = 'THREADBEAR_LAND_WORKER';
const FOLLOWER_ENV = 'THREADBEAR_LAND_FOLLOWER';
const SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

// Windows has no /bin/sh to start it from; there tb land stays as it was.
export const detachable = (): boolean => process.platform !== 'win32';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Copies what's been added to `file` since `from` to `to`; returns the new end.
function pump(file: string, from: number, to: NodeJS.WriteStream): number {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return from;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    let at = from;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, at);
      if (n <= 0) break;
      // A copy: a write to a slow pipe is still pending when buf is read into again.
      to.write(Buffer.from(buf.subarray(0, n)));
      at += n;
    }
    return at;
  } finally {
    fs.closeSync(fd);
  }
}

// The follower: the tb that was run. `argv` is tb's own arguments.
export async function landInBackground(argv: string[], pollMs = 200): Promise<number> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-land-'));
  const files = { out: path.join(dir, 'out'), err: path.join(dir, 'err'), exit: path.join(dir, 'exit'), locked: path.join(dir, 'locked') };
  const env = { ...process.env, [WORKER_ENV]: dir, [FOLLOWER_ENV]: String(process.pid) };
  // A session of its own (detached), then left behind by the shell, so it's
  // nobody's child and in nobody's process group.
  const sh = spawn('/bin/sh', ['-c', '"$0" "$@" >"$THREADBEAR_LAND_WORKER/out" 2>"$THREADBEAR_LAND_WORKER/err" </dev/null & echo $!',
    process.execPath, ...process.execArgv, process.argv[1], ...argv], { env, cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let said = '';
  sh.stdout.on('data', (d) => (said += d));
  const shCode = await new Promise<number | null>((resolve) => {
    sh.once('error', () => resolve(-1));
    sh.once('close', (code) => resolve(code));
  });
  const pid = Number(said.trim());
  if (shCode !== 0 || !Number.isInteger(pid) || pid <= 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    process.stderr.write(`Couldn't start the landing in a process of its own (${shCode}).\n`);
    return 1;
  }

  let at = { out: 0, err: 0 };
  const drain = (): void => {
    at = { out: pump(files.out, at.out, process.stdout), err: pump(files.err, at.err, process.stderr) };
  };
  let stopping: NodeJS.Signals | undefined;
  const carryOn = (signal: NodeJS.Signals): never => {
    drain();
    process.stderr.write(`tb land was stopped (${signal}) during its check, which carries on in a process of its own (pid ${pid}) and lands what passes. Its output goes on in ${dir} (out and err). A tb land run again in this worktree waits for it, then says what landed.\n`);
    process.exit(128 + (os.constants.signals[signal] ?? 15));
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (fs.existsSync(files.locked)) carryOn(signal);
    if (stopping) return;
    stopping = signal;
    try {
      process.kill(pid, signal);
    } catch {
      // Gone already: the loop sees it.
    }
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  try {
    for (;;) {
      drain();
      if (fs.existsSync(files.exit) || !alive(pid)) break;
      // Passed on just as it took the lock: it carries on, and says so.
      if (stopping && fs.existsSync(files.locked)) carryOn(stopping);
      await new Promise((r) => setTimeout(r, pollMs));
    }
    drain();
    let code = 1;
    try {
      const said = fs.readFileSync(files.exit, 'utf8').trim();
      code = said === '' ? 1 : Number(said);
    } catch {
      // Stopped by the signal passed on before it was listening for one
      // (still rebasing, say): nothing landed, as before.
      if (stopping) code = 128 + (os.constants.signals[stopping] ?? 15);
      else process.stderr.write(`The landing's process (pid ${pid}) ended without saying how it went.\n`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return Number.isInteger(code) ? code : 1;
  } finally {
    for (const s of SIGNALS) process.removeListener(s, onSignal);
  }
}

// The worker's side, or undefined when this tb wasn't started as one.
// `onLocked` is called once it holds the landing lock: from then on nothing
// stops it but the landing's own end. False if its follower went in the
// second since it last looked (Codex's review): it stops before checking.
export function landWorker(): { onLocked: () => boolean } | undefined {
  const dir = process.env[WORKER_ENV];
  if (!dir || !detachable()) return undefined;
  const follower = Number(process.env[FOLLOWER_ENV]);
  // Not for a tb the check itself runs.
  delete process.env[WORKER_ENV];
  delete process.env[FOLLOWER_ENV];
  process.on('exit', (code) => {
    try {
      // Whole or not at all: the follower stops as soon as it's there.
      const tmp = path.join(dir, `exit.${process.pid}.tmp`);
      fs.writeFileSync(tmp, String(code));
      fs.renameSync(tmp, path.join(dir, 'exit'));
    } catch {
      // The follower then says it ended without saying.
    }
  });
  // Its follower gone without passing a signal on (SIGKILL): as if it had.
  const watch = setInterval(() => {
    if (Number.isInteger(follower) && follower > 0 && !alive(follower)) {
      clearInterval(watch);
      process.kill(process.pid, 'SIGHUP');
    }
  }, 1000);
  watch.unref();
  return {
    onLocked: () => {
      clearInterval(watch);
      if (Number.isInteger(follower) && follower > 0 && !alive(follower)) return false;
      for (const s of SIGNALS) process.on(s, () => { /* the check carries on */ });
      try {
        fs.writeFileSync(path.join(dir, 'locked'), '');
      } catch {
        // The follower then passes a stop on, which is ignored, and waits.
      }
      return true;
    },
  };
}
