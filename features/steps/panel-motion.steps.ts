import { Given, Then } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import type { Dump, Rect } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

// Both apps' dumps give `panelMotion`: where each panel's group was drawn when
// the layout last changed with its glide, and where it is now (or, in the
// GPUI app, where it's going), by panel. The GPUI app says too whether the
// glide is still running; the Swift app's runs in SwiftUI and doesn't say.

const area = (r: Rect) => r.width * r.height;
const settled = (d: Dump) => d.panelMotion && d.panelMotion.moving !== true;

// With Reduce Motion on (the stress run's motion condition) the panels jump
// to their new places and nothing glides (start_motion in desktop/dock's
// view.rs), so `panelMotion` stays empty. Those steps check the layout
// instead: `dock`'s summary, like "row[threads 29% | column[thread 68% /
// terminal 32%] 47% | highlights 24%]".

/** The share of the window `panel`'s group has in a `dock` summary, or undefined when it isn't in it. */
function dockShare(summary: string | undefined, panel: string): number | undefined {
  if (!summary) return undefined;
  const walk = (node: string, share: number): number | undefined => {
    const box = /^(row|column)\[(.*)\]$/.exec(node);
    if (!box) return node.split(', ').some((tab) => tab.trim() === panel) ? share : undefined;
    const sep = box[1] === 'row' ? '|' : '/';
    let depth = 0;
    let start = 0;
    const kids: string[] = [];
    const body = box[2];
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '[') depth++;
      else if (body[i] === ']') depth--;
      else if (depth === 0 && body[i] === sep) {
        kids.push(body.slice(start, i));
        start = i + 1;
      }
    }
    kids.push(body.slice(start));
    for (const kid of kids) {
      const m = /^\s*(.*?)\s+(\d+)%\s*$/.exec(kid);
      const found = m ? walk(m[1], (share * Number(m[2])) / 100) : walk(kid.trim(), share);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(summary.trim(), 1);
}

const noGlide = (d: Dump) => {
  if (d.panelMotion) throw new Error(`The panels glided with Reduce Motion on: ${JSON.stringify(d.panelMotion)}`);
};

Given('the panels have settled with {string} in them', async function (this: ThreadbearWorld, panel: string) {
  if ((await this.app.dump()).reduceMotion) {
    noGlide(await this.until(`the panels with ${panel} in them`, (d) => dockShare(d.dock, panel) !== undefined && d));
    return;
  }
  await this.until(`the panels settled with ${panel}`, (d) => settled(d) && d.panelMotion!.to[panel]);
});

Then('the panels glide, with {string} {word} than it was', async function (this: ThreadbearWorld, panel: string, way: string) {
  if ((await this.app.dump()).reduceMotion) {
    const was = dockShare(this.dockBefore, panel);
    assert.ok(was !== undefined, `${panel} wasn't in the panels before: ${this.dockBefore}`);
    const d = await this.until(`${panel} ${way} than ${Math.round(was * 100)}% of the window`, (d) => {
      const now = dockShare(d.dock, panel);
      return now !== undefined && (way === 'bigger' ? now > was : now < was) ? d : undefined;
    });
    noGlide(d);
    return;
  }
  const m = await this.until(`${panel} gliding ${way}`, (d) => {
    const m = d.panelMotion;
    if (!m?.from[panel] || !m.to[panel]) return undefined;
    const grew = area(m.to[panel]) > area(m.from[panel]);
    return grew === (way === 'bigger') ? m : undefined;
  });
  // It started where the panel was drawn: inside the window, not from nothing.
  assert.ok(m.from[panel].width > 100 && m.from[panel].height > 100, `${panel} started as ${JSON.stringify(m.from[panel])}`);
  await this.until('the glide to end', (d) => settled(d));
});

Then('{string} glides in where it wasn\'t', async function (this: ThreadbearWorld, panel: string) {
  const d = await this.app.dump();
  if (d.reduceMotion) {
    assert.equal(dockShare(this.dockBefore, panel), undefined, `${panel} was already there: ${this.dockBefore}`);
    assert.ok((dockShare(d.dock, panel) ?? 0) > 0.05, `${panel} isn't in the panels: ${d.dock}`);
    return noGlide(d);
  }
  const m = d.panelMotion!;
  assert.equal(m.from[panel], undefined, `${panel} was already there: ${JSON.stringify(m.from)}`);
  assert.ok(m.to[panel] && m.to[panel].width > 50 && m.to[panel].height > 50, `${panel} ended as ${JSON.stringify(m.to[panel])}`);
});

Then('{string} glides out', async function (this: ThreadbearWorld, panel: string) {
  const d = await this.app.dump();
  if (d.reduceMotion) {
    assert.ok(dockShare(this.dockBefore, panel) !== undefined, `${panel} wasn't there: ${this.dockBefore}`);
    assert.equal(dockShare(d.dock, panel), undefined, `${panel} is still there: ${d.dock}`);
    return noGlide(d);
  }
  const m = d.panelMotion!;
  assert.ok(m.from[panel], `${panel} wasn't there: ${JSON.stringify(m.from)}`);
  assert.equal(m.to[panel], undefined, `${panel} is still there: ${JSON.stringify(m.to)}`);
});
