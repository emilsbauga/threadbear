#!/usr/bin/env node
// check.sh's pass records: a step, or one of the runner's unit test files,
// that passed with exactly these inputs before is skipped (Ville, 21 Nov
// 2026: "Keep track of changes and only run the deltas"). A landing's check
// on a Mac with no check host took 20 to 25 minutes, most of it the runner's
// unit tests, rerunning files nothing had touched.
//
// The key is made from what the files hold (git's blob ids), never from
// commits or dates, so a pass in one worktree counts in every other, after
// a rebase, and after one of Mike's releases comes in: a release that
// changes 1000 files reruns only what those files reach. Each key also
// holds the Node version, the step's command line, its tool's version
// (cargo, swift), check.sh and this file, so a new tool or a changed check
// reruns everything it touches.
//
//   node scripts/check-cache.mjs tree <checkout> <out>
//       writes "<blob id> <path>" for every file the checkout has (tracked
//       and untracked, not ignored; or every file, with no .git)
//   node scripts/check-cache.mjs step <tree> <checkout> <step name> [<command and args...>]
//       prints the step's key, or nothing for a step that's never skipped
//   node scripts/check-cache.mjs tests <tree> <checkout> <records> <file...>
//       for each test file (from runner/): "run <file> <key>" or
//       "skip <file> <key> <when and where it passed>" (or "as in Mike's
//       release <date>": the section on releases below)
//
// The records are small files named by key, holding when they passed,
// under check.sh's records folder (~/Library/Caches/Threadbear/check-passes
// on a Mac, ~/.cache/threadbear/check-passes elsewhere, and
// ~/.cache/threadbear-check/passes on a check host), shared by every
// checkout. One older than RECORD_DAYS doesn't count, so whatever a key
// misses (a file a test reads by a name built at run time) runs again
// within a week anyway. What a test file's key holds was checked against
// strace of every one on Linux (22 Nov 2026; makeReader says how).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const RECORD_DAYS = 7;
const VERSION = 'check-cache 1';

// What every key holds besides its own inputs: the check itself.
const CHECK_FILES = ['check.sh', 'scripts/check-cache.mjs', 'scripts/limit-step.mjs', 'runner/scripts/find-node.sh'];
// And every test file's: git's and npm's settings for the checkout, which a
// test running git or npm in it (or in a copy of these) reads.
const REPO_SETTINGS = ['.gitattributes', '.gitignore', 'runner/.gitignore', '.git-blame-ignore-revs', '.npmrc', 'runner/.npmrc', '.nvmrc', 'runner/.nvmrc'];
// And every test file's: how the tests are run, and the packages they get.
const TEST_FILES = ['runner/package.json', 'runner/package-lock.json', 'runner/tsconfig.json',
  'runner/test/helpers/clean-env.ts', 'runner/test/helpers/failed-files-reporter.mjs', 'runner/test/helpers/passed-files-reporter.mjs',
  'runner/test/helpers/run-test-files.mjs'];

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const blob = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// ---- the checkout's files ---------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', '.build', 'target', '.fixtures', 'dist', '.swiftpm']);

// "<git mode>-<blob id>": what it holds and how, as git has it, so making a
// script not executable, or a link a plain file holding its target, is a
// change too (Codex's and Gemini's reviews, 22 Nov 2026).
function hashFile(abs) {
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) return `120000-${blob(Buffer.from(fs.readlinkSync(abs)))}`;
  if (!st.isFile()) return undefined;
  // Git's rule: executable when the owner may run it.
  return `${st.mode & 0o100 ? '100755' : '100644'}-${blob(fs.readFileSync(abs))}`;
}

function walk(root) {
  const out = new Map();
  const go = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) go(r);
      } else if (e.isFile() || e.isSymbolicLink()) {
        const h = hashFile(path.join(root, r));
        if (h) out.set(r, h);
      }
    }
  };
  go('');
  return out;
}

