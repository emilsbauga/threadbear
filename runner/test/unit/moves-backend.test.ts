// Moving a thread to another runner in the backend (convex/moves.ts,
// docs/protocol.md "Moving a thread to another runner"), against the
// in-memory database: who may take each step, and the switch handing the
// thread and everything under it to the new runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { call, claimAndFinish, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const CLOUD_KEY = 'tbr_cloud';
const LAPTOP = 'laptop000001';
const MINI = 'cb921b2447ea';
const CLOUD = 'befe8df8975c';
const SEAL = 'A'.repeat(43) + '=';
const SHA = 'a'.repeat(64);

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const moves = load('moves');
const machinesModule = load('machines');
const migrations = load('migrations');

// Runs `f` as if `ms` had passed.
async function later<T>(ms: number, f: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + ms;
  try {
    return await f();
  } finally {
    Date.now = realNow;
  }
}

// Fires the move machine's timers due within `ms` from now, as Convex's scheduler would.
async function fireTimers(s: { ctx: unknown; pendingTimers: () => { id: string; args: any; at: number }[]; timerRan: (id: string) => void }, ms: number) {
  const at = Date.now() + ms;
  for (const t of s.pendingTimers().filter((t) => t.at <= at)) {
    await later(t.at - Date.now(), () => call(s.ctx, machinesModule.deliver, t.args));
    s.timerRan(t.id);
  }
}

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  await b.ctx.db.insert('runnerKeys', { runnerId: CLOUD, keyHash: await sha256(CLOUD_KEY), name: 'cloud', createdAt: 1 });
  for (const [runnerId, name] of [
    [LAPTOP, 'Laptop'],
    [MINI, 'mac-mini'],
    [CLOUD, 'cloud'],
  ] as const) {
    await b.ctx.db.insert('runners', { runnerId, name, version: '1', lastSeenAt: Date.now(), startedAt: new Date().toISOString(), draining: false, threadCount: 0 });
  }
  const fn = (f: unknown, args: Record<string, unknown>) => call(b.ctx, f as never, args);
  const as = (key: string) => ({
    start: (threadId: string, to: string, extra: Record<string, unknown> = {}) => fn(moves.startMove, { key, threadId, to, ...extra }),
    cancel: (moveId: string) => fn(moves.cancelMove, { key, moveId }),
    list: (runnerId: string) => fn(moves.moves, { key, runnerId }),
    info: (moveId: string, info: unknown = { cwd: '/x' }) => fn(moves.moveInfo, { key, moveId, info }),
    ready: (moveId: string, plan: unknown = { cwd: '/x' }, sealKey = SEAL) => fn(moves.moveReady, { key, moveId, plan, sealKey }),
    frozen: (moveId: string) => fn(moves.moveFrozen, { key, moveId }),
    chunkUrl: (moveId: string) => fn(moves.moveChunkUrl, { key, moveId }),
    packed: (moveId: string, chunks: string[]) => fn(moves.movePacked, { key, moveId, chunks, sha256: SHA, bytes: 1000 }),
    chunks: (moveId: string) => fn(moves.moveChunks, { key, moveId }),
    claim: (moveId: string) => fn(moves.moveClaim, { key, moveId }),
    done: (moveId: string) => fn(moves.moveDone, { key, moveId }),
    failed: (moveId: string, note = 'no room') => fn(moves.moveFailed, { key, moveId, note }),
    upsert: (...threads: Record<string, unknown>[]) => fn(sync.upsertThreads, { key, threads }),
    append: (threadId: string, text: string, seq = 1) => fn(sync.appendMessages, { key, messages: [{ threadId, seq, role: 'assistant', text, at: 'now' }] }),
  });
  // Runs whatever the switch scheduled (moves:rehomeRows), to the end.
  const rehome = async () => {
    for (let i = 0; i < 100; i++) {
      const next = b.scheduled.findIndex((s: any) => s.fn.endsWith('rehomeRows'));
      if (next < 0) return;
      const [job] = b.scheduled.splice(next, 1) as { args: Record<string, unknown> }[];
      await fn(moves.rehomeRows, job!.args);
    }
    throw new Error('rehomeRows never finished');
  };
  // A runner key's chunk upload through /runner/upload, as http.ts does it.
  const uploadChunk = async (url: string, id: string) => {
    const ticket = new URL(url).searchParams.get('ticket')!;
    b.file(id);
    return claimAndFinish(b.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: id, bytes: 9 * 1024 * 1024 });
  };
  return { ...b, rehome, uploadChunk, owner: as(OWNER), mini: as(MINI_KEY), cloud: as(CLOUD_KEY) };
}

