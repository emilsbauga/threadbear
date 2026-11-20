// What a patch that loads without a hash (a home patch, or one in
// Threadbear's own checkout) makes code: codeOfUnhashedPatch. Moved here
// from runner/patches.ts on 19 Nov so the trust worker (trust-worker.ts)
// can run it off the runner's main thread without loading the runner.
import os from 'node:os';
import path from 'node:path';
import { commandFiles, commandFilesOutside, namedPaths, patchHash, scanModule, type PatchHash } from './patch-trust.ts';
import { canonicalPath } from './code-writes.ts';
import { patchCommands, sayValue } from './patch-commands.ts';

// What a patch that loads without a hash makes code, its commands run from
// `from` (writeRunsAsCode): every file it reaches, as canonical lower-case
// paths, and `all` when something it can run can't all be followed, with
// `why` saying what, for the thread and Patches. Kept until anything its
// hash was made from changes, and for a few seconds at most, as what a
// command reaches from that folder isn't in that hash.
export type UnsureWhy = { file: string; line?: number; command?: string; problem: string; fix?: string };
export type CodeScan = { at: number; h: PatchHash; all: boolean; files: Set<string>; why?: UnsureWhy };
const scans = new Map<string, CodeScan>();
const SCAN_TTL_MS = 10_000;
// A web address held in a constant (`const PAGE = \`https://x/\${id}\``), so not
// in the default export where `url` would say so. Run as a command it's one
// file by that very name, which `files` has: only characters a shell neither
// splits at nor expands, so no `?`, `[`, `;` or `$`, and no `..` to leave the
// folder by (Codex's review). Only for a file read the old way (patchCommands
// couldn't read it), where every string is taken for a command.
const PLAIN_WEB_ADDRESS = /^https?:\/\/(?!.*\.\.)[\w.~/%:-]*$/i;
export function codeOfUnhashedPatch(file: string, from: string, now: number): CodeScan {
  const key = `${file}\0${from}`;
  const hit = scans.get(key);
  if (hit && now - hit.at < SCAN_TTL_MS && hit.h.looked.same()) return hit;
  const h = patchHash(file);
  const files = new Set<string>();
  const add = (f: string) => files.add(canonicalPath(f).toLowerCase());
  // Code it can't follow: any edit might be what it runs.
  let all = Boolean(h.incomplete);
  let why: UnsureWhy | undefined = h.incomplete ? { file, problem: h.incomplete } : undefined;
  const unsure = (w: UnsureWhy) => {
    all = true;
    why ??= w;
  };
  for (const f of [file, h.root, ...h.deps.map((d) => d.path), ...h.unnamed]) add(f);
  const worktreeReach = new Set<string>();
  // The folder holding its `.threadbear/patches`, as a worktree's commands run from there.
  const patchFolder = path.dirname(path.dirname(path.dirname(file)));
  // Each file's commands; if any file can't be read that way, none is: a
  // function it hands on (`export { execSync as run } from ...`) can be
  // called from another by a name nothing here knows (Codex's review).
  const reads = new Map<string, ReturnType<typeof patchCommands>>();
  for (const [module, bytes] of h.code) {
    const rootPath = canonicalPath(h.root);
    const own = canonicalPath(module) === rootPath && ![...h.edges.values()].some((to) => [...to.values()].some((f) => canonicalPath(f) === rootPath));
    try {
      reads.set(module, patchCommands(bytes.toString('utf8'), module, own));
    } catch (e) {
      reads.set(module, { unknown: { line: 1, why: `Threadbear couldn't read it (${e instanceof Error ? e.message : String(e)})` } });
    }
  }
  const oneUnknown = [...reads.entries()].find(([, r]) => 'unknown' in r);
  for (const [module, r] of reads) {
    if ('unknown' in r && r.unknown.hard) unsure({ file: module, line: r.unknown.line, problem: `${r.unknown.why}, so Threadbear can't tell what it runs`, fix: "Write the patch's actions, hooks and worktree out in its default export, so Threadbear can see their commands." });
  }
  for (const [module, bytes] of h.code) {
    const text = bytes.toString('utf8');
    for (const n of namedPaths(text)) add(path.resolve(from, n));
    const scan = scanModule(text, module);
    // Imported by anything it imports, its default export has a name after all.
    const rootPath = canonicalPath(h.root);
    const own = canonicalPath(module) === rootPath && ![...h.edges.values()].some((to) => [...to.values()].some((f) => canonicalPath(f) === rootPath));
    // Every string as a command, for the files it would reach: only ever
    // adds files, and never makes every edit ask by itself.
    for (const command of scan.strings) {
      if (!/\S/.test(command) || command.length > 2000) continue;
      commandFiles(command, from).files.forEach(add);
    }
    // What it runs, where it runs it (patch-commands.ts). A `worktree` setup
    // and check don't count: setup runs what's committed, in a new worktree,
    // and worktree-setup.sh won't install from an uncommitted package.json in
    // the main checkout; the check runs when a land is asked for. So neither
    // runs what an agent just wrote until it has got past a step that's asked
    // about.
    // Anything it trips on is read the old way, never skipped.
    const mine = reads.get(module)!;
    // Read exactly where it can be, and the old way as well when any file
    // of the patch can't be.
    const old = 'unknown' in mine ? mine.unknown : oneUnknown && 'unknown' in oneUnknown[1] ? { ...oneUnknown[1].unknown, why: `${path.basename(oneUnknown[0])} ${oneUnknown[1].unknown.why}` } : undefined;
    if ('commands' in mine) {
      const read = mine;
      for (const c of read.commands) {
        if (c.text.length > 4000) {
          unsure({ file: module, line: c.line, command: c.text, problem: 'the command is too long to follow.' });
          continue;
        }
        if (c.worktree) {
          for (const f of commandFiles(c.text, patchFolder).files) worktreeReach.add(canonicalPath(f).toLowerCase());
          continue;
        }
        // Its scripts outside the folder too: a path built in code, from a
        // constant, is in no word of the text.
        const reach = commandFilesOutside(c.text, from);
        reach.files.forEach(add);
        // And every absolute or `~/` path in the command as it was worked
        // out, there yet or not: the follow passes over a missing script
        // outside the repo, which an agent could then write (Codex's review).
        // A child_process call's runs from its cwd (patchCommands puts it as `cd '<dir>' && `).
        const cd = /^cd '([^']*)' && /.exec(c.text);
        const base = cd ? cd[1] : from;
        for (const word of shellWords(c.text)) {
          if (!word || word.includes('__threadbear_value') || word.length > 4096) continue;
          if (word.startsWith('/') && word.length > 1) add(word);
          else if (word.startsWith('~/')) add(path.join(os.homedir(), word.slice(2)));
          // `../../other/go.mjs`, from where it runs: the follow passes over
          // one outside the repo that isn't there yet, too.
          else if (word.includes('/')) add(path.resolve(base, word));
        }
        if (reach.problem) unsure({ file: module, line: c.line, command: c.text, problem: sayValue(reach.problem) });
      }
    }
    if (old) {
      const read = { unknown: old };
      // Read the old way: each string in it as a command run from where its
      // commands run. A problem means there may be more it runs, unless the
      // patch file's own default export has it as something else (scanModule).
      const data = new Set(own ? scan.data : []);
      const worktree = new Set(own ? scan.worktree : []);
      for (const command of scan.strings) {
        if (!/\S/.test(command) || command.length > 2000) continue;
        const reach = commandFiles(command, from);
        if (worktree.has(command)) {
          for (const f of commandFiles(command, patchFolder).files) worktreeReach.add(canonicalPath(f).toLowerCase());
        } else if (PLAIN_WEB_ADDRESS.test(command)) add(path.resolve(from, command));
        else if (reach.problem && !data.has(command)) {
          const at = text.indexOf(command);
          const shown = commandShown(command);
          unsure({
            file: module,
            problem: `${read.unknown.why} (line ${read.unknown.line}), so Threadbear reads every string in it as a command it might run, and can't follow \`${shown}\`${at >= 0 ? ` (line ${text.slice(0, at).split('\n').length})` : ''}: ${reach.problem.replace(/^the command (line \d+ )?/, 'it ')}`,
            fix: "Take that out, or keep to `sh`, `run` fields, child_process and Node's own modules, so Threadbear can see what it runs.",
          });
        }
      }
    }
    // Absolute and `~/` paths, there yet or not.
    for (const word of text.split(/[\s'"`;&|()<>=,[\]{}]+/)) {
      if (word.startsWith('/') && word.length > 1) add(word);
      else if (word.startsWith('~/')) add(path.join(os.homedir(), word.slice(2)));
    }
  }
  // A script it names that runs something it can't follow, other than a
  // worktree's own (above). A hook or action that runs one is a problem as a
  // command too; this also catches what's named some other way.
  const stuck = Object.keys(h.blocked ?? {}).find((s) => !worktreeReach.has(canonicalPath(s).toLowerCase()));
  if (stuck) unsure({ file: stuck, problem: h.blocked![stuck] });
  const scan = { at: now, h, all, files, ...(why ? { why } : {}) };
  scans.set(key, scan);
  if (scans.size > 200) scans.delete(scans.keys().next().value!);
  return scan;
}

