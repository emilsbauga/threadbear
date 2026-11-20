// The Mac's Move sheet asks before anything starts (threads.movePreview):
// the thread's runner describes it (`moves.describe`) and the target plans
// it (`moves.preview`), each through a relay `call`. These are the hops: the
// backend's allow-list, the description's shape check, and the target's plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { load } from '../helpers/convex-memory.ts';
import { FakeAccounts, makeHarness, tmpDir } from '../helpers/fakes.ts';
import { MovePreviews, moveBinding, moveInfoFrom } from '../../src/moves.ts';

const { commandArgs } = load('relay') as { commandArgs: (kind: string, a: unknown) => Record<string, unknown> };

test("the backend lets the Move sheet's two calls through, and only the description's own fields", () => {
  assert.deepEqual(commandArgs('call', { method: 'moves.describe', params: { anything: 'else' } }), { method: 'moves.describe', params: {} });
  const out = commandArgs('call', {
    method: 'moves.preview',
    params: { info: { title: 't', cwd: '/c', home: '/h', provider: 'claude', accountId: 'a', permissionMode: 'full', worktree: true, schedules: 2, secret: 'no', email: 5 }, cwd: '/there', extra: 1 },
  });
  assert.deepEqual(out, { method: 'moves.preview', params: { info: { title: '', cwd: '/c', home: '/h', provider: 'claude', accountId: 'a', permissionMode: 'full', worktree: true, schedules: 2 }, cwd: '/there' } });
  assert.throws(() => commandArgs('call', { method: 'threads.events', params: {} }), /can be asked of another runner/);
});

test("a description that came over the relay keeps only what it should, or none if it's short", () => {
  assert.equal(moveInfoFrom({ title: 't', cwd: '/c' }), undefined);
  assert.equal(moveInfoFrom('nope'), undefined);
  const info = moveInfoFrom({ title: 't', cwd: '/c', home: '/h', provider: 'claude', accountId: 'a', permissionMode: 'full', origin: 'git@x:y.git', worktree: true, schedules: 'two', junk: 1 });
  assert.deepEqual(info, { title: 't', cwd: '/c', home: '/h', provider: 'claude', accountId: 'a', permissionMode: 'full', worktree: true, schedules: 0, origin: 'git@x:y.git' });
});

test("the target's preview gives its guess and its logins, and says what would stop the move before it starts", async () => {
  const t = makeHarness(tmpDir('tb-preview-home-'), {}, {
    accounts: new FakeAccounts([
      { id: 'claude-1', provider: 'claude', title: 'Claude', configDir: tmpDir(), email: 'alex@example.com' },
      { id: 'claude-2', provider: 'claude', title: 'Claude 2', configDir: tmpDir() },
      { id: 'codex-1', provider: 'codex', title: 'Codex', configDir: tmpDir() },
    ]),
  });
  const base = { title: 'x', home: '/Users/alex', accountId: 'a', permissionMode: 'full', schedules: 0, provider: 'claude' };

  // A folder that's there: its guess, the same email's login, and only Claude logins to pick.
  const folder = tmpDir('tb-preview-folder-');
  const ok = await t.runner.previewMove({ info: { ...base, cwd: folder, email: 'Alex@example.com', worktree: false }, self: 'T1', cwd: folder });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.cwd, folder);
  assert.equal(ok.accountId, 'claude-1');
  assert.deepEqual(ok.accounts.map((a) => a.id), ['claude-1', 'claude-2']);

  // Nowhere to go: the problem, and still the logins.
  const none = await t.runner.previewMove({ info: { ...base, cwd: '/Users/alex/nowhere-at-all', worktree: false }, self: 'T1' });
  assert.equal(none.problems.length, 1);
  assert.match(none.problems[0]!, /There's no folder/);
  assert.equal(none.accounts.length, 2);

  // A worktree thread into a copy of its repo with no worktree patch: said now,
  // not after the thread has frozen and packed.
  const repo = tmpDir('tb-preview-repo-');
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/alex-example/foo']);
  const wt = await t.runner.previewMove({ info: { ...base, cwd: '/Users/alex/dev/foo', origin: 'git@github.com:alex-example/foo.git', repoTop: '/Users/alex/dev/foo', subdir: '', worktree: true }, self: 'T1', cwd: repo });
  assert.equal(wt.worktree, true);
  assert.equal(wt.problems.length, 1);
  assert.match(wt.problems[0]!, /no worktree patch/);
});

