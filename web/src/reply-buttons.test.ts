import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buttonLook, type MessageButton } from './reply-buttons.ts';
import { idle, step, type CommandState } from './command.ts';

const none: CommandState<undefined> = idle();
const sending = step(none, { kind: 'send', payload: undefined, at: 0 });
const waiting = step(sending, { kind: 'queued', attempt: 1, id: 'c1', at: 0 });
const at = (report: { state: 'pending' | 'taken' | 'done' | 'failed'; note?: string; threadId?: string }) => step(waiting, { kind: 'report', id: 'c1', report, at: 0 });

const start: MessageButton = { id: 'abcd1234', title: 'Fill in the form', kind: 'start', target: 'pebble' };
const send: MessageButton = { id: 'efgh5678', title: 'Ask it', kind: 'send', target: 'Meetup' };

test('a button says where it goes until it is pressed', () => {
  assert.deepEqual(buttonLook(start, none), { kind: 'ready', tip: 'Starts a thread in pebble' });
  assert.deepEqual(buttonLook(send, none), { kind: 'ready', tip: 'Sends a message to "Meetup"' });
});

test('a press shows as pressing until its command is done, then pressed with the thread to open', () => {
  assert.equal(buttonLook(start, sending).kind, 'pressing');
  assert.equal(buttonLook(start, at({ state: 'pending' })).kind, 'pressing');
  assert.equal(buttonLook(start, at({ state: 'taken' })).kind, 'pressing');
  assert.deepEqual(buttonLook(start, at({ state: 'done', threadId: 't2' })), { kind: 'pressed', threadId: 't2', tip: 'Pressed.' });
});

test('the row saying pressed wins, wherever it was pressed', () => {
  assert.equal(buttonLook({ ...start, pressedThreadId: 't3' }, none).kind, 'pressed');
  assert.equal(buttonLook({ ...start, pressedThreadId: 't3' }, at({ state: 'failed', note: 'x' })).kind, 'pressed');
});

test('a failed press shows its error and can be pressed again', () => {
  const look = buttonLook(start, at({ state: 'failed', note: 'Folder not found: /x' }));
  assert.equal(look.kind, 'failed');
  assert.equal(look.kind === 'failed' && look.error, 'Folder not found: /x');
  assert.equal(buttonLook({ ...start, failed: 'gone' }, none).kind, 'failed');
});

test('a press nothing has heard about in a while stops spinning but stays locked', () => {
  assert.equal(buttonLook(start, step(waiting, { kind: 'tick', at: 60_000 })).kind, 'slow');
});

// The cases the desktop app and the phones run too (shared/cases/reply-buttons.json).
test('a button looks as the shared cases say', () => {
  type Case = {
    name: string;
    input: { button: { kind: 'start' | 'send'; target?: string; pressedThreadId?: string; failed?: string }; press: { state: 'none' | 'sending' | 'pending' | 'taken' | 'done' | 'failed'; threadId?: string; note?: string } };
    expect: { look: string; threadId?: string; error?: string };
    differs?: Record<string, string>;
  };
  const file = new URL('../../shared/cases/reply-buttons.json', import.meta.url);
  const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: Case[] };
  const run = cases.filter((c) => !c.differs?.web);
  assert.ok(run.length > 5);
  for (const c of run) {
    const { state, threadId, note } = c.input.press;
    const press = state === 'none' ? none : state === 'sending' ? sending : at({ state, ...(threadId ? { threadId } : {}), ...(note ? { note } : {}) });
    const look = buttonLook({ id: 'abcd1234', title: 'Go', ...c.input.button }, press);
    const got = look.kind === 'pressed' ? { look: 'pressed', threadId: look.threadId } : look.kind === 'failed' ? { look: 'failed', error: look.error } : { look: look.kind };
    assert.deepEqual(got, c.expect, c.name);
  }
});
