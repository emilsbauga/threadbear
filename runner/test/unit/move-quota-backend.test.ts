// A moved thread's rows go to the runner it moves to within that runner's
// allowances, and a box is charged for them like any runner key (Daybreak
// finding 181, 24 Nov 2026): moves:rehomeRows added to the new runner's
// counts with no check, so moving full threads in could push a runner past
// its caps, and a box (whose key isn't a runnerKeys row) was taken for the
// owner, its moved rows and files charged to nobody. Played against the
// in-memory database (test/helpers/convex-memory.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, claimAndFinish, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';
import { BOX_RUNNER, boxBackend, OWNER, THREAD } from '../helpers/box-backend.ts';

const MINI_KEY = 'tbr_mac-mini';
const CLOUD_KEY = 'tbr_cloud';
const LAPTOP = 'laptop000001';
const MINI = 'cb921b2447ea'; // T
const CLOUD = 'befe8df8975c'; // S
const SEAL = 'A'.repeat(43) + '=';
const SHA = 'a'.repeat(64);
const STORED = 150 * 1024 * 1024; // sync.ts STORED_BYTES_PER_RUNNER

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const moves = load('moves');
const CAP = sync.RUNNER_KEY_CAPS as { messageBytes: number; evictPerWrite: number; bodyBytes: number; bodyEvictPerWrite: number };
const storedBytes = sync.storedBytes as (r: Record<string, unknown>) => number;

type B = ReturnType<typeof memoryBackend>;

function mover(b: B) {
  const fn = (f: unknown, args: Record<string, unknown>) => call(b.ctx, f as never, args);
  const as = (key: string) => ({
    start: (threadId: string, to: string) => fn(moves.startMove, { key, threadId, to }),
    info: (moveId: string) => fn(moves.moveInfo, { key, moveId, info: { cwd: '/x' } }),
    ready: (moveId: string) => fn(moves.moveReady, { key, moveId, plan: { cwd: '/x' }, sealKey: SEAL }),
    frozen: (moveId: string) => fn(moves.moveFrozen, { key, moveId }),
    // A runner key's chunk goes up through /runner/upload; the main key's is a plain Convex upload.
    pack: async (moveId: string) => {
      const ticket = new URL(await fn(moves.moveChunkUrl, { key, moveId })).searchParams.get('ticket');
      const id = b.file(`chunk-${moveId}`);
      if (ticket) assert.equal(await claimAndFinish(b.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: id, bytes: 1000 }), true);
      return fn(moves.movePacked, { key, moveId, chunks: [id], sha256: SHA, bytes: 1000 });
    },
    claim: (moveId: string) => fn(moves.moveClaim, { key, moveId }),
    done: (moveId: string) => fn(moves.moveDone, { key, moveId }),
    upsert: (threadId: string, runnerId: string) => fn(sync.upsertThreads, { key, threads: [{ threadId, runnerId, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] }),
    append: (threadId: string, from: number, n: number, size: number) => fn(sync.appendMessages, { key, messages: Array.from({ length: n }, (_, k) => ({ threadId, seq: from + k, role: 'assistant', text: `${threadId}${from + k} `.padEnd(size, 'x'), at: 'now' })) }),
    bodies: (threadId: string, from: number, n: number, size: number) => fn(sync.appendBodies, { key, bodies: Array.from({ length: n }, (_, k) => ({ threadId, seq: from + k, text: 'o'.repeat(size) })) }),
    picture: async (threadId: string, id: string, bytes: number) => {
      const ticket = new URL(await fn(sync.iconUploadUrl, { key })).searchParams.get('ticket');
      assert.equal(await claimAndFinish(b.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: b.file(id), bytes }), true);
      return fn(sync.addReplyImage, { key, threadId, seq: 1, path: `${id}.png`, storageId: id, mediaType: 'image/png' });
    },
  });
  // The rehome pages scheduled and not yet run, run until there are none.
  const runAll = async () => {
    let runs = 0;
    for (let round = 0; round < 500; round++) {
      const next: Record<string, unknown>[] = [];
      for (let i = b.scheduled.length - 1; i >= 0; i--) {
        const job = b.scheduled[i] as { fn: string; args: Record<string, unknown> };
        if (job.fn.endsWith('rehomeRows')) next.unshift(...(b.scheduled.splice(i, 1) as (typeof job)[]).map((j) => j.args));
      }
      if (!next.length) return runs;
      for (const a of next) {
        await fn(moves.rehomeRows, a);
        runs++;
      }
    }
    throw new Error('rehomeRows never finished');
  };
  // A whole move, S's and T's steps by their keys, its pages run.
  const move = async (threadId: string, to: string, from: ReturnType<typeof as>, onto: ReturnType<typeof as>, run = true) => {
    const { moveId } = await as(OWNER).start(threadId, to);
    await from.info(moveId);
    await onto.ready(moveId);
    await from.frozen(moveId);
    await from.pack(moveId);
    await onto.claim(moveId);
    await onto.done(moveId);
    if (run) await runAll();
    return moveId as string;
  };
  return { fn, as, runAll, move };
}

