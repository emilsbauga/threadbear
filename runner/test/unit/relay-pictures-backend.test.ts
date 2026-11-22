// Pictures sent to another runner's thread from the main Mac (backend API
// 63; docs/protocol/runners.md, "Other runners' threads through the backend"). Mike
// pasted a picture into a new thread on Hetzner Cloud on 8 Nov and the app
// said "Pictures can't go to Hetzner Cloud from this Mac yet." The main Mac's
// runner now uploads each one (the owner's upload URL) and names it in the
// command, which carries a URL for each, as a phone's photos do, so the other
// runner fetches them the same way. These play that through the backend's own
// functions in the in-memory database. Each upload is recorded (relayUploads,
// through /relay/upload, as the phone's are), so one that never went out is
// swept after a day (Codex's review: a lost reply or a runner quitting
// between uploading and queueing left it in storage for good).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, claimAndFinish, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const LAPTOP = 'laptop000001';
const MINI = 'cb921b2447ea';
const TOKEN = 'phone-token';
const DAY = 24 * 60 * 60_000;

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');
const relay = load('relay');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  const now = Date.now();
  await b.ctx.db.insert('tokens', { hash: await sha256(TOKEN), name: 'iphone', kind: 'phone', expiresAt: now + 100 * DAY, createdAt: now });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07' });
  await b.ctx.db.insert('backendMarks', { name: 'limits-2026-11-07-done' });
  for (const [runnerId, byOwner] of [[LAPTOP, true], [MINI, false]] as const) {
    await b.ctx.db.insert('runners', { runnerId, name: runnerId, version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: now, ...(byOwner ? { byOwner } : {}) });
  }
  await call(b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'B', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  return b;
}
type S = Awaited<ReturnType<typeof setup>>;

// What the main Mac's runner uploads: a one-use ticket on /relay/upload,
// redeemed as convex/http.ts does once it has stored the file.
async function ownerUpload(s: S, id: string, bytes = 1): Promise<string> {
  const url = new URL(await call(s.ctx, relay.pictureUploadUrl, { key: OWNER }));
  assert.equal(url.origin + url.pathname, 'https://site.example/relay/upload');
  assert.equal(await claimAndFinish(s.ctx, relay.claimRelayUpload, relay.finishRelayUpload, { ticket: url.searchParams.get('ticket'), storageId: s.file(id), bytes }), true);
  return id;
}

test('a send to another runner carries each picture with a URL to fetch it by, in order, and finishing deletes them', async () => {
  const s = await setup();
  const a = await ownerUpload(s, 'pic-a');
  const b = await ownerUpload(s, 'pic-b');
  const commandId = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'send', args: { text: 'this [Picture 1] like [Picture 2]', images: [a, b] } });
  const c = s.rows('commands').find((r) => r._id === commandId)!;
  // The same shape as a phone's, which every runner already fetches.
  assert.deepEqual(c.args.images, [
    { storageId: a, url: `https://files.example/${a}` },
    { storageId: b, url: `https://files.example/${b}` },
  ]);
  assert.equal(c.args.from, 'mac');
  assert.equal(s.rows('commandFiles').length, 2, 'recorded as on their way');
  // Mac mini takes it, fetches them and finishes: they're gone from Convex.
  const pending = (await call(s.ctx, sync.pendingCommands, { key: MINI_KEY, runnerId: MINI })) as { args: { images: unknown[] } }[];
  assert.equal(pending[0]!.args.images.length, 2);
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId });
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId, ok: true });
  assert.equal(s.hasFile(a), false);
  assert.equal(s.hasFile(b), false);
  assert.equal(s.rows('commandFiles').length, 0);
});

test('a new thread there can be just a picture; a send of nothing at all is still refused', async () => {
  const s = await setup();
  const pic = await ownerUpload(s, 'pic');
  assert.equal(await outcome(call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, kind: 'create', args: { text: '', images: [pic] } })), 'ok');
  assert.equal(await outcome(call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, kind: 'create', args: { text: ' ' } })), 'badArgs');
  assert.equal(await outcome(call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, kind: 'create', args: { text: '', images: [] } })), 'badArgs');
});

