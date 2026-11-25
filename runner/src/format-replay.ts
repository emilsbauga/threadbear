// Carrying work across a whole-tree format commit: a commit that is only a
// formatter's output (`cargo fmt --all` over desktop/, say) conflicts with
// every branch and every fork that changed those files before it, all over,
// though nothing about the code clashes.
//
// Formatting is deterministic, so none of that needs a person. Each of the
// branch's commits is made again with its tree run through the same
// formatter, and its change, in formatted terms (formatted parent to
// formatted commit), goes onto main as a rebase would put it. For a branch
// based on the format commit's parent that is exactly "each commit's tree,
// formatted, on top of the format commit"; a branch based further back gets
// the same three-way merge a rebase would do, only with both sides formatted,
// so the conflicts left are real ones.
//
// The format commits are listed in .git-blame-ignore-revs (git blame and
// GitHub look past them), each under `# format-...:` lines saying how it was
// made: the commit's subject (to find it before its id is written down, as
// tb land and scripts/sync-main.sh may both rebase it), the command, run from
// the top of a copy of the tree, the folders it formats, and the config files
// it formats with (taken from the format commit itself, so an older tree is
// formatted as the format commit was, toolchain included).
//
// Used by `tb land` (worktrees.ts) and scripts/replay-over-format.sh (the CLI
// at the bottom), which a fork also runs to bring in a release with a format
// commit in it (docs/bringing-in-updates.md). Only node's own modules, so a
// fork that doesn't have this file yet can run the release's copy of it.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORMAT_LIST = '.git-blame-ignore-revs';

export type FormatEntry = {
  subject: string;
  command: string;
  paths: string[];
  config: string[];
  id?: string;
  // Made by `# format-tool:` rather than `# format-command:`: a tool that
  // may also add and delete files in what it formats (splitting one file
  // into several, scripts/split-protocol.mjs), where a formatter only
  // changes the files there are. A copy older than this key skips the whole
  // entry, so it rebases as before and stops at the conflict rather than
  // carry work across without the files the tool made.
  adds?: true;
};

export type FormatCommit = { entry: FormatEntry; commit: string };

// --------------------------------------------------------------- the list

const HEX = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// The entries in a .git-blame-ignore-revs. A block of `# format-<key>: value`
// lines describes one; the id on the line after it, if there is one, is the
// commit. Other ids (plain blame skips) and comments are left alone.
export function parseFormatList(text: string): FormatEntry[] {
  const out: FormatEntry[] = [];
  let cur: Partial<FormatEntry> | undefined;
  const finish = (id?: string) => {
    if (cur?.subject && cur.command && cur.paths?.length) {
      out.push({ subject: cur.subject, command: cur.command, paths: cur.paths, config: cur.config ?? [], ...(id ? { id } : {}), ...(cur.adds ? { adds: true as const } : {}) });
    }
    cur = undefined;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^#\s*format-(subject|command|tool|paths|config):\s*(.*)$/.exec(line);
    if (m) {
      const [, key, value] = m;
      if (key === 'subject') {
        finish();
        cur = { subject: value.trim() };
      } else if (cur) {
        if (key === 'command' || key === 'tool') {
          cur.command = value.trim();
          if (key === 'tool') cur.adds = true;
          else delete cur.adds;
        }
        else cur[key as 'paths' | 'config'] = value.split(/\s+/).filter(Boolean).map((p) => p.replace(/\/+$/, ''));
      }
      continue;
    }
    if (HEX.test(line)) {
      finish(line);
      continue;
    }
    if (line && !line.startsWith('#')) finish();
  }
  finish();
  return out;
}

// --------------------------------------------------------------- git

type Run = { ok: boolean; code: number; stdout: string; stderr: string };

const GIT_SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'advice.graftFileDeprecated=false'];

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Ones that point git at some other repo or index (set inside a git hook).
  // And config handed down from a `git -c` or a hook, which would beat GIT_SAFE.
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete env[k];
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  // Replacement objects and grafts off, after the caller's: an id is that
  // object, so a release's signed commit merges as itself, never what a
  // refs/replace/ entry or info/grafts in this checkout puts in its place
  // (Daybreak 180, 24 Nov 2026). --merge refuses a checkout with either.
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' };
}

