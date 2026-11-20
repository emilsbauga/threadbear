// A virtual runner's boxes in the backend (convex/boxes.ts, boxMachine.ts;
// docs/virtual-runners.md, decisions 3, 5, 6, 7 and 10): a login's cloud
// token kept sealed, a box's boot token traded once for its key and
// secrets, a new box's key replacing the last one's, and the box's states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, claimAndFinish, load, outcome, THREAD_BASICS } from '../helpers/convex-memory.ts';
import { BOX_RUNNER, boxBackend, CLAUDE_TOKEN, later, LOGIN, OWNER, SEAL_KEY, THREAD } from '../helpers/box-backend.ts';

const sync = load('sync');
const boxes = load('boxes');
const viewer = load('viewer');
const PHONE = 'phone-token';
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const { BOOT_MS, LEASE_MS, SAVE_MS } = load('boxStates') as Record<string, number>;
const MINI_KEY = 'tbr_mac-mini';
const MINI = 'cb921b2447ea';

const heartbeat = (s: { ctx: unknown }, key: string, runnerId = BOX_RUNNER) =>
  call(s.ctx, sync.heartbeat, { key, runner: { runnerId, name: 'box', version: 'v', startedAt: new Date().toISOString(), draining: false, threadCount: 1 } });

// What a box's runner does to save: an upload on its key, then boxSaved.
async function save(s: Awaited<ReturnType<typeof boxBackend>>, boxKey: string, name: string, bytes = 5000) {
  const url: string = await call(s.ctx, sync.iconUploadUrl, { key: boxKey });
  const ticket = new URL(url).searchParams.get('ticket');
  assert.equal(await claimAndFinish(s.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: s.file(name), bytes }), true);
  await call(s.ctx, boxes.boxSaved, { key: boxKey, storageId: name, bytes });
}

test("a cloud token is kept sealed: listed by login, time and state only, never in the clear", async () => {
  const s = await boxBackend({ token: false });
  await s.setToken();
  const row = { ...s.rows('cloudTokens')[0] };
  assert.equal(row.login, LOGIN);
  assert.ok(!JSON.stringify(s.rows('cloudTokens')).includes(CLAUDE_TOKEN.slice(13, 40)), 'not stored in the clear');
  const listed = await call(s.ctx, boxes.cloudTokens, { key: OWNER });
  assert.deepEqual(listed.map((l: Record<string, unknown>) => Object.keys(l).sort()), [['login', 'madeAt', 'setAt', 'state']]);
  assert.equal(listed[0].state, 'valid');
  assert.ok(!JSON.stringify(listed).includes(row.sealed));
  // Setting it again replaces it.
  await s.setToken(`sk-ant-oat01-${'R'.repeat(60)}`);
  assert.equal(s.rows('cloudTokens').length, 1);
  assert.notEqual(s.rows('cloudTokens')[0].sealed, row.sealed);
});

test('only the main key sets or lists cloud tokens, and a deployment without a seal key says so', async () => {
  const s = await boxBackend({ token: false });
  await s.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  assert.equal(await outcome(s.setToken(CLAUDE_TOKEN, LOGIN, MINI_KEY)), 'forbidden');
  assert.equal(await outcome(call(s.ctx, boxes.cloudTokens, { key: MINI_KEY })), 'forbidden');
  assert.equal(await outcome(s.setToken(CLAUDE_TOKEN, LOGIN, 'nobody')), 'auth');
  assert.equal(await outcome(s.setToken('short')), 'badArgs');
  assert.equal(await outcome(s.setToken(CLAUDE_TOKEN, 'two words')), 'badArgs');
  process.env.BOX_SEAL_KEY = Buffer.alloc(16).toString('base64');
  assert.equal(await outcome(s.setToken()), 'config');
  delete process.env.BOX_SEAL_KEY;
  assert.equal(await outcome(s.setToken()), 'config');
  assert.equal(s.rows('cloudTokens').length, 0);
});

test('a new box starts creating, with a sealed thread key and its repo without credentials', async () => {
  const s = await boxBackend();
  const row = s.box();
  assert.equal(row.boxState.kind, 'creating');
  assert.equal(row.runnerId, BOX_RUNNER);
  assert.equal(row.provider, 'fly');
  assert.equal(row.repo.origin, 'https://github.com/mikecann/threadbear.git');
  assert.equal(row.boxKeyHash, undefined);
  assert.ok(row.sealedThreadKey.length > 40);
  // One box a thread, and a box's runner id is its own.
  assert.equal(await outcome(s.newBox()), 'conflict');
  assert.equal(await outcome(s.newBox('another-thread')), 'conflict');
  await s.ctx.db.insert('runners', { runnerId: MINI, name: 'mini', version: 'v', startedAt: 'x', draining: false, threadCount: 1, lastSeenAt: Date.now() });
  assert.equal(await outcome(s.newBox('another-thread', MINI)), 'conflict');
});

