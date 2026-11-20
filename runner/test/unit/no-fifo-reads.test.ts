// no-fifo-reads.ts: a look's reads never wait on a FIFO, and read every
// ordinary file as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFileSync as namedRead } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { noFifoReads } from '../../src/no-fifo-reads.ts';
import { claudeCommands } from '../../src/claude-trust.ts';

// Windows has no FIFOs in folders (its named pipes live only under \\.\pipe\),
// so no read there can wait on one: Git Bash's mkfifo makes an ordinary file
// that only MSYS treats as a pipe. And no /dev/null.
const unixOnly = { skip: process.platform === 'win32' && 'no FIFOs in folders on Windows' };

function dir(t: { after: (f: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-nofifo-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('a FIFO, read whole or opened, by name or through a link, fails the call at once, even when the code catches the error itself', unixOnly, (t) => {
  const d = dir(t);
  const fifo = path.join(d, 'f');
  execFileSync('mkfifo', [fifo]);
  fs.symlinkSync(fifo, path.join(d, 'link'));
  const swallow = (f: () => unknown) => () => {
    try {
      f();
    } catch {
      // As the trust code does: taken as missing.
    }
    return 'looked';
  };
  assert.throws(() => noFifoReads(swallow(() => fs.readFileSync(fifo))), /f is a FIFO or socket, not a file/);
  assert.throws(() => noFifoReads(swallow(() => fs.readFileSync(path.join(d, 'link'), 'utf8'))), /link is a FIFO or socket/);
  assert.throws(() => noFifoReads(swallow(() => fs.openSync(fifo, 'r'))), /is a FIFO or socket/);
  assert.throws(() => noFifoReads(swallow(() => namedRead(fifo))), /is a FIFO or socket/);
});

test('ordinary files, folders, missing files, /dev/null and writes go on as before, and fs is itself again afterwards', (t) => {
  const d = dir(t);
  const file = path.join(d, 'a.txt');
  fs.writeFileSync(file, 'hello');
  const read = fs.readFileSync;
  const open = fs.openSync;
  const got = noFifoReads(() => {
    const out: unknown[] = [fs.readFileSync(file, 'utf8'), fs.readFileSync(file).length, process.platform === 'win32' ? 0 : fs.readFileSync('/dev/null').length, namedRead(file, 'utf8')];
    for (const p of [d, path.join(d, 'nope')]) {
      try {
        fs.readFileSync(p);
        out.push('read');
      } catch (e) {
        out.push((e as NodeJS.ErrnoException).code);
      }
    }
    const fd = fs.openSync(path.join(d, 'w.txt'), 'w');
    fs.writeSync(fd, 'x');
    fs.closeSync(fd);
    const rd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(5);
    fs.readSync(rd, buf, 0, 5, 0);
    fs.closeSync(rd);
    out.push(buf.toString());
    return out;
  });
  assert.deepEqual(got, ['hello', 5, 0, 'hello', 'EISDIR', 'ENOENT', 'hello']);
  assert.equal(fs.readFileSync, read);
  assert.equal(fs.openSync, open);
});

test("a folder's Claude settings look the same through it as without", (t) => {
  const d = dir(t);
  const f = path.join(d, 'repo');
  fs.mkdirSync(path.join(f, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(f, '.claude', 'hooks', 'go.sh'), '#!/bin/sh\necho hi > /dev/null\n');
  fs.writeFileSync(path.join(f, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh .claude/hooks/go.sh 2>/dev/null' }] }] } }));
  for (const grants of [false, true]) assert.deepEqual(noFifoReads(() => claudeCommands(f, d, { grants })), claudeCommands(f, d, { grants }));
});
