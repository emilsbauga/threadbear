// The trust worker (trust-off-thread.ts): the same answers as on the main
// thread, a look shared only where it may be, and a stuck worker replaced.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCommands, CLAUDE_PATCH_ID } from '../../src/claude-trust.ts';
import { PatchTrust, TRUST_ALL } from '../../src/patch-trust.ts';
import { TrustOffThread } from '../../src/trust-off-thread.ts';
import { SCAN_SHOWN_MS, codeOfUnhashedPatch } from '../../src/unhashed-scan.ts';
import { execFileSync } from 'node:child_process';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { until } from '../helpers/worktrees-harness.ts';

// Windows has no FIFOs in folders (its named pipes live only under \\.\pipe\),
// so a look there can't get stuck on one: Git Bash's mkfifo makes an
// ordinary file that only MSYS treats as a pipe.
const unixOnly = { skip: process.platform === 'win32' && 'no FIFOs in folders on Windows' };

function hooked(folder: string): string {
  fs.mkdirSync(path.join(folder, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.claude', 'hooks', 'start.mjs'), 'console.log("hi")\n');
  const settings = path.join(folder, '.claude', 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/start.mjs' }] }] } }));
  return settings;
}

test('a look on the worker finds what the same look on this thread does', async (t) => {
  const off = new TrustOffThread();
  t.after(() => off.close());
  const root = tmpDir();
  const folder = path.join(root, 'cloned');
  hooked(folder);
  // A nested skill outside git, found by the walk.
  fs.mkdirSync(path.join(folder, 'a', 'b', '.claude', 'skills', 'go'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'a', 'b', '.claude', 'skills', 'go', 'SKILL.md'), '---\nname: go\nhooks:\n  Stop: node x.mjs\n---\n');
  for (const grants of [false, true]) {
    const here = claudeCommands(folder, root, { grants });
    assert.ok(here?.files.length);
    assert.deepEqual(await off.claudeCommands(folder, root, [grants], 'urgent'), [here]);
    assert.deepEqual(await off.claudeCommands(folder, root, [grants], 'background'), [here]);
  }
  // Both kinds in one call, in the order asked.
  assert.deepEqual(await off.claudeCommands(folder, root, [false, true], 'urgent'), [claudeCommands(folder, root, {}), claudeCommands(folder, root, { grants: true })]);
  assert.deepEqual(await off.claudeCommands(path.join(root, 'nothing'), root, [false], 'background'), [undefined]);

  const patch = path.join(folder, '.threadbear', 'patches', 'p.ts');
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, `const cmd = ['ec', 'ho'].join('');\nexport default { actions: [{ title: 'Go', run: cmd + ' hi' }] };\n`);
  const scan = codeOfUnhashedPatch(patch, folder, 0);
  assert.deepEqual(await off.editsAsk(patch, folder, 0), { all: scan.all, ...(scan.why ? { why: scan.why } : {}) });
});

// What Patches shows may come from a scan up to SCAN_SHOWN_MS old, as each
// thread's patches are read every 15 to 20 s and the 10 s scan never lasted
// to the next read (23 Nov); whether an edit asks still takes a fresh one,
// and a change to what the scan read starts a new one either way.
test('a scan lasts longer for what Patches shows than for whether an edit asks', () => {
  const folder = path.join(tmpDir(), 'shown');
  const patch = path.join(folder, '.threadbear', 'patches', 'p.ts');
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, `export default { actions: [{ title: 'Go', run: 'sh go.sh' }] };\n`);
  fs.writeFileSync(path.join(folder, 'go.sh'), 'echo hi\n');
  const first = codeOfUnhashedPatch(patch, folder, 1_000_000);
  assert.equal(codeOfUnhashedPatch(patch, folder, 1_030_000, SCAN_SHOWN_MS), first);
  assert.notEqual(codeOfUnhashedPatch(patch, folder, 1_030_000), first);
  const second = codeOfUnhashedPatch(patch, folder, 1_030_000, SCAN_SHOWN_MS);
  assert.notEqual(codeOfUnhashedPatch(patch, folder, 1_030_000 + SCAN_SHOWN_MS, SCAN_SHOWN_MS), second);
  // Edited: scanned afresh at once, however old a scan Patches may show.
  const third = codeOfUnhashedPatch(patch, folder, 2_000_000, SCAN_SHOWN_MS);
  fs.writeFileSync(patch, `export default { actions: [{ title: 'Go', run: 'sh other.sh' }] };\n`);
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(patch, later, later);
  assert.notEqual(codeOfUnhashedPatch(patch, folder, 2_001_000, SCAN_SHOWN_MS), third);
});

test('a scan for what Patches shows is never shared with one that wants it fresh', async (t) => {
  const off = new TrustOffThread();
  t.after(() => off.close());
  const folder = path.join(tmpDir(), 'shared');
  const patch = path.join(folder, '.threadbear', 'patches', 'p.ts');
  fs.mkdirSync(path.dirname(patch), { recursive: true });
  fs.writeFileSync(patch, `export default { actions: [{ title: 'Go', run: 'echo hi' }] };\n`);
  const shown = off.editsAsk(patch, folder, 0, SCAN_SHOWN_MS);
  const fresh = off.editsAsk(patch, folder, 0);
  assert.notEqual(fresh, shown);
  assert.equal(off.editsAsk(patch, folder, 0, SCAN_SHOWN_MS), shown);
  await Promise.all([shown, fresh]);
});

test('the background lane shares a look under way; the urgent lane never does', async (t) => {
  const off = new TrustOffThread();
  t.after(() => off.close());
  const root = tmpDir();
  hooked(root + '/f');
  const f = path.join(root, 'f');
  const a = off.claudeCommands(f, root, [false], 'background');
  const b = off.claudeCommands(f, root, [false], 'background');
  assert.equal(a, b);
  // Another kind of thread is another look.
  assert.notEqual(off.claudeCommands(f, root, [true], 'background'), a);
  const u1 = off.claudeCommands(f, root, [false], 'urgent');
  const u2 = off.claudeCommands(f, root, [false], 'urgent');
  assert.notEqual(u1, u2);
  await Promise.all([a, u1, u2]);
  // Once it's done, the next is a fresh look: it sees a change.
  fs.rmSync(path.join(f, '.claude'), { recursive: true });
  assert.deepEqual(await off.claudeCommands(f, root, [false], 'background'), [undefined]);
});

test('a worker that never answers is given up on, and the next call gets a new one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-trust-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'silent.mjs');
  fs.writeFileSync(script, "import { parentPort } from 'node:worker_threads';\nparentPort.postMessage({ ready: true });\nparentPort.on('message', () => {});\n");
  const off = new TrustOffThread({ timeoutMs: 300, script: new URL(`file://${script}`) });
  t.after(() => off.close());
  await assert.rejects(off.claudeCommands(dir, dir, [false], 'urgent'), /took over/);
  // Its worker stops (it was only stuck in JavaScript), so a look there
  // soon gets a new one, which is just as silent.
  let last = '';
  for (let i = 0; i < 100 && !/took over/.test(last); i++) {
    last = await off.claudeCommands(dir, dir, [false], 'urgent').then(
      () => 'answered',
      (e: Error) => e.message,
    );
    if (/still stuck/.test(last)) await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(last, /took over/);
});

// A worker that reads a folder's settings file raw, as one stuck in the OS
// on a hung mount would be: a FIFO there holds it in open() for good.
function rawReader(): URL {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-trust-raw-'));
  const script = path.join(dir, 'raw.mjs');
  fs.writeFileSync(
    script,
    "import fs from 'node:fs';\nimport { parentPort } from 'node:worker_threads';\n" +
      "parentPort.postMessage({ ready: true });\n" +
      "parentPort.on('message', (r) => {\n" +
      "  try { fs.readFileSync(r.cwd + '/.claude/settings.json'); } catch {}\n" +
      "  parentPort.postMessage({ id: r.id, ok: true, value: [r.cwd] });\n" +
      "});\n",
  );
  return new URL(`file://${script}`);
}

// Opens a FIFO to write if something has it open to read, without waiting,
// and writes to it. The open is what lets a reader stuck in open() go: one
// with terminate() pending exits at once and closes its end, and on a busy
// machine that can beat the write (EPIPE). That still counts, or every later
// try finds no reader (ENXIO) and the wait runs out (Pixel, 21 Nov).
function poke(fifo: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    fs.writeSync(fd, '{}');
  } catch {
    // The reader went before the write: it still let go.
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

async function outcome(p: Promise<unknown>): Promise<string> {
  return p.then(
    () => 'answered',
    (e: Error) => e.message,
  );
}

test('a folder whose look is stuck in the OS (a FIFO for its settings) fails at once until that worker lets go, without a new worker each time; other folders go on', unixOnly, async (t) => {
  const root = tmpDir();
  const stuck = path.join(root, 'stuck');
  fs.mkdirSync(path.join(stuck, '.claude'), { recursive: true });
  const fifo = path.join(stuck, '.claude', 'settings.json');
  execFileSync('mkfifo', [fifo]);
  t.after(async () => {
    // Let any worker still waiting on it go.
    for (let i = 0; i < 50; i++) {
      poke(fifo);
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  const fine = path.join(root, 'fine');
  hooked(fine);
  const off = new TrustOffThread({ timeoutMs: 500, script: rawReader() });
  t.after(() => off.close());
  // A look that times out inside the read leaves its worker stuck there.
  let last = '';
  for (let i = 0; i < 20 && !/still stuck/.test(last); i++) last = await outcome(off.claudeCommands(stuck, root, [false], 'urgent'));
  assert.match(last, /still stuck/);
  assert.match(await outcome(off.claudeCommands(stuck, root, [false], 'urgent')), /still stuck/);
  assert.deepEqual(await off.claudeCommands(fine, root, [false], 'urgent'), [fine]);
  // Something writes to it at last: the stuck worker reads it and goes, and
  // the next look there goes to a worker again rather than failing at once.
  await until(() => poke(fifo), 'the stuck worker to take the write');
  last = '';
  for (let i = 0; i < 100 && (last === '' || /still stuck/.test(last)); i++) {
    last = await outcome(off.claudeCommands(stuck, root, [false], 'urgent'));
    if (/still stuck/.test(last)) await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(last, /took over/);
});

test("a worker that can't start leaves the look to this thread, as before", async (t) => {
  const off = new TrustOffThread({ script: new URL('file:///nonexistent/trust-worker.mjs') });
  t.after(() => off.close());
  const root = tmpDir();
  const settings = hooked(path.join(root, 'f'));
  const [got] = await off.claudeCommands(path.join(root, 'f'), root, [false], 'urgent');
  assert.deepEqual(got?.files, [settings]);
});

// A worker that hangs on a folder named "hang", stops on one named
// "crash", and otherwise answers at once.
function picky(dir: string): URL {
  const script = path.join(dir, 'picky.mjs');
  fs.writeFileSync(
    script,
    "import { parentPort } from 'node:worker_threads';\n" +
      "parentPort.postMessage({ ready: true });\n" +
      "parentPort.on('message', (r) => {\n" +
      "  if (r.cwd.endsWith('hang')) return;\n" +
      "  if (r.cwd.endsWith('crash')) process.exit(1);\n" +
      "  parentPort.postMessage({ id: r.id, ok: true, value: [r.cwd] });\n" +
      "});\n",
  );
  return new URL(`file://${script}`);
}

test("one folder that hangs fails its own look alone: the looks queued behind it go to a new worker, with their own time limit", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-trust-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const off = new TrustOffThread({ timeoutMs: 400, script: picky(dir) });
  t.after(() => off.close());
  const hung = off.claudeCommands('/x/hang', dir, [false], 'urgent');
  const after = [1, 2, 3].map((i) => off.claudeCommands(`/x/ok${i}`, dir, [false], 'urgent'));
  await assert.rejects(hung, /Looking at \/x\/hang took over/);
  // Each waited longer than one time limit in all, but none was cut short.
  assert.deepEqual(await Promise.all(after), [['/x/ok1'], ['/x/ok2'], ['/x/ok3']]);
});

test('a worker that stops partway fails only the look it was on, which is never run again on this thread', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-trust-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const off = new TrustOffThread({ script: picky(dir) });
  t.after(() => off.close());
  assert.deepEqual(await off.claudeCommands('/x/first', dir, [false], 'urgent'), ['/x/first']);
  const crash = off.claudeCommands('/x/crash', dir, [false], 'urgent');
  const next = off.claudeCommands('/x/next', dir, [false], 'urgent');
  await assert.rejects(crash, /trust worker stopped/);
  assert.deepEqual(await next, ['/x/next']);
});

test('closing fails what is waiting rather than running it on this thread', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-trust-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const off = new TrustOffThread({ script: picky(dir) });
  const a = off.claudeCommands('/x/hang', dir, [false], 'urgent');
  const b = off.claudeCommands('/x/ok', dir, [false], 'urgent');
  off.close();
  await assert.rejects(a, /closed/);
  await assert.rejects(b, /closed/);
});

test('runner with the worker: an untrusted folder starts its CLI without the settings, shows them in Patches, and trusting them gives the next CLI them', async (t) => {
  const off = new TrustOffThread();
  t.after(() => off.close());
  const root = tmpDir();
  const project = path.join(root, 'cloned');
  const settings = hooked(project);
  const home = tmpDir();
  const h = makeHarness(home, {}, { panelsRoot: root, offThread: off, patchTrust: new PatchTrust({ file: path.join(home, 'patch-trust.json'), claudeHome: root, offThread: off }) });
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: project });
  await until(() => Boolean(h.adapter.sessions.length), 'the CLI to start');
  const s = h.adapter.last;
  assert.deepEqual(s.opts.untrustedProjectSettings, {});
  await until(() => Boolean(h.runner.get(thread.id).patches?.some((p) => p.id === CLAUDE_PATCH_ID)), 'Patches to list the settings');
  const waiting = h.runner.get(thread.id).patches!.find((p) => p.id === CLAUDE_PATCH_ID)!;
  assert.equal(waiting.file, settings);
  assert.equal(waiting.untrusted, 'new');

  s.init();
  s.result('completed');
  await tick();
  await h.runner.trustPatches(thread.id, [{ file: waiting.file!, hash: waiting.hash! }]);
  await until(() => !h.runner.get(thread.id).patches?.some((p) => p.id === CLAUDE_PATCH_ID), 'Patches to drop it');
  h.runner.send(thread.id, 'again');
  await until(() => h.adapter.last !== s, 'a fresh CLI');
  assert.equal(h.adapter.last.opts.untrustedProjectSettings, undefined);
});

test("a message sent while the turn's look at the folder is under way waits for that turn, never reaching the CLI first", async (t) => {
  let hold: Promise<void> | undefined;
  let release = () => {};
  const looks: string[] = [];
  const trust = {
    ...TRUST_ALL,
    lookClaude: async (cwd: string, opts: { grants?: boolean } = {}) => {
      looks.push(cwd);
      if (hold) await hold;
      return { cwd, grants: opts.grants === true, found: undefined };
    },
  };
  const off = new TrustOffThread();
  t.after(() => off.close());
  const h = makeHarness(tmpDir(), {}, { patchTrust: trust, offThread: off });
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: tmpDir() });
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  const s = h.adapter.last;
  s.init();
  s.result('completed');
  await tick();
  hold = new Promise((r) => (release = () => r()));
  const before = looks.length;
  h.runner.send(thread.id, 'again');
  await until(() => looks.length > before, 'the look to start');
  h.runner.send(thread.id, 'and this');
  await tick();
  // Not steered into the CLI ahead of "again".
  assert.deepEqual(s.sent.slice(1).map((m) => m.text), []);
  release();
  await until(() => s.sent.length >= 2, '"again" to reach the CLI');
  assert.match(s.sent[1].text, /again/);
  assert.ok(!s.sent[1].text.includes('and this'));
});

