// What the tests need to know about the platform they run on, in one place:
// a shell, stand-ins for the claude and codex programs that run anywhere,
// a shell command that waits, and the skip reasons for what Windows
// doesn't have (docs/windows-port-plan.md).
import { execFileSync } from 'node:child_process';
import { test as nodeTest } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { plainShell } from '../../src/system-tools.ts';

export const IS_WINDOWS = process.platform === 'win32';

// A `skip` option for node:test: the reason on Windows, false elsewhere.
export function skipOnWindows(reason: string): { skip: string | false } {
  return { skip: IS_WINDOWS ? reason : false };
}

// The other way round, for a test of something only Windows has.
export function onlyOnWindows(reason: string): { skip: string | false } {
  return { skip: IS_WINDOWS ? false : reason };
}

// Codex itself runs on Windows when a codex.exe is on the PATH (config.ts). What
// doesn't is Threadbear's own copy of it: made with npm, switched by a symlink,
// and off by default there.
export const NO_CODEX_COPIES_ON_WINDOWS = skipOnWindows("Threadbear's own copies of Codex (npm installs, a current symlink, ps) are off by default on Windows, and these tests fake them with shell scripts");
export const NO_SIGNALS_ON_WINDOWS = skipOnWindows('Windows has no process groups, and the only signal it has is a hard kill');
export const NO_LINKS_ON_WINDOWS = skipOnWindows("The current release link is a symlink swapped in place, which isn't ported to Windows yet");

// The shell the product runs project commands in: /bin/sh -c on macOS and
// Linux, Git Bash on Windows. `shell[0]` is the program, `shell[1]` the flag.
export const SHELL: string[] = plainShell();

// A path the way sh and git understand it. Git Bash reads D:\x\y as an
// escape-ridden word, so commands that name a path use forward slashes.
export function shPath(p: string): string {
  return IS_WINDOWS ? p.replace(/\\/g, '/') : p;
}

// Runs a command line in the shell, returning its trimmed output.
export function sh(cwd: string, cmd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(SHELL[0], [SHELL[1], cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env ?? process.env }).trim();
}

// A program standing in for a command-line tool (claude, codex, a helper):
// the body is a Node module that runs with the arguments after the script's
// own. Returns the path to a single executable file that runs it, a shell
// script on macOS and Linux and a .cmd on Windows, so code that wants one
// path to spawn (the way it does for the real programs) gets one.
// `env` adds fixed variables to every run.
export function fakeProgram(dir: string, name: string, body: string, env: Record<string, string> = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(script, body);
  if (IS_WINDOWS) {
    const cmd = path.join(dir, `${name}.cmd`);
    const sets = Object.entries(env).map(([k, v]) => `set "${k}=${v}"\r\n`).join('');
    fs.writeFileSync(cmd, `@echo off\r\n${sets}"${process.execPath}" "${script}" %*\r\n`);
    return cmd;
  }
  const file = path.join(dir, name);
  const sets = Object.entries(env).map(([k, v]) => `${k}='${v.replace(/'/g, "'\\''")}' `).join('');
  fs.writeFileSync(file, `#!/bin/sh\nexec env ${sets}'${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  return file;
}

// A string as a regular expression's literal text, for a pattern that holds a
// path (Windows paths are full of backslashes).
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Node won't start a .cmd file directly (spawn EINVAL), and the product starts
// the real programs directly, so a test that passes a stand-in to code built
// on execFile hands it through here: cmd.exe runs the .cmd, anything else goes
// through as it is.
export function cmdAware<A extends unknown[], R>(run: (file: string, args: string[], ...rest: A) => R): (file: string, args: string[], ...rest: A) => R {
  return (file, args, ...rest) => (IS_WINDOWS && /\.cmd$/i.test(file) ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', file, ...args], ...rest) : run(file, args, ...rest));
}

// A shell command that waits for the given seconds. Git Bash's own sleep is
// an MSYS program, which `taskkill /T` doesn't reach from the shell above it
// (it ends up an orphan holding the output open), so on Windows a node child
// does the waiting: that is a native process and the tree kill gets it.
export function sleepCommand(seconds: number): string {
  return IS_WINDOWS ? `"${shPath(process.execPath)}" -e "setTimeout(() => {}, ${seconds * 1000})"` : `sleep ${seconds}`;
}

// `test` for a file whose subject isn't there on Windows: every test in it
// is skipped there, with the reason, and runs as before everywhere else.
// Use it in place of the import from node:test.
export function testSkippedOnWindows(reason: string): typeof nodeTest {
  const wrapped = (name: string, a?: unknown, b?: unknown) => {
    const [opts, fn] = typeof a === 'function' ? [{}, a] : [(a ?? {}) as Record<string, unknown>, b];
    return nodeTest(name, { ...opts, ...(IS_WINDOWS && !opts.skip ? { skip: reason } : {}) }, fn as never);
  };
  return wrapped as unknown as typeof nodeTest;
}
export const macOnlyTest = testSkippedOnWindows('A Mac-only feature, off on Windows');

// The environment with every folder that holds powershell.exe taken off PATH,
// so on Windows the runner's start-time probe (proc.ts) fails the way it does
// when policy or a timeout stops PowerShell. Elsewhere it is the environment
// as it is.
export function withoutPowerShell(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!IS_WINDOWS) return { ...env };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const kept = (env[key] ?? '')
    .split(path.delimiter)
    .filter((dir) => dir && !fs.existsSync(path.join(dir, 'powershell.exe')) && !fs.existsSync(path.join(dir, 'pwsh.exe')));
  // The runner runs PowerShell by its full path (win32-helper.ts), so the PATH alone doesn't hide it.
  return { ...env, [key]: kept.join(path.delimiter), THREADBEAR_NO_POWERSHELL: '1' };
}
