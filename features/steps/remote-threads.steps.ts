import { Given, Then, When } from '@cucumber/cucumber';
import assert from 'node:assert/strict';
import { sleep } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

// The mock's threads on "mac-mini" (@remote-threads turns them on, world.ts).

When('its runner lets the thread go to mac-mini', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  assert.ok(d.selection?.id);
  await this.app.do({ cmd: 'mock', method: 'moveAway', params: { threadId: d.selection.id } });
});

When('its runner lets the thread go to mac-mini while the old Mac still lists it', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  assert.ok(d.selection?.id);
  await this.app.do({ cmd: 'mock', method: 'moveAway', params: { threadId: d.selection.id, staleIndex: true } });
});

Then('the row {string} is on the runner {string}', async function (this: ThreadbearWorld, title: string, runner: string) {
  await this.until(`"${title}" on ${runner}`, (d) => this.thread(d, title)?.runner === runner);
});

Then('the row {string} has the machine tile', async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" with the machine tile`, (d) => this.thread(d, title)?.tile === 'runner');
});

Then('the row {string} isn\'t on another runner', async function (this: ThreadbearWorld, title: string) {
  // Waits, as a move back lands after the runner says so (a slow runner
  // took longer than one look on 20 Nov's bug hunt).
  await this.until(`"${title}" on this Mac`, (d) => {
    const t = this.thread(d, title);
    return t && !t.runner;
  });
});

Then('the composer is on the runner {string}', async function (this: ThreadbearWorld, runner: string) {
  await this.until(`the composer on ${runner}`, (d) => d.composer.runner === runner);
});

When('I make {string} the default runner', async function (this: ThreadbearWorld, runner: string) {
  await this.app.do({ cmd: 'composer-menu', menu: 'runner', setDefault: runner });
});

Given('a move would leave nothing behind', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'moveLeftBehind', params: { lines: [] } });
});

Given('a move would clone its repo from {string} to {string}', async function (this: ThreadbearWorld, from: string, to: string) {
  await this.app.do({ cmd: 'mock', method: 'moveLeftBehind', params: { lines: [] } });
  await this.app.do({ cmd: 'mock', method: 'moveClone', params: { from, to } });
});

Then('the move sheet says it clones from {string} to {string}', async function (this: ThreadbearWorld, from: string, to: string) {
  await this.until(`the clone from ${from} to ${to}`, (d) => d.moveSheet?.clone === to && d.moveSheet?.cloneFrom === from);
});

// Daybreak 142: the move names the look it was shown, so it does that or nothing.
Then('the move was started with the preview it showed', async function (this: ThreadbearWorld) {
  // The row says it's going at once; the call reaches the runner after.
  let said = '';
  for (let tries = 0; tries < 50 && !said; tries += 1) {
    const text = await this.app.do({ cmd: 'mock', method: 'lastMove', params: {} });
    const r = (typeof text === 'string' ? JSON.parse(text) : text) as { params?: { previewId?: unknown } | null };
    said = String(r?.params?.previewId ?? '');
    if (!said) await sleep(100);
  }
  assert.match(said, /^mock-preview-/);
});

Then('the move was started with the preview it showed, for the folder {string}', async function (this: ThreadbearWorld, folder: string) {
  type Move = { previewId?: unknown; cwd?: unknown };
  let params: Move | null = null;
  for (let tries = 0; tries < 50 && !params; tries += 1) {
    const text = await this.app.do({ cmd: 'mock', method: 'lastMove', params: {} });
    params = ((typeof text === 'string' ? JSON.parse(text) : text) as { params?: Move }).params ?? null;
    if (!params) await sleep(100);
  }
  assert.match(String(params?.previewId ?? ''), /^mock-preview-/);
  assert.equal(params?.cwd, folder);
});

Then('no move has started', async function (this: ThreadbearWorld) {
  await sleep(500);
  const text = await this.app.do({ cmd: 'mock', method: 'lastMove', params: {} });
  const r = (typeof text === 'string' ? JSON.parse(text) : text) as { params?: unknown };
  assert.equal(r?.params ?? null, null);
});

When("I type {string} as the move sheet's folder", async function (this: ThreadbearWorld, folder: string) {
  await this.until('the sheet looked', (d) => d.moveSheet?.canMove === true);
  await this.app.do({ cmd: 'move', folder });
});

