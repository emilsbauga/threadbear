import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { SHELL, shPath } from '../helpers/platform.ts';

// Security review finding 3 (a), 9 Nov 2026, and Codex's review of it: the
// bring-in thread works a release's merge out with scripts/merge-preview.sh
// before the owner says go, and nothing configured anywhere runs on the
// release's files while it does: not a merge driver an attribute names,
// not merge.default, not one from .git/info/attributes.
const SCRIPT = path.join(import.meta.dirname, '../../../scripts/merge-preview.sh');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

test('the merge preview shows clashes and changes, and runs no merge driver from any config or attributes', () => {
  const root = tmpDir('tb-preview-');
  const repo = path.join(root, 'r');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.sh merge=preview diff=preview\n');
  fs.writeFileSync(path.join(repo, 'a.sh'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'branch', '-q', 'release');
  fs.writeFileSync(path.join(repo, 'a.sh'), 'theirs\n');
  git(repo, 'commit', '-qam', 'their change');
  git(repo, 'checkout', '-q', 'release');
  fs.writeFileSync(path.join(repo, 'a.sh'), 'alex\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', "Alex's change");
  const release = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  const marker = path.join(root, 'ran');
  // A script, so its path is the whole command: a `;` would start a
  // comment in a config file written by hand (the template's, below).
  const driver = path.join(root, 'driver.sh');
  fs.writeFileSync(driver, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  // (Git runs these through sh, which reads a Windows path's backslashes as escapes.)
  git(repo, 'config', 'merge.preview.driver', shPath(driver));
  git(repo, 'config', 'merge.custom.driver', shPath(driver));
  git(repo, 'config', 'merge.default', 'custom');
  git(repo, 'config', 'diff.preview.command', shPath(driver));
  git(repo, 'config', 'diff.preview.textconv', shPath(driver));
  fs.mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'info', 'attributes'), '* merge=preview diff=preview\n');
  // And a git template that would copy one into any new repo (Codex's
  // third look: the preview's own throwaway repo).
  const template = path.join(root, 'template');
  fs.mkdirSync(path.join(template, 'info'), { recursive: true });
  fs.writeFileSync(path.join(template, 'config'), `[merge "custom"]\n\tdriver = ${shPath(driver)}\n[merge]\n\tdefault = custom\n`);
  fs.writeFileSync(path.join(template, 'info', 'attributes'), '* merge=custom\n');
  // Plain git would run it, so the check below means something.
  spawnSync('git', ['-C', repo, 'merge-tree', '--write-tree', 'main', release], { env: ENV });
  assert.ok(fs.existsSync(marker), 'plain merge-tree runs the driver');
  fs.rmSync(marker);
  const r = spawnSync(SHELL[0], [shPath(SCRIPT), release], { cwd: repo, encoding: 'utf8', env: { ...ENV, GIT_TEMPLATE_DIR: template } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /a\.sh/);
  assert.match(r.stdout, /clashes/);
  assert.match(r.stdout, /b\.txt/);
  assert.ok(!fs.existsSync(marker), 'no driver ran');
  assert.equal(git(repo, 'status', '--porcelain'), '', 'nothing checked out or changed');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
});

// A release with a format commit main doesn't have (format-replay.ts): the
// preview says so, names the script that settles its clashes after go, and
// lists only the real clashes, from merging the commit before it.
test('the merge preview points past a format commit to the real clashes', () => {
  const root = tmpDir('tb-preview-fmt-');
  const repo = path.join(root, 'r');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src', 'a.rs'), 'fn  a() {}\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.rs'), 'fn  b() {}\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'branch', '-q', 'release');
  fs.writeFileSync(path.join(repo, 'src', 'a.rs'), 'fn  a() { mine }\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.rs'), 'fn  b() { mine }\n');
  git(repo, 'commit', '-qam', 'mine');
  git(repo, 'checkout', '-q', 'release');
  fs.writeFileSync(path.join(repo, 'src', 'b.rs'), 'fn  b() { theirs }\n');
  fs.writeFileSync(path.join(repo, '.git-blame-ignore-revs'), '# format-subject: Format it\n# format-command: fmt\n# format-paths: src\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'theirs');
  fs.writeFileSync(path.join(repo, 'src', 'a.rs'), 'fn a() {}\n');
  fs.writeFileSync(path.join(repo, 'src', 'b.rs'), 'fn b() { theirs }\n');
  git(repo, 'commit', '-qam', 'Format it');
  const release = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'main');
  const r = spawnSync(SHELL[0], [shPath(SCRIPT), release], { cwd: repo, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /format commit main doesn't: [0-9a-f]{40} \(Format it\)/);
  assert.match(r.stdout, /replay-over-format\.sh --merge/);
  const real = r.stdout.slice(r.stdout.indexOf('The real clashes'));
  assert.match(real, /b\.rs/);
  assert.doesNotMatch(real, /a\.rs/);
});

// Settling the clashes while the owner decides (Ville Lahdenvuo-Malta, 22
// Nov 2026: about 5 minutes of a 35-minute bring-in was settling clashes
// after go). --prepare writes each clashing file, with its markers, to a
// folder outside the checkout; after go, merge-prepared.sh merges and puts
// in the settled copies. It changes nothing while one still has markers,
// and catches up a branch that started behind main first.
const PREPARED = path.join(import.meta.dirname, '../../../scripts/merge-prepared.sh');

test('clashes settled before go go in with the merge', () => {
  const root = tmpDir('tb-preview-prep-');
  const repo = path.join(root, 'r');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  // GitHub's Windows has core.autocrlf on, which checks b.txt out as new\r\n.
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'branch', '-q', 'release');
  git(repo, 'branch', '-q', 'thread');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'mine\n');
  git(repo, 'commit', '-qam', 'mine');
  git(repo, 'checkout', '-q', 'release');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'theirs\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'theirs');
  const release = git(repo, 'rev-parse', 'HEAD');
  // The thread's branch, from main before its last commit.
  git(repo, 'checkout', '-q', 'thread');
  const preview = (dir: string) => spawnSync(SHELL[0], [shPath(SCRIPT), '--prepare', shPath(dir), release], { cwd: repo, encoding: 'utf8', env: ENV });

  const inside = preview(path.join(repo, 'prep'));
  assert.notEqual(inside.status, 0, 'a folder inside the checkout is refused');
  assert.ok(!fs.existsSync(path.join(repo, 'prep')), 'and not left behind');
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'keep'), 'x');
  fs.mkdirSync(path.join(other, 'files'));
  assert.notEqual(preview(other).status, 0, 'a folder with something else in it is refused');
  assert.ok(fs.existsSync(path.join(other, 'files')), 'and left alone');

  const prep = path.join(root, 'prep');
  const r = preview(prep);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(prep, 'clashes'), 'utf8'), 'a.txt\n');
  assert.match(fs.readFileSync(path.join(prep, 'files', 'a.txt'), 'utf8'), /^<<<<<<< [\s\S]*mine[\s\S]*theirs/);
  assert.equal(git(repo, 'status', '--porcelain'), '', 'nothing checked out or changed');

  const apply = () => spawnSync(SHELL[0], [shPath(PREPARED), shPath(prep), '-m', 'Bring it in'], { cwd: repo, encoding: 'utf8', env: ENV });
  const early = apply();
  assert.notEqual(early.status, 0);
  assert.match(early.stderr, /conflict markers.*a\.txt/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main^'), 'nothing changed');

  fs.writeFileSync(path.join(prep, 'files', 'a.txt'), 'mine and theirs\n');
  // Main moved on since the preview: the settled files may be stale.
  const main = git(repo, 'rev-parse', 'main');
  git(repo, 'update-ref', 'refs/heads/main', git(repo, 'commit-tree', '-p', main, '-m', 'later', `${main}^{tree}`));
  const stale = apply();
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /main has moved on/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main~2'), 'nothing changed');
  git(repo, 'update-ref', 'refs/heads/main', main);

  const done = apply();
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'mine and theirs\n');
  assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'new\n');
  assert.equal(git(repo, 'rev-parse', 'HEAD^1'), git(repo, 'rev-parse', 'main'));
  assert.equal(git(repo, 'rev-parse', 'HEAD^2'), release);
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'Bring it in');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