test('the exchange works once: a box key, the runner and thread, the login token, the thread key, the repo', async () => {
  const s = await boxBackend();
  await s.setToken();
  const token = await s.mint();
  assert.match(token, /^tbt_[0-9a-f]{64}$/);
  // Only the hash is kept.
  assert.equal(s.box().bootTokenHash, await sha256(token));
  const got = await s.exchange(token);
  assert.match(got.boxKey, /^tbb_[0-9a-f]{64}$/);
  assert.equal(got.runnerId, BOX_RUNNER);
  assert.equal(got.threadId, THREAD);
  assert.equal(got.claudeToken, CLAUDE_TOKEN);
  assert.equal(Buffer.from(got.threadKey, 'base64').length, 32);
  assert.deepEqual(got.repo, { origin: 'https://github.com/mikecann/threadbear.git', subfolder: 'runner', baseBranch: 'main' });
  assert.equal(got.save, null);
  // The login it runs on, as box mode can't read it from a token login's .claude.json.
  assert.equal(got.login, LOGIN);
  const row = s.box();
  assert.equal(row.boxState.kind, 'awake');
  assert.equal(row.boxKeyHash, await sha256(got.boxKey));
  assert.equal(row.bootTokenHash, undefined);
  // The same token again is refused, and the key it gave still works.
  assert.equal(await outcome(s.exchange(token)), 'auth');
  assert.equal(await outcome(heartbeat(s, got.boxKey)), 'ok');
  // The same thread key every time (it's the thread's, not the box's).
  await s.report({ type: 'LOST' });
  const again = await s.exchange(await s.mint());
  assert.equal(again.threadKey, got.threadKey);
});

test('an expired, unknown, malformed or replaced boot token is refused', async () => {
  const s = await boxBackend();
  await s.setToken();
  const old = await s.mint();
  assert.equal(await outcome(later(BOOT_MS + 1000, () => s.exchange(old))), 'auth');
  assert.equal(await outcome(s.exchange(`tbt_${'0'.repeat(64)}`)), 'auth');
  assert.equal(await outcome(s.exchange('not a token')), 'auth');
  // A newer token for the thread replaces the older.
  const newer = await s.mint();
  assert.equal(await outcome(s.exchange(old)), 'auth');
  assert.equal(s.state(), 'creating');
  assert.equal(await outcome(s.exchange(newer)), 'ok');
  // Nothing is minted for a box that isn't booting.
  assert.equal(await outcome(s.mint()), 'conflict');
});

test("an exchange that can't unseal uses nothing up: the boot token works once the right seal key is back", async () => {
  const s = await boxBackend();
  await s.setToken();
  const token = await s.mint();
  const before = { ...s.box() };
  // A deployment whose BOX_SEAL_KEY was changed: as valid a key, but not the one that sealed.
  process.env.BOX_SEAL_KEY = Buffer.alloc(32, 9).toString('base64');
  await assert.rejects(s.exchange(token));
  assert.equal(s.state(), 'creating');
  assert.equal(s.box().boxKeyHash, undefined);
  assert.equal(s.box().bootTokenHash, before.bootTokenHash);
  // A sealed value gone bad does the same.
  process.env.BOX_SEAL_KEY = SEAL_KEY;
  const sealed = s.rows('cloudTokens')[0].sealed;
  s.rows('cloudTokens')[0].sealed = `${sealed.slice(0, -6)}AAAAA=`;
  await assert.rejects(s.exchange(token));
  assert.equal(s.state(), 'creating');
  s.rows('cloudTokens')[0].sealed = sealed;
  assert.equal((await s.exchange(token)).claudeToken, CLAUDE_TOKEN);
  assert.equal(s.state(), 'awake');
});

test('of two exchanges racing with one boot token, exactly one wins', async () => {
  const s = await boxBackend();
  await s.setToken();
  const bootHash = await sha256(await s.mint());
  // Both read and unseal before either claims.
  const p1 = await call(s.ctx, boxes.peekBoot, { bootHash });
  const p2 = await call(s.ctx, boxes.peekBoot, { bootHash });
  const claim = async (p: { sealedToken: string; sealedThreadKey: string }, k: string) => call(s.ctx, boxes.claimBoot, { bootHash, boxKeyHash: await sha256(k), sealedToken: p.sealedToken, sealedThreadKey: p.sealedThreadKey });
  assert.notEqual(await claim(p1, 'tbb_first'), null);
  assert.equal(await claim(p2, 'tbb_second'), null);
  assert.equal(s.box().boxKeyHash, await sha256('tbb_first'));
  // A token set again between the read and the claim: try again, nothing used up.
  await s.report({ type: 'LOST' });
  const again = await sha256(await s.mint());
  const p3 = await call(s.ctx, boxes.peekBoot, { bootHash: again });
  await s.setToken(`sk-ant-oat01-${'Z'.repeat(60)}`);
  assert.equal(await outcome(call(s.ctx, boxes.claimBoot, { bootHash: again, boxKeyHash: 'x', sealedToken: p3.sealedToken, sealedThreadKey: p3.sealedThreadKey })), 'conflict');
  assert.equal(s.state(), 'waking');
});

