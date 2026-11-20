// A box's save and restore (src/box-save.ts, docs/protocol.md "Box mode"):
// the `save` command packs the thread (its folder, its transcript, its git
// work with what's uncommitted), seals it with the thread's key, uploads it
// and names it in boxSaved; a new box restores it on a fresh clone and the
// thread carries on in the same session. A fake backend, real git in temp
// repos, the runner on fake CLIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir, type Harness } from '../helpers/fakes.ts';
import { localClone, originRepo, sh } from '../helpers/box-git.ts';
import { nullLogger } from '../../src/log.ts';
import { paths } from '../../src/config.ts';
import { projectDirName } from '../../src/transcripts.ts';
import { openSave, restoreSave, SaveHold, saveThread, sealSave, SAVE_MAX_BYTES, type SaveLimits } from '../../src/box-save.ts';
import { prepareBoxFolder, readBoxSecrets, setSaveHold, writeBoxSecrets, type BoxSecrets } from '../../src/box-mode.ts';
import { spawn, spawnSync } from 'node:child_process';
import { PatchTrust, patchHash } from '../../src/patch-trust.ts';
import { SHELL } from '../helpers/platform.ts';
import { LIVE_POLL_MS, LIVE_SHARE_MS } from '../../src/runner.ts';

const THREAD = 'b0c0ffee-1111-4222-8333-444455556666';
const KEY = crypto.randomBytes(32);
const BOX_KEY = `tbb_${'b'.repeat(64)}`;

