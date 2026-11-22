// Carrying work across a format commit made by a tool that adds and deletes
// files (`# format-tool:`, format-replay.ts): the split of docs/protocol.md
// into docs/protocol/ (scripts/split-protocol.mjs, the real one). Real git in
// temp repos, as format-replay.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { capture, commit, makeBranch, makeRepo, sh } from '../helpers/worktrees-harness.ts';
import { land } from '../../src/worktrees.ts';
import { carryAcross, crossings, mergeAcross, parseFormatList, remakeOwn, TreeFormatter } from '../../src/format-replay.ts';

const SCRIPT = fs.readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'split-protocol.mjs'), 'utf8');
const SUBJECT = 'Split docs/protocol.md into a file per area, moving text only';
const LIST = `# format-subject: ${SUBJECT}\n# format-tool: node scripts/split-protocol.mjs\n# format-paths: docs/protocol.md docs/protocol\n# format-config: scripts/split-protocol.mjs\n`;

// The single file, in small: real headings, so the real map applies.
const DOC = [
  '# Runner protocol (v1)',
  '',
  'The app and the runner talk JSON-RPC.',
  '',
  '## Auth',
  '',
  'A token.',
  '',
  '## Needs you',
  '',
  'The card.',
  'Its asks.',
  '',
  '## Patches',
  '',
  'A patch file.',
  '',
  "### Trusting a folder's patches",
  '',
  'Trusted as left.',
  '',
  '## Ordering and reconnects',
  '',
  'In seq order.',
  '',
].join('\n');

const edit = (doc: string, from: string, to: string) => {
  assert.ok(doc.includes(from), from);
  return doc.replace(from, to);
};

// A repo with the script and the list on main (as the landing before the split).
function setup() {
  const { main } = makeRepo();
  commit(main, { 'docs/protocol.md': DOC, 'docs/guide.md': 'guide\n', 'scripts/split-protocol.mjs': SCRIPT, '.git-blame-ignore-revs': LIST }, 'Protocol and the script');
  return main;
}

function splitOn(dir: string): string {
  sh(dir, 'node scripts/split-protocol.mjs');
  sh(dir, `git add -A docs && git commit -qm "${SUBJECT}"`);
  return sh(dir, 'git rev-parse HEAD');
}

