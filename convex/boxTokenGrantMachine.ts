// A box's report quarantines its own grant, never the shared login token.
// Only the boot exchange or an owner SET issues a token to the box.
import { defineMachine } from '@convex-dev/state-machines';
import { v } from 'convex/values';
import { appSchema } from './schema';

export const boxTokenGrant = defineMachine(appSchema, {
  name: 'boxTokenGrant', table: 'boxTokenGrants', field: 'grantState',
  description: 'The token version a box may receive: issued at boot, quarantined on its own refusal, and released only by an owner-set replacement.',
  callers: { backend: 'Only the authenticated boot exchange and owner SET issue a grant.', grantHolder: 'An authenticated box may report refusal only for its own grant.' },
  events: { backend: { ISSUE: { setAt: v.number() }, QUARANTINE: { setAt: v.number(), afterSetAt: v.number() } }, grantHolder: { REFUSED: { setAt: v.number(), afterSetAt: v.number() } } },
  guards: { sameToken: 'The refusal names exactly the token this grant issued.' },
  states: {
    start: { on: {
      ISSUE: { to: 'issued', effect: 'issue', description: 'The boot exchange issues its token version to this box key.' },
      QUARANTINE: { to: 'refused', effect: 'refuse', description: 'A legacy box has no recorded grant: its report waits for an owner-set replacement.' },
    } },
    issued: { description: 'This box may fetch only this token version.', on: {
      ISSUE: { effect: 'issue', description: 'A new boot key receives its own token version.' },
      QUARANTINE: { to: 'refused', effect: 'refuse', description: 'A legacy key replaces an older grant and waits for owner approval.' },
      REFUSED: { to: 'refused', guard: 'sameToken', effect: 'refuse', description: 'The box reports refusal: only this grant is quarantined.' },
    } },
    refused: { description: 'The reporting box cannot fetch a replacement until the owner approves one.', on: {
      REFUSED: { description: 'A repeated report changes no grant or login state.' },
      QUARANTINE: { effect: 'refuse', description: 'A legacy key replaces an older quarantined grant.' },
      ISSUE: { to: 'issued', effect: 'issue', description: 'The owner sets a new token after this report, or a new boot exchange issues one.' },
    } },
  },
}, {
  callers: { backend: () => true, grantHolder: () => true },
  guards: { sameToken: (_ctx, { row, event }) => row.grantState.setAt === event.setAt },
  effects: {
    issue: async (_ctx, { event }) => ({ kind: 'issued' as const, setAt: event.setAt }),
    refuse: async (_ctx, { event }) => ({ kind: 'refused' as const, setAt: event.setAt, afterSetAt: event.afterSetAt, reportedAt: Date.now() }),
  },
});