async function until(check: () => boolean, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("a save opens only with its thread's key, as that thread's, untouched", () => {
  const plain = Buffer.from('the thread');
  const sealed = sealSave(KEY, THREAD, plain);
  assert.deepEqual(openSave(KEY, THREAD, sealed), plain);
  assert.throws(() => openSave(KEY, 'another-thread', sealed), /doesn't open/);
  assert.throws(() => openSave(crypto.randomBytes(32), THREAD, sealed), /doesn't open/);
  const bent = Buffer.from(sealed);
  bent[20]! ^= 1;
  assert.throws(() => openSave(KEY, THREAD, bent), /doesn't open/);
  assert.throws(() => openSave(KEY, THREAD, Buffer.alloc(10)), /too short/);
  // Two seals of the same bytes differ (a fresh IV each time).
  assert.notDeepEqual(sealSave(KEY, THREAD, plain), sealed);
});

function secretsFor(origin: string, over: Partial<BoxSecrets> = {}): BoxSecrets {
  return { version: 1, bootHash: 'h', syncUrl: 'https://dep.convex.cloud', boxKey: BOX_KEY, runnerId: 'box0thread01', threadId: THREAD, threadKey: KEY.toString('base64'), repo: { origin, subfolder: 'runner', baseBranch: 'main' }, save: null, ...over };
}

// A box: its data dir, its claude-main folder, its clone, and a runner on it.
async function boxOn(origin: string, save: BoxSecrets['save'], stored?: Map<string, Buffer>, opts: { holdForSetup?: boolean } = {}) {
  const home = tmpDir('tb-box-home-');
  const claudeDir = path.join(tmpDir('tb-box-claude-'), '.claude');
  const workRoot = tmpDir('tb-box-work-');
  const s = secretsFor(origin, { save });
  writeBoxSecrets(home, s);
  const folder = await prepareBoxFolder({ secrets: s, fresh: true, home, claudeDir, workRoot, log: nullLogger, clone: localClone, download: async (url) => stored!.get(url)! });
  const h = makeHarness(home, { defaults: { cwd: folder.cwd } as never }, { actionShell: ['/bin/sh', '-c'], actionTimeoutMs: 10_000, boxThread: THREAD, boxHolds: opts.holdForSetup ? ['setup'] : [] });
  // As main.ts makes it: the thread held from a save's start until the backend says.
  const hold = new SaveHold({ hold: () => h.runner.holdTurns(THREAD, 'save'), release: () => h.runner.releaseTurns(THREAD, 'save') });
  return { home, claudeDir, folder, h, hold };
}

// The backend's side of a save: an upload URL, the upload, boxSaved.
function fakeBackend() {
  const stored = new Map<string, Buffer>();
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    stored,
    calls,
    post: async (_kind: 'mutation', fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return fn === 'sync:iconUploadUrl' ? 'https://dep.convex.site/runner/upload?ticket=1' : null;
    },
    upload: async (url: string, bytes: Uint8Array, mediaType: string) => {
      assert.equal(url, 'https://dep.convex.site/runner/upload?ticket=1');
      assert.equal(mediaType, 'application/octet-stream');
      const id = `storage${stored.size + 1}`;
      stored.set(`https://dep.convex.cloud/api/storage/${id}`, Buffer.from(bytes));
      return id;
    },
  };
}

function save(h: Harness, b: { home: string; claudeDir: string; hold: SaveHold }, backend: Pick<ReturnType<typeof fakeBackend>, 'post' | 'upload'>, limits?: SaveLimits, more: { retryForMs?: number } = {}) {
  return saveThread({ home: b.home, claudeDir: b.claudeDir, threadId: THREAD, threadKey: KEY, boxKey: BOX_KEY, quiesce: (id) => h.runner.quiesceForSave(id), hold: b.hold, post: backend.post, upload: backend.upload, sleep: async () => {}, ...(limits ? { limits } : {}), ...more });
}

// The thread's first turn on the fake CLI, ended.
async function firstTurn(h: Harness, cwd: string) {
  h.runner.create({ text: 'Go', accountId: 'claude-main', cwd, id: THREAD });
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  h.adapter.last.init();
  h.adapter.last.result();
  return h.runner.get(THREAD);
}

function transcriptFor(claudeDir: string, cwd: string, sid: string): string {
  return path.join(claudeDir, 'projects', projectDirName(fs.realpathSync(cwd)), `${sid}.jsonl`);
}

test('a save round trip: what a new box restores is the thread as it was, its commits, its uncommitted work and its session', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  const t = await firstTurn(a.h, a.folder.cwd);
  assert.equal(t.cwd, a.folder.cwd);
  const sid = a.h.runner.threads.get(THREAD)!.rec.nativeSessionId!;
  // The agent's work: a commit, an edit, a new file; and the session's transcript.
  const top = a.folder.checkout;
  sh(top, 'echo b > runner/b.txt && git add -A && git commit -qm "the agent\'s commit"');
  fs.writeFileSync(path.join(top, 'README.md'), 'one, edited\n');
  fs.writeFileSync(path.join(top, 'runner', 'new.txt'), 'untracked\n');
  const transcript = transcriptFor(a.claudeDir, a.folder.cwd, sid);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, '{"type":"user","message":"Go"}\n');
  fs.mkdirSync(path.join(path.dirname(transcript), sid, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(transcript), sid, 'subagents', 'agent-1.jsonl'), '{"sub":1}\n');

  const backend = fakeBackend();
  const done = await save(a.h, a, backend);
  assert.deepEqual(backend.calls.map((c) => c.fn), ['sync:iconUploadUrl', 'boxes:boxSaved']);
  const [url, sealed] = [...backend.stored][0]!;
  assert.deepEqual(backend.calls[1]!.args, { key: BOX_KEY, storageId: 'storage1', bytes: sealed.length });
  assert.equal(done.bytes, sealed.length);
  // Sealed: none of the thread's words in the clear.
  assert.ok(!sealed.includes(Buffer.from('untracked')));
  assert.ok(!sealed.includes(Buffer.from(THREAD)));
  // The box's own copy is untouched by saving, and its CLI still there.
  assert.equal(sh(top, "git status --porcelain | sed 's/^/|/'"), '| M README.md\n|?? runner/new.txt');

  // A new box for the thread, from the save.
  const b = await boxOn(origin, { url, at: Date.now(), bytes: sealed.length }, backend.stored);
  assert.equal(b.folder.restored, true);
  const btop = b.folder.checkout;
  assert.notEqual(btop, top);
  assert.equal(b.folder.cwd, path.join(btop, 'runner'));
  assert.equal(sh(btop, 'git log -1 --format=%s'), "the agent's commit");
  assert.equal(fs.readFileSync(path.join(btop, 'runner', 'b.txt'), 'utf8'), 'b\n');
  assert.equal(fs.readFileSync(path.join(btop, 'README.md'), 'utf8'), 'one, edited\n');
  assert.equal(fs.readFileSync(path.join(btop, 'runner', 'new.txt'), 'utf8'), 'untracked\n');
  // Uncommitted and untracked again, not committed.
  assert.equal(sh(btop, "git status --porcelain | sed 's/^/|/'"), '| M README.md\n|?? runner/new.txt');
  // The transcript, where Claude Code looks for the folder it now runs in.
  assert.equal(fs.readFileSync(transcriptFor(b.claudeDir, b.folder.cwd, sid), 'utf8'), '{"type":"user","message":"Go"}\n');
  assert.ok(fs.existsSync(path.join(path.dirname(transcriptFor(b.claudeDir, b.folder.cwd, sid)), sid, 'subagents', 'agent-1.jsonl')));
  // The thread itself, loaded by the new box's runner, in the new folder.
  const restored = b.h.runner.get(THREAD);
  assert.equal(restored.cwd, b.folder.cwd);
  assert.equal(restored.title, t.title);
  assert.ok(b.h.runner.events(THREAD, {}).events.some((e) => e.type === 'user.message'));
  // Its next turn resumes the same session.
  b.h.runner.send(THREAD, 'And again', []);
  await until(() => b.h.adapter.sessions.length === 1, 'the CLI to start');
  assert.equal(b.h.adapter.last.opts.sessionId, sid);
  assert.equal(b.h.adapter.last.opts.resume, true);
  assert.equal(b.h.adapter.last.opts.cwd, b.folder.cwd);
  // And it's the box's one thread: another can't be made.
  assert.throws(() => b.h.runner.create({ text: 'x', cwd: b.folder.cwd, accountId: 'claude-main', id: THREAD }), /box for one thread/);
});

const WORKTREE_PATCH = 'export default { worktree: { setup: "mkdir -p node_modules && echo $PWD > node_modules/ran" } };\n';

test("a thread in a worktree comes back in its worktree, on its branch, and the worktree's setup runs again", async () => {
  const origin = originRepo({ patch: WORKTREE_PATCH });
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const w = a.h.runner.get(THREAD).worktree!;
  assert.ok(w, 'a worktree, as a new thread in that repo gets');
  await until(() => fs.existsSync(path.join(w.path, 'node_modules', 'ran')), 'its setup');
  sh(w.path, 'echo wip > runner/wip.txt && echo committed > runner/c.txt && git add runner/c.txt && git commit -qm "on the branch"');
  const backend = fakeBackend();
  await save(a.h, a, backend);
  const [url, sealed] = [...backend.stored][0]!;
  // Installed packages stay behind (they're made again).
  const b = await boxOn(origin, { url, at: Date.now(), bytes: sealed.length }, backend.stored);
  const rec = b.h.runner.threads.get(THREAD)!.rec;
  const bw = rec.worktree!;
  assert.equal(bw.mainCheckout, b.folder.checkout);
  assert.equal(path.dirname(bw.path), `${b.folder.checkout}-threads`);
  assert.equal(path.basename(bw.path), path.basename(w.path));
  assert.equal(bw.branch, w.branch);
  assert.equal(rec.cwd, path.join(bw.path, 'runner'));
  assert.equal(sh(bw.path, 'git rev-parse --abbrev-ref HEAD'), w.branch);
  assert.equal(sh(bw.path, 'git log -1 --format=%s'), 'on the branch');
  assert.equal(fs.readFileSync(path.join(bw.path, 'runner', 'wip.txt'), 'utf8'), 'wip\n');
  assert.equal(sh(bw.path, 'git status --porcelain'), '?? runner/wip.txt');
  assert.ok(!fs.existsSync(path.join(bw.path, 'node_modules')));
  await b.h.runner.setUpRestored(THREAD);
  assert.equal(fs.readFileSync(path.join(bw.path, 'node_modules', 'ran'), 'utf8').trim(), fs.realpathSync(bw.path));
});

test('a save bigger than one upload fails the command saying so, and nothing is uploaded', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  // Incompressible, so the gzip can't take it under.
  fs.writeFileSync(path.join(a.folder.checkout, 'runner', 'big.bin'), crypto.randomBytes(SAVE_MAX_BYTES + 1024));
  const backend = fakeBackend();
  await assert.rejects(save(a.h, a, backend), /more than one upload takes \(10\.0 MB\), and saves in parts aren't built yet/);
  assert.deepEqual(backend.calls, []);
  assert.equal(backend.stored.size, 0);
});

test("a save the backend refuses fails the command, and one for a thread that isn't here says so", async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await assert.rejects(save(a.h, a, fakeBackend()), /nothing to save/);
  await firstTurn(a.h, a.folder.cwd);
  const backend = fakeBackend();
  const refused = { ...backend, post: async (_k: 'mutation', fn: string, args: Record<string, unknown>) => {
    if (fn === 'boxes:boxSaved') throw Object.assign(new Error("The box is asleep, so it can't save now."), { data: { kind: 'conflict' } });
    return backend.post(_k, fn, args);
  } };
  await assert.rejects(save(a.h, a, refused), /can't save now/);
  // A save that won't open (another thread's) is refused on restore, and the box doesn't start.
  await save(a.h, a, backend);
  const [url, sealed] = [...backend.stored][0]!;
  const wrong = secretsFor(origin, { threadKey: crypto.randomBytes(32).toString('base64'), save: { url, at: 1, bytes: sealed.length } });
  const home = tmpDir();
  writeBoxSecrets(home, wrong);
  await assert.rejects(prepareBoxFolder({ secrets: wrong, fresh: true, home, claudeDir: tmpDir(), workRoot: tmpDir(), log: nullLogger, clone: localClone, download: async () => sealed }), /doesn't open/);
  assert.equal(fs.existsSync(paths.thread(home, THREAD)), false);
});

test('a save stops the thread first: its turn interrupted, its CLI and background jobs stopped, and no turn starts after it until the box is woken', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  // A turn running when the save comes (one past its day's hours, or archived).
  a.h.runner.send(THREAD, 'Keep going', []);
  await until(() => a.h.adapter.sessions.length === 1 && Boolean(a.h.runner.threads.get(THREAD)!.rt.turn), 'the second turn');
  const s = a.h.adapter.last;
  const backend = fakeBackend();
  let saving = true;
  const done = save(a.h, a, backend).finally(() => (saving = false));
  await until(() => s.interrupts === 1, 'the interrupt');
  // Nothing goes up while the turn is still going.
  await tick(10);
  assert.equal(saving, true);
  assert.equal(backend.calls.length, 0);
  s.result('interrupted');
  await done;
  assert.equal(s.ended, true, 'the CLI is stopped before the copy is taken');
  assert.deepEqual(backend.calls.map((c) => c.fn), ['sync:iconUploadUrl', 'boxes:boxSaved']);
  // Frozen: a message waits rather than changing the folder behind the acknowledged save.
  a.h.runner.send(THREAD, 'after the save', []);
  await tick(10);
  assert.equal(a.h.adapter.sessions.length, 1);
  assert.equal(a.h.runner.threads.get(THREAD)!.rec.queue.length, 1);
  // Only the backend's word lets it go: a heartbeat from before the outcome,
  // or one finding the box asleep, doesn't; one after, finding it awake, does.
  a.hold.heard('awake', 0);
  a.hold.heard('asleep', performance.now() + 1);
  await tick(10);
  assert.equal(a.h.adapter.sessions.length, 1);
  a.hold.heard('awake', performance.now() + 1);
  await until(() => a.h.adapter.sessions.length === 2, 'the queued turn');
});

test('a save the backend refused keeps the thread stopped until the backend sends it something after', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const backend = fakeBackend();
  let saving = true;
  const refusing = { upload: backend.upload, post: async (k: 'mutation', fn: string, args: Record<string, unknown>) => {
    if (fn === 'boxes:boxSaved') {
      // A message arriving while the save's outcome isn't known yet doesn't count.
      if (saving) a.hold.taken('send');
      throw Object.assign(new Error("The box is asleep, so it can't save now."), { data: { kind: 'conflict' } });
    }
    return backend.post(k, fn, args);
  } };
  await assert.rejects(save(a.h, a, refusing), /can't save now/);
  saving = false;
  a.h.runner.send(THREAD, 'carry on', []);
  await tick(10);
  assert.equal(a.h.adapter.sessions.length, 1, 'still stopped after the refusal');
  // A save sent again doesn't either; anything else from the backend now does.
  a.hold.taken('save');
  await tick(10);
  assert.equal(a.h.adapter.sessions.length, 1);
  a.hold.taken('send');
  await until(() => a.h.adapter.sessions.length === 2, 'the next turn');
});

test("a lost boxSaved answer is sent again with the same file; one that never comes leaves the thread stopped", async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const backend = fakeBackend();
  const saved: unknown[] = [];
  let lose = 1;
  const flaky = { upload: backend.upload, post: async (k: 'mutation', fn: string, args: Record<string, unknown>) => {
    if (fn === 'boxes:boxSaved') {
      saved.push(args.storageId);
      // Taken by the backend, the answer lost on the way.
      if (lose-- > 0) throw new Error('fetch failed: socket hang up');
    }
    return backend.post(k, fn, args);
  } };
  await save(a.h, a, flaky);
  assert.deepEqual(saved, ['storage1', 'storage1'], 'the same save, which the backend takes as one');
  assert.equal(backend.stored.size, 1);
  assert.equal(a.hold.saving, false);
  // Never answered: unknown, so held, and nothing local lets it go.
  a.hold.taken('send');
  const b = await boxOn(origin, null);
  await firstTurn(b.h, b.folder.cwd);
  const silent = { upload: backend.upload, post: async (k: 'mutation', fn: string, args: Record<string, unknown>) => {
    if (fn === 'boxes:boxSaved') throw new Error('fetch failed');
    return backend.post(k, fn, args);
  } };
  await assert.rejects(save(b.h, b, silent, undefined, { retryForMs: 0 }), /Couldn't tell whether the backend took/);
  assert.equal(b.hold.saving, true);
  b.hold.taken('send');
  b.hold.heard('awake', performance.now() + 1);
  b.h.runner.send(THREAD, 'go', []);
  await tick(10);
  assert.equal(b.h.adapter.sessions.length, 1, 'still stopped');
});

test('installed packages a restore would refuse are left out of the save, so every acknowledged save restores', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const top = a.folder.checkout;
  // node_modules no longer ignored, and one installed under runner/: untracked, as unpackGit refuses.
  sh(top, 'git rm -q .gitignore && git commit -qm "no ignores"');
  fs.mkdirSync(path.join(top, 'runner', 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(top, 'runner', 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(top, 'runner', 'kept.txt'), 'kept\n');
  const backend = fakeBackend();
  const done = await save(a.h, a, backend);
  assert.deepEqual(done.leftOut, ['runner/node_modules/pkg/index.js']);
  const [url, sealed] = [...backend.stored][0]!;
  const b = await boxOn(origin, { url, at: Date.now(), bytes: sealed.length }, backend.stored);
  assert.equal(fs.readFileSync(path.join(b.folder.checkout, 'runner', 'kept.txt'), 'utf8'), 'kept\n');
  assert.equal(fs.existsSync(path.join(b.folder.checkout, 'runner', 'node_modules')), false);
  // The box's own copy still has them.
  assert.ok(fs.existsSync(path.join(top, 'runner', 'node_modules', 'pkg', 'index.js')));
});

test("a save past what a restore takes (files, or size unpacked) fails before it's uploaded, and a restore holds to its own limit", async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const backend = fakeBackend();
  await assert.rejects(save(a.h, a, backend, { maxEntries: 3 }), /more than 3 files, more than a restore takes/);
  await assert.rejects(save(a.h, a, backend, { maxUnpacked: 1000 }), /before it's compressed, more than a restore takes/);
  assert.deepEqual(backend.calls, []);
  // One within the writer's limits, read by a box allowing less: refused, nothing written.
  await save(a.h, a, backend);
  const sealed = [...backend.stored.values()][0]!;
  const home = tmpDir();
  await assert.rejects(restoreSave({ home, claudeDir: tmpDir(), threadId: THREAD, checkout: a.folder.checkout, packed: openSave(KEY, THREAD, sealed), limits: { maxUnpacked: 1000 } }), /not a gzip, or too big/);
  assert.equal(fs.existsSync(paths.thread(home, THREAD)), false);
});

const FAILING_PATCH = 'export default { worktree: { setup: "test -f runner/ok.txt || exit 3; mkdir -p node_modules" } };\n';

test("a restored thread's turns wait for its worktree's setup; one that fails says so, and the turn goes ahead", async () => {
  for (const passes of [true, false]) {
    const origin = originRepo({ patch: passes ? WORKTREE_PATCH : FAILING_PATCH });
    const a = await boxOn(origin, null);
    a.h.runner.create({ text: 'Go', accountId: 'claude-main', cwd: a.folder.cwd, id: THREAD });
    await until(() => a.h.adapter.sessions.length === 1, 'the CLI to start');
    a.h.adapter.last.init();
    a.h.adapter.last.result();
    const backend = fakeBackend();
    await save(a.h, a, backend);
    const [url, sealed] = [...backend.stored][0]!;
    const b = await boxOn(origin, { url, at: Date.now(), bytes: sealed.length }, backend.stored, { holdForSetup: true });
    // Held: recovery, a carry-on or a message can't start a turn before the setup.
    b.h.runner.carryOnStopped();
    b.h.runner.send(THREAD, 'next', []);
    await tick(10);
    assert.equal(b.h.adapter.sessions.length, 0);
    await b.h.runner.setUpRestored(THREAD);
    await until(() => b.h.adapter.sessions.length === 1, 'the turn after the setup');
    const notes = b.h.events(THREAD).filter((e) => e.type === 'system.note').map((e) => String(e.text));
    if (passes) assert.ok(!notes.some((n) => /setup failed/.test(n)));
    else assert.ok(notes.some((n) => /setup failed after this thread was restored/.test(n)), notes.join('\n'));
  }
});

test('a change to a tracked file under node_modules fails the save, saying so, rather than be dropped', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const top = a.folder.checkout;
  fs.mkdirSync(path.join(top, 'runner', 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(top, 'runner', 'node_modules', 'pkg', 'index.js'), 'one\n');
  sh(top, 'git add -f runner/node_modules/pkg/index.js && git commit -qm "vendored"');
  fs.writeFileSync(path.join(top, 'runner', 'node_modules', 'pkg', 'index.js'), 'patched\n');
  const backend = fakeBackend();
  await assert.rejects(save(a.h, a, backend), /runner\/node_modules\/pkg\/index.js is tracked or staged, with changes/);
  assert.deepEqual(backend.calls, []);
  // The box keeps it as it was.
  assert.equal(fs.readFileSync(path.join(top, 'runner', 'node_modules', 'pkg', 'index.js'), 'utf8'), 'patched\n');
  // Deleted, the same.
  fs.rmSync(path.join(top, 'runner', 'node_modules', 'pkg', 'index.js'));
  await assert.rejects(save(a.h, a, backend), /is tracked or staged, with changes/);
});

const SLOW_PATCH = 'export default { worktree: { setup: "sleep 1; mkdir -p node_modules && echo done > node_modules/ran" } };\n';

test("a stopping save waits for a restored worktree's setup before it copies anything", async () => {
  const origin = originRepo({ patch: SLOW_PATCH });
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const w = a.h.runner.get(THREAD).worktree!;
  await until(() => fs.existsSync(path.join(w.path, 'node_modules', 'ran')), 'its first setup');
  const backend = fakeBackend();
  await save(a.h, a, backend);
  const [url, sealed] = [...backend.stored][0]!;
  const b = await boxOn(origin, { url, at: Date.now(), bytes: sealed.length }, backend.stored, { holdForSetup: true });
  const bw = b.h.runner.get(THREAD).worktree!;
  const setup = b.h.runner.setUpRestored(THREAD);
  // The save asked for while the setup still runs: nothing is copied until it's done.
  let doneAtUpload: boolean | undefined;
  const watching = { post: backend.post, upload: async (u: string, bytes: Uint8Array, t: string) => {
    doneAtUpload = fs.existsSync(path.join(bw.path, 'node_modules', 'ran'));
    return backend.upload(u, bytes, t);
  } };
  await save(b.h, b, watching);
  await setup;
  assert.equal(doneAtUpload, true);
});

test('a stopping save kills the rest of the box once the CLI is closed, and looks again before it copies anything', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  // Something left running that writes into the folder (a setup's background child, an agent's job).
  const marker = `tb-box-writer-${crypto.randomBytes(6).toString('hex')}`;
  const log = path.join(a.folder.checkout, 'runner', 'writer.log');
  const writer = spawn('/bin/sh', ['-c', `: ${marker}; while true; do echo x >> "$0"; sleep 0.05; done`, log], { detached: true, stdio: 'ignore' });
  writer.unref();
  await until(() => fs.existsSync(log), 'the writer');
  const calls: { cliEnded: boolean }[] = [];
  const stopOthers = async () => {
    calls.push({ cliEnded: a.h.adapter.last.ended });
    // In a box this is every process but the runner's own (box-procs.ts); here, only the test's.
    spawnSync('pkill', ['-KILL', '-f', marker]);
    return 1;
  };
  const backend = fakeBackend();
  await saveThread({ home: a.home, claudeDir: a.claudeDir, threadId: THREAD, threadKey: KEY, boxKey: BOX_KEY, quiesce: (id) => a.h.runner.quiesceForSave(id, { stopOthers }), hold: a.hold, post: backend.post, upload: backend.upload });
  assert.deepEqual(calls, [{ cliEnded: true }, { cliEnded: true }], 'after the CLI is closed, and once more before the copy');
  await until(() => spawnSync('pgrep', ['-f', marker]).status === 1, 'the writer to be gone');
  const size = fs.statSync(log).size;
  await tick(20);
  assert.equal(fs.statSync(log).size, size);
});

test("a save that can't stop the rest of the box saves nothing, and stays held", async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const backend = fakeBackend();
  await assert.rejects(
    saveThread({ home: a.home, claudeDir: a.claudeDir, threadId: THREAD, threadKey: KEY, boxKey: BOX_KEY, quiesce: (id) => a.h.runner.quiesceForSave(id, { stopOthers: async () => { throw new Error("2 of the box's processes wouldn't stop"); } }), hold: a.hold, post: backend.post, upload: backend.upload }),
    /wouldn't stop/,
  );
  assert.deepEqual(backend.calls, []);
  assert.equal(a.hold.held, true);
});

