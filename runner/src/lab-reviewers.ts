// Who reviews a code change, in Mike's order (runner.json `labReviewers`,
// Settings > General > Code review). Each is a provider, with a model and effort when it
// names them; the runner picks the login (lab-review.ts, reviewLogin).
//
// Why a list: Mike's Codex week ran out on 15 Nov 2026 and every review
// quietly became a fresh Claude session, while he had Grok credits going
// unused. With a list he puts the labs in the order he wants them, and
// the next one with room takes over when one runs out.
import { EFFORT_LEVELS, PROVIDERS, type EffortLevel, type Provider } from './protocol.ts';

// The review panel, which for a big or risky change reviews all at once
// (lab-review.ts, panelChange), is a list of its own: runner.json
// `labPanel`, Settings' "Big or risky changes". Mike, 19 Nov 2026: "a panel
// of reviewers ... even from the same provider, you could pick a few
// different reviewers". It began as a `panel: true` tick on this list's
// entries, which he found confusing ("maybe we have a couple of different
// categories of reviewers"), so now each list has its own entries, models
// and efforts, and Gemini (paid per token) can review big changes only.
export type LabReviewer = { provider: Provider; model?: string; effort?: EffortLevel };

// What a runner.json without the key does, and did before the list: the
// other provider of Claude and Codex reviews.
export const DEFAULT_LAB_REVIEWERS: readonly LabReviewer[] = [{ provider: 'codex' }, { provider: 'claude' }];

// Mike may have hand-edited runner.json: an entry that isn't a known
// provider is left out rather than failing the runner's start, and a
// reviewer listed twice (the same provider on the same model) counts the
// first time. A provider may come more than once on different models
// (Codex on two, say). Undefined for no list at all; an empty list is kept,
// as it means only the thread's own provider reviews.
export function parseLabReviewers(v: unknown): LabReviewer[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: LabReviewer[] = [];
  for (const x of v) {
    const r = labReviewer(x);
    if (r && !out.some((o) => sameReviewer(o, r))) out.push(r);
  }
  return out;
}

// One entry, or a reason it isn't one (settings.update says which).
export function labReviewerProblem(x: unknown): string | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'each labReviewers entry must be an object';
  const o = x as Record<string, unknown>;
  if (typeof o.provider !== 'string' || !(PROVIDERS as readonly string[]).includes(o.provider)) return `labReviewers provider must be one of ${PROVIDERS.join(', ')}`;
  if (o.model !== undefined && (typeof o.model !== 'string' || !o.model.trim() || o.model.length > 200)) return 'labReviewers model must be a model id';
  if (o.effort !== undefined && !(EFFORT_LEVELS as readonly unknown[]).includes(o.effort)) return `labReviewers effort must be one of ${EFFORT_LEVELS.join(', ')}`;
  // The old form's tick (reviewerLists reads it), from an app before the two lists.
  if (o.panel !== undefined && typeof o.panel !== 'boolean') return 'labReviewers panel must be true or false';
  return undefined;
}

function labReviewer(x: unknown): LabReviewer | undefined {
  if (labReviewerProblem(x)) return undefined;
  const o = x as { provider: Provider; model?: string; effort?: EffortLevel };
  return { provider: o.provider, ...(o.model ? { model: o.model.trim() } : {}), ...(o.effort ? { effort: o.effort } : {}) };
}

// The panel from a list in the old form, where its members were ticked
// `panel: true` among the reviewers (runner.json from 19 Nov 2026, or an app
// from before the two lists): those entries, which stay in the list too, as
// they reviewed every change then. Undefined when none is ticked.
export function ticked(v: unknown): LabReviewer[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const marked = v.filter((x) => x && typeof x === 'object' && (x as { panel?: unknown }).panel === true);
  return marked.length ? parseLabReviewers(marked) : undefined;
}

// Both lists from runner.json or a settings.update: `labPanel` when it's
// given, else the old ticks in `labReviewers`.
export function reviewerLists(reviewers: unknown, panel: unknown): { labReviewers?: LabReviewer[]; labPanel?: LabReviewer[] } {
  const list = parseLabReviewers(reviewers);
  const board = parseLabReviewers(panel) ?? ticked(reviewers);
  return { ...(list ? { labReviewers: list } : {}), ...(board ? { labPanel: board } : {}) };
}

// Two entries for the same reviewer: one provider, one model (no model is
// the provider's default).
export function sameReviewer(a: LabReviewer, b: LabReviewer): boolean {
  return a.provider === b.provider && (a.model ?? '') === (b.model ?? '');
}
