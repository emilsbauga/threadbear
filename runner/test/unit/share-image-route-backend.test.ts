// A shared thread's pictures go to anyone with the link through
// /share/image/<slug>/<id> (convex/http.ts), which asks share:shareImageFile
// at every request, not as the files' own storage URLs, which kept working
// for a former viewer after sharing stopped until the runner's cleanup
// deleted them (Daybreak finding 135, 15 Nov 2026). Against the in-memory
// database; the route itself does no more than this query says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const TOKEN = 'phone-token';
const LAPTOP = 'laptop000001';
const DAY = 24 * 60 * 60_000;

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const share = load('share');
const rekey = load('shareRekey');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  const now = Date.now();
  await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'iphone', kind: 'phone', expiresAt: now + 100 * DAY, createdAt: now });
  await b.ctx.db.insert('runners', { runnerId: LAPTOP, name: 'Laptop', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: now, byOwner: true });
  const sharedAs = (threadId: string, slug: string, access: 'link' | 'off') =>
    call(b.ctx, sync.upsertThreads, { key: OWNER, threads: [{ threadId, runnerId: LAPTOP, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false, share: { slug, access } }] });
  await sharedAs('T', 'slug-one', 'link');
  await sharedAs('U', 'slug-other', 'link');
  await call(b.ctx, sync.appendMessages, { key: OWNER, messages: [{ threadId: 'T', seq: 1, role: 'assistant', text: 'look', at: 'now' }] });
  await call(b.ctx, sync.addShareImage, { key: OWNER, threadId: 'T', seq: 1, path: '/a.png', storageId: b.file('pic'), mediaType: 'image/png' });
  await call(b.ctx, sync.addShareImage, { key: OWNER, threadId: 'U', seq: 1, path: '/b.png', storageId: b.file('other'), mediaType: 'image/svg+xml' });
  const id = b.rows('shareImages').find((r) => r.threadId === 'T')!._id as string;
  const otherId = b.rows('shareImages').find((r) => r.threadId === 'U')!._id as string;
  return { ...b, sharedAs, id, otherId };
}

const fetchAs = (s: { ctx: unknown }, slug: string, id: string) => call(s.ctx, share.shareImageFile, { slug, id });

test('anyone with the link gets the pictures through the route, not their storage URLs; Mike gets the files', async () => {
  const s = await setup();
  const page = await call(s.ctx, share.view, { slug: 'slug-one' });
  assert.deepEqual(page.images.map((i: { url: string }) => i.url), [`https://site.example/share/image/slug-one/${encodeURIComponent(s.id)}`]);
  const card = await call(s.ctx, share.preview, { slug: 'slug-one' });
  assert.equal(card.image, `https://site.example/share/image/slug-one/${encodeURIComponent(s.id)}`);
  const mikes = await call(s.ctx, share.view, { slug: 'slug-one', token: TOKEN });
  assert.deepEqual(mikes.images.map((i: { url: string }) => i.url), ['https://files.example/pic']);
  assert.deepEqual(await fetchAs(s, 'slug-one', s.id), { storageId: 'pic', mediaType: 'image/png' });
});

test('stopping sharing stops the picture at once, before the runner drops the pictures, and sharing again brings it back', async () => {
  const s = await setup();
  await s.sharedAs('T', 'slug-one', 'off');
  assert.ok(s.rows('shareImages').some((r) => r.threadId === 'T'), "the runner's cleanup hasn't run");
  assert.equal(await fetchAs(s, 'slug-one', s.id), null);
  await s.sharedAs('T', 'slug-one', 'link');
  assert.notEqual(await fetchAs(s, 'slug-one', s.id), null);
});

test('Share again with a new link: the old link’s picture URLs stop', async () => {
  const s = await setup();
  await s.sharedAs('T', 'slug-two', 'link');
  assert.equal(await fetchAs(s, 'slug-one', s.id), null);
  assert.notEqual(await fetchAs(s, 'slug-two', s.id), null);
});