// A trust store whose looks can be held, failed and counted, with the
// checks it makes after them.
function heldTrust() {
  const o = {
    hold: undefined as Promise<void> | undefined,
    fail: undefined as Error | undefined,
    looks: [] as { at: number }[],
    checks: [] as { look: boolean }[],
    trust: undefined as unknown as typeof TRUST_ALL,
  };
  let n = 0;
  o.trust = {
    ...TRUST_ALL,
    lookClaude: async (cwd: string, opts: { grants?: boolean } = {}) => {
      o.looks.push({ at: ++n });
      // Whether it fails is settled when it starts, as a real look's would be.
      const fail = o.fail;
      if (o.hold) await o.hold;
      if (fail) throw fail;
      return { cwd, grants: opts.grants === true, found: undefined };
    },
    checkClaude: (_cwd: string, _opts?: unknown, look?: unknown) => {
      o.checks.push({ look: look !== undefined });
      return { trusted: true as const };
    },
  };
  return o;
}

async function warmThread(t: { after: (f: () => void) => void }, trust: typeof TRUST_ALL) {
  const off = new TrustOffThread();
  t.after(() => off.close());
  const h = makeHarness(tmpDir(), {}, { patchTrust: trust, offThread: off });
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: tmpDir() });
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  const s = h.adapter.last;
  s.init();
  s.result('completed');
  await until(() => !h.runner.threads.get(thread.id)!.rt.turn, 'the turn to end');
  return { h, s, thread };
}

