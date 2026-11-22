// What a script a patch names runs in turn, so patch trust can hash it
// (docs/protocol/trust.md, "Trusting a folder's patches").
//
// Hashing only the script a patch names left a hole: a trusted
// `./setup.sh` that runs `./helper.sh` ran a changed helper with nobody
// asked (Daybreak verify-fix, 5 Nov). So from each script a patch names,
// this follows every local file it can run or read, the way a shell, Node
// and npm would find them, and hands back the lot to hash. When a script
// runs something it can't follow (eval, `sh -c "$x"`, `curl | sh`, a
// command in a variable), it says so in `problem`, and a command that runs
// by itself refuses that script (automaticCommand): the hash can't vouch
// for what it'd run.
//
// Followed:
//   - shell scripts (by extension or #!): every command they run, read with
//     a small shell lexer. A path to a file (`./helper.sh`,
//     `"$(dirname "$0")/x.sh"`, `${0%/*}/x`), `source`/`.`, `sh`/`bash`/`zsh`
//     with a file or a literal `-c`, `node`/`bun`/`deno`/`tsx` with a file,
//     `npm`/`pnpm`/`yarn`/`bun` scripts by a literal name (package.json and
//     the script's own command), installs (their lifecycle scripts), `npx`
//     (package.json), `make` (the Makefile's recipes), and what `env`,
//     `exec`, `nice`, `xargs`, `find -exec` and the like run. A `cd` to a
//     path it can work out is followed, so relative paths after it resolve.
//   - JavaScript and TypeScript: imports (scanModule), and any string in
//     them that's the path of a file in the repo.
//   - Any file a script names (an argument, `$(cat x)`, a `./` path in its
//     text) is hashed if it's code (looksRunnable), and followed if it's a
//     script. A data file it only names or reads isn't: trusting the
//     script trusts what it does with its data.
//
// Not followed: programs on PATH and packages, as installed. What one of
// those loads from the repo by its own rules (a test runner's tests, a
// build's config) is past this, as node_modules is for patch files.
import crypto from 'node:crypto';
import { IS_WINDOWS, realPathSync, slashes } from './platform.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBuiltin } from 'node:module';
import { bareImport, inNodeModules, linkedPackages, packageFiles } from './tracked-packages.ts';

// `outside`: with FollowOptions.outside, the scripts it runs or loads that
// aren't the repo's, which a schedule's check binds too (patch-trust.ts).
// Each with the folders it runs from, as its own relative paths are those.
// `refused`: a Windows UNC or device path it won't resolve (windowsSpelling),
// which could be a file of the repo's under another name: a command that
// names one can't have its files hashed, even where `problem` is let go.
// `writes`: what it writes, for followOutside to hold one reach's writes
// against another's runs (writeProblem).
// `writeProblem`: `problem` when it's that (writeProblem), which nobody can
// approve a schedule's check past.
export type ScriptReach = { files: string[]; missing: string[]; problem?: string; outside?: { file: string; dirs: string[] }[]; refused?: string; writes?: Writes; writeProblem?: string };
// `pending`: writes to a path made from variables, settled against every
// reach's `deps` (a variable a caller sets is the script's to steer too):
// what each variable's value was made from, `direct` when that's worked
// out as it runs (a `$(...)`, `read`, a loop), else the values and words
// it was set to, so a write in another script to `"$OUT"` is held as the
// file OUT names. `#args:<file>` stands for that script's positionals,
// made from what it (or a function in it) was handed.
// `assignsAny`: a variable whose name is worked out was set.
// A word as it was written: literal text, and variables (with `alt`, a
// plain `${x:-alt}` default or `${x:+alt}` word, that it may be instead).
export type Tpl = (string | { v: string; alt?: string })[];
// `values`: what it was set to where that was known; `forms`: the words it
// was set to where it wasn't.
export type Deps = { direct: boolean; names: string[]; values?: string[]; forms?: Tpl[] };
// `into`: a copy's target, which may be a folder it writes into.
// `srcs`: the names of what's copied there, when known: into a folder,
// that's what's written.
export type Pending = { where: string; direct: boolean; names: string[]; tpl: Tpl; dirs: string[]; flag?: boolean; into?: boolean; srcs?: string[] };
// `exported`: variables a shell it starts still has; `cleared`: ones some
// `env -u` takes away.
export type Writes = { written: [string, string][]; somewhere?: string; reached: string[]; pending?: Pending[]; deps?: [string, Deps][]; assignsAny?: boolean; exported?: string[]; cleared?: string[] };

// The most of one file patch trust reads (a patch, a helper, a script, a
// config file); it reads one bigger than this not at all, and fails closed.
export const MAX_READ_BYTES = 32 * 1024 * 1024;

// One look at the files a hash is made from: each read once, the bytes
// kept, so what was scanned for what it runs is what's hashed (and, for a
// patch's own code, what's imported). `prints` is each file's stat taken
// before its read, and `links` each path as it was named with the real
// path it led to then, so a cached hash can tell a file was changed (on
// macOS and Linux a write moves ctime, which can't be set back; a replace
// moves the inode; on Windows `sums` is what's compared, see same())
// or a symlink on the way to it retargeted.
export class Reads {
  readonly prints = new Map<string, string>();
  // Windows only: the SHA-256 of each file's bytes as read. NTFS keeps a
  // ChangeTime of its own, but a program can set it, with the write times,
  // by handle (SetFileInformationByHandle), so an edit at the same size
  // with its times put back kept the fingerprint above. The bytes can't be
  // put back without the hash changing.
  private readonly sums = new Map<string, string>();
  readonly bytes = new Map<string, Buffer>();
  readonly links = new Map<string, string>();
  // What a config file (an .npmrc, a Makefile) was read as, by kind and
  // real path: every one of a patch's up to 2000 strings is followed as a
  // command, each by a Reach of its own, and each read them again.
  readonly parsed = new Map<string, unknown>();

  // `p`'s real path, recorded; undefined when it isn't there.
  real(p: string): string | undefined {
    let r: string | undefined;
    try {
      r = realPathSync(p);
    } catch {
      r = undefined;
    }
    this.links.set(p, r ?? '');
    return r;
  }

  // A file's bytes as text, decoded once: each of a patch's commands is
  // followed by a Reach of its own, and each read the same files again.
  readonly texts = new Map<string, string>();
  text(real: string): string | undefined {
    const hit = this.texts.get(real);
    if (hit !== undefined) return hit;
    const b = this.read(real);
    if (!b) return undefined;
    const t = b.toString('utf8');
    this.texts.set(real, t);
    return t;
  }

  // A file the hash depends on without reading it (git's index, which says
  // what the repo tracks under node_modules: tracked-packages.ts), so a
  // cached hash looks again once it changes.
  watch(p: string): void {
    try {
      this.prints.set(p, fingerprint(p));
    } catch {
      this.links.set(p, '');
    }
  }

  // Windows: the names of the files in a folder that cmd.exe or Windows'
  // own lookup could run by a bare name (runnableNames), so a cached hash
  // looks again once one turns up, as a program a pull drops beside a
  // script would be run in place of an installed one by that name.
  readonly listings = new Map<string, string>();
  runnables(dir: string): string[] | undefined {
    const names = runnableNames(dir);
    this.listings.set(dir, names === undefined ? '\u0000none' : names.join('\n'));
    return names;
  }

  // Files over MAX_READ_BYTES, not read: a hash that needed one can't
  // be made (patchHash), so nothing that reaches one can be trusted.
  readonly tooBig = new Set<string>();

  // A file's bytes (by real path), read once.
  read(real: string): Buffer | undefined {
    const hit = this.bytes.get(real);
    if (hit) return hit;
    let print: string;
    let b: Buffer;
    try {
      print = fingerprint(real);
      if (fs.statSync(real).size > MAX_READ_BYTES) {
        this.tooBig.add(real);
        return undefined;
      }
      b = fs.readFileSync(real);
    } catch {
      return undefined;
    }
    this.prints.set(real, print);
    if (IS_WINDOWS) this.sums.set(real, sha256(b));
    this.bytes.set(real, b);
    return b;
  }

  // Whether everything looked at is as it was: no file changed, no link
  // retargeted, nothing that was missing turned up.
  same(): boolean {
    for (const [p, print] of this.prints) {
      try {
        if (fingerprint(p) !== print) return false;
        // The stat can be made to match (see sums): on Windows the bytes
        // are read again too. Patches and their scripts are small.
        if (IS_WINDOWS && sha256(fs.readFileSync(p)) !== this.sums.get(p)) return false;
      } catch {
        return false;
      }
    }
    for (const [dir, names] of this.listings) {
      const now = runnableNames(dir);
      if ((now === undefined ? '\u0000none' : now.join('\n')) !== names) return false;
    }
    for (const [p, real] of this.links) {
      let now = '';
      try {
        now = realPathSync(p);
      } catch {
        // missing
      }
      if (now !== real) return false;
    }
    return true;
  }
}

// The files directly in `dir` with an extension Windows runs by a bare name
// (PATHEXT, and its defaults whatever it says), sorted; undefined when it
// can't be read.
const DEFAULT_PATHEXT = ['.com', '.exe', '.bat', '.cmd', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msc', '.cpl', '.ps1'];
export function runnableNames(dir: string): string[] | undefined {
  const exts = new Set([...DEFAULT_PATHEXT, ...(process.env.PATHEXT ?? '').split(';').map((e) => e.trim().toLowerCase()).filter((e) => e.startsWith('.'))]);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.isDirectory() && exts.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort();
  } catch {
    return undefined;
  }
}

// What changes when a file's content can have: its inode (a replace), size,
// mtime, and ctime, which every write and chmod moves and nothing on macOS
// or Linux can set back (utimes moves it too). On NTFS a program can set it
// back, so on Windows this only finds the quick change and Reads.same()
// reads the bytes as well.
export function fingerprint(p: string): string {
  const st = fs.statSync(p);
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`;
}

export type FollowOptions = {
  folder: string; // where the command starts: the folder holding .threadbear/
  top: string; // the repo's top; only files inside it are the repo's to change
  home?: string;
  // From patch-trust.ts, passed in so the two don't import each other.
  // `packages`: its bare imports, followed when the repo commits them
  // (tracked-packages.ts).
  scanJs: (src: string, file: string) => { specifiers: string[]; packages?: string[]; strings: string[]; problem?: string };
  resolveImport: (dir: string, spec: string) => string;
  namedPaths: (src: string) => string[];
  // Shared with the caller's hash, so it hashes the bytes followed here.
  reads?: Reads;
  // For a Claude Code hook, which runs by itself (claude-trust.ts): what
  // patch trust lets through as installed code is a problem instead. A
  // package run by name (`npx x`, `pnpm dlx x`: whatever the name resolves
  // to then, the registry's latest or a bin of the repo's own), a test
  // runner finding its own tests (`node --test`, `bun test`), and, as the
  // command itself, a program on PATH that isn't one known to load nothing
  // from the folder (a formatter, a test runner or a build tool loads its
  // config and plugins from there by its own rules).
  strict?: boolean;
  // Note the scripts it reaches outside the repo (ScriptReach.outside),
  // which are nobody's to change but yours and otherwise aren't looked at:
  // a schedule's check runs them unattended, by a path as often as not.
  outside?: boolean;
};

// A package manager's own entry script, run by path through node.
const PACKAGE_MANAGER_ENTRY = /\/node_modules\/(?:npm|pnpm|yarn|corepack|bun|@yarnpkg\/[^/]+)\/|\/(?:npm|npx|pnpm|pnpx|yarn|yarnpkg|corepack)(?:-cli)?\.[cm]?js$/i;

// The variables patch trust can't follow a script setting, in the forms
// assignment() doesn't read: arithmetic (`$((HOME=0))`, `let`, `(( ))`,
// `HOME++`), by the script's text. A `$` or `{` before the name is a read.
const ARITH_SET = (name: string) => new RegExp(`(?<![$\\w{])${name}\\s*(?:(?:[-+*/%^|&]|<<|>>)?=(?!=)|\\+\\+|--)|(?:\\+\\+|--)\\s*${name}\\b`);
const HOME_SET = ARITH_SET('HOME');
const MSYS_SET = ARITH_SET('MSYS2?_(?:ARG_CONV_EXCL|NO_PATHCONV|ENV_CONV_EXCL)');

// Bounds: a script reaching more than this can't be checked.
export const MAX_SCRIPT_FILES = 300;
const MAX_DEPTH = 12;
const MAX_VISITS = 600;

const SHELL_EXT = ['.sh', '.bash', '.zsh', '.ksh', '.command'];
const JS_EXT = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.tsx', '.jsx'];
const SHELLS = ['sh', 'bash', 'zsh', 'dash', 'ksh'];
const JS_RUNNERS = ['node', 'tsx', 'ts-node', 'bun', 'deno'];
// Languages whose loads this can't follow: running a file or code in one
// fails closed.
const OTHER_LANGS = /^(python[0-9.]*|ruby|perl|php|lua|osascript|pwsh|powershell|fish|csh|tcsh|Rscript|expect|tclsh|uv|uvx|poetry|pipenv|rake|bundle|parallel)$/;
// Windows' own (checked as well there, by the lower-case name with the
// extension off): the command interpreter, the Python launcher, the script
// hosts, and wsl and conhost, which run another command line.
const WINDOWS_LANGS = /^(cmd|py|pyw|pythonw|rscript|wscript|cscript|mshta|wsl|conhost)$/;
// Shell words that run their argument as code, or change what a command
// name means, which can't be followed.
const UNFOLLOWABLE: Record<string, string> = {
  eval: 'runs text worked out as it runs (`eval`)',
  alias: 'defines an alias, which changes what a command name runs',
  autoload: 'autoloads functions from other files',
  enable: 'loads builtins from a file (`enable`)',
  coproc: 'starts a coprocess',
  fc: 'runs commands from history (`fc`)',
};
// Environment that makes a shell, Node or the loader run other code.
export const RISKY_ENV = new Set([
  'BASH_ENV', 'ENV', 'ZDOTDIR', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'RUBYOPT', 'PERL5OPT',
  'PERL5LIB', 'PROMPT_COMMAND', 'npm_config_script_shell', 'NPM_CONFIG_SCRIPT_SHELL', 'npm_config_node_options',
  'NPM_CONFIG_NODE_OPTIONS', 'BUN_OPTIONS', 'GIT_EXEC_PATH', 'SHELLOPTS', 'BASHOPTS', 'FPATH', 'fpath',
]);

// Programs a Claude Code hook (and what it runs) may run with nothing more
// to follow (FollowOptions.strict): ones that neither load code from the
// folder nor run a command they're handed, and shell builtins. Not git (an
// alias or core.hooksPath runs anything), open (an app in the repo), sed
// (its `e`), sort (--compress-program) or terminal-notifier (-execute).
const INERT_PROGRAMS = new Set([
  'echo', 'printf', 'true', 'false', 'test', '[', ':', 'cat', 'head', 'tail', 'ls', 'pwd', 'date', 'sleep', 'say', 'afplay',
  'jq', 'grep', 'egrep', 'fgrep', 'tr', 'wc', 'cut', 'uniq', 'tee', 'mkdir', 'touch', 'rm', 'rmdir', 'cp', 'mv', 'ln',
  'chmod', 'basename', 'dirname', 'realpath', 'readlink', 'stat', 'pbcopy', 'pbpaste', 'curl', 'wget', 'which', 'whoami',
  'hostname', 'uname', 'tput', 'notify-send', 'logger', 'mktemp',
  'cd', 'export', 'set', 'unset', 'shift', 'exit', 'return', 'read', 'local', 'declare', 'typeset', 'wait', 'umask',
  'break', 'continue', 'pushd', 'popd', 'type', 'hash', 'let', 'shopt', 'ulimit',
]);

// Redirections that write a file.
const WRITE_REDIRS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);
// `$(mktemp)`, `$(mktemp -d)`, `$(mktemp -t name)`: a new file in the temp
// folder, not the repo (a template without -t is made in the current one).
const PLAIN_MKTEMP = /^\s*mktemp(\s+(-[dqu]+|-t\s+[\w.-]+|\/tmp\/[\w.-]+))*\s*$/;
// What writesOf reads the arguments of for what it writes.
const WRITERS = new Set(['cp', 'gcp', 'mv', 'gmv', 'install', 'ginstall', 'rsync', 'ditto', 'scp', 'tee', 'dd', 'sed', 'gsed', 'sort', 'base64', 'iconv', 'openssl', 'uniq', 'xxd', 'curl', 'wget']);
const ARCHIVERS = new Set(['tar', 'gtar', 'bsdtar', 'gzip', 'bzip2', 'xz', 'zstd', 'lz4', 'brotli']);
// Wrappers writesOnly steps past to the command they run.
const WRAPPER_NAMES = new Set(['env', 'exec', 'command', 'builtin', 'nohup', 'nice', 'time', 'timeout', 'gtimeout', 'taskpolicy', 'caffeinate', 'stdbuf', 'xargs', 'sudo', 'doas', 'chronic', 'unbuffer', 'noglob', 'nocorrect', 'ionice', 'arch', 'flock']);
const RSYNC_VALUED = /^(-e|-T|-f|--rsh|--exclude|--include|--filter|--exclude-from|--include-from|--files-from|--log-file|--log-file-format|--password-file|--temp-dir|--partial-dir|--backup-dir|--suffix|--compare-dest|--copy-dest|--link-dest|--chmod|--chown|--usermap|--groupmap|--rsync-path|--out-format|--max-size|--min-size|--timeout|--contimeout|--bwlimit|--port|--sockopts|--iconv|--checksum-choice|--compress-choice|--skip-compress)$/;
// Programs whose last operand (or -t folder) is what they write.
const COPIERS = new Set(['cp', 'gcp', 'mv', 'gmv', 'install', 'ginstall', 'rsync', 'ditto', 'scp']);
// git commands that write the working tree from what git holds or fetches.
const GIT_WRITES = new Set([
  'checkout', 'switch', 'restore', 'reset', 'pull', 'merge', 'rebase', 'cherry-pick', 'revert', 'apply', 'am', 'stash',
  'clone', 'worktree', 'read-tree', 'checkout-index', 'submodule', 'sparse-checkout', 'bisect', 'filter-branch', 'mv',
]);
// Programs that write files the data names.
const UNPACKERS = new Set(['unzip', 'gunzip', 'bunzip2', 'unxz', 'unzstd', 'uncompress', 'unlz4', 'patch', 'gpatch', 'split', 'csplit', 'cpio', '7z', '7za', '7zz', 'unrar', 'unar', 'pax']);
const LOADING_FLAG = /(^|\s)(-r|-e|-p|--require|--import|--loader|--experimental-loader|--preload|--eval|--print|--preserve-symlinks|--preserve-symlinks-main)(\s|=|$)/;
const LIFECYCLE = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'prepack', 'postpack', 'prepublishOnly', 'publish', 'postpublish', 'dependencies'];
const PATH_SENTINEL = '\u0000PATH';
// A package's bin folder on PATH: on Windows written with either slash;
// elsewhere a backslash is part of a name (Codex's review, 18 Nov 2026).
const BIN_DIR = IS_WINDOWS ? /[\\/]node_modules[\\/]\.bin[\\/]?$/ : /\/node_modules\/\.bin\/?$/;

// Extensions of files that run as code: a shell's, Node's, or a language
// this can't follow (which fails closed when one runs).
// A PowerShell script and the two kinds of batch file are code on Windows
// only: elsewhere a file called x.bat is data until it has a #! or a mode.
export const RUNNABLE_EXT = [...SHELL_EXT, ...JS_EXT, '.py', '.rb', '.pl', ...(IS_WINDOWS ? ['.ps1', '.bat', '.cmd'] : [])];

// Whether a file a patch or script only names (a string, an argument) is
// code, and so goes in the hash: a runnable extension, the executable bit
// or a `#!` line. Anything else (state.json, notes.txt, a folder) is data:
// a patch that writes its own state file would otherwise change its hash
// every run and be asked about again. A file something runs, sources or
// imports is hashed whatever it looks like (follow's other `how`s). A
// missing file counts only with a runnable extension.
export function looksRunnable(file: string): boolean {
  if (RUNNABLE_EXT.includes(path.extname(file).toLowerCase())) return true;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    if (st.mode & 0o111) return true;
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(2);
      return fs.readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === '#!';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// A program's name as the tables above know it. On Windows a program is
// found whatever its case and with or without its extension, so `node.exe`,
// `NODE.EXE` and `npm.cmd` are node and npm (each of which took patch trust
// past `node -e` and a package.json's scripts: the Windows port's review).
// Elsewhere the name is the name.
export function programName(name: string, windows: boolean = IS_WINDOWS): string {
  return windows ? name.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '') : name;
}

// Whether a program is a language or launcher on Windows that runs a script
// patch trust can't follow (the OTHER_LANGS of the platform).
function isOtherLang(name: string): boolean {
  return OTHER_LANGS.test(name) || (IS_WINDOWS && WINDOWS_LANGS.test(name));
}

// A word that names a path, as Git Bash (which runs a patch's commands on
// Windows) reads it, as the Windows path it is. Git Bash takes `/c/x/y`
// (and `/C/x/y`, and a Cygwin-style `/cygdrive/c/x/y`) as C:\x\y and
// `/tmp` as the temp folder, and a file: URL's `/C:/x/y` is C:\x\y, none of
// which a Windows path.resolve reads that way: it put them on the current
// drive, outside the repo, so a script run by one of those spellings was
// never hashed. Windows has more ways to say the same drive: the extended
// `//?/C:/x` and `//./C:/x`, and this machine's own admin share
// (`//localhost/C$/x`, `//127.0.0.1/C$/x`, `//<this computer>/C$/x`), which
// are mapped to C:\x too. Any other path that starts with two slashes
// (`//host/share`, `//?/UNC/host/share`, `\\host\share`) is refused: it can
// name any file on the machine through a network name or a device, and patch
// trust can't tell which. (A bare `//`, as in a string that starts with a
// comment, names no host and is left alone.) Everything else comes back as
// it was; 8.3 short names, other cases and the like are settled by the real
// path (platform.ts's realPath). Pure: `tmp` is where /tmp is, `host` this
// computer's name.
export function windowsSpelling(v: string, where: { tmp?: string; host?: string } = {}): { path: string } | { refuse: string } {
  const win = path.win32;
  const onDrive = (letter: string, rest: string | undefined) => ({ path: win.normalize(`${letter.toUpperCase()}:\\${rest ?? ''}`) });
  if (/^[\\/]{2}[^\\/\s]/.test(v)) {
    const extended = /^[\\/]{2}[?.][\\/]([A-Za-z]):(?:[\\/](.*))?$/s.exec(v);
    if (extended) return onDrive(extended[1]!, extended[2]);
    const share = /^[\\/]{2}([^\\/]+)[\\/]([A-Za-z])\$(?:[\\/](.*))?$/s.exec(v);
    const own = ['localhost', '127.0.0.1', '[::1]', '::1', (where.host ?? os.hostname()).toLowerCase()];
    if (share && own.includes(share[1]!.toLowerCase())) return onDrive(share[2]!, share[3]);
    return { refuse: 'a network or device path (a name starting with two slashes)' };
  }
  const drive = /^\/(?:cygdrive\/)?([A-Za-z])(?:\/(.*))?$/s.exec(v) ?? /^\/([A-Za-z]):(?:[\\/](.*))?$/s.exec(v);
  if (drive) return onDrive(drive[1]!, drive[2]);
  if (v === '/tmp' || v.startsWith('/tmp/')) return { path: win.join(where.tmp ?? os.tmpdir(), v.slice('/tmp/'.length)) };
  return { path: v };
}

// ---- a shell lexer: enough of POSIX sh, bash and zsh to see what runs ----

type Part = { k: 'lit'; s: string; q: boolean } | { k: 'var'; name: string; op: string } | { k: 'sub'; src: string; line: number } | { k: 'arith' };
type Word = { parts: Part[]; line: number };
type Tok = { t: 'word'; w: Word } | { t: 'op'; op: string; line: number } | { t: 'redir'; op: string; target?: Word; line: number };

const OPS = ['<(', '>(', ';;&', ';;', ';&', '&&', '||', '|&', '<<<', '<<-', '<<', '&>>', '&>', '>>', '<>', '>|', '>&', '<&', ';', '&', '|', '(', ')', '<', '>'];
const REDIRS = new Set(['<<<', '<<-', '<<', '&>>', '&>', '>>', '<>', '>|', '>&', '<&', '<', '>']);

class Lexer {
  i = 0;
  line: number;
  toks: Tok[] = [];
  // Command substitutions outside any command's words (in a here-doc, a
  // ${x:-$(cmd)}): they run too.
  extra: { src: string; line: number }[] = [];
  private heredocs: { delim: string; strip: boolean; quoted: boolean }[] = [];
  private s: string;
  constructor(s: string, line = 1) {
    this.s = s;
    this.line = line;
  }

  run(): this {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === ' ' || c === '\t' || c === '\r') {
        this.i++;
      } else if (c === '\\' && s[this.i + 1] === '\n') {
        this.i += 2;
        this.line++;
      } else if (c === '\n') {
        this.toks.push({ t: 'op', op: '\n', line: this.line });
        this.i++;
        this.line++;
        this.readHeredocs();
      } else if (c === '#') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
      } else if (!this.op()) {
        const w = this.word();
        // `2>&1`: the 2 is the redirect's, not a word.
        if (/^\d+$/.test(litOf(w) ?? '') && (s[this.i] === '<' || s[this.i] === '>')) continue;
        if (!w.parts.length) throw new Error(`can't read line ${this.line}`);
        this.toks.push({ t: 'word', w });
      }
    }
    if (this.heredocs.length) this.readHeredocs();
    return this;
  }

  private op(): boolean {
    const s = this.s;
    const op = OPS.find((o) => s.startsWith(o, this.i));
    if (!op) return false;
    const line = this.line;
    if (op === '<(' || op === '>(') {
      const src = this.balanced(this.i + 1);
      this.toks.push({ t: 'word', w: { parts: [{ k: 'sub', src, line }], line } });
      return true;
    }
    this.i += op.length;
    if (!REDIRS.has(op)) {
      this.toks.push({ t: 'op', op, line });
      return true;
    }
    while (s[this.i] === ' ' || s[this.i] === '\t') this.i++;
    let target: Word | undefined;
    if (this.i < s.length && !' \t\r\n;&|()<>'.includes(s[this.i]!)) target = this.word();
    if ((op === '<<' || op === '<<-') && target) {
      const quoted = target.parts.some((p) => p.k === 'lit' && p.q);
      const delim = target.parts.map((p) => (p.k === 'lit' ? p.s : '')).join('');
      this.heredocs.push({ delim, strip: op === '<<-', quoted });
    }
    this.toks.push({ t: 'redir', op, ...(target ? { target } : {}), line });
    return true;
  }

  private readHeredocs(): void {
    const s = this.s;
    for (const h of this.heredocs) {
      let body = '';
      const line = this.line;
      while (this.i < s.length) {
        const end = s.indexOf('\n', this.i);
        const text = s.slice(this.i, end < 0 ? s.length : end);
        this.i = end < 0 ? s.length : end + 1;
        this.line++;
        if ((h.strip ? text.replace(/^\t+/, '') : text) === h.delim) break;
        body += text + '\n';
      }
      // An unquoted here-doc's $(...) runs as it's read.
      if (!h.quoted) this.collectSubs(body, line);
    }
    this.heredocs = [];
  }

  // The substitutions in text a shell expands as it would a "..." string.
  collectSubs(text: string, line: number): void {
    const l = new Lexer(text, line);
    while (l.i < text.length) {
      const c = text[l.i];
      if (c === '\\') l.i += 2;
      else if (c === '$' || c === '`') {
        const p = c === '$' ? l.dollar() : l.backtick();
        if (p?.k === 'sub') this.extra.push({ src: p.src, line: p.line });
        if (!p) l.i++;
      } else {
        if (c === '\n') l.line++;
        l.i++;
      }
    }
    this.extra.push(...l.extra);
  }

  word(): Word {
    const s = this.s;
    const parts: Part[] = [];
    const line = this.line;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (' \t\r\n;&|()<>'.includes(c)) break;
      if (c === '\\') {
        if (s[this.i + 1] === '\n') {
          this.i += 2;
          this.line++;
          continue;
        }
        parts.push({ k: 'lit', s: s[this.i + 1] ?? '', q: true });
        this.i += 2;
      } else if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end < 0) throw new Error(`an unclosed ' on line ${this.line}`);
        const text = s.slice(this.i + 1, end);
        this.line += countLines(text);
        parts.push({ k: 'lit', s: text, q: true });
        this.i = end + 1;
      } else if (c === '$' && s[this.i + 1] === "'") {
        let j = this.i + 2;
        while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
        if (j >= s.length) throw new Error(`an unclosed $' on line ${this.line}`);
        const text = s.slice(this.i + 2, j);
        this.line += countLines(text);
        // With an escape in it (`$'\142ash'` is bash), what it says isn't
        // the text: taken as worked out as it runs, so a command or file
        // named by one fails closed (Codex's review, 6 Nov).
        parts.push(text.includes('\\') ? { k: 'var', name: '', op: "$'" } : { k: 'lit', s: text, q: true });
        this.i = j + 1;
      } else if (c === '"') {
        this.i++;
        this.dquote(parts);
      } else if (c === '$') {
        const p = this.dollar();
        if (p) parts.push(p);
        else {
          parts.push({ k: 'lit', s: '$', q: false });
          this.i++;
        }
      } else if (c === '`') {
        parts.push(this.backtick());
      } else {
        parts.push({ k: 'lit', s: c, q: false });
        this.i++;
      }
    }
    return { parts, line };
  }

  // Inside "...", from just after the opening quote to just after the close.
  dquote(parts: Part[]): void {
    const s = this.s;
    while (this.i < s.length) {
      const c = s[this.i]!;
      if (c === '"') {
        this.i++;
        return;
      }
      if (c === '\\') {
        const n = s[this.i + 1] ?? '';
        if (n === '\n') this.line++;
        else parts.push({ k: 'lit', s: '$`"\\'.includes(n) ? n : '\\' + n, q: true });
        this.i += 2;
      } else if (c === '$') {
        const p = this.dollar();
        if (p) parts.push(p);
        else {
          parts.push({ k: 'lit', s: '$', q: true });
          this.i++;
        }
      } else if (c === '`') {
        parts.push(this.backtick());
      } else {
        if (c === '\n') this.line++;
        parts.push({ k: 'lit', s: c, q: true });
        this.i++;
      }
    }
    throw new Error(`an unclosed " on line ${this.line}`);
  }

  private dollar(): Part | undefined {
    const s = this.s;
    const line = this.line;
    const n = s[this.i + 1];
    if (n === '(' && s[this.i + 2] === '(') {
      const inner = this.balanced(this.i + 1);
      this.collectSubs(inner, line);
      return { k: 'arith' };
    }
    if (n === '(') return { k: 'sub', src: this.balanced(this.i + 1), line };
    if (n === '{') {
      let depth = 0;
      let j = this.i + 1;
      for (; j < s.length; j++) {
        const c = s[j];
        if (c === '\\') j++;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
        else if (c === '\n') this.line++;
      }
      if (j >= s.length) throw new Error(`an unclosed \${ on line ${line}`);
      const inner = s.slice(this.i + 2, j);
      this.i = j + 1;
      const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])(\[[^\]]*\])?/.exec(inner);
      const name = m ? m[1]! + (m[2] ?? '') : '';
      const op = m ? inner.slice(m[0].length) : inner;
      if (/[`$]/.test(op)) this.collectSubs(op, line);
      return { k: 'var', name, op };
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-])/.exec(s.slice(this.i + 1, this.i + 64));
    if (!m) return undefined;
    this.i += 1 + m[1]!.length;
    return { k: 'var', name: m[1]!, op: '' };
  }

  private backtick(): Part {
    const s = this.s;
    const line = this.line;
    let j = this.i + 1;
    let src = '';
    for (; j < s.length && s[j] !== '`'; j++) {
      if (s[j] === '\\' && (s[j + 1] === '`' || s[j + 1] === '\\' || s[j + 1] === '$')) src += s[++j];
      else src += s[j];
    }
    if (j >= s.length) throw new Error(`an unclosed \` on line ${line}`);
    this.line += countLines(src);
    this.i = j + 1;
    return { k: 'sub', src, line };
  }

  // The text inside the ( at `open` and its ), skipping quotes; moves past it.
  private balanced(open: number): string {
    const s = this.s;
    let depth = 0;
    let j = open;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') j++;
      else if (c === "'") {
        const end = s.indexOf("'", j + 1);
        if (end < 0) break;
        j = end;
      } else if (c === '"') {
        for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === '\\') j++;
      } else if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    if (j >= s.length) throw new Error(`an unclosed ( on line ${this.line}`);
    const inner = s.slice(open + 1, j);
    this.line += countLines(inner);
    this.i = j + 1;
    return inner;
  }
}

