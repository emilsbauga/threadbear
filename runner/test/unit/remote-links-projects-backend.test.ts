// What another runner writes into a thread row, read back by the phone and
// the website (convex/sync.ts upsertThreads, phone.ts), against an
// in-memory database (test/helpers/convex-memory.ts):
// - Daybreak 139: an ask's links and a thread's links are web pages or
//   nothing, so a runner key can't store a mailto:, slack: or intent: link
//   for the website to hand to another app.
// - Daybreak 141: a project is (runnerId, projectId). A runner that gives its
//   own thread another runner's project id doesn't put that thread in the
//   other runner's project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend, THREAD_BASICS } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const LAPTOP = 'laptop000001';
const MINI = 'cb921b2447ea';

const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');
const phone = load('phone');
const tokens = load('tokens');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  process.env.CONVEX_SITE_URL = 'https://site.example';
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  // The main Mac heartbeats with the main key; Mac mini with its own.
  for (const [runnerId, byOwner] of [[LAPTOP, true], [MINI, false]] as const) {
    await b.ctx.db.insert('runners', { runnerId, name: runnerId, version: '1', lastSeenAt: Date.now(), startedAt: 'x', draining: false, threadCount: 1, ...(byOwner ? { byOwner } : {}) });
  }
  const { code } = await call(b.ctx, sync.issuePairingCode, { key: OWNER, kind: 'browser', name: 'web' });
  const { token } = (await call(b.ctx, tokens.claim, { code })) as { token: string };
  return { ...b, token };
}

const thread = (threadId: string, runnerId: string, extra: Record<string, unknown> = {}) => ({ threadId, runnerId, ...THREAD_BASICS, title: threadId, view: 'inbox', needsYou: false, ...extra });
const project = (id: string, title: string) => ({ id, title, folders: [], goals: '', state: '', notes: '', createdBy: 'mike', archived: false, createdAt: 'c', updatedAt: 'u', threadCount: 1 });

const NOT_WEB = [
  'mailto:boss@example.com?subject=Resign&body=I%20quit',
  'slack://open?team=T0&id=C0',
  'intent://scan/#Intent;scheme=zxing;package=com.example;end',
  'x-apple.systempreferences:com.apple.preference.security',
  'file:///etc/passwd',
  'data:text/html,<script>alert(1)</script>',
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'https://',
  'https://' + 'a'.repeat(3000) + '.example',
];

for (const [who, key, runnerId] of [['a runner key', MINI_KEY, MINI], ['the main key', OWNER, LAPTOP]] as const) {
  test(`${who}'s thread keeps only web links on its ask card and its links (139)`, async () => {
    const s = await setup();
    const links = [...NOT_WEB.map((url, i) => ({ title: `bad ${i}`, url })), { title: 'Docs', url: 'https://docs.example.com/page?a=1' }, { title: 'Local', url: 'http://localhost:3000/' }];
    await call(s.ctx, sync.upsertThreads, {
      key,
      threads: [thread('T', runnerId, { needsYou: true, asksSeq: 1, asks: [{ action: 'Do it', links }, { action: 'Only bad', links: NOT_WEB.map((url) => ({ title: 'x', url })) }], links })],
    });
    const row = s.rows('threads').find((t) => t.threadId === 'T')!;
    assert.deepEqual(row.asks[0].links.map((l: { url: string }) => l.url), ['https://docs.example.com/page?a=1', 'http://localhost:3000/']);
    assert.equal(row.asks[1].links, undefined, 'an ask with only non-web links keeps none');
    assert.deepEqual(row.links.map((l: { url: string }) => l.url), ['https://docs.example.com/page?a=1', 'http://localhost:3000/']);
    // And what the website and phones read has none either.
    const { thread: read } = (await call(s.ctx, phone.thread, { token: s.token, threadId: 'T' })) as { thread: { asks?: { links?: { url: string }[] }[]; links?: { url: string }[] } };
    const seen = [...(read.asks ?? []).flatMap((a) => a.links ?? []), ...(read.links ?? [])].map((l) => l.url);
    assert.ok(seen.length > 0);
    for (const url of seen) assert.ok(!NOT_WEB.includes(url), `${url.slice(0, 40)} reached the phone`);
  });
}

