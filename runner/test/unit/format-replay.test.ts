// Carrying work across a whole-tree format commit (format-replay.ts,
// scripts/replay-over-format.sh, tb land). Real git in temp repos, with a
// small made-up formatter so it runs anywhere: it squeezes runs of spaces
// in src/*.rs, needs the format commit's config file to be there, and
// leaves a file with "SYNTAX ERROR" in it as it is and fails, as rustfmt
// does with a file it can't parse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { capture, commit, makeBranch, makeRepo, sh, write } from '../helpers/worktrees-harness.ts';
import { land } from '../../src/worktrees.ts';
import { carryAcross, crossings, formatCommitsIn, mergeAcross, parseFormatList, TreeFormatter } from '../../src/format-replay.ts';

const FMT = `import fs from 'node:fs';
import path from 'node:path';
if (!fs.existsSync('fmt.toml')) { console.error('no fmt.toml'); process.exit(3); }
let failed = false;
const all = (d) => !fs.existsSync(d) ? [] : fs.readdirSync(d).flatMap((n) => { const p = path.join(d, n); return fs.statSync(p).isDirectory() ? all(p) : [p]; });
// As cargo fmt does with a crate root it can't read: nothing formatted at all.
if (all('src').some((p) => fs.readFileSync(p, 'utf8').includes('FATAL'))) { console.error('error: FATAL'); process.exit(2); }
const walk = (d) => {
  if (!fs.existsSync(d)) return;
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.rs')) {
      const t = fs.readFileSync(p, 'utf8');
      if (t.includes('SYNTAX ERROR')) { failed = true; console.error('error: expected item in ' + p); continue; }
      fs.writeFileSync(p, t.split('\\n').map((l) => l.replace(/ {2,}/g, ' ').trimEnd()).join('\\n'));
    }
  }
};
walk('src');
process.exit(failed ? 1 : 0);
`;

const SUBJECT = 'Format src with fmt.mjs, nothing else';

function setup(): { root: string; main: string; fmt: string; list: string } {
  const { root, main } = makeRepo();
  const fmt = path.join(root, 'fmt.mjs');
  fs.writeFileSync(fmt, FMT);
  const list = `# Whole-tree format commits.\n# format-subject: ${SUBJECT}\n# format-command: node '${fmt}'\n# format-paths: src\n# format-config: fmt.toml\n`;
  return { root, main, fmt, list };
}

// What formatting a commit's whole tree by hand gives: the expected end.
function formattedTree(main: string, fmt: string, ref: string): string {
  const dir = path.join(tmpDir('tb-fmt-expect-'), 'tree');
  sh(main, `git worktree add -q --detach '${dir}' ${ref}`);
  execFileSync('node', [fmt], { cwd: dir, stdio: 'ignore' });
  const tree = sh(dir, 'git add -A src && git write-tree');
  sh(main, `git worktree remove --force '${dir}'`);
  return tree;
}

function formatOnMain(main: string, fmt: string): string {
  execFileSync('node', [fmt], { cwd: main, stdio: 'ignore' });
  sh(main, `git add -A src && git commit -qm "${SUBJECT}"`);
  return sh(main, 'git rev-parse HEAD');
}

test('the list: blocks of format- lines, with or without their id, beside plain blame skips', () => {
  const id = 'a'.repeat(40);
  const list = parseFormatList(`# A comment.\n${'b'.repeat(40)}\n# format-subject: One\n# format-command: cd x && fmt\n# format-paths: x/ y\n# format-config: x/fmt.toml\n${id}\n# format-subject: Two, not landed yet\n# format-command: prettier -w .\n# format-paths: web\n`);
  assert.deepEqual(list, [
    { subject: 'One', command: 'cd x && fmt', paths: ['x', 'y'], config: ['x/fmt.toml'], id },
    { subject: 'Two, not landed yet', command: 'prettier -w .', paths: ['web'], config: [] },
  ]);
});