function countLines(t: string): number {
  let n = 0;
  for (const c of t) if (c === '\n') n++;
  return n;
}

// A word that's only literal text, or undefined.
function litOf(w: Word): string | undefined {
  return w.parts.every((p) => p.k === 'lit') ? w.parts.map((p) => (p as { s: string }).s).join('') : undefined;
}

// A `${x:-default}`'s default as the shell hands it on: quotes and
// backslashes off.
function plainDefault(d: string): string {
  return d.replace(/^(["'])(.*)\1$/s, '$2').replace(/\\(.)/g, '$1');
}

// Whether the shell expands a word into names it finds or makes: an
// unquoted glob or a brace list.
function hasPattern(w: Word): boolean {
  // Across parts, as the lexer may split one; anything quoted or expanded
  // stands for a character that can't be part of either.
  // Quoted text can't be a pattern's `*` or a brace, but sits inside one
  // (`run.{s"h",bak}`), so it counts as plain letters; an expansion as a
  // character neither can hold.
  const glob = w.parts.map((p) => (p.k === 'lit' && !p.q ? p.s : '\u0000')).join('');
  const brace = w.parts.map((p) => (p.k === 'lit' ? (p.q ? 'a'.repeat(p.s.length) : p.s) : '\u0000')).join('');
  return /[*?[]/.test(glob) || /\{[^}\u0000]*(,|\.\.)[^}\u0000]*\}/.test(brace);
}

// Unquoted, plain: how reserved words and assignments are told apart.
function bareOf(w: Word): string | undefined {
  return w.parts.every((p) => p.k === 'lit' && !p.q) ? w.parts.map((p) => (p as { s: string }).s).join('') : undefined;
}

type Simple = { words: Word[]; redirs: { op: string; target?: Word }[]; line: number; arrays: Word[] };

const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '{', '}', '!', 'time', '}}', '{{']);

// Simple commands from tokens, with `case` patterns, `[[ ]]` and `x=(...)`
// kept from looking like commands of their own.
function simpleCommands(toks: Tok[]): Simple[] {
  const out: Simple[] = [];
  let cur: Simple = { words: [], redirs: [], line: 0, arrays: [] };
  const end = () => {
    if (cur.words.length || cur.redirs.length || cur.arrays.length) out.push(cur);
    cur = { words: [], redirs: [], line: 0, arrays: [] };
    leadAt = -1;
    leadIsCase = false;
  };
  const cases: ('pat' | 'body')[] = [];
  let inTest = false;
  // The first of cur's words that isn't a reserved word, kept as words are
  // added: finding it afresh each time was quadratic in `if if if ...`
  // (Codex's review, 6 Nov).
  let leadAt = -1;
  let leadIsCase = false;
  const lead = () => leadAt;
  const push = (w: Word) => {
    cur.words.push(w);
    if (leadAt < 0 && !RESERVED.has(bareOf(w) ?? '')) {
      leadAt = cur.words.length - 1;
      leadIsCase = bareOf(w) === 'case';
    }
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (cases.at(-1) === 'pat') {
      if (t.t === 'word' && bareOf(t.w) === 'esac') cases.pop();
      else if (t.t === 'op' && t.op === ')') cases[cases.length - 1] = 'body';
      // A pattern is expanded, so what's in it runs: kept as `:`'s words.
      else if (t.t === 'word') out.push({ words: [{ parts: [{ k: 'lit', s: ':', q: false }], line: t.w.line }, t.w], redirs: [], line: t.w.line, arrays: [] });
      continue;
    }
    if (t.t === 'op') {
      if (inTest && t.op !== '\n' && t.op !== ';') continue;
      if (t.op === '(' && cur.words.length && /=$/.test(bareOf(cur.words.at(-1)!) ?? '')) {
        for (k++; k < toks.length; k++) {
          const v = toks[k]!;
          if (v.t === 'op' && v.op === ')') break;
          if (v.t === 'word') cur.arrays.push(v.w);
        }
        continue;
      }
      end();
      if ((t.op === ';;' || t.op === ';&' || t.op === ';;&') && cases.at(-1) === 'body') cases[cases.length - 1] = 'pat';
      continue;
    }
    if (t.t === 'redir') {
      if (inTest) {
        if (t.target) push(t.target);
        continue;
      }
      cur.redirs.push({ op: t.op, ...(t.target ? { target: t.target } : {}) });
      if (!cur.line) cur.line = t.line;
      continue;
    }
    const bare = bareOf(t.w);
    if (!cur.line) cur.line = t.w.line;
    const at = lead();
    if (at < 0 && bare === 'esac' && cases.length) {
      cases.pop();
      end();
      continue;
    }
    if (at < 0 && bare === '[[') inTest = true;
    if (inTest && bare === ']]') inTest = false;
    push(t.w);
    const first = lead();
    if (first >= 0 && leadIsCase && cur.words.length === first + 3 && bare === 'in') {
      end();
      cases.push('pat');
    }
  }
  end();
  return out;
}

// ---- following ----

type Ctx = {
  label: string; // for messages: a path from the repo's top, or a package script
  file: string; // the script's own file (BASH_SOURCE)
  argv0: string[]; // what $0 can be
  dirs: Set<string>; // the folders it can be in
  lost?: string; // set once a cd goes somewhere this can't work out
  vars: Map<string, string[] | undefined>;
  depth: number;
  inSub?: boolean;
};

class Reach {
  files = new Set<string>();
  missing = new Set<string>();
  outside = new Map<string, Set<string>>();
  problem?: string;
  // The package folders whose node_modules/.bin a package script has first
  // on PATH, while one is being followed.
  private binDirs: string[] = [];
  refused?: string;
  private visits = new Set<string>();
  private besides = new Set<string>();
  private wraps = 0;
  // Each function a script defines, by the line it's defined on.
  private functions = new Map<string, number>();
  // Daybreak 153 (21 Nov 2026): what it writes, each file by its absolute
  // path with where, and what it runs, sources, loads or hashes as code.
  // A file in both is one whose bytes as they'll run were never hashed
  // (`cp payload.dat run.sh; sh run.sh`), so settleWrites fails closed.
  // `somewhere`: a write to a place worked out as it runs (or by the data,
  // as `tar x` and `git checkout` do), which could be any of them.
  readonly written = new Map<string, string>();
  writesSomewhere?: string;
  writeFailed?: string;
  readonly reached = new Set<string>();
  // Writes to a path made from variables, settled at the end (Writes).
  private pendingWrites: Pending[] = [];
  // Functions any script followed defines, for what they're handed.
  private definedFns = new Set<string>();
  private writesDepth = 0;
  private exported = new Set<string>();
  private cleared = new Set<string>();
  private deps = new Map<string, Deps>();
  private assignsAny = false;
  private home: string;
  private o: FollowOptions;
  readonly reads: Reads;
  constructor(o: FollowOptions) {
    this.o = o;
    this.home = o.home ?? os.homedir();
    this.reads = o.reads ?? new Reads();
  }

  private text(file: string): string | undefined {
    const real = this.reads.real(file);
    return real === undefined ? undefined : this.reads.text(real);
  }

  private rel(file: string): string {
    const r = path.relative(this.o.top, file);
    return r && !r.startsWith('..') ? r : file;
  }

  private fail(ctx: Ctx | undefined, line: number | undefined, what: string): void {
    if (this.problem) return;
    this.problem = ctx ? `${ctx.label}${line ? ` line ${line}` : ''} ${what}` : what;
  }

  // By the path as written, else by its real one: /tmp/R is /private/tmp/R
  // on macOS, and a path the lexical test put outside the repo ran a repo
  // file unfollowed (Codex's review, 6 Nov). A path that isn't there yet
  // goes by its nearest folder that is.
  private inRepo(p: string): boolean {
    const inside = (q: string) => {
      const rel = path.relative(this.o.top, q);
      return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
    };
    return inside(p) || inside(realOrNearest(p));
  }

  // Windows: every file in `dir` that a program run by a bare name could
  // turn out to be (runnableNames), hashed, and the folder's list of them
  // watched (Reads.runnables). cmd.exe, and Windows' own lookup a program
  // like node uses, try the folder a command runs in before PATH unless
  // NoDefaultCurrentDirectoryInExePath is set, which the runner sets but a
  // script can drop for what it starts in many ways (Codex's fourth review,
  // 19 Nov 2026): this way, a program a pull drops there changes the hash
  // whatever the script did to the variable.
  private besideRun(dir: string, ctx?: Ctx, line?: number): void {
    if (!IS_WINDOWS || this.problem || this.besides.has(dir) || !this.inRepo(dir)) return;
    this.besides.add(dir);
    const names = this.reads.runnables(dir);
    if (!names) return;
    for (const n of names) {
      const real = this.reads.real(path.join(dir, n));
      if (real === undefined || !isFile(real)) continue;
      this.reads.read(real);
      this.files.add(real);
      if (this.files.size > MAX_SCRIPT_FILES) return this.fail(ctx, line, `runs commands in ${this.rel(dir) || 'the repo'}, which has more files Windows could run by name than patch trust follows.`);
    }
  }

