---
id: externalIntake
name: External messages in Backlog
title: Save received external messages as dormant Backlog drafts
added: 2026-11-08
on: false
reminder: 6620ca36
---

## What it does

Every 15 seconds while sync is running, save received messages from explicitly
bound intake clients as unsent Backlog drafts. Their original text stays in the
composer; Message source in Highlights holds provenance. No task session, turn
or worktree starts until you send the draft. Existing Backlog librarian review
may add context. Retries, restarts and deletion do not create the same task again.
With backend API 63, attachments are transferred in private blocks, verified and
saved locally with the complete draft. Cloud bytes are removed only after durable
local confirmation. Pending data has no age expiry. See docs/intake.md for
checksum holds and storage lifecycle.
Sender receipts continue to mean received by Convex. Known test messages must
be explicitly excluded before binding a production client. Off by default;
turning it off takes effect on the next poll and does not delete existing drafts.

## Lives in

`convex/intakeConsumer.ts`, optional delivery fields/indexes on intake tables,
`runner/src/intake-consumer.ts`, `intake-record.ts`, `runner/new-threads.ts`,
`store.ts`, `sync.ts` and `main.ts`; `convex/intakeFiles.ts` and
`runner/src/intake-files.ts`. Backend API 62 (files require 63). Per-receipt completion markers
live in the runner's `intake-imports/`; source snapshots live in each imported
thread's `intake-source.json` and initial record. No nanobot access is needed.
See `docs/intake.md` and the External message intake protocol section.

## Taking it out

Disable `externalIntake` in runner.json to stop consumption. Remove the consumer
and its sync/main wiring, intake creation helper, completion marker hooks and
experiment manifest; regenerate experiment docs. Keep provenance/completion files
if retries may ever resume. Do not delete intake receipt records or the independent
sender API. Remove backend delivery functions and access entries together; only
drop table fields after existing data is migrated. Existing drafts remain normal
Backlog threads and can be started, edited, archived or deleted.
