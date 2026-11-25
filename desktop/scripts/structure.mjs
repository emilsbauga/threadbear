#!/usr/bin/env node
// Fails when desktop/'s Rust grows a new loop: modules that use each other in
// a circle, or types and functions that know each other in one across
// modules. deslop-please (github.com/deterministic-machines/deslop-please)
// finds them from rust-analyzer's index; structure-allow.txt beside this
// script lists the ones there already, which pass.
//
//   node desktop/scripts/structure.mjs           check
//   node desktop/scripts/structure.mjs --update  rewrite structure-allow.txt
//
// Needs `deslop-please` (cargo install deslop-please --locked) and
// rust-analyzer (rustup component add rust-analyzer) on the PATH. The first
// run indexes the workspace, a few minutes; after that only a change does.
// Heavy for the M5: run it on a check host (desktop/scripts/remote.sh).
//
// Mike, 24 Nov 2026: the tool's first run found 252 things, and six small
// loops were fixed. Only loops fail here, as they're what makes a change in one
// file need reading the others. Its other findings (fields read outside their
// type, modules that show most of what's in them, files over 2,000 lines,
// folders over 15) are counted and not held to: most of those 240 are GPUI's
// way of splitting one view's code across files, or plain data read where it's
// shown.
//
// deslop-please's own --allow fails a known loop that gains a member, and the
// GPUI app's is one loop of about 100 modules through `Threadbear`: every new
// file would fail it. Here a loop that shares a member with a listed one is
// that loop grown, and passes with a note; a loop with nothing in common with
// any listed one is new, and fails.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const allowPath = path.join(here, 'structure-allow.txt');
const held = new Set(['module-cycle', 'tangle']);

/** `<lint> <key>` lines, as deslop-please writes them. */
function parse(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const at = l.indexOf(' ');
      return { lint: l.slice(0, at), key: l.slice(at + 1) };
    });
}

/** A loop's members: its key split at commas outside brackets. */
function members(key) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < key.length; i++) {
    const c = key[i];
    if ('<(['.includes(c)) depth++;
    else if ('>)]'.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push(key.slice(start, i));
      start = i + 1;
    }
  }
  out.push(key.slice(start));
  return out;
}

/** Everything deslop-please finds now, as allow-file lines. */
function current() {
  const dir = mkdtempSync(path.join(tmpdir(), 'structure-'));
  const file = path.join(dir, 'now.txt');
  try {
    try {
      execFileSync('deslop-please', ['--update-allow', file], { cwd: desktop, stdio: ['ignore', 'ignore', 'inherit'] });
    } catch (e) {
      // It exits non-zero when it finds anything, having written the file.
      if (e.code === 'ENOENT') {
        console.error('deslop-please is not on the PATH: cargo install deslop-please --locked, and rustup component add rust-analyzer');
        process.exit(2);
      }
    }
    return readFileSync(file, 'utf8');
  } catch {
    console.error('deslop-please wrote no findings: its output above says why');
    process.exit(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const now = current();
if (process.argv.includes('--update')) {
  writeFileSync(allowPath, now);
  console.log(`wrote ${path.relative(process.cwd(), allowPath)}: ${parse(now).length} findings`);
  process.exit(0);
}

const allowed = parse(readFileSync(allowPath, 'utf8'));
const found = parse(now);
const counts = new Map();
const grown = [];
const added = [];
for (const f of found) {
  counts.set(f.lint, (counts.get(f.lint) ?? 0) + 1);
  if (!held.has(f.lint)) continue;
  if (allowed.some((a) => a.lint === f.lint && a.key === f.key)) continue;
  const mine = new Set(members(f.key));
  if (allowed.some((a) => a.lint === f.lint && members(a.key).some((m) => mine.has(m)))) grown.push(f);
  else added.push(f);
}

console.log(
  'deslop-please found: ' +
    [...counts].map(([lint, n]) => `${n} ${lint}`).join(', ') +
    ` (${allowed.length} listed in structure-allow.txt)`,
);
for (const g of grown) console.log(`note  a listed ${g.lint} grew: ${members(g.key).length} members now`);
if (added.length === 0) {
  console.log('No new loops.');
  process.exit(0);
}
for (const a of added) {
  console.log(`\nnew ${a.lint}: ${members(a.key).join(', ')}`);
}
console.log(
  '\nThese use each other in a circle, so none can be read or changed alone.' +
    '\nFix: move what both sides share into a module of its own, make one a child' +
    '\nof the other, or hand one a callback, so the uses run one way.' +
    '\n`cd desktop && deslop-please` draws each loop with the lines that close it.' +
    '\nA loop that has to stay: node desktop/scripts/structure.mjs --update, and say why in the commit.',
);
process.exit(1);
