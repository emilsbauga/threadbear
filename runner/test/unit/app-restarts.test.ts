import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHarness } from '../helpers/fakes.ts';
import { AppRestarts, asksForAppRestart } from '../../src/app-restarts.ts';
import { nullLogger } from '../../src/log.ts';

const A = { commit: 'aaaa1111', short: 'aaaa111', tree: 'tree-a' };
const B = { commit: 'bbbb2222', short: 'bbbb222', tree: 'tree-b' };

function setUp() {
  const h = makeHarness();
  const watcher = new AppRestarts({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger });
  const { thread } = h.runner.create({ text: 'Build the dock', accountId: 'claude-3' });
  h.adapter.last.init();
  return { h, watcher, thread };
}

const said = (h: ReturnType<typeof makeHarness>, threadId: string) => {
  const evs = h.events(threadId);
  return {
    note: evs.findLast((e) => e.type === 'system.note' && String(e.text).startsWith('Threadbear app restarted'))?.text,
    message: evs.findLast((e) => e.type === 'user.message' && e.origin === 'runner')?.text,
  };
};

test('a thread waiting hears when the app comes back on another build', () => {
  const { h, watcher, thread } = setUp();
  watcher.appHello(A);
  watcher.watch(thread.id);
  // The same build again (the app reconnecting to a restarted runner): nothing.
  watcher.appHello(A);
  assert.equal(said(h, thread.id).message, undefined);
  watcher.appHello(B);
  const { note, message } = said(h, thread.id);
  assert.equal(note, 'Threadbear app restarted: aaaa111 to bbbb222');
  assert.match(message, /restarted onto bbbb222/);
  // Once only.
  watcher.appHello({ ...A, tree: 'tree-c' });
  assert.equal(h.events(thread.id).filter((e) => e.type === 'user.message' && e.origin === 'runner').length, 1);
});

test('the agent\'s own text is sent, and the last request wins', () => {
  const { h, watcher, thread } = setUp();
  watcher.appHello(A);
  watcher.watch(thread.id, 'Check the dock in the real app.');
  watcher.watch(thread.id, 'Check the panels move.');
  watcher.appHello(B);
  assert.match(said(h, thread.id).message, /Check the panels move\.$/);
});

test('remembered across a runner restart', () => {
  const { h, watcher, thread } = setUp();
  watcher.appHello(A);
  watcher.watch(thread.id);
  const again = new AppRestarts({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger });
  again.appHello(A);
  assert.equal(said(h, thread.id).message, undefined);
  again.appHello(B);
  assert.match(said(h, thread.id).message, /restarted onto bbbb222/);
});

test('an archived thread or a stale request only gets the note', () => {
  const { h, watcher, thread } = setUp();
  watcher.appHello(A);
  watcher.watch(thread.id);
  h.clock.advance(25 * 60 * 60_000);
  watcher.appHello(B);
  assert.equal(said(h, thread.id).message, undefined);
  assert.match(said(h, thread.id).note, /more than a day old/);
});

test('a thread on a draining runner hears once it comes across', () => {
  // THREADBEAR-5: the app came back while the thread was finishing a turn
  // on the old runner; the primary said "Thread not found" and dropped
  // the request.
  const { h, thread } = setUp();
  const warned: string[] = [];
  // The primary as the watcher sees it: the thread is on a draining
  // runner, so this one hasn't got it.
  const away = new Set<string>();
  const primary = { has: (id: string) => !away.has(id) && h.runner.has(id), get: h.runner.get.bind(h.runner), note: h.runner.note.bind(h.runner), send: h.runner.send.bind(h.runner) };
  const watcher = new AppRestarts({ runner: primary, home: h.home, clock: h.clock, log: { ...nullLogger, warn: (m) => void warned.push(m) }, away: (id) => away.has(id) });
  watcher.appHello(A);
  watcher.watch(thread.id);
  h.adapter.last.result('completed');
  away.add(thread.id);
  watcher.appHello(B);
  assert.deepEqual(warned, []);
  assert.equal(said(h, thread.id).note, undefined);
  assert.equal(watcher.isWatching(thread.id), true, 'still waiting to tell it');
  // It comes across: now it hears, about the build the app came back on.
  away.delete(thread.id);
  watcher.adopted(thread.id);
  assert.deepEqual(warned, []);
  assert.match(said(h, thread.id).message, /restarted onto bbbb222/);
  assert.equal(said(h, thread.id).note, 'Threadbear app restarted: aaaa111 to bbbb222');
  assert.equal(watcher.isWatching(thread.id), false);
  // Once only.
  watcher.adopted(thread.id);
  assert.equal(h.events(thread.id).filter((e) => e.type === 'user.message' && e.origin === 'runner').length, 1);
});

