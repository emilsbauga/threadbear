// desktop/scripts/switch-from-swift.sh, which the Swift app's "Start using
// the new app" thread runs on someone else's Mac. Tried end to end on Tinker
// Desk as a stranger's copy (15 Nov 2026): with no Rust and a cold cache it
// took 31 minutes and about 4 GB, where the thread's brief said 10 minutes
// and 3 GB. Here, with stage-update.sh replaced by a stub on main, so
// nothing is built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = path.join(REPO, 'desktop', 'scripts', 'switch-from-swift.sh');
const GiB = 1024 * 1024;
// The script is only for a Mac (and needs its df and ditto), so a Linux
// check host skips these.
const mac = { skip: process.platform !== 'darwin' && 'macOS only' };

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

// A home with rustup and cargo in ~/.cargo/bin (so rustup is never
// fetched) unless noRust, and a checkout whose main has a stage-update.sh
// that makes an empty bundle where it's told to, or exits with stageExit.
function world(o: { noRust?: boolean; warm?: boolean; cachedMb?: number; stageExit?: number; runnerJson?: unknown } = {}) {
  const root = fs.realpathSync(tmpDir());
  const home = path.join(root, 'home');
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(path.join(home, 'tmp'), { recursive: true });
  // The pinned Rust an earlier build fetched (pinned-cargo.sh).
  if (!o.noRust) {
    const bin = path.join(home, 'Library', 'Caches', 'Threadbear', 'rust', '1.99.1-aarch64-apple-darwin', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'cargo'), '#!/bin/sh\n', { mode: 0o755 });
  }
  const cache = path.join(home, 'Library', 'Caches', 'Threadbear', 'update-desktop');
  if (o.warm) fs.mkdirSync(path.join(cache, 'target', 'release'), { recursive: true });
  if (o.cachedMb) {
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'earlier'), Buffer.alloc(o.cachedMb * 1024 * 1024, 1));
  }
  if (o.runnerJson !== undefined) {
    const data = path.join(home, 'Library', 'Application Support', 'Threadbear');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'runner.json'), JSON.stringify(o.runnerJson));
  }
  const scripts = path.join(checkout, 'desktop', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  const stage = o.stageExit
    ? `#!/bin/bash\necho "stub failed" >&2\nexit ${o.stageExit}\n`
    : '#!/bin/bash\n[ "$2" = --next ] || exit 9\nmkdir -p "$3/Contents/MacOS"\nfor b in threadbear-gpui threadbear-web-helper; do printf "#!/bin/sh\\n" > "$3/Contents/MacOS/$b"; chmod +x "$3/Contents/MacOS/$b"; done\necho staged\n';
  fs.writeFileSync(path.join(scripts, 'stage-update.sh'), stage);
  git(root, 'init', '-q', '-b', 'main', checkout);
  git(checkout, 'add', '-A');
  git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'stub');
  return { home, checkout };
}

function run(w: { home: string; checkout: string }, freeKb: number | string) {
  return spawnSync('/bin/bash', [SCRIPT, w.checkout, '--no-open'], {
    encoding: 'utf8',
    env: { HOME: w.home, TMPDIR: path.join(w.home, 'tmp'), PATH: '/usr/bin:/bin', THREADBEAR_SWITCH_FREE_KB: String(freeKb) },
  });
}

test('too little disk for Rust and a first build stops before either, saying how much it needs', mac, () => {
  const w = world({ noRust: true });
  const r = run(w, 3 * GiB);
  assert.equal(r.status, 6, r.stdout + r.stderr);
  assert.match(r.stderr, /needs about 5\.0 GB free .* has 3\.0 GB/);
  assert.doesNotMatch(r.stdout, /STEP Installing Rust/);
  assert.equal(fs.existsSync(path.join(w.home, '.cargo')), false);
});

