// eslint-suppressions.json's merge driver (scripts/merge-suppressions.mjs):
// two landings that each change the recorded lint problems merge by count,
// rather than conflicting on neighbouring lines of the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error: a plain .mjs script, no types
import { mergeSuppressions } from '../../../scripts/merge-suppressions.mjs';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'merge-suppressions.mjs');

type Counts = Record<string, Record<string, number>>;
const file = (c: Counts) =>
  JSON.stringify(Object.fromEntries(Object.entries(c).map(([f, rules]) => [f, Object.fromEntries(Object.entries(rules).map(([r, count]) => [r, { count }]))])), null, 2);
const merge = (base: Counts, ours: Counts, theirs: Counts): Counts =>
  Object.fromEntries(Object.entries(JSON.parse(mergeSuppressions(file(base), file(ours), file(theirs))) as Record<string, Record<string, { count: number }>>)
    .map(([f, rules]) => [f, Object.fromEntries(Object.entries(rules).map(([r, { count }]) => [r, count]))]));

const BASE: Counts = { 'a.ts': { x: 3 }, 'b.ts': { x: 2, y: 1 } };

test('merge-suppressions: one side recording a new rule and the other fixing an old problem keeps both', () => {
  assert.deepEqual(merge(BASE, { ...BASE, 'a.ts': { x: 3, z: 4 } }, { ...BASE, 'b.ts': { x: 1, y: 1 } }), { 'a.ts': { x: 3, z: 4 }, 'b.ts': { x: 1, y: 1 } });
});

test('merge-suppressions: both recording problems adds them up', () => {
  assert.deepEqual(merge(BASE, { ...BASE, 'a.ts': { x: 4 } }, { ...BASE, 'a.ts': { x: 5 } }), { 'a.ts': { x: 6 }, 'b.ts': { x: 2, y: 1 } });
});

test('merge-suppressions: both fixing problems takes the smaller fix, as they may be the same one', () => {
  assert.deepEqual(merge(BASE, { ...BASE, 'a.ts': { x: 2 } }, { ...BASE, 'a.ts': { x: 1 } }), { 'a.ts': { x: 2 }, 'b.ts': { x: 2, y: 1 } });
});

test('merge-suppressions: a count fixed down to nothing drops out, file and all', () => {
  assert.deepEqual(merge(BASE, { 'a.ts': { x: 3 }, 'b.ts': { x: 2 } }, { 'a.ts': { x: 3 } }), { 'a.ts': { x: 3 } });
});

test('merge-suppressions: writes what ESLint writes, so the same file on every side comes back as it was', () => {
  const ours = file({ 'b.ts': { y: 1, x: 2 }, 'a.ts': { x: 3 } });
  const merged: string = mergeSuppressions(ours, ours, ours);
  assert.equal(merged, file({ 'a.ts': { x: 3 }, 'b.ts': { x: 2, y: 1 } }), 'keys sorted, two spaces, no newline at the end');
  // As checked out, CRLF on a Windows checkout with core.autocrlf: kept so.
  const real = fs.readFileSync(path.join(ROOT, 'eslint-suppressions.json'), 'utf8');
  assert.equal(mergeSuppressions(real, real, real), real);
  const crlf = ours.replace(/\n/g, '\r\n');
  assert.equal(mergeSuppressions(crlf, crlf, crlf), file({ 'a.ts': { x: 3 }, 'b.ts': { x: 2, y: 1 } }).replace(/\n/g, '\r\n'));
});

test('merge-suppressions: as a git merge driver, a rebase of two neighbouring changes merges clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-merge-suppressions-'));
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'merge.suppressions.driver', `'${process.execPath}' '${SCRIPT}' %O %A %B`);
    fs.writeFileSync(path.join(dir, '.gitattributes'), 'eslint-suppressions.json merge=suppressions\n');
    const write = (c: Counts) => fs.writeFileSync(path.join(dir, 'eslint-suppressions.json'), file(c));
    write(BASE);
    git('add', '.');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'thread');
    write({ ...BASE, 'a.ts': { x: 3, z: 4 } });
    git('commit', '-qam', 'thread records a new rule');
    git('checkout', '-q', 'main');
    write({ ...BASE, 'a.ts': { x: 2 } });
    git('commit', '-qam', 'main fixes one');
    git('checkout', '-q', 'thread');
    git('rebase', '-q', 'main');
    // Line endings evened out: git on Windows may check it out with CRLF.
    assert.equal(fs.readFileSync(path.join(dir, 'eslint-suppressions.json'), 'utf8').replace(/\r\n/g, '\n'), file({ 'a.ts': { x: 2, z: 4 }, 'b.ts': { x: 2, y: 1 } }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merge-suppressions: a side that is not JSON is a conflict, with ours left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-merge-suppressions-'));
  try {
    const put = (name: string, text: string) => {
      fs.writeFileSync(path.join(dir, name), text);
      return path.join(dir, name);
    };
    const ours = file(BASE);
    const r = spawnSync(process.execPath, [SCRIPT, put('o', ours), put('a', ours), put('b', '<<<<<<< HEAD\n')], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /couldn't merge/);
    assert.equal(fs.readFileSync(path.join(dir, 'a'), 'utf8'), ours);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
