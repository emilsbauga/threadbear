// The Fly adapter for virtual runners (convex/boxProviders/fly.ts,
// docs/virtual-runners.md decisions 8 and 9) against a fake Fly API: never
// the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from '../helpers/convex-memory.ts';
import { fakeFly } from '../helpers/fake-fly.ts';

const { flyProvider, flyFromEnv, FLY_SUSPEND_MAX_MB } = load('boxProviders/fly');
const { ProviderError, transient, notFound } = load('boxProviders/types');

const spec = {
  image: 'registry.fly.io/threadbear-box:1',
  cpus: 2,
  memoryMb: 2048,
  region: 'syd',
  env: { THREADBEAR_SYNC_URL: 'https://x.convex.cloud', THREADBEAR_BOX_BOOT: `tbt_${'a'.repeat(64)}` },
  name: 'tb-box1-1',
  tags: { tb_box: 'box1', tb_attempt: '1', tb_service: 'svc1' },
  idempotencyKey: 'box1-1',
};

const make = (fly: ReturnType<typeof fakeFly>, memoryMb = 2048) => flyProvider({ token: 'fly-token', app: 'tb-boxes', org: 'my-org', memoryMb, baseUrl: fly.url, fetch: fly.fetch });

test('the first create makes the app, then one machine running the image as it is, with its tags', async () => {
  const fly = fakeFly();
  const p = make(fly);
  assert.equal((await p.create(spec)).providerBoxId, 'm1');
  const appMake = fly.seen.find((r) => r.method === 'POST' && r.path === '/v1/apps')!;
  assert.deepEqual(appMake.json, { app_name: 'tb-boxes', org_slug: 'my-org' });
  const posts = fly.seen.filter((r) => r.method === 'POST' && r.path.endsWith('/machines'));
  assert.equal(posts.length, 1);
  const body = posts[0]!.json;
  assert.equal(body.name, 'tb-box1-1');
  assert.equal(body.region, 'syd');
  assert.equal(body.config.image, spec.image);
  assert.deepEqual(body.config.guest, { cpu_kind: 'shared', cpus: 2, memory_mb: 2048 });
  assert.deepEqual(body.config.env, spec.env);
  assert.deepEqual(body.config.metadata, { ...spec.tags, tb_idem: 'box1-1' });
  assert.deepEqual(body.config.restart, { policy: 'no' });
  // Nothing injected: the image's own entrypoint is the runner in box mode.
  assert.equal(body.config.files, undefined);
  assert.equal(body.config.init, undefined);
  // It asked by the idempotency tag first, and only with the token.
  assert.equal(fly.seen[0]!.query.get('metadata.tb_idem'), 'box1-1');
  assert.ok(fly.seen.every((r) => r.headers.authorization === 'Bearer fly-token'));
  // The app isn't made again.
  await p.create({ ...spec, idempotencyKey: 'box1-2' });
  assert.equal(fly.seen.filter((r) => r.method === 'POST' && r.path === '/v1/apps').length, 1);
});

test('a create run again with the same idempotency key finds the first machine', async () => {
  const fly = fakeFly({ apps: ['tb-boxes'] });
  const p = make(fly);
  const a = await p.create(spec);
  const b = await p.create({ ...spec, name: 'retry' });
  assert.equal(a.providerBoxId, b.providerBoxId);
  assert.equal(fly.live().length, 1);
  await p.create({ ...spec, idempotencyKey: 'box1-2' });
  assert.equal(fly.live().length, 2);
});

test("a 409 on create lists again and returns what's there", async () => {
  const fly = fakeFly({ apps: ['tb-boxes'] });
  fly.conflictOnCreate = true;
  assert.equal((await make(fly).create(spec)).providerBoxId, 'm1');
});

test('list filters by every tag, maps states and gives each its tags; pause, resume and destroy, each safe twice', async () => {
  const fly = fakeFly({ apps: ['tb-boxes'] });
  const p = make(fly);
  const { providerBoxId: id } = await p.create(spec);
  await p.create({ ...spec, idempotencyKey: 'other', tags: { ...spec.tags, tb_box: 'box2' } });
  assert.deepEqual(await p.list({ tb_service: 'svc1', tb_box: 'box1' }), [{ providerBoxId: id, state: 'running', tags: { ...spec.tags, tb_idem: 'box1-1' } }]);
  const listReq = fly.seen.filter((r) => r.method === 'GET' && r.path.endsWith('/machines')).at(-1)!;
  assert.equal(listReq.query.get('metadata.tb_service'), 'svc1');
  assert.equal(listReq.query.get('metadata.tb_box'), 'box1');

  await p.pause!(id);
  assert.equal(fly.seen.filter((r) => r.path.endsWith(`/${id}/wait`)).at(-1)!.query.get('state'), 'suspended');
  assert.equal((await p.list({ tb_box: 'box1' }))[0].state, 'paused');
  await p.pause!(id); // already suspended
  await p.resume!(id);
  assert.equal(fly.byId(id)!.state, 'started');
  await p.resume!(id); // already started
  await p.destroy(id);
  assert.equal(fly.seen.find((r) => r.method === 'DELETE')!.query.get('force'), 'true');
  assert.deepEqual(await p.list({ tb_box: 'box1' }), []);
  await p.destroy(id); // already gone
  // A gone machine can't be paused or resumed: the caller hears it's gone.
  assert.ok(notFound(await p.pause!(id).catch((e: unknown) => e)));
  assert.ok(notFound(await p.resume!(id).catch((e: unknown) => e)));
});

