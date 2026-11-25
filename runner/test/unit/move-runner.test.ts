// A thread moving between two real Runners (runner/moves.ts), in temp
// homes with fake CLIs: packed on one, planned, placed and adopted on the
// other, its session carried on there, and the old copy put away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FakeAccounts, makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { projectDirName } from '../../src/transcripts.ts';
import { realpath } from '../../src/worktrees.ts';
import { moveInfoFrom, type MoveRow } from '../../src/moves.ts';
import type { Account } from '../../src/protocol.ts';

function machine(accounts: Account[]) {
  return makeHarness(tmpDir('tb-move-home-'), {}, { accounts: new FakeAccounts(accounts) });
}

function row(threadId: string, extra: Partial<MoveRow> = {}): MoveRow {
  return { moveId: 'ab12cd34ef56', threadId, from: 'S1', to: 'T1', state: 'unpacking', createdAt: 1, updatedAt: 1, ...extra };
}

test('a thread moves whole: its log, its queue and its Claude session carry on in the other runner', async () => {
  const work = tmpDir('tb-move-work-');
  const sDir = tmpDir('tb-move-claude-s-');
  const tDir = tmpDir('tb-move-claude-t-');
  const s = machine([{ id: 'claude-main', provider: 'claude', title: 'S login', email: 'alex@example.com', configDir: sDir }]);
  const t = machine([
    { id: 'claude-9', provider: 'claude', title: 'other', email: 'other@example.com', configDir: tmpDir() },
    { id: 'claude-1', provider: 'claude', title: 'T login', email: 'Alex@example.com', configDir: tDir },
  ]);
  const id = s.runner.create({ text: 'Fix the tests', accountId: 'claude-main', cwd: work }).thread.id;
  const cli = s.adapter.last;
  cli.init();
  cli.text('m1:0', 'On it.');
  cli.result('completed');
  await tick();
  const rec = s.runner.threads.get(id)!.rec;
  assert.ok(rec.sessionUsed && rec.nativeSessionId);
  const sid = rec.nativeSessionId!;
  // The CLI's own transcript, where Claude keeps it on S.
  const sProject = path.join(sDir, 'projects', projectDirName(realpath(work)));
  fs.mkdirSync(path.join(sProject, sid, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(sProject, `${sid}.jsonl`), '{"type":"user"}\n');
  fs.writeFileSync(path.join(sProject, sid, 'subagents', 'agent-1.jsonl'), '{}\n');

  // Frozen for the move: a message waits rather than start a turn.
  assert.equal(s.runner.moveIdle(id), true);
  s.runner.setMoving(id, { moveId: 'ab12cd34ef56', to: 'T1', toName: 'cloud', state: 'packing' });
  assert.equal(s.runner.get(id).moving?.toName, 'cloud');
  const before = s.adapter.sessions?.length;
  s.runner.send(id, 'and the docs too');
  await tick();
  assert.equal(s.adapter.sessions?.length, before, 'no turn started while it moves');
  assert.equal(s.runner.threads.get(id)!.rec.queue.length, 1);

  const info = (await s.runner.describeForMove(id, 0))!;
  assert.equal(info.email, 'alex@example.com');
  assert.equal(info.sessionId, sid);
  const r = row(id, { info });
  const plan = await t.runner.planMove(r);
  assert.ok(!('problem' in plan), JSON.stringify(plan));
  if ('problem' in plan) return;
  assert.equal(plan.accountId, 'claude-1', 'the same email, whatever its case');
  assert.equal(plan.cwd, work);

  const packed = await s.runner.packForMove(id, r);
  const paths = packed.entries.map((e) => e.path);
  assert.ok(paths.includes('thread/thread.json') && paths.includes('thread/events.ndjson'));
  assert.ok(paths.includes(`transcript/${sid}.jsonl`) && paths.includes(`transcript/${sid}/subagents/agent-1.jsonl`));
  r.plan = plan;
  await t.runner.placeMove(r, packed.entries);
  assert.equal(t.runner.threads.has(id), false, 'not one of its threads before the switch');

  const sLast = s.store.log(id).lastSeq;
  const adopted = await t.runner.adoptMoved(r);
  assert.equal(adopted.adopted, true);
  await tick();
  const moved = t.runner.threads.get(id)!.rec;
  assert.equal(moved.accountId, 'claude-1');
  assert.equal(moved.cwd, work);
  // Its whole log came, with one line saying where from.
  const notes = t.store.log(id).read(1, t.store.log(id).lastSeq).filter((e: any) => e.type === 'system.note').map((e: any) => e.text);
  assert.ok(notes.some((n: string) => n.startsWith('Moved from S1 to T1, in ')), notes.join(' | '));
  assert.ok(t.store.log(id).lastSeq > sLast);
  // The transcript is where T's login keeps it, and the queued message
  // resumed the same session there.
  const tProject = path.join(tDir, 'projects', projectDirName(realpath(work)));
  assert.equal(fs.readFileSync(path.join(tProject, `${sid}.jsonl`), 'utf8'), '{"type":"user"}\n');
  assert.ok(fs.existsSync(path.join(tProject, sid, 'subagents', 'agent-1.jsonl')));
  assert.equal(t.adapter.last.opts.resume, true);
  assert.equal(t.adapter.last.opts.sessionId, sid);
  assert.equal(t.adapter.last.opts.account.id, 'claude-1');
  // Adopting again does nothing.
  assert.deepEqual(await t.runner.adoptMoved(r), { adopted: false });

  await s.runner.putAwayMoved(id);
  assert.equal(s.runner.threads.has(id), false);
  assert.equal(fs.existsSync(path.join(s.home, 'threads', id)), false);
  assert.equal(fs.readdirSync(path.join(s.home, 'moved')).length, 1);
  assert.ok(s.notes.some((n) => n.method === 'thread.deleted' && (n.params as { threadId: string }).threadId === id));
});

test("with no transcript to carry, the next turn starts afresh with the handoff note", async () => {
  const work = tmpDir('tb-move-work-');
  const s = machine([{ id: 'claude-main', provider: 'claude', title: 'S', configDir: tmpDir() }]);
  const t = machine([{ id: 'claude-1', provider: 'claude', title: 'T', configDir: tmpDir() }]);
  const id = s.runner.create({ text: 'hello', accountId: 'claude-main', cwd: work }).thread.id;
  s.adapter.last.init();
  s.adapter.last.result('completed');
  await tick();
  const r = row(id, { info: (await s.runner.describeForMove(id, 0))! });
  const plan = await t.runner.planMove(r);
  assert.ok(!('problem' in plan));
  r.plan = plan as Exclude<typeof plan, { problem: string }>;
  await t.runner.placeMove(r, (await s.runner.packForMove(id, r)).entries);
  await t.runner.adoptMoved(r);
  t.runner.send(id, 'carry on');
  await tick();
  assert.equal(t.adapter.last.opts.resume, false);
  assert.notEqual(t.adapter.last.opts.sessionId, s.adapter.last.opts.sessionId);
  assert.match(t.adapter.last.sent.at(-1)?.text ?? '', /hello/);
});

test('the plan says why a thread has nowhere to go, and finds its repo by origin', async () => {
  const t = machine([{ id: 'claude-1', provider: 'claude', title: 'T', configDir: tmpDir() }]);
  const base = { title: 'x', home: '/Users/alex', accountId: 'a', permissionMode: 'full', worktree: false, schedules: 0 };
  const plan = (info: Record<string, unknown>, extra: Partial<MoveRow> = {}) => t.runner.planMove(row('t', { info: { ...base, ...info } as never, ...extra }));
  assert.deepEqual(await plan({ cwd: '/Users/alex/nowhere-at-all', provider: 'claude' }), { problem: "There's no folder " + path.join(process.env.HOME!, 'nowhere-at-all') + ' on T1. Pick one to move it into.' });
  assert.deepEqual(await plan({ cwd: '/x', provider: 'codex' }), { problem: 'T1 has no Codex login.' });
  assert.deepEqual(await plan({ cwd: '/x', provider: 'claude' }, { accountId: 'nope' }), { problem: 'T1 has no login nope.' });

  // A repo T has a thread in, under a different path from S's.
  const repo = tmpDir('tb-move-repo-');
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/alex-example/foo']);
  fs.mkdirSync(path.join(repo, 'app'));
  t.runner.create({ text: 'x', accountId: 'claude-1', cwd: repo });
  const found = await plan({ cwd: '/Users/alex/dev/foo/app', provider: 'claude', origin: 'git@github.com:alex-example/foo.git', repoTop: '/Users/alex/dev/foo', subdir: 'app' });
  assert.ok(!('problem' in found));
  assert.equal(!('problem' in found) && found.cwd, path.join(realpath(repo), 'app'));
  // Nowhere it knows, but S's path under its home is, here, a new folder
  // beside a repo this runner works in: cloned there.
  const home = process.env.HOME!;
  const beside = path.relative(realpath(home), realpath(path.dirname(repo)));
  const cloned = await plan({ cwd: `/Users/alex/${beside}/new/app`, provider: 'claude', origin: 'git@github.com:alex-example/other.git', repoTop: `/Users/alex/${beside}/new`, subdir: 'app' });
  // Named for the repo (its origin), not the old runner's folder.
  assert.ok(!('problem' in cloned) && cloned.clone?.to === path.join(home, beside, 'other'), JSON.stringify(cloned));
  assert.equal(!('problem' in cloned) && cloned.cwd, path.join(home, beside, 'other', 'app'));
});

test("a place that can't finish undoes what it made", async () => {
  const work = tmpDir('tb-move-work-');
  const s = machine([{ id: 'claude-main', provider: 'claude', title: 'S', configDir: tmpDir() }]);
  const t = machine([{ id: 'claude-1', provider: 'claude', title: 'T', configDir: tmpDir() }]);
  const id = s.runner.create({ text: 'hello', accountId: 'claude-main', cwd: work }).thread.id;
  s.adapter.last.init();
  s.adapter.last.result('completed');
  await tick();
  // A worktree thread, into a copy of its repo that has no worktree patch.
  execFileSync('git', ['-C', work, 'init', '-q']);
  execFileSync('git', ['-C', work, 'remote', 'add', 'origin', 'https://github.com/alex-example/undo']);
  const info = { ...(await s.runner.describeForMove(id, 0))!, worktree: true };
  const r = row(id, { info, cwd: work, plan: { cwd: work, accountId: 'claude-1', worktree: { repo: work, subdir: '' }, within: work, leftBehind: [] } });
  await assert.rejects(t.runner.placeMove(r, (await s.runner.packForMove(id, r)).entries), /has no worktree patch/);
  assert.equal(fs.existsSync(path.join(t.home, 'moves', r.moveId)), false);
  assert.equal(t.runner.threads.has(id), false);
});

test('a preview says what the thread would leave behind on this machine', async () => {
  const work = tmpDir('tb-move-work-');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: work, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(work, 'a.txt'), 'one');
  git('add', '.');
  git('commit', '-qm', 'one');
  const s = machine([{ id: 'claude-main', provider: 'claude', title: 'S login', configDir: tmpDir() }]);
  const id = s.runner.create({ text: 'Fix it', accountId: 'claude-main', cwd: work }).thread.id;
  assert.deepEqual(await s.runner.leftBehindByMove(id), [], 'nothing to say, so Move to goes straight away');
  fs.writeFileSync(path.join(work, 'a.txt'), 'two');
  const said = await s.runner.leftBehindByMove(id);
  assert.equal(said.length, 1);
  assert.match(said[0], /uncommitted changes in .*share that checkout: a\.txt/);
});