// Why a release can't be merged here as its id names it, or undefined: the
// checkout has replacement refs or grafts (scripts/merge-preview.sh says
// the same).
export async function substitutes(cwd: string): Promise<string | undefined> {
  const listed = await git(cwd, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/replace/']);
  const found = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  // A look that fails can't say there are none (git older than 2.31 has no
  // --path-format).
  if (!listed.ok || !found.ok) return `Couldn't tell whether this checkout has git replacement refs or grafts (${(listed.ok ? found : listed).stderr.trim().split('\n')[0]}), so the release isn't merged.`;
  const replaced = listed.stdout.trim();
  if (replaced) return `This checkout has git replacement refs (${replaced}), which could have git merge other objects in place of the release's: remove them (git replace -d) first.`;
  const common = found.stdout.trim();
  if (common && fs.existsSync(path.join(common, 'info', 'grafts'))) return `This checkout has git grafts (${path.join(common, 'info', 'grafts')}), which could have git merge other history in place of the release's: remove that file first.`;
  return undefined;
}

// Bringing in a release (--merge): the commit-graph off too, a file in the
// checkout's objects git reads a commit's tree and parents from in place of
// the commit (Codex's review of Daybreak 180). Not for tb land's replays,
// which carry the owner's own commits.
let noCommitGraph = false;

export function git(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile('git', [...GIT_SAFE, ...(noCommitGraph ? ['-c', 'core.commitGraph=false'] : []), '-C', cwd, ...args], { env: cleanEnv(extra), maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      const e = err as { code?: unknown; signal?: unknown } | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : e.signal ? -1 : 1;
      resolve({ ok: !err, code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function out(cwd: string, args: string[], extra?: NodeJS.ProcessEnv): Promise<string> {
  const r = await git(cwd, args, extra);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
  return r.stdout.trim();
}

async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', a, b])).ok;
}

const short = (id: string) => id.slice(0, 10);

// --------------------------------------------------------------- finding them

// The format commits in `ref`'s history, oldest first, from the list as
// `listFrom` (`ref` itself by default) has it. One whose id isn't written
// down yet (or isn't in `ref`) is found by its subject.
export async function formatCommitsIn(cwd: string, ref: string, listFrom = ref): Promise<FormatCommit[]> {
  const list = await git(cwd, ['show', `${listFrom}:${FORMAT_LIST}`]);
  if (!list.ok) return [];
  const entries = parseFormatList(list.stdout);
  if (!entries.length) return [];
  let subjects: Map<string, string[]> | undefined;
  const found: FormatCommit[] = [];
  for (const entry of entries) {
    let commit: string | undefined;
    if (entry.id && (await git(cwd, ['rev-parse', '--verify', '--quiet', `${entry.id}^{commit}`])).ok && (await isAncestor(cwd, entry.id, ref)) && (listFrom === ref || (await isAncestor(cwd, entry.id, listFrom)))) {
      commit = entry.id;
    } else {
      if (!subjects) {
        subjects = new Map();
        // Another ref's list names commits of that ref's history only.
        const log = await out(cwd, ['log', '--no-merges', '--format=%H%x00%s', listFrom === ref ? ref : listFrom]);
        for (const line of log.split('\n')) {
          const [id, s] = line.split('\0');
          if (id && s !== undefined) subjects.set(s, [...(subjects.get(s) ?? []), id]);
        }
      }
      // Only one: a second with the same subject (a revert's is different,
      // but a cherry-pick or a copy isn't) can't say which was the format
      // commit, so nothing is crossed until its id is written down.
      const ids = subjects.get(entry.subject) ?? [];
      if (ids.length === 1) commit = ids[0];
    }
    // From another ref's list, a commit only that ref has: never one of the
    // waiting branches a group check stacks on main, whose config would be
    // theirs (Gemini's second review, 21 Nov).
    if (commit && listFrom !== ref && !(await isAncestor(cwd, commit, listFrom))) commit = undefined;
    // And it has to be only what it formats: anything else in it would be
    // lost from a fork's merge across it (mergeAcross).
    if (commit && (await onlyWithin(cwd, commit, entry))) found.push({ entry, commit });
  }
  if (found.length < 2) return found;
  // Oldest first: an ancestor has fewer commits behind it than its descendants.
  const rank = new Map<string, number>();
  for (const f of found) rank.set(f.commit, Number(await out(cwd, ['rev-list', '--count', f.commit])));
  return found.sort((a, b) => (rank.get(a.commit) ?? 0) - (rank.get(b.commit) ?? 0));
}

// Whether `commit` (not a merge) changes nothing outside the folders it
// formats, and none of its config: a fork's merge across it takes its
// changes from formatting this copy's tree, which leaves config as it was.
async function onlyWithin(cwd: string, commit: string, entry: FormatEntry): Promise<boolean> {
  const paths = entry.paths;
  const parents = (await git(cwd, ['rev-list', '--parents', '-n', '1', commit])).stdout.trim().split(' ');
  if (parents.length !== 2) return false;
  const changed = await git(cwd, ['diff', '--name-only', '-z', `${commit}^`, commit]);
  if (!changed.ok) return false;
  return changed.stdout.split('\0').filter(Boolean).every((p) => !entry.config.includes(p) && paths.some((s) => p === s || p.startsWith(`${s}/`)));
}

// The format commits `onto` has that `tip` doesn't: what carrying `tip`
// onto `onto` crosses. Their commands come from `listFrom`'s list, `onto`'s
// by default: tb land's group check stacks waiting branches that haven't
// landed into `onto`, so it names main, whose list is the one trusted
// (Gemini's review, 21 Nov).
export async function crossings(cwd: string, tip: string, onto: string, listFrom = onto): Promise<FormatCommit[]> {
  // Most landings: every listed id is already in the branch, so nothing more to look up.
  const list = await git(cwd, ['show', `${listFrom}:${FORMAT_LIST}`]);
  if (!list.ok) return [];
  const entries = parseFormatList(list.stdout);
  if (!entries.length) return [];
  let known = true;
  for (const e of entries) if (!e.id || !(await isAncestor(cwd, e.id, tip)) || !(await isAncestor(cwd, e.id, onto))) known = false;
  if (known) return [];
  const all = await formatCommitsIn(cwd, onto, listFrom);
  const out: FormatCommit[] = [];
  for (const f of all) if (!(await isAncestor(cwd, f.commit, tip))) out.push(f);
  return out;
}

// Whether any commit in `range` changes a file one of these formats.
export async function touchesFormatted(cwd: string, range: string, formats: FormatCommit[]): Promise<boolean> {
  const paths = [...new Set(formats.flatMap((f) => f.entry.paths))];
  if (!paths.length) return false;
  // -m: a merge's own resolution counts too.
  const changed = await out(cwd, ['log', '-m', '--format=', '--name-only', range, '--', ...paths]);
  return changed.length > 0;
}

// --------------------------------------------------------------- formatting a tree

export type FormatNote = { commit?: string; what: string };

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    // Git Bash on Windows; a group of its own elsewhere, so a time limit
    // stops the formatter's children too, and with them the output pipes
    // this waits on.
    const shell = process.platform === 'win32' ? 'bash' : '/bin/sh';
    // The format commit's own toolchain file decides, not one set outside.
    const env = cleanEnv();
    delete env.RUSTUP_TOOLCHAIN;
    const child = spawn(shell, ['-c', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let text = '';
    let done = false;
    const finish = (ok: boolean, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, text: text + extra });
    };
    const add = (b: Buffer) => {
      if (text.length < 64_000) text += b.toString();
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Gone already.
      }
      // Whatever still holds the pipes, this has waited long enough.
      setTimeout(() => finish(false, `\nStopped after ${Math.round(timeoutMs / 1000)} s.`), 2000).unref();
    }, timeoutMs);
    child.on('error', (e) => finish(false, String(e)));
    child.on('close', (code) => finish(code === 0));
  });
}

// Files in a tree being formatted that would pick the program its command
// runs, or run one of their own: a toolchain file (rustup runs whatever a
// `path` toolchain names), cargo's config (an alias for `fmt`), a version
// manager's (mise, once rtx, runs an env script from any of its names, or
// under .config; proto loads plugins). Where a tree has one the format
// commit's config doesn't name, or a link (a formatter writes through it),
// the command isn't run on it. Matched as the disk will open the name: a
// Mac's disk ignores case (`.CARGO` is `.cargo` to cargo there; Codex's
// review, 21 Nov) and treats Unicode forms alike.
const STEERS = /(^|\/)(rust-toolchain(\.toml)?|\.cargo|\.?(mise|rtx)(\.[^/]*)?\.toml|\.?(mise|rtx)(?=\/)|\.config|\.tool-versions|\.prototools(\.[^/]*)?)(\/|$)/i;
const asDiskSees = (p: string) => p.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '').toLowerCase();
const steers = (p: string, config: string[]) => STEERS.test(asDiskSees(p)) && !config.some((c) => asDiskSees(c) === asDiskSees(p));

