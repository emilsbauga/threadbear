// Which GitHub workflows tb watches on main and how their last run went, and
// tb land's line while one it sets off is red (land-gate.ts, red-watch.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';
import { CANCELLED_LOOKED_AT, FRESH_MS, filesThatRunIt, holdingWorkflows, keptVerdict, lastVerdict, pushPaths, STALE_MS, watchedWorkflows, type Gh } from '../../src/land-gate.ts';
import { sayRedOnLanding } from '../../src/red-watch.ts';
import { land } from '../../src/worktrees.ts';
import { capture, commit, makeBranch, makeRepo, sh } from '../helpers/worktrees-harness.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const WORKFLOW = `# What it checks.
# tb land: hold while red
name: Desktop app

on:
  push:
    branches: [main]
    paths:
      - desktop/**
      - 'runner/src/protocol.ts'   # the contract
      - "features/**"
      - '!features/README.md'
  pull_request:
    paths:
      - pr-only/**
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-24.04
`;

function workflows(files: Record<string, string>): string {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, '.github/workflows', name), text);
  return root;
}

// gh as GitHub would answer: the runs, newest first, each run's jobs, and
// each job's annotations.
function fakeGh(runs: object[] | 'offline', jobs: Record<number, object[]> = {}, notes: Record<number, object[]> = {}): Gh & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = async (args: string[]) => {
    calls.push(args);
    if (runs === 'offline') return { ok: false, stdout: '', stderr: 'error connecting to api.github.com\nmore' };
    if (args[1] === 'list') return { ok: true, stdout: JSON.stringify(runs), stderr: '' };
    // gh api --paginate --jq '.[].message': each page's messages, a line each.
    if (args[0] === 'api') return { ok: true, stdout: ((notes[Number(/check-runs\/(\d+)\//.exec(args.join(' '))?.[1])] ?? []) as { message: string }[]).map((n) => `${n.message}\n`).join(''), stderr: '' };
    return { ok: true, stdout: JSON.stringify({ jobs: jobs[Number(args[2])] ?? [] }), stderr: '' };
  };
  return Object.assign(fn, { calls });
}

const run = (id: number, conclusion: string, at: string, status = 'completed', updatedAt?: string) => ({ databaseId: id, status, conclusion, headSha: `${id}abcdef0123`, url: `https://github.com/o/r/actions/runs/${id}`, createdAt: at, ...(updatedAt ? { updatedAt } : {}), displayTitle: `Commit ${id}` });

test("a workflow's push paths are read from its trigger, not the pull request's", () => {
  assert.deepEqual(pushPaths(WORKFLOW), ['desktop/**', 'runner/src/protocol.ts', 'features/**', '!features/README.md']);
  assert.deepEqual(pushPaths('on:\n  push:\n    branches: [main]\n    paths: [a/**, b]\n'), ['a/**', 'b']);
  // Items level with their key, as YAML allows.
  assert.deepEqual(pushPaths('on:\n  push:\n    paths:\n    - a/**\n    - b\n    branches: [main]\n'), ['a/**', 'b']);
  // No paths: every push runs it.
  assert.equal(pushPaths('on:\n  push:\n    branches: [main]\n  pull_request:\n    paths:\n      - x/**\n'), undefined);
  assert.equal(pushPaths('on: [push]\n'), undefined);
  // What it can't read holds every landing rather than none (Codex's review).
  assert.equal(pushPaths('on:\n  push:\n    paths: *desktop_paths\n'), undefined);
  assert.equal(pushPaths('on:\n  push:\n    paths: [\n      a/**,\n    ]\n'), undefined);
});

test("path filters match as GitHub's do", () => {
  assert.deepEqual(filesThatRunIt(['desktop/**/file.rs'], ['desktop/file.rs', 'desktop/a/b/file.rs', 'desktop/notfile.rs']), ['desktop/file.rs', 'desktop/a/b/file.rs']);
  assert.deepEqual(filesThatRunIt(['src/[ab].ts', 'docs/v[0-9].md'], ['src/a.ts', 'src/c.ts', 'docs/v2.md', 'docs/vx.md']), ['src/a.ts', 'docs/v2.md']);
  assert.deepEqual(filesThatRunIt(['**', '!**.md'], ['a/b.rs', 'a/b.md']), ['a/b.rs']);
  assert.deepEqual(filesThatRunIt(['desktop/file[0-9]+.rs', 'x/ab?c'], ['desktop/file12.rs', 'desktop/file.rs', 'x/ac', 'x/abc', 'x/abbc']), ['desktop/file12.rs', 'x/ac', 'x/abc']);
  assert.equal(pushPaths(`on:\n  push:\n    paths: ['desktop/a,b.rs']\n`), undefined);
});