test('a row stored before API 82 with non-web links reaches the phone and website without them (139)', async () => {
  const s = await setup();
  await call(s.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [thread('OLD', MINI)] });
  const row = s.rows('threads').find((t) => t.threadId === 'OLD')!;
  // As an older backend kept it: written straight in, past today's filter.
  await s.ctx.db.patch(row._id, { asks: [{ action: 'Click', links: [{ title: 'x', url: 'slack://open?team=T0' }, { title: 'ok', url: 'https://ok.example/' }] }], links: [{ title: 'm', url: 'mailto:a@b.example' }] });
  const { thread: read } = (await call(s.ctx, phone.thread, { token: s.token, threadId: 'OLD' })) as { thread: { asks?: { links?: { url: string }[] }[]; links?: unknown } };
  assert.deepEqual(read.asks?.[0].links?.map((l) => l.url), ['https://ok.example/']);
  assert.equal(read.links, undefined);
});

test("a runner's thread with another runner's project id isn't in that runner's project (141)", async () => {
  const s = await setup();
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: LAPTOP, projects: [project('p_shared', 'Main project')] });
  await call(s.ctx, sync.setProjects, { key: MINI_KEY, runnerId: MINI, projects: [project('p_mini', 'Mini project')] });
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('MAIN', LAPTOP, { projects: [{ id: 'p_shared', title: 'Main project' }] })] });
  // The other runner claims the main runner's project id for its own thread,
  // with that project's title, and an id it has no project for.
  await call(s.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [thread('EVIL', MINI, { projects: [{ id: 'p_shared', title: 'Main project' }, { id: 'p_main_only', title: 'x' }, { id: 'p_mini', title: 'Mini project' }] })] });
  const ids = async (runnerId: string | undefined, projectId: string) => ((await call(s.ctx, phone.projectThreads, { token: s.token, ...(runnerId ? { runnerId } : {}), projectId })) as { threadId: string }[]).map((t) => t.threadId);
  assert.deepEqual(await ids(LAPTOP, 'p_shared'), ['MAIN']);
  assert.deepEqual(await ids(MINI, 'p_shared'), []);
  assert.deepEqual(await ids(LAPTOP, 'p_main_only'), []);
  assert.deepEqual(await ids(MINI, 'p_mini'), ['EVIL'], 'its own project is kept');
  // A page from before API 82 asks by the id alone: nothing, not both runners'.
  assert.deepEqual(await ids(undefined, 'p_shared'), []);
  // Every link is under its own thread's runner.
  for (const l of s.rows('projectThreads')) assert.equal(l.runnerId, s.rows('threads').find((t) => t.threadId === l.threadId)!.runnerId);
});

