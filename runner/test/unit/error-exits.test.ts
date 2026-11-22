import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import {
  ERROR_EXITS,
  ERROR_EXIT_WINDOW_MS,
  ERROR_QUIET_MS,
  decideErrorExit,
  errorExitsPath,
  errorMode,
  guardHolds,
  readErrorExits,
  takeErrorEnv,
  testThrow,
  writeErrorExits,
  type ErrorExitState,
} from '../../src/error-exits.ts';

const T0 = Date.parse('2026-11-21T00:00:00Z');
const MIN = 60_000;

test('the first errors restart, and the one after ERROR_EXITS in the window carries on and trips the guard', () => {
  let s: ErrorExitState = { exits: [] };
  for (let i = 0; i < ERROR_EXITS; i++) {
    const d = decideErrorExit(s, T0 + i * MIN);
    assert.equal(d.exit, true, `error ${i + 1} restarts`);
    assert.equal(d.tripped, false);
    s = d.state;
  }
  const d = decideErrorExit(s, T0 + ERROR_EXITS * MIN);
  assert.equal(d.exit, false);
  assert.equal(d.tripped, true);
  assert.ok(guardHolds(d.state, T0 + ERROR_EXITS * MIN));
});

test('restarts older than the window do not count', () => {
  const old = new Date(T0 - ERROR_EXIT_WINDOW_MS - 1).toISOString();
  const d = decideErrorExit({ exits: [old, old, old] }, T0);
  assert.equal(d.exit, true);
  assert.deepEqual(d.state.exits, [new Date(T0).toISOString()]);
});

test('while the guard holds every error carries on and pushes the quiet period out; an hour without one clears it', () => {
  let s = decideErrorExit({ exits: [0, 1, 2].map((i) => new Date(T0 + i * MIN).toISOString()) }, T0 + 3 * MIN).state;
  // Errors every 50 minutes keep it held.
  for (let i = 1; i <= 3; i++) {
    const d = decideErrorExit(s, T0 + 3 * MIN + i * 50 * MIN);
    assert.equal(d.exit, false);
    assert.equal(d.tripped, false);
    s = d.state;
  }
  assert.equal(s.tripped?.errors, 4);
  const last = Date.parse(s.tripped!.lastErrorAt);
  assert.ok(guardHolds(s, last + ERROR_QUIET_MS - 1));
  assert.ok(!guardHolds(s, last + ERROR_QUIET_MS));
  // After the quiet hour the next error restarts again, with a fresh count.
  const d = decideErrorExit(s, last + ERROR_QUIET_MS);
  assert.equal(d.exit, true);
  assert.equal(d.state.tripped, undefined);
  assert.equal(d.state.exits.length, 1);
});

test('a clock that went back does not count future restarts', () => {
  const future = new Date(T0 + 5 * MIN).toISOString();
  assert.equal(decideErrorExit({ exits: [future, future, future] }, T0).exit, true);
});

test('a clock that went back since the guard tripped lets it go', () => {
  const s: ErrorExitState = { exits: [], tripped: { at: new Date(T0).toISOString(), lastErrorAt: new Date(T0).toISOString(), errors: 1 } };
  assert.ok(guardHolds(s, T0 + MIN));
  assert.ok(!guardHolds(s, T0 - MIN));
});

test('the state round-trips through run/error-exits.json, and a broken file reads as no history', () => {
  const home = tmpDir();
  assert.deepEqual(readErrorExits(home), { exits: [] });
  const s = decideErrorExit({ exits: [] }, T0).state;
  writeErrorExits(home, s);
  assert.equal(errorExitsPath(home), path.join(home, 'run', 'error-exits.json'));
  assert.deepEqual(readErrorExits(home), s);
  fs.writeFileSync(errorExitsPath(home), '{not json');
  assert.deepEqual(readErrorExits(home), { exits: [] });
  fs.writeFileSync(errorExitsPath(home), JSON.stringify({ exits: ['nonsense', 3, new Date(T0).toISOString()], tripped: { at: 'x' } }));
  assert.deepEqual(readErrorExits(home), { exits: [new Date(T0).toISOString()] });
});

test("another release's count and guard don't carry over, so a fixed release starts clean", () => {
  const home = tmpDir();
  let s: ErrorExitState = readErrorExits(home, 'broken');
  for (let i = 0; i <= ERROR_EXITS; i++) s = decideErrorExit(s, T0 + i * MIN).state;
  assert.ok(s.tripped);
  assert.equal(s.release, 'broken');
  writeErrorExits(home, s);
  assert.deepEqual(readErrorExits(home, 'broken'), s);
  assert.deepEqual(readErrorExits(home, 'fixed'), { release: 'fixed', exits: [] });
  assert.deepEqual(readErrorExits(home), { exits: [] }, 'a checkout (no release) is another release too');
});

test('only a supervised runner restarts; a dev runner exits; anything else carries on', () => {
  assert.equal(errorMode({ supervised: true, devRunner: false }), 'restart');
  assert.equal(errorMode({ supervised: true, devRunner: true }), 'restart');
  assert.equal(errorMode({ supervised: false, devRunner: true }), 'exit');
  assert.equal(errorMode({ supervised: false, devRunner: false }), 'carry on');
});

test("the dev runner's and the test hook's variables are taken out of the environment, so CLIs and nested runners don't inherit them", () => {
  const env: NodeJS.ProcessEnv = { THREADBEAR_DEV_RUNNER: '1', THREADBEAR_TEST_THROW: 'exception', THREADBEAR_TEST_THROW_MS: '5', PATH: 'x' };
  const got = takeErrorEnv(env);
  assert.equal(got.devRunner, true);
  assert.deepEqual(got.hookEnv, { THREADBEAR_TEST_THROW: 'exception', THREADBEAR_TEST_THROW_MS: '5' });
  assert.deepEqual(env, { PATH: 'x' });
  assert.equal(takeErrorEnv({}).devRunner, false);
});

test('the test hook works only from a checkout on a data dir that is not the real one', () => {
  const realHome = path.join(tmpDir(), 'real');
  const home = tmpDir();
  assert.deepEqual(testThrow({ THREADBEAR_TEST_THROW: 'rejection', THREADBEAR_TEST_THROW_MS: '50' }, { release: undefined, home, realHome }), { kind: 'rejection', afterMs: 50 });
  assert.deepEqual(testThrow({ THREADBEAR_TEST_THROW: 'exception' }, { release: undefined, home, realHome }), { kind: 'exception', afterMs: 500 });
  assert.equal(testThrow({ THREADBEAR_TEST_THROW: 'exception' }, { release: '20261121T000000Z-abc', home, realHome }), undefined);
  assert.equal(testThrow({ THREADBEAR_TEST_THROW: 'exception' }, { release: undefined, home: realHome, realHome }), undefined);
  assert.equal(testThrow({ THREADBEAR_TEST_THROW: 'yes' }, { release: undefined, home, realHome }), undefined);
  assert.equal(testThrow({}, { release: undefined, home, realHome }), undefined);
});
