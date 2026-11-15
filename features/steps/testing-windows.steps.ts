import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

When('I relaunch the testing copy', async function (this: ThreadbearWorld) {
  await this.app.relaunch();
});

Then('Hide all testing windows is {word}', async function (this: ThreadbearWorld, state: string) {
  await this.until('the test window preference', d => (d as unknown as {settingsWindow?: {hideTestingWindows?: boolean}}).settingsWindow?.hideTestingWindows === (state === 'on'));
});

Then("all of this test copy's visible windows are transparent and ignore the mouse", async function (this: ThreadbearWorld) {
  const dump = await this.app.dump();
  assert.equal((dump as unknown as {testingWindowsHidden: boolean}).testingWindowsHidden, true);
});
