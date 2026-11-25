// Which GitHub workflows on main tb watches, and how their last run there
// went (docs/thread-worktrees.md, "Red on GitHub").
//
// The Desktop app workflow failed on every push of main for two days (10 to 12
// Nov) while threads went on landing GPUI changes, each adding to what was
// red: the Windows build stopped linking, and specs failed only on GitHub's
// Macs (their bash) and Linux (its words for Finder and ⌘Q). None of it showed
// in tb land's quick check, and couldn't have: those specs pass on Tinker
// Desk, and running them all takes 15 to 30 minutes a system.
//
// Until 24 Nov a red workflow held every landing that changed what it
// checks. It held 31% of threads in the days before, 40% of those just used
// --despite-red, and desktop.yml's runs take 40 to 80 minutes and failed in
// about a third of them, so mostly it was a detour. Now a red one holds
// nothing: tb land says so in a line, and `tb red-watch` (red-watch.ts)
// starts one thread to fix it.
//
// A workflow opts in with a line of its own anywhere in its file (the words
// are from when it held landings; forks' workflows have them too):
//
//   # tb land: hold while red
//
// Its `on: push: paths:` say which landings it's named in (all of them,
// with no paths). Its own runs are asked of GitHub with gh.
//
// A workflow whose jobs only run in one repo (`github.repository ==
// 'owner/name'` in its `if:`, as Mike's all do since 19 Nov 2026) counts
// only in a checkout whose origin is that repo. In a fork, gh reads the
// `upstream` remote's runs before origin's, so Mike's red Windows build held
// a fork's landing that only had to work on its owner's Mac.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { repoKey } from './upstream.ts';

export const HOLD_MARK = /^\s*#\s*tb land:\s*hold while red\s*$/m;

export type HeldWorkflow = {
  file: string; // its file name, as gh's --workflow takes it
  name: string; // its `name:`, or the file name
  paths?: string[]; // its push paths; undefined when every push runs it
  onlyIn?: string; // the one repo its jobs run in (owner/name), if it names one
};