test('a CLI started after the old one closes gets a look taken after it closed, not before', async (t) => {
  const o = heldTrust();
  const { h, s, thread } = await warmThread(t, o.trust);
  s.slowExit = true;
  h.runner.threads.get(thread.id)!.rt.releaseWhenIdle = true;
  h.runner.send(thread.id, 'again');
  await until(() => s.ended, 'the old CLI asked to end');
  const before = o.looks.length;
  await tick();
  assert.equal(h.adapter.sessions.length, 1, 'waits for the old CLI');
  s.exit();
  await until(() => h.adapter.sessions.length === 2, 'the new CLI');
  assert.ok(o.looks.length > before, 'looked again once the old CLI had gone');
  // Its check used that look, not one from before the wait.
  assert.equal(o.checks.at(-1)?.look, true);
});

test('while the look runs the message waits in the queue with no turn open, so Stop has nothing of it to stop and the CLI nothing of it to answer', async (t) => {
  const o = heldTrust();
  const { h, s, thread } = await warmThread(t, o.trust);
  let release = () => {};
  o.hold = new Promise((r) => (release = () => r()));
  const before = o.looks.length;
  h.runner.send(thread.id, 'again');
  await until(() => o.looks.length > before, 'the look');
  const st = h.runner.threads.get(thread.id)!;
  assert.equal(st.rt.turn, undefined);
  assert.deepEqual(st.rec.queue.map((q) => q.text), ['again']);
  h.runner.interrupt(thread.id, { byMike: true });
  assert.equal(s.interrupts, 0, 'the idle CLI is left alone');
  release();
  await until(() => s.sent.length >= 2, '"again" to reach the CLI');
  assert.match(s.sent[1].text, /again/);
});

