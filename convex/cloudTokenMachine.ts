// A Claude login's cloud token as a state machine (docs/virtual-runners.md,
// decision 10; docs/lifecycles.md). Mike sets one (the in-thread token card:
// made with `claude setup-token` on his Mac, pasted, or that Mac's own
// year-long token); a box whose turn on it is refused says so, which kills
// it, and setting a new one brings it back. `claude auth status` calls any
// token signed in, so a refusal is the only way a dead one shows.
//
// The sealed value, madeAt and setAt are the row's own fields, written by
// boxes.ts storeCloudToken beside SET: never event data, so no sealed value
// is in the machine's history. Boxes authenticate with keys in their args,
// so boxes.ts checks who's asking before it sends.
import { defineMachine } from '@convex-dev/state-machines';
import { v } from 'convex/values';
import { appSchema } from './schema';
import { internal } from './_generated/api';
import { unlessStepping } from './stepping';

export const cloudToken = unlessStepping('tokenState', () => defineMachine(
  appSchema,
  {
    name: 'cloudToken',
    table: 'cloudTokens',
    field: 'tokenState',
    description: "A Claude login's token for the boxes of virtual runners: set by Mike, dead once a box's turn on it is refused, and set again to bring the threads waiting on it back.",
    callers: {
      owner: "Only the main Mac's runner sets a login's cloud token.",
      boxRunner: "Only a box on that login, on its own box key, says Claude refused the token it was given.",
    },
    events: {
      owner: { SET: {} },
      // setAt: the token the box was given (its row's setAt then), so a
      // refusal of an older token never kills a newer one.
      boxRunner: { REFUSED: { setAt: v.number() } },
    },
    guards: {
      sameToken: "It's about the token the row holds now, not one set before it.",
    },
    states: {
      start: {
        on: { SET: { to: 'valid', effect: 'set', description: "Mike sets the login's first cloud token: boxes waiting on the login start." } },
      },
      valid: {
        description: "Boxes on the login are given this token when they start, and run Claude Code on it.",
        on: {
          SET: { effect: 'set', description: 'Mike sets a new token for the login: boxes starting from now get it, and any waiting on the login start.' },
          REFUSED: { to: 'dead', guard: 'sameToken', effect: 'refused', description: 'A box says Claude refused this token (revoked, or past its year): threads on the login show the token card until a new one is set.' },
        },
      },
      dead: {
        description: "Claude refused it. New threads on the login wait for a new token, and the card in their thread asks Mike for one.",
        on: {
          SET: { to: 'valid', effect: 'set', description: 'Mike sets a new token: the boxes waiting on the login start, and boxes waiting after a refusal fetch it and carry on.' },
          REFUSED: { description: 'Another box says the same: it stays dead.' },
        },
      },
    },
  },
  {
    callers: { owner: () => true, boxRunner: () => true },
    guards: {
      sameToken: (_ctx, { row, event }) => row.setAt === event.setAt,
    },
    effects: {
      // Boxes waiting for a token on this login start, a page at a time (boxes.ts releaseForToken).
      set: async (ctx, { row }) => {
        await ctx.scheduler.runAfter(0, internal.boxes.releaseForToken, { login: row.login });
        return { kind: 'valid' as const };
      },
      refused: async () => ({ kind: 'dead' as const, at: Date.now() }),
    },
  },
));