test('a deleted thread is dropped quietly', () => {
  const { h, thread } = setUp();
  const warned: string[] = [];
  const watcher = new AppRestarts({ runner: h.runner, home: h.home, clock: h.clock, log: { ...nullLogger, warn: (m) => void warned.push(m) }, away: () => false });
  watcher.appHello(A);
  watcher.watch(thread.id);
  h.runner.delete(thread.id);
  watcher.appHello(B);
  assert.deepEqual(warned, []);
  assert.equal(watcher.isWatching(thread.id), false);
});

test('asks that tell Alex to restart the app count as a request', () => {
  assert.equal(asksForAppRestart([{ action: 'Click Restart to Update in the Threadbear menu' }]), true);
  assert.equal(asksForAppRestart([{ action: 'Restart Threadbear', where: 'Threadbear menu > Restart to Update' }]), true);
  // The ask is one paragraph now, so the words can be in its why.
  assert.equal(asksForAppRestart([{ action: 'Try the new card', why: 'It needs Restart to Update in the Threadbear menu first.' }]), true);
  assert.equal(asksForAppRestart([{ action: 'Restart the runner' }]), false);
  assert.equal(asksForAppRestart(undefined), false);
});

test('end_turn asking for Restart to Update signs the thread up; wait_for_app_restart sets the text', async () => {
  const { buildThreadbearTools } = await import('../../src/threadbear-mcp.ts');
  const { h, watcher, thread } = setUp();
  watcher.appHello(A);
  const tools = buildThreadbearTools(h.runner, thread.id, Date.now, undefined, undefined, watcher);
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)!;
    const r = (await t.handler(args as never, {})) as { content: { text: string }[] };
    return r.content.map((c) => c.text).join('\n');
  };
  const reply = await call('end_turn', { needs: 'you', asks: [{ action: 'Click Restart to Update', why: 'To check the fix.' }] });
  assert.match(reply, /message here when the app restarts/);
  assert.equal(watcher.isWatching(thread.id), true);
  // Asks about something else don't.
  const { thread: other } = h.runner.create({ text: 'Other', accountId: 'claude-3' });
  const otherTools = buildThreadbearTools(h.runner, other.id, Date.now, undefined, undefined, watcher);
  await otherTools.find((x) => x.name === 'end_turn')!.handler({ needs: 'you', asks: [{ action: 'Paste the key', why: 'The deploy needs it.' }] } as never, {});
  assert.equal(watcher.isWatching(other.id), false);
  // Every ask has to say why: a card with only an action and a place
  // left Mike guessing (28 Oct). The schema refuses one without.
  const shape = (buildThreadbearTools(h.runner, thread.id, Date.now, undefined, undefined, watcher, { provider: 'codex' }).find((x) => x.name === 'end_turn')!.inputSchema as any).asks;
  assert.equal(shape.safeParse([{ action: 'Fix the Slack draft', where: 'Slack' }]).success, false);
  assert.equal(shape.safeParse([{ action: 'Fix the Slack draft', why: 'It says Hayden; he is Pete.', links: [{ title: 'Open the Slack message', url: 'https://x.slack.com/archives/C1/p1' }] }]).success, true);
  // The tool's text is what's sent.
  assert.match(await call('wait_for_app_restart', { text: 'Drag Highlights about.' }), /aaaa111/);
  watcher.appHello(B);
  assert.match(said(h, thread.id).message, /Drag Highlights about\.$/);
});