test("this repo's Desktop app workflow is watched for landings to desktop/ and features/", () => {
  const held = holdingWorkflows(repoRoot);
  const desktop = held.find((w) => w.file === 'desktop.yml');
  assert.ok(desktop, 'desktop.yml has the mark');
  assert.equal(desktop.name, 'Desktop app');
  assert.equal(desktop.onlyIn, 'mikecann/threadbear', "its jobs don't run in forks");
  assert.deepEqual(filesThatRunIt(desktop.paths, ['desktop/gpui/src/terminal.rs', 'features/terminal.feature', 'runner/src/cli.ts', 'docs/guide.md']), ['desktop/gpui/src/terminal.rs', 'features/terminal.feature']);
});

test('only marked workflows are watched, and their paths say which files', () => {
  const root = workflows({ 'desktop.yml': WORKFLOW, 'other.yml': WORKFLOW.replace('# tb land: hold while red\n', ''), 'notes.txt': '# tb land: hold while red' });
  assert.deepEqual(holdingWorkflows(root).map((w) => w.file), ['desktop.yml']);
  const paths = holdingWorkflows(root)[0].paths;
  assert.deepEqual(filesThatRunIt(paths, ['desktop/a/b.rs', 'features/x.feature', 'features/README.md', 'runner/src/protocol.ts', 'runner/src/protocol.tsx', 'pr-only/x', 'desktopish/a']), ['desktop/a/b.rs', 'features/x.feature', 'runner/src/protocol.ts']);
  assert.deepEqual(filesThatRunIt(undefined, ['anything']), ['anything']);
  assert.deepEqual(filesThatRunIt(['*.md'], ['a.md', 'docs/a.md']), ['a.md']);
  assert.deepEqual(holdingWorkflows(tmpDir()), []);
});

test("the last finished run on main is the verdict, past cancelled ones", async () => {
  const root = tmpDir();
  // Newest first: one going, one cancelled for a newer push, then a failure.
  const gh = fakeGh([run(4, '', '2026-11-12T03:00:00Z', 'in_progress'), run(3, 'cancelled', '2026-11-12T02:00:00Z'), run(2, 'failure', '2026-11-12T01:00:00Z'), run(1, 'success', '2026-11-11T01:00:00Z')], {
    2: [{ name: 'Mac', conclusion: 'failure', steps: [{ name: 'Set up', conclusion: 'success' }, { name: 'Behaviour specs', conclusion: 'failure' }] }, { name: 'Linux', conclusion: 'success' }, { name: 'Windows', conclusion: 'failure' }],
  });
  const v = await lastVerdict(root, 'desktop.yml', gh);
  assert.equal(v.state, 'red');
  assert.ok(v.state === 'red');
  assert.equal(v.run.databaseId, 2);
  assert.deepEqual(v.failedJobs, ['Mac (Behaviour specs)', 'Windows']);
  assert.equal(v.newer?.databaseId, 4);
  assert.deepEqual(gh.calls[0].slice(0, 9), ['run', 'list', '--workflow', 'desktop.yml', '--branch', 'main', '--event', 'push', '--limit']);
  assert.equal((await lastVerdict(root, 'x.yml', fakeGh([run(5, 'success', 'b'), run(2, 'failure', 'a')]))).state, 'green');
  assert.equal((await lastVerdict(root, 'x.yml', fakeGh([run(5, '', 'b', 'queued')]))).state, 'none');
  assert.deepEqual(await lastVerdict(root, 'x.yml', fakeGh('offline')), { state: 'unknown', why: 'error connecting to api.github.com' });
  // A whole page of cancelled runs can't say the failure before them was fixed.
  const cancelled = Array.from({ length: 100 }, (_, i) => run(200 - i, 'cancelled', `c${i}`));
  assert.equal((await lastVerdict(root, 'x.yml', fakeGh(cancelled))).state, 'unknown');
});

