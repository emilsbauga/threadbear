// scripts/perf-lock.pl with real kernel locks and harmless sleeping children,
// never a build or a window: queues, Desk Runner's runs, builds side by side,
// and a landing's check going first. helpers/perf-lock-harness.ts says why it's
// five files.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { helper, pause, until, host } from '../helpers/perf-lock-harness.ts';
import { test, type TestContext } from 'node:test';

test('queued remote copies and targets stay marked in use before the host locks are acquired', async (t) => {
  const h = host(t);
  const source = path.join(h.home, 'src-copy');
  const target = path.join(h.home, 'target-copy');
  for (const dir of [source, target]) { fs.mkdirSync(dir); fs.utimesSync(dir, 1, 1); }
  const first = h.run(['sh', '-c', 'echo ready; sleep 1']);
  await until(() => first.output.includes('ready'), 'first did not start');
  const next = h.run(['true'], { THREADBEAR_REMOTE_SOURCE: source, THREADBEAR_REMOTE_TARGET: target });
  await until(() => next.output.includes('Waiting'), 'next did not wait');
  for (const dir of [source, target]) {
    assert.ok(fs.existsSync(path.join(dir, '.in-use')));
    assert.ok(Date.now() - fs.statSync(dir).mtimeMs < 5000);
  }
  assert.equal(await next.done, 0, next.output);
});

test('a measurement joins the blocking check queue ahead of later checks', async (t) => {
  const h = host(t);
  const base = path.join(h.home, '.cache/threadbear-check');
  fs.mkdirSync(base, { recursive: true });
  const lock = path.join(base, 'lock');
  const order = path.join(h.home, 'order');
  const first = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]); flock($f, LOCK_EX); $|=1; print "ready\\n"; sleep 2', lock]);
  let output = '';
  first.stdout!.on('data', (s) => { output += s; });
  await until(() => output.includes('ready'), 'first check did not start');
  const measurement = h.run(['sh', '-c', 'echo measured >> "$1"; sleep .2', 'sh', order]);
  await until(() => measurement.output.includes('Waiting'), 'measurement did not queue');
  await pause(150);
  const later = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]); flock($f, LOCK_EX); open(my $o, ">>", $ARGV[1]); print {$o} "later\\n";', lock, order]);
  const done = new Promise((r) => later.on('exit', r));
  assert.equal(await measurement.done, 0, measurement.output);
  assert.equal(await done, 0);
  assert.equal(fs.readFileSync(order, 'utf8'), 'measured\nlater\n');
});

test('a successful shell command cannot leave background work holding the host after unlock', async (t) => {
  const h = host(t);
  const pidfile = path.join(h.home, 'background.pid');
  const run = h.run(['sh', '-c', 'sleep 60 & echo $! > "$1"', 'sh', pidfile]);
  assert.equal(await run.done, 0, run.output);
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  assert.throws(() => process.kill(pid, 0));
});

test('a Desk client finishing early cannot release locks while its GUI workload lives', async (t) => {
  const h = host(t);
  const bin = path.join(h.home, '.local/bin');
  const appPid = path.join(h.home, 'app.pid');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'desk'), '#!/bin/bash\nbash -c "$1" >"$HOME/desk.log" 2>&1 </dev/null &\nfor i in {1..100}; do [ ! -f "$HOME/app.pid" ] || exit 0; sleep .02; done\nexit 1\n', { mode: 0o755 });
  const first = h.run(['sh', '-c', 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done', 'sh', appPid], {}, path.join(h.home, 'desk.pid'));
  await until(() => fs.existsSync(appPid), 'GUI workload did not start');
  const pid = Number(fs.readFileSync(appPid, 'utf8'));
  const next = h.run(['true']);
  await until(() => next.output.includes('Waiting'), 'early Desk client exit released the turn');
  assert.equal(await first.done, 0, first.output);
  assert.equal(await next.done, 0, next.output);
  assert.throws(() => process.kill(pid, 0));
});

