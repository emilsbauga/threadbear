import assert from 'node:assert/strict';
import { When, Then } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';
import { pane } from '../support/pane.ts';
import { okValue } from '../support/driver.ts';

When('I save the composer to Backlog', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'save-backlog' });
  await this.until('the saved task open', d => !!d.selection && d.composer.draft !== 'new');
});

When('I move the open conversation to Backlog', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'backlog' });
});

When('I move the open conversation to Inbox', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'inbox' });
});

Then('{string} appears only in Backlog', async function (this: ThreadbearWorld, title: string) {
  await this.until(`${title} only in Backlog`, d => {
    const sections = d.sidebar.sections.filter(s => s.threads.some(t => t.title === title));
    return sections.length === 1 && sections[0].name === 'Backlog';
  });
});

Then('{string} appears only in Inbox', async function (this: ThreadbearWorld, title: string) {
  await this.until(`${title} only in Inbox`, d => {
    const sections = d.sidebar.sections.filter(s => s.threads.some(t => t.title === title));
    return sections.length === 1 && sections[0].name === 'Inbox';
  });
});

Then('the saved task has no messages or running agent', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  assert.equal(d.selection?.status, 'idle');
  assert.equal(d.transcript.rows.filter(r => r.kind === 'user' || r.kind === 'assistant').length, 0);
});

When('I reopen the saved Backlog task', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  const id = d.selection!.id;
  await this.app.do({ cmd: 'new' });
  await this.app.do({ cmd: 'open', id });
});

When('I ask to delete the saved Backlog task', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'delete-backlog' });
});

When('I cancel the deletion', async function (this: ThreadbearWorld) {
  await new Promise(done => setTimeout(done, 300));
  await this.app.do({ cmd: 'click', title: 'Cancel' });
  assert.equal(JSON.parse(okValue(await this.app.do({cmd:'dialog-state'}))).open, false);
});

When('I confirm the deletion', async function (this: ThreadbearWorld) {
  await new Promise(done => setTimeout(done, 300));
  await this.app.do({ cmd: 'click', title: 'Delete' });
});

Then('deletion shows progress', async function (this: ThreadbearWorld) {
  await this.until('Deleting chat progress', d => d.banner?.text.includes('Deleting chat'));
});

Then('the saved task {string} disappears', async function (this: ThreadbearWorld, title: string) {
  await this.until('the saved task removed', d => !this.thread(d, title));
});

async function capture(world: ThreadbearWorld, title: string, extra: Record<string, unknown>) {
  const id = crypto.randomUUID();
  await world.app.do({ cmd: 'mock', method: 'thread', params: { id, title } });
  await world.app.do({ cmd: 'mock', method: 'backlog', params: { threadId: id, text: title, ...extra } });
  await world.until('the captured task in Backlog', d => d.sidebar.sections.find(s => s.name === 'Backlog')?.threads.some(t => t.id === id));
}

When('a captured Backlog task named {string} arrives with a file', async function (this: ThreadbearWorld, title: string) {
  await capture(this, title, { file: true });
});

When('a captured Backlog task named {string} arrives with prepared context {string}', async function (this: ThreadbearWorld, title: string, context: string) {
  await capture(this, title, { context });
});

Then('the saved task offers the file {string}', async function (this: ThreadbearWorld, name: string) {
  await this.until('the imported file', d => (d.composer as {attachments?: string[]}).attachments?.includes(name));
  await this.app.do({ cmd: 'label-point', label: `Preview ${name}` });
});

When("I preview the saved task's file {string}", async function (this: ThreadbearWorld, name: string) {
  await this.app.do({ cmd: 'click', tip: `Preview ${name}` });
});

Then('the preview shows {string}', async function (this: ThreadbearWorld, text: string) {
  await this.until('the file preview words', d => JSON.stringify(pane(d)).includes(text));
});

When("I remove the saved task's file {string}", async function (this: ThreadbearWorld, name: string) {
  await this.app.do({ cmd: 'click', tip: `Remove ${name} from this draft` });
});

Then('the saved task has no imported files', async function (this: ThreadbearWorld) {
  await this.until('the imported file removed', d => (d.composer as {attachments?: string[]}).attachments?.length === 0);
});

Then('Highlights shows prepared task context {string}', async function (this: ThreadbearWorld, text: string) {
  await this.app.do({ cmd: 'label-point', label: 'Context for this task' });
  await this.until('the prepared task context', d => JSON.stringify(pane(d)).includes(text));
});

Then('the runner keeps the saved prompt exactly as {string}', async function (this: ThreadbearWorld, text: string) {
  const d = await this.app.dump();
  const state = JSON.parse(okValue(await this.app.do({cmd:'mock',method:'backlogState',params:{threadId:d.selection!.id}})));
  assert.equal(state.draft?.text, text.replace(/\\n/g, '\n'));
});

Then('the runner received the imported file {string}', async function (this: ThreadbearWorld, name: string) {
  const d = await this.app.dump();
  const state = JSON.parse(okValue(await this.app.do({cmd:'mock',method:'backlogState',params:{threadId:d.selection!.id}})));
  assert.equal(state.draft, null);
  assert.equal(state.lastSend?.attachments?.[0]?.name, name);
});
