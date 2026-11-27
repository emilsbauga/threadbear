// The new thread page's model and effort pickers, from the mirrored
// accounts (phone:accounts, API 20): the iPhone's NewThreadChoices, ported.
// Naming a model is enough for the runner to pick a login of its provider
// with room (runner.ts, pickForNew), so there's no login picker.

export type ModelChoice = { id: string; title: string; effortLevels?: string[]; defaultEffort?: string; provider?: string };
export type AccountModels = { runnerId?: string; provider?: string; models?: ModelChoice[] };
export type RunnerPick = { runnerId: string; placed?: boolean; main?: boolean; draining?: boolean };

const ORDER = ['claude', 'codex'];
const ALL = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CLAUDE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const TITLES: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };

// The runner a new thread with none named lands on, as phone:create picks
// it (mainRunner): the first online in Mike's order, else the main one if
// it's online. undefined when the backend would pick some other way, so the
// page lists every runner's models rather than a sleeping Mac's.
export function defaultRunner<R extends RunnerPick>(runners: R[], online: (r: R) => boolean): R | undefined {
  const up = (r: R) => online(r) && !r.draining;
  return runners.find((r) => r.placed && up(r)) ?? runners.find((r) => r.main && up(r));
}

// The models on offer on one runner: its own logins' (a row with no runner
// is anyone's), Claude's first, each once. With no runner known, every one.
export function models(accounts: AccountModels[], runnerId?: string): ModelChoice[] {
  // phone:accounts is v.any(), so a row that isn't an object is passed over.
  const rows = accounts.filter((a) => a && typeof a === 'object');
  const mine = runnerId ? rows.filter((a) => !a.runnerId || a.runnerId === runnerId) : rows;
  const rank = (p?: string) => {
    const i = ORDER.indexOf(p ?? 'claude');
    return i < 0 ? ORDER.length : i;
  };
  const sorted = mine.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a.provider) - rank(y.a.provider) || x.i - y.i);
  const seen = new Set<string>();
  const out: ModelChoice[] = [];
  for (const { a } of sorted) {
    for (const m of Array.isArray(a.models) ? a.models : []) {
      // '' is the page's Default, so a row with no id can't stand for a model.
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push({ ...m, title: typeof m.title === 'string' && m.title ? m.title : m.id, provider: a.provider ?? 'claude' });
    }
  }
  return out;
}

// The efforts a model offers. With none picked, Claude's levels (the
// runner drops one the model it lands on doesn't offer); a Claude model
// that doesn't list its levels takes any of them (new-threads.ts,
// checkSettings). Other models that list none (OpenCode, Gemini, Grok)
// have no effort, so none.
export function efforts(model?: ModelChoice): string[] {
  if (!model) return CLAUDE_LEVELS;
  const levels = Array.isArray(model.effortLevels) ? model.effortLevels.filter((l) => ALL.includes(l)) : [];
  if (levels.length) return levels;
  return (model.provider ?? 'claude') === 'claude' ? CLAUDE_LEVELS : [];
}

export function effortTitle(level: string): string {
  return TITLES[level] ?? level.charAt(0).toUpperCase() + level.slice(1);
}

// Whether a picked effort still fits once the model changes.
export function keeps(effort: string, model?: ModelChoice): boolean {
  return !effort || efforts(model).includes(effort);
}
