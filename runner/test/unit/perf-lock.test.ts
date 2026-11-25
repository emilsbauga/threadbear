// scripts/perf-lock.pl with real kernel locks and harmless sleeping children,
// never a build or a window: who waits for whom, and what a signal to the
// holder leaves held. helpers/perf-lock-harness.ts says why it's five files.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, helper, pause, until, host } from '../helpers/perf-lock-harness.ts';
import { test } from 'node:test';

test('measurements wait, explain why, and keep both locks for their whole run', async (t) => {
  const h = host(t);
  const first = h.run(['sh', '-c', 'echo first; sleep 1']);
  await until(() => first.output.includes('first'), 'first did not start');
  const second = h.run(['sh', '-c', 'echo second']);
  await until(() => second.output.includes('Waiting for'), 'no waiting message');
  assert.ok(!second.output.includes('second'));
  assert.equal(await first.done, 0);
  assert.equal(await second.done, 0);
  assert.match(second.output, /second/);
});

test('an updater defers without queueing when either host lock is busy', async (t) => {
  const h = host(t);
  for (const name of ['.cache/threadbear-perf.lock', '.cache/threadbear-check/lock']) {
    fs.mkdirSync(path.dirname(path.join(h.home, name)), { recursive: true });
    const holder = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]) or die $!; flock($f, LOCK_EX) or die $!; $|=1; print "held\\n"; sleep 60', path.join(h.home, name)]);
    const done = new Promise((resolve) => holder.on('exit', resolve));
    t.after(() => holder.kill());
    await new Promise((resolve) => holder.stdout!.once('data', resolve));
    // h.run adds the pidfile argument; put --try before it in a tiny shim.
    const shim = path.join(h.home, 'try.pl');
    fs.writeFileSync(shim, `exec 'perl', ${JSON.stringify(helper)}, '--try', @ARGV;`);
    const updater = h.run(['sh', '-c', 'echo updater-ran'], {}, undefined, false, shim);
    const result = await Promise.race([updater.done, pause(2000).then(() => 'queued')]);
    if (result === 'queued') updater.stdin!.end();
    assert.equal(result, 75, updater.output);
    assert.doesNotMatch(updater.output, /updater-ran/);
    holder.kill();
    await done;
    // In particular, the first lock isn't retained while deferring on the second.
    const next = h.run(['sh', '-c', 'echo next']);
    assert.equal(await next.done, 0, next.output);
  }
});

test('an updater leaves a free host to an existing live waiter', async (t) => {
  const h = host(t);
  const waiting = path.join(h.home, '.cache/threadbear-perf.lock.waiting');
  fs.mkdirSync(waiting, { recursive: true });
  fs.writeFileSync(path.join(waiting, String(process.pid)), `${Math.floor(Date.now() / 1000)}\n`);
  const shim = path.join(h.home, 'try.pl');
  fs.writeFileSync(shim, `exec 'perl', ${JSON.stringify(helper)}, '--try', @ARGV;`);
  const updater = h.run(['sh', '-c', 'echo updater-ran'], {}, undefined, false, shim);
  assert.equal(await updater.done, 75, updater.output);
  assert.doesNotMatch(updater.output, /updater-ran/);
  // A note left by a killed waiter, whose pid now belongs to this newer
  // process, cannot hold updates forever.
  fs.writeFileSync(path.join(waiting, String(process.pid)), '1\n');
  const reused = h.run(['sh', '-c', 'echo updater-ran'], {}, undefined, false, shim);
  assert.equal(await reused.done, 0, reused.output);
  fs.rmSync(path.join(waiting, String(process.pid)));
  fs.writeFileSync(path.join(waiting, '99999999'), '1\n');
  const free = h.run(['sh', '-c', 'echo updater-ran'], {}, undefined, false, shim);
  assert.equal(await free.done, 0, free.output);
  assert.match(free.output, /updater-ran/);
});

test('a waiter is told who holds the perf lock, and the note goes with the holder', async (t) => {
  // lsof can't tell a holder from a waiter: both have the file open.
  const h = host(t);
  const note = path.join(h.home, '.cache/threadbear-perf.lock.holder');
  const first = h.run(['sh', '-c', 'echo first; sleep 3'], { THREADBEAR_PERF_LOCK_LABEL: 'remote.sh from slot-9 --desk: film the paw' });
  await until(() => first.output.includes('first'), 'first did not start');
  assert.match(fs.readFileSync(note, 'utf8'), new RegExp(`^${first.pid}\\n\\d+\\nremote.sh from slot-9 --desk: film the paw\\n$`));
  const second = h.run(['sh', '-c', 'echo second']);
  await until(() => second.output.includes('Waiting for'), 'no waiting message');
  assert.match(second.output, new RegExp(`held by perf-lock pid ${first.pid} for 0m, running: remote.sh from slot-9 --desk: film the paw\\.\\.\\.`));
  await pause(1100); // the queue is ordered by whole seconds
  const third = h.run(['sh', '-c', 'echo third']);
  await until(() => third.output.includes('Waiting for'), 'third did not wait');
  assert.match(third.output, /; 1 other run waiting since before this one\.\.\./);
  assert.equal(await first.done, 0);
  assert.equal(await second.done, 0);
  assert.equal(await third.done, 0);
  assert.ok(!fs.existsSync(note), 'the last holder left its note behind');
  assert.deepEqual(fs.readdirSync(path.join(h.home, '.cache/threadbear-perf.lock.waiting')), [], 'a waiter left its file behind');
});