test("an archive while a save holds the thread doesn't tear its worktree down under the copy: the cleanup is owed", async () => {
  const origin = originRepo({ patch: WORKTREE_PATCH });
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const w = a.h.runner.get(THREAD).worktree!;
  a.h.runner.holdTurns(THREAD, 'save');
  a.h.runner.update({ threadId: THREAD, archived: true });
  await tick(20);
  const rec = a.h.runner.threads.get(THREAD)!.rec;
  assert.ok(fs.existsSync(w.path));
  assert.equal(rec.worktree?.removedAt, undefined);
  assert.equal(rec.worktree?.cleanupOwed, true);
});

test("a save's size is checked from the disk before anything is read: one too big is refused without reading it", async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  // A 4 GB file in the thread's folder that takes no disk (sparse): reading it would take 4 GB of memory.
  const big = path.join(paths.thread(a.home, THREAD), 'big.bin');
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, 4 * 1024 * 1024 * 1024);
  const before = process.memoryUsage().arrayBuffers;
  const backend = fakeBackend();
  await assert.rejects(save(a.h, a, backend), /more than 128\.0 MB before it's compressed/);
  assert.ok(process.memoryUsage().arrayBuffers - before < 64 * 1024 * 1024, 'nothing like it was read');
  assert.deepEqual(backend.calls, []);
});

