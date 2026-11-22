// A runner's request for a new thread on another runner, as a state machine
// (docs/lifecycles.md; docs/protocol/runners.md "Asking another runner"). A runner
// on a runner key files it, the main Mac shows Mike its card, and on his
// answer the main Mac's runner (the owner key) claims it, starts the thread
// and marks it allowed, or says no. Runners authenticate with keys in their
// args, not ctx.auth, so each function in relay.ts checks who's asking
// (runnerAuth) before it sends: the roles say who sends what, and their
// checks pass.
//
// `runnerRequests.state`, `claim`, `result` and `decidedAt`, which runners
// read, are written by the effects from the state each one returns
// (requestStates.ts), so they can't drift from the machine.
import { defineMachine } from '@convex-dev/state-machines';
import { v } from 'convex/values';
import { appSchema } from './schema';
import type { Doc } from './_generated/dataModel';
import type { RequestState } from './requestStates';
import { unlessStepping } from './stepping';

const resultV = v.object({ runnerId: v.string(), runnerName: v.string(), threadId: v.string() });

export const request = unlessStepping('requestState', () => defineMachine(
  appSchema,
  {
    name: 'request',
    table: 'runnerRequests',
    field: 'requestState',
    description: "A runner on a runner key asking for a new thread on another runner. It can't start one there itself, so Mike sees exactly what it asked for on the main Mac, whose runner starts it if he allows it.",
    callers: {
      asker: 'Only the runner that asked files or gives up on a request.',
      owner: "Only the main Mac's runner answers a request.",
    },
    events: {
      asker: { FILE: {}, CLOSE: {} },
      owner: { CLAIM: { claim: v.optional(v.string()) }, ALLOW: { result: resultV }, HAND_BACK: {}, DENY: {} },
    },
    guards: {
      sameClaim: 'Another claim has it: it may be starting now.',
    },
    states: {
      start: {
        on: { FILE: { to: 'pending', effect: 'file', description: 'A runner files a request from one of its own threads, which shows a card for it there.' } },
      },
      pending: {
        description: "Mike hasn't answered. The asking thread's card waits up to an hour.",
        on: {
          CLAIM: { to: 'claimed', effect: 'claim', description: "Mike allowed it: the main Mac's runner claims it before starting the thread, so a retry or another click can't start a second." },
          DENY: { to: 'denied', effect: 'deny', description: 'Mike said no.' },
          CLOSE: { to: 'closed', effect: 'close', description: "The asking runner gave up on it: its card expired, or was declined there. It stops counting against that runner's limit." },
        },
      },
      claimed: {
        description: "The main Mac's runner is starting the thread. Nobody else can claim it, and the asking runner can't close it, as it may be starting now.",
        on: {
          CLAIM: { guard: 'sameClaim', description: 'The same claim asking again after its answer was lost: told yes, and nothing changes.' },
          ALLOW: { to: 'allowed', effect: 'allow', description: 'The thread started: the request says where.' },
          HAND_BACK: { to: 'pending', effect: 'handBack', description: "Starting it failed on the main Mac: it waits for Mike again, and the next claim is a new one." },
        },
      },
      allowed: { description: 'The thread was started, on the runner `result` names.' },
      denied: { description: 'Mike said no.' },
      closed: { description: 'The asking runner gave up on it before anyone started it.' },
    },
  },
  {
    callers: { asker: () => true, owner: () => true },
    guards: {
      sameClaim: (_ctx, { state, event }) => state.kind === 'claimed' && event.claim !== undefined && state.claim === event.claim,
    },
    effects: {
      file: async () => ({ kind: 'pending' as const }),
      claim: async (ctx, { id, event }) => {
        const now = Date.now();
        return legacy(ctx, id, { kind: 'claimed', claimedAt: now, ...(event.claim !== undefined ? { claim: event.claim } : {}) }, { claim: event.claim, decidedAt: now });
      },
      // A claim handed back loses its id: the next one is a new claim.
      handBack: async (ctx, { id }) => legacy(ctx, id, { kind: 'pending' }, { claim: undefined, decidedAt: Date.now() }),
      allow: async (ctx, { id, event }) => {
        const now = Date.now();
        return legacy(ctx, id, { kind: 'allowed', decidedAt: now }, { result: { ...event.result }, decidedAt: now });
      },
      deny: async (ctx, { id }) => ended(ctx, id, 'denied'),
      close: async (ctx, { id }) => ended(ctx, id, 'closed'),
    },
  },
));

async function ended<K extends 'denied' | 'closed'>(ctx: { db: unknown }, id: unknown, kind: K): Promise<{ kind: K; decidedAt: number }> {
  const now = Date.now();
  await legacy(ctx, id, { kind, decidedAt: now } as RequestState, { decidedAt: now });
  return { kind, decidedAt: now };
}

// The state's string on the row, as runners and the index read it, with the fields that step sets.
async function legacy<S extends RequestState>(ctx: { db: unknown }, id: unknown, next: S, fields: Partial<Doc<'runnerRequests'>>): Promise<S> {
  // The row's own fields, never its machine's: the guarded db checks that.
  await (ctx.db as { patch(id: unknown, value: object): Promise<void> }).patch(id, { state: next.kind, ...fields });
  return next;
}
