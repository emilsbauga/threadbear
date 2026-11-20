// A pause the process didn't see (a Mac waking, a box resumed): the clock
// jump watch (src/clock-jump.ts), the subscriber's reconnect, and the sync
// heartbeating at once (ConvexSync.reconnectNow).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockJumpWatch, JUMP_MS, MIN_GAP_MS, TICK_MS } from '../../src/clock-jump.ts';
import { ConvexSync, convexSubscriber, type MinimalConvexClient } from '../../src/sync.ts';
import { makeHarness, tick } from '../helpers/fakes.ts';
import { nullLogger } from '../../src/log.ts';

test('a jump in the wall clock between ticks is said once, and never storms', () => {
  let t = 1_000_000;
  const jumps: number[] = [];
  const w = new ClockJumpWatch({ now: () => t, onJump: (gap) => jumps.push(gap) });
  // Ticks on time: nothing.
  for (let i = 0; i < 5; i++) {
    t += TICK_MS;
    assert.equal(w.tick(), false);
  }
  // A paused process: the next tick comes a minute late.
  t += 60_000;
  assert.equal(w.tick(), true);
  assert.deepEqual(jumps, [60_000]);
  // A jump again 20 s later (a host too busy to tick): not another reconnect yet.
  t += 20_000;
  assert.equal(w.tick(), false);
  assert.equal(jumps.length, 1);
  // Just under the threshold is no jump at all.
  t += JUMP_MS;
  assert.equal(w.tick(), false);
  // Past MIN_GAP_MS since the last, a jump is said again.
  t += 20_000;
  assert.ok(t - 1_000_000 - 5 * TICK_MS - 60_000 >= MIN_GAP_MS);
  assert.equal(w.tick(), true);
  assert.equal(jumps.length, 2);
});

test("a watch whose reconnect throws goes on watching", () => {
  let t = 0;
  const w = new ClockJumpWatch({ now: () => t, onJump: () => { throw new Error('boom'); } });
  t += 20_000;
  assert.equal(w.tick(), true);
});

// A fake Convex client: what each one has subscribed, and whether it's closed.
function fakeClients() {
  const made: { subs: { fn: unknown; args: Record<string, unknown>; onUpdate: (v: unknown) => void; live: boolean }[]; closed: boolean }[] = [];
  const make = (): MinimalConvexClient => {
    const c = { subs: [] as (typeof made)[number]['subs'], closed: false };
    made.push(c);
    return {
      onUpdate: (fn, args, onUpdate) => {
        const s = { fn, args, onUpdate, live: true };
        c.subs.push(s);
        return () => (s.live = false);
      },
      close: async () => {
        c.closed = true;
      },
    };
  };
  return { made, make };
}

test('reconnect moves every live subscription to a new client and closes the old one', () => {
  const { made, make } = fakeClients();
  const sub = convexSubscriber('https://x.convex.cloud', make);
  // Nothing subscribed: nothing to reconnect.
  sub.reconnect!();
  assert.equal(made.length, 0);
  const got: unknown[] = [];
  const offA = sub.subscribe('sync:pendingCommands', { key: 'k' }, (v) => got.push(['a', v]), () => {});
  const offB = sub.subscribe('moves:moves', { key: 'k' }, (v) => got.push(['b', v]), () => {});
  offB();
  assert.equal(made.length, 1);
  sub.reconnect!();
  assert.equal(made.length, 2);
  assert.equal(made[0]!.closed, true);
  // Only the one still live came across, with its own arguments and callback.
  const live = made[1]!.subs;
  assert.equal(live.length, 1);
  assert.deepEqual(live[0]!.args, { key: 'k' });
  live[0]!.onUpdate(7);
  assert.deepEqual(got, [['a', 7]]);
  // Unsubscribing now ends it on the new client.
  offA();
  assert.equal(live[0]!.live, false);
  // And it's gone from what a later reconnect carries over.
  sub.reconnect!();
  assert.equal(made[2]!.subs.length, 0);
});

test('reconnectNow makes a new websocket and heartbeats at once, not at the next minute', async () => {
  const h = makeHarness();
  const beats: number[] = [];
  let reconnects = 0;
  const sync = new ConvexSync({
    config: { enabled: true, url: 'https://x.convex.cloud', name: 'TestMac', runnerId: 'r1' },
    key: 'k',
    runner: h.runner,
    version: '0.1.0+test',
    startedAt: '2026-10-27T00:00:00.000Z',
    clock: h.clock,
    log: nullLogger,
    post: async (_kind, fn) => {
      if (fn === 'sync:heartbeat') beats.push(h.clock.now());
      return null;
    },
    subscriber: { subscribe: () => () => {}, close: () => {}, reconnect: () => void reconnects++ },
  });
  // Not running: nothing.
  sync.reconnectNow('test');
  assert.equal(reconnects, 0);
  sync.start();
  await tick();
  assert.equal(beats.length, 1);
  h.clock.advance(5_000);
  sync.reconnectNow('clock jumped');
  await tick();
  assert.equal(reconnects, 1);
  assert.equal(beats.length, 2);
  // The minute's heartbeat runs from this one, not the old schedule.
  h.clock.advance(56_000);
  await tick();
  assert.equal(beats.length, 2);
  h.clock.advance(4_000);
  await tick();
  assert.equal(beats.length, 3);
  await sync.stop();
});