// git ls-files -s gives tracked files' blob ids without reading them; files
// that differ from the index, and untracked ones, are hashed here the same
// way, so a dirty checkout and a clean one with the same text agree.
export function treeOf(root) {
  const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(root)) return withoutCheckFiles(walk(root));
  const staged = git(['ls-files', '-s', '-z']);
  const dirty = git(['ls-files', '-m', '-o', '--exclude-standard', '-z']);
  if (staged.status !== 0 || dirty.status !== 0) return withoutCheckFiles(walk(root));
  const out = new Map();
  for (const entry of staged.stdout.split('\0')) {
    const m = /^(\d+) ([0-9a-f]+) \d\t(.+)$/s.exec(entry);
    // Submodules (160000) aren't files here.
    if (m && m[1] !== '160000') out.set(m[3], `${m[1]}-${m[2]}`);
  }
  for (const rel of dirty.stdout.split('\0')) {
    if (!rel) continue;
    let h;
    try { h = hashFile(path.join(root, rel)); } catch { h = undefined; }
    if (h) out.set(rel, h); else out.delete(rel);
  }
  return withoutCheckFiles(out);
}

// A check host's copy has the list of what the checkout changes from main
// beside its files (scripts/check-remote.sh): which steps run, not what
// any of them reads, and different for the same files in a group's check.
function withoutCheckFiles(tree) {
  tree.delete('.check-changed');
  return tree;
}

export function readTree(file) {
  const out = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const i = line.indexOf(' ');
    if (i > 0) out.set(line.slice(i + 1), line.slice(0, i));
  }
  return out;
}

const keyOf = (tree, files, extra) => {
  const lines = [VERSION, ...extra];
  for (const f of [...new Set(files)].sort()) lines.push(`${tree.get(f) ?? 'none'} ${f}`);
  return sha(lines.join('\n'));
};

// ---- steps ------------------------------------------------------------------

// Top-level files a step's tools read (package.json, tsconfig, eslint config),
// not the docs beside them.
const rootConfig = (f) => !f.includes('/') && !f.endsWith('.md');
const under = (...prefixes) => (f) => prefixes.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
// Any TypeScript, JavaScript or JSON, wherever it is: tsc follows imports
// out of its folder (the runner's tests import convex/, relay/, web/,
// site/ and features/ code), and type-aware lint rules read the types of
// what a file imports, so a change there can fail a file nobody touched.
const code = (f) => /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx|json)$/.test(f) || rootConfig(f);

// Step name → which files it reads, a superset of what check.sh's own
// test for running it looks at. A step not listed keys on every file: it's
// skipped only when nothing at all changed (a rebase with nothing new).
const STEPS = [
  [/^runner typecheck$/, code],
  [/^app tools parse$/, under('app/Tools/', 'mock-runner/')],
  // web's tests read shared/cases/; web and convex import nothing outside
  // these (the packages are the top's lockfile, and vendor/'s tarball).
  [/^(convex|web) /, (f) => rootConfig(f) || under('convex/', 'web/', 'shared/', 'vendor/', 'convex.json')(f)],
  // .check-left-out: the pictures a check host's copy leaves out, which
  // the build takes as there.
  [/^site build$/, under('site/', 'docs/guide.md', 'docs/experiments.md', '.check-left-out')],
  [/^feature/, (f) => under('features/', 'docs/gpui-port/', 'desktop/scripts/')(f) || rootConfig(f)],
  [/^desktop /, under('desktop/', 'rust-toolchain.toml', 'features/support/', 'site/app-doc-slugs.json', 'mock-runner/', 'runner/src/',
    'runner/package.json', 'runner/package-lock.json', 'shared/')],
  // app/ links to the iPhone kit's Swift files; its tests start the mock
  // runner, which imports the runner's code, and TourTests reads the site's
  // doc slugs (Gemini's review).
  [/^(app|dock) /, under('app/', 'dock/', 'shared/', 'mock-runner/', 'ios/', 'runner/src/', 'runner/package.json',
    'runner/package-lock.json', 'site/app-doc-slugs.json', 'features/support/')],
  [/^iphone /, under('ios/', 'app/', 'dock/', 'shared/')],
];
// Never skipped: installs aren't checks, and the end-to-end tests and the
// screenshots are asked for to be run.
const NEVER = /( packages| e2e|screenshots)$/;
// Where the checks run: a record from one system never vouches for another
// (a test that skips itself on Linux passes there).
const PLATFORM = `platform ${process.platform} ${process.arch}`;