// 18 Nov: perl --child sat under Desk Runner for 41 minutes, never reaching
// the bash that writes the pidfile, and outlived its ssh. Desk Runner starts
// the line outside the guard's tree and the wrapper leaves its group, so the
// pidfile is the only way the guard can find it: it has to be written first.
test('a Desk run held up before its command still stops when the ssh goes', async (t) => {
  const h = host(t);
  const bin = path.join(h.home, '.local/bin');
  const stall = path.join(h.home, 'stall');
  const stalled = path.join(h.home, 'stalled.pid');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(stall);
  // Like Desk Runner: the line runs away from the client (reparented, out of
  // the guard's tree, without the client's fd 197, which would let the
  // reaper find it), and the client waits until it is stopped itself.
  fs.writeFileSync(path.join(bin, 'desk'), `#!/bin/bash\nexec 197<&-\nPATH="$HOME/stall:$PATH" perl -e 'fork and exit; open(STDIN, "<", "/dev/null"); exec @ARGV' /bin/bash -c "$1"\nexec sleep 600\n`, { mode: 0o755 });
  // perf-children.pl --child never gets anywhere, as on Tinker Desk.
  fs.writeFileSync(path.join(stall, 'perl'), `#!/bin/bash\nif [ "\${2:-}" = --child ]; then echo $$ >"$HOME/stalled.pid"; exec sleep 600; fi\nexec /usr/bin/perl "$@"\n`, { mode: 0o755 });
  const pidfile = path.join(h.home, 'desk.pid');
  const run = h.run(['sh', '-c', 'echo never', 'sh'], {}, pidfile);
  await until(() => fs.existsSync(stalled), 'the desk line did not start');
  const pid = Number(fs.readFileSync(stalled, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  assert.equal(fs.readFileSync(pidfile, 'utf8').trim(), String(pid));
  run.stdin!.end();
  await run.done;
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'the held-up desk run outlived its ssh');
  assert.doesNotMatch(run.output, /never/);
});

// From 17 Nov Tinker Desk's build folders were on an SSD Desk Runner hadn't
// been allowed to read, and macOS held its open() there with nobody to ask.
// A FIFO with no writer blocks an open the same way.
test('a Desk run that cannot read its folders says why instead of hanging', { skip: process.platform === 'win32' }, async (t) => {
  const h = host(t);
  const bin = path.join(h.home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'desk'), '#!/bin/sh\nexec env -i HOME="$HOME" PATH="$PATH" /bin/bash -c "$1"\n', { mode: 0o755 });
  const blocked = path.join(h.home, 'blocked');
  assert.equal(spawnSync('mkfifo', [blocked]).status, 0);
  const ran = path.join(h.home, 'ran');
  const pidfile = path.join(h.home, 'desk.pid');
  const run = h.run(['sh', '-c', 'touch "$1"', 'sh', ran], { THREADBEAR_REMOTE_SOURCE: blocked, THREADBEAR_DESK_READ_SECONDS: '1' }, pidfile);
  assert.equal(await run.done, 126, run.output);
  assert.match(run.output, /Desk Runner couldn't open .*blocked.*Removable Volumes/);
  assert.ok(!fs.existsSync(ran));
  // remote.sh's pidfile is on that same disk, so it's only written after the check.
  assert.ok(!fs.existsSync(pidfile), 'the pidfile was written before the folders were checked');
});

// A refusal that comes at once (permission denied, or a privacy prompt
// already answered No) stops the run too, rather than counting as a pass.
test('a Desk run refused its folders outright says so and does not start', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
  const h = host(t);
  const bin = path.join(h.home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'desk'), '#!/bin/sh\nexec env -i HOME="$HOME" PATH="$PATH" /bin/bash -c "$1"\n', { mode: 0o755 });
  const shut = path.join(h.home, 'shut');
  fs.mkdirSync(shut, { mode: 0o000 });
  const ran = path.join(h.home, 'ran');
  const run = h.run(['sh', '-c', 'touch "$1"', 'sh', ran], { THREADBEAR_REMOTE_SOURCE: shut }, path.join(h.home, 'desk.pid'));
  // Back before the home's own cleanup, which can't empty a shut folder.
  try { assert.equal(await run.done, 126, run.output); } finally { fs.chmodSync(shut, 0o700); }
  assert.match(run.output, /Desk Runner couldn't open .*shut \(Permission denied\)/);
  assert.ok(!fs.existsSync(ran));
});

