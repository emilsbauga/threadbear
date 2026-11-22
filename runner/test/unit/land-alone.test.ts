// tb land, when a group's check fails (docs/thread-worktrees.md, "Finding
// who broke a group"): in the four days to 17 Nov about a third of branches
// reached the line already broken, and each took its group's check down
// with it, then one whole check per halving to find. Now what failed is run
// on each landing by itself first, which names the broken ones in one pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { land, landLimits, onlyFailed, onlyRan, type LandTarget } from '../../src/worktrees.ts';
import { LAND_TIMES_FILE, typicalCheckSeconds, waiting } from '../../src/land-queue.ts';
import { passedLandCheck } from '../../src/update.ts';
import { capture, commit, holdUntil, makeBranch, makeRepo, sh, until, write } from '../helpers/worktrees-harness.ts';

// A waiting landing looks for having been left out this often.
landLimits.goneMs = 50;

const SAID = 'To run only what failed again: --only "unit tests=test/unit/x.test.ts"';

// A check that writes down the files it saw and whether it was asked for
// only what failed, holds the first landing (a.txt alone) until the test
// lets it go so the rest queue up, and fails as `fails` says: a shell test
// that's true when this checkout is broken. `alone` is what a run of only
// what failed does instead, when that differs. Asked for only what failed,
// it says it ran it, as check.sh does (`ranIf`: only where that's true).
function check(root: string, fails: string, alone = '', ranIf = 'true'): string {
  const failing = `echo '${SAID}'; exit 1`;
  // LC_ALL=C: a Linux check host's locale sorts bad.txt before b.txt,
  // where the expected lists below (and a Mac) have it after (17 Nov: every
  // landing's check failed on cloud and tinker-desk for hours over it).
  return `echo "$(LC_ALL=C ls *.txt | tr '\\n' ' ')| only=\${THREADBEAR_CHECK_ONLY:-} host=\${THREADBEAR_CHECK_HOST_ONLY:-}" >> '${root}/checks'; ` +
    `if test -z "\${THREADBEAR_CHECK_ONLY:-}" && test -f a.txt && ! test -f b.txt; then touch '${root}/checking'; ${holdUntil(`${root}/release`)}; fi; ` +
    `if test -n "\${THREADBEAR_CHECK_ONLY:-}"; then if ${ranIf}; then echo '--only ran: "unit tests"'; else echo '--only ran: ""'; fi; ${alone || 'true'}; fi; ` +
    `if ${fails}; then ${failing}; fi`;
}
// True in a checkout with a landing's file in it: not on main as these tests leave it.
const NOT_MAIN = 'ls [b-e].txt >/dev/null 2>&1';

function branches(main: string, names: string[]): LandTarget[] {
  return names.map((n) => {
    const t = makeBranch(main, `${n}0000000`);
    commit(t.path, { [`${n}.txt`]: `${n}\n` }, `Add ${n}`);
    return t;
  });
}

// a lands first while the others queue behind it; they're then one group.
async function queued(root: string, _main: string, a: LandTarget, others: LandTarget[], cmd: string) {
  const first = land({ ...a, check: cmd }, capture().opts);
  await until(() => fs.existsSync(path.join(root, 'checking')), "a's check");
  const caps = others.map(() => capture());
  const rest = others.map((t, i) => land({ ...t, check: cmd }, caps[i].opts));
  try {
    await until(() => caps.every((c) => c.out.some((l) => l.startsWith('Waiting for another landing'))), 'the others waiting');
  } finally {
    write(root, { release: '' });
  }
  return { first, rest, caps };
}

// How many times a holder went looking for who broke its group.
const rounds = (caps: ReturnType<typeof capture>[]): number => caps.flatMap((c) => c.out).filter((l) => l.startsWith('Running only what failed')).length;
const said = (caps: ReturnType<typeof capture>[]): string => caps.map((c) => c.out.concat(c.err).join('\n')).join('\n---\n');
const checks = (root: string): { files: string[]; only: string; host: string }[] =>
  fs.readFileSync(path.join(root, 'checks'), 'utf8').trim().split('\n').map((l) => {
    const m = /^(.*)\| only=(.*) host=(.*)$/.exec(l)!;
    return { files: m[1].trim().split(' '), only: m[2], host: m[3] };
  });

