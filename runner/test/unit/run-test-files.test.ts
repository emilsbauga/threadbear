// test/helpers/run-test-files.mjs: check.sh's way of running the unit test
// files, as `node --test` does but the longest first.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { PATIENCE_MS } from '../helpers/patience.ts';
import { NO_SIGNALS_ON_WINDOWS } from '../helpers/platform.ts';
import { test } from 'node:test';

const helpers = path.resolve(import.meta.dirname, '../helpers');
const DRIVER = path.join(helpers, 'run-test-files.mjs');

// A folder of test files, each writing its name to `log` as it starts.
function files(t: { after: (fn: () => void) => void }, names: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-run-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'test'));
  for (const [name, body] of Object.entries(names)) {
    fs.writeFileSync(path.join(dir, 'test', `${name}.test.mjs`), `import { test } from 'node:test';
import fs from 'node:fs';
test(${JSON.stringify(name)}, () => { fs.appendFileSync(${JSON.stringify(path.join(dir, 'log'))}, ${JSON.stringify(`${name}\n`)}); ${body} });
`);
  }
  const run = (...args: string[]) => {
    fs.rmSync(path.join(dir, 'log'), { force: true });
    const r = spawnSync(process.execPath, [DRIVER, '--test-concurrency=1', ...args], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    const log = fs.existsSync(path.join(dir, 'log')) ? fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n') : [];
    return { status: r.status, out: r.stdout + r.stderr, log };
  };
  return { dir, run };
}

test('files run longest first by the times kept, new ones before them all, and each run writes its times', (t) => {
  const f = files(t, { a: '', b: '', c: '', d: '' });
  const times = path.join(f.dir, 'times');
  // With no times yet, in order of name, as node --test.
  const first = f.run(`--times=${times}`, 'test/*.test.mjs');
  assert.equal(first.status, 0, first.out);
  assert.deepEqual(first.log, ['a', 'b', 'c', 'd']);
  const kept = fs.readFileSync(times, 'utf8').trim().split('\n').map((l) => l.split(' ')[1]).sort();
  assert.deepEqual(kept, ['test/a.test.mjs', 'test/b.test.mjs', 'test/c.test.mjs', 'test/d.test.mjs']);
  assert.match(fs.readFileSync(times, 'utf8'), /^\d+ test\/a\.test\.mjs$/m);
  // c took longest, then a; d is new (no line): it goes first.
  fs.writeFileSync(times, '10 test/a.test.mjs\n5 test/b.test.mjs\n900 test/c.test.mjs\n');
  const again = f.run(`--times=${times}`, 'test/a.test.mjs', 'test/b.test.mjs', 'test/c.test.mjs', 'test/d.test.mjs');
  assert.equal(again.status, 0, again.out);
  assert.deepEqual(again.log, ['d', 'c', 'a', 'b']);
  // Whole paths, as the failed-files reporter hands back for a second run,
  // are the same files.
  fs.writeFileSync(times, '900 test/b.test.mjs\n');
  const whole = f.run(`--times=${times}`, path.join(f.dir, 'test/a.test.mjs'), path.join(f.dir, 'test/b.test.mjs'));
  assert.deepEqual(whole.log, ['a', 'b'], 'a, with no time, first');
  assert.match(fs.readFileSync(times, 'utf8'), /^\d+ test\/a\.test\.mjs$/m);
});

