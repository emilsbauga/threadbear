import { Then, When } from '@cucumber/cucumber';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Dump } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

// The GPUI app's dump says which row a click last slid off and which card
// last arrived in the box while its thread was on screen (`juice`,
// row_swipe.rs and composer_card.rs), and the last confetti (confetti.rs).

Then('the row {string} slid off', async function (this: ThreadbearWorld, title: string) {
  const t = await this.until(`a thread called "${title}"`, (d) => this.thread(d, title));
  await this.until(`"${title}" sliding off`, (d) => d.juice?.slidOff === t.id);
});

Then('the card that came settled in', async function (this: ThreadbearWorld) {
  await this.until('a card arriving in the box', (d) => typeof d.juice?.cardArrived === 'number', 20_000);
});

const inboxRows = (d: Dump) => d.sidebar.sections.find((s) => s.name === 'Inbox')?.threads ?? [];

/** Archives the Inbox's threads as their rows' Archive does, one at a time, all but `keep` (or all of them). */
async function archiveInbox(world: ThreadbearWorld, keep?: string) {
  for (;;) {
    const rows = inboxRows(await world.app.dump()).filter((t) => t.title !== keep);
    const t = rows[0];
    if (!t) return;
    await world.app.do({ cmd: 'archive', id: t.id });
    await world.until(`"${t.title}" gone from the Inbox`, (d) => !inboxRows(d).some((x) => x.id === t.id));
  }
}

When('I archive every thread in the Inbox but {string}', async function (this: ThreadbearWorld, keep: string) {
  await archiveInbox(this, keep);
});

When('I archive every thread in the Inbox', async function (this: ThreadbearWorld) {
  await archiveInbox(this);
});

Then('no confetti was thrown', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  if (d.juice?.confetti) throw new Error(`Confetti was thrown: ${JSON.stringify(d.juice.confetti)}`);
});

Then('confetti popped from the empty inbox', async function (this: ThreadbearWorld) {
  await this.until('confetti from the empty inbox', (d) => d.juice?.confetti?.anchor === 'inbox-empty' && d.juice.confetti.popped);
});

Then('confetti was thrown from {string}\'s Usage row', async function (this: ThreadbearWorld, account: string) {
  await this.until(`confetti from ${account}'s token line`, (d) => d.juice?.confetti?.anchor === `token:${account}`);
});

// The small motions of 18 Nov: the answer's fill, the pasted picture's drop
// and the reply's fade (composer_card.rs, composer.rs, rows/markdown.rs).

When('I pick the first answer on the card', async function (this: ThreadbearWorld) {
  await this.until('a card of asks in the box', (d) => (d.composer.card ?? []).some((l) => /^\[ \] 1\./.test(l)));
  await this.app.do({ cmd: 'ask', action: 'pick:0:0' });
});

Then('the answer\'s button filled', async function (this: ThreadbearWorld) {
  await this.until('the first answer filling', (d) => d.juice?.answerFilled === '0:0');
});

When('I paste a picture into the box', async function (this: ThreadbearWorld) {
  const sample = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../support/sample.png');
  await this.app.do({ cmd: 'paste-image', path: sample });
});

Then('the picture dropped into the box', async function (this: ThreadbearWorld) {
  await this.until('a picture dropping in', (d) => d.juice?.picturesDropped === 1 && d.composer.images === 1);
});

Then('a reply\'s new words fade in as they stream', async function (this: ThreadbearWorld) {
  await this.until('the reply fade on', (d) => (d.juice?.replyFadeMs ?? 0) > 0);
});

Then('confetti popped from the milestone note', async function (this: ThreadbearWorld) {
  await this.until('confetti from the milestone', (d) => d.juice?.confetti?.anchor === 'milestone' && d.juice.confetti.popped);
});

// Thrown, not popped: the login's row may be down the panel, out of sight.
Then('confetti was thrown for {string} signing back in', async function (this: ThreadbearWorld, account: string) {
  await this.until(`confetti for ${account} signed back in`, (d) => d.juice?.confetti?.anchor === `signed-in:${account}`);
});