test('the landing that broke a group is found by running what failed on each alone, and the rest land in the next check', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break it');
  const { first, rest, caps } = await queued(root, main, a, [b, c, d], check(root, 'test -f bad.txt'));
  assert.equal(await first, 0);
  assert.deepEqual(await Promise.all(rest), [0, 1, 0], said(caps));
  for (const n of ['a', 'b', 'd']) assert.ok(fs.existsSync(path.join(main, `${n}.txt`)), n);
  assert.ok(!fs.existsSync(path.join(main, 'bad.txt')));
  // c hears it was its own, with that run's output, and how to go on.
  const cSaid = caps[1].err.join('\n');
  assert.match(cSaid, /The check failed with 3 landings together, and what failed in it fails on thread\/c0000000 by itself too/);
  assert.match(cSaid, /To run only what failed again/);
  assert.match(cSaid, /Fix it, commit, and run tb land again\./);
  assert.equal(sh(c.path, 'git rev-parse --abbrev-ref HEAD'), c.branch);
  assert.equal(sh(c.path, 'git status --porcelain'), '');
  // No halving: a's check, the group's, and one more for the two that passed.
  assert.doesNotMatch(said(caps), /Checking them in smaller groups/);
  const all = checks(root);
  const whole = all.filter((x) => !x.only);
  assert.deepEqual(whole.map((x) => x.files.join(' ')), ['a.txt', 'a.txt b.txt bad.txt c.txt d.txt', 'a.txt b.txt d.txt'], JSON.stringify(all));
  // Main first, then each of the three alone on it, asked for only what
  // failed, on a host or nowhere.
  const alone = all.filter((x) => x.only);
  assert.deepEqual(alone[0].files, ['a.txt']);
  assert.deepEqual(alone.map((x) => x.files.join(' ')).sort(), ['a.txt', 'a.txt b.txt', 'a.txt bad.txt c.txt', 'a.txt d.txt']);
  for (const x of alone) assert.deepEqual([x.only, x.host], ['unit tests=test/unit/x.test.ts', '1']);
  assert.deepEqual(waiting(path.join(main, '.git')), [], 'nobody left in the line');
  // Those runs are in a checkout of tb land's own, which is no worktree.
  assert.ok(fs.existsSync(path.join(main, '.git', 'threadbear-land-alone', '.git')));
  assert.doesNotMatch(sh(main, 'git worktree list'), /threadbear-land-alone/);
});

test("a run of only what failed is never taken for a check: not by the updater, nor for how long checks take", async () => {
  const { root, main } = makeRepo();
  const [a, b, c] = branches(main, ['a', 'b', 'c']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break it');
  const { first, rest, caps } = await queued(root, main, a, [b, c], check(root, 'test -f bad.txt'));
  assert.equal(await first, 0);
  assert.deepEqual(await Promise.all(rest), [0, 1], said(caps));
  const file = path.join(main, '.git', LAND_TIMES_FILE);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const alone = lines.filter((l) => l.alone);
  assert.equal(alone.length, 3, 'main and the two of them');
  for (const l of alone) {
    assert.equal(typeof l.passed, 'boolean');
    for (const k of ['ok', 'check', 'intact']) assert.ok(!(k in l), `${k} in ${JSON.stringify(l)}`);
    assert.equal(passedLandCheck(file, String(l.commit)), undefined);
  }
  // The same lines with nothing else in the file say nothing about a check's time.
  const only = path.join(root, 'alone-only.log');
  fs.writeFileSync(only, alone.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(typicalCheckSeconds(only), undefined);
});

test('two broken landings in one group are both left out after one round', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d, e] = branches(main, ['a', 'b', 'c', 'd', 'e']);
  commit(b.path, { 'bad-b.txt': 'bad\n' }, 'Break it');
  commit(d.path, { 'bad-d.txt': 'bad\n' }, 'Break it too');
  const { first, rest, caps } = await queued(root, main, a, [b, c, d, e], check(root, 'ls bad-*.txt >/dev/null 2>&1'));
  assert.equal(await first, 0);
  assert.deepEqual(await Promise.all(rest), [1, 0, 1, 0], said(caps));
  for (const i of [0, 2]) assert.match(caps[i].err.join('\n'), /by itself too/);
  const whole = checks(root).filter((x) => !x.only).map((x) => x.files.join(' '));
  assert.deepEqual(whole, ['a.txt', 'a.txt b.txt bad-b.txt bad-d.txt c.txt d.txt e.txt', 'a.txt c.txt e.txt']);
  assert.doesNotMatch(said(caps), /Checking them in smaller groups/);
});

