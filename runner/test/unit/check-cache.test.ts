// check.sh's pass records (scripts/check-cache.mjs): a step or a runner unit
// test file that passed with the same inputs is skipped, in any worktree,
// after a rebase or a release coming in (Ville, 21 Nov 2026: "Keep track of
// changes and only run the deltas").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error a plain .mjs script, no types
import { treeOf, stepKey, testKeys, passed } from '../../../scripts/check-cache.mjs';

const repo = path.resolve(import.meta.dirname, '../../..');

function tmp(name: string) {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `tb-check-cache-${name}-`));
}
function writer(root: string) {
  return (rel: string, text: string, mode?: number) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
    if (mode) fs.chmodSync(path.join(root, rel), mode);
  };
}
const git = (root: string, ...args: string[]) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test('a git checkout and a plain copy with the same files agree, dirty files included', () => {
  const a = tmp('git');
  const b = tmp('plain');
  try {
    for (const root of [a, b]) {
      const put = writer(root);
      put('runner/src/x.ts', 'export const x = 1;\n');
      put('docs/guide.md', '# guide\n');
    }
    git(a, 'init', '-q');
    git(a, 'add', '.');
    git(a, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'one');
    assert.deepEqual([...treeOf(a)].sort(), [...treeOf(b)].sort());
    // An edit not yet committed, and a new file, count as what they hold.
    for (const root of [a, b]) {
      writer(root)('runner/src/x.ts', 'export const x = 2;\n');
      writer(root)('runner/src/y.ts', 'export const y = 1;\n');
    }
    assert.deepEqual([...treeOf(a)].sort(), [...treeOf(b)].sort());
    assert.equal(treeOf(a).size, 3);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("a step's key changes with what it reads, its command, the check and Node, not with other files", () => {
  const tree = new Map([
    ['site/build.mjs', 'a1'], ['docs/guide.md', 'b1'], ['runner/src/x.ts', 'c1'], ['check.sh', 'd1'], ['README.md', 'e1'],
  ]);
  const key = (t: Map<string, string>, name = 'site build', args = ['node', 'scripts/build.mjs', '--check']) => stepKey(t, name, args);
  const base = key(tree);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(key(new Map([...tree, ['runner/src/x.ts', 'c2']])), base, 'the runner is nothing the site reads');
  assert.notEqual(key(new Map([...tree, ['docs/guide.md', 'b2']])), base);
  assert.notEqual(key(new Map([...tree, ['check.sh', 'd2']])), base);
  assert.notEqual(key(tree, 'site build', ['node', 'scripts/build.mjs']), base);
  // Where the checkout is doesn't matter.
  assert.equal(stepKey(tree, 'site build', ['/a/b/site/x'], { root: '/a/b' }), stepKey(tree, 'site build', ['/c/site/x'], { root: '/c' }));
  // The tool's version is part of it.
  assert.notEqual(stepKey(tree, 'desktop lint', ['cargo'], { tools: 'cargo 1.90' }), stepKey(tree, 'desktop lint', ['cargo'], { tools: 'cargo 1.91' }));
  // A step it doesn't know reads everything: skipped only when nothing changed.
  assert.notEqual(key(new Map([...tree, ['README.md', 'e2']]), 'brand new step'), key(tree, 'brand new step'));
  // Lint reads the files it's given, and the types of all the code they
  // might import (its type-aware rules), but no docs.
  const lint = (t: Map<string, string>) => stepKey(t, 'lint', ['npm', 'run', 'lint:files', '--', 'runner/src/x.ts']);
  assert.equal(lint(new Map([...tree, ['docs/guide.md', 'b2']])), lint(tree));
  assert.notEqual(lint(new Map([...tree, ['runner/src/x.ts', 'c2']])), lint(tree));
  assert.notEqual(lint(new Map([...tree, ['site/build.mjs', 'a2']])), lint(tree), 'code it could import');
  // The runner's typecheck follows its imports out of runner/ (convex/,
  // web/), so any code counts; docs don't.
  const tsc = (t: Map<string, string>) => stepKey(t, 'runner typecheck', ['npm', 'run', 'typecheck']);
  assert.notEqual(tsc(new Map([...tree, ['convex/push.ts', 'x']])), tsc(tree));
  assert.equal(tsc(new Map([...tree, ['docs/guide.md', 'b2']])), tsc(tree));
  // web's tests read shared/cases; the features' typecheck desktop/scripts'
  // own-folder.ts; the Swift app links to the iPhone kit's files.
  const web = (t: Map<string, string>) => stepKey(t, 'web tests', ['npm', 'run', 'web:test']);
  assert.notEqual(web(new Map([...tree, ['shared/cases/turns.json', 'x']])), web(tree));
  const features = (t: Map<string, string>) => stepKey(t, 'features typecheck', ['npm', 'run', 'typecheck']);
  assert.notEqual(features(new Map([...tree, ['desktop/scripts/own-folder.ts', 'x']])), features(tree));
  const app = (t: Map<string, string>) => stepKey(t, 'app build', ['swift', 'build']);
  assert.notEqual(app(new Map([...tree, ['ios/ThreadbearKit/Sources/ThreadbearKit/Wire.swift', 'x']])), app(tree));
  // The deploy tests aren't in the table: they read everything.
  const deploy = (t: Map<string, string>) => stepKey(t, 'runner deploy tests', ['bash', 'test/deploy/run.sh']);
  assert.notEqual(deploy(new Map([...tree, ['README.md', 'e2']])), deploy(tree));
  // Installs and end-to-end runs are never skipped.
  assert.equal(stepKey(tree, 'runner packages', ['npm', 'ci']), '');
  assert.equal(stepKey(tree, 'runner e2e', ['node']), '');
});

test("a test file's key follows its imports and the files it names, and the test helpers change them all", () => {
  const root = tmp('tests');
  try {
    const put = writer(root);
    put('runner/src/a.ts', "import { b } from './b.ts';\nexport const a = b;\n");
    put('runner/src/b.ts', 'export const b = 1;\n');
    // The app's code names docs to tell people about them; a test names
    // the ones it reads.
    put('runner/src/c.ts', "export const c = 'see docs/protocol.md';\n");
    put('runner/test/unit/a.test.ts', "import { a } from '../../src/a.ts';\n");
    put('runner/test/unit/c.test.ts', "import { c } from '../../src/c.ts';\nconst guide = path.join(ROOT, 'docs/guide.md');\n");
    put('runner/test/unit/s.test.ts', "const s = path.join(ROOT, 'scripts', 'go.sh');\n");
    put('scripts/go.sh', 'bash "$ROOT/scripts/inner.sh"\n');
    put('scripts/inner.sh', 'true\n');
    put('docs/guide.md', '# guide\n');
    put('docs/protocol.md', '# protocol\n');
    put('runner/test/helpers/clean-env.ts', '');
    put('check.sh', '');
    const files = ['test/unit/a.test.ts', 'test/unit/c.test.ts', 'test/unit/s.test.ts'];
    const keys = () => testKeys(root, treeOf(root), files) as Map<string, string>;
    const before = keys();
    const changed = (rel: string, text: string) => {
      const old = fs.readFileSync(path.join(root, rel), 'utf8');
      put(rel, text);
      const after = keys();
      put(rel, old);
      return files.filter((f) => after.get(f) !== before.get(f));
    };
    assert.deepEqual(changed('runner/src/b.ts', 'export const b = 2;\n'), ['test/unit/a.test.ts'], 'through an import of an import');
    assert.deepEqual(changed('docs/guide.md', '# new\n'), ['test/unit/c.test.ts'], 'a file the test names');
    assert.deepEqual(changed('docs/protocol.md', '# new\n'), [], 'a file only the code names');
    assert.deepEqual(changed('scripts/inner.sh', 'false\n'), ['test/unit/s.test.ts'], 'a script the script it runs runs');
    assert.deepEqual(changed('runner/test/helpers/clean-env.ts', '// x\n'), files);
    assert.deepEqual(changed('check.sh', '# x\n'), files);
    // Copied somewhere else, the keys are the same.
    const copy = tmp('copy');
    fs.cpSync(root, copy, { recursive: true });
    assert.deepEqual([...testKeys(copy, treeOf(copy), files)], [...before]);
    fs.rmSync(copy, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a type-only import isn't read: Node strips it before the test runs", () => {
  const root = tmp('types');
  try {
    const put = writer(root);
    put('runner/src/big.ts', 'export type Big = { a: number };\nexport const big = 1;\n');
    put('runner/src/t.ts', "import type { Big } from './big.ts';\nexport type { Big } from './big.ts';\nexport const t: Big | null = null;\n");
    // `import { type X }` still loads the file, so it counts.
    put('runner/src/v.ts', "import { type Big } from './big.ts';\nexport const v: Big | null = null;\n");
    put('runner/test/unit/t.test.ts', "import { t } from '../../src/t.ts';\n");
    put('runner/test/unit/v.test.ts', "import { v } from '../../src/v.ts';\n");
    const files = ['test/unit/t.test.ts', 'test/unit/v.test.ts'];
    const before = testKeys(root, treeOf(root), files) as Map<string, string>;
    put('runner/src/big.ts', 'export type Big = { a: string };\nexport const big = 2;\n');
    const after = testKeys(root, treeOf(root), files) as Map<string, string>;
    assert.equal(after.get('test/unit/t.test.ts'), before.get('test/unit/t.test.ts'));
    assert.notEqual(after.get('test/unit/v.test.ts'), before.get('test/unit/v.test.ts'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("in a fork, a test file that reads just what Mike's newest release has is skipped as passed there", () => {
  const root = tmp('release');
  const commit = (msg: string) => {
    git(root, 'add', '-A');
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', msg);
  };
  try {
    const put = writer(root);
    git(root, 'init', '-q');
    git(root, 'remote', 'add', 'origin', 'git@github.com:ville/threadbear.git');
    put('runner/src/mike.ts', 'export const mike = 1;\n');
    put('runner/src/shared.ts', 'export const shared = 1;\n');
    put('runner/test/unit/mike.test.ts', "import { mike } from '../../src/mike.ts';\n");
    put('runner/test/unit/shared.test.ts', "import { shared } from '../../src/shared.ts';\n");
    put('runner/test/helpers/clean-env.ts', '');
    put('check.sh', '');
    commit('release');
    git(root, 'update-ref', 'refs/threadbear/upstream/2026-11-21', 'HEAD');
    // The fork's own change to one file.
    put('runner/src/shared.ts', 'export const shared = 2;\n');
    commit('fork');
    const records = path.join(root, '.records');
    const files = ['test/unit/mike.test.ts', 'test/unit/shared.test.ts'];
    const tree = path.join(root, '.tree');
    const cli = (env: NodeJS.ProcessEnv = {}) => {
      const r = spawnSync(process.execPath, [path.join(repo, 'scripts/check-cache.mjs'), 'tests', tree, root, records, ...files],
        { cwd: path.join(root, 'runner'), encoding: 'utf8', env: { ...process.env, ...env } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim().split('\n').map((l) => l.split(' ').slice(0, 2).join(' ') + (l.includes("Mike's release 2026-11-21") ? ' (release)' : ''));
    };
    assert.equal(spawnSync(process.execPath, [path.join(repo, 'scripts/check-cache.mjs'), 'tree', root, tree]).status, 0);
    assert.deepEqual(cli(), ['skip test/unit/mike.test.ts (release)', 'run test/unit/shared.test.ts']);
    assert.deepEqual(cli({ THREADBEAR_CHECK_TRUST_RELEASE: 'off' }), ['run test/unit/mike.test.ts', 'run test/unit/shared.test.ts']);
    // Never in Mike's own copy, however origin is written, nor in a copy
    // with no origin (a check host's).
    for (const url of ['https://github.com/mikecann/threadbear.git', 'git@github.com:MikeCann/threadbear', 'ssh://git@github.com/mikecann/threadbear.git/']) {
      git(root, 'remote', 'set-url', 'origin', url);
      assert.deepEqual(cli(), ['run test/unit/mike.test.ts', 'run test/unit/shared.test.ts'], url);
    }
    git(root, 'remote', 'remove', 'origin');
    assert.deepEqual(cli(), ['run test/unit/mike.test.ts', 'run test/unit/shared.test.ts']);
    git(root, 'remote', 'add', 'origin', 'git@github.com:ville/threadbear.git');
    assert.deepEqual(cli(), ['skip test/unit/mike.test.ts (release)', 'run test/unit/shared.test.ts']);
    // A fork that changes the check or the helpers around every test file
    // runs them all: with the helpers broken, nothing would load them.
    put('runner/test/helpers/clean-env.ts', 'throw new Error("broken");\n');
    commit('fork helper');
    assert.equal(spawnSync(process.execPath, [path.join(repo, 'scripts/check-cache.mjs'), 'tree', root, tree]).status, 0);
    assert.deepEqual(cli(), ['run test/unit/mike.test.ts', 'run test/unit/shared.test.ts']);
    put('runner/test/helpers/clean-env.ts', '');
    commit('fork helper back');
    assert.equal(spawnSync(process.execPath, [path.join(repo, 'scripts/check-cache.mjs'), 'tree', root, tree]).status, 0);
    assert.deepEqual(cli(), ['skip test/unit/mike.test.ts (release)', 'run test/unit/shared.test.ts']);
    // And a release/ tag, which anyone can make, vouches for nothing.
    git(root, 'update-ref', '-d', 'refs/threadbear/upstream/2026-11-21');
    git(root, 'tag', 'release/2099-01-01');
    assert.deepEqual(cli(), ['run test/unit/mike.test.ts', 'run test/unit/shared.test.ts']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Misses found by running every runner test file under strace on Linux and
// comparing what each opened with its key (22 Nov 2026): each of these let
// a change skip a test that reads it.
test("a test file's key holds what the app's code reads at run time, and what a test reaches by a name it makes", () => {
  const root = tmp('reads');
  try {
    const put = writer(root);
    // The runner's experiments, read from the folder beside experiments.ts,
    // and the guide, read by a whole path; a child script started from
    // beside the code, and what it imports.
    put('runner/src/experiments.ts', "export const DIR = path.join(import.meta.dirname, 'experiments');\n");
    put('runner/src/experiments/a.md', 'a\n');
    put('runner/src/guide.ts', "export const guide = () => readFileSync(join(repo, 'docs', 'guide.md'));\n");
    put('docs/guide.md', '# guide\n');
    put('runner/src/patches.ts', "const CHILD = path.join(import.meta.dirname, 'patch-child.ts');\n");
    put('runner/src/patch-child.ts', "import { x } from './child-dep.ts';\n");
    put('runner/src/child-dep.ts', 'export const x = 1;\n');
    put('runner/test/unit/app.test.ts', "import '../../src/experiments.ts';\nimport '../../src/guide.ts';\nimport '../../src/patches.ts';\n");
    // Folders a test goes through by name, and the one it joins a made-up
    // name to.
    put('runner/test/unit/walk.test.ts', "for (const dir of ['convex', 'relay/convex']) readdirSync(join(root, dir));\nfor (const c of ['core']) walk(path.join(root, 'desktop', c));\n");
    put('convex/a.ts', '');
    put('relay/convex/b.ts', '');
    put('desktop/core/x.rs', '');
    // A script's loop over files named bare, beside it.
    put('runner/test/unit/guard.test.ts', "const LIB = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'lib.sh');\n");
    put('scripts/lib.sh', '# the comment names scripts/other.sh\ncat "$here/guard.sh"\nfor f in helper.pl; do :; done\n');
    put('scripts/guard.sh', '');
    put('scripts/helper.pl', '');
    put('scripts/other.sh', '');
    // Another test file named is read, not run; Node reads package.json
    // above each module for its type.
    put('runner/test/unit/names.test.ts', "const see = 'runner/test/unit/app.test.ts';\nimport '../../../relay/convex/b.ts';\n");
    put('relay/package.json', '{"type":"module"}\n');
    // A test that runs git in the checkout itself can read anything.
    put('runner/test/unit/grep.test.ts', "const REPO = path.resolve(import.meta.dirname, '..', '..', '..');\nspawnSync('git', ['grep', 'x'], { cwd: REPO });\n");
    put('site/far.txt', 'far\n');
    // Or hands the checkout to code that goes through it.
    put('runner/test/unit/hand.test.ts', "const ROOT = path.join(import.meta.dirname, '..', '..', '..');\nconst bad = pc.check(ROOT);\n");
    // A bundler resolves './_generated/server' to server.js, and reads the
    // tsconfig.json above.
    put('runner/test/unit/bundle.test.ts', "build({ entryPoints: [path.join(base, 'convex/http.ts')] });\n");
    put('convex/http.ts', "import { httpRouter } from './_generated/server';\n");
    put('convex/_generated/server.js', 'export {};\n');
    put('runner/test/helpers/clean-env.ts', '');
    put('check.sh', '');
    const files = ['test/unit/app.test.ts', 'test/unit/walk.test.ts', 'test/unit/guard.test.ts', 'test/unit/names.test.ts', 'test/unit/grep.test.ts', 'test/unit/hand.test.ts', 'test/unit/bundle.test.ts'];
    const keys = () => testKeys(root, treeOf(root), files) as Map<string, string>;
    const before = keys();
    const changed = (rel: string, text: string) => {
      const old = fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), 'utf8') : undefined;
      put(rel, text);
      const after = keys();
      if (old === undefined) fs.rmSync(path.join(root, rel)); else put(rel, old);
      return files.filter((f) => after.get(f) !== before.get(f));
    };
    // (Both of these read everything.)
    const grep = ['test/unit/grep.test.ts', 'test/unit/hand.test.ts'];
    assert.deepEqual(changed('runner/src/experiments/a.md', 'b\n'), ['test/unit/app.test.ts', ...grep], 'a folder beside the code');
    assert.deepEqual(changed('runner/src/experiments/new.md', 'n\n'), ['test/unit/app.test.ts', ...grep], 'a new file in it');
    assert.deepEqual(changed('docs/guide.md', '# new\n'), ['test/unit/app.test.ts', ...grep], 'a path the code joins');
    assert.deepEqual(changed('runner/src/child-dep.ts', 'export const x = 2;\n'), ['test/unit/app.test.ts', ...grep], "a script it starts, and that script's imports");
    assert.deepEqual(changed('relay/convex/b.ts', 'x\n'), ['test/unit/walk.test.ts', 'test/unit/names.test.ts', ...grep], 'a folder named in a list');
    assert.deepEqual(changed('convex/c.ts', 'x\n'), ['test/unit/walk.test.ts', ...grep], 'a new file in a folder named bare in a list');
    assert.deepEqual(changed('desktop/core/y.rs', 'x\n'), ['test/unit/walk.test.ts', ...grep], 'the folder a made-up name is joined to');
    assert.deepEqual(changed('scripts/guard.sh', 'x\n'), ['test/unit/guard.test.ts', ...grep], "a file a script reads from beside it");
    assert.deepEqual(changed('scripts/helper.pl', 'x\n'), ['test/unit/guard.test.ts', ...grep], "a bare name in a script's loop");
    assert.deepEqual(changed('scripts/other.sh', 'x\n'), grep, "a script's comment runs nothing");
    assert.deepEqual(changed('runner/src/patches.ts', "const CHILD = path.join(import.meta.dirname, 'patch-child.ts');\n// x\n"), ['test/unit/app.test.ts', ...grep]);
    assert.deepEqual(changed('relay/package.json', '{}\n'), ['test/unit/walk.test.ts', 'test/unit/names.test.ts', ...grep], 'a module\'s package.json');
    assert.deepEqual(changed('relay/convex/package.json', '{}\n'), ['test/unit/walk.test.ts', 'test/unit/names.test.ts', ...grep], 'one appearing nearer (and a new file in a folder walk lists)');
    assert.deepEqual(changed('site/far.txt', 'x\n'), grep, 'anything, for a test that runs git in the checkout');
    // The other test file it names is read, not followed: what it imports
    // isn't this one's.
    assert.ok(!changed('runner/src/child-dep.ts', 'export const x = 3;\n').includes('test/unit/names.test.ts'));
    assert.deepEqual(changed('.gitattributes', '* text\n'), files, "git's settings, for every test");
    assert.deepEqual(changed('convex/_generated/server.js', 'export const x = 1;\n'), ['test/unit/walk.test.ts', ...grep, 'test/unit/bundle.test.ts'], 'what a bundled file imports (in a folder walk lists)');
    assert.deepEqual(changed('convex/tsconfig.json', '{}\n'), ['test/unit/walk.test.ts', ...grep, 'test/unit/bundle.test.ts'], 'the tsconfig.json above it');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// From the cross-lab reviews of 22 Nov 2026.
test("a file's mode counts, a script the app starts is followed, and so is a path after a braced variable", () => {
  const root = tmp('modes');
  try {
    const put = writer(root);
    put('runner/test/unit/run.test.ts', "spawnSync(path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'go.sh'));\n");
    put('scripts/go.sh', 'echo\n', 0o755);
    put('runner/src/update.ts', "export const deploy = (dir: string) => spawn(process.execPath, [path.join(dir, 'scripts', 'deploy.mjs')]);\n");
    put('runner/scripts/deploy.mjs', "import './deploy-steps.mjs';\n");
    put('runner/scripts/deploy-steps.mjs', 'export {};\n');
    put('runner/test/unit/update.test.ts', "import { deploy } from '../../src/update.ts';\n");
    put('runner/test/unit/braced.test.ts', 'const s = `bash "${ROOT}/scripts/inner.sh"`;\n');
    put('scripts/inner.sh', 'true\n');
    const files = ['test/unit/run.test.ts', 'test/unit/update.test.ts', 'test/unit/braced.test.ts'];
    const before = testKeys(root, treeOf(root), files) as Map<string, string>;
    const changedBy = (fn: () => void, undo: () => void) => {
      fn();
      const after = testKeys(root, treeOf(root), files) as Map<string, string>;
      undo();
      return files.filter((f) => after.get(f) !== before.get(f));
    };
    const go = path.join(root, 'scripts/go.sh');
    assert.deepEqual(changedBy(() => fs.chmodSync(go, 0o644), () => fs.chmodSync(go, 0o755)), ['test/unit/run.test.ts'], 'a script no longer executable');
    const steps = path.join(root, 'runner/scripts/deploy-steps.mjs');
    assert.deepEqual(changedBy(() => fs.writeFileSync(steps, 'x\n'), () => fs.writeFileSync(steps, 'export {};\n')), ['test/unit/update.test.ts'], "what the script the app starts imports");
    const inner = path.join(root, 'scripts/inner.sh');
    assert.deepEqual(changedBy(() => fs.writeFileSync(inner, 'false\n'), () => fs.writeFileSync(inner, 'true\n')), ['test/unit/braced.test.ts']);
    // A link and a plain file holding its target differ.
    fs.symlinkSync('go.sh', path.join(root, 'scripts/link'));
    const linked = treeOf(root).get('scripts/link');
    fs.rmSync(path.join(root, 'scripts/link'));
    fs.writeFileSync(path.join(root, 'scripts/link'), 'go.sh');
    assert.notEqual(treeOf(root).get('scripts/link'), linked);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a record counts for a week', () => {
  const dir = tmp('records');
  try {
    fs.mkdirSync(path.join(dir, 'tests'));
    fs.writeFileSync(path.join(dir, 'tests', 'k'), '21 Nov 17:00 on thread/x\n');
    assert.equal(passed(dir, 'tests', 'k'), '21 Nov 17:00 on thread/x');
    assert.equal(passed(dir, 'tests', 'k', Date.now() + 8 * 86_400_000), undefined);
    assert.equal(passed(dir, 'tests', 'none'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The real check.sh in a throwaway checkout whose steps are stand-ins, as
// check-only.test.ts does it.
const PASSES = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const FAILS = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => assert.equal(1, 2));\n";

// Its HOME and temp folder are a folder of their own, beside the checkout,
// and every tool a step asks for its version has a stand-in (bin/). From 22
// Nov 2026 HOME was the checkout itself and rustc the real one: on GitHub's
// Macs that's Homebrew's rustup, which, asked its version with a HOME it had
// never seen, installed a whole toolchain into it (17 s). A checkout with no
// .git is hashed file by file, before the run and after every step, so each
// of this file's 19 runs of check.sh then hashed that toolchain 3 to 15
// times, 15 to 35 s a time: 17 minutes for this one file, where Linux took
// 21 s. runner.yml's Mac jobs went from 17 to 20 minutes to over their 30,
// 18 runs in a row, and GitHub called each cancelled, not failed.
function checkout() {
  const root = tmp('run');
  const home = tmp('home');
  const put = writer(root);
  const copy = (rel: string, mode?: number) => put(rel, fs.readFileSync(path.join(repo, rel), 'utf8'), mode);
  copy('check.sh', 0o755);
  copy('scripts/swift-freeze.sh', 0o755);
  copy('scripts/check-cache.mjs');
  copy('runner/scripts/find-node.sh');
  copy('scripts/limit-step.mjs');
  copy('runner/test/helpers/failed-files-reporter.mjs');
  copy('runner/test/helpers/passed-files-reporter.mjs');
  copy('runner/test/helpers/progress-reporter.mjs');
  copy('runner/test/helpers/run-test-files.mjs');
  put('runner/package.json', JSON.stringify({ scripts: { typecheck: 'true' } }));
  put('runner/node_modules/.package-lock.json', '{}');
  put('runner/test/helpers/clean-env.ts', '');
  put('runner/src/one.ts', 'export const one = 1;\n');
  put('runner/test/unit/one.test.ts', `import '../../src/one.ts';\n${PASSES}`);
  put('runner/test/unit/two.test.ts', PASSES);
  put('package.json', JSON.stringify({ scripts: { 'convex:typecheck': 'true', 'web:typecheck': 'true', 'web:test': 'true', lint: 'true', 'lint:files': 'true' } }));
  put('node_modules/.package-lock.json', '{}');
  put('app/Tools/ok.mjs', '');
  put('mock-runner/ok.mjs', '');
  put('mock-runner/node_modules/.package-lock.json', '{}');
  put('desktop/.keep', '');
  put('bin/swift', '#!/bin/bash\n', 0o755);
  // rustc beside cargo, where its version is asked before the PATH's
  // (toolVersion). Each writes down how it was asked its version for a key.
  put('bin/cargo', '#!/bin/bash\n[ "$*" != "--version --verbose" ] || echo "cargo ${RUSTUP_AUTO_INSTALL:-may install}" >>"$HOME/versions-asked"\n', 0o755);
  put('bin/rustc', '#!/bin/bash\necho "rustc ${RUSTUP_AUTO_INSTALL:-may install}" >>"$HOME/versions-asked"\n', 0o755);
  const records = process.platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'Threadbear', 'check-passes') : path.join(home, '.cache', 'threadbear', 'check-passes');
  const remove = () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  };
  return { root, home, put, records, remove };
}

function run(c: { root: string, home: string }, flags: string[] = ['--quick'], extra: NodeJS.ProcessEnv = {}) {
  const list = path.join(c.root, '.changed');
  fs.writeFileSync(list, 'runner/src/one.ts\n');
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${path.join(c.root, 'bin')}:${process.env.PATH}`,
    THREADBEAR_CHECK_CHANGED_FILE: list, THREADBEAR_NODE: process.execPath, TMPDIR: c.home, HOME: c.home,
    XDG_CACHE_HOME: path.join(c.home, '.cache'),
  };
  delete env.GITHUB_ACTIONS;
  for (const k of Object.keys(env)) if (/^THREAD(BEAR|BARE)_(CHECK_|HOME$)/.test(k) && k !== 'THREADBEAR_CHECK_CHANGED_FILE') delete env[k];
  delete env.NODE_TEST_CONTEXT;
  // As a thread's tb land runs it: THREADBEAR_HOME is the real one (this
  // test's HOME's), so the records go in the real folder.
  env.THREADBEAR_HOME = path.join(c.home, 'Library', 'Application Support', 'Threadbear');
  Object.assign(env, extra);
  const r = spawnSync('bash', [path.join(c.root, 'check.sh'), ...flags, '--local'], { env, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const line = (out: string, name: string) => out.split('\n').find((l) => new RegExp(`^(ok|FAIL|skip)\\s+${name}\\b`).test(l)) ?? '';

test('check.sh skips what passed with the same inputs, says so, and runs what changed', () => {
  const c = checkout();
  try {
    const first = run(c);
    assert.equal(first.status, 0, first.out);
    assert.match(line(first.out, 'web tests'), /^ok/, first.out);
    assert.match(line(first.out, 'runner unit tests'), /^ok/, first.out);

    assert.equal(fs.readdirSync(path.join(c.records, 'tests')).length, 2, 'both test files recorded');
    // No real tool ran with the made-up HOME and left its own files there
    // (rustup's toolchains), and what's hashed as the checkout is still the
    // few files put there, not what a run writes to its HOME or temp folder
    // (npm's logs and cache, node's compile cache, check.sh's own logs).
    assert.deepEqual(fs.readdirSync(c.home).filter((n) => /^\.(rustup|cargo)$/.test(n)), []);
    // And a real rustup asked a version for a key is told to install nothing.
    assert.deepEqual([...new Set(fs.readFileSync(path.join(c.home, 'versions-asked'), 'utf8').trim().split('\n'))].sort(), ['cargo 0', 'rustc 0']);
    assert.ok(treeOf(c.root).size < 40, [...treeOf(c.root).keys()].join('\n'));
    const again = run(c);
    assert.equal(again.status, 0, again.out);
    // (When; a check host's copy is always on main, so it says no branch.)
    assert.match(line(again.out, 'web tests'), /^ok\s+web tests\s+0s  \(skipped: passed with the same inputs \d\d \w+ \d\d:\d\d\)$/, again.out);
    assert.match(line(again.out, 'runner unit tests'), /^ok .*\(skipped: all 2 test files passed/, again.out);

    // One test's import changes: just that file runs, and the line says so.
    c.put('runner/src/one.ts', 'export const one = 2;\n');
    const one = run(c);
    assert.equal(one.status, 0, one.out);
    assert.match(line(one.out, 'runner unit tests'), /^ok .*skipped 1 test files/, one.out);
    assert.match(one.out, /ran: test\/unit\/one\.test\.ts$/m, one.out);
    assert.match(line(one.out, 'web tests'), /skipped: passed/, 'nothing web reads changed');

    // A failing file: the others still count, and the next run is just it.
    c.put('runner/test/unit/bad.test.ts', FAILS);
    const bad = run(c);
    assert.equal(bad.status, 1, bad.out);
    c.put('runner/test/unit/bad.test.ts', PASSES);
    const fixed = run(c);
    assert.equal(fixed.status, 0, fixed.out);
    assert.match(fixed.out, /ran: test\/unit\/bad\.test\.ts$/m, fixed.out);

    // A file with a test that skipped itself isn't recorded (why it
    // skipped isn't in its key), nor is one that changed a file it reads
    // while it ran: it passed on the new files, not the ones it was keyed on.
    c.put('runner/test/unit/skips.test.ts', "import { test } from 'node:test';\ntest('ok', () => {});\ntest('later', { skip: 'no esbuild' }, () => {});\n");
    c.put('runner/test/unit/writes.test.ts', `import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('rewrites', () => fs.writeFileSync(${JSON.stringify(path.join(c.root, 'runner/src/one.ts'))}, 'export const one = 3;\\n'));\nimport '../../src/one.ts';\n`);
    const odd = run(c);
    assert.equal(odd.status, 0, odd.out);
    c.put('runner/src/one.ts', 'export const one = 2;\n');
    const again2 = run(c);
    assert.match(again2.out, /ran: .*test\/unit\/skips\.test\.ts/, again2.out);
    assert.match(again2.out, /ran: .*test\/unit\/writes\.test\.ts/, again2.out);
    fs.rmSync(path.join(c.root, 'runner/test/unit/skips.test.ts'));
    fs.rmSync(path.join(c.root, 'runner/test/unit/writes.test.ts'));
    c.put('runner/src/one.ts', 'export const one = 2;\n');

    // A file that passes on the second run is recorded, unless a test of it
    // skipped itself there.
    const flaky = (name: string, skip: boolean) => `import { test } from 'node:test';\nimport fs from 'node:fs';\nconst mark = ${JSON.stringify(path.join(c.root, `${name}.mark`))};\ntest('flaky', () => { if (!fs.existsSync(mark)) { fs.writeFileSync(mark, ''); throw new Error('first'); } });\n${skip ? "test('later', { skip: 'no esbuild' }, () => {});\n" : ''}`;
    c.put('runner/test/unit/flaky.test.ts', flaky('flaky', false));
    c.put('runner/test/unit/flaky-skip.test.ts', flaky('flaky-skip', true));
    const retried = run(c);
    assert.equal(retried.status, 0, retried.out);
    assert.match(retried.out, /passed on a second run/, retried.out);
    const after = run(c);
    assert.doesNotMatch(after.out, /ran: .*test\/unit\/flaky\.test\.ts/, after.out);
    assert.match(after.out, /ran: .*test\/unit\/flaky-skip\.test\.ts/, after.out);
    fs.rmSync(path.join(c.root, 'runner/test/unit/flaky.test.ts'));
    fs.rmSync(path.join(c.root, 'runner/test/unit/flaky-skip.test.ts'));

    // --all runs everything (and the steps this stand-in checkout can't
    // pass, which nothing else asks for).
    const all = run(c, ['--quick', '--all']);
    assert.match(line(all.out, 'web tests'), /^ok\s+web tests\s+\d+s$/, all.out);
    assert.match(line(all.out, 'runner unit tests'), /^ok/, all.out);
    assert.doesNotMatch(all.out, /skipped \d+ test files/);

    // --fresh (tb land --full) runs everything again without --all's extra
    // steps, the same through THREADBEAR_CHECK_FRESH, and still records.
    for (const fresh of [run(c, ['--quick', '--fresh']), run(c, ['--quick'], { THREADBEAR_CHECK_FRESH: '1' })]) {
      assert.equal(fresh.status, 0, fresh.out);
      assert.match(line(fresh.out, 'web tests'), /^ok\s+web tests\s+\d+s$/, fresh.out);
      assert.doesNotMatch(fresh.out, /skipped/, fresh.out);
    }
    assert.match(line(run(c).out, 'web tests'), /skipped: passed/);

    // A change to the check itself runs everything again.
    fs.appendFileSync(path.join(c.root, 'check.sh'), '\n');
    const changed = run(c);
    assert.match(line(changed.out, 'web tests'), /^ok\s+web tests\s+\d+s$/, changed.out);
    assert.match(line(changed.out, 'runner unit tests'), /^ok/, changed.out);
    assert.doesNotMatch(changed.out, /skipped \d+ test files/);
  } finally {
    c.remove();
  }
});

test("GitHub's runs read no records, and no test file inherits the records folder a check names", () => {
  const c = checkout();
  try {
    const seen = path.join(c.home, 'seen');
    c.put('runner/test/unit/env.test.ts', `import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('env', () => fs.appendFileSync(${JSON.stringify(seen)}, (process.env.THREADBEAR_CHECK_PASSES ?? 'unset') + '\\n'));\n`);
    const named = path.join(c.home, 'named-records');
    const first = run(c, ['--quick'], { THREADBEAR_CHECK_PASSES: named });
    assert.equal(first.status, 0, first.out);
    assert.deepEqual(fs.readFileSync(seen, 'utf8').trim().split('\n'), ['unset']);
    assert.ok(fs.readdirSync(path.join(named, 'tests')).length >= 3, 'recorded in the folder named');
    assert.ok(!fs.existsSync(c.records), 'and not the usual one');
    assert.match(line(run(c, ['--quick'], { THREADBEAR_CHECK_PASSES: named }).out, 'runner unit tests'), /skipped: all/);
    // On GitHub everything runs, whatever the folder holds.
    const gh = run(c, ['--quick'], { THREADBEAR_CHECK_PASSES: named, GITHUB_ACTIONS: 'true' });
    assert.equal(gh.status, 0, gh.out);
    assert.doesNotMatch(gh.out, /skipped:/, gh.out);
    // And there the unit tests say where they are as they go, into the
    // job's log (progress-reporter.mjs): here, the slowest files at the end.
    assert.match(gh.out, /^ {8}slowest test files: .*\bone\.test\.ts \d+s.*\nok +runner unit tests/m, gh.out);
    assert.doesNotMatch(first.out, /slowest test files/, first.out);
    // A run with a data dir of its own (a test's) keeps none.
    const own = run(c, ['--quick'], { THREADBEAR_HOME: path.join(c.home, 'other-home') });
    assert.doesNotMatch(own.out, /skipped:/, own.out);
    assert.ok(!fs.existsSync(c.records));
  } finally {
    c.remove();
  }
});

// Hetzner Cloud's release lives under "Application Support": the script
// compared import.meta.url (%20) with a bare file:// path, never ran its main,
// and printed nothing (couldn't update to 27ea98efe, 22 Nov 2026).
test('the script runs from a folder with a space in its name', () => {
  const root = tmp('space');
  try {
    const dir = path.join(root, 'Application Support');
    fs.mkdirSync(dir);
    fs.copyFileSync(path.join(repo, 'scripts/check-cache.mjs'), path.join(dir, 'check-cache.mjs'));
    const r = spawnSync(process.execPath, [path.join(dir, 'check-cache.mjs')], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /usage: check-cache\.mjs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
