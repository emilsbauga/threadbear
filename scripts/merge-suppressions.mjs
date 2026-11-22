#!/usr/bin/env node
// Git merge driver for eslint-suppressions.json, the lint problems recorded
// as exempt: `merge=suppressions` in .gitattributes, set up as
// merge.suppressions.driver by worktree-setup.sh. Called as
//   merge-suppressions.mjs <base> <ours> <theirs>
// it writes the merge into <ours>.
//
// The file is a count per file and rule. Two threads that each fixed or
// recorded problems, landing at once, touched neighbouring lines of it, and
// a text merge called that a conflict that stopped the second landing. Here
// each count comes out as the base's plus what each side added, less the
// smaller of what they took away when both took some (they may have fixed
// the same problem, and a count too high only leaves slack, where one too
// low fails the next lint). A count of 0 drops out, as ESLint drops it.
//
// The output is what ESLint writes (keys sorted, two spaces, no newline at
// the end), so a later `eslint --prune-suppressions` changes only what it
// prunes. A side that isn't JSON (a conflict left in by hand) is a
// conflict: exit 1, ours untouched.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @typedef {Record<string, Record<string, { count: number }>>} Suppressions */

/** @param {Suppressions} s */
const flat = (s) => {
  const m = new Map();
  for (const [file, rules] of Object.entries(s ?? {}))
    for (const [rule, { count }] of Object.entries(rules ?? {})) m.set(JSON.stringify([file, rule]), count);
  return m;
};

/** @param {unknown} value */
const sorted = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(/** @type {Record<string, unknown>} */ (value)[k])]));
};

/**
 * The three-way merge of three suppressions files, as text.
 * @param {string} base @param {string} ours @param {string} theirs
 * @returns {string}
 */
export function mergeSuppressions(base, ours, theirs) {
  const [o, a, b] = [base, ours, theirs].map((t) => flat(t.trim() ? JSON.parse(t) : {}));
  /** @type {Suppressions} */
  const out = {};
  for (const key of new Set([...o.keys(), ...a.keys(), ...b.keys()])) {
    const was = o.get(key) ?? 0;
    const da = (a.get(key) ?? 0) - was;
    const db = (b.get(key) ?? 0) - was;
    const taken = da < 0 && db < 0 ? Math.max(da, db) : Math.min(da, 0) + Math.min(db, 0);
    const count = was + Math.max(da, 0) + Math.max(db, 0) + taken;
    if (count <= 0) continue;
    const [file, rule] = JSON.parse(key);
    (out[file] ??= {})[rule] = { count };
  }
  const text = JSON.stringify(sorted(out), null, 2);
  // A Windows checkout may have the file with CRLF (core.autocrlf): keep ours'.
  return ours.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [basePath, oursPath, theirsPath] = process.argv.slice(2);
  if (!theirsPath) {
    process.stderr.write('usage: merge-suppressions.mjs <base> <ours> <theirs>\n');
    process.exit(2);
  }
  const read = (p) => fs.readFileSync(p, 'utf8');
  let merged;
  try {
    merged = mergeSuppressions(read(basePath), read(oursPath), read(theirsPath));
  } catch (e) {
    process.stderr.write(`eslint-suppressions.json: couldn't merge (${e instanceof Error ? e.message : String(e)}); take main's copy, then record only what this branch adds with \`npx eslint <files> --suppress-rule <rule>\`.\n`);
    process.exit(1);
  }
  fs.writeFileSync(oursPath, merged);
}
