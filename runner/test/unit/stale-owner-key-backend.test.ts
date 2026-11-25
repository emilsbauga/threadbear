// An old copy of the main key left on a Mac that now has a runner key of its
// own can't go on writing as that runner through the calls that name only a
// thread, a command, a schedule or a request (Daybreak finding 178, 24 Nov
// 2026): lib.ts actAs refused it the runner, but ownThread said yes to the
// main key for any thread, removeThreads without runnerId never asked, and
// takeCommand and finishCommand took any command. Against the in-memory
// database (test/helpers/convex-memory.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, claimAndFinish, load, memoryBackend, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const LAPTOP = 'laptop000001'; // the main Mac, on the main key
const MINI = 'cb921b2447ea'; // a Mac with a runner key of its own
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const { sha256, MAX_SEQ } = load('lib') as { sha256: (s: string) => Promise<string>; MAX_SEQ: number };
const sync = load('sync');
const relay = load('relay');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  for (const [runnerId, name] of [
    [LAPTOP, 'Laptop'],
    [MINI, 'mac-mini'],
  ] as const) {
    await b.ctx.db.insert('runners', { runnerId, name, version: '1', lastSeenAt: Date.now(), startedAt: 'x', draining: false, threadCount: 0 });
  }
  const fn = (f: unknown, args: Record<string, unknown>) => call(b.ctx, f as never, args);
  const as = (key: string) => ({
    upsert: (threadId: string, runnerId: string) => fn(sync.upsertThreads, { key, threads: [{ threadId, runnerId, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] }),
    append: (threadId: string, text: string, seq = 1) => fn(sync.appendMessages, { key, messages: [{ threadId, seq, role: 'assistant', text, at: 'now' }] }),
    body: (threadId: string, text: string, seq = 1) => fn(sync.appendBodies, { key, bodies: [{ threadId, seq, text }] }),
    reply: (threadId: string, storageId: string) => fn(sync.addReplyImage, { key, threadId, seq: 1, path: 'a.png', storageId, mediaType: 'image/png' }),
    share: (threadId: string, storageId: string) => fn(sync.addShareImage, { key, threadId, seq: 1, path: 'b.png', storageId, mediaType: 'image/png' }),
    remove: (threadIds: string[], runnerId?: string) => fn(sync.removeThreads, { key, threadIds, ...(runnerId ? { runnerId } : {}) }),
  });
  const upload = async (key: string, id: string) => {
    const ticket = new URL(await fn(sync.iconUploadUrl, { key })).searchParams.get('ticket');
    if (ticket) assert.equal(await claimAndFinish(b.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: b.file(id), bytes: 1 }), true);
    else b.file(id);
    return id;
  };
  return { ...b, fn, upload, owner: as(OWNER), mini: as(MINI_KEY) };
}
type S = Awaited<ReturnType<typeof setup>>;

const textsOf = (s: S, threadId: string) => s.rows('messages').filter((m) => m.threadId === threadId).map((m) => m.text);

test("the main key can't write a keyed runner's thread's messages, tool output or pictures, nor a head past its history", async () => {
  const s = await setup();
  await s.mini.upsert('M', MINI);
  await s.mini.append('M', 'real 1', 1);
  await s.mini.append('M', 'real 2', 2);
  await s.mini.body('M', 'real output', 2);
  // Replacing a message, adding one, and the largest seq there is, which the
  // runner's next start would take as the mirror's head.
  await s.owner.append('M', 'FORGED', 1);
  await s.owner.append('M', 'FORGED', 3);
  await s.owner.append('M', 'FORGED HEAD', MAX_SEQ);
  await s.owner.body('M', 'FORGED OUTPUT', 2);
  await s.owner.body('M', 'FORGED OUTPUT', 5);
  assert.deepEqual(textsOf(s, 'M'), ['real 1', 'real 2']);
  assert.deepEqual(s.rows('eventBodies').map((b) => b.text), ['real output']);
  assert.deepEqual(await s.fn(sync.messageHeads, { key: MINI_KEY, runnerId: MINI }), [{ threadId: 'M', lastSeq: 2 }]);
  // Pictures: what it uploads for the thread isn't kept, and its reads are empty.
  const reply = await s.upload(OWNER, 'owner-reply');
  const share = await s.upload(OWNER, 'owner-share');
  await s.owner.reply('M', reply);
  await s.owner.share('M', share);
  assert.equal(s.rows('replyImages').length, 0);
  assert.equal(s.rows('shareImages').length, 0);
  assert.equal(s.hasFile(reply), false);
  assert.equal(s.hasFile(share), false);
  assert.deepEqual(await s.fn(sync.replyImages, { key: OWNER, threadId: 'M' }), []);
  // Mac mini's own share pictures stay, whatever the main key asks to drop.
  await s.mini.share('M', await s.upload(MINI_KEY, 'mini-share'));
  assert.equal(await s.fn(sync.dropShareImages, { key: OWNER, threadId: 'M' }), 0);
  assert.equal(s.rows('shareImages').length, 1);
});

