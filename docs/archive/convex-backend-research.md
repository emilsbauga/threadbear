# Threadbear's Convex backend: the research (27 Oct 2026)

Sections 1 to 4 of docs/convex-backend.md, moved here on 20 Nov 2026 as history: the
research Mike said yes to on 27 Oct ("A", and make the project now). What's built and
how it works today is in docs/convex-backend.md from section 5 on.

## 1. What exists today

Nothing. Checked on 27 Oct:

- `git log --all` and `git grep` over every branch (main, pools, step4
  and its pieces, project-icons, rename, thread-worktrees, the design
  branches) and the 17 worktrees under `~/dev/me/threadbear-*` and
  `~/dev/me/threadbear-rename`. Every hit for "convex" is one of: the
  built-in Convex dashboard panel (`runner/src/patches.ts`), the "Convex
  work only" note on the claude-2 account, or the schedules doc saying
  cron works "like Convex's scheduled functions".
- `~/dev/me/threadbear-notes` holds only the step 4 plan, spikes and
  recorder scripts.
- No `convex/` folder, no Convex dependency, no deployment, no
  `.env.local` anywhere in the repo.

The runner keeps everything as files under
`~/Library/Application Support/Threadbear/`: `threads/<id>/thread.json`
(the summary), `events.ndjson` (every event), `media/`, `blobs/`, plus
`projects.json`, `schedules.json`, `usage.json` and `librarian.json`. The
Mac app is a client of the runner over a loopback WebSocket and holds no
state of its own.

### Where the Convex idea came from

From Agent Archive, in order:

1. **26 Oct, the original plan.** Mike's agreed build order put Convex at
   step 5: "thread state in Convex + a Threads tab in Quick Ask (his
   iPhone app) with a push when a thread needs him", then step 6 "Tinker
   Desk as a second runner, then cloud sandboxes". `docs/archive/plan.md` still
   says this under "Later steps".
2. **27 Oct, morning (archive thread jx7dzqk862, items 585 to 600).**
   Mike: "I think I want this to be a Convex project. So I think I want
   everything to get synced to Convex. And in theory, this could just
   become new agent archive potentially. But let's think about that. If we
   were to sync everything to Convex, that's going to be a lot of data,
   isn't it?" He added that Agent Archive's Convex costs were why it had
   moved to Bruce. The reply measured his transcripts (about 10 GB a
   month, 52% base64 images, 5% tool output, about 1% conversation text,
   about 110 MB a month) and offered three sizes. Mike answered "A for
   now": live shared state only, written on change and never per token,
   full transcripts staying on the runner's machine, Agent Archive on
   Bruce staying the search layer, Sydney region.
3. **27 Oct, afternoon (thread f5247e5b).** Asked for the phone app, Mike
   said Threadbear "was supposed to be backed by a convex project so that
   there was kind of like a real-time convex nature in there, potentially
   synced to convex", and wanted that sorted first.

Thread 6eecd8a8 ("thread digests for archive search and the phone") is
related but separate: it proposed a model-written digest per thread stored
in `thread.json`, for Archive search, the sidebar and the phone list. It
doesn't touch Convex, and its conclusion was that Agent Archive already
indexes every Threadbear transcript, so Threadbear shouldn't build its own
search. If digests get built they're one more field the mirror below
carries up.

## 2. What "Convex-backed" could mean

Two honest readings of what Mike has asked for, and a third I'd rule out.

### A. The runner owns the state, Convex mirrors it (and carries the phone's requests back)

The runner stays the source of truth for everything it has today. When
something the phone would care about changes, the runner writes the new
value to Convex. The phone reads Convex with live queries and writes its
requests (send a message, approve, answer, hibernate, start a thread) to
a `commands` table that the owning runner subscribes to and applies
through the same code paths the Mac app uses. The Mac app keeps talking
to the runner over loopback and doesn't know Convex exists.

This is the "A for now" Mike picked on 27 Oct, plus the command queue
that any phone app needs anyway.

### B. Convex is the source of truth for shared state; runners hold transcripts and processes

Projects, notes, schedules, thread summaries, usage and runner presence
live in Convex. The runner and the Mac app both subscribe to it. The
runner keeps `events.ndjson`, media and the CLI processes, and writes a
summary document after each change the way it writes `thread.json` now.
The Mac app's sidebar, Projects view, Scheduled view and Librarian view
read Convex.