// Formats trees the way the given format commits did, each in turn, with a
// cache: what a formatter makes depends only on the folders it formats.
export class TreeFormatter {
  private readonly cache = new Map<string, { tree: string; failed?: string }>();
  readonly limitMs: number;
  private readonly cwd: string;
  readonly formats: FormatCommit[];

  constructor(cwd: string, formats: FormatCommit[], opts: { limitMs?: number } = {}) {
    this.cwd = cwd;
    this.formats = formats;
    this.limitMs = opts.limitMs ?? 10 * 60_000;
  }

  // The tree, formatted, and why a formatter failed on it if one did. A
  // formatter that fails still leaves what it managed (rustfmt formats every
  // crate it can parse), and the rest of the tree as it was.
  async format(tree: string): Promise<{ tree: string; failed: string[] }> {
    let cur = tree;
    const failed: string[] = [];
    for (const f of this.formats) {
      const r = await this.formatOne(cur, f);
      cur = r.tree;
      if (r.failed) failed.push(r.failed);
    }
    return { tree: cur, failed };
  }

  private async formatOne(tree: string, f: FormatCommit): Promise<{ tree: string; failed?: string }> {
    const parts: string[] = [];
    for (const p of f.entry.paths) {
      // Mode, type and id: a path can be a file, whose mode can change alone.
      const r = await git(this.cwd, ['ls-tree', '-z', tree, '--', p]);
      parts.push((r.ok && r.stdout.split('\0').find((l) => l.endsWith(`\t${p}`))?.split('\t')[0]) || '-');
    }
    // Nothing it formats is in this tree.
    if (parts.every((p) => p === '-')) return { tree };
    // The attributes above those folders count too (eol, filters): the
    // top's and each folder's on the way down.
    for (const p of f.entry.paths) {
      const dirs = p.split('/').slice(0, -1);
      for (let i = 0; i <= dirs.length; i++) {
        const at = [...dirs.slice(0, i), '.gitattributes'].join('/');
        const r = await git(this.cwd, ['rev-parse', '--verify', '--quiet', `${tree}:${at}`]);
        parts.push(r.ok ? r.stdout.trim() : '-');
      }
    }
    const key = `${f.commit}\0${parts.join('\0')}`;
    let made = this.cache.get(key);
    if (!made) {
      made = await this.materialize(tree, f);
      this.cache.set(key, made);
    }
    // The formatted folders, put into this tree.
    if (made.tree === tree) return made;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-fmt-idx-'));
    try {
      const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
      await out(this.cwd, ['read-tree', tree], env);
      for (const p of f.entry.paths) {
        // From the temp index only: never anything to do with a working tree.
        const inIt = (await out(this.cwd, ['ls-files', '-z', '--', p], env)).split('\0').filter(Boolean);
        if (inIt.length) await stdinGit(this.cwd, ['update-index', '-z', '--force-remove', '--stdin'], inIt.join('\0'), env);
        const sub = await git(this.cwd, ['rev-parse', '--verify', '--quiet', `${made.tree}:${p}`]);
        if (!sub.ok) continue;
        // A path can be one file (a tool's format-paths: docs/protocol.md).
        const entry = (await out(this.cwd, ['ls-tree', '-z', made.tree, '--', p])).split('\0').filter(Boolean)[0] ?? '';
        if (entry.split(' ')[1] === 'blob') await stdinGit(this.cwd, ['update-index', '-z', '--add', '--index-info'], `${entry}\0`, env);
        else await out(this.cwd, ['read-tree', `--prefix=${p}/`, sub.stdout.trim()], env);
      }
      return { tree: await out(this.cwd, ['write-tree'], env), failed: made.failed };
    } finally {
      rmQuietly(dir);
    }
  }

  // Checks the folders out into a temp folder with the format commit's
  // config files, runs the command there, and reads back what it changed.
  // Only files the tree already has are read back: a formatter has no
  // business making new ones. A tool (format-tool) may, under its paths.
  private async materialize(tree: string, f: FormatCommit): Promise<{ tree: string; failed?: string }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-fmt-'));
    const work = path.join(dir, 'tree');
    fs.mkdirSync(work);
    try {
      const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
      await out(this.cwd, ['read-tree', tree], env);
      const staged = (await out(this.cwd, ['ls-files', '-s', '-z', '--', ...f.entry.paths], env)).split('\0').filter(Boolean);
      const files = staged.map((l) => l.slice(l.indexOf('\t') + 1));
      // The tree is a branch's, so what's in it is data for the command, never
      // what decides which program runs.
      // (A config file is swapped for the format commit's below, link or not.)
      const ours = (l: string) => f.entry.config.includes(l.slice(l.indexOf('\t') + 1));
      const link = staged.find((l) => l.startsWith('120000 ') && !ours(l));
      const steer = link ? link.slice(link.indexOf('\t') + 1) : files.find((p) => steers(p, f.entry.config));
      if (steer) {
        return { tree, failed: `${steer} is ${link ? 'a link' : 'a file that can change what the command runs'}, and the format commit's own config doesn't name it, so ${f.entry.command} wasn't run on this tree` };
      }
      // Attributes (eol, filters) from the tree itself both ways, so what
      // comes back differs only by what the formatter did.
      const attr = `--attr-source=${tree}`;
      await stdinGit(this.cwd, [attr, 'checkout-index', '-u', '-z', '--stdin', `--prefix=${work}/`], files.join('\0'), env);
      // The format commit's own config, in place of the tree's (or none).
      // Never through a link the tree has there: it's taken away first, and
      // the tree's own entry checked out again afterwards.
      const inTree = new Set((f.entry.config.length ? await out(this.cwd, ['ls-files', '-z', '--', ...f.entry.config], env) : '').split('\0').filter(Boolean));
      for (const c of f.entry.config) {
        const target = path.join(work, c);
        // Not under a link the tree has for a folder on the way, either.
        if (!realFoldersTo(work, c)) return { tree, failed: `${c} is under a link in this tree, so it wasn't formatted` };
        removeEntry(target, true);
        const blob = await gitBuffer(this.cwd, `${f.commit}:${c}`);
        if (blob) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, blob, { flag: 'wx' });
        }
      }
      const ran = await runCommand(f.entry.command, work, this.limitMs);
      // Config files go back to the tree's own, so only formatting is read.
      for (const c of f.entry.config) removeEntry(path.join(work, c), false);
      const back = f.entry.config.filter((c) => inTree.has(c));
      if (back.length) await stdinGit(this.cwd, [attr, 'checkout-index', '-f', '-u', '-z', '--stdin', `--prefix=${work}/`], back.join('\0'), env);
      if (f.entry.adds) {
        // What the tool made and took away too, under the paths there are
        // now, before or after (git add refuses a path that's neither).
        const known = new Set((await out(this.cwd, ['ls-files', '-z', '--', ...f.entry.paths], env)).split('\0').filter(Boolean));
        const there = f.entry.paths.filter((p) => fs.existsSync(path.join(work, p)) || [...known].some((k) => k === p || k.startsWith(`${p}/`)));
        // --force: what it made counts even where a .gitignore in the tree says otherwise.
        if (there.length) await out(this.cwd, [attr, `--work-tree=${work}`, 'add', '-A', '--force', '--', ...there], env);
      } else {
        await out(this.cwd, [attr, `--work-tree=${work}`, 'add', '-u', '--', ...f.entry.paths], env);
      }
      const made = await out(this.cwd, ['write-tree'], env);
      const failed = ran.ok ? undefined : `${f.entry.command} failed: ${lastLines(ran.text, 6)}`;
      return { tree: made, failed };
    } finally {
      rmQuietly(dir);
    }
  }
}

