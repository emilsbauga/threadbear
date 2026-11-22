# Runner protocol: Projects and schedules

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## Projects

A project groups threads above folders: it can have several folders, a
thread can be in several projects, and it keeps `goals`, `state` and
`notes` that carry forward from thread to thread. Nobody has to make one:
the librarian and the agents do. Kept in `projects.json` in the data dir;
which projects a thread is in is kept with the thread.

**Decisions** (the `projectDecisions` experiment, Mac app only so far).
The app gathers a project's open cards of asks at the top of its page from
what it already has: a thread is a decision while its summary is waiting
on Mike (`needs` "you", not busy) with an `asksSeq` and an unticked ask.
There's no request of its own: an answer there is the `threads.send` the
thread's own card makes with an empty composer (the picked answers'
`text` and `answers`), so the agent can't tell where it was answered.

**Parts.** A project can be a part of another (`parentId`), for one
body of work with separate strands (Threadbear, its GPUI port and its
Android app), so each part keeps its own goals, state and notes rather
than every thread being told all of them. One level only: a part can't
have parts, and a project with parts can't become one. A thread in a part
is told the parent's title and goals in its brief, then the part's own
(see "The brief"); a thread in the parent is told the parts' names. The
librarian doesn't set parents: Mike does, or an agent with `update_project`'s
`parent`. Merging a project moves its parts to the kept one (or makes them
projects of their own if that one is a part); deleting one makes its parts
projects of their own. Parts go to Convex as projects of their own: the
phone and the website list them flat, without `parentId`, for now.

**Patches.** A thread loads patches from, in this order: `~/.threadbear/`,
each folder of each of its projects (the built-in ones and the patch
files found walking up from it, each folder once), then its own folder
as before. Anything from a project folder has `folder` and `projectId`
set and runs in that folder; a hook from one only runs after a turn that
edited a file inside it, matched against its `edited` glob relative to
it. Two items that would share an id get the folder's name in front, the
later one only (`poddle:convex.dashboard`). A thread in a git worktree
reads a project folder in that repo's main checkout from the worktree's
copy of it instead, and skips it when its own folder already covers it:
the main checkout is the same repo on another branch, so loading both
gave every chip twice.

**The brief.** A session is told about its thread's projects once each.
A fresh session (a new thread, a move or account change that starts a new
native session) gets the brief as instructions: each project's title,
folders, goals and state, at most about 2,000 characters in all, and that
`read_project` has the notes. A part's block starts with its parent's
title and goals (not the parent's state or notes); a parent's ends with a
line naming its parts. Claude gets it appended to the system
prompt, Codex as developer instructions. A live or resumed session (Claude
Code ignores new instructions on a resume) hears about a project it hasn't
been told about at the start of its next message, in a line beginning
`[Threadbear project]`; a session from before projects existed gets the
whole brief that way. An agent that joined a project itself isn't told.

**The librarian** is the runner's own background job that keeps projects
up to date, on the small model (`models.*`, feature `projects`, inside the
daily budget, never for private folders). It looks at a thread when:

- a Backlog prompt is saved or edited (`backlog`), 10 seconds after the
  latest save; this files the dormant task and prepares context only
  (see Backlog above);
- its first message comes in (`first-message`), 5 seconds later, so a
  thread is filed while a long first turn is still going; that look
  never changes a project's state;
- its first turn ends (`first-turn`), 10 seconds later;
- a turn edits files outside its folder and its projects' folders
  (`new-folder`), 10 seconds later;
- it moves folder (`moved`);
- it has had turns since the last look, 20 minutes after that look at
  the soonest (`catch-up`). A catch-up is skipped, with no model call, when
  those turns edited no files, ran no commands in a repo outside its
  folder and its projects' folders, gave no link and said fewer than 400
  characters between Mike and the agent; it counts in `skippedToday`, and
  what they said still counts towards the next one;
- someone asks (`librarian.run`, `asked`);
- another thread is hibernating until it has done something (end_turn's
  `waitFor` with `until`): after any completed turn, its CLI's own too,
  10 seconds later (`waited-on`, never skipped as quiet). The look lists
  those threads and their `until`, and its answer's `met` gives each a verdict
  (`{ "<id>": { "met": true|false, "why": "what shows it" } }`); only
  `met: true` with a `why` marks the wait done (`waitMet`), with this
  thread's latest reply; the waiter wakes once all its waits are done. A
  private folder's thread gets no looks, so a wait on one only ends at
  its time.

Those come from the runner's events, and a turn that ends in an older
runner draining after a handover is only heard there. So on start and
every 5 minutes the librarian also queues any thread active in the last
two days with a finished turn it hasn't looked at since (`first-turn` or
`catch-up`). Unreviewed Backlog revisions are also found on startup and
each sweep, regardless of their age.