// Apps from before API 82 (the iPhone and Android apps already out there, an
// open old page) find a thread's project by its id alone, in the whole list.
// So a runner key can't put its thread under another runner's project id, nor
// make a project with that id for an old app to find instead (cross-lab
// review, 17 Nov 2026).
test("a runner key can't give its thread or a project of its own another runner's project id (141, old apps)", async () => {
  const s = await setup();
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: LAPTOP, projects: [project('p_shared', 'Main project')] });
  // Its own copy of the id, by both ways a runner writes projects, beside one of its own.
  await call(s.ctx, sync.setProjects, { key: MINI_KEY, runnerId: MINI, projects: [project('p_shared', 'Trusted project'), project('p_mini', 'Mini project')] });
  await call(s.ctx, sync.upsertProjects, { key: MINI_KEY, runnerId: MINI, projects: [{ ...project('p_shared', 'Trusted project'), lastActivityAt: '9999' }], removed: [] });
  await call(s.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [thread('EVIL', MINI, { projects: [{ id: 'p_shared', title: 'Trusted project' }] })] });
  const list = (await call(s.ctx, phone.projects, { token: s.token })) as { runnerId: string; id: string; title: string }[];
  // What an old app reads: one project with the id, the main runner's.
  assert.deepEqual(list.filter((p) => p.id === 'p_shared').map((p) => [p.runnerId, p.title]), [[LAPTOP, 'Main project']]);
  assert.ok(list.some((p) => p.runnerId === MINI && p.id === 'p_mini'), "the runner's own project is still there");
  const { thread: read } = (await call(s.ctx, phone.thread, { token: s.token, threadId: 'EVIL' })) as { thread: { projects?: unknown[] } };
  assert.equal(read.projects, undefined, "the thread isn't under the id at all");
  // The main key's own writes are as they were.
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('MAIN', LAPTOP, { projects: [{ id: 'p_shared', title: 'Main project' }] })] });
  const { thread: main } = (await call(s.ctx, phone.thread, { token: s.token, threadId: 'MAIN' })) as { thread: { projects?: { id: string }[] } };
  assert.deepEqual(main.projects?.map((p) => p.id), ['p_shared']);
});

// Whatever got stored, in whatever order (a runner key using the id before
// the main Mac's project was mirrored, rows from before API 82, a thread
// moved before moves cleared its projects, an id with a space that hid its
// link), what the apps read has the id only as the main Mac's: older apps
// look a project up by its id alone (cross-lab review, 17 Nov 2026).
test("whatever was stored first, apps read a project id only as its own runner's (141, old apps)", async () => {
  const s = await setup();
  // Before the main Mac has mirrored p_shared: the other runner's project and threads take the id.
  await call(s.ctx, sync.setProjects, { key: MINI_KEY, runnerId: MINI, projects: [project('p_shared', 'Trusted project'), project('p_mini', 'Mini project')] });
  await call(s.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [thread('EVIL', MINI, { projects: [{ id: 'p_shared', title: 'Trusted project' }, { id: 'p_mini', title: 'Mini project' }] })] });
  // One whose ids once joined to the same key: its p_shared ref has no link row.
  await call(s.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [thread('SLY', MINI, { projects: [{ id: 'p_shared zz', title: 'x' }] })] });
  await call(s.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [thread('SLY', MINI, { projects: [{ id: 'p_shared', title: 'x' }, { id: 'zz', title: 'x' }] })] });
  // The main Mac's own, and a thread it moved to Mac mini before moves cleared projects.
  await call(s.ctx, sync.setProjects, { key: OWNER, runnerId: LAPTOP, projects: [project('p_shared', 'Main project')] });
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('MAIN', LAPTOP, { projects: [{ id: 'p_shared', title: 'Main project' }] })] });
  const moved = s.rows('threads').find((t) => t.threadId === 'MAIN')!;
  await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread('OLDMOVE', LAPTOP, { projects: [{ id: 'p_shared', title: 'Main project' }] })] });
  await s.ctx.db.patch(s.rows('threads').find((t) => t.threadId === 'OLDMOVE')!._id, { runnerId: MINI });

  const list = (await call(s.ctx, phone.projects, { token: s.token })) as { runnerId: string; id: string; title: string }[];
  assert.deepEqual(list.filter((p) => p.id === 'p_shared').map((p) => [p.runnerId, p.title]), [[LAPTOP, 'Main project']]);
  assert.ok(list.some((p) => p.runnerId === MINI && p.id === 'p_mini'), "the runner's own project is still listed");
  const refs = async (threadId: string) => ((await call(s.ctx, phone.thread, { token: s.token, threadId })) as { thread: { projects?: { id: string }[] } }).thread.projects?.map((p) => p.id);
  assert.deepEqual(await refs('EVIL'), ['p_mini'], 'its own project stays, the main Mac\'s id goes');
  assert.deepEqual(await refs('SLY'), ['zz'], 'an id no runner has stays: no app finds a project for it');
  assert.deepEqual(await refs('OLDMOVE'), undefined);
  assert.deepEqual(await refs(moved.threadId), ['p_shared'], "the main Mac's own thread keeps it");
  // The lists the apps follow say the same.
  const inbox = (await call(s.ctx, phone.threadsAt, { token: s.token, view: 'inbox' })) as { rows: { threadId: string; projects?: { id: string }[] }[] };
  const byId = new Map(inbox.rows.map((r) => [r.threadId, r.projects?.map((p) => p.id)]));
  assert.deepEqual([byId.get('EVIL'), byId.get('OLDMOVE'), byId.get('MAIN')], [['p_mini'], undefined, ['p_shared']]);
  // The main Mac's project archived: the list without archived ones doesn't
  // fall back to Mac mini's copy of the id.
  await call(s.ctx, sync.upsertProjects, { key: OWNER, runnerId: LAPTOP, projects: [{ ...project('p_shared', 'Main project'), archived: true }], removed: [] });
  const live = (await call(s.ctx, phone.projects, { token: s.token })) as { runnerId: string; id: string }[];
  assert.deepEqual(live.filter((p) => p.id === 'p_shared'), []);
  await call(s.ctx, sync.upsertProjects, { key: OWNER, runnerId: LAPTOP, projects: [project('p_shared', 'Main project')], removed: [] });
  // Mac mini's key revoked: it's still not the main Mac.
  for (const k of s.rows('runnerKeys')) await s.ctx.db.patch(k._id, { revokedAt: Date.now() });
  assert.deepEqual(await refs('EVIL'), ['p_mini']);
  assert.deepEqual(await refs('MAIN'), ['p_shared']);
  // And the main Mac's project page has only its own threads.
  const page = (await call(s.ctx, phone.projectThreads, { token: s.token, runnerId: LAPTOP, projectId: 'p_shared' })) as { threadId: string }[];
  assert.deepEqual(page.map((t) => t.threadId).sort(), ['MAIN']);
});

