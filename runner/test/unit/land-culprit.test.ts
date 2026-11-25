// tb land, finding the landing that broke a group (docs/thread-worktrees.md,
// "Finding who broke a group"). On 17 Nov a line of eleven took over four
// hours and landed nothing of the line: half of it had landed with
// --despite-red, which switched off the runs of what failed on each alone;
// main skipped the failing Swift step with nothing changed, which would
// have too; and the halving that was left kept the broken landing, at the
// front of the line, in every holder's group, each halving down to the
// holder alone and landing only that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freeFixes, halveGroup, land, lookedFor, landLimits, setAside, type LandTarget } from '../../src/worktrees.ts';
import { joinQueue, queueDir, readEntry, setRunning, waiting, waitingLine } from '../../src/land-queue.ts';
import { capture, commit, holdUntil, makeBranch, makeRepo, sh, until, write } from '../helpers/worktrees-harness.ts';

landLimits.goneMs = 50;

function branches(main: string, names: string[]): LandTarget[] {
  return names.map((n) => {
    const t = makeBranch(main, `${n}0000000`);
    commit(t.path, { [`${n}.txt`]: `${n}\n` }, `Add ${n}`);
    return t;
  });
}

// Writes down each run: the files it saw, the --only it was asked for and
// whether it was asked to run every step (main's run). Holds a's own check
// so the rest queue behind it. `body` decides the rest.
function recorded(root: string, body: string): string {
  return `echo "$(LC_ALL=C ls *.txt | tr '\\n' ' ')| only=\${THREADBEAR_CHECK_ONLY:-} all=\${THREADBEAR_CHECK_ALL:-}" >> '${root}/checks'; ` +
    `if test -z "\${THREADBEAR_CHECK_ONLY:-}" && test -f a.txt && ! test -f b.txt && ! test -f c.txt && ! test -f d.txt; then touch '${root}/checking'; ${holdUntil(`${root}/release`)}; fi; ` +
    body;
}
const runs = (root: string): { files: string; only: string; all: string }[] =>
  fs.readFileSync(path.join(root, 'checks'), 'utf8').trim().split('\n').map((l) => {
    const m = /^(.*)\| only=(.*) all=(.*)$/.exec(l)!;
    return { files: m[1].trim(), only: m[2], all: m[3] };
  });

async function queued(root: string, _main: string, a: LandTarget, others: { t: LandTarget; despiteRed?: boolean }[], check: string) {
  const first = land({ ...a, check }, capture().opts);
  await until(() => fs.existsSync(path.join(root, 'checking')), "a's check");
  const caps = others.map(() => capture());
  const rest = others.map((o, i) => land({ ...o.t, check }, { ...caps[i].opts, ...(o.despiteRed ? { despiteRed: true } : {}) }));
  try {
    await until(() => caps.every((c) => c.out.some((l) => l.startsWith('Waiting for another landing'))), 'the others waiting');
  } finally {
    write(root, { release: '' });
  }
  return { first: await first, codes: await Promise.all(rest), caps };
}
const said = (caps: ReturnType<typeof capture>[]): string => caps.map((c) => c.out.concat(c.err).join('\n')).join('\n---\n');

// As check.sh's Swift mock tests: run only where the mock changed (here,
// with bad.txt), or with --all; failing where bad.txt is.
const SWIFT_LIKE = 'if test -n "${THREADBEAR_CHECK_ONLY:-}"; then ' +
  'if test -f bad.txt || test "${THREADBEAR_CHECK_ALL:-}" = 1; then echo \'--only ran: "mock tests"\'; else echo \'--only ran: ""\'; fi; fi; ' +
  'if test -f bad.txt; then echo \'To run only what failed again: --only "mock tests"\'; exit 1; fi';

test('main runs what failed even where it would skip it with nothing changed, so the one that broke it is found', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break the mock');
  const { first, codes, caps } = await queued(root, main, a, [{ t: b }, { t: c }, { t: d }], recorded(root, SWIFT_LIKE));
  assert.equal(first, 0);
  assert.deepEqual(codes, [0, 1, 0], said(caps));
  assert.match(caps[1].err.join('\n'), /fails on thread\/c0000000 by itself too/);
  assert.doesNotMatch(said(caps), /Checking them in smaller groups/);
  // Only main's run is asked for every step; each landing's is as it would be.
  const alone = runs(root).filter((r) => r.only);
  assert.deepEqual(alone[0], { files: 'a.txt', only: 'mock tests', all: '1' });
  for (const r of alone.slice(1)) assert.equal(r.all, '', JSON.stringify(r));
  for (const n of ['b', 'd']) assert.ok(fs.existsSync(path.join(main, `${n}.txt`)), n);
});

