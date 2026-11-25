import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeClock } from '../../src/clock.ts';
import { WebRuntimeUpdates, inspectIndex, newestBindings, runtimeInstalled, PIN, DAY_MS } from '../../src/updates/web-runtime.ts';

const at = Date.parse('2026-11-13T00:00:00Z');
const version = (v: string, date: string, channel = 'stable') => ({ cef_version: v, channel, files: [{ type: 'minimal', last_modified: date }] });
const index = (...versions: unknown[]) => ({ macosarm64: { versions } });
const old = version(PIN, '2026-11-07T00:00:00Z');
const newer = '156.0.33+g57389f0+chromium-156.0.8078.105';

test('reports the earliest newer stable, ignoring beta and order', () => {
  const got = inspectIndex(index(version('158.0.1+gabc+chromium-158.0.8127.18', '2026-10-01', 'beta'), version(newer, '2026-11-11'), old, version('156.0.32+gabc+chromium-156.0.8078.100', '2026-11-10')), 'macosarm64', at);
  assert.equal(got.latest, newer);
  assert.equal(got.behindSince, Date.parse('2026-11-10'));
  assert.equal(inspectIndex(index(old), 'macosarm64', at).behindSince, undefined);
});

test('rejects missing, malformed and future stable metadata', () => {
  for (const value of [{}, index(), index(version('garbage', '2026-11-10')), index(version(newer, '2027-01-01'))]) {
    assert.throws(() => inspectIndex(value, 'macosarm64', at));
  }
});