// Security review, 11 Nov 2026 (finding 96): a moved thread.json with
// `"presses": {}` came through placing and adopting as it was, and the
// runner it moved to then exited at every start, as recover went through
// it with no boundary per thread.
test('a moved record with bad press notes is cleaned, and never stops the runner it moves to', async () => {
  const work = tmpDir('tb-move-work-');
  const s = machine([{ id: 'claude-main', provider: 'claude', title: 'S', configDir: tmpDir() }]);
  const tHome = tmpDir('tb-move-home-');
  const accounts = [{ id: 'claude-1', provider: 'claude' as const, title: 'T', configDir: tmpDir() }];
  const t = makeHarness(tHome, {}, { accounts: new FakeAccounts(accounts) });
  const id = s.runner.create({ text: 'hello', accountId: 'claude-main', cwd: work }).thread.id;
  s.adapter.last.init();
  s.adapter.last.result('completed');
  await tick();
  const r = row(id, { info: (await s.runner.describeForMove(id, 0))! });
  const plan = await t.runner.planMove(r);
  assert.ok(!('problem' in plan));
  r.plan = plan as Exclude<typeof plan, { problem: string }>;
  const forged = [
    {},
    { not: 'a list' },
    'nonsense',
    [null, 3, { id: 'b1' }, { id: 'b2', line: 'kept', told: 'yes' }, { id: 'b3', line: 'x'.repeat(10_000), told: { seq: 4, inFlight: 'no' } }],
  ];
  for (const presses of forged) {
    const entries = (await s.runner.packForMove(id, r)).entries.map((e) => {
      if (e.path !== 'thread/thread.json') return e;
      const rec = JSON.parse(e.data.toString('utf8'));
      rec.presses = presses;
      return { ...e, data: Buffer.from(JSON.stringify(rec)) };
    });
    await t.runner.placeMove(r, entries);
    const staged = JSON.parse(fs.readFileSync(path.join(tHome, 'moves', r.moveId, 'thread', 'thread.json'), 'utf8'));
    assert.ok(staged.presses === undefined || Array.isArray(staged.presses), `placed: ${JSON.stringify(presses)}`);
    await t.runner.discardMove(r);
  }
  await t.runner.placeMove(r, (await s.runner.packForMove(id, r)).entries.map((e) => {
    if (e.path !== 'thread/thread.json') return e;
    const rec = JSON.parse(e.data.toString('utf8'));
    rec.presses = forged[3];
    return { ...e, data: Buffer.from(JSON.stringify(rec)) };
  }));
  assert.equal((await t.runner.adoptMoved(r)).adopted, true);
  const live = JSON.parse(fs.readFileSync(path.join(tHome, 'threads', id, 'thread.json'), 'utf8'));
  assert.deepEqual(live.presses, [{ id: 'b2', line: 'kept' }, { id: 'b3', line: 'x'.repeat(2000), told: { seq: 4 } }]);
  // Written as the finding had it, after adoption, and its neighbours as
  // Muse's review found them: the next starts still work.
  live.presses = {};
  live.queue = {};
  live.waitingOn = 'x';
  live.labReview = {};
  live.labReviewOwed = { turnId: 'x' };
  live.highlights = { items: {}, edited: [] };
  live.stoppedMidTurn = 'yes';
  live.needs = { seq: 1, needs: 'nothing', asks: {} };
  live.looseEnds = { seq: 1, ends: 3 };
  live.subagents = [null, 4];
  fs.writeFileSync(path.join(tHome, 'threads', id, 'thread.json'), JSON.stringify(live));
  const again = makeHarness(tHome, {}, { accounts: new FakeAccounts(accounts) });
  const back = again.runner.threads.get(id)!.rec as any;
  assert.equal(back.presses, undefined);
  assert.deepEqual(back.queue, []);
  assert.equal(back.waitingOn, undefined);
  assert.equal(back.labReview, undefined);
  assert.equal(back.highlights, undefined);
  assert.equal(back.stoppedMidTurn, undefined);
  // A wait whose thread isn't named by an id, done, on a hibernating
  // thread: reconcileWaits at start delivered it and threw (Muse's second look).
  live.waitingOn = [{ threadId: 123, title: 'x', done: { at: new Date().toISOString(), how: 'finished' } }, { threadId: 'abc', title: 7 }, { threadId: 'def', title: 'y', review: true, done: { at: new Date().toISOString(), how: 'finished', reply: 123 } }];
  live.reviewVerdict = {};
  live.finished = { at: new Date().toISOString(), reply: 5 };
  live.snoozedUntil = new Date(Date.now() + 86_400_000).toISOString();
  fs.writeFileSync(path.join(tHome, 'threads', id, 'thread.json'), JSON.stringify(live));
  const fourth = makeHarness(tHome, {}, { accounts: new FakeAccounts(accounts) });
  const fourthRec = fourth.runner.threads.get(id)!.rec as any;
  assert.equal(fourthRec.waitingOn.length, 0);
  assert.equal(fourthRec.reviewVerdict, undefined);
  assert.equal(fourthRec.finished.reply, undefined);
  fourth.runner.holdWaits = false;
  fourth.runner.reconcileWaits();
  fourth.runner.startOwedReviews();
  assert.equal(back.needs.asks, undefined);
  assert.equal(back.looseEnds, undefined);
  assert.deepEqual(back.subagents, []);
  again.runner.summary(again.runner.threads.get(id)!);
  const third = makeHarness(tHome, {}, { accounts: new FakeAccounts(accounts) });
  assert.ok(third.runner.threads.has(id));
});