test("the main key can't wait under a keyed runner's thread id that has no row for it to come back", async () => {
  const s = await setup();
  await s.mini.upsert('GONE', MINI);
  await s.mini.remove(['GONE'], MINI);
  await s.owner.append('GONE', 'FORGED HEAD', MAX_SEQ);
  assert.deepEqual(textsOf(s, 'GONE'), []);
});

test("removeThreads, either form, leaves a keyed runner's thread to it under the main key", async () => {
  const s = await setup();
  await s.mini.upsert('M', MINI);
  await s.mini.append('M', 'real');
  // The form older runners send, with no runnerId, never asked actAs.
  await s.owner.remove(['M']);
  await s.owner.remove(['M'], LAPTOP);
  assert.equal(await outcome(s.owner.remove(['M'], MINI)), 'forbidden');
  assert.equal(s.rows('threads').filter((t) => t.threadId === 'M').length, 1);
  assert.deepEqual(textsOf(s, 'M'), ['real']);
  // Mac mini removes its own.
  await s.mini.remove(['M'], MINI);
  assert.equal(s.rows('threads').filter((t) => t.threadId === 'M').length, 0);
});

test("the main key can't take or finish a keyed runner's commands", async () => {
  const s = await setup();
  await s.mini.upsert('M', MINI);
  const queued = await s.fn(relay.queueCommand, { key: OWNER, runnerId: MINI, threadId: 'M', kind: 'send', args: { text: 'hi' } });
  const commandId = queued.commandId ?? queued;
  assert.equal(await outcome(s.fn(sync.takeCommand, { key: OWNER, commandId })), 'forbidden');
  assert.equal(await outcome(s.fn(sync.takeCommand, { key: OWNER, commandId, attempt: 'attempt-0001' })), 'forbidden');
  // Mac mini takes it; the main key can't finish it for it, nor take it again.
  assert.equal(await s.fn(sync.takeCommand, { key: MINI_KEY, commandId, attempt: 'attempt-0002' }), true);
  assert.equal(await outcome(s.fn(sync.takeCommand, { key: OWNER, commandId, attempt: 'attempt-0002' })), 'forbidden');
  assert.equal(await outcome(s.fn(sync.finishCommand, { key: OWNER, commandId, ok: false, note: 'FORGED' })), 'forbidden');
  assert.equal((await s.ctx.db.get(commandId))!.state, 'taken');
  await s.fn(sync.finishCommand, { key: MINI_KEY, commandId, ok: true });
  assert.equal((await s.ctx.db.get(commandId))!.state, 'done');
});

test("the main key can't record or let go of a keyed runner's schedule runs, and can still put one on it", async () => {
  const s = await setup();
  const id = UUID(1);
  const at = '2026-11-25T00:00:00.000Z';
  await s.fn(sync.saveSchedule, { key: OWNER, schedule: { id, runnerId: MINI, title: 't', text: 't', whenText: 'w', paused: false, createdAt: 'c', updatedAt: 'u', runs: 0, nextRunAt: at } });
  assert.equal(await s.fn(sync.claimSchedule, { key: MINI_KEY, runnerId: MINI, scheduleId: id, holder: 'mini:1:1', kind: 'due', expect: at }), true);
  await s.fn(sync.releaseSchedule, { key: OWNER, scheduleId: id, holder: 'mini:1:1' });
  await s.fn(sync.scheduleRan, { key: OWNER, scheduleId: id, holder: 'mini:1:1', lastRun: { at: 'z', outcome: 'sent' }, sent: true, expectUpdatedAt: 'u', nextRunAt: '2099-01-01T00:00:00.000Z' });
  const row = s.rows('schedules').find((r) => r.id === id)!;
  assert.equal(row.claim?.holder, 'mini:1:1', 'still claimed by Mac mini');
  assert.equal(row.nextRunAt, at, 'its next run not moved');
  assert.equal(row.runs, 0);
  assert.equal(row.lastRun, undefined);
  // Asking it to run stays the main Mac's.
  assert.equal(await s.fn(sync.requestScheduleRun, { key: OWNER, scheduleId: id, at: 'now' }), true);
});

test("the main key can't close a keyed runner's request", async () => {
  const s = await setup();
  await s.mini.upsert('M', MINI);
  await s.fn(relay.fileRequest, { key: MINI_KEY, requestId: 'req-00001', threadId: 'M', target: 'main', request: { text: 'start one' } });
  assert.equal(await outcome(s.fn(relay.closeRequest, { key: OWNER, requestId: 'req-00001' })), 'notFound');
  assert.equal(s.rows('runnerRequests')[0]!.state, 'pending');
});