// Builds side by side (remote.sh --build), on a host that allows it: Mike
// asked on 18 Nov, as threads queued behind each other's builds on Tinker
// Desk all day. A command that runs until a file appears, so a test decides
// when each one ends.
function builds(t: TestContext, atOnce?: number) {
  const h = host(t);
  if (atOnce) {
    fs.mkdirSync(path.join(h.home, '.cache/threadbear-check'), { recursive: true });
    fs.writeFileSync(path.join(h.home, '.cache/threadbear-check/builds-at-once'), `${atOnce}\n`);
  }
  const shim = path.join(h.home, 'build.pl');
  fs.writeFileSync(shim, `exec 'perl', ${JSON.stringify(helper)}, '--build', @ARGV;`);
  const until = (name: string) => ['sh', '-c', `echo ${name} started; while [ ! -e "$HOME/end-${name}" ]; do sleep 0.05; done; echo ${name} ended`];
  const end = (name: string) => fs.writeFileSync(path.join(h.home, `end-${name}`), '');
  const build = (name: string) => h.run(until(name), {}, undefined, false, shim);
  const alone = (name: string) => h.run(until(name));
  return { h, build, alone, end };
}

test('two builds share a host that allows two at once, and a third waits for a lane', async (t) => {
  const { build, end } = builds(t, 2);
  const a = build('a');
  await until(() => a.output.includes('a started'), 'a did not start');
  const b = build('b');
  await until(() => b.output.includes('b started'), 'b did not start beside a');
  const c = build('c');
  await until(() => c.output.includes('Waiting for one of the 2 builds'), 'c did not wait for a lane');
  assert.doesNotMatch(c.output, /c started/);
  end('a');
  await until(() => c.output.includes('c started'), 'c did not start when a lane came free');
  end('b'); end('c');
  for (const r of [a, b, c]) assert.equal(await r.done, 0, r.output);
});

test('with no builds-at-once a build has the host alone, as before', async (t) => {
  const { build, end } = builds(t);
  const a = build('a');
  await until(() => a.output.includes('a started'), 'a did not start');
  const b = build('b');
  await until(() => b.output.includes('Waiting for'), 'b did not wait');
  assert.doesNotMatch(b.output, /b started/);
  end('a'); end('b');
  assert.equal(await a.done, 0, a.output);
  assert.equal(await b.done, 0, b.output);
});

test('a measurement waiting for builds keeps new builds out, so builds can never starve it', async (t) => {
  // macOS's flock grants a shared lock while an exclusive one waits; the gate
  // is what makes the measurement next.
  const { build, alone, end } = builds(t, 2);
  const a = build('a');
  await until(() => a.output.includes('a started'), 'a did not start');
  const m = alone('m');
  await until(() => m.output.includes('Waiting for'), 'm did not wait for the build');
  assert.match(m.output, /running: sh -c echo a started/, 'm said which build it waits for');
  const b = build('b');
  await until(() => b.output.includes('Waiting for'), 'b did not wait behind m');
  await pause(500);
  assert.doesNotMatch(b.output, /b started/, 'b jumped ahead of the waiting measurement');
  end('a');
  await until(() => m.output.includes('m started'), 'm did not start once a ended');
  assert.doesNotMatch(b.output, /b started/, 'b ran beside the measurement');
  end('m');
  await until(() => b.output.includes('b started'), 'b did not start after m');
  end('b');
  for (const r of [a, m, b]) assert.equal(await r.done, 0, r.output);
});

test("a check waiting at the gate keeps new builds out too", async (t) => {
  // check-remote.sh's checks take the gate, then the check lock, with lockf.
  const { h, build, end } = builds(t, 2);
  const a = build('a');
  await until(() => a.output.includes('a started'), 'a did not start');
  const base = path.join(h.home, '.cache/threadbear-check');
  const check = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $g, ">>", $ARGV[0]) or die $!; flock($g, LOCK_EX) or die $!; open(my $l, ">>", $ARGV[1]) or die $!; flock($l, LOCK_EX) or die $!; $|=1; print "checking\\n"; sleep 1', path.join(base, 'gate'), path.join(base, 'lock')], { stdio: ['ignore', 'pipe', 'inherit'] });
  let said = '';
  check.stdout!.on('data', (s) => { said += s; });
  const checked = new Promise((r) => check.on('exit', r));
  await pause(300);
  const b = build('b');
  await until(() => b.output.includes('Waiting for'), 'b did not wait behind the check');
  assert.equal(said, '', 'the check ran beside a build');
  end('a');
  await until(() => said.includes('checking'), 'the check did not start once a ended');
  assert.doesNotMatch(b.output, /b started/);
  assert.equal(await checked, 0);
  await until(() => b.output.includes('b started'), 'b did not start after the check');
  end('b');
  assert.equal(await b.done, 0, b.output);
});

