// Windows' clicks-only rule (platform.ts, clicksOnly): a project's patch
// trusted by its hash, and a folder's Claude Code settings, run nothing by
// themselves there for now, only the buttons that are clicked. The unit
// tests turn it off (test/helpers/clean-env.ts); this file turns it on, so
// it runs the same on a Mac as on Windows.
import '../helpers/clicks-only-on.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { applyLive, findWorktreePatch, loadPatchSet, renderListPanel } from '../../src/patches.ts';
import { PatchTrust } from '../../src/patch-trust.ts';
import { clicksOnly, CLICKS_ONLY_NOTE } from '../../src/platform.ts';

function write(folder: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    fs.writeFileSync(path.join(folder, name), body);
  }
}

test('on Windows it is on, and only the test value 0 turns it off; elsewhere only 1 turns it on; read once, as it loads', () => {
  assert.equal(clicksOnly(), true);
  process.env.THREADBEAR_CLICKS_ONLY = '0';
  assert.equal(clicksOnly(), true, 'a later change to process.env does nothing');
  process.env.THREADBEAR_CLICKS_ONLY = '1';
  assert.equal(clicksOnly({}, 'win32'), true);
  assert.equal(clicksOnly({ THREADBEAR_CLICKS_ONLY: '' }, 'win32'), true);
  assert.equal(clicksOnly({ THREADBEAR_CLICKS_ONLY: 'false' }, 'win32'), true);
  assert.equal(clicksOnly({ THREADBEAR_CLICKS_ONLY: '0' }, 'win32'), false);
  assert.equal(clicksOnly({}, 'darwin'), false);
  assert.equal(clicksOnly({ THREADBEAR_CLICKS_ONLY: '1' }, 'linux'), true);
});

test("a trusted project patch keeps its buttons and panels, but its hooks, setup and teardown are dropped, and it says why", async () => {
  const root = tmpDir();
  const folder = path.join(root, 'repo');
  write(folder, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.threadbear/patches/tools.ts':
      "export default { actions: [{ title: 'Build', run: './scripts/build.sh' }], worktree: { setup: './scripts/setup.sh', teardown: './scripts/teardown.sh', keep: ['.env'] }, hooks: [{ title: 'Check', on: 'turn.end', run: './scripts/check.sh' }] };\n",
    'scripts/build.sh': 'echo build\n',
    'scripts/setup.sh': 'echo setup\n',
    'scripts/teardown.sh': 'echo teardown\n',
    'scripts/check.sh': 'echo check\n',
  });
  const trust = new PatchTrust();
  assert.equal(trust.trustCurrent([path.join(folder, '.threadbear', 'patches', 'tools.ts')]).length, 1);
  const set = await loadPatchSet(folder, root, new Map(), [], [], undefined, trust);
  assert.equal(set.patches[0]?.error, undefined);
  assert.equal(set.patches[0]?.untrusted, undefined);
  assert.deepEqual(set.actions.map((a) => a.title), ['Build'], 'the button stays');
  assert.equal(set.hooks.length, 0, 'no hook, bound or as written');
  assert.equal(set.patches[0]?.liveError, CLICKS_ONLY_NOTE);
  const w = await findWorktreePatch(folder, root, new Map(), undefined, trust);
  assert.ok(w, 'its worktree settings still load');
  assert.equal(w.setup, undefined, 'no setup, or it would run as written');
  assert.equal(w.heldSetup, './scripts/setup.sh', 'kept aside, to say it did not run');
  assert.equal(w.setupRun, undefined);
  assert.equal(w.teardown, undefined);
  assert.equal(w.teardownRun, undefined);
  assert.deepEqual(w.keep, ['.env']);
});

test("a trusted project patch's live functions run no commands", async () => {
  const root = tmpDir();
  const repo = path.join(root, 'R');
  write(repo, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.threadbear/patches/p.ts': `export default {
  panels: [
    { title: 'Status', url: 'http://localhost:3000', badge: async ({ sh }) => Number((await sh('./tools/count.sh')).trim()) },
    { title: 'List', items: async ({ sh }) => [(await sh('./tools/count.sh')).trim()] },
  ],
};\n`,
    'tools/count.sh': '#!/bin/sh\necho 3\n',
  });
  const trust = new PatchTrust();
  assert.equal(trust.trustCurrent([path.join(repo, '.threadbear', 'patches', 'p.ts')]).length, 1);
  const ran: string[] = [];
  const ctx = {
    cwd: repo,
    threadId: 't1',
    timeoutMs: 120_000,
    run: async (command: string) => {
      ran.push(command);
      return { ok: true, text: '3\n', truncated: false, durationMs: 0 };
    },
    verify: (file: string, hash: string) => trust.verify(file, hash),
  };
  const base = await loadPatchSet(repo, root, new Map(), [], [], undefined, trust);
  assert.equal(base.patches[0]?.untrusted, undefined);
  const set = await applyLive(base, ctx);
  assert.equal(set.panels.find((p) => p.title === 'Status')?.badge, undefined);
  const list = await renderListPanel(base.panels.find((p) => p.title === 'List')!, base, ctx);
  assert.ok((list.note ?? '').includes(CLICKS_ONLY_NOTE), String(list.note));
  assert.deepEqual(ran, [], 'nothing reached the shell');
});

test("a home patch, which loads without a hash, isn't affected", async () => {
  const root = tmpDir();
  const home = path.join(root, 'home');
  write(home, { '.threadbear/patches/mine.ts': "export default { hooks: [{ title: 'Mine', on: 'turn.end', run: 'echo hi' }] };\n" });
  const work = path.join(root, 'work');
  fs.mkdirSync(work, { recursive: true });
  const set = await loadPatchSet(work, home, new Map(), [], [], undefined, new PatchTrust());
  assert.deepEqual(set.hooks.map((h) => h.title), ['Mine']);
  assert.equal(set.patches[0]?.liveError, undefined);
});

test("a folder's Claude Code hooks stay off, even once trusted", () => {
  const root = tmpDir();
  const dir = path.join(root, 'app');
  write(dir, {
    '.claude/settings.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node .claude/hooks/start.mjs' }] }] } }),
    '.claude/hooks/start.mjs': 'console.log("hi")\n',
  });
  const trust = new PatchTrust({ claudeHome: root });
  const v = trust.checkClaude(dir);
  assert.equal(v.trusted, false);
  assert.ok(!v.trusted && v.reason === 'unchecked' && /on Windows/.test(v.problem ?? ''), JSON.stringify(v));
  if (!v.trusted && v.hash) trust.trustClaude(dir, v.hash);
  assert.equal(trust.checkClaude(dir).trusted, false, 'a stored yes changes nothing');
});

test("a schedule's check in a repo's folder is held, whatever was approved; one outside any repo isn't", () => {
  const root = tmpDir();
  const repo = path.join(root, 'repo');
  write(repo, { '.git/HEAD': 'ref: refs/heads/main\n', 'check.sh': 'echo hi\n' });
  const loose = path.join(root, 'loose');
  write(loose, { 'check.sh': 'echo hi\n' });
  const trust = new PatchTrust({ file: path.join(root, 'trust.json') });
  assert.throws(() => trust.approveCheck('./check.sh', repo), /On Windows/);
  const held = trust.checkApproved('./check.sh', repo);
  assert.equal(held.approved, false);
  assert.match(held.why ?? '', /On Windows/);
  trust.approveCheck('./check.sh', loose);
  assert.equal(trust.checkApproved('./check.sh', loose).approved, true);
});