test('a fix in the group no longer stops the search, and a broken fix is found like any other', async () => {
  const { root, main } = makeRepo();
  const [a, f, b, c] = branches(main, ['a', 'f', 'b', 'c']);
  commit(f.path, { 'bad.txt': 'bad\n' }, 'A "fix" that breaks the mock');
  const { first, codes, caps } = await queued(root, main, a, [{ t: f, despiteRed: true }, { t: b }, { t: c }], recorded(root, SWIFT_LIKE));
  assert.equal(first, 0);
  assert.deepEqual(codes, [1, 0, 0], said(caps));
  assert.match(caps[0].err.join('\n'), /fails on thread\/f0000000 by itself too/);
  assert.doesNotMatch(said(caps), /Checking them in smaller groups/);
  // a's, the group's, and the one that landed b and c: never the fix again.
  const whole = runs(root).filter((r) => !r.only).map((r) => r.files);
  assert.deepEqual(whole, ['a.txt', 'a.txt b.txt bad.txt c.txt f.txt', 'a.txt b.txt c.txt'], JSON.stringify(runs(root)));
});

test('what main fails by itself is left out, and the rest of what failed is still run on each', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  commit(c.path, { 'bad.txt': 'bad\n' }, 'Break the unit tests');
  // "other step" fails wherever it's run alone (main too); "unit tests"
  // fails where bad.txt is. The group's whole check fails on bad.txt.
  const body = 'if test -n "${THREADBEAR_CHECK_ONLY:-}"; then ' +
    'echo "--only ran: \\"${THREADBEAR_CHECK_ONLY}\\""; failed=""; ' +
    'if test -f bad.txt; then echo "FAIL  unit tests            1s  log"; failed="unit tests"; else echo "ok    unit tests            1s"; fi; ' +
    'case "$THREADBEAR_CHECK_ONLY" in *"other step"*) echo "FAIL  other step            1s  log"; failed="${failed:+$failed;}other step";; esac; ' +
    'if test -n "$failed"; then echo "To run only what failed again: --only \\"$failed\\""; exit 1; fi; exit 0; fi; ' +
    'if test -f bad.txt; then echo \'To run only what failed again: --only "unit tests;other step"\'; exit 1; fi';
  const { first, codes, caps } = await queued(root, main, a, [{ t: b }, { t: c }, { t: d }], recorded(root, body));
  assert.equal(first, 0);
  assert.deepEqual(codes, [0, 1, 0], said(caps));
  assert.match(said(caps), /main fails other step by itself too, so only unit tests is run on each\./);
  assert.match(caps[1].err.join('\n'), /fails on thread\/c0000000 by itself too/);
  const alone = runs(root).filter((r) => r.only);
  assert.equal(alone[0].only, 'unit tests;other step');
  for (const r of alone.slice(1)) assert.equal(r.only, 'unit tests', JSON.stringify(r));
});

