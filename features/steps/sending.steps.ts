import { Given, Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { ThreadbearWorld } from '../support/world.ts';

// A tiny real picture, for the steps that need a file (the runner reads it).
const samplePicture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'support', 'sample.png');

When('I type {string} in the composer', async function (this: ThreadbearWorld, text: string) {
  await this.app.do({ cmd: 'type', text });
});

When('I leave the composer untouched for {int} seconds', async function (seconds: number) {
  assert(seconds > 0 && seconds <= 30, 'The idle-composer check must be bounded.');
  await delay(seconds * 1000);
});

When('I press Return', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'return' });
});

When('I press Shift-Return', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'return', shift: true });
});

When('I press Option-Return', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'return', option: true });
});

When('I send {string}', async function (this: ThreadbearWorld, text: string) {
  await this.app.do({ cmd: 'send', text });
});

// `menu-key` is the Mac app's Stop item and the GPUI app's Stop binding.
When('I stop the turn', async function (this: ThreadbearWorld) {
  await this.until('the thread running', (d) => d.selection?.status === 'running');
  await this.app.do({ cmd: 'menu-key', key: '.', modifiers: ['cmd'] });
});

Then('the composer is empty', async function (this: ThreadbearWorld) {
  await this.until('an empty composer', (d) => d.composer.text === '');
});

Then('the composer says {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until(`the composer saying "${text}"`, (d) => d.composer.text === text);
});

When('I paste {string} into the composer', async function (this: ThreadbearWorld, words: string) {
  await this.app.do({ cmd: 'paste', text: words.replace(/\\n/g, '\n') });
});

// Several paragraphs that wrap far past the box's ten lines.
When('I paste a long dictation into the composer', async function (this: ThreadbearWorld) {
  const paragraph = 'So what I am thinking is we build a really good tool for this, and it should feel quick. '.repeat(6);
  await this.app.do({ cmd: 'paste', text: [paragraph, paragraph, paragraph].join('\n\n') });
});

Then('the composer\'s cursor is in view', async function (this: ThreadbearWorld) {
  await this.until('the caret scrolled into the box', (d) => d.composer.text.length > 1000 && (d.composer as { caretInView?: boolean }).caretInView === true);
});

Then('the composer says the lines {string}', async function (this: ThreadbearWorld, lines: string) {
  const wanted = lines.replace(/\\n/g, '\n');
  await this.until(`the composer saying ${JSON.stringify(wanted)}`, (d) => d.composer.text === wanted);
});

Then('the composer holds a new line after {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until(`"${text}" and a new line`, (d) => d.composer.text === `${text}\n`);
});

Then('the reply streams in and the thread goes back to idle', async function (this: ThreadbearWorld) {
  await this.until('the mock\'s reply', (d) => d.transcript.rows.some((r) => r.kind === 'assistant' && r.text.startsWith('You said:')), 30_000);
  await this.until('the thread idle again', (d) => d.selection?.status === 'idle', 30_000);
});

Then('the thread isn\'t running any more', async function (this: ThreadbearWorld) {
  await this.until('the thread stopped', (d) => d.selection?.status !== 'running', 30_000);
});

When('I paste the picture into the composer', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'paste-image', path: samplePicture });
});

When('I paste the picture into the composer {int} times', async function (this: ThreadbearWorld, times: number) {
  for (let n = 0; n < times; n += 1) await this.app.do({ cmd: 'paste-image', path: samplePicture });
});

// A point in the thread's transcript on both apps' windows.
When('I drop the picture on the transcript', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'drop', path: samplePicture, x: 650, y: 300 });
});

// Any file but a picture goes in as its path in backticks.
const sampleFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'support', 'driver.ts');

When('I drop a file on the first letter of the composer\'s words', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'drop', path: sampleFile, boxOffset: 0 });
});

When('I drop a file at byte {int} of the composer\'s words', async function (this: ThreadbearWorld, offset: number) {
  await this.app.do({ cmd: 'drop', path: sampleFile, boxOffset: offset });
});

Then('the composer has the dropped file between {string} and {string}', async function (this: ThreadbearWorld, before: string, after: string) {
  const prefix = before.replace(/\\n/g, '\n');
  const suffix = after.replace(/\\n/g, '\n');
  const wanted = `${prefix}${/\s$/.test(prefix) ? '' : ' '}\`${sampleFile}\` ${suffix}`;
  await this.until(`the path between ${JSON.stringify(prefix)} and ${JSON.stringify(suffix)}`, (d) => d.composer.text === wanted);
});

Then('the composer starts with the dropped file\'s path, then {string}', async function (this: ThreadbearWorld, rest: string) {
  await this.until(`the path, then "${rest}"`, (d) => d.composer.text.trim() === `\`${sampleFile}\` ${rest}`);
});