test('warns after two weeks, retains warning offline and across restart, clears after recovery', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cef-'));
  const clock = new FakeClock(at);
  let offline = false;
  let current = false;
  const deps = { home, clock, platform: 'macosarm64', changed() {}, fetchBindings: async () => '', fetchIndex: async () => {
    if (offline) throw Error('offline');
    return current ? index(old) : index(old, version(newer, '2026-11-11'));
  } };
  try {
    let check = new WebRuntimeUpdates(deps);
    await check.check();
    assert.equal(check.problem(), undefined);
    clock.advance(14 * DAY_MS);
    assert.match(check.problem()!, /156.0.33/);
    offline = true;
    await check.check();
    check = new WebRuntimeUpdates(deps);
    assert.match(check.problem()!, /156.0.33/);
    offline = false; current = true;
    await check.check();
    assert.equal(check.problem(), undefined);
    check.stop();
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a broken check becomes visible, including on first use', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cef-'));
  const clock = new FakeClock(at);
  const check = new WebRuntimeUpdates({ home, clock, platform: 'macosarm64', changed() {}, fetchBindings: async () => '', fetchIndex: async () => { throw Error('offline'); } });
  try {
    await check.check();
    clock.advance(3 * DAY_MS);
    assert.match(check.problem()!, /Couldn't check/);
  } finally { check.stop(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('the monitor pin agrees with the runtime and bindings', () => {
  const core = fs.readFileSync(new URL('../../../desktop/core/src/web_runtime.rs', import.meta.url), 'utf8');
  assert.ok(core.includes(`pub const CEF_VERSION: &str = "${PIN}"`));
  const cargo = fs.readFileSync(new URL('../../../desktop/Cargo.lock', import.meta.url), 'utf8');
  const bindings = [...cargo.matchAll(/name = "cef(?:-dll-sys)?"\nversion = "([^"]+)"/g)];
  assert.equal(bindings.length, 2);
  for (const [, version] of bindings) assert.equal(version.split('+')[1], PIN.split('+')[0]);
});

test('historical builds without a minimal runtime do not break the check', () => {
  const got = inspectIndex(index(old, { channel: 'stable', cef_version: '136.1.1+g4dec9aa+chromium-136.0.7103.33', files: [] }), 'macosarm64', at);
  assert.equal(got.latest, PIN);
});

test('the daily timer honours its persisted attempt and stops', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cef-'));
  const clock = new FakeClock(at);
  let fetched = 0;
  const deps = { home, clock, platform: 'macosarm64', changed() {}, fetchBindings: async () => '', fetchIndex: async () => { fetched++; return index(old); } };
  let check = new WebRuntimeUpdates(deps);
  try {
    check.start(); clock.advance(60_000); await check.check();
    assert.equal(fetched, 1);
    check.stop(); check = new WebRuntimeUpdates(deps);
    check.start(); clock.advance(60_000); await Promise.resolve();
    assert.equal(fetched, 1);
    check.stop(); clock.advance(2 * DAY_MS);
    assert.equal(fetched, 1);
  } finally { check.stop(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('legacy CEF 3 builds in Intel history do not break freshness checks', () => {
  const raw = { macosx64: { versions: [old, version('3.3626.1895.g7001d56', '2019-03-14'), version(newer, '2026-11-11')] } };
  assert.equal(inspectIndex(raw, 'macosx64', at).latest, newer);
});

test('a clock corrected backwards checks again without overflowing the timer', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cef-'));
  const clock = new FakeClock(at);
  fs.mkdirSync(path.join(home, 'runner'));
  fs.writeFileSync(path.join(home, 'runner/web-runtime-check.json'), JSON.stringify({ pin: PIN, attemptedAt: at + 60 * DAY_MS }));
  let fetched = 0;
  const check = new WebRuntimeUpdates({ home, clock, platform: 'macosarm64', changed() {}, fetchBindings: async () => '', fetchIndex: async () => { fetched++; return index(old); } });
  try {
    check.start(); clock.advance(60_000); await check.check();
    assert.equal(fetched, 1);
    clock.advance(1000); await Promise.resolve();
    assert.equal(fetched, 1);
  } finally { check.stop(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('no CDN request or warning until a runtime is installed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cef-'));
  const root = path.join(home, 'web-runtime');
  const clock = new FakeClock(at);
  let fetched = 0;
  const check = new WebRuntimeUpdates({ home, clock, platform: 'macosarm64', installed: () => runtimeInstalled(root), changed() {}, fetchBindings: async () => '', fetchIndex: async () => { fetched++; return index(old); } });
  try {
    await check.check(); assert.equal(fetched, 0);
    assert.equal(check.problem(), undefined);
    fs.mkdirSync(path.join(root, PIN), { recursive: true });
    fs.writeFileSync(path.join(root, PIN, 'installed.json'), '{}');
    await check.check(); assert.equal(fetched, 1);
  } finally { check.stop(); fs.rmSync(home, { recursive: true, force: true }); }
});

const crate = (vers: string, yanked = false) => JSON.stringify({ name: 'cef', vers, yanked });

test('reads the newest CEF cef-rs binds, skipping yanked and prerelease crates', () => {
  const text = [crate('156.6.0+156.0.30'), crate('156.9.0+156.0.40', true), crate('157.0.0-beta+157.0.1'), 'not json', crate('156.7.0+156.0.31'), ''].join('\n');
  assert.equal(newestBindings(text), '156.0.31');
  assert.equal(newestBindings(''), undefined);
});

test('only notes waiting on cef-rs when no bindings are newer than the pin, and flags an update when some are', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cef-'));
  const clock = new FakeClock(at);
  const stable = '158.0.3+g8c29be2+chromium-158.0.8127.18';
  let crates = [crate(`156.7.0+${PIN.split('+')[0]}`)];
  let failing = false;
  const check = new WebRuntimeUpdates({ home, clock, platform: 'macosarm64', changed() {},
    fetchIndex: async () => index(old, version(stable, '2026-11-12')),
    fetchBindings: async () => { if (failing) throw Error('offline'); return crates.join('\n'); } });
  try {
    await check.check();
    clock.advance(14 * DAY_MS);
    // Nothing anyone can do: a quiet note, not a flagged problem.
    assert.equal(check.problem(), undefined);
    assert.equal(check.note(), `Web runtime: CEF ${PIN.split('+')[0]} is over two weeks behind stable 158.0.3. Waiting on cef-rs to support 158.0.3. Chromium's sandbox is off.`);
    crates = [...crates, crate('158.0.0+158.0.3')];
    await check.check();
    assert.match(check.problem()!, /Ask your agent to update it to 158\.0\.3, the newest cef-rs supports\./);
    assert.equal(check.note(), undefined);
    failing = true;
    await check.check();
    assert.match(check.problem()!, /update it to 158\.0\.3/, 'a failed crates check keeps the last answer');
  } finally { check.stop(); fs.rmSync(home, { recursive: true, force: true }); }
});
