import assert from 'node:assert/strict';
import { Given, Then, When } from '@cucumber/cucumber';
import type { Dump } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

// The quiet inbox for Mike's own threads (experiment quietInboxMine): an
// archived row it hid, and its menu's Should Have Shown Me.
Given('the quiet inbox archived {string} and {string} today', async function (this: ThreadbearWorld, first: string, second: string) {
  await this.until('the threads listed', (d) => Boolean(this.thread(d, first) && this.thread(d, second)));
  await this.app.do({ cmd: 'mock', method: 'quietArchive', params: { titles: [first, second] } });
  const archived = (d: Dump, title: string) => Boolean(d.sidebar.sections.find((x) => x.name === 'Archived')?.threads.some((t) => t.title === title));
  await this.until('the threads archived', (d) => archived(d, first) && archived(d, second));
});

Given('the runner will refuse the next Should have shown me', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'quietArchive', params: { refuse: true } });
});

// As the row's menu item does (`should-have-shown`, sidebar.rs).
When('I choose Should Have Shown Me for {string}', async function (this: ThreadbearWorld, title: string) {
  const t = await this.until(`a thread called "${title}"`, (d) => this.thread(d, title));
  await this.app.do({ cmd: 'should-have-shown', id: t.id });
});

Then('the runner was told I should have been shown {string}', async function (this: ThreadbearWorld, title: string) {
  let last: { threadId?: string } | null = null;
  for (let tries = 0; tries < 50 && !last; tries += 1) {
    const text = await this.app.do({ cmd: 'mock', method: 'lastWrongHide', params: {} });
    last = ((typeof text === 'string' ? JSON.parse(text) : text) as { params?: { threadId?: string } }).params ?? null;
    if (!last) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const d = await this.app.dump();
  assert.equal(last?.threadId, this.thread(d, title)?.id);
});

// A grey line of the runner's, on show rather than folded into the work.
Then('the transcript shows the line {string}', async function (this: ThreadbearWorld, words: string) {
  await this.until(`the line "${words}"`, (d) => d.transcript.rows.some((r) => r.kind === 'note' && r.text.startsWith(words) && !r.inGroup));
});
