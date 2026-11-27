// scripts/host-turn.sh, how a check takes its turn on a check host. On 23 Nov
// landings' checks waited 2.6 hours on Tinker Desk behind agents' builds and
// checks that came in after them, with every landing in the line waiting too:
// now a landing's check ("first") goes ahead of anything else waiting there.
// Real kernel locks (lockf on a Mac, flock on Linux) in a temp folder, and
// commands that only write a line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { PATIENCE_MS } from '../helpers/patience.ts';

const SCRIPT = path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'host-turn.sh');
const skip = process.platform === 'win32' ? 'lockf and flock are Mac and Linux tools' : false;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, message: string) {
  const end = Date.now() + PATIENCE_MS;
  while (Date.now() < end) {
    if (check()) return;
    await pause(40);
  }
  assert.fail(message);
}

type Run = ChildProcess & { output: string; done: Promise<number | null> };
function host(t: { after: (f: () => void) => void }) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-host-turn-'));
  const kids: ChildProcess[] = [];
  t.after(() => {
    for (const k of kids) k.kill('SIGKILL');
    fs.rmSync(base, { recursive: true, force: true });
  });
  const order = path.join(base, 'order');
  const said = () => (fs.existsSync(order) ? fs.readFileSync(order, 'utf8').trim().split('\n') : []);
  // A run whose command, like --on-host, drops its first/ mark once it has
  // the host, then says it started and holds the host until its end file is
  // there.
  const turn = (kind: string, when: string, id: string, env?: NodeJS.ProcessEnv): Run => {
    const cmd = `rm -f first/${id}; echo ${id} >>order; while [ ! -e end-${id} ]; do sleep 0.05; done`;
    // The command runs where host-turn.sh was started (ssh's $HOME on a host),
    // here the check folder, so its paths are from there.
    const child = spawn('/bin/bash', [SCRIPT, kind, when, base, id, 'testhost', cmd], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] }) as Run;
    child.output = '';
    child.stdout!.on('data', (s) => { child.output += s; });
    child.stderr!.on('data', (s) => { child.output += s; });
    child.done = new Promise((r) => child.on('exit', r));
    kids.push(child);
    return child;
  };
  const end = (id: string) => fs.writeFileSync(path.join(base, `end-${id}`), '');
  // Something else holding a file's lock (the gate, or a first/ mark) until killed.
  const hold = async (rel: string): Promise<ChildProcess> => {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]) or die $!; flock($f, LOCK_EX) or die $!; $| = 1; print "held\\n"; sleep 300', path.join(base, rel)], { stdio: ['ignore', 'pipe', 'ignore'] });
    kids.push(holder);
    await new Promise<void>((r) => holder.stdout!.once('data', () => r()));
    return holder;
  };
  // Whether someone holds a file's lock, as host-turn.sh asks it.
  const held = (rel: string): boolean => {
    const file = path.join(base, rel);
    if (!fs.existsSync(file)) return false;
    const probe = process.platform === 'darwin' ? spawnSync('/usr/bin/lockf', ['-t', '0', '-k', file, 'true']) : spawnSync('flock', ['-n', '-E', '75', file, 'true']);
    return probe.status === 75;
  };
  return { base, turn, end, hold, said, held };
}

test("a landing's check waiting on a busy host goes before a check that was waiting there first", { skip }, async (t) => {
  const h = host(t);
  const busy = await h.hold('gate');
  const other = h.turn('after', 'wait', 'other');
  await until(() => other.output.includes('Waiting for another check on testhost'), 'the other check did not wait');
  const landing = h.turn('first', 'wait', 'landing');
  await until(() => h.held('first/landing'), "the landing's check didn't mark itself");
  busy.kill('SIGKILL');
  await until(() => h.said().length > 0, 'nothing started once the host was free');
  assert.deepEqual(h.said(), ['landing']);
  // Still the landing's alone as it ends: the other never ran beside it.
  assert.equal(landing.exitCode, null);
  assert.deepEqual(h.said(), ['landing'], 'the other check ran beside the landing');
  h.end('landing');
  assert.equal(await landing.done, 0, landing.output);
  await until(() => h.said().length === 2, 'the other check did not start after the landing');
  assert.deepEqual(h.said(), ['landing', 'other']);
  h.end('other');
  assert.equal(await other.done, 0, other.output);
});

test("a check that would start at once on a free host leaves it to a landing's check waiting there", { skip }, async (t) => {
  const h = host(t);
  const mark = await h.hold('first/waiting-landing');
  const now = h.turn('after', 'now', 'now');
  assert.equal(await now.done, 75, now.output);
  assert.deepEqual(h.said(), []);
  // And one waiting its turn lets it go first, saying so, then runs.
  const waits = h.turn('after', 'wait', 'waits');
  await until(() => waits.output.includes("Letting a landing's check go first on testhost"), 'it did not say it let the landing go first');
  assert.deepEqual(h.said(), []);
  mark.kill('SIGKILL');
  await until(() => h.said().includes('waits'), 'it did not start once the landing had gone');
  h.end('waits');
  assert.equal(await waits.done, 0, waits.output);
});