test('a check lock acquired first blocks measurement, and no check can start during it', async (t) => {
  const h = host(t);
  fs.mkdirSync(path.join(h.home, '.cache/threadbear-check'), { recursive: true });
  const lock = path.join(h.home, '.cache/threadbear-check/lock');
  const check = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]) or die $!; flock($f, LOCK_EX); $|=1; print "ready\\n"; sleep 1', lock], { stdio: ['ignore', 'pipe', 'inherit'] });
  let ready = '';
  check.stdout!.on('data', (s) => { ready += s; });
  await until(() => ready.includes('ready'), 'check did not take lock');
  const run = h.run(['sh', '-c', 'echo measuring; sleep 1']);
  await until(() => run.output.includes('Waiting for'), 'measurement did not wait');
  assert.ok(!run.output.includes('measuring'));
  await until(() => run.output.includes('measuring'), 'measurement did not start');
  const probe = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]) or die $!; exit(flock($f, LOCK_EX|LOCK_NB) ? 0 : 75)', lock]);
  assert.equal(await new Promise((r) => probe.on('exit', r)), 75);
  assert.equal(await run.done, 0);
});

test('nested helper calls and node entry points inherit one lock without deadlock', async (t) => {
  const h = host(t);
  const entry = path.join(h.home, 'entry.mjs');
  const api = path.join(root, 'features/tools/perf-lock.ts');
  fs.writeFileSync(entry, `import { ensurePerfLock } from ${JSON.stringify(api)}; await ensurePerfLock(); console.log('nested');`);
  const child = h.run(['perl', helper, '-', process.execPath, entry]);
  assert.equal(await child.done, 0, child.output);
  assert.match(child.output, /nested/);
  assert.doesNotMatch(child.output, /Waiting/);
});

for (const signal of ['SIGTERM', 'SIGKILL'] as const) test(`${signal} retains locks until a TERM-resistant descendant has stopped`, async (t) => {
  const h = host(t);
  const pidfile = path.join(h.home, 'pid');
  const first = h.run(['sh', '-c', 'trap "" TERM; echo $$ > "$1"; echo ready; while :; do sleep 1; done', 'sh', pidfile]);
  await until(() => first.output.includes('ready'), 'child did not start');
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  first.kill(signal);
  const second = h.run(['sh', '-c', 'echo next']);
  await until(() => second.output.includes('Waiting'), 'lock released before cleanup');
  assert.ok(!second.output.includes('next'));
  await first.done;
  assert.equal(await second.done, 0, second.output);
  assert.throws(() => process.kill(pid, 0));
});

test('stdin closing cancels a queued measurement before its command starts', async (t) => {
  const h = host(t);
  const first = h.run(['sh', '-c', 'echo ready; sleep 1']);
  await until(() => first.output.includes('ready'), 'first did not start');
  const second = h.run(['sh', '-c', 'echo should-not-run']);
  await until(() => second.output.includes('Waiting'), 'second did not wait');
  second.stdin!.end();
  assert.notEqual(await second.done, 0);
  assert.doesNotMatch(second.output, /should-not-run/);
});

test('direct node tools acquire the locks and preserve a failing exit status', async (t) => {
  const h = host(t);
  const entry = path.join(h.home, 'entry.mjs');
  fs.writeFileSync(entry, `import { ensurePerfLock } from ${JSON.stringify(path.join(root, 'features/tools/perf-lock.ts'))}; await ensurePerfLock(); console.log('entry ran'); process.exit(17);`);
  const child = spawn(process.execPath, [entry], { env: h.env });
  let out = '';
  child.stdout!.on('data', (s) => { out += s; });
  assert.equal(await new Promise((r) => child.on('exit', r)), 17);
  assert.match(out, /entry ran/);
});


