// A thread's box on a virtual runner as a state machine (docs/virtual-runners.md,
// decisions 3, 5, 6 and 7; docs/lifecycles.md). The main Mac starts the
// thread's box and archives it; the runner in the box says when it has traded its
// boot token for its key (boxes.ts exchange) and when it has saved the
// thread; the service's own actions and crons say what the provider did.
// Boxes authenticate with keys and boot tokens in their args, not ctx.auth,
// so each function in boxes.ts and sync.ts checks who's asking before it
// sends: the roles say who sends what, and their checks pass.
//
// A box's key (`boxKeyHash` on the row) is good while the row says so: the
// effects clear it whenever a box is replaced, archived or fails, so a lost
// box's key is refused from the step that gives up on it.
//
// Every step that needs the provider schedules the service's action for it
// (boxService.ts): a box to wake or replace (wakeBox), one to pause or
// delete once it has saved (sleepBox), and one to delete when the thread is
// archived (destroyBox), and another create for a box lost while it was
// being made (createBox). The first box's create is scheduled by boxes.ts
// addBox, as the row has no id while its START runs. Each
// action reads the row again and acts on its newest attempt only, so one
// scheduled twice, or late, does nothing more.
import { defineMachine } from '@convex-dev/state-machines';
import { v } from 'convex/values';
import { appSchema } from './schema';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { BOOT_MS, LEASE_MS, SAVE_MS, WAKE_GRACE_MS } from './boxStates';
import { wakeIfPending } from './boxHooks';

type Box = Doc<'boxes'>;
const ERROR_CHARS = 500;