test("a command can't name a file that's gone, in use, a runner key's or a phone's, nor too many", async () => {
  const s = await setup();
  const queue = (images: unknown) => outcome(call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'send', args: { text: 'x', images } }));
  // Gone (or never was).
  assert.equal(await queue(['nothing-here']), 'notFound');
  // A stored file that wasn't uploaded for this: an owner's reply picture uploaded but not attached yet.
  assert.equal(await queue([s.file('bare')]), 'forbidden');
  // Mac mini's share picture: finishing would otherwise hand it to the command's runner.
  const ticket = new URL(await call(s.ctx, sync.iconUploadUrl, { key: MINI_KEY })).searchParams.get('ticket')!;
  const share = s.file('share');
  assert.equal(await claimAndFinish(s.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: share, bytes: 1 }), true);
  assert.equal(await queue([share]), 'forbidden', "a runner key's upload");
  await call(s.ctx, sync.addShareImage, { key: MINI_KEY, threadId: 'B', seq: 1, path: 'a.png', storageId: share, mediaType: 'image/png' });
  assert.equal(await queue([share]), 'forbidden');
  // The owner's own reply picture, in use.
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [{ threadId: 'O', runnerId: LAPTOP, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const reply = s.file('reply');
  await call(s.ctx, sync.addReplyImage, { key: OWNER, threadId: 'O', seq: 1, path: 'r.png', storageId: reply, mediaType: 'image/png' });
  assert.equal(await queue([reply]), 'forbidden');
  // A phone's photo.
  const url = new URL(await call(s.ctx, phone.imageUploadUrl, { token: TOKEN }));
  const photo = s.file('photo');
  assert.equal(await claimAndFinish(s.ctx, phone.claimPhoneUpload, phone.finishPhoneUpload, { ticket: url.searchParams.get('ticket'), storageId: photo, bytes: 1 }), true);
  assert.equal(await queue([photo]), 'forbidden');
  // Not ids, or more than a message takes.
  assert.equal(await queue('pic'), 'badArgs');
  assert.equal(await queue([42]), 'badArgs');
  assert.equal(await queue(await Promise.all(Array.from({ length: 7 }, (_, i) => ownerUpload(s, `many${i}`)))), 'badArgs');
  // One already on its way in another command: two commands finishing would race for it.
  const once = await ownerUpload(s, 'once');
  assert.equal(await queue([once]), 'ok');
  assert.equal(await queue([once]), 'forbidden');
  // Nothing refused was deleted.
  for (const id of [share, reply, photo, once]) assert.equal(s.hasFile(id), true, id);
});

test('pictures only go with a send or a new thread', async () => {
  const s = await setup();
  const pic = await ownerUpload(s, 'pic');
  const r = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'interrupt', args: { images: [pic] } });
  assert.equal(s.rows('commands').find((c) => c._id === r)!.args.images, undefined);
  assert.equal(s.rows('commandFiles').length, 0);
});

test("discarding a queue that failed deletes only the owner's loose uploads", async () => {
  const s = await setup();
  const loose = await ownerUpload(s, 'loose');
  const queued = await ownerUpload(s, 'queued');
  await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'send', args: { text: 'x', images: [queued] } });
  const ticket = new URL(await call(s.ctx, sync.iconUploadUrl, { key: MINI_KEY })).searchParams.get('ticket')!;
  const minis = s.file('minis');
  assert.equal(await claimAndFinish(s.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: minis, bytes: 1 }), true);
  const bare = s.file('bare');
  await call(s.ctx, relay.discardPictures, { key: OWNER, storageIds: [loose, queued, minis, bare, 'gone'] });
  assert.equal(s.hasFile(bare), true, 'not uploaded for this');
  assert.equal(s.hasFile(loose), false);
  assert.equal(s.hasFile(queued), true, 'still on its way');
  assert.equal(s.hasFile(minis), true, "a runner key's");
  // Only the main Mac's runner can.
  assert.equal(await outcome(call(s.ctx, relay.discardPictures, { key: MINI_KEY, storageIds: [queued] })), 'forbidden');
});