function stdinGit(cwd: string, args: string[], input: string, extra: NodeJS.ProcessEnv): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile('git', [...GIT_SAFE, ...(noCommitGraph ? ['-c', 'core.commitGraph=false'] : []), '-C', cwd, ...args], { env: cleanEnv(extra), maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000, killSignal: 'SIGKILL' }, (err, _o, stderr) =>
      err ? reject(new Error(`git ${args.join(' ')}: ${String(stderr).trim()}`)) : resolve(),
    );
    child.stdin?.end(input);
  });
}

function gitBuffer(cwd: string, object: string): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile('git', [...GIT_SAFE, ...(noCommitGraph ? ['-c', 'core.commitGraph=false'] : []), '-C', cwd, 'cat-file', 'blob', object], { env: cleanEnv(), encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL' }, (err, stdout) =>
      resolve(err ? undefined : stdout),
    );
  });
}

// Whether every folder on the way to `rel` under `root` is a real folder
// (or not there yet), never a link.
function realFoldersTo(root: string, rel: string): boolean {
  const parts = rel.split('/').slice(0, -1);
  let cur = root;
  for (const p of parts) {
    cur = path.join(cur, p);
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    } catch {
      return true;
    }
  }
  return true;
}

// Whatever is at a path gone, a link itself rather than through it, as
// fs.rmSync with force would (recursive only where asked). On Node 24.11
// fs.rmSync returns without error and leaves a link whose target is missing,
// so writing the config there failed with EEXIST and a fork's runner couldn't
// update (Crispaul Obana, 21 Nov).
function removeEntry(file: string, recursive: boolean): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return;
    throw e;
  }
  if (!st.isSymbolicLink()) return fs.rmSync(file, { force: true, recursive });
  try {
    fs.unlinkSync(file);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    // A link to a folder on Windows refuses unlink and goes with rmdir.
    if (process.platform !== 'win32' || code !== 'EPERM') throw e;
    try {
      fs.rmdirSync(file);
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code !== 'ENOENT') throw e2;
    }
  }
}

function rmQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // A formatter still holding a file there (Windows): the temp folder keeps it.
  }
}

function lastLines(text: string, n: number): string {
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.slice(-n).join(' | ') || '(no output)';
}

// --------------------------------------------------------------- carrying a branch

export type Carried =
  | { ok: true; tip: string; count: number; notes: string[] }
  | { ok: false; conflict: string[]; at: string; subject: string; notes: string[] }
  | { ok: false; error: string; notes: string[] };

// `base..tip`'s commits made again on `onto` (which has the format
// commits), formatted, as a rebase would: each one's change from its
// formatted parent to it formatted, merged onto the commits carried so far.
// Touches no working tree. A commit made empty is dropped, as rebase drops
// it, unless it was empty to start with. `tip` must have no merges past
// `base`.
export async function carryAcross(cwd: string, a: { base: string; tip: string; onto: string; formatter: TreeFormatter }): Promise<Carried> {
  const notes: string[] = [];
  const list = (await out(cwd, ['rev-list', '--reverse', '--topo-order', `${a.base}..${a.tip}`])).split('\n').filter(Boolean);
  if ((await out(cwd, ['rev-list', '--merges', `${a.base}..${a.tip}`])) !== '') {
    return { ok: false, error: `${short(a.tip)} has a merge on it past ${short(a.base)}, so it can't be carried commit by commit.`, notes };
  }
  // A formatter that can't format the base at all (not installed, say) would
  // carry nothing formatted: say so rather than leave the work half done.
  const baseTree = await out(cwd, ['rev-parse', `${a.base}^{tree}`]);
  const first = await a.formatter.format(baseTree);
  if (first.failed.length) {
    return { ok: false, error: `Couldn't format ${short(a.base)}, the commit this work starts from: ${first.failed.join('; ')}`, notes };
  }
  const landed = await alreadyOn(cwd, a.onto, a.tip, a.base);
  const asCommit = async (tree: string) => out(cwd, ['commit-tree', tree, '-m', 'formatted'], IDENT);
  let prev = first.tree;
  let prevCommit = await asCommit(prev);
  let tip = a.onto;
  let count = 0;
  for (const c of list) {
    if (landed.has(c)) {
      // Formatted it may not go on cleanly, and it isn't needed: rebase
      // leaves it out the same way.
      notes.push(`${short(c)} (${await out(cwd, ['log', '-1', '--format=%s', c])}) was left out: it's on ${short(a.onto)} already.`);
      prev = (await formatCommit(cwd, a.formatter, c, prev, notes, '')).tree;
      prevCommit = await asCommit(prev);
      continue;
    }
    const orig = await out(cwd, ['rev-parse', `${c}^{tree}`]);
    const parentTree = await out(cwd, ['rev-parse', `${c}^^{tree}`]).catch(() => '');
    const subject = await out(cwd, ['log', '-1', '--format=%s', c]);
    const formatted = await formatCommit(cwd, a.formatter, c, prev, notes, subject);
    const fc = await asCommit(formatted.tree);
    const merged = await git(cwd, ['merge-tree', '--write-tree', '--name-only', `--merge-base=${prevCommit}`, tip, fc]);
    if (!merged.ok) {
      if (merged.code === 1) {
        const lines = merged.stdout.split('\n');
        const files: string[] = [];
        for (const l of lines.slice(1)) {
          if (!l.trim()) break;
          files.push(l.trim());
        }
        return { ok: false, conflict: [...new Set(files)], at: c, subject, notes };
      }
      return { ok: false, error: `git merge-tree failed on ${short(c)}: ${(merged.stderr || merged.stdout).trim().split('\n')[0]}`, notes };
    }
    const tree = merged.stdout.split('\n')[0].trim();
    const wasEmpty = orig === parentTree;
    const tipTree = await out(cwd, ['rev-parse', `${tip}^{tree}`]);
    prev = formatted.tree;
    prevCommit = fc;
    if (!wasEmpty && tree === tipTree) {
      notes.push(`${short(c)} (${subject}) was left out: formatted, its change is already there.`);
      continue;
    }
    const meta = await out(cwd, ['log', '-1', '--format=%an%x00%ae%x00%ad', '--date=raw', c]);
    const message = (await git(cwd, ['log', '-1', '--format=%B', c])).stdout.replace(/\n+$/, '');
    const [name, email, date] = meta.split('\0');
    tip = await out(cwd, ['commit-tree', tree, '-p', tip, '-m', message], { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date });
    count++;
  }
  return { ok: true, tip, count, notes };
}