export const box = defineMachine(
  appSchema,
  {
    name: 'box',
    table: 'boxes',
    field: 'boxState',
    description: "A thread's box on a virtual runner: made when the thread starts, saved and slept when it's idle, woken for a message (the same box resumed, or a new one from the save), and deleted when the thread is archived. Every box that runs the thread is the same runner, each on a key of its own.",
    callers: {
      owner: "Only the main Mac's runner starts or archives a thread's box.",
      runner: "Only the runner in the thread's own box, on its boot token or key, says it's up or saved.",
    },
    events: {
      owner: { START: {}, ARCHIVE: {} },
      runner: { READY: {}, SAVED: { storageId: v.id('_storage'), bytes: v.number() } },
      // `attempt`: which box the event is about (boxes.ts mintBootToken numbers
      // each), on every event about one box. Without one, it's taken to be
      // about the newest (a loss: every box's so far). WAKE is the thread's.
      server: { TOKEN_SET: {}, ROOM: {}, CREATED: { providerBoxId: v.string(), attempt: v.optional(v.number()) }, IDLE: { attempt: v.optional(v.number()), capped: v.optional(v.boolean()) }, WAKE: {}, EXPIRE: {}, RESUMED: { attempt: v.optional(v.number()) }, LOST: { attempt: v.optional(v.number()) }, DESTROYED: {}, FAILED: { error: v.string(), attempt: v.optional(v.number()) }, PAUSED: { attempt: v.optional(v.number()) }, RETIRE: { sleptAt: v.number() }, RETIRED: {}, PURGE: {} },
    },
    guards: {
      heardFrom: "The box hasn't heartbeated within the lease.",
      resumable: "Only the box holding the thread's key resumes, and only while no newer box has been asked for: otherwise a new box has to start.",
      notStale: 'It names an older attempt at a box than the newest one this thread has: it changes nothing of the newer one.',
      unexchanged: "It's about the newest attempt, and that attempt's box hasn't traded its boot token or made any work: a late failure of a box that's already working changes nothing.",
      newBox: 'That box has already traded its boot token, or is older than the newest: its news is only its provider id.',
      capped: "It was asked to save because it's been up its day's hours, not for being idle.",
      keptBox: "The box coming back is the one that holds the thread's key: it may hold work newer than the last save.",
      holdsWork: 'A box of the thread may hold work newer than the newest save it made.',
      sameSleep: 'Still the sleep the retirement was planned on.',
      archivedRetiring: 'It was archived while it retired.',
      archivedWithSave: 'It was archived while it retired, and has a save.',
      stillWaking: 'A box of the thread may hold work newer than its save, and the wake has gone on less than fifteen minutes.',
      wakeOverdue: 'It has been waking more than fifteen minutes, and the event is about the newest attempt.',
      hasSave: 'The thread has a save to come back from.',
      hasToken: "Its login has a cloud token that no box's turn has been refused on.",
    },
    states: {
      start: {
        on: {
          START: [
            { to: 'creating', guard: 'hasToken', effect: 'start', description: 'A thread starts on a virtual runner: the service asks the provider for its first box, with a boot token and nothing reusable in its environment.' },
            { to: 'needsToken', effect: 'awaitToken', description: "A thread starts on a virtual runner with a login that has no cloud token, or only a refused one: nothing is asked of the provider until Mike sets one, from the card in the thread." },
          ],
        },
      },
      needsToken: {
        description: "Waiting for a cloud token for its login. No box, no key and nothing billed; its first message waits in the queue, and the thread shows the token card.",
        on: {
          TOKEN_SET: { to: 'waitingForRoom', effect: 'awaitRoom', description: "Mike set a token for the login: it joins its virtual runner's queue for room, in the order the threads started, so it never passes one that was waiting before it (boxes.ts wakeWaiting starts it at once if there's room)." },
          ARCHIVE: { to: 'expired', effect: 'archiveUnstarted', description: 'Mike archives the thread before it ever ran: nothing was made or saved, so it ends.' },
        },
      },
      waitingForRoom: {
        description: "Its login has a token, but its virtual runner has maxBoxes up or starting. No box and nothing billed; its first message waits in the queue. Those waiting start oldest first as room frees (a box sleeps, fails or is archived, or at the idle check).",
        on: {
          ROOM: [
            { to: 'creating', guard: 'hasToken', effect: 'tokenSet', description: "There's room now, and its login's token is still good: the service asks the provider for the thread's first box." },
            { to: 'needsToken', effect: 'awaitToken', description: "There's room, but a box's turn was refused on its login's token meanwhile: it waits for a token again, using none of the room, rather than start a machine that would be refused too." },
          ],
          ARCHIVE: { to: 'expired', effect: 'archiveUnstarted', description: 'Mike archives the thread before it ever ran: nothing was made or saved, so it ends.' },
        },
      },
      creating: {
        description: "The service is asking the provider for the thread's first box.",
        timers: { BOOT_TIMEOUT: { at: 'bootBy', description: "Ten minutes have passed and no box has traded the thread's boot token for its key." } },
        on: {
          CREATED: { to: 'starting', guard: 'newBox', effect: 'created', description: 'The provider has made the box, which boots and starts its runner.' },
          READY: { to: 'awake', effect: 'ready', description: "The box booted and traded its boot token for its key before the provider's answer came back." },
          FAILED: { to: 'failed', guard: 'unexchanged', effect: 'fail', description: "The provider couldn't make a box." },
          LOST: { effect: 'createAgain', description: 'The provider lost the box it was making: the service makes another before the ten minutes are up.' },
          BOOT_TIMEOUT: { to: 'failed', effect: 'bootTimeout', description: 'No box checked in: the thread waits for the next message to try again.' },
          ARCHIVE: [
            { to: 'shelved', guard: 'holdsWork', effect: 'shelve', description: 'Mike archives the thread while a box of it may hold work newer than its save: that box is kept.' },
            { to: 'destroying', effect: 'archive', description: 'Mike archives the thread before its box is up.' },
          ],
        },
      },
      starting: {
        description: 'The box is booting: its runner will trade the boot token for its box key, the login token and the thread key.',
        timers: { BOOT_TIMEOUT: { at: 'bootBy', description: "Ten minutes have passed since the box was asked for, and it hasn't traded its boot token." } },
        on: {
          READY: { to: 'awake', effect: 'ready', description: 'The box traded its boot token: its key is the only one for the thread from now on.' },
          CREATED: { guard: 'notStale', effect: 'created', description: "The provider's id for the booting box, or for a newer attempt's box (the last was lost or given up on), which boots in its place." },
          FAILED: { to: 'failed', guard: 'unexchanged', effect: 'fail', description: "The provider says the box didn't start." },
          LOST: [
            { to: 'waking', guard: 'notStale', effect: 'bootLost', description: 'The box was lost while it booted: no key or boot token of it works, and a new box is made, restoring the last save if there is one.' },
            { effect: 'forgetOldBox', description: "An older box's loss, reported late: only what was that box's goes." },
          ],
          BOOT_TIMEOUT: { to: 'failed', effect: 'bootTimeout', description: 'The box never checked in: the thread waits for the next message to try again.' },
          ARCHIVE: [
            { to: 'shelved', guard: 'holdsWork', effect: 'shelve', description: 'Mike archives the thread while a box of it may hold work newer than its save: that box is kept.' },
            { to: 'destroying', effect: 'archive', description: 'Mike archives the thread while its box boots.' },
          ],
        },
      },
      awake: {
        description: "The box's runner is running the thread, on its own box key, and heartbeats every minute.",
        timers: { LEASE_DUE: { at: 'leaseUntil', description: 'Five minutes since the lease was last renewed: the box must have heartbeated meanwhile.' } },
        on: {
          LEASE_DUE: [
            { guard: 'heardFrom', effect: 'renewLease', description: 'It has heartbeated: the lease runs five minutes from its last heartbeat.' },
            { effect: 'unheard', description: "No heartbeat for five minutes: it's marked unreachable and the provider is asked about the box (checkBox). Only the provider saying the box is gone (LOST) replaces it; until then it keeps its key, and its time counts." },
          ],
          LOST: [
            { to: 'waking', guard: 'notStale', effect: 'lost', description: "The provider says the box is gone: its key is refused from now, and a new box restores the thread from its last save." },
            { effect: 'forgetOldBox', description: "An older box's loss, reported late: only what was that box's goes." },
          ],
          IDLE: { to: 'saving', guard: 'notStale', effect: 'askSave', description: "The thread has been idle a while (or the box has been up its day's hours): the box is asked to save the thread before it sleeps." },
          SAVED: { effect: 'saved', description: 'The box saved the thread unasked: the save replaces the last one, and it stays awake.' },
          PAUSED: { to: 'asleep', guard: 'notStale', effect: 'pausedByGuard', description: "The billing guard paused the box (past its day's hours, or silent past its lease): the thread sleeps as it was." },
          CREATED: { guard: 'notStale', effect: 'noteBox', description: "The provider's id for the box that's up, arriving late: kept, for pausing and deleting it." },
          ARCHIVE: { to: 'archiving', effect: 'askArchiveSave', description: 'Mike archives the thread: the box is asked to save it first, so unarchiving comes back to where it was.' },
        },
      },
      archiving: {
        description: 'The thread is archived while its box is up: the box is saving it before it goes, as it would to sleep.',
        timers: {
          LEASE_DUE: { at: 'leaseUntil', description: 'Five minutes since the lease was last renewed: the box must have heartbeated meanwhile.' },
          SAVE_TIMEOUT: { at: 'saveBy', description: "Ten minutes have passed and the box hasn't said it saved." },
        },
        on: {
          SAVED: { to: 'destroying', effect: 'savedAndGo', description: 'The save is in: the box is deleted, and the save stays for unarchiving.' },
          SAVE_TIMEOUT: { to: 'shelved', effect: 'shelve', description: "No save came: the box is kept, paused if it can be, as it's where the work is." },
          LEASE_DUE: [
            { guard: 'heardFrom', effect: 'renewLease', description: 'It has heartbeated: the lease runs five minutes from its last heartbeat.' },
            { to: 'shelved', effect: 'shelve', description: "No heartbeat for five minutes: no save will come, but the box may still hold the work, so it's kept." },
          ],
          LOST: [
            { to: 'destroying', guard: 'notStale', effect: 'archiveLost', description: 'The provider lost the box mid-save: what remains of it is deleted, and the last save stays.' },
            { effect: 'forgetOldBox', description: "An older box's loss, reported late: only what was that box's goes." },
          ],
          CREATED: { guard: 'notStale', effect: 'noteBox', description: "The provider's id for the box, arriving late: kept, for deleting it." },
          WAKE: { to: 'awake', effect: 'stayUp', description: 'Unarchived, or a message, while it saved: the box stays up.' },
          PAUSED: { to: 'shelved', guard: 'notStale', effect: 'shelve', description: 'The billing guard paused the box mid-save: it is kept, paused.' },
        },
      },
      shelved: {
        description: "Archived, its save never came: its box is kept, paused if it can be, until deleteAfterDays, as that's where the work is.",
        on: {
          WAKE: { to: 'waking', effect: 'wake', description: 'Unarchived, or a message: the kept box is resumed.' },
          LOST: [
            { to: 'gone', guard: 'hasSave', effect: 'shelfLost', description: "The kept box is gone (or couldn't pause, so it was deleted): only the last save is left." },
            { to: 'expired', effect: 'shelfLost', description: "The kept box is gone, and there's no save: the thread can't come back." },
          ],
          EXPIRE: { to: 'expired', effect: 'expireShelf', description: 'deleteAfterDays have passed: the kept box and any save are deleted.' },
          SAVED: { to: 'destroying', effect: 'savedShelf', description: 'The kept box (one that can only be kept running) saved at last: the save is in, and the box goes.' },
          CREATED: { guard: 'notStale', effect: 'noteBox', description: "The provider's id for the kept box, arriving late: kept, to resume or delete it." },
        },
      },
      saving: {
        description: 'The box is saving the thread out of itself: committing and pushing its work, and uploading the folder and transcript sealed with the thread key.',
        timers: {
          LEASE_DUE: { at: 'leaseUntil', description: 'Five minutes since the lease was last renewed: the box must have heartbeated meanwhile.' },
          SAVE_TIMEOUT: { at: 'saveBy', description: "Ten minutes have passed and the box hasn't said it saved." },
        },
        on: {
          SAVED: { to: 'asleep', effect: 'sleep', description: 'The save is in: it replaces the last one, and the box is paused if the provider can, else deleted.' },
          CREATED: { guard: 'notStale', effect: 'noteBox', description: "The provider's id for the box, arriving late: kept, for pausing and deleting it." },
          WAKE: { to: 'awake', effect: 'stayUp', description: 'A message came in while it saved: the box stays up.' },
          SAVE_TIMEOUT: [
            { to: 'asleep', guard: 'capped', effect: 'sleepUnsaved', description: "No save came, and it's past its day's hours: it sleeps unsaved, paused if it can be (nothing lost), else kept running." },
            { to: 'awake', effect: 'stayUp', description: "No save came: the box stays up rather than lose work, and it's asked again at the next idle check." },
          ],
          LEASE_DUE: [
            { guard: 'heardFrom', effect: 'renewLease', description: 'It has heartbeated: the lease runs five minutes from its last heartbeat.' },
            { effect: 'unheard', description: "No heartbeat for five minutes: it's marked unreachable and the provider is asked about the box; only its saying the box is gone replaces it." },
          ],
          LOST: [
            { to: 'waking', guard: 'notStale', effect: 'lost', description: 'The provider says the box is gone mid-save: a new box restores the thread from its last save.' },
            { effect: 'forgetOldBox', description: "An older box's loss, reported late: only what was that box's goes." },
          ],
          ARCHIVE: { to: 'archiving', effect: 'askArchiveSave', description: 'Mike archives the thread while it saves: the save is for the archive now.' },
          PAUSED: { to: 'asleep', guard: 'notStale', effect: 'pausedByGuard', description: 'The billing guard paused the box mid-save: the thread sleeps as it was.' },
        },
      },
      asleep: {
        description: "The thread is saved and its box paused or deleted. Nothing is running; it costs a paused box's disk at most.",
        on: {
          WAKE: { to: 'waking', effect: 'wake', description: "A message for the thread: the paused box is resumed, or a new one restores the save. Once only: a second message while it's waking doesn't start another." },
          LOST: { effect: 'forgetBox', description: "The provider lost the paused box: its key goes with it, and as the save is still here, the next wake starts a new box." },
          CREATED: { guard: 'notStale', effect: 'noteBox', description: "The provider's id for the paused box, arriving late: kept, for resuming and deleting it." },
          ARCHIVE: [
            { to: 'shelved', guard: 'holdsWork', effect: 'shelve', description: "Mike archives the thread while a box of it may hold work newer than its save (it slept unsaved, or wrote after saving): that box is kept." },
            { to: 'destroying', effect: 'archive', description: 'Mike archives the thread: its box, if any, is deleted; its save stays.' },
          ],
          RETIRE: { to: 'retiring', guard: 'sameSleep', effect: 'beginRetire', description: "Past its virtual runner's days since it slept: its boxes' key is revoked and they're named for deletion, in this one step (the fence)." },
          SAVED: { guard: 'holdsWork', effect: 'savedAsleep', description: "A box asleep with work newer than its save (kept running, as it can't pause) saved at last: the save is in, and the box can go." },
        },
      },
      waking: {
        description: 'The thread is coming back for a message: its paused box resuming, or a new box being made that restores the last save.',
        timers: { BOOT_TIMEOUT: { at: 'bootBy', description: "Ten minutes have passed and the box hasn't come back." } },
        on: {
          RESUMED: { to: 'awake', guard: 'resumable', effect: 'resumed', description: 'The paused box resumed, its runner still holding its key.' },
          CREATED: [
            { to: 'starting', guard: 'newBox', effect: 'created', description: "A new box was made: the last box's key stops working, and the new one boots, trades a fresh boot token, and restores the save." },
            { guard: 'notStale', effect: 'noteBox', description: "The provider's id for the paused box, sent again: kept, and it can still resume." },
          ],
          LOST: { effect: 'forgetOldBox', description: "The paused box was lost before it resumed: its key stops working, and a new box restores the save instead." },
          READY: { to: 'awake', effect: 'ready', description: 'A new box traded its boot token: its key replaces the last box\'s, which is refused from now.' },
          FAILED: { to: 'failed', guard: 'unexchanged', effect: 'fail', description: "The provider couldn't bring a box back." },
          BOOT_TIMEOUT: [
            { guard: 'stillWaking', effect: 'retryWake', description: "The box holding work newer than the save hasn't come back yet, but the provider hasn't said it's gone: the wake keeps trying it, for a while." },
            { to: 'asleep', guard: 'holdsWork', effect: 'wakeGaveUp', description: "That box hasn't come back in fifteen minutes: the thread sleeps as it was, its box kept (and paused if it's running), until the next message." },
            { to: 'failed', effect: 'bootTimeout', description: 'No box came back: the thread waits for the next message to try again.' },
          ],
          PAUSED: { to: 'asleep', guard: 'wakeOverdue', effect: 'pausedByGuard', description: 'The billing guard paused a box that had been waking too long: the thread sleeps as it was.' },
          ARCHIVE: [
            { to: 'archiving', guard: 'keptBox', effect: 'archiveWaking', description: 'Mike archives the thread while its kept box comes back: that box may hold work newer than the save, so it saves first, or is kept.' },
            { to: 'destroying', effect: 'archive', description: 'Mike archives the thread while a new box is made for it: nothing in it is newer than the save.' },
          ],
        },
      },
      destroying: {
        description: "The thread is archived: the provider is deleting its box. No key works for it any more.",
        on: {
          DESTROYED: [
            { to: 'gone', guard: 'hasSave', effect: 'destroyed', description: 'The provider has deleted the box; its save stays, so it can come back.' },
            { to: 'expired', effect: 'destroyed', description: 'The provider has deleted the box, and with nothing saved the thread can never come back.' },
          ],
          CREATED: { guard: 'notStale', effect: 'noteBox', description: "The provider's id for a box made just before the archive: kept, so it's deleted too." },
        },
      },
      gone: {
        description: "Archived and its box deleted. The row stays for its save, deleted after the virtual runner's deleteAfterDays.",
        on: {
          WAKE: { to: 'waking', effect: 'wake', description: 'Unarchived, or a message: a new box restores the last save.' },
          EXPIRE: { to: 'expired', effect: 'expire', description: "deleteAfterDays have passed: its save is deleted, and the thread can't come back." },
        },
      },
      retiring: {
        description: "Its boxes are being deleted for its retention; it can't be woken meanwhile (a message waits), and it isn't given up on until the provider confirms them gone.",
        on: {
          RETIRED: [
            { to: 'gone', guard: 'archivedWithSave', effect: 'retired', description: 'Its boxes are gone, and it was archived meanwhile: archived, its save kept for its days.' },
            { to: 'expired', guard: 'archivedRetiring', effect: 'retired', description: "Its boxes are gone, and it was archived meanwhile with no save: it can't come back." },
            { to: 'asleep', effect: 'retired', description: 'The provider confirms every box it named gone: asleep with no box, and a waiting message brings it back from its last save.' },
          ],
          ARCHIVE: { effect: 'retireThenArchive', description: 'Mike archives (or deletes) the thread while its boxes go: it goes on to archived once they have.' },
          LOST: { effect: 'forgetBox', description: "One of its boxes is gone, on the provider's word." },
        },
      },
      expired: {
        description: "Its box and its save are gone: the thread can't come back, and what's sent to it fails saying so.",
        on: {
          DESTROYED: { effect: 'forgetProvider', description: 'A kept box it had is deleted too.' },
          PURGE: { to: 'purged', effect: 'purged', description: "Its virtual runner's deleteAfterDays more have passed, and the provider has no box of it left: its thread and runner rows have gone (boxService.ts purgeExpiredBoxes), and this row goes in the same step." },
        },
      },
      purged: { description: 'Gone for good, with its thread and its runner: the row is deleted in the step that put it here.' },
      failed: {
        description: "A box couldn't be started or brought back. The thread and its last save are kept, and no key works for it.",
        on: {
          WAKE: { to: 'waking', effect: 'wake', description: 'A new message tries again with a new box.' },
          CREATED: { guard: 'notStale', effect: 'noteBox', description: "The provider's id for a box that came too late: kept, so it's found and deleted." },
          ARCHIVE: [
            { to: 'shelved', guard: 'holdsWork', effect: 'shelve', description: 'Mike archives the thread while a box of it may hold work newer than its save: that box is kept.' },
            { to: 'destroying', effect: 'archive', description: 'Mike archives the thread: any box the provider still has is deleted.' },
          ],
        },
      },
    },
  },
  {
    callers: { owner: () => true, runner: () => true },
    guards: {
      heardFrom: (_ctx, { row }) => (row.lastHeartbeatAt ?? 0) > Date.now() - LEASE_MS,
      resumable: (_ctx, { row, event }) => row.boxKeyHash !== undefined && row.keyAttempt === newestAttempt(row) && (event.attempt === undefined || event.attempt === row.keyAttempt),
      notStale: (_ctx, { row, event }) => !stale(row, event.attempt),
      unexchanged: (_ctx, { row, event }) => !stale(row, event.attempt) && !exchanged(row, event.attempt),
      newBox: (_ctx, { row, event }) => !stale(row, event.attempt) && !(event.attempt !== undefined && event.attempt === row.keyAttempt),
      capped: (_ctx, { row }) => row.boxState.kind === 'saving' && row.boxState.capped === true,
      holdsWork: (_ctx, { row }) => (row.workAttempts?.length ?? 0) > 0,
      archivedRetiring: (_ctx, { row }) => row.boxState.kind === 'retiring' && row.boxState.archived === true,
      archivedWithSave: (_ctx, { row }) => row.boxState.kind === 'retiring' && row.boxState.archived === true && row.save !== undefined,
      sameSleep: (_ctx, { row, event }) => row.boxState.kind === 'asleep' && row.boxState.since === event.sleptAt,
      stillWaking: (_ctx, { row }) => (row.workAttempts?.length ?? 0) > 0 && row.boxState.kind === 'waking' && Date.now() < (row.boxState.since ?? 0) + WAKE_GRACE_MS,
      wakeOverdue: (_ctx, { row, event }) => !stale(row, event.attempt) && row.boxState.kind === 'waking' && Date.now() >= (row.boxState.since ?? 0) + WAKE_GRACE_MS,
      keptBox: (_ctx, { row }) => row.boxKeyHash !== undefined && row.providerBoxId !== undefined && row.keyAttempt === row.providerAttempt,
      hasSave: (_ctx, { row }) => row.save !== undefined,
      hasToken: async (ctx, { row }) => {
        const token = await ctx.db.query('cloudTokens').withIndex('by_login', (q) => q.eq('login', row.login)).unique();
        return token !== null && token.tokenState.kind !== 'dead';
      },
    },
    effects: {
      start: async () => ({ kind: 'creating' as const, bootBy: Date.now() + BOOT_MS }),
      awaitToken: async () => ({ kind: 'needsToken' as const, since: Date.now() }),
      awaitRoom: async () => ({ kind: 'waitingForRoom' as const, since: Date.now() }),
      // The row has an id now (unlike START's), so the step asks for its box itself.
      tokenSet: async (ctx, { id }) => {
        await provide(ctx, 'createBox', id);
        return { kind: 'creating' as const, bootBy: Date.now() + BOOT_MS };
      },
      archiveUnstarted: async (ctx, { row }) => {
        await expiredNow(ctx, row);
        return { kind: 'expired' as const, at: Date.now() };
      },
      // A new box: whatever box held the key before is done with. Its own key comes at its exchange.
      created: async (ctx, { id, row, state, event }) => {
        // A key of an older attempt than this box's goes; this box's own (or a newer one's) can't be here yet.
        const olderKey = event.attempt === undefined || (row.keyAttempt ?? 0) < event.attempt;
        await patch(ctx, id, { ...(olderKey ? { boxKeyHash: undefined, keyAttempt: undefined, keyMachineId: undefined, unsure: undefined } : {}), providerBoxId: event.providerBoxId, providerAttempt: event.attempt });
        return { kind: 'starting' as const, bootBy: state.bootBy };
      },
      noteBox: async (ctx, { id, state, event }) => {
        await patch(ctx, id, { providerBoxId: event.providerBoxId, providerAttempt: event.attempt });
        return state;
      },
      // boxes.ts claimBoot sets the new key's hash in the same mutation.
      ready: async (ctx, { id, row }) => {
        const now = Date.now();
        await patch(ctx, id, { lastHeartbeatAt: now, bootTokenHash: undefined, bootExpiresAt: undefined, bootAttempt: undefined, keyAttempt: row.bootAttempt, unreachableSince: undefined, seenRunningAt: undefined, ...holdsWork(row, row.bootAttempt) });
        return { kind: 'awake' as const, since: now, leaseUntil: now + LEASE_MS };
      },
      // Its own key, and nobody newer asked for (resumable): there's no newer boot token to touch.
      resumed: async (ctx, { id, row }) => {
        const now = Date.now();
        await patch(ctx, id, { lastHeartbeatAt: now, unreachableSince: undefined, seenRunningAt: undefined, ...unkept(row), ...holdsWork(row, row.keyAttempt) });
        return { kind: 'awake' as const, since: now, leaseUntil: now + LEASE_MS };
      },
      archiveWaking: async (ctx, { id }) => {
        const now = Date.now();
        await patch(ctx, id, { wantsWakeAt: undefined, waitsForHours: undefined });
        return { kind: 'archiving' as const, since: now, leaseUntil: now + LEASE_MS, saveBy: now + SAVE_MS };
      },
      savedAsleep: async (ctx, { id, row, state, event }) => {
        await patch(ctx, id, { ...unkept(row), save: saveOf(row, event), ...savedThrough(row, row.keyAttempt) });
        await provide(ctx, 'sleepBox', id);
        return { kind: 'asleep' as const, since: state.since };
      },
      savedShelf: async (ctx, { id, row, event }) => {
        await patch(ctx, id, { ...unkept(row), save: saveOf(row, event), ...savedThrough(row, row.keyAttempt), ...revoked });
        await provide(ctx, 'destroyBox', id);
        return { kind: 'destroying' as const, since: Date.now() };
      },
      renewLease: async (_ctx, { state, row }) => ({ ...state, leaseUntil: (row.lastHeartbeatAt ?? Date.now()) + LEASE_MS }),
      // Through the one rule (lostBox): the lease's own lapse names no attempt, so it ends them all.
      lost: async (ctx, { id, row, state, event }) => {
        await patch(ctx, id, { ...awakeAdded(row, state.since), ...lostBox(row, attemptOf(event)) });
        await provide(ctx, 'wakeBox', id);
        return { kind: 'waking' as const, bootBy: Date.now() + BOOT_MS, since: Date.now() };
      },
      askSave: async (_ctx, { state, event }) => ({ kind: 'saving' as const, since: state.since, leaseUntil: state.leaseUntil, saveBy: Date.now() + SAVE_MS, ...(event.capped ? { capped: true } : {}) }),
      // Its day's hours are up and no save came: asleep as it is, its key
      // kept so a paused box resumes with nothing lost (sleepBox).
      sleepUnsaved: async (ctx, { id, row, state }) => {
        const now = Date.now();
        await patch(ctx, id, awakeAdded(row, state.since));
        await provide(ctx, 'sleepBox', id);
        await freed(ctx, row);
        await wakeIfPending(ctx as never, row.runnerId, 'asleep');
        return { kind: 'asleep' as const, since: now };
      },
      stayUp: async (_ctx, { state }) => ({ kind: 'awake' as const, since: state.since, leaseUntil: state.leaseUntil }),
      saved: async (ctx, { id, row, state, event }) => {
        // The box goes on working after it, so its work isn't covered (invariant W).
        await patch(ctx, id, { save: saveOf(row, event) });
        return state;
      },
      unheard: async (ctx, { id, row, state }) => {
        const now = Date.now();
        if (row.unreachableSince === undefined) await patch(ctx, id, { unreachableSince: now });
        await provide(ctx, 'checkBox', id);
        return { ...state, leaseUntil: now + LEASE_MS };
      },
      retryWake: async (ctx, { id, state }) => {
        await provide(ctx, 'wakeBox', id);
        return { kind: 'waking' as const, bootBy: Date.now() + BOOT_MS, since: state.since ?? Date.now() };
      },
      // The kept box didn't come up within WAKE_GRACE_MS: the thread sleeps
      // as it was, its key kept, and the billing guard pauses the box if
      // it's running (boxService.ts). The next message tries again.
      wakeGaveUp: async (ctx, { id, row }) => {
        await provide(ctx, 'sleepBox', id);
        // Which machine holds the key still not made sure of: said on the thread.
        if (row.unsure) await patch(ctx, id, { unsure: { ...row.unsure, surfaced: true } });
        return { kind: 'asleep' as const, since: Date.now() };
      },
      // The billing guard paused the box (it wasn't entitled to run: past its
      // hours, silent past its lease, or a wake gone on too long): asleep as
      // it is, its key kept, so a wake resumes it with nothing lost.
      pausedByGuard: async (ctx, { id, row, state }) => {
        // Up until now by its state: that stretch goes on the day's count (split at midnight).
        const since = (state as { since?: number }).since;
        if (state.kind !== 'waking' && since !== undefined) await patch(ctx, id, awakeAdded(row, since));
        await freed(ctx, row);
        // A machine resumed to find out whether it holds the key never said so: said on the thread.
        if (row.unsure?.resumed) await patch(ctx, id, { unsure: { ...row.unsure, surfaced: true } });
        // A message that came meanwhile wakes it again, if it may run.
        await wakeIfPending(ctx as never, row.runnerId, 'asleep');
        return { kind: 'asleep' as const, since: Date.now() };
      },
      sleep: async (ctx, { id, row, state, event }) => {
        const now = Date.now();
        await patch(ctx, id, { ...awakeAdded(row, state.since), save: saveOf(row, event), ...savedThrough(row, row.keyAttempt) });
        await provide(ctx, 'sleepBox', id);
        await freed(ctx, row);
        await wakeIfPending(ctx as never, row.runnerId, 'asleep');
        return { kind: 'asleep' as const, since: now };
      },
      askArchiveSave: async (_ctx, { state }) => ({ kind: 'archiving' as const, since: state.since, leaseUntil: state.leaseUntil, saveBy: Date.now() + SAVE_MS }),
      savedAndGo: async (ctx, { id, row, state, event }) => {
        await patch(ctx, id, { ...awakeAdded(row, state.since), save: saveOf(row, event), ...savedThrough(row, row.keyAttempt), ...revoked, wantsWakeAt: undefined, waitsForHours: undefined });
        await provide(ctx, 'destroyBox', id);
        await freed(ctx, row);
        return { kind: 'destroying' as const, since: Date.now() };
      },
      // Archived with no save to show for it: its box is kept (sleepBox
      // pauses it, or deletes it and says LOST if it can't pause).
      shelve: async (ctx, { id, row, state }) => {
        if (state.kind === 'archiving') await patch(ctx, id, awakeAdded(row, state.since));
        await provide(ctx, 'sleepBox', id);
        if (['creating', 'starting', 'waking', 'archiving'].includes(state.kind)) await freed(ctx, row);
        await wakeIfPending(ctx as never, row.runnerId, 'shelved');
        return { kind: 'shelved' as const, at: Date.now() };
      },
      shelfLost: async (ctx, { id, row, event, to }) => {
        await patch(ctx, id, { ...unkept(row), ...lostBox(row, event.attempt), ...revoked });
        if (to === 'expired') await expiredNow(ctx, row);
        else await wakeIfPending(ctx as never, row.runnerId, 'gone');
        return { kind: to, at: Date.now() };
      },
      expireShelf: async (ctx, { id, row }) => {
        // boxService.ts pruneSaves deletes the save in the same step; destroyBox the kept box.
        await patch(ctx, id, { ...unkept(row), ...revoked, save: undefined, wantsWakeAt: undefined, waitsForHours: undefined });
        await provide(ctx, 'destroyBox', id);
        await expiredNow(ctx, row);
        return { kind: 'expired' as const, at: Date.now() };
      },
      purged: async () => ({ kind: 'purged' as const, at: Date.now() }),
      forgetProvider: async (ctx, { id, state }) => {
        await patch(ctx, id, noBox);
        return state;
      },
      wake: async (ctx, { id }) => {
        await patch(ctx, id, { wantsWakeAt: undefined, waitsForHours: undefined });
        await provide(ctx, 'wakeBox', id);
        return { kind: 'waking' as const, bootBy: Date.now() + BOOT_MS, since: Date.now() };
      },
      expire: async (ctx, { id, row }) => {
        // boxService.ts pruneSaves deletes the file in the same step.
        await patch(ctx, id, { save: undefined, wantsWakeAt: undefined });
        await expiredNow(ctx, row);
        return { kind: 'expired' as const, at: Date.now() };
      },
      bootLost: async (ctx, { id, row, event }) => {
        await patch(ctx, id, lostBox(row, event.attempt));
        await provide(ctx, 'wakeBox', id);
        return { kind: 'waking' as const, bootBy: Date.now() + BOOT_MS, since: Date.now() };
      },
      // What was the lost box's (its attempt's or older), not the boot token
      // or box of a newer attempt.
      forgetOldBox: async (ctx, { id, row, state, event }) => {
        await patch(ctx, id, lostBox(row, event.attempt));
        return state;
      },
      // Another attempt, unless a newer one is on its way (boxService.ts claimAttempt).
      createAgain: async (ctx, { id, row, state, event }) => {
        await patch(ctx, id, lostBox(row, event.attempt));
        await provide(ctx, 'createBox', id);
        return state;
      },
      forgetBox: async (ctx, { id, row, state, event }) => {
        await patch(ctx, id, lostBox(row, event.attempt));
        return state;
      },
      // Lost mid-save, on the provider's word: through lostBox (invariant W(b)), then archived.
      // The fence for a retirement: the attempts it will delete are named now,
      // and their key revoked, so nothing new is made in them meanwhile.
      beginRetire: async (ctx, { id, row }) => {
        const attempts = [...new Set([...(row.workAttempts ?? []), row.providerAttempt, row.keyAttempt].filter((a): a is number => a !== undefined))];
        await patch(ctx, id, { boxKeyHash: undefined, keyAttempt: undefined, keyMachineId: undefined, unsure: undefined, wantsWakeAt: undefined, waitsForHours: undefined });
        return { kind: 'retiring' as const, since: Date.now(), attempts };
      },
      // Only the attempts it named go: one minted meanwhile isn't touched.
      retired: async (ctx, { id, row, state, to }) => {
        const named = (a: number | undefined) => a !== undefined && state.attempts.includes(a);
        await patch(ctx, id, {
          workAttempts: (row.workAttempts ?? []).filter((a) => !named(a)),
          ...(named(row.providerAttempt) || row.providerAttempt === undefined ? { ...noBox, keptRunningSince: undefined, saveAsks: undefined, seenRunningAt: undefined } : {}),
        });
        const now = Date.now();
        // Archived meanwhile: on to archived, its save's days from now (or it can't come back).
        if (to === 'gone') {
          await wakeIfPending(ctx as never, row.runnerId, 'gone');
          return { kind: 'gone' as const, at: now };
        }
        if (to === 'expired') {
          await expiredNow(ctx, row);
          return { kind: 'expired' as const, at: now };
        }
        await wakeIfPending(ctx as never, row.runnerId, 'asleep');
        return { kind: 'asleep' as const, since: now };
      },
      retireThenArchive: async (_ctx, { state }) => ({ ...state, archived: true }),
      archiveLost: async (ctx, { id, row, state, event }) => {
        await patch(ctx, id, { ...lostBox(row, event.attempt), ...(state.kind === 'archiving' ? awakeAdded(row, state.since) : {}), ...revoked, wantsWakeAt: undefined, waitsForHours: undefined });
        await provide(ctx, 'destroyBox', id);
        await freed(ctx, row);
        return { kind: 'destroying' as const, since: Date.now() };
      },
      archive: async (ctx, { id, row }) => {
        await patch(ctx, id, { ...revoked, wantsWakeAt: undefined, waitsForHours: undefined });
        await provide(ctx, 'destroyBox', id);
        await freed(ctx, row);
        return { kind: 'destroying' as const, since: Date.now() };
      },
      destroyed: async (ctx, { id, row, to }) => {
        // A machine destroyBox kept (it may hold work) keeps its id on the row.
        const kept = row.providerAttempt !== undefined && (row.workAttempts?.includes(row.providerAttempt) ?? false);
        await patch(ctx, id, { ...revoked, ...(kept ? {} : noBox) });
        // An unarchive (or message) sent while it was being deleted brings it back now.
        if (to === 'gone') await wakeIfPending(ctx as never, row.runnerId, 'gone');
        else await expiredNow(ctx, row);
        return { kind: to, at: Date.now() };
      },
      fail: async (ctx, { id, row, event }) => {
        await patch(ctx, id, revoked);
        await freed(ctx, row);
        return { kind: 'failed' as const, at: Date.now(), error: event.error.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, ERROR_CHARS) || 'The box failed.' };
      },
      bootTimeout: async (ctx, { id, row }) => {
        await patch(ctx, id, revoked);
        await freed(ctx, row);
        return { kind: 'failed' as const, at: Date.now(), error: 'No box checked in within 10 minutes.' };
      },
    },
  },
);

