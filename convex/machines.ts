// Every state machine in the backend (docs/lifecycles.md), checked together
// when the app loads: a command's (commandMachine.ts), a move's
// (moveMachine.ts), a runner request's (requestMachine.ts), a thread
// id's clear (clearMachine.ts), a virtual runner's box (boxMachine.ts) and
// a login's cloud token for boxes (cloudTokenMachine.ts) and this
// deployment's install with the push relay (relayInstallMachine.ts). Functions that
// send `server` events, purge rows or read failed timers are built with this
// catalog's internalMutation, which carries the brand those need and a db
// that can't write a machine's state; the rest of the backend stays on
// Convex's own builders, and sends the machine's role events from them.
import { defineMachines, deliveryArgs, type Machines } from '@convex-dev/state-machines';
import type { WithoutSystemFields } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { components, internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, mutation, type MutationCtx } from './_generated/server';
import { appSchema } from './schema';
import { command as commandMachine } from './commandMachine';
import { move as moveMachine } from './moveMachine';
import { request as requestMachine } from './requestMachine';
import { clear as clearMachine } from './clearMachine';
import { box as boxMachine } from './boxMachine';
import { cloudToken as cloudTokenMachine } from './cloudTokenMachine';
import { relayInstall as relayInstallMachine } from './relayInstallMachine';
import { steppingFor } from './stepping';
import { wakeIfAsleep, wakeLevelOf } from './boxHooks';

// A machine whose backfill's stepping stone is being deployed is left out (stepping.ts).
export const machines: Machines<typeof appSchema> = defineMachines(appSchema, [...(steppingFor('commandState') ? [] : [commandMachine]), ...(steppingFor('moveState') ? [] : [moveMachine]), ...(steppingFor('requestState') ? [] : [requestMachine]), ...(steppingFor('clearState') ? [] : [clearMachine]), boxMachine, ...(steppingFor('tokenState') ? [] : [cloudTokenMachine]), relayInstallMachine] as never, {
  mutation,
  internalMutation,
  internalQuery,
  deliver: internal.machines.deliver,
  component: components.stateMachines,
});

// Imported from here rather than its own module: sending needs the catalog, and importing this loads it.
export const command = commandMachine;
export const move = moveMachine;
export const request = requestMachine;
export const clear = clearMachine;
export const box = boxMachine;
export const cloudToken = cloudTokenMachine;
export const relayInstall = relayInstallMachine;

/**
 * A new command, pending for its runner: the machine's QUEUE, which writes
 * its state (and `state`) and arms its timer. Both insert sites (relay.ts
 * queueCommand, phone.ts queue) come through here, so a command for a
 * sleeping box's runner wakes the box (boxHooks.ts wakeIfAsleep).
 */
export async function queued(ctx: MutationCtx, fields: Omit<WithoutSystemFields<Doc<'commands'>>, 'state' | 'commandState' | 'commandStateTimers'>): Promise<Id<'commands'>> {
  const wakeLevel = wakeLevelOf(fields.kind, fields.args);
  const r = await command.create(ctx, { ...fields, state: 'pending', ...(wakeLevel ? { wakeLevel } : {}) } as never, { type: 'QUEUE' });
  if (r.status !== 'done') throw new ConvexError({ kind: 'conflict', message: `the command couldn't be queued: ${r.reasons.join(' ')}` });
  await wakeIfAsleep(ctx, fields.runnerId, fields.kind, fields.args, r.id as Id<'commands'>);
  return r.id as Id<'commands'>;
}

// Timers fire through this. A timer whose step throws stays pending, its job
// failed, until rearmTimer.
export const deliver = machines.internalMutation({ args: deliveryArgs, handler: machines.deliver });

/** Timers whose step threw, newest first. `npx convex run machines:failedTimers` */
export const failedTimers = machines.internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.object({ machine: v.string(), id: v.string(), event: v.string(), dueAt: v.number() })),
  handler: async (ctx, args) => await machines.failedTimers(ctx, args),
});

/** Delivers a failed timer again, once its bug is fixed.
 * `npx convex run machines:rearmTimer '{"machine": "command", "id": "...", "event": "LEASE_LAPSED"}'` */
export const rearmTimer = machines.internalMutation({
  args: { machine: v.string(), id: v.string(), event: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await machines.rearmTimer(ctx, args);
    return null;
  },
});

/**
 * Delivers again the timers whose job failed, a page of scheduled jobs a
 * run: the deploy runs it after a stepping stone (stepping.ts), as a timer
 * due while its machine was off found nobody to deliver it to, passing back
 * the cursor it returns until it returns null (a string, as `convex run`
 * prints an object over several lines). One that fails again for a bug of
 * its own stays failed. A page, as Convex keeps a week of scheduled jobs with no index on
 * their state, and reading them all in one function went past its 4,096
 * reads (19 Nov 2026). 500 jobs a page leaves room for each failed one's
 * row and its rearm. `npx convex run machines:rearmFailed`
 */
export const rearmFailed = machines.internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { cursor }) => {
    const r = await machines.failedTimersPage(ctx, { cursor: cursor ?? null, numItems: 500 });
    for (const t of r.page) await machines.rearmTimer(ctx, t);
    return r.isDone ? null : r.continueCursor;
  },
});

// History is a fact per step, kept by the component. Commands are gone a day
// after they finish (sync.ts pruneOld), so their history goes after two weeks.
// The cron, daily; a batch a run, again straight away while there's more.
export const HISTORY_KEEP_MS = 14 * 24 * 60 * 60_000;
export const pruneHistory = machines.internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const { more } = await machines.pruneHistory(ctx, { before: Date.now() - HISTORY_KEEP_MS });
    if (more) await ctx.scheduler.runAfter(0, internal.machines.pruneHistory, {});
    return null;
  },
});