test('a measurement inside a shared build refuses rather than waiting for itself', async (t) => {
  const { h } = builds(t, 2);
  const shim = path.join(h.home, 'build.pl');
  const inner = h.run(['perl', helper, '-', 'sh', '-c', 'echo measured'], {}, undefined, false, shim);
  assert.notEqual(await inner.done, 0, inner.output);
  assert.match(inner.output, /inside a build that shares/);
  assert.doesNotMatch(inner.output, /measured/);
  const nested = h.run(['perl', helper, '--build', '-', 'sh', '-c', 'echo built'], {}, undefined, false, shim);
  assert.equal(await nested.done, 0, nested.output);
  assert.match(nested.output, /built/);
});

test('an update build joins a shared host without queueing, and defers when it would have to', async (t) => {
  const { h, build, end } = builds(t, 2);
  const shim = path.join(h.home, 'try-build.pl');
  fs.writeFileSync(shim, `exec 'perl', ${JSON.stringify(helper)}, '--build', '--try', @ARGV;`);
  const a = build('a');
  await until(() => a.output.includes('a started'), 'a did not start');
  const joined = h.run(['sh', '-c', 'echo updater-ran'], {}, undefined, false, shim);
  assert.equal(await joined.done, 0, joined.output);
  assert.match(joined.output, /updater-ran/);
  const b = build('b');
  await until(() => b.output.includes('b started'), 'b did not start');
  const full = h.run(['sh', '-c', 'echo updater-ran'], {}, undefined, false, shim);
  assert.equal(await full.done, 75, full.output);
  assert.doesNotMatch(full.output, /updater-ran/);
  end('a'); end('b');
  assert.equal(await a.done, 0);
  assert.equal(await b.done, 0);
});

test("a measurement from an older perf-lock.pl, waiting without the gate, still goes before new builds", async (t) => {
  // Its note has no "gate" line: it waits on the perf lock itself.
  const { h, build, end } = builds(t, 2);
  const waiting = path.join(h.home, '.cache/threadbear-perf.lock.waiting');
  fs.mkdirSync(waiting, { recursive: true });
  const note = path.join(waiting, String(process.pid));
  fs.writeFileSync(note, `${Math.floor(Date.now() / 1000)}\n`);
  const a = build('a');
  await until(() => a.output.includes('older checkout go first'), 'a did not let the older measurement go first');
  assert.doesNotMatch(a.output, /a started/);
  fs.rmSync(note);
  await until(() => a.output.includes('a started'), 'a did not start once it had gone');
  // A note from this version (through the gate) doesn't hold a build up.
  fs.writeFileSync(note, `${Math.floor(Date.now() / 1000)}\ngate\n`);
  const b = build('b');
  await until(() => b.output.includes('b started'), 'b waited for a gated note');
  fs.rmSync(note);
  end('a'); end('b');
  assert.equal(await a.done, 0, a.output);
  assert.equal(await b.done, 0, b.output);
});

// A landing's check, or the app's update build, waiting on the host goes
// ahead of builds and measurements (scripts/host-turn.sh's first/ marks).
// 24 Nov: landings waited hours behind agents' builds on Tinker Desk, and the
// update build was put off 1,162 times in 1,350 tries.
async function holdMark(t: TestContext, home: string, name: string) {
  const dir = path.join(home, '.cache/threadbear-check/first');
  fs.mkdirSync(dir, { recursive: true });
  const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]) or die $!; flock($f, LOCK_EX) or die $!; $|=1; print "held\\n"; sleep 300', path.join(dir, name)], { stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(() => holder.kill('SIGKILL'));
  await new Promise((r) => holder.stdout!.once('data', r));
  return holder;
}