test('the upload URL is the owner\'s, one use, and capped at 10 MB', async () => {
  const s = await setup();
  assert.equal(await outcome(call(s.ctx, relay.pictureUploadUrl, { key: MINI_KEY })), 'forbidden');
  const ticket = new URL(await call(s.ctx, relay.pictureUploadUrl, { key: OWNER })).searchParams.get('ticket');
  assert.equal(await claimAndFinish(s.ctx, relay.claimRelayUpload, relay.finishRelayUpload, { ticket, storageId: s.file('a'), bytes: 1 }), true);
  assert.equal(await call(s.ctx, relay.claimRelayUpload, { ticket }), false, 'used');
  assert.equal(await claimAndFinish(s.ctx, relay.claimRelayUpload, relay.finishRelayUpload, { ticket, storageId: s.file('b'), bytes: 1 }), false);
  const big = new URL(await call(s.ctx, relay.pictureUploadUrl, { key: OWNER })).searchParams.get('ticket');
  assert.equal(await claimAndFinish(s.ctx, relay.claimRelayUpload, relay.finishRelayUpload, { ticket: big, storageId: s.file('big'), bytes: 10 * 1024 * 1024 + 1 }), false);
  assert.equal(await call(s.ctx, relay.claimRelayUpload, { ticket: 'nope' }), false);
});

test('an upload that never went out goes after a day; one in a waiting command stays until that is over', async () => {
  const s = await setup();
  const orphan = await ownerUpload(s, 'orphan');
  const sent = await ownerUpload(s, 'sent');
  const commandId = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'send', args: { text: 'x', images: [sent] } });
  // A ticket whose upload never arrived.
  await call(s.ctx, relay.pictureUploadUrl, { key: OWNER });
  const real = Date.now;
  Date.now = () => real() + DAY + 60_000;
  try {
    for (let i = 0; i < 5; i++) await call(s.ctx, sync.pruneFiles, {});
  } finally {
    Date.now = real;
  }
  assert.equal(s.hasFile(orphan), false);
  assert.equal(s.hasFile(sent), true, 'still on its way to Mac mini');
  assert.equal(s.rows('relayUploads').length, 0, 'the records go after a day');
  await call(s.ctx, sync.takeCommand, { key: MINI_KEY, commandId });
  await call(s.ctx, sync.finishCommand, { key: MINI_KEY, commandId, ok: true });
  assert.equal(s.hasFile(sent), false);
});

// The other way (API 87): a picture pasted on the main Mac into a thread on
// the Mac mini reached the Mac mini and showed on the main Mac as a message
// with no picture (17 Nov 2026). The Mac mini already puts pasted pictures up
// for the phone and the website (replyImages, src "picture:N"); the main
// Mac's runner reads them by the message's seq with relay:picturesAtSeqs.
async function pasted(s: S, seq: number, n: number, more: Record<string, unknown> = {}) {
  await s.ctx.db.insert('replyImages', { threadId: 'B', seq, path: `/Users/b/inbox/p${seq}-${n}.png`, src: `picture:${n}`, storageId: s.file(`file-${seq}-${n}`), mediaType: 'image/png', width: 40, height: 30, ...more });
}

