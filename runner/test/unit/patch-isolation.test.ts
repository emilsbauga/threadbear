// Box mode never runs a repo's patch code in the runner's process
// (patches.ts isolatePatchCode, patch-child.ts): each patch file is read in
// a child process that sends back what's static in it and exits, and its
// functions (when, badge, a list panel's items) aren't run at all. So a
// timer the patch's code starts can't write behind a save's copy. On in
// this test's process only (each test file is a process of its own).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { PatchTrust, patchHash } from '../../src/patch-trust.ts';
import { SHELL } from '../helpers/platform.ts';
import { findWorktreePatch, isolatePatchCode } from '../../src/patches.ts';
import { LIVE_POLL_MS } from '../../src/runner.ts';

isolatePatchCode();

// A folder whose patch, as it loads, notes the process it runs in, and
// starts a timer that does too; with a live action, a list panel and a
// badged panel whose functions note theirs; and a static action and worktree setup.
function folder(): { dir: string; file: string; log: string } {
  const dir = fs.realpathSync(tmpDir('tb-iso-'));
  const log = path.join(dir, 'ran.log');
  const file = path.join(dir, '.threadbear', 'patches', 'p.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const note = (what: string) => `fs.appendFileSync(${JSON.stringify(log)}, '${what} ' + process.pid + '\\n')`;
  fs.writeFileSync(
    file,
    `import fs from 'node:fs';
${note('load')};
setTimeout(() => ${note('timer')}, 0);
setTimeout(() => ${note('late')}, 200);
export default {
  actions: [
    { title: 'Static', run: 'echo hi' },
    { title: 'Live', run: 'echo x', when: () => (${note('when')}, true) },
  ],
  panels: [
    { title: 'List', items: () => (${note('items')}, []) },
    { title: 'Page', url: 'https://example.com/', badge: () => (${note('badge')}, 2) },
    { title: 'Plain', url: 'https://example.com/plain' },
  ],
  worktree: { setup: './setup.sh' },
};
`,
  );
  fs.writeFileSync(path.join(dir, 'setup.sh'), '#!/bin/sh\necho set up\n', { mode: 0o755 });
  return { dir, file, log };
}

async function settle(h: ReturnType<typeof makeHarness>) {
  for (let i = 0; i < 5; i++) {
    await tick();
    await h.runner.patchesIdle();
  }
}

for (const trusted of [false, true]) {
  test(`in box mode a patch's code never runs in the runner's process, nor its functions anywhere (${trusted ? 'trusted by hash, from its bytes' : 'trusted outright'})`, async () => {
    const f = folder();
    const trust = trusted ? new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') }) : undefined;
    if (trust) assert.ok(trust.trust(f.file, patchHash(f.file).hash));
    const h = makeHarness(undefined, {}, { panelsRoot: fs.realpathSync(tmpDir()), ...(trust ? { patchTrust: trust } : {}), actionShell: SHELL, actionTimeoutMs: 5000 });
    const t = h.runner.create({ text: 'go', accountId: 'claude-main', cwd: f.dir }).thread;
    h.runner.get(t.id);
    await settle(h);
    const ran = () => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').trim().split('\n') : []);
    // Read, in a child: the static parts only.
    const summary = h.runner.get(t.id);
    const actions = (summary.actions ?? []).filter((a) => a.patch === 'p').map((a) => a.title);
    const panels = (summary.panels ?? []).filter((p) => p.patch === 'p').map((p) => p.title);
    assert.deepEqual(actions, ['Static']);
    assert.deepEqual(panels, ['Plain']);
    const w = await findWorktreePatch(f.dir, h.runner.panelsRoot, new Map(), undefined, trust ?? undefined);
    assert.equal(w?.setup, './setup.sh');
    // Polls come round: still nothing of its functions.
    h.clock.advance(LIVE_POLL_MS * 3);
    h.runner.get(t.id);
    await settle(h);
    const lines = ran();
    assert.ok(lines.some((l) => l.startsWith('load ')), 'it was read');
    for (const l of lines) {
      const [what, pid] = l.split(' ');
      assert.notEqual(Number(pid), process.pid, `${what} ran in the runner's process`);
      assert.ok(what === 'load' || what === 'timer' || what === 'late', `${what} ran`);
    }
    // The late timer had nowhere to run: its child had exited.
    await new Promise<void>((resolve) => {
      const end = Date.now() + 1000;
      const look = () => (Date.now() > end ? resolve() : setImmediate(look));
      look();
    });
    assert.ok(!ran().some((l) => l.startsWith('late ')), 'no timer of its outlived the read');
  });
}

// A patch whose code, as it loads, starts a process that holds the
// loader's stdout and stderr for a minute; and, `noisy`, prints to stdout
// and stderr around its own reply.
function patchFolder(opts: { hold?: boolean; noisy?: boolean }): { dir: string; pids: string } {
  const dir = fs.realpathSync(tmpDir('tb-iso-held-'));
  const pids = path.join(dir, 'pids.log');
  const file = path.join(dir, '.threadbear', 'patches', 'held.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const hold = `const held = spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'] });
fs.appendFileSync(${JSON.stringify(pids)}, held.pid + '\\n');
held.unref();`;
  fs.writeFileSync(
    file,
    `import fs from 'node:fs';
import { spawn } from 'node:child_process';
${opts.noisy ? "console.log('loading the patch');\nprocess.stdout.write('{\"not\": \"the reply\"');\nconsole.error('and on stderr');" : ''}
${opts.hold ? hold : ''}
export default { actions: [{ title: 'Held', run: 'echo hi' }] };
`,
  );
  return { dir, pids };
}

async function readIn(dir: string) {
  const h = makeHarness(undefined, {}, { panelsRoot: fs.realpathSync(tmpDir()), actionShell: SHELL, actionTimeoutMs: 5000 });
  const t = h.runner.create({ text: 'go', accountId: 'claude-main', cwd: dir }).thread;
  h.runner.get(t.id);
  await settle(h);
  const summary = h.runner.get(t.id);
  return { patch: summary.patches?.find((p) => p.id === 'held'), actions: (summary.actions ?? []).filter((a) => a.patch === 'held').map((a) => a.title) };
}

test("a patch that leaves a process holding the loader's outputs is still read, at once, and what it left is killed with the loader's group", { timeout: 25_000 }, async () => {
  const f = patchFolder({ hold: true });
  const started = Date.now();
  const got = await readIn(f.dir);
  assert.equal(got.patch?.error, undefined);
  assert.deepEqual(got.actions, ['Held']);
  assert.ok(Date.now() - started < 15_000, 'not held up by what it left running');
  const pid = Number(fs.readFileSync(f.pids, 'utf8').trim().split('\n')[0]);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const end = Date.now() + 10_000;
  while (alive() && Date.now() < end) await new Promise((r) => setImmediate(r));
  assert.equal(alive(), false, 'the process it left is gone');
});

test('a patch that prints, on stdout and stderr, around its reply is still read: the reply has a channel of its own', async () => {
  const f = patchFolder({ noisy: true });
  const got = await readIn(f.dir);
  assert.equal(got.patch?.error, undefined);
  assert.deepEqual(got.actions, ['Held']);
});