test("a build lets a landing's check waiting on the host go first, and an updater defers to it", async (t) => {
  const { h, build, end } = builds(t, 2);
  const mark = await holdMark(t, h.home, '0738141-123-0');
  const a = build('a');
  await until(() => a.output.includes("Letting a landing's check or the app's update build go first"), 'a did not let the landing go first');
  assert.doesNotMatch(a.output, /a started/);
  const shim = path.join(h.home, 'try.pl');
  fs.writeFileSync(shim, `exec 'perl', ${JSON.stringify(helper)}, '--build', '--try', @ARGV;`);
  const updater = h.run(['sh', '-c', 'echo updater-ran'], {}, undefined, false, shim);
  assert.equal(await updater.done, 75, updater.output);
  // A mark nobody holds any more (its run was killed) holds nothing up.
  mark.kill('SIGKILL');
  await until(() => a.output.includes('a started'), 'a did not start once the landing had gone');
  end('a');
  assert.equal(await a.done, 0, a.output);
});

test("the app's update build goes ahead of builds waiting before it, and doesn't defer to them", async (t) => {
  // One build at a time, so each waits at the gate.
  const { h, build, end } = builds(t);
  const shim = path.join(h.home, 'build.pl');
  const first = { THREADBEAR_PERF_LOCK_FIRST: '1' };
  const a = build('a');
  await until(() => a.output.includes('a started'), 'a did not start');
  const b = build('b');
  await until(() => b.output.includes('Waiting for'), 'b did not wait behind a');
  const until2 = (name: string) => ['sh', '-c', `echo ${name} started; while [ ! -e "$HOME/end-${name}" ]; do sleep 0.05; done; echo ${name} ended`];
  const u = h.run(until2('u'), first, undefined, false, shim);
  const marks = () => { try { return fs.readdirSync(path.join(h.home, '.cache/threadbear-check/first')); } catch { return []; } };
  await until(() => marks().length === 1, 'the update build left no mark');
  end('a');
  await until(() => u.output.includes('u started'), 'the update build did not start once a ended');
  assert.doesNotMatch(b.output, /b started/, 'b went ahead of the update build');
  // In, its mark is gone.
  assert.deepEqual(marks(), []);
  end('u');
  await until(() => b.output.includes('b started'), 'b did not start after the update build');
  end('b');
  for (const r of [a, u, b]) assert.equal(await r.done, 0, r.output);
  // As a try, it runs ahead of a run that's only queued, rather than deferring.
  const waiting = path.join(h.home, '.cache/threadbear-perf.lock.waiting');
  fs.mkdirSync(waiting, { recursive: true });
  fs.writeFileSync(path.join(waiting, String(process.pid)), `${Math.floor(Date.now() / 1000)}\ngate\n`);
  const tryShim = path.join(h.home, 'try-first.pl');
  fs.writeFileSync(tryShim, `exec 'perl', ${JSON.stringify(helper)}, '--build', '--try', @ARGV;`);
  const tried = h.run(['sh', '-c', 'echo updater-ran'], first, undefined, false, tryShim);
  assert.equal(await tried.done, 0, tried.output);
  assert.match(tried.output, /updater-ran/);
});

test("a measurement through the gate, waiting for builds to end, gives the gate to a landing's check", async (t) => {
  // With two builds at once, a run through the gate waited out a whole build
  // ahead of a landing's check (Codex's review, 24 Nov).
  const { h, build, alone, end } = builds(t, 2);
  const a = build('a');
  await until(() => a.output.includes('a started'), 'a did not start');
  const m = alone('m');
  await until(() => m.output.includes('Waiting for'), 'm did not wait for the build');
  const mark = await holdMark(t, h.home, 'landing-run');
  await until(() => m.output.includes("Letting a landing's check or the app's update build go first"), 'm kept the gate');
  // The gate is free for the landing's check now.
  const gate = path.join(h.home, '.cache/threadbear-check/gate');
  await until(() => spawnSync('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]) or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)', gate]).status === 0, 'the gate stayed taken');
  mark.kill('SIGKILL');
  end('a');
  await until(() => m.output.includes('m started'), 'm did not start once the landing and a had gone');
  end('m');
  for (const r of [a, m]) assert.equal(await r.done, 0, r.output);
});
