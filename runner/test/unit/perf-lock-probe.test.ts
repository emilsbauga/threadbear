// scripts/perf-lock.pl with real kernel locks and harmless sleeping children,
// never a build or a window: a descriptor probe (lsof) that fails, mostly on a
// Mac. helpers/perf-lock-harness.ts says why it's five files.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, pause, TEST_ALIVE, GRACEFUL, until, within, born, host } from '../helpers/perf-lock-harness.ts';
import { test } from 'node:test';

// With { stray: true } the failing stand-in leaves one process of its own
// running, in its own session, which would hold the host locks after
// cleanup if they leaked into the probes it starts. Its pid goes in
// $HOME/stray-probe-child.
const STRAY_PROBE_CHILD = `if (!-e "$ENV{HOME}/stray-probe-child") { my $s = fork(); if (defined($s) && !$s) { POSIX::setsid(); close STDOUT; close STDERR; sleep 1 while ${TEST_ALIVE}; exit 0; } if ($s && open(my $m, '>', "$ENV{HOME}/stray-probe-child")) { print {$m} $s; close $m; } }`;
// A copy of perf-lock.pl whose cleanup asks this stand-in instead of lsof.
// While $HOME/blocked-probe exists (and this test process lives) it fails
// the given way, noting each failure in $HOME/probe-failures; otherwise it
// runs the real lsof. $HOME/fail-few makes it fail three times in a row, as
// soon as the process in $HOME/child.pid and the lease's anchors are gone, so
// cleanup knows of nothing still running; after that it answers for lsof
// itself, listing only cleanup's own descriptor, so a slow lsof on a busy
// machine can't add failures of its own.
type ProbeFailure = 'stderr' | 'timeout' | 'closed-pipes' | 'empty';
function probedLock(home: string, failure: ProbeFailure, { stray = false } = {}) {
  const scripts = path.join(home, 'helpers');
  fs.mkdirSync(scripts);
  for (const name of ['perf-lock.pl', 'hangup-guard.sh']) fs.copyFileSync(path.join(root, 'scripts', name), path.join(scripts, name));
  const probe = path.join(scripts, 'probe');
  fs.writeFileSync(probe, `#!/usr/bin/perl
    use POSIX ();
    my $few = "$ENV{HOME}/fail-few";
    # The lease's anchors, live and not zombies waiting to be reaped.
    my $read = sub { my $line = ''; if (open(my $r, '<', $_[0])) { $line = <$r> // ''; chomp $line; } $line };
    my $anchored = sub { grep { my $pid = $read->($_);
      $pid =~ /^\\d+$/ && \`/bin/ps -o stat= -p $pid\` =~ /^\\s*[^Z\\s]/ }
      glob("$ENV{HOME}/.cache/threadbear-check/perf-children-*/{anchor,retired}-*") };
    my $live = sub { my ($pid) = @_; $pid =~ /^\\d+$/ && \`/bin/ps -o stat= -p $pid\` =~ /^\\s*[^Z\\s]/ };
    my $child = $read->("$ENV{HOME}/child.pid");
    if (-e $few && length($child) && !$live->($child) && !$anchored->()) {
      open(my $c, '>>', $few); print {$c} 'x'; close $c;
      if (-s $few >= 3) { unlink $few; open(my $d, '>', "$ENV{HOME}/failed-few"); close $d; }
      print STDERR "unavailable\\n"; exit 2;
    }
    if (-e "$ENV{HOME}/failed-few") {
      my ($state) = glob("$ENV{HOME}/.cache/threadbear-check/perf-children-*.reaping/state");
      my @st = stat($state // '');
      if (@st) { printf "p%d\\nf197\\nD0x%x\\ni%d\\n", getppid(), $st[0], $st[1]; exit 0; }
    }
    if (-e "$ENV{HOME}/blocked-probe" && ${TEST_ALIVE}) {
      if (open(my $n, '>>', "$ENV{HOME}/probe-failures")) { print {$n} "x\\n"; close $n; }
      ${stray ? STRAY_PROBE_CHILD : ''}
      ${failure === 'stderr' ? 'print STDERR "unavailable\\n"; exit 2;' : failure === 'empty' ? 'exit 0;' : `${failure === 'closed-pipes' ? 'close STDOUT; close STDERR;' : ''} sleep 1 while ${TEST_ALIVE};`}
    }
    exec '/usr/sbin/lsof', @ARGV;
  `, { mode: 0o755 });
  const source = fs.readFileSync(path.join(root, 'scripts/perf-children.pl'), 'utf8');
  const patched = source.replace("'/usr/sbin/lsof'", () => `'${probe}'`);
  assert.notEqual(source, patched);
  fs.writeFileSync(path.join(scripts, 'perf-children.pl'), patched);
  return path.join(scripts, 'perf-lock.pl');
}

