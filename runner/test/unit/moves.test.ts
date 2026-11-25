// A move from start to end (src/moves.ts), two runners' Moves against the
// backend's own functions in memory (convex/moves.ts), with fake hosts: who
// does what in each state, and what each side is left with when it works,
// when the thread is busy, and when it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { call, claimAndFinish, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';
import { MovePreviews, Moves, moveBinding, moveInfoFrom, planBinding, type MoveRow, type MovesBackend, type MovesHost, type MovePlan, type ThreadMoving } from '../../src/moves.ts';
import type { PackEntry } from '../../src/move-pack.ts';
import { SecretStore } from '../../src/secrets.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const LAPTOP = 'laptop000001';
const MINI = 'cb921b2447ea';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const moves = load('moves');

async function world() {
  process.env.RUNNER_KEY = OWNER;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  for (const [runnerId, name] of [
    [LAPTOP, 'Laptop'],
    [MINI, 'mac-mini'],
  ]) {
    await b.ctx.db.insert('runners', { runnerId, name, version: '1', lastSeenAt: Date.now(), startedAt: new Date().toISOString(), draining: false, threadCount: 0 });
  }
  const stored = new Map<string, Buffer>();
  const listeners: (() => Promise<void>)[] = [];
  let n = 0;
  const backendFor = (key: string, runnerId: string): MovesBackend => {
    const refresh = async () => {
      for (const l of listeners) await l();
    };
    return {
      watch(onMoves) {
        // As a Convex subscription does: only when the answer changed.
        let last: string | undefined;
        const l = async () => {
          const rows = (await call(b.ctx, moves.moves, { key, runnerId })) as MoveRow[];
          const now = JSON.stringify(rows);
          if (now === last) return;
          last = now;
          onMoves(rows);
        };
        listeners.push(l);
        void l();
        return () => listeners.splice(listeners.indexOf(l), 1);
      },
      async call(fn, args) {
        const out = await call(b.ctx, moves[fn], { key, ...args });
        // Rehoming runs as the scheduler would, after the switch.
        for (let job; (job = b.scheduled.findIndex((s: any) => s.fn.endsWith('rehomeRows'))) >= 0; ) {
          const [j] = b.scheduled.splice(job, 1) as { args: Record<string, unknown> }[];
          await call(b.ctx, moves.rehomeRows, j!.args);
        }
        setImmediate(() => void refresh());
        return out;
      },
      async upload(url, bytes) {
        const id = `file${++n}`;
        b.file(id);
        stored.set(id, Buffer.from(bytes));
        if (url.includes('ticket=')) assert.equal(await claimAndFinish(b.ctx, sync.claimUpload, sync.finishUpload, { ticket: new URL(url).searchParams.get('ticket'), storageId: id, bytes: bytes.length }), true);
        return id;
      },
      async download(url) {
        return stored.get(url.split('/').pop()!)!;
      },
    };
  };
  const refresh = async () => {
    for (const l of listeners) await l();
  };
  return { b, backendFor, refresh };
}

const names: Record<string, string> = { [LAPTOP]: 'Laptop', [MINI]: 'mac-mini' };
const log = { info() {}, warn() {} };

type Source = { idle: boolean; present: boolean; putAway: number; seen: (ThreadMoving | undefined)[]; host: Partial<MovesHost> };
function source(threadId: string): Source {
  const seen: (ThreadMoving | undefined)[] = [];
  const h: Source = {
    idle: true,
    present: true,
    putAway: 0,
    seen,
    host: {
      async describe(id: string) {
        return id === threadId ? { title: 'T', cwd: '/home/alex/dev/x', home: '/home/alex', provider: 'claude', accountId: 'claude-1', permissionMode: 'full', worktree: false, schedules: 0 } : undefined;
      },
      idle: () => h.idle,
      setMoving: (_id: string, m: ThreadMoving | undefined) => void seen.push(m),
      async pack(): Promise<{ entries: PackEntry[]; leftBehind: string[] }> {
        return { entries: [{ path: 'thread/thread.json', data: Buffer.from('{"id":"T1"}') }], leftBehind: ['a dev server'] };
      },
      async putAway() {
        h.putAway++;
        h.present = false;
      },
      has: () => h.present,
    },
  };
  return h;
}

