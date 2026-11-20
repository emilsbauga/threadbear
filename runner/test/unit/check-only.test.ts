// check.sh --only: just the named steps (and for the runner's unit tests,
// the named files), and a failed run ending with the --only that runs what
// failed again. tb land reads that line off a group's failed check and runs
// it on each of the group's landings alone, to find the one that broke it
// rather than halve the group one whole check at a time (worktrees.ts,
// findBroken; docs/thread-worktrees.md, "Finding who broke a group").
//
// The real check.sh in a throwaway checkout whose steps are stand-ins, as
// check-mock-swift-tests.test.ts does it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { onlyFailed, onlyRan } from '../../src/worktrees.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PASSES = "import { test } from 'node:test';\ntest('ok', () => {});\n";
const FAILS = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('broken', () => assert.equal(1, 2));\n";

function checkout(webTest = 'true') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tb-check-only-'));
  const put = (rel: string, text: string, mode?: number) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
    if (mode) fs.chmodSync(path.join(root, rel), mode);
  };
  const copy = (rel: string, mode?: number) => put(rel, fs.readFileSync(path.join(repo, rel), 'utf8'), mode);
  copy('check.sh', 0o755);
  copy('scripts/swift-freeze.sh', 0o755);
  copy('runner/scripts/find-node.sh');
  copy('scripts/limit-step.mjs');
  copy('runner/test/helpers/failed-files-reporter.mjs');
  put('runner/package.json', JSON.stringify({ scripts: { typecheck: 'true' } }));
  put('runner/node_modules/.keep', '');
  put('runner/test/helpers/clean-env.ts', '');
  put('runner/test/unit/ok.test.ts', PASSES);
  put('package.json', JSON.stringify({ scripts: { 'convex:typecheck': 'true', 'web:typecheck': 'true', 'web:test': webTest, lint: 'true', 'lint:files': 'true' } }));
  put('node_modules/.keep', '');
  put('app/Tools/ok.mjs', '');
  put('app/Tools/mock-runner/ok.mjs', '');
  put('app/Tools/mock-runner/node_modules/.keep', '');
  put('desktop/.keep', '');
  // swift and cargo that pass at once.
  put('bin/swift', '#!/bin/bash\n', 0o755);
  put('bin/cargo', '#!/bin/bash\n', 0o755);
  return { root, put };
}