test('with its cloud token gone, the exchange refuses and the boot token still works once one is set', async () => {
  const s = await boxBackend();
  const token = await s.mint();
  // Never happens by itself (rows aren't deleted): the exchange still refuses rather than hand out nothing.
  const kept = s.rows('cloudTokens').splice(0);
  assert.equal(await outcome(s.exchange(token)), 'noCloudToken');
  assert.equal(s.state(), 'creating');
  assert.equal(s.box().boxKeyHash, undefined);
  s.rows('cloudTokens').push(...kept);
  assert.equal((await s.exchange(token)).claudeToken, CLAUDE_TOKEN);
});

test("a second box for the thread kills the first box's key, its upload URLs with it", async () => {
  const s = await boxBackend();
  const first = await s.boot();
  const url: string = await call(s.ctx, sync.iconUploadUrl, { key: first.boxKey });
  // The first box is lost: its key is refused from that step.
  assert.equal(await s.report({ type: 'LOST' }), true);
  assert.equal(s.state(), 'waking');
  assert.equal(await outcome(heartbeat(s, first.boxKey)), 'auth');
  const second = await s.exchange(await s.mint());
  assert.notEqual(second.boxKey, first.boxKey);
  assert.equal(second.runnerId, first.runnerId, 'the same runner, for life');
  assert.equal(await outcome(heartbeat(s, second.boxKey)), 'ok');
  assert.equal(await outcome(heartbeat(s, first.boxKey)), 'auth');
  // The first box's upload URL died with its key.
  const ticket = new URL(url).searchParams.get('ticket');
  assert.equal(await claimAndFinish(s.ctx, sync.claimUpload, sync.finishUpload, { ticket, storageId: s.file('late'), bytes: 100 }), false);
});

test('a box goes creating, starting, awake, saving, asleep, waking and awake again, then is archived and gone', async () => {
  const s = await boxBackend();
  assert.equal(await s.report({ type: 'CREATED', providerBoxId: 'fly-1' }), true);
  assert.equal(s.state(), 'starting');
  assert.equal(s.box().providerBoxId, 'fly-1');
  const { boxKey } = await s.boot();
  assert.equal(s.state(), 'awake');
  assert.equal(await s.report({ type: 'IDLE' }), true);
  assert.equal(s.state(), 'saving');
  await save(s, boxKey, 'save1');
  assert.equal(s.state(), 'asleep');
  assert.equal(s.box().save.storageId, 'save1');
  assert.ok(s.box().awakeToday.ms >= 0);
  // Asleep on a paused box: its key still works, so it can resume.
  assert.equal(await outcome(heartbeat(s, boxKey)), 'ok');
  assert.equal(await s.report({ type: 'WAKE' }), true);
  assert.equal(s.state(), 'waking');
  // Two quick messages make one wake.
  assert.equal(await s.report({ type: 'WAKE' }), false);
  assert.equal(await s.report({ type: 'RESUMED' }), true);
  assert.equal(s.state(), 'awake');
  assert.equal(await outcome(heartbeat(s, boxKey)), 'ok');
  // Archived while it's up: it saves first (Codex's second review of the second slice).
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: THREAD });
  assert.equal(s.state(), 'archiving');
  assert.equal(await outcome(heartbeat(s, boxKey)), 'ok', 'its key works to save');
  await save(s, boxKey, 'save2');
  assert.equal(s.state(), 'destroying');
  assert.equal(s.box().boxKeyHash, undefined);
  assert.equal(await outcome(heartbeat(s, boxKey)), 'auth');
  // Archiving again is nothing; it comes back only once it's gone, from its save.
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: THREAD });
  assert.equal(await s.report({ type: 'WAKE' }), false);
  assert.equal(await s.report({ type: 'DESTROYED' }), true);
  assert.equal(s.state(), 'gone');
  // Its save stays, for deleteAfterDays: the one it made as it was archived.
  assert.ok(s.hasFile('save2'));
  assert.equal(s.hasFile('save1'), false);
});

// Codex's second review (18 Nov 2026): a paused box lost, or replaced, while
// the thread wakes kept its key working.
test("a box lost or replaced while the thread wakes loses its key at once", async () => {
  // The paused box was attempt 1; the new one is attempt 2.
  for (const event of [{ type: 'LOST', attempt: 1 }, { type: 'CREATED', providerBoxId: 'fly-2', attempt: 2 }, { type: 'CREATED', providerBoxId: 'fly-2' }]) {
    const s = await boxBackend();
    const { boxKey } = await s.boot();
    await s.report({ type: 'IDLE' });
    await save(s, boxKey, 'save1');
    await s.report({ type: 'WAKE' });
    assert.equal(await outcome(call(s.ctx, sync.threadsOf, { key: boxKey, runnerId: BOX_RUNNER })), 'ok');
    // The new box's boot token, minted before the news came, still works after it.
    const bootToken = await s.mint();
    assert.equal(await s.report(event), true, event.type);
    assert.equal(s.box().bootAttempt, 2);
    assert.equal(s.box().boxKeyHash, undefined, event.type);
    assert.equal(await outcome(call(s.ctx, sync.threadsOf, { key: boxKey, runnerId: BOX_RUNNER })), 'auth', event.type);
    assert.equal(await outcome(call(s.ctx, sync.iconUploadUrl, { key: boxKey })), 'auth', event.type);
    // The thread still wakes, on a new box with a key of its own.
    const got = await s.exchange(bootToken);
    assert.equal(s.state(), 'awake');
    assert.equal(await outcome(heartbeat(s, got.boxKey)), 'ok');
  }
});