const thread = (threadId: string, runnerId: string, extra: Record<string, unknown> = {}) => ({ threadId, runnerId, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false, ...extra });
const moveOf = (s: Awaited<ReturnType<typeof setup>>, moveId: string) => s.rows('threadMoves').find((m) => m.moveId === moveId)!;

test('only the main Mac starts a move, to an online runner other than the thread’s, one at a time', async () => {
  const s = await setup();
  await s.owner.upsert(thread('T1', LAPTOP));
  assert.equal(await outcome(s.mini.start('T1', MINI)), 'forbidden');
  assert.equal(await outcome(s.owner.start('T1', LAPTOP)), 'badArgs');
  assert.equal(await outcome(s.owner.start('NOPE', MINI)), 'notFound');
  assert.equal(await outcome(s.owner.start('T1', 'nobody')), 'notFound');
  const cloud = s.rows('runners').find((r) => r.runnerId === CLOUD)!;
  cloud.lastSeenAt = Date.now() - 10 * 60_000;
  assert.equal(await outcome(s.owner.start('T1', CLOUD)), 'conflict');
  assert.equal(await outcome(s.owner.start('T1', MINI, { cwd: 'a\nb' })), 'badArgs');
  const { moveId } = await s.owner.start('T1', MINI, { cwd: '/Users/alex/dev/x' });
  assert.deepEqual(
    { from: moveOf(s, moveId).from, to: moveOf(s, moveId).to, state: moveOf(s, moveId).state, cwd: moveOf(s, moveId).cwd },
    { from: LAPTOP, to: MINI, state: 'asking', cwd: '/Users/alex/dev/x' },
  );
  assert.equal(await outcome(s.owner.start('T1', MINI)), 'conflict');
});

test('the main Mac to Mac mini: each step is its own runner’s, and the switch hands everything over', async () => {
  const s = await setup();
  await s.owner.upsert(thread('T1', LAPTOP, { share: { slug: 'slug1', access: 'link' } }));
  await s.owner.append('T1', 'hello', 1);
  await s.owner.append('T1', 'there', 2);
  await s.ctx.db.insert('threadIndex', { runnerId: LAPTOP, threadId: 'T1', title: 'T', cwd: '/x', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: '', createdAt: 'x', lastActivityAt: 'x' });
  await s.ctx.db.insert('pocketCards', { key: 'k1', title: 'Code', text: '1234', threadId: 'T1', updatedAt: 'x', runnerId: LAPTOP });
  const img = s.file('img1');
  await s.ctx.db.insert('replyImages', { threadId: 'T1', seq: 2, path: 'a.png', storageId: img, mediaType: 'image/png' });

  const { moveId } = await s.owner.start('T1', MINI);
  // Mac mini sees it; Cloud doesn't, and can't ask for Mac mini's.
  assert.deepEqual((await s.mini.list(MINI)).map((m: any) => [m.moveId, m.state]), [[moveId, 'asking']]);
  assert.deepEqual(await s.cloud.list(CLOUD), []);
  assert.equal(await outcome(s.cloud.list(MINI)), 'forbidden');

  // S describes it first; only S can, and only T says it's ready, with a real key and a small plan.
  assert.equal(await outcome(s.mini.ready(moveId)), 'conflict');
  assert.equal(await outcome(s.mini.info(moveId)), 'forbidden');
  assert.equal(await outcome(s.owner.info(moveId, ['x'])), 'badArgs');
  await s.owner.info(moveId);
  assert.equal(await outcome(s.cloud.ready(moveId)), 'forbidden');
  assert.equal(await outcome(s.mini.ready(moveId, { cwd: '/x' }, 'short')), 'badArgs');
  assert.equal(await outcome(s.mini.ready(moveId, { big: 'x'.repeat(20_000) })), 'badArgs');
  assert.equal(await outcome(s.mini.frozen(moveId)), 'forbidden');
  await s.mini.ready(moveId);
  await s.mini.ready(moveId); // a retry is fine
  assert.equal(moveOf(s, moveId).state, 'ready');

  // S freezes and packs; T can't do S's steps or claim early.
  assert.equal(await outcome(s.mini.frozen(moveId)), 'forbidden');
  assert.equal(await outcome(s.owner.chunkUrl(moveId)), 'conflict');
  await s.owner.frozen(moveId);
  assert.equal(await s.owner.chunkUrl(moveId), 'https://upload.example/');
  assert.equal(await outcome(s.mini.claim(moveId)), 'conflict');
  const chunk = s.file('chunk1');
  assert.equal(await outcome(s.owner.packed(moveId, [chunk, chunk])), 'badArgs');
  assert.equal(await outcome(s.owner.packed(moveId, ['missing'])), 'badArgs');
  await s.owner.packed(moveId, [chunk]);
  assert.equal(moveOf(s, moveId).state, 'unpacking');
  assert.equal(await outcome(s.cloud.chunks(moveId)), 'forbidden');
  assert.deepEqual(await s.mini.chunks(moveId), ['https://files.example/chunk1']);
  // Before the switch the thread is still Laptop's: Mac mini can't write it.
  assert.equal(await outcome(s.mini.upsert(thread('T1', MINI))), 'forbidden');

  await s.mini.claim(moveId);
  await s.mini.claim(moveId); // a retry is fine
  const row = s.rows('threads').find((t) => t.threadId === 'T1')!;
  assert.equal(row.runnerId, MINI);
  assert.equal(row.share.slug, 'slug1');
  assert.equal(s.rows('threadIndex').find((r) => r.runnerId === LAPTOP && r.threadId === 'T1')!.deleted, true);
  assert.equal(s.rows('pocketCards').find((c) => c.key === 'k1')!.runnerId, MINI);
  await s.rehome();
  // Its history is Mac mini's now, counted against Mac mini, and so is its picture.
  assert.deepEqual(s.rows('messages').filter((m) => m.threadId === 'T1').map((m) => [m.text, m.runnerId]), [['hello', MINI], ['there', MINI]]);
  assert.ok(s.rows('runnerStorage').find((r) => r.runnerId === MINI)!.messageBytes > 0);
  assert.equal(s.rows('storageOwners').find((o) => o.storageId === img)!.runnerId, MINI);

  // Mac mini writes it from now on, its share link and all; its next message goes on.
  assert.equal(await outcome(s.mini.upsert(thread('T1', MINI, { share: { slug: 'slug1', access: 'link' } }))), 'ok');
  await s.mini.append('T1', 'moved', 3);
  assert.deepEqual(s.rows('messages').filter((m) => m.threadId === 'T1').map((m) => m.text), ['hello', 'there', 'moved']);
  // A command for it goes to Mac mini now, not Laptop.
  assert.equal(await outcome(call(s.ctx, load('relay').queueCommand as never, { key: OWNER, runnerId: LAPTOP, threadId: 'T1', kind: 'send', args: { text: 'hi' } })), 'forbidden');

  assert.equal(await outcome(s.mini.failed(moveId)), 'conflict');
  await s.mini.done(moveId);
  assert.equal(moveOf(s, moveId).state, 'done');
  assert.ok(s.deleted.includes(chunk), 'the chunk goes when the move ends');
  assert.equal(moveOf(s, moveId).chunks, undefined);
});