// No key and no boot token work for the thread after this step.
const revoked = { boxKeyHash: undefined, keyAttempt: undefined, keyMachineId: undefined, unsure: undefined, bootTokenHash: undefined, bootExpiresAt: undefined, bootAttempt: undefined } as const;
const noBox = { providerBoxId: undefined, providerAttempt: undefined } as const;

// Attempt ordering, the one rule every event naming an attempt goes by
// (Codex's fourth review, 18 Nov 2026). Each boot token is one attempt at a
// box (boxes.ts storeBootToken numbers them); the row knows the newest it
// has minted (boxAttempt) and whose its token, key and provider box are.
// An event naming attempt N touches only what's N's or older (lostBox), and
// one naming an attempt older than the newest changes neither the state
// nor the provider box (the notStale guard). CREATED for the newest attempt
// records its provider id in any state, and only starts a box that hasn't
// traded its token yet (newBox); RESUMED is only the key holder's, while no
// newer attempt was minted (resumable). One naming none is taken to be about
// the newest (a loss: every attempt so far).
export function newestAttempt(row: Pick<Box, 'boxAttempt' | 'bootAttempt' | 'keyAttempt' | 'providerAttempt'>): number {
  return Math.max(row.boxAttempt ?? 0, row.bootAttempt ?? 0, row.keyAttempt ?? 0, row.providerAttempt ?? 0);
}
export function stale(row: Pick<Box, 'boxAttempt' | 'bootAttempt' | 'keyAttempt' | 'providerAttempt'>, attempt: number | undefined): boolean {
  return attempt !== undefined && attempt < newestAttempt(row);
}
// Attempt N has traded its boot token (its key, or a newer one, is out) or may hold work.
function exchanged(row: Pick<Box, 'keyAttempt' | 'workAttempts'>, attempt: number | undefined): boolean {
  return attempt !== undefined && ((row.keyAttempt ?? 0) >= attempt || (row.workAttempts ?? []).includes(attempt));
}
const attemptOf = (event: unknown): number | undefined => (event as { attempt?: number }).attempt;