// The workflows in `root` that hold landings while red.
export function holdingWorkflows(root: string): HeldWorkflow[] {
  const dir = path.join(root, '.github', 'workflows');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort();
  } catch {
    return [];
  }
  const out: HeldWorkflow[] = [];
  for (const file of names) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    if (!HOLD_MARK.test(text)) continue;
    const name = /^name:\s*(.+?)\s*$/m.exec(text)?.[1]?.replace(/^(['"])(.*)\1$/, '$2') ?? file;
    const onlyIn = /github\.repository\s*==\s*'([\w.-]+\/[\w.-]+)'/.exec(text)?.[1];
    out.push({ file, name, paths: pushPaths(text), ...(onlyIn ? { onlyIn } : {}) });
  }
  return out;
}

const unquote = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2');

// The `paths:` under `on:` / `push:`, as a list (block or `[a, b]`), or
// undefined when there are none, so every push runs it. Only as much YAML
// as a workflow's trigger is written in: keys by their indent.
export function pushPaths(yaml: string): string[] | undefined {
  const lines = yaml.split('\n');
  const indent = (l: string) => l.length - l.trimStart().length;
  const key = (l: string) => /^\s*(['"]?)([\w-]+)\1\s*:\s*(.*)$/.exec(l.replace(/\s+#.*$/, ''));
  const blockUnder = (from: number, to: number, name: string): number | undefined => {
    let level: number | undefined;
    for (let i = from; i < to; i++) {
      const l = lines[i];
      if (!l.trim() || l.trimStart().startsWith('#')) continue;
      level ??= indent(l);
      if (indent(l) < level) return undefined;
      if (indent(l) === level && key(l)?.[2] === name) return i;
    }
    return undefined;
  };
  const end = (start: number): number => {
    const level = indent(lines[start]);
    let i = start + 1;
    while (i < lines.length && (!lines[i].trim() || lines[i].trimStart().startsWith('#') || indent(lines[i]) > level)) i++;
    return i;
  };
  const on = blockUnder(0, lines.length, 'on');
  if (on === undefined) return undefined;
  const push = blockUnder(on + 1, end(on), 'push');
  if (push === undefined) return undefined;
  const at = blockUnder(push + 1, end(push), 'paths');
  if (at === undefined) return undefined;
  const inline = key(lines[at])?.[3]?.trim() ?? '';
  // What this can't read (an alias to an anchored list, a `[` list over
  // several lines) counts as every push, so it holds more, never less.
  // A quoted item may have a comma in it, which splitting would break.
  if (inline.startsWith('[')) return inline.endsWith(']') && !/['"]/.test(inline) ? inline.slice(1, -1).split(',').map(unquote).filter(Boolean) : undefined;
  if (inline) return undefined;
  // Its items, indented further or (as YAML allows) level with it.
  const items: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i].replace(/\s+#.*$/, '');
    if (!l.trim() || l.trimStart().startsWith('#')) continue;
    const item = /^\s*-\s*(.+?)\s*$/.exec(l);
    if (!item || indent(l) < indent(lines[at])) break;
    items.push(unquote(item[1]));
  }
  return items.length ? items : undefined;
}

// A path filter as GitHub matches it: `*` within a folder, `**` across them
// (`a/**/b` takes a/b too), `?` and `+` the character before it zero or one
// and one or more times, `[ab]` and `[a-z]` one of those, and a later
// `!pattern` taking files back out.
function globRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        re += '(?:.*/)?';
        i++;
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if ((c === '?' || c === '+') && i > 0) re += c;
    else if (c === '[' && glob.indexOf(']', i + 2) > i) {
      const end = glob.indexOf(']', i + 2);
      re += `[${glob.slice(i + 1, end).replace(/[\\^]/g, '\\$&')}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// Which of `files` set the workflow off.
export function filesThatRunIt(paths: string[] | undefined, files: string[]): string[] {
  if (!paths) return files;
  const rules = paths.map((p) => (p.startsWith('!') ? { out: true, re: globRegex(p.slice(1)) } : { out: false, re: globRegex(p) }));
  return files.filter((f) => {
    let hit = false;
    for (const r of rules) if (r.re.test(f)) hit = !r.out;
    return hit;
  });
}

export type Gh = (args: string[], cwd: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const GH_TIMEOUT_MS = 20_000;

export const gh: Gh = (args, cwd) =>
  new Promise((resolve) => {
    execFile('gh', args, { cwd, timeout: GH_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err as Error | null)?.message || '') });
    });
  });

export type Run = { databaseId: number; status: string; conclusion: string; headSha: string; url: string; createdAt: string; updatedAt?: string; displayTitle?: string };
type Job = { databaseId?: number; name: string; conclusion: string; startedAt?: string; completedAt?: string; steps?: { name: string; conclusion: string }[] };

// How many of a workflow's latest runs on main are looked through for one
// that finished: a newer push takes the place of a run still waiting, so a
// busy day has runs of cancelled ones.
export const RUNS_LOOKED_AT = 100;

// A run that says nothing about main. Most cancelled ones don't either
// (stopped for a newer push, or by hand), but some do: timedOutJobs.
const NO_VERDICT = new Set(['skipped', 'neutral', 'stale', '']);
const RED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);

export type Verdict =
  | { state: 'none' }
  | { state: 'green'; run?: Run }
  | { state: 'red'; run: Run; failedJobs: string[]; newer?: Run }
  | { state: 'unknown'; why: string };

// A job stopped by its own timeout-minutes is cancelled, and so is its run,
// the same as one stopped for a newer push or by hand: only the job's
// annotation tells them apart. From 22 Nov runner.yml's Mac jobs ran into
// their 30 minutes on every push of main and nobody noticed, as every
// cancelled run was passed over.
export const TIMED_OUT = /exceeded the maximum execution time of ([\w.]+)/;
// Cancelled runs not seen before that one look reads the jobs of: one call
// each, and one more for each cancelled job that ran.
export const CANCELLED_LOOKED_AT = 10;

const minutesBetween = (from?: string, to?: string): number => {
  const ms = Date.parse(to ?? '') - Date.parse(from ?? '');
  return Number.isFinite(ms) ? ms / 60_000 : Infinity;
};

// What a cancelled run's timed-out jobs were, kept by run (and attempt), as
// a finished run doesn't change: null for none.
export type CancelledMemo = { get(key: string): string[] | null | undefined; set(key: string, timedOut: string[] | null): void };
const memoKey = (r: Run): string => `${r.databaseId}@${r.updatedAt ?? ''}`;

// The jobs of a cancelled run that ran into their own timeout, as "macos-26
// (timed out after 30m0s in Runner tests)": none when it was stopped for a
// newer push or by hand, undefined when GitHub couldn't say. Every
// cancelled job that ran a minute or more is asked about, not only those as
// long as the workflow's timeouts are now: a fix that raises one would
// otherwise pass over the run it timed out in, and the older green run
// behind it would count (Codex's review).
async function timedOutJobs(root: string, r: Run, run: Gh): Promise<string[] | undefined> {
  const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\//.exec(r.url)?.[1];
  if (!repo) return undefined;
  const jobs = await run(['run', 'view', String(r.databaseId), '--json', 'jobs'], root);
  if (!jobs.ok) return undefined;
  let parsed: { jobs?: Job[] };
  try {
    parsed = JSON.parse(jobs.stdout) as { jobs?: Job[] };
  } catch {
    return undefined;
  }
  const out: string[] = [];
  for (const j of parsed.jobs ?? []) {
    if (j.conclusion !== 'cancelled' || !j.databaseId) continue;
    if (minutesBetween(j.startedAt, j.completedAt) < 1) continue;
    // Every page, one message a line: a job's warnings can push the
    // timeout's past the first.
    const a = await run(['api', '--paginate', `repos/${repo}/check-runs/${j.databaseId}/annotations?per_page=100`, '--jq', '.[].message'], root);
    if (!a.ok) return undefined;
    const hit = a.stdout.split('\n').map((m) => TIMED_OUT.exec(m)).find(Boolean);
    if (!hit) continue;
    const step = j.steps?.find((s) => s.conclusion === 'cancelled')?.name;
    out.push(`${j.name} (timed out after ${hit[1]}${step ? ` in ${step}` : ''})`);
  }
  return out;
}

// The workflow's last finished run on main, from pushes: one that failed,
// or was cancelled by a job's own timeout, is red.
export async function lastVerdict(root: string, file: string, run: Gh = gh, memo?: CancelledMemo): Promise<Verdict> {
  const r = await run(['run', 'list', '--workflow', file, '--branch', 'main', '--event', 'push', '--limit', String(RUNS_LOOKED_AT), '--json', 'databaseId,status,conclusion,headSha,url,createdAt,updatedAt,displayTitle'], root);
  if (!r.ok) return { state: 'unknown', why: firstLine(r.stderr) || 'gh failed' };
  let runs: Run[];
  try {
    runs = JSON.parse(r.stdout) as Run[];
  } catch {
    return { state: 'unknown', why: "gh's answer wasn't JSON" };
  }
  // One still going, for a newer push: it may be the fix.
  const newer = (than: Run) => {
    const n = runs.find((x) => x.status !== 'completed' && x.createdAt > than.createdAt);
    return n ? { newer: n } : {};
  };
  let looked = 0;
  for (const x of runs) {
    if (x.status !== 'completed' || NO_VERDICT.has(x.conclusion ?? '')) continue;
    if (x.conclusion === 'cancelled') {
      let timedOut = memo?.get(memoKey(x));
      if (timedOut === undefined) {
        if (++looked > CANCELLED_LOOKED_AT) return { state: 'unknown', why: `more than ${CANCELLED_LOOKED_AT} cancelled runs to look through` };
        const found = await timedOutJobs(root, x, run);
        if (!found) return { state: 'unknown', why: `couldn't read why run ${x.databaseId} was cancelled` };
        timedOut = found.length ? found : null;
        memo?.set(memoKey(x), timedOut);
      }
      if (!timedOut) continue;
      return { state: 'red', run: x, failedJobs: timedOut, ...newer(x) };
    }
    if (!RED.has(x.conclusion)) return { state: 'green', run: x };
    let failedJobs: string[] = [];
    const jobs = await run(['run', 'view', String(x.databaseId), '--json', 'jobs'], root);
    if (jobs.ok) {
      try {
        const parsed = JSON.parse(jobs.stdout) as { jobs?: Job[] };
        failedJobs = (parsed.jobs ?? [])
          .filter((j) => RED.has(j.conclusion))
          .map((j) => {
            const step = j.steps?.find((s) => RED.has(s.conclusion))?.name;
            return step ? `${j.name} (${step})` : j.name;
          });
      } catch {
        // Only the detail goes.
      }
    }
    return { state: 'red', run: x, failedJobs, ...newer(x) };
  }
  // A whole page of cancelled runs says nothing about the one before them.
  return runs.length >= RUNS_LOOKED_AT ? { state: 'unknown', why: `none of its last ${RUNS_LOOKED_AT} runs on main finished` } : { state: 'none' };
}

