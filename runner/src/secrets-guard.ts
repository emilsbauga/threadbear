// Keeps a thread that isn't on Full access from reading the runner's secrets
// with Claude's own tools (docs/protocol.md, "Who's really calling"). Defence in
// depth behind the RPC's own check of the caller's process: a shell that's
// allowed to run anything can spell a path in ways no pattern will see, and
// SECURITY.md says so. A Full access thread can already run anything as you,
// so it isn't checked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REASON = "The runner's secrets aren't readable from a thread without Full access. tb in this thread already works with its own key.";

const GREP_REASON = "This search's folder holds the runner's secrets, which aren't readable from a thread without Full access. Search a folder further in instead.";

const SHARE_REASON = "A network path (\\\\host\\share) can name this PC's own folders, the runner's secrets among them, so a thread without Full access can't use one with Claude's file tools. If it needs files on a share, ask for Full access.";

const PATH_KEYS = ['file_path', 'path', 'notebook_path'] as const;

function expand(p: string): string {
  return p === '~' || p.startsWith('~/') || (path.sep === '\\' && p.startsWith('~\\')) ? path.join(os.homedir(), p.slice(1)) : p;
}

// The deepest part of a path that exists, with links followed, and the rest
// on the end: a Read of secrets/runner-token through a link in the path is
// that file.
function resolved(p: string, cwd?: string): string {
  let head = path.resolve(cwd ?? process.cwd(), expand(p));
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail);
    } catch {
      const up = path.dirname(head);
      if (up === head) return path.join(head, ...tail);
      tail.unshift(path.basename(head));
      head = up;
    }
  }
}

// A path as Windows opens it. A name's stream (secrets::$INDEX_ALLOCATION is
// the folder itself, runner-token::$DATA the file) and dots or spaces on its
// end (secrets.) are dropped, a \\?\ or \\.\ prefix names the path after
// it, and a share of this machine's own drive (\\localhost\c$\...) is
// that drive. Elsewhere a path is as written: a colon or a dot on the end is
// part of a Mac or Linux name.
function plain(p: string): string {
  if (path.sep !== '\\') return p;
  const local = p
    .replace(/^\\\\[?.]\\unc\\/i, '\\\\')
    // Only before a drive: \\?\GLOBALROOT\... and \\.\HarddiskVolume3\...
    // stay as they are, which no folder of a drive's starts with.
    .replace(/^\\\\[?.]\\(?=[a-z]:)/i, '')
    .replace(new RegExp(`^\\\\\\\\(?:localhost|127\\.\\d+\\.\\d+\\.\\d+|\\[?::1\\]?|${os.hostname().replace(/[^\w-]/g, '') || 'localhost'})\\\\([a-z])\\$(?=\\\\|$)`, 'i'), '$1:');
  return local
    .split('\\')
    .map((s, i) => (i === 0 || s === '.' || s === '..' ? s : s.replace(/:.*$/, '').replace(/[. ]+$/, '') || s))
    .join('\\');
}

// Paths and commands are compared without regard to case: APFS as it's usually
// made (and NTFS) opens the same folder whatever the letters. Where the file
// system tells them apart, a folder of the same name in other letters is
// refused too, which nothing has a reason to read.
// Unicode is folded to one form first too: APFS opens "é" whether it's written
// as one character or as "e" and an accent (cross-lab review, 11 Nov 2026).
const fold = (s: string) => s.normalize('NFC').toLowerCase();
const same = (a: string, b: string) => fold(plain(a)) === fold(plain(b));
const inside = (p: string, dir: string) => {
  const [low, root] = [fold(plain(p)), fold(plain(dir))];
  // `/` already ends in the separator: `//` would never match.
  return low === root || low.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
};

// A path or a command as it's compared: forward slashes, folded (see `fold`).
const slashed = (s: string) => fold(s.replace(/\\/g, '/'));

// A Windows path as Git Bash writes it: C:\Users\me as /c/Users/me.
function gitBashForm(p: string): string[] {
  const m = /^([a-z]):[\\/](.*)$/i.exec(p);
  return m ? [`/${m[1]}/${m[2]}`] : [];
}