// What goes when attempt `attempt`'s box is lost: its key, its unused boot
// token and the provider's id for it, and any older attempt's. Without an
// attempt, all of them.
function lostBox(row: Box, attempt: number | undefined): Partial<Box> {
  const gone = (a: number | undefined) => attempt === undefined || (a ?? 0) <= attempt;
  return {
    // Invariant W(b): the provider confirmed attempt N's box gone (the
    // service reports LOST only then), with whatever was in it: only N stops
    // being kept. Naming none means every box so far.
    ...(row.workAttempts?.length ? { workAttempts: row.workAttempts.filter((a) => attempt !== undefined && a !== attempt) } : {}),
    ...(gone(row.keyAttempt) ? { boxKeyHash: undefined, keyAttempt: undefined, keyMachineId: undefined, unsure: undefined } : {}),
    ...(gone(row.bootAttempt) ? { bootTokenHash: undefined, bootExpiresAt: undefined, bootAttempt: undefined } : {}),
    // Its box gone, whatever kept it running or counted it goes with it.
    ...(gone(row.providerAttempt) ? { ...noBox, keptRunningSince: undefined, saveAsks: undefined, seenRunningAt: undefined } : {}),
  };
}

type Db = { db: unknown };

// A box kept running though asleep or shelved (boxService.ts keepRunning,
// one that can't pause with unsaved work in it) stops being kept: its
// running time was charged by the billing guard, as the provider showed it running.
function unkept(row: Box): Partial<Box> {
  if (row.keptRunningSince === undefined) return {};
  // Its running time was charged as the billing guard saw it run.
  return { keptRunningSince: undefined, saveAsks: undefined };
}

