// The Desktop app workflow (.github/workflows/desktop.yml) only runs when a
// file in its `paths:` changes, and tb land's hold reads the same list
// (land-gate.ts). The desktop app builds and tests from files outside
// desktop/ too: the pictures and pele.js in shared/, the shared cases
// (shared/cases), the site's doc names, the runner files the mock runner imports.
// A change to only those ran no desktop CI and wasn't held, so a break
// showed up on the next unrelated desktop landing (16 Nov). This finds every
// such file in the code and checks the workflow runs for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { filesThatRunIt, pushPaths } from '../../src/land-gate.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CRATES = ['client', 'core', 'dock', 'gpui', 'web'].map((c) => path.join(ROOT, 'desktop', c));

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// Repo-relative paths outside desktop/ that the desktop crates and the mock
// runner read: include_str!/include_bytes! (beside the source file),
// CARGO_MANIFEST_DIR joins (beside the crate), and the mock runner's imports.
function readFromOutside(): string[] {
  const found = new Set<string>();
  const keep = (abs: string) => {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (!rel.startsWith('desktop/') && !rel.startsWith('../')) found.add(rel);
  };
  for (const crate of CRATES) {
    for (const file of walk(crate, '.rs')) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/include_(?:str|bytes)!\(\s*"([^"]+)"\s*\)/g)) keep(path.resolve(path.dirname(file), m[1]));
      for (const m of text.matchAll(/CARGO_MANIFEST_DIR"\)\s*,\s*"([^"]+)"/g)) keep(path.join(crate, m[1]));
    }
  }
  const mock = path.join(ROOT, 'mock-runner');
  for (const file of fs.readdirSync(mock).filter((f) => f.endsWith('.mjs'))) {
    const text = fs.readFileSync(path.join(mock, file), 'utf8');
    for (const m of text.matchAll(/from\s+'(\.\.?\/[^']+)'/g)) keep(path.resolve(mock, m[1]));
  }
  return [...found].sort();
}

const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/desktop.yml'), 'utf8');

test('the desktop app reads some files from outside desktop/, and the scan finds them', () => {
  const outside = readFromOutside();
  // Known ones, so a scan that quietly finds nothing fails here.
  for (const f of ['shared/rich/pele.js', 'shared/art/librarian.png', 'shared/cases/inbox-urgency.json', 'site/app-doc-slugs.json', 'runner/src/samples.ts']) {
    assert.ok(outside.includes(f), `${f} among ${outside.join(', ')}`);
  }
});

test('desktop.yml runs, and tb land holds, for every file the desktop app reads from outside desktop/', () => {
  const paths = pushPaths(workflow);
  assert.ok(paths?.length, 'desktop.yml has push paths');
  const missed = readFromOutside().filter((f) => filesThatRunIt(paths, [f]).length === 0);
  assert.deepEqual(missed, [], 'add these to both paths: lists in desktop.yml');
});

test("desktop.yml's pull request paths are its push paths", () => {
  // Two copies of one list: a path added to one only would run on pushes
  // and not PRs, or the other way round.
  const lists = [...workflow.matchAll(/^ {4}paths:\n((?: {6}- .*\n)+)/gm)].map((m) => m[1]);
  assert.equal(lists.length, 2, 'a push and a pull_request list');
  assert.equal(lists[1], lists[0]);
});
