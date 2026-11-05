// projectHeads: one small row per project, what a list of projects shows
// (schema.ts). Convex charges a read for the whole document, so a list read
// from `projects` costs every project's notes, about 200 KB for Mike's 79,
// however few fields it returns. Kept by the sync:*Projects functions, and only
// written when one of these fields changes, so editing a project's notes
// re-runs nobody's list.
import type { MutationCtx } from './_generated/server';
import { scrubDoc } from './redaction';

type ProjectFields = {
  runnerId: string;
  id: string;
  title: string;
  createdBy: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  threadCount: number;
  lastActivityAt?: string;
  icon?: { symbol?: string; picture?: string; by: string };
};

function headOf(p: ProjectFields): ProjectFields {
  return {
    runnerId: p.runnerId,
    id: p.id,
    title: p.title,
    createdBy: p.createdBy,
    archived: p.archived,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    threadCount: p.threadCount,
    ...(p.lastActivityAt !== undefined ? { lastActivityAt: p.lastActivityAt } : {}),
    ...(p.icon ? { icon: { ...(p.icon.symbol ? { symbol: p.icon.symbol } : {}), ...(p.icon.picture ? { picture: p.icon.picture } : {}), by: p.icon.by } } : {}),
  };
}

// updatedAt moves with a change to the notes, goals or state too, which a list
// doesn't show, so it doesn't count as a change: the row is left as it was.
export function sameHead(a: ProjectFields, b: ProjectFields): boolean {
  const key = (p: ProjectFields) => {
    const { updatedAt: _u, ...head } = headOf(p);
    return JSON.stringify([head.runnerId, head.id, head.title, head.createdBy, head.archived, head.createdAt, head.threadCount, head.lastActivityAt, head.icon?.symbol, head.icon?.picture, head.icon?.by]);
  };
  return key(a) === key(b);
}

export async function syncHead(ctx: { db: MutationCtx['db'] }, p: ProjectFields): Promise<void> {
  const want = headOf(p);
  const row = await ctx.db.query('projectHeads').withIndex('by_runner_id', (q) => q.eq('runnerId', p.runnerId).eq('id', p.id)).unique();
  if (!row) await ctx.db.insert('projectHeads', want);
  else if (!sameHead(row, want)) await ctx.db.replace(row._id, want);
}

export async function dropHead(ctx: { db: MutationCtx['db'] }, runnerId: string, id: string): Promise<void> {
  const row = await ctx.db.query('projectHeads').withIndex('by_runner_id', (q) => q.eq('runnerId', runnerId).eq('id', id)).unique();
  if (row) await ctx.db.delete(row._id);
}

// A runner's whole list (setProjects): the heads in line with it.
export async function syncHeads(ctx: { db: MutationCtx['db'] }, runnerId: string, projects: ProjectFields[]): Promise<void> {
  const ids = new Set(projects.map((p) => p.id));
  for (const row of await ctx.db.query('projectHeads').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).collect()) {
    if (!ids.has(row.id)) await ctx.db.delete(row._id);
  }
  for (const p of projects) await syncHead(ctx, p);
}

// Every project from before this table, whichever runner it's on, so one
// that's offline when this backend arrives doesn't lose its projects. Once, on
// the first heartbeat any runner sends; until then phone:projects reads
// `projects`, as it did.
export const HEADS_MARK = 'projectHeads';
export async function seedHeads(ctx: { db: MutationCtx['db'] }): Promise<void> {
  if (await ctx.db.query('backendMarks').withIndex('by_name', (q) => q.eq('name', HEADS_MARK)).first()) return;
  await ctx.db.insert('backendMarks', { name: HEADS_MARK });
  // Rows from before scrubbing (API 47) can hold what today's rules take out, and
  // nothing else would clean this copy.
  for await (const p of ctx.db.query('projects')) await syncHead(ctx, { ...p, title: scrubDoc(p.title) });
}