// Codex's third review (18 Nov 2026): a box reported lost kept the boot
// token minted for it, and could still trade it for a key and secrets. A
// boot token is one attempt's: LOST of that attempt (or an older one) ends
// it, while a token minted for the replacement lives on.
test("a lost box's unused boot token dies with it; the replacement's lives", async () => {
  const mintAttempt = async (s: Awaited<ReturnType<typeof boxBackend>>) => call(s.a, boxes.mintBootToken, { key: OWNER, threadId: THREAD });
  // creating: the first box's token, then the box is lost before CREATED.
  {
    const s = await boxBackend();
    await s.setToken();
    const first = await mintAttempt(s);
    assert.equal(await s.report({ type: 'LOST', attempt: first.attempt }), true);
    assert.equal(await outcome(s.exchange(first.bootToken)), 'auth');
    // The replacement's token, minted before a late LOST for the first, survives it.
    const second = await mintAttempt(s);
    assert.ok(second.attempt > first.attempt);
    assert.equal(await s.report({ type: 'LOST', attempt: first.attempt }), true);
    assert.equal((await s.exchange(second.bootToken)).claudeToken, CLAUDE_TOKEN);
  }
  // waking: a new box's token is lost with it, and the next one works.
  {
    const s = await boxBackend();
    const { boxKey } = await s.boot();
    await s.report({ type: 'IDLE' });
    await save(s, boxKey, 'save1');
    await s.report({ type: 'WAKE' });
    const fresh = await mintAttempt(s);
    await s.report({ type: 'CREATED', providerBoxId: 'fly-2', attempt: fresh.attempt });
    assert.equal(await s.report({ type: 'LOST', attempt: fresh.attempt }), true);
    assert.equal(s.state(), 'waking');
    assert.equal(await outcome(s.exchange(fresh.bootToken)), 'auth');
    assert.equal(await outcome(heartbeat(s, boxKey)), 'auth');
    const next = await mintAttempt(s);
    assert.equal(await outcome(s.exchange(next.bootToken)), 'ok');
  }
  // An older box's loss, reported late, leaves the box awake now alone.
  {
    const s = await boxBackend();
    await s.setToken();
    const old = await mintAttempt(s);
    const now = await mintAttempt(s);
    const { boxKey } = await s.exchange(now.bootToken);
    assert.equal(await s.report({ type: 'LOST', attempt: old.attempt }), true);
    assert.equal(s.state(), 'awake');
    assert.equal(await outcome(heartbeat(s, boxKey)), 'ok');
    assert.equal(await s.report({ type: 'LOST', attempt: now.attempt }), true);
    assert.equal(s.state(), 'waking');
    assert.equal(await outcome(heartbeat(s, boxKey)), 'auth');
  }
  // A LOST that doesn't say which box ends every token and key.
  {
    const s = await boxBackend();
    await s.setToken();
    const t = await mintAttempt(s);
    await s.report({ type: 'LOST' });
    assert.equal(await outcome(s.exchange(t.bootToken)), 'auth');
  }
});

// Codex's fourth review (18 Nov 2026): attempt ordering is one rule. An
// event naming attempt N touches only what's attempt N's or older, never a
// newer attempt's boot token, key or provider box; and one older than the
// newest attempt the row knows doesn't change its state or provider box.
// Each line: a step, then what must hold after it.
type Step =
  | ['mint', string] // a boot token for a new attempt, named
  | ['created', number, string] // the provider made box (id) for that attempt
  | ['lost', number] // the provider lost that attempt's box
  | ['resumed', number] // the provider resumed that attempt's paused box
  | ['idle', number] // the service asks that attempt's box to save
  | ['save', string] // the box holding the named token's key saves
  | ['wake']
  | ['exchange', string, 'ok' | 'auth'] // a box trades the named token
  | ['expect', { state?: string; provider?: string | null; key?: string | null; works?: string[]; dead?: string[] }];