// `move` asks like Move to ▸ that runner does, once the runner list has come.
When('I ask to move the thread {string} to {string}', async function (this: ThreadbearWorld, title: string, runner: string) {
  const t = await this.until(`a thread called "${title}"`, (d) => this.thread(d, title));
  let lastError: unknown;
  for (let tries = 0; tries < 50; tries += 1) {
    try {
      await this.app.do({ cmd: 'move', id: t.id, runner });
      return;
    } catch (e) {
      lastError = e;
      await sleep(150);
    }
  }
  throw lastError;
});

Then('the move sheet says {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`the sheet "${title}"`, (d) => d.moveSheet?.title === title);
});

Then('the move sheet warns {string}', async function (this: ThreadbearWorld, line: string) {
  await this.until(`the warning "${line}"`, (d) => d.moveSheet?.leftBehind?.includes(line));
});

Then('the move sheet offers the folder {string}', async function (this: ThreadbearWorld, folder: string) {
  await this.until(`the folder ${folder}`, (d) => d.moveSheet?.folder === folder);
});

Then('the move sheet\'s login is {string}', async function (this: ThreadbearWorld, login: string) {
  await this.until(`the login ${login}`, (d) => d.moveSheet?.login === login);
});

When('I press Move in the move sheet for {string}', async function (this: ThreadbearWorld, runner: string) {
  await this.until('the sheet ready to move', (d) => d.moveSheet?.canMove === true);
  // Past the sheet's entrance animation, so the click lands on the button
  // where it's about to settle (GPUI's dialog slides in).
  await sleep(1200);
  await this.app.do({ cmd: 'click', tip: `Move it to ${runner} once this turn ends` });
});

Then('the move sheet is closed', async function (this: ThreadbearWorld) {
  await this.until('the sheet gone', (d) => !d.moveSheet);
});

Then('the move sheet stayed closed', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  assert.ok(!d.moveSheet, 'the sheet came up');
});

// What the viewer says it shows, until it's drawn: "showing 1 of 1 <path>",
// with `after` (" (couldn't show)") when it won't be.
async function viewerShows(world: ThreadbearWorld, number: number, total: number, file: string, after = ''): Promise<void> {
  let said = '';
  for (let tries = 0; tries < 60; tries += 1) {
    said = await world.app.do({ cmd: 'viewer' }).catch((e) => String(e));
    if (new RegExp(`showing ${number} of ${total} .*${file.replace('.', '\\.')}${after.replace(/[()]/g, '\\$&')}$`).test(said)) return;
    await sleep(150);
  }
  assert.fail(`the viewer says "${said}", not picture ${number} of ${total} ${file}${after}`);
}

async function pressChip(world: ThreadbearWorld, number: number): Promise<void> {
  const row = await world.until('my message', (d) => d.transcript.rows.find((r) => r.kind === 'user'));
  const said = await world.app.do({ cmd: 'peek', row: row.id, words: `Picture ${number}`, press: true });
  assert.ok(said.includes('quicklook'), `the chip opened nothing: ${said}`);
}

Then('pressing the picture chip in my message says it couldn\'t show picture {int} of {int} {string}', async function (this: ThreadbearWorld, number: number, total: number, file: string) {
  await pressChip(this, number);
  await viewerShows(this, number, total, file, " (couldn't show)");
});

// A real press on the chip among the words (`peek` with `press`).
Then('pressing the picture chip in my message opens picture {int} of {int} {string}', async function (this: ThreadbearWorld, number: number, total: number, file: string) {
  await pressChip(this, number);
  await viewerShows(this, number, total, file);
});

// A real click on the tile over the words, where it's drawn (`tile-point`),
// through the window's hit testing.
When('I click picture {int} of my message', async function (this: ThreadbearWorld, number: number) {
  const point = await this.app.do({ cmd: 'tile-point', count: 1, index: number - 1 });
  const [, x, y] = point.trim().split(/\s+/);
  assert.ok(x && y, point);
  await this.app.do({ cmd: 'click-at', x: Number(x), y: Number(y) });
});

Given("mac-mini's pasted pictures were never put up", async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'remotePictures', params: { up: false } });
});

// Both apps' `tiles`: what each picture of the message says when it isn't
// drawn ("Couldn't get it from mac-mini"), "picture" when it is.