test("a look that fails fails the turn, rather than looking again on the runner's main thread", async (t) => {
  const o = heldTrust();
  const { h, s, thread } = await warmThread(t, o.trust);
  o.fail = new Error('Looking at /x took over 120 s.');
  const checks = o.checks.length;
  h.runner.send(thread.id, 'again');
  const said = () => h.events(thread.id).some((e) => JSON.stringify(e).includes("Couldn't read this folder's Claude Code settings"));
  await until(() => said() && !h.runner.threads.get(thread.id)!.rt.turn, 'the turn to fail, saying why');
  assert.equal(o.checks.length, checks, 'no check without a look');
  assert.deepEqual(s.sent.slice(1), []);
});

test("the CLI's own turn ending while a message waits on the look leaves that message to be sent, not dropped", async (t) => {
  const o = heldTrust();
  const { h, s, thread } = await warmThread(t, o.trust);
  let release = () => {};
  o.hold = new Promise((r) => (release = () => r()));
  const before = o.looks.length;
  h.runner.send(thread.id, 'again');
  await until(() => o.looks.length > before, 'the look');
  // A background task woke the CLI, and its own turn ends now: it's no
  // turn of the message's, which hasn't started one.
  assert.equal(h.runner.threads.get(thread.id)!.rt.turn, undefined);
  s.result('completed', undefined, undefined, { own: true, queuedTurns: 0 });
  await tick();
  assert.ok(!h.events(thread.id).some((e) => JSON.stringify(e).includes('was dropped by the CLI')));
  release();
  await until(() => s.sent.length >= 2, '"again" to reach the CLI');
  assert.match(s.sent[1].text, /again/);
});