// From 22 Nov runner.yml's Mac jobs ran into their 30 minutes on every
// push, and each run came out cancelled, which was passed over as a newer
// push's doing.
test('a run cancelled by a job running into its own timeout is red; one cancelled for a newer push or by hand is passed over', async () => {
  const root = workflows({ 'runner.yml': WORKFLOW });
  const job = (id: number, name: string, conclusion: string, mins: number) => ({ databaseId: id, name, conclusion, startedAt: '2026-11-23T16:00:00Z', completedAt: new Date(Date.parse('2026-11-23T16:00:00Z') + mins * 60_000).toISOString(), steps: [{ name: 'Set up', conclusion: 'success' }, { name: 'Runner tests', conclusion }] });
  const gh = fakeGh(
    [
      // Waited behind another and was replaced by a newer push: never ran a job.
      run(5, 'cancelled', '2026-11-23T17:00:00Z', 'completed', '2026-11-23T18:10:00Z'),
      // Stopped by hand after 40 minutes.
      run(4, 'cancelled', '2026-11-23T16:20:00Z', 'completed', '2026-11-23T17:00:00Z'),
      // Its one job stopped by hand within the minute: its annotations aren't asked for.
      run(3, 'cancelled', '2026-11-23T16:10:00Z', 'completed', '2026-11-23T16:15:00Z'),
      // Its Mac job ran into 30 minutes.
      run(2, 'cancelled', '2026-11-23T16:00:00Z', 'completed', '2026-11-23T16:31:00Z'),
      run(1, 'success', '2026-11-23T15:00:00Z'),
    ],
    { 4: [job(41, 'Linux', 'cancelled', 40)], 3: [job(31, 'Linux', 'cancelled', 0.5)], 2: [job(21, 'macos-26', 'cancelled', 30.5), job(22, 'ubuntu', 'success', 12), job(23, 'windows', 'cancelled', 3)] },
    { 41: [{ message: 'The operation was canceled.' }], 21: [{ message: 'The job has exceeded the maximum execution time of 30m0s' }, { message: 'The operation was canceled.' }], 23: [{ message: 'The operation was canceled.' }] },
  );
  const kept = new Map<string, string[] | null>();
  const memo = { get: (k: string) => kept.get(k), set: (k: string, v: string[] | null) => void kept.set(k, v) };
  const v = await lastVerdict(root, 'runner.yml', gh, memo);
  assert.equal(v.state, 'red');
  assert.ok(v.state === 'red');
  assert.equal(v.run.databaseId, 2);
  assert.deepEqual(v.failedJobs, ['macos-26 (timed out after 30m0s in Runner tests)']);
  const asked = gh.calls.map((c) => c.join(' '));
  assert.ok(!asked.some((c) => c.includes('check-runs/31/')), 'a job cancelled within its first minute');
  // However short next to the workflow's timeouts now: one raised by the fix mustn't hide this run.
  assert.ok(asked.includes("api --paginate repos/o/r/check-runs/23/annotations?per_page=100 --jq .[].message"));
  assert.ok(asked.includes("api --paginate repos/o/r/check-runs/21/annotations?per_page=100 --jq .[].message"));
  // What was found about each run is kept, so the next look asks only for the list.
  const again = gh.calls.length;
  assert.equal((await lastVerdict(root, 'runner.yml', gh, memo)).state, 'red');
  assert.equal(gh.calls.length, again + 1);
  // Cancelled for newer pushes all the way back to a pass: green.
  const passed = fakeGh([run(9, 'cancelled', '2026-11-23T17:00:00Z', 'completed', '2026-11-23T18:10:00Z'), run(8, 'success', '2026-11-23T16:00:00Z')]);
  assert.equal((await lastVerdict(root, 'runner.yml', passed)).state, 'green');
  // GitHub not saying why one was cancelled isn't a pass.
  const offlineJobs: Gh = async (args) => (args[1] === 'list' ? { ok: true, stdout: JSON.stringify([run(9, 'cancelled', 'a', 'completed', 'b'), run(8, 'success', 'a')]), stderr: '' } : { ok: false, stdout: '', stderr: 'HTTP 403' });
  assert.equal((await lastVerdict(root, 'runner.yml', offlineJobs)).state, 'unknown');
  // A long day of cancelled runs is looked through a few at a time.
  const many = fakeGh(Array.from({ length: CANCELLED_LOOKED_AT + 1 }, (_, i) => run(100 - i, 'cancelled', `2026-11-23T1${i % 10}:00:00Z`)));
  assert.equal((await lastVerdict(root, 'runner.yml', many)).state, 'unknown');
});

