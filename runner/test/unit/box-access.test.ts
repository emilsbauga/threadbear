// A box key against the backend (docs/virtual-runners.md, decision 4;
// docs/protocol.md, "Box keys"): a box runs its one thread as its own
// runner, and every other row, thread, runner and function is refused.
// The plain rules are in runner-access.test.ts; this plays them through
// the real functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, claimAndFinish, load, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';
import { BOX_RUNNER, boxBackend, OWNER, THREAD } from '../helpers/box-backend.ts';

const sync = load('sync');
const relay = load('relay');
const moves = load('moves');
const boxes = load('boxes');
const machinesModule = load('machines');
const { ACCESS, BOX_CALLS } = load('runnerAccess') as { ACCESS: Record<string, string>; BOX_CALLS: Set<string> };
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };

const MINI_KEY = 'tbr_mac-mini';
const MINI = 'cb921b2447ea';
const AT = new Date().toISOString();

async function setup() {
  const s = await boxBackend();
  await s.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  await s.ctx.db.insert('runners', { runnerId: MINI, name: 'mini', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  await call(s.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ ...THREAD_BASICS, threadId: 'B', runnerId: MINI, title: 'mini thread', view: 'inbox', needsYou: false }] });
  const { boxKey } = await s.boot();
  const beat = (runnerId = BOX_RUNNER) => call(s.ctx, sync.heartbeat, { key: boxKey, runner: { runnerId, name: 'box', version: 'v', startedAt: AT, draining: false, threadCount: 1 } });
  await beat();
  const thread = (threadId: string, runnerId = BOX_RUNNER) => ({ ...THREAD_BASICS, threadId, runnerId, title: 't', view: 'inbox' as const, needsYou: false });
  const write = (threadId: string, runnerId = BOX_RUNNER) => call(s.ctx, sync.upsertThreads, { key: boxKey, threads: [thread(threadId, runnerId)] });
  return { ...s, boxKey, beat, write };
}

test('a box writes its own thread, and never another one or as another runner', async () => {
  const s = await setup();
  assert.equal(await outcome(s.write(THREAD)), 'ok');
  assert.equal(s.rows('threads').find((t) => t.threadId === THREAD)!.runnerId, BOX_RUNNER);
  // A new thread under its own runner id: no.
  assert.equal(await outcome(s.write('another-new-thread')), 'forbidden');
  // Another runner's thread, under either runner id.
  assert.equal(await outcome(s.write('B')), 'forbidden');
  assert.equal(await outcome(s.write('B', MINI)), 'forbidden');
  assert.equal(await outcome(s.write(THREAD, MINI)), 'forbidden');
  assert.equal(s.rows('threads').find((t) => t.threadId === 'B')!.runnerId, MINI);
  // Heartbeat as another runner.
  assert.equal(await outcome(s.beat(MINI)), 'forbidden');
});

test("a box's messages, tool output and pictures go to its own thread only", async () => {
  const s = await setup();
  await s.write(THREAD);
  const msg = (threadId: string, seq: number) => ({ threadId, seq, role: 'assistant' as const, text: 'hi', at: AT });
  await call(s.ctx, sync.appendMessages, { key: s.boxKey, messages: [msg(THREAD, 1), msg('B', 1), msg('nobody', 1)] });
  assert.deepEqual(s.rows('messages').map((m) => m.threadId), [THREAD]);
  assert.deepEqual(await call(s.ctx, sync.replyImages, { key: s.boxKey, threadId: 'B' }), []);
  await call(s.ctx, sync.removeThreads, { key: s.boxKey, threadIds: ['B'] });
  assert.ok(s.rows('threads').some((t) => t.threadId === 'B'), "another runner's thread isn't removed");
  // Its sidebar rows: its own thread's only.
  const index = (threadId: string) => ({ threadId, title: 't', cwd: '/x', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: '', createdAt: AT, lastActivityAt: AT });
  await call(s.ctx, sync.setThreadIndex, { key: s.boxKey, runnerId: BOX_RUNNER, rows: [index(THREAD), index('B'), index('fresh-id')], removed: [] });
  assert.deepEqual(s.rows('threadIndex').filter((r) => r.runnerId === BOX_RUNNER).map((r) => r.threadId), [THREAD]);
});