// `typed` is a command line run by a shell from the checkout's top, as
// someone would type it, with `flags` after it.
function run(root: string, flags: string[], extra: NodeJS.ProcessEnv = {}, local = true, typed?: string) {
  const list = path.join(root, '.changed');
  fs.writeFileSync(list, 'runner/src/x.ts\n');
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
    THREADBEAR_CHECK_CHANGED_FILE: list, THREADBEAR_NODE: process.execPath, TMPDIR: root, HOME: root,
  };
  for (const k of Object.keys(env)) if (/^THREAD(BEAR|BARE)_(CHECK_|HOME$)/.test(k) && k !== 'THREADBEAR_CHECK_CHANGED_FILE') delete env[k];
  // This file is a test itself: a node --test started under it would report
  // to it as a subtest and exit 0 whatever failed.
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, extra);
  const all = [...flags, ...(local ? ['--local'] : [])];
  const r = typed
    ? spawnSync('/bin/sh', ['-c', `${typed} ${all.join(' ')}`], { cwd: root, env, encoding: 'utf8', timeout: 120_000 })
    : spawnSync('bash', [path.join(root, 'check.sh'), ...all], { env, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const step = (out: string, name: string): string | undefined => out.split('\n').find((l) => new RegExp(`^(ok|FAIL|skip)\\s+${name}\\b`).test(l));

test('--only runs the steps it names and says the rest were left out', () => {
  const c = checkout();
  try {
    const r = run(c.root, ['--quick', '--only', 'web tests']);
    assert.equal(r.status, 0, r.out);
    assert.match(step(r.out, 'web tests') ?? '', /^ok/, r.out);
    for (const name of ['runner typecheck', 'convex typecheck', 'web typecheck', 'runner unit tests']) {
      assert.match(step(r.out, name) ?? '', /^skip .*\(--only left it out\)$/, `${name}: ${r.out}`);
    }
    // And it ends by saying which of the steps asked for it ran: exit 0
    // alone doesn't tell passing a step from never getting to it. Here
    // nothing the site reads changed, so its build is skipped, asked for or not.
    assert.deepEqual([...(onlyRan(r.out) ?? [])], ['web tests']);
    const two = run(c.root, ['--quick', '--only', 'site build;web tests;no such step']);
    assert.equal(two.status, 0, two.out);
    assert.deepEqual([...(onlyRan(two.out) ?? [])], ['web tests']);
    // Without it, they all run.
    const all = run(c.root, ['--quick']);
    assert.equal(all.status, 0, all.out);
    for (const name of ['runner typecheck', 'web tests', 'runner unit tests']) assert.match(step(all.out, name) ?? '', /^ok/, all.out);
    assert.doesNotMatch(all.out, /--only/);
    assert.equal(onlyRan(all.out), undefined);
  } finally {
    fs.rmSync(c.root, { recursive: true, force: true });
  }
});

test('a failed run ends with the --only that runs what failed again, and that runs just those', () => {
  const c = checkout('false');
  try {
    c.put('runner/test/unit/bad.test.ts', FAILS);
    const r = run(c.root, ['--quick']);
    assert.equal(r.status, 1, r.out);
    const only = onlyFailed(r.out);
    assert.equal(only, 'web tests;runner unit tests=test/unit/bad.test.ts', r.out);
    // Asked for through the environment, as tb land does: the same two fail,
    // the passing test file isn't run, and it says the same thing again.
    const again = run(c.root, ['--quick'], { THREADBEAR_CHECK_ONLY: only });
    assert.equal(again.status, 1, again.out);
    assert.match(step(again.out, 'web tests') ?? '', /^FAIL/, again.out);
    assert.match(step(again.out, 'runner unit tests') ?? '', /^FAIL/, again.out);
    assert.match(step(again.out, 'runner typecheck') ?? '', /^skip/, again.out);
    assert.equal(onlyFailed(again.out), only);
    assert.deepEqual([...(onlyRan(again.out) ?? [])], ['web tests', 'runner unit tests']);
    const logs = again.out.match(/^FAIL\s+runner unit tests.*?(\S+\.log)/m)?.[1];
    assert.ok(logs && !/ok\.test\.ts|✔ ok/.test(fs.readFileSync(logs, 'utf8')), 'only the named file ran');
    // The hint is a whole command, run as printed from the checkout's top.
    // It said just `--only "..."` beside tb land's "run tb land again", and
    // an agent ran tb land --only, which tb refuses (19 Nov).
    const said = r.out.match(/^To run only what failed again: (.+)$/m)?.[1];
    assert.ok(said?.startsWith('./check.sh --only '), r.out);
    const typed = run(c.root, ['--quick'], {}, true, said);
    assert.equal(typed.status, 1, typed.out);
    assert.deepEqual([...(onlyRan(typed.out) ?? [])], ['web tests', 'runner unit tests']);
  } finally {
    fs.rmSync(c.root, { recursive: true, force: true });
  }
});

test("a checkout that passes what failed elsewhere says so, including without a test file that isn't in it", () => {
  // Another landing's checkout: its web tests pass, and bad.test.ts is the
  // broken landing's new file, which this one doesn't have.
  const c = checkout();
  try {
    const only = 'web tests;runner unit tests=test/unit/bad.test.ts';
    const r = run(c.root, ['--quick', '--only', only]);
    assert.equal(r.status, 0, r.out);
    assert.match(step(r.out, 'web tests') ?? '', /^ok/, r.out);
    assert.match(step(r.out, 'runner unit tests') ?? '', /^skip .*none of the files --only names are in this checkout/, r.out);
    assert.equal(onlyFailed(r.out), undefined);
    // Files it doesn't have are files it can't fail: that counts as run.
    assert.deepEqual([...(onlyRan(r.out) ?? [])], ['web tests', 'runner unit tests']);
    // With one of the files there, that one runs.
    const some = run(c.root, ['--quick', '--only', 'runner unit tests=test/unit/bad.test.ts test/unit/ok.test.ts']);
    assert.equal(some.status, 0, some.out);
    assert.match(step(some.out, 'runner unit tests') ?? '', /^ok/, some.out);
  } finally {
    fs.rmSync(c.root, { recursive: true, force: true });
  }
});

test('--only takes step names and test files under test/unit, nothing a shell would read', () => {
  const c = checkout();
  try {
    for (const bad of ['x$(touch pwned)', 'a`touch pwned`', "a'b", 'a&b', '-x', 'a\\b', 'a"b', 'a\nb']) {
      const r = run(c.root, ['--quick', '--only', bad]);
      assert.equal(r.status, 2, `${bad}: ${r.out}`);
      assert.match(r.out, /--only takes step names/);
      assert.doesNotMatch(r.out, /^ok /m);
      const viaEnv = run(c.root, ['--quick'], { THREADBEAR_CHECK_ONLY: bad });
      assert.equal(viaEnv.status, 2, `${bad}: ${viaEnv.out}`);
    }
    assert.ok(!fs.existsSync(path.join(c.root, 'pwned')));
    // A file outside test/unit, or reached by .., isn't run: none are left.
    c.put('runner/outside.test.ts', FAILS);
    for (const files of ['outside.test.ts', 'test/unit/../../outside.test.ts', '/etc/passwd', 'test/unit/ok.test.js']) {
      const r = run(c.root, ['--quick', '--only', `runner unit tests=${files}`]);
      assert.equal(r.status, 0, `${files}: ${r.out}`);
      assert.match(step(r.out, 'runner unit tests') ?? '', /^skip .*none of the files/, `${files}: ${r.out}`);
    }
    const none = run(c.root, ['--quick', '--only']);
    assert.equal(none.status, 2, none.out);
  } finally {
    fs.rmSync(c.root, { recursive: true, force: true });
  }
});

test('a run that is for a check host or nowhere never runs on this Mac', () => {
  const c = checkout();
  try {
    // No host set.
    const noHost = run(c.root, ['--quick', '--only', 'web tests'], { THREADBEAR_CHECK_HOST: '', THREADBEAR_CHECK_HOST_ONLY: '1' }, false);
    assert.equal(noHost.status, 4, noHost.out);
    assert.match(noHost.out, /No check host is set, and this run was only for one\./);
    assert.doesNotMatch(noHost.out, /^(ok|skip|FAIL) /m);
    assert.equal(onlyFailed(noHost.out), undefined);
    // A host that can't be reached (check-remote.sh's 255), which would
    // otherwise send the run here.
    c.put('scripts/check-remote.sh', '#!/bin/bash\necho "remote got: $*"\nexit 255\n', 0o755);
    const dropped = run(c.root, ['--quick', '--only', 'web tests'], { THREADBEAR_CHECK_HOST: 'nowhere', THREADBEAR_CHECK_HOST_ONLY: '1' }, false);
    assert.equal(dropped.status, 4, dropped.out);
    assert.match(dropped.out, /remote got: nowhere --quick --only web tests/);
    assert.match(dropped.out, /No check host could take it, and this run was only for one\./);
    assert.doesNotMatch(dropped.out, /So the checks run on this Mac instead|^(ok|skip|FAIL) /m);
    // Nor when the check command itself says to run here.
    const local = run(c.root, ['--quick', '--only', 'web tests'], { THREADBEAR_CHECK_HOST_ONLY: '1' });
    assert.equal(local.status, 4, local.out);
    assert.match(local.out, /this run was only for a check host/);
    assert.doesNotMatch(local.out, /^(ok|skip|FAIL) /m);
    // Without it, as ever: the run comes here.
    const here = run(c.root, ['--quick', '--only', 'web tests'], { THREADBEAR_CHECK_HOST: 'nowhere', THREADBEAR_JOB_PRIORITY: 'normal' }, false);
    assert.equal(here.status, 0, here.out);
    assert.match(here.out, /So the checks run on this Mac instead/);
    assert.match(step(here.out, 'web tests') ?? '', /^ok/, here.out);
  } finally {
    fs.rmSync(c.root, { recursive: true, force: true });
  }
});
