import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

When('I look for {string} in the thread', async function (this: ThreadbearWorld, words: string) {
  await this.until('the thread loaded', (d) => d.transcript.state === 'loaded' && d.transcript.rows.length > 0);
  await this.app.do({ cmd: 'threadFind', find: words });
});

Then('the thread\'s find bar says {string}', async function (this: ThreadbearWorld, line: string) {
  await this.until(`the thread's find bar to say "${line}"`, (d) => d.transcript.threadFind?.line === line);
});

Then('the picked match is in the step {string}, opened', async function (this: ThreadbearWorld, title: string) {
  await this.until(`the match in "${title}", opened`, (d) => {
    const picked = d.transcript.threadFind?.row;
    return d.transcript.rows.some((r) => r.id === picked && r.text === title && r.expanded);
  });
});

When('I find the next match in the thread', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'threadFind', next: true });
});

When('I find the match before in the thread', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'threadFind', previous: true });
});

When('I close the thread\'s find bar', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'threadFind', done: true });
});

Then('the thread has no find bar', async function (this: ThreadbearWorld) {
  await this.until('no find bar over the thread', (d) => !d.transcript.threadFind);
});

Then('the step {string} is still open', async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" open`, (d) => d.transcript.rows.some((r) => r.text === title && r.expanded));
});
