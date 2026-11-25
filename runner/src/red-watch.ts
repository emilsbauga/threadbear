// One thread to fix a watched GitHub workflow gone red on main, and a line in
// tb land while it's red (docs/thread-worktrees.md, "Red on GitHub").
//
// Until 24 Nov a red workflow held every landing that changed what it
// checks (land-gate.ts says why that stopped). Now nothing waits on it.
// Instead `tb red-watch`, run every few minutes by a schedule's check on the
// owner's Mac, asks GitHub how each watched workflow's last run on main went
// (through the answer landings share) and, the first time it's red, starts a
// thread in the repo to fix it, the way the Sentry watch starts its triage
// threads (`tb new --from`). That thread is the one for the red stretch: a
// later failed run is sent to it rather than starting another, and so is
// the news when the workflow passes again. A red stretch after that starts a
// new thread, unless the last one is still open (not archived), which is
// told instead.
//
// It prints nothing unless something's wrong with it, as a schedule's check
// that prints nothing costs no agent (schedule-check.ts).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { filesThatRunIt, gateCacheDir, keptVerdict, watchedWorkflows, type GateCache, type Gh, type HeldWorkflow, type Run, type Verdict } from './land-gate.ts';

export type FixThreadState = 'open' | 'archived' | 'gone';

// The runner's side: what tb red-watch does with threads.
export type FixThreads = {
  state(threadId: string): Promise<FixThreadState>;
  // An open thread this started in that repo (`cwd`) with that title or
  // `why`: one whose start went through though the answer, or the Watch
  // after it, was lost. Both, as an agent may rename it and its first
  // end_turn replaces the why with a byline.
  findOpen(p: { why: string; title: string; cwd: string }): Promise<string | undefined>;
  start(p: { text: string; why: string; title: string; cwd: string }): Promise<string>;
  // `why`: the few words the apps head the runner's note with (sendParams).
  send(threadId: string, text: string, why: string): Promise<void>;
};

// threads.send's params for a message to a fix thread: the runner's own
// note (origin "runner"), not words Mike typed, which is how they were
// stored until 25 Nov and so counted as his. `why` is its wakeReason; the
// Mac lowercases its first letter after "Sent by the runner: ".
export const sendParams = (threadId: string, text: string, why: string) => ({ threadId, text, images: [], origin: 'runner' as const, wakeReason: why });

// What the watch knows of one workflow between looks: the whole lifecycle,
// with every move made in `step` below.
//   (none) / green -> red    gone red: a fix thread is started, or the last
//                            one, still open, is told it's red again
//   red -> red               failed again on a newer run: its thread is told
//   red -> green             passed: its thread is told
// GitHub not answering, or no finished run, moves nothing.
export type Watch =
  | { state: 'green'; since: string; thread?: string }
  // `told`: the newest failed run its thread has heard of (its createdAt),
  // and `toldAt` that run's updatedAt, which a rerun of it moves.
  | { state: 'red'; since: string; thread: string; run: number; told: string; toldAt?: string };

const shortSha = (r: Run): string => r.headSha.slice(0, 8);
const runLine = (r: Run): string => `${r.url} (${shortSha(r)}${r.displayTitle ? `: ${r.displayTitle}` : ''}, ${r.createdAt})`;
const named = (w: HeldWorkflow): string => `${w.name} (${w.file})`;
const failedLine = (v: Extract<Verdict, { state: 'red' }>): string[] => (v.failedJobs.length ? [`Failed: ${v.failedJobs.join('; ')}`] : []);

