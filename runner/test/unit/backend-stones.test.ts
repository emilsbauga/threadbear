// The deploy's stepping stones (runner/scripts/backend-stones.mjs): a release
// that makes a field required is first deployed with convex/stepping.ts
// naming its backfill (the field optional, its machine off), the backfill
// run, then deployed as it is. Codex's review (17 Nov 2026) found the first
// design, deploying an older commit first, broke on merges and on forks
// with schema changes of their own; this one only ever deploys the tree
// being updated to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';
import { load } from '../helpers/convex-memory.ts';

// Plain .mjs (Node built-ins only, as deploy-backend.mjs), loaded as deploy-steps' tests load theirs.
const { backfillsAt, lastJson, rearmCursor, withStepping } = await import(pathToFileURL(path.join(import.meta.dirname, '..', '..', 'scripts', 'backend-stones.mjs')).href);
const ROOT = path.join(import.meta.dirname, '..', '..', '..');

function repo() {
  const dir = tmpDir();
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  const commit = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  return { dir, commit };
}

test('a release lists the backfills it needs; one with none needs nothing', () => {
  const r = repo();
  const old = r.commit('convex/sync.ts', 'v1');
  const tip = r.commit('convex/migrations.json', JSON.stringify({ backfills: [{ name: 'commandState' }, { name: 'moveState' }] }));
  assert.deepEqual(backfillsAt(r.dir, old), []);
  assert.deepEqual(backfillsAt(r.dir, tip), ['commandState', 'moveState']);
});

test('a listing that is not JSON, or a name that could be anything, stops the deploy', () => {
  const r = repo();
  const bad = r.commit('convex/migrations.json', '{ nope');
  assert.throws(() => backfillsAt(r.dir, bad), /isn't JSON/);
  const odd = r.commit('convex/migrations.json', JSON.stringify({ backfills: [{ name: '$(rm -rf ~)' }] }));
  assert.throws(() => backfillsAt(r.dir, odd), /no good name/);
});

test("the stepping stone is this repo's own stepping.ts with the names in, and the repo's always has it empty", () => {
  const real = fs.readFileSync(path.join(ROOT, 'convex', 'stepping.ts'), 'utf8');
  assert.match(real, /^export const STEPPING: readonly string\[\] = \[\];$/m, 'committed empty');
  const stone = withStepping(real, ['commandState']);
  assert.match(stone, /^export const STEPPING: readonly string\[\] = \["commandState"\];$/m);
  assert.equal(stone.replace('["commandState"]', '[]'), real, 'nothing else changes');
  assert.throws(() => withStepping('export const STEPPING = ["x"];', ['commandState']), /empty STEPPING list/);
  // Every backfill the repo lists exists in migrations.ts.
  const listed = backfillsAt(ROOT, 'HEAD') as string[];
  const migrations = fs.readFileSync(path.join(ROOT, 'convex', 'migrations.ts'), 'utf8');
  for (const name of listed) assert.match(migrations, new RegExp(`\\b${name}\\b`), `${name} has a backfill`);
});

test("convex run's answer is read from its last line of JSON", () => {
  assert.deepEqual(lastJson('Running migrations:run...\n{"done":true}\n'), { done: true });
  assert.equal(lastJson('true'), true);
  assert.equal(lastJson('no answer'), undefined);
});

// convex run prints a string as one quoted line and nothing for null; a
// reply it can't read isn't the last page.
test("rearmFailed's answer is the next page's cursor, or null after the last", () => {
  assert.equal(rearmCursor('"073ab9d7"\n'), '073ab9d7');
  assert.equal(rearmCursor(''), null);
  assert.equal(rearmCursor('null\n'), null);
  assert.throws(() => rearmCursor('3\n'), /other than a cursor/);
  assert.throws(() => rearmCursor('Something went wrong'), /other than a cursor/);
});

// The schema and machines as the stepping stone deploys them: the field
// optional, the machine off, its functions saying the backend's being updated.
test('with stepping.ts naming commandState, rows without it fit and the command machine is off', async () => {
  const stepping = load('stepping') as { STEPPING: string[]; requiredUnlessStepping: (n: string, f: unknown) => { isOptional: string }; unlessStepping: <T extends object>(n: string, make: () => T) => T };
  const { v } = await import('convex/values');
  const field = v.object({ kind: v.literal('x') });
  assert.equal(stepping.requiredUnlessStepping('commandState', field).isOptional, 'required');
  (stepping.STEPPING as string[]).push('commandState');
  try {
    assert.equal(stepping.requiredUnlessStepping('commandState', field).isOptional, 'optional');
    const off = stepping.unlessStepping('commandState', () => ({ send: () => 'ran' }));
    assert.throws(() => off.send(), /being updated/);
    assert.equal(stepping.unlessStepping('moveState', () => ({ send: () => 'ran' })).send(), 'ran');
  } finally {
    (stepping.STEPPING as string[]).length = 0;
  }
});
