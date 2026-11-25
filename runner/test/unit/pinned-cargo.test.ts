// desktop/scripts/pinned-cargo.sh: the Rust that builds the app a Mac runs
// is exactly the three archives main pins by SHA-256, each checked before
// it's unpacked, and nothing of rustup's (Daybreak 173). The archives here
// are small stand-ins laid out as Rust's are, served from a folder
// (THREADBEAR_RUST_DIST), never fetched. Mac only: it unpacks with ditto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { tmpDir } from '../helpers/fakes.ts';

const SCRIPT = path.join(import.meta.dirname, '..', '..', '..', 'desktop', 'scripts', 'pinned-cargo.sh');
const mac = { skip: process.platform !== 'darwin' && 'macOS only' };
const HOST = 'aarch64-apple-darwin';
const PARTS = { rustc: 'rustc', cargo: 'cargo', 'rust-std': `rust-std-${HOST}` } as const;

function write(file: string, text: string, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

// One of Rust's archives: <part>-<version>-<host>/components, and the
// component's folder laid out as it goes in the toolchain.
function archive(dist: string, part: keyof typeof PARTS, files: Record<string, string>) {
  const name = `${part}-1.99.1-${HOST}`;
  const stage = path.join(dist, 'stage', name);
  write(path.join(stage, 'components'), `${PARTS[part]}\n`);
  for (const [rel, text] of Object.entries(files)) write(path.join(stage, PARTS[part], rel), text, rel.startsWith('bin/') ? 0o755 : 0o644);
  write(path.join(stage, PARTS[part], 'manifest.in'), 'file:bin/x\n');
  const out = path.join(dist, `${name}.tar.xz`);
  const r = spawnSync('tar', ['-cJf', out, '-C', path.dirname(stage), name]);
  assert.equal(r.status, 0, String(r.stderr));
  fs.rmSync(path.join(dist, 'stage'), { recursive: true });
  return createHash('sha256').update(fs.readFileSync(out)).digest('hex');
}

function world(o: { tamper?: keyof typeof PARTS; toolchain?: string; pins?: (good: string) => string } = {}) {
  const root = fs.realpathSync(tmpDir());
  const repo = path.join(root, 'repo');
  const dist = path.join(root, 'dist');
  const marks = path.join(root, 'marks');
  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(marks, { recursive: true });
  write(path.join(repo, 'desktop', 'scripts', 'pinned-cargo.sh'), fs.readFileSync(SCRIPT, 'utf8'), 0o755);
  write(path.join(repo, 'rust-toolchain.toml'), o.toolchain ?? '[toolchain]\nchannel = "1.99.1"\ncomponents = ["rustfmt", "clippy"]\n');
  const shas = {
    rustc: archive(dist, 'rustc', { 'bin/rustc': `#!/bin/sh\necho rustc-ran >> '${marks}/rustc'\n`, 'lib/librustc_driver.dylib': 'lib' }),
    cargo: archive(dist, 'cargo', { 'bin/cargo': `#!/bin/sh\necho "cargo $* rustc=$RUSTC toolchain=\${RUSTUP_TOOLCHAIN-unset} wrap=[$RUSTC_WRAPPER$CARGO_BUILD_RUSTC_WRAPPER$RUSTC_WORKSPACE_WRAPPER]" >> '${marks}/cargo'\n` }),
    'rust-std': archive(dist, 'rust-std', { [`lib/rustlib/${HOST}/lib/libstd.rlib`]: 'std' }),
  };
  const good = Object.entries(shas).map(([part, sha]) => `1.99.1 ${HOST} ${part} ${sha} https://static.rust-lang.org/dist/2026-10-15/${part}-1.99.1-${HOST}.tar.xz`).join('\n');
  write(path.join(repo, 'desktop', 'scripts', 'rust-toolchain.pins'), `# version target part sha256 url\n${o.pins ? o.pins(good) : good}\n`);
  // After pinning: the archive served is another one under the same name.
  if (o.tamper) archive(dist, o.tamper, { [o.tamper === 'cargo' ? 'bin/cargo' : 'bin/rustc']: `#!/bin/sh\ntouch '${marks}/pwned'\n` });
  const cache = path.join(root, 'cache');
  // A rustup on the PATH notes it if it's ever run.
  write(path.join(root, 'bin', 'rustup'), `#!/bin/sh\necho "$*" >> '${marks}/rustup'\n`, 0o755);
  const run = (...args: string[]) => {
    const r = spawnSync('/bin/bash', [path.join(repo, 'desktop', 'scripts', 'pinned-cargo.sh'), ...args], {
      encoding: 'utf8',
      env: { HOME: root, PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`, THREADBEAR_RUST_CACHE: cache, THREADBEAR_RUST_DIST: dist, THREADBEAR_RUST_HOST: HOST, RUSTUP_TOOLCHAIN: 'stable' },
    });
    const marked = (what: string) => (fs.existsSync(path.join(marks, what)) ? fs.readFileSync(path.join(marks, what), 'utf8') : '');
    return { status: r.status, out: r.stdout + r.stderr, marked };
  };
  const prefix = () => {
    const made = fs.existsSync(cache) ? fs.readdirSync(cache).filter((f) => f.startsWith(`1.99.1-${HOST}-`)) : [];
    return path.join(cache, made[0] ?? 'none');
  };
  const start = () => spawn('/bin/bash', [path.join(repo, 'desktop', 'scripts', 'pinned-cargo.sh'), 'build'], {
    env: { HOME: root, PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`, THREADBEAR_RUST_CACHE: cache, THREADBEAR_RUST_DIST: dist, THREADBEAR_RUST_HOST: HOST },
    stdio: 'ignore',
  });
  return { root, dist, cache, prefix, marks, run, start };
}

test('the pinned archives are checked, put together as a toolchain, and its cargo runs with its own rustc', mac, () => {
  const w = world();
  const r = w.run('build', '--release');
  assert.equal(r.status, 0, r.out);
  assert.equal(r.marked('cargo'), `cargo build --release rustc=${w.prefix()}/bin/rustc toolchain=unset wrap=[]\n`);
  assert.ok(fs.existsSync(path.join(w.prefix(), 'lib', 'rustlib', HOST, 'lib', 'libstd.rlib')));
  assert.ok(fs.existsSync(path.join(w.prefix(), 'lib', 'librustc_driver.dylib')));
  assert.equal(fs.existsSync(path.join(w.prefix(), 'manifest.in')), false);
  assert.equal(r.marked('rustup'), '', 'rustup never ran');
  // Later builds reuse it: nothing is fetched again.
  fs.rmSync(w.dist, { recursive: true });
  assert.equal(w.run('build').status, 0);
});

test('an archive that is not the pinned one is refused before anything from it is unpacked or run', mac, () => {
  for (const part of ['rustc', 'cargo', 'rust-std'] as const) {
    const w = world({ tamper: part });
    const r = w.run('build');
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, new RegExp(`Rust 1\\.99\\.1's ${part} for ${HOST} isn't the one main pins`));
    assert.equal(fs.existsSync(w.prefix()), false, 'no toolchain made');
    assert.equal(r.marked('pwned'), '');
    assert.equal(r.marked('cargo'), '');
    assert.deepEqual(fs.readdirSync(w.cache).filter((f) => !f.startsWith('.')), []);
  }
});

test('no exact version, or pins that miss a part, point elsewhere or are malformed, fetch and build nothing', mac, () => {
  const cases: { toolchain?: string; pins?: (good: string) => string }[] = [
    { toolchain: '[toolchain]\nchannel = "stable"\n' },
    { toolchain: '[toolchain]\nchannel = "1.99"\n' },
    { pins: (g) => g.split('\n').filter((l) => !/ rust-std /.test(l)).join('\n') },
    { pins: (g) => `${g}\n${g.split('\n')[0]}` },
    { pins: (g) => g.replaceAll('https://static.rust-lang.org/', 'https://evil.example/') },
    { pins: (g) => g.replaceAll('http', 'file') },
    { pins: (g) => g.replace(/ [0-9a-f]{64} /, ' abc ') },
    { pins: (g) => g.replaceAll('1.99.1 ', '1.98.0 ') },
  ];
  for (const o of cases) {
    const w = world(o);
    const r = w.run('build');
    assert.equal(r.status, 1, `${JSON.stringify(o.toolchain)} ${o.pins}: ${r.out}`);
    assert.equal(fs.existsSync(w.prefix()), false);
    assert.equal(r.marked('cargo'), '');
  }
});

test("a toolchain folder that isn't what its pins say is never run", mac, () => {
  const w = world();
  assert.equal(w.run('build').status, 0);
  fs.writeFileSync(path.join(w.prefix(), 'pinned'), 'from older pins\n');
  fs.writeFileSync(path.join(w.prefix(), 'bin', 'cargo'), `#!/bin/sh\ntouch '${w.marks}/stale'\n`, { mode: 0o755 });
  const r = w.run('build');
  assert.equal(r.status, 1, r.out);
  assert.equal(r.marked('stale'), '', "its cargo never ran");
});

test('two first builds at once both build, and neither takes the toolchain from under the other', mac, async () => {
  const w = world();
  const ends = await Promise.all([w.start(), w.start(), w.start()].map((c) => new Promise<number | null>((done) => c.on('exit', done))));
  assert.deepEqual(ends, [0, 0, 0]);
  assert.equal(w.run('build').status, 0);
  assert.deepEqual(fs.readdirSync(w.cache).length, 1, 'one toolchain, and nothing left of the copies that lost');
  assert.equal(w.run('build').marked('cargo').split('\n').filter(Boolean).length, 5);
});

test('pins with an extra part for this Mac are refused', mac, () => {
  const w = world({ pins: (g) => `${g}\n1.99.1 ${HOST} rust-src ${'a'.repeat(64)} https://static.rust-lang.org/dist/2026-10-15/rust-src-1.99.1.tar.xz` });
  assert.equal(w.run('build').status, 1);
});

test('a wrapper set for rustc, in the environment or cargo\'s config, is turned off', mac, () => {
  const w = world();
  const r = spawnSync('/bin/bash', [path.join(w.root, 'repo', 'desktop', 'scripts', 'pinned-cargo.sh'), 'build'], {
    encoding: 'utf8',
    env: { HOME: w.root, PATH: '/usr/bin:/bin', THREADBEAR_RUST_CACHE: w.cache, THREADBEAR_RUST_DIST: w.dist, THREADBEAR_RUST_HOST: HOST, RUSTC_WRAPPER: '/tmp/evil', CARGO_BUILD_RUSTC_WRAPPER: '/tmp/evil', RUSTC_WORKSPACE_WRAPPER: '/tmp/evil' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(w.marks, 'cargo'), 'utf8'), /wrap=\[\]$/m);
});