test('a file staged under node_modules is the thread\'s work: the save fails rather than drop it', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const top = a.folder.checkout;
  fs.mkdirSync(path.join(top, 'runner', 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(top, 'runner', 'node_modules', 'pkg', 'patched.js'), 'mine\n');
  sh(top, 'git add -f runner/node_modules/pkg/patched.js');
  const backend = fakeBackend();
  await assert.rejects(save(a.h, a, backend), /runner\/node_modules\/pkg\/patched\.js is tracked or staged, with changes/);
  assert.deepEqual(backend.calls, []);
});

test('a save hold is kept on disk from before the thread is touched until the backend lets it go, and a start that finds it holds the thread before it loads', async () => {
  const states: (string | undefined)[] = [];
  const order: string[] = [];
  const hold = new SaveHold({ hold: () => order.push('hold'), release: () => order.push('release'), persist: (st) => (states.push(st), order.push(`persist ${st}`)) });
  hold.begin();
  hold.settled();
  hold.heard('awake', performance.now() + 1);
  assert.deepEqual(order, ['persist saving', 'hold', 'persist settled', 'persist undefined', 'release']);
  // A restart in the middle: held from the start, let go only on the backend's word.
  const restarted: string[] = [];
  const again = new SaveHold({ initial: 'saving', hold: () => {}, release: () => restarted.push('release') });
  assert.equal(again.held, true);
  again.taken('send');
  again.heard('awake', performance.now() + 1);
  assert.equal(restarted.length, 0, 'an outcome never learned stays held');
  const settled = new SaveHold({ initial: 'settled', hold: () => {}, release: () => restarted.push('release') });
  settled.heard('awake', 0);
  assert.deepEqual(restarted, ['release'], "any heartbeat of the new process's is after the outcome");
  // In box.json, written and cleared.
  const home = tmpDir();
  writeBoxSecrets(home, secretsFor('https://github.com/x/proj.git'));
  setSaveHold(home, 'saving');
  assert.equal(readBoxSecrets(home)?.saveHold, 'saving');
  setSaveHold(home, undefined);
  assert.equal(readBoxSecrets(home)?.saveHold, undefined);
  // A thread stopped mid-turn, loaded under the hold: no carry-on, no message starts.
  const origin = originRepo();
  const a = await boxOn(origin, null);
  a.h.runner.create({ text: 'Go', accountId: 'claude-main', cwd: a.folder.cwd, id: THREAD });
  await until(() => a.h.adapter.sessions.length === 1, 'the CLI to start');
  a.h.runner.flush();
  const b = makeHarness(a.home, { defaults: { cwd: a.folder.cwd } as never }, { boxThread: THREAD, boxHolds: ['save'] });
  b.runner.carryOnStopped();
  b.runner.send(THREAD, 'next', []);
  await tick(10);
  assert.equal(b.adapter.sessions.length, 0);
});

