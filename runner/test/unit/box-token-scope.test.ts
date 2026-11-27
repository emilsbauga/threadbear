import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, load } from '../helpers/convex-memory.ts';
import { boxBackend, LOGIN, OWNER, THREAD } from '../helpers/box-backend.ts';

const boxes = load('boxes');

test('a box refusal leaves the login token valid and an unrelated thread can start', async () => {
  const s = await boxBackend();
  const got = await s.boot();
  await call(s.ctx, boxes.tokenRefused, { key: got.boxKey, setAt: got.tokenSetAt });
  assert.equal(s.rows('cloudTokens')[0].tokenState.kind, 'valid');
  await s.newBox('unrelated', 'box0other001');
  assert.equal(s.state('unrelated'), 'creating');
  const other = await s.boot('unrelated');
  assert.equal(other.claudeToken, got.claudeToken);
  assert.equal(await call(s.a, boxes.boxCloudToken, { key: got.boxKey }), null);
});

test('only an owner-set replacement releases the reporting box grant', async () => {
  const s = await boxBackend();
  const got = await s.boot();
  await s.setToken('a-new-token-for-this-login');
  assert.equal((await call(s.a, boxes.boxCloudToken, { key: got.boxKey })).token, got.claudeToken, 'an active box receives only its approved snapshot');
  await call(s.ctx, boxes.tokenRefused, { key: got.boxKey, setAt: got.tokenSetAt });
  const grant = () => s.rows('boxTokenGrants').find((r) => r.boxId === s.box()._id)!;
  assert.equal(grant().grantState.kind, 'refused');
  await s.setToken('another-owner-approved-token');
  await call(s.ctx, boxes.releaseForToken, { login: LOGIN });
  const fresh = await call(s.a, boxes.boxCloudToken, { key: got.boxKey });
  assert.equal(fresh.token, 'another-owner-approved-token');
  assert.equal(grant().grantState.kind, 'issued');
  await call(s.ctx, boxes.tokenRefused, { key: got.boxKey, setAt: fresh.setAt });
  assert.equal(s.rows('cloudTokens')[0].tokenState.kind, 'valid');
  assert.equal(await call(s.a, boxes.boxCloudToken, { key: got.boxKey }), null);
  // Repeating a report, including stale/future versions, never poisons the login.
  for (const setAt of [got.tokenSetAt, fresh.setAt, fresh.setAt + 1000]) await call(s.ctx, boxes.tokenRefused, { key: got.boxKey, setAt });
  assert.equal(s.rows('cloudTokens')[0].tokenState.kind, 'valid');
});

test('a legacy live key adopts one canonical token snapshot and its refusal is quarantined', async () => {
  const s = await boxBackend();
  const got = await s.boot();
  s.rows('boxTokenGrants').splice(0);
  assert.equal((await call(s.a, boxes.boxCloudToken, { key: got.boxKey })).token, got.claudeToken);
  await call(s.ctx, boxes.tokenRefused, { key: got.boxKey, setAt: got.tokenSetAt });
  assert.equal(s.rows('cloudTokens')[0].tokenState.kind, 'valid');
  assert.equal(await call(s.a, boxes.boxCloudToken, { key: got.boxKey }), null);
  await s.setToken('owner-approved-legacy-recovery');
  await call(s.ctx, boxes.releaseForToken, { login: LOGIN });
  assert.equal((await call(s.a, boxes.boxCloudToken, { key: got.boxKey })).token, 'owner-approved-legacy-recovery');
});

test('a stale refusal cannot quarantine an owner-approved replacement', async () => {
  const s = await boxBackend();
  const got = await s.boot();
  await call(s.ctx, boxes.tokenRefused, { key: got.boxKey, setAt: got.tokenSetAt });
  await s.setToken('an-owner-approved-replacement');
  await call(s.ctx, boxes.releaseForToken, { login: LOGIN });
  await call(s.ctx, boxes.tokenRefused, { key: got.boxKey, setAt: got.tokenSetAt });
  assert.equal((await call(s.a, boxes.boxCloudToken, { key: got.boxKey })).token, 'an-owner-approved-replacement');
  assert.equal(await call(s.a, boxes.boxCloudToken, { key: OWNER }).then(() => 'bad', () => 'forbidden'), 'forbidden');
  assert.equal(s.box(THREAD).boxState.kind, 'awake');
});

