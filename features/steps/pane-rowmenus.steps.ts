import { Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { okValue, sleep } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

When('I right-click the visible pane row {string}', async function (this: ThreadbearWorld, label: string) {
  let point: number[] | undefined;
  for (let n = 0; n < 30; n += 1) {
    try { point = okValue(await this.app.do({cmd: 'label-point', label})).split(/\s+/).map(Number); break; }
    catch { await sleep(100); }
  }
  assert.ok(point?.length === 2 && point.every(Number.isFinite), `visible ${label}`);
  await this.app.do({cmd: 'click-at', x: point[0], y: point[1], right: true});
});
Then('exactly one context menu offers {string}', async function (this: ThreadbearWorld, expected: string) {
  let menus: string[][] = [];
  for (let n = 0; n < 20; n += 1) {
    menus = JSON.parse(okValue(await this.app.do({cmd: 'context-menus'})));
    if (menus.length) break;
    await sleep(100);
  }
  assert.equal(menus.length, 1, `one row menu, got ${JSON.stringify(menus)}`);
  for (const item of expected.split(' | ')) assert.ok(menus[0].includes(item), `${item} in ${JSON.stringify(menus)}`);
});

// Any right-click menu drawn in the window (the sidebar's, a pane row's,
// a reply link's), as `context-menus` finds them.
async function openMenus(world: ThreadbearWorld, want: (n: number) => boolean): Promise<string[][]> {
  let menus: string[][] = [];
  for (let n = 0; n < 20; n += 1) {
    menus = JSON.parse(okValue(await world.app.do({cmd: 'context-menus'})));
    if (want(menus.length)) break;
    await sleep(100);
  }
  return menus;
}
Then('a right-click menu is open', async function (this: ThreadbearWorld) {
  const menus = await openMenus(this, (n) => n > 0);
  assert.ok(menus.length > 0, 'no right-click menu open');
});
Then('no right-click menu is open', async function (this: ThreadbearWorld) {
  const menus = await openMenus(this, (n) => n === 0);
  assert.equal(menus.length, 0, `still open: ${JSON.stringify(menus)}`);
});
