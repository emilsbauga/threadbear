// A node:test reporter that says where a run is while it goes: every minute
// a line with how many test files are done and which are still running, for
// how long, and at the end the slowest files. check.sh adds it on GitHub
// (runner_unit_tests), where the tests' own output goes to a log file nobody
// can read while the job runs: runner.yml's Mac jobs printed nothing for 29
// minutes and were stopped at their 30, 18 runs in a row (22 to 23 Nov
// 2026), and no log said which file the time went on. It was one whose test
// waited on spawnSync for minutes, which no --test-timeout stops (the timer
// can't fire while the test holds the event loop), so the timer here is in
// the process that runs the files, not theirs.
//
// A stream, not a generator: a generator only speaks when an event comes,
// and stuck files send none. Plain .mjs so node loads it without a loader.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { Transform } from 'node:stream';

const EVERY_MS = (Number(process.env.THREADBEAR_TEST_PROGRESS_SECS) || 60) * 1000;
const SLOWEST = 10;
// More than run at once only if something here is wrong; the line stays short.
const NAMED = 8;

// node warns of a leak ("11 end listeners added to [TestsStream]") whenever
// three reporters read its one stream of events, as they do here (spec, the
// failed files, this). This reporter's lines go to the job's log, where
// that would read as something wrong. Only in the process that runs the
// files: the test files' own processes load no reporter.
if (EventEmitter.defaultMaxListeners < 30) EventEmitter.defaultMaxListeners = 30;

const span = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};

const began = Date.now();
const all = new Set(); // every test file
const running = new Map(); // file → when node started it
const took = []; // [ms, file]
const done = new Set();

function beat() {
  // The longest running first: that's the one a stopped job was on.
  const now = Date.now();
  const still = [...running].sort((a, b) => a[1] - b[1]).map(([f, at]) => `${path.basename(f)} (${span(now - at)})`);
  const named = still.length > NAMED ? [...still.slice(0, NAMED), `${still.length - NAMED} more`] : still;
  return `        ${span(now - began)}: ${done.size} of ${all.size} test files done${named.length ? `, still running: ${named.join(', ')}` : ''}\n`;
}

// node runs each file as a test of its own, named for the file, around the
// file's tests. That one's events say when the file's process was queued
// (every file, as the run starts), started and ended, as it happens, and
// they're all this goes by. What the file's tests report (test:pass, the
// file's test:summary) is held back until every file before it is done, so
// going by those a quick file after a stuck one read as still running, and
// the slowest (Codex's review); and a test made in a helper reports from
// the helper's path, which is no test file.
//
// It's told from a test in the file that happens to be named for it by
// where it's "written": the file's first character, where no test can be,
// and (from Node 24.22) by having no entryFile, which node puts on what a
// file's own process sent. Should a newer node say it another way, no file
// is counted and check-cache.test.ts, which looks for the last line, fails.
function theFileItself(event) {
  const d = event.data;
  if (d.nesting !== 0 || d.entryFile !== undefined || (d.line ?? 1) !== 1 || (d.column ?? 1) !== 1) return false;
  const name = String(d.name ?? '');
  return name !== '' && String(d.file).split(path.sep).join('/').endsWith(name.split(path.sep).join('/'));
}

function finish(file, ms) {
  done.add(file);
  took.push([ms ?? Date.now() - (running.get(file) ?? Date.now()), file]);
  running.delete(file);
}

const reporter = new Transform({
  writableObjectMode: true,
  transform(event, _encoding, callback) {
    const file = event.data?.file;
    if (file && !done.has(file) && theFileItself(event)) {
      all.add(file);
      if (event.type === 'test:dequeue') running.set(file, Date.now());
      // Its process ended: a file that didn't load ends this way too.
      else if (event.type === 'test:complete') finish(file, event.data.details?.duration_ms);
    }
    callback();
  },
  flush(callback) {
    clearInterval(timer);
    const slowest = took.sort((a, b) => b[0] - a[0]).slice(0, SLOWEST).map(([ms, f]) => `${path.basename(f)} ${span(ms)}`);
    callback(null, slowest.length ? `        slowest test files: ${slowest.join(', ')}\n` : '');
  },
});

const timer = setInterval(() => {
  if (reporter.destroyed || reporter.readableEnded) clearInterval(timer);
  else reporter.push(beat());
}, EVERY_MS);
timer.unref();

export default reporter;
