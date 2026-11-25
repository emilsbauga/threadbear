// The reporter that says where the unit tests are while they run
// (test/helpers/progress-reporter.mjs), for GitHub's runs: check.sh keeps
// the tests' output in a log file, so the step printed nothing until it
// ended, and a run stopped at the job's time limit never said which file
// it was on (runner.yml's Mac jobs, 22 to 23 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpDir } from '../helpers/fakes.ts';

// As file URLs: node takes a reporter's absolute Windows path (D:\...) for
// a URL with the scheme d: and won't load it.
const REPORTER = pathToFileURL(path.resolve(import.meta.dirname, '../helpers/progress-reporter.mjs')).href;
const FAILED_FILES = pathToFileURL(path.resolve(import.meta.dirname, '../helpers/failed-files-reporter.mjs')).href;

test('it names the files still running each interval, and the slowest at the end', () => {
  const dir = tmpDir();
  const put = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text);
  const mark = (name: string) => `fs.writeFileSync(${JSON.stringify(path.join(dir, name))}, '');`;
  // A test that never gives the event loop back, as one that waits on
  // spawnSync does: nothing of its own would say it's still going. First
  // by name: node holds back what later files report (their passes, their
  // summaries) until the files before it are done, so a file is done
  // here when node says its process ended, not when its results come. It
  // waits until the others have run, then three intervals more, however
  // slow the machine.
  const wait = `const fs = require('node:fs'); const t = Date.now(); const go = () => { if (['b', 'c', 'd'].every((n) => fs.existsSync(${JSON.stringify(dir)} + '/' + n + '.ran')) || Date.now() - t > 40000) setTimeout(() => {}, 3000); else setTimeout(go, 50); }; go();`;
  put('a-stuck.test.mjs', `import { test } from 'node:test';\nimport { spawnSync } from 'node:child_process';\ntest('waits', () => { spawnSync(process.execPath, ['-e', ${JSON.stringify(wait)}]); });\n`);
  // (Its second test is made in a helper, and reports from that file's
  // path: not a test file, so not counted.)
  put('helper.mjs', "import { test } from 'node:test';\nexport const made = () => test('from the helper', () => {});\n");
  put('b-quick.test.mjs', `import { test } from 'node:test';\nimport fs from 'node:fs';\nimport { made } from './helper.mjs';\ntest('ok', () => { ${mark('b.ran')} });\nmade();\n`);
  // One that never gets as far as a test.
  put('c-broken.test.mjs', `import fs from 'node:fs';\n${mark('c.ran')}\nthrow new Error('no such module');\n`);
  // And one whose first test has the file's own name: its ending isn't the file's.
  put('d-named.test.mjs', `import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('d-named.test.mjs', () => {});\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 1500)); ${mark('d.ran')} });\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, THREADBEAR_TEST_PROGRESS_SECS: '1' };
  delete env.NODE_TEST_CONTEXT;
  // As check.sh runs it on GitHub: third of three reporters, on stderr.
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=4',
    '--test-reporter=spec', '--test-reporter-destination=stdout',
    `--test-reporter=${FAILED_FILES}`, `--test-reporter-destination=${path.join(dir, 'failed')}`,
    `--test-reporter=${REPORTER}`, '--test-reporter-destination=stderr',
    'a-stuck.test.mjs', 'b-quick.test.mjs', 'c-broken.test.mjs', 'd-named.test.mjs'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const lines = r.stderr.split('\n').filter(Boolean);
  // Nothing else is on its stream: node's own warning that three reporters
  // on one stream look like a leak would land in the job's log beside it.
  assert.deepEqual(lines.filter((l) => !l.startsWith('        ')), []);
  assert.doesNotMatch(r.stderr, /helper\.mjs/);
  // What's done, of how many, and how long the one still going has been.
  const beats = lines.filter((l) => /test files done/.test(l));
  assert.match(beats.at(-1) ?? '', /^ {8}\d+s: 3 of 4 test files done, still running: a-stuck\.test\.mjs \(\d+s\)$/, r.stderr);
  const last = lines.at(-1) ?? '';
  assert.match(last, /^ {8}slowest test files: a-stuck\.test\.mjs \d+s(, [bcd]-\w+\.test\.mjs \d+s){3}$/, r.stderr);
  assert.match(last, /d-named\.test\.mjs [1-9]\d*s/, r.stderr);
});