test('Mac mini to the main Mac: chunks come through /runner/upload, charged with a move’s worth of room on top of Mac mini’s picture allowance', async () => {
  const s = await setup();
  await s.mini.upsert(thread('T2', MINI));
  await s.mini.append('T2', 'from mac-mini', 1);
  const { moveId } = await s.owner.start('T2', LAPTOP);
  await s.mini.info(moveId);
  await s.owner.ready(moveId);
  await s.mini.frozen(moveId);
  // Mac mini's stored allowance is spent: a picture would wait, a chunk has
  // a move's worth of room on top, and is charged while the move holds it.
  s.rows('runnerStorage').find((r) => r.runnerId === MINI)!.bytes = 150 * 1024 * 1024;
  const url = await s.mini.chunkUrl(moveId);
  assert.match(url, /^https:\/\/site\.example\/runner\/upload\?ticket=[0-9a-f]{48}$/);
  assert.equal(await s.uploadChunk(url, 'c1'), true);
  assert.equal(s.rows('runnerStorage').find((r) => r.runnerId === MINI)!.bytes, 159 * 1024 * 1024);
  // Only its own uploads go on the move.
  const someoneElses = s.file('owners-file');
  assert.equal(await outcome(s.mini.packed(moveId, [someoneElses])), 'forbidden');
  await s.mini.packed(moveId, ['c1']);
  await s.owner.claim(moveId);
  await s.rehome();
  const row = s.rows('threads').find((t) => t.threadId === 'T2')!;
  assert.equal(row.runnerId, LAPTOP);
  // The owner's rows carry no runnerId, and Mac mini's allowance has them back.
  assert.equal(s.rows('messages').find((m) => m.threadId === 'T2')!.runnerId, undefined);
  assert.equal(s.rows('runnerStorage').find((r) => r.runnerId === MINI)!.messageBytes, 0);
  // Mac mini can't write it any more.
  assert.equal(await outcome(s.mini.upsert(thread('T2', MINI))), 'forbidden');
  await s.mini.append('T2', 'late', 2);
  assert.deepEqual(s.rows('messages').filter((m) => m.threadId === 'T2').map((m) => m.text), ['from mac-mini']);
  await s.owner.done(moveId);
  assert.ok(s.deleted.includes('c1'));
  assert.equal(s.rows('storageOwners').some((o) => o.storageId === 'c1'), false);
  assert.equal(s.rows('runnerStorage').find((r) => r.runnerId === MINI)!.bytes, 150 * 1024 * 1024, 'given back when the move ends');
});