const ORDERS: { name: string; steps: Step[] }[] = [
  {
    name: "an older box's loss leaves its replacement's boot token (case 1)",
    steps: [['mint', 'A'], ['created', 1, 'box-1'], ['expect', { state: 'starting', provider: 'box-1' }], ['mint', 'B'], ['lost', 1], ['expect', { state: 'starting', provider: null }], ['created', 2, 'box-2'], ['expect', { state: 'starting', provider: 'box-2' }], ['exchange', 'B', 'ok'], ['expect', { state: 'awake', provider: 'box-2', key: 'B' }]],
  },
  {
    name: "a late CREATED doesn't take the live box's provider id (case 2)",
    steps: [['mint', 'A'], ['mint', 'B'], ['exchange', 'B', 'ok'], ['created', 2, 'box-2'], ['created', 1, 'box-1'], ['expect', { state: 'awake', provider: 'box-2', key: 'B' }], ['lost', 1], ['expect', { state: 'awake', provider: 'box-2', works: ['B'] }]],
  },
  {
    name: 'the newest box lost ends it, and only it',
    steps: [['mint', 'A'], ['created', 1, 'box-1'], ['exchange', 'A', 'ok'], ['lost', 1], ['expect', { state: 'waking', provider: null, key: null, dead: ['A'] }], ['mint', 'B'], ['created', 2, 'box-2'], ['exchange', 'B', 'ok'], ['expect', { state: 'awake', provider: 'box-2', works: ['B'] }]],
  },
  {
    name: 'three attempts: late news of the first two changes nothing of the third',
    steps: [['mint', 'A'], ['mint', 'B'], ['mint', 'C'], ['created', 3, 'box-3'], ['created', 1, 'box-1'], ['created', 2, 'box-2'], ['expect', { state: 'starting', provider: 'box-3' }], ['lost', 2], ['lost', 1], ['expect', { state: 'starting', provider: 'box-3' }], ['exchange', 'A', 'auth'], ['exchange', 'B', 'auth'], ['exchange', 'C', 'ok'], ['expect', { state: 'awake', provider: 'box-3', key: 'C' }]],
  },
  {
    name: 'three attempts: a token minted for the third survives losses of the first two, in any order',
    steps: [['mint', 'A'], ['created', 1, 'box-1'], ['mint', 'B'], ['lost', 1], ['expect', { state: 'starting', provider: null }], ['mint', 'C'], ['lost', 2], ['lost', 1], ['expect', { state: 'starting' }], ['exchange', 'B', 'auth'], ['exchange', 'C', 'ok'], ['expect', { state: 'awake', key: 'C', works: ['C'] }]],
  },
  // Codex's fifth review (18 Nov 2026):
  {
    name: "a late RESUMED of an older box leaves its replacement's token, and the older key still goes (case 1)",
    steps: [['mint', 'A'], ['exchange', 'A', 'ok'], ['created', 1, 'box-1'], ['idle', 1], ['save', 'A'], ['wake'], ['mint', 'B'], ['resumed', 1], ['expect', { state: 'waking' }], ['created', 2, 'box-2'], ['expect', { state: 'starting', provider: 'box-2', dead: ['A'] }], ['exchange', 'B', 'ok'], ['expect', { state: 'awake', key: 'B', works: ['B'] }]],
  },
  {
    name: 'a replayed CREATED for a box that already exchanged is only its metadata, so it can still resume (case 2)',
    steps: [['mint', 'A'], ['created', 1, 'box-1'], ['exchange', 'A', 'ok'], ['idle', 1], ['save', 'A'], ['wake'], ['created', 1, 'box-1'], ['expect', { state: 'waking', provider: 'box-1', works: ['A'] }], ['resumed', 1], ['expect', { state: 'awake', key: 'A', works: ['A'] }]],
  },
  {
    // A second machine named for the same attempt is a duplicate's (Codex's fifteenth round): not the row's.
    name: 'the current box\'s CREATED is recorded in any state, saving too, and a second machine for its attempt isn\'t (case 3)',
    steps: [['mint', 'A'], ['exchange', 'A', 'ok'], ['idle', 1], ['created', 1, 'box-1'], ['expect', { state: 'saving', provider: 'box-1', key: 'A' }], ['save', 'A'], ['created', 1, 'box-1b'], ['expect', { state: 'asleep', provider: 'box-1', works: ['A'] }]],
  },
  {
    name: "an older box's IDLE or RESUMED changes nothing",
    steps: [['mint', 'A'], ['mint', 'B'], ['exchange', 'B', 'ok'], ['idle', 1], ['resumed', 1], ['expect', { state: 'awake', key: 'B' }], ['idle', 2], ['expect', { state: 'saving' }]],
  },
];