// Daybreak 136 (16 Nov 2026): where a moved thread goes is the target's
// pick. The old runner's description (which a compromised extra Mac
// writes) once put the clone and the thread's folder anywhere: an absolute
// repoTop outside its home came through as it was, and a subdir of `..`
// led out of the repo, with the clone's folder never checked.
function tMachine() {
  return machine([{ id: 'claude-1', provider: 'claude', title: 'T', configDir: tmpDir() }]);
}
const BASE = { title: 'x', home: '/Users/alex', accountId: 'a', permissionMode: 'ask', worktree: false, schedules: 0, provider: 'claude' };
function gitRepo(dir: string, origin: string): string {
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}

test('a subdir that could lead out of the repo is refused, in every form', async () => {
  const t = tMachine();
  const repo = gitRepo(tmpDir('tb-move-repo-'), 'https://github.com/alex-example/sub');
  t.runner.create({ text: 'x', accountId: 'claude-1', cwd: repo });
  for (const subdir of ['..', '../..', '../../etc', 'app/../../..', '/etc', '.', './app', 'app//x', 'app/', '%2e%2e', '..%2fetc', 'app\\..\\..', 'a\u0000b']) {
    const plan = await t.runner.planMove(row('t', { info: { ...BASE, cwd: '/Users/alex/dev/sub', origin: 'git@github.com:alex-example/sub.git', repoTop: '/Users/alex/dev/sub', subdir } as never }));
    assert.ok('problem' in plan, `${JSON.stringify(subdir)}: ${JSON.stringify(plan)}`);
    assert.match((plan as { problem: string }).problem, /didn't describe it properly/);
  }
});

test("a clone goes only to a new folder under this home, beside one of this runner's repos", async () => {
  const t = tMachine();
  const home = realpath(process.env.HOME!);
  const repo = gitRepo(tmpDir('tb-move-repo-'), 'https://github.com/alex-example/mine');
  t.runner.create({ text: 'x', accountId: 'claude-1', cwd: repo });
  const beside = path.relative(home, realpath(path.dirname(repo)));
  const ask = (repoTop: string, home = '/Users/alex', subdir = '', origin = 'git@github.com:attacker/payload.git') => t.runner.planMove(row('t', { info: { ...BASE, home, cwd: repoTop, origin, repoTop, subdir } as never }));
  // Outside the old runner's home: no place here, whatever its parent.
  const outside = tmpDir('tb-move-outside-');
  assert.ok('problem' in (await ask(path.join(outside, 'payload'))));
  assert.ok('problem' in (await ask('/tmp/payload')));
  // Its home claimed as / or as the folder itself changes nothing.
  assert.ok('problem' in (await ask('/etc/payload', '/')), 'under / is under this home, at ~/etc, which has no repo beside it');
  // Under its home, but `..` to leave this one.
  assert.ok('problem' in (await ask('/Users/alex/../../private/tmp/payload')));
  // Somewhere tools load from, where no repo of this runner's is.
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  assert.ok('problem' in (await ask('/Users/alex/.claude/skills/evil')));
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  assert.ok('problem' in (await ask('/Users/alex/Library/LaunchAgents/evil')));
  // The folder is named for the repo, whatever the old runner calls it:
  // never hidden, never one that's there already, never a name tools look
  // for in the folders above them (security review, 16 Nov 2026).
  assert.ok('problem' in (await ask(`/Users/alex/${beside}/x`, '/Users/alex', '', 'git@github.com:attacker/.hidden.git')));
  // (A folder of its own beside the repo, named in lower case: the name
  // from an origin is lowercased, and a mixed-case tmp folder's name only
  // matches it on a Mac's case-insensitive disk.)
  fs.mkdirSync(path.join(path.dirname(repo), 'taken'));
  assert.ok('problem' in (await ask(`/Users/alex/${beside}/x`, '/Users/alex', '', 'https://github.com/attacker/taken')));
  for (const name of ['node_modules', 'bin', 'Vendor', 'site-packages', 'go']) {
    assert.ok('problem' in (await ask(`/Users/alex/${beside}/${name}`, '/Users/alex', '', `https://github.com/attacker/${name}.git`)), name);
  }
  // A clone for a worktree thread: made by hand first, so no worktree
  // patch from a folder above the clone runs its setup in it.
  const wt = await t.runner.planMove(row('t', { info: { ...BASE, cwd: `/Users/alex/${beside}/payload`, origin: 'git@github.com:attacker/payload.git', repoTop: `/Users/alex/${beside}/payload`, subdir: '', worktree: true } as never }));
  assert.ok('problem' in wt && /Clone it there yourself/.test(wt.problem), JSON.stringify(wt));
  // A link beside the repo to elsewhere isn't beside it.
  const elsewhere = tmpDir('tb-move-elsewhere-');
  fs.symlinkSync(elsewhere, path.join(path.dirname(repo), 'via-link'));
  assert.ok('problem' in (await ask(`/Users/alex/${beside}/via-link/payload`)));
  // Even beside one of its own repos, never under a hidden folder or
  // ~/Library, where tools load what they find: a skill's own repo that a
  // thread here works in makes ~/.claude/skills no place to clone to.
  const skill = path.join(home, '.claude', 'skills', 'mine');
  fs.mkdirSync(skill, { recursive: true });
  gitRepo(skill, 'https://github.com/alex-example/skill');
  t.runner.create({ text: 'x', accountId: 'claude-1', cwd: skill });
  assert.ok('problem' in (await ask('/Users/alex/.claude/skills/evil')));
  const agents = path.join(home, 'Library', 'LaunchAgents', 'mine');
  fs.mkdirSync(agents, { recursive: true });
  gitRepo(agents, 'https://github.com/alex-example/agents');
  t.runner.create({ text: 'x', accountId: 'claude-1', cwd: agents });
  assert.ok('problem' in (await ask('/Users/alex/Library/LaunchAgents/evil')));
  // A plain name that links into one of those.
  fs.symlinkSync(path.join(home, '.claude', 'skills'), path.join(home, 'skills-link'));
  assert.ok('problem' in (await ask('/Users/alex/skills-link/evil')));
  // The real thing: a new folder beside it.
  const ok = await ask(`/Users/alex/${beside}/payload`);
  assert.ok(!('problem' in ok) && ok.clone?.to === path.join(home, beside, 'payload'), JSON.stringify(ok));
});

test("the thread's folder in a repo found here can't lead out of it through a link", async () => {
  const t = tMachine();
  const repo = gitRepo(tmpDir('tb-move-repo-'), 'https://github.com/alex-example/linked');
  t.runner.create({ text: 'x', accountId: 'claude-1', cwd: repo });
  fs.symlinkSync(tmpDir('tb-move-secret-'), path.join(repo, 'out'));
  const plan = await t.runner.planMove(row('t', { info: { ...BASE, cwd: '/Users/alex/dev/linked/out', origin: 'git@github.com:alex-example/linked.git', repoTop: '/Users/alex/dev/linked', subdir: 'out' } as never }));
  assert.ok('problem' in plan && /leads out of/.test(plan.problem), JSON.stringify(plan));
});

test("a folder that's no repo goes only to the same place under this home", async () => {
  const t = tMachine();
  const home = realpath(process.env.HOME!);
  const ask = (cwd: string, home = '/Users/alex') => t.runner.planMove(row('t', { info: { ...BASE, home, cwd } as never }));
  assert.ok('problem' in (await ask('/etc')), 'outside its home');
  assert.ok('problem' in (await ask('/Users/alex/../../etc')), 'not normalised');
  const inHome = tmpDir('tb-move-plain-');
  const rel = path.relative(home, realpath(inHome));
  const ok = await ask(`/Users/alex/${rel}`);
  assert.ok(!('problem' in ok) && ok.cwd === path.join(home, rel), JSON.stringify(ok));
  // A link under this home that leads out of it.
  fs.symlinkSync(realpath('/etc'), path.join(inHome, 'etc-link'));
  const linked = await ask(`/Users/alex/${rel}/etc-link`);
  assert.ok('problem' in linked && /leads out of the home folder/.test(linked.problem), JSON.stringify(linked));
});

test('placing plans again: a plan the backend changed, or a folder swapped for a link since, places nothing', async () => {
  const s = machine([{ id: 'claude-main', provider: 'claude', title: 'S', configDir: tmpDir() }]);
  const t = tMachine();
  const repo = gitRepo(tmpDir('tb-move-repo-'), 'https://github.com/alex-example/swap');
  fs.mkdirSync(path.join(repo, 'app'));
  t.runner.create({ text: 'x', accountId: 'claude-1', cwd: repo });
  const work = tmpDir('tb-move-work-');
  const id = s.runner.create({ text: 'hello', accountId: 'claude-main', cwd: work }).thread.id;
  s.adapter.last.init();
  s.adapter.last.result('completed');
  await tick();
  const info = { ...BASE, cwd: '/Users/alex/dev/swap/app', origin: 'git@github.com:alex-example/swap.git', repoTop: '/Users/alex/dev/swap', subdir: 'app' };
  const r = row(id, { info: info as never });
  const plan = await t.runner.planMove(r);
  assert.ok(!('problem' in plan), JSON.stringify(plan));
  const entries = (await s.runner.packForMove(id, r)).entries;
  // The row's plan as a backend could hand it back: somewhere else.
  await assert.rejects(t.runner.placeMove({ ...r, plan: { ...(plan as never as object), cwd: '/etc' } as never }, entries), /changed since the move was planned/);
  assert.equal(fs.existsSync(path.join(t.home, 'moves', r.moveId)), false);
  // The folder swapped for a link out between planning and placing.
  fs.rmSync(path.join(repo, 'app'), { recursive: true });
  fs.symlinkSync(tmpDir('tb-move-secret-'), path.join(repo, 'app'));
  await assert.rejects(t.runner.placeMove({ ...r, plan: plan as never }, entries), /leads out of/);
  assert.equal(t.runner.threads.has(id), false);
  assert.equal(fs.existsSync(path.join(t.home, 'moves', r.moveId)), false);
});

test("a repo directly in this home doesn't make the home a place to clone to", async () => {
  const t = tMachine();
  const home = realpath(process.env.HOME!);
  const top = path.join(home, 'toplevel-repo');
  fs.mkdirSync(top, { recursive: true });
  gitRepo(top, 'https://github.com/alex-example/top');
  t.runner.create({ text: 'x', accountId: 'claude-1', cwd: top });
  const plan = await t.runner.planMove(row('t', { info: { ...BASE, cwd: '/Users/alex/bin', origin: 'https://github.com/attacker/payload.git', repoTop: '/Users/alex/payload' } as never }));
  assert.ok('problem' in plan, JSON.stringify(plan));
});

test('the home itself, a hidden folder or ~/Library is never a folder picked on the old runner\'s word', async () => {
  const t = tMachine();
  const home = realpath(process.env.HOME!);
  const ask = (cwd: string, extra: Record<string, unknown> = {}) => t.runner.planMove(row('t', { info: { ...BASE, cwd, ...extra } as never }));
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Library', 'Application Support'), { recursive: true });
  assert.ok('problem' in (await ask('/Users/alex')));
  assert.ok('problem' in (await ask('/Users/alex/.ssh')));
  assert.ok('problem' in (await ask('/Users/alex/Library/Application Support')));
  fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'keys'));
  assert.ok('problem' in (await ask('/Users/alex/keys')), 'a plain name linking to one');
  // A repo under a hidden folder, named by its real origin, isn't found there.
  const dot = path.join(home, '.dotfiles');
  fs.mkdirSync(dot, { recursive: true });
  gitRepo(dot, 'https://github.com/alex-example/dotfiles');
  const found = await ask('/Users/alex/.dotfiles', { origin: 'https://github.com/alex-example/dotfiles', repoTop: '/Users/alex/.dotfiles', subdir: '' });
  assert.ok('problem' in found, JSON.stringify(found));
  // Mike's own pick still goes anywhere he says.
  const picked = await t.runner.planMove(row('t', { cwd: path.join(home, '.ssh'), info: { ...BASE, cwd: '/Users/alex/.ssh' } as never }));
  assert.ok(!('problem' in picked), JSON.stringify(picked));
});