A thread its own agent or Mike has put in a project (`by` other than
`"librarian"`) is theirs to file: its looks still keep its line and the
state of its projects, but never add or take out a project. Every
thread's agent is told, in the Threadbear tools' instructions, to
`join_project` early and keep the state current with `update_project`.

One look at a time, the soonest due first. A look sends the model the
project list (title, folders, goals, one line of state) and the thread's
title, folder, first message, last few messages and the folders it edited
in, and gets back the projects the thread belongs in with a short reason
for each, a new project when none fits, and a new `state` for a project
the thread moved on. What it decides takes effect straight away: the
thread gets `projects` (`by: "librarian"`, `why` the reason, replaced by a
later look's) and a `system.note` saying so ("Put in Threadbear"), and
Mike can take it out (`threads.setProjects`), after which it's never put
back. It never takes out a pinned project or one an agent added.
A project the thread isn't in yet needs a reason that says it fits: an
id with no reason, or one like "Not that; ignore", is dropped and
logged, and a thread nothing clearly fits stays unfiled.

The folders it gives a project (a new one's, or `addFolders`) are only
repos no other project has, sits inside or holds, and never a folder in
a git worktree: a guessed folder pulls in every later thread that works
there. A new project whose repos all belong to other projects isn't made
(the thread is that project's work), though one with no folders at all
(a house job) still is. Mike and agents can still share a folder between
projects on purpose.

Leaving a project out of its answer doesn't take the thread out of it, so
it doesn't flap from turn to turn. A look takes the thread out of one of
its own guesses when its answer says to (`leave`, with why: "Took it out
of Convex components directory: not a components thread"), on any look,
and also when a move or an ask leaves it out. That isn't remembered as a
no the way Mike's is: a later look can put it back. Looks are listed in
`LibrarianStatus.recent`.

Looks (and icon picks) run on the Claude pool, like every small job.
Without a pool with a Claude login (`models.pool` null, or a pool with
none), or while every login in it is out of room, the queue waits
(`state: "off"`) and tries again later.

**Titles.** A look also says whether the thread's title still fits, and
gives a new one when the work has moved on or the title is only its first
message's opening words. It takes effect straight away, tidied like any
model title, and the look's entry says so ("Renamed it ..."). Never on a
`first-message` look (the title model has only just named it), never over
a title Mike chose (`titleByMike`), or an older fixed title whose ownership
is unknown (`titleSet` without `titleByMike: false`), and not if the title
changed while the model was answering. New agent-chosen titles explicitly
record `titleByMike: false`, so they remain eligible. A librarian title
doesn't set `titleSet`, so a later look can rename it again. Settings >
General > Evolving titles switches these later renames on or off (default
on). The same look considers milestones and changes of objective or phase;
completion alone and cosmetic rewrites do not warrant a new title. No extra
model call: it uses the existing look and catch-up timing.

The same look renames a project the thread is in whose name has gone out
of date: the thing it's about was renamed ("Chrome browser control" after
Paws became BrowserBear), or the work got a name of its own. The entry
says "Renamed <old> to <new>", and the project's `titleBy` becomes
`librarian`. Never on a `first-message` look, and never a project Mike
named (`titleBy`, else `createdBy`, is `mike`): one he made or renamed in
the app, or one an agent named because he asked (`update_project`'s
`mikeAsked`). The prompt marks those, and a name it sends for one anyway
is dropped. Names from the librarian or an agent can be renamed again.

**Icons.** The librarian gives each project an icon and keeps it up to
date. It looks through the project's folders for the picture the project
already has, by file name and place, no model needed: an Xcode
`AppIcon.appiconset`, an `.icns`, an `apple-touch-icon` or `icon-512.png`,
a Chrome extension's or Expo app's manifest icon, a picture named after the
project in an `icons/` folder, then favicons and logos. Wide pictures,
template (menu bar) icons, other image sets, and anything under
`node_modules`, build output, docs or tests are passed over, as is one
under a folder named for something else (`public/inventory/icon.svg` is
the inventory's). A manifest's icon counts only if it's named like a
picture and is a file of the repo's own, not a link out of it. The best is
copied in, so the app never reads a repo, and only if its bytes say it's a
picture; on Linux ImageMagick gets it with its decoder named (never one it
picks, as its MSL and MVG ones are scripts), and an SVG is drawn only by
rsvg-convert. It
looks again a few seconds after a project is made or its folders change,
and every hour at all of them, copying again when the file has changed or
a better one has turned up. A project with no picture gets an SF Symbol:
one small-model call (feature `projects`, in the budget, not while paused,
never for a private folder) choosing from a fixed list. One Mike or an
agent chose (`projects.setIcon`, `update_project`'s `icon`) is never
changed by the librarian.

**No fix threads.** From 30 Oct to 2 Nov 2026 a look could start a thread
to fix a problem Mike mentioned with his tools. It was removed before going
public: on someone else's Mac it started threads that edited and landed
code they hadn't asked for, and Mike starts those threads himself or has a
schedule look for them. A look gets a message's words but not its images,
so each message with images is marked as having some. An older
`librarian.json` may still hold `fixes`, which is ignored.

**Links.** A project keeps up to 8 links: the places Mike keeps going
back to for it (its live site, admin page, dashboard, store listing), not
one-off pages or pull requests. The app shows them at the top of each of
its threads' Highlights, under the project's icon and title. Agents set
them with `create_project` and `update_project` (`links` replaces them,
`addLinks` adds or retitles by url, `removeLinks` takes some off), and
Mike with `projects.update`. The librarian's look can add ones the
thread's messages give for a project the thread is in (`links` in its
answer): only a url that's in what it was sent, never more than 8, and it
never takes one away. Merging two projects keeps both lots.

**Agents** have tools for projects (see Tools for agents):
`list_projects`, `read_project`, `create_project`, `update_project`,
`join_project` and `leave_project` (each for their own thread by default).
An agent's join is pinned. `update_project` changes notes three ways:
`editNotes` (a list of `{ old, new }`, like Claude Code's Edit: each `old`
must be in the notes exactly once, after the edits before it, and an empty
`new` takes it out; one that doesn't match refuses the whole call),
`appendNote` (a paragraph on the end, which can follow `editNotes` in the
same call) and `notes` (all of them, for a restructure; not with
`editNotes`). The runner that keeps the projects reads, edits and saves
the notes in one step (`editNotes` on it, a `drain.projects` op too), and
after a card it refuses the call if the notes aren't the ones judged.

### Project tasks

A project can name a Notion page (`notion`) with its task board on it: a
database with a Status column, like a Notion board. The runner reads it
through the Connectors gateway (see Connectors), with the main Claude
login's `connectors` entry in `~/.claude.json` (its URL and its
`headersHelper`, which prints the Authorization header;
`runner.json`'s `connectors.headersHelper` can name another). So it's the
same Notion login the agents use, and the runner keeps no Notion key.

It finds the database on the page (the one called Tasks, else the first;
a database or a `collection://` address is used as it is) and one of its
views with no filter, then reads the rows through that view every 5
minutes, and when the project page asks (`projects.refreshTasks`):
`notion__notion-query-data-sources` in view mode, 100 a page, 300 at
most. Not rows or SQL mode: Notion caps those per workspace, and two dozen
boards used the allowance up in minutes (30 Oct); view queries don't
count. A database with only filtered views is read in rows mode. Boards are read three at a time: the gateway allows 32 calls in flight, agents' included, and 73 boards read together went past it. The
columns (`notion__notion-fetch` of the data source) are read again every
30 minutes, or when a card is in a column they don't have. The last board
is kept in `project-tasks.json` in the data dir, so a restart shows it at
once.

```ts
// On Project
notion?: string        // the page (or database) Mike or an agent set
tasks?: ProjectTasks   // with notion only

type ProjectTasks = {
  url: string          // the database to open in Notion
  columns: { name: string; kind: "todo" | "doing" | "done"; color?: string }[]
                       // the Status options in Notion's order; kind is the
                       // option's group (To do, In progress, Complete)
  items: {
    id: string; title: string; url: string
    status: string     // a column's name
    who: string[]      // a Who / Assignee / Owner multi-select or people
    due?: string; dueEnd?: string // the first date property, ISO
    thread?: string    // a text property called Thread: a thread id or prefix
  }[]
  fetchedAt?: string
  loading?: boolean    // not read yet
  error?: string       // the last read failed; the rest is the last good board
  more?: boolean       // over 300 rows
}
```

A thread's Highlights lists up to 4 open cards under each of its
projects: the one whose Thread is this thread first, then those in an
In progress column, then To do; more opens the project page.

Threadbear only shows the board; cards are moved in Notion, by people
or by agents with the Notion tools. `read_project` lists the open cards,
and a thread's brief has one line saying the board is there and how many
are open. With no gateway, `error` says so.

## Schedules

A schedule sends a message at a set time, once (`at`) or over and over
(`cron`), like Convex's scheduled functions and crons. It either sends to
a thread that already exists or starts a new thread each time. They're
kept in `schedules.json` in the data dir.

- **Cron.** Five fields: minute, hour, day of month, month, day of week
  (0 or 7 is Sunday), with `*`, lists (`1,15`), ranges (`1-5`), steps
  (`*/15`, `9-17/2`) and names (`jan`, `mon`). When both day fields are
  restricted, either one matching is enough, as in standard cron. Read in
  `timezone`, or the Mac's own zone. A time that doesn't exist on a
  daylight-saving day runs at the first minute that does; one that happens
  twice runs once.
- **Sending.** The message starts with a line saying which schedule sent
  it, `[Scheduled: "<title>", <whenText>]`, so the agent knows Mike didn't
  just type it, and its `user.message` has `origin: "schedule"` and
  `scheduleId`. A message for a thread that's busy waits for the running
  turn to end (it doesn't go into it), then starts its own turn. While it
  waits, only the newest queued reminder per schedule is kept,
  so rebooking a long-running job's check-in cannot build a pile. Messages
  from Mike and other threads can still join the active turn. If a message
  has to wait for a fresh CLI, it goes before scheduled reminders; other
  messages keep their order. Queued runner notifications also yield to
  ordinary messages. When an ordinary message reaches the agent, pending
  automatic inputs are marked `beforeMessage: true` in `QueuedSend`.
  If the agent then ends with archive, snooze or waitFor, those older
  inputs are held through that wait instead of overriding it. This also
  applies when ordinary input joins a background-opened CLI turn; automatic
  notifications alone do not grant that parking path. Inputs
  arriving later still prevent putting the thread away. An older reminder
  delivered later tells the agent that newer instructions take precedence.
  An interrupted, unread peer message is queued again ahead of automatic
  inputs; saved interrupted user messages hold automatic inputs until the
  user writes again. A fresh ordinary peer message is told to keep stopped
  work paused; it never carries or settles the unread user request. Retried peer inputs carry `retryAfterInterrupt: true`
  and count as automatic redelivery, so a saved user cancellation holds them
  too. Held queues release idle CLIs and survive crash recovery. Old queues are compacted to the latest reminder
  per schedule, with a durable local note for each superseded delivery so
  retrying a lost reply cannot bring it back. Reminders carrying check output
  are preserved separately: that output may contain items no longer in the
  check's storage, except that the same text queued again from one
  schedule (a check printing the same thing every tick while the thread is
  busy) keeps only the newest copy. New queued sends carry `preserveSchedule: boolean` from
  the scheduler, so a quoted check report in the reminder's own text does
  not disable coalescing. Legacy queues infer this from the check suffix,
  conservatively retaining held-check notices too. Repeated Run now requests
  also replace a pending reminder
  from the same schedule; they cannot hold up ordinary messages. Pausing a
  schedule does not retract its already accepted message. Deleting one
  does: its reminders still queued for the thread are dropped, each with
  the same `supersededReminder` receipt, whether it was deleted here or the
  backend's rows stop showing it. A draining runner keeping the thread is
  asked with `drain.dropScheduled { threadId, scheduleId }` → `{ dropped }`
  (`moved` once the thread has come across, when the primary drops them
  itself); a draining release without the method keeps its queue. The
  runner also remembers the schedules deleted while it runs (and any its
  first backend snapshot leaves out that its saved copy had), and drops
  their reminders before a turn would start, however they reached the
  queue: adopted in a handover, a retried send, a receipt that failed. A
  thread kept by a draining runner receives it there through
  `drain.sendScheduled { threadId, text, scheduleId }` → `{ turnId }`,
  with `origin: "schedule"` and `queue: true`, once its turn ends and
  background work is all that keeps it there. Until it can start the turn
  immediately, the run stays due on the primary: recovery after an old
  runner crashes discards its unsent queue. A slow draining process holds
  only its own schedule's send, while other schedules continue.
  After 12 hours on the old release, scheduled messages wait for handover
  so recurring check-ins can't keep resetting its quiet spell.
  A draining release that
  doesn't know this method leaves the run due until its thread comes across.
  Supersession receipts are `system.note` events with
  `supersededReminder: <messageId>`. Their `turnId` is the active turn, or
  absent between turns: the discarded reminder never owned a running turn.
  Clients ignore the optional receipt metadata and fold the note normally.
  New primaries use `drain.sendScheduledOnce { threadId, text, scheduleId,
  run, since?, preserve? }` instead. Optional `preserve` carries that same
  check-data flag across handovers; older runners may omit it. `run` identifies
  the cron slot, one-off slot and
  accepted run count, or backend Run now request; rearming a consumed
  one-off time gets a new id, while manual cron runs leave its due id alone.
  `since` is its earliest possible delivery time, bounding the log lookup.
  The lookup includes five minutes before it for clocks on other runners.
  the schedule, thread and run produce a stable message/turn id. Both the
  draining runner and a primary that adopts it acknowledge an already
  logged delivery instead of sending again after a lost reply. A message
  logged before `turn.started` failed is reused when that start is retried.
  The old method remains for older primaries; a draining release without
  the keyed method leaves the run due until handover. Falling back would
  restore duplicate deliveries after a lost reply, so it isn't used.
  An archived or snoozed thread comes back to the inbox, as with any message. One it
  brought out of the archive (`unarchivedBySchedule` on the record, with who
  had archived it) goes back, archived by them again with a `system.note`,
  when that run finishes with `needs: "nothing"` and nothing left running
  or queued; one that needs Mike, fails or waits stays out. Mike writing to
  it, or archiving or unarchiving it himself, clears the mark.
- **New threads** get the schedule's title and settings and are made the
  way `threads.create` makes them. One with a `poolId` starts on that
  pool's pick of its logins at the time (Which login), and stays in the pool.
  Unlike a thread Mike starts, it doesn't change the login or pool the
  next new thread starts on. Their summary's `schedule` says which
  schedule started them, so a client can mark them as scheduled. A repeating schedule whose last thread is
  still starting, running or waiting on Mike skips that run
  (`lastRun.outcome: "skipped"`) rather than pile up threads.
- **Late runs.** The runner checks at least every 30 seconds, so a Mac
  that was asleep (when timers stop) catches up soon after it wakes. A run
  that was due while the runner was stopped or the Mac slept happens once
  as soon as it can, however many were missed; then `nextRunAt` is the
  next time after now. While the runner is restarting, a due run waits for
  the new one.
- **Failures.** A run that can't send (the folder or account has gone)
  records `lastRun.outcome: "failed"` and a `note`, and a repeating
  schedule carries on next time. Deleting a thread deletes the schedules
  that send to it.
- **Runners.** With sync on and a backend of API 9 or later, schedules
  live in the backend's `schedules` table rather than `schedules.json`,
  so every runner sees one list and a schedule can be made for another
  runner (step 6, docs/archive/step6-plan.md). Each row names its `runnerId`, and
  only that runner sends it. The runner keeps a live subscription to the
  table (`sync:schedules`) and a copy in `schedules.json` (`version: 2`)
  for when the backend can't be reached. Its own timer finds a due run,
  as above; before sending it takes the run with `sync:claimSchedule`,
  which says no unless the row is still due at that `nextRunAt` and
  nobody holds it (a claim lasts 2 minutes), so a run is sent once even
  while two runner processes share a `runnerId` in a handover. The
  holder takes it again every 45 seconds while it checks, sends and
  records the run (a check can run 5 minutes), asks once more just before
  the send and sends nothing if it's no longer its, and keeps it until
  `sync:scheduleRan` gets through: a lapsed claim let the other process
  send the same run again. What it
  sends is the claimed schedule as it is once the claim (and its check)
  come back: still there, still this runner's, and the same schedule
  (`createdAt`), or nothing is sent and the claim is let go. The main Mac
  reads every runner's rows, so a row another runner's key saved under a
  deleted id must never be sent in place of the one it claimed. Then
  `sync:scheduleRan` records it and the next time. Until the backend has
  that, the row still says the run is due, and once the claim lapses it
  would be sent again (THREADBEAR-15: a daily schedule sent twice when the
  network dropped as it was recorded and a self-update's new runner read
  the row). So the run is written to `schedule-runs/` (a file each) first
  and tried again every tick until `scheduleRan` lands, by the next runner
  process if need be, and meanwhile laid over the row the subscription
  brings, so it isn't due again here; the `nextRunAt` it ran at is never
  claimed again. If the row was edited meanwhile but still says that time,
  the run takes the row's `updatedAt` and is told again. `scheduleRan`
  counts a run it already has (same `lastRun` time, outcome and thread)
  once, and one older than its `lastRun` (left in flight by a runner
  process that has gone) changes nothing but the claim. A runner key's
  schedule keeps 400 bytes of its 16 KB for that run record. Making, changing and
  deleting go straight to the backend and answer once it has them; with
  no backend reachable they fail with `-32000` saying so. A transport
  failure includes known network error codes or timeout/abort names from
  its causes (for example `ECONNRESET` or `TimeoutError`), without copying
  cause messages, addresses or request data.
  Saves are not retried automatically: a lost reply may follow a committed
  write. Pausing, deleting or editing a schedule leaves messages already accepted
  into a busy thread's queue as they were when sent. Nothing fires
  without the backend. After a failed first heartbeat, the runner retries
  after 1 second, doubling the delay up to a minute until it hears the
  backend, so a brief startup outage doesn't hold schedules for a minute.
  Key refusals and rate limits keep the normal minute interval. Once the
  first heartbeat succeeds, heartbeats stay a minute apart.
  The first time a runner meets a backend of API 9
  it moves its own `schedules.json` up, under its `runnerId`, and from
  then on the file is only the copy. With sync off, or an older backend,
  schedules stay the runner's own file as before.
  From backend API 45 a runner reads the table once with
  `sync:schedulesSince` and then only the rows written since, plus the ids
  gone (`scheduleGone`, kept a day), asking again from 5 seconds before the
  newest row it heard. A claim doesn't count as a write for this. An older
  runner goes on using `sync:schedules`.
- **Checks**. A schedule's `check` is a
  shell command run first, in its folder, each time it's due
  (`src/schedule-check.ts`). For a thread still on a draining runner, its
  folder comes from that runner's thread summary. If the summary isn't
  available during handover, the run waits and a new check approval is
  refused until the folder is known; it never falls back to the runner's
  data folder. It runs by itself from then on, so it's bound to
  what was approved: `checkDigest` in `src/patch-trust.ts` follows the command
  from its folder, as patch trust follows an action's, and hashes the command
  and every file it reaches, scripts outside the repo that it runs by a path
  included (each from the folder it runs in, so its `./x` is there, with its
  own repo for what's the script's own; one it sources is hashed but can't be
  followed, as it can change the shell it's sourced into). The hash goes in
  `patch-trust.json`, as `check:<hash>` in that folder's list (so a worktree
  counts as its main checkout), written only by the runner the check runs on:
  making a schedule with a check, or passing `check` to an update, approves
  it as it is then. Nothing else does: an update that only names a folder,
  the same one or another, approves nothing, so a check moved to another
  folder is held there until it's passed again (the apps' editors send the
  folder only when it changed, and show no check; security review, 11 Nov
  2026). `update_schedule` with a new folder passes the check along, so it's
  approved there as that call's card showed it, command and folder (as it
  is, from Full), and refuses if the check changed while the card was up. The backend's row says what
  to run, never that it was approved. Before each run it's worked out afresh,
  and the check doesn't run unless that hash is stored and its folder is
  there. A script changed, a link retargeted, a file that turned up, a thread
  moved, a row another client changed, or a check made for this runner from
  another all count. The first run then goes ahead without the check,
  saying so, and later ones are skipped (`lastRun.note`) until that version
  of what it runs is approved: `update_schedule` with the same check, which
  from a thread that asks first is a card as any check is. From such a
  thread a check that can't be followed all the way (`python3 x.py`, `eval`)
  is refused before any card. The card's hash and folder go with the save,
  which binds that or nothing, so scripts changed or a thread moved while the
  card was up change nothing. `schedules.create` and `schedules.update` take
  them as `checkCard`, for a draining runner's tool call: it can only refuse.
  A check that turns out to be this runner's with no folder to compare (a
  `runner` naming this one, with no `folder`) is refused too. A Full thread, the app or `tb` may still set one, as it can run
  anything anyway: it's bound to what could be followed, and what the check
  loads past that isn't. Programs on PATH and installed packages aren't
  followed, as for patches. Threadbear's own checkout binds only the command.
  A change another process makes while the check runs isn't caught.
- **Agents** make and change schedules with the `threadbear` tools
  (`schedule_message`, `list_schedules`, `update_schedule`,
  `delete_schedule`); `createdBy` is their thread. By default an agent's
  schedule sends to its own thread ("check the deploy again in 20
  minutes"). `schedule_message` takes a `runner` (a name or id from
  `runners.list`); left out, the schedule runs on the agent's own runner.

## Recipes

Behind the `recipes` experiment. A recipe is a technique someone found worth
keeping (a morning brief, a nightly look back, an email watcher), written so
an agent can set it up for anyone: one `RECIPE.md`, with an optional header
picture beside it. The format is in `runner/src/recipes/FORMAT.md`. The ones
that come with Threadbear are `runner/src/recipes/<id>/`; the user's own are
`<recipes folder>/<id>/` (`runner.json`'s `recipes.folder`, default
`~/ThreadbearThreads/recipes`), and one of theirs with a built-in's id is used
in its place. That folder is also where a recipe's working files go once it's
set up (its `TASK.md`, its `memory.md`), so a subfolder without a `RECIPE.md`
is just that and isn't listed.

What the runner remembers about each, in `recipes.json` in the data dir:
whether it's on, the thread that set it up, and the schedules that are its.
A schedule made by its setup thread (`createdBy`) becomes its own when the
runner next looks, so the setup agent needs no tool of its own. A recipe with
`experiment: <id>` is on while that experiment is: its switch is the
experiment's switch (`settings.update`'s `experiments`).

`RecipeSummary`:

```
{ id, name, icon,            // icon: an emoji
  description,               // one line, for its card
  by?,                       // who wrote it
  source: "builtin" | "yours",
  experiment?,               // the experiment it switches
  when?,                     // how often, in words: "Every day at 6:30"
  color?,                    // "#rrggbb", the header's colour when it has no picture
  header?,                   // absolute path of its header picture on this Mac
  state: "add" | "settingUp" | "on" | "off",
  setupThreadId?,
  schedules: { id, title, paused, nextRunAt?, whenText }[],
  stats: { runs: number, neededYou: number, seen: number, lastRunAt?, lastHeadline? } }   // last 30 days
```

`state` is `add` until it's added; `settingUp` from `recipes.add` until it
has a schedule (or, for an experiment's, until that's on); then `on` or `off`.
`stats` count the threads its schedules started in the last 30 days: those
that ended needing the user, and those they've read (`lastSeenSeq` at
`lastSeq`).

| Method | Params | Result |
|---|---|---|
| `recipes.list` | `{}` | `{ recipes: RecipeSummary[] }`, on first, then the rest by name |
| `recipes.get` | `{ id }` | `{ recipe: RecipeSummary & { about, example?, file, runs: RecipeRun[] } }`. `about` and `example` are Markdown (the file's sections); `file` is the `RECIPE.md` path. `RecipeRun` is `{ threadId, title, at, headline?, needsYou, seen, archived }`, the threads its schedules started in the last 30 days, newest first, 60 at most |
| `recipes.add` | `{ id }` | `{ threadId, thread }` (`thread` its `ThreadSummary`, so a client opens it at once): starts a thread in `<recipes folder>/<id>` (made if need be), on the default pool and mode, whose message points its agent at the recipe's file and has it set the recipe up with the user. The recipe is `settingUp` from now |
| `recipes.setOn` | `{ id, on }` | `{ recipe }`. Off pauses each of its schedules (and turns its experiment off); on resumes them (and turns it on). A recipe still setting up just records the choice |
| `recipes.remove` | `{ id }` | `{ removed: true }`: deletes its schedules, turns its experiment off and forgets it, so it's `add` again. Its files stay |
| `recipes.create` | `{ text?, fromThreadId?, editId? }` | `{ threadId, thread }`: starts a thread in the recipes folder whose agent writes a new recipe with the user (from `text`, or from what went well in `fromThreadId`), and a header picture if it can make one. A new recipe shows as `add` until it's added. With `editId` the agent changes that recipe instead, writing a built-in's changed copy into the recipes folder as the user's own |

`recipes.updated` (notification, no params) says the list has changed: a
recipe's file, its state, its schedules or the threads they started. The
runner looks every 30 seconds and at once after its own changes; a client
fetches `recipes.list` again (and `recipes.get` for a recipe it shows). With
the experiment off every method fails with `-32601`.