test("a box hears and takes its own thread's commands, never another thread's or runner's", async () => {
  const s = await setup();
  await s.write(THREAD);
  const mine = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: BOX_RUNNER, threadId: THREAD, kind: 'send', args: { text: 'hello' } });
  // A create for no thread, as one queued before boxes:startThread named its thread. The
  // main Mac can't ask a box for a new thread any more (relay.ts), but a call it can.
  assert.equal(await outcome(call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: BOX_RUNNER, kind: 'create', args: { text: 'go', cwd: '/w' } })), 'badArgs');
  const create = await machinesModule.queued(s.ctx, { runnerId: BOX_RUNNER, kind: 'create', args: { text: 'go', cwd: '/w' }, createdAt: Date.now() });
  // Only the owner or the phone queue for a box's runner; one naming another thread is hidden and refused.
  const other = await machinesModule.queued(s.ctx, { runnerId: BOX_RUNNER, threadId: 'B', kind: 'send', args: { text: 'x' }, createdAt: Date.now() });
  const minis = await call(s.ctx, relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'B', kind: 'send', args: { text: 'y' } });
  const pending = await call(s.ctx, sync.pendingCommands, { key: s.boxKey, runnerId: BOX_RUNNER });
  assert.deepEqual(pending.map((c: { commandId: string }) => c.commandId).sort(), [mine, create].sort());
  assert.equal(await outcome(call(s.ctx, sync.pendingCommands, { key: s.boxKey, runnerId: MINI })), 'forbidden');
  assert.equal(await call(s.ctx, sync.takeCommand, { key: s.boxKey, commandId: mine }), true);
  await call(s.ctx, sync.finishCommand, { key: s.boxKey, commandId: mine, ok: true });
  assert.equal(await outcome(call(s.ctx, sync.takeCommand, { key: s.boxKey, commandId: other })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, sync.takeCommand, { key: s.boxKey, commandId: minis })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, sync.finishCommand, { key: s.boxKey, commandId: minis, ok: true })), 'forbidden');
});

test('every function a box key has no business with is refused, owner-only ones and all', async () => {
  const s = await setup();
  const modules = [sync, relay, moves, boxes, load('intakeConsumer'), load('intakeFiles')];
  const refused: string[] = [];
  for (const fn of Object.keys(ACCESS).filter((f) => !BOX_CALLS.has(f))) {
    const mod = modules.find((m) => m[fn]);
    assert.ok(mod, `found ${fn}`);
    // Actions ask the gate through a query; the rest at their first line.
    const ctx = fn === 'setCloudToken' || fn === 'mintBootToken' || fn === 'startThread' ? s.a : s.ctx;
    const err = await mod[fn].handler(ctx, { key: s.boxKey }).then(
      () => null,
      (e: { data?: { kind?: string; message?: string } }) => e,
    );
    assert.equal(err?.data?.kind, 'forbidden', fn);
    assert.match(err.data.message, /a box's key runs its one thread/, fn);
    refused.push(fn);
  }
  for (const fn of ['issueToken', 'addRunnerKey', 'runnersList', 'queueCommand', 'startMove', 'saveSchedule', 'savePocketCard', 'setAccounts', 'sharedUsage', 'pools', 'memorySince', 'setPresence', 'prune', 'setCloudToken', 'mintBootToken', 'archiveBox', 'startThread', 'setRunnerService', 'runnerServices']) assert.ok(refused.includes(fn), fn);
});

test("a box's moves are its own thread's only", async () => {
  const s = await setup();
  await s.write(THREAD);
  // The main Mac can't move the mini's thread to the box's runner: it's another thread's box.
  assert.equal(await outcome(call(s.ctx, moves.startMove, { key: OWNER, threadId: 'B', to: BOX_RUNNER })), 'conflict');
  // One made before that check: not the box's thread, so not its move.
  const theirs = 'move-of-thread-b';
  await machinesModule.move.create(s.ctx, { moveId: theirs, threadId: 'B', from: MINI, to: BOX_RUNNER, state: 'asking', createdAt: Date.now(), updatedAt: Date.now() }, { type: 'START' });
  assert.deepEqual(await call(s.ctx, moves.moves, { key: s.boxKey, runnerId: BOX_RUNNER }), []);
  assert.equal(await outcome(call(s.ctx, moves.moveReady, { key: s.boxKey, moveId: theirs, plan: {}, sealKey: `${'A'.repeat(43)}=` })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, moves.moveFailed, { key: s.boxKey, moveId: theirs, note: 'no' })), 'forbidden');
  await call(s.ctx, moves.cancelMove, { key: OWNER, moveId: theirs });
  // Its own thread moving off the box is its to take part in.
  const { moveId: mine } = await call(s.ctx, moves.startMove, { key: OWNER, threadId: THREAD, to: MINI });
  assert.deepEqual((await call(s.ctx, moves.moves, { key: s.boxKey, runnerId: BOX_RUNNER })).map((m: { moveId: string }) => m.moveId), [mine]);
  assert.equal(await outcome(call(s.ctx, moves.moveInfo, { key: s.boxKey, moveId: mine, info: { title: 't' } })), 'ok');
});

