// Shared memory (docs/protocol.md, "Shared memory"; runner/src/memory-sync.ts).
// The main Mac's global CLAUDE.md and the memory folders Claude Code keeps
// under its home folder, copied to Mike's other runners so a thread on Bruce
// knows what one on the M5 does.
//
// Only the owner key writes the files (sync:putMemory): they go into every
// session on every runner, so a runner key that could write them could brief
// the main Mac's agents. What a runner key's own agents save comes back as an
// offer (sync:offerMemory) that only the owner reads, as data for the nightly
// retro to fold in or drop, never as memory.
import type { MutationCtx, QueryCtx } from './_generated/server';

// Plain checks with no Convex imports, so the runner's tests can hold its
// own copy of the rule to this one (memory-sync.test.ts).
//
//   global/CLAUDE.md                 the main Mac's ~/.claude/CLAUDE.md
//   memory/~<slug rest>/<name>.md    one memory file. The folder is Claude
//                                    Code's project slug with the home
//                                    folder's part cut off, so it lands under
//                                    each runner's own home ("~-dev-me-misc"
//                                    is ~/dev/me/misc; "~" is home itself).
export const MEMORY_PATH = /^(?:global\/CLAUDE\.md|memory\/~(?:-[A-Za-z0-9-]*)?\/[A-Za-z0-9][A-Za-z0-9._-]*\.md)$/;
export const MAX_MEMORY_PATH = 240;
// Each file, as UTF-8. The biggest on the M5 was 21 KB (misc's MEMORY.md).
export const MAX_MEMORY_FILE = 128 * 1024;
export const MAX_MEMORY_BATCH = 50;
// Text in one call, so a batch's reads and writes stay well inside a
// mutation's limits (the runner sends up to 1 MB, MEMORY_BATCH_BYTES).
export const MAX_BATCH_BYTES = 2 * 1024 * 1024;
// Files one answer of memorySince carries, so a first read of a few MB comes
// in pages well under a query's limits.
export const MEMORY_PAGE = 60;
// Offers a runner key may have waiting at once, and how many the owner reads
// in one go.
export const MAX_OFFERS_PER_RUNNER = 200;
export const OFFER_PAGE = 20;
const HASH = /^[0-9a-f]{64}$/;

export function memoryPathOk(p: string): boolean {
  return typeof p === 'string' && p.length <= MAX_MEMORY_PATH && MEMORY_PATH.test(p) && !p.includes('..');
}

export function memoryHashOk(h: string): boolean {
  return typeof h === 'string' && HASH.test(h);
}

export type MemoryPut = { path: string; hash: string; text?: string; gone?: boolean };

// What's wrong with a file as sent, or undefined. Counted in bytes, as
// that's what a row costs.
export function badMemoryFile(f: MemoryPut): string | undefined {
  if (!memoryPathOk(f.path)) return `not a memory path: ${JSON.stringify(String(f.path).slice(0, 80))}`;
  if (!memoryHashOk(f.hash)) return `${f.path}: hash must be 64 hex characters`;
  if (f.gone) return f.text ? `${f.path}: a gone file has no text` : undefined;
  if (typeof f.text !== 'string') return `${f.path}: no text`;
  if (new TextEncoder().encode(f.text).length > MAX_MEMORY_FILE) return `${f.path}: over ${MAX_MEMORY_FILE} bytes`;
  return undefined;
}

export function batchBytes(files: { text?: string }[]): number {
  let n = 0;
  for (const f of files) n += new TextEncoder().encode(f.text ?? '').length;
  return n;
}

type Db = { db: MutationCtx['db'] };

// A runner's count of waiting offers, moved by `by`. Returns the new count.
export async function bumpOfferCount(ctx: Db, runnerId: string, by: number): Promise<number> {
  const row = await ctx.db.query('memoryOfferCounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique();
  const count = Math.max(0, (row?.count ?? 0) + by);
  if (row) await ctx.db.replace(row._id, { runnerId, count });
  else await ctx.db.insert('memoryOfferCounts', { runnerId, count });
  return count;
}

export async function offerCount(ctx: { db: QueryCtx['db'] }, runnerId: string): Promise<number> {
  return (await ctx.db.query('memoryOfferCounts').withIndex('by_runnerId', (q) => q.eq('runnerId', runnerId)).unique())?.count ?? 0;
}

// Writes what differs from the table, each change with the next sequence
// number, so a runner reading "after seq N" never misses one: mutations are
// serialised, so a later seq always commits after an earlier one, which
// timestamps can't promise. Returns how many rows changed.
export async function putMemoryFiles(ctx: Db, files: MemoryPut[], now: number): Promise<number> {
  const last = await ctx.db.query('memoryFiles').withIndex('by_seq').order('desc').first();
  let seq = last?.seq ?? 0;
  let changed = 0;
  for (const f of files) {
    const row = await ctx.db.query('memoryFiles').withIndex('by_path', (q) => q.eq('path', f.path)).unique();
    if (f.gone) {
      if (!row || row.gone) continue;
      await ctx.db.replace(row._id, { path: f.path, hash: f.hash, text: '', gone: true, seq: ++seq, updatedMs: now });
    } else {
      if (row && !row.gone && row.hash === f.hash) continue;
      const doc = { path: f.path, hash: f.hash, text: f.text!, seq: ++seq, updatedMs: now };
      if (row) await ctx.db.replace(row._id, doc);
      else await ctx.db.insert('memoryFiles', doc);
    }
    changed++;
  }
  return changed;
}

export type MemoryRow = { path: string; hash: string; text: string; gone?: true; seq: number };

// The rows changed after `after`, oldest first, a page at a time. `more`
// says ask again from the last one's seq.
export async function memoryAfter(ctx: { db: QueryCtx['db'] }, after: number): Promise<{ rows: MemoryRow[]; more: boolean; seq: number }> {
  const page = await ctx.db
    .query('memoryFiles')
    .withIndex('by_seq', (q) => q.gt('seq', after))
    .order('asc')
    .take(MEMORY_PAGE + 1);
  const more = page.length > MEMORY_PAGE;
  const rows = page.slice(0, MEMORY_PAGE).map((r) => ({ path: r.path, hash: r.hash, text: r.text, ...(r.gone ? { gone: true as const } : {}), seq: r.seq }));
  const top = await ctx.db.query('memoryFiles').withIndex('by_seq').order('desc').first();
  return { rows, more, seq: top?.seq ?? 0 };
}
