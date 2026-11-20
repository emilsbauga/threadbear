// What differs on Windows, in one place (docs/gpui-port/runner-windows-plan.md).
// The rest of src/ asks this file rather than testing process.platform
// itself, so the Windows branches are easy to find and to test. Started
// from Keith's (platima) Windows port, with the data folder moved out of
// Roaming.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Probe = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string };

export const IS_WINDOWS = process.platform === 'win32';

// Windows, for now: a project's patch trusted by its hash, and a folder's
// Claude Code settings, run nothing by themselves (hooks, worktree setup
// and teardown, a live function's commands, Claude's hooks). Only a
// patch's buttons run, when they're clicked. Following a script there
// still has gaps a repo written to get round it could use: each of four
// reviews found about six more ways to run a program the hash didn't
// cover (Mike, 19 Nov 2026). THREADBEAR_CLICKS_ONLY=1 turns it on
// anywhere, and =0 off, both for tests: the unit tests turn it off
// (test/helpers/clean-env.ts), as most check what the follow lets run once
// this goes, and clicks-only.test.ts turns it on. The runner's own
// variables are set by its Scheduled Task, which no thread can change.
// Read once, as this loads, before any patch's code runs in the runner's
// process: one that set process.env later would otherwise turn the rule
// off (Codex's review, 19 Nov).
const CLICKS_ONLY_SET = process.env.THREADBEAR_CLICKS_ONLY;
export function clicksOnly(env?: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): boolean {
  const set = env ? env.THREADBEAR_CLICKS_ONLY : CLICKS_ONLY_SET;
  return set === '1' || (platform === 'win32' && set !== '0');
}

export const CLICKS_ONLY_NOTE = "On Windows, a project's hooks, setup and live commands don't run by themselves for now. Its buttons still run when you click them.";

// %LOCALAPPDATA%, or where Windows puts it when the variable is missing. A
// home other than this user's (a test's temp folder) gets its own, so a
// test can never reach the real data dir through the variable.
function localAppData(p: Probe): string {
  const home = p.home ?? os.homedir();
  const env = p.env ?? (home === os.homedir() ? process.env : {});
  return env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
}

// The data dir. macOS and Linux keep ~/Library/Application Support/Threadbear
// (docs/protocol.md). Windows uses %LOCALAPPDATA%\Threadbear, not Roaming:
// a roaming profile copies Roaming to a server at every sign-out, and the
// data dir holds every transcript (the 9 Nov audit). The GPUI app's
// default_home (desktop/client/src/config.rs) has to say the same.
export function dataDirFor(p: Probe = {}): string {
  if ((p.platform ?? process.platform) === 'win32') return path.win32.join(localAppData(p), 'Threadbear');
  return path.posix.join(p.home ?? os.homedir(), 'Library', 'Application Support', 'Threadbear');
}

// Where the runner writes its log: ~/Library/Logs on a Mac (and Linux, which
// kept the Mac's names), the data dir's Logs folder on Windows.
export function logFileFor(p: Probe = {}): string {
  if ((p.platform ?? process.platform) === 'win32') return path.win32.join(localAppData(p), 'Threadbear', 'Logs', 'threadbear-runner.log');
  return path.posix.join(p.home ?? os.homedir(), 'Library', 'Logs', 'threadbear-runner.log');
}