test('a box asks for a new thread from its own thread only', async () => {
  const s = await setup();
  await s.write(THREAD);
  const ask = (threadId: string, requestId: string) => call(s.ctx, relay.fileRequest, { key: s.boxKey, requestId, threadId, target: 'mini', request: { text: 'please' } });
  assert.equal(await outcome(ask(THREAD, 'req-own-1')), 'ok');
  assert.equal(await outcome(ask('B', 'req-their-1')), 'forbidden');
});

test('an archived box key, or one that never was, is refused everywhere', async () => {
  const s = await setup();
  // Archived: it's asked to save first; the save in, its box goes.
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: THREAD });
  assert.equal(s.state(), 'archiving');
  const url: string = await call(s.ctx, sync.iconUploadUrl, { key: s.boxKey });
  assert.equal(await claimAndFinish(s.ctx, sync.claimUpload, sync.finishUpload, { ticket: new URL(url).searchParams.get('ticket'), storageId: s.file('save1'), bytes: 100 }), true);
  await call(s.ctx, boxes.boxSaved, { key: s.boxKey, storageId: 'save1', bytes: 100 });
  assert.equal(s.state(), 'destroying');
  assert.equal(await outcome(s.beat()), 'auth');
  assert.equal(await outcome(call(s.ctx, sync.pendingCommands, { key: s.boxKey, runnerId: BOX_RUNNER })), 'auth');
  assert.equal(await outcome(call(s.ctx, sync.heartbeat, { key: `tbb_${'0'.repeat(64)}`, runner: { runnerId: BOX_RUNNER, name: 'b', version: 'v', startedAt: AT, draining: false, threadCount: 1 } })), 'auth');
});