test('one left out while it waits stops waiting and says why, before the next check is over', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break it');
  // The check of the two that passed is held until c has heard.
  const cmd = check(root, 'test -f bad.txt') +
    `; if test -z "\${THREADBEAR_CHECK_ONLY:-}" && test -f b.txt && test -f d.txt; then touch '${root}/second'; ${holdUntil(`${root}/release2`)}; fi`;
  const { first, rest, caps } = await queued(root, main, a, [b, c, d], cmd);
  assert.equal(await first, 0);
  try {
    await until(() => fs.existsSync(path.join(root, 'second')), 'the check of b and d');
    assert.equal(await rest[1], 1, said(caps));
    assert.match(caps[1].err.join('\n'), /by itself too/);
    assert.ok(!fs.existsSync(path.join(main, 'b.txt')) || !fs.existsSync(path.join(main, 'd.txt')), 'the others were still being checked');
  } finally {
    write(root, { release2: '' });
  }
  assert.deepEqual(await Promise.all(rest), [0, 1, 0], said(caps));
});

test('when each passes what failed alone, the group is halved as before', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  // b and c only fail together.
  const { first, rest, caps } = await queued(root, main, a, [b, c, d], check(root, 'test -f b.txt && test -f c.txt'));
  assert.equal(await first, 0);
  const codes = await Promise.all(rest);
  assert.match(said(caps), /Each of them passes it alone/);
  assert.match(said(caps), /Checking them in smaller groups/);
  // Whichever of b and c comes second is refused, on a main with the other
  // (by its own check, or alone in a later group: by then it does fail alone).
  assert.equal(codes[2], 0, said(caps));
  assert.deepEqual([codes[0], codes[1]].sort(), [0, 1], said(caps));
  assert.ok(fs.existsSync(path.join(main, 'd.txt')));
  // The first round ran all three alone, on a main with neither b nor c, and
  // each passed; that landing then halves, and never runs them alone again.
  const firstRound = checks(root).filter((x) => x.only).slice(0, 4).map((x) => x.files.join(' ')).sort();
  assert.deepEqual(firstRound, ['a.txt', 'a.txt b.txt', 'a.txt c.txt', 'a.txt d.txt']);
  const holder = caps.find((x) => x.out.some((l) => /Each of them passes it alone/.test(l)))!;
  assert.equal(holder.out.filter((l) => l.startsWith('Running only what failed')).length, 1);
});

test('when main fails what failed too, nobody is blamed for it', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break it');
  // Run alone, what failed fails everywhere, main included.
  const { first, rest, caps } = await queued(root, main, a, [b, c, d], check(root, 'test -f bad.txt', `echo '${SAID}'; exit 1`));
  assert.equal(await first, 0);
  assert.deepEqual(await Promise.all(rest), [0, 1, 0], said(caps));
  assert.doesNotMatch(said(caps), /by itself too|Left out/);
  assert.match(said(caps), /Checking them in smaller groups/);
  assert.match(caps[1].err.join('\n'), /^The check failed \(exit 1\), so main wasn't touched/);
  // Main is run first, and that's the end of it: one run for each time a
  // failed group was looked at, and none of a landing alone.
  const alone = checks(root).filter((x) => x.only);
  assert.deepEqual(alone[0].files, ['a.txt']);
  assert.equal(alone.length, rounds(caps), JSON.stringify(alone));
});