for (const order of ORDERS) {
  test(`attempt ordering: ${order.name}`, async () => {
    const s = await boxBackend();
    await s.setToken();
    const tokens = new Map<string, { bootToken: string; attempt: number }>();
    const keys = new Map<string, string>();
    for (const [i, step] of order.steps.entries()) {
      const at = `step ${i + 1} ${JSON.stringify(step)}`;
      if (step[0] === 'mint') tokens.set(step[1], await call(s.a, boxes.mintBootToken, { key: OWNER, threadId: THREAD }));
      else if (step[0] === 'created') await s.report({ type: 'CREATED', attempt: step[1], providerBoxId: step[2] });
      else if (step[0] === 'lost') await s.report({ type: 'LOST', attempt: step[1] });
      else if (step[0] === 'resumed') await s.report({ type: 'RESUMED', attempt: step[1] });
      else if (step[0] === 'idle') await s.report({ type: 'IDLE', attempt: step[1] });
      else if (step[0] === 'wake') await s.report({ type: 'WAKE' });
      else if (step[0] === 'save') await save(s, keys.get(step[1])!, `save-${i}`);
      else if (step[0] === 'exchange') {
        const r = await outcome(s.exchange(tokens.get(step[1])!.bootToken).then((g) => keys.set(step[1], g.boxKey)));
        assert.equal(r, step[2], at);
      } else {
        const want = step[1];
        if (want.state) assert.equal(s.state(), want.state, at);
        if (want.provider !== undefined) assert.equal(s.box().providerBoxId ?? null, want.provider, at);
        if (want.key !== undefined) assert.equal(s.box().boxKeyHash ?? null, want.key === null ? null : await sha256(keys.get(want.key)!), at);
        for (const k of want.works ?? []) assert.equal(await outcome(heartbeat(s, keys.get(k)!)), 'ok', `${at}: ${k} works`);
        for (const k of want.dead ?? []) assert.equal(await outcome(heartbeat(s, keys.get(k)!)), 'auth', `${at}: ${k} is dead`);
      }
    }
  });
}

test('a box lost while it boots goes back to waking for another', async () => {
  const s = await boxBackend();
  await s.report({ type: 'CREATED', providerBoxId: 'fly-1' });
  assert.equal(await s.report({ type: 'LOST' }), true);
  assert.equal(s.state(), 'waking');
  assert.equal(s.box().providerBoxId, undefined);
});

test('a save replaces the last one, and a new box gets the last save to restore', async () => {
  const s = await boxBackend();
  const { boxKey } = await s.boot();
  await save(s, boxKey, 'save1');
  assert.equal(s.state(), 'awake', 'a save while awake keeps it awake');
  await s.report({ type: 'IDLE' });
  await save(s, boxKey, 'save2', 9000);
  assert.equal(s.state(), 'asleep');
  assert.deepEqual({ id: s.box().save.storageId, bytes: s.box().save.bytes }, { id: 'save2', bytes: 9000 });
  assert.equal(s.hasFile('save1'), false, 'the last save is deleted');
  // The paused box was lost while asleep: its key goes with it, so it can't
  // resume, and the next wake makes a new box, which restores the save.
  await s.report({ type: 'LOST' });
  assert.equal(s.state(), 'asleep');
  assert.equal(await outcome(heartbeat(s, boxKey)), 'auth');
  await s.report({ type: 'WAKE' });
  assert.equal(await s.report({ type: 'RESUMED' }), false);
  const got = await s.exchange(await s.mint());
  assert.equal(got.save.url, 'https://files.example/save2');
  assert.equal(got.save.bytes, 9000);
  assert.equal(await outcome(heartbeat(s, boxKey)), 'auth');
});

test("a box's save is a file its own runner uploaded, on its own key", async () => {
  const s = await boxBackend();
  const { boxKey } = await s.boot();
  // A file nobody's runner uploaded (the owner's), and the owner itself.
  s.file('owners');
  assert.equal(await outcome(call(s.ctx, boxes.boxSaved, { key: boxKey, storageId: 'owners', bytes: 10 })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, boxes.boxSaved, { key: OWNER, storageId: 'owners', bytes: 10 })), 'forbidden');
  assert.equal(await outcome(call(s.ctx, boxes.boxSaved, { key: boxKey, storageId: 'owners', bytes: 0 })), 'badArgs');
  assert.equal(s.box().save, undefined);
});

test('timers: a box that never checks in fails; one that stops heartbeating is lost; a save that never comes keeps it up', async () => {
  const s = await boxBackend();
  // Never exchanged: failed after ten minutes, and the next message tries again.
  await s.fireTimers(Date.now() + BOOT_MS + 1000);
  assert.equal(s.state(), 'failed');
  assert.match(s.box().boxState.error, /10 minutes/);
  assert.equal(await s.report({ type: 'WAKE' }), true);
  assert.equal(s.state(), 'waking');
  const { boxKey } = await s.boot();
  assert.equal(s.state(), 'awake');
  // Heartbeating: the lease runs on from its last heartbeat.
  const t1 = Date.now() + LEASE_MS - 1000;
  await later(t1 - Date.now(), () => heartbeat(s, boxKey));
  await s.fireTimers(Date.now() + LEASE_MS + 10);
  assert.equal(s.state(), 'awake');
  assert.ok(s.box().boxState.leaseUntil > Date.now() + LEASE_MS);
  // Asked to save, and nothing comes: it stays up.
  await s.report({ type: 'IDLE' });
  await later(SAVE_MS - 2000, () => heartbeat(s, boxKey));
  await s.fireTimers(Date.now() + SAVE_MS + 10);
  assert.equal(s.state(), 'awake');
  // No heartbeat for the lease: not lost on that alone (Codex's fourth round):
  // marked unreachable, its key kept, while the provider is asked.
  await s.fireTimers(Date.now() + 3 * LEASE_MS);
  assert.equal(s.state(), 'awake');
  assert.ok(s.box().unreachableSince);
  assert.ok(s.box().boxKeyHash);
  assert.ok((s.scheduled as { fn: string }[]).some((j) => j.fn.endsWith('checkBox')));
  // The provider says it's gone: lost, its key refused.
  assert.equal(await s.report({ type: 'LOST' }), true);
  assert.equal(s.state(), 'waking');
  assert.equal(s.box().boxKeyHash, undefined);
  assert.equal(await outcome(heartbeat(s, boxKey)), 'auth');
});