// It can't come back: what's waiting for its runner fails, saying so (boxes.ts failExpired).
async function expiredNow(ctx: { scheduler: { runAfter(ms: number, fn: never, args: never): Promise<unknown> } }, row: Box): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.boxes.failExpired as never, { runnerId: row.runnerId } as never);
}

// A box stopped counting toward its virtual runner's maxBoxes: one waiting
// to wake, or to start (waitingForRoom), can now (boxes.ts wakeWaiting).
async function freed(ctx: { db: unknown; scheduler: { runAfter(ms: number, fn: never, args: never): Promise<unknown> } }, row: Box): Promise<void> {
  const db = ctx.db as { query(t: 'boxes'): { withIndex(i: 'by_service_wants', f: (q: any) => unknown): { first(): Promise<unknown> } } };
  const states = ctx.db as { query(t: 'boxes'): { withIndex(i: 'by_service_state', f: (q: any) => unknown): { first(): Promise<unknown> } } };
  const waiting =
    (await db.query('boxes').withIndex('by_service_wants', (q) => q.eq('serviceId', row.serviceId).gt('wantsWakeAt', 0)).first()) ??
    // Or one with a token that's waiting for room to start (waitingForRoom).
    (await states.query('boxes').withIndex('by_service_state', (q) => q.eq('serviceId', row.serviceId).eq('boxState.kind', 'waitingForRoom')).first());
  if (waiting) await ctx.scheduler.runAfter(0, internal.boxes.wakeWaiting as never, { serviceId: row.serviceId } as never);
}

