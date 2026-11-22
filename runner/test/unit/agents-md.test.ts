// AGENTS.md is loaded into every agent thread in this repo, so it stays the
// traps to avoid, not the how-to: on 20 Nov 2026 it had grown to 575 lines
// (about 9.6k tokens a thread) and was cut to about 160, its how-to moved to
// the docs that own each topic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(import.meta.dirname, '..', '..', '..', 'AGENTS.md');
const MAX_LINES = 180;

test(`AGENTS.md stays under ${MAX_LINES} lines`, () => {
  const lines = fs.readFileSync(FILE, 'utf8').replace(/\n$/, '').split('\n').length;
  assert.ok(lines <= MAX_LINES,
    `AGENTS.md has ${lines} lines, over its ${MAX_LINES}. Every thread here loads it, so keep it to the rules ` +
    'and traps. Move the how-to and detail into the doc that owns the topic (docs/dev-tools.md, ' +
    'docs/thread-worktrees.md, desktop/README.md, ios/README.md, ...), merged into what is there, and leave ' +
    'a one-line rule or a line in "Doing X? Read Y" that links it. Don\'t raise the limit.');
});

test('the docs AGENTS.md points at exist', () => {
  const text = fs.readFileSync(FILE, 'utf8');
  const root = path.dirname(FILE);
  const cited = new Set([...text.matchAll(/(?<![\w/.-])((?:docs|desktop|app|ios|runner|features|scripts)\/[\w./-]+\.(?:md|sh|ts|rs))/g)].map((m) => m[1]));
  const missing = [...cited].filter((p) => !fs.existsSync(path.join(root, p)));
  assert.deepEqual(missing, [], 'AGENTS.md names files that are not there: fix the path or the line');
});
