// Stepping stones for a backend deploy (deploy-backend.mjs, convex/stepping.ts,
// convex/migrations.ts).
//
// A schema change that makes a field required can only be deployed once every
// stored row has it: Convex checks every row against the new schema and
// refuses the deploy otherwise. Threadbear's backends upgrade themselves to
// whatever commit their main Mac's runner updates to, often skipping many
// commits, and forks carry schema changes of their own, so the deploy can't
// count on an earlier release having been deployed, nor deploy one of Mike's
// older commits in its place (a fork's rows wouldn't fit it).
//
// So a release that needs a backfill lists it in convex/migrations.json:
//
//   { "backfills": [{ "name": "commandState" }] }
//
// and the field is `requiredUnlessStepping` in its schema. Before deploying
// it, the deploy script asks the deployment which listed backfills have
// finished (`migrations:done`). For any that haven't, it deploys the same
// tree once with convex/stepping.ts naming them (the fields optional, their
// machines off), runs `migrations:run` until each says done, then deploys
// the tree as it is.
//
// Node built-ins only, like deploy-backend.mjs.
import { spawnSync } from 'node:child_process';

export const MIGRATIONS_FILE = 'convex/migrations.json';
export const STEPPING_FILE = 'convex/stepping.ts';
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const STEPPING_LINE = /^export const STEPPING: readonly string\[\] = \[\];$/m;

/** The backfills a commit needs before it can be deployed, by name. */
export function backfillsAt(repo, commit) {
  const r = spawnSync('git', ['-C', repo, 'show', `${commit}:${MIGRATIONS_FILE}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    throw new Error(`${MIGRATIONS_FILE} at ${commit.slice(0, 7)} isn't JSON: ${e.message}`);
  }
  const list = Array.isArray(parsed?.backfills) ? parsed.backfills : [];
  return list.map((b) => {
    if (!NAME.test(String(b?.name ?? ''))) throw new Error(`${MIGRATIONS_FILE} at ${commit.slice(0, 7)} has a backfill with no good name`);
    return b.name;
  });
}

/** convex/stepping.ts's text naming these backfills, from the file as the release has it. */
export function withStepping(text, names) {
  if (!STEPPING_LINE.test(text)) throw new Error(`${STEPPING_FILE} doesn't have its empty STEPPING list, so the backfills ${names.join(', ')} can't be run before this deploy`);
  return text.replace(STEPPING_LINE, `export const STEPPING: readonly string[] = ${JSON.stringify(names)};`);
}

/**
 * What machines:rearmFailed answered through `convex run`: the next page's
 * cursor, or null after the last page (the CLI prints nothing for a null).
 * Anything else throws rather than pass for done, or the deploy would stop
 * delivering failed timers again with pages still to go (19 Nov 2026).
 */
export function rearmCursor(stdout) {
  const out = String(stdout).trim();
  const next = out ? lastJson(out) : null;
  if (next === null || typeof next === 'string') return next;
  throw new Error(`it answered something other than a cursor: ${out.slice(-200)}`);
}

/** The answer `npx convex run` printed: its last line of JSON, or the whole of it. */
export function lastJson(text) {
  const lines = String(text).trim().split('\n').reverse();
  for (const line of lines) {
    try {
      return JSON.parse(line);
    } catch {
      // not this one
    }
  }
  try {
    return JSON.parse(String(text));
  } catch {
    return undefined;
  }
}
