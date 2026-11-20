// Runs the runner's unit tests on Windows in two groups (from Keith's
// Windows port; .github/workflows/runner.yml runs it): the files that
// should pass (a failure fails the run) and the ones in
// test/windows-known-failing.txt (a report, so the list can shrink as the
// port goes). Usage, from runner/:
//
//   node scripts/test-windows.mjs            the files that should pass
//   node scripts/test-windows.mjs --known    the known-failing files, as a report
//   node scripts/test-windows.mjs --gate     the files a runner's update must pass
//                                            (test/windows-update-gate.txt)
//   node scripts/test-windows.mjs a.test.ts  just those files
//
// Each test gets 30 seconds (60 on CI), not the package's five minutes, so a
// test waiting on something Windows can't give fails fairly quickly. The
// limit has to leave room for load: node runs several files at once, and a
// test that starts runners or reads process start times through PowerShell
// takes 3 s on a quiet machine and over 40 s when every core is busy. At
// 15 s, CI failed main.test.ts on the clock alone (6 Nov). The limit can be
// set with THREADBEAR_TEST_TIMEOUT_MS.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unit = path.join(root, 'test', 'unit');
const readList = (name) =>
  fs
    .readFileSync(path.join(root, 'test', name), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
const known = new Set(readList('windows-known-failing.txt'));
const gate = readList('windows-update-gate.txt');
const all = fs.globSync('**/*.test.ts', { cwd: unit }).map((f) => f.split(path.sep).join('/')).sort();

for (const [list, names] of [['windows-known-failing.txt', known], ['windows-update-gate.txt', gate]]) {
  for (const k of names) {
    if (!all.includes(k)) {
      console.error(`${list} lists ${k}, which is not a unit test file`);
      process.exit(2);
    }
  }
}

const args = process.argv.slice(2);
const wantKnown = args.includes('--known');
const wantGate = args.includes('--gate');
const named = args.filter((a) => !a.startsWith('--'));
const files = named.length ? named : wantGate ? gate : all.filter((f) => known.has(f) === wantKnown);

const perTest = Number(process.env.THREADBEAR_TEST_TIMEOUT_MS) || (process.env.CI ? 60_000 : 30_000);
// Files run side by side (Node's default is one fewer than the cores). On a
// 4-core GitHub runner that left the tests that wait on a hook or a git process a
// few times slower than they expect, and a different one failed in about one run
// in five (8 Nov), so CI runs two at a time. THREADBEAR_TEST_CONCURRENCY sets it anywhere.
const concurrency = Number(process.env.THREADBEAR_TEST_CONCURRENCY) || (process.env.CI ? 2 : 0);

console.log(`${wantGate ? 'update gate' : wantKnown ? 'known-failing' : 'expected-to-pass'}: ${files.length} files, ${perTest / 1000} s a test${concurrency ? `, ${concurrency} files at a time` : ''}`);
// node --test with no files would run whatever it finds in the folder.
if (!files.length) process.exit(0);
const r = spawnSync(
  process.execPath,
  ['--import=./test/helpers/clean-env.ts', '--test', '--test-reporter=spec', `--test-timeout=${perTest}`, '--test-force-exit', ...(concurrency ? [`--test-concurrency=${concurrency}`] : []), ...files.map((f) => path.join(unit, f))],
  { cwd: root, stdio: 'inherit' },
);
// The known list is a report: it never fails the run.
process.exit(wantKnown ? 0 : (r.status ?? 1));