test('boot-token replays cannot harvest a replacement or bypass quarantine', async () => {
  const s = await boxBackend();
  const boot = await s.mint();
  const got = await call(s.a, boxes.exchange, { bootToken: boot, machineId: 'machine-1' });
  const boxKeyHash = await load('lib').sha256(got.boxKey);
  const replay = () => call(s.a, boxes.exchange, { bootToken: boot, machineId: 'machine-1', boxKeyHash });
  assert.equal((await replay()).claudeToken, got.claudeToken);
  await call(s.ctx, boxes.tokenRefused, { key: got.boxKey, setAt: got.tokenSetAt });
  await assert.rejects(replay);
  await s.setToken('owner-approved-replay-replacement');
  await call(s.ctx, boxes.releaseForToken, { login: LOGIN });
  assert.equal((await replay()).claudeToken, 'owner-approved-replay-replacement');
  await s.setToken('future-token-not-approved-to-this-box');
  assert.equal((await replay()).claudeToken, 'owner-approved-replay-replacement');
});

test('owner SET releases more than one page without releasing reports made after it', async () => {
  const s = await boxBackend();
  const keys = [];
  for (let n = 0; n < 52; n++) {
    const thread = `grant-${n}`;
    await s.newBox(thread, `grant${String(n).padStart(7, '0')}`);
    const got = await s.boot(thread);
    keys.push(got);
    await call(s.ctx, boxes.tokenRefused, { key: got.boxKey, setAt: got.tokenSetAt });
  }
  await s.setToken('a-paged-owner-replacement');
  for (let n = 0; n < 2; n++) await call(s.ctx, boxes.releaseForToken, { login: LOGIN });
  for (const got of keys) assert.equal((await call(s.a, boxes.boxCloudToken, { key: got.boxKey })).token, 'a-paged-owner-replacement');
  const late = await s.boot();
  await call(s.ctx, boxes.tokenRefused, { key: late.boxKey, setAt: late.tokenSetAt });
  await call(s.ctx, boxes.releaseForToken, { login: LOGIN });
  assert.equal(await call(s.a, boxes.boxCloudToken, { key: late.boxKey }), null);
});

// Cross-lab review: old boxes already marked their report heard, and two
// owner SETs can happen before the next polling response arrives.
test('an already-reported legacy box recovers on owner SET without a new report', async () => {
  const s = await boxBackend();
  const got = await s.boot();
  s.rows('boxTokenGrants').splice(0);
  await s.setToken('owner-releases-an-old-reported-box');
  // This SET could have run on the old backend: no grant-release job ran.
  assert.equal((await call(s.a, boxes.boxCloudToken, { key: got.boxKey })).token, 'owner-releases-an-old-reported-box');
});

test('an approved replacement remains fetchable after another owner SET', async () => {
  const s = await boxBackend();
  const got = await s.boot();
  await call(s.ctx, boxes.tokenRefused, { key: got.boxKey, setAt: got.tokenSetAt });
  await s.setToken('replacement-approved-for-this-box');
  await call(s.ctx, boxes.releaseForToken, { login: LOGIN });
  await s.setToken('newer-token-not-yet-approved-to-box');
  await call(s.ctx, boxes.releaseForToken, { login: LOGIN });
  assert.equal((await call(s.a, boxes.boxCloudToken, { key: got.boxKey })).token, 'replacement-approved-for-this-box');
});

test('a replayed legacy refusal cannot quarantine a replacement owner-set on the old backend', async () => {
  const s = await boxBackend();
  const got = await s.boot();
  s.rows('boxTokenGrants').splice(0);
  await s.setToken('owner-approved-before-backend-upgrade');
  // A legacy watcher without refusedSetAt reports its installed A before
  // fetching B. No new backend's release job has ever run for this SET.
  await call(s.ctx, boxes.tokenRefused, { key: got.boxKey, setAt: got.tokenSetAt });
  assert.equal((await call(s.a, boxes.boxCloudToken, { key: got.boxKey })).token, 'owner-approved-before-backend-upgrade');
});

test('a lost legacy exchange response recovers through a version-bound replay grant', async () => {
  const s = await boxBackend();
  const bootToken = await s.mint();
  const boxKeyHash = await load('lib').sha256(`tbb_${'e'.repeat(64)}`);
  const args = { bootToken, machineId: 'legacy-machine', boxKeyHash };
  const first = await call(s.a, boxes.exchange, args);
  s.rows('boxTokenGrants').splice(0); // The old backend consumed the token but made no grant.
  assert.equal((await call(s.a, boxes.exchange, args)).claudeToken, first.claudeToken);
  await s.setToken('future-token-unapproved-to-replay');
  assert.equal((await call(s.a, boxes.exchange, args)).claudeToken, first.claudeToken);
});
