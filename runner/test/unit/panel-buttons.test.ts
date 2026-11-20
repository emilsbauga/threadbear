// Panel buttons (docs/protocol.md, "Reply buttons"): a reply's button that
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
  fs.writeFileSync(path.join(dir, 'start.mjs'), "import fs from 'node:fs';\nfs.writeFileSync('started', '');\nconsole.log(3);\n");
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