function target(plan: MovePlan | { problem: string }) {
  const secrets = new SecretStore(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-moves-')));
  const h = {
    placed: [] as PackEntry[],
    adopted: 0,
    discarded: 0,
    host: {
      plan: async () => plan,
      async place(_row: MoveRow, entries: PackEntry[]) {
        h.placed = entries;
      },
      async adopt() {
        h.adopted++;
      },
      async discard() {
        h.discarded++;
      },
      sealKey: () => secrets.publicKey(),
      open: (sealed: Buffer, info: string) => secrets.openBytes(sealed, info),
    } as Partial<MovesHost>,
  };
  return h;
}

async function until(what: () => boolean, label: string) {
  // By the clock, not a count of turns of the event loop: 500 turns is 30ms,
  // which a busy machine's file and crypto work can easily outlast.
  for (const deadline = Date.now() + 15_000; Date.now() < deadline; ) {
    if (what()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`never: ${label}`);
}

function runners(w: Awaited<ReturnType<typeof world>>, s: ReturnType<typeof source>, t: ReturnType<typeof target>, timers: (() => void)[] = [], vouches?: (expect: string, moveId: string) => boolean) {
  const common = { runnerName: (id: string) => names[id] ?? id };
  const ms = new Moves({ self: () => MINI, backend: () => w.backendFor(MINI_KEY, MINI), host: { ...common, ...s.host } as MovesHost, log, setTimer: (fn) => (timers.push(fn), { cancel() {} }) });
  const mt = new Moves({ self: () => LAPTOP, backend: () => w.backendFor(OWNER, LAPTOP), host: { ...common, ...t.host } as MovesHost, log, setTimer: (fn) => (timers.push(fn), { cancel() {} }), ...(vouches ? { vouches } : {}) });
  ms.start();
  mt.start();
  return { ms, mt };
}

const moveRow = (w: Awaited<ReturnType<typeof world>>) => w.b.rows('threadMoves')[0]!;

// As the main Mac's runner starts one (main.ts threads.move): bound to what
// a preview of it showed, the source's description and the target's plan.
async function startBound(w: Awaited<ReturnType<typeof world>>, threadId: string, s: Source, t: ReturnType<typeof target>, extra: Record<string, unknown> = {}) {
  const info = moveInfoFrom(await s.host.describe!(threadId));
  const plan = await t.host.plan!({} as MoveRow);
  const expect = info && !('problem' in plan) ? moveBinding({ threadId, to: LAPTOP, info, plan: planBinding(plan) }) : undefined;
  return call(w.b.ctx, moves.startMove, { key: OWNER, threadId, to: LAPTOP, ...(expect ? { expect } : {}), ...extra });
}

test('a thread moves from Mac mini to the laptop, and each side ends as it should', async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T1', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T1');
  const t = target({ cwd: '/Users/alex/dev/x', accountId: 'claude-main', leftBehind: [] });
  const { ms } = runners(w, s, t);
  await startBound(w, 'T1', s, t);
  await until(() => moveRow(w).state === 'done', 'the move is done');
  await until(() => s.putAway === 1, "Mac mini's copy put away");
  assert.equal(t.adopted, 1);
  assert.deepEqual(
    t.placed.map((e) => e.path),
    ['thread/thread.json', 'move.json'],
  );
  assert.deepEqual(JSON.parse(t.placed[1]!.data.toString()).leftBehind, ['a dev server']);
  assert.equal(w.b.rows('threads').find((r) => r.threadId === 'T1')!.runnerId, LAPTOP);
  // Mac mini showed it moving, to the laptop, and stopped writing it after the switch.
  assert.ok(s.seen.some((m) => m?.toName === 'Laptop' && m.state === 'packing'));
  assert.equal(ms.gone('T1'), true);
  // The chunks went with the end of the move.
  assert.equal(moveRow(w).chunks, undefined);
});

