// scripts/own-folders.sh: the folders desktop/scripts/remote.sh writes helpers
// into on a build host, and then runs, must be ones no other account can
// change. A link is let through only to a folder of this account's own under
// folders only root or this account can change (cloud's cache moved to a
// volume on 24 Nov 2026, and the guard that refused every link stopped every
// build there). Tried for real on cloud when written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { closedTmpParent } from '../helpers/closed-tmp.ts';
import { testSkippedOnWindows } from '../helpers/platform.ts';

const test = testSkippedOnWindows('The build-host folder guard uses /bin/bash and POSIX ownership and permissions on macOS and Linux');

const SCRIPT = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'own-folders.sh');

function run(cwd: string, ...folders: string[]) {
  return spawnSync('/bin/bash', [SCRIPT, 'testhost', ...folders], { cwd, encoding: 'utf8' });
}

// A temp folder of our own, under folders closed to others, as the script
// asks of the one it starts in.
function tmp(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(closedTmpParent(), '.tb-own-folders-'));
  t.after(() => {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Its real path: links must lead straight to one (/var is a link on a Mac).
  return fs.realpathSync(dir);
}

test('folders of our own pass and lose group and other write', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true, mode: 0o777 });
  fs.chmodSync(path.join(dir, 'a'), 0o775);
  const r = run(dir, 'a', 'a/b');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(path.join(dir, 'a')).mode & 0o777, 0o755);
});

test('a link to a folder of our own, under folders only root or we can change, passes', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'home'));
  fs.mkdirSync(path.join(dir, 'volume/check/gpui'), { recursive: true });
  fs.chmodSync(path.join(dir, 'volume/check'), 0o775);
  fs.symlinkSync(path.join(dir, 'volume/check'), path.join(dir, 'home/check'));
  const r = run(path.join(dir, 'home'), 'check', 'check/gpui');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(path.join(dir, 'volume/check')).mode & 0o777, 0o755);
});

test('a link to a folder under one others can write in is refused', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'open/check'), { recursive: true });
  fs.chmodSync(path.join(dir, 'open'), 0o777);
  fs.symlinkSync(path.join(dir, 'open/check'), path.join(dir, 'check'));
  const r = run(dir, 'check');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /~\/check on testhost isn't a folder of this account's own: .*open above it/);
});

test('a link to a folder of another account, a link to nothing, and a file are refused', (t) => {
  const dir = tmp(t);
  fs.symlinkSync('/usr', path.join(dir, 'theirs'));
  fs.symlinkSync(path.join(dir, 'nothing'), path.join(dir, 'dangling'));
  fs.writeFileSync(path.join(dir, 'file'), '');
  for (const name of ['theirs', 'dangling', 'file']) {
    const r = run(dir, name);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, new RegExp(`~/${name} on testhost isn't a folder of this account's own`));
  }
});

test('a later folder is not checked once an earlier one is refused', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'ok'), { mode: 0o777 });
  fs.chmodSync(path.join(dir, 'ok'), 0o777);
  const r = run(dir, 'missing', 'ok');
  assert.equal(r.status, 1);
  assert.equal(fs.statSync(path.join(dir, 'ok')).mode & 0o777, 0o777);
});

test('a link through another link, or with .. in it, is refused', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'real/check'), { recursive: true });
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'hop'));
  fs.symlinkSync(path.join(dir, 'hop/check'), path.join(dir, 'via-hop'));
  fs.symlinkSync(`${dir}/real/check/../check`, path.join(dir, 'dotdot'));
  fs.symlinkSync('real/check', path.join(dir, 'relative'));
  for (const name of ['via-hop', 'dotdot', 'relative']) {
    const r = run(dir, name);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, /not straight to a folder's real path/, name);
  }
});

test('a link to a folder whose name ends in a newline is refused', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'check\n'));
  fs.symlinkSync(path.join(dir, 'check\n'), path.join(dir, 'link'));
  const r = run(dir, 'link');
  assert.equal(r.status, 1, r.stderr);
});

test('nothing passes from a folder others can write in', (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'open/a'), { recursive: true });
  fs.chmodSync(path.join(dir, 'open'), 0o777);
  const r = run(path.join(dir, 'open'), 'a');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /~\/\. on testhost/);
});

test('on a Mac, a folder with an ACL that lets another account in is refused', { skip: process.platform !== 'darwin' }, (t) => {
  const dir = tmp(t);
  fs.mkdirSync(path.join(dir, 'a'));
  const acl = spawnSync('/bin/chmod', ['+a', 'everyone allow add_file,add_subdirectory,delete_child', path.join(dir, 'a')], { encoding: 'utf8' });
  assert.equal(acl.status, 0, acl.stderr);
  const r = run(dir, 'a');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ACL/);
});

test('on a Mac, a folder whose ACL we may not read is refused', { skip: process.platform !== 'darwin' }, (t) => {
  const dir = tmp(t);
  const a = path.join(dir, 'a');
  fs.mkdirSync(a);
  const acl = spawnSync('/bin/chmod', ['+a', `${os.userInfo().username} deny readsecurity`, a], { encoding: 'utf8' });
  assert.equal(acl.status, 0, acl.stderr);
  t.after(() => spawnSync('/bin/chmod', ['-N', a]));
  const r = run(dir, 'a');
  // Refused either way: chmod can't change it, or the ACL can't be read.
  assert.equal(r.status, 1);
  assert.match(r.stderr, /~\/a on testhost isn't a folder of this account's own/);
});
