# Runner protocol: Boxes

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

### Box keys

A box on a virtual runner (docs/virtual-runners.md, `convex/boxes.ts`) runs
one thread as an ordinary runner, on a **box key** (`tbb_` and 64 hex
characters): a third kind of key, beside the owner key and runner keys,
for one `runnerId` *and* one thread. It isn't a `runnerKeys` row and
doesn't count toward their three: the thread's `boxes` row keeps its
SHA-256 (`boxKeyHash`).

- **Getting one.** The provider starts the box with a boot token (`tbt_`
  and 64 hex characters) in its environment and nothing else reusable.
  `boxes:exchange({ bootToken, machineId?, boxKeyHash? })` trades it, once and within
  10 minutes of its minting, for `{ boxKey, runnerId, threadId, claudeToken, threadKey,
  repo, save, login }`: the box key, the login's cloud token, the thread's key
  for sealing its saves (base64, 32 bytes), the repo the owner fixed
  (`origin` without credentials, `subfolder`, `baseBranch`), the last
  save's URL, or null, and the login the box runs on (as its cloud token
  is kept, an email), which a token login can't read from `.claude.json`.
  With `boxKeyHash` (the SHA-256, in hex, of a box key the box made itself,
  as the runner's box mode does) that hash is the box's key and no `boxKey`
  comes back, so the key never crosses the network. The exchange then
  records the token's hash and when it would have expired
  (`boxes.exchanged`), and the same `bootToken`, `machineId` and
  `boxKeyHash` asked again, while that key is still the thread's (not
  replaced, revoked or dead) and within the token's 10 minutes, get the
  same answer and change nothing: a box whose answer was lost tries again.
  Anything else with a spent token (another machine, another hash, no
  machine or no hash) is refused (`auth`). It unseals first, from a read that uses nothing
  up, so a deployment that can't unseal (`kind: "config"`) leaves the
  boot token and the box as they were. Then, in one mutation that checks
  the token again, it's used up, the box's machine goes to `awake`
  (`READY`), and the new key's hash replaces the last box's, so the last
  box's key is refused from that moment. A login with no cloud token
  refuses with `kind: "noCloudToken"` and leaves the boot token as it was.
  `machineId` is the provider's id for the machine the box runs on, which
  each provider says how a box learns (`BoxProvider.machineIdEnv`: Fly's
  `FLY_MACHINE_ID`); letters, digits, `_` and `-`, at most 64. The
  exchange records it as the key holder's machine (`boxes.keyMachineId`),
  so where a provider made two machines for one attempt, only that one is
  the row's: the reaper takes it in and deletes the other, and a
  `CREATED`, `LOST` or `PAUSED` naming the other changes nothing. The box
  runner sends it from slice 3; an exchange without it is taken, its
  machine unknown, and then no machine of that attempt is reported lost,
  taken in or deleted for the key while another of it is listed. A box's
  heartbeat may send it too (`runner.machineId`, kept on the box row,
  never the runner's): it names the key holder's machine if nothing has
  yet, and changes nothing once one is known. Before a wake, a lease
  check or the reconciler decides anything, the service makes sure of the
  key holder's machine: one the row never took in is taken in, or, once
  the provider confirms it gone (asked by its id), reported lost, which
  ends its key and its attempt's protection together. Not known: the row's
  machine gone with one of its attempt left, that one is taken in as a
  guess (it deletes nothing and refuses no report, and a box's own word
  replaces it); several left, each is tried in turn. A machine resumed
  while it's unsure is a trial: the thread stays `waking` (no `RESUMED`)
  until a key heartbeat 30 seconds or more after that resume names it,
  and one that stops, or sends none within 3 minutes, is paused and the
  next tried. A failed trial, or a wake that gives up with it still unsure,
  is shown on the thread (`RemoteRunner.box.unsure`). A create's late
  `FAILED` for an attempt that has traded its token (or may hold work)
  changes nothing, nor does a late `CREATED` naming another machine for an
  attempt the row already names one for, unless it names the key holder's
  machine, which the row then takes as its own. A refused `CREATED` deletes
  its machine only if the reaper's plan and fence would delete it then.
  A machine a delete fence decides to delete is condemned in that same step
  (a `boxCondemned` row, with when, no cap) until its delete succeeds or a
  listing asked for after that no longer has it: an exchange naming
  it is refused, as is one naming no machine while any of its attempt is
  condemned (the boot token stays for the kept machine), and a heartbeat
  naming it never makes it the key holder's.
  A newer boot token for the thread replaces an older one. Each is for one
  attempt at a box (`mintBootToken` returns its `attempt`, numbered from
  1), which the service's `CREATED` and `LOST` name: a loss ends the key,
  unused boot token and provider id of that attempt and older ones, and
  leaves a newer attempt's alone (a `LOST` naming none ends them all). An
  event naming an older attempt than the newest the thread has changes
  neither its state nor its provider box: a late `CREATED` is refused
  (`boxMachine.ts` `stale`, one rule for every event). `CREATED`, `IDLE`,
  `RESUMED` and `LOST` each name their attempt. The newest attempt's
  `CREATED` records its provider id in any state, and only starts a box
  that hasn't traded its token yet; `RESUMED` is only the key holder's,
  while no newer attempt has been minted. Box keys and
  boot tokens (`tbb_`, `tbt_`) are redacted from transcripts like runner
  keys, and so is a value under a name like `threadKey`, `boxKey` or
  `sealed`; a message's `turn` (or a picture's name, a claim's holder, a
  move's digest) with a credential's prefix is stored as `[REDACTED]`. A
  message's `turn` must be a turn id's first characters (1 to 8 letters,
  digits, `-` or `_`, from any key) and a runner or box key's `at` an ISO
  time, as `share:view` hands both out unscrubbed; anything else is dropped
  (`turn`) or made now (`at`). A box can't put a share link another thread
  had under its runner id on its own thread.
- **What it reaches.** Only what running its one thread needs (the list
  below, `BOX_CALLS` in `convex/runnerAccess.ts`), each for its own
  runner as a runner key's is, and each row checked against its thread
  too (`ownThreadOnly`): a thread row only under its own thread id, never a
  new thread. Every list and write by runner id (`threadsOf`,
  `sharedThreads`, `messageHeads`, `setThreadIndex`'s `removed` and `keep`,
  its requests, making room under its caps, removing its thread) leaves
  out any other thread the owner key put under its runner id. Messages, tool output and pictures of that thread; its
  runner's commands for that thread or for no thread (another thread's are
  hidden from `pendingCommands` and refused); its thread's moves only.
  Everything else is refused as `forbidden`: everything owner-only,
  schedules, Pocket, projects, logins and usage readings (the service sets
  a box's login), pools, shared memory, presence, `prune` and machine
  figures. A new thread from a box goes through `fileRequest`, which asks
  Mike with a card, as from any runner key. An upload URL it asks for
  dies when its key is replaced.
- **When it stops working.** The box's state machine (`convex/boxMachine.ts`)
  clears the hash when the box is lost (no heartbeat for 5 minutes, or the
  provider says so, in any state, waking included), when the provider
  makes a new box for the thread, and when it fails, is archived or
  deleted; a key whose row is
  `destroying`, `gone` or `failed` is refused whatever the row holds. A
  box that sleeps on a paused machine keeps its key, so it can resume.
- **Heartbeats.** A box's `heartbeat` marks its `runners` row `box: {
  serviceId }`, renews the box's lease (`boxes.lastHeartbeatAt`) and
  drops any `rpcUrl`: no Mac app dials a box. Its answer carries `box: {
  state }`, the box's state as the heartbeat found it (a box stopped by its
  save runs again on `awake`, Box mode).
- **The Machines page** (`convex/viewer.ts`) leaves out a box's
  `bootTokenHash`, `boxKeyHash` and `sealedThreadKey`, and any `sealed`.
- **Internal.** `boxes:authorize` (an action's gate), `storeCloudToken`,
  `newBox` and `insertBox` (a thread's box row), `storeBootToken`,
  `peekBoot` (the exchange's read), `claimBoot` (its one step) and `report` (what the service saw
  of the provider, as the machine's `server` events; `FAILED` names its
  attempt too, and one for an older attempt changes nothing).

A box key may call:

<!-- box-calls -->
`heartbeat`, `bye`, `upsertThreads`, `removeThreads`, `threadsOf`,
`sharedThreads`, `appendMessages`, `messageHeads`, `appendBodies`,
`replyImages`, `addReplyImage`, `shareImages`, `addShareImage`,
`dropShareImages`, `addHeldPicture`, `iconUploadUrl`, `setThreadIndex`,
`pendingCommands`, `takeCommand`, `finishCommand`, `fileRequest`,
`runnerRequest`, `closeRequest`, `moves`, `moveInfo`, `moveReady`,
`moveFrozen`, `moveChunkUrl`, `movePacked`, `moveChunks`, `moveClaim`,
`moveDone`, `moveFailed`, `boxSaved`, `tokenRefused`, `boxCloudToken`
<!-- /box-calls -->

### Box mode

The runner in a box (`runner/src/box-mode.ts`, `box-save.ts`): an ordinary
runner for one thread, started by the image with `THREADBEAR_BOX_BOOT` set.
The box image (`runner/box/Dockerfile`) is Node 24 on Debian with git,
Claude Code at a pinned version (`~/.local/bin/claude`) and the runner from
the commit it was built from. Its entrypoint (`runner/box/entrypoint.sh`)
runs the runner as root, in box mode, with `IS_SANDBOX=1`,
`DISABLE_AUTOUPDATER=1`, `THREADBEAR_BOX_WORK=/work` and the runner's log on
stderr as well (`THREADBEAR_LOG_STDERR=1`); with no `THREADBEAR_BOX_BOOT`, or
no `THREADBEAR_SYNC_URL`, it exits 64 at once, saying why, rather than start
an ordinary runner. Nothing restarts the runner in the box: when it exits,
the machine stops.

- **Starting.** Before anything else it reads the boot token and takes it
  out of its own environment, so nothing it starts (Claude Code, its
  shells, a worktree's setup) inherits it. It makes its own box key and
  sends only its hash (`boxKeyHash`). Then `boxes:exchange` at
  `THREADBEAR_SYNC_URL`, with `machineId` from the variable
  `THREADBEAR_MACHINE_ID_ENV` names (`FLY_MACHINE_ID` when it names none;
  left out if it isn't an id the backend takes). A network failure, or
  `config`, `noCloudToken` or `conflict` (each leaves the token as it was),
  is tried again, 2 s doubling to 15 s, for up to the token's 10 minutes,
  with the same key hash (so an answer lost after the backend took the
  token comes back as a replay);
  `auth` (used, expired, unknown) stops the box at once, as does an answer
  it can't use. What it got is kept in the data dir's secrets, 0600:
  `box.json` (the box key, runner id, thread id, thread key, repo, login,
  machine id, the save's URL and the boot token's SHA-256, never the token)
  and `convex-key` (the box key, the sync key as any runner's is); the
  login's token goes to claude-main's `threadbear-token.json` (0600), which
  the runner already passes to that login's CLI as a year-long token. A
  runner that starts again on the same machine under the same boot token
  uses `box.json` rather than exchange again.
- **The thread's folder.** The repo is cloned (`origin`, https or ssh
  only) into `THREADBEAR_BOX_WORK` (default `~/work`) under its own name,
  on `baseBranch`. With no save, that's all: the thread's `create` command
  makes the thread under the id the backend named, in `subfolder`, on
  claude-main, and its first turn makes a worktree as a new thread in that
  repo would, its patch trusted as the runner's own checkout is. With a
  save, it's restored on top of the clone (below), and the thread's next
  turn resumes the same Claude session. Done once per box (`box.json`'s
  `prepared`), only by the start that traded the token and only into an
  empty place; nothing is ever deleted to make room. A box whose folder
  has gone, or whose first start died before its folder was made, stops
  and says so rather than clone or restore over what's there (the
  exchange's save may be older than its work). It doesn't exit, either:
  on Fly an exited machine's disk is reset. It stays up **degraded**,
  heartbeating on its key, running nothing (no turn, no `create`, no
  `save`), with a note on its thread saying what's wrong and what of the
  thread it found, so the billing guard pauses it with its disk and a
  person can see to it. The same goes for any failure at the start of a
  box that has run. Only a fresh box with nothing to lose exits. Only the box's own thread
  is loaded from the data dir: any other record there is left alone and
  logged, and none is taken in by a handover or a move.
- **What box mode turns off** (decision 1): self-update and following
  main, CLI updates, keep-awake, `followOrigin`, the reinstaller and
  upstream releases, Sentry, the Mac screen watch, schedules, the
  librarian, spare-week threads and the borrow sweep; the sync sends no
  presence, logins, projects or their pictures, schedules, pools, shared
  memory or machine figures, and never calls `prune` (its key can't do
  any of them; a fresh box's first full write goes without it). It keeps
  no schedules: `schedule_message`, `tb schedule` and the backend's
  `schedule` command are refused with a note that the Mac schedules it
  (a schedule there sends to the thread and wakes it), and nothing in the
  box arms a schedule's timer, runs its check or reads `schedules.json`.
  Its key isn't the owner's (`ownerKey()` is false for `tbb_`, as for
  `tbr_`), so `create_thread` naming another runner files a request the
  main Mac asks the user about. A repo's patch code never runs in the
  box's runner process: each patch file is imported in a short-lived child
  process (`runner/src/patch-child.ts`) that sends back what's static in it
  as one line of JSON on a channel of its own (fd 3; what the patch prints
  on stdout or stderr is thrown away) and exits. The loader runs in a
  process group of its own: the read ends on that line, the loader's exit
  or 30 seconds, never on its pipes closing, and then the whole group is
  killed, so nothing the patch starts holds the read up. A process the patch
  starts in a group of its own (detached, setsid) can outlive the read, but it
  stays in the box, and a stopping save's sweep kills it. Its functions
  aren't run at all: an action or panel with a `when`, `badge`, `label` or
  `summary`, and a list panel (`items`), aren't shown on a box's thread;
  its static actions, panels, hooks (commands, gated like any process) and
  `worktree` setup are. It runs one thread: any other `create`, from
  anywhere, is refused (`create_thread` asks the main Mac, as from any
  runner key). Claude Code runs as root there, so `IS_SANDBOX=1` is set
  for everything the runner starts. The app port listens on 127.0.0.1
  only, as every runner's does; nothing dials a box.
- **Heartbeats** carry `runner.machineId`, the same id as the exchange.
- **A refused token** (API 94). The exchange also gives `tokenSetAt`, when
  the login's token was set, kept in `box.json`. `claude auth status`
  calls any token signed in, so a dead one only shows when a turn is
  refused (errorKind `auth`). In box mode that turn sends
  `boxes:tokenRefused({ key, setAt })`, quarantines only its own token grant, says so once in the thread
  (`system.note`), and the thread waits (`waitingForToken` on its record,
  kept across restarts, with `refusedSetAt`, the version refused, and
  `reported` once the backend has heard; no pool move, as a box has one
  login). A refusal not yet heard is sent again on the next start or
  poll, always with `refusedSetAt`, never a version installed since. While
  it waits the runner asks `boxes:boxCloudToken({ key })` (an action, box key
  only: a token already issued to that box, or explicitly approved by an owner-set replacement, else null) every
  30 seconds. Any token newer than the refused one lifts the hold: one the
  box already has (a box restored from a save whose exchange installed a
  newer token goes at once, telling nobody), or one set later, which is written over
  claude-main's `threadbear-token.json` (0600) and into `box.json`, the
  thread's CLI is closed so the next turn starts on it, and the thread
  carries on by itself with the runner's carry-on message, as after a
  sign-in. A legacy saved wait without a refused version retries the installed token once, so a new boot token is never guessed to have failed. Boot secrets without a token version fetch an approved snapshot first. A message from Mike meanwhile waits behind it. A box report never marks the login-wide token dead: unrelated threads keep starting. `boxTokenGrants` holds each box key’s issued/refused state; setting a token as owner releases only refusals already recorded before that SET. Legacy live keys adopt one token grant from the canonical backend box row and the owner-set token, including older runners whose refusal was already marked reported. Later replacements require the same recorded-refusal and owner-SET checks as new boxes. Each issued grant retains its approved sealed token, so a later SET cannot overwrite an undelivered replacement. Boot-token replays obey the same grant and never hand out a later token on their own.
- **Superseded.** Any call refused with `kind: "auth"` (the box key
  unknown: a newer box for the thread has traded its boot token, or the
  box was lost, failed or archived) means this box no longer has the
  thread. It sends nothing more, stops its CLIs and exits with no `bye`,
  so the provider's machine stops for the service to clean up.
- **The `save` command** (only the backend sends it, for the box's own
  thread). Every save the backend asks for is a stopping one (to sleep, at
  its day's hours, or to be archived), and once it's acknowledged the box
  may be deleted, so the box stops first, categorically: turns are held, a
  running turn is interrupted (30 s to end) and the CLI closed, then every
  other process in the box is killed (all but the runner, its ancestors,
  PID 1 and the provider's own: `runner/src/box-procs.ts`, from `/proc`).
  The provider's are a baseline the first start after the exchange takes,
  before anything of the thread runs, kept in `box.json` (`baseline`: pid,
  start time, command) and used by every start after, so an agent's
  process that outlived a restart of the runner is never spared. A process
  is alive while any of its threads is (a zombie leader can have live
  ones), and its whole thread group is killed. The runner's own work waited
  for (a minute at most, or the command fails), and it looks again that
  nothing new started. A worktree cleanup or teardown an archive would
  start meanwhile is owed instead (`cleanupOwed`). And from the save's
  start, no process starts in the runner at all: in box mode,
  `node:child_process` is gated (`runner/src/spawn-gate.ts`: every function
  of it that starts a process, and `ChildProcess.prototype.spawn`, for the
  runner and its libraries alike), and only the save's own git and packing
  are let by. A patch's live functions aren't read while it's held, and a
  read already going is waited for. From the moment a save starts, the thread
  runs nothing until the backend says it may: a command other than `save`
  taken after the save's outcome is known, or a heartbeat sent after that
  whose answer finds the box `awake`. Nothing in the box lets it go: not a
  clock jump, a timeout or an error, nor a restart: the hold is written to
  `box.json` (`saveHold`) before the thread is touched, and a start that
  finds it holds the thread before loading it. While it's held, the box's
  heartbeats and its save's `finishCommand` send `held: true`, and
  don't mark the box as holding work (`runnerAuth`'s housekeeping; only a
  `save` command's finish counts), and a finish of any other command taken
  while the save goes waits until its outcome is known. A command's finish
  goes once at a time (a retry waits for one on its way), and the backend
  takes a finish that changes nothing (its command already ended) as
  housekeeping too. Then it's packed: the thread's folder in the data dir (its record and events,
  not `panels`), its Claude session's transcript and the folder beside
  it, and its git work as a move packs it (`move-git.ts packGit`: the
  commits origin doesn't have and one more of every uncommitted and
  untracked file, in a git bundle; ignored files stay behind, and so do
  files under a `node_modules` folder that the checkout's own index doesn't
  have, which a restore refuses: the worktree's setup makes them again; a
  change there to a tracked or staged file fails the command, saying so.
  Its index is built from HEAD, with no stat data to trust, and every file
  hashed afresh (`core.checkStat` default, `core.trustctime` on, whatever
  the repo says), plus the paths the checkout's own index has staged that
  HEAD hasn't (force-added, so an ignored one comes too): what's saved is
  the files as they really are), in a move's
  archive (`move-pack.ts`) with a `box.json` naming the thread. At most
  100,000 files and 128 MB unpacked, the limits a restore holds it to,
  checked from the sizes on disk before anything is read, and
  it's read back as a restore will read it before anything is uploaded:
  over a limit or unreadable, the command fails and the thread carries on. Sealed
  AES-256-GCM under the thread key: a 12-byte IV, the ciphertext, the
  16-byte tag, bound to `threadbear box save v1 <threadId>` as associated
  data. Uploaded to the URL `sync:iconUploadUrl` gives the box key, then
  `boxes:boxSaved({ key, storageId, bytes })`, but only once every change
  of the runner's has gone up (the mirror's flush waited for, then one run
  to the end with nothing left, the sidebar index's writer the same, and
  any command's finish still to send from before the save; if
  it can't, the command fails and the box
  stays held), so no write after the save marks the box as working; the command finishes
  with `{ bytes }` (and `leftOut`, up to 20 paths left out). A sealed save
  over 10 MB (one upload) fails the command saying so; saves in parts are
  a TODO. A `boxSaved` whose answer is lost (not a refusal) is sent again
  with the same file, which the backend takes as the same save, for up to
  10 minutes; past that its outcome is unknown, and the thread stays held
  until the backend asks for another save. Messages wait in the queue
  while it's held.
- **Restoring.** The save is downloaded (https, no redirects, 10 MB at
  most), gunzipped to 128 MB at most, opened (one that doesn't open with the thread's key, or isn't
  that thread's, stops the box), the thread's folder written into the data
  dir, its git work put back on the clone (`unpackGit`), in a worktree at
  `<clone>-threads/<the folder name it had>` on `thread/<id8>` if it had
  one, and its transcript put where Claude Code looks for the folder it
  now runs in. Once the runner is up, the worktree's setup runs again
  (installed packages weren't saved), and no turn starts in the thread
  (recovery, a carry-on or a message) until it's done; one that fails
  says so in the thread, and the turns go ahead. That it has run is kept
  apart (`box.json`'s `setUp`): a runner that stops before it has runs it
  again, holding the turns again, on its next start.