test("a link reaches only its own thread's pictures, and a stored type the page doesn't show goes as plain bytes", async () => {
  const s = await setup();
  assert.equal(await fetchAs(s, 'slug-one', s.otherId), null, "another shared thread's picture");
  assert.equal(await fetchAs(s, 'slug-one', 'messages:1'), null, 'a row of another table');
  assert.equal(await fetchAs(s, 'slug-one', 'nonsense'), null);
  assert.equal(await fetchAs(s, 'nope', s.id), null);
  assert.deepEqual(await fetchAs(s, 'slug-other', s.otherId), { storageId: 'other', mediaType: 'application/octet-stream' });
});

// The storage URLs a shared page handed out before /share/image (15 Nov)
// kept working after sharing stopped until the runner's cleanup deleted the
// file. A one-off job copies each shared picture to a new file and deletes
// the old one (convex/shareRekey.ts), so every URL from before is dead,
// shared or not, and the pages go on as they were.
async function runRekey(s: Awaited<ReturnType<typeof setup>>) {
  const fns: Record<string, any> = { rekeyPage: rekey.rekeyPage, rekeySwap: rekey.rekeySwap, rekeyDone: rekey.rekeyDone, rekeyProgress: rekey.rekeyProgress, rekeyShareImages: rekey.rekeyShareImages };
  const byRef = (ref: unknown) => fns[String(ref).split('.').pop()!];
  let next: Record<string, unknown> | undefined = { cursor: null };
  const ctx = {
    runQuery: (ref: unknown, args: Record<string, unknown>) => call(s.ctx, byRef(ref), args),
    runMutation: (ref: unknown, args: Record<string, unknown>) => call(s.ctx, byRef(ref), args),
    storage: { get: async (id: string) => (s.hasFile(id) ? new Blob([`bytes of ${id}`]) : null), store: (b: Blob) => (s.ctx as any).storage.store(b), delete: (id: string) => (s.ctx as any).storage.delete(id) },
    scheduler: { runAfter: async (_ms: number, _fn: unknown, args: Record<string, unknown>) => void (next = args) },
  };
  for (let runs = 0; next && runs < 100; runs++) {
    const args = next;
    next = undefined;
    await call(ctx, rekey.rekeyShareImages, args);
  }
  assert.equal(next, undefined, 'it finished');
}

// The limits migration has run (the rekey waits for it).
const limitsDone = async (s: Awaited<ReturnType<typeof setup>>) => {
  for (const name of ['limits-2026-11-07', 'limits-2026-11-07-done']) await s.ctx.db.insert('backendMarks', { name });
};

test("the first heartbeat after the deploy ends every shared picture's storage URL from before, once, and the pages go on as before", async () => {
  const s = await setup();
  await limitsDone(s);
  // Thirty more on T, past one page of the job.
  for (let i = 0; i < 30; i++) await call(s.ctx, sync.addShareImage, { key: OWNER, threadId: 'T', seq: 2 + i, path: `/p${i}.png`, storageId: s.file(`p${i}`), mediaType: 'image/png' });
  // A runner key's upload record moves with its file.
  await s.ctx.db.insert('storageOwners', { storageId: 'p0', runnerId: 'cb921b2447ea', at: 1, bytes: 65536, attachedAt: 1 });
  const before = { pic: await s.ctx.storage.getUrl('pic'), other: await s.ctx.storage.getUrl('other') };
  assert.ok(before.pic && before.other);
  s.scheduled.length = 0;
  const beat = () => call(s.ctx, sync.heartbeat, { key: OWNER, runner: { runnerId: LAPTOP, name: 'laptop', version: 'v', startedAt: 'x', draining: false, threadCount: 1 } });
  await beat();
  assert.equal(s.scheduled.filter((j) => String((j as { fn: string }).fn).endsWith('rekeyShareImages')).length, 1);
  // Not before the limits migration has finished.
  const s2 = await setup();
  s2.scheduled.length = 0;
  await call(s2.ctx, sync.heartbeat, { key: OWNER, runner: { runnerId: LAPTOP, name: 'laptop', version: 'v', startedAt: 'x', draining: false, threadCount: 1 } });
  assert.equal(s2.scheduled.filter((j) => String((j as { fn: string }).fn).endsWith('rekeyShareImages')).length, 0);
  await beat();
  assert.equal(s.scheduled.filter((j) => String((j as { fn: string }).fn).endsWith('rekeyShareImages')).length, 1, 'once');
  await runRekey(s);
  assert.ok(s.rows('backendMarks').some((m) => m.name === 'share-rekey-2026-11-16-done'));
  s.scheduled.length = 0;
  await later(3 * 60 * 60_000, beat);
  assert.equal(s.scheduled.length, 0, 'finished, so never again');
  // The old files have gone, so the URLs handed out for them are dead,
  // the shared thread's and the one no longer shared alike.
  for (const id of ['pic', 'other', 'p0', 'p29']) assert.equal(await s.ctx.storage.getUrl(id), null, id);
  // Each row names a new file of the same bytes; the route and Mike's page still show them.
  const row = s.rows('shareImages').find((r) => r._id === s.id)!;
  assert.notEqual(row.storageId, 'pic');
  assert.equal(s.hasFile(row.storageId), true);
  assert.deepEqual(await fetchAs(s, 'slug-one', s.id), { storageId: row.storageId, mediaType: 'image/png' });
  const mikes = await call(s.ctx, share.view, { slug: 'slug-one', token: TOKEN });
  assert.equal(mikes.images.length, 31);
  assert.ok(mikes.images.every((i: { url: string }) => !/files\.example\/(pic|p\d+)$/.test(i.url)));
  const p0row = s.rows('shareImages').find((r) => r.path === '/p0.png')!;
  assert.deepEqual(s.rows('storageOwners').filter((o) => o.runnerId === 'cb921b2447ea').map((o) => o.storageId), [p0row.storageId]);
  assert.equal(s.rows('shareImages').length, 32);
});

