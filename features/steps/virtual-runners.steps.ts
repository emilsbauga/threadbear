import { Given, Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import type { ThreadbearWorld } from '../support/world.ts';

// Virtual runners (@virtual-runners turns on the mock's "Cloud (Fly)" and its
// box threads, world.ts).

Then('the Runs on menu lists {string} after This Mac', async function (this: ThreadbearWorld, lines: string) {
  const menu = JSON.parse(await this.app.do({ cmd: 'composer-menu', menu: 'runner' })) as string[];
  const machines = menu.slice(2, menu.indexOf('---', 2));
  assert.deepEqual(machines, lines.split(', '));
});

When('I pick {string} in Runs on', async function (this: ThreadbearWorld, name: string) {
  await this.app.do({ cmd: 'composer-menu', menu: 'runner', click: name });
});

Then('the Runs on menu has {string} ticked', async function (this: ThreadbearWorld, name: string) {
  const menu = JSON.parse(await this.app.do({ cmd: 'composer-menu', menu: 'runner' })) as string[];
  assert.ok(menu.includes(`[x] ${name}`), `menu: ${menu.join(' | ')}`);
});

Then('the row {string} says {string}', async function (this: ThreadbearWorld, title: string, words: string) {
  await this.until(`"${title}" saying ${words}`, (d) => this.thread(d, title)?.trailing === words);
});

Then('the row {string} has the needs-you dot', async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" with the dot`, (d) => this.thread(d, title)?.mark === 'dot');
});

type Card = { text: string; buttons: string[]; busy: string | null } | null;
const card = (d: unknown): Card => (d as { tokenCard?: Card }).tokenCard ?? null;

Then('the token card says {string} with {string}', async function (this: ThreadbearWorld, text: string, buttons: string) {
  await this.until(`the token card saying ${text}`, (d) => card(d)?.text === text && card(d)?.buttons.join(', ') === buttons);
});

Given('the runner holds cloud token requests', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'holdTokens', params: {} });
});

When('the runner lets the cloud token request through', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'releaseTokens', params: {} });
});

When('I press {string} on the token card', async function (this: ThreadbearWorld, button: string) {
  await this.app.do({ cmd: 'token-card', press: button });
});

Then('the token card is busy with {string}', async function (this: ThreadbearWorld, words: string) {
  await this.until(`the token card busy`, (d) => card(d)?.busy === words);
});

Then("there's no token card", async function (this: ThreadbearWorld) {
  await this.until('no token card', (d) => card(d) === null);
});
