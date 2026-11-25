// The # thread picker over the message box (thread-picker.feature): the
// GPUI app's `dump` has it as `threadPicker` while it's open.
import { Then, When } from '@cucumber/cucumber';
import type { Dump } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

const titles = (d: Dump) => d.threadPicker?.threads.map((t) => t.title) ?? [];

Then('the thread picker lists {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`the thread picker listing "${title}"`, (d) => titles(d).includes(title));
});

Then('the thread picker doesn\'t list {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`the thread picker open without "${title}"`, (d) => !!d.threadPicker && !titles(d).includes(title));
});

Then('the thread picker\'s threads are {string}', async function (this: ThreadbearWorld, list: string) {
  await this.until(`the thread picker listing ${list}`, (d) => titles(d).join(' | ') === list);
});

Then('the thread picker is closed', async function (this: ThreadbearWorld) {
  await this.until('the thread picker closed', (d) => !d.threadPicker);
});

// Each row's tooltip names it (thread_palette.rs).
When('I click {string} in the thread picker', async function (this: ThreadbearWorld, title: string) {
  await this.until(`the thread picker listing "${title}"`, (d) => titles(d).includes(title));
  await this.app.do({ cmd: 'click', tip: `Put a link to "${title}" in the message (Return)` });
});