test("the owner key reads the pasted pictures of the messages it names, each with a URL, and nothing else of the thread's", async () => {
  const s = await setup();
  await pasted(s, 7, 2);
  await pasted(s, 7, 1);
  await pasted(s, 9, 1);
  // A reply's picture at a seq that's asked for, and one at a seq that isn't.
  await s.ctx.db.insert('replyImages', { threadId: 'B', seq: 9, path: '/Users/b/x/chart.png', src: 'chart.png', storageId: s.file('chart'), mediaType: 'image/png' });
  await s.ctx.db.insert('replyImages', { threadId: 'B', seq: 8, path: '/Users/b/x/other.png', src: 'picture:1', storageId: s.file('other'), mediaType: 'image/png' });
  const got = await call(s.ctx, relay.picturesAtSeqs, { key: OWNER, threadId: 'B', seqs: [9, 7, 11, 7] });
  assert.deepEqual(got, [
    { seq: 7, n: 1, path: '/Users/b/inbox/p7-1.png', url: 'https://files.example/file-7-1', mediaType: 'image/png', width: 40, height: 30 },
    { seq: 7, n: 2, path: '/Users/b/inbox/p7-2.png', url: 'https://files.example/file-7-2', mediaType: 'image/png', width: 40, height: 30 },
    { seq: 9, n: 1, path: '/Users/b/inbox/p9-1.png', url: 'https://files.example/file-9-1', mediaType: 'image/png', width: 40, height: 30 },
  ]);
  // Another thread's rows never come with it.
  assert.deepEqual(await call(s.ctx, relay.picturesAtSeqs, { key: OWNER, threadId: 'other', seqs: [7] }), []);
});

test('a picture whose file has gone is left out, and seqs that are not seqs are passed over', async () => {
  const s = await setup();
  await pasted(s, 7, 1);
  await s.ctx.db.insert('replyImages', { threadId: 'B', seq: 7, path: '/Users/b/inbox/gone.png', src: 'picture:2', storageId: 'file-never-stored', mediaType: 'image/png' });
  const got = (await call(s.ctx, relay.picturesAtSeqs, { key: OWNER, threadId: 'B', seqs: [7, -1, 1.5, Number.MAX_VALUE] })) as { path: string }[];
  assert.deepEqual(got.map((p) => p.path), ['/Users/b/inbox/p7-1.png']);
});

test("a runner key can't read them, even of its own thread", async () => {
  const s = await setup();
  await pasted(s, 7, 1);
  assert.equal(await outcome(call(s.ctx, relay.picturesAtSeqs, { key: MINI_KEY, threadId: 'B', seqs: [7] })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, relay.picturesAtSeqs, { key: 'wrong', threadId: 'B', seqs: [7] })), 'auth');
});

test('at most fifty messages are read in one call, and thirty pictures of each', async () => {
  const s = await setup();
  for (let seq = 1; seq <= 60; seq++) await pasted(s, seq, 1);
  const got = (await call(s.ctx, relay.picturesAtSeqs, { key: OWNER, threadId: 'B', seqs: Array.from({ length: 60 }, (_, i) => i + 1) })) as { seq: number }[];
  assert.deepEqual(got.map((p) => p.seq), Array.from({ length: 50 }, (_, i) => i + 1));
  for (let n = 1; n <= 40; n++) await pasted(s, 100, n);
  const many = (await call(s.ctx, relay.picturesAtSeqs, { key: OWNER, threadId: 'B', seqs: [100] })) as { n: number }[];
  assert.equal(many.length, 30);
});

// The row says how many pictures its message came with (API 87), so the
// relay doesn't guess from the words, and the relay's reads carry it.
test("a message row's picture count is kept and read back by the relay, and a bad one is left off", async () => {
  const s = await setup();
  await call(s.ctx, sync.appendMessages, { key: MINI_KEY, messages: [
    { threadId: 'B', seq: 3, role: 'user', text: 'Look\n\n[2 pictures]', pictures: 2, at: 'x' },
    { threadId: 'B', seq: 4, role: 'user', text: 'odd', pictures: 1.5, at: 'x' },
    { threadId: 'B', seq: 5, role: 'assistant', text: 'ok', at: 'x' },
  ] });
  const tail = (await call(s.ctx, relay.remoteTail, { key: OWNER, threadId: 'B' })) as { messages: { seq: number; pictures?: number }[] };
  assert.deepEqual(tail.messages.map((m) => [m.seq, m.pictures]), [[3, 2], [4, undefined], [5, undefined]]);
  const page = (await call(s.ctx, relay.remoteMessages, { key: OWNER, threadId: 'B' })) as { messages: { seq: number; pictures?: number }[] };
  assert.equal(page.messages.find((m) => m.seq === 3)!.pictures, 2);
});