test('a branch on the format commit\'s parent is replayed as each commit\'s tree formatted, history kept', async () => {
  const { main, fmt, list } = setup();
  commit(main, { 'src/a.rs': 'fn  a()  {\n    let   x = 1;\n}\n', 'src/c.rs': 'fn   c() {}\n', 'docs/x.md': 'two  spaces stay\n' }, 'Code');
  commit(main, { 'fmt.toml': 'style = 1\n', '.git-blame-ignore-revs': list }, 'Format config');
  const p = sh(main, 'git rev-parse HEAD');
  const t = makeBranch(main);
  commit(t.path, { 'src/a.rs': 'fn  a()  {\n    let   x = 1;\n    let  y  =  2;\n}\n' }, 'Edit a');
  commit(t.path, { 'src/b.rs': 'fn   b()   {}\n' }, 'Add b');
  sh(t.path, 'git rm -q src/c.rs && git commit -qm "Delete c"');
  commit(t.path, { 'docs/x.md': 'two  spaces  still stay\n' }, 'Docs only');
  const tip = sh(t.path, 'git rev-parse HEAD');
  const f = formatOnMain(main, fmt);
  assert.equal(sh(main, 'git rev-parse HEAD^'), p);

  const found = await formatCommitsIn(main, 'main');
  assert.deepEqual(found.map((x) => x.commit), [f], 'found by subject before its id is written down');
  const cross = await crossings(main, tip, 'main');
  assert.equal(cross.length, 1);
  const r = await carryAcross(main, { base: p, tip, onto: f, formatter: new TreeFormatter(main, cross) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.count, 4);
  assert.equal(sh(main, `git rev-parse ${r.tip}^{tree}`), formattedTree(main, fmt, tip));
  assert.equal(sh(main, `git log --format=%s ${f}..${r.tip}`), 'Docs only\nDelete c\nAdd b\nEdit a');
  assert.equal(sh(main, `git rev-list --first-parent ${f}..${r.tip} | tail -1 | xargs -I@ git rev-parse @^`), f);
  // Each commit is its own tree formatted, not just the end.
  const carried = sh(main, `git rev-list --reverse ${f}..${r.tip}`).split('\n');
  const orig = sh(main, `git rev-list --reverse ${p}..${tip}`).split('\n');
  for (let i = 0; i < orig.length; i++) assert.equal(sh(main, `git rev-parse ${carried[i]}^{tree}`), formattedTree(main, fmt, orig[i]));
  assert.equal(sh(main, `git show ${r.tip}:docs/x.md`), 'two  spaces  still stay', 'outside what it formats');
});

test('a branch from further back, past a commit that fails to format, onto a main that moved on after the format commit', async () => {
  const { main, fmt, list } = setup();
  commit(main, { 'src/a.rs': 'fn  a()  {}\n', 'src/d.rs': 'one\n\ntwo   d\n\n\n\nthree\n' }, 'Code');
  const b = sh(main, 'git rev-parse HEAD');
  const t = makeBranch(main);
  // Main: a change, then the config (P), the format commit, a change after it.
  commit(main, { 'src/d.rs': 'one   changed\n\ntwo   d\n\n\n\nthree\n' }, 'Change d');
  commit(main, { 'fmt.toml': 'style = 1\n', '.git-blame-ignore-revs': list }, 'Format config');
  const f = formatOnMain(main, fmt);
  commit(main, { 'src/d.rs': 'one changed\n\ntwo d\n\n\n\nthree after\n' }, 'Change d after');
  // The branch, from before all of that (no fmt.toml: the format commit's is used).
  commit(t.path, { 'src/b.rs': 'fn  b() { SYNTAX ERROR\n' }, 'Start b');
  commit(t.path, { 'src/b.rs': 'fn  b()  {}\n', 'src/a.rs': 'fn  a()  {}\nfn   a2() {}\n' }, 'Finish b');
  const tip = sh(t.path, 'git rev-parse HEAD');
  const cross = await crossings(main, tip, 'main');
  assert.deepEqual(cross.map((x) => x.commit), [f]);
  const r = await carryAcross(main, { base: b, tip, onto: sh(main, 'git rev-parse main'), formatter: new TreeFormatter(main, cross) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.notes.join('\n'), /Start b.*partly unformatted.*expected item/);
  // The one that couldn't be parsed is left as it was; the rest of it is formatted.
  const first = sh(main, `git rev-list --reverse main..${r.tip} | head -1`);
  assert.equal(sh(main, `git show ${first}:src/b.rs`), 'fn  b() { SYNTAX ERROR');
  assert.equal(sh(main, `git show ${first}:src/a.rs`), 'fn a() {}');
  // The end: main's changes and the branch's, all formatted, nothing else.
  assert.equal(sh(main, `git show ${r.tip}:src/d.rs`), 'one changed\n\ntwo d\n\n\n\nthree after');
  assert.equal(sh(main, `git show ${r.tip}:src/a.rs`), 'fn a() {}\nfn a2() {}');
  assert.equal(sh(main, `git show ${r.tip}:src/b.rs`), 'fn b() {}');
  assert.equal(sh(main, `git show ${r.tip}:fmt.toml`), 'style = 1');
});

test('a real conflict is named, not formatted away', async () => {
  const { main, fmt, list } = setup();
  commit(main, { 'src/a.rs': 'fn  a()  {}\n', 'fmt.toml': 'style = 1\n', '.git-blame-ignore-revs': list }, 'Code');
  const p = sh(main, 'git rev-parse HEAD');
  const t = makeBranch(main);
  commit(t.path, { 'src/a.rs': 'fn  a()  { ours }\n' }, 'Ours');
  formatOnMain(main, fmt);
  commit(main, { 'src/a.rs': 'fn a() { theirs }\n' }, 'Theirs');
  const tip = sh(t.path, 'git rev-parse HEAD');
  const r = await carryAcross(main, { base: p, tip, onto: sh(main, 'git rev-parse main'), formatter: new TreeFormatter(main, await crossings(main, tip, 'main')) });
  assert.ok(!r.ok && 'conflict' in r, JSON.stringify(r));
  assert.deepEqual(r.conflict, ['src/a.rs']);
  assert.equal(r.subject, 'Ours');
});

test('tb land carries a branch across a format commit on main by itself', async () => {
  const { main, fmt, list } = setup();
  commit(main, { 'src/a.rs': 'fn  a()  {}\n\nfn   z() {}\n', 'fmt.toml': 'style = 1\n', '.git-blame-ignore-revs': list }, 'Code');
  const t = makeBranch(main);
  commit(t.path, { 'src/a.rs': 'fn  a()  { 1 }\n\nfn   z() {}\n', 'src/new.rs': 'fn   new() {}\n' }, 'Change a, add new');
  const f = formatOnMain(main, fmt);
  const c = capture();
  assert.equal(await land(t, c.opts), 0, c.err.join('\n'));
  assert.match(c.out.join('\n'), /Carried 1 commit across/);
  assert.equal(sh(main, 'git log --format=%s -2'), `Change a, add new\n${SUBJECT}`);
  assert.equal(sh(main, 'git rev-parse main^'), f);
  assert.equal(sh(main, 'git show main:src/a.rs'), 'fn a() { 1 }\n\nfn z() {}');
  assert.equal(sh(main, 'git show main:src/new.rs'), 'fn new() {}');
});

test('tb land names the script when carrying across meets a real conflict', async () => {
  const { main, fmt, list } = setup();
  commit(main, { 'src/a.rs': 'fn  a()  {}\n', 'fmt.toml': 'style = 1\n', '.git-blame-ignore-revs': list }, 'Code');
  const t = makeBranch(main);
  commit(t.path, { 'src/a.rs': 'fn  a()  { ours }\n' }, 'Ours');
  const before = sh(t.path, 'git rev-parse HEAD');
  formatOnMain(main, fmt);
  commit(main, { 'src/a.rs': 'fn a() { theirs }\n' }, 'Theirs');
  const c = capture();
  assert.equal(await land(t, c.opts), 1);
  assert.match(c.err.join('\n'), /real conflicts at .*\(Ours\)[\s\S]*src\/a\.rs[\s\S]*scripts\/replay-over-format\.sh/);
  assert.equal(sh(t.path, 'git rev-parse HEAD'), before, 'nothing moved');
});

test('a fork merges a release with a format commit in it without formatting conflicts, Mike\'s ids kept', async () => {
  const { main, fmt, list } = setup();
  // Mike's history: code, the config, the format commit, a later change.
  commit(main, { 'src/a.rs': 'fn  a()  {}\n\nfn  m() {}\n' }, 'Code');
  const fork = makeBranch(main, 'forkmain');
  commit(main, { 'fmt.toml': 'style = 1\n', '.git-blame-ignore-revs': list }, 'Format config');
  const f = formatOnMain(main, fmt);
  commit(main, { 'src/a.rs': 'fn a() {}\n\nfn m() { later }\n' }, 'Later');
  const release = sh(main, 'git rev-parse main');
  // The fork's own: a change to the same file, and a merge of its own.
  commit(fork.path, { 'src/a.rs': 'fn  a()  { mine }\n\nfn  m() {}\n' }, 'Mine');
  sh(fork.path, 'git checkout -q -b side && git commit -q --allow-empty -m side && git checkout -q thread/forkmain && git merge -q --no-ff side -m "Their merge"');
  const r = await mergeAcross(fork.path, release, { message: "Bring in Mike's release" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(sh(fork.path, 'git show HEAD:src/a.rs'), 'fn a() { mine }\n\nfn m() { later }');
  for (const id of [f, release]) assert.equal(sh(fork.path, `git merge-base --is-ancestor ${id} HEAD && echo yes`), 'yes');
  assert.equal(sh(fork.path, 'git log -1 --format=%s'), "Bring in Mike's release");
  assert.equal(sh(fork.path, 'git status --porcelain'), '');
});

test('the script carries a branch, and with a real conflict leaves a rebase to finish', () => {
  const { main, fmt, list } = setup();
  const script = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'replay-over-format.sh');
  commit(main, { 'src/a.rs': 'fn  a()  {}\n', 'src/b.rs': 'fn  b()  {}\n', 'fmt.toml': 'style = 1\n', '.git-blame-ignore-revs': list }, 'Code');
  const t = makeBranch(main);
  commit(t.path, { 'src/a.rs': 'fn  a()  { ours }\n' }, 'Ours');
  commit(t.path, { 'src/b.rs': 'fn  b()  { 2 }\n' }, 'Second');
  formatOnMain(main, fmt);
  commit(main, { 'src/a.rs': 'fn a() { theirs }\n' }, 'Theirs');
  let failed = false;
  try {
    execFileSync(script, [], { cwd: t.path, encoding: 'utf8', stdio: 'pipe' });
  } catch {
    failed = true;
  }
  assert.ok(failed, 'stops at the conflict');
  assert.ok(fs.existsSync(path.join(sh(t.path, 'git rev-parse --git-dir'), 'rebase-merge')), 'a rebase in progress');
  // Sorted out by hand: the rest is formatted already.
  write(t.path, { 'src/a.rs': 'fn a() { both }\n' });
  sh(t.path, 'git add src/a.rs && GIT_EDITOR=true git rebase --continue');
  assert.equal(sh(t.path, 'git log --format=%s -3'), 'Second\nOurs\nTheirs');
  assert.equal(sh(t.path, 'git show HEAD:src/b.rs'), 'fn b() { 2 }');
  assert.equal(sh(t.path, 'git rev-parse --abbrev-ref HEAD'), t.branch);
  void fmt;
});

test('a format commit found by subject must be the only one with it, and only change what it formats', async () => {
  const { main, fmt, list } = setup();
  commit(main, { 'src/a.rs': 'fn  a()  {}\n', 'fmt.toml': 'style = 1\n', '.git-blame-ignore-revs': list }, 'Code');
  const f = formatOnMain(main, fmt);
  assert.deepEqual((await formatCommitsIn(main, 'main')).map((x) => x.commit), [f]);
  // A second commit with its subject: which one is it? Neither, until the id is written.
  commit(main, { 'src/a.rs': 'fn a() { changed }\n' }, SUBJECT);
  assert.deepEqual(await formatCommitsIn(main, 'main'), []);
  commit(main, { '.git-blame-ignore-revs': `${list}${f}\n` }, 'Write its id');
  assert.deepEqual((await formatCommitsIn(main, 'main')).map((x) => x.commit), [f]);
  // One that changes something outside what it formats isn't one.
  const { main: other, fmt: fmt2, list: list2 } = setup();
  commit(other, { 'src/a.rs': 'fn  a()  {}\n', 'fmt.toml': 'style = 1\n', '.git-blame-ignore-revs': list2 }, 'Code');
  execFileSync('node', [fmt2], { cwd: other, stdio: 'ignore' });
  write(other, { 'README.md': 'changed\n' });
  sh(other, `git add -A && git commit -qm "${SUBJECT}"`);
  assert.deepEqual(await formatCommitsIn(other, 'main'), []);
});

test('a branch with a link where the config goes neither writes through it nor loses it', async () => {
  const { root, main, fmt, list } = setup();
  const list2 = list.replace('# format-config: fmt.toml', '# format-config: fmt.toml src/fmt.toml');
  commit(main, { 'src/a.rs': 'fn  a()  {}\n', 'fmt.toml': 'style = 1\n', 'src/fmt.toml': 'x\n', '.git-blame-ignore-revs': list2 }, 'Code');
  const p = sh(main, 'git rev-parse HEAD');
  const t = makeBranch(main);
  const outside = path.join(root, 'outside.toml');
  sh(t.path, `rm src/fmt.toml && ln -s '${outside}' src/fmt.toml && git add -A && git commit -qm "Link it"`);
  commit(t.path, { 'src/a.rs': 'fn  a()  { 1 }\n' }, 'Edit a');
  const tip = sh(t.path, 'git rev-parse HEAD');
  formatOnMain(main, fmt);
  const r = await carryAcross(main, { base: p, tip, onto: sh(main, 'git rev-parse main'), formatter: new TreeFormatter(main, await crossings(main, tip, 'main')) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(!fs.existsSync(outside), 'nothing written through the link');
  assert.equal(sh(main, `git ls-tree ${r.tip} src/fmt.toml | cut -c1-6`), '120000', 'the link is still there');
  assert.equal(sh(main, `git show ${r.tip}:src/a.rs`), 'fn a() { 1 }');
});

test('a commit the formatter gives up on entirely keeps the formatting of every file it didn\'t touch', async () => {
  const { main, fmt, list } = setup();
  commit(main, { 'src/a.rs': 'fn  a()  {}\n', 'src/b.rs': 'fn  b()  {}\n', 'fmt.toml': 'style = 1\n', '.git-blame-ignore-revs': list }, 'Code');
  const p = sh(main, 'git rev-parse HEAD');
  const t = makeBranch(main);
  commit(t.path, { 'src/c.rs': 'fn  c() { FATAL }\n' }, 'Break it');
  commit(t.path, { 'src/c.rs': 'fn  c()  {}\n' }, 'Mend it');
  const tip = sh(t.path, 'git rev-parse HEAD');
  formatOnMain(main, fmt);
  const r = await carryAcross(main, { base: p, tip, onto: sh(main, 'git rev-parse main'), formatter: new TreeFormatter(main, await crossings(main, tip, 'main')) });
  assert.ok(r.ok, JSON.stringify(r));
  const first = sh(main, `git rev-list --reverse main..${r.tip} | head -1`);
  assert.equal(sh(main, `git diff --name-only main ${first}`), 'src/c.rs', 'only its own file differs from main');
  assert.equal(sh(main, `git show ${first}:src/a.rs`), 'fn a() {}');
  assert.equal(sh(main, `git rev-parse ${r.tip}^{tree}`), formattedTree(main, fmt, tip));
});

test('a commit already on main (landed as a copy before the format commit) is left out, as rebase leaves it', async () => {
  const { main, fmt, list } = setup();
  commit(main, { 'src/a.rs': 'fn  a()  {\n    one();\n}\n', 'fmt.toml': 'style = 1\n', '.git-blame-ignore-revs': list }, 'Code');
  const p = sh(main, 'git rev-parse HEAD');
  const t = makeBranch(main);
  commit(t.path, { 'src/a.rs': 'fn  a()  {\n    one();\n    two(  );\n}\n' }, 'Two');
  commit(t.path, { 'src/b.rs': 'fn  b() {}\n' }, 'Add b');
  // Main takes the first as a copy, then changes the same lines further, then formats.
  sh(main, `git cherry-pick -x ${sh(t.path, 'git rev-parse HEAD^')}`);
  commit(main, { 'src/a.rs': 'fn  a()  {\n    one();\n    two(  3 );\n}\n' }, 'Three');
  formatOnMain(main, fmt);
  const tip = sh(t.path, 'git rev-parse HEAD');
  const r = await carryAcross(main, { base: p, tip, onto: sh(main, 'git rev-parse main'), formatter: new TreeFormatter(main, await crossings(main, tip, 'main')) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.count, 1);
  assert.match(r.notes.join('\n'), /\(Two\) was left out: it's on/);
  assert.equal(sh(main, `git show ${r.tip}:src/a.rs`), 'fn a() {\n one();\n two( 3 );\n}');
  assert.equal(sh(main, `git log -1 --format=%s ${r.tip}`), 'Add b');
});

test('the script\'s rebase leaves out a commit already on main as well, past a real conflict', () => {
  const { main, fmt, list } = setup();
  const script = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'replay-over-format.sh');
  commit(main, { 'src/a.rs': 'fn  a()  {}\n', 'src/b.rs': 'fn  b()  {\n    one();\n}\n', 'fmt.toml': 'style = 1\n', '.git-blame-ignore-revs': list }, 'Code');
  const t = makeBranch(main);
  commit(t.path, { 'src/b.rs': 'fn  b()  {\n    one();\n    two(  );\n}\n' }, 'Two');
  commit(t.path, { 'src/a.rs': 'fn  a()  { ours }\n' }, 'Ours');
  sh(main, `git cherry-pick -x ${sh(t.path, 'git rev-parse HEAD^')}`);
  commit(main, { 'src/b.rs': 'fn  b()  {\n    one();\n    two(  3 );\n}\n' }, 'Three');
  formatOnMain(main, fmt);
  commit(main, { 'src/a.rs': 'fn a() { theirs }\n' }, 'Theirs');
  let output = '';
  try {
    execFileSync(script, [], { cwd: t.path, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_CONFIG_PARAMETERS: "'rebase.abbreviatecommands'='true' 'core.abbrev'='4'" } });
  } catch (e) {
    output = String((e as { stdout?: string }).stdout ?? '');
  }
  assert.match(output, /is on main already, so it's left out/);
  write(t.path, { 'src/a.rs': 'fn a() { both }\n' });
  sh(t.path, 'git add src/a.rs && GIT_EDITOR=true git rebase --continue');
  assert.equal(sh(t.path, 'git log --format=%s -2'), 'Ours\nTheirs');
  assert.equal(sh(t.path, 'git show HEAD:src/b.rs'), 'fn b() {\n one();\n two( 3 );\n}');
});