// Codex's review of the first slice (18 Nov 2026): a box key read and
// buried rows of another thread that sat under its runner id (the owner key
// may write one there). Every list and write by runner id is held to the
// box's own thread.
test("a box neither sees nor touches another thread's rows under its own runner id", async () => {
  const s = await setup();
  await s.write(THREAD);
  const U = 'owner-thread-u';
  // The owner key puts thread U under the box's runner id, shared, with a message, a sidebar row, a request and old messages and tool output.
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [{ ...THREAD_BASICS, threadId: U, runnerId: BOX_RUNNER, title: 'u', view: 'inbox', needsYou: false, share: { access: 'link', slug: 'slugslugslugslug' } }] });
  await call(s.ctx, sync.appendMessages, { key: OWNER, messages: [{ threadId: U, seq: 1, role: 'assistant', text: 'private', at: AT }] });
  const index = (threadId: string) => ({ threadId, title: 't', cwd: '/x', accountId: 'a', provider: 'claude', status: 'idle', needsYou: false, unread: false, preview: '', createdAt: AT, lastActivityAt: AT });
  await call(s.ctx, sync.setThreadIndex, { key: OWNER, runnerId: BOX_RUNNER, rows: [index(U)], removed: [] });
  await machinesModule.request.create(s.ctx, { requestId: 'req-of-thread-u', runnerId: BOX_RUNNER, threadId: U, target: 'mini', text: 'x', createdAt: Date.now(), state: 'pending' }, { type: 'FILE' });
  await s.ctx.db.insert('messages', { threadId: U, seq: 0, role: 'assistant', text: 'old', at: AT, runnerId: BOX_RUNNER });
  await s.ctx.db.insert('eventBodies', { threadId: U, seq: 0, runnerId: BOX_RUNNER, at: 1, text: 'old output' });

  // Reads: none of U.
  const listed = await call(s.ctx, sync.threadsOf, { key: s.boxKey, runnerId: BOX_RUNNER });
  assert.deepEqual(listed.map((t: { threadId: string }) => t.threadId), [THREAD]);
  assert.deepEqual(await call(s.ctx, sync.sharedThreads, { key: s.boxKey, runnerId: BOX_RUNNER }), []);
  assert.ok(!(await call(s.ctx, sync.messageHeads, { key: s.boxKey, runnerId: BOX_RUNNER })).some((h: { threadId: string }) => h.threadId === U));
  assert.equal(await call(s.ctx, relay.runnerRequest, { key: s.boxKey, requestId: 'req-of-thread-u' }), null);
  assert.equal(await outcome(call(s.ctx, relay.closeRequest, { key: s.boxKey, requestId: 'req-of-thread-u' })), 'notFound');

  // Writes: U's sidebar row isn't buried, by name, by being left out of keep, or by writing it.
  await call(s.ctx, sync.setThreadIndex, { key: s.boxKey, runnerId: BOX_RUNNER, rows: [index(U)], removed: [U], keep: [] });
  const uRow = s.rows('threadIndex').find((r) => r.threadId === U && r.runnerId === BOX_RUNNER)!;
  assert.equal(uRow.deleted, undefined, "U's sidebar row stands");
  // A create it finishes can't name U as the thread it made.
  const create = await machinesModule.queued(s.ctx, { runnerId: BOX_RUNNER, kind: 'create', args: { text: 'go', cwd: '/w' }, createdAt: Date.now() });
  await call(s.ctx, sync.takeCommand, { key: s.boxKey, commandId: create });
  await call(s.ctx, sync.finishCommand, { key: s.boxKey, commandId: create, ok: true, resultThreadId: U });
  assert.equal(s.rows('commands').find((c) => c._id === create)!.resultThreadId, undefined);

  // Over its caps, it makes room among its own thread's rows only: U's old message and output stay, and its own wait.
  const usage = s.rows('runnerStorage').find((r) => r.runnerId === BOX_RUNNER);
  if (usage) Object.assign(usage, { messageBytes: 1e12, bodyBytes: 1e12 });
  else await s.ctx.db.insert('runnerStorage', { runnerId: BOX_RUNNER, bytes: 0, messageBytes: 1e12, bodyBytes: 1e12 });
  const m = await call(s.ctx, sync.appendMessages, { key: s.boxKey, messages: [{ threadId: THREAD, seq: 5, role: 'assistant', text: 'mine', at: AT }] });
  assert.deepEqual(m.skipped, [`${THREAD}:5`]);
  const b = await call(s.ctx, sync.appendBodies, { key: s.boxKey, bodies: [{ threadId: THREAD, seq: 5, text: 'out' }] });
  assert.deepEqual(b.skipped, [`${THREAD}:5`]);
  assert.ok(s.rows('messages').some((x) => x.threadId === U && x.seq === 0));
  assert.ok(s.rows('eventBodies').some((x) => x.threadId === U && x.seq === 0));
});