// The version line of the tool a command runs, once a check (kept beside the
// tree). Cargo is asked in desktop/, so rust-toolchain.toml's pin is the one
// it names, and never through the shared-cargo wrapper, which would take a
// build slot's lock and copy the checkout over to answer.
//
// Asking installs nothing (RUSTUP_AUTO_INSTALL=0): rustup's cargo and rustc
// download the toolchain they'd run when it isn't there, and Homebrew's
// rustup does that for stable with no toolchain set at all. On GitHub's
// Macs a test's rustc, asked its version with a made-up HOME, put 1.4 GB
// there in 17 s (22 Nov 2026; check-cache.test.ts, checkout). A toolchain
// that's missing reads as no version, and that answer isn't kept: the step
// that needs it installs it, the key made after it has the version, and so
// a pass is never recorded under "no version".
function toolVersion(treeFile, args, root) {
  const tool = args.some((a) => /(^|\/)cargo$/.test(a)) ? 'cargo'
    : args.some((a) => /(^|\/)swift$/.test(a)) ? 'swift' : args.includes('npm') ? 'npm' : '';
  if (!tool) return '';
  const memo = path.join(path.dirname(treeFile), `${tool}-version`);
  try { return fs.readFileSync(memo, 'utf8'); } catch {}
  let cargo = args.find((a) => /(^|\/)cargo$/.test(a));
  if (cargo && /(^|\/)shared-cargo\/cargo$/.test(cargo)) cargo = process.env.THREADBEAR_SHARED_CARGO_REAL || 'cargo';
  const cmd = tool === 'cargo' ? [cargo, ['--version', '--verbose']]
    : tool === 'swift' ? ['swift', ['--version']] : ['npm', ['--version']];
  const cwd = tool === 'cargo' && root && fs.existsSync(path.join(root, 'desktop')) ? path.join(root, 'desktop') : path.dirname(treeFile);
  const env = { ...process.env, RUSTUP_AUTO_INSTALL: '0' };
  const r = spawnSync(cmd[0], cmd[1], { encoding: 'utf8', cwd, env });
  let v = `${tool}: ${(r.stdout ?? '').trim()} ${r.status}`;
  let said = r.status === 0;
  if (tool === 'cargo') {
    const beside = path.join(path.dirname(cargo), 'rustc');
    const rustc = spawnSync(cargo.includes('/') && fs.existsSync(beside) ? beside : 'rustc', ['--version', '--verbose'], { encoding: 'utf8', cwd, env });
    v += ` rustc: ${(rustc.stdout ?? '').trim()}`;
    said &&= rustc.status === 0;
  }
  if (said) try { fs.writeFileSync(memo, v); } catch {}
  return v;
}

export function stepKey(tree, name, args, { root = '', tools = '' } = {}) {
  if (NEVER.test(name) || name === 'runner unit tests') return '';
  // Where the checkout is doesn't matter, only what it holds.
  const rel = args.map((a) => (root && a.startsWith(`${root}/`) ? a.slice(root.length + 1) : a === root && root ? '.' : a));
  let pick = STEPS.find(([re]) => re.test(name))?.[1] ?? (() => true);
  // Lint: the files it's given (in its arguments, so in the key) as they
  // read every file's types, so all the code, or everything for "lint .".
  if (name === 'lint') pick = rel.includes('.') ? () => true : code;
  const files = [...tree.keys()].filter((f) => pick(f));
  return keyOf(tree, [...files, ...CHECK_FILES], [`step ${name}`, `args ${JSON.stringify(rel)}`, `node ${process.version}`, PLATFORM, tools]);
}

// ---- test files -------------------------------------------------------------