// Commit `c`'s tree formatted. Where the formatter fails on it (a file that
// doesn't parse, a crate root it can't read), only the files `c` changes
// are taken as it left them; the rest come from `prev`, its parent
// formatted, so a failure never takes the formatting back out of files the
// commit didn't touch.
async function formatCommit(cwd: string, formatter: TreeFormatter, c: string, prev: string, notes: string[], subject: string): Promise<{ tree: string }> {
  const orig = await out(cwd, ['rev-parse', `${c}^{tree}`]);
  const r = await formatter.format(orig);
  if (!r.failed.length) return r;
  // A tool that moves text to other files can't be half applied (the old
  // file beside the new ones): stop, and the branch is rebased as it is.
  if (formatter.formats.some((f) => f.entry.adds)) throw new Error(`${short(c)} (${subject}): ${r.failed.join('; ')}`);
  for (const why of r.failed) notes.push(`${short(c)} (${subject}) was left partly unformatted: ${why}`);
  const changed = (await git(cwd, ['diff', '--name-only', '--no-renames', '-z', `${c}^`, c])).stdout.split('\0').filter(Boolean);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-fmt-pick-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(dir, 'index') };
    await out(cwd, ['read-tree', prev], env);
    if (changed.length) {
      // Each changed file as the formatter left it in `c`, or gone.
      const listed = (await git(cwd, ['ls-tree', '-r', '-z', r.tree, '--', ...changed])).stdout.split('\0').filter(Boolean);
      const present = new Set<string>();
      const lines: string[] = [];
      for (const l of listed) {
        const tab = l.indexOf('\t');
        const [mode, , id] = l.slice(0, tab).split(' ');
        const name = l.slice(tab + 1);
        present.add(name);
        lines.push(`${mode} ${id}\t${name}`);
      }
      for (const n of changed) if (!present.has(n)) lines.push(`0 ${'0'.repeat(40)}\t${n}`);
      await stdinGit(cwd, ['update-index', '-z', '--index-info'], lines.map((l) => `${l}\0`).join(''), env);
    }
    return { tree: await out(cwd, ['write-tree'], env) };
  } finally {
    rmQuietly(dir);
  }
}

// The commits of `tip` whose change is on `onto` already (landed as a
// rebased copy), as rebase finds them: by patch id. An empty one never is
// (rebase keeps those).
async function alreadyOn(cwd: string, onto: string, tip: string, base: string): Promise<Set<string>> {
  const marked = await git(cwd, ['rev-list', '--right-only', '--cherry-mark', '--no-merges', `${onto}...${tip}`]);
  const same = new Set<string>();
  if (!marked.ok) return same;
  // And any of base..tip that is on it as it is (the same commit, landed).
  const own = await git(cwd, ['rev-list', `${onto}..${tip}`]);
  if (own.ok) {
    const mine = new Set(own.stdout.split('\n').filter(Boolean));
    for (const c of (await git(cwd, ['rev-list', `${base}..${tip}`])).stdout.split('\n').filter(Boolean)) if (!mine.has(c)) same.add(c);
  }
  for (const line of marked.stdout.split('\n')) {
    if (line[0] !== '=') continue;
    const c = line.slice(1).trim();
    const t = await git(cwd, ['rev-parse', `${c}^{tree}`, `${c}^^{tree}`]);
    const [a, b] = t.stdout.trim().split('\n');
    if (a !== b) same.add(c);
  }
  return same;
}

// --------------------------------------------------------------- what a branch adds

// What a landing of `tip` onto `base` would change in what later landings
// run on this Mac: recipes its list has that `base`'s doesn't, and config
// files of any listed recipe (a format tool's own script, the toolchain
// file) it changes. With an id that stands for exactly those, recipes and
// file contents both, for `tb land --allow-format <id>`. Throws when the
// list can't be read, rather than calling that no change.
export async function formatChanges(cwd: string, base: string, tip: string): Promise<{ entries: FormatEntry[]; configs: string[]; id: string }> {
  const read = async (ref: string) => {
    const at = await git(cwd, ['ls-tree', '--name-only', ref, '--', FORMAT_LIST]);
    if (!at.ok) throw new Error(`couldn't read ${ref}'s tree`);
    if (!at.stdout.trim()) return [];
    const r = await git(cwd, ['show', `${ref}:${FORMAT_LIST}`]);
    if (!r.ok) throw new Error(`couldn't read ${ref}:${FORMAT_LIST}`);
    return parseFormatList(r.stdout);
  };
  const before = await read(base);
  const after = await read(tip);
  // By recipe and subject: an entry naming another commit for a recipe main
  // trusts (a new subject) says which tree's config that recipe later runs
  // with, so it counts too. Only an id written in under the same subject
  // and recipe (filled in once the commit is on main) doesn't; one changed
  // to name another commit does.
  const ident = (e: FormatEntry) => JSON.stringify([recipe(e), e.subject]);
  const ids = new Map<string, Set<string | undefined>>();
  for (const e of before) ids.set(ident(e), (ids.get(ident(e)) ?? new Set()).add(e.id));
  const fresh = (e: FormatEntry) => {
    const had = ids.get(ident(e));
    return !had || (e.id !== undefined && !had.has(e.id) && !had.has(undefined));
  };
  const seen = new Set<string>();
  const entries = after.filter((e) => fresh(e) && !seen.has(ident(e) + (e.id ?? '')) && seen.add(ident(e) + (e.id ?? '')));
  const paths = [...new Set([...before, ...after].flatMap((e) => e.config))].sort();
  const configs: string[] = [];
  const blobs: string[] = [];
  for (const p of paths) {
    const blob = async (ref: string) => {
      const r = await git(cwd, ['ls-tree', ref, '--', p]);
      if (!r.ok) throw new Error(`couldn't read ${ref}:${p}`);
      return r.stdout.trim();
    };
    const now = await blob(tip);
    if ((await blob(base)) !== now) {
      configs.push(p);
      blobs.push(`${p}\0${now}`);
    }
  }
  const id = createHash('sha256').update(JSON.stringify([[...seen].sort(), blobs])).digest('hex').slice(0, 12);
  return { entries, configs, id };
}

