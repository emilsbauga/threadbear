// A design review as a page beside the thread (review-page.feature, the
// reviewPage experiment). The GPUI app's `review-page` command opens the
// open thread's review as its card does, does what a click on one of the
// page's own links would with `ask` ("pick/1", "open/1/0": the option and
// shot by index, as the page writes them), and says where the page has got
// to: the review, its ticks, and the page's HTML as the app made it.
import { Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { okValue, sleep } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';
import type { Dump } from '../support/driver.ts';
import { pane } from '../support/pane.ts';

type PageState = { review: string; status: string; picked: string[]; saving: boolean; error?: string | null; made: boolean; page: string; wide?: number | null };

async function page(world: ThreadbearWorld, more: Record<string, unknown> = {}): Promise<PageState> {
  return JSON.parse(okValue(await world.app.do({ cmd: 'review-page', ...more }, 30))) as PageState;
}

/** Waits until the page says what `pass` wants, reading it as it is. */
async function untilPage(world: ThreadbearWorld, what: string, pass: (s: PageState) => boolean): Promise<PageState> {
  const deadline = Date.now() + 15_000;
  let last: PageState | undefined;
  for (;;) {
    last = await page(world, { open: false }).catch(() => undefined);
    if (last && pass(last)) return last;
    if (Date.now() > deadline) throw new Error(`Never saw: ${what}\n\nThe page said: ${JSON.stringify({ ...last, page: last?.page.slice(0, 400) })}`);
    await sleep(150);
  }
}

const ticks = (d: Dump): string[] => (d.composer as { reviewPicks?: string[] | null }).reviewPicks ?? [];
/** An option's section of the page, by its name. */
const section = (html: string, title: string): string | undefined => html.split('<section ').find((part) => part.includes(`<span>${title}</span>`));

When("I open the review's page", async function (this: ThreadbearWorld) {
  await page(this);
});

Then("the pane shows the review's page", async function (this: ThreadbearWorld) {
  await this.until("the review's page in the pane", (d) => (pane(d) as { previewKind?: string } | undefined)?.previewKind === 'review');
  // Drawn once, its page is made.
  await untilPage(this, 'its page made', (s) => s.made && s.page.includes('<main>'));
});

Then("the review's page has {string} as the agent's pick", async function (this: ThreadbearWorld, title: string) {
  const s = await untilPage(this, 'its page made', (s) => s.made);
  assert.ok(section(s.page, title)?.includes('<span class="rec">Recommended</span>'), `${title} is marked as recommended`);
  assert.equal(s.page.split('class="rec"').length - 1, 1, 'only one option is');
});

Then("the review's page has a picture and a tick for {string}", async function (this: ThreadbearWorld, title: string) {
  const part = section((await untilPage(this, 'its page made', (s) => s.made)).page, title);
  assert.ok(part?.includes('<img src="'), 'its picture');
  assert.ok(part?.includes('class="pick" href="_threadbear/pick/'), 'its tick');
});

Then("the review's page has a picture and no tick for {string}", async function (this: ThreadbearWorld, title: string) {
  const part = section((await untilPage(this, 'its page made', (s) => s.made)).page, title);
  assert.ok(part?.includes('<img src="'), 'its picture');
  assert.ok(!part?.includes('class="pick"'), 'no tick');
});

Then('the pane is as wide as a wide design wants', async function (this: ThreadbearWorld) {
  await untilPage(this, 'the pane widened for it', (s) => (s.wide ?? 0) >= 900);
});

// Options count from 1 here, as a person would; the page's links from 0.
When("I click the tick of option {int} on the review's page", async function (this: ThreadbearWorld, option: number) {
  await page(this, { ask: `pick/${option - 1}` });
});

When("I click the picture of option {int} on the review's page", async function (this: ThreadbearWorld, option: number) {
  await page(this, { ask: `open/${option - 1}/0` });
});

Then("the review's page has {string} ticked", async function (this: ThreadbearWorld, ids: string) {
  const want = ids ? ids.split(', ') : [];
  // Saved, and on the page itself: each ticked option's section is marked.
  // The page is made again when the pane next draws, a moment after the
  // save is back, so both are waited for (checked at once, it failed on
  // GitHub's Mac, 20 Nov).
  const marked = (html: string) => html.split('class="opt picked').length - 1;
  await untilPage(this, `"${ids}" ticked, saved and marked on the page`, (s) => !s.saving && JSON.stringify(s.picked) === JSON.stringify(want) && marked(s.page) === want.length);
});

Then('the message box shows the ticks {string}', async function (this: ThreadbearWorld, titles: string) {
  await this.until(`the ticks "${titles}" over the message box`, (d) => ticks(d).join(', ') === titles);
});

Then('the message box shows no ticks', async function (this: ThreadbearWorld) {
  await this.until('no ticks over the message box', (d) => ticks(d).length === 0);
});

When('I press Return in the empty message box', async function (this: ThreadbearWorld) {
  await this.until('an empty composer', (d) => d.composer.text === '');
  await this.app.do({ cmd: 'return' });
});

Then("the review's page has closed", async function (this: ThreadbearWorld) {
  await this.until("no review's page in the pane", (d) => (pane(d) as { previewKind?: string } | undefined)?.previewKind !== 'review');
});

Then('the review window is a closer look, with no column down the right', async function (this: ThreadbearWorld) {
  const state = JSON.parse(okValue(await this.app.do({ cmd: 'review', open: false }, 30))) as { closerLook?: boolean };
  assert.equal(state.closerLook, true);
});

// reviews.save held a few seconds by the mock, as a busy runner's is.
When('the runner is slow to save', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'slow', params: { saveMs: 3000 } });
});

When("I click the tick of option {int} on the review's page without waiting", async function (this: ThreadbearWorld, option: number) {
  await page(this, { ask: `pick/${option - 1}`, wait: false });
});

Then('the message box shows the ticks {string} before the runner has them', async function (this: ThreadbearWorld, titles: string) {
  await this.until(`the ticks "${titles}" over the message box`, (d) => ticks(d).join(', ') === titles);
  assert.equal((await page(this, { open: false })).saving, true, 'the tick was still on its way');
});