test('a landing that sets off a red workflow gets one line saying so, and lands', async () => {
  const root = workflows({ 'desktop.yml': WORKFLOW });
  const gh = fakeGh([run(7, 'failure', '2026-11-12T01:00:00Z')], { 7: [{ name: 'Linux', conclusion: 'failure', steps: [{ name: 'Behaviour specs', conclusion: 'failure' }] }, { name: 'Mac', conclusion: 'failure' }, { name: 'Windows', conclusion: 'failure' }] });
  const notes: string[] = [];
  const said = new Set<string>();
  await sayRedOnLanding(root, ['desktop/gpui/src/a.rs', 'docs/x.md'], (l) => notes.push(l), gh, undefined, said);
  assert.equal(notes.length, 1);
  assert.equal(notes[0], 'Desktop app (desktop.yml) is red on main (https://github.com/o/r/actions/runs/7, failed: Linux (Behaviour specs); Mac and 1 more); this lands anyway, and no fix thread is on it yet.');
  // Asked again before main moves: not said twice.
  await sayRedOnLanding(root, ['desktop/gpui/src/a.rs'], (l) => notes.push(l), gh, undefined, said);
  assert.equal(notes.length, 1);
  // Files it doesn't check never ask GitHub at all.
  const quiet = fakeGh([run(7, 'failure', 'a')]);
  await sayRedOnLanding(root, ['docs/x.md', 'features/README.md'], (l) => notes.push(l), quiet, undefined, new Set());
  assert.deepEqual(quiet.calls, []);
  // Green, or GitHub out of reach: nothing to say.
  await sayRedOnLanding(root, ['desktop/a'], (l) => notes.push(l), fakeGh([run(8, 'success', 'a')]), undefined, new Set());
  await sayRedOnLanding(root, ['desktop/a'], (l) => notes.push(l), fakeGh('offline'), undefined, new Set());
  assert.equal(notes.length, 1);
  // With its fix thread started, the line names it.
  const dir = path.join(tmpDir(), 'gate');
  fs.mkdirSync(path.join(dir, 'red-watch'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'red-watch', 'desktop.yml.json'), JSON.stringify({ state: 'red', since: 'x', thread: 'abcdef12-3456', run: 7, told: '2026-11-12T01:00:00Z' }));
  const named: string[] = [];
  await sayRedOnLanding(root, ['desktop/a'], (l) => named.push(l), gh, { dir }, new Set());
  assert.match(named[0], /this lands anyway, and fix thread abcdef12 is on it\.$/);
});

test("a workflow that only runs in Mike's repo counts only there, not in a fork", async () => {
  const guarded = WORKFLOW.replace('on:\n', "jobs:\n  build:\n    if: github.repository == 'mikecann/threadbear' || github.event_name == 'workflow_dispatch'\n\non:\n");
  const root = workflows({ 'desktop.yml': guarded });
  assert.equal(holdingWorkflows(root)[0].onlyIn, 'mikecann/threadbear');
  const red = () => fakeGh([run(7, 'failure', 'a')], { 7: [{ name: 'Windows', conclusion: 'failure' }] });
  sh(root, 'git init -q');
  // A fork: its own main, which these jobs never run on (gh would read upstream's runs).
  sh(root, 'git remote add origin git@github.com:someone/threadbear.git && git remote add upstream https://github.com/mikecann/threadbear.git');
  const fork = red();
  const said: string[] = [];
  assert.deepEqual(watchedWorkflows(root), []);
  await sayRedOnLanding(root, ['desktop/a'], (l) => said.push(l), fork, undefined, new Set());
  assert.deepEqual(fork.calls, []);
  assert.equal(said.length, 0);
  // Mike's own copy, however origin's URL is written.
  sh(root, 'git remote remove upstream && git remote set-url origin https://github.com/MikeCann/threadbear.git');
  assert.deepEqual(watchedWorkflows(root).map((w) => w.file), ['desktop.yml']);
  await sayRedOnLanding(root, ['desktop/a'], (l) => said.push(l), red(), undefined, new Set());
  assert.equal(said.length, 1);
  // One that names no repo counts anywhere, as before.
  assert.equal(holdingWorkflows(workflows({ 'desktop.yml': WORKFLOW }))[0].onlyIn, undefined);
});

