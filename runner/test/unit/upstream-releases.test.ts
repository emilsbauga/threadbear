// upstream: finding and verifying releases (helpers/upstream-harness.ts says why it's several files).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FakeClock } from '../../src/clock.ts';
import { type CiRun, bareRepoArgs, ciVerdict, earlierVerdict, HISTORY_PAGE, FETCH_INTERVAL_MS, FIRST_LOOK_MS, RETRY_AFTER_FAILURE_MS, SETTLE_MS, cleanNotes, parseImportant, parseNotes, repoKey, signersPath, splitSignedTag, tagFor } from '../../src/upstream.ts';
import { nullLogger } from '../../src/log.ts';
import { type GitOptions, gitAsync } from '../../src/upstream.ts';
import { LATER, asGitHub, commit, fakeGpg, git, kept, key, release, signedTag, upstreamFor, waitFor, withVictimGpg, world } from '../helpers/upstream-harness.ts';

test('repoKey: the same repo however its URL is written', () => {
  const k = 'github.com/mikecann/threadbear';
  for (const u of ['https://github.com/mikecann/threadbear.git', 'https://github.com/mikecann/threadbear', 'git@github.com:mikecann/threadbear.git', 'ssh://git@github.com/mikecann/threadbear', 'https://x-access-token@github.com/MikeCann/threadbear/']) {
    assert.equal(repoKey(u), k, u);
  }
  assert.notEqual(repoKey('https://github.com/someone/threadbear.git'), k);
});

test('tagFor: release/ and the local date', () => {
  assert.equal(tagFor(new Date(2026, 9, 5, 23, 59)), 'release/2026-10-05');
});

