// The secrets folder's access list on Windows (src/win-acl.ts, and
// privateDir in src/win32-helper.ps1). The last two tests run it for real on
// Windows, through the runner's own helper.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makePrivate } from '../../src/win-acl.ts';
import { win32Helper } from '../../src/win32-helper.ts';

const windows = process.platform === 'win32';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-acl-'));
after(() => {
  if (windows) win32Helper().stop();
  fs.rmSync(root, { recursive: true, force: true });
});

test('off Windows it does nothing', async () => {
  const asked: string[] = [];
  assert.equal(await makePrivate(path.join(root, 'mac'), { platform: 'darwin', ask: async (op) => (asked.push(op), '') }), undefined);
  assert.deepEqual(asked, []);
  assert.equal(fs.existsSync(path.join(root, 'mac')), false);
});

test('on Windows it makes the folder, asks the helper, and says why when that fails', async () => {
  const asked: [string, Record<string, string>][] = [];
  const dir = path.join(root, 'stub', 'secrets');
  assert.equal(await makePrivate(dir, { platform: 'win32', ask: async (op, p) => (asked.push([op, p]), 'S-1-5-21-1-2-3-1001') }), undefined);
  assert.deepEqual(asked, [['privateDir', { path: dir }]]);
  assert.ok(fs.existsSync(dir));
  const why = await makePrivate(dir, { platform: 'win32', ask: async () => { throw new Error('the helper said: C:\\x still lets S-1-1-0 in'); } });
  assert.match(why ?? '', /still lets S-1-1-0 in/);
});

const icacls = (...args: string[]) => execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), args, { encoding: 'utf8', windowsHide: true });
// The entries icacls lists for a path, one a line ("NAME:(OI)(CI)(F)").
const entries = (p: string) => icacls(p).split(/\r?\n/).map((l) => l.replace(p, '').trim()).filter((l) => /:\(/.test(l));

test('for real: grants made before are gone, from the folder and what was in it', { skip: !windows && 'Windows only' }, async () => {
  const secrets = path.join(root, 'real', 'secrets');
  fs.mkdirSync(secrets, { recursive: true });
  const key = path.join(secrets, 'key');
  fs.writeFileSync(key, 'k');
  const me = /"(S-1-[\d-]+)"/.exec(execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }))![1]!;
  // Everyone may read the folder, and the file has a list of its own that
  // inherits nothing, with Everyone on it too (Codex's review, 18 Nov 2026).
  icacls(secrets, '/grant', '*S-1-1-0:(OI)(CI)R');
  icacls(key, '/inheritance:r', '/grant', `*${me}:F`, '/grant', '*S-1-1-0:R');
  assert.ok(entries(key).some((l) => /^Everyone:/i.test(l)), entries(key).join(' | '));

  assert.equal(await makePrivate(secrets), undefined);
  fs.writeFileSync(path.join(secrets, 'new'), 'n');
  for (const p of [secrets, key, path.join(secrets, 'new')]) {
    const list = entries(p);
    assert.equal(list.length, 2, `${p}: ${list.join(' | ')}`);
    assert.ok(list.some((l) => /^NT AUTHORITY\\SYSTEM:/i.test(l)), list.join(' | '));
    assert.ok(list.every((l) => !/Everyone|Users|Authenticated|Administrators/i.test(l)), list.join(' | '));
  }
  assert.equal(fs.readFileSync(key, 'utf8'), 'k');
  // Again changes nothing.
  assert.equal(await makePrivate(secrets), undefined);
});

test('for real: a folder that is a link is left alone, and said', { skip: !windows && 'Windows only' }, async () => {
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const linked = path.join(root, 'linked-secrets');
  fs.symlinkSync(elsewhere, linked, 'junction');
  assert.match((await makePrivate(linked)) ?? '', /is a link/);
});