// Security review, 10 Nov 2026: a move's uploads were stored with nothing
// charged and nothing naming the move, so a runner could take its 24
// tickets, upload 10 MB through each, fail the move before movePacked, and
// keep 240 MB that no cleanup ever reached; a ticket also still worked
// after the move ended.
test('a move’s uploads are charged, and all of them go when it fails, listed or not', async () => {
  const s = await setup();
  await s.mini.upsert(thread('T3', MINI));
  const { moveId } = await s.owner.start('T3', LAPTOP);
  await s.mini.info(moveId);
  await s.owner.ready(moveId);
  await s.mini.frozen(moveId);
  const urls: string[] = [];
  for (let i = 0; i < 24; i++) urls.push(await s.mini.chunkUrl(moveId));
  assert.equal(await outcome(s.mini.chunkUrl(moveId)), 'tooMany');
  for (let i = 0; i < 23; i++) assert.equal(await s.uploadChunk(urls[i]!, `x${i}`), true);
  const charged = s.rows('runnerStorage').find((r) => r.runnerId === MINI)!.bytes;
  assert.equal(charged, 23 * 9 * 1024 * 1024);
  await s.mini.failed(moveId);
  for (let i = 0; i < 23; i++) assert.ok(s.deleted.includes(`x${i}`), `x${i} deleted`);
  assert.equal(s.rows('storageOwners').filter((o) => o.runnerId === MINI).length, 0);
  assert.equal(s.rows('runnerStorage').find((r) => r.runnerId === MINI)!.bytes, 0);
  // The last ticket, from before it failed, stores nothing now.
  const ticket = new URL(urls[23]!).searchParams.get('ticket')!;
  assert.equal(await call(s.ctx, sync.claimUpload, { ticket }), false);
  s.file('late');
  assert.equal(await claimAndFinish(s.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: 'late', bytes: 1024 }), false);
  assert.equal(s.rows('storageOwners').some((o) => o.storageId === 'late'), false);
});

test('a move’s ticket stores nothing once the move is packed, and the move’s room has a limit', async () => {
  const s = await setup();
  await s.mini.upsert(thread('T4', MINI));
  const { moveId } = await s.owner.start('T4', LAPTOP);
  await s.mini.info(moveId);
  await s.owner.ready(moveId);
  await s.mini.frozen(moveId);
  const [a, b, c] = [await s.mini.chunkUrl(moveId), await s.mini.chunkUrl(moveId), await s.mini.chunkUrl(moveId)];
  // Already at its allowance and a move's room: this one waits.
  await s.ctx.db.insert('runnerStorage', { runnerId: MINI, bytes: (150 + 120) * 1024 * 1024 - 1024 * 1024 });
  assert.equal(await s.uploadChunk(a, 'full'), 'later');
  s.rows('runnerStorage').find((r) => r.runnerId === MINI)!.bytes = 0;
  assert.equal(await s.uploadChunk(b, 'p1'), true);
  await s.mini.packed(moveId, ['p1']);
  assert.equal(await s.uploadChunk(c, 'after'), false);
  assert.equal(s.rows('storageOwners').some((o) => o.storageId === 'after'), false);
});