test("a file the index says is unchanged (assume-unchanged, skip-worktree) is saved as it really is, and one under node_modules fails the save", async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const top = a.folder.checkout;
  // The agent hid an edit from git.
  fs.writeFileSync(path.join(top, 'runner', 'a.txt'), 'edited, hidden\n');
  sh(top, 'git update-index --assume-unchanged runner/a.txt');
  fs.writeFileSync(path.join(top, 'README.md'), 'edited too\n');
  sh(top, 'git update-index --skip-worktree README.md');
  const backend = fakeBackend();
  await save(a.h, a, backend);
  const [url, sealed] = [...backend.stored][0]!;
  const b = await boxOn(origin, { url, at: Date.now(), bytes: sealed.length }, backend.stored);
  assert.equal(fs.readFileSync(path.join(b.folder.checkout, 'runner', 'a.txt'), 'utf8'), 'edited, hidden\n');
  assert.equal(fs.readFileSync(path.join(b.folder.checkout, 'README.md'), 'utf8'), 'edited too\n');
  // The box's own index keeps its flags: only the save's copy loses them.
  assert.match(sh(top, 'git ls-files -v runner/a.txt'), /^h /);
  // Under node_modules, the real change is seen, and refused.
  const c = await boxOn(origin, null);
  await firstTurn(c.h, c.folder.cwd);
  const ctop = c.folder.checkout;
  fs.mkdirSync(path.join(ctop, 'runner', 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(ctop, 'runner', 'node_modules', 'pkg', 'index.js'), 'one\n');
  sh(ctop, 'git add -f runner/node_modules/pkg/index.js && git commit -qm vendored');
  fs.writeFileSync(path.join(ctop, 'runner', 'node_modules', 'pkg', 'index.js'), 'patched\n');
  sh(ctop, 'git update-index --skip-worktree runner/node_modules/pkg/index.js');
  await assert.rejects(save(c.h, c, fakeBackend()), /runner\/node_modules\/pkg\/index\.js is tracked or staged, with changes/);
});