test("when main didn't run what failed (exit 0 with the step skipped), that's no pass, and nobody is blamed", async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break it');
  // As check.sh's Swift steps: skipped on main with nothing changed, and
  // here run only where the broken change is.
  const { first, rest, caps } = await queued(root, main, a, [b, c, d], check(root, 'test -f bad.txt', '', 'test -f bad.txt'));
  assert.equal(await first, 0);
  assert.deepEqual(await Promise.all(rest), [0, 1, 0], said(caps));
  assert.doesNotMatch(said(caps), /by itself too|Left out/);
  assert.match(said(caps), /Checking them in smaller groups/);
  const alone = checks(root).filter((x) => x.only);
  assert.deepEqual(alone[0].files, ['a.txt']);
  assert.equal(alone.length, rounds(caps), JSON.stringify(alone));
});

test('a run alone that goes on past its time is stopped, with everything it started, and counts for nothing', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break it');
  const before = { ...landLimits };
  Object.assign(landLimits, { aloneMs: 0, aloneMinMs: 300, aloneGraceMs: 100 });
  try {
    // Asked for only what failed, it never ends (a host's line that doesn't
    // move), and one thing it started doesn't stop when asked nicely either.
    const stuck = `echo $$ >> '${root}/pids'; sh -c 'trap "" TERM; echo $$ >> "${root}/pids"; exec sleep 600' >/dev/null 2>&1 & sleep 600 & wait`;
    const started = Date.now();
    const { first, rest, caps } = await queued(root, main, a, [b, c, d], check(root, 'test -f bad.txt', stuck));
    assert.equal(await first, 0);
    assert.deepEqual(await Promise.all(rest), [0, 1, 0], said(caps));
    assert.ok(Date.now() - started < 120_000);
    assert.doesNotMatch(said(caps), /by itself too|Left out/);
    assert.match(said(caps), /Checking them in smaller groups/);
    // The shell and the sleep under it are gone.
    const pids = fs.readFileSync(path.join(root, 'pids'), 'utf8').trim().split('\n');
    assert.ok(pids.length >= 2, pids.join(' '));
    const alive = (pid: string): boolean => sh(root, `kill -0 ${pid} 2>/dev/null && echo yes || echo no`) === 'yes';
    await until(() => !pids.some(alive), 'the stopped runs to go');
  } finally {
    // (aloneMs isn't in `before` when nothing had set it.)
    Object.assign(landLimits, { aloneMs: undefined }, before);
  }
});

test("a run that says nothing either way (no check host could take it) refuses nobody", async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break it');
  const { first, rest, caps } = await queued(root, main, a, [b, c, d], check(root, 'test -f bad.txt', 'echo "No check host is set, and this run was only for one."; exit 4'));
  assert.equal(await first, 0);
  assert.deepEqual(await Promise.all(rest), [0, 1, 0], said(caps));
  assert.doesNotMatch(said(caps), /by itself too|Left out/);
  assert.match(said(caps), /Checking them in smaller groups/);
  assert.match(caps[1].err.join('\n'), /^The check failed \(exit 1\), so main wasn't touched/);
});

test("when the time for it runs out, whoever wasn't run waits, and nobody is refused or landed on a guess", async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break it');
  const before = landLimits.aloneMs;
  // The second landing run alone (the holder's own is the first) holds
  // until the time has been taken away, so the third never gets its turn.
  const second = `if ${NOT_MAIN}; then n=$(($(cat '${root}/n' 2>/dev/null || echo 0) + 1)); echo $n > '${root}/n'; ` +
    `if test $n = 2; then touch '${root}/second'; ${holdUntil(`${root}/go`)}; fi; fi`;
  try {
    const { first, rest, caps } = await queued(root, main, a, [b, c, d], check(root, 'test -f bad.txt', second));
    assert.equal(await first, 0);
    await until(() => fs.existsSync(path.join(root, 'second')), 'the second run alone');
    landLimits.aloneMs = 0;
    write(root, { go: '' });
    // Whoever held the lock: c is the only one refused, and it never lands.
    assert.deepEqual(await Promise.all(rest), [0, 1, 0], said(caps));
    for (const n of ['a', 'b', 'd']) assert.ok(fs.existsSync(path.join(main, `${n}.txt`)), n);
    assert.ok(!fs.existsSync(path.join(main, 'bad.txt')));
    // Main and two of the three were run in that round, not the third.
    const round = checks(root).filter((x) => x.only).slice(0, 4).map((x) => x.files.join(' '));
    assert.equal(round.filter((f) => f !== 'a.txt').length, 2, JSON.stringify(round));
  } finally {
    landLimits.aloneMs = before;
  }
});