test("list with no app yet doesn't make one", async () => {
  const fly = fakeFly();
  assert.deepEqual(await make(fly).list({ tb_service: 'svc1' }), []);
  assert.equal(fly.seen.filter((r) => r.method !== 'GET').length, 0);
});

test('a box over 2 GB is one Fly can\'t suspend, so it says it can\'t pause', () => {
  const fly = fakeFly();
  assert.equal(make(fly, FLY_SUSPEND_MAX_MB).caps.pause, true);
  assert.equal(make(fly, 4096).caps.pause, false);
});

test("errors say what failed and whether it's worth trying again, never the token", async () => {
  const fly = fakeFly({ apps: ['tb-boxes'] });
  const p = make(fly);
  fly.failNext('POST', '/machines', 503);
  const e = await p.create(spec).catch((x: unknown) => x);
  assert.ok(e instanceof ProviderError);
  assert.equal(e.status, 503);
  assert.equal(transient(e), true);
  assert.ok(!String(e.message).includes('fly-token'));
  fly.failNext('POST', '/machines', 422);
  assert.equal(transient(await p.create(spec).catch((x: unknown) => x)), false);
  // Unreachable is worth trying again.
  const down = flyProvider({ token: 't', app: 'a', memoryMb: 1024, baseUrl: fly.url, fetch: async () => { throw new TypeError('fetch failed'); } });
  const d = await down.list({}).catch((x: unknown) => x);
  assert.equal(d.status, 0);
  assert.equal(transient(d), true);
});

test('from the environment: FLY_API_TOKEN and FLY_APP are needed, FLY_ORG defaults to personal', async () => {
  assert.throws(() => flyFromEnv({ FLY_APP: 'a' }, 1024), /FLY_API_TOKEN/);
  assert.throws(() => flyFromEnv({ FLY_API_TOKEN: 't' }, 1024), /FLY_APP/);
  const fly = fakeFly({ token: 't' });
  const seen: string[] = [];
  const p = flyFromEnv({ FLY_API_TOKEN: 't', FLY_APP: 'tb-boxes' }, 1024, (async (url: string, init?: RequestInit) => {
    seen.push(String(url));
    return fly.fetch(String(url).replace('https://api.machines.dev/v1', fly.url), init);
  }) as never);
  await p.create(spec);
  assert.ok(seen[0]!.startsWith('https://api.machines.dev/v1/apps/tb-boxes/machines'));
  assert.equal(fly.seen.find((r) => r.path === '/v1/apps')!.json.org_slug, 'personal');
});

// Codex's second review of the fixes: a call has a deadline well inside the op lease.
test('a call that gets no answer by its deadline is given up, and never reaches the provider', async () => {
  const fly = fakeFly({ apps: ['tb-boxes'] });
  const p = flyProvider({ token: 'fly-token', app: 'tb-boxes', memoryMb: 1024, baseUrl: fly.url, fetch: fly.fetch, timeoutMs: 50 });
  const held = fly.hold((r) => r.method === 'POST' && r.path.endsWith('/machines'));
  const e = await p.create({ ...spec, idempotencyKey: 'slow' }).catch((x: unknown) => x);
  await held.arrived;
  assert.ok(e instanceof ProviderError);
  assert.equal(e.status, 0);
  assert.match(e.message, /no answer in 50 ms/);
  assert.equal(transient(e), true);
  held.release();
  assert.equal(fly.machines.length, 0, 'the held create was never handled');
});

test('get asks for one machine by its id: its state and tags, or null once it is gone or being destroyed', async () => {
  const fly = fakeFly();
  const p = make(fly);
  const { providerBoxId } = await p.create(spec);
  assert.deepEqual(await p.get(providerBoxId), { providerBoxId, state: 'running', tags: { ...spec.tags, tb_idem: 'box1-1' } });
  fly.byId(providerBoxId)!.state = 'destroying';
  assert.equal(await p.get(providerBoxId), null);
  assert.equal(await p.get('nope'), null);
  assert.equal(p.machineIdEnv, 'FLY_MACHINE_ID');
});