async function afterMinutes<T>(n: number, f: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow() + n * 60_000;
  try {
    return await f();
  } finally {
    Date.now = realNow;
  }
}

const usage = (b: B, runnerId: string) => b.rows('runnerStorage').find((u) => u.runnerId === runnerId) ?? { bytes: 0, messageBytes: 0, bodyBytes: 0 };
const held = (b: B, table: string, runnerId: string) => b.rows(table).filter((r) => r.runnerId === runnerId).reduce((n, r) => n + storedBytes(r), 0);
const moveOf = (b: B, moveId: string) => b.rows('threadMoves').find((m) => m.moveId === moveId)!;

async function keyed() {
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
  const m = mover(b);
  return { ...b, ...m, owner: m.as(OWNER), mini: m.as(MINI_KEY), cloud: m.as(CLOUD_KEY) };
}

async function withCaps<T>(caps: Partial<typeof CAP>, f: () => Promise<T>): Promise<T> {
  const was = { ...CAP };
  Object.assign(CAP, caps);
  try {
    return await f();
  } finally {
    Object.assign(CAP, was);
  }
}

test("a thread moved to a runner at its caps never puts it past them: its oldest give way, and pictures it has no room for aren't kept for it", async () => {
  const s = await keyed();
  // Cloud's thread T: 30 messages, 10 tool outputs and a picture. Mac mini's own O, as much again.
  await s.cloud.upsert('T', CLOUD);
  await s.cloud.append('T', 1, 30, 2_000);
  await s.cloud.bodies('T', 1, 10, 2_000);
  await s.cloud.picture('T', 'cloud-pic', 100_000);
  await s.mini.upsert('O', MINI);
  await s.mini.append('O', 1, 30, 2_000);
  await s.mini.bodies('O', 1, 10, 2_000);
  const mini = usage(s, MINI);
  // Mac mini's allowances: room for a few more of each, and only a few made a call.
  await withCaps({ messageBytes: mini.messageBytes + 10_000, evictPerWrite: 3, bodyBytes: mini.bodyBytes + 5_000, bodyEvictPerWrite: 2 }, async () => {
    await s.ctx.db.patch(s.rows('runnerStorage').find((u) => u.runnerId === MINI)!._id, { bytes: STORED - 1_000 });
    const { moveId } = await s.owner.start('T', MINI);
    await s.cloud.info(moveId);
    await s.mini.ready(moveId);
    await s.cloud.frozen(moveId);
    await s.cloud.pack(moveId);
    await s.mini.claim(moveId);
    await s.mini.done(moveId);
    const runs = await s.runAll();
    assert.ok(runs > 5, 'it took runs of their own to make room');
    assert.equal(moveOf(s, moveId).state, 'done');
    // Within its caps, and its counts are what its rows hold.
    const after = usage(s, MINI);
    assert.ok(after.messageBytes <= CAP.messageBytes, `messages ${after.messageBytes} within ${CAP.messageBytes}`);
    assert.ok(after.bodyBytes <= CAP.bodyBytes, `tool output ${after.bodyBytes} within ${CAP.bodyBytes}`);
    assert.equal(after.messageBytes, held(s, 'messages', MINI));
    assert.equal(after.bodyBytes, held(s, 'eventBodies', MINI));
    // Nothing of T's is still Cloud's, nor counted against it.
    assert.equal(s.rows('messages').filter((r) => r.runnerId === CLOUD).length, 0);
    assert.equal(s.rows('eventBodies').filter((r) => r.runnerId === CLOUD).length, 0);
    assert.equal(usage(s, CLOUD).messageBytes, 0);
    assert.equal(usage(s, CLOUD).bodyBytes, 0);
    // T's rows are older than anything of Mac mini's own, so they're what
    // gives way: none of O's go for them (Gemini's review).
    assert.equal(s.rows('messages').filter((r) => r.threadId === 'O').length, 30);
    assert.equal(s.rows('eventBodies').filter((r) => r.threadId === 'O').length, 10);
    // The picture: no room on Mac mini, so the backend's copy goes and nobody is charged for it.
    assert.equal(s.rows('replyImages').length, 0);
    assert.equal(s.hasFile('cloud-pic'), false);
    assert.equal(after.bytes, STORED - 1_000);
    assert.equal(s.rows('storageOwners').filter((o) => o.storageId === 'cloud-pic').length, 0);
  });
});

