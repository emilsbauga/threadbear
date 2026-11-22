import assert from 'node:assert/strict';
import { Then, When } from '@cucumber/cucumber';
import type { Dump } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

// The Feed (the feed experiment, GPUI only). The dump's `homePage` while it
// shows has `cards`, one a thread: its title, state ("needsYou", "running",
// "quiet", "done"), the top line, the fold's words, whether it's open and its
// messages then, whether an answer or reply is on its way, and whether it has
// a reply box.
type Card = { id: string; title: string; state: string; top: string; fold: string; open: boolean; messages: string[]; sending: boolean; reply: boolean };
const cards = (d: Dump): Card[] => ((d as unknown as { homePage?: { title?: string; cards?: Card[] } | null }).homePage?.cards ?? []);
const card = (d: Dump, title: string) => cards(d).find((c) => c.title === title);

When('I open the Feed', async function (this: ThreadbearWorld) {
  await this.until('the demo threads', (d) => d.sidebar.sections.some((s) => s.threads.length > 0));
  await this.app.do({ cmd: 'feed', open: true });
  await this.until('the Feed open', (d) => cards(d).length > 0);
});

Then("the Feed's card {string} needs me", async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" needing me`, (d) => card(d, title)?.state === 'needsYou');
});

Then("the Feed's card {string} is running", async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" running`, (d) => card(d, title)?.state === 'running');
});

Then("the Feed's card {string} comes before {string}", async function (this: ThreadbearWorld, first: string, second: string) {
  const d = await this.app.dump();
  const titles = cards(d).map((c) => c.title);
  assert.ok(titles.includes(first) && titles.includes(second), `cards: ${titles.join(', ')}`);
  assert.ok(titles.indexOf(first) < titles.indexOf(second), `cards: ${titles.join(', ')}`);
});

Then("the Feed's card {string} starts with {string}", async function (this: ThreadbearWorld, title: string, line: string) {
  await this.until(`"${title}" starting "${line}"`, (d) => card(d, title)?.top === line);
});

Then('the sidebar still shows the Inbox', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  assert.ok(d.sidebar.sections.some((s) => s.name === 'Inbox'), `sections: ${d.sidebar.sections.map((s) => s.name).join(', ')}`);
});

When('I answer {string} on the Feed\'s card {string}', async function (this: ThreadbearWorld, answer: string, title: string) {
  const c = await this.until(`a card for "${title}"`, (d) => card(d, title));
  const choices: Record<string, string> = { 'Drop the idea': '1:1', 'Keep holding till 4 Dec': '1:2', 'Close the pane': '1:1', 'Do nothing': '1:2' };
  assert.ok(choices[answer], `no answer ${answer} known to this step`);
  await this.app.do({ cmd: 'feed', thread: c.id, pick: choices[answer] });
});

Then("the Feed's card {string} is sending", async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" sending`, (d) => card(d, title)?.sending === true, 2_000);
});

// The thread's transcript has the words as a message of Mike's.
Then('the thread {string} got {string}', async function (this: ThreadbearWorld, title: string, words: string) {
  const c = await this.until(`a thread called "${title}"`, (d) => this.thread(d, title));
  await this.app.do({ cmd: 'open', id: c.id });
  await this.until(`"${words}" in "${title}"`, (d) => d.transcript.threadId === c.id && d.transcript.rows.some((r) => JSON.stringify(r).includes(words)));
});

When("I open the fold on the Feed's card {string}", async function (this: ThreadbearWorld, title: string) {
  const c = await this.until(`a card for "${title}"`, (d) => card(d, title));
  await this.app.do({ cmd: 'feed', thread: c.id, fold: true });
  await this.until(`"${title}"'s messages`, (d) => (card(d, title)?.messages.length ?? 0) > 0);
});

Then("the Feed's card {string} says {string}", async function (this: ThreadbearWorld, title: string, words: string) {
  await this.until(`"${title}" saying "${words}"`, (d) => card(d, title)?.fold === words);
});

Then("the Feed's card {string} shows the message {string}", async function (this: ThreadbearWorld, title: string, words: string) {
  await this.until(`"${words}" in "${title}"'s fold`, (d) => card(d, title)?.messages.includes(words));
});

Then("the Feed's card {string} has a reply box", async function (this: ThreadbearWorld, title: string) {
  await this.until(`a reply box on "${title}"`, (d) => card(d, title)?.reply === true);
});

When("I mark the Feed's card {string} Done", async function (this: ThreadbearWorld, title: string) {
  const c = await this.until(`a card for "${title}"`, (d) => card(d, title));
  await this.app.do({ cmd: 'feed', thread: c.id, done: true });
});

Then("the Feed's card {string} is one line", async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" one line`, (d) => card(d, title)?.state === 'done');
});

Then('the thread {string} is archived', async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" archived`, (d) => d.sidebar.sections.find((s) => s.name === 'Archived')?.threads.some((t) => t.title === title) || !d.sidebar.sections.find((s) => s.name === 'Inbox')?.threads.some((t) => t.title === title));
});

When("I undo the Feed's card {string}", async function (this: ThreadbearWorld, title: string) {
  const c = await this.until(`a card for "${title}"`, (d) => card(d, title));
  await this.app.do({ cmd: 'feed', thread: c.id, undo: true });
});

Then("the Feed's card {string} is a card again", async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" a card again`, (d) => card(d, title) && card(d, title)?.state !== 'done');
});

When("I reply {string} on the Feed's card {string}", async function (this: ThreadbearWorld, words: string, title: string) {
  const c = await this.until(`a card for "${title}"`, (d) => card(d, title));
  await this.app.do({ cmd: 'feed', thread: c.id, reply: words });
});

// A real click on the first button of that name in view: the card with its
// fold open is scrolled to the top first, so its messages' links are.
When('I click {string} on the Feed', async function (this: ThreadbearWorld, label: string) {
  const d = await this.app.dump();
  const open = cards(d).find((c) => c.open);
  if (open) await this.app.do({ cmd: 'feed', thread: open.id, show: true });
  await this.app.do({ cmd: 'click', title: label });
});