test("the main key still writes a runner's that has no key of its own, and a keyed one's again once its key is revoked", async () => {
  const s = await setup();
  await s.owner.upsert('L', LAPTOP);
  await s.owner.append('L', 'laptop');
  await s.owner.body('L', 'laptop output');
  assert.deepEqual(textsOf(s, 'L'), ['laptop']);
  assert.equal(s.rows('eventBodies').length, 1);
  await s.mini.upsert('M', MINI);
  await s.mini.append('M', 'mini 1');
  // Revoked: the id is the main key's to act as again (lib.ts actAs's rule).
  const key = s.rows('runnerKeys').find((k) => k.runnerId === MINI)!;
  await s.ctx.db.patch(key._id, { revokedAt: Date.now() });
  await s.owner.append('M', 'owner 2', 2);
  assert.deepEqual(textsOf(s, 'M'), ['mini 1', 'owner 2']);
  await s.owner.remove(['M']);
  assert.equal(s.rows('threads').filter((t) => t.threadId === 'M').length, 0);
});

// Rows an old copy of the main key wrote before this (Daybreak 178's
// remediation test 3): a head inside the runner's history's range, past rows
// it never got to send, and a message it wrote over. A runner key's head is
// the newest of its own rows, and what it sends takes the forged rows back
// with its own words.
test("a keyed runner's head is its own newest row, and its own words go over a forged one", async () => {
  const s = await setup();
  await s.mini.upsert('M', MINI);
  for (const seq of [1, 2, 3]) await s.mini.append('M', `real ${seq}`, seq);
  // As the old main key left them: the message at seq 2 written over, and one at 40.
  const two = s.rows('messages').find((m) => m.threadId === 'M' && m.seq === 2)!;
  await s.ctx.db.replace(two._id, { threadId: 'M', seq: 2, role: 'assistant', text: 'FORGED', at: 'now' });
  await s.ctx.db.insert('messages', { threadId: 'M', seq: 40, role: 'assistant', text: 'FORGED HEAD', at: 'now' });
  assert.deepEqual(await s.fn(sync.messageHeads, { key: MINI_KEY, runnerId: MINI }), [{ threadId: 'M', lastSeq: 3 }]);
  // Its start sends from there, and its history again: its own words win.
  await s.mini.append('M', 'real 2', 2);
  await s.mini.append('M', 'real 40', 40);
  assert.deepEqual(textsOf(s, 'M'), ['real 1', 'real 2', 'real 3', 'real 40']);
  assert.ok(s.rows('messages').filter((m) => m.threadId === 'M').every((m) => m.runnerId === MINI), 'and counted as its own');
  // The main Mac's own head is still its newest row, whoever's.
  assert.deepEqual(await s.fn(sync.messageHeads, { key: OWNER, runnerId: LAPTOP }), []);
});

// Gemini's review: a picture call for the keyed runner's thread, dropped,
// freed the file it named, which could be that runner's upload on its way.
test("the main key can't delete a keyed runner's upload by naming it on a call for its thread", async () => {
  const s = await setup();
  await s.mini.upsert('M', MINI);
  const theirs = await s.upload(MINI_KEY, 'mini-upload');
  await s.owner.reply('M', theirs);
  await s.owner.share('M', theirs);
  assert.equal(s.hasFile(theirs), true);
  // Mac mini attaches it after all.
  await s.mini.reply('M', theirs);
  assert.equal(s.rows('replyImages').length, 1);
});

test("an \"any\" command the main key finishes can't name a keyed runner's thread as the one it made", async () => {
  const s = await setup();
  const machinesModule = load('machines');
  await s.mini.upsert('M', MINI);
  await s.owner.upsert('L', LAPTOP);
  for (const [made, kept] of [
    ['M', undefined],
    ['L', 'L'],
  ] as const) {
    const commandId = await machinesModule.queued(s.ctx, { runnerId: 'any', kind: 'create', args: { text: 'go', cwd: '/w' }, createdAt: Date.now() });
    assert.equal(await s.fn(sync.takeCommand, { key: OWNER, commandId }), true);
    await s.fn(sync.finishCommand, { key: OWNER, commandId, ok: true, resultThreadId: made });
    assert.equal((await s.ctx.db.get(commandId))!.resultThreadId, kept);
  }
});

