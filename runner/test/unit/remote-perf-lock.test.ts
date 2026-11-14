// Execute remote.sh against a local fake ssh host: its real copy/prelude/run
// paths and real locks, without any build, GUI, network or installed runner.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '../../..');

for (const perf of [false, true]) test(`remote.sh holds both locks and passes nesting with ${perf ? 'shared perf' : 'per-checkout'} target`, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-remote-perf-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const home = path.join(work, 'home');
  const bin = path.join(work, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/bash\ncd "$HOME"\nexec /bin/bash -c "${@: -1}"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'rsync'), `#!/bin/bash
src="\${@: -2:1}"
dest="$HOME/\${!#}"
dest="\${dest/host:/}"
mkdir -p "$dest/scripts" "$dest/runner/scripts" "$dest/desktop"
for name in perf-lock.pl perf-children.pl hangup-guard.sh remote-guard-lib.sh build-priority.sh perf-build.sh; do
  [ ! -f "$src/scripts/$name" ] || cp "$src/scripts/$name" "$dest/scripts/"
done
cp "$src/runner/scripts/find-node.sh" "$dest/runner/scripts/"
for dir in features app/Tools/mock-runner runner; do mkdir -p "$dest/$dir/node_modules"; done
`, { mode: 0o755 });
  // df is called during heavy cache trimming and again after the command.
  // Prove those phases own both locks too, not just the benchmark body.
  fs.writeFileSync(path.join(bin, 'df'), `#!/bin/bash
perl -MFcntl=:flock -e 'for my $p (@ARGV) { open(my $f, ">>", $p) or die $!; if (flock($f, LOCK_EX | LOCK_NB)) { open(my $bad, ">", "$ENV{HOME}/unlocked"); print {$bad} $p; } }' "$HOME/.cache/threadbear-perf.lock" "$HOME/.cache/threadbear-check/lock"
echo 'Filesystem 1024-blocks Used Available Capacity Mounted'
echo 'fake 0 0 41943040 0% /'
`, { mode: 0o755 });
  const entry = path.join(home, 'measurement.mjs');
  fs.writeFileSync(entry, `import { ensurePerfLock } from ${JSON.stringify(path.join(root, 'features/tools/perf-lock.ts'))}; await ensurePerfLock(); console.log('nested measurement');`);
  const probe = 'use Fcntl ":flock"; for my $p (@ARGV) { open(my $f, ">>", $p) or die $!; if (flock($f, LOCK_EX | LOCK_NB)) { die "host lock not held: $p\\n"; } } print "both locked\\n";';
  const child = spawn('/bin/bash', [path.join(root, 'desktop/scripts/remote.sh'), 'host', ...(perf ? ['--perf'] : []), '--', 'bash', '-c', 'perl -e "$1" "$HOME/.cache/threadbear-perf.lock" "$HOME/.cache/threadbear-check/lock" && "$2" "$3" && echo "target=$CARGO_TARGET_DIR"', 'probe', probe, process.execPath, entry], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, THREADBEAR_NODE: process.execPath, THREADBEAR_PERF_LOCK_OWNER: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (s) => { output += s; });
  child.stderr!.on('data', (s) => { output += s; });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 15_000);
  t.after(() => clearTimeout(timeout));
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0, output);
  assert.ok(!fs.existsSync(path.join(home, 'unlocked')), 'cache trim and postlude hold both host locks');
  assert.match(output, /both locked\nnested measurement/);
  assert.match(output, perf ? /target=.*\/perf-target/ : /target=.*\/target-[a-f0-9]+/);
  const base = path.join(home, '.cache/threadbear-check/gpui');
  const src = fs.readdirSync(base).find((name) => name.startsWith('src-'))!;
  assert.ok(fs.existsSync(path.join(base, src, '.in-use')), 'source lease starts before lock waiting');
});