test("a folder change while a new CLI's look runs makes it look again at the new folder, not on the runner's main thread", async (t) => {
  const o = heldTrust();
  const seen: string[] = [];
  const look = o.trust.lookClaude!;
  // The new CLI's looks (the patch list looks too, on the background lane).
  o.trust.lookClaude = async (cwd, opts, lane) => {
    if (lane === 'urgent') seen.push(cwd);
    return look(cwd, opts, lane);
  };
  let release = () => {};
  o.hold = new Promise((r) => (release = () => r()));
  const off = new TrustOffThread();
  t.after(() => off.close());
  const h = makeHarness(tmpDir(), {}, { patchTrust: o.trust, offThread: off });
  const a = tmpDir();
  const b = tmpDir();
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: a });
  await until(() => seen.length >= 1, 'the look at the first folder');
  h.runner.threads.get(thread.id)!.rec.cwd = b;
  o.hold = undefined;
  release();
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  assert.deepEqual([...new Set(seen)], [a, b]);
  assert.equal(o.checks.at(-1)?.look, true, "startSession used the new folder's look");
});

test('a look begun for a message taken off the queue is not used for the next one: that one gets a look of its own', async (t) => {
  const o = heldTrust();
  const { h, s, thread } = await warmThread(t, o.trust);
  let release = () => {};
  o.hold = new Promise((r) => (release = () => r()));
  const before = o.looks.length;
  const first = h.runner.send(thread.id, 'never mind');
  await until(() => o.looks.length === before + 1, 'the first look');
  assert.ok(h.runner.unqueue(thread.id, first.turnId));
  h.runner.send(thread.id, 'this one');
  o.hold = undefined;
  release();
  await until(() => s.sent.length >= 2, 'the second message to reach the CLI');
  assert.equal(o.looks.length, before + 2, 'a look of its own');
  assert.match(s.sent[1].text, /this one/);
});

