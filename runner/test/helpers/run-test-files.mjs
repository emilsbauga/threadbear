// Runs test files as `node --test` does, but the slowest first. check.sh
// runs the runner's unit tests through this (runner_unit_tests), as
// `node <this> --import=./test/helpers/clean-env.ts [options] <files>`:
// each file's own process loads clean-env.ts, as with node --test, and this
// one doesn't. (Loaded here too, it gave every file a temp HOME inside this
// process's temp HOME, and the Codex adapter tests' socket paths went past
// Linux's 108 characters: both files hung, each test to its 300 s timeout,
// 24 Nov 2026.)
//
// Why: `node --test` sorts the files it's given by name, so a long file
// late in the alphabet started late and the whole run waited on it. On the
// cloud box's 15 workers (24 Nov 2026) the run took 200 s, with every
// other file done for the last minute while worktrees-landing.test.ts,
// started at 141 s, ran on; the same files longest first fit in about 160.
// So each file's time is kept (--times: "<ms> <file>" lines, in the
// check's records folder), and the next run starts the longest first,
// files with no time yet before them all. The order changes nothing else:
// each file still runs in a process of its own. And on a machine with 12
// cores or more it runs more files at once than node would
// (defaultConcurrency, below).
//
// Options, spelt as node's own (only these):
//   --import=<module>    loaded first in each file's process
//   --test-reporter=<name or path> --test-reporter-destination=<stdout,
//       stderr or a file>, in pairs, as many as wanted
//   --test-timeout=<ms>  --test-force-exit  --test-concurrency=<n>
//   --times=<file>       read for the order, written with this run's times
// The files are paths from runner/, or globs, as node takes them. It
// exits 1 when a test failed, as node does. Plain .mjs so node loads it
// without a loader.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compose } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { run } from 'node:test';
import * as builtin from 'node:test/reporters';

const reporters = [];
const destinations = [];
const patterns = [];
const imports = [];
let timeout;
let forceExit = false;
let concurrency = true;
let times;
for (const arg of process.argv.slice(2)) {
  const [flag, value] = arg.startsWith('--') ? [arg.split('=')[0], arg.slice(arg.indexOf('=') + 1)] : ['', arg];
  if (flag === '--test-reporter') reporters.push(value);
  else if (flag === '--test-reporter-destination') destinations.push(value);
  else if (flag === '--import') imports.push(value);
  else if (flag === '--test-timeout') timeout = Number(value);
  else if (flag === '--test-force-exit' && !arg.includes('=')) forceExit = true;
  else if (flag === '--test-concurrency') concurrency = Number(value);
  else if (flag === '--times') times = value;
  else if (flag === '') patterns.push(value);
  else {
    console.error(`run-test-files.mjs: unknown option ${arg}`);
    process.exit(2);
  }
}
// A name filter or --test-only given to node itself (NODE_OPTIONS) would
// reach run() here and leave out whole files, which then pass by not
// running; node --test sends them on to each file's process instead
// (Codex's review). They're for running a file by hand, never a check.
const filters = /--test-(?:name-pattern|skip-pattern|only)\b/;
if (process.execArgv.some((a) => filters.test(a)) || filters.test(process.env.NODE_OPTIONS ?? '')) {
  console.error('run-test-files.mjs: runs every test of the files it is given; leave --test-name-pattern, --test-skip-pattern and --test-only out of NODE_OPTIONS');
  process.exit(2);
}
if (reporters.length === 0 && destinations.length === 0) reporters.push('spec');
if (reporters.length === 1 && destinations.length === 0) destinations.push('stdout');
if (reporters.length !== destinations.length || (timeout !== undefined && !(timeout > 0))
  || (concurrency !== true && !(Number.isInteger(concurrency) && concurrency > 0))) {
  console.error('run-test-files.mjs: each --test-reporter needs a --test-reporter-destination, and the numbers must be numbers');
  process.exit(2);
}

// As node finds them: each argument a path or a glob, from here, sorted.
const files = [];
for (const p of patterns) {
  const found = fs.globSync(p, { exclude: (name) => path.basename(String(name)) === 'node_modules' });
  if (found.length === 0 && !/[*?[\]{}]/.test(p)) {
    console.error(`Could not find '${p}'`);
    process.exit(1);
  }
  for (const f of found.sort()) if (!files.includes(f)) files.push(f);
}

