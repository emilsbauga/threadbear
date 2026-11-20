// Where the system tools the runner runs by absolute path live, per
// platform. A runner also runs on Linux (INSTALL.md, "A runner on Linux"),
// where macOS's paths aren't there: zsh isn't installed by default, and lsof
// is /usr/bin/lsof on Ubuntu, not /usr/sbin/lsof (handover.ts's lsofPath). A macOS-only path in
// a runner that runs everywhere failed the Linux runners' pre-install tests
// and stopped Hetzner's updating (5 Nov 2026); system-tools.test.ts checks every
// absolute tool path in src/ against a list.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

type Probe = {
  platform?: NodeJS.Platform;
  executable?: (file: string) => boolean;
  env?: NodeJS.ProcessEnv;
  // The value of a registry key's InstallPath (Windows), or undefined.
  registry?: (key: string) => string | undefined;
  // Whether to look afresh rather than use the last answer (tests).
  fresh?: boolean;
};

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Where Git for Windows says it was installed: `reg query` on its key, read
// only, from reg.exe by its full path. HKLM for an install for everyone
// (64 and 32 bit), HKCU for one for the user.
const GIT_KEYS = ['HKLM\\SOFTWARE\\GitForWindows', 'HKCU\\SOFTWARE\\GitForWindows', 'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows'];

export function installPathFromRegistry(key: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const reg = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'reg.exe');
    const out = execFileSync(reg, ['query', key, '/v', 'InstallPath'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return /^\s*InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

function probe(p: Probe): Required<Omit<Probe, 'fresh'>> & { fresh: boolean } {
  const env = p.env ?? process.env;
  // A probe with its own files or environment is a stand-in machine: it
  // has no registry unless it brings one.
  const registry = p.registry ?? (p.executable || p.env ? () => undefined : (key: string) => installPathFromRegistry(key, env));
  return { platform: p.platform ?? process.platform, executable: p.executable ?? isExecutable, env, registry, fresh: p.fresh ?? Object.keys(p).length > 0 };
}

// The last answer gitBash gave the real machine (no probe), kept for half a
// minute: every action, check and land asks, and the registry is a process
// to start.
let lastBash: { at: number; found: string | undefined } | undefined;
const BASH_FOR_MS = 30_000;

// Git for Windows' bash, the one shell on Windows that runs the commands
// written for sh (patch actions, project checks). Claude Code looks for it
// too and takes CLAUDE_CODE_GIT_BASH_PATH. In order: that variable; the
// places Git installs to (Program Files, the user's Programs); the Git
// folder that a git.exe on the PATH sits in (git is in its cmd, bin or
// mingw64\bin folder, bash in its bin and usr\bin), so a Git put anywhere
// and on the PATH is found; and the Git folder its installer recorded in
// the registry. Never a bash.exe found on the PATH by itself (the one in
// System32 is the WSL launcher, which is no use here). Undefined when there
// isn't one: the callers don't fall back to cmd.exe, which would take `-c`
// as nothing and say nothing (plainShell and loginShell).
export function gitBash(p: Probe = {}): string | undefined {
  const q = probe(p);
  if (q.platform !== 'win32') return undefined;
  const real = !q.fresh;
  if (real && lastBash && Date.now() - lastBash.at < BASH_FOR_MS) return lastBash.found;
  const found = findBash(q);
  if (real) lastBash = { at: Date.now(), found };
  return found;
}

function findBash(q: ReturnType<typeof probe>): string | undefined {
  const env = q.env;
  const win = path.win32;
  const inGit = (root: string) => [win.join(root, 'bin', 'bash.exe'), win.join(root, 'usr', 'bin', 'bash.exe')];
  const roots = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], env.LOCALAPPDATA && win.join(env.LOCALAPPDATA, 'Programs')].filter((r): r is string => Boolean(r));
  const tried = new Set<string>();
  const usable = (f: string | undefined): f is string => {
    if (!f || tried.has(f.toLowerCase())) return false;
    tried.add(f.toLowerCase());
    return q.executable(f);
  };
  if (usable(env.CLAUDE_CODE_GIT_BASH_PATH)) return env.CLAUDE_CODE_GIT_BASH_PATH;
  for (const r of roots) for (const f of inGit(win.join(r, 'Git'))) if (usable(f)) return f;
  // A git.exe on the PATH: its folder is cmd or bin of the Git folder, or
  // mingw64\bin (or mingw32, clangarm64) a level further in.
  for (const entry of (env.PATH ?? env.Path ?? '').split(';')) {
    const dir = entry.trim().replace(/^"|"$/g, '');
    if (!dir || !q.executable(win.join(dir, 'git.exe'))) continue;
    const up = win.dirname(dir);
    for (const root of [up, win.dirname(up)]) for (const f of inGit(root)) if (usable(f)) return f;
  }
  for (const key of GIT_KEYS) {
    const root = q.registry(key);
    if (root) for (const f of inGit(root)) if (usable(f)) return f;
  }
  return undefined;
}

// Said when a command needed bash and there isn't one.
export const NO_BASH =
  "Git for Windows (bash) is not installed, so this command can't run. Install it from https://git-scm.com/download/win, or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe, then try again.";

// The notice for a runner on Windows with no bash, for the runner to show
// the way it does a missing claude; undefined when there is one (or off
// Windows).
export function missingBashNotice(p: Probe = {}): string | undefined {
  const q = probe(p);
  return q.platform === 'win32' && !gitBash(p) ? NO_BASH : undefined;
}

// What stands in for the shell when there is no bash: a program that says
// so on its error output and exits 127 ("not found"), whatever it is given.
// A caller starts it as it would the shell (`[bin, flag]`, then the command),
// so it fails the way the command would have, with the reason in its
// output, in place of cmd.exe taking the flag and the command for its own.
function noBash(): string[] {
  return [process.execPath, '-e', `process.stderr.write(${JSON.stringify(NO_BASH + '\n')}); process.exit(127);`, '--'];
}

// A shell for a one-off command (a project's check, a connectors headers
// helper): sh -c where there is an sh, Git Bash on Windows.
export function plainShell(p: Probe = {}): string[] {
  const q = probe(p);
  if (q.platform === 'win32') {
    const bash = gitBash(p);
    return bash ? [bash, '-c'] : noBash();
  }
  return ['/bin/sh', '-c'];
}

// The login shell command actions and patch panels run in, so PATH, nvm
// and the like apply as in a terminal. zsh on a Mac (its default since
// Catalina). On Linux, the user's own $SHELL if it's a POSIX-style one
// that's there (commands are written for sh, so not fish or csh), else
// bash, else sh: zsh isn't something a Linux runner can count on.
export function loginShell(p: Probe = {}): string[] {
  const q = probe(p);
  if (q.platform === 'win32') {
    const bash = gitBash(p);
    return bash ? [bash, '-lc'] : noBash();
  }
  if (q.platform === 'darwin') return ['/bin/zsh', '-lc'];
  const own = q.env.SHELL;
  const posix = own && path.isAbsolute(own) && ['bash', 'zsh', 'sh', 'dash', 'ksh'].includes(path.basename(own));
  const candidates = [...(posix ? [own] : []), '/bin/bash', '/usr/bin/bash'];
  for (const f of candidates) if (q.executable(f)) return [f, '-lc'];
  return ['/bin/sh', '-lc'];
}