// Codex Security's verify-fix (24 Nov 2026): the new runner sending the
// moved thread's history again before its pages ran took each row back
// (sync.ts takenBack) with no check of its own allowance.
test("the new runner sending a moved thread's history again before its rows come over stays within its caps", async () => {
  const s = await keyed();
  await s.cloud.upsert('T', CLOUD);
  await s.cloud.append('T', 1, 30, 2_000);
  await s.cloud.bodies('T', 1, 10, 2_000);
  await s.mini.upsert('O', MINI);
  await s.mini.append('O', 1, 30, 2_000);
  await s.mini.bodies('O', 1, 10, 2_000);
  const mini = usage(s, MINI);
  await withCaps({ messageBytes: mini.messageBytes + 10_000, evictPerWrite: 3, bodyBytes: mini.bodyBytes + 5_000, bodyEvictPerWrite: 2 }, async () => {
    const { moveId } = await s.owner.start('T', MINI);
    await s.cloud.info(moveId);
    await s.mini.ready(moveId);
    await s.cloud.frozen(moveId);
    await s.cloud.pack(moveId);
    await s.mini.claim(moveId);
    const within = () => {
      const u = usage(s, MINI);
      assert.ok(u.messageBytes <= CAP.messageBytes, `messages ${u.messageBytes} within ${CAP.messageBytes}`);
      assert.ok(u.bodyBytes <= CAP.bodyBytes, `tool output ${u.bodyBytes} within ${CAP.bodyBytes}`);
      assert.equal(u.messageBytes, held(s, 'messages', MINI));
      assert.equal(u.bodyBytes, held(s, 'eventBodies', MINI));
    };
    // Mac mini's whole history of T, sent before any page has run.
    for (let i = 0; i < 3; i++) {
      await s.mini.append('T', 1, 30, 2_000);
      await s.mini.bodies('T', 1, 10, 2_000);
      within();
    }
    await s.mini.done(moveId);
    await s.runAll();
    within();
    assert.equal(moveOf(s, moveId).state, 'done');
    assert.equal(usage(s, CLOUD).messageBytes, 0);
    assert.equal(usage(s, CLOUD).bodyBytes, 0);
  });
});