// Daybreak 142 (16 Nov 2026): a preview's id is good once, for the same
// thread, runner and picks it was asked with, for ten minutes, and carries
// the binding of what it showed (what the runner it goes to checks).
test('a preview binds once: replayed, for other picks or stale, it starts nothing', () => {
  let now = 1_000_000;
  const previews = new MovePreviews(() => now);
  const info = moveInfoFrom({ title: 't', cwd: '/h/dev/x', home: '/h', provider: 'claude', accountId: 'a', permissionMode: 'ask', origin: 'git@github.com:o/x.git', repoTop: '/h/dev/x', subdir: '' })!;
  const picks = { threadId: 't1', to: 'T1' };
  const answer = { cwd: '/u/dev/x', accountId: 'claude-1', accounts: [], leftBehind: [], problems: [], previewId: 'the-targets-own', checksPreview: true };
  const shown = previews.remember(picks, info, answer);
  assert.equal(typeof shown.previewId, 'string');
  assert.notEqual(shown.previewId, 'the-targets-own', "never the target's word");
  const want = moveBinding({ ...picks, info, plan: { cwd: '/u/dev/x', accountId: 'claude-1', worktree: false } });
  assert.equal(previews.take(shown.previewId as string, picks), want);
  assert.throws(() => previews.take(shown.previewId as string, picks), /run out or been used/, 'a replay');

  const again = previews.remember(picks, info, answer);
  assert.throws(() => previews.take(again.previewId as string, { ...picks, accountId: 'claude-2' }), /differs from the one its preview showed/);
  assert.throws(() => previews.take(again.previewId as string, picks), /run out or been used/, 'a refused one is spent too');
  const other = previews.remember(picks, info, answer);
  assert.throws(() => previews.take(other.previewId as string, { ...picks, to: 'T2' }), /differs/);
  const stale = previews.remember(picks, info, answer);
  now += MovePreviews.MS + 1;
  assert.throws(() => previews.take(stale.previewId as string, picks), /run out/);

  // Nothing to bind to: a problem, or no place or login, or no description.
  assert.equal(previews.remember(picks, info, { ...answer, problems: ['no copy'] }).previewId, undefined);
  assert.equal(previews.remember(picks, info, { ...answer, cwd: undefined }).previewId, undefined);
  assert.equal(previews.remember(picks, undefined, answer).previewId, undefined);
  // A target from before it checked moves against their preview: none, as it
  // would do whatever the move's row said (security review, 17 Nov 2026).
  const { checksPreview: _c, ...older } = answer;
  assert.equal(previews.remember(picks, info, older).previewId, undefined);
  // A clone binds where from and to.
  const cloning = previews.remember(picks, info, { ...answer, clone: '/u/dev/x', cloneFrom: 'git@github.com:o/x.git' });
  assert.equal(previews.take(cloning.previewId as string, picks), moveBinding({ ...picks, info, plan: { cwd: '/u/dev/x', accountId: 'claude-1', worktree: false, clone: '/u/dev/x', cloneFrom: 'git@github.com:o/x.git' } }));
});

// Security review, 17 Nov 2026: the row's `expect` is the backend's word, so
// the main Mac's runner (which starts every move) takes a move only with a
// binding it handed out itself, and only for a day.
test('the main Mac vouches only for bindings its own previews gave a move', () => {
  let now = 5_000_000;
  const previews = new MovePreviews(() => now);
  const info = moveInfoFrom({ title: 't', cwd: '/h/dev/x', home: '/h', provider: 'claude', accountId: 'a', permissionMode: 'ask', origin: 'git@github.com:o/x.git', repoTop: '/h/dev/x', subdir: '' })!;
  const picks = { threadId: 't1', to: 'T1' };
  const answer = { cwd: '/u/dev/x', accountId: 'claude-1', accounts: [], leftBehind: [], problems: [], checksPreview: true };
  const forged = moveBinding({ ...picks, cwd: '/', info, plan: { cwd: '/', accountId: 'claude-1', worktree: false } });
  assert.equal(previews.vouches(forged, 'm1'), false, 'a digest the backend worked out itself');
  const shown = previews.remember(picks, info, answer);
  const expect = moveBinding({ ...picks, info, plan: { cwd: '/u/dev/x', accountId: 'claude-1', worktree: false } });
  assert.equal(previews.vouches(expect, 'm1'), false, 'shown but not moved');
  assert.equal(previews.take(shown.previewId as string, picks), expect);
  previews.startedAs(expect, 'm1');
  assert.equal(previews.vouches(expect, 'm1'), true);
  assert.equal(previews.vouches(expect, 'm1'), true, 'every step of that move');
  // That move cancelled, and the same binding on a new move's row: no.
  assert.equal(previews.vouches(expect, 'm2'), false);
  // A move seen here before startMove answered is the one it started.
  const again = previews.remember(picks, info, answer);
  previews.take(again.previewId as string, picks);
  assert.equal(previews.vouches(expect, 'm3'), true);
  previews.startedAs(expect, 'm4');
  assert.equal(previews.vouches(expect, 'm4'), false);
  now += MovePreviews.VOUCHED_MS + 1;
  assert.equal(previews.vouches(expect, 'm3'), false);
});

test("a thread at the top of its repo binds the same from the preview and from the move's row", () => {
  // The preview's description keeps subdir "" (it came over the relay); the
  // backend leaves empty strings out of the one on the move's row. The same
  // thread, so the same binding, or every such move fails as changed since
  // the Move sheet looked (Mike's move to Hetzner Cloud, 18 Nov 2026).
  const described = { title: 't', cwd: '/Users/alex/dev/x', home: '/Users/alex', provider: 'claude', accountId: 'claude-1', permissionMode: 'full', worktree: false, schedules: 0, email: 'alex@example.com', origin: 'https://github.com/alex/x.git', repoTop: '/Users/alex/dev/x' };
  const fromPreview = moveInfoFrom({ ...described, subdir: '' })!;
  const fromRow = moveInfoFrom(described)!;
  assert.equal(fromPreview.subdir, '');
  assert.equal(fromRow.subdir, undefined);
  const picks = { threadId: 'T1', to: 'laptop' };
  const plan = { cwd: '/home/alex/dev/x', accountId: 'claude-1', worktree: false };
  assert.equal(moveBinding({ ...picks, info: fromPreview, plan }), moveBinding({ ...picks, info: fromRow, plan }));
  // A real subdir still counts.
  assert.notEqual(moveBinding({ ...picks, info: { ...fromRow, subdir: 'app' }, plan }), moveBinding({ ...picks, info: fromRow, plan }));
});