test("a look that failed while the thread moved folder is taken again for the new one, rather than failing the message", async (t) => {
  const o = heldTrust();
  const { h, s, thread } = await warmThread(t, o.trust);
  let release = () => {};
  o.hold = new Promise((r) => (release = () => r()));
  o.fail = new Error('Looking at the old folder took over 120 s.');
  const before = o.looks.length;
  h.runner.send(thread.id, 'again');
  await until(() => o.looks.length === before + 1, 'the look');
  h.runner.threads.get(thread.id)!.rec.cwd = tmpDir();
  o.hold = undefined;
  o.fail = undefined;
  release();
  await until(() => s.sent.length >= 2 || h.adapter.sessions.length > 1, 'the message to go');
  assert.ok(o.looks.length >= before + 2, 'looked again');
  assert.ok(!h.events(thread.id).some((e) => JSON.stringify(e).includes("Couldn't read this folder's Claude Code settings")));
});

test('a long queue of looks at a folder that just got stuck all fail at once, one after another, not one call deeper each', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-trust-worker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const off = new TrustOffThread({ timeoutMs: 300, script: picky(dir) });
  t.after(() => off.close());
  const first = outcome(off.claudeCommands('/x/hang', dir, [false], 'urgent'));
  const queued = Array.from({ length: 20_000 }, () => outcome(off.claudeCommands('/x/hang', dir, [false], 'urgent')));
  const after = off.claudeCommands('/x/ok', dir, [false], 'urgent');
  assert.match(await first, /took over/);
  const all = await Promise.all(queued);
  assert.ok(all.every((m) => /still stuck/.test(m)), all.find((m) => !/still stuck/.test(m)) ?? "");
  assert.deepEqual(await after, ['/x/ok']);
});