test('a group halved down to its holder sets aside the one it was narrowed to, and the next holder lands without it', async () => {
  // The check names nothing to run again, so it's the halving alone. The
  // broken one is a fix, first in every group and outside the limit: as on
  // 17 Nov. Before, each holder in turn halved down to itself.
  const { root, main } = makeRepo();
  const [a, f, b, c, d] = branches(main, ['a', 'f', 'b', 'c', 'd']);
  commit(f.path, { 'bad.txt': 'bad\n' }, 'A "fix" that breaks it');
  const body = '! test -f bad.txt';
  const { first, codes, caps } = await queued(root, main, a, [{ t: f, despiteRed: true }, { t: b }, { t: c }, { t: d }], recorded(root, body));
  assert.equal(first, 0);
  assert.deepEqual(codes, [1, 0, 0, 0], said(caps));
  for (const n of ['b', 'c', 'd']) assert.ok(fs.existsSync(path.join(main, `${n}.txt`)), n);
  // Once set aside, the fix is only ever checked by itself.
  const all = runs(root).map((r) => r.files);
  const asideAt = caps.flatMap((c) => c.out).some((l) => /^Set aside to be checked by itself, as the group failed with it and passed without: thread\/f0000000\.$/.test(l));
  const withBad = all.filter((x) => x.includes('bad.txt'));
  if (asideAt) {
    assert.match(caps[0].out.join('\n'), /Checking thread\/f0000000 by itself: a group check with it and thread\/\w+ failed/);
    // After the holder's check without it, it's checked once more, by
    // itself, and the rest land in one check without it. Which comes first
    // is whichever tb takes the lock first: a busy Linux follower saw its
    // own check before the rest's, 1 run in 4 (18 Nov).
    // Halved like any other since 18 Nov (ordinaryAt), it may first be in
    // one more group with another left out with it, before it's the only
    // one left out and set aside.
    const holderAlone = all.findIndex((x, i) => i > 0 && !x.includes('bad.txt'));
    assert.ok(all.slice(holderAlone + 1).filter((x) => x.includes('bad.txt')).length <= 2, JSON.stringify(all));
    const rest = all.findLast((x) => !x.includes('bad.txt'))!;
    assert.ok(['b', 'c', 'd'].every((n) => rest.includes(`${n}.txt`)), JSON.stringify(all));
  }
  // At most: the group (fbcd), halved to two with the fix (f + one + the
  // holder), the holder and the fix, the holder alone, then the rest in one,
  // and the fix alone. Before, every later holder went through it again.
  assert.ok(all.length <= 7, JSON.stringify(all));
  assert.ok(withBad.length <= 4, JSON.stringify(all));
});

// 18 Nov: two landings that each passed feature pairing alone failed it
// together (one added a scenario, the other made verify-pairing ask every
// scenario for a tag). Groups of eight and nine failed on it at 07:01 and
// 08:03 and nothing was narrowed: each holder's tb was killed by its
// agent's two-hour command limit before the halving was written, so the
// next holder stacked the same mix again. The halving is on the entries
// before findBroken's first run now, and the pair is still split apart.
test("a failed group's halving is on everyone's entry before anything slow, and two that only fail together are split", async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  const q = queueDir(path.join(main, '.git'));
  // Fails where b and c are both there. A run of only that (findBroken's)
  // also writes down the limits on the queue's entries as it starts.
  const body = `if test -n "\${THREADBEAR_CHECK_ONLY:-}"; then cat '${q}'/*.json 2>/dev/null | tr -d '\\n' >> '${root}/limits'; echo >> '${root}/limits'; ` +
    'echo \'--only ran: "feature pairing"\'; fi; ' +
    'if test -f b.txt && test -f c.txt; then echo \'To run only what failed again: --only "feature pairing"\'; exit 1; fi';
  const { first, codes, caps } = await queued(root, main, a, [{ t: b }, { t: c }, { t: d }], recorded(root, body));
  assert.equal(first, 0);
  // Whichever of b and c lands first, the other then fails on that main by
  // itself and is told so; d lands.
  assert.deepEqual(codes.filter((x) => x === 1).length, 1, said(caps));
  assert.equal(codes[2], 0, said(caps));
  assert.ok(fs.existsSync(path.join(main, 'd.txt')));
  assert.notEqual(fs.existsSync(path.join(main, 'b.txt')), fs.existsSync(path.join(main, 'c.txt')));
  assert.match(said(caps), /Each of them passes it alone/);
  // While main and each landing were run alone after the first failed group
  // (holder and two others), the two others already had a limit of 2 there.
  const first3 = fs.readFileSync(path.join(root, 'limits'), 'utf8').trim().split('\n')[0];
  const limits = [...first3.matchAll(/"limit":(\d+)/g)].map((m) => Number(m[1]));
  assert.deepEqual(limits, [2, 2], first3);
});

