// scripts/perf-lock.pl with real kernel locks and harmless sleeping children,
// never a build or a window: process groups and their anchors.
// helpers/perf-lock-harness.ts says why it's five files.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, pause, TEST_ALIVE, until, born, host } from '../helpers/perf-lock-harness.ts';
import { test } from 'node:test';

test('an anchor with a different freshly queried group cannot authorize group KILL', async (t) => {
  const h = host(t);
  const bin = path.join(h.home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), `#!/usr/bin/perl
    if ($ARGV[0] eq '-p' && $ARGV[3] eq 'lstart=' && !-e "$ENV{HOME}/resume-scan" && -e "$ENV{HOME}/child.pid") {
      open(my $f, '<', "$ENV{HOME}/child.pid"); my $child = <$f>; close $f;
      if ($ARGV[1] == $child) { print 'wrong-child-birth'; exit 0; }
    }
    if ($ARGV[0] eq '-p' && $ARGV[3] eq 'pgid=,uid=,stat=,lstart=') {
      if (!-e "$ENV{HOME}/rejected-anchor") {
        open(my $ps, '-|', '/bin/ps', @ARGV); my $row = <$ps>; close $ps or die;
        open(my $f, '>', "$ENV{HOME}/rejected-anchor"); print {$f} $ARGV[1]; close $f;
        $row =~ s/^\\s*\\d+/0/; print $row; exit 0;
      }
      open(my $f, '>', "$ENV{HOME}/query-paused"); close $f;
      select(undef, undef, undef, .02) until -e "$ENV{HOME}/resume-scan" || !${TEST_ALIVE};
    }
    exec '/bin/ps', @ARGV;
  `, { mode: 0o755 });
  const pidfile = path.join(h.home, 'child.pid');
  const command = `use POSIX; my $p = fork() // die $!; if (!$p) {
    POSIX::close(197); $SIG{TERM} = $SIG{HUP} = 'IGNORE';
    open(my $f, '>', $ARGV[0]); print {$f} $$; close $f; sleep 1 while ${TEST_ALIVE};
  } select(undef, undef, undef, .01) until -s $ARGV[0]; exit 0;`;
  const first = h.run(['perl', '-e', command, pidfile], { PATH: `${bin}:${process.env.PATH}` });
  await until(() => fs.existsSync(path.join(h.home, 'query-paused')), 'group query did not reject and retry');
  const anchor = Number(fs.readFileSync(path.join(h.home, 'rejected-anchor'), 'utf8'));
  assert.ok(anchor > 1);
  const state = spawnSync('/bin/ps', ['-p', String(anchor), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
  assert.ok(state && !state.startsWith('Z'), 'group KILL ran despite the mismatching fresh PGID');
  const child = fs.readFileSync(pidfile, 'utf8').trim();
  const childState = spawnSync('/bin/ps', ['-p', child, '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
  assert.ok(childState && !childState.startsWith('Z'), 'the pinned child must keep its anchor from retiring');
  const next = h.run(['true']);
  await until(() => next.output.includes('Waiting'), 'rejected group query released locks');
  fs.writeFileSync(path.join(h.home, 'resume-scan'), '');
  assert.equal(await first.done, 0, first.output);
  assert.equal(await next.done, 0, next.output);
});

test('loss of an anchor cannot unlock a live group whose ownership is now uncertain', async (t) => {
  const h = host(t);
  const entry = path.join(h.home, 'worker.mjs');
  const childFile = path.join(h.home, 'child.pid');
  const workerFile = path.join(h.home, 'worker.pid');
  const registryFile = path.join(h.home, 'registry');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import { spawn } from 'node:child_process';
    fs.writeFileSync(${JSON.stringify(workerFile)}, String(process.pid));
    fs.writeFileSync(${JSON.stringify(registryFile)}, process.env.THREADBEAR_PERF_CHILDREN);
    spawn('perl', ['-MPOSIX', '-e', 'POSIX::close(197); $SIG{HUP}=$SIG{TERM}="IGNORE"; open(my $f, ">", $ARGV[0]); print {$f} $$; close $f; sleep 1 while ${TEST_ALIVE};', ${JSON.stringify(childFile)}], { stdio: 'ignore' });
    setInterval(() => {}, 1000);`);
  const first = h.run([process.execPath, entry]);
  await until(() => fs.existsSync(childFile) && Number(fs.readFileSync(childFile, 'utf8')) > 1, 'child did not start');
  const child = Number(fs.readFileSync(childFile, 'utf8'));
  const firstBorn = born(String(child));
  const stopChild = () => {
    const now = born(String(child));
    if (firstBorn && now === firstBorn) { try { process.kill(child, 'SIGKILL'); } catch {} }
  };
  t.after(stopChild);
  const worker = Number(fs.readFileSync(workerFile, 'utf8'));
  const registry = fs.readFileSync(registryFile, 'utf8');
  const [anchor, anchorBorn] = fs.readFileSync(path.join(registry, `anchor-${worker}`), 'utf8').split('\n');
  assert.equal(born(anchor), anchorBorn);
  process.kill(Number(anchor), 'SIGKILL');
  process.kill(worker, 'SIGKILL');
  const next = h.run(['sh', '-c', 'echo entered-next-lease']);
  try {
    await until(() => fs.existsSync(`${registry}.reaping`), 'cleanup did not retire registry');
    await pause(1500);
    assert.match(next.output, /Waiting/);
    assert.doesNotMatch(next.output, /entered-next-lease/);
    const state = spawnSync('ps', ['-p', String(child), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
    assert.ok(state && !state.startsWith('Z'), 'cleanup guessed ownership after losing its anchor');
  } finally { stopChild(); }
  assert.equal(await next.done, 0, next.output);
  await first.done;
});

test('stopped child groups retire their anchors during a continuing lease', async (t) => {
  const h = host(t);
  const entry = path.join(h.home, 'worker.mjs');
  const groupsFile = path.join(h.home, 'groups.json');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import { GpuiDriver } from ${JSON.stringify(path.join(root, 'features/support/gpui.ts'))};
    const driver = new GpuiDriver(); const groups = [];
    for (let i = 0; i < 20; i++) {
      const file = process.env.HOME + '/' + i + '.pid';
      const c = driver.child('perl', ['-e', 'open(my $f, ">", $ARGV[0]); print {$f} $$; close $f; sleep 30;', file], {});
      while (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8')) await new Promise(r => setTimeout(r, 10));
      const done = new Promise(r => c.once('exit', r)); await driver.killChild(c); await done;
      groups.push(c.pid); console.log('stopped child ' + i);
    }
    fs.writeFileSync(${JSON.stringify(groupsFile)}, JSON.stringify({ registry: process.env.THREADBEAR_PERF_CHILDREN, groups }));
    console.log('stopped twenty'); setInterval(() => {}, 1000);`);
  const first = h.run([process.execPath, entry]);
  // Twenty starts and stops one after another took more than one wait's
  // patience at a load of 37 (Ville's Mac, 20 Nov), so each child gets its own.
  for (let i = 0; i < 20; i++) await until(() => first.output.includes(`stopped child ${i}\n`), `sequential child ${i} did not stop`);
  await until(() => first.output.includes('stopped twenty'), 'sequential children did not stop');
  const { registry, groups } = JSON.parse(fs.readFileSync(groupsFile, 'utf8')) as { registry: string; groups: number[] };
  const live = () => {
    const rows = spawnSync('ps', ['-axo', 'pid=,stat='], { encoding: 'utf8' }).stdout;
    return groups.filter((group) => {
      let record: string;
      try { record = fs.readFileSync(path.join(registry, `anchor-${group}`), 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        record = fs.readFileSync(path.join(registry, `retired-${group}`), 'utf8');
      }
      const [pid, recorded] = record.split('\n');
      return rows.split('\n').some((row) => {
        const m = row.match(/^\s*(\d+)\s+(\S+)/);
        return m && m[1] === pid && !m[2].startsWith('Z') && born(pid) === recorded;
      });
    });
  };
  await until(() => live().length === 0, 'stopped children left resident anchors until lease cleanup');
});

test('repeated same-group registration keeps one holder and clears stale retirement', async (t) => {
  const h = host(t);
  const entry = path.join(h.home, 'reenter.pl');
  const gate = path.join(root, 'scripts/perf-children.pl');
  fs.writeFileSync(entry, `my $left = shift; my $dir = $ENV{THREADBEAR_PERF_CHILDREN};
    if ($left) {
      open(my $in, '<', "$dir/anchor-$$") or die $!;
      open(my $out, '>', "$dir/retired-$$") or die $!; print {$out} $_ while <$in>; close $out; close $in;
      exec 'perl', $ARGV[0], '--child', $dir, 'perl', $0, $left-1, $ARGV[0]; die $!;
    }
    $|=1; print "ready-reentered $$\\n"; sleep 1 while 1;`);
  const first = h.run(['perl', entry, '5', gate]);
  await until(() => first.output.includes('ready-reentered'), 'same-group reentry did not finish');
  const group = Number(first.output.match(/ready-reentered (\d+)/)![1]);
  const rows = spawnSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8' }).stdout;
  const holders = rows.split('\n').filter((row) => {
    const m = row.match(/^\s*(\d+)\s+(\d+)\s+(\S+)/);
    return m && Number(m[2]) === group && Number(m[1]) !== group && !m[3].startsWith('Z');
  });
  assert.equal(holders.length, 1, 're-entering the gate created duplicate resident holders');
  const base = path.join(h.home, '.cache/threadbear-check');
  const registry = fs.readdirSync(base).find((name) => name.startsWith('perf-children-'))!;
  assert.ok(!fs.existsSync(path.join(base, registry, `retired-${group}`)), 'new registration retained a stale retirement marker');
});

test('a retired group number cannot block cleanup when an unrelated leaderless group reuses it', async (t) => {
  const h = host(t);
  const bin = path.join(h.home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ps'), `#!/usr/bin/perl
    if ($ARGV[0] eq '-axo' && $ARGV[1] eq 'pid=,ppid=,pgid=,uid=,stat=,lstart=' && -e "$ENV{HOME}/alias-target") {
      open(my $f, '<', "$ENV{HOME}/alias-target"); my ($pid,$group) = split / /, <$f>; close $f;
      open(my $ps, '-|', '/bin/ps', @ARGV) or die;
      while (my $row = <$ps>) { $row =~ s/^(\\s*$pid\\s+\\d+\\s+)\\d+/$1 . $group/e; print $row; }
      close $ps or die; exit 0;
    }
    exec '/bin/ps', @ARGV;
  `, { mode: 0o755 });
  const entry = path.join(h.home, 'worker.mjs');
  const data = path.join(h.home, 'group.json');
  fs.writeFileSync(entry, `import fs from 'node:fs'; import { GpuiDriver } from ${JSON.stringify(path.join(root, 'features/support/gpui.ts'))};
    const file = process.env.HOME + '/ready'; const d = new GpuiDriver();
    const c = d.child('perl', ['-e', 'open(my $f, ">", $ARGV[0]); print {$f} $$; close $f; sleep 30;', file], {});
    while (!fs.existsSync(file) || !fs.readFileSync(file,'utf8')) await new Promise(r => setTimeout(r,10));
    const done = new Promise(r => c.once('exit',r)); await d.killChild(c); await done;
    fs.writeFileSync(${JSON.stringify(data)}, JSON.stringify({ group:c.pid, worker:process.pid, registry:process.env.THREADBEAR_PERF_CHILDREN }));
    console.log('stopped one'); setInterval(() => {},1000);`);
  const first = h.run([process.execPath, entry], { PATH: `${bin}:${process.env.PATH}` });
  await until(() => first.output.includes('stopped one'), 'registered child did not stop');
  const { group, worker, registry } = JSON.parse(fs.readFileSync(data, 'utf8')) as { group: number; worker: number; registry: string };
  await until(() => fs.existsSync(path.join(registry, `retired-${group}`)), 'holder did not retire');
  assert.notEqual(spawnSync('/bin/ps', ['-p', String(group), '-o', 'pid=']).status, 0, 'original leader must be absent');
  const other = spawn('perl', ['-e', 'sleep 30'], { detached: true, stdio: 'ignore' });
  const otherDone = new Promise((r) => other.once('exit', r));
  let next: ReturnType<typeof h.run> | undefined;
  try {
    fs.writeFileSync(path.join(h.home, 'alias-target'), `${other.pid} ${group}`);
    process.kill(worker, 'SIGKILL');
    next = h.run(['sh', '-c', 'echo entered-next-lease']);
    await until(() => next!.output.includes('entered-next-lease'), 'retired registration treated the unrelated group as uncertain');
    assert.equal(other.exitCode, null, 'cleanup signalled an unrelated process');
    assert.equal(other.signalCode, null, 'cleanup signalled an unrelated process');
  } finally {
    if (other.exitCode === null && other.signalCode === null) other.kill('SIGKILL');
    await otherDone;
  }
  assert.equal(await next!.done, 0, next!.output);
});

for (const loss of ['owner', 'transport'] as const) test(`${loss} loss reaps a nested orphan that lost the descriptor`, async (t) => {
  const h = host(t);
  const orphanFile = path.join(h.home, 'orphan.pid');
  const ready = path.join(h.home, 'nested-ready');
  const nested = path.join(h.home, 'nested.mjs');
  fs.writeFileSync(nested, `import fs from 'node:fs'; import { spawn } from 'node:child_process';
    const c = spawn('perl', ['-MPOSIX', '-e', 'POSIX::close(197); $SIG{HUP}=$SIG{TERM}="IGNORE"; my $p=fork() // die $!; exit 0 if $p; open(my $f, ">", $ARGV[0]); print {$f} $$; close $f; sleep 1 while 1;', process.argv[2]], { stdio: 'ignore' });
    c.once('exit', () => fs.writeFileSync(process.argv[3], ''));
    setInterval(() => {}, 1000);`);
  const entry = path.join(h.home, 'worker.mjs');
  fs.writeFileSync(entry, `import { GpuiDriver } from ${JSON.stringify(path.join(root, 'features/support/gpui.ts'))};
    new GpuiDriver().child(process.execPath, ${JSON.stringify([nested, orphanFile, ready])}, {}); setInterval(() => {}, 1000);`);
  const first = h.run([process.execPath, entry]);
  await until(() => fs.existsSync(ready) && fs.existsSync(orphanFile) && Number(fs.readFileSync(orphanFile, 'utf8')) > 1, 'nested orphan did not start');
  const pid = Number(fs.readFileSync(orphanFile, 'utf8'));
  const firstBorn = born(String(pid));
  const stopOrphan = () => {
    const now = born(String(pid));
    if (firstBorn && now === firstBorn) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  };
  if (loss === 'owner') first.kill('SIGKILL');
  else { first.stdout!.destroy(); first.stderr!.destroy(); first.stdin!.end(); }
  const next = h.run(['sh', '-c', 'echo entered-next-lease']);
  try {
    await until(() => next.output.includes('entered-next-lease'), 'cancelled lease did not finish nested group cleanup');
    const state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
    assert.ok(!state || state.startsWith('Z'), `nested orphan survived ${loss} cancellation: ${state}`);
  } finally { stopOrphan(); }
  assert.equal(await next.done, 0, next.output);
});
