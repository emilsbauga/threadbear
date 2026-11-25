// scripts/perf-lock.pl with real kernel locks and harmless sleeping children,
// never a build or a window: a lost worker, owner or ssh, and what it left
// running. helpers/perf-lock-harness.ts says why it's five files.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, GRACEFUL, until, born, host, pausedSnapshot } from '../helpers/perf-lock-harness.ts';
import { test } from 'node:test';

test('KILL of the actual measurement worker reaps its detached driver children before unlock', async (t) => {
  const h = host(t);
  const workerPid = path.join(h.home, 'worker.pid');
  const appPid = path.join(h.home, 'app.pid');
  const entry = path.join(h.home, 'worker.mjs');
  const registryFile = path.join(h.home, 'registry');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import { GpuiDriver } from ${JSON.stringify(path.join(root, 'features/support/gpui.ts'))}; fs.writeFileSync(${JSON.stringify(registryFile)}, process.env.THREADBEAR_PERF_CHILDREN); const driver = new GpuiDriver(); driver.child('sh', ['-c', 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done', 'sh', ${JSON.stringify(appPid)}], {}); fs.writeFileSync(${JSON.stringify(workerPid)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const first = h.run([process.execPath, entry]);
  await until(() => fs.existsSync(appPid), 'driver child did not start');
  const worker = Number(fs.readFileSync(workerPid, 'utf8'));
  const app = Number(fs.readFileSync(appPid, 'utf8'));
  process.kill(worker, 'SIGKILL');
  const registry = fs.readFileSync(registryFile, 'utf8');
  await until(() => fs.existsSync(`${registry}.reaping`), 'registry was not atomically retired');
  const lateFile = path.join(h.home, 'late-started');
  const late = spawn('perl', [path.join(root, 'scripts/perf-children.pl'), '--child', registry, 'touch', lateFile], { detached: true });
  assert.equal(await new Promise((r) => late.on('exit', r)), 129);
  assert.ok(!fs.existsSync(lateFile), 'late workload started during registry removal');
  const next = h.run(['sh', '-c', 'echo next']);
  await until(() => next.output.includes('Waiting'), 'worker death released locks before reaping apps');
  assert.equal(await first.done, 137, first.output);
  assert.equal(await next.done, 0, next.output);
  assert.throws(() => process.kill(app, 0));
  assert.ok(!fs.readdirSync(path.join(h.home, '.cache/threadbear-check')).some((n) => n.startsWith('perf-children-')));
});

for (const loss of ['worker', 'owner', 'transport', 'app', 'app-pty', 'closed-proof'] as const) test(`${loss} loss stops an app's separate terminal session before the next lease`, async (t) => {
  const h = host(t);
  const terminalPid = path.join(h.home, 'terminal.pid');
  const workerPid = path.join(h.home, 'worker.pid');
  const app = path.join(h.home, 'app.pl');
  const ptyApp = path.join(h.home, 'pty-app.py');
  fs.writeFileSync(ptyApp, `import os, pty, sys, time
with open(os.environ['HOME'] + '/app.pid', 'w') as f: f.write(str(os.getpid()))
pid, fd = pty.fork()
if pid == 0:
    # Exercise macOS's default interactive login shell without user profiles.
    shell = '/bin/zsh' if sys.platform == 'darwin' else '/bin/sh'
    args = ['zsh', '-d', '-f', '-i', '-l'] if sys.platform == 'darwin' else ['sh']
    os.execv(shell, args + ['-c', 'trap "" HUP TERM; echo $$ > "$1"; while :; do sleep 1; done', 'shell', sys.argv[1]])
while True: time.sleep(1)
`);
  const clean = path.join(h.home, 'clean-terminal.pl');
  fs.writeFileSync(clean, `$SIG{HUP} = $SIG{TERM} = 'IGNORE'; open(my $f, '>', $ARGV[0]); print {$f} $$; close $f; sleep 1 while 1;`);
  // Like forkpty: a child in a different session, ignoring the signals an
  // app's exit normally sends. Sleeping keeps the regression off Alex's CPU.
  fs.writeFileSync(app, `use POSIX qw(setsid);
    open(my $app, '>', "$ENV{HOME}/app.pid"); print {$app} $$; close $app;
    my $pid = fork() // die $!;
    if (!$pid) { setsid() >= 0 or die $!; $SIG{HUP} = $SIG{TERM} = 'IGNORE';
      if ($ARGV[1]) { POSIX::close(197); exec 'env', '-u', 'THREADBEAR_PERF_CHILDREN', 'perl', $ARGV[1], $ARGV[0]; die $!; }
      open(my $f, '>', $ARGV[0]) or die $!; print {$f} $$; close $f;
      sleep 1 while 1;
    } sleep 1 while 1;`);
  const entry = path.join(h.home, 'worker.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import { GpuiDriver } from ${JSON.stringify(path.join(root, 'features/support/gpui.ts'))};
    fs.writeFileSync(${JSON.stringify(workerPid)}, String(process.pid));
    new GpuiDriver().child(${JSON.stringify(loss === 'app-pty' ? 'python3' : 'perl')}, ${JSON.stringify([loss === 'app-pty' ? ptyApp : app, terminalPid, ...(loss === 'closed-proof' ? [clean] : [])])}, {});
    setInterval(() => {}, 1000);`);
  const first = h.run([process.execPath, entry]);
  await until(() => fs.existsSync(terminalPid) && Number(fs.readFileSync(terminalPid, 'utf8')) > 1, 'terminal session did not start');
  const pid = Number(fs.readFileSync(terminalPid, 'utf8'));
  const firstBorn = born(String(pid));
  t.after(() => {
    const now = born(String(pid));
    if (firstBorn && now === firstBorn) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  if (loss.startsWith('app')) process.kill(Number(fs.readFileSync(path.join(h.home, 'app.pid'), 'utf8')), 'SIGKILL');
  if (loss === 'worker' || loss.startsWith('app') || loss === 'closed-proof') process.kill(Number(fs.readFileSync(workerPid, 'utf8')), 'SIGKILL');
  else if (loss === 'owner') first.kill('SIGKILL');
  else { first.stdout!.destroy(); first.stderr!.destroy(); first.stdin!.end(); }
  const probe = path.join(h.home, 'probe.mjs');
  fs.writeFileSync(probe, `import { spawnSync } from 'node:child_process';
    const state = spawnSync('ps', ['-p', '${pid}', '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
    if (state && !state.startsWith('Z')) { console.error('terminal survived unlock: ' + state); process.exit(1); }`);
  const next = h.run([process.execPath, probe]);
  assert.equal(await next.done, 0, next.output);
});

test('a fork after discovery is found even when its parent exits before the rescan', async (t) => {
  const h = host(t);
  const env = pausedSnapshot(h.home);
  const script = path.join(h.home, 'fork.pl');
  const pidfile = path.join(h.home, 'late.pid');
  fs.writeFileSync(script, `use POSIX qw(setsid); open(my $ready, '>', "$ENV{HOME}/app-ready"); close $ready;
    select(undef, undef, undef, 0.01) until -e "$ENV{HOME}/fork-now";
    if (!fork()) { setsid(); $SIG{TERM} = $SIG{HUP} = 'IGNORE';
      open(my $f, '>', $ARGV[0]); print {$f} $$; close $f;
      sleep 1 while 1;
    } exit 0;`);
  const workerPid = path.join(h.home, 'worker.pid');
  const entry = path.join(h.home, 'worker.mjs');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import { GpuiDriver } from ${JSON.stringify(path.join(root, 'features/support/gpui.ts'))};
    fs.writeFileSync(${JSON.stringify(workerPid)}, String(process.pid));
    new GpuiDriver().child('perl', [${JSON.stringify(script)}, ${JSON.stringify(pidfile)}], {});
    setInterval(() => {}, 1000);`);
  const first = h.run([process.execPath, entry], env);
  await until(() => fs.existsSync(path.join(h.home, 'app-ready')), 'app did not start');
  process.kill(Number(fs.readFileSync(workerPid, 'utf8')), 'SIGKILL');
  await until(() => fs.existsSync(path.join(h.home, 'scan-ready')), 'scan did not pause');
  fs.writeFileSync(path.join(h.home, 'fork-now'), '');
  await until(() => fs.existsSync(pidfile) && Number(fs.readFileSync(pidfile, 'utf8')) > 1, 'late fork did not start');
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  const firstBorn = born(String(pid));
  t.after(() => {
    const now = born(String(pid));
    if (firstBorn && now === firstBorn) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  fs.writeFileSync(path.join(h.home, 'resume-scan'), '');
  assert.notEqual(await first.done, 0);
  const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
  assert.ok(!state || state.startsWith('Z'), `late fork survived: ${state}`);
});

test('stale registration and snapshot identities never stop an unrelated process', async (t) => {
  const h = host(t);
  const env = pausedSnapshot(h.home);
  const registryFile = path.join(h.home, 'registry');
  const first = h.run(['sh', '-c', 'echo "$THREADBEAR_PERF_CHILDREN" > "$1"; echo ready; while :; do sleep 1; done', 'sh', registryFile], env);
  await until(() => first.output.includes('ready'), 'worker did not start');
  const registry = fs.readFileSync(registryFile, 'utf8').trim();
  // A matching argument is not an inherited environment entry.
  const unrelated = spawn('perl', ['-e', 'my $p = fork() // die $!; if ($p) { $|=1; print "$p\\n"; } sleep 1 while 1;', `THREADBEAR_PERF_CHILDREN=${registry}`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let childPid = '';
  unrelated.stdout!.on('data', (s) => { childPid += s; });
  const unrelatedDone = new Promise((r) => unrelated.on('exit', r));
  t.after(async () => { process.kill(-unrelated.pid!, 'SIGKILL'); await unrelatedDone; });
  await until(() => childPid.includes('\n'), 'unrelated subtree did not start');
  fs.writeFileSync(path.join(registry, String(unrelated.pid)), 'stale registration');
  const childBorn = born(childPid.trim());
  fs.writeFileSync(path.join(registry, `anchor-${unrelated.pid}`), `${childPid.trim()}\n${childBorn}\nstale registration`);
  first.stdin!.end();
  await until(() => fs.existsSync(path.join(h.home, 'scan-ready')), 'scan did not pause');
  // Pretend a recorded descendant PID was reused after discovery. Its live
  // start check must disagree, and its alleged group must never be signalled.
  const snapshotFile = path.join(h.home, 'snapshot');
  const rows = fs.readFileSync(snapshotFile, 'utf8');
  const worker = fs.readdirSync(`${registry}.reaping`).find((n) => /^\d+$/.test(n));
  assert.ok(worker);
  fs.writeFileSync(snapshotFile, rows.split('\n').map((row) => {
    if (!new RegExp(`^\\s*${unrelated.pid}\\s`).test(row)) return row;
    return `${unrelated.pid} ${worker} ${unrelated.pid} ${process.getuid!()} S stale-start-time`;
  }).join('\n'));
  fs.writeFileSync(path.join(h.home, 'resume-scan'), '');
  await first.done;
  for (const pid of [String(unrelated.pid), childPid.trim()]) {
    const state = spawnSync('ps', ['-p', pid, '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
    assert.ok(state && !/^[TZ]/.test(state), `unrelated process ${pid} was stopped: ${state}`);
  }
});

test('an unavailable process snapshot keeps both leases held until discovery recovers', async (t) => {
  const h = host(t);
  const env = pausedSnapshot(h.home);
  fs.unlinkSync(path.join(h.home, 'pause-scan'));
  const first = h.run(['sh', '-c', 'echo ready; while :; do sleep 1; done'], env);
  await until(() => first.output.includes('ready'), 'worker did not start');
  fs.writeFileSync(path.join(h.home, 'fail-scan'), '');
  first.stdin!.end();
  await until(() => fs.existsSync(path.join(h.home, 'scan-failed')), 'failed snapshot not attempted');
  const next = h.run(['sh', '-c', 'echo entered-next-lease']);
  await until(() => next.output.includes('Waiting'), 'failed snapshot released locks');
  assert.doesNotMatch(next.output, /entered-next-lease/);
  fs.unlinkSync(path.join(h.home, 'fail-scan'));
  assert.equal(await next.done, 0, next.output);
});

test('registered background helpers keep their graceful TERM cleanup', async (t) => {
  const h = host(t);
  const ready = path.join(h.home, 'helper-ready');
  const stopped = path.join(h.home, 'helper-stopped');
  const script = path.join(h.home, 'graceful.pl');
  fs.writeFileSync(script, `my $p = fork() // die $!;
    if (!$p) { $SIG{TERM} = sub { open(my $f, '>', $ARGV[1]); close $f; exit 0; };
      open(my $f, '>', $ARGV[0]); close $f; sleep 1 while 1;
    }
    select(undef, undef, undef, .01) until -e $ARGV[0]; exit 0;`);
  const run = h.run(['perl', script, ready, stopped], GRACEFUL);
  assert.equal(await run.done, 0, run.output);
  assert.ok(fs.existsSync(stopped), 'registered helper was killed without TERM');
});

test('worker death reaps children that Node launched without the proof descriptor', async (t) => {
  const h = host(t);
  const entry = path.join(h.home, 'worker.mjs');
  const pidfile = path.join(h.home, 'unmarked.pid');
  const workerPid = path.join(h.home, 'worker.pid');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import { spawn } from 'node:child_process';
    fs.writeFileSync(${JSON.stringify(workerPid)}, String(process.pid));
    spawn('perl', ['-MPOSIX', '-e', 'POSIX::close(197); $SIG{HUP}=$SIG{TERM}="IGNORE"; open(my $f, ">", $ARGV[0]); print {$f} $$; close $f; sleep 1 while 1;', ${JSON.stringify(pidfile)}], { stdio: 'ignore' });
    setInterval(() => {}, 1000);`);
  h.run([process.execPath, entry]);
  await until(() => fs.existsSync(pidfile) && Number(fs.readFileSync(pidfile, 'utf8')) > 1, 'background child did not start');
  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  const firstBorn = born(String(pid));
  t.after(() => {
    const now = born(String(pid));
    if (firstBorn && now === firstBorn) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });
  process.kill(Number(fs.readFileSync(workerPid, 'utf8')), 'SIGKILL');
  const next = h.run(['sh', '-c', 'echo next']);
  assert.equal(await next.done, 0, next.output);
  const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
  assert.ok(!state || state.startsWith('Z'), `unmarked group member survived unlock: ${state}`);
});