test("a check already through the gate, waiting for builds to finish, still lets a landing's check go first", { skip }, async (t) => {
  // A build holds the check lock shared (perf-lock.pl), and with two at once
  // a check through the gate waited out a whole build ahead of a landing.
  const h = host(t);
  const build = await h.hold('lock');
  const other = h.turn('after', 'wait', 'other');
  await until(() => other.output.includes('Waiting for another check on testhost'), 'the other check did not wait');
  // Through the gate, waiting for the check lock: the gate is taken.
  await until(() => h.held('gate'), 'the other check never took the gate');
  const landing = h.turn('first', 'wait', 'landing');
  await until(() => h.held('first/landing'), "the landing's check didn't mark itself");
  await until(() => other.output.includes("Letting a landing's check go first"), 'the other check kept the gate');
  build.kill('SIGKILL');
  await until(() => h.said().length > 0, 'nothing started once the build ended');
  assert.deepEqual(h.said(), ['landing']);
  h.end('landing');
  assert.equal(await landing.done, 0, landing.output);
  await until(() => h.said().length === 2, 'the other check did not start after the landing');
  h.end('other');
  assert.equal(await other.done, 0, other.output);
});

test('waiting for the check lock says why once without printing every failed lock attempt', { skip }, async (t) => {
  const h = host(t);
  const bin = path.join(h.base, 'bin');
  const retries = path.join(h.base, 'retries');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nif [ "$1" = 1 ]; then printf x >>"$THREADBEAR_TEST_RETRIES"; fi\nexec /bin/sleep "$@"\n', { mode: 0o755 });
  const busy = await h.hold('lock');
  const waits = h.turn('after', 'wait', 'waits', { ...process.env, PATH: `${bin}:${process.env.PATH}`, THREADBEAR_TEST_RETRIES: retries });
  await until(() => waits.output.includes('Waiting for another check on testhost'), 'the check never explained its wait');
  await until(() => h.held('gate'), 'the check never started waiting on the check lock');
  await until(() => fs.existsSync(retries) && fs.readFileSync(retries, 'utf8').length >= 2, 'the lock was not tried twice');
  assert.doesNotMatch(waits.output, /already locked/);
  assert.equal(waits.output.match(/Waiting for another check/g)?.length, 1);
  assert.deepEqual(h.said(), []);
  busy.kill('SIGKILL');
  await until(() => h.said().includes('waits'), 'the waiting check did not run once the lock was free');
  h.end('waits');
  assert.equal(await waits.done, 0, waits.output);
});

test('a broken lock path still reports its error rather than looking like a busy host', { skip }, async (t) => {
  const h = host(t);
  fs.symlinkSync(path.join(h.base, 'missing', 'lock'), path.join(h.base, 'lock'));
  const run = h.turn('first', 'now', 'broken');
  const code = await run.done;
  assert.notEqual(code, 0);
  assert.notEqual(code, 75);
  assert.match(run.output, /cannot open|failed to open|No such file/i);
  assert.deepEqual(h.said(), []);
});

test('the command runs in the folder it was started from, not the check folder', { skip }, async (t) => {
  // A --shots run's pidfile is a path from ssh's $HOME (Codex's review).
  const h = host(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-host-turn-cwd-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  for (const [kind, when] of [['first', 'now'], ['first', 'wait'], ['after', 'now'], ['after', 'wait']]) {
    const r = spawn('/bin/bash', [SCRIPT, kind, when, h.base, `cwd-${kind}-${when}`, 'testhost', 'pwd -P >"$0/cwd"'.replace('$0', fs.realpathSync(elsewhere))], { cwd: elsewhere, stdio: 'ignore' });
    assert.equal(await new Promise((res) => r.on('exit', res)), 0, `${kind} ${when}`);
    assert.equal(fs.readFileSync(path.join(elsewhere, 'cwd'), 'utf8').trim(), fs.realpathSync(elsewhere), `${kind} ${when}`);
  }
});

test('a mark nobody holds (its run was killed) holds nothing up', { skip }, async (t) => {
  const h = host(t);
  fs.mkdirSync(path.join(h.base, 'first'));
  fs.writeFileSync(path.join(h.base, 'first', 'killed-run'), '');
  const now = h.turn('after', 'now', 'now');
  await until(() => h.said().includes('now'), 'it did not start');
  h.end('now');
  assert.equal(await now.done, 0, now.output);
});

test("the command's own exit comes back, and a landing's check on a free host starts at once", { skip }, async (t) => {
  const h = host(t);
  for (const kind of ['first', 'after']) {
    for (const when of ['now', 'wait']) {
      const r = spawn('/bin/bash', [SCRIPT, kind, when, h.base, `x-${kind}-${when}`, 'testhost', 'exit 3'], { stdio: 'ignore' });
      assert.equal(await new Promise((res) => r.on('exit', res)), 3, `${kind} ${when}`);
    }
  }
  // Taken already: now is 75, for a landing's check too.
  const busy = await h.hold('lock');
  const r = spawn('/bin/bash', [SCRIPT, 'first', 'now', h.base, 'y', 'testhost', 'exit 0'], { stdio: 'ignore' });
  assert.equal(await new Promise((res) => r.on('exit', res)), 75);
  busy.kill('SIGKILL');
});

test('every lockf it runs keeps its file, so a waiter and a later run lock the same one', () => {
  // Without -k lockf deletes the file when it's done: a run waiting on the
  // old one and a new one on its replacement would both have "the" lock.
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const uses = [...text.matchAll(/\/usr\/bin\/lockf([^)\n]*)/g)];
  assert.ok(uses.length >= 2);
  for (const u of uses) assert.match(u[1], /(^|\s)-k(\s|$)/, u[0]);
});