// The name of a program file: claude.exe on Windows, claude elsewhere.
export function exeName(name: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${name}.exe` : name;
}

// A path's real form, the one to compare two paths by. On macOS and Linux
// that is fs.realpathSync, exactly as before. On Windows it is the native
// one (GetFinalPathNameByHandle): the JS one resolves links but leaves the
// 8.3 short names (C:\Users\RUNNER~1, which is how GitHub's runners spell
// TEMP, and how any profile folder longer than eight characters can turn
// up in a cwd) and the case as they were given, while git and the files
// Windows hands back use the long form, so two spellings of one folder
// compared as two. Throws when the path isn't there, as realpathSync does.
type RealProbe = { platform?: NodeJS.Platform; native?: (p: string) => string; plain?: (p: string) => string };

export function realPathSync(p: string, q: RealProbe = {}): string {
  if ((q.platform ?? process.platform) === 'win32') return (q.native ?? fs.realpathSync.native)(p);
  return (q.plain ?? fs.realpathSync)(p);
}

// The same, without throwing. When the path isn't there, macOS and Linux
// give it back as it was; Windows makes its nearest folder that is there
// real and keeps the rest, so a path to a file about to be made still
// compares with the folder it will be in.
export function realPath(p: string, q: RealProbe = {}): string {
  try {
    return realPathSync(p, q);
  } catch {
    // not there, or not readable
  }
  const platform = q.platform ?? process.platform;
  if (platform !== 'win32') return p;
  const P = path.win32;
  let rest = '';
  for (let d = p; ; ) {
    const up = P.dirname(d);
    if (up === d) return p;
    rest = rest ? P.join(P.basename(d), rest) : P.basename(d);
    d = up;
    try {
      return P.join(realPathSync(d, q), rest);
    } catch {
      // one folder up
    }
  }
}

// core.hooksPath for git that must run no hook. /dev/null on a Mac and
// Linux. Windows has no /dev/null folder, and what Git for Windows makes of
// /dev/null/<hook> is down to its own path handling (the 9 Nov audit feared
// C:\dev\null, which any account on the PC can make; a hook planted there
// didn't run on GitHub's Windows machines, 18 Nov 2026). So rather than rely
// on that, it's a file of Windows' own that only TrustedInstaller can
// change: git looks for <file>\<hook> and <hook>.exe, which can't exist.
// Hooks named in config (hook.<name>.command) are a separate matter:
// safe-git.ts turns those off by name.
export function noHooksPath(p: Probe = {}): string {
  if ((p.platform ?? process.platform) !== 'win32') return '/dev/null';
  const env = p.env ?? process.env;
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'ntdll.dll');
}

// A path with forward slashes whatever the platform, for text a person reads
// (messages name files as ./tools/x.sh) and for words a shell takes. It
// changes nothing on macOS and Linux, where path.sep is already /.
export function slashes(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
}

// Whether the runner may open a path that an agent's text or tool call
// named (a Markdown picture, a pinned file). Off Windows any path may be. On
// Windows not one that starts with two separators: `//host/share/x.png`,
// `\\host\share\x.png`, `\\?\UNC\host\share\x.png` and
// `file:////host/share/x.png` all make Windows open a connection to a host
// the text picked, and send the user's NTLM sign-in to it (`\\?\C:\x.png` and
// `\\.\pipe\x` are device names, which aren't a picture's either). Nor one
// that names a device in a folder (`C:\x\CON.png` opens the console, and a
// read of it waits for ever). A drive letter's path, and one rooted on the
// current drive (`\x\a.png`), are the user's own.
export function isLocalPath(p: string, windows: boolean = IS_WINDOWS): boolean {
  if (!windows) return true;
  if (/^[\\/]{2}/.test(p)) return false;
  return !p.split(/[\\/]/).some((part) => /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\.|:|$)/i.test(part));
}

// npm beside a Node: its `npm` link elsewhere, and on Windows its script,
// npm-cli.js, as the npm.cmd there can't be started without a shell. A
// caller runs a .js path on Node (runOnNode).
export function npmBeside(execPath: string, platform: NodeJS.Platform = process.platform): string {
  const P = platform === 'win32' ? path.win32 : path.posix;
  return platform === 'win32' ? P.join(P.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js') : P.join(P.dirname(execPath), 'npm');
}

// What to spawn for a program path: a .js script runs on this Node.
export function runOnNode(file: string, args: string[], execPath: string = process.execPath): [string, string[]] {
  return /\.[cm]?js$/i.test(file) ? [execPath, [file, ...args]] : [file, args];
}

// The npm-installed codex beside a Node: its `codex` link elsewhere, and
// on Windows the package's codex.js (npm's codex.cmd there can't be
// started without a shell; resolveCodexBinary finds codex.exe behind it).
export function codexBeside(execPath: string, platform: NodeJS.Platform = process.platform): string {
  const P = platform === 'win32' ? path.win32 : path.posix;
  return platform === 'win32' ? P.join(P.dirname(execPath), 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : P.join(P.dirname(execPath), 'codex');
}
