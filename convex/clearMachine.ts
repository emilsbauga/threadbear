// A thread id's clear as a state machine (docs/lifecycles.md): a thread
// removed, or taken over by the owner, whose old rows (messages, pictures,
// tool output) are more than one mutation may read. They go in runs of
// their own (sync.ts dropThreadRows), and the id is closed to every write
// until they have. Before this machine, a run that threw was never started
// again, so the id stayed closed for good: every write under it skipped.
//
// The backend's own mutations start and finish a clear (sync.ts
// clearThread, called once the caller's key is checked), so the role's
// check passes; the runs report as the server.
import { defineMachine } from '@convex-dev/state-machines';
import { v } from 'convex/values';
import { appSchema } from './schema';
import { internal } from './_generated/api';
import { CLEAR_RETRY_MS } from './clearStates';
import { unlessStepping } from './stepping';

export const clear = unlessStepping('clearState', () => defineMachine(
  appSchema,
  {
    name: 'clear',
    table: 'threadClears',
    field: 'clearState',
    description: "A thread id's old rows going a run at a time, after the thread was removed or taken over by the main Mac. Nothing is written under the id until they've gone.",
    callers: {
      backend: "Only the backend's own mutations start and finish a clear, once they've checked the runner's key.",
    },
    events: {
      backend: { CLEAR: { moving: v.boolean() }, REMOVED: {}, OWNER_WROTE: {} },
      server: { PROGRESS: {}, DRAINED: {} },
    },
    guards: {
      moving: "It isn't for a takeover.",
    },
    states: {
      start: {
        on: { CLEAR: { to: 'clearing', effect: 'start', description: "A thread removed, or taken over by the main Mac, with more rows than one mutation may read: the rest go in runs of their own." } },
      },
      clearing: {
        description: 'Its rows going, a run at a time. Every write under the id is skipped meanwhile (the main Mac sends its again).',
        timers: { STALLED: { at: 'retryAt', description: 'Ten minutes with no run moving it on: a run threw, or was lost.' } },
        on: {
          PROGRESS: { effect: 'progress', description: 'A run deleted what it could read; another follows, and the ten minutes start again.' },
          STALLED: { effect: 'restart', description: 'The runs start again from where the rows are: each deletes what it reads.' },
          REMOVED: { effect: 'removed', description: 'The thread is removed while its rows go: no takeover to finish, so the id opens once they have.' },
          DRAINED: [
            { to: 'awaitingOwner', guard: 'moving', effect: 'awaiting', description: "All gone, for a takeover: the main Mac's next write of the thread goes through." },
            { to: 'cleared', description: 'All gone: the id opens again.' },
          ],
        },
      },
      awaitingOwner: {
        description: "Its old rows are gone. The id stays closed to the runner that had it until the main Mac's write of the thread takes it over.",
        on: {
          OWNER_WROTE: { to: 'cleared', description: "The main Mac's write of the thread goes through: it's the main Mac's now." },
          REMOVED: { to: 'cleared', description: 'The thread is removed before the main Mac wrote it: the id opens.' },
        },
      },
      cleared: { description: 'Done with: the row goes in the same mutation, and the id opens.' },
    },
  },
  {
    callers: { backend: () => true },
    guards: {
      moving: (_ctx, { state }) => state.moving,
    },
    effects: {
      start: async (ctx, { event }) => {
        // Its first run. A machine's create has no id yet, so the run finds the row by the thread.
        return { kind: 'clearing' as const, moving: event.moving, retryAt: Date.now() + CLEAR_RETRY_MS };
      },
      progress: async (_ctx, { state }) => ({ ...state, retryAt: Date.now() + CLEAR_RETRY_MS }),
      restart: async (ctx, { state, row }) => {
        await ctx.scheduler.runAfter(0, internal.sync.dropThreadRows, { threadId: row.threadId });
        return { ...state, retryAt: Date.now() + CLEAR_RETRY_MS };
      },
      removed: async (_ctx, { state }) => ({ ...state, moving: false }),
      awaiting: async () => ({ kind: 'awaitingOwner' as const }),
    },
  },
));