test('every run alone goes to the check host the group failed on, and one made anywhere else says nothing', async () => {
  // A check that says where it ran: where it was sent, or else `fallback`.
  const onHost = (root: string, fallback: string, forAlone: string): string =>
    `if test -n "\${THREADBEAR_CHECK_ONLY:-}"; then echo "sent to \${THREADBEAR_CHECK_HOST:-nowhere} group=\${THREADBEAR_CHECK_GROUP:-}" >> '${root}/sent'; echo "Checking on ${forAlone} (copied in 1s; x)"; ` +
    `else echo "Checking on ${fallback} (copied in 1s; x)"; fi; ` + check(root, 'test -f bad.txt');
  {
    const { root, main } = makeRepo();
    const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
    commit(c.path, { 'bad.txt': 'bad\n' }, 'Break it');
    const { first, rest, caps } = await queued(root, main, a, [b, c, d], onHost(root, 'linux-box', '$THREADBEAR_CHECK_HOST'));
    assert.equal(await first, 0);
    assert.deepEqual(await Promise.all(rest), [0, 1, 0], said(caps));
    assert.match(caps[1].err.join('\n'), /by itself too/);
    // That host and no other: not the group's own choice of hosts.
    assert.deepEqual([...new Set(fs.readFileSync(path.join(root, 'sent'), 'utf8').trim().split('\n'))], ['sent to linux-box group=']);
  }
  {
    // The runs come back from another host (the one asked for had dropped
    // out): c fails there too, but nobody is refused on that.
    const { root, main } = makeRepo();
    const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
    commit(c.path, { 'bad.txt': 'bad\n' }, 'Break it');
    const { first, rest, caps } = await queued(root, main, a, [b, c, d], onHost(root, 'linux-box', 'the-mac'));
    assert.equal(await first, 0);
    assert.deepEqual(await Promise.all(rest), [0, 1, 0], said(caps));
    assert.doesNotMatch(said(caps), /by itself too|Left out|Each of them passes/);
    assert.match(said(caps), /Checking them in smaller groups/);
  }
});

test('a check that names nothing to run again is halved as before, with no runs alone', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break it');
  const cmd = check(root, 'false') + '; ! test -f bad.txt';
  const { first, rest, caps } = await queued(root, main, a, [b, c, d], cmd);
  assert.equal(await first, 0);
  assert.deepEqual(await Promise.all(rest), [0, 1, 0], said(caps));
  assert.match(said(caps), /Checking them in smaller groups/);
  assert.equal(checks(root).filter((x) => x.only).length, 0);
  assert.ok(!fs.existsSync(path.join(main, '.git', 'threadbear-land-alone')));
});

test("what a failed check says to run again is read only in check.sh's own words", () => {
  const line = (v: string): string => `ok    runner typecheck        4s\nTo run only what failed again: --only "${v}"\n\nLogs kept in /tmp/x; rm -rf it when you're done.\n`;
  assert.equal(onlyFailed(line('runner unit tests=test/unit/a.test.ts test/unit/b.test.ts;desktop app check (as installed)')), 'runner unit tests=test/unit/a.test.ts test/unit/b.test.ts;desktop app check (as installed)');
  // The last one said, as a host that dropped out partway may have said one too.
  assert.equal(onlyFailed(line('site build') + line('web tests')), 'web tests');
  assert.equal(onlyFailed('ok    runner unit tests  200s\n'), undefined);
  // Nothing a shell or an option parser would read as more than a name.
  for (const v of ['x$(id)', 'a`b`', "a'b", '-rf', 'a\\b', 'a&b', 'a|b', 'a>b', '']) assert.equal(onlyFailed(line(v)), undefined, v);
  // Not from the middle of a line a test printed.
  assert.equal(onlyFailed('  not ok 3 - To run only what failed again: --only "site build"\n'), undefined);
  // As check.sh says it now, a command that runs as printed (19 Nov), and
  // as an older check.sh said it.
  assert.equal(onlyFailed('To run only what failed again: ./check.sh --only "lint"\n'), 'lint');
  assert.equal(onlyFailed('To run only what failed again: tb land --only "lint"\n'), undefined);
});