test("a thread whose folder is reached through a link describes itself honestly", async () => {
  const s = machine([{ id: 'claude-main', provider: 'claude', title: 'S', configDir: tmpDir() }]);
  const repo = gitRepo(tmpDir('tb-move-repo-'), 'https://github.com/alex-example/linkdesc');
  fs.mkdirSync(path.join(repo, 'app'));
  const via = path.join(tmpDir('tb-move-via-'), 'code');
  fs.symlinkSync(repo, via);
  const id = s.runner.create({ text: 'x', accountId: 'claude-main', cwd: path.join(via, 'app') }).thread.id;
  const info = (await s.runner.describeForMove(id, 0))!;
  assert.equal(info.subdir, 'app');
  assert.ok(moveInfoFrom(info), 'the description passes its own checks');
});

// Security review, 17 Nov 2026: a clone checked only its own name against
// the folders tools load from, so with a checkout inside a node_modules that
// one of this runner's threads works in (a thread moved there earlier, say),
// a missing package could be cloned beside it and loaded by the app above.
// Every folder on the way counts, and S's path never finds a repo there.
test("a clone never goes inside a node_modules or vendor, even beside one of this runner's repos", async () => {
  const t = tMachine();
  const home = realpath(process.env.HOME!);
  const app = tmpDir('tb-move-app-');
  const nested = path.join(app, 'node_modules', 'local-copy');
  fs.mkdirSync(nested, { recursive: true });
  gitRepo(nested, 'https://github.com/alex-example/local-copy');
  const rel = path.relative(home, realpath(app));
  // S's path names the nested checkout: not found there on its word.
  const found = await t.runner.planMove(row('t', { info: { ...BASE, cwd: `/Users/alex/${rel}/node_modules/local-copy`, origin: 'https://github.com/alex-example/local-copy.git', repoTop: `/Users/alex/${rel}/node_modules/local-copy`, subdir: '' } as never }));
  assert.ok('problem' in found, JSON.stringify(found));
  // A thread here works in it: still no clone beside it, nor a move into it.
  t.runner.create({ text: 'x', accountId: 'claude-1', cwd: nested });
  const clone = await t.runner.planMove(row('t', { info: { ...BASE, cwd: `/Users/alex/${rel}/node_modules/whatever`, origin: 'https://github.com/attacker/missing-dependency.git', repoTop: `/Users/alex/${rel}/node_modules/whatever`, subdir: '' } as never }));
  assert.ok('problem' in clone && !('clone' in clone), JSON.stringify(clone));
  const into = await t.runner.planMove(row('t', { info: { ...BASE, cwd: '/Users/alex/elsewhere/local-copy', origin: 'https://github.com/alex-example/local-copy.git', repoTop: '/Users/alex/elsewhere/local-copy', subdir: '' } as never }));
  assert.ok('problem' in into, JSON.stringify(into));
  // Through a plain name that links into a vendor folder, the same.
  const vendor = path.join(app, 'vendor', 'gem');
  fs.mkdirSync(vendor, { recursive: true });
  gitRepo(vendor, 'https://github.com/alex-example/gem');
  t.runner.create({ text: 'x', accountId: 'claude-1', cwd: vendor });
  fs.symlinkSync(path.join(app, 'vendor'), path.join(app, 'plain'));
  const linked = await t.runner.planMove(row('t', { info: { ...BASE, cwd: `/Users/alex/${rel}/plain/payload`, origin: 'https://github.com/attacker/payload.git', repoTop: `/Users/alex/${rel}/plain/payload`, subdir: '' } as never }));
  assert.ok('problem' in linked && !('clone' in linked), JSON.stringify(linked));
});