function redText(w: HeldWorkflow, v: Extract<Verdict, { state: 'red' }>, again: boolean): string {
  const timedOut = v.failedJobs.some((j) => j.includes('(timed out after'));
  return [
    `${named(w)} is red on main${again ? ' again' : ''}. Find out why, fix it in your worktree and land the fix with tb land.`,
    '',
    `Run: ${runLine(v.run)}`,
    ...failedLine(v),
    ...(v.newer ? [`A newer run is still going: ${v.newer.url}`] : []),
    '',
    `gh run view ${v.run.databaseId} --log-failed shows what failed${timedOut ? `; a job that timed out ran into its own timeout-minutes, and gh run view ${v.run.databaseId} --log shows how far it got (runner.yml's unit tests print the files still running each minute)` : ''}.`,
    "Landings don't wait for it, so main may have moved on: look at main's newest runs first, as the fix may be in already.",
    `If it's GitHub's doing rather than the code's (a runner that never started, an outage), run it again: gh run rerun ${v.run.databaseId} --failed.`,
    `This is the one thread for it until it's green: Threadbear tells you here when ${w.file} fails again or passes on main.`,
  ].join('\n');
}

const againText = (w: HeldWorkflow, v: Extract<Verdict, { state: 'red' }>): string =>
  [`${named(w)} failed on main again: ${runLine(v.run)}`, ...failedLine(v), `If your fix is on main, check this run's commit has it (git merge-base --is-ancestor <your commit> ${shortSha(v.run)}).`].join('\n');

const greenText = (w: HeldWorkflow, v: Extract<Verdict, { state: 'green' }>): string =>
  `${named(w)} is green on main again${v.run ? `: ${runLine(v.run)}` : ''}. Nothing more is needed for it.`;

// The move for one look, and what to do for it. Pure, apart from asking
// whether the last thread is still there.
type Act = { kind: 'start'; text: string; why: string; title: string } | { kind: 'send'; thread: string; text: string; why: string };
export async function step(w: HeldWorkflow, was: Watch | undefined, v: Verdict, threads: Pick<FixThreads, 'state'>, now: string): Promise<{ next?: Watch; act?: Act }> {
  if (v.state === 'unknown' || v.state === 'none') return {};
  if (v.state === 'green') {
    if (was?.state !== 'red') return was ? {} : { next: { state: 'green', since: now } };
    const next: Watch = { state: 'green', since: now, thread: was.thread };
    return (await threads.state(was.thread)) === 'gone' ? { next } : { next, act: { kind: 'send', thread: was.thread, text: greenText(w, v), why: "Main's CI passed again" } };
  }
  const red = (thread: string): Watch => redWatch(thread, v, was?.state === 'red' ? was.since : now);
  if (was?.state === 'red') {
    // A newer run, or the same one run again (gh run rerun) and failed again.
    const rerun = v.run.databaseId === was.run && (v.run.updatedAt ?? '') > (was.toldAt ?? '');
    if (v.run.createdAt <= was.told && !rerun) return {};
    // Deleted: someone didn't want it, so it isn't started again.
    if ((await threads.state(was.thread)) === 'gone') return { next: red(was.thread) };
    return { next: red(was.thread), act: { kind: 'send', thread: was.thread, text: againText(w, v), why: "Main's CI failed again" } };
  }
  if (was?.thread && (await threads.state(was.thread)) === 'open') return { next: red(was.thread), act: { kind: 'send', thread: was.thread, text: redText(w, v, true), why: "Main's CI went red again" } };
  return { act: { kind: 'start', text: redText(w, v, false), why: `${w.file} red on main`, title: `Fix ${named(w)}, red on main` } };
}

export const redWatch = (thread: string, v: Extract<Verdict, { state: 'red' }>, since: string): Watch => ({
  state: 'red',
  since,
  thread,
  run: v.run.databaseId,
  told: v.run.createdAt,
  ...(v.run.updatedAt ? { toldAt: v.run.updatedAt } : {}),
});

// Where each workflow's Watch is kept: beside GitHub's shared answers.
export const watchDir = (cacheDir: string): string => path.join(cacheDir, 'red-watch');

export function readWatch(cacheDir: string, file: string): Watch | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(watchDir(cacheDir), `${file}.json`), 'utf8')) as Watch;
    if (v?.state === 'green' && typeof v.since === 'string') return v;
    if (v?.state === 'red' && typeof v.thread === 'string' && typeof v.told === 'string') return v;
  } catch {
    // none yet
  }
  return undefined;
}

function writeWatch(cacheDir: string, file: string, w: Watch): void {
  const at = path.join(watchDir(cacheDir), `${file}.json`);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(`${at}.${process.pid}.tmp`, JSON.stringify(w));
  fs.renameSync(`${at}.${process.pid}.tmp`, at);
}

