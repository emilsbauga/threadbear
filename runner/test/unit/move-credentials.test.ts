// What a move says about a thread's repo never carries a password or
// token (security review, 10 Nov 2026): the preview sent the thread's
// origin as `git remote get-url` gave it, through a relay command (which
// isn't scrubbed on its way, so the phone's words go as typed), and the
// runner the preview asked read `https://user:github_pat_...@github.com/...`
// whole. Now the address loses its credentials where it's read, the
// preview sends only what the target plans from, scrubbed as sync scrubs,
// and the backend strips an address an older runner sends whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { load } from '../helpers/convex-memory.ts';
import { FakeAccounts, makeHarness, tmpDir } from '../helpers/fakes.ts';
import { cloneableUrl, packGit, repoKey, withoutCredentials } from '../../src/move-git.ts';
import { moveInfoFrom, previewInfo } from '../../src/moves.ts';
import { Scrubber } from '../../src/scrub.ts';

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX';
const CASES: [string, string][] = [
  [`https://user:${TOKEN}@github.com/owner/private.git`, 'https://github.com/owner/private.git'],
  [`https://${TOKEN}@github.com/owner/private.git`, 'https://github.com/owner/private.git'],
  ['https://x-access-token:ghs_abc@github.com/o/r', 'https://github.com/o/r'],
  ['http://u:p@example.com/r.git?token=abc#frag', 'http://example.com/r.git'],
  ['ssh://git:hunter2@github.com/o/r.git', 'ssh://git@github.com/o/r.git'],
  ['ssh://git@github.com/o/r.git', 'ssh://git@github.com/o/r.git'],
  ['git@github.com:mikecann/threadbear.git', 'git@github.com:mikecann/threadbear.git'],
  ['https://github.com/mikecann/threadbear', 'https://github.com/mikecann/threadbear'],
  ['/Users/alex/origin.git', '/Users/alex/origin.git'],
  // Daybreak 143 (16 Nov 2026): a token as the ssh user, in the URL and
  // scp forms, and under any scheme. Only ssh's own `git` stays.
  [`ssh://${TOKEN}@github.com/owner/private.git`, 'ssh://github.com/owner/private.git'],
  [`${TOKEN}@github.com:owner/private.git`, 'github.com:owner/private.git'],
  [`git:${TOKEN}@github.com:owner/private.git`, ''],
  [`a@${TOKEN}@github.com:owner/private.git`, 'github.com:owner/private.git'],
  [`git+ssh://${TOKEN}@github.com/o/r.git`, 'git+ssh://github.com/o/r.git'],
  [`ssh+git://git@github.com/o/r.git`, 'ssh+git://git@github.com/o/r.git'],
  [`git://${TOKEN}@example.com/r.git`, 'git://example.com/r.git'],
  [`custom-scheme://user:${TOKEN}@host/r`, 'custom-scheme://host/r'],
  [`ftp://${TOKEN}@host/r`, 'ftp://host/r'],
  ['ssh://%67it@github.com/o/r.git', 'ssh://github.com/o/r.git'],
  [`ssh://git%3A${TOKEN}@github.com/o/r.git`, 'ssh://github.com/o/r.git'],
  [`https://tok%40en${TOKEN}@github.com/o/r`, 'https://github.com/o/r'],
  [`ssh://a:b@${TOKEN}@github.com/o/r`, 'ssh://github.com/o/r'],
  ['GIT@github.com:o/r.git', 'github.com:o/r.git'],
  ['github.com:o/r.git', 'github.com:o/r.git'],
  ['/Users/a@b/repo.git', '/Users/a@b/repo.git'],
  // Security review, 17 Nov 2026: an `@` in the path's first folder.
  ['UNCLASSIFIEDSSHLOGIN@example.com:team@work/repo.git', 'example.com:team@work/repo.git'],
  ['UNCLASSIFIEDSSHLOGIN@example.com:@scope/repo.git', 'example.com:@scope/repo.git'],
  ['git@example.com:team@work/repo.git', 'git@example.com:team@work/repo.git'],
  // One that can't be told from a login (`user:token@host:path`, or an `@`
  // then a `:` in the path) is left out altogether, never guessed at.
  [`u:${TOKEN}@[::1]:o/r.git`, ''],
  ['git@git.example.com:team@backup.example.com:repo.git', ''],
  ['alice@gitbox:team@backup.example.com:repo.git', ''],
  ['first.last:UNCLASSIFIED_SECRET@git.example.com:o/r.git', ''],
  ['git:UNCLASSIFIED_SECRET@gitbox:o/r.git', ''],
  ['', ''],
];