test('a rehome page run again, or run late, gives and counts nothing twice', async () => {
  const s = await keyed();
  await s.cloud.upsert('T', CLOUD);
  await s.cloud.append('T', 1, 450, 300);
  await s.cloud.bodies('T', 1, 5, 300);
  await s.cloud.picture('T', 'pic', 70_000);
  const { moveId } = await s.owner.start('T', MINI);
  await s.cloud.info(moveId);
  await s.mini.ready(moveId);
  await s.cloud.frozen(moveId);
  await s.cloud.pack(moveId);
  await s.mini.claim(moveId);
  // Every page run twice over.
  const pages: Record<string, unknown>[] = [];
  const twice = async () => {
    for (let round = 0; round < 50; round++) {
      const next: Record<string, unknown>[] = [];
      for (let i = s.scheduled.length - 1; i >= 0; i--) {
        const job = s.scheduled[i] as { fn: string; args: Record<string, unknown> };
        if (job.fn.endsWith('rehomeRows')) next.unshift(...(s.scheduled.splice(i, 1) as (typeof job)[]).map((j) => j.args));
      }
      if (!next.length) return;
      for (const a of next) {
        pages.push(a);
        await s.fn(moves.rehomeRows, a);
        await s.fn(moves.rehomeRows, a);
      }
    }
  };
  await twice();
  await s.mini.done(moveId);
  for (const a of pages) await s.fn(moves.rehomeRows, a);
  const mini = usage(s, MINI);
  assert.equal(mini.messageBytes, held(s, 'messages', MINI));
  assert.equal(mini.bodyBytes, held(s, 'eventBodies', MINI));
  assert.equal(s.rows('messages').filter((r) => r.threadId === 'T').length, 450);
  assert.equal(mini.bytes, 70_000, 'the picture counted once');
  assert.equal(usage(s, CLOUD).messageBytes, 0);
});

test("a thread moved to a box and back keeps every row and file charged to the runner it's on", async () => {
  const s = await boxBackend();
  const MINI_ONLINE = { runnerId: MINI, name: 'mini', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() };
  await s.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  await s.ctx.db.insert('runners', MINI_ONLINE);
  const { boxKey } = await s.boot();
  await call(s.ctx, sync.heartbeat, { key: boxKey, runner: { runnerId: BOX_RUNNER, name: 'box', version: 'v', startedAt: new Date().toISOString(), draining: false, threadCount: 1 } });
  const m = mover(s);
  const mini = m.as(MINI_KEY);
  const box = m.as(boxKey);
  // The box's thread starts on Mac mini, with messages, tool output and a picture.
  await mini.upsert(THREAD, MINI);
  await mini.append(THREAD, 1, 20, 500);
  await mini.bodies(THREAD, 1, 4, 500);
  await mini.picture(THREAD, 'mini-pic', 80_000);
  const moveTo = async (to: string, from: ReturnType<typeof m.as>, onto: ReturnType<typeof m.as>) => {
    const { moveId } = await m.as(OWNER).start(THREAD, to);
    await from.info(moveId);
    await onto.ready(moveId);
    await from.frozen(moveId);
    await from.pack(moveId);
    await onto.claim(moveId);
    await onto.done(moveId);
    await m.runAll();
    assert.equal(moveOf(s, moveId).state, 'done');
  };
  await moveTo(BOX_RUNNER, mini, box);
  // The box's, by its own runner id, counted against it: never the owner's.
  const onBox = (table: string) => s.rows(table).filter((r) => r.threadId === THREAD).map((r) => r.runnerId);
  assert.deepEqual([...new Set(onBox('messages'))], [BOX_RUNNER]);
  assert.deepEqual([...new Set(onBox('eventBodies'))], [BOX_RUNNER]);
  assert.equal(usage(s, BOX_RUNNER).messageBytes, held(s, 'messages', BOX_RUNNER));
  assert.equal(usage(s, BOX_RUNNER).bodyBytes, held(s, 'eventBodies', BOX_RUNNER));
  assert.deepEqual(s.rows('storageOwners').filter((o) => o.storageId === 'mini-pic').map((o) => [o.runnerId, o.bytes]), [[BOX_RUNNER, 80_000]]);
  assert.equal(usage(s, MINI).messageBytes, 0);
  assert.equal(usage(s, MINI).bodyBytes, 0);
  // And back: Mac mini's again, the box's counts given back.
  await moveTo(MINI, box, mini);
  assert.deepEqual([...new Set(onBox('messages'))], [MINI]);
  assert.equal(usage(s, MINI).messageBytes, held(s, 'messages', MINI));
  assert.equal(usage(s, BOX_RUNNER).messageBytes, 0);
  assert.equal(usage(s, BOX_RUNNER).bodyBytes, 0);
  assert.deepEqual(s.rows('storageOwners').filter((o) => o.storageId === 'mini-pic').map((o) => o.runnerId), [MINI]);
});