test("a file the owner also put on a reply row moves to the copy with it, so the old one goes; a row gone meanwhile leaves no copy", async () => {
  const s = await setup();
  await call(s.ctx, sync.addReplyImage, { key: OWNER, threadId: 'T', seq: 1, path: '/a.png', storageId: 'pic', mediaType: 'image/png' });
  await runRekey(s);
  assert.equal(s.hasFile('pic'), false, 'the old URL is dead');
  const fresh = s.rows('shareImages').find((r) => r._id === s.id)!.storageId;
  assert.equal(s.rows('replyImages').find((r) => r.threadId === 'T')!.storageId, fresh, 'the reply row names the copy');
  // Stopping sharing then leaves the copy for the reply row.
  assert.equal(await call(s.ctx, sync.dropShareImages, { key: OWNER, threadId: 'T' }), 1);
  assert.equal(s.hasFile(fresh), true);
  // A swap for a row that's gone deletes its copy.
  const copy = s.file('copy');
  assert.equal(await call(s.ctx, rekey.rekeySwap, { id: 'shareImages:999999', old: 'other', fresh: copy }), false);
  assert.equal(s.hasFile('copy'), false);
});

test('a run that stops partway goes on from where it got to, once it has got no further for two hours', async () => {
  const s = await setup();
  await limitsDone(s);
  for (let i = 0; i < 12; i++) await call(s.ctx, sync.addShareImage, { key: OWNER, threadId: 'T', seq: 2 + i, path: `/p${i}.png`, storageId: s.file(`p${i}`), mediaType: 'image/png' });
  const beat = () => call(s.ctx, sync.heartbeat, { key: OWNER, runner: { runnerId: LAPTOP, name: 'laptop', version: 'v', startedAt: 'x', draining: false, threadCount: 1 } });
  const runs = () => (s.scheduled.filter((j) => String((j as { fn: string }).fn).endsWith('rekeyShareImages')) as { args: Record<string, unknown> }[]);
  s.scheduled.length = 0;
  await beat();
  assert.deepEqual(runs().map((j) => j.args), [{ cursor: null }]);
  // One page goes, then the run dies (a storage failure on the next).
  await call(s.ctx, rekey.rekeyProgress, { cursor: 'page-2' });
  s.scheduled.length = 0;
  await later(60 * 60_000, beat);
  assert.equal(runs().length, 0, 'an hour on: still its turn');
  await later(3 * 60 * 60_000, beat);
  assert.deepEqual(runs().map((j) => j.args), [{ cursor: 'page-2' }], 'goes on from where it got to');
  await runRekey(s);
  assert.equal(s.hasFile('pic'), false);
});

async function later<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}