test('an address loses anything that could be a password or token, on the runner and in the backend', () => {
  const { withoutCredentials: backend } = load('lib') as { withoutCredentials: (u: string) => string };
  for (const [url, want] of CASES) {
    assert.equal(withoutCredentials(url), want, url);
    assert.equal(backend(url), want, `backend: ${url}`);
    // Scrubbing twice changes nothing (the backend scrubs what the runner did).
    assert.equal(withoutCredentials(want), want, `again: ${want}`);
    assert.ok(!withoutCredentials(url).includes(TOKEN) && !withoutCredentials(url).includes('SECRET'), url);
  }
});

// Security review, 17 Nov 2026: an honest ssh user is taken off too, and
// the address is still one a clone can use (ssh's config gives the user).
test('an scp address without its user can still be cloned, and the same repo found', () => {
  for (const a of ['alice@git.example.com:team/project.git', 'git@github.com:o/r.git']) {
    const clean = withoutCredentials(a);
    assert.ok(cloneableUrl(clean), clean);
    assert.equal(repoKey(clean), repoKey(a));
  }
  for (const a of ['UNCLASSIFIEDSSHLOGIN@example.com:team@work/repo.git', 'alice@gitbox:team/repo.git']) assert.equal(repoKey(withoutCredentials(a)), repoKey(a), a);
  for (const u of ['file:///etc', 'host:-oProxyCommand=x', 'C::x']) assert.equal(cloneableUrl(u), false, u);
});

test('the same repo is still the same repo once its user has gone', () => {
  for (const a of ['git@github.com:mikecann/threadbear.git', 'github.com:mikecann/threadbear.git', 'https://github.com/mikecann/threadbear', 'ssh://github.com/mikecann/threadbear.git', 'ssh://git@github.com/mikecann/threadbear.git']) {
    assert.equal(repoKey(a), 'github.com/mikecann/threadbear', a);
  }
});

test("the backend stores a moved thread's ssh origin without its token", async () => {
  process.env.RUNNER_KEY = 'owner-key';
  const { memoryBackend, call } = await import('../helpers/convex-memory.ts');
  const moves = load('moves');
  const b = memoryBackend();
  await b.ctx.db.insert('threads', { threadId: 't1', runnerId: 'runner000001' } as never);
  await b.ctx.db.insert('runners', { runnerId: 'runner000002', name: 'T', version: '1', lastSeenAt: Date.now(), startedAt: new Date().toISOString(), draining: false, threadCount: 0 });
  const { moveId } = (await call(b.ctx, moves.startMove, { key: 'owner-key', threadId: 't1', to: 'runner000002' })) as { moveId: string };
  for (const origin of [`${TOKEN}@github.com:owner/private.git`, `ssh://${TOKEN}@github.com/owner/private.git`]) {
    const row = b.rows('threadMoves').find((r: any) => r.moveId === moveId)!;
    await b.ctx.db.patch(row._id, { info: undefined });
    await call(b.ctx, moves.moveInfo, { key: 'owner-key', moveId, info: { title: 't', cwd: '/c', home: '/h', provider: 'claude', accountId: 'a', permissionMode: 'ask', worktree: false, schedules: 0, origin } });
    const stored = b.rows('threadMoves').find((r: any) => r.moveId === moveId)!.info;
    assert.ok(!JSON.stringify(stored).includes(TOKEN), JSON.stringify(stored));
  }
});