test('a move fails or is cancelled only before the switch, and a stuck one fails by itself', async () => {
  const s = await setup();
  await s.owner.upsert(thread('T3', LAPTOP), thread('T4', LAPTOP), thread('T5', LAPTOP));
  const a = (await s.owner.start('T3', MINI)).moveId;
  assert.equal(await outcome(s.cloud.failed(a)), 'forbidden');
  await s.mini.failed(a, 'Mac mini has no copy of alex-example/foo.');
  assert.equal(moveOf(s, a).state, 'failed');
  assert.equal(moveOf(s, a).note, 'Mac mini has no copy of alex-example/foo.');
  await s.mini.failed(a); // again is fine
  // A failed move doesn't stop the next.
  const b = (await s.owner.start('T3', MINI)).moveId;
  await s.owner.info(b);
  await s.mini.ready(b);
  await s.owner.frozen(b);
  await s.owner.cancel(b);
  assert.equal(moveOf(s, b).state, 'cancelled');

  const c = (await s.owner.start('T4', MINI)).moveId;
  await s.owner.info(c);
  await s.mini.ready(c);
  await s.owner.frozen(c);
  await s.owner.packed(c, [s.file('k')]);
  assert.equal(await outcome(s.owner.cancel(c)), 'conflict');
  await s.mini.claim(c);
  assert.equal(await outcome(s.owner.failed(c)), 'conflict');

  // Nobody answered T5's, and another frozen for too long: the machine's timers end them.
  const d = (await s.owner.start('T5', CLOUD)).moveId;
  const e = (await s.owner.start('T3', MINI)).moveId;
  await s.owner.info(e);
  await s.mini.ready(e);
  await s.owner.frozen(e);
  await fireTimers(s, 9 * 60_000);
  assert.equal(moveOf(s, d).state, 'asking');
  await fireTimers(s, 11 * 60_000);
  assert.equal(moveOf(s, d).state, 'failed');
  assert.equal(moveOf(s, d).note, "cloud didn't answer.");
  assert.equal(moveOf(s, e).state, 'packing');
  await fireTimers(s, 31 * 60_000);
  assert.equal(moveOf(s, e).state, 'failed');
  assert.equal(moveOf(s, e).note, 'The move took more than 30 minutes.');
  assert.equal(moveOf(s, c).state, 'claimed', 'past the switch, the new runner finishes it');
});

// 16 Nov 2026 (David Clark's fork): a restart of the main Mac took two
// threads it had moved to another Mac for deleted there, and the owner key's
// removeThreads deleted their rows on the Mac they'd moved to. A removal that
// names its runner only takes that runner's rows, whatever the key.
test("a removal naming its runner leaves a thread that moved to another runner alone", async () => {
  const s = await setup();
  await s.owner.upsert(thread('T7', LAPTOP), thread('T8', LAPTOP));
  const { moveId } = await s.owner.start('T7', MINI);
  await s.owner.info(moveId);
  await s.mini.ready(moveId);
  await s.owner.frozen(moveId);
  const chunk = s.file('chunk7');
  await s.owner.packed(moveId, [chunk]);
  await s.mini.claim(moveId);
  assert.equal(s.rows('threads').find((t) => t.threadId === 'T7')!.runnerId, MINI);

  await call(s.ctx, sync.removeThreads as never, { key: OWNER, threadIds: ['T7', 'T8'], runnerId: LAPTOP });
  assert.ok(s.rows('threads').some((t) => t.threadId === 'T7'), "Mac mini's thread stays");
  assert.ok(!s.rows('threads').some((t) => t.threadId === 'T8'), "the Laptop's own goes");
  assert.equal(await outcome(call(s.ctx, sync.removeThreads as never, { key: MINI_KEY, threadIds: ['T7'], runnerId: LAPTOP })), 'forbidden', 'a runner key names only its own runner');
});

test('the switch fails the move if the thread left its runner meanwhile', async () => {
  const s = await setup();
  await s.mini.upsert(thread('T6', MINI));
  const { moveId } = await s.owner.start('T6', CLOUD);
  await s.mini.info(moveId);
  await s.cloud.ready(moveId);
  await s.mini.frozen(moveId);
  const url = await s.mini.chunkUrl(moveId);
  await s.uploadChunk(url, 'c6');
  await s.mini.packed(moveId, ['c6']);
  // Removed on Mac mini meanwhile.
  await call(s.ctx, sync.removeThreads as never, { key: MINI_KEY, threadIds: ['T6'] });
  await s.cloud.claim(moveId);
  assert.equal(moveOf(s, moveId).state, 'failed');
  assert.ok(s.deleted.includes('c6'));
});

// Codex's review, 10 Nov 2026: the main Mac's own chunks go up as Convex
// uploads with no record, so a target that failed the move while they
// went up left them for good. Its runner now names them once it's over.
test('the main Mac drops its own chunks for a move that ended before it was packed', async () => {
  const s = await setup();
  await s.owner.upsert(thread('T5', LAPTOP));
  const { moveId } = await s.owner.start('T5', MINI);
  await s.owner.info(moveId);
  await s.mini.ready(moveId);
  await s.owner.frozen(moveId);
  const mine = s.file('mine1');
  const drop = (key: string, chunks: string[]) => call(s.ctx, moves.moveDropChunks as never, { key, moveId, chunks });
  assert.equal(await outcome(drop(OWNER, [mine])), 'conflict', 'not while it goes');
  await s.mini.failed(moveId, 'gone away');
  assert.equal(await outcome(s.owner.packed(moveId, [mine])), 'conflict');
  assert.equal(await outcome(drop(MINI_KEY, [mine])), 'forbidden');
  // A file something else uses, or one a runner key uploaded, stays.
  const used = s.file('used1');
  await s.ctx.db.insert('replyImages', { threadId: 'T5', seq: 1, path: 'a.png', storageId: used, mediaType: 'image/png' });
  const theirs = s.file('theirs1');
  await s.ctx.db.insert('storageOwners', { storageId: theirs, runnerId: MINI, at: 1, bytes: 1 });
  await drop(OWNER, [mine, used, theirs]);
  assert.ok(s.deleted.includes('mine1'));
  assert.ok(!s.deleted.includes('used1'));
  assert.ok(!s.deleted.includes('theirs1'));
});