test('a busy thread waits for its turn to end before it freezes', async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T2', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T2');
  s.idle = false;
  const t = target({ cwd: '/x', accountId: 'a', leftBehind: [] });
  const timers: (() => void)[] = [];
  runners(w, s, t, timers);
  await startBound(w, 'T2', s, t);
  await until(() => moveRow(w).state === 'ready' && timers.length > 0, 'ready, waiting on the turn');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(moveRow(w).state, 'ready', 'not frozen while the turn runs');
  s.idle = true;
  timers.shift()!();
  await until(() => moveRow(w).state === 'done', 'done once the turn ended');
});

// A call refused while the backend is being updated (a deploy's stepping
// stone, convex/stepping.ts) is asked again, not taken for the move failing,
// and only the call: a bundle already uploaded isn't uploaded again, a
// thread already placed isn't placed again (Codex's review). T's adopt and
// done after the switch are tried again too: one lost used to leave the
// move claimed and the thread unable to move again until T restarted.
test("calls refused while the backend is updated are asked again, and T's done after the switch is tried again", async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T9', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T9');
  const t = target({ cwd: '/x', accountId: 'a', leftBehind: [] });
  const adopt = t.host.adopt!;
  let adopts = 0;
  t.host.adopt = async (row) => {
    if (++adopts === 1) throw new Error('the folder was busy');
    return adopt(row);
  };
  const place = t.host.place!;
  let places = 0;
  t.host.place = async (row, entries) => (places++, place(row, entries));
  const timers: { fn: () => void; ms: number }[] = [];
  const setTimer = (fn: () => void, ms: number) => (timers.push({ fn, ms }), { cancel() {} });
  const common = { runnerName: (id: string) => names[id] ?? id };
  const refused = new Set(['moveReady', 'movePacked', 'moveClaim']);
  let uploads = 0;
  const flaky = (b: MovesBackend): MovesBackend => ({
    ...b,
    async call(fn, args) {
      if (refused.delete(fn)) throw new Error('The backend is being updated. Try again in a minute.');
      return b.call(fn, args);
    },
    upload: (url, bytes) => (uploads++, b.upload(url, bytes)),
  });
  new Moves({ self: () => MINI, backend: () => flaky(w.backendFor(MINI_KEY, MINI)), host: { ...common, ...s.host } as MovesHost, log, setTimer }).start();
  new Moves({ self: () => LAPTOP, backend: () => flaky(w.backendFor(OWNER, LAPTOP)), host: { ...common, ...t.host } as MovesHost, log, setTimer }).start();
  await startBound(w, 'T9', s, t);
  for (let i = 0; i < 6 && moveRow(w).state !== 'done'; i++) {
    await until(() => timers.some((x) => x.ms === 20_000) || moveRow(w).state === 'done', 'a call or step to try again');
    const at = timers.findIndex((x) => x.ms === 20_000);
    if (at >= 0) timers.splice(at, 1)[0]!.fn();
  }
  await until(() => moveRow(w).state === 'done', 'done once each went through');
  assert.equal(refused.size, 0, 'each call was refused once');
  assert.equal(uploads, 1, 'the bundle went up once');
  assert.equal(places, 1, 'the thread was placed once');
  assert.equal(t.adopted, 1);
});