test('tb land refuses --only, and says so with a failing exit', () => {
  // A background `tb land --only lint` had to fail, not seem to land.
  const r = spawnSync(process.execPath, [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/tb'), 'land', '--only', 'lint'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Unknown option '--only'/);
});

test("what a run with --only says it ran is read the same way", () => {
  assert.deepEqual([...(onlyRan('skip  x (--only left it out)\n--only ran: "runner unit tests;desktop app check (as installed)"\n') ?? [])], ['runner unit tests', 'desktop app check (as installed)']);
  assert.deepEqual([...(onlyRan('--only ran: ""\n') ?? ['x'])], []);
  assert.equal(onlyRan('ok    runner unit tests  3s\n'), undefined);
  assert.equal(onlyRan('  log: --only ran: "site build"\n'), undefined);
});

// No check host could run it (20 Nov: the cloud box ran out of disk during a
// group's check): the hosts' trouble, so nobody in the group is looked for
// or halved, and the next check of the same group lands it.
test('a group check no host could run blames nobody, and the group lands on the next check', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  // The group's first check: the hosts give up, with the exit tb land asks for.
  const unavailable = `test -f b.txt && ! test -f '${root}/hosts-back' && { touch '${root}/hosts-back'; echo '${SAID}'; echo 'This check failed because cloud ran out of disk during it.'; exit "$THREADBEAR_CHECK_BUSY_EXIT"; }; true`;
  const { first, rest, caps } = await queued(root, main, a, [b, c, d], `${check(root, 'false')}; ${unavailable}`);
  assert.equal(await first, 0);
  const codes = await Promise.all(rest);
  // The one that held the line hears why, and lands nothing; the rest land.
  assert.deepEqual([...codes].sort(), [0, 0, 1], said(caps));
  assert.match(said(caps), /No check host could run the check of 3 landings together, so main wasn't touched\. That's the hosts' trouble, not any landing in it\./);
  assert.match(said(caps), /cloud ran out of disk during it/);
  assert.equal(rounds(caps), 0, said(caps));
  assert.doesNotMatch(said(caps), /Checking them in smaller groups/);
  const failed = [b, c, d][codes.indexOf(1)];
  assert.equal(sh(failed.path, 'git rev-parse --abbrev-ref HEAD'), failed.branch);
  for (const t of [b, c, d].filter((t) => t !== failed)) assert.ok(fs.existsSync(path.join(main, `${t.branch.slice(-8, -7)}.txt`)), t.branch);
  assert.deepEqual(waiting(path.join(main, '.git')), [], 'nobody left in the line');
});

// check-remote.sh runs a check again on another host when one ran out of
// disk: what the earlier run said failed isn't the later one's.
test('what failed and what ran are read from the last run in a check\'s output', () => {
  const text = [
    'Checking on cloud (copied in 3s; ...)',
    'To run only what failed again: --only "desktop app check"',
    '--only ran: "desktop app check"',
    'cloud ran out of disk during this check (0.1 GiB free at the lowest), so what failed there may have failed for want of space. Running it again on another host.',
    'Checking on tinker-desk (copied in 4s; ...)',
    'npm ci failed in runner',
  ].join('\n');
  assert.equal(onlyFailed(text), undefined);
  assert.equal(onlyRan(text), undefined);
  assert.equal(onlyFailed(`${text}\nTo run only what failed again: --only "unit tests"`), 'unit tests');
  assert.equal(onlyFailed(SAID), 'unit tests=test/unit/x.test.ts');
});