// One look at a workflow at a time, so two watches never both start a
// thread. A lock left by one that died goes after a few minutes.
const LOCK_STALE_MS = 5 * 60_000;
// By the real clock, as the lock file's time is.
function lock(cacheDir: string, file: string): (() => void) | undefined {
  const at = path.join(watchDir(cacheDir), `${file}.lock`);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(at, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(at, { force: true });
    } catch {
      let age = 0;
      try {
        age = Date.now() - fs.statSync(at).mtimeMs;
      } catch {
        continue;
      }
      if (age < LOCK_STALE_MS) return undefined;
      fs.rmSync(at, { force: true });
    }
  }
  return undefined;
}

// The checkout a fix thread starts in: the repo's main one, which gets it
// a worktree of its own.
export function mainCheckoutOf(root: string): string {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (path.basename(common) === '.git') return path.dirname(common);
  } catch {
    // as given
  }
  return root;
}

export type WatchDeps = { gh: Gh; threads: FixThreads; cache?: GateCache; now?: () => number };

// A look at every watched workflow, as tb red-watch does. Says what it did,
// for a person running it by hand; throws only when a thread couldn't be
// started or told, which the next look tries again.
export async function watchRed(root: string, deps: WatchDeps): Promise<string[]> {
  const dir = deps.cache?.dir ?? gateCacheDir(root);
  if (!dir) throw new Error(`${root} isn't in a git checkout, so there's nowhere to keep what's red.`);
  const cache: GateCache = deps.cache ?? { dir };
  const now = deps.now ?? Date.now;
  const cwd = mainCheckoutOf(root);
  const did: string[] = [];
  const failed: string[] = [];
  for (const w of watchedWorkflows(root)) {
    const unlock = lock(dir, w.file);
    if (!unlock) {
      did.push(`${named(w)}: another look has it.`);
      continue;
    }
    try {
      const { verdict } = await keptVerdict(root, w.file, deps.gh, cache);
      const was = readWatch(dir, w.file);
      const at = new Date(now()).toISOString();
      const { next, act } = await step(w, was, verdict, deps.threads, at);
      if (act?.kind === 'start' && verdict.state === 'red') {
        const p = { why: act.why, title: act.title, cwd };
        const found = await deps.threads.findOpen(p);
        const thread = found ?? (await deps.threads.start({ ...p, text: act.text }));
        writeWatch(dir, w.file, redWatch(thread, verdict, at));
        did.push(found ? `${named(w)} is red on main: fix thread ${thread} was already started.` : `${named(w)} is red on main: started fix thread ${thread}.`);
        continue;
      }
      if (act?.kind === 'send') {
        await deps.threads.send(act.thread, act.text, act.why);
        did.push(`${named(w)}: told ${act.thread} it's ${verdict.state === 'green' ? 'green again' : 'red'}.`);
      }
      if (next) writeWatch(dir, w.file, next);
    } catch (e) {
      failed.push(`${named(w)}: ${(e as Error).message}`);
    } finally {
      unlock();
    }
  }
  if (failed.length) throw new Error(`tb red-watch couldn't start or tell a fix thread, so it tries again next time:\n${failed.join('\n')}`);
  return did;
}

// tb land's one line for each watched workflow it sets off that's red on
// main, once a landing (`said` keeps which): it lands anyway.
export async function sayRedOnLanding(root: string, files: string[], note: (line: string) => void, run: Gh, cache: GateCache | undefined, said: Set<string>): Promise<void> {
  for (const w of watchedWorkflows(root)) {
    if (said.has(w.file) || !filesThatRunIt(w.paths, files).length) continue;
    const { verdict: v } = await keptVerdict(root, w.file, run, cache);
    if (v.state !== 'red') continue;
    said.add(w.file);
    const watch = cache ? readWatch(cache.dir, w.file) : undefined;
    const jobs = v.failedJobs.length > 2 ? `${v.failedJobs.slice(0, 2).join('; ')} and ${v.failedJobs.length - 2} more` : v.failedJobs.join('; ');
    const who = watch?.state === 'red' ? `fix thread ${watch.thread.slice(0, 8)} is on it` : 'no fix thread is on it yet';
    note(`${named(w)} is red on main (${v.run.url}${jobs ? `, failed: ${jobs}` : ''}); this lands anyway, and ${who}.`);
  }
}
