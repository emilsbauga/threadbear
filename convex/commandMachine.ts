// A command's lifecycle as a state machine (docs/lifecycles.md): something the
// phone, the website or the main Mac asked a runner to do. The rules are the
// first argument and the code behind their names the second. The runner,
// the phone and the main Mac authenticate with keys and tokens in their
// args, not ctx.auth, so each function checks who's asking itself
// (runnerAuth, checkPhoneToken, mayTake) before it sends: the roles say who
// sends what, and their checks pass.
//
// `commands.state`, the four strings every client reads, is written by the
// effects from the state each one returns (commandStates.ts), so it can't
// drift from the machine.
import { defineMachine } from '@convex-dev/state-machines';
import { v } from 'convex/values';
import { appSchema } from './schema';
import { internal } from './_generated/api';
import { legacyState, type CommandState } from './commandStates';
import { unlessStepping } from './stepping';

// How long a command waits for its runner, and how long a taken one has to finish (sync.ts).
export const COMMAND_KEEP_MS = 14 * 24 * 60 * 60_000;
export const TAKEN_LEASE_MS = 3 * 60 * 60_000;

const finish = [
  { to: 'done', guard: 'worked', effect: 'done', description: 'Its runner says it worked.' },
  { to: 'failed', effect: 'failed', description: "Its runner says it didn't work, and why." },
] as const;

export const command = unlessStepping('commandState', () => defineMachine(
  appSchema,
  {
    name: 'command',
    table: 'commands',
    field: 'commandState',
    description: 'Something the phone, the website or the main Mac asked a runner to do: it waits for its runner, which takes it once, runs it and says how it went.',
    callers: {
      sender: 'Only the phone, the website or the main Mac queues a command.',
      phone: 'Only a phone or browser with a token takes a message back.',
      runner: "Only the command's own runner takes and finishes it.",
    },
    events: {
      sender: { QUEUE: {} },
      phone: { CANCEL: {} },
      runner: { TAKE: { attempt: v.optional(v.string()) }, FINISH: { ok: v.boolean() }, THREAD_ELSEWHERE: {} },
      server: { EXPIRE: {}, LAPSE: {} },
    },
    guards: {
      worked: "Its runner said it didn't work.",
      sameAttempt: 'Another take has it.',
    },
    states: {
      start: {
        on: { QUEUE: { to: 'pending', effect: 'queue', description: 'The phone, the website or the main Mac asks a runner to do something: a message, a new thread, a setting.' } },
      },
      pending: {
        description: 'Waiting for its runner to take it: the runner may be asleep. The phone can still take a message back.',
        timers: { EXPIRED: { after: COMMAND_KEEP_MS, description: 'Two weeks have passed and its runner never took it.' } },
        on: {
          TAKE: { to: 'taken', effect: 'take', description: 'Its runner takes it, once: any other take is refused.' },
          CANCEL: { to: 'failed', effect: 'cancel', description: 'The phone takes the message back before its runner has it.' },
          THREAD_ELSEWHERE: { to: 'failed', effect: 'elsewhere', description: 'Its thread moved to another runner or was deleted before it was taken, so this runner never runs it.' },
          EXPIRED: { to: 'failed', effect: 'expire', description: 'Nobody took it in two weeks.' },
          EXPIRE: { to: 'failed', effect: 'expire', description: 'The sweep finds it waiting past two weeks (rows from before timers).' },
        },
      },
      taken: {
        description: 'Its runner has it and is running it. Asked again by the same take (its answer was lost), it says yes; nobody else gets it.',
        timers: { LEASE_LAPSED: { after: TAKEN_LEASE_MS, description: 'Three hours have passed and its runner never said how it went: it stopped partway, or has been away too long.' } },
        on: {
          TAKE: { guard: 'sameAttempt', description: 'The same take asking again after its answer was lost: told yes, and nothing changes.' },
          FINISH: finish,
          LEASE_LAPSED: { to: 'lapsed', effect: 'lapse', description: 'It lapses, shown as failed. It is never handed out again, as it may have run.' },
          LAPSE: { to: 'lapsed', effect: 'lapse', description: 'The sweep finds it taken past its lease (rows from before timers).' },
        },
      },
      lapsed: {
        description: "Its runner never said how it went within the lease. Shown as failed; its runner's late answer still settles it.",
        on: { FINISH: finish },
      },
      done: { description: 'Its runner ran it and it worked.' },
      failed: { description: "It didn't happen or didn't work: its runner said so, the phone took it back, nobody took it in time, or its thread moved or went." },
    },
  },
  {
    callers: { sender: () => true, phone: () => true, runner: () => true },
    guards: {
      worked: (_ctx, { event }) => event.ok,
      sameAttempt: (_ctx, { state, event }) => state.kind === 'taken' && event.attempt !== undefined && state.attempt === event.attempt,
    },
    effects: {
      queue: async () => ({ kind: 'pending' as const }),
      take: async (ctx, { id, event }) => legacy(ctx, id, { kind: 'taken', takenAt: Date.now(), ...(event.attempt !== undefined ? { attempt: event.attempt } : {}) }),
      done: async (ctx, { id }) => legacy(ctx, id, { kind: 'done', doneAt: Date.now() }),
      failed: async (ctx, { id }) => legacy(ctx, id, { kind: 'failed', doneAt: Date.now() }),
      cancel: async (ctx, { id }) => legacy(ctx, id, { kind: 'failed', doneAt: Date.now() }),
      elsewhere: async (ctx, { id }) => legacy(ctx, id, { kind: 'failed', doneAt: Date.now() }),
      // Its words and photos go, and it says why (sync.ts commandEnded):
      // scheduled, as sync.ts sends this machine its events.
      expire: async (ctx, { id }) => {
        await ctx.scheduler.runAfter(0, internal.sync.commandEnded, { commandId: id, why: 'expired' });
        return legacy(ctx, id, { kind: 'failed', doneAt: Date.now() });
      },
      lapse: async (ctx, { id }) => {
        const now = Date.now();
        await ctx.scheduler.runAfter(0, internal.sync.commandEnded, { commandId: id, why: 'lapsed' });
        return legacy(ctx, id, { kind: 'lapsed', doneAt: now, lapsedAt: now });
      },
    },
  },
));

// The state's string and timestamps on the row, as clients and the indexes read them.
async function legacy<S extends CommandState>(ctx: { db: unknown }, id: unknown, next: S): Promise<S> {
  const at = 'takenAt' in next ? { takenAt: next.takenAt, ...(next.attempt !== undefined ? { attempt: next.attempt } : {}) } : 'doneAt' in next ? { doneAt: next.doneAt, lapsedAt: 'lapsedAt' in next ? next.lapsedAt : undefined } : {};
  // The row's own fields, never its machine's: the guarded db checks that.
  await (ctx.db as { patch(id: unknown, value: object): Promise<void> }).patch(id, { state: legacyState(next), ...at });
  return next;
}