test('the mirror must be all up before boxSaved: a flush that fails fails the save, held, and boxSaved is never sent', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const backend = fakeBackend();
  const order: string[] = [];
  const watched = { upload: backend.upload, post: async (k: 'mutation', fn: string, args: Record<string, unknown>) => (order.push(fn), backend.post(k, fn, args)) };
  await assert.rejects(
    saveThread({ home: a.home, claudeDir: a.claudeDir, threadId: THREAD, threadKey: KEY, boxKey: BOX_KEY, quiesce: (id) => a.h.runner.quiesceForSave(id), hold: a.hold, beforeSaved: async () => { order.push('flush'); throw new Error('2 still to send'); }, post: watched.post, upload: watched.upload, sleep: async () => {} }),
    /2 still to send/,
  );
  assert.deepEqual(order, ['sync:iconUploadUrl', 'flush']);
  assert.equal(a.hold.held, true);
  order.length = 0;
  await saveThread({ home: a.home, claudeDir: a.claudeDir, threadId: THREAD, threadKey: KEY, boxKey: BOX_KEY, quiesce: (id) => a.h.runner.quiesceForSave(id), hold: a.hold, beforeSaved: async () => void order.push('flush'), post: watched.post, upload: watched.upload, sleep: async () => {} });
  assert.deepEqual(order, ['sync:iconUploadUrl', 'flush', 'boxes:boxSaved']);
});