// The same day most of the line had landed with --despite-red (GitHub's
// desktop workflow was red), and fixes ride in every group outside the
// limit, so the halving couldn't split a pair of them: only drop them all,
// then check each by itself. Once main passes what failed, they're halved
// like any other.
test('fixes that only fail together are halved like any other once main passes what failed', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d, e] = branches(main, ['a', 'b', 'c', 'd', 'e']);
  const body = 'if test -n "${THREADBEAR_CHECK_ONLY:-}"; then echo \'--only ran: "feature pairing"\'; fi; ' +
    'if test -f b.txt && test -f c.txt; then echo \'To run only what failed again: --only "feature pairing"\'; exit 1; fi';
  const { first, codes, caps } = await queued(root, main, a, [b, c, d, e].map((t) => ({ t, despiteRed: true })), recorded(root, body));
  assert.equal(first, 0);
  assert.equal(codes.filter((x) => x === 1).length, 1, said(caps));
  assert.deepEqual([codes[2], codes[3]], [0, 0], said(caps));
  assert.match(said(caps), /main passes what failed by itself, so the fixes \(--despite-red\) in the group are halved with the rest\./);
  assert.doesNotMatch(said(caps), /Set aside to be checked by themselves/);
  // a's, the group, halved to the holder and one, then at worst the
  // holder alone, the other of the pair alone, and the rest: six. Before,
  // the fixes were left out together and each checked by itself.
  const whole = runs(root).filter((r) => !r.only).map((r) => r.files);
  assert.ok(whole.length <= 6, JSON.stringify(whole));
});

// What a holder that died just after its group of fixes failed leaves
// behind (halveGroup, before anything slow), and the next holder keeps to
// it: fixes too, which used to ride into every group outside the limit.
test("the next holder keeps to the halving a dead holder's failed group of fixes left", async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  const common = path.join(main, '.git');
  // a's own check fails, so main stays where the dead holder's group failed.
  const check = recorded(root, '! test -f a.txt');
  const first = land({ ...a, check }, capture().opts);
  await until(() => fs.existsSync(path.join(root, 'checking')), "a's check");
  const caps = [b, c, d].map(() => capture());
  const rest = [b, c, d].map((t, i) => land({ ...t, check }, { ...caps[i].opts, despiteRed: true }));
  try {
    await until(() => caps.every((x) => x.out.some((l) => l.startsWith('Waiting for another landing'))), 'b, c and d waiting');
    // A holder of their own failed with all three, and was killed.
    halveGroup(common, sh(main, 'git rev-parse main'), waiting(common).filter((e) => e.fix).map((entry) => ({ entry })), true);
  } finally {
    write(root, { release: '' });
  }
  assert.equal(await first, 1);
  assert.deepEqual(await Promise.all(rest), [0, 0, 0], said(caps));
  // Three and the holder halved to two: the next check has two of them.
  const whole = runs(root).filter((r) => !r.only).map((r) => r.files);
  assert.equal(whole[1].split(' ').length, 2, JSON.stringify(whole));
});

// Codex's second review: a main that skipped what failed (ran nothing of
// it) hasn't failed it, so the fixes stay halved with the rest.
test("fixes stay halved when main only skipped what failed, rather than failed it", async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d, e] = branches(main, ['a', 'b', 'c', 'd', 'e']);
  const body = 'if test -n "${THREADBEAR_CHECK_ONLY:-}"; then ' +
    'if test -f b.txt || test -f c.txt; then echo \'--only ran: "feature pairing"\'; else echo \'--only ran: ""\'; fi; fi; ' +
    'if test -f b.txt && test -f c.txt; then echo \'To run only what failed again: --only "feature pairing"\'; exit 1; fi';
  const { first, codes, caps } = await queued(root, main, a, [b, c, d, e].map((t) => ({ t, despiteRed: true })), recorded(root, body));
  assert.equal(first, 0);
  assert.equal(codes.filter((x) => x === 1).length, 1, said(caps));
  assert.doesNotMatch(said(caps), /Set aside to be checked by themselves/);
  const whole = runs(root).filter((r) => !r.only).map((r) => r.files);
  assert.ok(whole.length <= 6, JSON.stringify(whole));
});