### C. Everything in Convex, including transcripts

Mike's first instinct on 27 Oct ("everything gets synced"). About 10 GB
a month at today's pace, half of it base64 images, with every streamed
token a write. Already ruled out in that conversation and I agree: it's
the exact pattern that put Agent Archive at 137 GB of database I/O in a
month and tripped the team's spending limit. Not discussed further.

### Weighing A against B

**Cost.** Convex bills database I/O, not storage, and a live query re-runs
and re-reads every document it touched each time one of them changes. So
the question is how many subscribers sit on the thread list all day.

Measured on the live runner on 27 Oct (64 threads, 2 days):

| | per day |
|---|---|
| events persisted | about 6,300 |
| turns | about 115 |
| user and assistant text messages | about 600, 250 KB |
| `thread.updated` notifications | several thousand (every status, preview, background and context change, coalesced per tick) |

A mirror that writes only phone-relevant fields (title, status, needs
you, preview, last activity, put away, projects, cost) and coalesces to
one write per thread every couple of seconds while a turn runs comes to
roughly 2,000 summary writes a day of about 1 KB each, plus about 600
message documents. Writes: a few MB a day. The phone's inbox query reads
about 60 documents (60 KB) each time any of them changes. If the phone
subscribed all day that's about 120 MB a day, 3 to 4 GB a month; a phone
that's open for a few minutes a day is a rounding error. Under A the Mac
app isn't a subscriber, so this is the whole bill: well inside the team's
50 GB of included I/O even at Sydney's 1.3x, and nowhere near the US$80
limit.

Under B the Mac app subscribes all day to the thread list, projects,
schedules and the rest, on every machine Threadbear is open on. Each
`thread.updated` then costs a re-read of the list on the Mac as well as
the phone, and the Mac's reads happen whether or not anyone's looking.
Call it 4 GB a month per always-on client, and more as the thread count
and turn rate grow. Still affordable on its own, but it's the same
"re-read on every change" shape that got Agent Archive, and a mistake in
one query (reading all events, or all archived threads) takes every
project on the `mikec` team down together, as on 22 Oct.

**Offline and asleep.** Under A the Mac works with no internet: the runner
owns the state, and the mirror just writes "the current value of this
document" when the connection is back, so nothing is lost or queued. When
the laptop sleeps the runner stops, Convex keeps the last state, the
phone shows "Mac offline since 10:42" from the runner's heartbeat, and
anything Mike does on the phone waits in `commands` until the runner
wakes and applies it. That's the thing a phone talking straight to the
runner over Tailscale can't do (and Tailscale on the 15 Pro Max was last
seen 43 days ago).

Under B the Mac app's sidebar needs Convex to load. The Swift client
caches the last snapshot, so it would still open, but every change
Mike makes to a project, note or schedule with no internet either fails
or needs an outbox that doesn't exist in `convex-swift` today. The
runner would also need to keep working while Convex is unreachable,
which means a local copy of projects and schedules anyway. So B ends up
with the local files plus Convex, not instead of them.

**Latency.** The app's bar is cold start to a usable window under a
second and thread switches that feel instant. Loopback to the runner is
under a millisecond; Sydney is about 80 ms and US East about 285 ms. A
round trip on open is fine; one on every sidebar interaction is not
what Mike built a native app for.

**Tinker Desk as a second runner (plan step 6).** Under A each runner
registers itself (`runners` table: name, version, last heartbeat) and
mirrors its own threads, so the phone sees one list across machines
with a machine label, and a command carries the `runnerId` it's for. A
thread started from the phone names a runner, or goes to the main Mac
(docs/protocol.md, "Runner keys"). No new Convex work is needed for step 6. The
Mac app still has to reach the second runner somehow for transcripts
and sends: either a second socket over Tailscale, or, later, by reading
remote runners' summaries from Convex and opening a socket only for the
transcript. That later piece is the one place B's idea earns its keep,
for remote runners only, and it can wait for step 6.

Under B multi-runner comes for free on the list, but every runner still
needs its own socket for transcripts and sends, so the saving is small.

**Schedules.** One real advantage of B: a Convex cron could be the clock,
and fire into whichever runner is online, so a schedule isn't lost while
the laptop's lid is shut. Worth doing later, as a targeted change: keep
`schedules.json` as the runner's own, mirror it, and let Convex re-fire
a missed one on another runner. Not needed for the phone.