test("an edit that keeps a file's size and mtime is saved, whatever the repo says to trust of stat data", async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const top = a.folder.checkout;
  sh(top, 'git config core.checkStat minimal && git config core.trustctime false');
  const file = path.join(top, 'runner', 'a.txt');
  // An hour old, so the index written after it isn't racy (git hashes a file as new as its index).
  const old = new Date(Date.now() - 3600_000);
  fs.writeFileSync(file, 'aaaa\n');
  fs.utimesSync(file, old, old);
  sh(top, 'git add runner/a.txt && git commit -qm four && git status --porcelain');
  // The same size, and its mtime put back: by stat data alone, unchanged.
  fs.writeFileSync(file, 'bbbb\n');
  fs.utimesSync(file, old, old);
  assert.equal(sh(top, 'git status --porcelain runner/a.txt'), '', "git's own status misses it, as the trigger needs");
  // And one staged under an ignored path, added with -f.
  fs.mkdirSync(path.join(top, 'build'));
  fs.writeFileSync(path.join(top, '.gitignore'), 'node_modules\nbuild\n');
  sh(top, 'git add .gitignore && git commit -qm ignore');
  fs.writeFileSync(path.join(top, 'build', 'kept.txt'), 'staged\n');
  sh(top, 'git add -f build/kept.txt');
  const backend = fakeBackend();
  await save(a.h, a, backend);
  const [url, sealed] = [...backend.stored][0]!;
  const b = await boxOn(origin, { url, at: Date.now(), bytes: sealed.length }, backend.stored);
  assert.equal(fs.readFileSync(path.join(b.folder.checkout, 'runner', 'a.txt'), 'utf8'), 'bbbb\n');
  assert.equal(fs.readFileSync(path.join(b.folder.checkout, 'build', 'kept.txt'), 'utf8'), 'staged\n');
});