function repoWithOrigin(origin: string): string {
  const repo = tmpDir('tb-move-cred-');
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
  g('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g('add', '.');
  g('commit', '-qm', 'a');
  g('remote', 'add', 'origin', origin);
  return repo;
}

test("a thread's description and its git work name the repo without its token", async () => {
  const repo = repoWithOrigin(`https://user:${TOKEN}@github.com/owner/private.git`);
  const s = makeHarness(tmpDir('tb-move-home-'), {}, { accounts: new FakeAccounts([{ id: 'claude-main', provider: 'claude', title: 'S', configDir: tmpDir() }]) });
  const id = s.runner.create({ text: 'x', accountId: 'claude-main', cwd: repo }).thread.id;
  const info = (await s.runner.describeForMove(id, 0))!;
  assert.equal(info.origin, 'https://github.com/owner/private.git');
  assert.ok(!JSON.stringify(info).includes(TOKEN));
  const packed = await packGit(repo, repo, path.join(tmpDir(), 'b.bundle'));
  assert.ok(packed.ok);
  assert.equal(packed.ok && packed.meta.origin, 'https://github.com/owner/private.git');
});

test('the preview sends the target only what it plans from, scrubbed, and an older target can still read it', () => {
  const scrubber = new Scrubber({ env: {}, folders: false });
  scrubber.known.add('hunter2-very-secret-value');
  const info = moveInfoFrom({
    title: 'Deploy with hunter2-very-secret-value',
    cwd: '/Users/alex/dev/app',
    home: '/Users/alex',
    provider: 'claude',
    accountId: 'claude-main',
    email: 'alex@example.com',
    model: 'opus',
    effort: 'max',
    permissionMode: 'ask',
    origin: `https://user:${TOKEN}@github.com/owner/private.git`,
    repoTop: '/Users/alex/dev/app',
    subdir: '',
    worktree: true,
    sessionId: 'sess-1',
    schedules: 3,
  })!;
  const sent = previewInfo(info, (v) => scrubber.doc(v));
  assert.deepEqual(sent, {
    title: '',
    cwd: '/Users/alex/dev/app',
    home: '/Users/alex',
    provider: 'claude',
    accountId: 'claude-main',
    permissionMode: 'ask',
    worktree: true,
    schedules: 0,
    email: 'alex@example.com',
    origin: 'https://github.com/owner/private.git',
    repoTop: '/Users/alex/dev/app',
    subdir: '',
  });
  // A target from before this reads it as before.
  assert.ok(moveInfoFrom(sent));
  // And it's scrubbed as sync scrubs (which leaves paths alone).
  const withSecret = previewInfo({ ...info, origin: 'https://example.com/hunter2-very-secret-value.git' }, (v) => scrubber.doc(v));
  assert.ok(!JSON.stringify(withSecret).includes('hunter2-very-secret-value'));
});

test("the backend strips a credential from a preview's description an older main Mac sends whole", () => {
  const { commandArgs } = load('relay') as { commandArgs: (kind: string, a: unknown) => Record<string, unknown> };
  const out = commandArgs('call', { method: 'moves.preview', params: { info: { title: 't', cwd: '/c', home: '/h', provider: 'claude', accountId: 'a', permissionMode: 'full', origin: `https://user:${TOKEN}@github.com/o/p.git` } } }) as { params: { info: { origin: string } } };
  assert.equal(out.params.info.origin, 'https://github.com/o/p.git');
  // Nor the title (made from the first message) or the session.
  const more = commandArgs('call', { method: 'moves.preview', params: { info: { title: 'my password is hunter2', sessionId: 's1', cwd: '/c', home: '/h', provider: 'claude', accountId: 'a', permissionMode: 'full' } } }) as { params: { info: Record<string, unknown> } };
  assert.equal(more.params.info.title, '');
  assert.equal(more.params.info.sessionId, undefined);
});

// Security review, 17 Nov 2026: the Move sheet's `moves.describe` answer is
// stored in the command's row until the main Mac reads it, and an older
// runner's scrubber left a token-shaped ssh user in its origin. The backend
// stores that answer's origin as moves:moveInfo would.
test("the backend stores an older runner's description for the Move sheet without its origin's token", async () => {
  const { memoryBackend, call } = await import('../helpers/convex-memory.ts');
  const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
  const sync = load('sync');
  const relay = load('relay');
  process.env.RUNNER_KEY = 'owner-key';
  delete process.env.RUNNER_KEY_NEXT;
  const MINI = 'cb921b2447ea';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256('tbr_mac-mini'), name: 'mac-mini', createdAt: 1 });
  await b.ctx.db.insert('runners', { runnerId: MINI, name: 'mac-mini', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  const { THREAD_BASICS } = await import('../helpers/convex-memory.ts');
  await call(b.ctx, sync.upsertThreads, { key: 'tbr_mac-mini', threads: [{ ...THREAD_BASICS, threadId: 'B', runnerId: MINI, title: 'T', view: 'inbox', needsYou: false }] });
  const unclassified = 'UNCLASSIFIEDSSHLOGIN';
  for (const origin of [`ssh://${unclassified}@example.com/owner/repo.git`, `${unclassified}@example.com:owner/repo.git`]) {
    const id = await call(b.ctx, relay.queueCommand, { key: 'owner-key', runnerId: MINI, threadId: 'B', kind: 'call', args: { method: 'moves.describe', params: {} } });
    await call(b.ctx, sync.takeCommand, { key: 'tbr_mac-mini', commandId: id });
    await call(b.ctx, sync.finishCommand, { key: 'tbr_mac-mini', commandId: id, ok: true, result: JSON.stringify({ title: 't', cwd: '/c', home: '/h', provider: 'claude', accountId: 'a', permissionMode: 'ask', worktree: false, schedules: 0, origin }) });
    const stored = b.rows('commands').find((c: any) => c._id === id)!.result as string;
    assert.ok(!stored.includes(unclassified), stored);
    assert.equal(repoKey(JSON.parse(stored).origin), 'example.com/owner/repo');
  }
});