// Round two (Codex, Gemini): taking a forged row back before finding room
// for its own words left the forged words on a row now counted as its own,
// which no later send could correct.
test("a forged row is taken back with its own words in one step, or not at all", async () => {
  const s = await setup();
  await s.mini.upsert('M', MINI);
  await s.mini.append('M', 'real 1', 1);
  await s.ctx.db.insert('messages', { threadId: 'M', seq: 2, role: 'assistant', text: 'FORGED', at: 'now' });
  const CAP = sync.RUNNER_KEY_CAPS as { messageBytes: number };
  const was = CAP.messageBytes;
  // No room at all: it waits, still not Mac mini's.
  CAP.messageBytes = s.rows('runnerStorage').find((u) => u.runnerId === MINI)!.messageBytes;
  try {
    const r = await s.fn(sync.appendMessages, { key: MINI_KEY, messages: [{ threadId: 'M', seq: 2, role: 'assistant', text: 'real 2 '.padEnd(2_000, 'x'), at: 'now' }] });
    assert.deepEqual(r.skipped, ['M:2']);
    assert.equal(s.rows('messages').find((m) => m.seq === 2)!.runnerId, undefined);
  } finally {
    CAP.messageBytes = was;
  }
  // With room, its words go in, as its own.
  await s.fn(sync.appendMessages, { key: MINI_KEY, messages: [{ threadId: 'M', seq: 2, role: 'assistant', text: 'real 2', at: 'now' }] });
  const two = s.rows('messages').find((m) => m.seq === 2)!;
  assert.deepEqual([two.text, two.runnerId], ['real 2', MINI]);
});

test("the main key can't attach a keyed runner's upload to a thread of its own", async () => {
  const s = await setup();
  await s.owner.upsert('L', LAPTOP);
  const theirs = await s.upload(MINI_KEY, 'mini-upload');
  assert.equal(await outcome(s.owner.reply('L', theirs)), 'forbidden');
  assert.equal(s.rows('storageOwners').find((o) => o.storageId === theirs)!.attachedAt, undefined);
});

// Codex, round three: a tool output was taken back with its old contents,
// sized as they were, and the runner's own never went in.
test("a forged tool output is taken back with the runner's own, sized as its own", async () => {
  const s = await setup();
  await s.mini.upsert('M', MINI);
  await s.mini.body('M', 'real 1', 1);
  await s.ctx.db.insert('eventBodies', { threadId: 'M', seq: 2, text: 'FORGED '.padEnd(4_000, 'x'), at: 1 });
  const CAP = sync.RUNNER_KEY_CAPS as { bodyBytes: number };
  const was = CAP.bodyBytes;
  // Room for the runner's small one, not for the big forged one.
  CAP.bodyBytes = s.rows('runnerStorage').find((u) => u.runnerId === MINI)!.bodyBytes + 500;
  try {
    await s.mini.body('M', 'real 2', 2);
  } finally {
    CAP.bodyBytes = was;
  }
  const two = s.rows('eventBodies').find((b) => b.seq === 2)!;
  assert.deepEqual([two.text, two.runnerId], ['real 2', MINI]);
  const { storedBytes } = sync as { storedBytes: (r: Record<string, unknown>) => number };
  assert.equal(s.rows('runnerStorage').find((u) => u.runnerId === MINI)!.bodyBytes, s.rows('eventBodies').filter((b) => b.runnerId === MINI).reduce((n, b) => n + storedBytes(b), 0));
});

// Gemini, round three: the tool-output takeback also caught a runner's own
// row sent again with new contents, and dropped the update.
test("a runner's own tool output sent again with new contents still replaces it", async () => {
  const s = await setup();
  await s.mini.upsert('M', MINI);
  await s.mini.body('M', 'first', 3);
  await s.mini.body('M', 'second', 3);
  assert.deepEqual(s.rows('eventBodies').map((b) => b.text), ['second']);
});

// Gemini, round three: a row planted early at a seq, older than all a full
// runner has, was let go and the runner's own message at that seq with it.
test("a full runner's message at a seq a row was planted under still goes in", async () => {
  const s = await setup();
  await s.mini.upsert('M', MINI);
  await s.ctx.db.insert('messages', { threadId: 'M', seq: 5, role: 'assistant', text: 'PLANTED', at: 'now' });
  for (const seq of [1, 2, 3]) await s.mini.append('M', `real ${seq}`, seq);
  const CAP = sync.RUNNER_KEY_CAPS as { messageBytes: number };
  const was = CAP.messageBytes;
  CAP.messageBytes = s.rows('runnerStorage').find((u) => u.runnerId === MINI)!.messageBytes;
  try {
    await s.mini.append('M', 'real 5', 5);
  } finally {
    CAP.messageBytes = was;
  }
  assert.ok(textsOf(s, 'M').includes('real 5'));
  assert.ok(!textsOf(s, 'M').includes('PLANTED'));
});
