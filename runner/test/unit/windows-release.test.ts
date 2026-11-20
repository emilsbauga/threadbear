// On Windows <home>/runner/current is a file with the release's id, not a
// symlink (launch.mjs's readCurrentLink says why). Both readers agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// @ts-expect-error launch.mjs has no types
import { pointCurrent, readCurrentLink } from '../../launch.mjs';
import { currentLink } from '../../src/release.ts';

function home(): { home: string; dir: string } {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-current-'));
  const dir = path.join(h, 'runner');
  fs.mkdirSync(path.join(dir, 'releases', 'r1'), { recursive: true });
  return { home: h, dir };
}

test("Windows' current is a file naming the release, swapped by rename", () => {
  const { home: h, dir } = home();
  try {
    pointCurrent(dir, 'r1', 'win32');
    assert.equal(fs.lstatSync(path.join(dir, 'current')).isSymbolicLink(), false);
    assert.equal(readCurrentLink(dir, 'win32'), 'r1');
    assert.equal(currentLink(h, 'win32'), 'r1');
    pointCurrent(dir, 'r2', 'win32');
    assert.equal(readCurrentLink(dir, 'win32'), 'r2');
    // Off Windows a plain file isn't current.
    assert.equal(readCurrentLink(dir, 'darwin'), null);
    // Nor a path in the file.
    fs.writeFileSync(path.join(dir, 'current'), '..\\elsewhere\n');
    assert.equal(readCurrentLink(dir, 'win32'), null);
    assert.equal(currentLink(h, 'win32'), undefined);
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test('elsewhere current stays a relative symlink', { skip: process.platform === 'win32' ? 'symlinks need a privilege on Windows' : false }, () => {
  const { home: h, dir } = home();
  try {
    pointCurrent(dir, 'r1');
    assert.equal(fs.readlinkSync(path.join(dir, 'current')), path.join('releases', 'r1'));
    assert.equal(currentLink(h), 'r1');
  } finally {
    fs.rmSync(h, { recursive: true, force: true });
  }
});

test("a supervised runner stops when launch.mjs asks over IPC (Windows' stop)", async () => {
  const { fork } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-stopreq-'));
  try {
    const script = path.join(dir, 'child.ts');
    const release = path.join(import.meta.dirname, '..', '..', 'src', 'release.ts');
    fs.writeFileSync(script, `import { onStopRequest } from ${JSON.stringify(pathToFileURL(release).href)};\nonStopRequest(() => { process.send?.({ type: 'stopping' }); setTimeout(() => process.exit(0), 10); });\nprocess.send?.({ type: 'ready' });\nsetInterval(() => {}, 1000);\n`);
    const child = fork(script, { env: { ...process.env, THREADBEAR_SUPERVISED: '1' }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const seen: string[] = [];
    child.on('message', (m: { type: string }) => {
      seen.push(m.type);
      if (m.type === 'ready') {
        child.send({ type: 'other' });
        child.send({ type: 'stop' });
      }
    });
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 0);
    assert.deepEqual(seen, ['ready', 'stopping']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("launch.mjs takes the Windows task's --home, --port and --log, and nothing else", async () => {
  // @ts-expect-error launch.mjs has no types
  const { launchArgs } = await import('../../launch.mjs');
  assert.deepEqual(launchArgs(['--home', 'C:\\x y\\Threadbear', '--port', '8899', '--log', 'C:\\l.log', '--other', 'v']), { home: 'C:\\x y\\Threadbear', port: '8899', log: 'C:\\l.log' });
  assert.deepEqual(launchArgs([]), {});
  assert.deepEqual(launchArgs(['--home']), {});
});

test("launch.mjs stops its runners once the process that started it has gone (Windows' End kills only conhost)", async () => {
  // @ts-expect-error launch.mjs has no types
  const { watchParent } = await import('../../launch.mjs');
  let alive = true;
  let calls = 0;
  const timer = watchParent(4242, () => calls++, { everyMs: 5, alive: () => alive, startedAt: () => undefined });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 0);
  alive = false;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1);
  clearInterval(timer);
  assert.equal(watchParent(1, () => calls++), null);
});

test("launch.mjs's parent watch takes a reused process id for its parent gone, and a failed read for nothing", async () => {
  // @ts-expect-error launch.mjs has no types
  const { watchParent } = await import('../../launch.mjs');
  let start: string | undefined = '100';
  let calls = 0;
  const timer = watchParent(4242, () => calls++, { everyMs: 2, identityEvery: 2, alive: () => true, startedAt: () => start });
  start = undefined; // PowerShell refused this time
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(calls, 0);
  start = '200'; // a new process with the same id
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(calls, 1);
  clearInterval(timer);
});

test('ending the task waits for the old runner to let go of the data dir', async () => {
  // @ts-expect-error .mjs, no types
  const { endTask } = await import('../../scripts/windows-task.mjs');
  let ended = 0;
  let checks = 0;
  const ok = await endTask('t', '/h', { end: () => ended++, holder: () => 4242, alive: () => ++checks < 3, sleep: async () => {} });
  assert.equal(ok, true);
  assert.equal(ended, 1);
  assert.equal(checks, 3);
  const late = await endTask('t', '/h', { timeoutMs: -1, end: () => {}, holder: () => 4242, alive: () => true, sleep: async () => {} });
  assert.equal(late, false);
  assert.equal(await endTask('t', '/h', { end: () => {}, holder: () => undefined }), true);
});