// A command's words roughly as a shell splits them, quotes taken off, so a
// quoted path with a space is one word (Codex's review). Only for finding
// paths in it: the follower is what reads it properly.
export function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: string | undefined;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else word += ch;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (/[\s;&|()<>=`]/.test(ch)) {
      if (word) words.push(word);
      word = '';
    } else word += ch;
  }
  if (word) words.push(word);
  return words;
}

// A command as the note shows it: its first few words, with anything after
// a word like token or key, and anything long enough to be one, left out.
// The note is kept in the transcript and goes to the phone, and a patch's
// command can carry a credential (Codex's review).
export function commandShown(command: string): string {
  const words = command
    .replace(/\$\{__threadbear_value\}/g, '${...}')
    // A URL's user and password.
    .replace(/:\/\/[^\s/@]*@/g, '://...@')
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const [i, w] of words.entries()) {
    if (out.length >= 4) {
      out.push('...');
      break;
    }
    const secretish =
      (i > 0 && /token|key|secret|pass|auth|bearer|cookie/i.test(words[i - 1])) ||
      /(token|key|secret|pass|auth)[^=]*=/i.test(w) ||
      /^[A-Za-z0-9_+=-]{24,}$/.test(w.replace(/^['"]|['"]$/g, ''));
    out.push(secretish ? '...' : w.length > 80 ? `${w.slice(0, 80)}...` : w);
  }
  return out.join(' ');
}
