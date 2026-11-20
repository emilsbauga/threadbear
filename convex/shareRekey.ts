// Every shared picture's file copied to a new one and the old one deleted,
// once (Daybreak 135, 16 Nov 2026). Until 15 Nov a shared page handed its
// viewers each picture's own storage URL, which kept working after sharing
// stopped, until the runner's dropShareImages deleted the file. Since then
// anyone but Mike gets /share/image/<slug>/<id>, which checks the share at
// every request (share.ts shareImageFile), so no storage URL of a shared
// picture reaches anyone else; this ends the ones handed out before, as a
// storage URL names its file. Started by the first heartbeat after the
// deploy once limitsMigration is done (sync.ts), a page at a time, and if
// it stops partway a later heartbeat has it go on from where it got to,
// until a run gets to the end (rekeyDone). A picture's row goes on naming the
// new file, with its runner key's upload record (storageOwners) moved
// across, so nothing else changes: its page, its count, its cleanup.
//
// A file the old row shared with another picture row (only the owner key
// can attach one file twice, sync.ts mustBeUnnamed) moves to the copy with
// it, so the old file goes too; one a waiting command still names (on its
// way to a runner) stays for it until the command is over.
import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { PICTURE_TABLES, storageInUse } from './sync';
import { SHARE_REKEY_DONE, SHARE_REKEY_STARTED } from './lib';

// Small: each picture is up to 10 MB read and written again.
const PAGE = 5;

export const rekeyPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({ rows: v.array(v.object({ id: v.id('shareImages'), storageId: v.id('_storage') })), next: v.union(v.string(), v.null()) }),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.query('shareImages').paginate({ numItems: PAGE, cursor });
    // A page Convex couldn't read whole would skip rows if its cursor were
    // followed: the run ends here instead, and starts again from this page
    // (sync.ts). Rows are a few KB since limitsMigration, so it doesn't.
    if ((page as { pageStatus?: string }).pageStatus === 'SplitRequired') throw new Error('share rekey page too big to read whole');
    return { rows: page.page.map((r) => ({ id: r._id, storageId: r.storageId })), next: page.isDone ? null : page.continueCursor };
  },
});

// The row onto its new file, and the old file deleted unless something
// else names it. False (and the new file deleted): the row has gone or
// names another file now, so there's nothing to swap.
export const rekeySwap = internalMutation({
  args: { id: v.id('shareImages'), old: v.id('_storage'), fresh: v.id('_storage') },
  returns: v.boolean(),
  handler: async (ctx, { id, old, fresh }) => {
    const row = await ctx.db.get(id);
    if (!row || row.storageId !== old) {
      await ctx.storage.delete(fresh);
      return false;
    }
    // Every picture row naming the old file goes to the copy, and its upload record.
    for (const table of PICTURE_TABLES) {
      for (const r of await ctx.db.query(table).withIndex('by_storageId', (q) => q.eq('storageId', old)).collect()) await ctx.db.patch(r._id, { storageId: fresh });
    }
    for (const o of await ctx.db.query('storageOwners').withIndex('by_storageId', (q) => q.eq('storageId', old)).collect()) await ctx.db.patch(o._id, { storageId: fresh });
    if (!(await storageInUse(ctx, old)) && (await ctx.db.system.get(old))) await ctx.storage.delete(old);
    return true;
  },
});

// A page done: how far the run has got, for one started again (sync.ts).
export const rekeyProgress = internalMutation({
  args: { cursor: v.string() },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const m = await ctx.db.query('backendMarks').withIndex('by_name', (q) => q.eq('name', SHARE_REKEY_STARTED)).first();
    if (m) await ctx.db.patch(m._id, { cursor, at: Date.now() });
    return null;
  },
});

// Every shared picture is on a file of its own made since: the run is over.
export const rekeyDone = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (!(await ctx.db.query('backendMarks').withIndex('by_name', (q) => q.eq('name', SHARE_REKEY_DONE)).first())) await ctx.db.insert('backendMarks', { name: SHARE_REKEY_DONE });
    return null;
  },
});

export const rekeyShareImages = internalAction({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const page = await ctx.runQuery(internal.shareRekey.rekeyPage, { cursor });
    for (const r of page.rows) {
      const blob = await ctx.storage.get(r.storageId);
      if (!blob) continue;
      const fresh = await ctx.storage.store(blob);
      try {
        await ctx.runMutation(internal.shareRekey.rekeySwap, { id: r.id, old: r.storageId, fresh });
      } catch (e) {
        // The run ends here, unfinished: the next heartbeat after
        // SHARE_REKEY_STALE_MS starts it again (sync.ts).
        await ctx.storage.delete(fresh);
        throw e;
      }
    }
    if (page.next) {
      await ctx.runMutation(internal.shareRekey.rekeyProgress, { cursor: page.next });
      await ctx.scheduler.runAfter(0, internal.shareRekey.rekeyShareImages, { cursor: page.next });
    }
    else await ctx.runMutation(internal.shareRekey.rekeyDone, {});
    return null;
  },
});