// Each project a thread names is a lookup when the phones read it, so a
// runner key's thread names at most 10, and a list past 1,000 different ids
// leaves the rest out rather than go past Convex's index reads (4,096 per
// query): 100 inbox threads naming 50 made-up ids each (cross-lab review).
test("a runner key's threads can't name enough project ids to stop the phones' lists loading (141)", async () => {
  const s = await setup();
  const many = (n: number, at: number) => Array.from({ length: n }, (_, i) => ({ id: `p_fake_${at}_${i}`, title: 'x' }));
  await call(s.ctx, sync.upsertThreads, { key: MINI_KEY, threads: [thread('ONE', MINI, { projects: many(50, 0) })] });
  assert.equal(s.rows('threads').find((t) => t.threadId === 'ONE')!.projects.length, 10);
  // As written before the cap: 120 threads of 50 ids each.
  for (let i = 0; i < 120; i++) {
    await call(s.ctx, sync.upsertThreads, { key: OWNER, threads: [thread(`T${i}`, LAPTOP)] });
    await s.ctx.db.patch(s.rows('threads').find((t) => t.threadId === `T${i}`)!._id, { projects: many(50, i + 1) });
  }
  let ranges = 0;
  const query = s.ctx.db.query.bind(s.ctx.db);
  (s.ctx.db as { query: unknown }).query = (table: string) => {
    if (table === 'projectHeads' || table === 'projects') ranges++;
    return query(table);
  };
  const inbox = (await call(s.ctx, phone.threadsAt, { token: s.token, view: 'inbox' })) as { rows: { projects?: unknown[] }[] };
  assert.equal(inbox.rows.length, 121);
  assert.ok(ranges <= 1001, `${ranges} project reads`);
});
