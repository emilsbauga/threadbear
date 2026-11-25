// Searching Agent Archive from the sidebar (features/archive-search.feature).
import { Then, When } from '@cucumber/cucumber';
import type { ThreadbearWorld } from '../support/world.ts';

type Hit = { threadId: string; title: string; line: string; snippet: string; marked: string[]; threadbear: string | null };
type Search = { on: boolean; shown: boolean; searching: boolean; error: string | null; hits: Hit[] | null };
type Message = { role: string; text: string; found: boolean; marked: string[] };
type Page = { threadId: string; title: string; line: string | null; loading: boolean; error: string | null; url: string | null; messages: Message[] };

const search = (d: unknown): Search | undefined => (d as { sidebar?: { archive?: Search } }).sidebar?.archive;
const page = (d: unknown): Page | null | undefined => (d as { archivePage?: Page | null }).archivePage;
const hit = (d: unknown, title: string): Hit | undefined => search(d)?.hits?.find((h) => h.title === title);

Then('the archive lists {string} under {string}', async function (this: ThreadbearWorld, title: string, line: string) {
  await this.until(`"${title}" in the archive's rows, under "${line}"`, (d) => Boolean(hit(d, title)?.line.startsWith(line)), 10_000);
});

Then('the archive marks {string} in {string}', async function (this: ThreadbearWorld, word: string, title: string) {
  await this.until(`"${word}" marked in "${title}"`, (d) => Boolean(hit(d, title)?.marked.includes(word)));
});

Then("the archive doesn't list {string}", async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" not in the archive's rows`, (d) => Boolean(search(d)?.hits) && !hit(d, title), 10_000);
});

When('I open {string} from the archive', async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" in the archive's rows`, (d) => Boolean(hit(d, title)), 10_000);
  await this.app.do({ cmd: 'click', title });
});

Then('the archived session {string} is open read-only', async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" read-only in the thread's place`, (d) => {
    const p = page(d);
    return p?.title === title && !p.loading && p.messages.length > 0 && !d.selection?.id;
  }, 10_000);
});

Then('its marked message says {string}', async function (this: ThreadbearWorld, words: string) {
  await this.until(`the marked message saying "${words}"`, (d) => Boolean(page(d)?.messages.find((m) => m.found)?.text.includes(words)));
});

Then('its messages mark {string}', async function (this: ThreadbearWorld, word: string) {
  await this.until(`"${word}" marked in the session`, (d) => Boolean(page(d)?.messages.some((m) => m.marked.includes(word))));
});

Then('the archived session has {string} and {string}', async function (this: ThreadbearWorld, a: string, b: string) {
  await this.until('the read-only bar', (d) => Boolean(page(d)?.url));
  const labels = JSON.parse(await this.app.do({ cmd: 'labels' })) as { label: string; disabled?: boolean }[];
  for (const label of [a, b]) {
    if (!labels.some((l) => l.label === label && !l.disabled)) throw new Error(`no "${label}" to press; on screen: ${labels.map((l) => l.label).join(', ')}`);
  }
});

When('I click {string} under the archived session', async function (this: ThreadbearWorld, label: string) {
  await this.until('the session read', (d) => page(d)?.loading === false);
  await this.app.do({ cmd: 'click', title: label });
});

// By what's open, not the sidebar's rows: the search has the thread out of them.
Then("the thread {string} opens in place of a read-only session", async function (this: ThreadbearWorld, title: string) {
  await this.until(`"${title}" open`, (d) => d.selection?.title === title && !page(d), 10_000);
});

Then("the new thread's box says {string}", async function (this: ThreadbearWorld, text: string) {
  await this.until(`the new thread's box saying "${text}"`, (d) => !d.selection?.id && d.composer.text === text);
});

Then("the archive says it's searching", async function (this: ThreadbearWorld) {
  await this.until('"Searching the archive"', (d) => search(d)?.searching === true);
});

Then('the archive says {string}', async function (this: ThreadbearWorld, error: string) {
  await this.until(`the archive saying "${error}"`, (d) => search(d)?.error === error, 10_000);
});

Then('the sidebar shows nothing from the archive', async function (this: ThreadbearWorld) {
  await this.until('no archive rows', (d) => !search(d)?.shown);
});