// origin's github.com/owner/name, or undefined with no origin.
function originRepo(root: string): string | undefined {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return url.trim() ? repoKey(url) : undefined;
  } catch {
    return undefined;
  }
}

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';

// Every landing asks GitHub, and a dozen threads landing at once (each with
// gh run watch of its own) ran the shared API allowance out on 13 Nov: gh
// answered 403. So the answer is kept in the repo's git folder, shared by
// every worktree and `tb red-watch`: one from the last minute is used as it
// is, and when GitHub won't answer, one from the last half hour still counts.
export type GateCache = { dir: string; now?: () => number };
export const FRESH_MS = 60_000;
export const STALE_MS = 30 * 60_000;
const MEMO_KEPT = 500;

type Kept = { at: number; verdict: Verdict };

// The repo's shared git folder, for `root` (a worktree or the main checkout).
export function gateCacheDir(root: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out ? path.join(out, 'threadbear-land-gate') : undefined;
  } catch {
    return undefined;
  }
}

// The cancelled runs looked into, in the cache's folder, newest kept.
function memoIn(dir: string): CancelledMemo {
  const at = path.join(dir, 'cancelled-runs.json');
  let seen: Record<string, string[] | null> | undefined;
  const read = (): Record<string, string[] | null> => {
    if (seen) return seen;
    try {
      const v = JSON.parse(fs.readFileSync(at, 'utf8')) as unknown;
      seen = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string[] | null>) : {};
    } catch {
      seen = {};
    }
    return seen;
  };
  return {
    get: (key) => {
      const v = read()[key];
      return v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string')) ? v : undefined;
    },
    set: (key, timedOut) => {
      const all = read();
      delete all[key];
      all[key] = timedOut;
      const keys = Object.keys(all);
      for (const k of keys.slice(0, Math.max(0, keys.length - MEMO_KEPT))) delete all[k];
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(`${at}.${process.pid}.tmp`, JSON.stringify(all));
        fs.renameSync(`${at}.${process.pid}.tmp`, at);
      } catch {
        // Only the sharing goes: it's asked again next time.
      }
    },
  };
}