test('once a few looks are stuck in the OS, no more are started anywhere until one lets go', unixOnly, async (t) => {
  const root = tmpDir();
  const fifos: string[] = [];
  t.after(async () => {
    for (let i = 0; i < 50; i++) {
      fifos.forEach(poke);
      await new Promise((r) => setTimeout(r, 20));
    }
  });
  const off = new TrustOffThread({ timeoutMs: 400, script: rawReader() });
  t.after(() => off.close());
  // Four folders, each the same FIFO by another name would be just as bad.
  for (let i = 0; i < 4; i++) {
    const d = path.join(root, `stuck${i}`);
    fs.mkdirSync(path.join(d, '.claude'), { recursive: true });
    const fifo = path.join(d, '.claude', 'settings.json');
    execFileSync('mkfifo', [fifo]);
    fifos.push(fifo);
    let last = '';
    for (let j = 0; j < 20 && !/still stuck/.test(last); j++) last = await outcome(off.claudeCommands(d, root, [false], 'urgent'));
    assert.match(last, /still stuck/);
  }
  const fine = path.join(root, 'fine');
  hooked(fine);
  assert.match(await outcome(off.claudeCommands(fine, root, [false], 'urgent')), /4 earlier looks are still stuck/);
  // One lets go: looks start again.
  await until(() => poke(fifos[0]), 'the first stuck worker to take a write');
  let last = '';
  for (let j = 0; j < 100 && last !== 'answered'; j++) {
    last = await outcome(off.claudeCommands(fine, root, [false], 'urgent'));
    if (last !== 'answered') await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(last, 'answered');
});

test("the real worker refuses a FIFO for the settings at once, failing the look rather than waiting on it, and the process still exits; a hook's /dev/null is read as before", unixOnly, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-trust-exit-'));
  try {
    const folder = path.join(dir, 'f');
    fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
    execFileSync('mkfifo', [path.join(folder, '.claude', 'settings.json')]);
    const script = path.join(dir, 'run.ts');
    const mod = new URL('../../src/trust-off-thread.ts', import.meta.url).href;
    fs.writeFileSync(
      script,
      `import { TrustOffThread } from ${JSON.stringify(mod)};\n` +
        `const off = new TrustOffThread({ timeoutMs: 20000 });\n` +
        `const go = () => off.claudeCommands(${JSON.stringify(folder)}, ${JSON.stringify(dir)}, [false], 'urgent').then(() => 'answered', (e) => e.message);\n` +
        `console.log(await go());\nconsole.log(await go());\n`,
    );
    const started = Date.now();
    const out = execFileSync(process.execPath, [script], { timeout: 30_000 }).toString().trim().split('\n');
    assert.equal(out.length, 2);
    for (const line of out) assert.match(line, /settings\.json is a FIFO or socket, not a file/);
    assert.ok(Date.now() - started < 15_000);
    // A hook that names /dev/null (a device) is looked at as it always was.
    const quiet = path.join(dir, 'quiet');
    fs.mkdirSync(path.join(quiet, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(quiet, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cat /dev/null' }] }] } }));
    const off = new TrustOffThread();
    try {
      assert.deepEqual(await off.claudeCommands(quiet, dir, [false], 'urgent'), [claudeCommands(quiet, dir, {})]);
    } finally {
      off.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a thread with a schedule booked reads as about to start, not Hibernating, while its next message waits on the look (a coordinator woken by its helper, 26 Nov)', async (t) => {
  let hold: Promise<void> | undefined;
  let release = () => {};
  const trust = {
    ...TRUST_ALL,
    lookClaude: async (cwd: string, opts: { grants?: boolean } = {}) => {
      if (hold) await hold;
      return { cwd, grants: opts.grants === true, found: undefined };
    },
  };
  const off = new TrustOffThread();
  t.after(() => off.close());
  const h = makeHarness(tmpDir(), {}, { patchTrust: trust, offThread: off });
  const { thread } = h.runner.create({ text: 'hi', accountId: 'claude-3', cwd: tmpDir() });
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  const s = h.adapter.last;
  s.init();
  s.out({ kind: 'event', event: { type: 'tool.call', itemId: 'e1', name: 'mcp__threadbear__end_turn', kind: 'mcp', title: 'end_turn', input: { needs: 'nothing' } } });
  s.result('completed');
  await tick();
  const states: (string | undefined)[] = [];
  h.runner.onNotification((n) => {
    if (n.method === 'thread.updated' && n.params.thread.id === thread.id) states.push(n.params.thread.waitState);
  });
  hold = new Promise((r) => (release = () => r()));
  h.runner.send(thread.id, 'A helper turn finished', [], { origin: 'runner', queue: true });
  // The schedule list lands while the message waits on the look.
  h.runner.schedulesFor = () => [{ id: 's1', title: 'Check', text: 'look', whenText: 'today', threadId: thread.id, nextRunAt: '2099-01-01T00:00:00Z' } as never];
  h.runner.markDirty(h.runner.threads.get(thread.id)!);
  await tick();
  await tick();
  assert.notEqual(h.runner.get(thread.id).waitState, 'scheduled');
  assert.ok(!states.includes('scheduled'), `sent ${states.join(', ')}`);
  release();
  await until(() => s.sent.length >= 2, 'the message to reach the CLI');
  const notes = h.runner.events(thread.id, { limit: 10_000 }).events.filter((e) => e.type === 'system.note' && e.text.startsWith('Moved to Hibernating'));
  assert.equal(notes.length, 0);
});