**How much changes.** A is one new runner module and a `convex/` folder.
It hooks the places the runner already notifies from (`flush()` for
summaries, the persisted-event path for text messages and approvals,
`projects.updated`, `schedules.updated`, `accounts.updated`) and adds a
subscription for commands that calls the existing `send`, `respond`,
`update` and `create` methods. The protocol gains a `sync` status field,
an `origin: "phone"` on `user.message`, and nothing else. The Mac app
doesn't change.

B rewrites `projects.ts`, `schedules.ts`, `librarian.ts` and the
summary save path to treat Convex as the store, adds `convex-swift` to
the Mac app with a second data source beside the runner socket, and
changes the protocol's "kept in `projects.json`" and "kept in
`schedules.json`" contracts. Weeks, not days, and it moves the Mac app
off the loopback path that makes it fast.

**Agent Archive.** Stays on Bruce as the search and memory layer under
both. It already ingests every Threadbear session, because Threadbear
runs the real CLIs and they write the same JSONL the archive reads.
Mike's "could become the new agent archive" is the C shape and the
answer's the same as on 27 Oct: no. If Threadbear wants search over its
own threads, it should ask Bruce.

## 3. Recommendation: A, as "runner owns, Convex mirrors, phone asks"

Build A. It is what Mike agreed on 27 Oct, it gives the phone everything
it needs, it costs almost nothing, the Mac stays fast and offline-safe,
and Tinker Desk fits without more Convex work. Revisit two pieces of B
later and on their own: Convex as the clock for schedules, and the Mac
app reading remote runners' summaries from Convex at step 6.

### Shape

**One Convex project**, `threadbear`, on the `mikec` team, Sydney region,
in `convex/` at the repo root with its own `package.json` (which also
lights up the built-in Convex dashboard panel for threads in this repo).
Tables:

| table | written by | holds |
|---|---|---|
| `runners` | each runner, every 60 s | id, name (M5, Tinker Desk), version, release, `lastSeenAt`, `draining` |
| `threads` | the owning runner, on change | the phone's view of `ThreadSummary`: id, runnerId, title, cwd, account, provider, model, status, needsYou, preview, timestamps, snoozedUntil, archivedAt, costUsd, projects (ids and titles), `pendingApproval` (the open approval or question, with its options), the working line (what `background` shows) |
| `messages` | the owning runner | the last 20 `user.message` and `assistant.text` per thread: threadId, seq, role, text, origin, at. Older ones are deleted as new ones arrive |
| `commands` | the phone | `send` (text, optional new-thread fields), `respond` (approvalId, decision, answers), `update` (snooze, archive, title), `create`; `runnerId` or "any"; `state: pending / taken / done / failed`, `note` |
| `projects` | the owning runner | id, title, folders, goals, state, notes, archived, lastActivityAt |
| `schedules` | the owning runner | the `Schedule` list, for reading on the phone |
| `accounts` | each runner | per account: title, provider, note, blocked, usage windows (the usage popover's numbers) |
| `devices` | the phone | APNs token and environment, like Poddle's `devices:register` |
| `tokens` | by hand | hashed phone tokens with expiry, as Quick Ask does it |

Rules the runner follows, so the bill stays small and Convex never
becomes a dependency:

- **Fail soft.** The mirror is best effort. If Convex is unreachable or
  the team is over its limit, the runner logs once, keeps a "dirty" set,
  and retries with backoff. Nothing the Mac app does waits on it.
- **Write values, not events.** Each table row is "the current state of
  X". A reconnect writes the dirty rows once; there's no queue of
  deltas to replay, so a long outage costs one write per changed row.
- **Coalesce.** At most one `threads` write per thread every 2 seconds
  while a turn runs, and only when a phone-relevant field changed.
  `contextTokens`, per-task `background` churn and `lastSeq` are not
  mirrored. Messages are written when an `assistant.text` item
  completes, never per delta.
- **Never per token.** No streaming text goes to Convex. The phone shows
  the working line and waits for the finished message.
- **Kill switch.** `runner.json` `sync.enabled: false` stops it; `tb
  status` and the Settings view show the sync state and the last error.
- **Handovers.** A draining runner stops mirroring and stops taking
  commands; the new release writes every thread once on start so Convex
  can't be left showing the old runner's last state.
- **Auth.** The runner holds a key in `secrets/convex-key` (0600) and
  passes it to its mutations, which compare it to a deployment env var.
  Phone queries and mutations carry a phone token checked against the
  hashed `tokens` table, issued by `tb phone-token` and delivered by the
  one-off LAN page and QR code Quick Ask uses, never the clipboard.
  Convex Auth can come later if this ever has a second user.

**Push**: a Convex Node action that calls APNs with the team's existing
key, copied from `poddle/convex/apns.ts`, scheduled with `runAfter(0)`
from the mutation that flips `needsYou` to true or marks a turn
finished, with a per-thread cooldown so a flapping status doesn't spam.

**Full transcripts on the phone**: not in v1. When Mike taps "earlier
messages", the phone writes a `page` command and the runner uploads the
next 50 text messages of that thread into `messages` with a `pagedAt`
stamp; a cron deletes paged rows after a day. That keeps the phone off
Tailscale and keeps the steady-state table small. Tool output and diffs
stay on the Mac.

**Pictures on the phone (API 24, 1 Nov).** An agent writing
`![alt](/path/on/the/mac.png)` or pinning an image file showed nothing on
the phone, which can't read the Mac's disk. So those two kinds, what an
agent put in front of Mike on purpose, go to file storage from every
thread (`replyImages`, `runner/src/share-images.ts`), at most 10 MB each and
only if the file really is a picture. `phone:messages` hands them over in
`images`: one with `src` replaces that image in the text, a `pinned` one
goes under the turn's reply. They go as they're written, and each runner
start looks through unarchived threads active in the last 14 days, so an
older thread's pictures stay on the Mac and the phone says so. They're
deleted with the thread. Mike's attachments and tools' screenshots stay on
the Mac unless the thread is shared (`shareImages`), as they're many and big.

Since API 95, with the livePages experiment on, a page an agent shows in its
reply (`![title](/path/page.html)`, one self-contained HTML file, checked
to be markup) goes too: its row's `mediaType` is `text/html`, but the file
is stored as `application/octet-stream`, so its storage URL opened in a
browser downloads it rather than running it on the deployment's origin.
`phoneImage` carries `mediaType`, and the apps run a page only in their
sealed views (docs/live-pages-design). A pinned page stays on the Mac.

They go as the file is, so a GIF keeps its frames; the phone's 1400 pixel limit
is only on what it decodes for the column. MP4 and MOV files an agent writes
the same way or pins go through the same rows (`.mp4`, `.m4v`, `.mov`, under
the same 10 MB), which took no backend change as the phone tells a video from
a picture by its bytes. Shared pages still get only pictures.

### Build order

1. **Project and summaries.** `convex/` with the schema above, the runner
   module (`runner/src/sync/`), `runners` heartbeat, `threads` mirror from
   `flush()`, the kill switch, `tb status` output, protocol note. Tests
   with a fake client; one real e2e against a dev deployment. About half
   a day. The phone can start on its inbox against this.
2. **Messages, approvals, projects, schedules, accounts.** The rest of
   the read side.
3. **Commands.** The phone's writes, applied by the owning runner;
   `origin: "phone"` on `user.message` so the transcript shows where it
   came from (the Mac app already draws `origin: "schedule"`). Creating a
   thread from the phone uses the same defaults as `threads.create`.
4. **Push.** APNs action, `devices` table, the cooldown.
5. **Paged older messages**, when the phone's thread view wants them.

Then, when step 6 of the main plan comes: Tinker Desk runs the same
release with its own runner name, and the Mac app learns to read remote
runners' summaries from Convex. Separately, if Mike wants it: schedules
re-fired by a Convex cron on whichever runner is up, and option B's
"full conversation text" (about 110 MB a month, written once) as a flag
on the mirror.

### What the iPhone app needs first

In order, matching the build order above:

1. `threads` and `runners`, for the inbox with needs-you first, running
   ones with their working line, and "Mac offline since" when the
   heartbeat is stale. Read-only; this is enough to start the app.
2. `messages` and `pendingApproval` on the thread, for the thread view
   and the approval or question card.
3. `commands`, for reply, approve, answer, hibernate, den and new thread.
4. `devices` and the push action.

Quick Ask stays as it is on Bruce. Folding it into the Threadbear phone
app is a later decision and doesn't depend on any of this.

## 4. Decisions

Mike, 27 Oct: shape A, and make the project now. Full conversation text
(the 27 Oct option B) stays a later flag.
