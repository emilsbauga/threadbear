// A virtual runner's box as its state machine holds it (convex/boxMachine.ts,
// docs/virtual-runners.md, docs/lifecycles.md): one member per state, each
// with only its own data. Every deadline is a time in the state's data, so
// its timer is armed for that time.
import { v, type Infer } from 'convex/values';

// A box that hasn't traded its boot token for its key by then never will:
// the token lasts as long (decision 5).
export const BOOT_MS = 10 * 60_000;
// A box that's awake but hasn't heartbeated for this long is lost (decision 12).
export const LEASE_MS = 5 * 60_000;
// A box asked to save that hasn't said it has by then stays up, and is asked again later.
export const SAVE_MS = 10 * 60_000;
// A wake whose box hasn't come up in this long stops: its box (if the
// provider has it running) is paused, and the thread sleeps as it was.
export const WAKE_GRACE_MS = 15 * 60_000;

export const boxStateV = v.union(
  // Its login has no cloud token, or only a refused one: nothing is asked
  // of the provider, and its create waits, until one is set (TOKEN_SET).
  v.object({ kind: v.literal('needsToken'), since: v.number() }),
  // Its login has a token, but its virtual runner has maxBoxes up or
  // starting: it starts, oldest first, as room frees (boxes.ts wakeWaiting).
  v.object({ kind: v.literal('waitingForRoom'), since: v.number() }),
  // The service is asking the provider for the thread's first box.
  // `bootBy`: when it fails if no box has traded its boot token by then.
  v.object({ kind: v.literal('creating'), bootBy: v.number() }),
  // The provider has the box (providerBoxId on the row); it's booting and
  // will trade its boot token for its key.
  v.object({ kind: v.literal('starting'), bootBy: v.number() }),
  // Its runner is up, on its box key. `since`: when it woke, for the day's
  // awake time. `leaseUntil`: when it's lost unless it has heartbeated.
  v.object({ kind: v.literal('awake'), since: v.number(), leaseUntil: v.number() }),
  // Asked to save the thread out of the box before it sleeps (decision 7).
  // `saveBy`: when it stays awake again if no save came. `capped`: asked
  // because it's been up its day's hours, so by then it sleeps all the
  // same, unsaved: paused (nothing lost) or, if it can't pause, deleted.
  v.object({ kind: v.literal('saving'), since: v.number(), leaseUntil: v.number(), saveBy: v.number(), capped: v.optional(v.boolean()) }),
  // Saved and slept: the box is paused if the provider can, else deleted.
  // Whether its box may hold work newer than its save is the row's
  // workAttempts, and nothing else (invariant W).
  v.object({ kind: v.literal('asleep'), since: v.number(), unsaved: v.optional(v.boolean()) }),
  // Coming back for a message: the paused box resumed, or a new one
  // restored from the last save.
  // `since`: when it began waking, which bounds how long a box may run
  // while it does (boxService.ts entitled, WAKE_GRACE_MS).
  v.object({ kind: v.literal('waking'), bootBy: v.number(), since: v.optional(v.number()) }),
  // Archived while up: the box is asked to save first, so unarchiving
  // comes back to where it was. `since`, `leaseUntil` as awake's; `saveBy`:
  // when it's shelved (paused, kept) if no save came.
  v.object({ kind: v.literal('archiving'), since: v.number(), leaseUntil: v.number(), saveBy: v.number() }),
  // Archived, but its save didn't come: its box is kept paused, as that's
  // where its work is, until deleteAfterDays. Unarchiving resumes it.
  v.object({ kind: v.literal('shelved'), at: v.number() }),
  // Archived: the provider is deleting the box.
  v.object({ kind: v.literal('destroying'), since: v.number() }),
  // Asleep past its virtual runner's days: its boxes (`attempts`, named
  // when retirement began, their key revoked then) are being deleted. A
  // message waits; once the provider confirms them gone it's asleep again,
  // with no box, and comes back from its last save (boxService.ts retireBox).
  // `archived`: archived or deleted meanwhile, which it goes on to once done.
  v.object({ kind: v.literal('retiring'), since: v.number(), attempts: v.array(v.number()), archived: v.optional(v.boolean()) }),
  // Archived and its box deleted. The row stays for its save until
  // deleteAfterDays: a message (unarchiving it) brings it back on a new box.
  v.object({ kind: v.literal('gone'), at: v.number() }),
  // Archived with no save, or its save deleted after deleteAfterDays: the
  // thread can't come back. What's sent to it fails, saying so.
  v.object({ kind: v.literal('expired'), at: v.number() }),
  // A box couldn't be started or brought back. The thread and its save are
  // kept; the next message tries again.
  v.object({ kind: v.literal('failed'), at: v.number(), error: v.string() }),
);
export type BoxState = Infer<typeof boxStateV>;