// Codex's review (24 Nov 2026): a file that went to the owner lost its
// record, and a move on to a runner key gave it one charging nothing.
test("a picture moved to the main Mac and on to a runner key is charged to it", async () => {
  const s = await keyed();
  await s.cloud.upsert('T', CLOUD);
  await s.cloud.append('T', 1, 2, 100);
  await s.cloud.picture('T', 'pic', 100_000);
  await s.move('T', LAPTOP, s.cloud, s.owner);
  assert.equal(s.rows('storageOwners').filter((o) => o.storageId === 'pic').length, 0, "the owner's files have no record");
  assert.equal(usage(s, CLOUD).bytes, 0);
  const before = usage(s, MINI).bytes;
  await s.move('T', MINI, s.owner, s.mini);
  const rec = s.rows('storageOwners').filter((o) => o.storageId === 'pic');
  assert.equal(rec.length, 1);
  assert.equal(rec[0]!.runnerId, MINI);
  assert.ok(rec[0]!.bytes >= 64 * 1024, `charged ${rec[0]!.bytes}`);
  assert.equal(usage(s, MINI).bytes - before, rec[0]!.bytes);
});

// Codex's review: 200 tool outputs of up to 512 KB in one page were more than
// a mutation may read, so the page failed every time and the move stayed claimed.
test("a moved thread's biggest tool outputs go over in pages a mutation can read", async () => {
  const s = await keyed();
  await s.cloud.upsert('T', CLOUD);
  for (let i = 0; i < 40; i += 10) await s.cloud.bodies('T', i + 1, 10, 450_000);
  const moveId = await s.move('T', MINI, s.cloud, s.mini, false);
  for (let round = 0; round < 50; round++) {
    const next: Record<string, unknown>[] = [];
    for (let i = s.scheduled.length - 1; i >= 0; i--) {
      const job = s.scheduled[i] as { fn: string; args: Record<string, unknown> };
      if (job.fn.endsWith('rehomeRows')) next.unshift(...(s.scheduled.splice(i, 1) as (typeof job)[]).map((j) => j.args));
    }
    if (!next.length) break;
    for (const a of next) {
      s.resetReads();
      await s.fn(moves.rehomeRows, a);
      assert.ok(s.bytesRead() < 12 * 1024 * 1024, `a page read ${s.bytesRead()} bytes`);
    }
  }
  assert.equal(moveOf(s, moveId).state, 'done');
  assert.equal(s.rows('eventBodies').filter((r) => r.runnerId === MINI).length, 40);
  assert.equal(usage(s, MINI).bodyBytes, held(s, 'eventBodies', MINI));
});

