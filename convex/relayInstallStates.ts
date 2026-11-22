// This deployment's install with the push relay, as its state machine holds
// it (convex/relayInstallMachine.ts, docs/push-relay.md, docs/lifecycles.md):
// one member per state, each with only its own data. One row per relay
// address (relayRegistrations).
import { v, type Infer } from 'convex/values';

// How long one registration may take before another send may start its own:
// the relay's /register calls this deployment back (/relay/verify) before it
// answers, so it's a few seconds, and push.ts gives up on it after
// RELAY_REGISTER_TIMEOUT_MS.
export const RELAY_REGISTER_MS = 40_000;
export const RELAY_REGISTER_TIMEOUT_MS = 20_000;
// The relay asks this deployment to confirm a registration (/relay/verify)
// before it gives the install a new key. It's told yes only while the
// registering send is still waiting for the answer (its fetch gives up
// RELAY_REGISTER_TIMEOUT_MS after its check was made), and a send only makes
// its check with that long and this long again left of its lease. So the
// relay never confirms a registration nobody is waiting for, and one it
// confirmed has at least this long to finish before another send may
// register: a send that got no answer keeps the install until its time is up
// (push.ts register).
export const RELAY_VERIFY_SPARE_MS = 8_000;
// After the relay turned a registration down: how long sends wait before
// registering again.
export const RELAY_FAILED_RETRY_MS = 60_000;
// A key the relay refuses within RELAY_FRESH_MS of giving it (by any send):
// the relay is refusing new keys, so sends wait RELAY_RETRY_MS before
// registering again rather than use up its 20 a day.
export const RELAY_FRESH_MS = 2 * 60_000;
export const RELAY_RETRY_MS = 5 * 60_000;

export const installStateV = v.union(
  // A send is registering with the relay. `attempt`: that send's own id, so
  // only its answer is kept. `giveUpAt`: when another send may register
  // instead, if this one hasn't answered (its action died, or the relay hung).
  v.object({ kind: v.literal('registering'), attempt: v.string(), giveUpAt: v.number() }),
  // The relay gave this install id and key, and every send uses them. `at`:
  // when, so a refusal soon after is told from an old key's (RELAY_FRESH_MS).
  // `attempt`: the registration that got them, so a send that saw them
  // refused clears these and not a newer pair. The key is taken out of what
  // the Machines page shows (viewer.ts SECRET_FIELDS).
  v.object({ kind: v.literal('registered'), attempt: v.string(), installId: v.string(), installKey: v.string(), at: v.number() }),
  // No usable key: the relay refused the last one (it forgot the install,
  // or another registration replaced it), or registering failed. The next
  // send from `retryAt` registers; until then sends fail at once, so a
  // relay turning registrations down (or refusing each new key) isn't asked
  // by every send, using up its 20 a day. `at`: since when.
  v.object({ kind: v.literal('unregistered'), at: v.number(), retryAt: v.number() }),
);
export type InstallState = Infer<typeof installStateV>;