// Files that run (and so read others), and of those the modules Node loads.
const CODE = /\.(ts|mts|cts|tsx|js|mjs|cjs|sh|bash|pl|py|ps1)$/;
const MODULE = /\.(ts|mts|cts|tsx|js|mjs|cjs)$/;
const TEST_SIDE = /^(runner\/test\/|scripts\/|runner\/scripts\/|runner\/bin\/|desktop\/scripts\/|[^/]+\.(sh|pl)$)/;
const runsAsProgram = (f) => CODE.test(f) || /(^|\/)bin\/[^/.]+$/.test(f);
// `import type` and `export type ... from` are gone before the code runs
// (Node strips types), so a test doesn't read what they name: the typecheck
// step covers those. `import { type X }` stays, as Node still loads the file.
const TYPE_ONLY = /^[ \t]*(?:import|export)[ \t]+type[ \t][^;'"`]*?\bfrom[ \t]*['"][^'"]+['"];?/gm;
// What a path.join or path.resolve starts from when it means "beside this
// file": its folder.
const HERE = /^(?:import\.meta\.dirname|__dirname|(?:path\.)?dirname\((?:url\.)?fileURLToPath\(import\.meta\.url\)\))$/;

// The string arguments of each join(...) or resolve(...) call: [first
// argument, the strings at its end] (path.join(ROOT, 'docs', 'protocol')
// gives the 'docs/protocol' a test lists, which no one string names).
function joins(text) {
  const out = [];
  for (const m of text.matchAll(/\b(?:join|resolve)\(/g)) {
    let depth = 1, i = m.index + m[0].length, arg = '', q = '';
    const args = [];
    for (; i < text.length && depth > 0; i++) {
      const c = text[i];
      if (q) { arg += c; if (c === '\\') { arg += text[++i] ?? ''; } else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; arg += c; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) break; }
      if (c === ',' && depth === 1) { args.push(arg.trim()); arg = ''; continue; }
      arg += c;
    }
    if (arg.trim()) args.push(arg.trim());
    if (args.length > 60) continue;
    const lit = (a) => /^(['"])([^'"`$\\]*)\1$/.exec(a)?.[2];
    // Each run of strings, with what comes before it (join(ROOT, 'desktop',
    // crate) lists desktop/'s crates).
    for (let k = 0; k < args.length; k++) {
      if (lit(args[k]) === undefined) continue;
      const run = [];
      const first = k > 0 ? args[k - 1] : '';
      while (k < args.length && lit(args[k]) !== undefined) run.push(lit(args[k++]));
      out.push([first, run]);
    }
  }
  return out;
}

// What one file reads: its relative imports, and any string in it that
// names a file or folder of the checkout ('docs/guide.md', path.join(ROOT,
// 'scripts', 'check-remote.sh'), 'app/Tests/Fixtures', a folder beside it
// that it lists). A bare name matching more than three files counts only
// beside the file, at the top or in runner/ (index.ts, package.json).
function indexTree(tree) {
  const byBase = new Map();
  const dirs = new Map();
  const add = (m, k, v) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
  for (const f of tree.keys()) {
    add(byBase, path.posix.basename(f), f);
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!dirs.has(d)) add(byBase, `${parts[i - 1]}/`, d);
      add(dirs, d, f);
    }
  }
  return { byBase, dirs };
}

export function makeReader(root, tree) {
  const { byBase, dirs } = indexTree(tree);
  const memo = new Map();
  const textOf = (file) => {
    try { return fs.readFileSync(path.join(root, file), 'utf8'); } catch { return undefined; }
  };
  // Names in a file of data a test reads (AGENTS.md, a fixture's JSON): the
  // files it names, which a test that checks them reads in turn.
  const named = (file, out) => {
    const text = textOf(file);
    if (text === undefined || text.length > 2_000_000 || text.includes('\0')) return;
    for (const m of text.matchAll(/(?:^|[^\w.@+/-])((?:[\w.@+-]+\/)+[\w.@+-]+)(?![\w/])/gm)) {
      const s = m[1].replace(/^(\.\.?\/)+/, '').replace(/\.+$/, '');
      for (const f of tree.has(s) ? [s] : dirs.get(s) ?? []) if (!out.has(f)) out.set(f, 'leaf');
    }
  };
  // direct(file, mode): what the file reads, as a map of file → how it's
  // reached. A file is read in one of three ways:
  //   test  a test, or a helper or script on the tests' side (TEST_SIDE)
  //         that a test reaches: every name in it counts, and the names in
  //         the data it reads
  //   code  the app's own code (runner/src and the like), reached by an
  //         import or started as a script beside it (patches.ts's
  //         patch-child.ts): its imports count, and what it names beside
  //         itself or by a whole path, only as files it reads (it names
  //         scripts and docs all over, mostly to tell an agent or a person
  //         about them, and following those made nearly every test read
  //         nearly everything: 1750 files each)
  //   leaf  read as it is: what it holds counts, nothing it names
  const direct = (file, mode = TEST_SIDE.test(file) ? 'test' : 'code') => {
    const memoKey = `${mode} ${file}`;
    if (memo.has(memoKey)) return memo.get(memoKey);
    const out = new Map();
    memo.set(memoKey, out);
    // The check's own files are in every key already, and this one names
    // folders all over.
    if (mode === 'leaf' || !runsAsProgram(file) || !tree.has(file) || CHECK_FILES.includes(file)) return out;
    let text = textOf(file);
    if (text === undefined) return out;
    if (/\.(ts|mts|cts|tsx)$/.test(file)) text = text.replace(TYPE_ONLY, '');
    // Whole lines of comment run nothing, and scripts name each other in
    // theirs so widely that following them reached nearly every file
    // (remote.sh's "the rule test-remote-freshness.sh keeps").
    text = MODULE.test(file) ? text.replace(/^[ \t]*(?:\/\/|\/\*|\*(?!\/)|\*\/).*$/gm, '') : text.replace(/^[ \t]*#(?!!).*$/gm, '');
    const here = path.posix.dirname(file);
    const testSide = mode === 'test';
    // How a file this one reaches is read in turn (above).
    // Another test file named (a script's comment saying which test covers
    // it) is read at most: no test runs another.
    // A module or script the code joins a path to, or finds beside itself
    // ('run'), it imports or starts (update.ts's join(dir, 'scripts',
    // 'deploy.mjs'), tb-dev.ts's ../bin/tb): it's read as code too, its
    // imports followed (Gemini's review, 22 Nov 2026).
    const as = (f, how) => (how === 'module' || (how === 'run' && runsAsProgram(f)) ? (testSide && TEST_SIDE.test(f) ? 'test' : 'code')
      : /^runner\/test\/(unit|e2e|deploy)\/.*\.test\.ts$/.test(f) ? 'leaf'
      : testSide ? (TEST_SIDE.test(f) || !CODE.test(f) ? 'test' : 'code')
      : 'leaf');
    const rank = { leaf: 0, code: 1, test: 2 };
    const addFile = (f, how = 'name') => {
      if (!tree.has(f) || f === file) return;
      const m = as(f, how);
      const had = out.get(f);
      if (had && rank[had] >= rank[m]) return;
      out.set(f, m);
      if (testSide && !had && !runsAsProgram(f)) named(f, out);
    };
    // Not a folder the file is in (join(import.meta.dirname, '..') is
    // where it starts from, not what it reads), nor the checkout's top.
    // What's in a folder it names is read, as text, not run: a test that
    // copies one of scripts/ by a name it makes runs a script it names too.
    const addDir = (d) => {
      if (!d || d === '.' || here === d || here.startsWith(`${d}/`)) return;
      for (const f of dirs.get(d) ?? []) if (!out.has(f)) out.set(f, 'leaf');
    };
    const near = (list) => (list.length <= 3 ? list : list.filter((f) => [here, path.posix.dirname(here), '.', 'runner'].includes(path.posix.dirname(f))));
    // A path by itself: the file or folder it names, wherever it is.
    const byPath = (s, inJoin = false) => {
      const how = inJoin ? 'run' : 'name';
      s = s.replace(/^(\.\.?\/)+/, '').replace(/\/+$/, '');
      if (!s || s.startsWith('/')) return;
      const base = path.posix.basename(s);
      if (s.includes('/')) {
        for (const f of byBase.get(base) ?? []) if (f === s || f.endsWith(`/${s}`)) addFile(f, how);
        for (const d of byBase.get(`${base}/`) ?? []) if (d === s || d.endsWith(`/${s}`)) addDir(d);
      } else if (/^[\w.@+-]+\.[A-Za-z0-9]{1,8}$/.test(s)) {
        for (const f of near(byBase.get(s) ?? [])) addFile(f, how);
      } else if (inJoin) {
        // A folder's bare name in a join: beside the file, at the top or in
        // runner/ (a bare 'text' elsewhere is a word, not desktop's text/).
        for (const d of byBase.get(`${s}/`) ?? []) if ([here, '.', 'runner'].includes(path.posix.dirname(d))) addDir(d);
      }
    };
    // Beside the file: './x', '../x', or join(import.meta.dirname, 'x'). A
    // module there is imported or started as a script of its own.
    const relative = (s) => {
      const r = path.posix.normalize(path.posix.join(here, s));
      // All that it could be: experiments.ts's 'experiments' is the folder
      // beside it, not itself.
      let found = false;
      // (A bundler's too: './_generated/server' is server.js.)
      for (const c of [r, `${r}.ts`, `${r}.tsx`, `${r}.js`, `${r}.mjs`, `${r}/index.ts`, `${r}/index.js`, r.endsWith('.js') ? r.replace(/\.js$/, '.ts') : '']) {
        if (c && c !== file && tree.has(c)) { addFile(c, MODULE.test(c) ? 'module' : 'run'); found = true; }
      }
      if (dirs.has(r)) { addDir(r); found = true; }
      return found;
    };
    for (const m of text.matchAll(/['"`]([^'"`\s$<>{}*|,;:!?]{2,200})['"`]/g)) {
      const s = m[1];
      if ((s.startsWith('./') || s.startsWith('../')) && relative(s)) continue;
      // From the app's code, a whole path, or a bare name of data beside it
      // (package.json); a bare module's name is mostly a message.
      if (testSide || s.includes('/') || (/\.[A-Za-z0-9]{1,8}$/.test(s) && !MODULE.test(s))) byPath(s);
    }
    for (const [first, segs] of joins(text)) {
      const s = segs.join('/');
      if (HERE.test(first.replace(/\s+/g, '')) && relative(s)) continue;
      byPath(path.posix.normalize(s), true);
    }
    if (testSide || !MODULE.test(file)) {
      // A path after a variable, "${ROOT}/scripts/x.sh" or `${dir}/a/b.json`
      // (the regex below wants what comes before a path not to be a slash).
      for (const m of text.matchAll(/\$\{?[A-Za-z_][\w.]*\}?\/((?:[\w.@+-]+\/)*[\w.@+-]+)/g)) byPath(m[1], true);
    }
    if (testSide) {
      // In a script, a file's bare name outside quotes (a shell loop's `for
      // f in hangup-guard.sh perf-lock.pl`), as a quoted one. (In code those
      // are comments, and the harness every test loads names half the
      // runner in its own.)
      // After a slash too: "$here/hangup-guard.sh" is the one beside it.
      if (!MODULE.test(file)) for (const m of text.matchAll(/(?:^|[^\w.@+$-])([\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?![\w/])/gm)) byPath(m[1]);
      // Names a test goes through one by one, each likely joined to a
      // folder: `for (const dir of ['convex', 'relay/convex'])`, or
      // `['client', 'core'].map(...)`, as if each were in a join.
      for (const m of text.matchAll(/(?:\bof\s*\[([^\]]*)\]|\[([^\]]*)\]\s*\.\s*(?:map|flatMap|forEach|filter|some|every)\()/g)) {
        const items = (m[1] ?? m[2]).split(',').map((x) => x.trim()).filter(Boolean);
        const lit = items.map((x) => /^(['"])([^'"`$\\]*)\1$/.exec(x)?.[2]);
        if (lit.every((x) => x !== undefined)) for (const x of lit) byPath(path.posix.normalize(x), true);
      }
      // A test that runs a command in the checkout itself (git grep, git
      // ls-files, a patch's command) can read any file of it: all of them.
      const roots = new Set(['REPO', 'ROOT', 'REPO_ROOT', 'repoRoot']);
      for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*path\.(?:resolve|join)\(([^;\n]*)\)\s*;/g)) {
        const j = joins(`join(${m[2]})`)[0];
        if (j && HERE.test(j[0].replace(/\s+/g, '')) && path.posix.normalize(path.posix.join(here, ...j[1])) === '.') roots.add(m[1]);
      }
      // Or hands the checkout to code that goes through it (protocol
      // citations' check(ROOT), a git history read, a workflow scan).
      const pathish = /^(?:join|resolve|relative|dirname|basename|normalize|split|update|includes|startsWith|endsWith|replace|replaceAll|indexOf|push|add|has|set|get|log|equal|ok|match|existsSync|statSync|lstatSync|realpathSync|readdirSync)$/;
      for (const r of roots) {
        if (new RegExp(`(?:\\bcwd:\\s*${r}\\b|['"]-C['"],\\s*${r}\\b)`).test(text)) { out.set('*', 'leaf'); break; }
        if ([...text.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\(\\s*${r}\\s*[,)]`, 'g'))].some((m) => !pathish.test(m[1]))) { out.set('*', 'leaf'); break; }
      }
    }
    // And from the tests' side, or a script, paths with a folder in them
    // outside quotes, or inside a shell's "$ROOT/scripts/x.sh" (in the app's
    // code those are in comments and messages: what it reads it names in
    // quotes or a join).
    if (testSide || !MODULE.test(file)) for (const m of text.matchAll(/(?:^|[^\w.@+/-])((?:[\w.@+-]+\/)+[\w.@+-]+\.[A-Za-z0-9]{1,8})(?![\w/])/gm)) {
      const s = m[1];
      for (const f of byBase.get(path.posix.basename(s)) ?? []) if (f === s || f.endsWith(`/${s}`) || s.endsWith(`/${f}`)) addFile(f);
    }
    return out;
  };
  // Everything a file reaches, each the strongest way it's reached.
  const closure = (file) => {
    const rank = { leaf: 0, code: 1, test: 2 };
    const seen = new Map();
    const todo = [[file, TEST_SIDE.test(file) ? 'test' : 'code']];
    let all = false;
    while (todo.length) {
      const [f, m] = todo.pop();
      if (f === '*') { all = true; continue; }
      if (seen.has(f) && rank[seen.get(f)] >= rank[m]) continue;
      seen.set(f, m);
      for (const [g, gm] of direct(f, m)) if (!seen.has(g) || rank[seen.get(g)] < rank[gm]) todo.push([g, gm]);
    }
    const out = new Set(all ? tree.keys() : seen.keys());
    // Node reads the package.json beside a module and in each folder above
    // it for its "type" (android-push's relay/package.json), and esbuild the
    // tsconfig.json (site-no-frames bundles convex/http.ts): those that are
    // there, and those that aren't, as one appearing changes how it loads.
    for (const f of seen.keys()) {
      if (!MODULE.test(f)) continue;
      for (let d = path.posix.dirname(f); ; d = path.posix.dirname(d)) {
        // And the tsconfig.json a bundler (esbuild) reads the same way.
        for (const n of ['package.json', 'tsconfig.json']) out.add(d === '.' ? n : `${d}/${n}`);
        if (d === '.') break;
      }
    }
    return out;
  };
  return { direct, closure };
}

export function testKeys(root, tree, files, { withFiles = false } = {}) {
  const reader = makeReader(root, tree);
  const common = new Set([...CHECK_FILES, ...REPO_SETTINGS]);
  for (const f of TEST_FILES) for (const g of reader.closure(f)) common.add(g);
  const out = new Map();
  for (const t of files) {
    const all = [...reader.closure(`runner/${t}`), ...common];
    const key = keyOf(tree, all, ['test', `file ${t}`, `node ${process.version}`, PLATFORM]);
    out.set(t, withFiles ? { key, files: all } : key);
  }
  return out;
}

// ---- Mike's releases --------------------------------------------------------

// In a fork, a test file that reads exactly what Mike's newest release has
// (every file it reaches, byte for byte) passed his check already: his main
// takes commits only through tb land's check, and a release is a main commit
// his runner ran for six hours and GitHub's checks passed on
// (docs/setup-and-updates.md, "Releases, not Mike's main"). So it isn't run
// again here. Ville, 22 Nov 2026: "If Mike has changed the runner but I
// haven't it shouldn't need to rerun checks as Mike ran them before
// releasing". Every file counts, the check's own and the test helpers
// loaded around every test file too: with those left out, a fork that broke
// clean-env.ts skipped every test file, and nothing loaded it (Gemini's
// review, 22 Nov 2026). Only a release the runner checked the signature of
// counts (refs/threadbear/upstream/), never a release/ tag, which anyone
// can make on any commit (Codex's). THREADBEAR_CHECK_TRUST_RELEASE=off turns it off. Never in Mike's own copy
// (origin is mikecann/threadbear): his release is a commit of his main, so
// it would vouch for his own unchecked work, and his checks run in full.

const MIKES_REPO = 'github.com/mikecann/threadbear';
// github.com/mikecann/threadbear, however the URL is written (as
// runner/src/upstream.ts's repoKey).
export const repoKey = (url) => url.trim().replace(/^git@([^:]+):/, '$1/').replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, '')
  .replace(/\.git\/?$/, '').replace(/\/$/, '').toLowerCase();

// The newest verified release already in HEAD: { name, tree } or undefined.
export function releaseIn(root) {
  if (process.env.THREADBEAR_CHECK_TRUST_RELEASE === 'off') return undefined;
  const git = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  // A fork's own copy only: one with an origin that isn't Mike's. Mike's
  // copy, and a check host's copy (no origin), never take a release's word.
  const origin = git(['config', '--get', 'remote.origin.url']);
  if (origin.status !== 0 || !origin.stdout.trim() || repoKey(origin.stdout) === MIKES_REPO) return undefined;
  // refs/threadbear/upstream/ holds the releases the runner checked the
  // signature of (runner/src/upstream.ts).
  const r = git(['for-each-ref', '--merged', 'HEAD', '--sort=-refname', '--count=1', '--format=%(refname)', 'refs/threadbear/upstream/']);
  const name = r.status === 0 ? r.stdout.trim() : '';
  if (!name) return undefined;
  const ls = git(['ls-tree', '-r', '-z', `${name}^{commit}`]);
  if (ls.status !== 0) return undefined;
  const tree = new Map();
  for (const entry of ls.stdout.split('\0')) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (m && m[1] !== '160000') tree.set(m[3], `${m[1]}-${m[2]}`);
  }
  return { name: name.replace(/^refs\/threadbear\/upstream\//, ''), tree };
}

export function sameAsRelease(tree, release, files) {
  return files.every((f) => release.tree.get(f) === tree.get(f));
}

// When a key passed: the record's text, or undefined if there's none or it's
// older than RECORD_DAYS.
export function passed(records, kind, key, now = Date.now()) {
  const file = path.join(records, kind, key);
  try {
    const st = fs.statSync(file);
    if (now - st.mtimeMs > RECORD_DAYS * 86_400_000) return undefined;
    return fs.readFileSync(file, 'utf8').trim() || 'before';
  } catch {
    return undefined;
  }
}

// ---- command line -----------------------------------------------------------

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'tree') {
    const [root, out] = rest;
    const tree = treeOf(path.resolve(root));
    fs.writeFileSync(out, [...tree].map(([f, h]) => `${h} ${f}`).join('\n') + '\n');
    return 0;
  }
  if (cmd === 'step') {
    const [treeFile, root, name, ...args] = rest;
    const key = stepKey(readTree(treeFile), name, args, { root, tools: toolVersion(treeFile, args, root) });
    if (key) console.log(key);
    return 0;
  }
  if (cmd === 'tests') {
    const [treeFile, root, records, ...files] = rest;
    const tree = readTree(treeFile);
    const lines = [];
    let release;
    for (const [t, { key, files: read }] of testKeys(root, tree, files, { withFiles: true })) {
      let when = passed(records, 'tests', key);
      if (!when) {
        if (release === undefined) release = releaseIn(root) ?? null;
        if (release && sameAsRelease(tree, release, read)) when = `as in Mike's release ${release.name}`;
      }
      lines.push(when ? `skip ${t} ${key} ${when}` : `run ${t} ${key}`);
    }
    if (lines.length) console.log(lines.join('\n'));
    return 0;
  }
  console.error('usage: check-cache.mjs tree|step|tests ...');
  return 2;
}

// pathToFileURL, not `file://${argv[1]}`: a path with a space (Application
// Support on a runner) is %20 in import.meta.url, and main never ran; realpath
// as import.meta.url has symlinks resolved (/tmp on a Mac).
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
