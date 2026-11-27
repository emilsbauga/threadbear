// A Claude login's cloud token as a state machine (docs/virtual-runners.md,
// decision 10; docs/lifecycles.md). Mike sets one (the in-thread token card:
// made with `claude setup-token` on his Mac, pasted, or that Mac's own
// year-long token). Reports of provider refusal are scoped to each box's
// boxTokenGrantMachine; they never invalidate this shared login token.
// The dead state remains readable for rows written by older backends.
//
// The sealed value, madeAt and setAt are the row's own fields, written by
// boxes.ts storeCloudToken beside SET: never event data, so no sealed value
// is in the machine's history. Boxes authenticate with keys in their args,
// so boxes.ts checks who's asking before it sends.
import { defineMachine } from '@convex-dev/state-machines';
import { appSchema } from './schema';
import { internal } from './_generated/api';
import { unlessStepping } from './stepping';

export const cloudToken = unlessStepping('tokenState', () => defineMachine(
  appSchema,
  {
    name: 'cloudToken',
    table: 'cloudTokens',
    field: 'tokenState',
    description: "A Claude login's token for the boxes of virtual runners: set by the owner, with box-specific refusal handled by each box token grant.",
    callers: {
      owner: "Only the main Mac's runner sets a login's cloud token.",
    },
    events: {
      owner: { SET: {} },
    },
    states: {
      start: {
        on: { SET: { to: 'valid', effect: 'set', description: "Mike sets the login's first cloud token: boxes waiting on the login start." } },
      },
      valid: {
        description: "Boxes on the login are given this token when they start, and run Claude Code on it.",
        on: {
          SET: { effect: 'set', description: 'Mike sets a new token for the login: boxes starting from now get it, and any waiting on the login start.' },
        },
      },
      dead: {
        description: "An older backend marked the login token dead. An owner SET restores it; box reports can no longer enter this state.",
        on: {
          SET: { to: 'valid', effect: 'set', description: 'Mike sets a new token: the boxes waiting on the login start, and boxes waiting after a refusal fetch it and carry on.' },
        },
      },
    },
  },
  {
    callers: { owner: () => true },
    effects: {
      // Boxes waiting for a token on this login start, a page at a time (boxes.ts releaseForToken).
      set: async (ctx, { row }) => {
        await ctx.scheduler.runAfter(0, internal.boxes.releaseForToken, { login: row.login });
        return { kind: 'valid' as const };
      },
    },
  },
));
