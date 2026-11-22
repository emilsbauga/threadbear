// Recipes (docs/protocol/projects.md, "Recipes"; experiment `recipes`): techniques
// worth keeping, written so an agent can set them up for anyone. Each is a
// folder with a RECIPE.md (format: recipes/FORMAT.md) and maybe a header
// picture. The ones that come with Threadbear are in src/recipes/, so a
// release carries them; the user's own are in their recipes folder, which is
// also where a set-up recipe keeps its working files.
//
// Mike's idea (20 Nov 2026): the jobs he gets the most from (his morning
// brief, the nightly look back) were schedules only he could see. A recipe
// is one of those made shareable, with a switch, its runs counted, and a
// thread that sets it up around whatever tools the user has, rather than a
// fixed installer.
//
// The runner only remembers what's its to remember (recipes.json): whether
// one is on, the thread that set it up and the schedules that are its. The
// setup agent makes the schedule with its ordinary schedule_message, and a
// schedule that thread made becomes the recipe's at the next look, so agents
// get no new tool for this.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './fsutil.ts';
import { ErrorCode, RpcError, type Schedule, type ThreadSummary } from './protocol.ts';
import type { UpdateScheduleParams } from './schedules.ts';

export const RECIPES_EXPERIMENT = 'recipes';
export const BUILTIN_RECIPES_DIR = path.join(import.meta.dirname, 'recipes');
export const DEFAULT_RECIPES_FOLDER = '~/ThreadbearThreads/recipes';
const STATE_FILE = 'recipes.json';
const HEADERS = ['header.png', 'header.jpg', 'header.jpeg', 'header.webp'];
const WINDOW_MS = 30 * 86_400_000;
const MAX_RUNS = 60;
const LOOK_MS = 30_000;

export type RecipeFile = {
  id: string;
  name: string;
  icon: string;
  description: string;
  by?: string;
  when?: string;
  color?: string;
  experiment?: string;
  about: string;
  example?: string;
  setup?: string;
  eachRun?: string;
  file: string;
  dir: string;
  header?: string;
  source: 'builtin' | 'yours';
};

export type RecipeState = 'add' | 'settingUp' | 'on' | 'off';

export type RecipeSummary = {
  id: string;
  name: string;
  icon: string;
  description: string;
  by?: string;
  source: 'builtin' | 'yours';
  experiment?: string;
  when?: string;
  color?: string;
  header?: string;
  state: RecipeState;
  setupThreadId?: string;
  schedules: { id: string; title: string; paused: boolean; nextRunAt?: string; whenText: string }[];
  stats: { runs: number; neededYou: number; seen: number; lastRunAt?: string; lastHeadline?: string };
};

export type RecipeRun = { threadId: string; title: string; at: string; headline?: string; needsYou: boolean; seen: boolean; archived: boolean };
export type RecipeDetail = RecipeSummary & { about: string; example?: string; file: string; runs: RecipeRun[] };

// What recipes.json keeps for a recipe that's been added.
type Kept = {
  // What the user last chose: on unless they switched it off.
  on: boolean;
  setupThreadId?: string;
  schedules: string[];
  addedAt: string;
};

export type RecipesDeps = {
  home: string;
  // The user's recipes folder, expanded (runner.json `recipes.folder`).
  folder: () => string;
  builtinDir?: string;
  now: () => number;
  // The experiment's switch, read each time.
  on: () => boolean;
  publish: () => void;
  experimentOn: (id: string) => boolean;
  setExperiment: (id: string, on: boolean) => void;
  schedules: {
    list(): Schedule[];
    update(p: UpdateScheduleParams): Promise<Schedule>;
    delete(id: string): Promise<unknown>;
  };
  // The threads a schedule started since then (ms), archived ones too.
  threads: (since: number) => ThreadSummary[];
  // Starts a thread.
  start: (p: { text: string; title: string; cwd: string }) => ThreadSummary;
  // A fixed message, and what went wrong as `error` (sentry.ts sends only the message).
  log?: (msg: string, extra?: { error: string }) => void;
};