test('freeFixes: every fix waiting rides free again on that main, not only one group', () => {
  const { main } = makeRepo();
  const common = path.join(main, '.git');
  const t = makeBranch(main, 'q0000000');
  const head = sh(main, 'git rev-parse main');
  const es = [1, 2, 3].map((n) => joinQueue(common, { branch: `thread/x${n}`, path: t.path, base: head, commit: head, fix: true }));
  fs.writeFileSync(path.join(queueDir(common), `${es[0].id}.json`), JSON.stringify({ ...es[0], ordinaryAt: head, limit: 2, limitAt: head }));
  fs.writeFileSync(path.join(queueDir(common), `${es[1].id}.json`), JSON.stringify({ ...es[1], ordinaryAt: 'an-old-main' }));
  freeFixes(common, head);
  assert.equal(readEntry(common, es[0].id)?.ordinaryAt, undefined);
  assert.equal(readEntry(common, es[0].id)?.limit, 2, 'its limit stays');
  assert.equal(readEntry(common, es[1].id)?.ordinaryAt, 'an-old-main');
});

// Codex's third review: main is broken in one step, a repair for it waits,
// and two others fail another step only together. The first group (repair
// in) fails only the second step, which main passes, so the repair is
// halved like the rest and can be left out; the next failure is main's own
// step, and is looked into too, which lets the repair ride free again.
test('a step that fails only once halving leaves the repair out is looked into, and the repair rides free again', async () => {
  const { root, main } = makeRepo();
  const [a, p, q, r] = branches(main, ['a', 'p', 'q', 'r']);
  commit(main, { 'broken.txt': 'x\n' }, 'Break main');
  for (const t of [a, p, q, r]) sh(t.path, 'git rebase -q main');
  const body = 'want="${THREADBEAR_CHECK_ONLY:-step one;step two}"; ' +
    'test -n "${THREADBEAR_CHECK_ONLY:-}" && echo "--only ran: \\"$want\\""; failed=""; ' +
    'case "$want" in *"step one"*) if test -f broken.txt && ! test -f r.txt; then echo "FAIL  step one            1s  log"; failed="step one"; else echo "ok    step one            1s"; fi;; esac; ' +
    'case "$want" in *"step two"*) if test -f p.txt && test -f q.txt; then echo "FAIL  step two            1s  log"; failed="${failed:+$failed;}step two"; else echo "ok    step two            1s"; fi;; esac; ' +
    'if test -n "$failed"; then echo "To run only what failed again: --only \\"$failed\\""; exit 1; fi';
  const { codes, caps } = await queued(root, main, a, [{ t: p }, { t: q }, { t: r, despiteRed: true }], recorded(root, body));
  // The repair lands, and one of p and q with it or after; the other fails
  // with it on main. Only a holder of p or q meets the case (one of r holds
  // passes straight through), so without the second look this fails in
  // some runs, not all.
  assert.equal(codes[2], 0, said(caps));
  assert.ok(fs.existsSync(path.join(main, 'r.txt')));
  assert.equal(codes.filter((x) => x === 0).length, 2, said(caps));
});

test('lookedFor: what an --only names, file by file within a step', () => {
  assert.deepEqual(lookedFor('lint;runner unit tests=test/unit/x.test.ts test/unit/y.test.ts'), ['lint', 'runner unit tests=test/unit/x.test.ts', 'runner unit tests=test/unit/y.test.ts']);
  assert.deepEqual(lookedFor('runner unit tests'), ['runner unit tests']);
  // So a later failure of y in the same step is new, and is looked into.
  const looked = new Set(lookedFor('runner unit tests=test/unit/x.test.ts'));
  assert.ok(lookedFor('runner unit tests=test/unit/x.test.ts test/unit/y.test.ts').some((k) => !looked.has(k)));
  assert.ok(!lookedFor('runner unit tests=test/unit/x.test.ts').some((k) => !looked.has(k)));
});

