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

/**
 * Waits for the confetti `what`, or with Reduce Motion on (the stress run's
 * motion condition) checks none comes, as the app throws none then
 * (confetti.rs, throw_confetti_from).
 */
async function confetti(world: ThreadbearWorld, what: string, seen: (d: Dump) => unknown) {
  if ((await world.app.dump()).reduceMotion) {
    await new Promise((r) => setTimeout(r, 1000));
    const d = await world.app.dump();
    if (d.juice?.confetti) throw new Error(`Confetti was thrown with Reduce Motion on: ${JSON.stringify(d.juice.confetti)}`);
    return;
  }
  await world.until(what, seen);
}

Then('no confetti was thrown', async function (this: ThreadbearWorld) {
  const d = await this.app.dump();
  if (d.juice?.confetti) throw new Error(`Confetti was thrown: ${JSON.stringify(d.juice.confetti)}`);
});

Then('confetti popped from the empty inbox', async function (this: ThreadbearWorld) {
  await confetti(this, 'confetti from the empty inbox', (d) => d.juice?.confetti?.anchor === 'inbox-empty' && d.juice.confetti.popped);
});

Then('confetti was thrown from {string}\'s Usage row', async function (this: ThreadbearWorld, account: string) {
  await confetti(this, `confetti from ${account}'s token line`, (d) => d.juice?.confetti?.anchor === `token:${account}`);
});

// The small motions of 18 Nov: the answer's fill, the pasted picture's drop
// and the reply's fade (composer_card.rs, composer.rs, rows/markdown.rs).

When('I pick the first answer on the card', async function (this: ThreadbearWorld) {
  await this.until('a card of asks in the box', (d) => (d.composer.card ?? []).some((l) => /^\[ \] 1\./.test(l)));
  await this.app.do({ cmd: 'ask', action: 'pick:0:0' });
});

// With Reduce Motion on (the stress run's motion condition) none of the three
// moves: the answer is ticked without filling (composer_card.rs, pick_answer),
// the picture is in the box without dropping (composer.rs, add_pictures) and
// the reply's words are there at once (the kit's stream fade). So those check
// the end state is right and that nothing moved.

Then('the answer\'s button filled', async function (this: ThreadbearWorld) {
  if ((await this.app.dump()).reduceMotion) {
    const d = await this.until('the first answer ticked', (d) => ((d.composer.card ?? []).some((l) => /^\[x\] 1\./.test(l)) ? d : undefined));
    if (d.juice?.answerFilled) throw new Error(`An answer filled with Reduce Motion on: ${d.juice.answerFilled}`);
    return;
  }
  await this.until('the first answer filling', (d) => d.juice?.answerFilled === '0:0');
});

When('I paste a picture into the box', async function (this: ThreadbearWorld) {
  const sample = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../support/sample.png');
  await this.app.do({ cmd: 'paste-image', path: sample });
});

Then('the picture dropped into the box', async function (this: ThreadbearWorld) {
  if ((await this.app.dump()).reduceMotion) {
    const d = await this.until('a picture in the box', (d) => (d.composer.images === 1 ? d : undefined));
    if (d.juice?.picturesDropped) throw new Error(`${d.juice.picturesDropped} picture(s) dropped in with Reduce Motion on`);
    return;
  }
  await this.until('a picture dropping in', (d) => d.juice?.picturesDropped === 1 && d.composer.images === 1);
});

Then('a reply\'s new words fade in as they stream', async function (this: ThreadbearWorld) {
  if ((await this.app.dump()).reduceMotion) {
    // The reply to what was just sent: an agent's row after the last of mine,
    // quoting it, as the mock runner's answers do.
    const d = await this.until('the reply on the page', (d) => {
      const rows = d.transcript.rows;
      const mine = rows.map((r) => r.kind).lastIndexOf('user');
      const sent = rows[mine]?.text;
      return sent && rows.slice(mine + 1).some((r) => r.kind === 'assistant' && r.text?.includes(sent)) ? d : undefined;
    });
    if (d.juice?.replyFadeMs) throw new Error(`The reply fades over ${d.juice.replyFadeMs} ms with Reduce Motion on`);
    return;
  }
  await this.until('the reply fade on', (d) => (d.juice?.replyFadeMs ?? 0) > 0);
});

Then('confetti popped from the milestone note', async function (this: ThreadbearWorld) {
  await confetti(this, 'confetti from the milestone', (d) => d.juice?.confetti?.anchor === 'milestone' && d.juice.confetti.popped);
});

// Thrown, not popped: the login's row may be down the panel, out of sight.
Then('confetti was thrown for {string} signing back in', async function (this: ThreadbearWorld, account: string) {
  await confetti(this, `confetti for ${account} signed back in`, (d) => d.juice?.confetti?.anchor === `signed-in:${account}`);
});