// The ways one command can be read, for the patterns to look at. A shell
// drops its quotes and the backslashes before other characters (bash), but on
// Windows a backslash is the separator (C:\Users\me\secrets), so it's read
// with them kept and as forward slashes too. PowerShell's escape is a
// backtick and cmd's a caret, so it's read without those as well. A share of
// this machine's own drive (\\localhost\c$\...) and a \\?\ or \\.\
// prefix name the drive's own path (Keith's fork, 10 Nov 2026).
function commandSpellings(command: string): string[] {
  const unquoted = command.replace(/["']/g, '');
  const hosts = ['localhost', '127\\.\\d+\\.\\d+\\.\\d+', '\\[?::1\\]?', os.hostname().replace(/[^\w-]/g, '') || 'localhost'].join('|');
  const share = new RegExp(`[\\\\/]{2}(?:[?.][\\\\/]unc[\\\\/])?(?:${hosts})[\\\\/]([a-z])\\$[\\\\/]`, 'gi');
  const local = (s: string) => s.replace(share, '$1:/').replace(/[\\/]{2}[?.][\\/]/g, '');
  const escapes = unquoted.replace(/[`^]/g, '');
  // Most commands read the same every way, so each reading is looked at once.
  return [...new Set([command.replace(/\\(.)/g, '$1').replace(/["']/g, ''), unquoted, escapes, local(escapes)].flatMap((c) => [c, c.replace(/\\/g, '/')]))];
}

// The reason a call is denied, or undefined if it's fine. `home` is the
// runner's data dir.
export function denySecrets(tool: string, input: Record<string, unknown>, home: string, cwd?: string): string | undefined {
  const secrets = path.join(home, 'secrets');
  // Claude on Windows can have a PowerShell tool as well as Bash; the runner
  // turns it off (adapter.ts), and if one gets through it's checked the same.
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = typeof input.command === 'string' ? input.command : '';
    const readings = commandSpellings(command);
    for (const c of readings) {
      // The token file's name first, before anything below folds a letter:
      // NFC and lower-casing both turn the Kelvin sign (K, U+212A) into a K,
      // and `runner-tokenK` (which a shell's ${x%K} cuts back to the file's
      // name) lost its word boundary that way (cross-lab review, 11 Nov 2026).
      if (/\brunner-token\b/i.test(c)) return REASON;
    }
    // Then the ways a shell writes the same folder: `/./` and `//`, an accent
    // as one character or two, and in any letters (see `same`). Checked as
    // written and also with `${X:-y}` or `${X%y}` read as `${X}`, which names
    // the same folder whenever X is set; as written too, as the fallback can
    // hold the path itself (`${X:-$THREADBEAR_HOME/secrets/...}`). The
    // modifier can hold a `$` (`${THREADBEAR_HOME:-$HOME}`) and is bounded,
    // so the match stays linear; a longer one gets past, as any spelling a
    // pattern doesn't know does. Each is checked without NFC as well, as NFC
    // can join an accent onto the s of secrets that the shell then cuts off
    // (`${p%<accent>}`, the third pass).
    const tidy = (c: string) => c.replace(/\/(?:\.\/)+/g, '/').replace(/\/{2,}/g, '/');
    const spellings = readings
      .flatMap((c) => [c, c.replace(/\$\{(\w+)(?!\w)[^}\n]{0,300}\}/g, '${$1}')])
      .flatMap((c) => [tidy(c).toLowerCase(), fold(tidy(c))])
      .filter((c, i, all) => all.indexOf(c) === i);
    const home2 = os.homedir();
    // The variables every thread is given for the data dir (threadEnv in
    // restart.ts), the old names too, as each shell writes them: bash's $X
    // and ${X}, PowerShell's $env:X, ${env:X} and $($env:X), and cmd's %X%
    // and !X!.
    const given = ['THREADBEAR_HOME', 'THREADBEAR_RUNNER_HOME', 'THREADBARE_HOME', 'THREADBARE_RUNNER_HOME'].flatMap((v) => [`$${v}`, `\${${v}}`, `$env:${v}`, `\${env:${v}}`, `$($env:${v})`, `%${v}%`, `!${v}!`]);
    // The data dir as a path, as written: its own spelling, from the home
    // folder (~, $HOME, ${HOME}), and on Windows as Git Bash writes a drive
    // (/c/Users/...).
    const asPaths = (p: string) => [p, p.replace(home2, '~'), p.replace(home2, '$HOME'), p.replace(home2, '${HOME}'), ...gitBashForm(p)];
    const forms = [
      ...asPaths(secrets),
      ...given.map((v) => `${v}/secrets`),
      // Its usual name, under any folder: on a Mac, Application Support; on
      // Windows, %LOCALAPPDATA% (and %APPDATA%, where Keith's fork kept it).
      'Threadbear/secrets',
    ].map(slashed);
    if (spellings.some((c) => forms.some((f) => c.includes(f)))) return REASON;
    // Those variables in any other syntax: PowerShell's $($env:X), cmd's
    // delayed !X!, [Environment]::GetEnvironmentVariable('X'). The name, then
    // only punctuation, then the folder (Codex's review, 18 Nov 2026).
    const varThen = /\b(?:threadbear|threadbare)_(?:runner_)?home\W{0,40}?\/(?:secrets\b|\S*[*?[])/;
    if (spellings.some((c) => varThen.test(c))) return REASON;
    // A name Windows made for a long one (8.3): Threadbear is THREAD~1 and
    // runner-token RUNNER~1, so a command can name `THREAD~1\secrets\RUNNER~1`
    // without either word (Keith's fork, 10 Nov 2026). A data folder's short
    // name counts before its secrets folder (or a wildcard) wherever it is:
    // THREAD~1, or the short form of the data folder's own name when it's
    // somewhere else (D:\TB-Data is TBDATA~1; Codex's review). RUNNER~1
    // counts in a secrets folder, or run from inside one, as runner~1 is
    // Git's revision syntax too (git diff runner~1 -- secrets.ts).
    // Windows' rule: spaces and dots dropped, +,;=[] as _, the first six.
    // The stem is from the name before its last dot (D:\\TB.data is
    // TB~1.DAT, Codex's fourth review).
    const base = path.basename(home).toLowerCase();
    const dot = base.lastIndexOf('.');
    const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[\s.]/g, '').replace(/[+,;=[\]]/g, '_').slice(0, 6);
    const names = ['thread', ...(stem && stem !== 'thread' ? [stem.replace(/[^\w]/g, '\\$&')] : [])].join('|');
    // With the first three letters after the last dot as its extension
    // (D:\\Threadbear.data is THREAD~1.DAT, Codex's third review).
    const short = new RegExp(`(?:^|/)(?:${names})~\\d+(?:\\.[^/\\s.]{1,3})?/(?:secrets\\b|secret~\\d|\\S*[*?[])`);
    const inSecrets = cwd !== undefined && inside(resolved(cwd), resolved(secrets));
    const token = inSecrets ? /(?:^|[\s/=])runner~\d/ : /(?:^|[\s/=])(?:secrets|secret~\d+)\/runner~\d/;
    if (spellings.some((c) => short.test(c) || token.test(c))) return REASON;
    const wild = /[*?[]/.test(command);
    // The data dir named with a wildcard after it reaches the same files
    // without those words (secr*/*).
    const dataDir = [...asPaths(home), ...given, 'Application Support/Threadbear', 'AppData/Local/Threadbear', 'AppData/Roaming/Threadbear', '%LOCALAPPDATA%/Threadbear', '$env:LOCALAPPDATA/Threadbear', '%APPDATA%/Threadbear', '$env:APPDATA/Threadbear'].map(slashed);
    if (wild && spellings.some((c) => dataDir.some((d) => c.includes(d)))) return REASON;
    return undefined;
  }
  const target = resolved(secrets);
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v !== 'string' || !v) continue;
    const written = path.resolve(cwd ?? process.cwd(), expand(v));
    // A share as written is refused before anything looks it up: resolving
    // \\\\192.168.1.77\\... waited on the network for seconds (CI, 18 Nov).
    if (path.sep === '\\' && plain(written).startsWith('\\\\')) return SHARE_REASON;
    const real = resolved(v, cwd);
    if (inside(real, target) || inside(written, secrets)) return REASON;
    // On Windows, a share (\\host\share\...) can be any folder of this PC's
    // by a name of its own (C:\Users\me shared as Profile), and a mapped
    // drive resolves to one: no spelling of the data folder says which. So
    // without Full access, a file tool doesn't reach through one at all
    // (Codex's review, 18 Nov 2026).
    if (path.sep === '\\' && [real, written].some((p) => plain(p).startsWith('\\\\'))) return SHARE_REASON;
  }
  // A Glob or Grep from the data dir itself reaches the folder whatever its
  // pattern says. From further up, a Glob only lists names, so it's refused
  // when its pattern names the folder; a Grep reads what's in every file it
  // passes, and its glob, not its pattern, picks the files (`pattern: "."`
  // with `glob: "Threadbear/secrets/runner-token"` printed the token, cross-lab
  // review, 11 Nov 2026), so it's refused whenever the folder is under it.
  if (tool === 'Glob' || tool === 'Grep') {
    const base = typeof input.path === 'string' && input.path ? input.path : (cwd ?? '.');
    // The folder it searches whether or not it was named: with no path,
    // it's the thread's own, which can be a share too (Codex's review).
    if (path.sep === '\\' && plain(path.resolve(cwd ?? process.cwd(), base)).startsWith('\\\\')) return SHARE_REASON;
    const dir = resolved(base, cwd);
    if (path.sep === '\\' && plain(dir).startsWith('\\\\')) return SHARE_REASON;
    const pattern = typeof input.pattern === 'string' ? input.pattern : '';
    if (same(dir, resolved(home))) return REASON;
    if (inside(target, dir) && (tool === 'Grep' || /\bsecrets\b|runner-token/i.test(pattern))) return GREP_REASON;
  }
  return undefined;
}