test('halveGroup: halves on this main at once, keeps a smaller limit, skips landed ones, and puts each back as it was', () => {
  const { main } = makeRepo();
  const common = path.join(main, '.git');
  const t = makeBranch(main, 'q0000000');
  const head = sh(main, 'git rev-parse main');
  const mk = (n: number) => joinQueue(common, { branch: `thread/x${n}`, path: t.path, base: head, commit: head });
  const es = [1, 2, 3, 4, 5].map(mk);
  fs.writeFileSync(path.join(queueDir(common), `${es[1].id}.json`), JSON.stringify({ ...es[1], limit: 1, limitAt: head }));
  fs.writeFileSync(path.join(queueDir(common), `${es[2].id}.json`), JSON.stringify({ ...es[2], limit: 1, limitAt: 'an-old-main' }));
  fs.writeFileSync(path.join(queueDir(common), `${es[3].id}.json`), JSON.stringify({ ...es[3], result: { landed: head, commits: '', together: [] } }));
  const fix = { ...es[4], fix: true };
  fs.writeFileSync(path.join(queueDir(common), `${fix.id}.json`), JSON.stringify(fix));
  const group = [es[0], es[1], es[2], es[3], fix].map((entry) => ({ entry }));
  // Without the fixes: four counted with the holder, the fix outside.
  halveGroup(common, head, group, false)();
  const put = halveGroup(common, head, group, false);
  assert.deepEqual([0, 1, 2, 4].map((i) => [readEntry(common, es[i].id)?.limit, readEntry(common, es[i].id)?.limitAt]), [[3, head], [1, head], [3, head], [3, head]]);
  assert.equal(readEntry(common, es[4].id)?.ordinaryAt, undefined);
  put();
  // With them: five and the holder, and the fix is halved with the rest.
  const put2 = halveGroup(common, head, group, true);
  assert.deepEqual([0, 1, 2, 4].map((i) => [readEntry(common, es[i].id)?.limit, readEntry(common, es[i].id)?.limitAt]), [[3, head], [1, head], [3, head], [3, head]]);
  assert.equal(readEntry(common, es[4].id)?.ordinaryAt, head);
  assert.equal(readEntry(common, es[3].id)?.limit, undefined, 'one that has landed is left alone');
  put2();
  assert.equal(readEntry(common, es[4].id)?.ordinaryAt, undefined);
  assert.equal(readEntry(common, es[0].id)?.limit, undefined);
  assert.equal(readEntry(common, es[0].id)?.limitAt, undefined);
  assert.deepEqual([readEntry(common, es[1].id)?.limit, readEntry(common, es[1].id)?.limitAt], [1, head]);
  assert.deepEqual([readEntry(common, es[2].id)?.limit, readEntry(common, es[2].id)?.limitAt], [1, 'an-old-main']);
});

