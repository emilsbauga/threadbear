// Recipes (src/recipes.ts, docs/protocol/projects.md "Recipes"): techniques worth
// keeping, each a RECIPE.md an agent sets up for the user, switched on and
// off from the app's Recipes view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_RECIPES_DIR, Recipes, parseRecipe, readRecipes, recipeMethods, type RecipesDeps } from '../../src/recipes.ts';
import { EXPERIMENTS } from '../../src/experiments.ts';
import type { Schedule, ThreadSummary } from '../../src/protocol.ts';
import { tmpDir } from '../helpers/fakes.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T10:00:00Z');

function recipeText(fields: Record<string, string>, sections: Record<string, string> = { About: 'Why it helps.', 'Each run': 'Do the thing.' }): string {
  const head = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
  const body = Object.entries(sections).map(([k, v]) => `## ${k}\n\n${v}\n`).join('\n');
  return `---\n${head}\n---\n\n${body}`;
}

function writeRecipe(dir: string, id: string, fields: Record<string, string>, sections?: Record<string, string>): string {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  const file = path.join(dir, id, 'RECIPE.md');
  fs.writeFileSync(file, recipeText(fields, sections));
  return file;
}

function schedule(id: string, over: Partial<Schedule> = {}): Schedule {
  return { id, title: id, text: 'x', whenText: 'Every day at 6:30', cron: '30 6 * * *', paused: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', runs: 0, ...over };
}

function thread(id: string, over: Partial<ThreadSummary> = {}): ThreadSummary {
  return { id, title: id, createdAt: new Date(NOW - DAY).toISOString(), lastSeq: 5, lastSeenSeq: 5, preview: 'All quiet', needs: 'nothing', ...over } as ThreadSummary;
}

type World = {
  deps: RecipesDeps;
  recipes: Recipes;
  home: string;
  folder: string;
  builtin: string;
  schedules: Schedule[];
  threads: ThreadSummary[];
  started: { text: string; title: string; cwd: string }[];
  experiments: Record<string, boolean>;
  published: number;
  on: boolean;
};

function world(): World {
  const home = tmpDir();
  const folder = path.join(tmpDir(), 'recipes');
  const builtin = tmpDir();
  const w = { home, folder, builtin, schedules: [], threads: [], started: [], experiments: {}, published: 0, on: true } as unknown as World;
  w.deps = {
    home,
    folder: () => folder,
    builtinDir: builtin,
    now: () => NOW,
    on: () => w.on,
    publish: () => {
      w.published++;
    },
    experimentOn: (id) => w.experiments[id] === true,
    setExperiment: (id, on) => {
      w.experiments[id] = on;
    },
    schedules: {
      list: () => w.schedules,
      update: async (p) => {
        const s = w.schedules.find((x) => x.id === p.scheduleId);
        if (!s) throw new Error('no such schedule');
        if (p.paused !== undefined) s.paused = p.paused;
        return s;
      },
      delete: async (id) => {
        w.schedules = w.schedules.filter((x) => x.id !== id);
        return {};
      },
    },
    threads: () => w.threads,
    start: (p) => {
      w.started.push(p);
      return thread(`t${w.started.length}`, { title: p.title });
    },
  };
  w.recipes = new Recipes(w.deps);
  return w;
}

test('recipes: a file gives its fields and sections, and needs a name, an icon and a description', () => {
  const r = parseRecipe(recipeText({ name: 'Daily brief', icon: '☀️', description: 'A short note.', by: 'Mike', when: 'Every day', color: '#e0884a' }, { About: 'Why.', Example: '**Today**', 'Setting it up': 'Ask.', 'Each run': 'Do it.' }), 'daily-brief/RECIPE.md');
  assert.equal(r.name, 'Daily brief');
  assert.equal(r.icon, '☀️');
  assert.equal(r.by, 'Mike');
  assert.equal(r.color, '#e0884a');
  assert.equal(r.about, 'Why.');
  assert.equal(r.example, '**Today**');
  assert.equal(r.setup, 'Ask.');
  assert.equal(r.eachRun, 'Do it.');
  assert.throws(() => parseRecipe(recipeText({ icon: 'x', description: 'y' }), 'f'), /name/);
  assert.throws(() => parseRecipe('no fields here', 'f'), /---/);
  assert.equal(parseRecipe(recipeText({ name: 'n', icon: 'i', description: 'd', color: 'red' }), 'f').color, undefined, 'only #rrggbb');
});

test('recipes: every one that comes with Threadbear reads, can be set up, and keeps to plain words', () => {
  const all = readRecipes(BUILTIN_RECIPES_DIR, undefined);
  assert.ok(all.length >= 3);
  const experiments = new Set(EXPERIMENTS.map((x) => x.id));
  for (const r of all) {
    assert.ok(/^[a-z0-9-]+$/.test(r.id), `${r.id}: a folder name in kebab-case`);
    assert.ok(r.about.length > 40, `${r.id}: says what it's for`);
    assert.ok(r.example, `${r.id}: shows a made-up run`);
    assert.ok(r.setup, `${r.id}: tells the agent how to set it up`);
    if (r.experiment) assert.ok(experiments.has(r.experiment), `${r.id}: ${r.experiment} is an experiment`);
    else assert.ok(r.eachRun, `${r.id}: says what each run does`);
    const text = fs.readFileSync(r.file, 'utf8');
    assert.ok(!text.includes('—'), `${r.id}: no em dashes`);
    assert.ok(!/@(gmail|convex|cannstudios)\.|\/Users\/|m5-mike|tinker-desk|bruce/i.test(text), `${r.id}: nothing of Mike's own`);
  }
});

test("recipes: the user's own are listed with the built-in ones, and one with a built-in's id takes its place", () => {
  const w = world();
  writeRecipe(w.builtin, 'daily-brief', { name: 'Daily brief', icon: '☀️', description: 'Built in.' });
  writeRecipe(w.builtin, 'repo-watch', { name: 'Repo watch', icon: '🔎', description: 'Built in.' });
  writeRecipe(w.folder, 'daily-brief', { name: 'My brief', icon: '☀️', description: 'Mine.' });
  writeRecipe(w.folder, 'kite-watch', { name: 'Kite watch', icon: '🪁', description: 'Mine too.' });
  fs.mkdirSync(path.join(w.folder, 'just-files'), { recursive: true });
  fs.writeFileSync(path.join(w.folder, 'just-files', 'TASK.md'), 'a set-up recipe works here');
  fs.writeFileSync(path.join(w.folder, 'kite-watch', 'header.png'), 'png');
  const list = w.recipes.list();
  assert.deepEqual(list.map((r) => [r.id, r.name, r.source]), [
    ['kite-watch', 'Kite watch', 'yours'],
    ['daily-brief', 'My brief', 'yours'],
    ['repo-watch', 'Repo watch', 'builtin'],
  ]);
  assert.equal(list.find((r) => r.id === 'kite-watch')?.header, path.join(w.folder, 'kite-watch', 'header.png'));
  assert.ok(list.every((r) => r.state === 'add'));
});

test('recipes: a broken file is left out, not the whole list', () => {
  const w = world();
  writeRecipe(w.builtin, 'good', { name: 'Good', icon: '✅', description: 'Fine.' });
  fs.mkdirSync(path.join(w.folder, 'bad'), { recursive: true });
  fs.writeFileSync(path.join(w.folder, 'bad', 'RECIPE.md'), 'no fields');
  assert.deepEqual(w.recipes.list().map((r) => r.id), ['good']);
});

test('recipes: adding one starts a thread in its working folder, and the schedule that thread makes becomes its own', async () => {
  const w = world();
  const file = writeRecipe(w.builtin, 'daily-brief', { name: 'Daily brief', icon: '☀️', description: 'A short note.' });
  const { threadId, thread: made } = w.recipes.add('daily-brief');
  assert.equal(threadId, 't1');
  assert.equal(made.id, 't1', 'the thread comes back too, so the app can open it at once');
  const start = w.started[0];
  assert.equal(start.cwd, path.join(w.folder, 'daily-brief'));
  assert.ok(fs.statSync(start.cwd).isDirectory(), 'the folder is made');
  assert.ok(start.text.includes(file), 'the agent is pointed at the file');
  assert.match(start.title, /Daily brief/);
  assert.equal(w.recipes.get('daily-brief').state, 'settingUp');
  assert.equal(w.recipes.get('daily-brief').setupThreadId, 't1');
  assert.ok(w.published > 0);

  w.schedules.push(schedule('s-other', { createdBy: 't9' }), schedule('s-brief', { createdBy: 't1', title: 'Daily brief' }));
  const r = w.recipes.get('daily-brief');
  assert.equal(r.state, 'on');
  assert.deepEqual(r.schedules.map((s) => s.id), ['s-brief']);
  assert.throws(() => w.recipes.add('daily-brief'), /already/);
  assert.throws(() => w.recipes.add('nope'), /no recipe/);
});

test('recipes: off pauses its schedules and on resumes them; one still setting up just keeps the choice', async () => {
  const w = world();
  writeRecipe(w.builtin, 'daily-brief', { name: 'Daily brief', icon: '☀️', description: 'A short note.' });
  w.recipes.add('daily-brief');
  await w.recipes.setOn('daily-brief', false);
  assert.equal(w.recipes.get('daily-brief').state, 'settingUp');
  w.schedules.push(schedule('s1', { createdBy: 't1' }));
  assert.equal(w.recipes.get('daily-brief').state, 'off', 'it was switched off while setting up');
  assert.equal(w.schedules[0].paused, false);
  await w.recipes.setOn('daily-brief', false);
  assert.equal(w.schedules[0].paused, true);
  const r = await w.recipes.setOn('daily-brief', true);
  assert.equal(r.state, 'on');
  assert.equal(w.schedules[0].paused, false);
});

test("recipes: one that switches an experiment is on while it is, and its switch is the experiment's", async () => {
  const w = world();
  writeRecipe(w.builtin, 'email-watcher', { name: 'Email watcher', icon: '✉️', description: 'Wakes threads.', experiment: 'mailWatch' }, { About: 'Why.' });
  assert.equal(w.recipes.get('email-watcher').state, 'add');
  w.experiments.mailWatch = true;
  assert.equal(w.recipes.get('email-watcher').state, 'on', 'already on from runner.json');
  await w.recipes.setOn('email-watcher', false);
  assert.equal(w.experiments.mailWatch, false);
  assert.equal(w.recipes.get('email-watcher').state, 'off');
  await w.recipes.setOn('email-watcher', true);
  assert.equal(w.experiments.mailWatch, true);
  await w.recipes.remove('email-watcher');
  assert.equal(w.experiments.mailWatch, false);
  assert.equal(w.recipes.get('email-watcher').state, 'add');
  w.recipes.add('email-watcher');
  assert.equal(w.experiments.mailWatch, true, 'adding it turns it on, and its thread sets up the rest');
  assert.equal(w.started.length, 1);
});

test('recipes: its numbers count the threads its schedules started in the last 30 days', () => {
  const w = world();
  writeRecipe(w.builtin, 'daily-brief', { name: 'Daily brief', icon: '☀️', description: 'A short note.' });
  w.recipes.add('daily-brief');
  w.schedules.push(schedule('s1', { createdBy: 't1' }));
  const sch = { id: 's1', title: 'Daily brief' };
  w.threads.push(
    thread('a', { schedule: sch, createdAt: new Date(NOW - 1 * DAY).toISOString(), needs: 'you', preview: '2 emails need you', lastSeenSeq: 5 }),
    thread('b', { schedule: sch, createdAt: new Date(NOW - 2 * DAY).toISOString(), lastSeenSeq: 3, archivedAt: '2026-11-19T00:00:00Z' }),
    thread('c', { schedule: sch, createdAt: new Date(NOW - 40 * DAY).toISOString() }),
    thread('d', { schedule: { id: 's-else', title: 'x' } }),
    thread('e'),
  );
  const r = w.recipes.get('daily-brief');
  assert.deepEqual(r.stats, { runs: 2, neededYou: 1, seen: 1, lastRunAt: new Date(NOW - DAY).toISOString(), lastHeadline: '2 emails need you' });
  assert.deepEqual(r.runs.map((x) => [x.threadId, x.needsYou, x.seen, x.archived]), [['a', true, true, false], ['b', false, false, true]]);
});

test('recipes: removing one deletes its schedules and forgets it, leaving its files', async () => {
  const w = world();
  writeRecipe(w.builtin, 'daily-brief', { name: 'Daily brief', icon: '☀️', description: 'A short note.' });
  w.recipes.add('daily-brief');
  w.schedules.push(schedule('s1', { createdBy: 't1' }), schedule('s2'));
  w.recipes.get('daily-brief');
  fs.writeFileSync(path.join(w.folder, 'daily-brief', 'TASK.md'), 'its task');
  await w.recipes.remove('daily-brief');
  assert.deepEqual(w.schedules.map((s) => s.id), ['s2']);
  assert.equal(w.recipes.get('daily-brief').state, 'add');
  assert.ok(fs.existsSync(path.join(w.folder, 'daily-brief', 'TASK.md')));
});

test('recipes: what it remembers survives a restart', () => {
  const w = world();
  writeRecipe(w.builtin, 'daily-brief', { name: 'Daily brief', icon: '☀️', description: 'A short note.' });
  w.recipes.add('daily-brief');
  w.schedules.push(schedule('s1', { createdBy: 't1' }));
  w.recipes.get('daily-brief');
  w.schedules[0].createdBy = undefined;
  const again = new Recipes(w.deps);
  assert.deepEqual(again.get('daily-brief').schedules.map((s) => s.id), ['s1'], 'kept by id, not only by who made it');
  assert.equal(again.get('daily-brief').state, 'on');
});

test('recipes: writing a new one or changing one starts a thread pointed at the format and the folder', () => {
  const w = world();
  writeRecipe(w.builtin, 'daily-brief', { name: 'Daily brief', icon: '☀️', description: 'A short note.' });
  w.recipes.create({ text: 'Tell me when the surf is good' });
  assert.equal(w.started[0].cwd, w.folder);
  assert.ok(w.started[0].text.includes('Tell me when the surf is good'));
  assert.ok(w.started[0].text.includes(path.join(BUILTIN_RECIPES_DIR, 'FORMAT.md')));
  assert.ok(fs.statSync(w.folder).isDirectory());
  w.recipes.create({ fromThreadId: 'abc123' });
  assert.ok(w.started[1].text.includes('abc123'));
  w.recipes.create({ editId: 'daily-brief' });
  assert.match(w.started[2].text, /comes with Threadbear/);
  assert.ok(w.started[2].text.includes(path.join(w.folder, 'daily-brief', 'RECIPE.md')), 'a changed copy goes in the folder');
  assert.throws(() => w.recipes.create({ editId: 'nope' }), /no recipe/);
});

test('recipes: with the experiment off its methods answer as if they did not exist', async () => {
  const w = world();
  const m = recipeMethods(w.recipes);
  w.on = false;
  await assert.rejects(async () => m['recipes.list']({}), (e: { code?: number }) => e.code === -32601);
  w.on = true;
  assert.deepEqual(await m['recipes.list']({}), { recipes: [] });
});

test('recipes: the list says when it has changed, on a look as well as after its own changes', () => {
  const w = world();
  w.recipes.look();
  const before = w.published;
  w.recipes.look();
  assert.equal(w.published, before, 'nothing changed');
  writeRecipe(w.folder, 'kite-watch', { name: 'Kite watch', icon: '🪁', description: 'Mine.' });
  w.recipes.look();
  assert.equal(w.published, before + 1);
});