// Security review, 17 Nov 2026: a home that's itself a git repo (dotfiles)
// and one of this runner's threads working in it made the home a repo found
// by origin, whose subdir could be Library/LaunchAgents or .ssh.
test('a home that is a repo is never where a thread goes on the old runner\'s word', async () => {
  const t = tMachine();
  const home = realpath(process.env.HOME!);
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  gitRepo(home, 'https://github.com/alex-example/dotfiles');
  try {
    t.runner.create({ text: 'x', accountId: 'claude-1', cwd: home });
    for (const subdir of ['Library/LaunchAgents', '.ssh', '']) {
      const plan = await t.runner.planMove(row('t', { info: { ...BASE, home: '/s', cwd: `/s/${subdir}`, origin: 'https://github.com/alex-example/dotfiles.git', repoTop: '/s', subdir } as never }));
      assert.ok('problem' in plan, `${subdir}: ${JSON.stringify(plan)}`);
    }
    // Mike's pick of it still goes.
    const picked = await t.runner.planMove(row('t', { cwd: home, info: { ...BASE, home: '/s', cwd: '/s', origin: 'https://github.com/alex-example/dotfiles.git', repoTop: '/s', subdir: '' } as never }));
    assert.ok(!('problem' in picked), JSON.stringify(picked));
  } finally {
    fs.rmSync(path.join(home, '.git'), { recursive: true, force: true });
  }
});