// Codex's review: two full runners moving their oldest threads to each other
// each waited for room the other held, for good.
test('two full runners moving threads to each other both finish, within their caps', async () => {
  const s = await keyed();
  await s.cloud.upsert('Y', CLOUD);
  await s.cloud.append('Y', 1, 20, 2_000);
  await s.mini.upsert('X', MINI);
  await s.mini.append('X', 1, 20, 2_000);
  await s.cloud.upsert('C', CLOUD);
  await s.cloud.append('C', 1, 20, 2_000);
  await s.mini.upsert('O', MINI);
  await s.mini.append('O', 1, 20, 2_000);
  const full = Math.max(usage(s, CLOUD).messageBytes, usage(s, MINI).messageBytes);
  await withCaps({ messageBytes: full, evictPerWrite: 3 }, async () => {
    const x = await s.move('X', CLOUD, s.mini, s.cloud, false);
    const y = await s.move('Y', MINI, s.cloud, s.mini, false);
    for (let i = 0; i < 20 && !(moveOf(s, x).state === 'done' && moveOf(s, y).state === 'done'); i++) {
      await s.runAll();
      // What stopped for want of room starts again with the sweep.
      await afterMinutes(11 * (i + 1), () => s.fn(moves.expireMoves, {}));
    }
    assert.equal(moveOf(s, x).state, 'done');
    assert.equal(moveOf(s, y).state, 'done');
    for (const r of [CLOUD, MINI]) {
      assert.ok(usage(s, r).messageBytes <= CAP.messageBytes);
      assert.equal(usage(s, r).messageBytes, held(s, 'messages', r));
    }
    // Each thread's rows are its runner's now.
    for (const [t, r] of [['X', CLOUD], ['Y', MINI]] as const) assert.deepEqual([...new Set(s.rows('messages').filter((m) => m.threadId === t).map((m) => m.runnerId))], [r]);
  });
});

// Codex's review: rows of the thread nobody was charged for (the owner key's,
// or left so by an older move) stayed uncounted once it moved to a runner key.
test("a moved thread's rows nobody was charged for are its new runner's", async () => {
  const s = await keyed();
  await s.cloud.upsert('T', CLOUD);
  await s.cloud.append('T', 1, 5, 500);
  for (let seq = 100; seq < 105; seq++) await s.ctx.db.insert('messages', { threadId: 'T', seq, role: 'assistant', text: `old ${seq}`, at: 'now' });
  await s.ctx.db.insert('eventBodies', { threadId: 'T', seq: 100, text: 'old output', at: 1 });
  await s.move('T', MINI, s.cloud, s.mini);
  assert.deepEqual([...new Set(s.rows('messages').filter((m) => m.threadId === 'T').map((m) => m.runnerId))], [MINI]);
  assert.deepEqual([...new Set(s.rows('eventBodies').filter((m) => m.threadId === 'T').map((m) => m.runnerId))], [MINI]);
  assert.equal(usage(s, MINI).messageBytes, held(s, 'messages', MINI));
  assert.equal(usage(s, MINI).bodyBytes, held(s, 'eventBodies', MINI));
});

// Gemini's review: a moved row older than all of T's, taken as "this call's
// own" by T's room-making, sent it reading every row T has (48 MB of them
// at its cap, past what a mutation may read). Now the row that would go
// first goes, and a page reads only what it moves.
test("moving older rows into a full runner reads only the page, not everything the runner has", async () => {
  const s = await keyed();
  await s.cloud.upsert('T', CLOUD);
  await s.cloud.append('T', 1, 50, 500);
  await s.mini.upsert('O', MINI);
  for (let i = 0; i < 3_000; i += 500) await s.mini.append('O', i + 1, 500, 200);
  await withCaps({ messageBytes: usage(s, MINI).messageBytes }, async () => {
    const moveId = await s.move('T', MINI, s.cloud, s.mini, false);
    for (let round = 0; round < 50; round++) {
      const next: Record<string, unknown>[] = [];
      for (let i = s.scheduled.length - 1; i >= 0; i--) {
        const job = s.scheduled[i] as { fn: string; args: Record<string, unknown> };
        if (job.fn.endsWith('rehomeRows')) next.unshift(...(s.scheduled.splice(i, 1) as (typeof job)[]).map((j) => j.args));
      }
      if (!next.length) break;
      for (const a of next) {
        s.resetReads();
        await s.fn(moves.rehomeRows, a);
        assert.ok(s.reads() < 1_000, `a page read ${s.reads()} rows`);
      }
    }
    assert.equal(moveOf(s, moveId).state, 'done');
    assert.equal(s.rows('messages').filter((r) => r.threadId === 'O').length, 3_000, "none of Mac mini's own gave way");
    assert.equal(usage(s, MINI).messageBytes, held(s, 'messages', MINI));
    assert.equal(usage(s, CLOUD).messageBytes, 0);
  });
});