// The longest first. A file with no time yet (a new one) goes before them:
// it could be the longest, and a short one first costs next to nothing.
// By real path: node reports a file under the folder it was given, which on
// macOS can be /var/... while the cwd reads /private/var/..., and the key
// came out as ../../../var/... (seen on the M5, 24 Nov).
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const key = (f) => path.relative(real(process.cwd()), real(path.resolve(f))).split(path.sep).join('/');
const took = new Map();
if (times) {
  try {
    for (const line of fs.readFileSync(times, 'utf8').split('\n')) {
      const m = /^(\d+) (\S.*)$/.exec(line);
      if (m) took.set(m[2], Number(m[1]));
    }
  } catch {
    // none yet
  }
}
const order = files.map((f, i) => [f, took.get(key(f)) ?? Infinity, i]);
order.sort((a, b) => b[1] - a[1] || a[2] - b[2]);

// How many files at once, with no --test-concurrency: node's one fewer than
// the cores, except on a machine with 12 or more, where half as many again
// as it has. Most files spend their time waiting on processes they start,
// not working: the cloud box's 16 ran at a load of 9 with node's 15, and
// with 24 the whole run took 138 s rather than 200, with nothing failing
// that hadn't (24 Nov 2026). A machine with fewer is left as it was:
// Tinker Desk's 8 also run other threads' builds. THREADBEAR_TEST_CONCURRENCY
// sets it, as for scripts/test-windows.mjs.
function defaultConcurrency() {
  const asked = Number(process.env.THREADBEAR_TEST_CONCURRENCY);
  if (Number.isInteger(asked) && asked > 0) return asked;
  const cores = os.availableParallelism();
  return cores >= 12 ? Math.floor(cores * 1.5) : Math.max(cores - 1, 1);
}

// Every reporter loaded before the run starts, and all of them attached at
// once, as node does: one attached after the events began would miss some.
const loaded = [];
for (let i = 0; i < reporters.length; i++) {
  const name = reporters[i];
  let reporter = builtin[name];
  if (!reporter) {
    const mod = await import(/^\.{0,2}\//.test(name) || path.isAbsolute(name) ? pathToFileURL(path.resolve(name)).href : name);
    reporter = mod.default ?? mod;
  }
  if (reporter?.prototype && Object.getOwnPropertyDescriptor(reporter.prototype, 'constructor')) reporter = new reporter();
  const to = destinations[i] === 'stdout' ? process.stdout : destinations[i] === 'stderr' ? process.stderr
    : fs.createWriteStream(destinations[i], { flush: true });
  loaded.push([reporter, to]);
}

// Started from inside a test (check-cache.test.ts's runs of check.sh), it
// would hear the test's NODE_TEST_CONTEXT, and run() would then run nothing
// and pass: this process is only ever a runner of files, never a test.
delete process.env.NODE_TEST_CONTEXT;
// Stopped (Ctrl-C, or a check stopped by what runs it), the files' own
// processes go too, as node --test's do: the run is cancelled, which ends
// them, and the cancelled tests are reported. Never longer than 10 s.
const stopped = new AbortController();
// A second signal changes nothing: the first is still being acted on, and
// node's default (ending at once) would cut the reporters short (Codex).
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(signal, () => {
    if (stopped.signal.aborted) return;
    stopped.abort();
    process.exitCode = code;
    setTimeout(() => process.exit(code), 10_000).unref();
  });
}
const stream = run({
  files: order.map(([f]) => f),
  concurrency: concurrency === true ? defaultConcurrency() : concurrency,
  ...(timeout ? { timeout } : {}),
  forceExit,
  signal: stopped.signal,
  execArgv: imports.map((m) => `--import=${m}`),
});
// node warns of a leak once a run has more than three reporters (spec, the
// failed and passed files, progress-reporter.mjs on GitHub): it isn't one.
stream.setMaxListeners(50);
stream.on('test:summary', (data) => {
  if (!data.success && !stopped.signal.aborted) process.exitCode = 1;
});
for (const [reporter, to] of loaded) compose(stream, reporter).pipe(to);

// Each file's own time: the events node sends for the file itself (its
// process), told apart as progress-reporter.mjs does.
const fileItself = (d) => d.nesting === 0 && d.entryFile === undefined && (d.line ?? 1) === 1 && (d.column ?? 1) === 1
  && typeof d.file === 'string' && d.name !== undefined && String(d.file).split(path.sep).join('/').endsWith(String(d.name).split(path.sep).join('/'));
if (times) {
  stream.on('test:complete', (d) => {
    if (fileItself(d) && d.details?.duration_ms >= 0) took.set(key(d.file), Math.round(d.details.duration_ms));
  });
  process.on('exit', () => {
    // A file that's gone keeps its line: harmless, as only the files a run
    // is given are looked up.
    const tmp = `${times}.${process.pid}`;
    try {
      fs.writeFileSync(tmp, [...took].map(([f, ms]) => `${ms} ${f}`).join('\n') + '\n');
      fs.renameSync(tmp, times);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
  });
}