/** One RECIPE.md: `key: value` lines between `---`, then `## ` sections. */
export function parseRecipe(text: string, file: string): Omit<RecipeFile, 'id' | 'file' | 'dir' | 'header' | 'source'> {
  const match = text.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${file}: starts with its fields between --- lines`);
  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) fields[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  const sections: Record<string, string> = {};
  for (const chunk of match[2].split(/^## /m).slice(1)) {
    const [heading, ...body] = chunk.split('\n');
    sections[heading.trim().toLowerCase()] = body.join('\n').trim();
  }
  const need = (k: string) => {
    if (!fields[k]) throw new Error(`${file}: has no ${k}`);
    return fields[k];
  };
  const opt = (v: string | undefined) => (v ? v : undefined);
  return {
    name: need('name'),
    icon: need('icon'),
    description: need('description'),
    by: opt(fields.by),
    when: opt(fields.when),
    color: /^#[0-9a-fA-F]{6}$/.test(fields.color ?? '') ? fields.color : undefined,
    experiment: opt(fields.experiment),
    about: sections.about ?? '',
    example: opt(sections.example),
    setup: opt(sections['setting it up']),
    eachRun: opt(sections['each run']),
  };
}

function readDir(dir: string | undefined, source: RecipeFile['source'], log?: (m: string, extra?: { error: string }) => void): RecipeFile[] {
  if (!dir || !fs.existsSync(dir)) return [];
  const out: RecipeFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const at = path.join(dir, entry.name);
    const file = path.join(at, 'RECIPE.md');
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = parseRecipe(fs.readFileSync(file, 'utf8'), file);
      const header = HEADERS.map((h) => path.join(at, h)).find((h) => fs.existsSync(h));
      out.push({ id: entry.name, ...parsed, file, dir: at, source, ...(header ? { header } : {}) });
    } catch (e) {
      log?.('recipes: could not read one', { error: (e as Error).message });
    }
  }
  return out;
}

/** The built-in recipes and the user's, theirs in place of a built-in with its id. */
export function readRecipes(builtinDir: string | undefined, folder: string | undefined, log?: (m: string, extra?: { error: string }) => void): RecipeFile[] {
  const byId = new Map<string, RecipeFile>();
  for (const r of readDir(builtinDir, 'builtin', log)) byId.set(r.id, r);
  for (const r of readDir(folder, 'yours', log)) byId.set(r.id, r);
  return [...byId.values()];
}

export class Recipes {
  private deps: RecipesDeps;
  private kept: Record<string, Kept>;
  private seen = '';
  private timer?: ReturnType<typeof setInterval>;

  constructor(deps: RecipesDeps) {
    this.deps = deps;
    this.kept = this.load();
  }

  start(): void {
    this.timer = setInterval(() => {
      try {
        this.look();
      } catch (e) {
        this.deps.log?.('recipes: look failed', { error: (e as Error).message });
      }
    }, LOOK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  on(): boolean {
    return this.deps.on();
  }

  /** Says recipes.updated when what the list shows has changed. */
  look(): void {
    if (!this.deps.on()) return;
    const now = JSON.stringify(this.list());
    if (now !== this.seen) {
      const first = this.seen === '';
      this.seen = now;
      if (!first) this.deps.publish();
    }
  }

  list(): RecipeSummary[] {
    const threads = this.recentThreads();
    const order: Record<RecipeState, number> = { on: 0, settingUp: 1, off: 2, add: 3 };
    return this.files()
      .map((f) => this.summary(f, threads))
      .sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
  }

  get(id: string): RecipeDetail {
    const f = this.file(id);
    const threads = this.recentThreads();
    const s = this.summary(f, threads);
    return { ...s, about: f.about, ...(f.example ? { example: f.example } : {}), file: f.file, runs: this.runs(s, threads) };
  }

  add(id: string): { threadId: string; thread: ThreadSummary } {
    const f = this.file(id);
    const current = this.summary(f, []);
    if (current.state !== 'add') throw new RpcError(ErrorCode.badParams, `${f.name} is already added`);
    const cwd = path.join(this.deps.folder(), id);
    fs.mkdirSync(cwd, { recursive: true });
    if (f.experiment) this.deps.setExperiment(f.experiment, true);
    const thread = this.deps.start({ text: setupBrief(f, cwd), title: `Set up ${f.name}`, cwd });
    this.kept[id] = { on: true, setupThreadId: thread.id, schedules: [], addedAt: new Date(this.deps.now()).toISOString() };
    this.changed();
    return { threadId: thread.id, thread };
  }

  async setOn(id: string, on: boolean): Promise<RecipeSummary> {
    const f = this.file(id);
    if (f.experiment) {
      this.deps.setExperiment(f.experiment, on);
      this.kept[id] = { ...(this.kept[id] ?? { schedules: [], addedAt: new Date(this.deps.now()).toISOString() }), on };
    } else {
      const k = this.kept[id];
      if (!k) throw new RpcError(ErrorCode.badParams, `${f.name} isn't added yet`);
      this.adopt(id, k);
      k.on = on;
      this.save();
      for (const s of this.deps.schedules.list()) {
        if (k.schedules.includes(s.id) && s.paused === on) await this.deps.schedules.update({ scheduleId: s.id, paused: !on });
      }
    }
    this.changed();
    return this.summary(f, this.recentThreads());
  }

  async remove(id: string): Promise<{ removed: true }> {
    const f = this.file(id);
    const k = this.kept[id];
    if (k) {
      this.adopt(id, k);
      for (const s of this.deps.schedules.list()) if (k.schedules.includes(s.id)) await this.deps.schedules.delete(s.id);
    }
    if (f.experiment) this.deps.setExperiment(f.experiment, false);
    delete this.kept[id];
    this.changed();
    return { removed: true };
  }

  create(p: { text?: string; fromThreadId?: string; editId?: string }): { threadId: string; thread: ThreadSummary } {
    const folder = this.deps.folder();
    fs.mkdirSync(folder, { recursive: true });
    const format = path.join(BUILTIN_RECIPES_DIR, 'FORMAT.md');
    if (p.editId) {
      const f = this.file(p.editId);
      const target = path.join(folder, f.id, 'RECIPE.md');
      const where = f.source === 'builtin'
        ? `It comes with Threadbear, so don't edit it there: write your changed copy to ${target} (copy its header picture too, if it has one), and that copy is used in its place.`
        : 'Change it where it is.';
      const text = `Change the recipe "${f.name}" with the user. Its file is ${f.file}. ${where}\n\nThe format is in ${format}. Ask what they want changed first${p.text ? `; they said: ${p.text}` : ''}. If it's set up and the change affects its schedule or its TASK.md in ${path.join(folder, f.id)}, change those too.`;
      return started(this.deps.start({ text, title: `Change ${f.name}`, cwd: folder }));
    }
    const from = p.fromThreadId ? `\n\nBase it on what went well in the thread ${p.fromThreadId}: read it with read_thread first.` : '';
    const what = p.text ? `\n\nWhat they said: ${p.text}` : '\n\nAsk them what they want it to do.';
    const text = `Write a new Threadbear recipe with the user: a technique worth keeping, written so an agent can set it up for anyone. The format, and how to keep it shareable, are in ${format}: read it first.${what}${from}\n\nMake a folder for it in ${folder} (a short kebab-case name) with its RECIPE.md. If you can make pictures (an image model you can reach), make its header picture too, as the format says; otherwise give it a color. Don't set it up: once the file is there it shows in Threadbear's Recipes, switched off, for the user to add.`;
    return started(this.deps.start({ text, title: 'New recipe', cwd: folder }));
  }

  // ------------------------------------------------------------- inside

  private files(): RecipeFile[] {
    return readRecipes(this.deps.builtinDir ?? BUILTIN_RECIPES_DIR, this.deps.folder(), this.deps.log);
  }

  private file(id: string): RecipeFile {
    const f = this.files().find((r) => r.id === id);
    if (!f) throw new RpcError(ErrorCode.badParams, `no recipe "${id}"`);
    return f;
  }

  // Schedules its setup thread made become its own; ones deleted elsewhere
  // drop off.
  private adopt(id: string, k: Kept): void {
    const all = this.deps.schedules.list();
    const ids = new Set(all.map((s) => s.id));
    const mine = k.schedules.filter((s) => ids.has(s));
    for (const s of all) if (k.setupThreadId && s.createdBy === k.setupThreadId && !mine.includes(s.id)) mine.push(s.id);
    if (mine.join() !== k.schedules.join()) {
      k.schedules = mine;
      this.kept[id] = k;
      this.save();
    }
  }

  private summary(f: RecipeFile, threads: ThreadSummary[]): RecipeSummary {
    const k = this.kept[f.id];
    if (k) this.adopt(f.id, k);
    const schedules = k ? this.deps.schedules.list().filter((s) => k.schedules.includes(s.id)) : [];
    let state: RecipeState;
    if (f.experiment) state = this.deps.experimentOn(f.experiment) ? 'on' : k ? 'off' : 'add';
    else if (!k) state = 'add';
    else if (!schedules.length) state = 'settingUp';
    else state = k.on ? 'on' : 'off';
    const ids = new Set(schedules.map((s) => s.id));
    const runs = threads.filter((t) => t.schedule && ids.has(t.schedule.id));
    const last = runs[0];
    return {
      id: f.id,
      name: f.name,
      icon: f.icon,
      description: f.description,
      ...(f.by ? { by: f.by } : {}),
      source: f.source,
      ...(f.experiment ? { experiment: f.experiment } : {}),
      ...(f.when ? { when: f.when } : {}),
      ...(f.color ? { color: f.color } : {}),
      ...(f.header ? { header: f.header } : {}),
      state,
      ...(k?.setupThreadId ? { setupThreadId: k.setupThreadId } : {}),
      schedules: schedules.map((s) => ({ id: s.id, title: s.title, paused: s.paused, whenText: s.whenText, ...(s.nextRunAt ? { nextRunAt: s.nextRunAt } : {}) })),
      stats: {
        runs: runs.length,
        neededYou: runs.filter((t) => t.needs === 'you').length,
        seen: runs.filter(seen).length,
        ...(last ? { lastRunAt: last.createdAt } : {}),
        ...(last?.preview ? { lastHeadline: last.preview } : {}),
      },
    };
  }

  private runs(s: RecipeSummary, threads: ThreadSummary[]): RecipeRun[] {
    const ids = new Set(s.schedules.map((x) => x.id));
    return threads
      .filter((t) => t.schedule && ids.has(t.schedule.id))
      .slice(0, MAX_RUNS)
      .map((t) => ({ threadId: t.id, title: t.title, at: t.createdAt, ...(t.preview ? { headline: t.preview } : {}), needsYou: t.needs === 'you', seen: seen(t), archived: !!t.archivedAt }));
  }

  // Threads a schedule started in the last 30 days, newest first.
  private recentThreads(): ThreadSummary[] {
    const since = this.deps.now() - WINDOW_MS;
    return this.deps.threads(since)
      .filter((t) => t.schedule && Date.parse(t.createdAt) >= since)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private changed(): void {
    this.save();
    this.seen = JSON.stringify(this.list());
    this.deps.publish();
  }

  private load(): Record<string, Kept> {
    try {
      const json = JSON.parse(fs.readFileSync(path.join(this.deps.home, STATE_FILE), 'utf8')) as { recipes?: Record<string, Kept> };
      return json.recipes && typeof json.recipes === 'object' ? json.recipes : {};
    } catch {
      return {};
    }
  }

  private save(): void {
    atomicWriteFileSync(path.join(this.deps.home, STATE_FILE), JSON.stringify({ version: 1, recipes: this.kept }, null, 2) + '\n');
  }
}