test('a fork sees a newer signed release from Mike, with what main is missing', async () => {
  const w = world();
  const up = upstreamFor(w.theirs, w.home);
  let s = await up.check();
  assert.equal(s.state, 'idle', s.reason ?? '');
  assert.equal(s.release?.tag, 'release/2026-10-01');
  assert.equal(s.release?.changes, 0);

  commit(w.mike, 'b.txt', 'Second');
  const third = commit(w.mike, 'c.txt', 'Third');
  signedTag(w.mike, 'release/2026-10-30', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  s = await up.check();
  assert.equal(s.state, 'available');
  assert.equal(s.release?.tag, 'release/2026-10-30');
  assert.equal(s.release?.commit, third);
  assert.equal(s.release?.changes, 2);
  assert.deepEqual(s.release?.subjects, ['Third', 'Second']);
  assert.ok(s.checkedAt);
  // Their own tags are left alone: upstream's go in a namespace of their own.
  assert.equal(git(w.theirs, 'tag', '--list', 'release/2026-10-30'), '');

  // Once main has it, there's nothing to bring in.
  git(w.theirs, 'merge', '-q', '--no-edit', 'refs/threadbear/upstream/2026-10-30');
  s = await up.check();
  assert.equal(s.state, 'idle');
  assert.equal(s.release?.changes, 0);
});

// Claude's desktop terminal sets safe.bareRepository=explicit in
// GIT_CONFIG_PARAMETERS, and git then refuses a bare repo it finds by
// looking from inside it, as the check's staging folder was (a fork's
// commit, 8 Nov 2026: every check failed there).
test('the check works under safe.bareRepository=explicit, as in Claude\'s desktop terminal', async () => {
  const w = world();
  commit(w.mike, 'b.txt', 'Second');
  const third = commit(w.mike, 'c.txt', 'Third');
  signedTag(w.mike, 'release/2026-10-30', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const before = process.env.GIT_CONFIG_PARAMETERS;
  process.env.GIT_CONFIG_PARAMETERS = "'safe.bareRepository'='explicit'";
  try {
    // The setting really is on: git refuses a bare repo found from inside.
    const bare = path.join(w.home, 'a-bare-repo');
    git(w.home, 'init', '-q', '--bare', bare);
    assert.notEqual(spawnSync('git', ['-C', bare, 'rev-parse', '--git-dir'], { encoding: 'utf8' }).status, 0);
    assert.deepEqual(bareRepoArgs(bare), ['--git-dir', path.resolve(bare)]);
    assert.deepEqual(bareRepoArgs(w.theirs), [], 'a checkout is found as usual');

    const s = await upstreamFor(w.theirs, w.home).check();
    assert.equal(s.state, 'available', s.reason ?? '');
    assert.equal(s.release?.tag, 'release/2026-10-30');
    assert.equal(s.release?.commit, third);
  } finally {
    if (before === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = before;
  }
});

test('commits Mike marks Important: come with the release, and lead his tag message', async () => {
  const w = world();
  const seen: string[] = [];
  const up = upstreamFor(w.theirs, w.home, new FakeClock(LATER), { onChecked: (s: { state: string }) => seen.push(s.state) });
  commit(w.mike, 'b.txt', 'Ordinary');
  fs.writeFileSync(path.join(w.mike, 'c.txt'), 'x');
  git(w.mike, 'add', 'c.txt');
  git(w.mike, 'commit', '-q', '-m', 'Scrub secrets\n\nWhy it matters.\n\nImportant: keeps API keys out of Convex');
  const fix = git(w.mike, 'rev-parse', 'HEAD');
  signedTag(w.mike, 'release/2026-11-06', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const s = await up.check();
  assert.deepEqual(s.release?.important, [{ commit: fix, why: 'keeps API keys out of Convex' }]);
  assert.deepEqual(seen, ['available']);
  assert.deepEqual(parseImportant(`abc\x1f\ndef\x1fa reason\n`), [{ commit: 'def', why: 'a reason' }]);
});

test('only tags signed with the pinned key, under their own name, count', async () => {
  const w = world();
  const stranger = key(w.root, 'stranger');
  commit(w.mike, 'b.txt', 'Signed by someone else');
  signedTag(w.mike, 'release/2026-10-30', stranger.priv);
  commit(w.mike, 'c.txt', 'Not signed at all');
  git(w.mike, 'tag', '-a', '-m', 'unsigned', 'release/2026-10-31');
  // A real signed tag for the 29th, pushed again as if it were the 1st.
  git(w.mike, 'update-ref', 'refs/tags/release/2026-11-01', git(w.mike, 'rev-parse', 'refs/tags/release/2026-10-01'));
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.equal(s.state, 'idle');
  assert.equal(s.release?.tag, 'release/2026-10-01');
});

test('off without an upstream remote, when upstream is this repo, or with no pinned key', async () => {
  const w = world();
  assert.match((await upstreamFor(w.mike, w.home).check()).reason ?? '', /no upstream remote/);
  git(w.mike, 'remote', 'add', 'upstream', git(w.mike, 'remote', 'get-url', 'origin'));
  assert.match((await upstreamFor(w.mike, w.home).check()).reason ?? '', /upstream is this repo/);
  fs.rmSync(signersPath(w.home));
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.equal(s.state, 'off');
  assert.match(s.reason ?? '', /no release key pinned/);
});

test('a fetch that fails says so and keeps the release it knew of', async () => {
  const w = world();
  commit(w.mike, 'b.txt', 'Second');
  signedTag(w.mike, 'release/2026-10-30', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const up = upstreamFor(w.theirs, w.home);
  assert.equal((await up.check()).state, 'available');
  git(w.theirs, 'remote', 'set-url', 'upstream', path.join(w.root, 'gone.git'));
  const s = await up.check();
  assert.equal(s.state, 'failed');
  assert.equal(s.release?.tag, 'release/2026-10-30');
});

test('the timer looks a while after start, then every six hours', async () => {
  const w = world();
  const clock = new FakeClock();
  let changes = 0;
  const up = upstreamFor(w.theirs, w.home, clock, { onChange: () => changes++ });
  up.start();
  assert.equal(up.status().state, 'off');
  clock.advance(FIRST_LOOK_MS);
  await waitFor(() => up.status().state === 'idle');
  assert.ok(changes >= 1);
  assert.equal(clock.pending(), 1);
  up.stop();
  assert.equal(clock.pending(), 0);
  void FETCH_INTERVAL_MS;
});

// A Mac waking from sleep often has no network for its look, and six hours
// later it's asleep again: a fork's runner failed nearly every look for a
// week and never kept two of Mike's releases (DavidClarkTucson's fork, 15 Nov).
test('a failed look tries again 15 minutes later, then goes back to six hours', async () => {
  const w = world();
  const clock = new FakeClock();
  git(w.theirs, 'remote', 'set-url', 'upstream', path.join(w.root, 'gone.git'));
  const up = upstreamFor(w.theirs, w.home, clock);
  up.start();
  clock.advance(FIRST_LOOK_MS);
  await waitFor(() => up.status().state === 'failed');
  git(w.theirs, 'remote', 'set-url', 'upstream', path.join(w.root, 'mike.git'));
  clock.advance(RETRY_AFTER_FAILURE_MS - 1);
  assert.equal(up.status().state, 'failed');
  clock.advance(1);
  await waitFor(() => up.status().state === 'idle');
  const checkedAt = up.status().checkedAt;
  clock.advance(RETRY_AFTER_FAILURE_MS);
  assert.equal(up.status().checkedAt, checkedAt);
  assert.equal(clock.pending(), 1);
  up.stop();
  assert.equal(RETRY_AFTER_FAILURE_MS, 15 * 60_000);
});

test("Mike's runner tags main once a day, signed, once it has settled", async () => {
  const w = world();
  const tip = commit(w.mike, 'b.txt', 'Newer work');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  let settled = false;
  const clock = new FakeClock(committed + SETTLE_MS / 2);
  const up = upstreamFor(w.mike, w.home, clock, { publish: { publish: true, signingKey: w.mikeKey.priv }, runningMainSettled: () => settled });

  assert.equal(await up.publishOnce(), undefined, 'the runner has not settled');
  settled = true;
  assert.equal(await up.publishOnce(), undefined, "main's tip is too new");
  clock.advance(SETTLE_MS);
  const tag = await up.publishOnce();
  assert.equal(tag, tagFor(new Date(clock.now())));
  assert.equal(git(w.mike, 'rev-parse', `${tag}^{commit}`), tip);
  assert.match(git(w.mike, 'cat-file', 'tag', tag!), /- Newer work/);
  // Pushed, and signed so that a fork's runner takes it.
  assert.ok(git(w.mike, 'ls-remote', 'origin', `refs/tags/${tag}`));
  assert.equal((await upstreamFor(w.theirs, w.home, clock).check()).release?.tag, tag);
  assert.equal(up.status().published?.tag, tag);

  // Not again the same day, and not on a later day with nothing new.
  assert.equal(await up.publishOnce(), undefined);
  clock.advance(24 * 60 * 60_000);
  assert.equal(await up.publishOnce(), undefined);
});

// Notes without their dates, which come from the tags' own times.
const plain = (notes?: { tag: string; date?: string; lines: string[] }[]) => notes?.map(({ tag, lines }) => ({ tag, lines }));

test("release notes: Mike's runner writes them into the tag, and a fork reads each release's", async () => {
  const w = world();
  const prompts: string[] = [];
  let reply: string | undefined = '- Threads can be pinned\n- Search is quicker';
  let failPush = true;
  commit(w.mike, 'b.txt', 'Pinning: a pin button on rows\n\nBecause Mike asked.');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  const clock = new FakeClock(committed + 2 * SETTLE_MS);
  const up = upstreamFor(w.mike, w.home, clock, {
    publish: { publish: true, signingKey: w.mikeKey.priv }, runningMainSettled: () => true,
    writeNotes: async (commits: string) => { prompts.push(commits); if (reply === 'throw') throw new Error('no room'); return reply; },
    git: async (cwd: string, args: string[]) => {
      if (args[0] === 'push' && args.some((a) => a.includes('refs/tags/')) && failPush) { failPush = false; throw new Error('push offline'); }
      return git(cwd, ...args);
    },
  });
  await assert.rejects(up.publishOnce(), /push offline/);
  const first = await up.publishOnce();
  assert.equal(prompts.length, 1, 'a failed push reuses the draft for the same commits');
  assert.match(prompts[0], /Pinning: a pin button on rows\nBecause Mike asked\./);
  const message = git(w.mike, 'cat-file', 'tag', first!);
  assert.match(message, /What's new:\n- Threads can be pinned\n- Search is quicker\n\nEvery change:\n- Pinning: a pin button on rows/);

  // The next day, the model fails: the release goes out without notes.
  commit(w.mike, 'c.txt', 'Tidy the tests');
  git(w.mike, 'push', '-q', 'origin', 'main');
  clock.advance(24 * 60 * 60_000 + 2 * SETTLE_MS);
  reply = 'throw';
  const second = await up.publishOnce();
  assert.ok(second && second !== first);
  assert.doesNotMatch(git(w.mike, 'cat-file', 'tag', second), /What's new:/);

  // A fork behind both sees the first's notes (the second has none).
  const s = await upstreamFor(w.theirs, w.home, clock).check();
  assert.equal(s.release?.tag, second);
  assert.deepEqual(plain(s.release?.notes), [{ tag: second, lines: ['Tidy the tests'] }, { tag: first, lines: ['Threads can be pinned', 'Search is quicker'] }]);
  // Each note carries its own release's time, for the app to head it with
  // the reader's own day rather than the name's (Mike's).
  assert.equal(s.release?.notes?.[0]?.date, s.release?.date);
  assert.ok(s.release?.notes?.every((n) => n.date && !Number.isNaN(Date.parse(n.date))), JSON.stringify(s.release?.notes));
  // Once main has the first, only what's newer counts.
  git(w.theirs, 'merge', '-q', '--no-edit', git(w.mike, 'rev-parse', `${first}^{commit}`));
  assert.deepEqual(plain((await upstreamFor(w.theirs, w.home, clock).check()).release?.notes), [{ tag: second, lines: ['Tidy the tests'] }]);
});

test('release notes exclude signed tags outside the offered history and unsigned notes', async () => {
  const w = world();
  commit(w.mike, 'main.txt', 'Main work');
  const newest = git(w.mike, 'rev-parse', 'HEAD');
  git(w.mike, 'checkout', '-q', '-b', 'side', 'HEAD~1');
  commit(w.mike, 'side.txt', 'Unmerged side work');
  git(w.mike, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${w.mikeKey.priv}`, 'tag', '-s', '-m', "What's new:\n- Not in the offered release", 'release/2026-11-01');
  git(w.mike, 'tag', '-a', '-m', "What's new:\n- Unsigned notes", 'release/2026-11-02');
  git(w.mike, 'checkout', '-q', 'main');
  git(w.mike, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${w.mikeKey.priv}`, 'tag', '-s', '-m', "What's new:\n- Main work", 'release/2026-11-03', newest);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const s = await upstreamFor(w.theirs, w.home).check();
  assert.deepEqual(plain(s.release?.notes), [{ tag: 'release/2026-11-03', lines: ['Main work'] }]);
});

test('parseNotes and cleanNotes', () => {
  assert.deepEqual(parseNotes("Threadbear 2026-11-06\n\nImportant: x\n\nWhat's new:\n- One\n- Two\n\nEvery change:\n- a"), ['One', 'Two']);
  assert.deepEqual(parseNotes('Threadbear 2026-11-01\n\n- an old one with only subjects'), []);
  assert.deepEqual(cleanNotes('Here you go:\n- One — and more\n* Two\nnot a line'), ['One, and more', 'Two']);
  assert.deepEqual(cleanNotes(' NONE '), []);
  assert.deepEqual(cleanNotes(undefined), []);
  assert.deepEqual(cleanNotes('- ' + 'x'.repeat(1000)), ['x'.repeat(200)]);
});

test("ciVerdict: every workflow's latest attempt has to pass", () => {
  const run = (workflow: string, status: string, conclusion: string | null, attempt = 1): CiRun => ({ workflow, name: `wf ${workflow}`, status, conclusion, attempt });
  assert.equal(ciVerdict([run('1', 'completed', 'success'), run('2', 'completed', 'skipped')]), undefined);
  assert.match(ciVerdict([])!, /hasn't run/);
  assert.match(ciVerdict([run('1', 'completed', 'success'), run('2', 'in_progress', null)])!, /still running/);
  assert.equal(ciVerdict([run('1', 'completed', 'failure'), run('2', 'completed', 'cancelled')]), '"wf 1", "wf 2" didn\'t pass on it');
  // A red run re-run green passes; a green one re-run red doesn't.
  assert.equal(ciVerdict([run('1', 'completed', 'failure', 1), run('1', 'completed', 'success', 2)]), undefined);
  assert.match(ciVerdict([run('1', 'completed', 'success', 1), run('1', 'completed', 'failure', 2)])!, /didn't pass/);
});

test("earlierVerdict: a workflow that didn't run on the tip counts by its last finished run on a commit the tip has", () => {
  const run = (sha: string, status: string, conclusion: string | null): CiRun => ({ workflow: '9', name: 'Runner', status, conclusion, attempt: 1, sha });
  const has = new Set(['c3', 'c2', 'c1']);
  assert.equal(earlierVerdict([], has), undefined, 'never ran: nothing to go on');
  assert.equal(earlierVerdict([run('c2', 'completed', 'success'), run('c1', 'completed', 'failure')], has), undefined, 'fixed since');
  assert.equal(earlierVerdict([run('c2', 'completed', 'failure'), run('c1', 'completed', 'success')], has), '"Runner" didn\'t pass on c2, the last commit it ran on');
  // Skipped says nothing: the one before decides.
  assert.equal(earlierVerdict([run('c3', 'completed', 'skipped'), run('c2', 'completed', 'success')], has), undefined);
  assert.match(earlierVerdict([run('c3', 'completed', 'skipped'), run('c2', 'completed', 'failure')], has)!, /didn't pass on c2/);
  // Cancelled, by hand or by a push GitHub has and this main hasn't: its
  // changes were never checked, whatever passed before or since elsewhere.
  assert.equal(earlierVerdict([run('c3', 'completed', 'cancelled'), run('c2', 'completed', 'success')], has), '"Runner" was cancelled on c3, the last commit it ran on');
  assert.match(earlierVerdict([run('x9', 'completed', 'success'), run('c3', 'completed', 'cancelled'), run('c2', 'completed', 'success')], has)!, /cancelled on c3/);
  assert.match(earlierVerdict([run('c3', 'in_progress', null), run('c2', 'completed', 'success')], has)!, /still running on c3/);
  // A push the tip doesn't have (main rewound, or another branch's) isn't evidence.
  assert.equal(earlierVerdict([run('x9', 'completed', 'failure'), run('c1', 'completed', 'success')], has), undefined);
  // A full page with nothing the tip has can't say, so it holds.
  const full = Array.from({ length: HISTORY_PAGE }, (_, i) => run(`y${i}`, 'completed', 'success'));
  assert.match(earlierVerdict(full, has)!, /none of "Runner"'s last 100 runs/);
  assert.equal(earlierVerdict(full.slice(1), has), undefined, 'a short page is all there is');
});

test("Mike's runner holds a release when a workflow that didn't run on the tip was red on the last commit it ran on", async () => {
  const w = world();
  asGitHub(w.mike, w.root);
  fs.mkdirSync(path.join(w.mike, '.github', 'workflows'), { recursive: true });
  commit(w.mike, '.github/workflows/build.yml', 'Build on GitHub');
  const broke = commit(w.mike, '.github/workflows/runner.yml', 'Runner tests on GitHub');
  // Touches only what build.yml watches: runner.yml doesn't run on it.
  const tip = commit(w.mike, 'README.md', 'Docs');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  const clock = new FakeClock(committed + 2 * SETTLE_MS);
  const runnerRun = (sha: string, conclusion: string): CiRun => ({ workflow: '8', name: 'Runner', status: 'completed', conclusion, attempt: 1, file: '.github/workflows/runner.yml', sha });
  let history: CiRun[] = [runnerRun(broke, 'failure')];
  const askedFor: string[] = [];
  const up = upstreamFor(w.mike, w.home, clock, {
    publish: { publish: true, signingKey: w.mikeKey.priv },
    runningMainSettled: () => true,
    ciRuns: async () => [{ workflow: '7', name: 'Build', status: 'completed', conclusion: 'success', attempt: 1, file: '.github/workflows/build.yml', sha: tip }],
    ciHistory: async (_repo: string, file: string) => (askedFor.push(file), history),
  });
  assert.equal(await up.publishOnce(), undefined, "runner.yml's red run holds it");
  // The tip's look asks only for the workflow that sat it out; the look
  // back for an older green commit (none here) then reads each one's.
  assert.deepEqual(askedFor[0], '.github/workflows/runner.yml', 'only the workflow that sat the tip out');
  assert.equal(up.status().held?.commit, tip);
  assert.equal(up.status().held!.why, `"Runner" didn't pass on ${broke.slice(0, 8)}, the last commit it ran on`);
  // Re-run green on that commit: the tip can go.
  history = [runnerRun(broke, 'success')];
  const tag = await up.publishOnce();
  assert.equal(tag, tagFor(new Date(clock.now())));
  assert.equal(git(w.mike, 'rev-parse', `${tag}^{commit}`), tip);
});

test("Mike's runner holds a release until GitHub's checks pass on that commit", async () => {
  const w = world();
  asGitHub(w.mike, w.root);
  fs.mkdirSync(path.join(w.mike, '.github', 'workflows'), { recursive: true });
  const tip = commit(w.mike, '.github/workflows/build.yml', 'Build on GitHub');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  const clock = new FakeClock(committed + 2 * SETTLE_MS);
  let runs: CiRun[] | Error = [{ workflow: '7', name: 'Builds on Xcode 26', status: 'completed', conclusion: 'failure', attempt: 1, file: '.github/workflows/build.yml' }];
  const asked: string[] = [];
  let notesCalls = 0;
  const up = upstreamFor(w.mike, w.home, clock, {
    publish: { publish: true, signingKey: w.mikeKey.priv },
    runningMainSettled: () => true,
    writeNotes: async () => { notesCalls++; return "- Checks keep releases buildable"; },
    ciRuns: async (repo: string, sha: string) => {
      asked.push(`${repo} ${sha}`);
      if (runs instanceof Error) throw runs;
      return runs;
    },
    ciHistory: async () => assert.fail('every workflow ran on the tip'),
  });

  assert.equal(await up.publishOnce(), undefined, 'a red build holds it');
  assert.deepEqual(asked, [`mikecann/threadbear ${tip}`]);
  assert.equal(up.status().held?.commit, tip);
  assert.match(up.status().held!.why, /"Builds on Xcode 26" didn't pass/);
  assert.equal(git(w.mike, 'tag', '--list', 'release/2026-12*'), '');
  // A check of upstream in between leaves it saying so.
  await up.check();
  assert.ok(up.status().held);

  runs = new Error('offline');
  assert.equal(await up.publishOnce(), undefined, "checks it can't read hold it too");
  assert.match(up.status().held!.why, /couldn't read GitHub's checks/);

  assert.equal(notesCalls, 0, 'notes generation waits for the exact commit checks too');
  runs = [{ workflow: '7', name: 'Builds on Xcode 26', status: 'completed', conclusion: 'success', attempt: 2, file: '.github/workflows/build.yml' }];
  const tag = await up.publishOnce();
  assert.equal(tag, tagFor(new Date(clock.now())));
  assert.equal(git(w.mike, 'rev-parse', `${tag}^{commit}`), tip);
  assert.equal(up.status().held, undefined);
  assert.equal(up.status().published?.tag, tag);
  assert.equal(notesCalls, 1);
  assert.match(git(w.mike, "cat-file", "tag", tag!), /What's new:\n- Checks keep releases buildable/);
});

test("a red tip doesn't hold the day's release: the newest commit green on everything goes out, never one inside a push", async () => {
  const w = world();
  asGitHub(w.mike, w.root);
  fs.mkdirSync(path.join(w.mike, '.github', 'workflows'), { recursive: true });
  commit(w.mike, '.github/workflows/build.yml', 'Build on GitHub');
  const c0 = commit(w.mike, '.github/workflows/runner.yml', 'Runner tests on GitHub');
  // Only build.yml's paths: runner.yml counts by its run on c0.
  const g1 = commit(w.mike, 'README.md', 'Docs');
  // Pushed with the tip, so nothing ran on it alone.
  const inside = commit(w.mike, 'a.txt', 'Inside a push');
  const tip = commit(w.mike, 'b.txt', 'Breaks Windows');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  const clock = new FakeClock(committed + 2 * SETTLE_MS);
  const ran = (wf: string, sha: string, conclusion: string): CiRun => ({ workflow: wf === 'build' ? '7' : '8', name: wf === 'build' ? 'Build' : 'Runner', status: 'completed', conclusion, attempt: 1, file: `.github/workflows/${wf}.yml`, sha });
  let history: Record<string, CiRun[]> = {
    '.github/workflows/build.yml': [ran('build', tip, 'success'), ran('build', g1, 'success'), ran('build', c0, 'success')],
    '.github/workflows/runner.yml': [ran('runner', tip, 'failure'), ran('runner', c0, 'success')],
  };
  const make = () =>
    upstreamFor(w.mike, w.home, clock, {
      publish: { publish: true, signingKey: w.mikeKey.priv },
      runningMainSettled: () => true,
      ciRuns: async (_repo: string, sha: string) => [...history['.github/workflows/build.yml']!, ...history['.github/workflows/runner.yml']!].filter((r) => r.sha === sha),
      ciHistory: async (_repo: string, file: string) => history[file] ?? [],
    });
  // Nothing green since the last push head either: held, saying why the tip is.
  history = { ...history, '.github/workflows/runner.yml': [ran('runner', tip, 'failure'), ran('runner', c0, 'cancelled')] };
  const held = make();
  assert.equal(await held.publishOnce(), undefined);
  assert.equal(held.status().held?.commit, tip);
  assert.match(held.status().held!.why, /"Runner" didn't pass on it/);
  // c0 green, g1 green by c0's runner run: g1 goes out, not the commit inside the push.
  history = { ...history, '.github/workflows/runner.yml': [ran('runner', tip, 'failure'), ran('runner', c0, 'success')] };
  const up = make();
  const tag = await up.publishOnce();
  assert.equal(tag, tagFor(new Date(clock.now())));
  assert.equal(git(w.mike, 'rev-parse', `${tag}^{commit}`), g1);
  assert.notEqual(git(w.mike, 'rev-parse', `${tag}^{commit}`), inside);
  assert.equal(up.status().held, undefined);
  assert.doesNotMatch(git(w.mike, 'cat-file', 'tag', tag!), /Breaks Windows|Inside a push/, "the tag's notes are its own commits'");
});

test("Mike's runner pushes a settled main GitHub doesn't have, then waits for its checks", async () => {
  const w = world();
  asGitHub(w.mike, w.root);
  fs.mkdirSync(path.join(w.mike, '.github', 'workflows'), { recursive: true });
  const tip = commit(w.mike, '.github/workflows/build.yml', 'Build on GitHub');
  // Landed here, never pushed.
  assert.notEqual(git(w.mike, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], tip);
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  const up = upstreamFor(w.mike, w.home, new FakeClock(committed + 2 * SETTLE_MS), { publish: { publish: true, signingKey: w.mikeKey.priv }, runningMainSettled: () => true, ciRuns: async () => assert.fail('not asked yet') });
  assert.equal(await up.publishOnce(), undefined);
  assert.equal(git(w.mike, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], tip, 'pushed');
  assert.match(up.status().held!.why, /just pushed main/);

  // A main that's gone a different way from GitHub's isn't pushed over it.
  const w2 = world();
  asGitHub(w2.mike, w2.root);
  commit(w2.mike, 'x.txt', 'Mine');
  const other = path.join(w2.root, 'other');
  git(w2.root, 'clone', '-q', path.join(w2.root, 'mike.git'), other);
  commit(other, 'y.txt', 'Theirs');
  git(other, 'push', '-q', 'origin', 'HEAD:main');
  fs.mkdirSync(path.join(w2.mike, '.github', 'workflows'), { recursive: true });
  commit(w2.mike, '.github/workflows/build.yml', 'Build on GitHub');
  const at = Number(git(w2.mike, 'log', '-1', '--format=%ct')) * 1000;
  const up2 = upstreamFor(w2.mike, w2.home, new FakeClock(at + 2 * SETTLE_MS), { publish: { publish: true, signingKey: w2.mikeKey.priv }, runningMainSettled: () => true });
  assert.equal(await up2.publishOnce(), undefined);
  assert.match(up2.status().held!.why, /different ways/);
  assert.match(git(other, 'log', '-1', '--format=%s', 'origin/main'), /Theirs/);
});

test("a main whose origin isn't GitHub can't show its checks, so it waits", async () => {
  const w = world();
  fs.mkdirSync(path.join(w.mike, '.github', 'workflows'), { recursive: true });
  commit(w.mike, '.github/workflows/build.yml', 'Build on GitHub');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  const up = upstreamFor(w.mike, w.home, new FakeClock(committed + 2 * SETTLE_MS), { publish: { publish: true, signingKey: w.mikeKey.priv }, runningMainSettled: () => true, ciRuns: async () => assert.fail('not asked') });
  assert.equal(await up.publishOnce(), undefined);
  assert.match(up.status().held!.why, /isn't on GitHub/);
});

test('publishing needs a signing key', async () => {
  const w = world();
  const up = upstreamFor(w.mike, w.home, new FakeClock(Date.now() + 2 * SETTLE_MS), { publish: { publish: true, signingKey: path.join(w.root, 'missing') }, runningMainSettled: () => true });
  assert.equal(await up.publishOnce(), undefined);
});

// Gautam's scan, 6 Nov 2026, F5: verify-tag with gpg.format=ssh still hands
// a PGP or X.509 signature to gpg and the whole keyring, so an attacker who
// controls upstream got a release past the pinned key with their own key.
test('a release tag signed with OpenPGP or X.509 never counts, whatever gpg says about it', async () => {
  const w = world();
  const pgp = fakeGpg(w.root, 'PGP SIGNATURE');
  const x509 = fakeGpg(w.root, 'SIGNED MESSAGE');
  commit(w.mike, 'evil.txt', 'Attacker code');
  git(w.mike, '-c', 'gpg.format=openpgp', '-c', `gpg.program=${pgp}`, '-c', 'user.signingkey=MALLORY', 'tag', '-s', '-m', 'Threadbear 2026-12-01', 'release/2026-12-01');
  git(w.mike, '-c', 'gpg.format=x509', '-c', `gpg.x509.program=${x509}`, '-c', 'user.signingkey=MALLORY', 'tag', '-s', '-m', 'Threadbear 2026-12-02', 'release/2026-12-02');
  assert.match(git(w.mike, 'cat-file', 'tag', 'release/2026-12-01'), /-----BEGIN PGP SIGNATURE-----/);
  assert.match(git(w.mike, 'cat-file', 'tag', 'release/2026-12-02'), /-----BEGIN SIGNED MESSAGE-----/);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  // The victim's gpg would call both good.
  const s = await withVictimGpg({ 'gpg.program': pgp, 'gpg.openpgp.program': pgp, 'gpg.x509.program': x509 }, async () => {
    assert.equal(spawnSync('git', ['-C', w.mike, 'verify-tag', 'release/2026-12-01'], { env: process.env }).status, 0, 'gpg calls the PGP tag good');
    return upstreamFor(w.theirs, w.home).check();
  });
  assert.equal(s.release?.tag, 'release/2026-10-01');
  assert.equal(s.state, 'idle');
  assert.equal(spawnSync('git', ['-C', w.theirs, 'rev-parse', '-q', '--verify', 'refs/threadbear/upstream/2026-12-01']).status, 1, 'never copied where a bring-in merges from');
});

test('splitSignedTag: only one SSH signature block, at the end, under the four headers git writes', () => {
  const w = world();
  const raw = spawnSync('git', ['-C', w.mike, 'cat-file', 'tag', 'release/2026-10-01']).stdout as Buffer;
  const text = raw.toString('latin1');
  const ok = splitSignedTag(raw, 'release/2026-10-01');
  assert.ok(ok, 'a tag as Mike signs it');
  assert.equal(ok.commit, git(w.mike, 'rev-parse', 'release/2026-10-01^{commit}'));
  assert.ok(ok.date);
  assert.equal(ok.payload.length + Buffer.byteLength(ok.signature, 'latin1'), raw.length, 'payload and signature are the whole object');
  const sig = text.slice(text.indexOf('-----BEGIN SSH'));
  const pgp = '-----BEGIN PGP SIGNATURE-----\n\nAAAA\n-----END PGP SIGNATURE-----\n';
  const bad: [string, string][] = [
    ['another name', text],
    ['a PGP block after Mike\'s', text + pgp],
    ['a PGP block before it', text.replace(sig, pgp + sig)],
    ['an X.509 block in the message', text.replace(sig, '-----BEGIN SIGNED MESSAGE-----\nAAAA\n-----END SIGNED MESSAGE-----\n' + sig)],
    ['a second SSH block', text + sig],
    ['no signature', text.slice(0, text.indexOf('-----BEGIN SSH'))],
    ['a header added', text.replace('\ntagger ', '\ngpgsig-sha256 x\ntagger ')],
    ['a tag of a tree', text.replace('type commit', 'type tree')],
    ['text after the signature', text + 'more\n'],
  ];
  for (const [what, t] of bad) assert.equal(splitSignedTag(Buffer.from(t, 'latin1'), what === 'another name' ? 'release/2026-10-02' : 'release/2026-10-01'), undefined, what);
  // Armor mentioned in a commit subject (publishOnce starts each with "- ")
  // isn't a block, so it doesn't stop a release.
  const subject = Buffer.from(text.replace(sig, '- Reject -----BEGIN PGP SIGNATURE----- tags\n' + sig), 'latin1');
  assert.ok(splitSignedTag(subject, 'release/2026-10-01'));
});

// F31: the fetch force-moved refs/threadbear/upstream/<date>, the ref a
// bring-in thread merges, to whatever upstream served, before any check.
test('a release swapped upstream after it verified never moves the ref a bring-in merges', async () => {
  const w = world();
  const good = commit(w.mike, 'b.txt', 'Second');
  signedTag(w.mike, 'release/2026-10-30', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const up = upstreamFor(w.theirs, w.home);
  assert.equal((await up.check()).release?.commit, good);

  // The attacker force-pushes the same name, unsigned, at their own commit.
  git(w.mike, 'checkout', '-q', '-b', 'evil');
  const evil = commit(w.mike, 'evil.txt', 'Attacker code');
  git(w.mike, 'tag', '-f', '-a', '-m', 'Threadbear 2026-10-30', 'release/2026-10-30', evil);
  git(w.mike, 'push', '-q', '-f', 'origin', 'refs/tags/release/2026-10-30');
  const s = await up.check();
  assert.equal(kept(w.theirs, '2026-10-30'), good, 'the verified ref keeps the commit that verified');
  assert.equal(s.release?.tag, 'release/2026-10-30');
  assert.equal(s.release?.commit, good);
  // What upstream serves now never reached the checkout: it was staged
  // outside it, didn't verify, and went (Daybreak, 7 Nov 2026).
  assert.equal(git(w.theirs, 'for-each-ref', 'refs/threadbear/upstream-incoming/'), '');
  assert.notEqual(spawnSync('git', ['-C', w.theirs, 'cat-file', '-e', evil]).status, 0, 'the unsigned tag\'s commit is not in the checkout');
});

test('a release name that verified keeps its first tag even if a signed one replaces it upstream', async () => {
  const w = world();
  const first = commit(w.mike, 'b.txt', 'Second');
  signedTag(w.mike, 'release/2026-10-30', w.mikeKey.priv);
  git(w.mike, 'push', '-q', 'origin', 'main', '--tags');
  const up = upstreamFor(w.theirs, w.home);
  await up.check();
  const other = commit(w.mike, 'c.txt', 'Third');
  git(w.mike, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${w.mikeKey.priv}`, 'tag', '-f', '-s', '-m', 'again', 'release/2026-10-30', other);
  git(w.mike, 'push', '-q', '-f', 'origin', 'main', 'refs/tags/release/2026-10-30');
  const s = await up.check();
  assert.equal(kept(w.theirs, '2026-10-30'), first);
  assert.equal(s.release?.commit, first);
});

// 19 Nov 2026: the Secure Enclave handed back a signature with empty r and
// s, git called the tag signed, and release/2026-11-19 went out verifying
// nowhere. Mike's runner now checks its own tag as a fork would first.
test("Mike's runner never pushes a release tag whose signature doesn't verify against release-signers", async () => {
  // The corrupting signer is a shell script, which git on Windows doesn't run as one.
  for (const how of process.platform === 'win32' ? (['unannounced'] as const) : (['corrupt', 'unannounced'] as const)) {
    const w = world();
    commit(w.mike, 'b.txt', 'Newer work');
    git(w.mike, 'push', '-q', 'origin', 'main');
    const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
    let signingKey = w.mikeKey.priv;
    let ownerConfig: string | undefined;
    if (how === 'corrupt') {
      // A signer that says it signed but leaves a signature that's no good,
      // as the provider did: ssh-keygen signs, then the blob is mangled.
      const program = path.join(w.root, 'bad-signer');
      fs.writeFileSync(program, `#!/bin/sh
ssh-keygen "$@" || exit $?
for last; do :; done
case "$*" in *"-Y sign"*)
  # The signature's own bytes sit at the end of the armor.
  awk '{ l[NR] = $0 } END { for (i = 1; i <= NR; i++) { if (l[i + 2] ~ /^-----END/) l[i] = "AAAAAAAA" substr(l[i], 9); print l[i] } }' "$last.sig" > "$last.sig.tmp" && mv "$last.sig.tmp" "$last.sig" ;;
esac
`, { mode: 0o755 });
      // Mike's own git config (global), as his signing setup is: the
      // checkout's own config can't name a signing program (Daybreak 179).
      ownerConfig = path.join(w.root, 'owner.gitconfig');
      fs.writeFileSync(ownerConfig, `[gpg "ssh"]\n\tprogram = ${program}\n`);
    } else {
      signingKey = key(w.root, 'not-announced').priv;
    }
    const logged: string[] = [];
    const log = { ...nullLogger, warn: (m: string) => logged.push(m) };
    const up = upstreamFor(w.mike, w.home, new FakeClock(committed + 2 * SETTLE_MS), { publish: { publish: true, signingKey }, runningMainSettled: () => true, log });
    const global = process.env.GIT_CONFIG_GLOBAL;
    if (ownerConfig) process.env.GIT_CONFIG_GLOBAL = ownerConfig;
    try {
      assert.equal(await up.publishOnce(), undefined, how);
    } finally {
      process.env.GIT_CONFIG_GLOBAL = global;
    }
    const tag = tagFor(new Date(committed + 2 * SETTLE_MS));
    assert.equal(git(w.mike, 'tag', '--list', tag), '', `${how}: the bad tag is deleted`);
    assert.equal(git(w.mike, 'ls-remote', 'origin', `refs/tags/${tag}`), '', `${how}: and never pushed`);
    assert.match(up.status().held?.why ?? '', how === 'corrupt' ? /signature didn't verify, so it wasn't pushed: ssh-keygen says it isn't good/ : /signature didn't verify, so it wasn't pushed: its key wasn't in scripts\/release-signers at release\/2026-10-01/, how);
    assert.ok(logged.some((m) => /does not verify/.test(m)), how);
  }
});

// A world ready to publish today's release: `files` committed on main and
// pushed, the clock past the settle time.
function readyToPublish(files: Record<string, string> = {}) {
  const w = world();
  for (const [f, text] of Object.entries(files)) {
    fs.writeFileSync(path.join(w.mike, f), text);
    git(w.mike, 'add', f);
  }
  const tip = commit(w.mike, 'b.txt', 'Newer work');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const now = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000 + 2 * SETTLE_MS;
  const publisher = (signingKey: string, extra = {}) => upstreamFor(w.mike, w.home, new FakeClock(now), { publish: { publish: true, signingKey }, runningMainSettled: () => true, ...extra });
  return { w, tip, now, publisher };
}

const pub = (k: { signers: string }) => fs.readFileSync(k.signers, 'utf8').trim().split(' ').slice(2, 4).join(' ');
const signers = (...ks: { signers: string }[]) => ks.map((k) => fs.readFileSync(k.signers, 'utf8').trim().replace(/^\S+/, 'threadbear-releases')).join('\n') + '\n';

// Codex's and Gemini's reviews of the check: revoked keys are the last
// release's, so a key revoked there is refused, and one revoking itself
// still goes out (forks take the revocation in, then don't offer it).
test("the release check refuses a key the last release revoked, and lets a key revoke itself", async () => {
  let r = readyToPublish();
  release(r.w, 'release/2026-10-02', r.w.mikeKey.priv, { 'scripts/release-keys-revoked': `${pub(r.w.mikeKey)}\n` });
  commit(r.w.mike, 'c.txt', 'After the revocation');
  git(r.w.mike, 'push', '-q', 'origin', 'main');
  const now = Number(git(r.w.mike, 'log', '-1', '--format=%ct')) * 1000 + 2 * SETTLE_MS;
  const up = upstreamFor(r.w.mike, r.w.home, new FakeClock(now), { publish: { publish: true, signingKey: r.w.mikeKey.priv }, runningMainSettled: () => true });
  assert.equal(await up.publishOnce(), undefined);
  assert.match(up.status().held?.why ?? '', /isn't good for any key/);

  r = readyToPublish({ 'scripts/release-keys-revoked': `${pub(r.w.mikeKey)}\n` });
  const self = r.publisher(r.w.mikeKey.priv);
  assert.ok(await self.publishOnce(), 'a release revoking its own key still goes out');
});

// A key in release-signers counts for forks only a week after a release
// announced it (release-keys.ts): signing with it sooner is held.
test("the release check holds a key forks haven't had a week to take in", async () => {
  const r = readyToPublish();
  const next = key(r.w.root, 'next-key');
  const oldTag = (name: string, daysAgo: number) => {
    const at = Math.floor((r.now - daysAgo * 24 * 60 * 60_000) / 1000);
    const t = spawnSync('git', ['-C', r.w.mike, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${r.w.mikeKey.priv}`, 'tag', '-s', '-m', name, name, 'HEAD'], { env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000` } });
    assert.equal(t.status, 0, String(t.stderr));
    git(r.w.mike, 'push', '-q', 'origin', `refs/tags/${name}`);
  };
  oldTag('release/2026-09-01', 10); // its release-signers has only Mike's key
  fs.writeFileSync(path.join(r.w.mike, 'scripts', 'release-signers'), signers(r.w.mikeKey, next));
  git(r.w.mike, 'add', 'scripts/release-signers');
  const tip = commit(r.w.mike, 'd.txt', 'Announce the next key');
  git(r.w.mike, 'push', '-q', 'origin', 'main');
  const now = Number(git(r.w.mike, 'log', '-1', '--format=%ct')) * 1000 + 2 * SETTLE_MS;
  const publisher = (k: string) => upstreamFor(r.w.mike, r.w.home, new FakeClock(now), { publish: { publish: true, signingKey: k }, runningMainSettled: () => true });
  const early = publisher(next.priv);
  assert.equal(await early.publishOnce(), undefined);
  assert.match(early.status().held?.why ?? '', /wasn't in scripts\/release-signers at release\/2026-09-01, so forks don't take it yet/);
  // A release with it in, more than eight days old: now it counts.
  git(r.w.mike, 'push', '-q', 'origin', ':refs/tags/release/2026-09-01');
  git(r.w.mike, 'tag', '-d', 'release/2026-09-01');
  oldTag('release/2026-09-02', 9);
  const tag = await publisher(next.priv).publishOnce();
  assert.ok(tag);
  assert.equal(git(r.w.mike, 'rev-parse', `${tag}^{commit}`), tip);
});

// Gemini's and Codex's reviews: a tag made here and never pushed (its
// delete failed, perhaps before a restart) passed for today's release on
// the next look, and as the last release after that.
test("a tag that never reached GitHub isn't a release: the next look deletes it and tries again", async () => {
  const r = readyToPublish();
  const stranger = key(r.w.root, 'stranger');
  let failDelete = true;
  const failing = { git: (cwd: string, args: string[], opts?: GitOptions) => (failDelete && args[0] === 'update-ref' && args[1] === '-d' ? Promise.reject(new Error('cannot lock ref')) : gitAsync(cwd, args, opts)) };
  const up = r.publisher(stranger.priv, failing);
  assert.equal(await up.publishOnce(), undefined);
  const tag = tagFor(new Date(r.now));
  const bad = git(r.w.mike, 'rev-parse', `refs/tags/${tag}`);
  assert.match(up.status().held?.why ?? '', /couldn't be deleted yet/);
  // A restarted runner, delete still failing: held, saying so, nothing pushed.
  const again = r.publisher(stranger.priv, failing);
  assert.equal(await again.publishOnce(), undefined);
  assert.match(again.status().held?.why ?? '', new RegExp(`never pushed, and it can't be deleted \\(git tag -d ${tag}\\)`));
  assert.equal(git(r.w.mike, 'ls-remote', 'origin', `refs/tags/${tag}`), '');
  // Once it can be deleted, a good key's release goes out in its place.
  failDelete = false;
  const good = r.publisher(r.w.mikeKey.priv);
  assert.equal(await good.publishOnce(), tag);
  assert.notEqual(git(r.w.mike, 'rev-parse', `refs/tags/${tag}`), bad);
  assert.ok(git(r.w.mike, 'ls-remote', 'origin', `refs/tags/${tag}`));
});

// Codex's third review: a pushed release/latest at main's tip passed for
// the last release, though forks only take date-named ones.
test('a release/ tag not named for a day is not the last release', async () => {
  const r = readyToPublish();
  signedTag(r.w.mike, 'release/latest', r.w.mikeKey.priv);
  git(r.w.mike, 'push', '-q', 'origin', 'refs/tags/release/latest');
  // A branch named like the old release can't hide it from the key check.
  git(r.w.mike, 'branch', 'release/2026-10-01');
  assert.equal(await r.publisher(r.w.mikeKey.priv).publishOnce(), tagFor(new Date(r.now)));
});

test("Mike asking for today's release tags the newest green commit at once, with no hour's wait", async () => {
  const w = world();
  asGitHub(w.mike, w.root);
  fs.mkdirSync(path.join(w.mike, '.github', 'workflows'), { recursive: true });
  const c0 = commit(w.mike, '.github/workflows/build.yml', 'Build on GitHub');
  const tip = commit(w.mike, 'b.txt', 'Still building');
  git(w.mike, 'push', '-q', 'origin', 'main');
  const committed = Number(git(w.mike, 'log', '-1', '--format=%ct')) * 1000;
  // A minute after the last landing, the runner just restarted onto it.
  const clock = new FakeClock(committed + 60_000);
  const ran = (sha: string, status: string, conclusion: string | null): CiRun => ({ workflow: '7', name: 'Build', status, conclusion, attempt: 1, file: '.github/workflows/build.yml', sha });
  const history = [ran(tip, 'in_progress', null), ran(c0, 'completed', 'success')];
  const up = upstreamFor(w.mike, w.home, clock, {
    publish: { publish: true, signingKey: w.mikeKey.priv },
    runningMainSettled: () => false,
    ciRuns: async (_repo: string, sha: string) => history.filter((r) => r.sha === sha),
    ciHistory: async () => history,
  });
  assert.equal(await up.publishOnce(), undefined, 'the hourly look waits for things to settle');
  const tag = await up.publishOnce({ now: true });
  assert.equal(tag, tagFor(new Date(clock.now())));
  assert.equal(git(w.mike, 'rev-parse', `${tag}^{commit}`), c0, "the tip's checks are still running, so the green commit before it");
  assert.ok(git(w.mike, 'ls-remote', 'origin', `refs/tags/${tag}`));
  assert.equal(await up.publishOnce({ now: true }), undefined, 'once a day');
});