Then('the pictures of my message say {string}', async function (this: ThreadbearWorld, words: string) {
  await this.until('a message with pictures', (d) => d.transcript.rows.some((r) => r.kind === 'user'));
  let said = '';
  for (let tries = 0; tries < 60; tries += 1) {
    said = await this.app.do({ cmd: 'tiles', count: 1 }).catch((e) => String(e));
    // The Swift app's answer starts with the command's name.
    if (said.replace(/^tiles /, '') === `ok ${words}`) return;
    await sleep(150);
  }
  assert.fail(`the pictures say "${said}", not "${words}"`);
});

// The row's Cancel Move (`move` with `cancel`).
When('I cancel the move of {string}', async function (this: ThreadbearWorld, title: string) {
  const t = await this.until(`a thread called "${title}"`, (d) => this.thread(d, title));
  await this.app.do({ cmd: 'move', id: t.id, cancel: true });
});

// What the box says in place of its words while its thread moves, and so
// it and its card take nothing (the dump's composer.moving).
type WithMoving = { moving?: string | null };
Then('the box is locked, saying {string}', async function (this: ThreadbearWorld, line: string) {
  await this.until(`the box locked with "${line}"`, (d) => (d.composer as WithMoving).moving === line);
});

Then("the box isn't locked", async function (this: ThreadbearWorld) {
  await this.until('the box unlocked', (d) => !(d.composer as WithMoving).moving);
});

When('its runner lets the thread go to {string}', async function (this: ThreadbearWorld, to: string) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'moveAway', params: { threadId: d.selection?.id, to } });
});

When('the destination lists the moved thread', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'moveArrive', params: { threadId: d.selection?.id } });
  // Allow the destination read/subscription to finish before it emits events.
  await this.app.do({ cmd: 'waitFor', loaded: true });
  await sleep(500);
});

When('a reply arrives on the destination', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'stream', params: { threadId: d.selection?.id, text: 'The destination is serving this thread', hz: 60 } });
});

When('its old runner lists the thread again', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'moveSourceBack', params: { threadId: d.selection?.id } });
  await sleep(500);
});

When('the index restarts while its move to this Mac is waiting', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'moveIndexRestart', params: { threadId: d.selection?.id } });
});

When('that waiting move is cancelled', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'moveCancelAfterRestart', params: { threadId: d.selection?.id } });
});

When('its move to this Mac is claimed before the local thread arrives', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'moveIndexRestart', params: { threadId: d.selection?.id } });
  // Keep the source row until claimed, unlike the moveAway example.
  await this.app.do({ cmd: 'mock', method: 'moveArrive', params: { threadId: d.selection?.id, claimedFirst: true } });
  await sleep(500);
});

// Runs on › Folder › Other…, the path typed in its dialog and Return pressed.
When('I type {string} as the folder on that machine', async function (this: ThreadbearWorld, folder: string) {
  await this.app.do({ cmd: 'composer-menu', menu: 'runner', click: 'Other…', folder });
});

// The machine chip's menu under an open thread's box, as lines joined by ", "
// (sidebar.rs, machine_menu_rows).
Then("the box's machine menu reads {string}", async function (this: ThreadbearWorld, lines: string) {
  let last: unknown;
  for (let tries = 0; tries < 50; tries += 1) {
    // The result line is the menu as a JSON list, maybe after the command's name.
    const line = await this.app.do({ cmd: 'composer-menu', menu: 'machine' });
    last = JSON.parse(line.slice(line.indexOf('[')));
    if (Array.isArray(last) && last.join(', ') === lines) return;
    await sleep(150);
  }
  assert.fail(`the machine menu read ${JSON.stringify(last)}, not "${lines}"`);
});

Given('the runner is slow to say where a thread would go', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'holdMovePreview', params: {} });
});

When("the thread's row comes in again while it looks", async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  await this.app.do({ cmd: 'mock', method: 'relist', params: { threadId: d.selection?.id } });
  // Long enough for the row to have landed in the app.
  await sleep(500);
});

Then('nothing asked the runner to cancel a move', async function (this: ThreadbearWorld) {
  // Long enough for a wrongly sent cancel to have arrived.
  await sleep(800);
  const text = await this.app.do({ cmd: 'mock', method: 'moveCancels', params: {} });
  const r = (typeof text === 'string' ? JSON.parse(text) : text) as { cancels?: unknown[] };
  assert.deepEqual(r?.cancels ?? [], []);
});

When('the runner says where it would go', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mock', method: 'releaseMovePreview', params: {} });
});

When("I pick {string} from the box's machine menu", async function (this: ThreadbearWorld, title: string) {
  await this.app.do({ cmd: 'composer-menu', menu: 'machine', click: title });
});