// --------------------------------------------------------------- a branch with one

export type Untrusted = { commit: string; subject: string; command: string; why: 'unlisted' | 'config' };

export type Remade =
  | { ok: true; tip: string; remade: string[]; notes: string[] }
  | { ok: false; conflict: string[]; at: string; subject: string }
  | { ok: false; error: string }
  | { ok: false; untrusted: Untrusted[] };

// How an entry makes its commit: what runs, whether it may add files, what
// it formats and the config it formats with. Two entries that agree on all
// of that run the same thing, whatever their subjects.
function recipe(e: FormatEntry): string {
  return JSON.stringify([e.command, Boolean(e.adds), e.paths, e.config]);
}

// A branch that is itself bringing in a format commit (the commit that ran
// the formatter, listed in its own .git-blame-ignore-revs and not on `onto`
// yet) can't be rebased: by the time it lands, main has moved on in the
// files it rewrote, and its diff conflicts with all of that, though nothing
// clashes. So that commit is made again instead, by running the same tool
// on the tree it now goes onto, with its message and author; the branch's
// other commits are picked as a rebase picks them. Undefined when the branch
// has no such commit. Touches no working tree; a commit made empty is
// dropped, as rebase drops it.
//
// The list comes from the branch, which anyone who can commit to it writes,
// so its command is never trusted for that (Codex Security, 21 Nov): only an
// entry whose recipe (command, kind, paths and config) `onto`'s own list has,
// byte for byte, is run, with config no commit of the branch changed. Any
// other that would have to be run comes back as `untrusted`, before anything
// has run, for a person to make again by hand. One the branch already made
// on `onto` as it is now needs no running: it's picked as it is.
export async function remakeOwn(cwd: string, onto: string, tip: string, opts: { toolsOnly?: boolean } = {}): Promise<Remade | undefined> {
  const list = await git(cwd, ['show', `${tip}:${FORMAT_LIST}`]);
  if (!list.ok) return undefined;
  // Not one already on `onto` (a later commit reusing its words isn't it),
  // and with toolsOnly, only a format-tool's.
  const landed = new Set((await out(cwd, ['log', '--no-merges', '--format=%s', onto])).split('\n'));
  const entries = parseFormatList(list.stdout).filter((e) => !landed.has(e.subject) && (!opts.toolsOnly || e.adds));
  if (!entries.length) return undefined;
  // As rebase picks them: less any whose change is on `onto` already.
  const marked = (await out(cwd, ['rev-list', '--reverse', '--topo-order', '--right-only', '--cherry-mark', '--no-merges', `${onto}...${tip}`])).split('\n').filter(Boolean);
  if ((await out(cwd, ['rev-list', '--merges', `${onto}..${tip}`])) !== '') return undefined;
  const picks: { c: string; format?: FormatEntry }[] = [];
  let any = false;
  const onMain = await git(cwd, ['show', `${onto}:${FORMAT_LIST}`]);
  const trusted = new Set((onMain.ok ? parseFormatList(onMain.stdout) : []).map(recipe));
  const untrusted: Untrusted[] = [];
  // Config files the branch's commits so far change: a tool run with one of
  // those would run the branch's version (a script, a toolchain file).
  const touched = new Set<string>();
  // A subject that's on more than one of them can't say which ran the tool
  // (a later fix with the same words would be run away): only its id can.
  const seen = new Map<string, number>();
  for (const line of marked) {
    const s = await out(cwd, ['log', '-1', '--format=%s', line.slice(1)]);
    seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  for (const line of marked) {
    const c = line.slice(1);
    const tree = await out(cwd, ['rev-parse', `${c}^{tree}`]);
    const parent = await out(cwd, ['rev-parse', `${c}^^{tree}`]).catch(() => '');
    if (line[0] === '=' && tree !== parent) continue;
    const subject = await out(cwd, ['log', '-1', '--format=%s', c]);
    const entry = entries.find((e) => e.subject === subject && (e.id ? e.id === c : seen.get(subject) === 1));
    let format = entry && (await onlyWithin(cwd, c, entry)) ? entry : undefined;
    if (format) {
      const why = !trusted.has(recipe(format)) ? 'unlisted' : format.config.some((p) => touched.has(p)) ? 'config' : undefined;
      if (why) {
        if (await isAncestor(cwd, onto, c)) format = undefined;
        else untrusted.push({ commit: c, subject, command: format.command, why });
      }
    }
    if (format) any = true;
    else for (const p of (await out(cwd, ['diff', '--name-only', '--no-renames', '-z', `${c}^`, c])).split('\0')) if (p) touched.add(p);
    picks.push({ c, format });
  }
  if (untrusted.length) return { ok: false, untrusted };
  if (!any) return undefined;
  let cur = await out(cwd, ['rev-parse', `${onto}^{commit}`]);
  const remade: string[] = [];
  const notes: string[] = [];
  for (const { c, format } of picks) {
    const subject = await out(cwd, ['log', '-1', '--format=%s', c]);
    const curTree = await out(cwd, ['rev-parse', `${cur}^{tree}`]);
    let tree: string;
    if (format) {
      // With the config as it is where it goes (main may have changed it),
      // as the commit made here is the one later work is carried across.
      const r = await new TreeFormatter(cwd, [{ entry: format, commit: cur }]).format(curTree);
      if (r.failed.length) return { ok: false, error: `Couldn't make ${short(c)} (${subject}) again on ${short(onto)}: ${r.failed.join('; ')}` };
      tree = r.tree;
      if (tree === curTree) {
        notes.push(`${short(c)} (${subject}) was left out: run again on ${short(onto)}, it changes nothing.`);
        continue;
      }
      remade.push(c);
    } else {
      const merged = await git(cwd, ['merge-tree', '--write-tree', '--name-only', `--merge-base=${c}^`, cur, c]);
      if (!merged.ok) {
        if (merged.code !== 1) return { ok: false, error: `git merge-tree failed on ${short(c)}: ${(merged.stderr || merged.stdout).trim().split('\n')[0]}` };
        const files: string[] = [];
        for (const l of merged.stdout.split('\n').slice(1)) {
          if (!l.trim()) break;
          files.push(l.trim());
        }
        return { ok: false, conflict: [...new Set(files)], at: c, subject };
      }
      tree = merged.stdout.split('\n')[0].trim();
      const wasEmpty = (await out(cwd, ['rev-parse', `${c}^{tree}`])) === (await out(cwd, ['rev-parse', `${c}^^{tree}`]).catch(() => ''));
      if (!wasEmpty && tree === curTree) continue;
    }
    const meta = await out(cwd, ['log', '-1', '--format=%an%x00%ae%x00%ad', '--date=raw', c]);
    const message = (await git(cwd, ['log', '-1', '--format=%B', c])).stdout.replace(/\n+$/, '');
    const [name, email, date] = meta.split('\0');
    cur = await out(cwd, ['commit-tree', tree, '-p', cur, '-m', message], { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date });
  }
  // Run again here it changed nothing: not a format commit to bring in.
  if (!remade.length) return undefined;
  return { ok: true, tip: cur, remade, notes };
}

// Only for the throwaway commits that hold a formatted tree for merge-tree.
const IDENT = { GIT_AUTHOR_NAME: 'format', GIT_AUTHOR_EMAIL: 'format@localhost', GIT_COMMITTER_NAME: 'format', GIT_COMMITTER_EMAIL: 'format@localhost', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };

// The branch's commits as formatted copies on a formatted copy of their
// base (whose parent is the real base), so an ordinary `git rebase --onto
// <onto> <first>` puts them on `onto` with conflicts a person can sort out
// as usual. Returns the formatted base and tip.
export async function formattedChain(cwd: string, base: string, tip: string, formatter: TreeFormatter): Promise<{ first: string; tip: string; notes: string[]; copies: Map<string, string> }> {
  const notes: string[] = [];
  const baseTree = (await formatter.format(await out(cwd, ['rev-parse', `${base}^{tree}`]))).tree;
  const first = await out(cwd, ['commit-tree', baseTree, '-p', base, '-m', `Formatted copy of ${short(base)} (replay-over-format.sh)`]);
  let cur = first;
  let prev = baseTree;
  const copies = new Map<string, string>();
  for (const c of (await out(cwd, ['rev-list', '--reverse', '--topo-order', `${base}..${tip}`])).split('\n').filter(Boolean)) {
    const subject = await out(cwd, ['log', '-1', '--format=%s', c]);
    const r = await formatCommit(cwd, formatter, c, prev, notes, subject);
    const wasEmpty = (await out(cwd, ['rev-parse', `${c}^{tree}`])) === (await out(cwd, ['rev-parse', `${c}^^{tree}`]).catch(() => ''));
    // One that only reformatted is nothing once formatted: rebase would keep
    // it as an empty commit, so it's left out here, as carryAcross does.
    if (r.tree === prev && !wasEmpty) {
      notes.push(`${short(c)} (${subject}) was left out: formatted, it changes nothing.`);
      continue;
    }
    prev = r.tree;
    const meta = await out(cwd, ['log', '-1', '--format=%an%x00%ae%x00%ad', '--date=raw', c]);
    const message = (await git(cwd, ['log', '-1', '--format=%B', c])).stdout.replace(/\n+$/, '');
    const [name, email, date] = meta.split('\0');
    cur = await out(cwd, ['commit-tree', r.tree, '-p', cur, '-m', message], { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date });
    copies.set(c, cur);
  }
  return { first, tip: cur, notes, copies };
}

// --------------------------------------------------------------- merging across

export type Merged = { ok: true; notes: string[] } | { ok: false; conflict: string[]; step: string; notes: string[] } | { ok: false; error: string; notes: string[] };

// For a history that brings things in with merges (a fork bringing in
// Mike's release): before merging `target`, each format commit F it has and
// HEAD doesn't comes in as two merges: F's parent (an ordinary merge, whose
// conflicts are real ones), then F itself, with HEAD's tree formatted the
// way F was made as the result (F is only formatting, so that is everything
// both sides have). Then `target` merges as usual, both sides formatted.
// Runs in the checkout at `cwd`, which must be clean. A conflict is left
// in place for a person when `leave` is set, and undone otherwise.
export async function mergeAcross(cwd: string, target: string, opts: { message?: string; leave?: boolean; final?: boolean } = {}): Promise<Merged> {
  const notes: string[] = [];
  const head = await out(cwd, ['rev-parse', 'HEAD']);
  const cross = await crossings(cwd, head, target);
  // Back to where it started; says so when it couldn't be.
  const undo = async (): Promise<string> => {
    await git(cwd, ['merge', '--abort']);
    const back = await git(cwd, ['reset', '--keep', head]);
    return back.ok ? '' : ` It couldn't go back to ${short(head)} by itself (${(back.stderr || back.stdout).trim().split('\n')[0]}): git reset --hard ${short(head)} does.`;
  };
  // Only a conflict is left for a person (opts.leave); anything else goes back.
  const failWith = async (error: string): Promise<Merged> => ({ ok: false, error: error + (await undo()), notes });
  const merge = async (what: string, message: string, step: string): Promise<Merged | undefined> => {
    const m = await git(cwd, ['merge', '--no-ff', '-m', message, what]);
    if (m.ok) return undefined;
    const conflict = (await out(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).split('\n').filter(Boolean);
    if (conflict.length) {
      if (!opts.leave) {
        const stuck = await undo();
        if (stuck) return { ok: false, error: `Conflicts ${step}, in ${conflict.join(', ')}.${stuck}`, notes };
      }
      return { ok: false, conflict, step, notes };
    }
    return failWith(`git merge ${what} failed: ${(m.stderr || m.stdout).trim().split('\n')[0]}`);
  };
  try {
    return await crossAll();
  } catch (e) {
    // Thrown partway (git failing under it): back to where it started.
    return failWith(`Couldn't bring it in: ${e instanceof Error ? e.message : String(e)}.`);
  }

  async function crossAll(): Promise<Merged> {
  for (const f of cross) {
    const parent = await out(cwd, ['rev-parse', `${f.commit}^`]);
    // Only formatting, or its tree can't stand in for it.
    const changed = (await git(cwd, ['diff', '--name-only', '-z', parent, f.commit])).stdout.split('\0').filter(Boolean);
    const outside = changed.filter((p) => !f.entry.paths.some((s) => p === s || p.startsWith(`${s}/`)));
    if (outside.length) {
      return failWith(`${short(f.commit)} (${f.entry.subject}) changes files outside what it formats (${outside.slice(0, 5).join(', ')}), so it isn't only formatting. Merge it by hand.`);
    }
    if (!(await isAncestor(cwd, parent, 'HEAD'))) {
      const r = await merge(parent, `Bring in the changes before ${f.entry.subject}`, `merging ${short(parent)}, the commit before ${short(f.commit)} (${f.entry.subject})`);
      if (r) return r;
    }
    const formatter = new TreeFormatter(cwd, [f]);
    const now = await out(cwd, ['rev-parse', 'HEAD']);
    const r = await formatter.format(await out(cwd, ['rev-parse', 'HEAD^{tree}']));
    // A merge made from a tree the formatter couldn't do would take F's
    // formatting back out of whatever it missed.
    if (r.failed.length) return failWith(`Couldn't format this copy's tree as ${short(f.commit)} (${f.entry.subject}) was made, so it isn't merged: ${r.failed.join('; ')}.`);
    const made = await out(cwd, ['commit-tree', r.tree, '-p', now, '-p', f.commit, '-m', `Bring in ${f.entry.subject}\n\nWith this copy's own changes formatted the same way (scripts/replay-over-format.sh).`]);
    const moved = await git(cwd, ['reset', '--keep', made]);
    if (!moved.ok) return failWith(`Couldn't move to the formatted merge: ${moved.stderr.trim()}.`);
    notes.push(`Crossed ${short(f.commit)} (${f.entry.subject}) with this copy's own changes formatted the same way.`);
  }
  if (opts.final !== false && !(await isAncestor(cwd, target, 'HEAD'))) {
    const r = await merge(target, opts.message ?? `Merge ${target}`, `merging ${target}`);
    if (r) return r;
  }
  return { ok: true, notes };
  }
}

// --------------------------------------------------------------- the CLI

const USAGE = `scripts/replay-over-format.sh: carry work across a format commit (${FORMAT_LIST}).

  scripts/replay-over-format.sh [<onto>]
      Rebase the checked-out branch onto <onto> (main by default), formatting
      each of its commits as the format commits it crosses were made. Stops
      at a real conflict as git rebase does: sort it out, git rebase --continue.

  scripts/replay-over-format.sh --merge <commit> [-m <message>]
      Merge <commit> (Mike's release) into the checked-out branch, crossing
      any format commit in it without hand-resolving formatting
      (docs/bringing-in-updates.md). Stops at a real conflict: sort it out,
      git commit, and run it again.
`;

async function cli(argv: string[]): Promise<number> {
  const say = (s: string) => process.stdout.write(`${s}\n`);
  const cwd = process.cwd();
  if (argv.includes('-h') || argv.includes('--help')) {
    say(USAGE);
    return 0;
  }
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
  if (!top) {
    say('Not in a git checkout.');
    return 2;
  }
  const status = await out(top, ['status', '--porcelain', '--untracked-files=no']);
  if (status) {
    say(`There are uncommitted changes in ${top}; commit or stash them first.`);
    return 1;
  }
  if (argv[0] === '--merge') {
    const target = argv[1];
    if (!target) {
      say(USAGE);
      return 2;
    }
    const mi = argv.indexOf('-m');
    const message = mi > 0 ? argv[mi + 1] : undefined;
    noCommitGraph = true;
    const substituted = await substitutes(top);
    if (substituted) {
      say(substituted);
      return 1;
    }
    const r = await mergeAcross(top, target, { message, leave: true });
    for (const n of r.notes) say(n);
    if (r.ok) {
      say(`Merged ${target}.`);
      return 0;
    }
    if ('conflict' in r) {
      say(`Conflicts ${r.step}, in:\n${r.conflict.map((f) => `  ${f}`).join('\n')}\nSort them out, git commit, then run this again.`);
      return 1;
    }
    say(r.error);
    return 1;
  }
  const onto = argv[0] ?? 'main';
  const head = await out(top, ['rev-parse', 'HEAD']);
  const branch = (await git(top, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim();
  if (!branch) {
    say('HEAD is detached: check out the branch to carry first.');
    return 1;
  }
  const cross = await crossings(top, head, onto);
  if (!cross.length) {
    say(`${branch} doesn't cross a format commit on its way to ${onto}: git rebase ${onto} is all it needs.`);
    return 0;
  }
  const base = await out(top, ['merge-base', head, onto]);
  const formatter = new TreeFormatter(top, cross);
  say(`Carrying ${branch} across ${cross.map((f) => `${short(f.commit)} (${f.entry.subject})`).join(', ')}...`);
  const r = await carryAcross(top, { base, tip: head, onto: await out(top, ['rev-parse', onto]), formatter });
  for (const n of r.notes) say(n);
  if (r.ok) {
    await out(top, ['reset', '--keep', r.tip]);
    say(`Done: ${r.count} commit${r.count === 1 ? '' : 's'} on ${onto}, formatted. It was at ${short(head)} before (git reset --hard ${short(head)} goes back).`);
    return 0;
  }
  if ('error' in r) {
    say(r.error);
    return 1;
  }
  // A real conflict: put the formatted copies on the branch and let git
  // rebase stop at it, as it would for any rebase.
  say(`${short(r.at)} (${r.subject}) conflicts with ${onto} in: ${r.conflict.join(', ')}. Rebasing formatted copies so you can sort it out.`);
  const chain = await formattedChain(top, base, head, formatter);
  for (const n of chain.notes) say(n);
  await out(top, ['reset', '--keep', chain.tip]);
  // Commits already on `onto` are left out of the rebase, as a plain one
  // would leave them: their formatted copies don't match by patch id, so
  // the todo list drops them by name. Each pick still merges from its own
  // parent, so what comes after is right.
  const landed = await alreadyOn(top, onto, head, base);
  const drop = [...landed].map((c) => chain.copies.get(c)).filter((c): c is string => Boolean(c));
  for (const c of landed) say(`${short(c)} is on ${onto} already, so it's left out.`);
  const editor = `node -e ${shellQuote(`const fs=require('fs');const f=process.argv[1];const drop=${JSON.stringify(drop)};fs.writeFileSync(f,fs.readFileSync(f,'utf8').split('\\n').filter((l)=>!drop.includes((l.split(' ')[1]||''))).join('\\n'))`)}`;
  // Full ids and the long command names in the todo, whatever the config says.
  const rb = drop.length
    ? await git(top, ['-c', 'core.abbrev=no', '-c', 'rebase.abbreviateCommands=false', 'rebase', '-i', '--onto', onto, chain.first], { GIT_SEQUENCE_EDITOR: editor })
    : await git(top, ['rebase', '--onto', onto, chain.first]);
  process.stdout.write(rb.stdout);
  process.stderr.write(rb.stderr);
  say(rb.ok ? `Done. It was at ${short(head)} before.` : `Sort out the conflict, then git rebase --continue. To give up instead: git rebase --abort, then git reset --hard ${short(head)} (the abort alone leaves ${branch} on the formatted copies).`);
  return rb.ok ? 0 : 1;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function same(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  cli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