// Codex's review: a call waiting to be asked again belongs to its move. One
// cancelled while it waited gives up, and its late tidying up leaves alone a
// newer move of the same thread, which would otherwise unfreeze it mid-pack.
test('a call waiting out an update gives up once its move ends, and leaves a newer move of the thread alone', async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T8', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T8');
  const t = target({ cwd: '/x', accountId: 'a', leftBehind: [] });
  const timers: { fn: () => void; ms: number }[] = [];
  const setTimer = (fn: () => void, ms: number) => (timers.push({ fn, ms }), { cancel() {} });
  const common = { runnerName: (id: string) => names[id] ?? id };
  let packed = 0;
  const sb = w.backendFor(MINI_KEY, MINI);
  const refusing: MovesBackend = {
    ...sb,
    async call(fn, args) {
      if (fn === 'movePacked' && ++packed === 1) throw new Error('The backend is being updated. Try again in a minute.');
      return sb.call(fn, args);
    },
  };
  new Moves({ self: () => MINI, backend: () => refusing, host: { ...common, ...s.host } as MovesHost, log, setTimer }).start();
  new Moves({ self: () => LAPTOP, backend: () => w.backendFor(OWNER, LAPTOP), host: { ...common, ...t.host } as MovesHost, log, setTimer }).start();
  const a = (await startBound(w, 'T8', s, t)).moveId;
  await until(() => timers.some((x) => x.ms === 20_000), "the pack's call waiting to be asked again");
  await call(w.b.ctx, moves.cancelMove, { key: OWNER, moveId: a });
  await w.refresh();
  s.idle = false;
  const b = (await startBound(w, 'T8', s, t)).moveId;
  await w.refresh();
  await until(() => s.seen.at(-1)?.moveId === b && s.seen.at(-1)?.state === 'ready', 'the new move waiting on the turn');
  timers.splice(timers.findIndex((x) => x.ms === 20_000), 1)[0]!.fn();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(packed, 1, 'not asked again once cancelled');
  assert.deepEqual([s.seen.at(-1)?.moveId, s.seen.at(-1)?.state], [b, 'ready'], 'the thread still shows the new move');
});

// Review, 23 Nov 2026: T's claim going through with its reply lost (a POST
// timeout, a reset) used to be taken as the move failing. The backend
// refuses to fail a claimed move, and T took the move as ended, so it
// dropped the claimed row and never adopted the thread: it showed moving,
// on neither runner, until T restarted. A claim that truly didn't go
// through is asked again, without placing the thread twice.
for (const committed of [true, false]) {
  test(`a claim whose reply is lost ${committed ? 'after it went through' : 'before it went through'} still ends with the thread on T`, async () => {
    const w = await world();
    const id = committed ? 'T20' : 'T21';
    await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: id, runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
    const s = source(id);
    const t = target({ cwd: '/x', accountId: 'a', leftBehind: [] });
    const place = t.host.place!;
    let places = 0;
    t.host.place = async (row, entries) => (places++, place(row, entries));
    const timers: { fn: () => void; ms: number }[] = [];
    const setTimer = (fn: () => void, ms: number) => (timers.push({ fn, ms }), { cancel() {} });
    const common = { runnerName: (n: string) => names[n] ?? n };
    let claims = 0;
    const tb = w.backendFor(OWNER, LAPTOP);
    const lossy: MovesBackend = {
      ...tb,
      async call(fn, args) {
        if (fn === 'moveClaim' && ++claims === 1) {
          if (committed) await tb.call(fn, args);
          throw new Error('fetch failed: the request timed out');
        }
        return tb.call(fn, args);
      },
    };
    new Moves({ self: () => MINI, backend: () => w.backendFor(MINI_KEY, MINI), host: { ...common, ...s.host } as MovesHost, log, setTimer }).start();
    new Moves({ self: () => LAPTOP, backend: () => lossy, host: { ...common, ...t.host } as MovesHost, log, setTimer }).start();
    await startBound(w, id, s, t);
    for (let i = 0; i < 4 && moveRow(w).state !== 'done' && moveRow(w).state !== 'failed'; i++) {
      await until(() => timers.some((x) => x.ms === 20_000) || ['done', 'failed'].includes(moveRow(w).state), 'the claim to try again, or the end');
      const at = timers.findIndex((x) => x.ms === 20_000);
      if (at >= 0) timers.splice(at, 1)[0]!.fn();
      await w.refresh();
    }
    await until(() => moveRow(w).state === 'done', 'done');
    assert.equal(t.adopted, 1, 'T runs the thread');
    assert.equal(places, 1, 'placed once');
    assert.equal(t.discarded, 0);
    assert.equal(w.b.rows('threads').find((r) => r.threadId === id)!.runnerId, LAPTOP);
    await until(() => s.putAway === 1, "Mac mini's copy put away");
  });
}