test('a symlink staged with -f under an ignored path, whose target is missing, is saved as the link it is', async () => {
  const origin = originRepo();
  const a = await boxOn(origin, null);
  await firstTurn(a.h, a.folder.cwd);
  const top = a.folder.checkout;
  fs.writeFileSync(path.join(top, '.gitignore'), 'node_modules\nbuild\n');
  sh(top, 'git add .gitignore && git commit -qm ignore');
  fs.mkdirSync(path.join(top, 'build'));
  fs.symlinkSync('../nowhere/target.txt', path.join(top, 'build', 'link'));
  assert.equal(fs.existsSync(path.join(top, 'build', 'link')), false, 'dangling: exists() says no');
  sh(top, 'git add -f build/link');
  const backend = fakeBackend();
  await save(a.h, a, backend);
  const [url, sealed] = [...backend.stored][0]!;
  const b = await boxOn(origin, { url, at: Date.now(), bytes: sealed.length }, backend.stored);
  assert.equal(fs.readlinkSync(path.join(b.folder.checkout, 'build', 'link')), '../nowhere/target.txt');
});

test("a save's hold stops a patch's live poll from running its functions and their commands, and the save waits for one already going", async () => {
  // A folder whose patch has a live badge that runs a command writing into the folder.
  const dir = fs.realpathSync(tmpDir('tb-box-live-'));
  const file = path.join(dir, '.threadbear', 'patches', 'live.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'export default { panels: [{ title: "Live", url: "http://127.0.0.1:1/", badge: async ({ sh }) => Number(await sh("node ./poll.mjs")) }] };\n');
  fs.writeFileSync(path.join(dir, 'poll.mjs'), "import fs from 'node:fs';\nfs.appendFileSync('polled.log', 'x\\n');\nconsole.log(1);\n");
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  assert.ok(trust.trust(file, patchHash(file).hash));
  const h = makeHarness(undefined, {}, { panelsRoot: fs.realpathSync(tmpDir()), patchTrust: trust, actionShell: SHELL, actionTimeoutMs: 5000, boxThread: THREAD });
  h.runner.create({ text: 'go', accountId: 'claude-main', cwd: dir, id: THREAD });
  await until(() => h.adapter.sessions.length === 1, 'the CLI to start');
  h.adapter.last.init();
  h.adapter.last.result();
  const polls = () => (fs.existsSync(path.join(dir, 'polled.log')) ? fs.readFileSync(path.join(dir, 'polled.log'), 'utf8').length / 2 : 0);
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await tick();
      await h.runner.patchesIdle();
    }
  };
  h.runner.get(THREAD);
  await settle();
  await until(() => polls() >= 1, 'the first live read');
  // Polling, as it does every LIVE_POLL_MS.
  const before = polls();
  h.clock.advance(LIVE_POLL_MS + LIVE_SHARE_MS);
  await settle();
  await until(() => polls() > before, 'a poll');
  // Held by a save: polls come round, and nothing runs.
  h.runner.holdTurns(THREAD, 'save');
  const held = polls();
  for (let i = 0; i < 3; i++) {
    h.clock.advance(LIVE_POLL_MS + LIVE_SHARE_MS);
    h.runner.get(THREAD);
    await settle();
  }
  assert.equal(polls(), held, 'no live function ran while held');
  h.runner.releaseTurns(THREAD, 'save');
  // A read already going when a save starts: the save's stop waits for it.
  h.clock.advance(LIVE_POLL_MS + LIVE_SHARE_MS);
  let quiesced = false;
  const reading = h.runner['patchReads'].size;
  const q = h.runner.quiesceForSave(THREAD, { waitMs: 30_000 }).then(() => (quiesced = true));
  if (reading) assert.equal(quiesced, false);
  await q;
  assert.equal(h.runner['patchReads'].size, 0, 'no read of its patches outlives the stop');
});