test('the provider failing fails the box, its key with it; a failed or archived box takes no boot', async () => {
  const s = await boxBackend();
  await s.setToken();
  const token = await s.mint();
  assert.equal(await s.report({ type: 'FAILED', error: 'no capacity\nin syd' }), true);
  assert.equal(s.state(), 'failed');
  assert.equal(s.box().boxState.error, 'no capacity in syd');
  assert.equal(await outcome(s.exchange(token)), 'auth');
  await s.report({ type: 'WAKE' });
  const late = await s.mint();
  await call(s.ctx, boxes.archiveBox, { key: OWNER, threadId: THREAD });
  assert.equal(await outcome(s.exchange(late)), 'auth');
  assert.equal(s.state(), 'destroying');
});

test("a box's heartbeat marks its runner as a box's, and nothing a heartbeat sends takes it off", async () => {
  const s = await boxBackend();
  const { boxKey } = await s.boot();
  await call(s.ctx, sync.heartbeat, { key: boxKey, runner: { runnerId: BOX_RUNNER, name: 'box', version: 'v', startedAt: new Date().toISOString(), draining: false, threadCount: 1, rpcUrl: 'wss://evil.example/rpc' } });
  const runner = s.rows('runners').find((r) => r.runnerId === BOX_RUNNER)!;
  assert.deepEqual(runner.box, { serviceId: s.serviceId });
  // No Mac app dials a box.
  assert.equal(runner.rpcUrl, undefined);
  // The owner key heartbeating as that runner keeps it.
  await heartbeat(s, OWNER);
  assert.deepEqual(s.rows('runners').find((r) => r.runnerId === BOX_RUNNER)!.box, { serviceId: s.serviceId });
  assert.ok(s.box().lastHeartbeatAt! > 0);
  // A box key is no runner key: none was made for it.
  assert.equal(s.rows('runnerKeys').length, 0);
});

test('no query hands back a sealed token, a thread key or a key hash', async () => {
  const s = await boxBackend();
  const got = await s.boot();
  await heartbeat(s, got.boxKey);
  const sealed = [s.rows('cloudTokens')[0].sealed, s.box().sealedThreadKey, s.box().boxKeyHash];
  // The Machines page's queries, for a phone or browser token.
  await s.ctx.db.insert('tokens', { hash: await sha256(PHONE), name: 'iphone', kind: 'phone', expiresAt: Date.now() + 1e9, createdAt: Date.now() });
  const viewed = [
    await call(s.ctx, viewer.overview, { token: PHONE }),
    await call(s.ctx, viewer.rows, { token: PHONE, table: 'boxes' }),
    await call(s.ctx, viewer.rows, { token: PHONE, table: 'boxes', machine: 'box', kind: 'awake' }),
    await call(s.ctx, viewer.row, { token: PHONE, table: 'boxes', id: s.boxId }),
  ];
  assert.equal(viewed[1].rows.length, 1, 'the viewer still lists the box');
  assert.equal(viewed[3].doc.threadId, THREAD, 'and shows its row');
  const answers = [...viewed, await call(s.ctx, boxes.cloudTokens, { key: OWNER }), await call(s.ctx, sync.threadsOf, { key: got.boxKey, runnerId: BOX_RUNNER }), await call(s.ctx, sync.runnersList, { key: OWNER })];
  const text = JSON.stringify(answers);
  for (const x of [...sealed, CLAUDE_TOKEN, got.threadKey]) assert.ok(!text.includes(x), 'nothing secret in what queries return');
});