test('format-tool: a command that may add and delete files; an older copy skips the entry', () => {
  const [e] = parseFormatList(LIST);
  assert.deepEqual(e, { subject: SUBJECT, command: 'node scripts/split-protocol.mjs', paths: ['docs/protocol.md', 'docs/protocol'], config: ['scripts/split-protocol.mjs'], adds: true });
  // What a copy that only knows format-command reads: no command, no entry.
  const old = (text: string) => parseFormatList(text.replace(/^# format-tool:.*$/m, ''));
  assert.deepEqual(old(LIST), []);
});

test('an edit to a section of the old file comes across into the file the section went to, with a citation beside it', async () => {
  const main = setup();
  const p = sh(main, 'git rev-parse HEAD');
  const t = makeBranch(main);
  commit(t.path, { 'docs/protocol.md': edit(DOC, 'Its asks.', 'Its asks, one by one.'), 'runner/a.ts': '// docs/protocol.md, "Needs you"\nexport const a = 2;\n' }, 'Edit the card and cite it');
  const tip = sh(t.path, 'git rev-parse HEAD');
  const f = splitOn(main);
  const cross = await crossings(main, tip, 'main');
  assert.deepEqual(cross.map((c) => c.commit), [f]);
  const r = await carryAcross(main, { base: p, tip, onto: f, formatter: new TreeFormatter(main, cross) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(sh(main, `git diff --name-only ${f} ${r.tip}`), 'docs/protocol/needs-you.md\nrunner/a.ts');
  assert.match(sh(main, `git show ${r.tip}:docs/protocol/needs-you.md`), /The card\.\nIts asks, one by one\./);
  assert.equal(sh(main, `git show ${r.tip}:runner/a.ts`), '// docs/protocol.md, "Needs you"\nexport const a = 2;');
  assert.doesNotMatch(sh(main, `git show ${r.tip}:docs/protocol.md`), /The card/);
});

test('a section the branch added goes with the one before it, and the index lists it', async () => {
  const main = setup();
  const p = sh(main, 'git rev-parse HEAD');
  const t = makeBranch(main);
  commit(t.path, { 'docs/protocol.md': edit(DOC, 'A token.\n', 'A token.\n\n## Brand new\n\nNever seen.\n') }, 'Add a section');
  const tip = sh(t.path, 'git rev-parse HEAD');
  const f = splitOn(main);
  // Main moves on in the new files meanwhile.
  commit(main, { 'docs/protocol/patches.md': sh(main, 'cat docs/protocol/patches.md').replace('A patch file.', 'A patch file, in a folder.') + '\n' }, 'After the split');
  const r = await carryAcross(main, { base: p, tip, onto: sh(main, 'git rev-parse main'), formatter: new TreeFormatter(main, await crossings(main, tip, 'main')) });
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(sh(main, `git show ${r.tip}:docs/protocol/connection.md`), /A token\.\n\n## Brand new\n\nNever seen\./);
  assert.match(sh(main, `git show ${r.tip}:docs/protocol.md`), /\| \[connection\.md\]\(protocol\/connection\.md\) \| Auth, Brand new \|/);
  assert.match(sh(main, `git show ${r.tip}:docs/protocol/patches.md`), /in a folder/);
  void f;
});

test('tb land carries a branch across the split by itself', async () => {
  const main = setup();
  const t = makeBranch(main);
  commit(t.path, { 'docs/protocol.md': edit(DOC, 'Trusted as left.', 'Trusted as left, by its hash.') }, 'Edit trust');
  splitOn(main);
  const c = capture();
  assert.equal(await land(t, c.opts), 0, c.err.join('\n'));
  assert.match(c.out.join('\n'), /Carried 1 commit across/);
  assert.match(sh(main, 'git show main:docs/protocol/trust.md'), /by its hash/);
  assert.equal(sh(main, 'node scripts/split-protocol.mjs --check && echo current'), 'current');
});

test('a fork with a merge of its own brings in a release with the split, its edit in the right file', async () => {
  const main = setup();
  const fork = makeBranch(main, 'forkmain');
  const f = splitOn(main);
  commit(main, { 'README.md': 'later\n' }, 'Later');
  const release = sh(main, 'git rev-parse main');
  commit(fork.path, { 'docs/protocol.md': edit(DOC, 'In seq order.', 'In seq order, always.') + 'mine\n' }, 'Mine');
  sh(fork.path, 'git checkout -q -b side && git commit -q --allow-empty -m side && git checkout -q thread/forkmain && git merge -q --no-ff side -m "Their merge"');
  const r = await mergeAcross(fork.path, release, { message: 'Bring in the release' });
  assert.ok(r.ok, JSON.stringify(r));
  const index = sh(fork.path, 'git show HEAD:docs/protocol.md');
  assert.match(index, /In seq order, always\.\nmine$/);
  assert.match(sh(fork.path, 'git show HEAD:docs/protocol/needs-you.md'), /Its asks\./);
  for (const id of [f, release]) assert.equal(sh(fork.path, `git merge-base --is-ancestor ${id} HEAD && echo yes`), 'yes');
  assert.equal(sh(fork.path, 'git status --porcelain'), '');
});

test('a branch bringing in the split itself has it made again on a main that moved on', async () => {
  const main = setup();
  const t = makeBranch(main);
  commit(t.path, { 'docs/guide.md': 'guide, before\n' }, 'Before it');
  splitOn(t.path);
  commit(t.path, { 'docs/protocol/needs-you.md': sh(t.path, 'cat docs/protocol/needs-you.md').replace('The card.', 'The card, after.') + '\n' }, 'After it');
  // Main changes the old file meanwhile: a plain rebase conflicts.
  commit(main, { 'docs/protocol.md': edit(DOC, 'A patch file.', 'A patch file, on main.') }, 'Main edits patches');
  const direct = await remakeOwn(main, 'main', t.branch);
  assert.ok(direct?.ok, JSON.stringify(direct));
  const c = capture();
  assert.equal(await land(t, c.opts), 0, c.err.join('\n'));
  assert.match(c.out.join('\n'), /Made .* again on main/);
  assert.equal(sh(main, 'git log --format=%s -4'), `After it\n${SUBJECT}\nBefore it\nMain edits patches`);
  assert.match(sh(main, 'git show main:docs/protocol/patches.md'), /A patch file, on main\./);
  assert.match(sh(main, 'git show main:docs/protocol/needs-you.md'), /The card, after\./);
  assert.equal(sh(main, 'git diff --name-only main^^ main^'), 'docs/protocol.md\ndocs/protocol/connection.md\ndocs/protocol/needs-you.md\ndocs/protocol/patches.md\ndocs/protocol/trust.md');
  // A branch with no such commit is left to the rebase.
  const other = makeBranch(main, 'other123');
  commit(other.path, { 'README.md': 'x\n' }, 'Plain');
  assert.equal(await remakeOwn(main, 'main', other.branch), undefined);
});

test('a branch that made one of the new files beside the old one is left as it was, not written over', async () => {
  const main = setup();
  const p = sh(main, 'git rev-parse HEAD');
  const t = makeBranch(main);
  commit(t.path, { 'docs/protocol/connection.md': 'my own notes\n' }, 'Start a file of its own');
  const tip = sh(t.path, 'git rev-parse HEAD');
  splitOn(main);
  // The tool refuses to split over it, so carrying stops (tb land then
  // rebases as it is, and the conflict is a person's).
  await assert.rejects(carryAcross(main, { base: p, tip, onto: sh(main, 'git rev-parse main'), formatter: new TreeFormatter(main, await crossings(main, tip, 'main')) }), /there already/);
});

test('a later commit with the same subject as the format commit is never run away', async () => {
  const main = setup();
  const t = makeBranch(main);
  splitOn(t.path);
  commit(t.path, { 'docs/protocol/needs-you.md': sh(t.path, 'cat docs/protocol/needs-you.md').replace('The card.', 'The card, fixed.') + '\n' }, SUBJECT);
  commit(main, { 'docs/protocol.md': edit(DOC, 'A patch file.', 'A patch file, on main.') }, 'Main edits patches');
  assert.equal(await remakeOwn(main, 'main', t.branch), undefined);
});

test('a change of mode alone to the old file comes across', { skip: process.platform === 'win32' }, async () => {
  const main = setup();
  const p = sh(main, 'git rev-parse HEAD');
  const t = makeBranch(main);
  sh(t.path, 'chmod +x docs/protocol.md && git commit -qam "Make it executable"');
  const tip = sh(t.path, 'git rev-parse HEAD');
  splitOn(main);
  const r = await carryAcross(main, { base: p, tip, onto: sh(main, 'git rev-parse main'), formatter: new TreeFormatter(main, await crossings(main, tip, 'main')) });
  assert.ok(r.ok && r.count === 1, JSON.stringify(r));
  assert.equal(sh(main, `git ls-tree ${r.tip} docs/protocol.md`).slice(0, 6), '100755');
});

test('tb land makes the split again even where a rebase would go through, so a section main added goes in the table', async () => {
  const main = setup();
  const t = makeBranch(main);
  splitOn(t.path);
  // Main adds a section at the end, where the split commit changed nothing.
  commit(main, { 'docs/protocol.md': DOC + '\n## Brand new at the end\n\nFrom main.\n' }, 'Main adds a section');
  const c = capture();
  assert.equal(await land(t, c.opts), 0, c.err.join('\n'));
  assert.match(c.out.join('\n'), /Made .* again on main/);
  assert.equal(sh(main, 'node scripts/split-protocol.mjs --check && echo current'), 'current');
  assert.match(sh(main, 'git show main:docs/protocol.md'), /\| this page \| Ordering and reconnects, Brand new at the end \|/);
});