// Security review, 17 Nov 2026 (second pass): S's path through a link in
// this home to a checkout outside it found that checkout by origin, though
// none of this runner's threads works there.
test("S's path through a link in this home never finds a repo outside it", async () => {
  const t = tMachine();
  const home = realpath(process.env.HOME!);
  const outside = fs.mkdtempSync(path.join(realpath('/tmp'), 'tb-move-external-'));
  try {
    gitRepo(outside, 'https://example.com/o/project.git');
    const inHome = tmpDir('tb-move-linkhome-');
    fs.symlinkSync(outside, path.join(inHome, 'project'));
    const rel = path.relative(home, realpath(inHome));
    const plan = await t.runner.planMove(row('t', { info: { ...BASE, cwd: `/Users/alex/${rel}/project`, origin: 'https://example.com/o/project.git', repoTop: `/Users/alex/${rel}/project`, subdir: '' } as never }));
    assert.ok('problem' in plan, JSON.stringify(plan));
    // One of this runner's own threads works there: then it's this runner's repo.
    t.runner.create({ text: 'x', accountId: 'claude-1', cwd: outside });
    const known = await t.runner.planMove(row('t', { info: { ...BASE, cwd: `/Users/alex/${rel}/project`, origin: 'https://example.com/o/project.git', repoTop: `/Users/alex/${rel}/project`, subdir: '' } as never }));
    assert.ok(!('problem' in known) && realpath(known.cwd) === realpath(outside), JSON.stringify(known));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// Security review, 17 Nov 2026 (second pass): S's subdir naming a hidden or
// installed packages' folder in the repo (.git, node_modules/x) runs the
// thread at the repo's top instead, said in what stays behind.
test("a subdir that's a hidden or packages' folder in the repo runs at its top", async () => {
  const t = tMachine();
  const repo = gitRepo(tmpDir('tb-move-repo-'), 'https://github.com/alex-example/pkgs');
  fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src', 'lib'), { recursive: true });
  fs.symlinkSync(path.join(repo, '.git'), path.join(repo, 'plain'));
  t.runner.create({ text: 'x', accountId: 'claude-1', cwd: repo });
  const ask = (subdir: string) => t.runner.planMove(row('t', { info: { ...BASE, cwd: `/Users/alex/dev/pkgs/${subdir}`, origin: 'git@github.com:alex-example/pkgs.git', repoTop: '/Users/alex/dev/pkgs', subdir } as never }));
  for (const subdir of ['.git', 'node_modules/left-pad', 'plain']) {
    const plan = await ask(subdir);
    assert.ok(!('problem' in plan) && plan.cwd === repo && plan.leftBehind.some((l) => /runs at the top/.test(l)), `${subdir}: ${JSON.stringify(plan)}`);
  }
  const ok = await ask('src/lib');
  assert.ok(!('problem' in ok) && ok.cwd === path.join(repo, 'src', 'lib'), JSON.stringify(ok));
});

// Security review, 17 Nov 2026 (third pass): a worktree is made in the repo
// its patch is in, and a nested checkout with no patch of its own found its
// parent repo's by looking upward, so the thread's worktree would have been
// made in that other repo, never previewed.
test("a worktree thread's repo needs a worktree patch of its own, not a parent repo's", async () => {
  const t = tMachine();
  const commit = (dir: string, origin: string) => {
    const g = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    g('add', 'a.txt');
    g('commit', '-qm', 'a');
    g('remote', 'add', 'origin', origin);
  };
  const outer = tmpDir('tb-move-outer-');
  commit(outer, 'https://example.com/outer.git');
  fs.mkdirSync(path.join(outer, '.threadbear', 'patches'), { recursive: true });
  fs.writeFileSync(path.join(outer, '.threadbear', 'patches', 'w.ts'), 'export default { worktree: {} };\n');
  const inner = path.join(outer, 'inner');
  fs.mkdirSync(inner);
  commit(inner, 'https://example.com/inner.git');
  const home = realpath(process.env.HOME!);
  const rel = path.relative(home, realpath(inner));
  const info = { ...BASE, cwd: `/Users/alex/${rel}`, origin: 'https://example.com/inner.git', repoTop: `/Users/alex/${rel}`, subdir: '', worktree: true };
  const preview = await t.runner.previewMove({ info: info as never, self: 'T1' });
  assert.ok(preview.problems.some((p) => /no worktree patch of its own/.test(p)), JSON.stringify(preview));
  // The parent repo itself, with its own patch: fine.
  const outerRel = path.relative(home, realpath(outer));
  const own = await t.runner.previewMove({ info: { ...info, cwd: `/Users/alex/${outerRel}`, origin: 'https://example.com/outer.git', repoTop: `/Users/alex/${outerRel}` } as never, self: 'T1' });
  assert.deepEqual(own.problems, [], JSON.stringify(own));
});

// Security review, 17 Nov 2026 (third pass): this runner's own repos are
// all known before a match from S's path is weighed, so a linked checkout
// in this home of a repo whose main checkout is outside it still goes.
test("a linked checkout of one of this runner's repos outside the home is found from S's path", async () => {
  const t = tMachine();
  const home = realpath(process.env.HOME!);
  const outside = fs.mkdtempSync(path.join(realpath('/tmp'), 'tb-move-main-'));
  try {
    const g = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
    g(outside, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(outside, 'a.txt'), 'a\n');
    g(outside, 'add', 'a.txt');
    g(outside, 'commit', '-qm', 'a');
    g(outside, 'remote', 'add', 'origin', 'https://example.com/o/project.git');
    const parent = tmpDir('tb-move-linked-');
    const linked = path.join(parent, 'project');
    g(outside, 'worktree', 'add', '-q', '-b', 'side', linked);
    t.runner.create({ text: 'x', accountId: 'claude-1', cwd: outside });
    const rel = path.relative(home, realpath(linked));
    const plan = await t.runner.planMove(row('t', { info: { ...BASE, cwd: `/Users/alex/${rel}`, origin: 'https://example.com/o/project.git', repoTop: `/Users/alex/${rel}`, subdir: '' } as never }));
    assert.ok(!('problem' in plan) && realpath(plan.cwd) === realpath(outside), JSON.stringify(plan));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// Codex's review, 23 Nov 2026: T now asks for a claim again after placing,
// for up to the move's thirty minutes, so a restart in that time places the
// thread again. Placing emptied the staging folder first, and with it the
// only record of what the earlier placing made (a worktree, a transcript),
// which stayed and could block the new one. Now that's undone first.
test('a move placed whole is known after a restart, and placing again after a partway one undoes what it made first', async () => {
  const work = tmpDir('tb-move-work-');
  const s = machine([{ id: 'claude-main', provider: 'claude', title: 'S', configDir: tmpDir() }]);
  const tHome = tmpDir('tb-move-home-');
  const t = makeHarness(tHome, {}, { accounts: new FakeAccounts([{ id: 'claude-1', provider: 'claude', title: 'T', configDir: tmpDir() }]) });
  const id = s.runner.create({ text: 'hello', accountId: 'claude-main', cwd: work }).thread.id;
  s.adapter.last.init();
  s.adapter.last.result('completed');
  await tick();
  const r = row(id, { info: (await s.runner.describeForMove(id, 0))!, expect: 'binding-1' });
  const plan = await t.runner.planMove(r);
  assert.ok(!('problem' in plan));
  r.plan = plan as Exclude<typeof plan, { problem: string }>;
  const entries = (await s.runner.packForMove(id, r)).entries;
  assert.equal(t.runner.movePlaced(r), false, 'nothing placed yet');
  await t.runner.placeMove(r, entries);
  assert.equal(t.runner.movePlaced(r), true, 'placed whole: a restarted runner only asks for the claim');
  assert.equal(t.runner.movePlaced({ ...r, expect: 'binding-2' }), false, 'a row whose binding changed places afresh');
  assert.equal(t.runner.movePlaced({ ...r, threadId: 'f'.repeat(36) }), false, 'nor one naming another thread');
  // An earlier placing that stopped partway, and what it left, as its
  // placed.json records it.
  const placedFile = path.join(tHome, 'moves', r.moveId, 'placed.json');
  const earlier = path.join(tmpDir('tb-move-transcript-'), 'earlier.jsonl');
  fs.writeFileSync(earlier, '{}\n');
  const { whole: _whole, ...partway } = JSON.parse(fs.readFileSync(placedFile, 'utf8'));
  fs.writeFileSync(placedFile, JSON.stringify({ ...partway, transcript: [earlier] }));
  assert.equal(t.runner.movePlaced(r), false);
  await t.runner.placeMove(r, entries);
  assert.equal(fs.existsSync(earlier), false, "the earlier placing's transcript went");
  assert.equal((await t.runner.adoptMoved(r)).adopted, true, 'placed again, whole');
});
