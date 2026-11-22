// The Recipes view and a recipe's page (features/recipes.feature).
import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

type Row = { id: string; name: string; state: string; tag: string; stat: string };
type Recipes = { loaded: boolean; sidebar: Row[]; cards: Row[]; busy: string[]; open: string | null; page: { id: string; runs: number; example: boolean } | null };
const recipes = (d: unknown): Recipes | undefined => (d as { sidebar?: { recipes?: Recipes } }).sidebar?.recipes;

When('I open the Recipes view', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mode', mode: 'recipes' });
  await this.until('the recipes loaded', (d) => Boolean(recipes(d)?.loaded));
});

When('I switch off {string}', async function (this: ThreadbearWorld, name: string) {
  await this.app.do({ cmd: 'click', title: 'On. Turn it off to pause its schedules' });
  await this.until(`"${name}" switched`, (d) => recipes(d)?.sidebar.find((r) => r.name === name)?.state === 'off');
});

When('I add {string}', async function (this: ThreadbearWorld, name: string) {
  // By its tip, which scrolls a card below the gallery's fold into sight.
  await this.app.do({ cmd: 'click', tip: `Add ${name}: an agent sets it up with you in a new thread` });
});

When('I open the recipe {string}', async function (this: ThreadbearWorld, name: string) {
  await this.app.do({ cmd: 'click', title: `Open ${name}'s page` });
});

Then('the Recipes sidebar lists {string} as {string}', async function (this: ThreadbearWorld, name: string, state: string) {
  await this.until(`"${name}" listed as ${state}`, (d) => recipes(d)?.sidebar.find((r) => r.name === name)?.state === state);
});

Then("the Recipes sidebar doesn't list {string}", async function (this: ThreadbearWorld, name: string) {
  await this.until(`"${name}" not listed`, (d) => Boolean(recipes(d)?.loaded) && !recipes(d)?.sidebar.some((r) => r.name === name));
});

Then('the gallery has a card {string} tagged {string}', async function (this: ThreadbearWorld, name: string, tag: string) {
  await this.until(`a card "${name}" tagged ${tag}`, (d) => recipes(d)?.cards.find((r) => r.name === name)?.tag === tag);
});

Then('the gallery has a card {string} saying {string}', async function (this: ThreadbearWorld, name: string, words: string) {
  await this.until(`a card "${name}" saying "${words}"`, (d) => Boolean(recipes(d)?.cards.find((r) => r.name === name)?.stat.includes(words)));
});

Then('nothing in the Recipes view is waiting on the runner', async function (this: ThreadbearWorld) {
  await this.until('no recipe busy', (d) => recipes(d)?.busy.length === 0);
});

Then('the thread {string} is open', async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" open`, (d) => {
    const t = this.thread(d, title);
    return Boolean(t) && d.selection?.id === t?.id;
  });
});

Then('the recipe page for {string} has an example and its runs', async function (this: ThreadbearWorld, id: string) {
  await this.until(`the page for ${id}`, (d) => {
    const page = recipes(d)?.page;
    return recipes(d)?.open === id && page?.id === id && page.example && page.runs > 0;
  });
});