// Codex's second review (18 Nov 2026): removing its own thread brought
// another thread under its runner id back into the inbox; and a box key
// put in a message's `turn` was stored whole, for share:view to show.
test("removing a box's thread leaves other threads under its runner id as they were", async () => {
  const s = await setup();
  await s.write(THREAD);
  const U = 'owner-thread-u';
  await s.ctx.db.insert('threads', { ...THREAD_BASICS, threadId: U, runnerId: BOX_RUNNER, title: 'u', view: 'overflow', wantView: 'inbox', needsYou: false, updatedMs: 1 });
  await call(s.ctx, sync.removeThreads, { key: s.boxKey, threadIds: [THREAD] });
  assert.ok(!s.rows('threads').some((t) => t.threadId === THREAD));
  const u = s.rows('threads').find((t) => t.threadId === U)!;
  assert.deepEqual({ view: u.view, wantView: u.wantView, updatedMs: u.updatedMs }, { view: 'overflow', wantView: 'inbox', updatedMs: 1 });
});

test("a credential in a box's message turn isn't stored", async () => {
  const s = await setup();
  await s.write(THREAD);
  await call(s.ctx, sync.appendMessages, { key: s.boxKey, messages: [{ threadId: THREAD, seq: 1, role: 'assistant', text: 'hi', turn: s.boxKey, at: AT }] });
  assert.ok(!JSON.stringify(s.rows('messages')).includes(s.boxKey.slice(4, 30)));
});

// Codex's third review (18 Nov 2026): a box could put another thread's
// retired share link (one that thread had under the same runner id) on its
// own thread, showing it to that link's holders.
test("a box can't take another thread's retired share link under its runner id", async () => {
  const s = await setup();
  const U = 'owner-thread-u';
  const L = 'retiredLinkOfThreadU';
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [{ ...THREAD_BASICS, threadId: U, runnerId: BOX_RUNNER, title: 'u', view: 'inbox', needsYou: false, share: { access: 'link', slug: L } }] });
  await call(s.ctx, sync.removeThreads, { key: OWNER, threadIds: [U] });
  assert.ok(s.rows('threadTombstones').some((t) => t.slug === L));
  const shared = { ...THREAD_BASICS, threadId: THREAD, runnerId: BOX_RUNNER, title: 't', view: 'inbox' as const, needsYou: false, share: { access: 'link' as const, slug: L } };
  assert.equal(await outcome(call(s.ctx, sync.upsertThreads, { key: s.boxKey, threads: [shared] })), 'forbidden');
  // A link of its own is fine, and so is keeping it.
  const own = { ...shared, share: { access: 'link' as const, slug: 'aBoxsOwnLink1234567890' } };
  assert.equal(await outcome(call(s.ctx, sync.upsertThreads, { key: s.boxKey, threads: [own] })), 'ok');
  assert.equal(await outcome(call(s.ctx, sync.upsertThreads, { key: s.boxKey, threads: [{ ...own, share: { access: 'off' as const, slug: 'aBoxsOwnLink1234567890' } }] })), 'ok');
});

// Codex's third review: a message's turn and time are a box's to fill, and
// share:view hands them to anyone with the link, so they must be what a
// runner sends: a short turn id and an ISO time.
test("a box's message turn and time are held to their real shapes", async () => {
  const s = await setup();
  await s.write(THREAD);
  const key = JSON.stringify({ threadKey: 'q8Zr3vT1yLmN0pXc5bWd7eFa9gH=' });
  await call(s.ctx, sync.appendMessages, { key: s.boxKey, messages: [{ threadId: THREAD, seq: 1, role: 'assistant', text: 'hi', turn: key, at: key }, { threadId: THREAD, seq: 2, role: 'assistant', text: 'ok', turn: 'ae376077', at: AT }] });
  const [one, two] = s.rows('messages').sort((a, b) => a.seq - b.seq);
  assert.ok(!JSON.stringify(s.rows('messages')).includes('q8Zr3vT1'));
  assert.equal(one!.turn, undefined);
  assert.ok(!Number.isNaN(Date.parse(one!.at)));
  assert.equal(two!.turn, 'ae376077');
  assert.equal(two!.at, AT);
});