// Grok's review, 23 Nov 2026: T restarting while it asks for the claim
// again placed the thread a second time, and a worktree that came with git
// work blocked that. A placing that finished is on disk (movePlaced): a
// restarted T only asks for the claim.
test('a target that restarts after placing the thread only asks for the claim', async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T22', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T22');
  const t = target({ cwd: '/x', accountId: 'a', leftBehind: [] });
  const place = t.host.place!;
  let places = 0;
  t.host.place = async (row, entries) => (places++, place(row, entries));
  t.host.placed = () => places > 0;
  const timers: { fn: () => void; ms: number }[] = [];
  const setTimer = (fn: () => void, ms: number) => (timers.push({ fn, ms }), { cancel() {} });
  const common = { runnerName: (n: string) => names[n] ?? n };
  const tb = w.backendFor(OWNER, LAPTOP);
  const down: MovesBackend = { ...tb, call: async (fn, args) => (fn === 'moveClaim' ? Promise.reject(new Error('fetch failed')) : tb.call(fn, args)) };
  new Moves({ self: () => MINI, backend: () => w.backendFor(MINI_KEY, MINI), host: { ...common, ...s.host } as MovesHost, log, setTimer }).start();
  const before = new Moves({ self: () => LAPTOP, backend: () => down, host: { ...common, ...t.host } as MovesHost, log, setTimer });
  before.start();
  await startBound(w, 'T22', s, t);
  await until(() => timers.some((x) => x.ms === 20_000), 'the claim waiting to be asked again');
  before.close();
  assert.equal(moveRow(w).state, 'unpacking');
  new Moves({ self: () => LAPTOP, backend: () => tb, host: { ...common, ...t.host } as MovesHost, log, setTimer }).start();
  await until(() => moveRow(w).state === 'done', 'done');
  assert.equal(places, 1, 'placed once, before the restart');
  assert.equal(t.adopted, 1);
});

test("a move the new runner can't take fails, and the thread stays where it was", async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T3', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T3');
  const t = target({ problem: 'The laptop has no copy of alex-example/foo.' });
  runners(w, s, t);
  await startBound(w, 'T3', s, t);
  await until(() => moveRow(w).state === 'failed', 'failed');
  assert.equal(moveRow(w).note, 'The laptop has no copy of alex-example/foo.');
  await until(() => s.seen.at(-1)?.note === 'The laptop has no copy of alex-example/foo.', 'Mac mini shows why');
  assert.equal(s.putAway, 0);
  assert.equal(w.b.rows('threads').find((r) => r.threadId === 'T3')!.runnerId, MINI);
  await until(() => t.discarded === 1, 'the laptop cleans up');
});

test("a bundle that doesn't arrive whole fails before the switch", async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T4', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T4');
  const t = target({ cwd: '/x', accountId: 'a', leftBehind: [] });
  // The laptop's download comes back damaged.
  const realFor = w.backendFor;
  w.backendFor = (key, runnerId) => {
    const real = realFor(key, runnerId);
    return runnerId === LAPTOP ? { ...real, download: async (url) => Buffer.concat([await real.download(url), Buffer.from('x')]) } : real;
  };
  runners(w, s, t);
  await startBound(w, 'T4', s, t);
  await until(() => moveRow(w).state === 'failed', 'failed');
  assert.match(moveRow(w).note, /didn't arrive whole/);
  assert.equal(w.b.rows('threads').find((r) => r.threadId === 'T4')!.runnerId, MINI);
  assert.equal(t.adopted, 0);
});

// Moved away and back (Codex's review, 10 Nov 2026): an old move's switch
// marked the thread gone for good, and its done, heard again after a
// restart, put the thread that had come back away again.
test("a thread moved away and back is this runner's again, and the old move's done leaves it alone", async () => {
  let putAway = 0;
  const host = { has: () => true, putAway: async () => void putAway++, setMoving() {}, runnerName: (id: string) => id, adopt: async () => {} } as unknown as MovesHost;
  const row = (moveId: string, from: string, to: string, state: MoveRow['state'], createdAt: number): MoveRow => ({ moveId, threadId: 'T1', from, to, state, createdAt, updatedAt: createdAt });
  const away = row('aaaaaaaa0001', LAPTOP, MINI, 'done', 1);
  const back = row('aaaaaaaa0002', MINI, LAPTOP, 'done', 2);
  const ms = new Moves({ self: () => LAPTOP, backend: () => undefined, host, log });
  ms.update([away, back]);
  await new Promise((r) => setImmediate(r));
  assert.equal(ms.gone('T1'), false);
  assert.equal(putAway, 0);
  // Only the move away: gone, and put away.
  const once = new Moves({ self: () => LAPTOP, backend: () => undefined, host, log });
  once.update([away]);
  await new Promise((r) => setImmediate(r));
  assert.equal(once.gone('T1'), true);
  assert.equal(putAway, 1);
});