test('with Rust already here a first build needs a little less', mac, () => {
  assert.equal(run(world(), 3 * GiB).status, 6);
  const r = run(world(), 4 * GiB);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('an empty folder cargo made at the start of a stopped try is no cache', mac, () => {
  // Grok's review: cargo makes target/release at once, so its folder alone said "warm".
  assert.equal(run(world({ warm: true }), 2 * GiB).status, 6);
});

test("what an earlier try left in the cache counts toward what's needed", mac, () => {
  assert.equal(run(world(), 4 * GiB - 32 * 1024).status, 6);
  const r = run(world({ cachedMb: 64 }), 4 * GiB - 32 * 1024);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('a build host it would use, or a check host, needs room only for the clone and bundle', mac, () => {
  assert.equal(run(world({ runnerJson: { updateBuildHosts: ['builder'] } }), 1.5 * GiB).status, 0);
  // stage-update.sh exits 5 with a check host and no update build host.
  const r = run(world({ runnerJson: { checkHost: 'checker' }, stageExit: 5 }), 1.5 * GiB);
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.match(r.stderr, /check hosts \(checkHosts or checkHost\).*Ask which Mac/);
});

test("with no Rust and another Mac (or none) doing the build, Rust isn't installed", mac, () => {
  // Grok's second look: rustup ran, and its gigabyte, for a build that never happens here.
  const w = world({ noRust: true, runnerJson: { checkHost: 'checker' }, stageExit: 5 });
  const r = run(w, 1.5 * GiB);
  assert.equal(r.status, 5, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /STEP Installing Rust/);
});

// Daybreak 173: it never installs Rust itself (no rustup, no download it
// runs): the build fetches the pinned Rust and checks it (pinned-cargo.sh).
test('with no Rust at all it installs none, and the build goes ahead', mac, () => {
  const w = world({ noRust: true });
  const r = run(w, 8 * GiB);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /STEP Installing Rust/);
  assert.equal(fs.existsSync(path.join(w.home, '.cargo')), false);
  assert.equal(fs.existsSync(path.join(w.home, '.rustup')), false);
  assert.doesNotMatch(fs.readFileSync(SCRIPT, 'utf8'), /rustup-init|sh\.rustup\.rs|curl /);
});

test('free space comes from the disk itself when nothing stands in for it', mac, () => {
  const w = world();
  const r = spawnSync('/bin/bash', [SCRIPT, w.checkout, '--no-open'], { encoding: 'utf8', env: { HOME: w.home, TMPDIR: path.join(w.home, 'tmp'), PATH: '/usr/bin:/bin' } });
  // This Mac's temp disk has room for a stub build, or the message says what it read.
  if (r.status === 6) assert.match(r.stderr, /it has \d+\.\d GB/);
  else assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("host names stage-update.sh would refuse don't count, so it still wants room to build here", mac, () => {
  for (const runnerJson of [{ updateBuildHosts: ['-oProxyCommand=x', ' spaced', 7] }, { updateBuildHosts: { a: 'h' } }, 'not an object']) {
    const r = run(world({ runnerJson }), 1.5 * GiB);
    assert.equal(r.status, 6, JSON.stringify(runnerJson) + r.stdout + r.stderr);
  }
});

test("df past the disk's reserve (a negative figure) is no room; one it can't read leaves it to the build", mac, () => {
  assert.equal(run(world(), -2048).status, 6);
  assert.equal(run(world(), 'unknown').status, 0);
});

test('with room it builds, installs into ~/Applications and says a first build takes a while', mac, () => {
  const w = world();
  const r = run(w, 50 * GiB);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /STEP Building the new app \(a first build takes 20 to 40 minutes/);
  assert.match(r.stdout, /Installed .*Threadbear GPUI\.app/);
  assert.equal(fs.existsSync(path.join(w.home, 'Applications', 'Threadbear GPUI.app', 'Contents', 'MacOS', 'threadbear-gpui')), true);
  assert.equal(fs.existsSync(path.join(w.home, 'Applications', 'Threadbear GPUI.app.installing')), false);
});

test("a folder left by a copy stopped partway isn't taken for the app: it's built and replaced", mac, () => {
  const w = world();
  // As an older script's ditto left it, killed after the main binary.
  const macos = path.join(w.home, 'Applications', 'Threadbear GPUI.app', 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(macos, 'threadbear-gpui'), '#!/bin/sh\n', { mode: 0o755 });
  const r = run(w, 50 * GiB);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /STEP Building/);
  assert.equal(fs.existsSync(path.join(w.home, 'Applications', 'Threadbear GPUI.app', 'Contents', 'MacOS', 'threadbear-gpui')), true);
});

test('an app already installed is left alone, with nothing built', mac, () => {
  const w = world();
  assert.equal(run(w, 50 * GiB).status, 0);
  const r = run(w, 0);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /STEP Building/);
});

// Setup run again after a pull: an installed app built from another
// desktop/ tree gets main's staged beside it, where its own updates go
// (Tinker Desk's second account, 19 Nov 2026: the app built it in the
// background minutes after setup said all was done).
function builtFrom(w: { home: string }, tree: string) {
  const res = path.join(w.home, 'Applications', 'Threadbear GPUI.app', 'Contents', 'Resources');
  fs.mkdirSync(res, { recursive: true });
  fs.writeFileSync(path.join(res, 'build.json'), JSON.stringify({ appTree: tree }));
}
const mainTree = (w: { checkout: string }) => spawnSync('git', ['-C', w.checkout, 'rev-parse', 'refs/heads/main:desktop'], { encoding: 'utf8' }).stdout.trim();
const next = (w: { home: string }) => path.join(w.home, 'Applications', '.Threadbear GPUI.app.next');

test("an installed app behind main gets main's build staged for its next start", mac, () => {
  const w = world();
  assert.equal(run(w, 50 * GiB).status, 0);
  builtFrom(w, 'an-older-tree');
  const r = run(w, 50 * GiB);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /STEP Building main's version of the app/);
  assert.equal(fs.existsSync(path.join(next(w), 'Contents', 'MacOS', 'threadbear-gpui')), true);
});

test('an installed app already on main builds nothing', mac, () => {
  const w = world();
  assert.equal(run(w, 50 * GiB).status, 0);
  builtFrom(w, mainTree(w));
  const r = run(w, 50 * GiB);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /STEP Building/);
  assert.equal(fs.existsSync(next(w)), false);
});

test("an installed app behind main isn't rebuilt on a disk without room, and setup goes on", mac, () => {
  const w = world();
  assert.equal(run(w, 50 * GiB).status, 0);
  builtFrom(w, 'an-older-tree');
  const r = run(w, 1);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /needs about .* GB free/);
  assert.equal(fs.existsSync(next(w)), false);
});

test("main's build failing for an installed app doesn't fail setup: its own updates try again", mac, () => {
  const w = world({ stageExit: 1 });
  const macos = path.join(w.home, 'Applications', 'Threadbear GPUI.app', 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  for (const b of ['threadbear-gpui', 'threadbear-web-helper']) fs.writeFileSync(path.join(macos, b), '#!/bin/sh\n', { mode: 0o755 });
  builtFrom(w, 'an-older-tree');
  const r = run(w, 50 * GiB);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /tries again by itself/);
});

test("a build that couldn't run says what to do in this thread, not that an app will try later", mac, () => {
  const r = run(world({ stageExit: 4 }), 50 * GiB);
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stderr, /run this again/i);
});