for (const failure of ['stderr', 'timeout', 'closed-pipes', 'empty'] as const) test(`descriptor probe ${failure} still stops registered work and keeps both locks`, { skip: process.platform !== 'darwin' }, async (t) => {
  const h = host(t);
  const program = probedLock(h.home, failure);
  const stopped = path.join(h.home, 'terminated');
  const ready = path.join(h.home, 'ready');
  const command = `my $p = fork() // die $!; if (!$p) {
    $SIG{TERM} = sub { open(my $f, '>', $ARGV[1]); close $f; exit 0; };
    open(my $f, '>', $ARGV[0]); close $f; sleep 1 while 1;
  } select(undef, undef, undef, .01) until -e $ARGV[0]; exit 0;`;
  fs.writeFileSync(path.join(h.home, 'blocked-probe'), '');
  const first = h.run(['perl', '-e', command, ready, stopped], GRACEFUL, undefined, false, program);
  await until(() => fs.existsSync(stopped), 'probe failure prevented registered TERM cleanup');
  const next = h.run(['sh', '-c', 'echo entered-next-lease']);
  await until(() => next.output.includes('Waiting'), 'probe failure released locks');
  await pause(3000);
  assert.doesNotMatch(next.output, /entered-next-lease/, 'probe failure declared quiet after registered work stopped');
  fs.unlinkSync(path.join(h.home, 'blocked-probe'));
  assert.equal(await first.done, 0, first.output);
  assert.equal(await next.done, 0, next.output);
});

// Seth's case (PR #93): a cleanup whose lsof never recovers held the host
// for hours. Once everything it knows of has stopped, it gives up at its
// limit, keeps the workload's own failure, and leaves nothing behind.
for (const workload of [0, 3]) test(`a cleanup whose probe never recovers gives up at its limit once its work is gone (exit ${workload})`, { skip: process.platform !== 'darwin' }, async (t) => {
  const h = host(t);
  const program = probedLock(h.home, 'stderr', { stray: true });
  const strayFile = path.join(h.home, 'stray-probe-child');
  // Read while the home is still there: host()'s own after hook removes it.
  let strayPid = 0;
  t.after(() => { if (strayPid > 1) { try { process.kill(strayPid, 'SIGKILL'); } catch {} } });
  const stopped = path.join(h.home, 'terminated');
  const ready = path.join(h.home, 'ready');
  const command = `my $p = fork() // die $!; if (!$p) {
    $SIG{TERM} = sub { open(my $f, '>', $ARGV[1]); close $f; exit 0; };
    open(my $f, '>', $ARGV[0]); close $f; sleep 1 while ${TEST_ALIVE};
  } select(undef, undef, undef, .01) until -e $ARGV[0]; exit ${workload};`;
  fs.writeFileSync(path.join(h.home, 'blocked-probe'), '');
  const first = h.run(['perl', '-e', command, ready, stopped], { ...GRACEFUL, THREADBEAR_PERF_REAP_LIMIT: '3' }, undefined, false, program);
  assert.equal(await within(first.done, 'cleanup never gave up'), workload || 1, first.output);
  assert.ok(fs.existsSync(stopped), 'gave up before stopping the work it knew of');
  assert.ok(fs.existsSync(strayFile), 'the probe never left its stray child');
  strayPid = Number(fs.readFileSync(strayFile, 'utf8'));
  const cache = path.join(h.home, '.cache/threadbear-check');
  assert.match(fs.readFileSync(path.join(cache, 'perf-cleanup.log'), 'utf8'), /gave up after \d+ s of cleanup: the descriptor probe could not confirm/);
  assert.deepEqual(fs.readdirSync(cache).filter((name) => name.startsWith('perf-children-')), [], 'gave up and left its registry behind');
  // The probe's stray child is still running: it mustn't hold the locks.
  const next = h.run(['sh', '-c', 'echo entered-next-lease']);
  assert.equal(await within(next.done, 'the probe\'s leftover child kept the host locked'), 0, next.output);
  assert.match(next.output, /entered-next-lease/);
});