test('a turn whose end_turn was refused still signs up from its closing "What I need from you"', () => {
  // The thread that asked Mike to reply "restarted" instead (29 Oct).
  const asked: string[] = [];
  const h = makeHarness(undefined, {}, { appRestartAsked: (id) => asked.push(id) });
  const { thread } = h.runner.create({ text: 'Share a thread', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  s.text('m1', 'Landed.\n\n**What I need from you**\n\n1. Choose Restart to Update from the Threadbear menu, then reply "restarted".');
  s.result('completed');
  assert.deepEqual(asked, [thread.id]);
  // A turn asking for something else doesn't.
  h.runner.send(thread.id, 'ok');
  h.adapter.last.text('m2', 'Done.\n\n**What I need from you**\n\n1. Paste the key.');
  h.adapter.last.result('completed');
  assert.deepEqual(asked, [thread.id]);
});

const D1 = { commit: 'dddd1111', short: 'dddd111', tree: 'desktop-1' };
const D2 = { commit: 'dddd2222', short: 'dddd222', tree: 'desktop-2' };

test('the GPUI app restarting is told apart from the Swift app', () => {
  const { h, watcher, thread } = setUp();
  watcher.appHello(A);
  watcher.appHello(D1, 'desktop');
  watcher.watch(thread.id);
  // Each reconnecting on the build it had: nothing.
  watcher.appHello(A);
  watcher.appHello(D1, 'desktop');
  assert.equal(said(h, thread.id).message, undefined);
  watcher.appHello(D2, 'desktop');
  const evs = h.events(thread.id);
  assert.equal(evs.findLast((e) => e.type === 'system.note')?.text, 'Threadbear GPUI app restarted: dddd111 to dddd222');
  assert.match(String(evs.findLast((e) => e.type === 'user.message' && e.origin === 'runner')?.text), /The Threadbear GPUI app has restarted onto dddd222/);
  assert.equal(watcher.isWatching(thread.id), false);
});

test("the GPUI app's first build isn't a restart of the Swift app a thread waits for", () => {
  // Before the GPUI app said its build, a thread only knew the Swift app's.
  const { h, watcher, thread } = setUp();
  watcher.appHello(A);
  watcher.watch(thread.id);
  watcher.appHello(D1, 'desktop');
  assert.equal(said(h, thread.id).message, undefined);
  assert.equal(watcher.isWatching(thread.id), true);
  watcher.appHello(B);
  assert.match(said(h, thread.id).message, /restarted onto bbbb222/);
});

test('with no build known at all, either app coming back counts', () => {
  const { h, watcher, thread } = setUp();
  watcher.watch(thread.id);
  watcher.appHello(D1, 'desktop');
  assert.match(String(h.events(thread.id).findLast((e) => e.type === 'user.message' && e.origin === 'runner')?.text), /GPUI app has restarted onto dddd111/);
});

// With both apps connected, what the wait says it's waiting to change from
// names each one's build: it named only the frozen Swift app's (13 Nov).
test('the wait names each running app with its build', () => {
  const { watcher, thread } = setUp();
  watcher.appHello(A, 'mac');
  watcher.appHello(B, 'desktop');
  assert.equal(watcher.watch(thread.id).running, 'the GPUI app on bbbb222, the Swift app on aaaa111');
  const { watcher: w2, thread: t2 } = setUp();
  w2.appHello(B, 'desktop');
  assert.equal(w2.watch(t2.id).running, 'the GPUI app on bbbb222');
  const { watcher: w3, thread: t3 } = setUp();
  assert.equal(w3.watch(t3.id).running, undefined);
});

// 2f98f449, 17 Nov: the GPUI app swapped in a build it had staged hours
// before the thread landed, and the thread was told to check a change the
// running app didn't have.
test('a new build without the commit the thread waits for keeps it waiting', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const { h, watcher, thread } = setUp();
  const repo = h.runner.get(thread.id).cwd;
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  const commit = (msg: string) => {
    fs.writeFileSync(`${repo}/f`, msg);
    git('add', 'f');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  const staged = commit('staged earlier');
  const landed = commit('the change');
  const D = (c: string, tree: string) => ({ commit: c, short: c.slice(0, 7), tree });
  watcher.appHello(D(staged, 'tree-0'), 'desktop');
  const { waitingFor } = watcher.watch(thread.id);
  assert.equal(waitingFor, landed.slice(0, 9));
  // The older staged build swapped in under a new tree: a note, no message.
  watcher.appHello(D(staged, 'tree-1'), 'desktop');
  assert.equal(said(h, thread.id).message, undefined);
  assert.match(String(h.events(thread.id).findLast((e) => e.type === 'system.note')?.text), /doesn't have .* yet\. Still waiting\./);
  assert.ok(watcher.isWatching(thread.id));
  // Reconnecting on that same build isn't news again.
  const notes = () => h.events(thread.id).filter((e) => e.type === 'system.note').length;
  const before = notes();
  watcher.appHello(D(staged, 'tree-1'), 'desktop');
  assert.equal(notes(), before);
  // A build of main after the landing tells it.
  const later = commit('someone else, later');
  watcher.appHello(D(later, 'tree-2'), 'desktop');
  assert.match(said(h, thread.id).message, new RegExp(`restarted onto ${later.slice(0, 7)}`));
  assert.ok(!watcher.isWatching(thread.id));
});

test('a named commit, and a build git can\'t place, keep waiting', () => {
  const { h, thread } = setUp();
  const asked: string[] = [];
  const watcher = new AppRestarts({
    runner: h.runner, home: h.home, clock: h.clock, log: nullLogger,
    git: {
      resolve: (_repo, rev) => (asked.push(rev), rev === 'mine' ? 'c0ffee1234567' : undefined),
      contains: () => undefined,
    },
  });
  watcher.appHello(A);
  assert.equal(watcher.watch(thread.id, undefined, 'mine').waitingFor, 'c0ffee123');
  assert.deepEqual(asked, ['mine']);
  // Git can't tell: not news, as the build may not have it (19 Nov).
  watcher.appHello(B);
  assert.equal(said(h, thread.id).message, undefined);
  assert.ok(watcher.isWatching(thread.id));
});

// 42071b05, 19 Nov: a thread in ~/dev/me/misc named a Threadbear commit
// its folder doesn't have, the watch fell back to any new build, and it was
// told the GPUI app had restarted onto main from just before its landing.
test('a commit named from a thread outside the repo is looked for in the apps\' checkout', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = makeHarness();
  const appRepo = fs.mkdtempSync(path.join(h.home, 'app-repo-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', appRepo, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  const commit = (msg: string) => {
    fs.writeFileSync(`${appRepo}/f`, msg);
    git('add', 'f');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  const before = commit('main before the landing');
  const landed = commit('the settings change');
  const watcher = new AppRestarts({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, appRepo });
  const { thread } = h.runner.create({ text: 'Panel of reviewers', accountId: 'claude-3' });
  h.adapter.last.init();
  const D = (c: string, tree: string) => ({ commit: c, short: c.slice(0, 9), tree });
  watcher.appHello(D(before, 'tree-0'), 'desktop');
  assert.equal(watcher.watch(thread.id, undefined, landed.slice(0, 9)).waitingFor, landed.slice(0, 9));
  // A restart onto a build without it: still waiting.
  watcher.appHello(D(before, 'tree-1'), 'desktop');
  assert.equal(h.events(thread.id).findLast((e) => e.type === 'user.message' && e.origin === 'runner'), undefined);
  assert.ok(watcher.isWatching(thread.id));
  watcher.appHello(D(landed, 'tree-2'), 'desktop');
  assert.match(String(h.events(thread.id).findLast((e) => e.type === 'user.message' && e.origin === 'runner')?.text), new RegExp(`restarted onto ${landed.slice(0, 9)}`));
  // One found nowhere is refused, not turned into "any new build", and
  // takes the place of the wait the thread had.
  watcher.watch(thread.id);
  assert.ok(watcher.isWatching(thread.id));
  assert.throws(() => watcher.watch(thread.id, undefined, 'deadbeef1'), /Can't find commit deadbeef1/);
  assert.ok(!watcher.isWatching(thread.id));
});

test('a named commit is the thread\'s own folder\'s first, main the apps\' checkout\'s', () => {
  const { h, thread } = setUp();
  const cwd = h.runner.get(thread.id).cwd;
  const asked: string[] = [];
  const watcher = new AppRestarts({
    runner: h.runner, home: h.home, clock: h.clock, log: nullLogger, appRepo: '/apps-checkout',
    git: { resolve: (repo, rev) => (asked.push(`${repo === cwd ? 'cwd' : repo} ${rev}`), `${repo === cwd ? 'c' : 'a'}0ffee1234567`), contains: () => undefined },
  });
  // HEAD from a worktree is the worktree's, not the main checkout's.
  assert.equal(watcher.watch(thread.id, undefined, 'HEAD').waitingFor, 'c0ffee123');
  assert.deepEqual(asked.splice(0), ['cwd HEAD']);
  assert.equal(watcher.watch(thread.id).waitingFor, 'a0ffee123');
  assert.deepEqual(asked.splice(0), ['/apps-checkout refs/heads/main']);
});

// Codex's review, 18 Nov: main moved on with only runner changes before
// the thread asked, so the one build that comes is of an older commit
// with the same desktop/ folder.
test('a build of an older commit with the same app folders counts', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const { h, watcher, thread } = setUp();
  const repo = h.runner.get(thread.id).cwd;
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  const commit = (file: string, msg: string) => {
    fs.mkdirSync(`${repo}/${file.split('/')[0]}`, { recursive: true });
    fs.writeFileSync(`${repo}/${file}`, msg);
    git('add', file);
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  const before = commit('desktop/a', 'old app');
  const landed = commit('desktop/a', 'the change');
  commit('runner/b', 'runner only');
  watcher.appHello({ commit: before, short: before.slice(0, 7), tree: git('rev-parse', `${before}:desktop`) }, 'desktop');
  watcher.watch(thread.id);
  watcher.appHello({ commit: landed, short: landed.slice(0, 7), tree: git('rev-parse', `${landed}:desktop`) }, 'desktop');
  assert.match(said(h, thread.id).message, new RegExp(`restarted onto ${landed.slice(0, 7)}`));
});

test('git too slow keeps waiting quietly and asks again next time', () => {
  const { h, thread } = setUp();
  let answer: boolean | 'busy' = 'busy';
  let calls = 0;
  const watcher = new AppRestarts({
    runner: h.runner, home: h.home, clock: h.clock, log: nullLogger,
    git: { resolve: () => 'c0ffee1234567', contains: () => (calls++, answer) },
  });
  watcher.appHello(A);
  watcher.watch(thread.id);
  watcher.appHello(B);
  assert.equal(said(h, thread.id).message, undefined);
  assert.equal(h.events(thread.id).filter((e) => e.type === 'system.note').length, 0);
  answer = true;
  watcher.appHello(B);
  assert.equal(calls, 2);
  assert.match(said(h, thread.id).message, /restarted onto bbbb222/);
});

test('a build due after a handover is dropped when an older one replaces it', () => {
  const { h, thread } = setUp();
  const away = new Set<string>([thread.id]);
  const has = (id: string) => !away.has(id) && h.runner.has(id);
  const C = { commit: 'cccc3333', short: 'cccc333', tree: 'tree-c' };
  const watcher = new AppRestarts({
    runner: { get: (id) => h.runner.get(id), note: (id, t) => h.runner.note(id, t), send: (...a) => h.runner.send(...a), has },
    home: h.home, clock: h.clock, log: nullLogger, away: (id) => away.has(id),
    git: { resolve: () => 'want1234567', contains: (_r, _a, c) => c !== C.commit },
  });
  watcher.appHello(A);
  watcher.watch(thread.id);
  watcher.appHello(B);
  watcher.appHello(C);
  away.delete(thread.id);
  watcher.adopted(thread.id);
  assert.equal(said(h, thread.id).message, undefined);
  assert.ok(watcher.isWatching(thread.id));
});

test('a build due after a handover is dropped when the app rolls back', () => {
  const { h, thread } = setUp();
  const away = new Set<string>([thread.id]);
  const watcher = new AppRestarts({
    runner: { get: (id) => h.runner.get(id), note: (id, t) => h.runner.note(id, t), send: (...a) => h.runner.send(...a), has: (id) => !away.has(id) && h.runner.has(id) },
    home: h.home, clock: h.clock, log: nullLogger, away: (id) => away.has(id),
  });
  watcher.appHello(A);
  watcher.watch(thread.id);
  watcher.appHello(B);
  watcher.appHello(A);
  away.delete(thread.id);
  watcher.adopted(thread.id);
  assert.equal(said(h, thread.id).message, undefined);
  assert.ok(watcher.isWatching(thread.id));
});

test('the Swift app\'s tree is its app and dock folders\' trees', async () => {
  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const { realGit } = await import('../../src/app-restarts.ts');
  const { h, thread } = setUp();
  const repo = h.runner.get(thread.id).cwd;
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (const d of ['app', 'dock']) {
    fs.mkdirSync(`${repo}/${d}`, { recursive: true });
    fs.writeFileSync(`${repo}/${d}/f`, d);
  }
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'x');
  // As app/build-app.sh makes it.
  const expected = git('rev-parse', 'HEAD:app', 'HEAD:dock').split('\n').join('+');
  assert.equal(realGit.tree!(repo, git('rev-parse', 'HEAD'), ['app', 'dock']), expected);
});

test('a done turn waiting on the app restart hibernates until it comes, then wakes', () => {
  // The draft-box thread sat in Mike's inbox as done while it waited for
  // the app to pick up its change (18 Nov 2026).
  let watcher!: AppRestarts;
  const h = makeHarness(undefined, {}, { awaitingAppRestart: (id) => watcher.isWatching(id) });
  watcher = new AppRestarts({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger });
  const { thread } = h.runner.create({ text: 'Add Edit to draft boxes', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  watcher.appHello(D1, 'desktop');
  watcher.watch(thread.id, 'Check Edit shows beside Copy.');
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: 'mcp__threadbear__end_turn', kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  s.text('m1', 'Landed. The app picks it up once it is idle.');
  s.result('completed');
  let t = h.runner.get(thread.id);
  assert.equal(Date.parse(t.snoozedUntil!), h.clock.now() + 24 * 60 * 60_000);
  assert.equal(h.events(thread.id).findLast((e) => e.type === 'system.note')?.text, 'Hibernating until the Threadbear app restarts onto the new build, a day at most.');
  // The app keeps it under Running, as it isn't done until Mike runs it (19 Nov 2026).
  assert.equal(t.awaitingAppRestart, true);
  watcher.appHello(D2, 'desktop');
  t = h.runner.get(thread.id);
  assert.equal(t.snoozedUntil, undefined);
  assert.equal(t.awaitingAppRestart, undefined);
  assert.ok(['starting', 'running'].includes(t.status), 'the restart message started a turn');
  assert.match(said(h, thread.id).message, /Check Edit shows beside Copy\./);
});

test("Mike hibernating a thread that waits on the app makes it his own snooze", () => {
  let watcher!: AppRestarts;
  const h = makeHarness(undefined, {}, { awaitingAppRestart: (id) => watcher.isWatching(id) });
  watcher = new AppRestarts({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger });
  const { thread } = h.runner.create({ text: 'Add Edit to draft boxes', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  watcher.appHello(D1, 'desktop');
  watcher.watch(thread.id);
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: 'mcp__threadbear__end_turn', kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  s.text('m1', 'Landed.');
  s.result('completed');
  assert.equal(h.runner.get(thread.id).awaitingAppRestart, true);
  h.runner.update({ threadId: thread.id, snoozedUntil: new Date(h.clock.now() + 2 * 60 * 60_000).toISOString() });
  assert.equal(h.runner.get(thread.id).awaitingAppRestart, undefined, 'under Hibernating, where he put it');
});

test('one archived while the app restarted no longer says it waits for the app', () => {
  // Its watch is spent and nothing will wake it (Codex's review, 19 Nov 2026).
  let watcher!: AppRestarts;
  const h = makeHarness(undefined, {}, { awaitingAppRestart: (id) => watcher.isWatching(id) });
  watcher = new AppRestarts({ runner: h.runner, home: h.home, clock: h.clock, log: nullLogger });
  const { thread } = h.runner.create({ text: 'Add Edit to draft boxes', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  watcher.appHello(D1, 'desktop');
  watcher.watch(thread.id);
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: 'mcp__threadbear__end_turn', kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  s.text('m1', 'Landed.');
  s.result('completed');
  h.runner.update({ threadId: thread.id, archived: true });
  watcher.appHello(D2, 'desktop');
  h.runner.update({ threadId: thread.id, archived: false });
  assert.equal(h.runner.get(thread.id).awaitingAppRestart, undefined);
});

test('a turn that needs Mike, or one not waiting on the app, stays in the inbox', () => {
  let watching = true;
  const h = makeHarness(undefined, {}, { awaitingAppRestart: () => watching });
  const { thread } = h.runner.create({ text: 'Add Edit to draft boxes', accountId: 'claude-3' });
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: 'mcp__threadbear__end_turn', kind: 'mcp', title: 'end_turn', input: { needs: 'you', asks: [{ question: 'Paste the key.' }] } } });
  s.text('m1', 'Need the key.');
  s.result('completed');
  assert.equal(h.runner.get(thread.id).snoozedUntil, undefined);
  watching = false;
  h.runner.send(thread.id, 'here');
  h.adapter.last.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e2', name: 'mcp__threadbear__end_turn', kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  h.adapter.last.text('m2', 'Done.');
  h.adapter.last.result('completed');
  assert.equal(h.runner.get(thread.id).snoozedUntil, undefined);
});

// The Updates panel lists the threads waiting on the app and whether each
// one's commit is in the build that's coming (Mike's pick, review 0a7d18e2,
// 21 Nov): each waiting thread's summary says which commit it waits for.
test('a waiting thread says which commit it waits for, until it hears or a day passes', () => {
  const { h, thread } = setUp();
  const watcher = new AppRestarts({
    runner: h.runner, home: h.home, clock: h.clock, log: nullLogger,
    git: { resolve: () => 'c0ffee1234567', contains: () => true },
  });
  assert.equal(watcher.waitingFor(thread.id), undefined, 'not waiting');
  watcher.appHello(A);
  watcher.watch(thread.id);
  assert.deepEqual(watcher.waitingFor(thread.id), { commit: 'c0ffee1234567', short: 'c0ffee123' });
  watcher.appHello(B);
  assert.equal(watcher.waitingFor(thread.id), undefined, 'told: no longer waiting');
  watcher.watch(thread.id);
  h.clock.advance(25 * 60 * 60_000);
  assert.equal(watcher.waitingFor(thread.id), undefined, 'a day old: no longer listed');
});

test('a wait with no commit to look for is still listed', () => {
  const { h, thread } = setUp();
  const watcher = new AppRestarts({
    runner: h.runner, home: h.home, clock: h.clock, log: nullLogger,
    git: { resolve: () => undefined, contains: () => undefined },
  });
  watcher.watch(thread.id);
  assert.deepEqual(watcher.waitingFor(thread.id), {});
});
