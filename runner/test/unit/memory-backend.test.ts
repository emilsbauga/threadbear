// Shared memory in the backend's own functions (convex/memorySync.ts, sync.ts),
// against the in-memory database with the real schema and validators: only
// the main Mac's key writes the files every runner's agents read; a runner
// key's saves are offers that only the main Mac's key can read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load, memoryBackend } from '../helpers/convex-memory.ts';

const OWNER = 'owner-key';
const MINI_KEY = 'tbr_mac-mini';
const MINI = 'cb921b2447ea';
const { sha256 } = load('lib') as { sha256: (s: string) => Promise<string> };
const sync = load('sync');

async function setup() {
  process.env.RUNNER_KEY = OWNER;
  delete process.env.RUNNER_KEY_NEXT;
  const b = memoryBackend();
  await b.ctx.db.insert('runnerKeys', { runnerId: MINI, keyHash: await sha256(MINI_KEY), name: 'mac-mini', createdAt: 1 });
  return b;
}

const H = (c: string) => c.repeat(64);
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'accepted';
  } catch (e) {
    return String((e as { data?: { message?: string } }).data?.message ?? (e as Error).message);
  }
};

test('the main Mac puts files up and every runner reads them by seq, deletes included', async () => {
  const s = await setup();
  const n = await call(s.ctx, sync.putMemory, {
    key: OWNER,
    files: [
      { path: 'global/CLAUDE.md', hash: H('a'), text: 'global' },
      { path: 'memory/~-dev-me-misc/MEMORY.md', hash: H('b'), text: 'index' },
    ],
  });
  assert.equal(n, 2);
  // The same again changes nothing.
  assert.equal(await call(s.ctx, sync.putMemory, { key: OWNER, files: [{ path: 'global/CLAUDE.md', hash: H('a'), text: 'global' }] }), 0);
  const all = await call(s.ctx, sync.memorySince, { key: MINI_KEY, after: 0 });
  assert.deepEqual(all.rows.map((r: { path: string; seq: number }) => [r.path, r.seq]), [['global/CLAUDE.md', 1], ['memory/~-dev-me-misc/MEMORY.md', 2]]);
  assert.equal(all.more, false);
  await call(s.ctx, sync.putMemory, { key: OWNER, files: [{ path: 'memory/~-dev-me-misc/MEMORY.md', hash: H('c'), gone: true }] });
  const after = await call(s.ctx, sync.memorySince, { key: MINI_KEY, after: 2 });
  assert.deepEqual(after.rows.map((r: { path: string; gone?: boolean; seq: number }) => [r.path, r.gone, r.seq]), [['memory/~-dev-me-misc/MEMORY.md', true, 3]]);
});

test("a runner key can't write the shared files, and bad paths are refused", async () => {
  const s = await setup();
  assert.match(await refusal(call(s.ctx, sync.putMemory, { key: MINI_KEY, files: [{ path: 'global/CLAUDE.md', hash: H('a'), text: 'take over' }] })), /only the main Mac's key/);
  for (const path of ['memory/~-dev/../x.md', 'memory/dev/x.md', '/etc/passwd', 'global/AGENTS.md']) {
    assert.match(await refusal(call(s.ctx, sync.putMemory, { key: OWNER, files: [{ path, hash: H('a'), text: 'x' }] })), /not a memory path/, path);
  }
  assert.match(await refusal(call(s.ctx, sync.putMemory, { key: OWNER, files: [{ path: 'global/CLAUDE.md', hash: H('a'), text: 'x'.repeat(128 * 1024 + 1) }] })), /over/);
  assert.equal(s.rows('memoryFiles').length, 0);
});

test("a runner key's offers reach only the main Mac, each version its own row, counted", async () => {
  const s = await setup();
  const offer = (hash: string, text: string) => call(s.ctx, sync.offerMemory, { key: MINI_KEY, runnerId: MINI, files: [{ path: 'memory/~-dev-me-misc/new.md', hash, text }] });
  await offer(H('d'), 'learned');
  assert.match(await refusal(call(s.ctx, sync.offerMemory, { key: MINI_KEY, runnerId: 'someone-else', files: [] })), /act as runner/);
  assert.match(await refusal(call(s.ctx, sync.memoryOffers, { key: MINI_KEY })), /only the main Mac's key/);
  assert.match(await refusal(call(s.ctx, sync.takeMemoryOffers, { key: MINI_KEY, taken: [] })), /only the main Mac's key/);
  assert.match(await refusal(call(s.ctx, sync.offerMemory, { key: OWNER, runnerId: MINI, files: [] })), /act as runner|putMemory/);
  // Another login's different edit of the same file, and the first again.
  await offer(H('e'), 'learned differently');
  await offer(H('d'), 'learned');
  const offers = await call(s.ctx, sync.memoryOffers, { key: OWNER });
  assert.deepEqual(offers.map((o: { runnerId: string; text: string }) => [o.runnerId, o.text]), [[MINI, 'learned'], [MINI, 'learned differently']]);
  assert.equal((s.rows('memoryOfferCounts')[0] as unknown as { count: number }).count, 2);
  // A wrong hash takes nothing.
  await call(s.ctx, sync.takeMemoryOffers, { key: OWNER, taken: [{ id: offers[0].id, hash: H('f') }] });
  assert.equal(s.rows('memoryOffers').length, 2);
  await call(s.ctx, sync.takeMemoryOffers, { key: OWNER, taken: offers.map((o: { id: string; hash: string }) => ({ id: o.id, hash: o.hash })) });
  assert.equal(s.rows('memoryOffers').length, 0);
  assert.equal((s.rows('memoryOfferCounts')[0] as unknown as { count: number }).count, 0);
  // None of it is memory.
  assert.equal(s.rows('memoryFiles').length, 0);
});

test('offers stop at the cap until the main Mac takes some, and a batch is bounded in bytes', async () => {
  const s = await setup();
  await s.ctx.db.insert('memoryOfferCounts', { runnerId: MINI, count: 200 });
  assert.match(await refusal(call(s.ctx, sync.offerMemory, { key: MINI_KEY, runnerId: MINI, files: [{ path: 'memory/~/a.md', hash: H('a'), text: 'x' }] })), /already waiting/);
  const big = 'x'.repeat(100 * 1024);
  const files = Array.from({ length: 30 }, (_, i) => ({ path: `memory/~/f${i}.md`, hash: H('b'), text: big }));
  assert.match(await refusal(call(s.ctx, sync.putMemory, { key: OWNER, files })), /bytes of text at once/);
});
