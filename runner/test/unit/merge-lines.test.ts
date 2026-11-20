// docs/experiments.md's merge driver (scripts/merge-lines.mjs). On 17 Nov
// main took out one experiment and a thread's branch another; the rebase in
// `tb land` merged the doc by union, which brought both lines back, and the
// landing's check failed on experiment-docs.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error: a plain .mjs script, no types
import { mergeLines } from '../../../scripts/merge-lines.mjs';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'merge-lines.mjs');

const DOC = [
  '# Experiments',
  '',
  '<!-- list:start -->',
  '- **Alpha** (`alpha`). Does a.',
  '- **Beta** (`beta`). Does b.',
  '- **Gamma** (`gamma`). Does c.',
  '<!-- list:end -->',
  '',
  '| Experiment | Lives in | Taking it out |',
  '|---|---|---|',
  '| Alpha (`alpha`) | a.ts | Delete it. |',
  '| Beta (`beta`) | b.ts | Delete it. |',
  '| Gamma (`gamma`) | c.ts | Delete it. |',
  '',
].join('\n');

const without = (doc: string, id: string) => doc.split('\n').filter((l) => !l.includes(`(\`${id}\`)`)).join('\n');
// A new entry after each of `after`'s two lines: the list's and the table's.
const adding = (doc: string, id: string, after: string) =>
  doc.split('\n').flatMap((l) => !l.includes(`(\`${after}\`)`) ? [l]
    : [l, l.startsWith('- ') ? `- **${id}** (\`${id}\`). New.` : `| ${id} (\`${id}\`) | ${id}.ts | Delete it. |`]).join('\n');

test('merge-lines: each side taking out a different entry takes out both', () => {
  assert.equal(mergeLines(DOC, without(DOC, 'alpha'), without(DOC, 'beta')), without(without(DOC, 'alpha'), 'beta'));
});

test('merge-lines: each side adding an entry keeps both, each in its own section', () => {
  const merged = mergeLines(DOC, adding(DOC, 'one', 'alpha'), adding(DOC, 'two', 'gamma'));
  const lines: string[] = merged.split('\n');
  assert.equal(lines.indexOf('- **one** (`one`). New.'), lines.indexOf('- **Alpha** (`alpha`). Does a.') + 1);
  assert.equal(lines.indexOf('- **two** (`two`). New.'), lines.indexOf('- **Gamma** (`gamma`). Does c.') + 1);
  assert.equal(lines.indexOf('| two (`two`) | two.ts | Delete it. |'), lines.indexOf('| Gamma (`gamma`) | c.ts | Delete it. |') + 1);
  assert.equal(lines.filter((l) => l === '').length, DOC.split('\n').filter((l) => l === '').length, 'blank lines are counted, not doubled');
});

test('merge-lines: the same change on both sides counts once', () => {
  const gone = without(DOC, 'beta');
  assert.equal(mergeLines(DOC, gone, gone), gone);
  const added = adding(DOC, 'one', 'alpha');
  assert.equal(mergeLines(DOC, added, added), added);
  assert.equal(mergeLines(DOC, DOC, DOC), DOC);
});

test('merge-lines: a side that turned the file to CRLF still loses what the other took out', () => {
  assert.equal(mergeLines('a\nb\n', 'a\n', 'a\r\nb\r\nc\r\n'), 'a\nc\n');
});

test('merge-lines: one side adding while the other takes out', () => {
  assert.equal(mergeLines(DOC, adding(DOC, 'one', 'alpha'), without(DOC, 'gamma')), without(adding(DOC, 'one', 'alpha'), 'gamma'));
});

// The real thing: git with the driver set up as worktree-setup.sh sets it,
// a rebase like tb land's (from a subfolder, to show the script's relative
// path holds) and a merge-tree like its group replay.
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
}

function twoRemovals(attribute: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-lines-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'merge.lines.driver', `'${process.execPath}' scripts/merge-lines.mjs %O %A %B`);
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.mkdirSync(path.join(dir, 'runner'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'merge-lines.mjs'));
  fs.writeFileSync(path.join(dir, '.gitattributes'), `docs/experiments.md ${attribute}\n`);
  fs.writeFileSync(path.join(dir, 'docs', 'experiments.md'), DOC);
  fs.writeFileSync(path.join(dir, 'runner', 'keep'), '');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'thread/x');
  fs.writeFileSync(path.join(dir, 'docs', 'experiments.md'), without(DOC, 'beta'));
  git(dir, 'commit', '-qam', 'take out beta');
  git(dir, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'docs', 'experiments.md'), without(DOC, 'alpha'));
  git(dir, 'commit', '-qam', 'take out alpha');
  return dir;
}

test('merge-lines: git rebase and merge-tree of two branches each taking out an experiment', (t) => {
  const dir = twoRemovals('merge=lines');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const want = without(without(DOC, 'alpha'), 'beta');

  const tree = git(dir, 'merge-tree', '--write-tree', 'main', 'thread/x').trim();
  assert.equal(git(dir, 'show', `${tree}:docs/experiments.md`), want);

  git(dir, 'checkout', '-q', 'thread/x');
  git(path.join(dir, 'runner'), 'rebase', 'main');
  assert.equal(fs.readFileSync(path.join(dir, 'docs', 'experiments.md'), 'utf8'), want);
});

test('merge-lines: union, as it was, brings a taken-out experiment back', (t) => {
  const dir = twoRemovals('merge=union');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'checkout', '-q', 'thread/x');
  git(dir, 'rebase', 'main');
  const doc = fs.readFileSync(path.join(dir, 'docs', 'experiments.md'), 'utf8');
  assert.ok(doc.includes('`alpha`') && doc.includes('`beta`'));
});

test('merge-lines: the repo uses it, and worktree-setup.sh sets it up as the test does', () => {
  assert.match(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8'), /^docs\/experiments\.md merge=lines$/m);
  assert.ok(fs.readFileSync(path.join(ROOT, 'worktree-setup.sh'), 'utf8').includes(`config merge.lines.driver "'$NODE' scripts/merge-lines.mjs %O %A %B"`));
});
