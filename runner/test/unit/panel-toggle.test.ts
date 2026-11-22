import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/fakes.ts';
import { loadPatchSet, panelItem, readPatchModule, renderListPanel, runCommand, toggleListPanel } from '../../src/patches.ts';

// A list row's switch (docs/protocol/patches.md, Patches, "Row toggles"): a PRs
// panel's auto-fix wand on each PR, say. Ported from Ville
// Lahdenvuo-Malta's fork.

test('a list row keeps a well-formed toggle and drops a malformed one', () => {
  assert.deepEqual(panelItem({ title: 'a', toggle: { id: ' o/r#1 ', on: true, icon: ' wand.and.stars ', title: 'Auto-fix #1', extra: 1 } }), {
    title: 'a',
    toggle: { id: 'o/r#1', on: true, icon: 'wand.and.stars', title: 'Auto-fix #1' },
  });
  assert.deepEqual(panelItem({ title: 'a', toggle: { id: 'x', on: 'yes' } }), { title: 'a' });
  assert.deepEqual(panelItem({ title: 'a', toggle: { id: ' ', on: false } }), { title: 'a' });
  assert.deepEqual(panelItem({ title: 'a', toggle: 'on' }), { title: 'a' });
  const long = panelItem({ title: 'a', toggle: { id: 'x'.repeat(300), on: false, title: 'y'.repeat(100) } })?.toggle;
  assert.equal(long?.id.length, 200);
  assert.equal(long?.title?.length, 80);
});

test('panels.toggle calls the patch toggle function and fills the panel again; rows of a panel without one lose their switch', async () => {
  const home = tmpDir();
  const app = path.join(home, 'dev/app');
  const dir = path.join(app, '.threadbear/patches');
  fs.mkdirSync(dir, { recursive: true });
  const state = path.join(app, 'on.txt');
  fs.writeFileSync(path.join(dir, 'prs.ts'), `
    import fs from "node:fs";
    const file = ${JSON.stringify(state)};
    const on = () => fs.existsSync(file) && fs.readFileSync(file, "utf8") === "1";
    export default {
      panels: [
        { title: "PRs", items: () => [{ title: "#1", toggle: { id: "o/r#1", on: on(), icon: "wand.and.stars" } }],
          toggle: async ({ id, on, sh }) => { await sh("true"); if (id !== "o/r#1") throw new Error("no such PR " + id); fs.writeFileSync(file, on ? "1" : "0"); } },
        { title: "Plain", items: () => [{ title: "#2", toggle: { id: "x", on: true } }] },
        { title: "Slow", items: () => [], toggle: () => new Promise(() => {}) },
      ],
    };
  `);
  const set = await loadPatchSet(app, home);
  assert.equal(set.patches[0]?.error, undefined);
  const [prs, plain, slow] = set.panels;
  const ctx = { cwd: app, threadId: 't1', timeoutMs: 120_000, run: (command: string, cwd: string) => runCommand(command, { cwd, env: process.env }) };

  assert.deepEqual(await renderListPanel(prs!, set, ctx), { items: [{ title: '#1', toggle: { id: 'o/r#1', on: false, icon: 'wand.and.stars' } }] });
  assert.deepEqual(await toggleListPanel(prs!, set, ctx, 'o/r#1', true), { items: [{ title: '#1', toggle: { id: 'o/r#1', on: true, icon: 'wand.and.stars' } }] });
  assert.equal(fs.readFileSync(state, 'utf8'), '1');
  assert.deepEqual(await toggleListPanel(prs!, set, ctx, 'o/r#1', false), { items: [{ title: '#1', toggle: { id: 'o/r#1', on: false, icon: 'wand.and.stars' } }] });
  await assert.rejects(toggleListPanel(prs!, set, ctx, 'o/r#9', true), /Couldn't switch it: no such PR o\/r#9/);
  await assert.rejects(toggleListPanel(slow!, set, { ...ctx, timeoutMs: 50 }, 'x', true), /took over/);

  assert.deepEqual(await renderListPanel(plain!, set, ctx), { items: [{ title: '#2' }] });
  await assert.rejects(toggleListPanel(plain!, set, ctx, 'x', true), /no switches/);

  assert.equal(readPatchModule('x', 'project', '/x.ts', { panels: [{ title: 'Bad', items: () => [], toggle: 'nope' }] }).info.error, 'panels[0] ("Bad") has a toggle that isn\'t a function.');
});