// A project id is only its runner's own (sync.ts heldElsewhere), so a thread
// moved to another Mac leaves its old Mac's projects at the switch: kept,
// the new Mac could leave it listed in the old Mac's project page, and under
// that project in the phone apps from before API 82, by never writing it
// again (Daybreak 141, cross-lab review, 17 Nov 2026).
test("a thread moved to another Mac leaves the old Mac's projects at the switch", async () => {
  const s = await setup();
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: LAPTOP, projects: [{ id: 'p_main', title: 'Main', folders: [], goals: '', state: '', notes: '', createdBy: 'mike', archived: false, createdAt: 'c', updatedAt: 'u', threadCount: 1 }] });
  await s.owner.upsert(thread('T1', LAPTOP, { projects: [{ id: 'p_main', title: 'Main' }] }));
  assert.equal(s.rows('projectThreads').length, 1);
  const { moveId } = await s.owner.start('T1', MINI);
  await s.owner.info(moveId);
  await s.mini.ready(moveId);
  await s.owner.frozen(moveId);
  await s.owner.packed(moveId, [s.file('chunk1')]);
  await s.mini.claim(moveId);
  const row = s.rows('threads').find((t) => t.threadId === 'T1')!;
  assert.equal(row.runnerId, MINI);
  assert.equal(row.projects, undefined);
  assert.deepEqual(s.rows('projectThreads'), []);
  // And it stays out while Mac mini only adds replies.
  await s.mini.append('T1', 'later', 9);
  assert.equal(s.rows('threads').find((t) => t.threadId === 'T1')!.projects, undefined);
});

// A ready move waits for S's thread to finish its turn, so it has no short
// limit. But with nothing to end it, a move whose S went away stayed ready
// for good, and every later move of the thread was refused as "already
// moving" (the state machines survey, 17 Nov 2026).
test('a ready move fails once its thread’s runner has gone offline, or after 12 hours, and the thread can move again', async () => {
  const s = await setup();
  await s.mini.upsert(thread('R1', MINI));
  await s.mini.upsert(thread('R2', MINI));
  await s.owner.upsert(thread('R3', LAPTOP));
  const busy = (await s.owner.start('R1', CLOUD)).moveId;
  await s.mini.info(busy);
  await s.cloud.ready(busy);
  // S online, its thread still in its turn: it waits, however many sweeps go by.
  await call(s.ctx, moves.expireMoves as never, {});
  assert.equal(moveOf(s, busy).state, 'ready');
  assert.equal(await outcome(s.owner.start('R1', CLOUD)), 'conflict');

  // S went to sleep: once it's been gone ten minutes, the move ends.
  const mini = s.rows('runners').find((r) => r.runnerId === MINI)!;
  mini.lastSeenAt = Date.now() - 11 * 60_000;
  moveOf(s, busy).updatedAt -= 11 * 60_000;
  await call(s.ctx, moves.expireMoves as never, {});
  assert.equal(moveOf(s, busy).state, 'failed');
  assert.equal(moveOf(s, busy).note, 'mac-mini went offline before the thread could be packed, so it stays where it is.');
  // A move made ready just now isn't failed for S's earlier silence.
  const fresh = (await s.owner.start('R2', CLOUD)).moveId;
  await s.mini.info(fresh);
  await s.cloud.ready(fresh);
  await call(s.ctx, moves.expireMoves as never, {});
  assert.equal(moveOf(s, fresh).state, 'ready');
  mini.lastSeenAt = Date.now();
  // And the thread can be moved again.
  await s.owner.cancel(fresh);
  assert.equal(moveOf(s, (await s.owner.start('R1', CLOUD)).moveId).state, 'asking');

  // S online but the thread busy for 12 hours: it ends too.
  const long = (await s.owner.start('R3', MINI)).moveId;
  await s.owner.info(long);
  await s.mini.ready(long);
  await fireTimers(s, 11 * 60 * 60_000);
  assert.equal(moveOf(s, long).state, 'ready');
  await fireTimers(s, 12 * 60 * 60_000 + 60_000);
  assert.equal(moveOf(s, long).state, 'failed');
  assert.match(moveOf(s, long).note, /still busy 12 hours later/);
});