test('setAside: one left out of a passing check is set aside, fixes too, and the rest keep their limit on the new main', () => {
  const { main } = makeRepo();
  const common = path.join(main, '.git');
  const base = { path: main, base: 'old', commit: 'x' };
  const one = joinQueue(common, { ...base, branch: 'thread/one', limit: 2, limitAt: 'old' });
  const landed = joinQueue(common, { ...base, branch: 'thread/landed', limit: 2, limitAt: 'old' });
  const out = capture();
  setAside(common, 'old', 'new', 'thread/holder', [one, landed], new Set([landed.id]), out.opts.out);
  assert.match(readEntry(common, one.id)?.alone?.why ?? '', /^Checking thread\/one by itself: a group check with it and thread\/holder failed, and thread\/holder's next check without it passed\.$/);
  assert.equal(readEntry(common, landed.id)?.alone, undefined);
  assert.deepEqual(out.out, ['Set aside to be checked by itself, as the group failed with it and passed without: thread/one.']);
  // It says so while it waits, and nobody stacks it.
  assert.match(waitingLine(common, path.join(common, 'none'), readEntry(common, one.id)), /set aside to be checked by itself/);

  const [x, y, fix] = ['x', 'y', 'fix'].map((n) => joinQueue(common, { ...base, branch: `thread/${n}`, limit: 2, limitAt: 'old', ...(n === 'fix' ? { fix: true } : {}) }));
  const out2 = capture();
  setAside(common, 'old', 'new', 'thread/holder', [x, y, fix], new Set(), out2.opts.out);
  for (const e of [x, y]) {
    assert.equal(readEntry(common, e.id)?.alone, undefined);
    assert.deepEqual([readEntry(common, e.id)?.limit, readEntry(common, e.id)?.limitAt], [2, 'new']);
  }
  assert.ok(readEntry(common, fix.id)?.alone);
  assert.deepEqual(out2.out, ['Set aside to be checked by itself, as the group failed with it and passed without: thread/fix.']);
});

test('a landing set aside is never in anyone else\'s group, and its own tb checks it alone', async () => {
  const { root, main } = makeRepo();
  const [a, b, c, d] = branches(main, ['a', 'b', 'c', 'd']);
  const check = recorded(root, 'true');
  const first = land({ ...a, check }, capture().opts);
  await until(() => fs.existsSync(path.join(root, 'checking')), "a's check");
  const caps = [capture(), capture(), capture()];
  const rest = [b, c, d].map((t, i) => land({ ...t, check }, caps[i].opts));
  const common = path.join(main, '.git');
  try {
    await until(() => caps.every((x) => x.out.some((l) => l.startsWith('Waiting for another landing'))), 'the others waiting');
    const e = waiting(common).find((x) => x.branch === c.branch)!;
    fs.writeFileSync(path.join(queueDir(common), `${e.id}.json`), JSON.stringify({ ...e, alone: { at: Date.now(), why: 'Checking thread/c0000000 by itself: test.' } }));
  } finally {
    write(root, { release: '' });
  }
  assert.equal(await first, 0);
  assert.deepEqual(await Promise.all(rest), [0, 0, 0], said(caps));
  assert.ok(caps[1].out.includes('Checking thread/c0000000 by itself: test.'), said(caps));
  // c landed by itself, and nobody landed with it.
  assert.doesNotMatch(caps[1].out.join('\n'), /In the same check|in one check with/, said(caps));
  for (const i of [0, 2]) assert.doesNotMatch(caps[i].out.join('\n'), /thread\/c0000000/, said(caps));
  for (const n of ['b', 'c', 'd']) assert.ok(fs.existsSync(path.join(main, `${n}.txt`)), n);
});

for (const inCheck of [false, true]) test(`a tb land stopped while it waits ${inCheck ? 'in the running group stays in the line and says so' : 'leaves the line and says so'}`, async () => {
  const { root, main } = makeRepo();
  const [b] = branches(main, ['b']);
  const common = path.join(main, '.git');
  // Someone else holds the landing lock throughout.
  const lock = path.join(common, 'threadbear-land.lock');
  const hold = `touch '${root}/held'; ${holdUntil(`${root}/drop`)}`;
  const holder = spawn('/bin/sh', ['-c', process.platform === 'darwin' ? `/usr/bin/lockf -k '${lock}' /bin/sh -c "${hold}"` : `flock -x '${lock}' /bin/sh -c "${hold}"`], { stdio: 'ignore' });
  holder.on('error', () => {});
  try {
    await until(() => fs.existsSync(path.join(root, 'held')), 'the lock held');
    const src = fileURLToPath(new URL('../../src/worktrees.ts', import.meta.url));
    const script = `import { land } from ${JSON.stringify(src)}; ` +
      `process.exitCode = await land(${JSON.stringify({ ...b, check: 'true' })}, { sayWhenStopped: true });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.stderr.on('data', (d) => (text += d));
    const exited = new Promise<number | null>((r) => child.once('close', (code) => r(code)));
    await until(() => /Waiting for another landing/.test(text), 'the child waiting', 20_000);
    assert.equal(waiting(common).length, 1);
    // As a holder checking a group with it in: that may still land it.
    if (inCheck) setRunning(common, { startedAt: Date.now(), branches: ['thread/holder', b.branch], pid: process.pid, entries: [waiting(common)[0].id] });
    child.kill('SIGTERM');
    assert.equal(await exited, 143, text);
    const entries = fs.readdirSync(queueDir(common)).filter((n) => n.endsWith('.json'));
    if (inCheck) {
      assert.match(text, /while it waited in the landing queue: thread\/b0000000 stays in the line, as it was in a group check: the landings after it carry it and land it once a check with it passes/);
      assert.equal(entries.length, 1, 'left for the holders to land');
      // Marked, so the line keeps it once its tb has gone.
      assert.equal(typeof readEntry(common, entries[0].replace(/\.json$/, ''))?.inCheckAt, 'number');
      assert.equal(waiting(common).length, 1);
    } else {
      assert.match(text, /tb land was stopped \(SIGTERM\) while it waited in the landing queue: thread\/b0000000 is out of the line and nothing of it landed\. Run tb land again to rejoin/);
      assert.deepEqual(entries, []);
    }
  } finally {
    write(root, { drop: '' });
    await new Promise((r) => holder.once('close', r));
  }
});