// The service's action for a step that needs the provider, at once.
async function provide(ctx: { scheduler: { runAfter(ms: number, fn: never, args: never): Promise<unknown> } }, action: 'createBox' | 'wakeBox' | 'sleepBox' | 'destroyBox' | 'checkBox', id: unknown): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.boxService[action] as never, { boxId: id as Id<'boxes'> } as never);
}

// The row's own fields, never its machine's: the guarded db checks that.
async function patch(ctx: Db, id: unknown, fields: Partial<Box>): Promise<void> {
  await (ctx.db as { patch(id: unknown, value: object): Promise<void> }).patch(id, fields);
}

// The awake time since `since`, added to the day's (UTC) count.
// Only today's share of the stretch counts toward today: one that began
// before midnight (UTC) gives yesterday its part, which today's count
// doesn't carry, as only today's is kept.
export function awakeAdded(row: Pick<Box, 'awakeToday'>, since: number, now = Date.now()): Pick<Box, 'awakeToday'> {
  const day = new Date(now).toISOString().slice(0, 10);
  const ms = Math.max(0, now - Math.max(since, Date.parse(`${day}T00:00:00.000Z`)));
  return { awakeToday: { day, ms: (row.awakeToday?.day === day ? row.awakeToday.ms : 0) + ms } };
}

// The attempts whose boxes may hold work newer than the last save (one
// that has run the thread since). The reaper and destroyBox keep those
// boxes until a save covers them, the provider says they're gone, or the
// thread's days run out (boxService.ts planFor).
function holdsWork(row: Box, attempt: number | undefined): Partial<Box> {
  if (attempt === undefined || row.workAttempts?.includes(attempt)) return {};
  return { workAttempts: [...(row.workAttempts ?? []), attempt] };
}
// A save, with the attempt whose box made it (invariant W(a)).
function saveOf(row: Box, event: { storageId: Id<'_storage'>; bytes: number }): NonNullable<Box['save']> {
  return { storageId: event.storageId, bytes: event.bytes, at: Date.now(), ...(row.keyAttempt !== undefined ? { attempt: row.keyAttempt } : {}) };
}

// Invariant W(a): a save made by `attempt`'s box as it stops covers that
// box's work, and only that box's: an older box's work isn't in it.
function savedThrough(row: Box, attempt: number | undefined): Partial<Box> {
  if (!row.workAttempts?.length || attempt === undefined) return {};
  return { workAttempts: row.workAttempts.filter((a) => a !== attempt) };
}