// ------------------------------------------------------------ the move machine

const { legacyMoveState, MOVE_READY_MS } = load('moveStates') as { legacyMoveState: (s: { kind: string }) => string; MOVE_READY_MS: number };

test('every step writes moveState with state, and the move only takes the steps its state allows', async () => {
  const s = await setup();
  await s.owner.upsert(thread('M1', LAPTOP));
  const id = (await s.owner.start('M1', MINI)).moveId;
  const kinds = [moveOf(s, id).moveState.kind];
  // Out of order: refused as before, with the state it's in.
  await assert.rejects(s.owner.frozen(id), /The move is asking, so it can't start packing/);
  await assert.rejects(s.mini.ready(id), /before its thread is described/);
  await s.owner.info(id);
  await s.mini.ready(id);
  kinds.push(moveOf(s, id).moveState.kind);
  await s.owner.frozen(id);
  kinds.push(moveOf(s, id).moveState.kind);
  assert.equal(moveOf(s, id).moveState.frozenAt, moveOf(s, id).frozenAt);
  await s.owner.packed(id, [s.file('c1')]);
  kinds.push(moveOf(s, id).moveState.kind);
  await s.mini.claim(id);
  kinds.push(moveOf(s, id).moveState.kind);
  assert.deepEqual(kinds, ['asking', 'ready', 'packing', 'unpacking', 'claimed']);
  for (const r of s.rows('threadMoves')) assert.equal(legacyMoveState(r.moveState), r.state);
  // None of the machine's own fields reach the runners.
  const listed = (await s.mini.list(MINI))[0];
  assert.ok(!('moveState' in listed) && !('moveStateTimers' in listed));
  // Leaving a state with a deadline cancels its timer: a claimed move has none.
  assert.deepEqual(s.pendingTimers().filter((t) => t.args.id === moveOf(s, id)._id), []);
});

test('T saying done before its rows have gone over ends the move once they have, and either order ends it once', async () => {
  const s = await setup();
  await s.owner.upsert(thread('D1', LAPTOP), thread('D2', LAPTOP));
  const go = async (threadId: string) => {
    const id = (await s.owner.start(threadId, MINI)).moveId;
    await s.owner.info(id);
    await s.mini.ready(id);
    await s.owner.frozen(id);
    await s.owner.packed(id, [s.file(`c-${threadId}`)]);
    await s.mini.claim(id);
    return id;
  };
  // Done first: it waits, claimed, for the rows.
  const first = await go('D1');
  await s.mini.done(first);
  await s.mini.done(first); // again is fine
  assert.deepEqual(moveOf(s, first).moveState, { kind: 'claimed', claimedAt: moveOf(s, first).moveState.claimedAt, doneAsked: true });
  await s.rehome();
  assert.equal(moveOf(s, first).moveState.kind, 'done');
  // Rows first: handed over, still `claimed` to the runners, until T says done.
  const second = await go('D2');
  await s.rehome();
  assert.equal(moveOf(s, second).moveState.kind, 'handedOver');
  assert.equal(moveOf(s, second).state, 'claimed');
  assert.equal(await outcome(s.owner.start('D2', CLOUD)), 'conflict', 'not moving again before it ends');
  await s.mini.done(second);
  assert.equal(moveOf(s, second).state, 'done');
  await s.mini.done(second);
  assert.equal(moveOf(s, second).state, 'done');
});

test('the backfill gives moves from before moveState their state and deadlines, and the sweep arms their timers', async () => {
  const s = await setup();
  const now = Date.now();
  const base = { from: LAPTOP, to: MINI, createdAt: now - 60_000, moveState: undefined };
  const old = [
    { moveId: 'm-asking', threadId: 'A', state: 'asking', updatedAt: now - 9 * 60_000, want: { kind: 'asking', askBy: now + 60_000 } },
    { moveId: 'm-ready', threadId: 'B', state: 'ready', updatedAt: now - 1000, want: { kind: 'ready', readyAt: now - 1000, giveUpAt: now - 1000 + MOVE_READY_MS } },
    { moveId: 'm-packing', threadId: 'C', state: 'packing', updatedAt: now, frozenAt: now - 31 * 60_000, want: { kind: 'packing', frozenAt: now - 31 * 60_000, giveUpAt: now - 60_000 } },
    { moveId: 'm-claimed', threadId: 'D', state: 'claimed', updatedAt: now - 5, doneAsked: true, want: { kind: 'claimed', claimedAt: now - 5, doneAsked: true } },
    { moveId: 'm-rehomed', threadId: 'E', state: 'claimed', updatedAt: now - 5, rehomedAt: now - 2, want: { kind: 'handedOver', claimedAt: now - 5, rehomedAt: now - 2 } },
    { moveId: 'm-done', threadId: 'F', state: 'done', updatedAt: now - 3, want: { kind: 'done', endedAt: now - 3 } },
  ];
  for (const { want: _, ...row } of old) await s.ctx.db.insert('threadMoves', { ...base, ...row });
  assert.equal(await call(s.ctx, migrations.done, { name: 'moveState' }), false);
  while (!(await call(s.ctx, migrations.run, { name: 'moveState' })).done);
  assert.equal(await call(s.ctx, migrations.done, { name: 'moveState' }), true);
  assert.deepEqual(old.map((o) => moveOf(s, o.moveId).moveState), old.map((o) => o.want));
  assert.ok(s.rows('threadMoves').every((r) => Array.isArray(r.moveStateTimers) && r.moveStateTimers.length === 0));

  // Once the machine is live, the sweep arms each deadline the row already had.
  await call(s.ctx, moves.expireMoves as never, {});
  const due = Object.fromEntries(s.pendingTimers().map((t) => [t.args.event + ':' + s.rows('threadMoves').find((m) => m._id === t.args.id)!.moveId, t.at]));
  assert.deepEqual(due, { 'NO_ANSWER:m-asking': now + 60_000, 'WAITED_TOO_LONG:m-ready': now - 1000 + MOVE_READY_MS, 'TOO_SLOW:m-packing': now - 60_000 });
  // Armed once: the sweep again leaves them be.
  await call(s.ctx, moves.expireMoves as never, {});
  assert.equal(s.pendingTimers().length, 3);
  // The one past its deadline ends as soon as its timer runs.
  await fireTimers(s, 0);
  assert.equal(moveOf(s, 'm-packing').state, 'failed');
  assert.equal(moveOf(s, 'm-asking').state, 'asking');
});

// Codex's review: while the deploy's stepping stone has the machine off, a
// runner from before the retries treats a refused moveDone as final, which
// left the move claimed and the thread unable to move again. moveDone and
// moveFailed go through then, the way they did before the machine; the rest
// say the backend is being updated.
test('during the stepping stone, done and failed go through as before, and keep a backfilled row’s moveState in step', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-stepping-'));
  try {
    const convex = path.join(import.meta.dirname, '../../../convex');
    for (const f of fs.readdirSync(convex)) if (f.endsWith('.ts')) fs.copyFileSync(path.join(convex, f), path.join(root, f));
    const stepping = path.join(root, 'stepping.ts');
    fs.writeFileSync(stepping, fs.readFileSync(stepping, 'utf8').replace('export const STEPPING: readonly string[] = [];', "export const STEPPING: readonly string[] = ['moveState'];"));
    process.env.RUNNER_KEY = OWNER;
    const b = memoryBackend(root);
    const m = load('moves', root);
    const now = Date.now();
    const base = { from: MINI, to: LAPTOP, createdAt: now - 60_000, updatedAt: now - 1000 };
    const id = async (moveId: string, row: Record<string, unknown>) => (await b.ctx.db.insert('threadMoves', { moveId, threadId: moveId, ...base, ...row }), moveId);
    const row = (moveId: string) => b.rows('threadMoves').find((r) => r.moveId === moveId)!;
    const a = await id('m-claimed', { state: 'claimed' });
    const r = await id('m-rehomed', { state: 'claimed', rehomedAt: now - 500 });
    const f = await id('m-asking', { state: 'asking' });
    // One the backfill has already reached: its moveState follows the old fields.
    const g = await id('m-backfilled', { state: 'claimed', moveState: { kind: 'claimed', claimedAt: now - 1000, doneAsked: false }, moveStateTimers: [] });
    const fn = (f: unknown, args: Record<string, unknown>) => call(b.ctx, f as never, { key: OWNER, ...args });

    await fn(m.moveDone, { moveId: a });
    assert.deepEqual([row(a).state, row(a).doneAsked, row(a).moveState], ['claimed', true, undefined]);
    await fn(m.moveDone, { moveId: r });
    assert.equal(row(r).state, 'done');
    await fn(m.moveFailed, { moveId: f, note: 'no room' });
    assert.deepEqual([row(f).state, row(f).note], ['failed', 'no room']);
    await fn(m.moveDone, { moveId: g });
    assert.deepEqual(row(g).moveState, { kind: 'claimed', claimedAt: row(g).updatedAt, doneAsked: true });
    assert.equal(await outcome(fn(m.moveFailed, { moveId: a, note: 'x' })), 'conflict', 'past the switch, still');
    // The rest wait for the machine.
    await assert.rejects(fn(m.cancelMove, { moveId: g }), /The backend is being updated/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
