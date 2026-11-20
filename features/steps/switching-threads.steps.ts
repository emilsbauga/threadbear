// Switching threads (switching-threads.feature): the spinner while one's read,
// and the threads kept loaded (the Swift app's `sessions`, the GPUI app's
// pane_cache.rs). The mock answers every read late for these (world.ts), so a
// thread that's read again on the way back can't pass for one that was kept.
import { Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { describe, type ThreadbearWorld } from '../support/world.ts';
import type { Dump } from '../support/driver.ts';

When('I start opening the thread {string}', async function (this: ThreadbearWorld, title: string) {
  const t = await this.until(`a thread called "${title}"`, (d) => this.thread(d, title));
  await this.app.do({ cmd: 'open', id: t.id });
});

Then('the transcript is a spinner with no rows', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  assert.equal(d.transcript.state, 'loading', `not being read:\n${describe(d)}`);
  assert.equal(d.transcript.rows.length, 0, `rows while it's read:\n${describe(d)}`);
  // Only the GPUI dump says; the Swift app's ProgressView is the whole of its loading state.
  assert.notEqual(d.transcript.spinner, false, 'no spinner');
});

// Within a second, where a read takes three.
Then('straight away the transcript shows my message {string}', async function (this: ThreadbearWorld, words: string) {
  await this.until(`my message "${words}" without the thread being read again`, (d) => d.transcript.state === 'loaded' && d.transcript.rows.some((r) => r.kind === 'user' && r.text.startsWith(words)), 1000);
});

// About 4.5 seconds of reply at 2 pieces a second, over a 3 second read: the
// read answers with its words so far (`inProgress`), the rest streams after.
When('a reply starts streaming in it, slowly enough to outlast the read', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'stream', params: { threadId: d.selection?.id, text: 'Here is a reply that takes its time, a few words a second.', hz: 2 } });
});

Then('the reply ends in its own turn', async function (this: ThreadbearWorld) {
  const ended = (d: Dump) => d.transcript.rows.some((r) => r.kind === 'footer' && r.turn === 'turn_stream') && d;
  const d = await this.until('the reply\'s turn ended', ended, 20_000);
  const reply = d.transcript.rows.find((r) => r.kind === 'assistant' && r.text.startsWith('Here is a reply'));
  assert.ok(reply, `no reply:\n${describe(d)}`);
  assert.equal(reply.turn, 'turn_stream', `the reply is outside its turn:\n${describe(d)}`);
});