test("GitHub's answer is shared for a minute, and an old one still counts for half an hour when GitHub won't answer", async () => {
  const root = workflows({ 'desktop.yml': WORKFLOW });
  let now = 1_000_000;
  const cache = { dir: path.join(tmpDir(), 'gate'), now: () => now };
  const red = fakeGh([run(7, 'failure', 'a')], { 7: [{ name: 'Linux', conclusion: 'failure' }] });
  const state = async (gh: Gh) => (await keptVerdict(root, 'desktop.yml', gh, cache)).verdict.state;
  assert.equal(await state(red), 'red');
  // Within the minute another look doesn't ask again.
  now += FRESH_MS - 1;
  const quiet = fakeGh([run(8, 'success', 'b')]);
  assert.equal(await state(quiet), 'red');
  assert.deepEqual(quiet.calls, []);
  // After it, GitHub out of reach (a 403 for the rate limit): the old answer, saying why.
  now += 2;
  const old = await keptVerdict(root, 'desktop.yml', fakeGh('offline'), cache);
  assert.equal(old.verdict.state, 'red');
  assert.match(old.note ?? '', /GitHub didn't answer \(error connecting to api\.github\.com\), so this goes by what it said 1 min ago/);
  // A green answer replaces it.
  assert.equal(await state(fakeGh([run(9, 'success', 'c')])), 'green');
  // Older than half an hour, it's no answer at all.
  now += FRESH_MS;
  assert.equal(await state(red), 'red');
  now += STALE_MS;
  assert.equal(await state(fakeGh('offline')), 'unknown');
});

test('tb land asks after the rebase, about what the branch changes, and a hold leaves main as it was before any check', async () => {
  const { main } = makeRepo();
  const t = makeBranch(main);
  commit(main, { 'on-main.txt': 'main moved\n' }, 'Main moves');
  commit(t.path, { 'desktop/a.rs': 'fn a() {}\n', 'desktop/café.rs': '\n' }, 'Desktop change');
  const before = sh(main, 'git rev-parse main');
  const asked: { root: string; files: string[] }[] = [];
  const c = capture();
  const code = await land({ ...t, check: 'touch checked' }, { ...c.opts, hold: async (root, files) => (asked.push({ root, files }), 'Held: red on main.') });
  assert.equal(code, 1);
  assert.match(c.err.join('\n'), /Held: red on main\./);
  // A name with other letters in it as it is, not git's quoted form.
  assert.deepEqual(asked, [{ root: t.path, files: ['desktop/a.rs', 'desktop/café.rs'] }]);
  assert.equal(sh(main, 'git rev-parse main'), before);
  assert.ok(!fs.existsSync(path.join(t.path, 'checked')), 'the check never ran');
  // Gone red while the check ran: asked again before main moves.
  let calls = 0;
  const late = capture();
  assert.equal(await land({ ...t, check: 'true' }, { ...late.opts, hold: async () => (++calls === 2 ? 'Red now.' : undefined) }), 1);
  assert.match(late.err.join('\n'), /Red now\./);
  assert.equal(sh(main, 'git rev-parse main'), before);
  // Not held: it lands as before.
  const ok = capture();
  assert.equal(await land({ ...t, check: 'true' }, { ...ok.opts, hold: async () => undefined }), 0, ok.err.join('\n'));
  assert.equal(sh(main, 'git rev-parse main'), sh(t.path, 'git rev-parse HEAD'));
});