// An update that came while a step was running was dropped: cancelled
// while Bruce packed, the cancel was never stepped (the packing step's
// own failure is a no-op on a cancelled move), so the thread stayed
// "Moving" there, queueing every message, until the runner restarted
// (13 Nov 2026, the implicit state machines scan). The latest row now
// goes once the step that was running ends.
test('a move cancelled while the thread is being packed stops showing as moving', async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T9', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T9');
  let release: (() => void) | undefined;
  const pack = s.host.pack!;
  s.host.pack = async (...args) => {
    await new Promise<void>((r) => (release = r));
    return pack(...args);
  };
  const t = target({ cwd: '/x', accountId: 'a', leftBehind: [] });
  runners(w, s, t);
  await startBound(w, 'T9', s, t);
  await until(() => Boolean(release), 'packing');
  await call(w.b.ctx, moves.cancelMove, { key: OWNER, moveId: moveRow(w).moveId });
  // The backend's watch tells both runners of the cancel, while the pack runs.
  await w.refresh();
  release!();
  await until(() => s.seen.at(-1)?.state === 'cancelled', 'Mac mini shows it was cancelled');
  assert.equal(moveRow(w).state, 'cancelled');
  assert.equal(s.putAway, 0);
});

// Daybreak 142 (16 Nov 2026): the move is bound to what its preview showed.
// The old runner describes the thread once for the preview and again for the
// move, and may be a compromised extra Mac: anything it changes in between
// that the target plans from (the repo's address, its path, the thread's
// folder in it, its provider) fails the move before anything is frozen,
// packed or placed, as does a pick that isn't the previewed one, or a move
// with no binding at all.
for (const [what, change] of [
  ['origin', { origin: 'git@evil.example:attacker/payload.git' }],
  ['repoTop', { repoTop: '/home/alex/.claude/skills/evil' }],
  ['subdir', { subdir: 'deeper' }],
  ['provider', { provider: 'codex' }],
  ['cwd', { cwd: '/home/alex/.ssh' }],
  ['worktree', { worktree: true }],
] as [string, Record<string, unknown>][]) {
  test(`a description whose ${what} changed after the preview fails the move, and nothing is taken`, async () => {
    const w = await world();
    await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T5', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
    const s = source('T5');
    const honest = s.host.describe!;
    let asked = 0;
    s.host.describe = async (id) => {
      const info = await honest(id);
      return asked++ === 0 ? { ...info!, origin: 'git@github.com:alex-example/x.git', repoTop: '/home/alex/dev/x', subdir: '' } : ({ ...info!, origin: 'git@github.com:alex-example/x.git', repoTop: '/home/alex/dev/x', subdir: '', ...change } as never);
    };
    const t = target({ cwd: '/Users/alex/dev/x', accountId: 'claude-main', leftBehind: [] });
    let placed = 0;
    t.host.place = async () => void placed++;
    runners(w, s, t);
    await startBound(w, 'T5', s, t);
    await until(() => moveRow(w).state === 'failed', 'failed');
    assert.match(moveRow(w).note, /changed since the Move sheet looked/);
    assert.equal(moveRow(w).frozenAt, undefined, 'never frozen');
    assert.equal(placed, 0);
    assert.equal(w.b.rows('threads').find((r) => r.threadId === 'T5')!.runnerId, MINI);
  });
}

