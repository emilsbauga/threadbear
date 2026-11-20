// The setup cards (features/hello.feature): the `hello` command says the card
// on show as "ok 2/6 agents", and `dump` has `hello` (desktop/gpui/src/hello.rs).
import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

type Hello = { card: string; title: string; index: number; count: number; agents: { name: string; detail: string; ready: boolean }[] } | null;

const hello = (d: unknown): Hello => (d as { hello?: Hello }).hello ?? null;

When('I go on in the setup cards', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'hello', do: 'next' });
});

When('I go back in the setup cards', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'hello', do: 'back' });
});

When('I put the setup cards away', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'menu-key', key: 'escape' });
});

When('I skip the setup card', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'hello', do: 'skip' });
});

When('I skip to the last setup card', async function (this: ThreadbearWorld) {
  for (let i = 0; i < 8; i++) {
    const d = await this.app.dump();
    const h = hello(d);
    if (h && h.index === h.count) return;
    await this.app.do({ cmd: 'hello', do: 'skip' });
  }
});

Then('the setup cards show {string}', async function (this: ThreadbearWorld, title: string) {
  await this.until(`the setup card "${title}"`, (d) => hello(d)?.title === title);
});

Then('no setup card shows', async function (this: ThreadbearWorld) {
  await new Promise((r) => setTimeout(r, 500));
  await this.until('no setup card', (d) => hello(d) === null);
});

Then('the agents card lists {string} as signed in', async function (this: ThreadbearWorld, who: string) {
  await this.until(`"${who}" signed in on the agents card`, (d) => (hello(d)?.agents ?? []).some((a) => a.detail.startsWith(who) && a.ready));
});

Then('the new-thread page is open', async function (this: ThreadbearWorld) {
  await this.until('the new-thread page', (d) => !d.selection && d.composer.draft === 'new');
});