// Slice 3's exchange (docs/protocol.md, "Box keys"): the box makes its own
// key and sends its hash, so an answer lost on the way can be asked for
// again, by that machine with that key, and by nobody else.
test("a box's own key: the exchange keeps only its hash, and replays the answer to the same machine and key, never to anyone else", async () => {
  const s = await boxBackend();
  await s.setToken();
  const token = await s.mint();
  const boxKey = `tbb_${'d'.repeat(64)}`;
  const boxKeyHash = await sha256(boxKey);
  const ask = (a: Record<string, unknown>) => call(s.a, boxes.exchange, { bootToken: token, ...a });
  const got = await ask({ machineId: 'm-1', boxKeyHash });
  // No key made here: the box has its own, which now works.
  assert.equal(got.boxKey, undefined);
  assert.equal(s.box().boxKeyHash, boxKeyHash);
  assert.equal(s.box().keyMachineId, 'm-1');
  assert.equal(await outcome(heartbeat(s, boxKey)), 'ok');
  // The same machine and key, its answer lost: the same answer, nothing changed.
  const again = await ask({ machineId: 'm-1', boxKeyHash });
  assert.deepEqual({ ...again }, { ...got });
  assert.equal(s.box().boxKeyHash, boxKeyHash);
  assert.equal(s.box().boxState.kind, 'awake');
  // Anyone else with the spent token: refused.
  assert.equal(await outcome(ask({ machineId: 'm-2', boxKeyHash })), 'auth');
  assert.equal(await outcome(ask({ machineId: 'm-1', boxKeyHash: await sha256(`tbb_${'e'.repeat(64)}`) })), 'auth');
  assert.equal(await outcome(ask({ boxKeyHash })), 'auth');
  assert.equal(await outcome(ask({ machineId: 'm-1' })), 'auth');
  assert.equal(await outcome(ask({})), 'auth');
  assert.equal(await outcome(ask({ machineId: 'm-1', boxKeyHash: 'not-a-hash' })), 'badArgs');
  // Past the token's 10 minutes: refused, the key still working.
  assert.equal(await outcome(later(11 * 60_000, () => ask({ machineId: 'm-1', boxKeyHash }))), 'auth');
  // Once the key isn't the thread's any more (a newer box), refused too.
  await s.report({ type: 'LOST' });
  assert.equal(await outcome(ask({ machineId: 'm-1', boxKeyHash })), 'auth');
});

test("a box's heartbeat answers with its box's state, which a box stopped by its save waits on; no other key's does", async () => {
  const s = await boxBackend();
  const got = await s.boot();
  const r = await heartbeat(s, got.boxKey);
  assert.deepEqual(r.box, { state: 'awake' });
  await s.report({ type: 'IDLE', attempt: 1 });
  assert.deepEqual((await heartbeat(s, got.boxKey)).box, { state: s.state() });
  assert.notEqual(s.state(), 'awake');
  const owner = await call(s.ctx, sync.heartbeat, { key: OWNER, runner: { runnerId: 'mac1', name: 'Mac', version: 'v', startedAt: new Date().toISOString(), draining: false, threadCount: 0 } });
  assert.equal(owner.box, undefined);
});

test("a box held by its save: its heartbeats and its save's finish, sent `held`, don't mark it as holding work again", async () => {
  const s = await boxBackend();
  const got = await s.boot();
  await heartbeat(s, got.boxKey);
  assert.deepEqual(s.box().workAttempts, [1]);
  await s.report({ type: 'IDLE', attempt: 1 });
  // As the idle cron does (boxService.ts sleepIdleBoxes).
  await boxes.askToSave(s.ctx, s.box());
  const cmd = s.rows('commands').find((c) => c.kind === 'save')!;
  assert.ok(cmd, 'a save asked for');
  await save(s, got.boxKey, 'save1');
  assert.deepEqual(s.box().workAttempts ?? [], [], 'the save covers the work');
  const beat = (held?: boolean) => call(s.ctx, sync.heartbeat, { key: got.boxKey, runner: { runnerId: BOX_RUNNER, name: 'box', version: 'v', startedAt: new Date().toISOString(), draining: false, threadCount: 1 }, ...(held ? { held } : {}) });
  await beat(true);
  // Its finish (whatever the command's own state makes of it, its key is checked first).
  await outcome(call(s.ctx, sync.finishCommand, { key: got.boxKey, commandId: cmd._id, ok: true, held: true }));
  assert.deepEqual(s.box().workAttempts ?? [], []);
  // Without it, a heartbeat is the box at work again.
  await beat();
  assert.deepEqual(s.box().workAttempts, [1]);
});

test("a box's repeated finish of a command already ended (a retry racing the first) doesn't mark it as working", async () => {
  const s = await boxBackend();
  const got = await s.boot();
  await call(s.ctx, sync.upsertThreads, { key: got.boxKey, threads: [{ ...THREAD_BASICS, threadId: THREAD, runnerId: BOX_RUNNER, title: 't', view: 'inbox', needsYou: false }] });
  await s.report({ type: 'IDLE', attempt: 1 });
  await boxes.askToSave(s.ctx, s.box());
  const cmd = s.rows('commands').find((c) => c.kind === 'save')!;
  assert.equal(await call(s.ctx, sync.takeCommand, { key: got.boxKey, commandId: cmd._id }), true);
  await call(s.ctx, sync.finishCommand, { key: got.boxKey, commandId: cmd._id, ok: true, held: true });
  await save(s, got.boxKey, 'save1');
  assert.deepEqual(s.box().workAttempts ?? [], []);
  // The same finish again, without `held` (a heartbeat's retry of a finish whose answer was lost).
  await call(s.ctx, sync.finishCommand, { key: got.boxKey, commandId: cmd._id, ok: true });
  assert.deepEqual(s.box().workAttempts ?? [], [], 'a finish that changes nothing makes no work');
  // Anything else from the box is work again, as before.
  await call(s.ctx, sync.heartbeat, { key: got.boxKey, runner: { runnerId: BOX_RUNNER, name: 'box', version: 'v', startedAt: new Date().toISOString(), draining: false, threadCount: 1 } });
  assert.deepEqual(s.box().workAttempts, [1]);
});
