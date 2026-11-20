#!/usr/bin/env node
// Git merge driver for a file of one-line entries whose order doesn't
// matter (docs/experiments.md): `merge=lines` in .gitattributes, set up as
// merge.lines.driver by worktree-setup.sh. Called as
//   merge-lines.mjs <base> <ours> <theirs>
// it writes the merge into <ours> and never reports a conflict.
//
// It replaced merge=union, which keeps every line either side has, so a
// line one side deleted comes back: on 17 Nov main took out the
// openAnything experiment and a thread's branch took out sameWork, the
// rebase in `tb land` kept both lines, and experiment-docs.test.ts failed
// the landing's check. Here each line ends up as many times as the base
// had it plus what each side added or took away, so two threads adding
// entries both keep theirs (as union did) and an entry either side
// removed stays removed. Both sides adding (or removing) the same line
// counts once.
//
// A line both sides changed in different ways comes out as both new
// versions; the doc's test catches that, and `npm run experiment-docs`
// remakes it.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Line endings are evened out to \n first: otherwise a side that turned a
// file to CRLF has "b\r" where the other took out "b", and it comes back
// (Codex's review, 17 Nov). The doc is LF in the repo.
const lines = (text) => {
  const all = text.replace(/\r\n/g, '\n').split('\n');
  if (all.at(-1) === '') all.pop();
  return all;
};

const counts = (list) => {
  const m = new Map();
  for (const l of list) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
};

/** The three-way merge of three texts, each a list of lines. */
export function mergeLines(base, ours, theirs) {
  const [o, a, b] = [base, ours, theirs].map(lines);
  const [co, ca, cb] = [o, a, b].map(counts);
  const want = new Map();
  for (const l of new Set([...o, ...a, ...b])) {
    const was = co.get(l) ?? 0;
    const da = (ca.get(l) ?? 0) - was;
    const db = (cb.get(l) ?? 0) - was;
    const d = da > 0 && db > 0 ? Math.max(da, db) : da < 0 && db < 0 ? Math.min(da, db) : da + db;
    want.set(l, Math.max(0, was + d));
  }

  // Ours in its order, less what theirs took away (the last copies go)...
  const left = new Map(want);
  const out = [];
  for (const l of a) {
    if ((left.get(l) ?? 0) > 0) {
      out.push(l);
      left.set(l, left.get(l) - 1);
    }
  }
  // ...then what theirs added, each after the line it follows in theirs,
  // so a new entry lands in its own section.
  let prev;
  for (const l of b) {
    if ((left.get(l) ?? 0) > 0) {
      const at = prev === undefined ? -1 : out.lastIndexOf(prev);
      out.splice(at === -1 ? out.length : at + 1, 0, l);
      left.set(l, left.get(l) - 1);
    }
    if (out.includes(l)) prev = l;
  }
  // Anything still owed (only base had it, and neither side took it out).
  for (const [l, n] of left) for (let i = 0; i < n; i++) out.push(l);
  return out.length ? out.join('\n') + '\n' : '';
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [basePath, oursPath, theirsPath] = process.argv.slice(2);
  if (!theirsPath) {
    process.stderr.write('usage: merge-lines.mjs <base> <ours> <theirs>\n');
    process.exit(2);
  }
  const read = (p) => fs.readFileSync(p, 'utf8');
  fs.writeFileSync(oursPath, mergeLines(read(basePath), read(oursPath), read(theirsPath)));
}