test('a move whose login or folder pick differs from the previewed one fails', async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T6', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T6');
  const t = target({ cwd: '/Users/alex/dev/x', accountId: 'claude-main', leftBehind: [] });
  runners(w, s, t);
  // Bound with no picks, started with one.
  await startBound(w, 'T6', s, t, { accountId: 'claude-other' });
  await until(() => moveRow(w).state === 'failed', 'failed');
  assert.match(moveRow(w).note, /changed since the Move sheet looked/);
});

test('a move with no preview binding fails before the thread freezes', async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T7', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T7');
  const t = target({ cwd: '/Users/alex/dev/x', accountId: 'claude-main', leftBehind: [] });
  runners(w, s, t);
  await call(w.b.ctx, moves.startMove, { key: OWNER, threadId: 'T7', to: LAPTOP });
  await until(() => moveRow(w).state === 'failed', 'failed');
  assert.match(moveRow(w).note, /without a preview/);
  assert.equal(moveRow(w).frozenAt, undefined);
});

// Security review, 17 Nov 2026: the backend could write a row whose
// description, pick and `expect` all agree (a digest anyone can work out).
// The main Mac's runner starts every move, so a move coming to it goes
// ahead only with a binding its own preview handed out.
test("a move to the main Mac whose binding it didn't hand out fails before the thread freezes", async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T8', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T8');
  const t = target({ cwd: '/Users/alex/dev/x', accountId: 'claude-main', leftBehind: [] });
  const handedOut = new Set<string>();
  runners(w, s, t, [], (e) => handedOut.has(e));
  await startBound(w, 'T8', s, t);
  await until(() => moveRow(w).state === 'failed', 'failed');
  assert.match(moveRow(w).note, /didn't start that move/);
  assert.equal(moveRow(w).frozenAt, undefined, 'never frozen');
  assert.equal(w.b.rows('threads').find((r) => r.threadId === 'T8')!.runnerId, MINI);
});

test('a move to the main Mac with a binding it handed out goes ahead', async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T10', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T10');
  const t = target({ cwd: '/Users/alex/dev/x', accountId: 'claude-main', leftBehind: [] });
  const handedOut = new Set<string>();
  runners(w, s, t, [], (e) => handedOut.has(e));
  const info = moveInfoFrom(await s.host.describe!('T10'))!;
  const plan = (await t.host.plan!({} as MoveRow)) as MovePlan;
  handedOut.add(moveBinding({ threadId: 'T10', to: LAPTOP, info, plan: planBinding(plan) }));
  await startBound(w, 'T10', s, t);
  await until(() => moveRow(w).state === 'done', 'done');
});

// Security review, 17 Nov 2026 (second pass): a binding the main Mac handed
// out is for the one move it started. Cancelled, the same binding on a new
// move's row (the backend's to write) takes nothing.
test('a cancelled move\'s binding on a new move to the main Mac fails it', async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T11', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T11');
  const t = target({ cwd: '/Users/alex/dev/x', accountId: 'claude-main', leftBehind: [] });
  const previews = new MovePreviews();
  const info = moveInfoFrom(await s.host.describe!('T11'))!;
  const plan = (await t.host.plan!({} as MoveRow)) as MovePlan;
  const shown = previews.remember({ threadId: 'T11', to: LAPTOP }, info, { cwd: plan.cwd, accountId: plan.accountId, problems: [], checksPreview: true });
  const expect = previews.take(shown.previewId as string, { threadId: 'T11', to: LAPTOP });
  const first = (await call(w.b.ctx, moves.startMove, { key: OWNER, threadId: 'T11', to: LAPTOP, expect })) as { moveId: string };
  previews.startedAs(expect, first.moveId);
  await call(w.b.ctx, moves.cancelMove, { key: OWNER, moveId: first.moveId });
  const again = (await call(w.b.ctx, moves.startMove, { key: OWNER, threadId: 'T11', to: LAPTOP, expect })) as { moveId: string };
  runners(w, s, t, [], (e, id) => previews.vouches(e, id));
  const row = () => w.b.rows('threadMoves').find((r) => r.moveId === again.moveId)!;
  await until(() => row().state === 'failed', 'failed');
  assert.match(row().note, /didn't start that move/);
  assert.equal(row().frozenAt, undefined);
});