// Round two (Codex, Gemini): the age check looked only at T's oldest row
// once, so a mid-aged row made room past it, through T's newer rows too.
test("a moved row makes room only among the new runner's older rows", async () => {
  const s = await keyed();
  await s.mini.upsert('O', MINI);
  await s.mini.append('O', 1, 1, 300); // Mac mini's one old, small row
  await s.cloud.upsert('T', CLOUD);
  await s.cloud.append('T', 1, 1, 5_000); // the moved row, in between
  await s.mini.append('O', 2, 10, 2_000); // Mac mini's newer history
  await withCaps({ messageBytes: usage(s, MINI).messageBytes }, async () => {
    await s.move('T', MINI, s.cloud, s.mini);
    // The old small row gave way, but no newer one did: the moved row, older than them, went instead.
    assert.deepEqual(s.rows('messages').filter((r) => r.threadId === 'O').map((r) => r.seq).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(s.rows('messages').filter((r) => r.threadId === 'T').length, 0);
    assert.ok(usage(s, MINI).messageBytes <= CAP.messageBytes);
    assert.equal(usage(s, MINI).messageBytes, held(s, 'messages', MINI));
    assert.equal(usage(s, CLOUD).messageBytes, 0);
  });
});

// Gemini, round two: a record of 0 bytes (an older move's) stayed free.
test("a picture's record of 0 bytes is charged at its size when it moves on", async () => {
  const s = await keyed();
  await s.cloud.upsert('T', CLOUD);
  await s.cloud.append('T', 1, 1, 100);
  await s.cloud.picture('T', 'pic', 100_000);
  const rec = s.rows('storageOwners').find((o) => o.storageId === 'pic')!;
  await s.ctx.db.patch(rec._id, { bytes: 0 });
  await s.move('T', MINI, s.cloud, s.mini);
  assert.ok(s.rows('storageOwners').find((o) => o.storageId === 'pic')!.bytes >= 64 * 1024);
});

// Codex, round four: three full runners moving threads round in a ring each
// waited on the next for good.
test('three full runners moving threads round in a ring all finish, within their caps', async () => {
  const s = await keyed();
  const THIRD = 'c0ffee000003';
  const THIRD_KEY = 'tbr_third';
  await s.ctx.db.insert('runnerKeys', { runnerId: THIRD, keyHash: await sha256(THIRD_KEY), name: 'third', createdAt: 1 });
  await s.ctx.db.insert('runners', { runnerId: THIRD, name: 'third', version: '1', lastSeenAt: Date.now(), startedAt: new Date().toISOString(), draining: false, threadCount: 0 });
  const third = s.as(THIRD_KEY);
  const ring = [
    ['A', CLOUD, s.cloud],
    ['B', MINI, s.mini],
    ['C', THIRD, third],
  ] as const;
  // Each one's outgoing thread first (its oldest rows), then one it keeps.
  for (const [t, r, k] of ring) {
    await k.upsert(t, r);
    await k.append(t, 1, 15, 2_000);
  }
  for (const [t, r, k] of ring) {
    await k.upsert(`${t}-kept`, r);
    await k.append(`${t}-kept`, 1, 15, 2_000);
  }
  const full = Math.max(...ring.map(([, r]) => usage(s, r).messageBytes));
  await withCaps({ messageBytes: full, evictPerWrite: 3 }, async () => {
    const ids = [await s.move('A', MINI, s.cloud, s.mini, false), await s.move('B', THIRD, s.mini, third, false), await s.move('C', CLOUD, third, s.cloud, false)];
    for (let i = 0; i < 30 && !ids.every((id) => moveOf(s, id).state === 'done'); i++) {
      await s.runAll();
      await afterMinutes(11 * (i + 1), () => s.fn(moves.expireMoves, {}));
    }
    for (const id of ids) assert.equal(moveOf(s, id).state, 'done');
    for (const [, r] of ring) {
      assert.ok(usage(s, r).messageBytes <= CAP.messageBytes);
      assert.equal(usage(s, r).messageBytes, held(s, 'messages', r));
    }
  });
});
