// This deployment's install with the push relay as a state machine
// (docs/push-relay.md, docs/lifecycles.md). Each registration makes the relay
// rotate the install's key, so the key a registration got is the only one
// that works until the next. Before this machine, two notify actions could
// register at once and save their keys in either order: the last save could
// be the dead one, and every push then failed with 401 until one cleared it,
// which also cleared whatever key another send had saved meanwhile. Now one
// send registers at a time (the others wait for its key), a refusal clears
// only the key it was made with, and push.ts registers again and sends that
// push once more.
//
// push.ts's actions call devices.ts's internal mutations, which send these
// events; nothing outside the deployment reaches them, so the role's check
// passes.
import { defineMachine } from '@convex-dev/state-machines';
import { v } from 'convex/values';
import { appSchema } from './schema';
import { RELAY_FAILED_RETRY_MS, RELAY_FRESH_MS, RELAY_REGISTER_MS, RELAY_RETRY_MS } from './relayInstallStates';

export const relayInstall = defineMachine(
  appSchema,
  {
    name: 'relayInstall',
    table: 'relayRegistrations',
    field: 'installState',
    description: "This deployment's install with the push relay, which sends its Android phones' notifications, and its iPhones' when it has no Apple key of its own: registered by one send at a time, as each registration replaces the install's key, and again when the relay refuses the key.",
    callers: {
      backend: "Only the deployment's own push sends register and use the install.",
    },
    events: {
      // attempt: the registering send's own id. The id and key go in the
      // state; history keeps no event's payload.
      backend: {
        REGISTER: { attempt: v.string() },
        ADOPT: { attempt: v.string(), installId: v.string(), installKey: v.string() },
        REGISTERED: { attempt: v.string(), installId: v.string(), installKey: v.string() },
        FAILED: { attempt: v.string() },
        REFUSED: { attempt: v.string() },
      },
    },
    guards: {
      sameAttempt: "It's about another registration than the one the install holds now.",
      lapsed: 'Another send is registering, and has time left to answer.',
    },
    states: {
      start: {
        on: {
          REGISTER: { to: 'registering', effect: 'register', description: 'The first send through the relay registers this deployment with it.' },
          ADOPT: { to: 'registered', effect: 'adopted', description: 'An install registered before this machine (the relayInstall table) is taken over as it is, without registering again.' },
        },
      },
      registering: {
        description: 'A send is registering with the relay. Other sends wait for its key rather than register too, which would replace it.',
        timers: { LAPSED: { at: 'giveUpAt', description: "Forty seconds and the registering send hasn't answered: its action died, or the relay hung." } },
        on: {
          REGISTERED: { to: 'registered', guard: 'sameAttempt', effect: 'registered', description: 'The relay gave the install its id and a new key: every send uses them from now on.' },
          FAILED: { to: 'unregistered', guard: 'sameAttempt', effect: 'failed', description: 'The relay turned the registration down: sends fail at once for a minute, then the next tries again.' },
          REGISTER: { guard: 'lapsed', effect: 'register', description: "The registering send ran out of time before the timer said so: this send registers instead, and the other's answer is dropped." },
          LAPSED: { to: 'unregistered', effect: 'unregistered', description: 'Nothing came of the registration: the next send registers.' },
        },
      },
      registered: {
        description: "Every send uses this install's id and key.",
        on: {
          REFUSED: { to: 'unregistered', guard: 'sameAttempt', effect: 'refused', description: "The relay refused this key (it forgot the install after 90 days unused, or a registration replaced it): the send that saw it registers again and sends once more. A key refused within two minutes of being given waits five minutes." },
        },
      },
      unregistered: {
        description: 'No usable key: the next send registers, after a while if the relay turned the last registration down or refused a new key.',
        on: {
          REGISTER: { to: 'registering', effect: 'register', description: 'A send registers again.' },
        },
      },
    },
  },
  {
    callers: { backend: () => true },
    guards: {
      sameAttempt: (_ctx, { state, event }) => state.attempt === event.attempt,
      lapsed: (_ctx, { state }) => state.giveUpAt <= Date.now(),
    },
    effects: {
      register: async (_ctx, { event }) => ({ kind: 'registering' as const, attempt: event.attempt, giveUpAt: Date.now() + RELAY_REGISTER_MS }),
      registered: async (_ctx, { event }) => ({ kind: 'registered' as const, attempt: event.attempt, installId: event.installId, installKey: event.installKey, at: Date.now() }),
      // Registered before: never taken for a new key (RELAY_FRESH_MS), so its refusal registers again at once.
      adopted: async (_ctx, { event }) => ({ kind: 'registered' as const, attempt: event.attempt, installId: event.installId, installKey: event.installKey, at: 0 }),
      unregistered: async () => ({ kind: 'unregistered' as const, at: Date.now(), retryAt: Date.now() }),
      failed: async () => ({ kind: 'unregistered' as const, at: Date.now(), retryAt: Date.now() + RELAY_FAILED_RETRY_MS }),
      refused: async (_ctx, { state }) => ({ kind: 'unregistered' as const, at: Date.now(), retryAt: Date.now() + (Date.now() - state.at < RELAY_FRESH_MS ? RELAY_RETRY_MS : 0) }),
    },
  },
);