function started(thread: ThreadSummary): { threadId: string; thread: ThreadSummary } {
  return { threadId: thread.id, thread };
}

function seen(t: ThreadSummary): boolean {
  return t.lastSeenSeq >= t.lastSeq;
}

// The first message of the thread that sets a recipe up.
function setupBrief(f: RecipeFile, cwd: string): string {
  const lines = [
    `Set up the recipe "${f.name}" for the user. Its file is ${f.file}: read it all first, then follow its "Setting it up" section.`,
    `Work in this folder (${cwd}): it's the recipe's own, for its TASK.md, memory.md and any scripts.`,
  ];
  if (f.experiment) {
    lines.push(`It switches Threadbear's ${f.experiment} experiment, which is on now. Set up what it needs to work, as the file says.`);
  } else {
    lines.push(
      'Make its schedule here, with schedule_message (new_thread true, this folder): only schedules this thread makes count as the recipe\'s, and they appear under it in Recipes. Make one schedule unless the file says otherwise.',
      'If the user already has a schedule doing this job, say so and ask whether to set this up anyway.',
    );
  }
  lines.push('Ask what you need in one card, keep anything of theirs out of the recipe\'s own file, and end by telling them what you set up and when it first runs.');
  return lines.join('\n\n');
}

export function recipeMethods(r: Recipes): Record<string, (p: Record<string, unknown>) => unknown> {
  const gate = <T>(fn: (p: Record<string, unknown>) => T) => (p: Record<string, unknown>): T => {
    if (!r.on()) throw new RpcError(ErrorCode.methodNotFound, `Recipes is an experiment that's off (${RECIPES_EXPERIMENT} in runner.json)`);
    return fn(p);
  };
  const id = (p: Record<string, unknown>) => {
    if (typeof p.id !== 'string' || !p.id) throw new RpcError(ErrorCode.badParams, 'id must be a string');
    return p.id;
  };
  const optStr = (p: Record<string, unknown>, k: string) => {
    const v = p[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'string') throw new RpcError(ErrorCode.badParams, `${k} must be a string`);
    return v;
  };
  return {
    'recipes.list': gate(() => ({ recipes: r.list() })),
    'recipes.get': gate((p) => ({ recipe: r.get(id(p)) })),
    'recipes.add': gate((p) => r.add(id(p))),
    'recipes.setOn': gate(async (p) => {
      if (typeof p.on !== 'boolean') throw new RpcError(ErrorCode.badParams, 'on must be a boolean');
      return { recipe: await r.setOn(id(p), p.on) };
    }),
    'recipes.remove': gate((p) => r.remove(id(p))),
    'recipes.create': gate((p) => r.create({ text: optStr(p, 'text'), fromThreadId: optStr(p, 'fromThreadId'), editId: optStr(p, 'editId') })),
  };
}