test('legacy lockf jobs contend with both helper locks on macOS', { skip: process.platform !== 'darwin' }, async (t) => {
  const h = host(t);
  fs.mkdirSync(path.join(h.home, '.cache/threadbear-check'), { recursive: true });
  const perf = path.join(h.home, '.cache/threadbear-perf.lock');
  const check = path.join(h.home, '.cache/threadbear-check/lock');
  const legacy = spawn('/usr/bin/lockf', ['-k', perf, '/usr/bin/lockf', '-k', check, 'sh', '-c', 'echo legacy; sleep 1']);
  let output = '';
  legacy.stdout!.on('data', (s) => { output += s; });
  await until(() => output.includes('legacy'), 'legacy job did not acquire locks');
  const measured = h.run(['sh', '-c', 'echo measuring; sleep 1']);
  await until(() => measured.output.includes('Waiting'), 'helper did not contend with lockf');
  assert.doesNotMatch(measured.output, /measuring/);
  await until(() => measured.output.includes('measuring'), 'measurement did not start');
  for (const file of [perf, check]) {
    const probe = spawnSync('/usr/bin/lockf', ['-k', '-t', '0', file, 'true']);
    assert.equal(probe.status, 75, file);
  }
  assert.equal(await measured.done, 0);
});

test('remote build wrappers background builds without lowering the benchmark shell', (t) => {
  const h = host(t);
  const bin = path.join(h.home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'cargo'), '#!/bin/sh\necho fake-cargo\n', { mode: 0o755 });
  const run = spawnSync('/bin/bash', ['-c', '. "$1"; cargo build; echo benchmark; test -d "$threadbear_build_bin"', 'bash', path.join(root, 'scripts/build-priority.sh')], {
    env: { ...h.env, TMPDIR: h.home, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /fake-cargo\nbenchmark/);
  assert.ok(!fs.readdirSync(h.home).some((n) => n.startsWith('threadbear-build-bin.')));
});

test('free check probes keep the same inode that waiting measurements have open', () => {
  const check = fs.readFileSync(path.join(root, 'scripts/check-remote.sh'), 'utf8');
  for (const probe of check.matchAll(/\/usr\/bin\/lockf -t 0 ([^;\n]*?)true/g)) {
    assert.match(probe[1], /\b-k\b|^-k\s/, probe[0]);
  }
});

test('Desk Runner receives lock ownership explicitly through a fresh service environment', async (t) => {
  const h = host(t);
  const bin = path.join(h.home, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'desk'), '#!/bin/sh\nexec env -i HOME="$HOME" PATH="$PATH" /bin/bash -c "$1"\n', { mode: 0o755 });
  const entry = path.join(h.home, "desk entry's test.mjs");
  fs.writeFileSync(entry, `import fs from 'node:fs'; import { ensurePerfLock } from ${JSON.stringify(path.join(root, 'features/tools/perf-lock.ts'))}; await ensurePerfLock(); if (fs.readFileSync(process.argv[2], 'utf8').trim() !== String(process.pid)) throw Error('wrapper did not record desk pid'); console.log('desk inherited');`);
  const child = h.run([process.execPath, entry, path.join(h.home, 'desk.pid')], {}, path.join(h.home, 'desk.pid'));
  assert.equal(await child.done, 0, child.output);
  assert.match(child.output, /desk inherited/);
  assert.doesNotMatch(child.output, /Waiting/);
});

test('an old unlinking lockf owner cannot strand the helper on a deleted inode', { skip: process.platform !== 'darwin' }, async (t) => {
  const h = host(t);
  fs.mkdirSync(path.join(h.home, '.cache'), { recursive: true });
  const lock = path.join(h.home, '.cache/threadbear-perf.lock');
  const legacy = spawn('/usr/bin/lockf', [lock, 'sh', '-c', 'echo ready; sleep 1']);
  let output = '';
  legacy.stdout!.on('data', (s) => { output += s; });
  await until(() => output.includes('ready'), 'legacy job did not start');
  const measured = h.run(['sh', '-c', 'echo measuring; sleep 1']);
  await until(() => measured.output.includes('Waiting'), 'measurement did not wait');
  await until(() => measured.output.includes('measuring'), 'measurement did not acquire current inode');
  assert.equal(spawnSync('/usr/bin/lockf', ['-k', '-t', '0', lock, 'true']).status, 75);
  assert.equal(await measured.done, 0, measured.output);
});

test('a whole process-group TERM leaves the guard alive to stop its workload', async (t) => {
  const h = host(t);
  const pidfile = path.join(h.home, 'pid');
  const first = h.run(['sh', '-c', 'trap "" TERM; echo $$ > "$1"; echo ready; while :; do sleep 1; done', 'sh', pidfile], {}, undefined, true);
  await until(() => first.output.includes('ready'), 'child did not start');
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  process.kill(-first.pid!, 'SIGTERM');
  const next = h.run(['sh', '-c', 'echo next']);
  await until(() => next.output.includes('Waiting'), 'turn released before cleanup');
  await first.done;
  assert.equal(await next.done, 0);
  assert.throws(() => process.kill(pid, 0));
});