// Daybreak 180, 24 Nov 2026: a refs/replace/ entry or info/grafts in the
// checkout has git read another commit in place of the release's signed one,
// so a merge would take an unsigned tree under the signed id. The preview,
// the prepared merge and the format replay refuse such a checkout, and their
// git reads the release as itself; a clean preview merges with the same
// helper as one with clashes.
const REPLAY = path.join(import.meta.dirname, '../../../scripts/replay-over-format.sh');

test("a replacement ref or grafts stop the preview, the merge and the format replay, which merge the release's own commit", () => {
  const root = tmpDir('tb-preview-replace-');
  const repo = path.join(root, 'r');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'release');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'signed\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'signed');
  const release = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'evil', base);
  fs.writeFileSync(path.join(repo, 'b.txt'), 'evil\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'evil');
  const evil = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-b', 'thread', 'main');
  const run = (...args: string[]) => spawnSync(SHELL[0], args, { cwd: repo, encoding: 'utf8', env: ENV });
  const prep = path.join(root, 'prep');
  const preview = () => run(shPath(SCRIPT), '--prepare', shPath(prep), release);
  const apply = () => run(shPath(PREPARED), shPath(prep), '-m', 'Bring it in');
  const replay = () => run(shPath(REPLAY), '--merge', release, '-m', 'Bring it in');
  const grafts = path.join(repo, '.git', 'info', 'grafts');
  // Each substitution, refused by each step, before go and after.
  const substitutions: [string, () => void, () => void][] = [
    ['replacement refs', () => git(repo, 'replace', release, evil), () => git(repo, 'replace', '-d', release)],
    ['grafts', () => fs.writeFileSync(grafts, `${release} ${evil}\n`), () => fs.rmSync(grafts)],
  ];
  for (const [what, add, remove] of substitutions) {
    add();
    for (const [step, out] of [['preview', preview()], ['format replay', replay()]] as const) {
      assert.notEqual(out.status, 0, `${step} with ${what}`);
      assert.match(out.stderr + out.stdout, new RegExp(what), `${step} with ${what}`);
    }
    remove();
  }
  const r = preview();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(prep, 'clashes'), 'utf8'), '', 'a clean merge leaves an empty list');
  for (const [what, add, remove] of substitutions) {
    add();
    const out = apply();
    assert.notEqual(out.status, 0, `merge with ${what}`);
    assert.match(out.stderr + out.stdout, new RegExp(what), `merge with ${what}`);
    remove();
  }
  assert.equal(git(repo, 'rev-parse', 'HEAD'), base, 'nothing merged');

  const done = apply();
  assert.equal(done.status, 0, done.stderr + done.stdout);
  assert.equal(git(repo, 'rev-parse', 'HEAD^2'), release);
  assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'signed\n');
});
