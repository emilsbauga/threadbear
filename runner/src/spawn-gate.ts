// Box mode's one gate on starting processes (Codex's seventh review of
// slice 3). While a stopping save holds the box (box-save.ts SaveHold),
// nothing in the runner may start a process that could change the thread's
// folder behind the save's copy: not a patch's live command, a hook, an
// action, a worktree's setup or teardown, git for the repo, the CLI, or
// anything a library starts. Rather than fence each of those, the gate is
// on node:child_process itself: in box mode every function it exports that
// starts a process is replaced by one that refuses while the gate is
// closed, and syncBuiltinESMExports() makes every module's import of them
// (the runner's and its libraries') see the replacement. The save's own
// git and packing run inside asSave(), which lets them by.
//
// Never on a normal runner: main.ts installs it only in box mode.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promisify } from 'node:util';

// Every function node:child_process has that starts a process (its other
// two, ChildProcess and _forkChild, don't: ChildProcess.prototype.spawn,
// which does, is gated below). A test (spawn-gate.test.ts) checks this is
// all of them, and that nothing in runner/src starts one another way.
export const SPAWNERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;

let closed: string | undefined;
let installed = false;
const save = new AsyncLocalStorage<true>();

export class SpawnRefused extends Error {}

function check(name: string): void {
  if (closed !== undefined && save.getStore() !== true) throw new SpawnRefused(`Not starting a process (${name}): ${closed}`);
}

type Fn = (...args: unknown[]) => unknown;
function promisified(fn: Fn): Fn {
  return (...args: unknown[]) => {
    let child: unknown;
    const p = new Promise((resolve, reject) => {
      child = fn(...args, (err: Error | null, stdout: unknown, stderr: unknown) => {
        if (err) reject(Object.assign(err, { stdout, stderr }));
        else resolve({ stdout, stderr });
      });
    }) as Promise<unknown> & { child?: unknown };
    p.child = child;
    return p;
  };
}

export function installSpawnGate(): void {
  if (installed) return;
  installed = true;
  const m = cp as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of SPAWNERS) {
    const real = m[name]!;
    m[name] = function gated(this: unknown, ...args: unknown[]) {
      check(name);
      return real.apply(this, args);
    };
  }
  // promisify(execFile) and promisify(exec) resolve with { stdout, stderr }
  // (and carry .child, and the error's stdout and stderr) by a property on
  // the function, which the replacement must have too, going through the
  // gate (as win32-hide.ts does for its own).
  for (const name of ['exec', 'execFile'] as const) Object.defineProperty(m[name], promisify.custom, { value: promisified(m[name]!), configurable: true });
  // And the class every async start goes through, however it's reached
  // (exec, execFile and fork call the module's own spawn, not the export).
  const proto = cp.ChildProcess.prototype as unknown as { spawn: (...a: unknown[]) => unknown };
  const realSpawn = proto.spawn;
  proto.spawn = function gated(this: unknown, ...args: unknown[]) {
    check('ChildProcess.spawn');
    return realSpawn.apply(this, args);
  };
  syncBuiltinESMExports();
}

// While closed, every process start is refused, saying `why`, but the save's own.
// Whether the gate is on (box mode): the trust worker (trust-off-thread.ts)
// won't start then, as a worker thread's processes would get round it.
export function spawnGateInstalled(): boolean {
  return installed;
}

export function closeSpawns(why: string): void {
  closed = why;
}

export function openSpawns(): void {
  closed = undefined;
}

export function spawnsClosed(): boolean {
  return closed !== undefined;
}

// The save's own git and packing: let by while the gate is closed, through
// every await inside `fn` (and nothing started outside it).
export function asSave<T>(fn: () => Promise<T>): Promise<T> {
  return save.run(true, fn);
}