// Security review, 17 Nov 2026 (third pass): a move seen cancelled whose
// row comes back at an earlier state (the backend's to write) takes nothing.
test('a move seen cancelled and put back at unpacking places nothing', async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T12', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T12');
  const t = target({ cwd: '/Users/alex/dev/x', accountId: 'claude-main', leftBehind: [] });
  let placed = 0;
  t.host.place = async () => void placed++;
  let discarded = 0;
  t.host.discard = async () => void discarded++;
  const planHost = t.host.plan!;
  let planned = 0;
  t.host.plan = async (row) => (planned++, planHost(row));
  runners(w, s, t);
  await startBound(w, 'T12', s, t);
  await until(() => moveRow(w).state !== 'asking', 'past asking');
  await call(w.b.ctx, moves.cancelMove, { key: OWNER, moveId: moveRow(w).moveId });
  await w.refresh();
  await until(() => discarded > 0, 'the target saw it cancelled');
  // The same move's row, as the backend could write it back: the target
  // doesn't so much as plan it again.
  planned = 0;
  const r = moveRow(w);
  await w.b.ctx.db.patch(r._id, { state: 'unpacking', updatedAt: Date.now() });
  await w.refresh();
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(planned, 0);
  assert.equal(placed, 0);
});

// Security review, 17 Nov 2026 (fourth pass): cancelled while the target
// is unpacking, and the row put back at unpacking before that step ends:
// nothing is placed, and the cancel's clean-up still runs.
test('a move cancelled while it unpacks places nothing, even if its row comes back', async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T13', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  const s = source('T13');
  const t = target({ cwd: '/Users/alex/dev/x', accountId: 'claude-main', leftBehind: [] });
  let placed = 0;
  t.host.place = async () => void placed++;
  let discarded = 0;
  t.host.discard = async () => void discarded++;
  const planHost = t.host.plan!;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let unpacking = false;
  t.host.plan = async (row) => {
    if (row.state === 'unpacking') {
      unpacking = true;
      await held;
    }
    return planHost(row);
  };
  runners(w, s, t);
  await startBound(w, 'T13', s, t);
  await until(() => unpacking, 'unpacking');
  const r = moveRow(w);
  await w.b.ctx.db.patch(r._id, { state: 'cancelled', updatedAt: Date.now() });
  await w.refresh();
  await w.b.ctx.db.patch(r._id, { state: 'unpacking', updatedAt: Date.now() + 1 });
  await w.refresh();
  release();
  await until(() => discarded > 0, 'the cancel cleaned up');
  assert.equal(placed, 0);
});

test('the backend keeps only a description of the right shape, and only a digest as the binding', async () => {
  const w = await world();
  await call(w.b.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [{ threadId: 'T8', runnerId: MINI, ...THREAD_BASICS, title: 'T', view: 'inbox', needsYou: false }] });
  await assert.rejects(call(w.b.ctx, moves.startMove, { key: OWNER, threadId: 'T8', to: LAPTOP, expect: 'not-a-digest' }), /64 hex/);
  await call(w.b.ctx, moves.startMove, { key: OWNER, threadId: 'T8', to: LAPTOP, expect: 'a'.repeat(64) });
  const moveId = moveRow(w).moveId;
  const base = { title: 'T', cwd: '/c', home: '/h', provider: 'claude', accountId: 'a', permissionMode: 'ask', worktree: false, schedules: 0 };
  await assert.rejects(call(w.b.ctx, moves.moveInfo, { key: MINI_KEY, moveId, info: { ...base, subdir: 5 } }), /info.subdir/);
  await assert.rejects(call(w.b.ctx, moves.moveInfo, { key: MINI_KEY, moveId, info: { ...base, cwd: '/c\n/d' } }), /info.cwd/);
  await call(w.b.ctx, moves.moveInfo, { key: MINI_KEY, moveId, info: { ...base, origin: 'TOKEN123@github.com:o/r.git', extra: { big: 'x' } } });
  assert.deepEqual(moveRow(w).info, { ...base, origin: 'github.com:o/r.git' });
  assert.equal(moveRow(w).expect, 'a'.repeat(64));
});