// lastVerdict through the kept answer, and a line to say when it's an old one.
export async function keptVerdict(root: string, file: string, run: Gh, cache: GateCache | undefined): Promise<{ verdict: Verdict; note?: string }> {
  if (!cache) return { verdict: await lastVerdict(root, file, run) };
  const now = (cache.now ?? Date.now)();
  const at = path.join(cache.dir, `${file}.json`);
  let kept: Kept | undefined;
  try {
    kept = JSON.parse(fs.readFileSync(at, 'utf8')) as Kept;
  } catch {
    // none yet, or unreadable: ask
  }
  const age = kept ? now - kept.at : Infinity;
  if (kept && age >= 0 && age < FRESH_MS) return { verdict: kept.verdict };
  const verdict = await lastVerdict(root, file, run, memoIn(cache.dir));
  if (verdict.state !== 'unknown') {
    try {
      fs.mkdirSync(cache.dir, { recursive: true });
      fs.writeFileSync(`${at}.${process.pid}.tmp`, JSON.stringify({ at: now, verdict }));
      fs.renameSync(`${at}.${process.pid}.tmp`, at);
    } catch {
      // Only the sharing goes.
    }
    return { verdict };
  }
  if (kept && age >= 0 && age < STALE_MS) {
    const mins = Math.max(1, Math.round(age / 60_000));
    return { verdict: kept.verdict, note: `GitHub didn't answer (${verdict.why}), so this goes by what it said ${mins} min ago.` };
  }
  return { verdict };
}

// The marked workflows that count in this checkout: all of them, less those
// whose jobs only run in another repo than origin's.
export function watchedWorkflows(root: string): HeldWorkflow[] {
  let origin: string | undefined | null = null;
  return holdingWorkflows(root).filter((w) => {
    if (!w.onlyIn) return true;
    if (origin === null) origin = originRepo(root);
    return origin?.toLowerCase() === `github.com/${w.onlyIn}`.toLowerCase();
  });
}