test('a live group whose owner is in doubt keeps the locks past the give-up limit', { skip: process.platform !== 'darwin' }, async (t) => {
  const h = host(t);
  const program = probedLock(h.home, 'stderr');
  const entry = path.join(h.home, 'worker.mjs');
  const childFile = path.join(h.home, 'child.pid');
  const workerFile = path.join(h.home, 'worker.pid');
  const registryFile = path.join(h.home, 'registry');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import { spawn } from 'node:child_process';
    fs.writeFileSync(${JSON.stringify(workerFile)}, String(process.pid));
    fs.writeFileSync(${JSON.stringify(registryFile)}, process.env.THREADBEAR_PERF_CHILDREN);
    spawn('perl', ['-MPOSIX', '-e', 'POSIX::close(197); $SIG{HUP}=$SIG{TERM}="IGNORE"; open(my $f, ">", $ARGV[0]); print {$f} $$; close $f; sleep 1 while ${TEST_ALIVE};', ${JSON.stringify(childFile)}], { stdio: 'ignore' });
    setInterval(() => {}, 1000);`);
  const first = h.run([process.execPath, entry], { THREADBEAR_PERF_REAP_LIMIT: '1' }, undefined, false, program);
  await until(() => fs.existsSync(childFile) && Number(fs.readFileSync(childFile, 'utf8')) > 1, 'child did not start');
  const child = Number(fs.readFileSync(childFile, 'utf8'));
  const firstBorn = born(String(child));
  const stopChild = () => {
    if (firstBorn && born(String(child)) === firstBorn) { try { process.kill(child, 'SIGKILL'); } catch {} }
  };
  t.after(stopChild);
  const worker = Number(fs.readFileSync(workerFile, 'utf8'));
  const registry = fs.readFileSync(registryFile, 'utf8');
  const [anchor] = fs.readFileSync(path.join(registry, `anchor-${worker}`), 'utf8').split('\n');
  fs.writeFileSync(path.join(h.home, 'blocked-probe'), '');
  process.kill(Number(anchor), 'SIGKILL');
  process.kill(worker, 'SIGKILL');
  const next = h.run(['sh', '-c', 'echo entered-next-lease']);
  try {
    await until(() => fs.existsSync(`${registry}.reaping`), 'cleanup did not retire registry');
    await until(() => next.output.includes('Waiting'), 'the next lease did not queue');
    // Three times the limit, and more failed probes than give-up needs: a
    // cleanup that gave up here would have let it in.
    await pause(3000);
    const failures = () => (fs.existsSync(path.join(h.home, 'probe-failures')) ? fs.readFileSync(path.join(h.home, 'probe-failures'), 'utf8').split('\n').length - 1 : 0);
    await until(() => failures() >= 4, 'cleanup did not keep probing');
    assert.doesNotMatch(next.output, /entered-next-lease/, 'gave up while a group it could not account for was alive');
  } finally {
    fs.rmSync(path.join(h.home, 'blocked-probe'), { force: true });
    stopChild();
  }
  assert.equal(await next.done, 0, next.output);
  await first.done;
});

// A few quick probe failures once cleanup is past its limit aren't enough to
// give up, as the probe has to have been failing for the whole limit: the
// child ignores TERM, so it's only killed when the 5 s TERM grace runs out
// (GRACEFUL, here for its length), past the 4 s limit; then the probe fails
// three times in a row and answers again.
test('a brief probe failure past the give-up limit still finishes cleanly', { skip: process.platform !== 'darwin' }, async (t) => {
  const h = host(t);
  const program = probedLock(h.home, 'stderr');
  const ready = path.join(h.home, 'ready');
  const childFile = path.join(h.home, 'child.pid');
  const command = `my $p = fork() // die $!; if (!$p) {
    $SIG{TERM} = 'IGNORE';
    open(my $f, '>', $ARGV[1]); print {$f} $$; close $f;
    open(my $r, '>', $ARGV[0]); close $r; sleep 1 while ${TEST_ALIVE};
  } select(undef, undef, undef, .01) until -e $ARGV[0]; exit 0;`;
  fs.writeFileSync(path.join(h.home, 'fail-few'), '');
  const first = h.run(['perl', '-e', command, ready, childFile], { ...GRACEFUL, THREADBEAR_PERF_REAP_LIMIT: '4' }, undefined, false, program);
  assert.equal(await within(first.done, 'cleanup never finished'), 0, first.output);
  const child = fs.readFileSync(childFile, 'utf8').trim();
  const state = spawnSync('/bin/ps', ['-p', child, '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
  assert.ok(!state || state.startsWith('Z'), 'the child outlived cleanup');
  assert.ok(!fs.existsSync(path.join(h.home, 'fail-few')), 'the probe never failed three times');
});
