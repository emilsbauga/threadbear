// Windows opens a console window for every console program a process with no
// console starts, and the runner (a logon task) has none: each git, taskkill
// or powershell would flash one up. windowsHide stops that, but it defaults
// to false, and the runner and the CLIs' SDK start hundreds of processes. So
// on Windows this makes it default to true for every spawn, and main.ts
// imports it before anything else. It does nothing elsewhere.

import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

type Fn = (...args: unknown[]) => unknown;

function withHide(fn: Fn, optionsAt: (args: unknown[]) => number): Fn {
  return function (this: unknown, ...args: unknown[]) {
    const at = optionsAt(args);
    const given = args[at];
    if (given !== null && typeof given === 'object' && !Array.isArray(given)) {
      if ((given as { windowsHide?: boolean }).windowsHide === undefined) args[at] = { ...given, windowsHide: true };
    } else if (given === undefined || typeof given === 'function') {
      // the options were left out: put them in front of the callback, if any
      args.splice(at, typeof given === 'function' ? 0 : 1, { windowsHide: true });
    }
    return fn.apply(this, args);
  };
}

// The position of the options argument: after the file or command, and after
// the argument list when there is one.
const afterArgs = (args: unknown[]) => (Array.isArray(args[1]) ? 2 : 1);
const afterCommand = () => 1;

// promisify(execFile) and promisify(exec) resolve with { stdout, stderr } by a
// property on the original function, which still starts its own process, so
// the wrapper gets the same property over itself.
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

export function hideWindows(): void {
  if (process.platform !== 'win32') return;
  const m = cp as unknown as Record<string, Fn>;
  for (const name of ['spawn', 'spawnSync', 'execFileSync', 'fork']) m[name] = withHide(m[name], afterArgs);
  for (const name of ['execFile']) {
    m[name] = withHide(m[name], afterArgs);
    Object.defineProperty(m[name], promisify.custom, { value: promisified(m[name]) });
  }
  m.exec = withHide(m.exec, afterCommand);
  Object.defineProperty(m.exec, promisify.custom, { value: promisified(m.exec) });
  m.execSync = withHide(m.execSync, afterCommand);
  syncBuiltinESMExports();
}

hideWindows();
