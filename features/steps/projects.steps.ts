import { Then, When } from '@cucumber/cucumber';
import type { Dump } from '../support/driver.ts';
import type { ThreadbearWorld } from '../support/world.ts';

// The Projects page and a project's page (`projectCards` in the dump: a line
// a card).
type WithProjects = Dump & { projectCards?: string[] | null };

When('I show the Projects page', async function (this: ThreadbearWorld) {
  await this.app.do({ cmd: 'mode', mode: 'projects' });
});

When('I open the project {string}', async function (this: ThreadbearWorld, title: string) {
  await this.app.do({ cmd: 'project', title });
});

Then('the project card {string} says {string}', async function (this: ThreadbearWorld, title: string, words: string) {
  await this.until(`the "${title}" card saying "${words}"`, (d) =>
    ((d as WithProjects).projectCards ?? []).some((line) => line.startsWith(`${title}: `) && line.includes(words)));
});

// Parts (docs/protocol/projects.md, Projects, "Parts"): the open page's `project`
// in the dump names its parent and parts by title.
type WithPage = Dump & { project?: { title: string; parent?: string | null; parts?: string[] } | null };

Then('the project page says it\'s a part of {string}', async function (this: ThreadbearWorld, parent: string) {
  await this.until(`the page a part of "${parent}"`, (d) => (d as WithPage).project?.parent === parent);
});

Then('the project page says it\'s a part of nothing', async function (this: ThreadbearWorld) {
  await this.until('the page a project of its own', (d) => Boolean((d as WithPage).project) && !(d as WithPage).project?.parent);
});

Then('the project page lists the part {string}', async function (this: ThreadbearWorld, part: string) {
  await this.until(`the part "${part}" listed`, (d) => ((d as WithPage).project?.parts ?? []).includes(part));
});

When('I make the project {string} its own project', async function (this: ThreadbearWorld, title: string) {
  await this.app.do({ cmd: 'projectParent', title, parent: '' });
});