test('a failure exits 1, and each reporter gets every event, as node --test gives them', (t) => {
  const f = files(t, { a: '', b: "throw new Error('b broke');", c: '' });
  const failed = path.join(f.dir, 'failed');
  const passed = path.join(f.dir, 'passed');
  const r = f.run(
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${path.join(helpers, 'failed-files-reporter.mjs')}`, `--test-reporter-destination=${failed}`,
    `--test-reporter=${path.join(helpers, 'passed-files-reporter.mjs')}`, `--test-reporter-destination=${passed}`,
    'test/*.test.mjs',
  );
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /✖ b/);
  assert.match(r.out, /ℹ pass 2/);
  assert.doesNotMatch(r.out, /MaxListenersExceededWarning/);
  assert.deepEqual(fs.readFileSync(failed, 'utf8').trim().split('\n').map((p) => path.basename(p)), ['b.test.mjs']);
  assert.deepEqual(fs.readFileSync(passed, 'utf8').trim().split('\n').map((p) => path.basename(p)).sort(), ['a.test.mjs', 'c.test.mjs']);
  const ok = f.run('test/a.test.mjs', 'test/c.test.mjs');
  assert.equal(ok.status, 0, ok.out);
});

test('an option it does not know, a reporter without a destination, or a missing file stops it before anything runs', (t) => {
  const f = files(t, { a: '' });
  for (const args of [['--test-only', 'test/a.test.mjs'], ['--test-reporter=spec', '--test-reporter=dot', '--test-reporter-destination=stdout', 'test/a.test.mjs'], ['test/missing.test.mjs']]) {
    const r = f.run(...args);
    assert.notEqual(r.status, 0, `${args.join(' ')}: ${r.out}`);
    assert.deepEqual(r.log, [], args.join(' '));
  }
});

// Codex's review: run() alone, unlike node --test, leaves the files' own
// processes running when it's stopped, and the reporters never finish.
test('stopped with SIGTERM, it ends the files still running and the reporters still say what failed', NO_SIGNALS_ON_WINDOWS, async (t) => {
  const f = files(t, { a: '', long: "fs.writeFileSync(process.env.PID_FILE, String(process.pid)); return new Promise((r) => setTimeout(r, 120_000));" });
  const pidFile = path.join(f.dir, 'pid');
  const failed = path.join(f.dir, 'failed');
  const child = spawn(process.execPath, [DRIVER, '--test-concurrency=1',
    `--test-reporter=${path.join(helpers, 'failed-files-reporter.mjs')}`, `--test-reporter-destination=${failed}`,
    'test/a.test.mjs', 'test/long.test.mjs'], { cwd: f.dir, env: { ...process.env, PID_FILE: pidFile }, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const end = Date.now() + PATIENCE_MS;
  while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8')) {
    assert.ok(Date.now() < end, 'the long file never started');
    await new Promise((r) => setTimeout(r, 20));
  }
  const worker = Number(fs.readFileSync(pidFile, 'utf8'));
  child.kill('SIGTERM');
  assert.equal(await new Promise((r) => child.once('exit', (code) => r(code))), 143);
  assert.throws(() => process.kill(worker, 0), 'the long file\'s process outlived the run');
  assert.deepEqual(fs.readFileSync(failed, 'utf8').trim().split('\n').map((p) => path.basename(p)), ['long.test.mjs']);
});

// Loaded in the driver too, clean-env.ts gave each file a temp HOME inside
// the driver's own, and the Codex adapter tests' socket paths grew past
// Linux's limit: both files hung (24 Nov 2026). node --test loads it only
// in the files' processes, and so does this.
test('--import is loaded in each file\'s process, and not in the one that runs them', (t) => {
  const f = files(t, { a: '', b: '' });
  const seen = path.join(f.dir, 'imported');
  const preload = path.join(f.dir, 'preload.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(seen)}, process.argv.slice(1).join(' ') + '\\n');`);
  const r = f.run(`--import=${pathToFileURL(preload).href}`, 'test/a.test.mjs', 'test/b.test.mjs');
  assert.equal(r.status, 0, r.out);
  const lines = fs.readFileSync(seen, 'utf8').trim().split('\n').sort();
  assert.equal(lines.length, 2, lines.join('\n'));
  assert.match(lines[0], /a\.test\.mjs$/);
  assert.match(lines[1], /b\.test\.mjs$/);
});

// Codex's review: given to node itself, a name filter reached run() and
// left out whole files, which then passed by not running.
test('a test filter in NODE_OPTIONS stops it, rather than leaving files out', (t) => {
  const f = files(t, { a: "throw new Error('a broke');" });
  const r = spawnSync(process.execPath, [DRIVER, 'test/a.test.mjs'], { cwd: f.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '--test-name-pattern=nothing' } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /NODE_OPTIONS/);
});