  // Hashes a file of the repo's and follows it by its kind. `how`: it runs
  // (its own process), it's sourced into `ctx`'s shell, it's loaded as
  // code or config (an import, a package.json a package script runs from),
  // or it's only named (an argument, a string): then it's hashed only if
  // it's code (looksRunnable), and only a script is followed.
  follow(file: string, how: 'run' | 'source' | 'load' | 'named', ctx: Ctx | undefined, line?: number): void {
    if (this.problem) return;
    const abs = path.resolve(file);
    if (how !== 'named' || looksRunnable(abs)) this.reached.add(abs);
    if (!this.inRepo(abs)) {
      // npm's own script run through node is npm, with none of its checks
      // (Codex's fourth review, 19 Nov 2026).
      if (IS_WINDOWS && how === 'run' && PACKAGE_MANAGER_ENTRY.test(slashes(abs))) return this.fail(ctx, line, `runs ${path.basename(abs)}, a package manager, which on Windows runs package scripts with cmd.exe, so patch trust can't follow it.`);
      return this.noteOutside(abs, how, ctx, line);
    }
    if (how === 'named' && !looksRunnable(abs)) return;
    const passive = how === 'named' || how === 'load';
    const found = this.reads.real(abs);
    if (found === undefined) {
      if (this.missing.size < 500) this.missing.add(abs);
      if (!passive) this.fail(ctx, line, `runs ${this.rel(abs)}, which isn't a file in the repo now, so patch trust can't see what it'll be.`);
      return;
    }
    const real = found;
    let st: fs.Stats;
    try {
      st = fs.statSync(real);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    this.files.add(real);
    if (this.files.size > MAX_SCRIPT_FILES) return this.fail(undefined, undefined, `what it runs reaches more than ${MAX_SCRIPT_FILES} files, more than patch trust follows.`);
    const depth = (ctx?.depth ?? 0) + 1;
    if (depth > MAX_DEPTH) return this.fail(ctx, line, `runs scripts more than ${MAX_DEPTH} deep, more than patch trust follows.`);
    const dirs = ctx && !ctx.lost ? [...ctx.dirs].sort().join('\n') : this.o.folder;
    // By the path as named too: a shell script's $0 and BASH_SOURCE are
    // that, not where a link leads, so its `$(dirname "$0")/x.sh` is beside
    // the link.
    const key = `${how} ${real} ${abs} ${dirs}`;
    if (this.visits.has(key)) return;
    if (this.visits.size >= MAX_VISITS) return this.fail(undefined, undefined, `what it runs is more than patch trust follows.`);
    this.visits.add(key);
    const text = this.reads.text(real);
    if (text === undefined) {
      if (this.reads.tooBig.has(real)) this.fail(ctx, line, `reaches ${this.rel(real)}, over ${MAX_READ_BYTES / 1024 / 1024} MB, more than patch trust reads.`);
      return;
    }
    const kind = kindOf(real, text, !passive);
    const label = this.rel(real);
    if (kind === 'binary') {
      if (!passive) this.fail(ctx, line, `runs ${label}, a program patch trust can't read.`);
      return;
    }
    if (kind === 'other') {
      if (!passive) this.fail(ctx, line, `runs ${label}, which isn't a shell script or JavaScript, so patch trust can't follow what it loads.`);
      return;
    }
    const startDirs = ctx && !ctx.lost ? new Set(ctx.dirs) : new Set([this.o.folder]);
    if (passive) startDirs.add(path.dirname(real));
    if (kind === 'js') {
      const shebang = /^#!(.*)/.exec(text)?.[1] ?? '';
      if (LOADING_FLAG.test(shebang.replace(/^\S+/, ''))) return this.fail(undefined, undefined, `${label}'s #! line loads other code by a flag (${shebang.trim()}), which patch trust doesn't follow.`);
      return this.js(real, text, startDirs, depth);
    }
    // A #! that makes the shell read its commands from elsewhere (`-s`
    // reads its input, `-c` its arguments, `-i` rc files), or env -S.
    if (!passive && shebangReadsElsewhere(text)) return this.fail(ctx, line, `runs ${label}, whose #! line makes the shell read its commands from somewhere else, which patch trust can't follow.`);
    // A shell script is lexed whole, again for each command that reaches
    // it: one too big for a script fails closed.
    if (text.length > MAX_CONFIG_BYTES) return this.fail(ctx, line, `runs ${label}, a shell script over ${MAX_CONFIG_BYTES / 1024} KB, more than patch trust reads.`);
    if (how === 'source' && ctx) {
      this.dependsOn(`#args:${abs}`, { direct: false, names: [`#args:${ctx.file}`] });
      return this.shell(text, { ...ctx, label, file: abs, argv0: [...ctx.argv0, abs], depth });
    }
    this.shell(text, { label, file: abs, argv0: [abs], dirs: startDirs, vars: new Map(), depth });
  }

  // A script outside the repo this reaches (FollowOptions.outside). A
  // program (/usr/bin/git, a brew binary) isn't one: its bytes change with
  // every upgrade, and programs aren't followed anyway.
  private noteOutside(abs: string, how: 'run' | 'source' | 'load' | 'named', ctx: Ctx | undefined, line: number | undefined): void {
    if (how !== 'named' || looksRunnable(abs)) this.reached.add(abs);
    if (!this.o.outside || this.outside.size >= MAX_SCRIPT_FILES) return;
    if (how === 'named' && !looksRunnable(abs)) return;
    const real = this.reads.real(abs);
    if (real === undefined || !isFile(real) || isBinary(real)) return;
    // It keeps the folder it was run from, so its `. ./helper.sh` is there,
    // not beside it (Codex's review, 7 Nov).
    if (ctx?.lost) return this.fail(ctx, line, `runs ${abs} after a cd patch trust couldn't follow (${ctx.lost}), so it can't tell what that script's relative paths are.`);
    const dirs = this.outside.get(real) ?? new Set<string>();
    for (const d of ctx ? ctx.dirs : [this.o.folder]) dirs.add(d);
    this.outside.set(real, dirs);
    // It's followed as a process of its own, later, but a sourced one can
    // change this shell's folder and variables, so what's run after it here
    // can't be told (hashed all the same, above).
    if (how === 'source') this.fail(ctx, line, `sources ${abs}, outside the repo, whose changes to this shell patch trust can't follow.`);
  }

  // Bare imports and `node --import x`: what the repo commits under
  // node_modules (tracked-packages.ts), and a package that's a link to a
  // folder of the repo's. A workspace or `file:` package is what npm links
  // like that, and Node follows the link, so its files are the repo's to
  // change, though nothing under node_modules is (Daybreak, 7 Nov). A
  // package npm installed is neither, and isn't hashed (Mike's call, 7 Nov).
  private barePackage(fromDir: string, spec: string, ctx: Ctx, label: string): void {
    if (isBuiltin(spec) || spec.startsWith('node:')) return;
    // Node's self-reference needs neither git nor a node_modules.
    const own = this.ownPackage(fromDir, spec);
    if (own) return this.fail(undefined, undefined, `${label} imports ${spec}, its own package by name, which ${own}'s \`exports\` send to a file by rules patch trust doesn't follow. Import the file by a plain path.`);
    const bare = bareImport(fromDir, spec, this.o.top, this.reads);
    if (bare && 'problem' in bare) return this.fail(undefined, undefined, `${label} imports ${spec}, and ${bare.problem}`);
    for (const f of bare?.files ?? []) this.follow(f, 'load', ctx);
    if (this.problem) return;
    // All of them, not only the one it names, as an installed package may
    // import one too (Codex's review, 7 Nov), as for what's committed.
    const links = linkedPackages(fromDir, this.o.top, this.reads);
    for (const linked of links) {
      const code = packageFiles(linked, MAX_SCRIPT_FILES);
      if ('problem' in code) return this.fail(undefined, undefined, `${label} imports ${spec}, and ${this.rel(linked)}, a package the repo links into node_modules: ${code.problem}`);
      // Whatever they look like, as its manifest can export any of them.
      for (const f of code.files) this.follow(f, 'load', ctx);
      if (this.problem) return;
    }
    // What decides which of those files runs as code: a file Node would run
    // that the follower reads as data was hashed, but what it loads wasn't.
    const manifests = [...links, ...(bare?.files ?? []).filter((f) => path.basename(f) === 'package.json').map((f) => path.dirname(f))];
    for (const dir of manifests) {
      const odd = this.exportedOddly(dir);
      if (odd) return this.fail(undefined, undefined, `${label} imports ${spec}, and ${this.rel(dir)}'s package.json points at ${odd}, which isn't JavaScript patch trust can follow, though Node would run it.`);
    }
    const sub = this.oddSubpath(fromDir, spec);
    if (sub) this.fail(undefined, undefined, `${label} imports ${spec}, ${this.rel(sub)}, which isn't JavaScript patch trust can follow, though Node would run it.`);
  }

  // The file a bare import names directly in a node_modules (`wsp/payload`,
  // or `payload` for a file there of that name), when it's the repo's and
  // not JavaScript: require() runs any file it's given by its exact name as
  // CommonJS.
  private oddSubpath(fromDir: string, spec: string): string | undefined {
    for (let d = fromDir; this.inRepo(d); d = path.dirname(d)) {
      const real = this.reads.real(path.join(d, 'node_modules', spec));
      if (real !== undefined && isFile(real) && this.inRepo(real)) {
        if (path.extname(real) === '.json' || JS_EXT.includes(path.extname(real))) return undefined;
        // Installed packages stay as they are: only the repo's own.
        const t = bareImport(fromDir, spec, this.o.top, this.reads);
        const committed = t && !('problem' in t) && t.files.includes(real);
        return committed || !inNodeModules(path.relative(this.o.top, real)) ? real : undefined;
      }
      if (d === this.o.top || path.dirname(d) === d) break;
    }
    return undefined;
  }

  // The package.json a bare import is its own package's by name, when Node
  // would resolve it through that: the nearest one up has this `name` and an
  // `exports` (Node's self-reference), so it loads a file of the repo's no
  // lookup in node_modules finds, as a pull renaming a package can arrange
  // (patches' own imports are refused the same way, verified-imports.ts).
  // Read and noticed, not hashed: an install writes package.json too.
  private ownPackage(fromDir: string, spec: string): string | undefined {
    if (inNodeModules(path.relative(this.o.top, fromDir))) return undefined;
    const parts = spec.split('/');
    const name = (spec.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
    for (let d = fromDir; this.inRepo(d); d = path.dirname(d)) {
      const real = this.reads.real(path.join(d, 'package.json'));
      if (real !== undefined && isFile(real)) {
        try {
          const pkg = JSON.parse(this.reads.text(real) ?? '') as { name?: unknown; exports?: unknown };
          return pkg?.name === name && pkg.exports !== undefined && pkg.exports !== null ? this.rel(real) : undefined;
        } catch {
          return undefined;
        }
      }
      if (d === this.o.top || path.dirname(d) === d) break;
    }
    return undefined;
  }

  // A file a linked package's manifest names as what loads (`exports`,
  // `main`, `module`, `bin`) that isn't one the follower reads as
  // JavaScript: a CommonJS file with no extension runs all the same.
  private exportedOddly(pkgDir: string): string | undefined {
    const real = this.reads.real(path.join(pkgDir, 'package.json'));
    if (real === undefined || !isFile(real)) return undefined;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(this.reads.text(real) ?? '') as Record<string, unknown>;
    } catch {
      return this.rel(real);
    }
    const out: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') out.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    for (const k of ['exports', 'main', 'module', 'bin']) walk(pkg?.[k]);
    for (const v of out) {
      // A pattern: only one that says it ends in JavaScript can be told apart.
      if (v.includes('*')) {
        if (!JS_EXT.includes(path.extname(v)) && path.extname(v) !== '.json') return v;
        continue;
      }
      const p = path.resolve(pkgDir, v);
      if (isFile(p) && !JS_EXT.includes(path.extname(p)) && path.extname(p) !== '.json') return v;
    }
    return undefined;
  }

  // Everything the repo commits under node_modules, once a package manager
  // runs: its scripts' programs come from node_modules/.bin, an install runs
  // the lifecycle scripts of what's there, and `npx x` what x's bin says, so
  // a committed package's bytes run without any import naming them.
  private committedPackages(fromDir: string, ctx: Ctx, line: number): void {
    const bare = bareImport(fromDir, ANY_PACKAGE, this.o.top, this.reads);
    if (!bare) return;
    if ('problem' in bare) {
      // git can't say, which only matters with a node_modules on the way up
      // for a package manager to use: an import has to be refused anyway.
      for (let d = fromDir; this.inRepo(d); d = path.dirname(d)) {
        if (this.reads.real(path.join(d, 'node_modules')) !== undefined) return this.fail(ctx, line, `runs a package manager, and ${bare.problem}`);
        if (d === this.o.top || path.dirname(d) === d) break;
      }
      return;
    }
    // Those a shell would run by name are what they'd be run as: a committed
    // .bin file with no #! runs as a shell script, though it reads as data.
    for (const f of bare.files) this.follow(f, path.basename(path.dirname(f)) === '.bin' ? 'run' : 'load', ctx, line);
  }

  // What the repo commits under node_modules, with a lifecycle script of its
  // own: `npm rebuild` or an install runs those from that package's folder,
  // and one may run a file of the repo's that isn't under node_modules at all.
  private committedLifecycle(fromDir: string, ctx: Ctx, line: number): void {
    const bare = bareImport(fromDir, ANY_PACKAGE, this.o.top, this.reads);
    if (!bare || 'problem' in bare) return;
    for (const f of bare.files) {
      if (path.basename(f) !== 'package.json') continue;
      try {
        this.runScripts(path.dirname(f), JSON.parse(this.text(f) ?? '') as Record<string, any>, LIFECYCLE, ctx);
      } catch {
        this.fail(ctx, line, `installs ${this.rel(f)}, which can't be read, so patch trust can't tell what it runs.`);
      }
      if (this.problem) return;
    }
  }

  // The file a program name is in a package's node_modules/.bin, when it's
  // a link to a file of the repo's outside node_modules (a workspace
  // package's bin). A committed one is hashed with the rest
  // (committedPackages), and an installed one isn't, by design.
  private repoBin(name: string, dirs: Iterable<string>): string | undefined {
    if (!/^[\w@.+-]+$/.test(name)) return undefined;
    for (const dir of dirs) {
      for (let d = dir; this.inRepo(d); d = path.dirname(d)) {
        const real = this.reads.real(path.join(d, 'node_modules', '.bin', name));
        if (real !== undefined) return this.inRepo(real) && !inNodeModules(path.relative(this.o.top, real)) ? real : undefined;
        if (d === this.o.top || path.dirname(d) === d) break;
      }
    }
    return undefined;
  }

  private js(file: string, text: string, dirs: Set<string>, depth: number): void {
    const scan = this.o.scanJs(text, file);
    const label = this.rel(file);
    if (scan.problem) return this.fail(undefined, undefined, `${label}: ${scan.problem}`);
    // Commands it runs itself aren't followed from JavaScript, which a
    // Claude Code hook (FollowOptions.strict) can't leave out.
    // The parsed strings too, which a `\u0070` in a name has been decoded in.
    // An escape (`B\u0075n`, "child_\x70rocess") can spell any of those.
    if (this.o.strict && (/child_process|\bBun\b|\bDeno\b|\bprocess\s*\.\s*(binding|dlopen)\b|\\(u[0-9a-fA-F{]|x[0-9a-fA-F]{2}|[0-7])/.test(text) || scan.strings.some((x) => /child_process|worker_threads|^(node:)?(vm|module|cluster|inspector)$/.test(x)))) {
      return this.fail(undefined, undefined, `${label} runs other commands or native code itself, which a hash can't follow. Run them from a shell script instead.`);
    }
    // On Windows a program it starts with an environment of its own loses
    // NoDefaultCurrentDirectoryInExePath, and may be run from wherever it
    // says (Codex's fourth review, 19 Nov 2026).
    if (IS_WINDOWS && /child_process|\bexeca\b|cross-spawn|\bzx\b|shelljs|\bBun\b|\bDeno\b/.test(text) && (/(?<!process\s*\.\s*)\benv\b|nodefaultcurrentdirectoryinexepath/i.test(text) || /\\(u[0-9a-fA-F{]|x[0-9a-fA-F]{2})/.test(text))) {
      return this.fail(undefined, undefined, `${label} starts programs with an environment of its own, which on Windows lets one run from the folder it's in, so patch trust can't tell what runs. Leave env out, or run them from a shell script.`);
    }
    for (const d of [...dirs, path.dirname(file)]) this.besideRun(d);
    const ctx: Ctx = { label, file, argv0: [file], dirs, vars: new Map(), depth };
    for (const spec of scan.specifiers) {
      const target = this.o.resolveImport(path.dirname(file), spec);
      // require() runs a file it's given by its exact name as CommonJS,
      // whatever it's called, but read as data what it loads isn't followed.
      const ext = path.extname(target);
      if (this.inRepo(target) && isFile(target) && !JS_EXT.includes(ext) && ext !== '.json') return this.fail(undefined, undefined, `${label} loads ${this.rel(target)}, which isn't JavaScript patch trust can follow, though Node would run it.`);
      this.follow(target, 'load', ctx);
    }
    // A package inside the repo: what the repo commits under node_modules
    // is its own code, hashed and followed; an installed one isn't.
    for (const spec of scan.packages ?? []) {
      this.barePackage(path.dirname(file), spec, ctx, label);
      if (this.problem) return;
    }
    this.namedIn(text, file, ctx);
    // A string naming a file of the repo's (`spawnSync('bash', ['scripts/x.sh'])`).
    for (const raw of scan.strings) {
      if (raw.length > 300 || !/[./]/.test(raw) || /[\s\0]/.test(raw) || (IS_WINDOWS ? /^[a-z]{2,}:/i : /^[a-z]+:/i).test(raw)) continue;
      const spelled = IS_WINDOWS ? windowsSpelling(raw) : { path: raw };
      if (!('path' in spelled)) continue;
      const s = spelled.path;
      const bases = path.isAbsolute(s) ? [''] : [path.dirname(file), ...dirs, this.o.top];
      for (const b of bases) {
        const p = path.resolve(b, s);
        if (isFile(p)) this.follow(p, 'named', ctx);
        else if (s.includes('/') && [...SHELL_EXT, ...JS_EXT].includes(path.extname(s)) && this.missing.size < 500 && this.inRepo(p)) this.missing.add(p);
      }
    }
  }

  // `./` and `../` paths anywhere in a file's text, from its folder and the
  // folders it runs in: extra matches only add files to the hash.
  private namedIn(text: string, file: string, ctx: Ctx): void {
    for (const spec of this.o.namedPaths(text)) {
      for (const b of new Set([path.dirname(file), ...(ctx.lost ? [] : ctx.dirs)])) {
        const p = path.resolve(b, spec);
        if (isFile(p)) this.follow(p, 'named', ctx);
      }
    }
  }

  shell(text: string, ctx: Ctx, lineBase = 1): void {
    if (this.problem) return;
    // By the text, comment lines aside, so no form of assignment or
    // name worked out as it runs gets past (Codex's fourth review).
    const code = text.replace(/^[ \t]*#.*$/gm, '');
    if (HOME_SET.test(code)) return this.fail(ctx, undefined, "sets HOME (in arithmetic or let), so ~ and $HOME name another folder from then on, which patch trust doesn't follow.");
    const msys = IS_WINDOWS ? MSYS_SET.exec(code) : null;
    if (msys) return this.fail(ctx, undefined, `sets ${/MSYS2?_\w+/.exec(msys[0])?.[0] ?? 'an MSYS variable'}, which changes how Git Bash hands paths to programs, so patch trust can't tell which file one names.`);
    // CDPATH makes `cd x` go somewhere else than ./x (Codex's sixth review).
    if (/\bCDPATH\b/.test(code)) return this.fail(ctx, undefined, "uses CDPATH, which makes cd go to folders patch trust can't follow.");
    if (IS_WINDOWS && /nodefaultcurrentdirectoryinexepath/i.test(code)) return this.fail(ctx, undefined, "names NoDefaultCurrentDirectoryInExePath, which keeps cmd.exe from running a program from the folder it's in, so patch trust can't tell what a command name runs.");
    for (const m of code.matchAll(/(?:^|[;&|{(\n])[ \t]*(?:function[ \t]+)?([A-Za-z_][\w-]*)[ \t]*\([ \t]*\)|\bfunction[ \t]+([A-Za-z_][\w-]*)/g)) {
      if (this.definedFns.size < 500) this.definedFns.add((m[1] ?? m[2])!);
    }
    let lexed: Lexer;
    try {
      lexed = new Lexer(text, lineBase).run();
    } catch (e) {
      return this.fail(ctx, undefined, `can't be read as a shell script (${(e as Error).message}), so patch trust can't follow what it runs.`);
    }
    // The functions a script defines are its own words, not programs on
    // PATH (FollowOptions.strict): `name ()` and `function name`, as the
    // lexer reads them, so a comment or a here-doc doesn't define one.
    // Only at a command's start, and only for this script's own commands:
    // a shell it starts (`sh -c`) doesn't have them.
    const outer = this.functions;
    if (this.o.strict) {
      // A command substitution is the same shell's, so it has them too.
      this.functions = ctx.inSub ? new Map(outer) : new Map();
      const t = lexed.toks;
      // A function defined in a subshell `( ... )` is gone after it.
      let depth = 0;
      for (let i = 0; i < t.length; i++) {
        const a = t[i];
        const before = t[i - 1];
        if (a.t === 'op' && a.op === '(' && !(before?.t === 'word' && t[i + 1]?.t === 'op' && (t[i + 1] as { op: string }).op === ')')) depth++;
        else if (a.t === 'op' && a.op === ')' && !(t[i - 1]?.t === 'op' && (t[i - 1] as { op: string }).op === '(' && t[i - 2]?.t === 'word')) depth = Math.max(0, depth - 1);
        if (depth > 0) continue;
        if (a.t !== 'word' || (before && !(before.t === 'op' && [';', '\n', '&&', '||', '&', '{', '(', ')', '|'].includes(before.op)))) continue;
        const name = bareOf(a.w);
        if (!name) continue;
        const b = t[i + 1];
        const c = t[i + 2];
        if (b?.t === 'op' && b.op === '(' && c?.t === 'op' && c.op === ')' && !this.functions.has(name)) this.functions.set(name, a.w.line);
        if (name === 'function' && b?.t === 'word') {
          const f = bareOf(b.w);
          if (f && !this.functions.has(f)) this.functions.set(f, a.w.line);
        }
      }
    }
    try {
      this.shellBody(text, lexed, ctx);
    } finally {
      this.functions = outer;
    }
  }

  private shellBody(text: string, lexed: Lexer, ctx: Ctx): void {
    this.namedIn(text, ctx.file, ctx);
    for (const x of lexed.extra) this.shell(x.src, { ...ctx, inSub: true }, x.line);
    for (const cmd of simpleCommands(lexed.toks)) {
      // Past a problem, nothing more is followed, but what the rest writes
      // still counts: `go() { sh new.sh; }; cp payload.dat new.sh; go`
      // stopped at the missing new.sh before it saw the copy (Gemini's
      // review), and a write problem is the one no approval gets past.
      if (this.problem) this.writesOnly(cmd, ctx);
      else this.command(cmd, ctx);
    }
  }

  // The values a word can have, or undefined when it's worked out as it runs.
  private values(w: Word, ctx: Ctx): string[] | undefined {
    let outs = [''];
    for (const [n, p] of w.parts.entries()) {
      let vals: string[] | undefined;
      if (p.k === 'lit') {
        // ~ at the start, alone or before a /, is home.
        const next = w.parts[1];
        const tilde = n === 0 && !p.q && p.s === '~' && (!next || (next.k === 'lit' && next.s.startsWith('/')));
        vals = [tilde ? this.home : p.s];
      } else if (p.k === 'var') vals = this.varValues(p.name, p.op, ctx);
      else if (p.k === 'sub') vals = this.subValues(p.src, ctx, p.line);
      if (!vals) return undefined;
      outs = outs.flatMap((o) => vals!.map((v) => o + v)).slice(0, 16);
    }
    return outs;
  }

  private varValues(name: string, op: string, ctx: Ctx): string[] | undefined {
    let vals: string[] | undefined;
    if (name === '' && /^\(%\):-%[xN]$/.test(op)) return [ctx.file];
    if (name === '0') vals = ctx.argv0.length ? ctx.argv0 : undefined;
    else if (name === 'BASH_SOURCE' || name === 'BASH_SOURCE[0]') vals = [ctx.file];
    else if (name === 'HOME') vals = [this.home];
    else if (name === 'PWD') vals = ctx.lost ? undefined : [...ctx.dirs];
    else if (name === 'PATH' && !ctx.vars.has('PATH')) vals = [PATH_SENTINEL];
    else vals = ctx.vars.get(name);
    if (op === '') return vals;
    // `${x:-d}` is d where x is empty (or unset, for `-`); `${x:+w}` is w where it isn't.
    if (/^:?[-=]/.test(op)) {
      const d = op.replace(/^:?[-=]/, '');
      if (!vals || /[$`]/.test(d)) return vals;
      return vals.map((v) => (v === '' && op.startsWith(':') ? plainDefault(d) : v));
    }
    if (/^:?\+/.test(op)) {
      const d = op.replace(/^:?\+/, '');
      if (!vals || /[$`]/.test(d)) return vals && vals.every((v) => v === '') ? vals : undefined;
      return vals.map((v) => (v === '' ? '' : plainDefault(d)));
    }
    if (!vals) return undefined;
    if (op === '%/*' || op === ':h') return vals.map((v) => path.dirname(v));
    if (op === ':A' || op === ':a') return vals.map((v) => path.resolve(v));
    if (op === ':A:h' || op === ':a:h') return vals.map((v) => path.dirname(path.resolve(v)));
    return undefined;
  }

  // What a $(...) gives, for the few a script uses to find its own folder.
  private subValues(src: string, ctx: Ctx, line: number): string[] | undefined {
    let cmds: Simple[];
    try {
      cmds = simpleCommands(new Lexer(src, line).run().toks);
    } catch {
      return undefined;
    }
    // Each word's values; the last word's can be several (a sourced
    // script's $0 is its caller's or its own).
    const words = (c: Simple) => {
      if (!c.words.length) return undefined;
      const v = c.words.map((w) => this.values(w, ctx));
      return v.every(Boolean) ? (v as string[][]) : undefined;
    };
    const fixed = (v: string[][]) => v.slice(0, -1).every((x) => x.length === 1);
    const absAll = (vs: string[]) => {
      const out = vs.map((x) => this.abs(x, ctx));
      return out.every(Boolean) ? out.flat() as string[] : undefined;
    };
    if (cmds.length === 1) {
      const w = words(cmds[0]!);
      if (!w || !fixed(w)) return undefined;
      const name = w[0]![0];
      const last = w.at(-1)!;
      if (name === 'dirname' && w.length === 2) return last.map((x) => path.dirname(x));
      if ((name === 'realpath' || name === 'grealpath') && w.length === 2) return absAll(last);
      if (name === 'readlink' && w[1]![0] === '-f' && w.length === 3) return absAll(last);
      if (name === 'pwd') return ctx.lost ? undefined : [...ctx.dirs];
      if (w.map((x) => x[0]).join(' ') === 'git rev-parse --show-toplevel') return [this.o.top];
      return undefined;
    }
    if (cmds.length === 2) {
      const a = words(cmds[0]!);
      const b = words(cmds[1]!);
      if (a && b && fixed(a) && a[0]![0] === 'cd' && b[0]![0] === 'pwd') {
        const target = a.slice(1).filter((x) => !x[0]!.startsWith('-'));
        if (target.length === 1) return absAll(target[0]!);
      }
    }
    return undefined;
  }

  // `v` as a path to look at: on Windows, the drive and temp spellings Git
  // Bash reads (windowsSpelling) as the paths they are. A UNC or device
  // path is the problem itself (this.problem is set, and what's returned
  // is undefined), so whatever the caller does next, it fails closed.
  private spell(v: string, ctx: Ctx | undefined, line?: number): string | undefined {
    if (!IS_WINDOWS) return v;
    const s = windowsSpelling(v);
    if ('refuse' in s) {
      const shown = v.length > 80 ? v.slice(0, 80) + '...' : v;
      this.refused ??= `${shown}, ${s.refuse}`;
      this.fail(ctx, line, `names ${shown}, ${s.refuse}, which patch trust can't follow.`);
      return undefined;
    }
    return s.path;
  }

  private abs(v: string, ctx: Ctx): string[] | undefined {
    const w = this.spell(v, ctx);
    if (w === undefined) return undefined;
    if (path.isAbsolute(w)) return [path.normalize(w)];
    if (ctx.lost) return undefined;
    return [...ctx.dirs].map((d) => path.resolve(d, w));
  }

  // Hashes every file of the repo's a word names.
  private named(w: Word, ctx: Ctx): void {
    const vals = this.values(w, ctx);
    for (const v of vals ?? []) {
      if (!v || v.length > 1024 || v.includes('\n') || v === PATH_SENTINEL) continue;
      // An argument only names a file; a UNC one isn't looked for (a
      // program that runs it is refused where it runs, in abs).
      const spelled = IS_WINDOWS ? windowsSpelling(v) : { path: v };
      if (!('path' in spelled)) continue;
      const s = spelled.path;
      for (const p of (path.isAbsolute(s) ? [s] : ctx.lost ? [] : [...ctx.dirs].map((d) => path.resolve(d, s)))) {
        if (isFile(p)) this.follow(p, 'named', ctx);
      }
    }
  }

  private subsOf(w: Word, ctx: Ctx): void {
    for (const p of w.parts) if (p.k === 'sub') this.shell(p.src, { ...ctx, inSub: true }, p.line);
  }

  private assign(name: string, value: Word | undefined, append: boolean, ctx: Ctx, line: number): void {
    const vals = value ? this.values(value, ctx) : [''];
    // A plain `$(mktemp)` is a new file in the temp folder, nobody's to steer.
    const temp = !append && value?.parts.length === 1 && value.parts[0]!.k === 'sub' && PLAIN_MKTEMP.test(value.parts[0]!.src);
    this.dependsOn(name, temp ? { direct: false, names: [], values: [path.join(os.tmpdir(), 'mktemp')] } : vals ? { direct: false, names: [], values: vals } : this.depsOf(value!, ctx));
    if (RISKY_ENV.has(name)) return this.fail(ctx, line, `sets ${name}, which makes other code load, so patch trust can't follow what runs.`);
    if (this.unfollowableVar(name, ctx, line)) return;
    if (name === 'NODE_OPTIONS' && (!vals || vals.some((v) => LOADING_FLAG.test(v)))) return this.fail(ctx, line, 'sets NODE_OPTIONS to load other code, which patch trust can\'t follow.');
    if (name === 'PATH' || name === 'path') {
      // An empty entry is the current folder (a leading or trailing `:`, or
      // `::`), so it's left in to be refused, as `.` is (Codex's review, 7 Nov).
      // On Windows each as Git Bash reads it (/c/repo/bin is C:\repo\bin);
      // a network or device one can't be vouched for (Codex's review).
      const entries = vals?.flatMap((v) => (name === 'PATH' ? v.split(':') : v.split(' '))).map((e) => {
        if (!IS_WINDOWS || e === PATH_SENTINEL) return e;
        const w = windowsSpelling(e);
        return 'path' in w ? w.path : '';
      });
      const ok = entries?.every((e) => e === PATH_SENTINEL || BIN_DIR.test(e) || (path.isAbsolute(e) && !this.inRepo(e)));
      if (!ok || append) return this.fail(ctx, line, "puts a folder on PATH that patch trust can't vouch for, so it can't tell what a command name runs.");
      // A package's bin folder, as a package script has first on PATH:
      // a name after this may be a program of the repo's, committed or a
      // workspace's, not an installed one (Codex's review, 7 Nov).
      for (const e of entries ?? []) {
        if (e === PATH_SENTINEL || !BIN_DIR.test(e)) continue;
        const bins = this.abs(e, ctx);
        if (!bins) return this.fail(ctx, line, "puts a package's bin folder on PATH after a cd patch trust couldn't follow, so it can't tell what a command name runs.");
        for (const bin of bins) {
          if (!this.inRepo(bin)) continue;
          const pkg = path.dirname(path.dirname(bin));
          this.committedPackages(pkg, ctx, line);
          if (this.problem) return;
          this.binDirs = [...this.binDirs, pkg];
        }
      }
    }
    ctx.vars.set(name, append ? undefined : vals);
  }

  // A variable patch trust can't follow being set, in any way a script can
  // set one (an assignment, a prefix, export, read, for): failed, and true.
  // HOME, as ~, $HOME and a bare cd name the real one throughout (following
  // a script's own, through prefixes, exports and child shells, left holes:
  // Codex's reviews of the Windows port, 18 Nov 2026). And on Windows the
  // ones that turn off Git Bash's rewriting of /c/x to C:\x for a Windows
  // program, after which patch trust reads a path as another file.
  private unfollowableVar(full: string, ctx: Ctx, line: number): boolean {
    // HOME[0] is HOME, as $HOME is its first element.
    const name = full.replace(/\[.*$/s, '');
    if (name === 'HOME') {
      this.fail(ctx, line, "sets HOME, so ~ and $HOME name another folder from then on, which patch trust doesn't follow.");
      return true;
    }
    // The runner sets NoDefaultCurrentDirectoryInExePath for everything it
    // starts on Windows (main.ts), so cmd.exe doesn't run a program from the
    // folder it's in: a script that changes it gets that back.
    if (IS_WINDOWS && /^nodefaultcurrentdirectoryinexepath$/i.test(name)) {
      this.fail(ctx, line, `changes ${name}, which lets cmd.exe run a program from the folder it's in, so patch trust can't tell what a command name runs.`);
      return true;
    }
    if (IS_WINDOWS && /^MSYS2?_(?:ARG_CONV_EXCL|NO_PATHCONV|ENV_CONV_EXCL)$/.test(name)) {
      this.fail(ctx, line, `sets ${name}, which changes how Git Bash hands paths to programs, so patch trust can't tell which file one names.`);
      return true;
    }
    return false;
  }

  // A declaration's or env's argument that bash takes as an assignment but
  // assignment() doesn't (quoted: 'HOME=x'), checked by its name alone.
  // Only the literal start counts, as the value can be anything ("HOME=$PWD").
  private quotedAssignment(w: Word, ctx: Ctx, line: number): boolean {
    let text = '';
    for (const p of w.parts) {
      if (p.k !== 'lit') break;
      text += p.s;
    }
    const m = /^([A-Za-z_]\w*(?:\[[^\]]*\])?)\+?=/.exec(text);
    // `export 'dest=run.sh'` sets dest all the same (Codex's review of 153).
    if (m) this.setsUnknown(m[1]!.replace(/\[.*$/s, ''), ctx);
    else if (w.parts.some((p) => p.k !== 'lit')) this.assignsAny = true;
    return m ? this.unfollowableVar(m[1]!, ctx, line) : false;
  }

  // Splits `NAME=value` off a word, or undefined.
  private assignment(w: Word): { name: string; append: boolean; value: Word } | undefined {
    const first = w.parts[0];
    if (!first || first.k !== 'lit' || first.q) return undefined;
    // The name and = may be split over parts when the lexer reads char by char.
    // Each part is looked at once: the whole text so far was tested again
    // at every part, and the lexer makes a part of each character, so a
    // long word took seconds per 20 KB (Gautam's scan, 6 Nov). Only the
    // part that brings the first `=` can complete an assignment (before
    // it, every character must be a name's, a subscript's or a final +).
    let text = '';
    let plus = false;
    for (let k = 0; k < w.parts.length; k++) {
      const p = w.parts[k]!;
      if (p.k !== 'lit' || p.q) break;
      text += p.s;
      if (p.s.includes('=')) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=/.exec(text);
        if (!m) return undefined;
        const rest = text.slice(m[0].length);
        const parts: Part[] = [...(rest ? [{ k: 'lit' as const, s: rest, q: false }] : []), ...w.parts.slice(k + 1)];
        return { name: m[1]!, append: m[3] === '+', value: { parts, line: w.line } };
      }
      if ((plus && p.s) || !/^[A-Za-z0-9_[\]]*\+?$/.test(p.s)) return undefined;
      plus = p.s.endsWith('+');
    }
    return undefined;
  }

  // The program a simple command's words run, by its base name, past
  // reserved words and assignments; undefined when it can't be told.
  private programOf(words: Word[], ctx: Ctx): string | undefined {
    for (const w of words) {
      if (RESERVED.has(bareOf(w) ?? '') || this.assignment(w)) continue;
      const v = this.str(w, ctx);
      return v === undefined ? undefined : programName(path.basename(v));
    }
    return undefined;
  }

  private command(cmd: Simple, ctx: Ctx): void {
    const line = cmd.line;
    for (const w of [...cmd.words, ...cmd.arrays]) this.subsOf(w, ctx);
    // `${x:=v}` sets x as it expands (Codex's review of 153).
    for (const w of [...cmd.words, ...cmd.arrays, ...cmd.redirs.flatMap((r) => (r.target ? [r.target] : []))]) {
      for (const p of w.parts) if (p.k === 'var' && /^:?=/.test(p.op)) this.setsUnknown(p.name.replace(/\[.*$/s, ''), ctx);
    }
    // A file redirected into a shell may be what it runs (a flag that
    // makes it read commands from its input, missed below), so it's hashed
    // whatever it looks like, not only if it looks like code. Not one into
    // Node: with a script, its input is the script's data, and without one
    // it's refused below.
    const into = this.programOf(cmd.words, ctx);
    const loads = (into !== undefined && (into === '.' || into === 'source')) || cmd.words.some((w) => {
      // Past a wrapper too (`env bash`, `command bash`, `nice sh`).
      const v = litOf(w);
      return v !== undefined && SHELLS.includes(programName(path.basename(v)));
    });
    for (const r of cmd.redirs) {
      if (!r.target) continue;
      this.subsOf(r.target, ctx);
      // `>&2` and `2>&-` move a descriptor; `>& file` writes it.
      if (WRITE_REDIRS.has(r.op) && !(r.op === '>&' && /^(\d+-?|-)$/.test(litOf(r.target) ?? ''))) this.wrote(this.values(r.target, ctx), r.target, ctx, line);
      if (r.op === '<' || r.op === '<>') {
        const v = this.values(r.target, ctx);
        if (!v && ctx.inSub) return this.fail(ctx, line, 'reads a file it works out as it runs (`$(< ...)`), which patch trust can\'t follow.');
        if (loads) for (const p of (v ?? []).flatMap((x) => this.abs(x, ctx) ?? [])) this.follow(p, 'load', ctx, line);
        else this.named(r.target, ctx);
      }
    }
    // Past reserved words (`then`, `do`, `!`, `{`) and `function name`.
    let words = cmd.words;
    const skip = () => {
      const i = words.findIndex((w) => !RESERVED.has(bareOf(w) ?? ''));
      words = i < 0 ? [] : words.slice(i);
    };
    skip();
    if (words.length && bareOf(words[0]!) === 'function') {
      words = words.slice(2);
      skip();
    }
    // Assignments before the command (or alone).
    // By index: dropping one word at a time copied the rest each time, so
    // a long run of `a=1` was quadratic (Codex's review, 6 Nov).
    let k = 0;
    for (; k < words.length; k++) {
      const a = this.assignment(words[k]!);
      if (!a) break;
      this.assign(a.name, a.value, a.append, ctx, line);
      if (this.problem) return;
    }
    words = words.slice(k);
    for (const w of cmd.arrays) this.named(w, ctx);
    if (!words.length) return;
    this.run(words, ctx, line, false);
  }

  // A command's words, from its name. `extra`: xargs adds arguments this
  // can't see.
  // `wrappedIn`: run by a wrapper whose own run named these words already.
  private run(words: Word[], ctx: Ctx, line: number, extra: boolean, wrappedIn = false): void {
    if (this.problem || !words.length) return;
    const head = words[0]!;
    const headVals = this.values(head, ctx);
    const shown = head.parts.map((p) => (p.k === 'lit' ? p.s : p.k === 'var' ? `$${p.name}` : '$(...)')).join('');
    if (!headVals || headVals.length !== 1) return this.fail(ctx, line, `runs a command worked out as it runs (\`${shown}\`), which patch trust can't follow.`);
    const name = headVals[0]!;
    if (name !== '[' && name !== '[[' && head.parts.some((p) => p.k === 'lit' && !p.q && /[*?[{]/.test(p.s))) return this.fail(ctx, line, `runs a command named by a pattern (\`${shown}\`), which patch trust can't follow.`);
    const args = words.slice(1);
    if (this.functions.has(name) || this.definedFns.has(name)) this.handed(args, [ctx.file], ctx);
    else if (name === 'set') {
      // Its options aren't positionals: what follows `--`, or the first word
      // that isn't one (`set -e` sets none; Grok's review).
      const at = args.findIndex((w) => { const v = litOf(w); return v === '--' || v === undefined || !/^[-+]/.test(v); });
      if (at >= 0) this.handed(args.slice(litOf(args[at]!) === '--' ? at + 1 : at), [ctx.file], ctx);
    }
    else if (name.includes('/')) this.handed(args, this.abs(name, ctx) ?? [], ctx);
    else if (SHELLS.includes(programName(path.basename(name))) || name === 'source' || name === '.') {
      // The script is one of its words; each is handed the rest.
      const files = args.flatMap((w) => (this.values(w, ctx) ?? []).flatMap((v) => this.abs(v, ctx) ?? []));
      this.handed(args, files, ctx);
    }
    if (!wrappedIn) for (const w of args) this.named(w, ctx);
    if (this.problem) return;
    // A path: the repo's file runs (followed), or a program outside it,
    // treated by its name (/bin/sh is sh).
    // On Windows a backslash names a folder too: a quoted 'C:\repo\x.exe'
    // keeps them, and bash runs it as a path (Codex's review).
    if (name.includes('/') || (IS_WINDOWS && name.includes('\\'))) {
      const targets = this.abs(name, ctx);
      if (!targets) return this.fail(ctx, line, `runs ${name} after a cd patch trust couldn't follow (${ctx.lost}), so it can't tell which file that is.`);
      const inRepo = targets.filter((t) => this.inRepo(t));
      for (const t of targets) this.reached.add(t);
      if (inRepo.length) {
        const found = inRepo.filter(isFile);
        // A missing one that could turn up as a program: a runnable
        // extension, or none. Not a data file's name: every string a patch
        // has is followed as a command, so `'.cache/state.json'` lands here.
        for (const t of inRepo) if (!isFile(t) && mayRun(t) && this.missing.size < 500) this.missing.add(t);
        if (!found.length) return this.fail(ctx, line, `runs ${name}, which isn't a file in the repo now, so patch trust can't see what it'll be.`);
        // A file that isn't code can't run as a command (it has no
        // executable bit): not hashed, and anything that runs by itself
        // refuses it, as before.
        const code = found.filter(looksRunnable);
        if (!code.length) return this.fail(ctx, line, `runs ${name}, which isn't a shell script or JavaScript, so patch trust can't follow what it loads.`);
        for (const t of code) this.follow(t, 'run', ctx, line);
        return;
      }
      // /dev/fd/3 after `exec 3< ./x.sh` is x.sh.
      if (targets.some(readsInput)) return this.fail(ctx, line, `runs ${name}, which is a file it has open, so patch trust can't tell what runs.`);
      for (const t of targets) this.noteOutside(t, 'run', ctx, line);
      return this.program(path.basename(name), args, ctx, line, extra);
    }
    // In a package script, node_modules/.bin comes first on PATH.
    // (A hook's are refused below, or by the short list: nothing more to add.)
    if (!this.o.strict && this.binDirs.length) {
      const bin = this.repoBin(name, this.binDirs);
      if (bin) return this.follow(bin, 'run', ctx, line);
    }
    this.program(name, args, ctx, line, extra);
  }

  private str(w: Word | undefined, ctx: Ctx): string | undefined {
    if (!w) return undefined;
    const v = this.values(w, ctx);
    return v && v.length === 1 ? v[0] : undefined;
  }

  private program(called: string, args: Word[], ctx: Ctx, line: number, extra: boolean): void {
    const name = programName(called);
    // Whatever it is: a builtin's name can be a program's too.
    for (const d of ctx.dirs) this.besideRun(d, ctx, line);
    const a = (i: number) => this.str(args[i], ctx);
    if (Object.hasOwn(UNFOLLOWABLE, name)) return this.fail(ctx, line, `${UNFOLLOWABLE[name]}, which patch trust can't follow.`);
    if (name === 'hash' && args.some((w) => /^-\w*p/.test(this.str(w, ctx) ?? ''))) return this.fail(ctx, line, 'maps a command name to a file (`hash -p`), which patch trust can\'t follow.');
    if (name === 'cd' || name === 'pushd') return this.cd(args, ctx, line);
    if (name === 'source' || name === '.') {
      const target = a(0);
      if (target === undefined) return this.fail(ctx, line, `sources a file worked out as it runs, which patch trust can't follow.`);
      const tries = this.abs(target, ctx);
      if (!tries) return this.fail(ctx, line, `sources ${target} after a cd patch trust couldn't follow (${ctx.lost}).`);
      // In the repo too: a committed link to /dev/stdin is the input.
      if (tries.some(readsInput)) return this.fail(ctx, line, `sources ${target}, which reads what to run from its input, which patch trust can't follow.`);
      for (const t of tries) {
        // There or not, in the repo or not: one the check writes is what runs.
        this.reached.add(t);
        if (isFile(t)) this.follow(t, 'source', ctx, line);
        else if (this.inRepo(t) && this.missing.size < 500) this.missing.add(t);
      }
      return;
    }
    if (name === 'unset') {
      for (const w of args) {
        const v = this.str(w, ctx);
        if (v === undefined) return this.fail(ctx, line, "unsets a variable whose name patch trust can't read.");
        if (!v.startsWith('-') && this.unfollowableVar(v, ctx, line)) return;
        if (!v.startsWith('-') && /^[A-Za-z_]\w*$/.test(v)) {
          ctx.vars.set(v, ['']);
          this.dependsOn(v, { direct: false, names: [], values: [''] });
        }
      }
    }
    // let's expressions assign by their text, so one worked out as it runs could set anything.
    if (name === 'let' && args.some((w) => w.parts.some((p) => p.k !== 'lit'))) return this.fail(ctx, line, "runs let with an expression worked out as it runs, which could set a variable patch trust can't name.");
    if (name === 'let') for (const w of args) for (const m of (litOf(w) ?? '').matchAll(/([A-Za-z_]\w*)\s*(?:[-+*/%^|&]|<<|>>)?=(?!=)|([A-Za-z_]\w*)\s*(?:\+\+|--)|(?:\+\+|--)\s*([A-Za-z_]\w*)/g)) this.setsUnknown((m[1] ?? m[2] ?? m[3])!, ctx);
    if (name === 'printf') {
      // "$option" could be -v (Codex's fourth review).
      if (args[0] && this.str(args[0], ctx) === undefined && args[0].parts.some((p) => p.k !== 'lit')) return this.fail(ctx, line, "runs printf with a first argument worked out as it runs, which could make it set a variable patch trust can't name.");
      const at = args.findIndex((w) => this.str(w, ctx) === '-v');
      const v = at >= 0 ? args[at + 1] && this.str(args[at + 1]!, ctx) : undefined;
      if (at >= 0 && v === undefined) return this.fail(ctx, line, "sets a variable with printf -v whose name patch trust can't read.");
      if (v && this.unfollowableVar(v, ctx, line)) return;
      if (v) this.setsUnknown(v, ctx);
    }
    if (name === 'export' || name === 'local' || name === 'declare' || name === 'typeset' || name === 'readonly' || name === 'integer') {
      // A name reference makes a later assignment to one name write
      // another (declare -n d=HOME; d=x), which isn't followed.
      if (name !== 'export' && args.some((w) => /^[-+][a-zA-Z]*n/.test(litOf(w) ?? ''))) return this.fail(ctx, line, `makes a name reference (${name} -n), which patch trust doesn't follow.`);
      const exports = name === 'export' || args.some((w) => /^-[a-zA-Z]*x/.test(litOf(w) ?? ''));
      for (const w of args) {
        const as = this.assignment(w);
        if (exports) {
          const n = as?.name ?? /^([A-Za-z_]\w*)/.exec(this.str(w, ctx) ?? '')?.[1];
          if (n) this.exported.add(n);
        }
        if (as) this.assign(as.name, as.value, as.append, ctx, line);
        else if (this.quotedAssignment(w, ctx, line)) return;
      }
      return;
    }
    if (name === 'trap') {
      const code = args[0];
      if (!code) return;
      const text = litOf(code);
      if (text === undefined) return this.fail(ctx, line, 'sets a trap worked out as it runs, which patch trust can\'t follow.');
      if (text !== '-' && !/^-[lp]$/.test(text)) this.shell(text, ctx, line);
      return;
    }
    if (name === 'for' || name === 'select') {
      const v = a(0);
      if (v && this.unfollowableVar(v, ctx, line)) return;
      if (v) {
        this.setsUnknown(v, ctx);
      }
      return;
    }
    if (name === 'read' || name === 'getopts' || name === 'mapfile' || name === 'readarray') {
      for (const w of args) {
        const v = this.str(w, ctx);
        if (v && /^[A-Za-z_]\w*(?:\[.*\])?$/s.test(v) && this.unfollowableVar(v, ctx, line)) return;
        if (v && /^[A-Za-z_]\w*$/.test(v)) {
          this.setsUnknown(v, ctx);
        }
      }
      if (name === 'getopts' && args[1]) {
        this.setsUnknown(this.str(args[1], ctx) ?? '', ctx);
      }
      return;
    }
    if (name === 'function') return;
    if (ctx.inSub && name === 'cat') {
      if (args.some((w) => !this.values(w, ctx))) return this.fail(ctx, line, 'reads a file it works out as it runs (`$(cat ...)`), which patch trust can\'t follow.');
      return;
    }
    // Wrappers: what they run is checked the same way.
    const wrapped = this.unwrap(name, args, ctx, line);
    if (wrapped) {
      if (!wrapped.words.length) return;
      // A few deep at most: each one looked at every word after it again,
      // so `env env env ...` was quadratic (Codex's review, 6 Nov).
      if (this.wraps >= 8) return this.fail(ctx, line, "runs a command through more wrappers (env, nice...) than patch trust follows.");
      this.wraps++;
      try {
        return this.run(wrapped.words, ctx, line, extra || wrapped.extra, true);
      } finally {
        this.wraps--;
      }
    }
    if (this.problem) return;
    this.writesOf(name, args, ctx, line, extra);
    if (name === 'find') {
      for (let i = 0; i < args.length; i++) {
        // From each folder it finds, which isn't followed (Codex's sixth review).
        if (/^-(execdir|okdir)$/.test(a(i) ?? '')) return this.fail(ctx, line, 'runs a command from each folder find finds (-execdir), which patch trust can\'t follow.');
        if (!/^-(exec|ok)$/.test(a(i) ?? '')) continue;
        const end = args.findIndex((w, j) => j > i && /^[;+]$/.test(litOf(w) ?? ''));
        this.run(args.slice(i + 1, end < 0 ? args.length : end), ctx, line, false);
      }
      return;
    }
    if (SHELLS.includes(name)) return this.shellRun(name, args, ctx, line, extra);
    if (JS_RUNNERS.includes(name)) return this.jsRun(name, args, ctx, line, extra);
    // On Windows npm, npx, pnpm and yarn run package scripts and programs
    // with cmd.exe, which looks in the folder for a program before PATH (a
    // node.exe beside package.json runs for `node x.js`) and reads a
    // script by its own rules; routes in kept turning up (npx -c, a bare
    // npm install's lifecycle, npm start's implicit server.js: Codex's
    // reviews, 18 Nov 2026), so none is followed there.
    if (IS_WINDOWS && ['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'bunx', 'corepack'].includes(name)) return this.fail(ctx, line, `runs ${name}, which on Windows runs package scripts and programs with cmd.exe, so patch trust can't follow it.`);
    if (['npm', 'pnpm', 'yarn'].includes(name)) return this.pkgRun(name, args, ctx, line);
    if (['npx', 'bunx', 'pnpx'].includes(name)) return this.npx(args, ctx, line);
    if (name === 'make' || name === 'gmake') return this.make(args, ctx, line);
    if (name === 'awk' || name === 'gawk' || name === 'nawk' || name === 'mawk') return this.awk(args, ctx, line);
    if (isOtherLang(name)) return this.fail(ctx, line, `runs ${name}, whose loads patch trust can't follow.`);
    // Anything else: a program on PATH, a builtin or a function in the
    // script (whose body was read with the rest).
    // A function only once it's defined (by line: a call before it runs the program).
    const defined = this.functions.get(name);
    if (this.o.strict && !INERT_PROGRAMS.has(name) && !(defined !== undefined && defined <= line)) {
      return this.fail(ctx, line, `runs ${name}, a program that may load code from the folder by its own rules (its config, plugins or tests), which a hash can't follow. Run a script in the repo instead.`);
    }
  }

  private dependsOn(name: string, d: Deps): void {
    const had = this.deps.get(name);
    if (!had) return void this.deps.set(name, d);
    this.deps.set(name, {
      direct: had.direct || d.direct,
      names: [...new Set([...had.names, ...d.names])],
      ...(had.values || d.values ? { values: [...new Set([...(had.values ?? []), ...(d.values ?? [])])].slice(0, 32) } : {}),
      ...(had.forms || d.forms ? { forms: [...(had.forms ?? []), ...(d.forms ?? [])].slice(0, 16) } : {}),
    });
  }

  // A variable set to something worked out as it runs: whatever it held is forgotten.
  private setsUnknown(name: string, ctx: Ctx): void {
    if (!name) return;
    ctx.vars.set(name, undefined);
    this.dependsOn(name, { direct: true, names: [] });
  }

  // A positional's name, or a variable's, as Deps keys them; undefined for
  // one that's a number or flags ($$, $?, $!, $-) and no path to pick.
  private depName(n: string, ctx: Ctx): string | undefined {
    if (/^([0-9@*#]|[1-9]\d+)$/.test(n)) return `#args:${ctx.file}`;
    if (/^[A-Za-z_]\w*$/.test(n)) return n;
    return undefined;
  }

  // What a word's value is made from: its values when known here.
  private depsOf(w: Word, ctx: Ctx): Deps {
    const vals = this.values(w, ctx);
    if (vals) return { direct: false, names: [], values: vals };
    const t = this.tplOf(w, ctx);
    if (!t) return { direct: true, names: [] };
    return { direct: false, names: t.flatMap((p) => (typeof p === 'string' ? [] : [p.v])), forms: [t] };
  }

  // A word as text and variables, or undefined for one this can't spell
  // out that way (a `$(...)`, arithmetic, `${x/a/b}`, `${!x}`).
  private tplOf(w: Word, ctx: Ctx): Tpl | undefined {
    const out: Tpl = [];
    for (const p of w.parts) {
      if (p.k === 'lit') out.push(p.s);
      else if (p.k !== 'var') return undefined;
      // $? is whatever the last command gave, so a path with it is anywhere.
      else if (p.name === '?') return undefined;
      else if (/^[$!-]$/.test(p.name)) out.push('');
      else {
        const v = this.depName(p.name.replace(/\[.*$/s, ''), ctx);
        if (v === undefined) return undefined;
        if (p.op === '') out.push({ v });
        else if (/[$`]/.test(p.op)) return undefined;
        else if (/^:?[-=]/.test(p.op)) out.push({ v, alt: plainDefault(p.op.replace(/^:?[-=]/, '')) });
        else if (/^:?\+/.test(p.op)) out.push({ v: '', alt: plainDefault(p.op.replace(/^:?\+/, '')) });
        else return undefined;
      }
    }
    return out;
  }

  // What a script or function is handed is what its positionals are:
  // `files`, each script it may be (a function's are its own script's).
  private handed(args: Word[], files: string[], ctx: Ctx): void {
    for (const w of args) {
      const d = this.depsOf(w, ctx);
      for (const f of files) this.dependsOn(`#args:${f}`, d);
    }
  }

  // A write to the path a word names (`vals`, its values, when known).
  // `flag`: the word may be an option rather than the path.
  private wrote(vals: string[] | undefined, w: Word | undefined, ctx: Ctx, line: number, flag = false, into = false, srcs?: string[]): void {
    const where = `${ctx.label}${line ? ` line ${line}` : ''}`;
    // `> run.?h`, `$dest` holding `run.?h`: the shell makes it the file that
    // matches (Codex's reviews).
    if (w && (hasPattern(w) || (vals && w.parts.some((p) => p.k !== 'lit') && vals.some((v) => /[*?[]|\{[^}]*(,|\.\.)[^}]*\}/.test(v))))) {
      this.writesSomewhere ??= where;
      return;
    }
    if (!vals) {
      const t = w && this.tplOf(w, ctx);
      if (!t || ctx.lost) {
        this.writesSomewhere ??= where;
        return;
      }
      this.pendingWrites.push({ where, direct: false, names: t.flatMap((p) => (typeof p === 'string' ? [] : [p.v])), tpl: t, dirs: [...ctx.dirs], ...(flag ? { flag } : {}), ...(into ? { into } : {}), ...(srcs ? { srcs } : {}) });
      return;
    }
    for (const v of vals) {
      if (!v || v === PATH_SENTINEL || v.length > 4096) continue;
      if (flag && v.startsWith('-')) {
        this.writesSomewhere ??= where;
        continue;
      }
      const ps = this.abs(v, ctx);
      if (!ps) {
        this.writesSomewhere ??= where;
        continue;
      }
      for (const p of ps) if (!this.written.has(p)) this.written.set(p, where);
    }
  }

  // What a command writes, without following anything it runs.
  private writesOnly(cmd: Simple, ctx: Ctx): void {
    for (const r of cmd.redirs) {
      if (r.target && WRITE_REDIRS.has(r.op) && !(r.op === '>&' && /^(\d+-?|-)$/.test(litOf(r.target) ?? ''))) this.wrote(this.values(r.target, ctx), r.target, ctx, cmd.line);
    }
    // Assignments still set what later writes are made from.
    for (const w of cmd.words) {
      const a = this.assignment(w);
      if (!a) continue;
      const v = this.values(a.value, ctx);
      ctx.vars.set(a.name, a.append ? undefined : v);
      this.dependsOn(a.name, v && !a.append ? { direct: false, names: [], values: v } : this.depsOf(a.value, ctx));
    }
    const words = cmd.words.filter((w) => !RESERVED.has(bareOf(w) ?? '') && !this.assignment(w));
    let i = 0;
    // Past wrappers by name, as their options can't be told apart here.
    while (i < words.length && WRAPPER_NAMES.has(programName(path.basename(this.str(words[i]!, ctx) ?? '')))) i++;
    const name = words[i] && this.str(words[i]!, ctx);
    if (name === undefined) return void (words.length > i && (this.writesSomewhere ??= `${ctx.label} line ${cmd.line}`));
    const prog = programName(path.basename(name));
    const args = words.slice(i + 1);
    this.writesOf(prog, args, ctx, cmd.line, i > 0);
    // What it runs in turn: `sh -c '...'`, a script, a sourced file,
    // `find -exec`, read for writes the same way (Grok's review).
    if (this.writesDepth >= 8) return void (this.writesSomewhere ??= `${ctx.label} line ${cmd.line}`);
    this.writesDepth++;
    try {
      const c = args.findIndex((w) => litOf(w) === '-c');
      if (SHELLS.includes(prog) && c >= 0) {
        const code = args[c + 1] && litOf(args[c + 1]!);
        const own = `${ctx.file}\u0000-c${cmd.line}`;
        this.handed(args.slice(c + 2), [own], ctx);
        if (code === undefined) this.writesSomewhere ??= `${ctx.label} line ${cmd.line}`;
        else this.writesOnlyText(code, { ...ctx, file: own, vars: new Map() });
      } else if (prog === 'find') {
        // Each -exec, as the main follower does.
        for (let at = 0; at < args.length; at++) {
          if (!/^-(exec|ok|execdir|okdir)$/.test(litOf(args[at]!) ?? '')) continue;
          const end = args.findIndex((w, j) => j > at && /^[;+]$/.test(litOf(w) ?? ''));
          this.writesOnly({ words: args.slice(at + 1, end < 0 ? args.length : end), redirs: [], line: cmd.line, arrays: [] }, ctx);
          if (end < 0) break;
          at = end;
        }
      } else {
        // A script by path, by a shell, or sourced: its text, if it's there.
        const file = name.includes('/') ? name : SHELLS.includes(prog) || prog === 'source' || prog === '.' ? args.map((w) => this.str(w, ctx)).find((v) => v !== undefined && !v.startsWith('-')) : undefined;
        const files = file ? this.abs(file, ctx) ?? [] : [];
        this.handed(args.slice(name.includes('/') ? 0 : args.findIndex((w) => this.str(w, ctx) === file) + 1), files, ctx);
        for (const f of files) {
          this.reached.add(f);
          const text = isFile(f) && this.inRepo(f) ? this.text(f) : undefined;
          if (text !== undefined && text.length <= MAX_CONFIG_BYTES) this.writesOnlyText(text, { ...ctx, file: f, label: this.rel(f), vars: new Map() });
        }
      }
    } finally {
      this.writesDepth--;
    }
  }

  private writesOnlyText(text: string, ctx: Ctx): void {
    let cmds: Simple[];
    try {
      cmds = simpleCommands(new Lexer(text, 1).run().toks);
    } catch {
      this.writesSomewhere ??= ctx.label;
      return;
    }
    for (const c of cmds) this.writesOnly(c, ctx);
  }

  // What a program writes by its arguments, for the common ones that copy,
  // fetch, unpack or edit files. A program that writes by its own rules
  // where the data says (tar x, unzip, patch, git checkout) writes
  // somewhere this can't tell.
  private writesOf(name: string, args: Word[], ctx: Ctx, line: number, extra: boolean): void {
    const lit = (w: Word | undefined) => (w ? this.str(w, ctx) : undefined);
    const somewhere = () => {
      this.writesSomewhere ??= `${ctx.label}${line ? ` line ${line}` : ''} (${name})`;
    };
    const to = (w: Word | undefined) => this.wrote(w ? this.values(w, ctx) : undefined, w, ctx, line);
    const into = (w: Word | undefined, srcs?: string[]) => {
      // rsync's and scp's `host:path` is another machine's.
      if (w && /^[^/]*:/.test(lit(w) ?? '') ) return;
      this.wrote(w ? this.values(w, ctx) : undefined, w, ctx, line, false, true, srcs);
    };
    // A word's values with a prefix (`of=`) taken off.
    const after = (w: Word, prefix: string) => {
      const v = this.values(w, ctx);
      this.wrote(v?.map((x) => (x.startsWith(prefix) ? x.slice(prefix.length) : x)), w, ctx, line);
    };
    // Arguments this can't see (xargs adds them, find puts each file in
    // `{}`), or a pattern or brace the shell expands into other words, can
    // make any of them the one written (Codex's review of 153).
    const writer = WRITERS.has(name) || ARCHIVERS.has(name) || UNPACKERS.has(name);
    if (writer && (extra || args.some((w) => hasPattern(w) || (litOf(w) ?? '').includes('{}')))) return somewhere();
    // An argument worked out as it runs may be the file, or a flag that
    // writes one (`-o"$f"`, `tar "$f"`): settled like a write to it, so the
    // runner's own variables pass and anything the repo can steer doesn't.
    // (sed's own program, worked out or not, is no file: its branch below.)
    if (writer && name !== 'sed' && name !== 'gsed') for (const w of args) if (!this.values(w, ctx)) this.wrote(undefined, w, ctx, line, true);
    const operands = () => {
      const out: Word[] = [];
      let opts = true;
      for (const w of args) {
        const v = lit(w);
        if (opts && v === '--') opts = false;
        else if (!(opts && v !== undefined && v.startsWith('-') && v !== '-')) out.push(w);
      }
      return out;
    };
    // An option's value: `-o x`, `-ox`, `--output x`, `--output=x`.
    const optionValue = (short: string | undefined, long: string | undefined) => {
      for (let i = 0; i < args.length; i++) {
        const v = lit(args[i]);
        if (v === undefined) continue;
        if (long && v === long) to(args[i + 1]);
        else if (long && v.startsWith(`${long}=`)) after(args[i]!, `${long}=`);
        else if (short && /^-[A-Za-z]/.test(v) && v.includes(short)) {
          // In a cluster, what follows the letter is its value (`-sorun.sh`),
          // or the next word when nothing does.
          const rest = v.slice(v.indexOf(short) + 1);
          if (rest) after(args[i]!, v.slice(0, v.indexOf(short) + 1));
          else to(args[i + 1]);
        }
      }
    };
    // A link the check makes can point a later write, or a later run, at
    // another file than the path says (Codex's review of 153).
    if (name === 'ln' || name === 'gln') return somewhere();
    if (COPIERS.has(name)) {
      const target = args.findIndex((w) => /^(-t|--target-directory)$/.test(lit(w) ?? ''));
      const joined = args.find((w) => /^--target-directory=/.test(lit(w) ?? ''));
      if (target >= 0) return into(args[target + 1]);
      if (joined) return after(joined, '--target-directory=');
      if (extra) return somewhere();
      // rsync's options that take the next word, wherever they are.
      const ops = name === 'rsync' ? args.filter((w, i) => !(lit(w) ?? '').startsWith('-') && !RSYNC_VALUED.test(lit(args[i - 1]!) ?? '')) : operands();
      // What lands in a folder is a source by its own name only when it's a
      // file named plainly: a folder (or `dir/`, which copies what's in it),
      // -R or a list of files puts other names there (Grok's review).
      const srcs = ops.slice(0, -1).map((w) => this.values(w, ctx));
      const listed = args.some((w) => /^(-[A-Za-z]*R|--relative|--files-from|--include-from)/.test(lit(w) ?? ''));
      const names = !listed && srcs.every((v) => v && v.length === 1 && !v[0]!.endsWith('/') && (path.isAbsolute(v[0]!) ? isFile(v[0]!) : [...ctx.dirs].every((d) => isFile(path.resolve(d, v[0]!))))) ? srcs.map((v) => path.basename(v![0]!)) : undefined;
      if (ops.length >= 2) return into(ops.at(-1), names);
      return;
    }
    if (name === 'tee') return void operands().forEach(to);
    if (name === 'dd') {
      for (const w of args) {
        const v = this.values(w, ctx);
        if (!v) somewhere();
        else if (v.some((x) => x.startsWith('of='))) after(w, 'of=');
      }
      return;
    }
    if (name === 'sed' || name === 'gsed') {
      if (args.some((w) => /^-[A-Za-z]*f|^--file/.test(lit(w) ?? ''))) return this.fail(ctx, line, "runs a sed program from a file, which can write files or run commands, so patch trust doesn't follow it.");
      // `w file`, `s/a/b/w file`: a file the program names (and `e` runs one).
      // After an address or any delimiter (`1,$w f`, `s|a|b|w f`), so any w,
      // W or e that isn't inside a word (Grok's review).
      // GNU's `w/tmp/x` needs no space; `r` reads a file into what's written.
      if (args.some((w) => /(^|[^A-Za-z])[wWeRr](\s|;|$|\/)/.test(lit(w) ?? ''))) return somewhere();
      const inPlace = args.find((w) => /^-[A-Za-z]*i|^--in-place/.test(lit(w) ?? ''));
      if (!inPlace) return;
      // The files: past the program, unless -e gave it.
      const all = operands();
      // BSD's `-i ''` and `-i .bak` give a suffix as the next word.
      if (lit(inPlace) === '-i' && args[args.indexOf(inPlace) + 1] === all[0] && /^(|\..*)$/.test(lit(all[0]) ?? 'x')) all.shift();
      // -e gives the program, its own word or run on (`-e'1r x'`, `-ne...`).
      const ops = args.some((w) => /^-[A-Za-z]*e|^--expression/.test(lit(w) ?? '')) ? all : all.slice(1);
      for (const o of ops) if (!this.values(o, ctx)) this.wrote(undefined, o, ctx, line, true);
      ops.forEach(to);
      // A backup beside each: `-i.bak`, BSD's `-i .bak` (its next word).
      const flag = lit(inPlace) ?? '';
      const suffix = /^-[A-Za-z]*i(.+)$/.exec(flag)?.[1] ?? /^--in-place=(.+)$/.exec(flag)?.[1] ?? (flag === '-i' && args[args.indexOf(inPlace) + 1] ? lit(args[args.indexOf(inPlace) + 1]) : undefined);
      if (suffix) for (const o of ops) this.wrote(this.values(o, ctx)?.map((v) => v + suffix), o, ctx, line);
      return;
    }
    if (name === 'sort' || name === 'base64' || name === 'iconv') return optionValue('o', '--output');
    if (name === 'openssl') return optionValue(undefined, '-out');
    if (name === 'uniq' || (name === 'xxd' && args.some((w) => lit(w) === '-r'))) {
      const ops = operands();
      return ops[1] ? to(ops[1]) : undefined;
    }
    if (name === 'curl') {
      if (args.some((w) => /^-[A-Za-z]*[OJK]|^--(remote-name|remote-header-name|output-dir|config|remote-name-all)/.test(lit(w) ?? ''))) return somewhere();
      return optionValue('o', '--output');
    }
    if (name === 'wget') {
      if (args.some((w) => lit(w) === '--spider')) return;
      if (!args.some((w) => /^-[A-Za-z]*O|^--output-document/.test(lit(w) ?? ''))) return somewhere();
      return optionValue('O', '--output-document');
    }
    if (name === 'git') {
      // xargs hands it a subcommand this can't see.
      if (extra) return somewhere();
      let i = 0;
      for (; i < args.length; i++) {
        const v = lit(args[i]);
        if (v === undefined) return somewhere();
        if (/^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix|--config-env)$/.test(v)) i++;
        else if (!v.startsWith('-')) break;
      }
      const sub = lit(args[i]) ?? '';
      const rest = args.slice(i + 1).map((w) => lit(w));
      if (sub === 'stash' && ['list', 'show', 'create'].includes(rest[0] ?? '')) return;
      if (sub === 'worktree' && !['add', 'move'].includes(rest[0] ?? '')) return;
      if (sub === 'submodule' && ['status', 'summary'].includes(rest[0] ?? '')) return;
      // Only these reset the files, not just the index.
      if (sub === 'reset' && !rest.some((r) => r === undefined || /^--(hard|merge|keep)$/.test(r))) return;
      if (GIT_WRITES.has(sub)) somewhere();
      return;
    }
    if (ARCHIVERS.has(name)) {
      // The mode's letters: a `-` cluster (`-xf./a.tar` runs on into its
      // value), or the first word without one (`tar xf a.tar`).
      const extracts = args.some((w, i) => {
        const v = lit(w) ?? '';
        // Up to the first letter that takes a value (`f`, `C`...), the rest being it.
        const run = /^-([A-Za-z].*)/.exec(v)?.[1] ?? (i === 0 ? /^([A-Za-z].*)/.exec(v)?.[1] : undefined);
        const letters = run === undefined ? '' : /^[^fCTXbHIKLNVg]*[fCTXbHIKLNVg]?/.exec(run)![0];
        return /^--(extract|get)$/.test(v) || (!v.startsWith('--') && letters.includes('x'));
      });
      if (extracts) somewhere();
      return;
    }
    // To its output only (`gzip -dc`, `unzip -p`, `unzip -l`), it writes no file.
    const dash = args.findIndex((w) => lit(w) === '--');
    const options = (dash < 0 ? args : args.slice(0, dash)).map((w) => lit(w) ?? '').filter((v) => v.startsWith('-'));
    const toOutput = options.some((v) => /^-[A-Za-z]*[ct]|^--(stdout|to-stdout|test)$/.test(v));
    if (['gzip', 'bzip2', 'xz', 'zstd', 'lz4', 'brotli'].includes(name)) {
      if (!toOutput && args.some((w) => /^-[A-Za-z]*d|^--(decompress|uncompress)$/.test(lit(w) ?? ''))) somewhere();
      return;
    }
    if (['gunzip', 'bunzip2', 'unxz', 'unzstd', 'unlz4'].includes(name) && toOutput) return;
    if (name === 'unzip') {
      // `-d dir` extracts there; `-p`, `-c`, `-l`, `-v`, `-t`, `-Z` write no file.
      if (options.some((v) => /^-[A-Za-z]*d/.test(v)) || !options.some((v) => /^-[A-Za-z]*[pclvtZ]/.test(v))) somewhere();
      return;
    }
    if (UNPACKERS.has(name)) somewhere();
  }

  // Fails when it writes something it runs (Daybreak 153), once all of it
  // has been followed.
  settleWrites(): void {
    // Over a problem found first, as that's often the run of a file the
    // check writes (`cp p run.sh; sh run.sh` with no run.sh yet), and an
    // owner's check that can't be followed is still approved, bound only
    // as far as it can be: this one mustn't be (PatchTrust.approveCheck).
    const wp = writeProblem(this.writes(), this.o.top);
    if (wp?.definite) this.problem = this.writeFailed = wp.problem;
    else if (wp) this.problem ??= wp.problem;
  }

  writes(): Writes {
    return {
      written: [...this.written],
      ...(this.writesSomewhere ? { somewhere: this.writesSomewhere } : {}),
      reached: [...this.reached, ...this.files, ...this.missing],
      pending: this.pendingWrites,
      deps: [...this.deps],
      exported: [...this.exported],
      cleared: [...this.cleared],
      ...(this.assignsAny ? { assignsAny: true } : {}),
    };
  }

  private cd(args: Word[], ctx: Ctx, line: number): void {
    const words = args.filter((w) => !/^-[LPe@]+$|^--$/.test(litOf(w) ?? ''));
    if (!words.length) {
      ctx.dirs.add(this.home);
      return;
    }
    const v = this.str(words[0], ctx);
    if (v === undefined || v === '-') {
      ctx.lost ??= `line ${line}`;
      return;
    }
    const to = this.abs(v, ctx);
    if (!to) return;
    for (const d of to) ctx.dirs.add(d);
  }

  // The command a wrapper (env, exec, nice, xargs...) runs, or undefined
  // when `name` isn't one.
  private unwrap(name: string, args: Word[], ctx: Ctx, line: number): { words: Word[]; extra: boolean } | undefined {
    const val = (opts: string[], flagsOk = true) => {
      let i = 0;
      for (; i < args.length; i++) {
        const s = this.str(args[i], ctx);
        if (s === undefined) break;
        if (s === '--') return i + 1;
        if (!s.startsWith('-') || s === '-') break;
        if (opts.includes(s)) i++;
        else if (!flagsOk) break;
      }
      return i;
    };
    switch (name) {
      case 'exec':
        // -c clears the environment, NoDefaultCurrentDirectoryInExePath with it.
        if (IS_WINDOWS && args.some((w) => /^-[a-z]*c/.test(litOf(w) ?? ''))) {
          this.fail(ctx, line, "runs `exec -c`, which on Windows lets cmd.exe run a program from the folder it's in, so patch trust doesn't follow it.");
          return { words: [], extra: false };
        }
        return { words: args.slice(val(['-a'])), extra: false };
      case 'command': {
        if (args.some((w) => /^-[vV]$/.test(litOf(w) ?? ''))) return { words: [], extra: false };
        return { words: args.slice(val([])), extra: false };
      }
      case 'builtin':
      case 'nohup':
      case 'chronic':
      case 'unbuffer':
      case 'noglob':
      case 'nocorrect':
        return { words: args.slice(name === 'builtin' ? 0 : val([])), extra: false };
      case 'time':
        return { words: args.slice(val([])), extra: false };
      case 'nice':
        return { words: args.slice(val(['-n'])), extra: false };
      case 'ionice':
        return { words: args.slice(val(['-c', '-n', '-p'])), extra: false };
      case 'caffeinate':
        return { words: args.slice(val(['-t', '-w'])), extra: false };
      case 'taskpolicy':
        return { words: args.slice(val(['-c', '-d', '-g', '-t', '-l', '-p'])), extra: false };
      case 'stdbuf':
        return { words: args.slice(val(['-i', '-o', '-e'])), extra: false };
      case 'doas':
        return { words: args.slice(val(['-u', '-C'])), extra: false };
      case 'arch':
        return { words: args.slice(val(['-arch', '-e'])), extra: false };
      case 'flock': {
        const i = val(['-w', '-E', '--timeout', '--conflict-exit-code']);
        if (args.slice(i).some((w) => /^(-c|--command)$/.test(litOf(w) ?? ''))) {
          this.fail(ctx, line, 'runs a command string through flock, which patch trust doesn\'t follow.');
          return { words: [], extra: false };
        }
        return { words: args.slice(i + 1), extra: false };
      }
      case 'timeout':
      case 'gtimeout': {
        const i = val(['-s', '-k', '--signal', '--kill-after']);
        return { words: args.slice(i + 1), extra: false };
      }
      case 'sudo': {
        if (args.some((w) => /^-\w*[si]\w*$|^--(shell|login)$/.test(litOf(w) ?? ''))) {
          this.fail(ctx, line, "runs a shell through sudo, which patch trust can't follow.");
          return { words: [], extra: false };
        }
        return { words: args.slice(val(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T'])), extra: false };
      }
      case 'env': {
        let i = 0;
        for (; i < args.length; i++) {
          const s = this.str(args[i], ctx);
          if (s === undefined) break;
          if (/^(-S|--split-string|-C|--chdir)/.test(s)) {
            this.fail(ctx, line, `runs \`env ${s}\`, which patch trust doesn't follow.`);
            return { words: [], extra: false };
          }
          if (s === '-u' || s === '--unset') {
            const v = args[i + 1] && this.str(args[i + 1]!, ctx);
            if (v === undefined) {
              this.fail(ctx, line, "runs `env -u` with a name worked out as it runs, which patch trust can't follow.");
              return { words: [], extra: false };
            }
            if (v && this.unfollowableVar(v, ctx, line)) return { words: [], extra: false };
            this.cleared.add(v);
            i++;
            continue;
          }
          // -uNAME and --unset=NAME (Codex's fourth review).
          const joined = /^(?:-u|--unset=)(.+)$/s.exec(s);
          if (joined) {
            if (this.unfollowableVar(joined[1]!, ctx, line)) return { words: [], extra: false };
            this.cleared.add(joined[1]!);
            continue;
          }
          // A cleared environment loses NoDefaultCurrentDirectoryInExePath.
          if (IS_WINDOWS && (s === '-i' || s === '--ignore-environment' || s === '-')) {
            this.fail(ctx, line, `runs \`env ${s}\`, which on Windows lets cmd.exe run a program from the folder it's in, so patch trust doesn't follow it.`);
            return { words: [], extra: false };
          }
          // -P picks the folder programs come from; -a/--argv0 take a value.
          if (/^-[a-zA-Z]*P/.test(s)) {
            this.fail(ctx, line, `runs \`env ${s}\`, which picks the folder programs run from, so patch trust doesn't follow it.`);
            return { words: [], extra: false };
          }
          if (s === '-a' || s === '--argv0') {
            i++;
            continue;
          }
          // -i: none of the environment (Grok's review).
          if (s === '-i' || s === '--ignore-environment' || s === '-') this.cleared.add('*');
          if (s.startsWith('-')) continue;
          let as = this.assignment(args[i]!);
          // `env 'X=1' cmd` is an assignment too, after its quotes come off
          // (Gemini's review): it was taken for the command's name.
          const quoted = /^([A-Za-z_]\w*)=(.*)$/s.exec(s);
          if (!as && quoted) as = { name: quoted[1]!, append: false, value: { parts: [{ k: 'lit', s: quoted[2]!, q: true }], line } };
          if (!as && this.quotedAssignment(args[i]!, ctx, line)) return { words: [], extra: false };
          if (!as) break;
          this.assign(as.name, as.value, as.append, { ...ctx, vars: new Map(ctx.vars) }, line);
          if (this.problem) return { words: [], extra: false };
        }
        return { words: args.slice(i), extra: false };
      }
      case 'xargs': {
        const i = val(['-I', '-n', '-P', '-L', '-s', '-E', '-d', '-J', '-R', '-S']);
        if (args.slice(0, i).some((w) => /^-a$|^--arg-file/.test(litOf(w) ?? ''))) {
          this.fail(ctx, line, "runs xargs with arguments from a file, which patch trust doesn't follow.");
          return { words: [], extra: false };
        }
        return { words: args.slice(i), extra: true };
      }
      case 'watch':
        return { words: args.slice(val(['-n', '--interval'])), extra: false };
    }
    return undefined;
  }

  private shellRun(name: string, args: Word[], ctx: Ctx, line: number, extra: boolean): void {
    for (let i = 0; i < args.length; i++) {
      const s = this.str(args[i], ctx);
      if (s === undefined) return this.fail(ctx, line, `runs ${name} with a script worked out as it runs, which patch trust can't follow.`);
      if (s === '--') {
        const file = this.str(args[i + 1], ctx);
        return file === undefined ? this.fail(ctx, line, `runs ${name} reading what to run from its input, which patch trust can't follow.`) : this.runFile(file, ctx, line);
      }
      if (/^[-+][a-zA-Z]*o$/.test(s) || s === '-O' || s === '+O') {
        i++;
        continue;
      }
      // bash's options that take a file: it's sourced, not the script
      // (taking it for the script missed a `-s` after it: Codex's review).
      if (s === '--rcfile' || s === '--init-file') {
        const rc = this.str(args[++i], ctx);
        if (rc === undefined) return this.fail(ctx, line, `runs ${name} with an rc file worked out as it runs, which patch trust can't follow.`);
        const rcs = this.abs(rc, ctx) ?? [];
        if (rc === '-' || rcs.some(readsInput)) return this.fail(ctx, line, `runs ${name} with an rc file that reads from its input or another open file, which patch trust can't follow.`);
        for (const t of rcs) if (isFile(t)) this.follow(t, 'source', ctx, line);
        continue;
      }
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(s)) {
        const code = args[i + 1] ? litOf(args[i + 1]!) : undefined;
        if (code === undefined) return this.fail(ctx, line, `runs \`${name} -c\` with code worked out as it runs, which patch trust can't follow.`);
        // Its own positionals: the words after the code ($0, $1...), not
        // the caller's (Grok's review).
        const own = `${ctx.file}\u0000-c${line}`;
        this.handed(args.slice(i + 2), [own], ctx);
        return this.shell(code, { ...ctx, file: own, argv0: [], vars: new Map(), dirs: new Set(ctx.dirs) }, line);
      }
      if (/^-[a-zA-Z]*s[a-zA-Z]*$/.test(s)) return this.fail(ctx, line, `runs ${name} reading what to run from its input, which patch trust can't follow.`);
      if (s.startsWith('-') || s.startsWith('+')) continue;
      return this.runFile(s, ctx, line);
    }
    this.fail(ctx, line, `runs ${name} reading what to run from its input${extra ? ' (from xargs)' : ' (a pipe or a here-doc)'}, which patch trust can't follow.`);
  }

  private runFile(file: string, ctx: Ctx, line: number): void {
    // `-` as the file (`node -- -`, `sh -- -`) is the input, whatever file
    // is called that.
    if (file === '-') return this.fail(ctx, line, `runs \`-\`, which reads what to run from its input, which patch trust can't follow.`);
    const tries = this.abs(file, ctx);
    if (!tries) return this.fail(ctx, line, `runs ${file} after a cd patch trust couldn't follow (${ctx.lost}).`);
    // `sh /dev/stdin < ./steps.txt` runs steps.txt, which a hash of the
    // script doesn't cover: refused, as `sh < ./steps.txt` is (Gautam's
    // scan, 6 Nov).
    if (tries.some(readsInput)) return this.fail(ctx, line, `runs ${file}, which reads what to run from its input, which patch trust can't follow.`);
    const inRepo = tries.filter((t) => this.inRepo(t));
    // A script outside the repo, handed to sh or node by its path. Where
    // outside scripts are followed (a schedule's check, writeRunsAsCode),
    // it's one, whatever its mode or name says: `sh /opt/x` runs x though
    // it has no shebang, no +x and no .sh, and leaving it out hashed none
    // of it and guarded none of it (Grok's review of Daybreak 126, 15 Nov
    // 2026). Every outside candidate, even beside one in the repo: after
    // `cd /opt`, `sh payload` runs /opt/payload though the repo has a
    // payload too (Grok's second review). Elsewhere it's a program, as
    // before.
    if (this.o.outside) {
      for (const t of tries) {
        if (inRepo.includes(t)) continue;
        // One not there yet is noted as missing (so an edit that writes it
        // asks), not refused: the digest is taken again at each run, and
        // once it's there it's followed and hashed, so the check is held.
        // A patch naming a script in another of its owner's repos
        // (Threadbear's App Store chip) would otherwise make every edit ask
        // in a copy without that repo.
        if (!isFile(t)) {
          if (this.missing.size < 500) this.missing.add(t);
          continue;
        }
        // An interpreter runs what it's given, so one that looks binary (a
        // NUL in a comment, or a file it can't read now) isn't a program
        // to skip here: it can't be followed.
        if (isBinary(t)) return this.fail(ctx, line, `runs ${file}, which patch trust can't read as a script.`);
        this.noteOutside(t, 'run', ctx, line);
      }
    }
    if (!inRepo.length) return;
    const found = inRepo.filter(isFile);
    for (const t of inRepo) if (!isFile(t) && this.missing.size < 500) this.missing.add(t);
    if (!found.length) return this.fail(ctx, line, `runs ${file}, which isn't a file in the repo now, so patch trust can't see what it'll be.`);
    for (const t of found) this.follow(t, 'run', ctx, line);
  }

  private jsRun(name: string, args: Word[], ctx: Ctx, line: number, extra: boolean): void {
    let i = 0;
    // bun and deno have subcommands; `bun x`/`bun run x`/`bun x.ts`.
    if (name === 'bun' || name === 'deno') {
      while (i < args.length && (this.str(args[i], ctx) ?? '').startsWith('-')) i++;
      const sub = this.str(args[i], ctx);
      if (sub === undefined) return args[i] ? this.fail(ctx, line, `runs ${name} with a subcommand worked out as it runs, which patch trust can't follow.`) : this.fail(ctx, line, `runs ${name} reading what to run from its input, which patch trust can't follow.`);
      if (name === 'deno') {
        if (sub === 'task' || sub === 'eval') return this.fail(ctx, line, `runs \`deno ${sub}\`, which patch trust doesn't follow.`);
        if (sub !== 'run') {
          if (this.isScriptPath(sub, ctx)) return this.runFile(sub, ctx, line);
          return this.o.strict ? this.fail(ctx, line, `runs \`deno ${sub}\`, which finds what to run by its own rules.`) : undefined;
        }
        i++;
      } else {
        if (['install', 'i', 'add', 'a', 'update', 'link', 'pm'].includes(sub)) return this.lifecycle(ctx, line);
        if (sub === 'x') return this.npx(args.slice(i + 1), ctx, line);
        if (['test', 'build', 'create', 'init', 'upgrade', 'outdated', 'publish', 'patch', 'remove', 'rm', 'repl', 'help', 'completions', 'audit', 'info', 'why'].includes(sub)) {
          if (this.o.strict && ['test', 'build', 'create', 'init', 'upgrade', 'publish', 'patch', 'repl'].includes(sub)) return this.fail(ctx, line, `runs \`bun ${sub}\`, which finds what to run by its own rules.`);
          return;
        }
        if (sub === 'run') i++;
        while (i < args.length && (this.str(args[i], ctx) ?? '').startsWith('-')) i++;
        const target = this.str(args[i], ctx);
        if (target === undefined) return args[i] ? this.fail(ctx, line, `runs bun with a target worked out as it runs, which patch trust can't follow.`) : undefined;
        if (this.isScriptPath(target, ctx)) {
          // Bun loads bunfig.toml (its preloads) before the script.
          if (this.o.strict && [...ctx.dirs].some((d) => { for (let x = d; this.inRepo(x); x = path.dirname(x)) { if (isFile(path.join(x, 'bunfig.toml'))) return true; if (x === this.o.top) break; } return false; })) return this.fail(ctx, line, 'runs bun beside a bunfig.toml, whose preloads run first by their own rules.');
          return this.runFile(target, ctx, line);
        }
        return this.packageScript(target, ctx, line);
      }
    }
    for (; i < args.length; i++) {
      const s = this.str(args[i], ctx);
      if (s === undefined) return this.fail(ctx, line, `runs ${name} with a file worked out as it runs, which patch trust can't follow.`);
      if (s === '--') {
        i++;
        break;
      }
      // An env file can set NODE_OPTIONS to load other code.
      if (/^--env-file(-if-exists)?(=|$)/.test(s)) return this.fail(ctx, line, `runs ${name} with an env file, which can make it load code patch trust can't follow.`);
      // `node -` reads its program from its input, whatever follows.
      if (s === '-') return this.fail(ctx, line, `runs ${name} reading what to run from its input, which patch trust can't follow.`);
      if (/^(-e|--eval|-p|--print)$/.test(s) || /^--(eval|print)=/.test(s)) return this.fail(ctx, line, `runs ${name} with code on its command line, which patch trust doesn't follow.`);
      const load = /^(-r|--require|--import|--loader|--experimental-loader|--preload)(?:=(.*))?$/.exec(s);
      if (load) {
        const v = load[2] ?? this.str(args[++i], ctx);
        if (v === undefined) return this.fail(ctx, line, `runs ${name} loading a module worked out as it runs, which patch trust can't follow.`);
        if (/^\.{0,2}\//.test(v)) this.runFile(v, ctx, line);
        // A file: URL as Node reads it (`%6c`, `file://localhost/`, `?q`),
        // or not at all (Grok's review).
        else if (/^file:/i.test(v)) {
          let file: string;
          try {
            file = fileURLToPath(v);
          } catch {
            return this.fail(ctx, line, `runs ${name} loading ${v.slice(0, 40)}, a file: URL patch trust can't read.`);
          }
          this.runFile(file, ctx, line);
        }
        // As a module's own import of them is refused (scanModule): a `#`
        // maps through package.json to a file this doesn't follow, and a
        // URL's code isn't a file at all.
        else if (v.startsWith('#') || (/^[a-z]+:/i.test(v) && !v.startsWith('node:'))) return this.fail(ctx, line, `runs ${name} loading ${v.slice(0, 40)}, which a hash can't follow.`);
        // A package, loaded before the script: as a bare import is.
        else {
          for (const d of ctx.lost ? [] : ctx.dirs) this.barePackage(d, v, ctx, ctx.label);
          if (this.problem) return;
        }
        continue;
      }
      // Symlinks kept as named change which files a module's imports are.
      if (this.o.strict && /^--preserve-symlinks(-main)?$/.test(s)) return this.fail(ctx, line, `runs ${name} keeping symlinked paths, which changes which files it loads.`);
      // An env file can set NODE_OPTIONS, which loads more code.
      if (this.o.strict && /^--env-file(-if-exists)?(=|$)/.test(s)) return this.fail(ctx, line, `runs ${name} with an env file, which can load code by its own rules.`);
      if (/^(--env-file|--env-file-if-exists|--conditions|-C|--input-type|--title|--test-reporter|--test-name-pattern|--watch-path|--cpu-prof-dir|--heap-prof-dir|--diagnostic-dir|--redirect-warnings|--tsconfig|--project|-P)$/.test(s)) {
        i++;
        continue;
      }
      if (s.startsWith('-')) continue;
      break;
    }
    const file = this.str(args[i], ctx);
    if (file === undefined) {
      if (args.some((w) => litOf(w) === '--test')) {
        // node's test runner finding tests
        if (this.o.strict) return this.fail(ctx, line, `runs ${name}'s test runner, which finds its own tests to run, so a hash can't cover them.`);
        return;
      }
      return this.fail(ctx, line, `runs ${name} reading what to run from its input${extra ? ' (from xargs)' : ''}, which patch trust can't follow.`);
    }
    // npm's own script by its path is npm, there or not (Codex's fourth review).
    if (IS_WINDOWS && PACKAGE_MANAGER_ENTRY.test(slashes(file))) return this.fail(ctx, line, `runs ${path.basename(file)}, a package manager, which on Windows runs package scripts with cmd.exe, so patch trust can't follow it.`);
    this.runFile(file, ctx, line);
  }

  private isScriptPath(s: string, ctx: Ctx): boolean {
    if (/^\.{0,2}\//.test(s) || JS_EXT.includes(path.extname(s)) || SHELL_EXT.includes(path.extname(s))) return true;
    return (this.abs(s, ctx) ?? []).some(isFile);
  }

  // The package.json a package manager in `ctx`'s folders would use, and
  // the config next to it that can load code (.npmrc, bunfig.toml...).
  private packages(ctx: Ctx, line: number): { dir: string; pkg: Record<string, any> }[] | undefined {
    if (ctx.lost) {
      this.fail(ctx, line, `runs a package script after a cd patch trust couldn't follow (${ctx.lost}), so it can't tell which package.json.`);
      return undefined;
    }
    const out: { dir: string; pkg: Record<string, any> }[] = [];
    for (const start of ctx.dirs) {
      this.committedPackages(start, ctx, line);
      if (this.problem) return undefined;
      for (let d = start; this.inRepo(d); d = path.dirname(d)) {
        for (const rc of ['.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', '.pnpmfile.cjs', 'pnpm-workspace.yaml']) {
          const f = path.join(d, rc);
          if (!isFile(f)) continue;
          this.follow(f, 'load', ctx);
          this.rcLoads(f, ctx);
        }
        const f = path.join(d, 'package.json');
        if (isFile(f)) {
          this.follow(f, 'load', ctx);
          try {
            out.push({ dir: d, pkg: JSON.parse(this.text(f) ?? '') as Record<string, any> });
          } catch {
            this.fail(ctx, line, `runs a package script, and ${this.rel(f)} can't be read, so patch trust can't tell what it runs.`);
            return undefined;
          }
          break;
        }
        if (this.missing.size < 500) this.missing.add(f);
        if (d === this.o.top || path.dirname(d) === d) break;
      }
    }
    return out;
  }

  // Code a package manager's config loads: yarn's yarnPath and plugins,
  // bun's preload, pnpm's .pnpmfile.cjs (followed as it is).
  //
  // Read a line at a time, each tested from its own start: `/^\s*x/m` over
  // the whole file restarted at every newline and ran on through all the
  // blank lines after it, so an .npmrc of a few MB of newlines held the
  // runner for minutes, before anyone was asked anything (Gautam's scan,
  // 6 Nov). Once per file per hash (Reads.parsed), and one too big for a
  // config file fails closed.
  private rcLoads(file: string, ctx: Ctx): void {
    const base = path.basename(file);
    if (base === '.pnpmfile.cjs') return;
    const rc = this.config(file, 'rc', (text) => rcConfig(base, text));
    if (!rc) return;
    if ('problem' in rc && rc.problem) return this.fail(undefined, undefined, `${this.rel(file)} ${rc.problem}`);
    if (!('paths' in rc)) return;
    for (const given of rc.paths) {
      const s = this.spell(given, ctx);
      if (s === undefined) return;
      const p = path.resolve(path.dirname(file), s);
      if (isFile(p)) this.follow(p, 'load', ctx);
    }
  }

  // A config file's text read once by `parse`, kept on the shared Reads;
  // undefined when it can't be read. One over MAX_CONFIG_BYTES isn't
  // parsed: `problem` says so.
  private config<T extends object>(file: string, kind: string, parse: (text: string) => T): T | { problem: string } | undefined {
    const real = this.reads.real(file);
    if (real === undefined) return undefined;
    const key = `${kind}\u0000${real}`;
    if (this.reads.parsed.has(key)) return this.reads.parsed.get(key) as T | { problem: string };
    const bytes = this.reads.read(real);
    if (!bytes) return undefined;
    const out = bytes.length > MAX_CONFIG_BYTES ? { problem: `is over ${MAX_CONFIG_BYTES / 1024} KB, more than patch trust reads of a config file.` } : parse(this.reads.text(real) ?? '');
    this.reads.parsed.set(key, out);
    return out;
  }

  private scriptsOf(pkg: Record<string, any>): Record<string, string> {
    const s = pkg.scripts;
    return s && typeof s === 'object' ? (s as Record<string, string>) : {};
  }

  private runScripts(dir: string, pkg: Record<string, any>, names: string[], ctx: Ctx): void {
    const scripts = this.scriptsOf(pkg);
    if (ctx.depth + 1 > MAX_DEPTH) return this.fail(ctx, undefined, `runs scripts more than ${MAX_DEPTH} deep, more than patch trust follows.`);
    for (const n of names) {
      const text = scripts[n];
      const key = `script ${dir} ${n}`;
      if (typeof text !== 'string' || this.visits.has(key)) continue;
      this.visits.add(key);
      // On Windows npm runs a script with cmd.exe, which looks for a
      // program in the package's own folder before PATH (a node.exe beside
      // package.json runs for `node x.js`), and reads the text by its own
      // rules: none of that is what's followed here (Codex's review).
      if (IS_WINDOWS) return this.fail(ctx, undefined, `runs ${this.rel(path.join(dir, 'package.json'))}'s "${n}" script, which npm runs with cmd.exe on Windows, so patch trust can't follow it.`);
      // A package script runs through sh in the package's folder, with its
      // node_modules/.bin (and those of the folders above) first on PATH.
      const outer = this.binDirs;
      this.binDirs = [dir];
      try {
        this.shell(text, { label: `${this.rel(path.join(dir, 'package.json'))}'s "${n}" script`, file: path.join(dir, 'package.json'), argv0: [], dirs: new Set([dir]), vars: new Map(), depth: ctx.depth + 1 });
      } finally {
        this.binDirs = outer;
      }
    }
  }

  // `npm run x`, `yarn x`, `bun x`: the script by that name, and what runs
  // before and after it. Without one, it's a package's bin: installed, as
  // the package.json's versions pin, or one of the repo's (repoBin).
  private packageScript(name: string, ctx: Ctx, line: number): void {
    const pkgs = this.packages(ctx, line);
    if (!pkgs) return;
    // One that isn't there runs something by default (npm start runs
    // server.js; pnpm and yarn a package's bin of that name).
    if (this.o.strict && !pkgs.some(({ pkg }) => typeof pkg?.scripts?.[name] === 'string')) {
      return this.fail(ctx, line, `runs the package script ${name}, which isn't in package.json, so what runs instead is worked out by the package manager.`);
    }
    if (!pkgs.some(({ pkg }) => typeof pkg?.scripts?.[name] === 'string')) {
      const bin = this.repoBin(name, ctx.dirs);
      if (bin) return this.follow(bin, 'run', ctx, line);
    }
    for (const { dir, pkg } of pkgs) this.runScripts(dir, pkg, [`pre${name}`, name, `post${name}`], ctx);
  }

  // An install runs the package's own lifecycle scripts, and its
  // workspaces' and local (file:) dependencies'.
  private lifecycle(ctx: Ctx, line: number): void {
    const pkgs = this.packages(ctx, line);
    if (!pkgs) return;
    for (const { dir, pkg } of pkgs) {
      this.runScripts(dir, pkg, LIFECYCLE, ctx);
      this.committedLifecycle(dir, ctx, line);
      for (const sub of this.localPackages(dir, pkg)) {
        const f = path.join(sub, 'package.json');
        if (!isFile(f) || !this.inRepo(f)) continue;
        this.follow(f, 'load', ctx);
        try {
          this.runScripts(sub, JSON.parse(this.text(f) ?? '') as Record<string, any>, LIFECYCLE, ctx);
        } catch {
          this.fail(ctx, line, `installs ${this.rel(f)}, which can't be read, so patch trust can't tell what it runs.`);
        }
      }
    }
  }

  private localPackages(dir: string, pkg: Record<string, any>): string[] {
    const out = new Set<string>();
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : Array.isArray(pkg.workspaces?.packages) ? pkg.workspaces.packages : [];
    const yaml = path.join(dir, 'pnpm-workspace.yaml');
    if (isFile(yaml)) {
      // A line at a time, as rcLoads reads; too big a file is refused there
      // (packages() follows it first), and gives nothing here.
      const listed = this.config(yaml, 'pnpm-workspace', (text) => ({ items: yamlListItems(text) }));
      ws.push(...(listed && 'items' in listed ? listed.items : []));
    }
    for (const pattern of ws) {
      if (typeof pattern !== 'string' || pattern.startsWith('!')) continue;
      try {
        for (const m of fs.globSync(pattern, { cwd: dir })) out.add(path.resolve(dir, m));
      } catch {
        // an odd pattern: nothing found
      }
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const v of Object.values((pkg[field] ?? {}) as Record<string, unknown>)) {
        const m = typeof v === 'string' ? /^(?:file|link|portal):(.+)$/.exec(v) : null;
        if (m) out.add(path.resolve(dir, m[1]!));
      }
    }
    return [...out].slice(0, 50);
  }

  private pkgRun(tool: string, args: Word[], ctx: Ctx, line: number): void {
    let i = 0;
    let local = ctx;
    for (; i < args.length; i++) {
      const s = this.str(args[i], ctx);
      if (s === undefined) return this.fail(ctx, line, `runs ${tool} with words worked out as it runs, which patch trust can't follow.`);
      if (/^(-w|--workspace|-ws|--workspaces|--filter|-F|-r|--recursive)(=|$)/.test(s)) return this.fail(ctx, line, `runs ${tool} across workspaces (${s}), which patch trust doesn't follow.`);
      const dirOpt = /^(--prefix|-C|--dir|--cwd)(?:=(.*))?$/.exec(s);
      if (dirOpt) {
        const v = dirOpt[2] ?? this.str(args[++i], ctx);
        const to = v === undefined ? undefined : this.abs(v, ctx);
        if (!to) return this.fail(ctx, line, `runs ${tool} in a folder worked out as it runs, which patch trust can't follow.`);
        local = { ...ctx, dirs: new Set(to) };
        continue;
      }
      if (!s.startsWith('-')) break;
    }
    const sub = this.str(args[i], ctx);
    const rest = args.slice(i + 1);
    const nameAfter = () => {
      for (const w of rest) {
        const s = this.str(w, local);
        if (s === undefined) return undefined;
        if (!s.startsWith('-')) return s;
      }
      return '';
    };
    if (sub === undefined) {
      if (tool === 'yarn' && !args[i]) return this.lifecycle(local, line);
      return;
    }
    if (['run', 'run-script', 'rum', 'urn'].includes(sub)) {
      const n = nameAfter();
      if (n === undefined) return this.fail(ctx, line, `runs \`${tool} run\` with a script name worked out as it runs, which patch trust can't follow.`);
      if (!n) return;
      return this.packageScript(n, local, line);
    }
    if (['test', 't', 'tst', 'start', 'stop', 'restart'].includes(sub)) return this.packageScript(sub === 't' || sub === 'tst' ? 'test' : sub, local, line);
    if (['install', 'i', 'ci', 'add', 'isntall', 'in', 'install-test', 'it', 'update', 'up', 'upgrade', 'rebuild', 'rb', 'pack', 'publish', 'install-ci-test', 'cit'].includes(sub)) {
      this.lifecycle(local, line);
      if (['install-test', 'it', 'install-ci-test', 'cit'].includes(sub)) this.packageScript('test', local, line);
      return;
    }
    if (['exec', 'x', 'dlx'].includes(sub)) return this.npx(rest, local, line);
    if (tool === 'npm') return; // npm's own commands
    // pnpm and yarn run a script by its bare name, else a package's bin.
    this.packageScript(sub, local, line);
  }

  private npx(args: Word[], ctx: Ctx, line: number): void {
    for (let i = 0; i < args.length; i++) {
      const s = this.str(args[i], ctx);
      if (s === undefined) return this.fail(ctx, line, "runs a package worked out as it runs, which patch trust can't follow.");
      // However npm reads it: it takes a shortened name, and `=`.
      const call = /^(-c|--(?:c|ca|cal|call))(=|$)/.exec(s);
      if (call) {
        const whole = litOf(args[i]!);
        const code = call[2] === '=' ? whole?.slice(call[1]!.length + 1) : args[i + 1] ? litOf(args[i + 1]!) : undefined;
        if (code === undefined) return this.fail(ctx, line, "runs `npx -c` with code worked out as it runs, which patch trust can't follow.");
        // Run as a package script is: with what the repo commits hashed,
        // and its node_modules/.bin first on PATH.
        this.packages(ctx, line);
        if (this.problem) return;
        const outer = this.binDirs;
        this.binDirs = [...outer, ...ctx.dirs];
        try {
          return this.shell(code, { ...ctx, argv0: [], vars: new Map(), dirs: new Set(ctx.dirs) }, line);
        } finally {
          this.binDirs = outer;
        }
      }
      if (s === '-p' || s === '--package') {
        i++;
        continue;
      }
      if (s.startsWith('-')) continue;
      if (/^\.{0,2}\//.test(s)) return this.runFile(s, ctx, line);
      if (this.o.strict) return this.fail(ctx, line, `runs the package ${s} by name (npx or the like), which runs whatever that name resolves to then, so a hash can't cover it.`);
      // A package: its version is the package.json's, what the repo commits
      // is hashed (packages), and a bin of the repo's own runs as a script.
      this.packages(ctx, line);
      if (this.problem || ctx.lost) return;
      const bin = this.repoBin(s, ctx.dirs);
      if (bin) this.follow(bin, 'run', ctx, line);
      return;
    }
  }

  private make(args: Word[], ctx: Ctx, line: number): void {
    let dirs = ctx.lost ? undefined : [...ctx.dirs];
    // Every -f: make reads them all (only the last was followed: Codex's review).
    const files: string[] = [];
    const incDirs: string[] = [];
    // `-C dir`, `-f file`, as their own word, after `=` or run on (`-fx.mk`,
    // `-f-`), or last in a bunch of flags (`-sf x.mk`), as getopt reads
    // them; any other of make's flags that takes a value ends the bunch.
    const opt = (s: string): { flag: 'C' | 'f' | 'I'; value?: string } | undefined => {
      const long = /^--(directory|file|makefile|include-dir)(?:=(.*))?$/.exec(s);
      if (long) return { flag: long[1] === 'directory' ? 'C' : long[1] === 'include-dir' ? 'I' : 'f', ...(long[2] !== undefined ? { value: long[2] } : {}) };
      if (!/^-[^-]/.test(s)) return undefined;
      for (let k = 1; k < s.length; k++) {
        const c = s[k]!;
        if (c === 'C' || c === 'f') return { flag: c, ...(k + 1 < s.length ? { value: s.slice(k + 1) } : {}) };
        if (c === 'I') return { flag: 'I', ...(k + 1 < s.length ? { value: s.slice(k + 1) } : {}) };
        if ('oWjlO'.includes(c)) return undefined;
      }
      return undefined;
    };
    for (let i = 0; i < args.length; i++) {
      const s = this.str(args[i], ctx);
      if (s === undefined) return this.fail(ctx, line, "runs make with words worked out as it runs, which patch trust can't follow.");
      const v = opt(s);
      if (v) {
        const given = v.value ?? this.str(args[++i], ctx);
        if (given === undefined) return this.fail(ctx, line, "runs make with a folder or file worked out as it runs, which patch trust can't follow.");
        // `-f -` is the input, which isn't a path to turn into another.
        const val = given === '-' ? given : this.spell(given, ctx, line);
        if (val === undefined) return;
        // Each -C from the one before (`-C sub -C nested` is sub/nested).
        if (v.flag === 'C') dirs = dirs && (path.isAbsolute(val) ? [path.normalize(val)] : dirs.map((d) => path.resolve(d, val)));
        // `-f -` reads the Makefile from make's input, as `sh < file` does.
        // -I: the folders an include is looked for in, after the Makefile's.
        else if (v.flag === 'I') incDirs.push(val);
        else if (val === '-') return this.fail(ctx, line, "runs make reading its Makefile from its input, which patch trust can't follow.");
        else files.push(val);
      }
    }
    if (!dirs) return this.fail(ctx, line, `runs make after a cd patch trust couldn't follow (${ctx.lost}).`);
    for (const d of dirs) {
      if (files.length) {
        for (const f of files) {
          const t = path.resolve(d, f);
          this.reached.add(t);
          if (readsInput(t)) return this.fail(ctx, line, `runs make with ${f}, which reads what to run from its input or another open file, which patch trust can't follow.`);
          if (isFile(t)) this.makefile(t, d, ctx, line, incDirs);
          else if (this.inRepo(t)) return this.fail(ctx, line, `runs make with ${f}, which isn't a file in the repo now, so patch trust can't see what it'll be.`);
        }
        continue;
      }
      const tries = ['GNUmakefile', 'makefile', 'Makefile'].map((n) => path.join(d, n));
      // A Makefile that's a link to the input reads the redirected file.
      if (tries.some(readsInput)) return this.fail(ctx, line, "runs make with a Makefile that reads from its input or another open file, which patch trust can't follow.");
      const found = tries.find(isFile);
      for (const t of tries) this.reached.add(t);
      for (const t of tries) if (!isFile(t) && this.inRepo(t) && this.missing.size < 500) this.missing.add(t);
      if (found) this.makefile(found, d, ctx, line, incDirs);
    }
  }

  // A Makefile's recipes are shell commands with make's $(VAR)s in them.
  private makefile(file: string, dir: string, ctx: Ctx, line: number, incDirs: string[] = []): void {
    if (!this.inRepo(file)) return;
    const real = this.reads.real(file);
    if (real === undefined) return;
    this.files.add(real);
    const key = `make ${file}`;
    if (this.visits.has(key)) return;
    this.visits.add(key);
    const label = this.rel(file);
    const mctx: Ctx = { label, file, argv0: [], dirs: new Set([dir]), vars: new Map(), depth: ctx.depth + 1 };
    // Its lines, once per file per hash, each tested on its own: a
    // multiline `/^\s*SHELL=/m` over the whole text was quadratic in a run
    // of blank lines (Gautam's scan, 6 Nov).
    const mk = this.config(file, 'make', (text): { lines: string[]; text: string } | { problem: string } => {
      const lines = text.split('\n');
      return lines.some(setsMakeShell) ? { problem: "runs commands a way patch trust can't follow ($(shell ...), `!=`, or its own SHELL)." } : { lines, text };
    });
    if (!mk) return;
    if (!('lines' in mk)) return this.fail(mctx, undefined, mk.problem);
    const { lines, text } = mk;
    if (this.o.strict && /\.RECIPEPREFIX/.test(text)) return this.fail(mctx, undefined, 'sets .RECIPEPREFIX, so its recipes are lines this doesn\'t read as recipes.');
    let recipe = '';
    for (const [n, raw] of lines.entries()) {
      const inc = /^\s*-?(?:include|sinclude)\s+(.+)$/.exec(raw);
      if (inc) {
        for (const f of inc[1]!.trim().split(/\s+/)) {
          if (/[$*?]/.test(f)) return this.fail(mctx, n + 1, "includes a makefile worked out as it runs, which patch trust can't follow.");
          // Where make looks: the folder, then each -I folder in turn.
          const named = this.spell(f, mctx, n + 1);
          if (named === undefined) return;
          const where = path.isAbsolute(named) ? [named] : [dir, ...incDirs.map((i) => path.resolve(dir, i))].map((b) => path.resolve(b, named));
          if (f === '-' || where.some(readsInput)) return this.fail(mctx, n + 1, "includes a makefile that reads from its input or another open file, which patch trust can't follow.");
          const p = where.find(isFile);
          if (p) this.makefile(p, dir, ctx, line, incDirs);
          else for (const w of where) if (this.missing.size < 500) this.missing.add(w);
        }
        continue;
      }
      if (!raw.startsWith('\t')) {
        // A rule's recipe can follow a `;` on its own line (`all: ; ./x.sh`).
        const inline = inlineRecipe(raw);
        if (inline !== undefined) {
          this.shell(makeRecipeToShell(inline.replace(/^[ \t]*[@+-]*/, '')), mctx, n + 1);
          if (this.problem) return;
        }
        continue;
      }
      recipe = raw.slice(1).replace(/^[@+-]+/, '');
      this.shell(makeRecipeToShell(recipe), mctx, n + 1);
      if (this.problem) return;
    }
    this.namedIn(text, file, mctx);
  }

  private awk(args: Word[], ctx: Ctx, line: number): void {
    for (let i = 0; i < args.length; i++) {
      const s = this.str(args[i], ctx);
      if (s?.startsWith('-f') || s?.startsWith('--file')) return this.fail(ctx, line, "runs an awk program from a file, which patch trust doesn't follow.");
      if (s === '-F' || s === '-v') {
        i++;
        continue;
      }
      if (s?.startsWith('-')) continue;
      const raw = args[i] ? litOf(args[i]!) : undefined;
      if (raw === undefined) return this.fail(ctx, line, "runs an awk program worked out as it runs, which patch trust can't follow.");
      // A backslash-newline is one line to awk.
      const prog = raw.replace(/\\\n/g, ' ');
      if (/\bsystem\s*\(|\|\s*getline|\|\s*&/.test(prog) || awkPrintsToCommand(prog)) return this.fail(ctx, line, "runs an awk program that runs commands, which patch trust doesn't follow.");
      // `print > "run.sh"`: a file named in the program, or worked out in it.
      if (awkWritesFile(prog)) this.writesSomewhere ??= `${ctx.label} line ${line} (awk)`;
      return;
    }
  }
}

// The most of a package manager's config, a pnpm-workspace.yaml or a
// Makefile that patch trust reads; a bigger one fails closed.
export const MAX_CONFIG_BYTES = 1024 * 1024;

// .npmrc keys that make npm run a shell or load code.
const NPM_LOADERS = new Set(['script-shell', 'node-options', 'onload-script']);

// What an rc file loads: the paths of files it may run (yarn's yarnPath and
// plugins, bun's preload: every quoted string, and a `yarnPath:` or `path:`
// value, on its line or, YAML-style, the next), or `problem` for an .npmrc
// that sets npm's shell or code. A line at a time, and each test anchored
// to that line's own start, so the work is linear in the text.
export function rcConfig(base: string, text: string): { paths: string[]; problem?: string } {
  const paths: string[] = [];
  const odd = (what: string) => ({ paths, problem: `has ${what}, which patch trust doesn't read, so it can't tell what it loads.` });
  let pending = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimStart();
    if (base === '.npmrc' && NPM_LOADERS.has(npmKey(line))) return { paths, problem: "sets a shell or code for npm to load, which patch trust can't follow." };
    for (const m of line.matchAll(/["']([^"'\n]+)["']/g)) {
      // An escape (YAML's and TOML's `"\u002e/x.cjs"` is `./x.cjs`) is
      // read as JSON reads one; one it can't read fails closed.
      // As written too: a single-quoted YAML string keeps its backslashes.
      paths.push(m[1]!);
      if (!m[1]!.includes('\\')) continue;
      try {
        paths.push(JSON.parse(`"${m[1]!.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')}"`) as string);
      } catch {
        return odd(`an escaped string (${m[0].slice(0, 60)})`);
      }
    }
    // A list item's key too: yarn's `plugins:` are `- path: .yarn/plugins/x.cjs`.
    const keyed = line.startsWith('- ') ? line.slice(2).trimStart() : line;
    if (pending && keyed && !keyed.startsWith('#')) {
      if (/^[!&*|>{[]/.test(keyed)) return odd(`a YAML value it can't read (${keyed.slice(0, 40)})`);
      const v = /^["']?([^"'\s#]+)/.exec(keyed);
      if (v) paths.push(v[1]!);
      pending = false;
    }
    // Yarn Classic's .yarnrc: `yarn-path ./x.cjs`, a space for the colon.
    const y = /^(["']?)(?:yarnPath|path|yarn-path)\1(?:[ \t]*:|[ \t]+)(.*)$/.exec(keyed);
    // A path key inside a flow value (`plugins: [{path: x}]`) isn't read.
    if (!y && /[{[]/.test(keyed) && /path/i.test(keyed)) return odd(`a YAML flow value it can't read (${keyed.slice(0, 40)})`);
    if (y) {
      const rest = y[2]!.trimStart();
      // A tag, anchor, alias, block or flow value: not a plain path.
      if (/^[!&*|>{[]/.test(rest)) return odd(`a YAML value it can't read (${rest.slice(0, 40)})`);
      const v = /^["']?([^"'\s#]+)/.exec(rest);
      if (v) paths.push(v[1]!);
      else pending = true;
    }
  }
  return { paths };
}

// An .npmrc line's key as npm's ini reader takes it (quotes off), in one
// spelling (lower case, `-` for `_`), or '' for a comment.
export function npmKey(line: string): string {
  if (line.startsWith('#') || line.startsWith(';')) return '';
  const eq = line.indexOf('=');
  let key = (eq < 0 ? line : line.slice(0, eq)).trim();
  if (key.length > 1 && (key[0] === '"' || key[0] === "'") && key.at(-1) === key[0]) key = key.slice(1, -1);
  return key.toLowerCase().replaceAll('_', '-');
}

// The `- item` entries of a YAML list (pnpm-workspace.yaml's packages),
// unquoted, a comment after one dropped. No regex: a lazy match before
// `\s*$` was quadratic in a line of spaces.
export function yamlListItems(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimStart();
    if (!line.startsWith('-')) continue;
    let item = line.slice(1);
    const hash = item.indexOf('#');
    if (hash >= 0) item = item.slice(0, hash);
    item = item.trim();
    if (item.length > 1 && (item[0] === '"' || item[0] === "'") && item.at(-1) === item[0]) item = item.slice(1, -1);
    if (item) out.push(item);
  }
  return out;
}

// Whether a Makefile line sets the shell make runs recipes with (SHELL or
// .SHELLFLAGS, after `export` or `override`, or for a target: `t: SHELL =
// x`), or runs a command as make reads it (`$(shell ...)`). A recipe line's
// own `SHELL=` is the shell's business. Scanned by hand, so it's linear.
export function setsMakeShell(raw: string): boolean {
  if (raw.startsWith('\t')) return /\$[({]shell(\s|$)/.test(raw);
  const line = withoutMakeComment(raw);
  if (/\$[({]shell(\s|$)/.test(line)) return true;
  // `X != cmd` runs cmd as make reads the line (GNU make 4).
  if (line.includes('!=')) return true;
  // .RECIPEPREFIX changes what starts a recipe line, so recipes would be
  // read as something else: refused with the shell's own settings.
  for (const name of ['SHELL', '.SHELLFLAGS', '.RECIPEPREFIX']) {
    for (let i = line.indexOf(name); i >= 0; i = line.indexOf(name, i + 1)) {
      if (i > 0 && !' \t\r:;'.includes(line[i - 1]!)) continue;
      let j = i + name.length;
      while (line[j] === ' ' || line[j] === '\t') j++;
      let ops = 0;
      while (ops < 3 && j < line.length && ':+?!'.includes(line[j]!)) {
        j++;
        ops++;
      }
      if (line[j] === '=') return true;
    }
  }
  return false;
}

// A Makefile line before its comment (an unescaped #).
function withoutMakeComment(line: string): string {
  for (let i = line.indexOf('#'); i >= 0; i = line.indexOf('#', i + 1)) {
    if (line[i - 1] !== '\\') return line.slice(0, i);
  }
  return line;
}

// The recipe after a rule's `;` (`all: deps ; cmd`), or undefined when the
// line isn't a rule with one. Not an assignment (`x := a; b`).
export function inlineRecipe(raw: string): string | undefined {
  const line = withoutMakeComment(raw);
  const colon = line.indexOf(':');
  if (colon < 0 || line[colon + 1] === '=' || line.slice(0, colon).includes('=')) return undefined;
  const semi = line.indexOf(';', colon);
  return semi < 0 ? undefined : raw.slice(semi + 1);
}

// A recipe line as shell: `$$` is a `$`, `$(MAKE)` is make, and any other
// make variable or function (`$(X)`, `${X}`, `$@`) a variable the shell
// can't know. One pass, each `$(` finding its `)` from a pointer that only
// moves on: a regex that scanned to the line's end from every unclosed
// `$(` was quadratic.
export function makeRecipeToShell(recipe: string): string {
  let out = '';
  let close = 0; // the next ) or } at or after where it was last needed
  for (let i = 0; i < recipe.length; ) {
    const c = recipe[i]!;
    if (c !== '$') {
      out += c;
      i++;
      continue;
    }
    const n = recipe[i + 1];
    if (n === '$') {
      out += '$';
      i += 2;
    } else if (n === '(' || n === '{') {
      if (close < i + 2) close = i + 2;
      while (close < recipe.length && recipe[close] !== ')' && recipe[close] !== '}') close++;
      if (close >= recipe.length) {
        out += '$';
        i++;
        continue;
      }
      out += recipe.slice(i + 2, close) === 'MAKE' ? 'make' : '$__make_variable';
      i = close + 1;
    } else if (n !== undefined && /[A-Za-z@<^?*%+|]/.test(n)) {
      out += '$__make_variable';
      i += 2;
    } else {
      out += '$';
      i++;
    }
  }
  return out;
}

// `p`'s real path, or, when it isn't there, its nearest folder that is,
// real, with the rest after it.
function realOrNearest(p: string): string {
  let rest = '';
  for (let d = p; ; d = path.dirname(d)) {
    try {
      return path.join(realPathSync(d), rest);
    } catch {
      // not there: one up
    }
    if (path.dirname(d) === d) return p;
    rest = rest ? path.join(path.basename(d), rest) : path.basename(d);
  }
}

// Paths that are a process's input or another file it has open: a shell
// or Node given one reads its program from whatever was redirected there
// (`sh /dev/stdin < ./steps.txt`), which isn't the path it was given.
const INPUT_PATH = /^\/(dev\/(stdin|tty|fd\/\d+)|proc\/(self|thread-self|\d+)\/fd\/\d+)$/;

// A Windows path as Git Bash names it: forward slashes, and the drive
// dropped, as Windows reads /dev/stdin as C:\dev\stdin and path.normalize
// makes it \dev\stdin. (A real C:\dev\stdin is refused too: fails closed.)
export function asBashPath(p: string): string {
  return path.posix.normalize(p.replace(/\\/g, '/').replace(/^[A-Za-z]:(?=\/)/, ''));
}

// Whether running or sourcing `p` reads what to run from the process's
// input: one of those paths, or anything there that isn't a plain file
// (a link to one, in the repo or not, a fifo, a device).
export function readsInput(p: string): boolean {
  if (INPUT_PATH.test(path.normalize(p))) return true;
  try {
    if (INPUT_PATH.test(IS_WINDOWS ? asBashPath(realPathSync(p)) : realPathSync(p))) return true;
  } catch {
    // not there, or a link to nowhere
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return false; // not there: a program that isn't installed
  }
  return !st.isFile() && !st.isDirectory();
}

// Whether a shell script's #! passes the shell a flag that has it read
// commands from somewhere other than the script.
export function shebangReadsElsewhere(text: string): boolean {
  const m = /^#![ \t]*(\S+)([^\n]*)/.exec(text);
  if (!m) return false;
  const words = m[2]!.trim().split(/[ \t]+/).filter(Boolean);
  if (programName(path.basename(m[1]!)) === 'env' && words.some((w) => /^(-[a-zA-Z]*S|--split-string)/.test(w))) return true;
  return words.some((w) => /^[-+][a-zA-Z]*[sci]/.test(w));
}

// Whether an awk program pipes a print into a command (`print x | "sh"`):
// a `|` (not `||`) after a print in the same statement. Statement by
// statement, so it's linear: `print[^;}]*\|` scanned on from every print.
function awkPrintsToCommand(prog: string): boolean {
  for (const st of prog.split(/[;}\n]/)) {
    const at = st.indexOf('print');
    if (at < 0) continue;
    const rest = st.slice(at);
    for (let i = rest.indexOf('|'); i >= 0; i = rest.indexOf('|', i + 1)) {
      if (rest[i + 1] === '|' || rest[i - 1] === '|') continue;
      return true;
    }
  }
  return false;
}

// A missing path in a command's place that could turn up as a program.
function mayRun(p: string): boolean {
  const ext = path.extname(p).toLowerCase();
  return !ext || RUNNABLE_EXT.includes(ext);
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// A name no package has, for "any bare import" (bareImport's answer doesn't
// depend on which, only that it isn't a builtin).
const ANY_PACKAGE = 'any-package';

// Whether a file's start has a NUL: a program, not a script.
export function isBinary(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const buf = Buffer.alloc(512);
    return buf.subarray(0, fs.readSync(fd, buf, 0, 512, 0)).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// How a file runs: by its #! line, else its extension. A file run with no
// #! goes to sh, so it's a shell script then.
export function kindOf(file: string, text: string, running: boolean): 'shell' | 'js' | 'binary' | 'other' {
  if (text.slice(0, 512).includes('\0')) return 'binary';
  const shebang = /^#!\s*(\S+)(?:\s+(.*))?/.exec(text);
  if (shebang) {
    const prog = programName(path.basename(shebang[1]!));
    const words = prog === 'env' ? (shebang[2] ?? '').split(/\s+/).filter((w) => !w.startsWith('-') && !w.includes('=')) : [prog];
    const p = programName(words[0] ?? '');
    if (SHELLS.includes(p)) return 'shell';
    if (JS_RUNNERS.includes(p)) return 'js';
    return 'other';
  }
  const ext = path.extname(file).toLowerCase();
  if (SHELL_EXT.includes(ext)) return 'shell';
  if (JS_EXT.includes(ext)) return 'js';
  return running && !ext ? 'shell' : 'other';
}

// Everything `file` (a script a patch names) can run or read in the repo.
export function reachOf(file: string, opts: FollowOptions): ScriptReach {
  const r = new Reach(opts);
  try {
    r.follow(file, 'run', undefined);
    r.settleWrites();
  } catch (e) {
    // A bug here mustn't let the script through: it fails closed.
    r.problem ??= `couldn't be followed (${(e as Error).message}).`;
  }
  return { files: [...r.files], missing: [...r.missing], ...(r.problem ? { problem: r.problem } : {}), ...(r.refused ? { refused: r.refused } : {}), ...outsideOf(r), writes: r.writes(), ...(r.writeFailed ? { writeProblem: r.writeFailed } : {}) };
}

// The same for a command a patch writes (an action's `run`, a live
// function's `sh(...)`), run by a shell in `opts.folder`. `label` names it
// in a problem. A string that isn't a command only names files to hash.
// `vars`: what the shell it runs in already has set (a Claude Code hook's
// CLAUDE_PROJECT_DIR).
export function reachOfCommand(command: string, label: string, opts: FollowOptions, vars: Record<string, string> = {}): ScriptReach {
  const r = new Reach(opts);
  try {
    r.shell(command, { label, file: opts.folder, argv0: [], dirs: new Set([opts.folder]), vars: new Map(Object.entries(vars).map(([k, v]) => [k, [v]])), depth: 0 });
    r.settleWrites();
  } catch (e) {
    r.problem ??= `couldn't be followed (${(e as Error).message}).`;
  }
  return { files: [...r.files], missing: [...r.missing], ...(r.problem ? { problem: r.problem } : {}), ...(r.refused ? { refused: r.refused } : {}), ...outsideOf(r), writes: r.writes(), ...(r.writeFailed ? { writeProblem: r.writeFailed } : {}) };
}

function outsideOf(r: Reach): { outside?: { file: string; dirs: string[] }[] } {
  return r.outside.size ? { outside: [...r.outside].map(([file, dirs]) => ({ file, dirs: [...dirs] })) } : {};
}

// Whether what a reach (or several, followOutside) writes is any of what it
// runs, sources, loads or hashes as code: `cp payload.dat run.sh; sh run.sh`
// hashed run.sh as it was and ran the payload (Daybreak 153, 21 Nov 2026).
// Each path as written and by its real one, and without case on a Mac or
// Windows, whose disks match names that way; a write to a folder covers
// what's in it. In any order: a loop or a function runs a write before a
// run that comes earlier in the text, and a script reads itself as it goes.
// `definite`: a file it's known to write is one it runs, which no approval
// can cover; otherwise it writes somewhere it can't tell, like any other
// check it can't follow (an owner's is bound as far as it can be).
export function writeProblem(w: Writes, top: string): { problem: string; definite: boolean } | undefined {
  // A write to `$x` where nothing followed sets x is the runner's own
  // environment (`$THREADBEAR_CHECK_STATE`), which no file can change; a
  // positional, or one set anywhere, could be the file it runs.
  const deps = new Map<string, Deps>();
  for (const [n, d] of w.deps ?? []) {
    const had = deps.get(n);
    deps.set(n, had ? { direct: had.direct || d.direct, names: [...had.names, ...d.names], values: [...(had.values ?? []), ...(d.values ?? [])], forms: [...(had.forms ?? []), ...(d.forms ?? [])] } : d);
  }
  const exported = new Set(w.exported ?? []);
  const cleared = new Set(w.cleared ?? []);
  const tainted = new Map<string, boolean>();
  const isTainted = (n: string): boolean => {
    if (tainted.has(n)) return tainted.get(n)!;
    tainted.set(n, false); // a cycle adds nothing
    const d = deps.get(n);
    const t = !!d && (d.direct || d.names.some(isTainted));
    tainted.set(n, t);
    return t;
  };
  // What a variable may hold: what it was set to, the words it was set to
  // spelled out in turn, or nothing (unset: the runner's own, or empty).
  const valuesOf = (n: string, depth: number): string[] => {
    const d = deps.get(n);
    if (!d || depth > 6) return [''];
    // Empty too: a shell it starts doesn't have a variable it didn't
    // export, `env -u` takes one away, `shift` empties a positional.
    const empty = n.startsWith('#args:') || !exported.has(n) || cleared.has(n) || cleared.has('*') ? [''] : [];
    return [...empty, ...(d.values ?? []), ...(d.forms ?? []).flatMap((f) => expand(f, depth + 1))].slice(0, 32);
  };
  const expand = (t: Tpl, depth: number): string[] => {
    let outs = [''];
    for (const p of t) {
      const opts = typeof p === 'string' ? [p] : [...(p.v ? valuesOf(p.v, depth) : ['']), ...(p.alt !== undefined ? [p.alt] : [])];
      outs = [...new Set(outs.flatMap((o) => opts.map((x) => o + x)))].slice(0, 64);
    }
    return outs;
  };
  let somewhere = w.somewhere;
  const written = [...w.written];
  for (const p of w.pending ?? []) {
    if (w.assignsAny || p.direct || p.names.some(isTainted)) {
      somewhere ??= p.where;
      continue;
    }
    for (const v of expand(p.tpl, 0)) {
      if (!v || v.length > 4096) continue;
      if (/[*?[]/.test(v) || (p.flag && v.startsWith('-'))) somewhere ??= p.where;
      // A folder can't be written over by a redirect or a file's write, and
      // one is what a variable left empty makes of `"$dest"`.
      else {
        for (const d of path.isAbsolute(v) ? [''] : p.dirs) {
          const at = path.resolve(d, v);
          // A copy into a folder writes what's copied, by name, in it; one
          // whose names aren't known could write anything there.
          if (!isDir(at)) written.push([at, p.where]);
          else if (p.into && p.srcs) for (const n of p.srcs) written.push([path.join(at, n), p.where]);
          else if (p.into) somewhere ??= p.where;
        }
      }
    }
  }
  if (!written.length && !somewhere) return undefined;
  if (!w.reached.length) return undefined;
  const definite = definiteWrite(written, w.reached, top);
  if (definite) return { problem: definite, definite: true };
  if (somewhere) return { problem: `${somewhere} writes files where it works out as it runs (or where its data says), which could be ones it runs, so patch trust can't follow what runs after it.`, definite: false };
  return undefined;
}

function definiteWrite(written: [string, string][], reachedList: string[], top: string): string | undefined {
  const fold = process.platform === 'darwin' || IS_WINDOWS;
  const keys = (p: string) => [...new Set([path.resolve(p), realOrNearest(path.resolve(p))])].map((k) => (fold ? k.toLowerCase() : k));
  // `require('./helper')` with no helper.js yet reaches ./helper: a
  // write of helper.js or helper/index.js is it (Gemini's review).
  const reached = new Set(reachedList.flatMap((r) => (path.extname(r) ? [r] : [r, ...JS_EXT.map((e) => r + e), ...JS_EXT.map((e) => path.join(r, 'index' + e))])).flatMap(keys));
  // By inode too: a link made before (hard or not) is the same file.
  const inodes = new Set<string>();
  for (const r of reachedList.slice(0, 2000)) {
    try {
      const st = fs.statSync(r);
      if (st.isFile()) inodes.add(`${st.dev}:${st.ino}`);
    } catch {
      // not there
    }
  }
  for (const [file, where] of written) {
    try {
      const st = fs.statSync(file);
      if (st.isFile() && inodes.has(`${st.dev}:${st.ino}`)) return `${where} writes ${path.relative(top, file) || file}, which is (by a link) a file it also runs or loads, so what runs then isn't what was hashed. Patch trust can't follow that.`;
    } catch {
      // not there yet
    }
    for (const k of keys(file)) {
      if (reached.has(k) || [...reached].some((r) => r.startsWith(k.endsWith(path.sep) ? k : k + path.sep))) {
        const rel = path.relative(top, file);
        const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
        return `${where} writes ${shown}, which it also runs or loads, so what runs then isn't what was hashed. Patch trust can't follow that.`;
      }
    }
  }
  return undefined;
}

// Whether an awk program prints to a file (`print > "run.sh"`): a `>` after
// a print in the same statement, outside strings. Linear: strings out
// first, then each statement looked at once.
export function awkWritesFile(prog: string): boolean {
  // One pass: strings, regex literals and comments skipped (a `"` in
  // `/"/` or `# "` hid what came after: Gemini's review), a backslash-
  // newline joining lines, and a statement ending at ; { } or a newline.
  // A `>` outside parentheses after a print is its output file.
  let inPrint = false;
  let depth = 0;
  let prev = '';
  for (let i = 0; i < prog.length; i++) {
    const c = prog[i]!;
    if (c === '\\' && prog[i + 1] === '\n') {
      i++;
      continue;
    }
    if (c === '"') {
      for (i++; i < prog.length && prog[i] !== '"'; i++) if (prog[i] === '\\') i++;
      prev = '"';
      continue;
    }
    if (c === '#') {
      while (i < prog.length && prog[i] !== '\n') i++;
      i--;
      continue;
    }
    if (c === '/' && (prev === '' || '(,~!&|{};\n=<>?:'.includes(prev))) {
      for (i++; i < prog.length && prog[i] !== '/' && prog[i] !== '\n'; i++) {
        if (prog[i] === '\\') i++;
        else if (prog[i] === '[') while (i < prog.length && prog[i] !== ']' && prog[i] !== '\n') i++;
      }
      prev = '/';
      continue;
    }
    if (c === ';' || c === '{' || c === '}' || c === '\n') {
      inPrint = false;
      depth = 0;
    } else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === '>' && inPrint && depth === 0) return true;
    else if (c === 'p' && /^printf?\b/.test(prog.slice(i, i + 7)) && !/[\w$]/.test(prog[i - 1] ?? '')) inPrint = true;
    if (c !== ' ' && c !== '\t') prev = c;
  }
  return false;
}
