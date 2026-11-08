// Runner-only delivery of external intake to dormant drafts. Sender receipts
// remain immutable. Admin binding is explicit; clients cannot choose a runner.
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { query, mutation, internalMutation } from './_generated/server';
import { runnerAuth, actAs, checkRunnerId, sha256 } from './lib';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';

export const bindConsumer = internalMutation({
  args: { clientId: v.string(), runnerId: v.string() }, returns: v.null(),
  handler: async (ctx, { clientId, runnerId }) => {
    checkRunnerId(runnerId);
    const c = await ctx.db.query('intakeClients').withIndex('by_client', q => q.eq('clientId', clientId)).unique();
    if (!c || c.revokedAt !== undefined) throw new Error('No active intake client');
    if (c.consumerRunnerId && c.consumerRunnerId !== runnerId) throw new Error('Intake client is already bound to another runner');
    await ctx.db.patch(c._id, { consumerRunnerId: runnerId });
    return null;
  },
});

export const ignoreMessage = internalMutation({
  args: { clientId: v.string(), messageId: v.string() }, returns: v.null(),
  handler: async (ctx, { clientId, messageId }) => {
    const row = await ctx.db.query('intakeMessages').withIndex('by_client_message', q => q.eq('clientId', clientId).eq('messageId', messageId)).unique();
    if (!row) throw new Error('Intake message not found');
    if (row.deliveryState === 'saved' || (row.leaseUntil ?? 0) > Date.now()) throw new Error('Message is already saved or has a live lease');
    await ctx.db.patch(row._id, { deliveryState: 'ignored' });
    if (row.transferId) {
      await ctx.db.patch(row.transferId, { state: 'cancelled', cleanupPending: true });
      await ctx.scheduler.runAfter(0, internal.intakeFiles.cleanDelivered, { transferId: row.transferId });
    }
    return null;
  },
});

async function owned(ctx: MutationCtx | QueryCtx, receiptId: Id<'intakeMessages'>, runnerId: string) {
  const row = await ctx.db.get(receiptId);
  if (!row) return null;
  const client = await ctx.db.query('intakeClients').withIndex('by_client', q => q.eq('clientId', row.clientId)).unique();
  return client && client.revokedAt === undefined && client.consumerRunnerId === runnerId ? row : null;
}
const itemOf = (row: Doc<'intakeMessages'>) => ({ receiptId: row._id, clientId: row.clientId, receivedAt: row.receivedAt, message: row.message, ...(row.attachments ? { attachments: row.attachments } : {}) });

export const pendingIntake = query({
  args: { key: v.string(), runnerId: v.string(), includeAttachments: v.optional(v.boolean()) },
  handler: async (ctx, { key, runnerId, includeAttachments }) => {
    const caller = await runnerAuth(ctx, key, 'pendingIntake');
    await actAs(ctx, caller, runnerId);
    const out: ReturnType<typeof itemOf>[] = [];
    for (const c of await ctx.db.query('intakeClients').withIndex('by_consumer', q => q.eq('consumerRunnerId', runnerId)).take(32)) {
      if (c.revokedAt !== undefined) continue;
      const rows = includeAttachments
        ? await ctx.db.query('intakeMessages').withIndex('by_client_delivery', q => q.eq('clientId', c.clientId).eq('deliveryState', undefined)).take(8 - out.length)
        : await ctx.db.query('intakeMessages').withIndex('by_client_delivery_kind', q => q.eq('clientId', c.clientId).eq('deliveryState', undefined).eq('hasAttachments', undefined)).take(8 - out.length);
      out.push(...rows.filter(row => includeAttachments || !row.attachments?.length).map(itemOf));
      if (out.length >= 8) break;
    }
    return out;
  },
});

export const claimIntake = mutation({
  args: { key: v.string(), runnerId: v.string(), receiptId: v.id('intakeMessages'), leaseToken: v.string() },
  handler: async (ctx, { key, runnerId, receiptId, leaseToken }) => {
    const caller = await runnerAuth(ctx, key, 'claimIntake');
    await actAs(ctx, caller, runnerId);
    if (!/^[a-f0-9]{32}$/.test(leaseToken)) throw new Error('Invalid lease token');
    const row = await owned(ctx, receiptId, runnerId);
    if (!row || row.deliveryState === 'ignored') return { state: 'unavailable' as const };
    if (row.deliveryState === 'saved') return { state: 'saved' as const, threadId: row.deliveryThreadId };
    if ((row.leaseUntil ?? 0) > Date.now() && row.leaseToken !== leaseToken) return { state: 'busy' as const };
    const hash = await sha256('threadbear-intake-v1:' + JSON.stringify([row.clientId, receiptId]));
    const threadId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    await ctx.db.patch(receiptId, { leaseToken, leaseUntil: Date.now() + 60_000, deliveryThreadId: threadId });
    return { state: 'claimed' as const, threadId };
  },
});

export const finishIntake = mutation({
  args: { key: v.string(), runnerId: v.string(), receiptId: v.id('intakeMessages'), leaseToken: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { key, runnerId, receiptId, leaseToken }) => {
    const caller = await runnerAuth(ctx, key, 'finishIntake');
    await actAs(ctx, caller, runnerId);
    const row = await owned(ctx, receiptId, runnerId);
    if (!row || row.deliveryState === 'ignored') return false;
    if (row.deliveryState === 'saved') return row.leaseToken === leaseToken;
    if (row.leaseToken !== leaseToken || (row.leaseUntil ?? 0) <= Date.now()) return false;
    await ctx.db.patch(receiptId, { deliveryState: 'saved', deliveredAt: Date.now(), deliveredRunnerId: runnerId, leaseUntil: undefined });
    if (row.transferId) {
      await ctx.db.patch(row.transferId, { localSaved: true, cleanupPending: true });
      await ctx.scheduler.runAfter(0, internal.intakeFiles.cleanDelivered, { transferId: row.transferId });
    }
    return true;
  },
});