// The message still says the file's path for the agent; the bubble draws it as the file's chip.
Then('the transcript shows my message with the dropped file\'s path and the chip {string}', async function (this: ThreadbearWorld, chip: string) {
  await this.until(`my message with the path and the chip "${chip}"`, (d) => d.transcript.rows.some((r) => r.kind === 'user' && r.text.startsWith(`\`${sampleFile}\``) && (r.chips ?? []).includes(chip)));
});

Then('the composer holds {int} picture(s)', async function (this: ThreadbearWorld, count: number) {
  await this.until(`${count} picture(s) in the composer`, (d) => d.composer.images === count);
});

Then('hovering chip {int} shows its picture', async function (this: ThreadbearWorld, number: number) {
  const result = await this.app.do({ cmd: 'composer-peek', number });
  assert.match(result, /ok/);
});

// Longer than the half second after the last keystroke that a draft is
// written in (drafts.rs, DraftStore).
When('I wait a moment', async function (this: ThreadbearWorld) {
  await new Promise((done) => setTimeout(done, 1200));
});

Given('the runner holds each message {int} seconds before its turn starts', async function (this: ThreadbearWorld, seconds: number) {
  await this.app.do({ cmd: 'mock', method: 'slow', params: { queueMs: seconds * 1000 } });
});

Then("the transcript's last row reads {string}", async function (this: ThreadbearWorld, text: string) {
  await this.until(`the last row reading "${text}"`, (d) => d.transcript.rows.at(-1)?.text === text);
});

// The whole box copied or cut, and pasted back, as ⌘A then ⌘C or ⌘X, and ⌘V
// (both apps' `composer-clip`).
When('I cut everything in the composer', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'composer-clip', action: 'cut' });
});

When('I copy everything in the composer', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'composer-clip', action: 'copy' });
});

When(/^I paste back what I (?:cut|copied)$/, async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'composer-clip', action: 'paste' });
});

When('I clear the composer', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'type', text: '', replace: true });
  await this.until('an empty composer', (d) => d.composer.text === '');
});

// What "Copy thread id" gives: the bare id.
When('I paste the id of the thread {string} into the composer', async function (this: ThreadbearWorld, title: string) {
  const t = await this.until(`a thread called "${title}"`, (d) => this.thread(d, title));
  await this.app.do({ cmd: 'paste', text: t.id });
});

// The chips in the box, in order (`composer-chips` on both apps).
async function composerChips(world: ThreadbearWorld): Promise<string[]> {
  const out = await world.app.do({ cmd: 'composer-chips' });
  return JSON.parse(out.slice(out.indexOf('['))) as string[];
}

Then("the composer's chips are {string}", async function (this: ThreadbearWorld, list: string) {
  const wanted = list.split(' | ');
  let chips: string[] = [];
  for (let tries = 0; tries < 40; tries += 1) {
    chips = await composerChips(this);
    if (JSON.stringify(chips) === JSON.stringify(wanted)) return;
    await new Promise((done) => setTimeout(done, 150));
  }
  assert.deepEqual(chips, wanted);
});

Then('the composer has no chips', async function (this: ThreadbearWorld) {
  assert.deepEqual(await composerChips(this), []);
});

// The draft holds the link the chip stands for, which is what's sent.
Then('the composer holds the link to the thread {string}', async function (this: ThreadbearWorld, title: string) {
  const t = await this.until(`a thread called "${title}"`, (d) => this.thread(d, title));
  await this.until(`the link to "${title}" in the composer`, (d) => d.composer.text === `[${title}](thread:${t.id})`);
});


// Where a labelled control's middle is, from `label-point`.
async function pointOf(world: ThreadbearWorld, label: string): Promise<{ x: number; y: number }> {
  const reply = await world.app.do({ cmd: 'label-point', label });
  const [, x, y] = reply.trim().split(/\s+/);
  assert.ok(x && y, reply);
  return { x: Number(x), y: Number(y) };
}

// Well above the box, over the page or the transcript, which takes the
// keyboard from the box.
When('I click away from the message box', async function (this: ThreadbearWorld) {
  const box = await pointOf(this, 'Message');
  await this.app.do({ cmd: 'click-at', x: box.x, y: box.y - 150 });
});

// Off the words: in the box's padding under Send, where only the box itself
// is (ADEMark's click at 860,400 on 19 Nov). Not beside Send: in a narrow
// window the chips give way until only the row's gaps are left between them,
// and a thread's machine chip did that on GitHub's Mac (19 Nov). The padding
// is 14 points whatever the width; Send is 28 tall, so 21 below its middle.
When('I click the message box under its controls', async function (this: ThreadbearWorld) {
  const send = await pointOf(this, 'Send');
  await this.app.do({ cmd: 'click-at', x: send.x, y: send.y + 21 });
});
