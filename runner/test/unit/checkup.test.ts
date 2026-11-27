import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { key } from '../helpers/upstream-harness.ts';
import { signersPath } from '../../src/upstream.ts';
import { buildCheckup, BURST_GAP_MS, checkupOff, countErrors, landingChecks, failingPatches, formatCheckup, parseLogLine, postDraft, readState, releasesOnMain, safeErrorCause, saveDraft, scrubForPosting, skipped, topStackSourceFile, type Checkup } from '../../src/checkup.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-19T12:00:00Z');

function logLine(at: number, level: string, msg: string, extra?: object): string {
  return `${new Date(at).toISOString()} ${level} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
}

test('a log line loses its details, which can carry paths and thread text', () => {
  const p = parseLogLine(logLine(NOW, 'ERROR', 'could not build a release of main', { error: 'tsc failed in /Users/someone/secret-project' }));
  assert.deepEqual(p, { at: NOW, level: 'ERROR', message: 'could not build a release of main' });
  assert.equal(parseLogLine('not a log line'), undefined);
});

test("errors are counted by message, and only Mike's messages are named", () => {
  const lines = [
    logLine(NOW - DAY, 'ERROR', 'could not build a release of main', { commit: 'abc' }),
    logLine(NOW - 2 * DAY, 'ERROR', 'could not build a release of main'),
    logLine(NOW - DAY, 'ERROR', 'my own private-client sync failed'),
    logLine(NOW - DAY, 'WARN', 'could not check main'),
    logLine(NOW - 30 * DAY, 'ERROR', 'an old one'),
  ];
  const r = countErrors(lines, NOW - 14 * DAY, (m) => m.startsWith('could not'));
  assert.deepEqual(r, { errors: [{ message: 'could not build a release of main', count: 2 }], otherErrors: 1 });
});

test("patches: Mike's by name, theirs as a count", () => {
  const r = failingPatches(
    [
      { id: 'checks', source: 'project', file: '/c/.threadbear/patches/checks.ts', error: 'items() threw\nstack' },
      { id: 'my-crm', source: 'home', file: '/Users/x/.threadbear/patches/my-crm.ts', error: 'boom at /Users/x' },
      { id: 'fine', source: 'project', file: '/c/.threadbear/patches/fine.ts' },
    ],
    (f) => f.startsWith('/c/'),
  );
  assert.deepEqual(r, { patches: [{ id: 'checks', error: 'items() threw' }], otherPatchesFailing: 1 });
});

test('the report reads plainly, with the agent note last', () => {
  const c: Checkup = {
    release: { tag: 'release/2026-11-19', date: '2026-11-19T01:00:00Z' },
    previous: { tag: 'release/2026-11-05', date: '2026-11-05T01:00:00Z' },
    sinceDays: 14,
    errors: [{ message: 'could not build a release of main', count: 2 }],
    otherErrors: 1,
    updateFailing: false,
    patches: [],
    otherPatchesFailing: 1,
    note: 'settings.ts clashed with their own change; kept both.',
  };
  assert.equal(
    formatCheckup(c),
    [
      'Brought in `release/2026-11-19` from `release/2026-11-05` (14 days behind).',
      'Runner errors in the last 14 days:',
      '- 2x could not build a release of main',
      "- 1 other (not from Threadbear's own code, so not listed)",
      '1 patch of their own won\'t load.',
      '',
      'From their agent: settings.ts clashed with their own change; kept both.',
    ].join('\n'),
  );
  assert.match(formatCheckup({ ...c, errors: [], otherErrors: 0, otherPatchesFailing: 0, note: undefined }), /Runner errors in the last 14 days: none\.$/);
});

test('posting scrubs secrets, the home folder and the user name', () => {
  const out = scrubForPosting('key sk-ant-api03-' + 'a'.repeat(90) + ' in /Users/alice/dev/x, alice said', '/Users/alice', 'alice');
  assert.doesNotMatch(out, /sk-ant/);
  assert.doesNotMatch(out, /alice/);
  assert.match(out, /~\/dev\/x/);
});

function repo(origin = 'https://github.com/someone/threadbear.git'): string {
  const dir = tmpDir('tb-checkup-repo-');
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init', '-q', '-b', 'main');
  g('remote', 'add', 'origin', origin);
  fs.mkdirSync(path.join(dir, 'runner', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runner', 'src', 'a.ts'), "log.error('could not build a release of main');\n");
  g('add', '.');
  g('commit', '-q', '-m', 'one');
  g('tag', 'release/2026-11-05');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  g('add', '.');
  g('commit', '-q', '-m', 'two');
  g('tag', 'release/2026-11-19');
  return dir;
}

test("the release main had before comes from main's reflog", async () => {
  const dir = repo();
  const r = await releasesOnMain(dir);
  assert.equal(r.release?.tag, 'release/2026-11-19');
  assert.equal(r.previous?.tag, 'release/2026-11-05');
});

test("without a pinned key, refs under refs/threadbear/upstream aren't believed: the release check is off then, so it kept none", async () => {
  // A fork whose releases after 16 Nov were only there was told it had
  // brought in 16 Nov's when it had 21 Nov's (discussions/85).
  const dir = repo();
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('commit', '-q', '--allow-empty', '-m', 'three');
  g('update-ref', 'refs/threadbear/upstream/2026-11-20', 'HEAD');
  g('commit', '-q', '--allow-empty', '-m', 'their own');
  g('commit', '-q', '--allow-empty', '-m', 'four');
  g('tag', '-a', '-m', 'r', 'kept', 'HEAD');
  g('update-ref', 'refs/threadbear/upstream/2026-11-21', 'refs/tags/kept');
  g('tag', '-d', 'kept');
  // A tag of the fork's own with the same name, off main, doesn't hide it.
  g('tag', 'release/2026-11-21', g('commit-tree', '-m', 'theirs', 'HEAD^{tree}').trim());
  const r = await releasesOnMain(dir);
  assert.equal(r.release?.tag, 'release/2026-11-19');
  assert.equal((await releasesOnMain(dir, tmpDir('tb-checkup-nokey-'))).release?.tag, 'release/2026-11-19');
});

// A fork's copy as the release check leaves it (upstream.ts): the releases
// it fetched tags for long ago under refs/tags, and the ones since only
// under refs/threadbear/upstream/<date>, as signed tag objects. Main moves
// from 20 Nov's release to 21 Nov's.
function forkWithKeptReleases(): { dir: string; home: string; dates: Record<string, string> } {
  const dir = repo();
  const home = tmpDir('tb-checkup-home-');
  const { priv, signers } = key(tmpDir('tb-checkup-key-'), 'mike-key');
  fs.copyFileSync(signers, signersPath(home));
  const env = (date: string) => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Mike', GIT_COMMITTER_EMAIL: 'mike@example.com', GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date });
  const g = (date: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8', env: env(date) }).trim();
  const dates: Record<string, string> = {};
  // Signed by the pinned key as release/<name>, then moved under the kept namespace.
  const keep = (name: string, date: string, signedAs = name, by = priv) => {
    g(date, '-c', 'gpg.format=ssh', '-c', `user.signingkey=${by}`, 'tag', '-s', '-m', `Threadbear ${signedAs}`, `release/${signedAs}`, 'HEAD');
    g(date, 'update-ref', `refs/threadbear/upstream/${name}`, g(date, 'rev-parse', `refs/tags/release/${signedAs}`));
    g(date, 'tag', '-d', `release/${signedAs}`);
    dates[name] = new Date(date).toISOString();
  };
  const step = (file: string, date: string) => {
    fs.writeFileSync(path.join(dir, file), file);
    g(date, 'add', '.');
    g(date, 'commit', '-q', '-m', file);
  };
  step('c.txt', '2026-11-20T02:00:00Z');
  keep('2026-11-20', '2026-11-20T02:00:00Z');
  fs.writeFileSync(path.join(dir, 'runner', 'src', 'a.ts'), "log.error('could not build a release of main');\nlog.error('a message new in 21 Nov');\n");
  step('d.txt', '2026-11-21T02:00:00Z');
  keep('2026-11-21', '2026-11-21T02:00:00Z');
  // Not to be believed: an unsigned tag, one signed by another key, and a
  // real signed tag kept under a newer name than it was signed as.
  step('e.txt', '2026-11-22T02:00:00Z');
  g('2026-11-22T02:00:00Z', 'tag', '-a', '-m', 'unsigned', 'release/2026-11-22', 'HEAD');
  g('2026-11-22T02:00:00Z', 'update-ref', 'refs/threadbear/upstream/2026-11-22', g('2026-11-22T02:00:00Z', 'rev-parse', 'refs/tags/release/2026-11-22'));
  g('2026-11-22T02:00:00Z', 'tag', '-d', 'release/2026-11-22');
  keep('2026-11-23', '2026-11-22T02:00:00Z', '2026-11-23', key(tmpDir('tb-checkup-key-'), 'other-key').priv);
  keep('2026-11-24', '2026-11-22T02:00:00Z', '2026-11-21b');
  // Tags of the fork's own, with a key pinned (the reviews): a lightweight
  // one with a later name, and an unsigned one under 21 Nov's name, both on
  // main's tip, whose code isn't Mike's.
  g('2026-11-22T02:00:00Z', 'tag', 'release/2026-11-30', 'HEAD');
  g('2026-11-22T02:00:00Z', 'tag', '-a', '-m', 'ours', 'release/2026-11-21', 'HEAD');
  return { dir, home, dates };
}

test('a fork whose newer releases are only under refs/threadbear/upstream/ names those, with their dates (Crispaul, 21 Nov)', async () => {
  const { dir, home, dates } = forkWithKeptReleases();
  const r = await releasesOnMain(dir, home);
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();
  assert.deepEqual(r.release, { tag: 'release/2026-11-21', rev: g('rev-parse', 'refs/threadbear/upstream/2026-11-21^{commit}'), date: dates['2026-11-21'] });
  assert.deepEqual(r.previous, { tag: 'release/2026-11-20', rev: g('rev-parse', 'refs/threadbear/upstream/2026-11-20^{commit}'), date: dates['2026-11-20'] });
  // Without a pinned key the release check is off and nothing kept is
  // believed: tags count as they did, the fork's own included.
  const bare = await releasesOnMain(dir, tmpDir('tb-checkup-nokey-'));
  assert.equal(bare.release?.tag, 'release/2026-11-30');
  // The report reads Mike's messages from that release's code, which has no tag to name it by.
  const c = await buildCheckup({ home, checkout: dir, logLines: [logLine(NOW - DAY, 'ERROR', 'a message new in 21 Nov')], patches: [], updateFailing: false, now: NOW });
  assert.equal(c.release?.tag, 'release/2026-11-21');
  assert.deepEqual(c.errors, [{ message: 'a message new in 21 Nov', count: 1 }]);
  assert.match(formatCheckup(c), /^Brought in `release\/2026-11-21` from `release\/2026-11-20` \(1 day behind\)/);
});

test("a replacement ref can't make a fork's own code read as a release's (Codex's review)", async () => {
  const { dir, home } = forkWithKeptReleases();
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  // A side commit whose code has a private message, put in place of 21 Nov's release commit.
  const release = g('rev-parse', 'refs/threadbear/upstream/2026-11-21^{commit}');
  const put = (args: string[], input: string) => execFileSync('git', ['-C', dir, ...args], { input, encoding: 'utf8' }).trim();
  const blob = put(['hash-object', '-w', '--stdin'], "log.error('acme provisioning failed');\n");
  const src = put(['mktree'], `100644 blob ${blob}\ta.ts\n`);
  const runner = put(['mktree'], `040000 tree ${src}\tsrc\n`);
  const tree = put(['mktree'], `040000 tree ${runner}\trunner\n`);
  const side = g('commit-tree', tree, '-p', g('rev-list', '--max-parents=0', 'HEAD'), '-m', 'ours');
  g('replace', release, side);
  const c = await buildCheckup({ home, checkout: dir, logLines: [logLine(NOW - DAY, 'ERROR', 'acme provisioning failed')], patches: [], updateFailing: false, now: NOW });
  assert.equal(c.release?.tag, 'release/2026-11-21');
  assert.deepEqual(c.errors, []);
  assert.equal(c.otherErrors, 1);
});


test("landing checks: counts, typical and slowest times, Mike's step names only, no host names", () => {
  const at = (d: number) => new Date(NOW - d * DAY).toISOString();
  const lines = [
    JSON.stringify({ at: at(20), ok: true, seconds: 9999 }),
    JSON.stringify({ at: at(3), ok: true, seconds: 1200, waitedSeconds: 60, steps: [{ name: 'runner unit tests', status: 'ok', seconds: 700 }, { name: 'their secret step', status: 'ok', seconds: 900 }, { name: 'desktop lint', status: 'skip' }] }),
    JSON.stringify({ at: at(2), ok: false, seconds: 1440, waitedSeconds: 120, steps: [{ name: 'runner unit tests', status: 'FAIL', seconds: 800 }, { name: 'desktop core tests', status: 'ok', seconds: 90 }] }),
    JSON.stringify({ at: at(1), ok: true, seconds: 300, host: 'olli-mini', steps: [{ name: 'runner unit tests', status: 'ok', seconds: 200 }] }),
    JSON.stringify({ at: at(1), dryRun: true, seconds: 5 }),
    '{"cut sho',
    JSON.stringify({ at: at(1), ok: true, seconds: 10, steps: [null, { name: 'private-client\nrunner unit tests', status: 'ok', seconds: 5 }] }),
    JSON.stringify({ at: at(1), ok: true, seconds: 10, steps: {} }),
    'null',
  ];
  const k = landingChecks(lines, NOW - 14 * DAY, (name) => name !== 'their secret step')!;
  assert.deepEqual(k, { count: 5, failed: 1, medianSeconds: 300, slowestSeconds: 1440, medianWaitSeconds: 120, onCheckHost: 1, steps: [{ name: 'runner unit tests', medianSeconds: 700 }, { name: 'desktop core tests', medianSeconds: 90 }] });
  const c: Checkup = { sinceDays: 14, errors: [], otherErrors: 0, updateFailing: false, patches: [], otherPatchesFailing: 0, checks: k };
  const out = formatCheckup(c);
  assert.match(out, /Landing checks in the last 14 days: 5 \(1 failed\), 1 on a check host, 4 on their Mac\. Typical 5 min, slowest 24 min, typical wait for the lock 2 min\./);
  assert.match(out, /Slowest steps \(typical\): runner unit tests 12 min, desktop core tests 2 min\./);
  assert.doesNotMatch(out, /olli-mini|secret|private/);
  assert.equal(landingChecks([], 0, () => true), undefined);
});

test("off with releases.checkup false, and in Mike's own copy", () => {
  assert.equal(checkupOff(repo(), {}), undefined);
  assert.match(checkupOff(repo(), { releases: { checkup: false } })!, /off here/);
  assert.match(checkupOff(repo('git@github.com:mikecann/threadbear.git'), {})!, /Mike's own copy/);
});

test('a check-up drafts from the log, then posts that draft once per release', async () => {
  const dir = repo();
  const home = tmpDir('tb-checkup-home-');
  const c = await buildCheckup({
    home,
    checkout: dir,
    logLines: [logLine(NOW - DAY, 'ERROR', 'could not build a release of main', { error: 'x' }), logLine(NOW - DAY, 'ERROR', 'their own thing')],
    patches: [],
    updateFailing: true,
    note: '  all   fine  ',
    now: NOW,
  });
  assert.deepEqual(c.errors, [{ message: 'could not build a release of main', count: 1 }]);
  assert.equal(c.otherErrors, 1);
  assert.equal(c.note, 'all fine');
  saveDraft(home, c);

  assert.match(postDraft(home, NOW, () => ({ ok: true, out: 'x' }), 0).message, /hasn't opened/);

  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    return { ok: true, out: calls.length === 1 ? 'D_1' : 'https://github.com/mikecann/threadbear/discussions/9#c1' };
  };
  const r = postDraft(home, NOW, gh, 9);
  assert.equal(r.code, 0, r.message);
  assert.ok(calls[1].some((a) => a.startsWith('b=Brought in `release/2026-11-19`')));
  assert.equal(readState(home).posted?.[0].tag, 'release/2026-11-19');
  assert.equal(readState(home).lastAt, new Date(NOW).toISOString());

  saveDraft(home, c);
  assert.match(postDraft(home, NOW, gh, 9).message, /already sent/);
});

test('a skipped check-up still moves where the next one counts from', () => {
  const home = tmpDir('tb-checkup-home-');
  skipped(home, NOW);
  assert.equal(readState(home).lastAt, new Date(NOW).toISOString());
});

test('safeErrorCause and topStackSourceFile extract only allowlisted causes and runner src frames', () => {
  assert.equal(safeErrorCause("Error: ENOSPC: no space left on device, write '/Users/alice/secret'"), 'ENOSPC');
  assert.equal(safeErrorCause('TypeError: Cannot read properties of undefined'), 'TypeError');
  assert.equal(safeErrorCause('TypeError: connect ECONNREFUSED 127.0.0.1:4444'), 'TypeError (ECONNREFUSED)');
  assert.equal(safeErrorCause('AcpExitedError: process died in /Users/alice/private'), 'AcpExitedError');
  assert.equal(safeErrorCause('Error: something private with MYSECRETWORD'), undefined);
  assert.equal(safeErrorCause(undefined), undefined);

  const stack = [
    'Error: secret text at /fake/src/main.ts:1:1',
    '    at node:internal/timers:512:7',
    '    at foo (/Users/alice/app/node_modules/pkg/src/index.js:10:2)',
    '    at bar (/Users/alice/Library/Application Support/Threadbear/runner/releases/r1/src/runner/worktrees.ts:42:9)',
    '    at baz (/Users/alice/Library/Application Support/Threadbear/runner/releases/r1/src/main.ts:10:1)',
  ].join('\n');
  assert.equal(topStackSourceFile(stack), 'runner/worktrees.ts');
  assert.equal(topStackSourceFile('TypeError: boom\n    at check (C:\\Users\\bob\\runner\\src\\task-reminders.ts:12:3)'), 'task-reminders.ts');
  assert.equal(topStackSourceFile('Error: at /Users/alice/runner/src/main.ts:1:1'), undefined, 'line 0 never counts as a stack frame');
  assert.equal(topStackSourceFile('Error: x\n    at /Users/alice/runner/src/../secret.ts:1:1'), undefined, 'dot-dot rejected');
});

test('countErrors: safe causes, burst collapsing, fork attribution, reinstall code and non-bug filtering', () => {
  const MIN = 60_000;
  const t0 = NOW - DAY;
  const lines = [
    // 5 ENOSPC save errors in a single 40-minute burst (each < 15 min apart)
    logLine(t0, 'ERROR', 'could not save thread', { error: "Error: ENOSPC: no space left, open '/Users/alice/t1'" }),
    logLine(t0 + 10 * MIN, 'ERROR', 'could not save thread', { error: 'Error: ENOSPC: no space left' }),
    logLine(t0 + 20 * MIN, 'ERROR', 'could not save thread', { error: 'Error: ENOSPC: no space left' }),
    logLine(t0 + 30 * MIN, 'ERROR', 'could not save thread', { error: 'Error: ENOSPC: no space left' }),
    logLine(t0 + 40 * MIN, 'ERROR', 'could not save thread', { error: 'Error: ENOSPC: no space left' }),
    // 2 separate incidents (> BURST_GAP_MS apart) of a Threadbear RPC method
    logLine(t0, 'ERROR', 'request failed', { method: 'threads.send', error: 'TypeError: boom' }),
    logLine(t0 + BURST_GAP_MS + 60_000, 'ERROR', 'request failed', { method: 'threads.send', error: 'TypeError: boom' }),
    // Fork-only RPC method -> goes to otherErrors, never named
    logLine(t0, 'ERROR', 'request failed', { method: 'reminders.sync', error: 'TypeError: offline' }),
    // Fork-only unhandled rejection (top frame not in Mike's release) -> goes to otherErrors, never named
    logLine(t0, 'ERROR', 'unhandled rejection', { error: 'TypeError: fetch failed\n    at tick (/Users/wayne/runner/src/task-reminders.ts:44:5)\n    at main (/Users/wayne/runner/src/main.ts:10:1)' }),
    // Threadbear unhandled rejection (top frame in Mike's release) -> named with file & cause
    logLine(t0, 'ERROR', 'unhandled rejection', { error: 'TypeError: bad\n    at take (/Users/alice/runner/src/handover.ts:88:3)' }),
    // Reinstall finished carries integer exit code, never raw reason text
    logLine(t0, 'ERROR', 'reinstall finished', { code: 1, reason: 'failed at /Users/alice/secret' }),
    // Known non-bugs are skipped
    logLine(t0, 'ERROR', 'model call failed', { error: 'rate limit' }),
    logLine(t0, 'ERROR', 'convex sync failed; will retry', { error: 'TypeError: fetch failed' }),
  ];

  const r = countErrors(
    lines,
    NOW - 14 * DAY,
    () => true,
    {
      knownMethod: (m) => m === 'threads.send',
      knownSourceFile: (f) => f === 'handover.ts' || f === 'main.ts',
    },
  );

  assert.equal(r.otherErrors, 2, 'fork RPC method + fork unhandled rejection counted as other');
  assert.deepEqual(r.errors, [
    { message: 'request failed', count: 2, cause: 'threads.send, TypeError' },
    { message: 'could not save thread', count: 5, cause: 'ENOSPC', bursts: 1, spanSeconds: 2400 },
    { message: 'reinstall finished', count: 1, cause: 'exit 1' },
    { message: 'unhandled rejection in handover.ts', count: 1, cause: 'TypeError' },
  ]);

  const formatted = formatCheckup({
    sinceDays: 3,
    errors: r.errors,
    otherErrors: r.otherErrors,
    updateFailing: false,
    patches: [],
    otherPatchesFailing: 0,
    health: { rolledBack: true, restartGuardTripped: true, lowDiskGb: 0.6 },
  });
  assert.match(formatted, /- 2x request failed \(threads\.send, TypeError\)/);
  assert.match(formatted, /- 5x could not save thread \(ENOSPC\), 1 burst over 40 min/);
  assert.match(formatted, /- 1x reinstall finished \(exit 1\)/);
  assert.match(formatted, /- 1x unhandled rejection in handover\.ts \(TypeError\)/);
  assert.match(formatted, /A runner release rolled back after crashing in the last 3 days\./);
  assert.match(formatted, /The error-restart guard tripped in the last 3 days\./);
  assert.match(formatted, /Disk space is low right now \(0\.6 GB free\)\./);
  assert.doesNotMatch(formatted, /reminders|task-reminders|alice|wayne|secret/);
});

test('buildCheckup verifies RPC methods, stack files and health state against the release and home dir', async () => {
  const dir = tmpDir('tb-checkup-sig-');
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init', '-q', '-b', 'main');
  g('remote', 'add', 'origin', 'https://github.com/someone/threadbear.git');
  fs.mkdirSync(path.join(dir, 'runner', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runner', 'src', 'rpc.ts'), "case 'threads.send': log.error('request failed');\n");
  fs.writeFileSync(path.join(dir, 'runner', 'src', 'main.ts'), "log.error('unhandled rejection');\n");
  fs.writeFileSync(path.join(dir, 'runner', 'src', 'handover.ts'), 'export const ok = true;\n');
  g('add', '.');
  g('commit', '-q', '-m', 'init');
  g('tag', 'release/2026-11-25');

  const home = tmpDir('tb-checkup-health-');
  fs.mkdirSync(path.join(home, 'runner'), { recursive: true });
  fs.mkdirSync(path.join(home, 'run'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runner', 'state.json'), JSON.stringify({
    current: 'r1',
    previous: null,
    lastGood: 'r1',
    boots: [],
    rolledBack: { from: 'r2', to: 'r1', at: new Date(NOW - DAY).toISOString() },
  }));
  fs.writeFileSync(path.join(home, 'run', 'error-exits.json'), JSON.stringify({
    release: 'r2',
    exits: [],
    tripped: { at: new Date(NOW - DAY).toISOString(), lastErrorAt: new Date(NOW - DAY).toISOString(), errors: 4 },
  }));

  const lines = [
    logLine(NOW - DAY, 'ERROR', 'request failed', { method: 'threads.send', error: 'Error: EACCES: denied' }),
    logLine(NOW - DAY, 'ERROR', 'request failed', { method: 'custom.forkMethod', error: 'Error: boom' }),
    logLine(NOW - DAY, 'ERROR', 'unhandled rejection', { error: 'TypeError: x\n    at fn (/x/runner/src/handover.ts:10:1)' }),
    logLine(NOW - DAY, 'ERROR', 'unhandled rejection', { error: 'TypeError: x\n    at fn (/x/runner/src/fork-only.ts:10:1)' }),
  ];

  const c = await buildCheckup({
    home,
    checkout: dir,
    logLines: lines,
    patches: [],
    updateFailing: false,
    now: NOW,
    freeBytes: Math.round(2.4 * 1024 ** 3),
  });

  assert.deepEqual(c.errors, [
    { message: 'request failed', count: 1, cause: 'threads.send, EACCES' },
    { message: 'unhandled rejection in handover.ts', count: 1, cause: 'TypeError' },
  ]);
  assert.equal(c.otherErrors, 2);
  assert.deepEqual(c.health, { rolledBack: true, restartGuardTripped: true, lowDiskGb: 2.4 });

  // Healthy free disk omits lowDiskGb
  const healthy = await buildCheckup({
    home: tmpDir('tb-checkup-ok-'),
    checkout: dir,
    logLines: [],
    patches: [],
    updateFailing: false,
    now: NOW,
    freeBytes: 50 * 1024 ** 3,
  });
  assert.equal(healthy.health, undefined);
});
