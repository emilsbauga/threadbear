import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
// Finished commands and paged messages older than a day.
crons.interval('prune old rows', { hours: 6 }, internal.sync.pruneOld, {});
// Stored files whose rows ran out (tool pictures, uploads never sent) and
// commands no runner took in two weeks: on their own, so neither holds up the other.
crons.interval('prune old files', { hours: 6 }, internal.sync.pruneFiles, {});
// Taken commands whose runner never finished them in the lease, for rows from
// before the command machine's own timer (sync.ts lapseCommands).
crons.interval('lapse taken commands', { minutes: 15 }, internal.sync.lapseCommands, {});
// Tool output past its 30 days, a batch at a time (each row is read to be deleted).
crons.interval('prune old tool output', { minutes: 15 }, internal.sync.pruneBodies, {});
crons.interval('finish intake file cleanup', { minutes: 15 }, internal.intakeFiles.sweepCleanup, {});
crons.interval('remove abandoned intake blobs', { hours: 6 }, internal.intakeFiles.sweepOrphans, {});
// Moves nobody answered, or frozen too long (moves.ts), and old ended ones.
crons.interval('expire moves', { minutes: 5 }, internal.moves.expireMoves, {});
// Pushes held for a Mac that went to sleep with Mike at it (sync.ts).
crons.interval('send stale held pushes', { minutes: 2 }, internal.sync.sendStaleHeldPushes, {});
// Thread clears from before their machine get its timer (sync.ts armClears).
crons.interval('arm thread clears', { minutes: 10 }, internal.sync.armClears, {});
// The state machines' history past two weeks (machines.ts).
crons.interval('prune machine history', { hours: 24 }, internal.machines.pruneHistory, {});
// Virtual runners' boxes (boxService.ts, docs/virtual-runners.md): sleep the
// idle and the ones up their day's hours; reap boxes the provider has that
// nobody wants (a call to the provider per virtual runner, none without
// one); delete archived threads' saves past their days.
crons.interval('sleep idle boxes', { minutes: 2 }, internal.boxService.sleepIdleBoxes, {});
crons.interval('reap boxes', { minutes: 5 }, internal.boxService.reapBoxes, {});
crons.interval('prune box saves', { hours: 6 }, internal.boxService.pruneSaves, {});
// Expired boxes past their days again, with their thread and runner rows (boxService.ts).
crons.interval('purge expired boxes', { hours: 6 }, internal.boxService.purgeExpiredBoxes, {});
export default crons;
