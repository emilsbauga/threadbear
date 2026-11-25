// Panel buttons (docs/protocol/events.md, "Reply buttons"): a reply's button that
// opens another folder's patch panel beside the thread. The Daily brief's
// "Go through comments" opens the YouTube patch's panel from
// yt-channel-manager (Mike, 18 Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeHarness, tick, tmpDir } from '../helpers/fakes.ts';
import { checkSummary } from '../helpers/protocol-check.ts';
import { PatchTrust, patchHash } from '../../src/patch-trust.ts';
import { buildThreadbearTools } from '../../src/threadbear-mcp.ts';
import { borrowedPanelId } from '../../src/runner/buttons.ts';
import { SHELL } from '../helpers/platform.ts';

// A folder like yt-channel-manager: a web panel whose badge starts its
// server (here, leaves a file), and a list panel.
function youtubeFolder(): { dir: string; file: string } {
  const dir = fs.realpathSync(tmpDir());
  const file = path.join(dir, '.threadbear', 'patches', 'youtube.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `export default {
  panels: [
    {
      title: "YouTube",
      url: "http://127.0.0.1:6427/?thread={threadId}",
      badge: async ({ sh }) => Number(await sh("node ./start.mjs")),
      summary: () => "3 comments waiting on you",
    },
    { title: "Rows", items: () => [] },
  ],
};
`);
  // As scripts/youtube-panel.mjs starts the YouTube panel's server.
  // Slow to start once there's a file called slow.
  fs.writeFileSync(path.join(dir, 'start.mjs'), "import fs from 'node:fs';\nfs.writeFileSync('running', '');\nif (fs.existsSync('slow')) await new Promise((r) => setTimeout(r, 3000));\nfs.writeFileSync('started', '');\nconsole.log(3);\n");
  return { dir, file };
}

async function fixture() {
  const yt = youtubeFolder();
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  assert.ok(trust.trust(yt.file, patchHash(yt.file).hash));
  const h = makeHarness(undefined, {}, { panelsRoot: fs.realpathSync(tmpDir()), patchTrust: trust, actionShell: SHELL, actionTimeoutMs: 5000 });
  const brief = h.runner.create({ text: 'Daily brief', accountId: 'claude-3', cwd: fs.realpathSync(tmpDir()) }).thread;
  await tick();
  await h.runner.patchesIdle();
  return { h, yt, brief };
}

function addButton(h: ReturnType<typeof makeHarness>, threadId: string) {
  const t = buildThreadbearTools(h.runner, threadId).find((x) => x.name === 'add_button');
  assert.ok(t, 'add_button');
  return async (args: Record<string, unknown>) => {
    const r = (await t.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), error: Boolean(r.isError) };
  };
}

async function settle(h: ReturnType<typeof makeHarness>) {
  for (let i = 0; i < 5; i++) {
    await tick();
    await h.runner.patchesIdle();
  }
}

test('a panel button opens the folder\'s panel beside the thread, starting what it needs, every press', async () => {
  const { h, yt, brief } = await fixture();
  const made = await addButton(h, brief.id)({ title: 'Go through comments', panel: { folder: yt.dir, panel: 'youtube' } });
  assert.equal(made.error, false, made.text);
  const id = /button:([a-z0-9]{8})/.exec(made.text)![1]!;
  assert.match(made.text, /opens YouTube from .* beside this thread/);
  const button = h.runner.listButtons(brief.id).buttons[0]!;
  assert.deepEqual(button.panel, { cwd: yt.dir, panelId: 'youtube.youtube', title: 'YouTube' });
  // Nothing runs, and nothing joins the thread, until it's pressed.
  assert.equal(fs.existsSync(path.join(yt.dir, 'started')), false);
  assert.equal(h.runner.get(brief.id).panels?.some((p) => p.from), undefined);

  const pressed = h.runner.pressButton(brief.id, id).button;
  assert.equal(pressed.pressed?.threadId, brief.id);
  await settle(h);
  const after = h.runner.get(brief.id);
  assert.deepEqual(checkSummary(after as never), []);
  const panel = after.panels?.find((p) => p.from === yt.dir);
  assert.ok(panel, 'the panel joined the thread');
  assert.equal(panel.id, borrowedPanelId(yt.dir, 'youtube.youtube'));
  assert.notEqual(panel.id, 'youtube.youtube', "never taken for the folder's own");
  // {threadId} empty: the brief isn't one of that folder's threads.
  assert.equal(panel.url, 'http://127.0.0.1:6427/?thread=');
  assert.equal(panel.badge, 3);
  assert.equal(panel.summary, '3 comments waiting on you');
  assert.ok(fs.existsSync(path.join(yt.dir, 'started')), 'the badge ran, in its own folder');
  assert.equal(after.panelRequest?.panel, panel.id);
  assert.equal(after.panelRequest?.title, 'YouTube');

  // Shown, then pressed again: it asks again, rather than being spent.
  h.runner.panelShown(brief.id, after.panelRequest!.id);
  h.runner.pressButton(brief.id, id);
  await settle(h);
  assert.equal(h.runner.get(brief.id).panelRequest?.panel, panel.id);
  // A second button for the same panel (tomorrow's brief) adds no second panel.
  const again = await addButton(h, brief.id)({ title: 'Comments', panel: { folder: yt.dir, panel: 'YouTube' } });
  h.runner.pressButton(brief.id, /button:([a-z0-9]{8})/.exec(again.text)![1]!);
  await settle(h);
  assert.equal(h.runner.get(brief.id).panels?.filter((p) => p.from).length, 1);
  // It stays after a restart.
  const back = h.restart();
  back.runner.get(brief.id);
  await settle(back);
  assert.ok(back.runner.get(brief.id).panels?.some((p) => p.id === panel.id));
  // Mike's next message to the brief hears nothing of it: it's not a job done.
  assert.equal((h.store.load(brief.id) as { presses?: unknown[] }).presses?.length ?? 0, 0);
});

test('a panel button is checked when made', async () => {
  const { h, yt, brief } = await fixture();
  const add = addButton(h, brief.id);
  const missing = await add({ title: 'Go', panel: { folder: yt.dir, panel: 'storybook' } });
  assert.equal(missing.error, true);
  assert.match(missing.text, /No panel called storybook .* Its web panels: youtube\.youtube \(YouTube\)\./);
  const list = await add({ title: 'Go', panel: { folder: yt.dir, panel: 'Rows' } });
  assert.match(list.text, /Rows is a list panel/);
  const gone = await add({ title: 'Go', panel: { folder: path.join(yt.dir, 'nope'), panel: 'YouTube' } });
  assert.equal(gone.error, true);
  const both = await add({ title: 'Go', panel: { folder: yt.dir, panel: 'YouTube' }, send: { threadId: brief.id, text: 'x' } });
  assert.equal(both.error, true);
  assert.equal(h.runner.listButtons(brief.id).buttons.length, 0);
});

test('a folder gone by the press fails it', async () => {
  const { h, yt, brief } = await fixture();
  const made = await addButton(h, brief.id)({ title: 'Go through comments', panel: { folder: yt.dir, panel: 'YouTube' } });
  const id = /button:([a-z0-9]{8})/.exec(made.text)![1]!;
  fs.rmSync(yt.dir, { recursive: true, force: true });
  assert.throws(() => h.runner.pressButton(brief.id, id), /has gone/);
  assert.match(h.runner.listButtons(brief.id).buttons[0]!.failed!.error, /has gone/);
});

// Daily brief, 23 Nov 2026: Mike pressed Go through comments six times and
// nothing opened. The press waited for the brief's whole patch read, every
// patch's live state included, before asking for the panel, and on the busy
// runner that read kept going for 13 minutes; the panel came up long after
// he'd given up. The panel is shown from its own folder now, straight away,
// whatever the thread's other patches are doing.
test('a panel button opens its panel without waiting for the thread\'s own slow patches', async () => {
  const yt = youtubeFolder();
  const briefDir = fs.realpathSync(tmpDir());
  const slow = path.join(briefDir, '.threadbear', 'patches', 'slow.ts');
  fs.mkdirSync(path.dirname(slow), { recursive: true });
  // Slow once the flag is there: the first read, before the press, is quick.
  fs.writeFileSync(slow, `export default {
  panels: [{ title: "Slow", url: "http://127.0.0.1:1/", badge: async ({ sh }) => Number(await sh("node ./slow.mjs")) }],
};
`);
  fs.writeFileSync(path.join(briefDir, 'slow.mjs'), "import fs from 'node:fs';\nif (fs.existsSync('slow')) await new Promise((r) => setTimeout(r, 4000));\nconsole.log(1);\n");
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  assert.ok(trust.trust(yt.file, patchHash(yt.file).hash));
  assert.ok(trust.trust(slow, patchHash(slow).hash));
  const h = makeHarness(undefined, {}, { panelsRoot: fs.realpathSync(tmpDir()), patchTrust: trust, actionShell: SHELL, actionTimeoutMs: 10_000 });
  const brief = h.runner.create({ text: 'Daily brief', accountId: 'claude-3', cwd: briefDir }).thread;
  await settle(h);
  assert.ok(h.runner.get(brief.id).panels?.some((p) => p.title === 'Slow'));
  const made = await addButton(h, brief.id)({ title: 'Go through comments', panel: { folder: yt.dir, panel: 'YouTube' } });
  const id = /button:([a-z0-9]{8})/.exec(made.text)![1]!;
  fs.writeFileSync(path.join(briefDir, 'slow'), '');
  // Past the live share, so the brief's read runs its slow badge again.
  h.clock.advance(60_000);
  const started = Date.now();
  h.runner.pressButton(brief.id, id);
  let after = h.runner.get(brief.id);
  while (!after.panelRequest && Date.now() - started < 3000) {
    await new Promise((r) => setTimeout(r, 20));
    after = h.runner.get(brief.id);
  }
  const panel = after.panels?.find((p) => p.from === yt.dir);
  assert.ok(after.panelRequest, 'the panel was asked for while the slow badge still ran');
  assert.ok(panel, 'and the thread has it, so the app can show it');
  assert.deepEqual(checkSummary(after as never), []);
  assert.equal(after.panelRequest.panel, panel.id);
  assert.equal(panel.url, 'http://127.0.0.1:6427/?thread=');
  assert.ok(fs.existsSync(path.join(yt.dir, 'started')), 'its badge ran, so its server is up');
  // The slow read ends with the panel still there, badge and all.
  await settle(h);
  const later = h.runner.get(brief.id).panels?.find((p) => p.from === yt.dir);
  assert.equal(later?.badge, 3);
});

// A second panel button pressed while the thread's read is still running
// the first one's slow badge: that read looked before the press, and must
// not take the second panel away again once it's on screen (Codex's review).
test('a read that started before a press keeps the panel the press opened', async () => {
  const a = youtubeFolder();
  const b = youtubeFolder();
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  assert.ok(trust.trust(a.file, patchHash(a.file).hash));
  assert.ok(trust.trust(b.file, patchHash(b.file).hash));
  const h = makeHarness(undefined, {}, { panelsRoot: fs.realpathSync(tmpDir()), patchTrust: trust, actionShell: SHELL, actionTimeoutMs: 10_000 });
  const brief = h.runner.create({ text: 'Daily brief', accountId: 'claude-3', cwd: fs.realpathSync(tmpDir()) }).thread;
  await settle(h);
  const add = addButton(h, brief.id);
  const idOf = (text: string) => /button:([a-z0-9]{8})/.exec(text)![1]!;
  const first = idOf((await add({ title: 'A', panel: { folder: a.dir, panel: 'YouTube' } })).text);
  const second = idOf((await add({ title: 'B', panel: { folder: b.dir, panel: 'YouTube' } })).text);
  const bId = borrowedPanelId(b.dir, 'youtube.youtube');
  const inside = h.runner as unknown as { threads: Map<string, { rt: { patches?: { set: { panels: { id: string }[] } } } }>; markDirty: (s: unknown) => void; borrowedPanels: (s: unknown) => unknown };
  const st = inside.threads.get(brief.id)!;
  // Every time the thread's panels change once B is open, B is among them.
  let bOpen = false;
  const lost: string[][] = [];
  const markDirty = inside.markDirty.bind(h.runner);
  inside.markDirty = (s: unknown) => {
    const ids = (st.rt.patches?.set.panels ?? []).map((p) => p.id);
    if (bOpen && !ids.includes(bId)) lost.push(ids);
    if (ids.includes(bId)) bOpen = true;
    markDirty(s);
  };
  fs.writeFileSync(path.join(a.dir, 'slow'), '');
  fs.rmSync(path.join(a.dir, 'running'), { force: true });
  // The thread's read looks at what's pressed through borrowedPanels.
  let looked = 0;
  const borrowedPanels = inside.borrowedPanels.bind(h.runner);
  inside.borrowedPanels = (s: unknown) => {
    looked += 1;
    return borrowedPanels(s);
  };
  h.runner.pressButton(brief.id, first);
  // The read has looked, and is running A's slow badge.
  let started = Date.now();
  while ((!looked || !fs.existsSync(path.join(a.dir, 'running'))) && Date.now() - started < 3000) await new Promise((r) => setTimeout(r, 10));
  assert.ok(looked && fs.existsSync(path.join(a.dir, 'running')), "the read never got to A's badge");
  h.runner.pressButton(brief.id, second);
  started = Date.now();
  while (h.runner.get(brief.id).panelRequest?.panel !== bId && Date.now() - started < 2000) await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.runner.get(brief.id).panelRequest?.panel, bId, 'B opened while A\'s badge still ran');
  // A's badge ends and the read that started before B's press is saved.
  started = Date.now();
  while (!h.runner.get(brief.id).panels?.some((p) => p.id === borrowedPanelId(a.dir, 'youtube.youtube')) && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 20));
  await settle(h);
  assert.deepEqual(lost, [], 'B went from the panels after it opened');
  // And A, pressed first but slower, didn't open over B (Codex's second look).
  assert.equal(h.runner.get(brief.id).panelRequest?.panel, bId);
  const ids = h.runner.get(brief.id).panels?.filter((p) => p.from).map((p) => p.id).sort();
  assert.deepEqual(ids, [borrowedPanelId(a.dir, 'youtube.youtube'), bId].sort());
});

// Pressed again later, its badge runs again before the panel is shown, so a
// server that has stopped since is started first (Gemini's review).
test('a panel button pressed again runs its badge again before showing it', async () => {
  const { h, yt, brief } = await fixture();
  const made = await addButton(h, brief.id)({ title: 'Go through comments', panel: { folder: yt.dir, panel: 'YouTube' } });
  const id = /button:([a-z0-9]{8})/.exec(made.text)![1]!;
  h.runner.pressButton(brief.id, id);
  await settle(h);
  const first = h.runner.get(brief.id).panelRequest!;
  h.runner.panelShown(brief.id, first.id);
  fs.rmSync(path.join(yt.dir, 'started'));
  // Past the live share, so the badge's command runs again.
  h.clock.advance(60_000);
  h.runner.pressButton(brief.id, id);
  const started = Date.now();
  let request = h.runner.get(brief.id).panelRequest;
  while (!request && Date.now() - started < 3000) {
    await new Promise((r) => setTimeout(r, 5));
    request = h.runner.get(brief.id).panelRequest;
  }
  assert.ok(request, 'shown again');
  assert.ok(fs.existsSync(path.join(yt.dir, 'started')), 'its server was started before it was shown');
});

// A button for a panel of the thread's own folder opens that panel, under
// its own id, once its badge has run.
test('a panel button for the thread\'s own folder opens its own panel', async () => {
  const yt = youtubeFolder();
  const trust = new PatchTrust({ file: path.join(tmpDir(), 'patch-trust.json') });
  assert.ok(trust.trust(yt.file, patchHash(yt.file).hash));
  const h = makeHarness(undefined, {}, { panelsRoot: fs.realpathSync(tmpDir()), patchTrust: trust, actionShell: SHELL, actionTimeoutMs: 10_000 });
  const thread = h.runner.create({ text: 'Comments', accountId: 'claude-3', cwd: yt.dir }).thread;
  await settle(h);
  const made = await addButton(h, thread.id)({ title: 'Open it', panel: { folder: yt.dir, panel: 'YouTube' } });
  fs.rmSync(path.join(yt.dir, 'started'));
  h.clock.advance(60_000);
  h.runner.pressButton(thread.id, /button:([a-z0-9]{8})/.exec(made.text)![1]!);
  const started = Date.now();
  let request = h.runner.get(thread.id).panelRequest;
  while (!request && Date.now() - started < 3000) {
    await new Promise((r) => setTimeout(r, 5));
    request = h.runner.get(thread.id).panelRequest;
  }
  assert.equal(request?.panel, 'youtube.youtube');
  assert.ok(fs.existsSync(path.join(yt.dir, 'started')), 'its badge ran first');
  assert.equal(h.runner.get(thread.id).panels?.some((p) => p.from), false);
});
