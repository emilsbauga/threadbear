# Virtual runners: a machine per thread, on demand

Mike, 16 Nov 2026 (thread 1cbaefb7): "you would just pick another option
from this list of where it runs. And it would be instead of it being an
actual runner on a machine that's actually live, it would be a service ...
it's just going to spin up a runner as necessary. And you can spin up as
many of these threads as you want." It must not be tied to one provider:
"It could run on anything ... whatever is the cheapest", as long as the
provider has "a minimum set of functionality that we would require".

This replaces the sandboxed-threads experiment (a container around Claude
Code on a shared runner, taken out on 16 Nov) and is the "cloud sandboxes"
half of step 6 (docs/archive/plan.md). Coordinators are a separate experiment and
out of scope here.

Status: the spike passed (Order, 1), and the backend is built in two
slices (18 Nov, "What's built", below): the tables, the box's state
machine, box keys, cloud tokens and the boot exchange; then the Fly
adapter, the service's actions, starting a thread, waking, reachable
boxes and the crons; then the runner's box mode (19 Nov, slice 3) and the
box image it boots (slice 4); then starting one from the Mac app, with
its cloud token made just in time in the thread (19 Nov, slice 5). Nothing
has made a real box through the app yet. A first draft of the plan
went to a review panel (Fable, Opus and Grok, 16 Nov), each reading the
code; their changes are folded in, and "What the review changed" at the
end says what moved and why.

## What it's like when it's done

- The Runs-on menu in the new-thread box lists, after the machines, one
  entry per **virtual runner**, for example "Cloud (Fly)". It has its own
  icon and no online dot: it's always there.
- Starting a thread on it feels like starting one on bruce, only slower
  the first time. The row shows "Starting a machine" with a spinner while
  the box boots and clones the repo, the message waits in the queue, then
  the turn runs.
- The first time a thread runs on it with a Claude login that has no
  cloud token yet, the thread shows one card: "Make one for <login>" or
  "Paste a token". Making one runs `claude setup-token` on the Mac, which
  opens claude.ai to approve and gets the code back on a localhost
  callback, so there's nothing to copy. The message waits and goes once
  the token is set. The same card comes back when a token is revoked or
  expires. (Mike picked this on 17 Nov over a switch per login in
  Settings or Capy-style setup cards; Settings still lists each cloud
  token with its expiry and a link to revoke it.)
  If that login already uses a year-long token on the Mac (thread
  d0cf502c: each login may opt in, kept in its own `settings.json`), the
  card offers to use it, but a separate cloud token is the default: a box
  can leak its token, and revoking a shared one would sign the Mac out
  too. `claude auth status` reports any token as signed in, so a dead
  cloud token only shows when a turn is refused with a 401; that is what
  brings the card back.
- Ten threads on it are ten boxes. They show under the one entry, never
  as ten machines in the menu or in Settings.
- A thread that's been idle a few minutes **sleeps**: its work is saved
  out of the box, then the box is paused or deleted. The row says
  "Asleep" in the same quiet way a hibernating thread does. Sending a
  message wakes it ("Waking" with a spinner) and the turn runs when it's
  up, on the same box if the provider kept it, else on a new one restored
  from the save.
- If a box dies, the thread comes back on a new box from its last save,
  with a line in the transcript saying so and what (if anything) was lost.
- Archiving the thread deletes its box and, after `deleteAfterDays`, its
  save.
- **Move to** works both ways between a Mac and a virtual runner, with the
  same transcript, branch and uncommitted changes as any other move.
- Settings › Runners has a section per virtual runner: the provider, the
  size of box, how many boxes are running and asleep, and what they've
  cost this month.

## Decisions

1. **A box runs a whole, ordinary runner** (all three reviewers agreed).
   Not just the CLI with the runner staying on an always-on machine: the
   runner does git, worktrees, patches, transcripts and file listing in the
   thread's folder, and everything between machines (commands, mirror,
   moves, sidebar) is keyed on a `runnerId`. The runner gains a **box
   mode**: no self-update (a new release is a new image), no keep-awake,
   no systemd, no `followOrigin`, one thread, and its login's email given
   to it rather than read from `.claude.json` (a token login doesn't write
   `oauthAccount`, `runner/src/accounts.ts`). Box mode is a convenience,
   not a boundary: the agent has a shell, so every limit that matters is
   enforced in the backend.
2. **The service is in Convex.** A virtual runner is a row in a new
   `runnerServices` table (name, provider, box size, limits, image). Each
   thread on it has a `boxes` row (`serviceId, threadId, runnerId,
   provider, providerBoxId?, state, bootToken, lastHeartbeatAt,
   awakeSince, awakeSecondsToday, save?`). Convex actions call the
   provider's API; a cron sleeps idle boxes, reaps lost ones and cleans
   up. Once a thread has started, nothing needs a Mac to be on: the phone
   can start and wake threads on a virtual runner too.
3. **One `runnerId` per thread, for life; a new credential per box.** The
   thread's box runner has a `runnerId` made when the thread starts, and
   every box that ever runs that thread uses it. A new box gets a fresh
   credential in the same mutation that revokes the last one, so a wake
   onto a new box is not a move (no `rehomeRows`, no dead `runners` rows),
   and two boxes can never both act as that runner.
4. **Box credentials are their own class**, not runner keys. Runner keys
   are capped at `MAX_RUNNER_KEYS = 4` (`convex/sync.ts`), budgeted
   for whole machines, and bruce, the Hetzner box, the Pixel and the Dell
   hold all four;
   a new runner key also drops shared logins (`makeRunnerKey`,
   `convex/sync.ts` ~:3904, `dropRunnerLogins`). A **box
   key** is scoped in `convex/runnerAccess.ts` to one `runnerId` *and*
   one `threadId`, with caps sized for one thread, outside that limit:
   no new threads (`create_thread` from a box asks Mike with a card, as
   from any runner key), no schedules, no Pocket, no login sharing, no
   moves except its own thread's. The service sets the box's logins
   itself.
5. **Secrets come in by exchange, not in the environment.** The provider
   starts the box with one `bootToken`: single use, valid 10 minutes,
   stored hashed on the `boxes` row. The box's runner trades it over HTTPS
   for its box key; the boot token then dies. The environment, which every
   child process and the provider's API can read, holds nothing reusable.
6. **Starting and waking go through the queue, which knows about boxes.**
   - `boxes:startThread` (owner, from the Mac's runner or the phone)
     writes the `runners` row (marked `box: { serviceId }`, hidden from
     the Runs-on menu and Settings' machine list) and the `boxes` row,
     then queues the `create` command and schedules the boot.
     `queueCommand` needs that row to exist (`convex/relay.ts` ~:357).
   - The `create` carries what a box can't find on its own disk: the
     repo's `origin`, the subfolder and the base branch, read on the Mac
     the way `moveInfo` does (`withoutCredentials`).
   - A runner whose `boxes` row is `starting`, `asleep` or `waking` counts
     as reachable everywhere one is checked: `mustBeOnline`
     (`runner/src/relay.ts` ~:1514), the phone's `ONLINE_MS`
     (`convex/phone.ts`), `startMove` (`convex/moves.ts` ~:162).
   - Both command insert sites (`convex/relay.ts` ~:373, `convex/phone.ts`
     ~:1350; both go through `queued()` in `convex/machines.ts`)
     schedule a wake when the target box is asleep. The wake is
     idempotent: it moves `asleep → waking` once, so two quick sends make
     one wake.
   - The Mac's waits (`TAKE_MS`, 20 s; 30 s for a remote create) become
     the service's measured start or wake time for a box, and the row
     shows "Starting a machine" / "Waking" rather than an error.
7. **Every sleep saves the thread out of the box first; pause is only a
   cache.** A provider can lose a paused box (Fly drops a suspend snapshot
   on host maintenance and cold-boots; a stopped Fly Machine's root disk
   is reset from the image, only Volumes persist), so the thread must not
   live only there. Before the cron sleeps a box it sends it a `save`
   command. The box:
   - commits its uncommitted work to `refs/threadbear/save` and pushes the
     thread's branch and that ref to `origin` (`cloud/<thread>`, see 10);
   - uploads the thread folder and the session transcript, gzipped and
     sealed to a **per-thread key** (made with the thread, kept on its
     `boxes` row, handed only to boxes for that thread), to Convex file
     storage, replacing the last save.
   Then the backend pauses the box if the provider can, else deletes it.
   Waking: resume the paused box if it's still there; otherwise a new box
   restores the last save (the same session id resumes, as after a move).
   The move code's packing (`runner/src/move-pack.ts`, `move-git.ts`) is
   reused for the bundle; the move protocol itself isn't, since it needs
   an online target and deletes its chunks when it ends.
8. **The minimum a provider must do**: start a Linux box from an OCI
   image with a size, a name and tags; delete a box; list boxes by tag
   (to find orphans); and let a process in the box hold an outbound
   HTTPS/WebSocket connection to Convex for hours; all from a Convex
   action over HTTPS. That's enough, because saves make every provider
   able to sleep (delete, then restore). Optional, declared as `caps`:
   pause with memory (fast wake), an egress allowlist, snapshots of a
   prepared disk (per-repo images later).
9. **The adapter interface** (`convex/boxProviders/<name>.ts`):

   ```ts
   type BoxCaps = { pause: boolean; egressAllowlist?: boolean; snapshots?: boolean };
   interface BoxProvider {
     caps: BoxCaps;
     // idempotencyKey is the boxes row's: Convex may retry an action, and a
     // retry must find the first box, not make a second.
     create(spec: { image: string; cpus: number; memoryMb: number;
       diskGb: number; env: Record<string, string>; name: string;
       tags: Record<string, string>; idempotencyKey: string })
       : Promise<{ providerBoxId: string }>;
     list(tags: Record<string, string>): Promise<{ providerBoxId: string;
       state: "running" | "paused" | "stopped" }[]>;
     pause?(id: string): Promise<void>;
     resume?(id: string): Promise<void>;
     destroy(id: string): Promise<void>;
   }
   ```

   The provider's API key is a Convex environment variable. Adding a
   provider is one file and a test against a fake HTTP server. Mike's own
   machines as a provider (Docker or gVisor on the Hetzner box) can come
   later through the same interface: a small host program that keeps one
   connection to Convex and takes jobs, as Amp's self-hosted orbs do.
10. **The Claude login is a setup token kept in Convex, as Capy does
    it.** Mike makes one with `claude setup-token` on his Mac and pastes
    it into Threadbear once per Claude account; it's stored in Convex
    sealed with a key held in a Convex environment variable, so a data
    export or backup doesn't carry it in the clear. A box gets it only
    through the boot exchange (5), keeps it in the runner's memory and
    passes it to Claude Code as `CLAUDE_CODE_OAUTH_TOKEN`. It's never in
    the provider's machine config or on the box's disk. Codex the same
    way with its own token.

    This does mean the box holds a token that can use the whole
    subscription for up to a year, and the agent in it can read its own
    environment. Things that would avoid that, and why not:
    - **A short-lived token minted from the long one**: Claude Code has
      no way to do it (`claude setup-token` takes no options, 2.1.326).
    - **Convex holds a normal login's refresh token and hands boxes only
      the access token**, which lasts hours: logins now end after 28
      days, so Mike would sign in again every month, and it would mean
      calling Claude Code's private sign-in endpoint from Convex.
    - **A proxy in front of Anthropic that swaps a stand-in credential
      for the real one**: through Convex HTTP actions it would put every
      model request (hundreds of KB each) through Convex's usage and add
      a hop to every turn (Mike, 17 Nov). On a machine of Mike's or a
      Cloudflare Worker, it's another thing every Threadbear owner has to
      run, when Convex is "the only reliable constant" they all have.

    What limits the damage instead: Settings says which token a box uses
    and links to claude.ai to revoke it, and pasting a new one swaps it
    for every box at its next wake. A Claude account kept only for boxes
    means a revoke doesn't touch the Mac's threads. Where the provider
    has an egress allowlist (`caps.egressAllowlist`), it's on by default.
11. **GitHub tokens for one repo, decided when the box is made.** The repo
    is fixed on the `boxes` row by the owner side at start, never taken
    from what the box later writes. A git credential helper in the box asks
    for a token with its box key; a Convex action mints a GitHub App
    installation token limited to that repo and returns it, and it's never
    written to disk. The `cloud/**` push limit is a ruleset per repo
    (personal accounts have no account-wide rulesets), so only repos with
    that ruleset can be used from a box. At first that's threadbear.
12. **Limits, money and lost boxes.** Each virtual runner has `maxBoxes`
    (awake at once, default 5), `maxAwakeHours` per box per day (default
    8; past it the box is saved and slept, even with a dev server running)
    and `deleteAfterDays` for archived threads' saves. Starting past a
    limit fails at once and says what's in the way. The cron also:
    - reaps any provider box whose tag has no `boxes` row, or a row that
      isn't awake (found with `list`);
    - treats a box that's awake but hasn't heartbeated for 5 minutes as
      lost: destroys it, puts any command it had `taken` back to `pending`
      once (a taken command now lapses after 3 hours and is never handed
      out again, `TAKEN_LEASE_MS` in `convex/commandMachine.ts`, so a lost
      box's is put back by the backend before then),
      and restores the thread from its last save on a new box, with a
      transcript line saying so;
    - records awake seconds, which Settings shows times the provider's
      rate.
13. **What a box can't do**: anything Mac-only (simulators, Xcode,
    BrowserBear, ComputerCub, Mike's signed-in apps), the threadbear tools
    that act on a Mac, reaching his tailnet, and schedules (a sleeping box
    can't fire one; a schedule for a box thread stays on the Mac and sends
    to it, which wakes it).
14. **An experiment**, `virtual-runners`, on for Mike only, until it has
    run a week of his real threads.

## What's built

The backend's first slice (18 Nov 2026), with tests in
`runner/test/unit/boxes-backend.test.ts` and `box-access.test.ts`:

- **Tables** (`convex/schema.ts`): `runnerServices` (decision 2; limits
  default to `BOX_LIMITS` in `convex/boxes.ts`: 5 boxes, sleep after 10
  idle minutes, 8 awake hours a day, saves kept 14 days), `boxes` (one per
  thread, for life), `cloudTokens` (decision 10), and `runners.box: {
  serviceId }`, which a box's heartbeat sets and keeps.
- **The box's state machine** (`convex/boxMachine.ts`, `boxStates.ts`,
  drawn in docs/machines.md): creating, starting, awake, saving, asleep,
  waking, destroying, gone and failed. The owner sends START and ARCHIVE;
  the runner in the box READY (its boot exchange) and SAVED; the service
  CREATED, IDLE, WAKE, RESUMED, LOST, DESTROYED and FAILED
  (`boxes:report`, internal). Timers: 10 minutes to boot, a 5-minute
  heartbeat lease, and 10 minutes for a save, after which the box stays
  up. A heartbeat only stamps `boxes.lastHeartbeatAt`; the lease's timer
  reads it and runs on from it, so heartbeats aren't steps in the
  machine's history. A lost box goes to waking with its key cleared,
  failing and archiving clear it too, and an asleep box keeps its key so
  a paused box can resume (unless the provider lost it). WAKE is taken
  once, so two quick messages make one wake.
- **Box keys** (decision 4; docs/protocol/boxes.md, "Box keys"): a third
  `Caller`, `{ owner: false, runnerId, box: { id, threadId, keyHash } }`,
  found by `boxes.boxKeyHash`, never a `runnerKeys` row. `BOX_CALLS` in
  `convex/runnerAccess.ts` is what it may call, and `ownThreadOnly` holds
  every row check (`mayWrite`, `mayTouch`, `mayClaim`, `mayTake`, the
  moves' `mustBe`, `fileRequest`) to its one thread. Its upload URLs die
  with its key. What it holds counts against its runner id's allowances as
  a runner key's does, a thread moved to it included (`lib.ts
  hasAllowance`), never as the owner's.
- **Cloud tokens** (decision 10): `boxes:setCloudToken` (owner, an action)
  seals with AES-GCM under `BOX_SEAL_KEY` (a Convex env var: 32 random
  bytes in base64, `npx convex env set BOX_SEAL_KEY "$(openssl rand
  -base64 32)"`), bound to its login, and `boxes:cloudTokens` lists the
  logins with when each was made and set, never the token.
- **The boot exchange** (decision 5): `boxes:mintBootToken` (owner) keeps
  only a boot token's hash, for 10 minutes, a newer one replacing it;
  `boxes:exchange` (no key) reads and unseals first without using anything
  up (`peekBoot`), then claims it in one mutation (`claimBoot`: checked
  again, used up, READY sent, the new box key's hash in place of the last
  one's) and returns the box key, runner id, thread id, cloud token,
  thread key, repo and the last save's URL. `tbb_` and `tbt_` are redacted
  from transcripts, and the Machines page leaves out the boxes' hashes and
  sealed values. The per-thread
  key is made, sealed, with the box row (`boxes:newBox`, internal, for
  `startThread`).
- **Saves** (decision 7): `boxes:boxSaved` (a box key only) takes a file
  its runner uploaded, replaces the last save and deletes it.

The second slice (18 Nov 2026), with tests in
`runner/test/unit/box-service.test.ts` (the service against a fake Fly
API, never the real one), `box-fly.test.ts` (the adapter) and
`thread-index.test.ts`:

- **The Fly adapter** (`convex/boxProviders/fly.ts`, the interface in
  `types.ts`), ported from the spike to plain `fetch` in a Convex action:
  `FLY_API_TOKEN`, `FLY_APP` (made in `FLY_ORG`, default `personal`, the
  first time a box is), idempotent creates by a `tb_idem` tag, `restart:
  no`, nothing injected (the image's entrypoint is the runner in box
  mode). `caps.pause` only for a box of 2 GB or less, as Fly can't
  suspend bigger. `list` gives each box's tags too, for the reaper, and
  `CreateSpec` takes a `region`; `diskGb` is optional, as Fly has none.
- **The service's actions** (`convex/boxService.ts`), each told only a
  box row's id, reading it again and acting on its newest attempt only:
  `createBox` (a new attempt: its boot token minted through
  `claimAttempt`, which hands out one attempt at a time, then the
  provider's create keyed `<boxId>-<attempt>`, reporting `CREATED` or
  `FAILED` for that attempt, and deleting a box nobody took);
  `wakeBox` (`RESUMED` for the paused key holder, or `LOST` and a new
  attempt); `sleepBox` (pause, or delete and `LOST`); `destroyBox` (every
  box tagged for the row, then `DESTROYED`). The box's machine schedules
  them from its steps (a wake, a loss, a save, an archive), so a box lost
  to its lease comes back by itself. A provider error is tried twice more
  in the action when it's worth it (unreachable, 429, 5xx); then a box
  that couldn't be made or woken is `failed` with the error, and the next
  message tries again, and a sleep or delete that didn't happen is left
  for the reaper. `FAILED` now names its attempt, so a late one can't fail
  a newer box.
- **`boxes:startThread`** (owner): the thread's runner (marked `box`, a
  fresh 12-hex id), its box row and its `create` (naming its thread) in one
  mutation, refused past `maxBoxes` (boxes creating, starting, awake,
  saving or waking); then `createBox`. `boxes:setRunnerService` and
  `runnerServices` make and list virtual runners.
- **Waking** (decision 6): `queued()` (both insert sites) schedules
  `boxes:wakeFor` for a command to a box that's asleep, saving, failed or
  gone, which sends `WAKE` once, room allowing. A box's own `save` command doesn't wake it.
- **Reachable** (decision 6): in every state but `destroying` and `expired`
  (`failed` and `gone` too, as a message tries a new box): `startMove` lets a box's
  own thread move to it, and `otherRunnersList` gives each box's state,
  which the runner's `thread-index.ts` counts as online, so `mustBeOnline`
  lets a message through. The phone's online checks pick a runner for a
  *new* thread, which a box never is: `mainRunner` and `mainOwnerRunner`
  skip boxes, and `phone:create`, `quickAsk` and `queueCommand`'s
  `create` refuse a box's runner. A move to or from a sleeping box wakes it.
- **The crons**: every 2 minutes, an awake box idle `idleSleepMinutes`
  (no command waiting, its thread not starting, running or waiting on an
  answer) or up `maxAwakeHoursPerDay` today (busy or not, unless a
  command waits) gets `IDLE` and a `save` command; every 10, the reaper
  (above, and protocol/keys.md "Virtual runners"); every 6 hours, archived
  threads' saves and box rows past `deleteAfterDays`.
- **Archiving**: a box's thread put in the den or removed has its box
  deleted after a minute (`boxHooks.ts archiveSoon`), unless it's out of
  the den again; `archiveBox` at once. An archive command for a sleeping
  box wakes it to do it. The box is then `gone`, its save kept for
  `deleteAfterDays`: unarchiving it (or a message) brings it back on a
  new box from the save. After that, or if it never saved, it's
  `expired`, and what's sent to it fails saying it can't come back.

Codex's review of the second slice (18 Nov 2026) found nine holes, fixed
with a test each in `box-service.test.ts` (the fake Fly API can hold a
request, so a test runs one action in the middle of another):

- The day's hours cap needed the box to save: one that never did stayed
  up. A capped save that doesn't come in 10 minutes now sleeps it anyway
  (`saving.capped`, `sleepUnsaved`): paused, or deleted if it can't pause.
- Waking ignored `maxBoxes`. A wake past it now waits (`boxes.wantsWakeAt`,
  `RemoteRunner.box.waiting`), with its message pending, and the oldest
  waiting wakes when a box sleeps, fails or is archived (`wakeWaiting`).
- A sleep's slow suspend could land after a wake had resumed the box.
  One action at a time calls the provider for a box (`boxes.op`, a lease
  claimed in a mutation; another waits and runs again), and a sleep that
  finds the thread woken when its suspend returns resumes the box.
- Pause support came from the virtual runner's size now. It's the size
  each attempt was made at (`boxes.size`), and a refused suspend deletes
  the box (LOST: the save's already in).
- A new thread's `create` was refused, as its thread had no row yet: a
  box's key now takes its own thread's `create` before then.
- An archived thread couldn't come back (above).
- The reaper acted on a plan the row had moved on from. Each step is
  checked against the row in the mutation that takes it (`reapStep`), and
  a loss is only reported under the box's op lease after asking the
  provider again. A resume the machine didn't take goes on to a new box.
- A move to or from a sleeping box never woke it: `startMove` does now.
- The crons' bounded scans saw the same first rows each run: they page,
  carrying on from where they stopped (the reaper by provider id).

Its second look at those fixes found eight more, fixed the same way:

- A command waiting for the box kept it from its day's cap. The cap now
  comes first: at its hours a box saves and sleeps whatever's waiting,
  and what's waiting waits for tomorrow's hours, or for Mike to wake it
  past them (`boxes:wakePastHours`, owner).
- Archiving deleted the box unsaved. A box that's up now saves first
  (`archiving`); if no save comes it's kept paused (`shelved`) until
  `deleteAfterDays`, and unarchiving resumes it.
- An unarchive sent while the box was being deleted waited for ever. A box
  that goes asleep, gone or shelved with a waking command waiting wakes.
- A run whose op lease had lapsed could still act. Every provider call now
  has a 40-second deadline inside the 3-minute lease, checks and renews
  the lease before and after, and the run's reports carry its lease, so
  one that lost it does nothing more; its reconciling loops until the
  provider matches the row.
- Expiring a save left waiting commands pending, and failing them stopped
  at 50: everything waiting for an expired box now fails, a batch at a
  time, the command that asked first.
- A box could sleep mid-move: a move going counts as activity (no idle
  sleep, and the cap waits for it), and each move step wakes a sleeping
  box on either side, past its hours if need be.
- The crons read only the first 100 virtual runners: those page too.

A third look found six more. The rule they share: a box that may hold
work newer than its last save is never deleted, except when its days run
out or the thread is deleted.

- A box that couldn't pause was deleted with unsaved work in it. Now it's
  kept running (`keptRunningSince`), its time counting toward its day's
  hours (the cap can't delete it: it waits there, costing a running box,
  until a save comes or its archive's days run out), and asked to save on
  a backoff (`retryKeptSaves`); a refused suspend marks the box
  `unpausable` and does the same (since replaced: one refusal no longer
  does, see the sixth look below). Waking it takes it up as it is. And
  `setRunnerService` now refuses a Fly box over 2048 MB, so it only
  happens to a box whose suspend is refused or one made before.
- Archiving a kept box while it woke deleted it. It now saves first
  (`archiving`), and is kept (`shelved`) if no save comes; an `archiving`
  box that stops heartbeating is kept too.
- A message cancelled a save its day's hours asked for: it now waits.
- A move left claimed with no last word kept its box up for ever: a move
  counts as going only while it has had a step in the last hour (the
  move machine's handedOver has no timer of its own, as by then the thread
  is the target's and it holds up nothing but another move of it).
- A waking command behind fifty others went unseen: commands carry what
  they'd wake (`wakeLevel`), found by an index.
- Boxes waiting for tomorrow's hours could starve those waiting for room:
  they're kept apart (`waitsForHours`, moved across when their day comes).

A fourth look found four more, two of them the same hole at its root: a
box was given up on errors, timeouts or missed heartbeats. Now only the
provider saying the box is gone, or has lost its disk (a stopped Fly
Machine), does that.

- A resume that failed (three 503s) gave the kept box up for an older
  save. It's now tried again a minute later; the wake's boot timer keeps
  trying a kept box rather than failing it; and each attempt whose box may
  hold work newer than the save is listed on the row (`workAttempts`), so
  the reaper and an archive leave that box alone until a save covers it,
  the provider says it's gone, or the thread's days run out.
- Missed heartbeats replaced a live box. Now the box stays awake, marked
  unreachable (the thread shows its box not answering), its key working
  and its time counting, while `checkBox` asks the provider: gone means
  LOST and a new box; paused means resume; running means keep, and ask
  again in five minutes. A heartbeat clears it.
- A box kept running counts toward `maxBoxes`.
- A stretch awake across midnight UTC counts only its part after midnight
  toward the new day.

### The two invariants

A fifth look found five more, each a new edge of the patches before. So
the service was rebuilt around two invariants, each decided in one place,
and those five fall out of them.

**W (work): a provider machine that may hold work newer than the newest
save it made is never deleted and never superseded.** Retention's end and
the thread's deletion are the only overrides.

- The row lists those machines by attempt (`workAttempts`): an attempt
  joins when its box comes up (READY, RESUMED). A save records the
  attempt that made it (`save.attempt`), and only that attempt's save as
  it stops (to sleep, or to be archived) takes it off the list; a save it
  makes while it keeps working, or another attempt's, doesn't
  (`boxMachine.ts` savedThrough). LOST for attempt N takes off only N, and
  the service reports LOST only on the provider's word (`lostBox`).
- No new attempt is minted, by the service or by the owner's
  `mintBootToken`, while the list isn't empty: `boxes.ts` newAttempt (and
  `mayMintAttempt`), the one place both go through. The service resumes
  that machine, or waits on it, instead.
- With the provider not set up, or no `CONVEX_CLOUD_URL`, an action
  changes nothing and tries again a minute later: never FAILED, never a
  new attempt.
- The reaper and `destroyBox` never delete a machine on the list
  (`boxService.ts` planFor), unless its row has expired or is gone
  altogether.

**M (money): one billing guard, run by the reaper every 5 minutes,
independent of the row's state** (`boxService.ts` entitled and planFor).
It lists the provider's machines; any the provider shows running that
isn't entitled to run now is paused, never deleted. Entitled means: the
row's current attempt, in a running state (booting within its boot timer,
waking within 15 minutes, or up and heard from within 15 minutes), and
within its day's hours (with 10 minutes' grace for the capped save, a save
or archive until its `saveBy`, Mike's `wakePastHours`, or a move going).
A pause that fails is tried again every pass. A box paused that way goes
to sleep as it was (`PAUSED`), its key kept. Running time is charged as
the provider shows it: `observe` charges each pass to a row whose machine
runs while the row isn't up (waking, asleep, kept running, half resumed),
and marks it `seenRunningAt`, which counts toward `maxBoxes`; an up row is
charged by its state, as before. Retention ends every kept box: archived
ones as before, and an asleep thread's box (kept running, paused or
unpausable) after `deleteAfterDays` from when it slept (`retireBox`): the
box is deleted and the thread comes back from its last save, losing any
work newer than that. A wake whose box hasn't come up in 15 minutes stops
(`wakeGaveUp`): the thread sleeps as it was until the next message.

A sixth look found seven more, where the row's view drifted from the
provider's and from what the box's key had done. Two changes of framing:

- **A key that's been used holds work.** An attempt joins `workAttempts`
  the moment its box key makes any call that can write (a heartbeat, a
  take, an append, an upload: `lib.ts keyUsed`, in `runnerAuth`, the one
  gate every box call goes through; `BOX_READS` are the read-only ones),
  not only when the machine says it's up. So a box that half resumed and
  took a message is kept, its key isn't revoked by a timer, and no newer
  attempt can be minted.
- **The reaper reconciles both ways, every pass.** Besides the listing
  against the rows, every row against the listing (`driftPage`): a row
  counted as running whose machine isn't listed running stops being
  counted, and one whose machine is missing is asked about directly and
  reported LOST if the provider has it no more. It takes in the current
  attempt's machine id even when that machine holds work. Delayed actions
  carry what they planned on: `retireBox` takes the sleep it was for, and
  does nothing if the thread has woken and slept since or its days have
  changed.

And: a pause by the guard charges the time the box was up; a box can't
pause only if the size its attempt was made at says so, never from one
refusal (a failed pause is tried again by the guard with a backoff from
5 minutes to an hour, `suspendFails`, per attempt); and a loss while
archiving goes through `lostBox` like every other.

A seventh look found five more, covered by two rules:

- **The fence.** Anything that deletes a machine or supersedes an attempt
  first runs one mutation that checks it may, against the row as it is,
  and revokes the affected key in that same step: `retireFence` before a
  retirement, `deleteFence` before a sleep's delete, `reapStep` before the
  reaper's, and `newAttempt` when any new attempt is minted (refused while
  the older one holds work). With its key gone a box can take nothing and
  write nothing, so no new work can appear behind the decision.
- **One record of unsaved work.** `workAttempts` is it: archiving keeps the
  box (`shelved`) whenever a box may hold work, whatever state it's in,
  and a box asleep with work saves its way out the same way; nothing reads
  `asleep.unsaved` any more. A save sent again doesn't count as work, and
  `DESTROYED` never forgets a machine it kept.

And: a box the guard pauses wakes again for a message already waiting;
the lease checker and the reconciler resume a box they find paused only if
it may run now (`mayRunNow`), else the row follows the provider (`PAUSED`);
and an action waiting for the lease runs again with all its arguments.

An eighth look found four more. Retirement is now durable: its fence
(`RETIRE`) names the attempts whose boxes go and revokes their key in one
step, and the thread is `retiring` until the provider confirms those
boxes gone (`RETIRED`, back to asleep with no box); a message waits
meanwhile, a run cut short is carried on by the reaper (`retryRetiring`, a page at a time),
and only the named attempts are deleted or given up. The other fences
can't strand work: `deleteFence` and the reaper's revoke only an attempt
holding none, and `newAttempt` refuses while one does. Each machine is
charged from its own last observation (`observedAt`, by attempt), so one
machine's pass doesn't shorten another's; and `countRunning` reads the
boxes seen running until it has counted enough distinct ones.

A ninth look found three more, all in retirement: the guard pauses a
retiring machine that's running (retirement still owns its deletion); the
sweep that carries retirements on pages through them all; and archiving
or deleting a retiring thread is kept (`retiring.archived`) and takes
effect once its boxes are gone (to `gone`, or `expired` with no save). An
asleep thread with no box keeps its save while its thread lives (it comes
back from it); one archived or deleted whose box missed the archive is
archived by the retention sweep, so its save gets its days.

A tenth look was about scheduling, so three rules now hold for every
sweep and provider step in `boxService.ts` and `boxes.ts`:

1. **No step is lost to lease contention.** Every action that can't get a
   box's op lease runs again shortly with all its arguments: the ones
   under `withOp` (create, wake, sleep, delete, check, retire), the
   guard's and reaper's steps (`reapOne`), and the drift check
   (`driftOne`). And a lease holder does the guard's part while it holds
   it: a retirement pauses a running machine before deleting it.
2. **No action outruns its time.** The reaper's pass only lists, charges
   and plans; each step that calls the provider (a delete, a pause, a
   loss, a drift check) is a run of its own. Runs that call the provider
   several times (`withOp`'s) have a budget (`ACTION_BUDGET_MS`, 6
   minutes): a call isn't started without its worst case left, and the run
   carries on in a new one. A machine whose delete failed waits out a
   backoff (`boxDeleteBackoff`, 5 minutes doubling to an hour) before it's
   tried again, by the reaper, an archive's delete or a retirement, so a
   broken one doesn't hold up the rest.
3. **Every retry sweep pages**: boxes stuck being deleted
   (`retryDestroying`), retirements (`retryRetiring`), kept boxes' saves,
   idle checks, retention, drift and the virtual runners themselves. The
   waiting-to-wake queues and an expired thread's commands are consumed as
   they're read (each row leaves the queue, or the sweep stops for lack of
   room), and `countBoxes` only counts.

An eleventh look added to rule 2: **a continuation keeps the progress
of the run before it.** A run out of its budget carries what it got done
into its continuation's arguments: a retirement's pause is one try, backed
off on failure (`suspendFails`) and listed as tried (`pauseTried`), so its
continuation goes straight on to the delete. A try of a provider call is
started only with its own worst case left (by the requests it makes:
a pause or resume three, a create four); a sleep doesn't try a pause that's
backing off; and a new attempt is claimed only with the time left to make
its box, so a continuation never strands a boot token. Deletes go on in
their own continuations (each machine done is done), and the others have
one step or repeat harmlessly. And a reaper step queued for a machine
(`reapQueued`) isn't queued again until it ends, and its delete waits out
a backoff recorded after it was queued.

A twelfth look found three more, all from **duplicates**: two provider
machines tagged with the same box and attempt. Machines are now told
apart by their provider id wherever a loss, keep or guard decision is
made. A `LOST` or `PAUSED` names its machine (`providerBoxId`), and
`boxes:report` takes it only if that's the row's own machine. In the
reaper's plan, a stopped machine that isn't the row's is just deleted (it
holds nothing the row relies on), and a duplicate is never entitled to run:
the guard pauses it, then keeps it if its attempt may hold work (which of
the two holds it can't be told) or deletes it. A delete's fence revokes the
key only for the row's own machine. A pause's backoff (`suspendFails`) and
each machine's charge (`observedAt`) are kept by machine id. And a queued
reaper step's mark has a generation (`reapQueued.gen`), so an old step
ending doesn't clear a newer one's.

A thirteenth look found that the row couldn't tell which duplicate held
the key: the row took whichever machine's `CREATED` came, so the other's
stop could be taken for the key holder's loss. The exchange now names its
machine (`machineId`, from `FLY_MACHINE_ID`; the runner sends it from
slice 3) and the row records it (`keyMachineId`). For the key holder's
attempt, that machine is the row's: the reaper takes it in and deletes
the other, and no `CREATED`, `LOST` or `PAUSED` of the other counts. With
no id said, every machine of that attempt is kept while another is
listed: none is reported lost (reaper, drift, lease check, sleep or wake),
taken in or deleted for the key; one that's stopped and not the row's is
deleted, and a wake waits. Observed charging leaves out only the machine
whose time the row's state charges, so a running duplicate is charged by
its own observation. And a reaper step's queue mark carries a random job
id (`reapQueued.job`), not a generation, which started again at 1 once a
mark was deleted.

A fourteenth look found two ways a wake could wait for good. A key
holder's machine the row never took in (its `CREATED` lost) that the
provider then lost was never reported lost; and with no machine id said,
the one machine left after the row's own was lost stayed a paused
"duplicate". Now a wake, a lease check and the reconciler make sure of the
key holder's machine first (`identify`): a known one is taken in, or its
loss reported once the provider confirms it gone by its id (`get`). Not
known, the row's machine gone: none left is a loss, one left is the key
holder by elimination, and several are resumed one per wake, alone, the
one whose key heartbeat follows being the holder (`unsure`, and a box's
heartbeat can name its machine too). One that never answers, or a wake
that gives up still unsure, shows on the thread (`RemoteRunner.box.unsure`).

A fifteenth look found three more. A create whose answer came very late
could report `FAILED` for an attempt whose box had already traded its
token and was working, revoking its key and stranding its work: `FAILED`
is now refused for an attempt that has exchanged or may hold work
(`unexchanged`), and a late `CREATED` naming another machine for an
attempt the row already names is a duplicate's. A machine taken in by
elimination is only a guess (`unsure`, never `keyMachineId`), so it
deletes no other machine and refuses no report; a box's own word replaces
it. And a machine resumed while it's unsure is a trial: the thread stays
waking until its key heartbeat, and one that stops or stays silent past
`TRIAL_MS` is paused and the next tried.

A sixteenth look found that a refused `CREATED` was taken as leave to
delete its machine: with Fly duplicates, the create's late answer for the
key holder's machine was refused (the row named the other) and the key
holder deleted. Now a `CREATED` naming the key holder's machine (by the
box's word) makes it the row's, and a refused one deletes its machine only
if the reaper's plan and fence would, in the same check
(`deleteIfReaperWould`). The reaper doesn't take a machine in while an
action holds the box's lease.

That left one gap, closed the next day: a machine the reaper decides to
delete that hadn't traded the token yet could trade it between that step
and the provider's delete. The fence now condemns it in the same step (a
`boxCondemned` row of its own, with when, never capped; unmarked only once
its delete succeeds or a listing asked for after the mark lacks it): its exchange is
refused, as is any exchange that doesn't name its machine while one of its
attempt is condemned, and a heartbeat naming it gives it nothing.

The third slice (19 Nov 2026), the runner's **box mode**
(`runner/src/box-mode.ts`, `box-save.ts`, `clock-jump.ts`; docs/protocol/boxes.md
"Box mode"), with tests in `runner/test/unit/box-mode.test.ts` (the real
runner entry point among them), `box-save.test.ts` and
`clock-jump.test.ts`:

- **Starting.** `THREADBEAR_BOX_BOOT` set means box mode. The boot token
  is read and taken out of the environment first, then traded at
  `THREADBEAR_SYNC_URL` with the machine's id (the variable the service now
  names in `THREADBEAR_MACHINE_ID_ENV`, from the provider's
  `machineIdEnv`; `FLY_MACHINE_ID` if it names none). The exchange now
  also gives the box its `login`. What it got goes in the data dir's
  secrets (`box.json`, `convex-key`) and the token in claude-main's
  `threadbear-token.json`, each 0600; a runner that restarts on the same
  machine uses them rather than the spent token.
- **The folder**: the repo cloned into `~/work` on its base branch, and the
  `create` makes the thread under its own id in the subfolder, with a
  worktree as any new thread in that repo gets (the clone trusted as the
  runner's own checkout); or, with a save, the save restored on the clone
  and the same session resumed.
- **Limits** (decision 1): no self-update, CLI updates, keep-awake,
  `followOrigin`, reinstaller, Sentry, schedules, librarian or spare-week
  threads; no presence, logins, projects, pools or machine figures sent;
  one thread (`Runner.boxThread`); the login's email given; `IS_SANDBOX=1`.
- **Superseded**: a call refused as a bad key ends the box: no more calls,
  its CLI stopped, the process exits (no `bye`).
- **The `save` command**: the thread's folder, transcript and git work
  (move-pack.ts and move-git.ts, as decision 7 planned), sealed under the
  thread key, uploaded on the box key and named in `boxSaved`. Over one
  upload (10 MB) it fails, saying so.
- **Clock jumps**, for every runner: a wall-clock jump of over 15 s between
  2-second ticks (a box resumed, a Mac waking) makes the sync's Convex
  client again at once and heartbeats, at most every 30 s. The spike
  measured 60 s to 3.3 s on Fly.

Codex's review of the third slice (19 Nov 2026) found five holes and two
follow-ups, fixed with a test each (`box-mode.test.ts`, `box-save.test.ts`,
`boxes-backend.test.ts`):

- A save left the thread working, so work after the copy was lost once
  `SAVED` let the box go. Every save now stops the thread first (turn
  interrupted, CLI and background jobs stopped) and keeps its turns held
  until the box is woken (`Runner.quiesceForSave`, `releaseTurns`).
- An established box whose folder had gone deleted what was left and
  restored the exchange's (older) save over it. Now only the start that
  traded the token makes the folder, into an empty place, deleting nothing.
- An untracked `node_modules` made an acknowledged save unrestorable: it's
  left out of the save now (`packGit`'s `leaveOut`).
- The save wasn't held to the restore's limits: it is now (100,000 files,
  128 MB unpacked since the second look, the restore's allowance lowered from a move's 1 GB to
  that), and it's read back before it's uploaded.
- A box loaded every thread record on its disk: only its own now
  (`Runner.start`, `adopt`).
- A restored thread's turns could start before its worktree's setup had
  run: they're held until it has (`boxSetupPending`, `setUpRestored`).
- A lost exchange answer couldn't be asked for again: the box makes its
  own key and sends its hash, and the backend replays the answer to the
  same token, machine and hash (`boxes.exchanged`, `peekReplay`).

A second look at those found six more and a follow-up, fixed the same way.
The rule three of them share: **once a stopping save has started, the box
runs nothing until the backend says it may** (a command other than a save
taken after the save's outcome is known, or a heartbeat sent after that
finding the box `awake`); nothing local lets it go (`SaveHold`).

- A lost `boxSaved` answer let the thread go while the backend might be
  deleting the box: it's sent again with the same file (the backend takes
  a repeat as the same save), and an outcome never known keeps it held.
- A clock jump let a save's hold go: it no longer does.
- `leaveOut` dropped changes to tracked files under `node_modules`: only
  untracked ones are left out now; a tracked change fails the save.
- A restored worktree's setup could write during a save: the save waits for it.
- A box whose folder had gone exited, and on Fly its disk went with it: an
  established box now stays up degraded (heartbeating, running nothing,
  saying why on the thread) for the guard to pause and a person to see to.
- A save could be bigger than a small replacement box could read: boxes are
  1024 MB at least (`MIN_BOX_MB`), and a save 128 MB unpacked at most. The
  restore still gunzips into one buffer (its files are views of it, not
  copies); streaming it would need a format that names its files before
  their bytes, which waits for chunked saves.
- A restored setup that hadn't finished was forgotten on a restart: it's
  kept apart from `prepared` (`setUp`), and run again, turns held, until it has.

A third look found five more and a follow-up. A save now stops the box
**categorically**: once the CLI is closed, every other process in the box
is killed (`box-procs.ts`: all but the runner, its ancestors, PID 1 and
what the provider was running when the box booted), the runner's own work
is waited for, and it looks again before anything is copied; an archive's
cleanup meanwhile is owed instead. That covers a restored setup's
background children and a teardown starting after the CLI closed. And:

- The save hold is kept in `box.json` (`saveHold`) before the thread is
  touched, so a restart mid-save, or with its outcome unknown, starts held.
- A save's size is checked from the disk before anything is read.
- A file staged under `node_modules` was dropped: the save starts from the
  checkout's own index now, and only files that index doesn't have are
  left out; a staged or tracked change there fails the save.
- Heartbeats and the save's finish while held marked the box as working
  again: they send `held`, which `runnerAuth` takes as housekeeping.

A fourth look found three more ways to lose work, and a follow-up:

- The provider's processes were taken afresh at every start, so an agent's
  process that outlived a runner restart was spared: the baseline is taken
  once, by the first start after the exchange, and kept in `box.json`.
- A zombie thread-group leader with live threads was skipped: a process
  is alive while any of its tasks is, and its group is killed.
- The save's copy of the index kept assume-unchanged and skip-worktree,
  hiding real changes (the fifth look replaced the copy altogether, below).
- The mirror's flush before `boxSaved` wasn't sure: `flushAll` waits for one
  going, runs its own to the end, and fails the save if anything's left.

A fifth look found two more and a follow-up:

- The copied index's stat data let git keep an edit that kept a file's
  size and mtime (with `core.checkStat` minimal and `core.trustctime`
  off). The save's index is now built from HEAD, which has no stat data,
  every file hashed afresh with those settings overridden, plus the
  checkout's staged paths force-added; `untrustedGit` no longer needs
  `update-index`.
- Every fresh box's first flush called `sync:prune`, which a box key can't,
  so its mirror never finished and no save could: a box skips it (and
  projects' pictures). The box tests' fake backend now refuses anything
  not in `BOX_CALLS`, so a call like that can't hide in a fake again.
- `flushAll` now drains the sidebar index's writer too.

A sixth look found two more and two follow-ups:

- An agent's `schedule_message` started the box's scheduler, arming timers
  and checks that could write after a save's copy: a box's scheduler now
  refuses every way in (`Scheduler`'s `refuse`), saying the Mac schedules it.
- A symlink staged with `-f` whose target was missing was dropped (an
  `existsSync` that followed it): `lstat` now.
- Commands' finishes still to send could mark a saved box as working: the
  save's barrier sends those from before it, and any other command's
  finish waits while the save goes.
- A box key counted as the owner's, so `create_thread` on another runner
  tried to start it directly: a box files the request, as any runner key.

A seventh look found one more and a follow-up:

- A patch's live poll ran its functions, and the commands they run, while
  a save held the box. Now one gate stops every process start in the
  runner while a save holds it (`spawn-gate.ts`, on `node:child_process`
  itself, with a test that it covers every way the module starts one and
  that nothing in `runner/src` goes round it), the save's own git let by;
  the live poll doesn't read the thread's patches while it's held, and the
  save waits for a read already going.
- The save's barrier could race a heartbeat's retry of the same finish,
  and the backend marked a repeated finish as work: finishes now go one
  at a time per command, and a finish that changes nothing is housekeeping.

An eighth look found one more and a follow-up:

- A patch's code runs inside the runner, so a timer or worker it started
  could write behind a save's copy with no process to stop. In box mode no
  patch code runs in the runner's process at all: each file is read in a
  child process that prints what's static in it and exits
  (`patch-child.ts`), and functions (`when`, `badge`, `items` and the rest)
  aren't run, so what has one isn't shown on a box's thread.
- The gate's `exec` and `execFile` lost `util.promisify`'s contract: their
  replacements carry it now, through the gate.

A ninth look found two more in that loader: a process the patch left
holding the loader's stdout kept the read (and the thread's first turn)
waiting for ever, and anything the patch printed spoiled its reply. The
loader now runs in a process group of its own, the read ends on the reply,
the loader's exit or a timeout, and the group is killed; the reply comes on
fd 3, and the patch's stdout and stderr are thrown away.

Where it differs from the plan: the Claude token is on the box's disk, in
`threadbear-token.json`, rather than only in the runner's memory as
decision 10 says, so the runner's existing year-long token path carries it
to the CLI and a restarted runner still has it; the box's disk is the
box's alone, and goes with it. And the save doesn't yet push the thread's
branch and `refs/threadbear/save` to `origin` (that waits for GitHub
tokens, decision 11).

The fourth slice (19 Nov 2026), the **box image** (`runner/box/Dockerfile`,
`entrypoint.sh`, `smoke.sh`, `runner/.dockerignore`), built and published by
`.github/workflows/box-image.yml` (Faster starts, 1):

- **What's in it.** For linux/amd64, Fly's default: Node 24 on Debian 13
  (`node:24-trixie-slim`, pinned by digest) with git, procps and ca-certificates
  exactly as `runner/box/debs.lock` names them (below); Claude Code's native
  linux-x64 build at a pinned version, checked against its SHA-256
  (`CLAUDE_CODE_VERSION`, `CLAUDE_CODE_SHA256`), where its installer puts
  it (`~/.local/bin/claude`, a link into `~/.local/share/claude/versions`),
  with `DISABLE_AUTOUPDATER` set; and the runner from the commit being
  built, as a release holds it (`src`, `bin`, the package files, `npm ci
  --omit=dev`), with a `release.json` naming the commit, so it reports
  `0.1.0+<built>-<commit>`. The agent SDK's own copy of Claude Code (some
  250 MB) is left out, as the runner always names the CLI. No secrets.
  About 1.3 GB unpacked (Claude Code 373 MB, the runner's packages 218
  MB) and 330 MB to pull; the first build, on the Hetzner box, took about
  4 minutes.
- **Its entrypoint** runs the runner in box mode, as the service passes no
  command; with no `THREADBEAR_BOX_BOOT` or `THREADBEAR_SYNC_URL` it stops
  at once (64), saying why, rather than start an ordinary runner. As root
  (Claude Code with `IS_SANDBOX=1`), in `/work` (`THREADBEAR_BOX_WORK`),
  with the runner's log on stderr too, so the provider's logs show a box's
  start (Faster starts, 2). Nothing restarts the runner: when it exits the
  machine stops, as the Fly adapter's `restart: no` intends.
- **Which runner it is.** Built from the repo at a commit rather than from
  a signed release, so it's the runner Mike's backend is deployed from: a
  push to main that changes what the image holds pushes
  `registry.fly.io/<FLY_APP>:<commit>`, and once the runner's typecheck and
  unit tests pass on that commit (the workflow runs them beside the
  build; until 23 Nov a main failing them still went to new boxes as
  `:latest`), and only while that commit is still main's head by GitHub's
  API, so a re-run of an older run promotes nothing, it's promoted.
- **Booted by digest, never by tag** (Daybreak 171, 23 Nov;
  `convex/boxImage.ts`). A box's image gets its boot token, which trades
  for the login's Claude token and the thread's key, and a tag is only a
  name anyone who can push to the app's registry can move. So the
  workflow promotes the image to the backend by the
  digest its own push reported (`POST /box-image/promote`), with the job's
  GitHub OIDC token for the deployment's `CONVEX_SITE_URL` (the repo
  variable `BOX_PROMOTE_URL`); the backend takes one only from
  `box-image.yml` on main in the repo `BOX_IMAGE_REPO` names, and only
  newer than the last. No shared secret: `FLY_BOX_IMAGE_TOKEN`, which
  pushes images, can't promote one, so a stolen push token or a moved tag
  reaches no box; a change to main's workflow, or GitHub itself, still
  could. The build takes no cache from the registry and no `:latest` is
  pushed: a pushed cache could hand the build layers it never ran, which
  the workflow would then promote under its own name (the fix's second
  review). `setRunnerService` makes a virtual runner that follows main when
  it names no image (`defaultBoxImage`; its row keeps
  `registry.fly.io/<FLY_APP>:latest` as the sign for that), and each new
  box of it boots the digest promoted when the box is claimed; with none
  promoted, the box fails, saying so, and nothing is made. An image given
  must be a digest (`registry.fly.io/<app>@sha256:...`), and a row left with
  any other tag makes no box. The Fly adapter refuses a tag too. A new box is ten minutes or
  so behind main while the image builds and the tests run; the runner and backend stay compatible both ways,
  as for any runner. A release tag publishes `:release-<date>` too: a
  virtual runner pinned to a release names that image's digest. A fork's push builds its own, into its
  own Fly app (docs/forking.md).
- **Private, in the boxes' own Fly app** (Mike, 19 Nov). The image holds
  Claude Code, which isn't open source, so publishing it would
  redistribute Anthropic's program. It goes to the private registry of
  the Fly app the boxes live in (Mike's is `tb-boxes-mikecann`), which
  Fly pulls from for that app's machines with no credentials. GitHub
  pushes with `FLY_BOX_IMAGE_TOKEN`, a token that reaches that app only
  (Mike's org token narrowed with `fly tokens attenuate`, so it ends when
  that token does, 16 Dec 2026). The passed-over choices were a public
  image without Claude Code, installed at each box's start (about 20 s
  slower), and a public image with it.
- **Checked before it's pushed** (`smoke.sh`, no secrets): with no boot
  token it exits 64 and says why; Claude Code runs at the version its link
  names, with git, ps and the runner's version; and in box mode the whole
  runner loads and trades its boot token at `THREADBEAR_SYNC_URL` with a
  stand-in for Convex in the same container, which refuses it (`auth`),
  and the runner stops at once, saying so.
- **Moving Claude Code on** is by hand: both values from its release
  manifest (the Dockerfile says how), in a commit that rebuilds the image.
  Until then a box runs that version, while Mike's other runners follow
  Claude Code's latest. It's fetched with Node's own fetch: the image
  build runs no apt and no curl.
- **Debian's packages from a lock** (Daybreak, 24 Nov: until then the
  build ran `apt-get update && apt-get install`, so rebuilding a commit took
  whatever the archive, or anyone who could sign for it, published that
  day). `runner/box/debs.lock` names every package the box adds (git,
  procps, ca-certificates and their 37 dependencies) by name, version,
  architecture, size and SHA-256, from one dated snapshot of Debian's
  archive, resolved against the pinned base image; `box/debs.ts` fetches
  each (from snapshot.debian.org, else deb.debian.org) and checks it, and
  only when all of them match does `dpkg -i` see any, so a different file
  stops the build before a package script runs; after the install, dpkg must
  have each at its locked version. A download has a deadline and is read
  only up to the locked size. The lock stays in the image at
  `/opt/threadbear/box/debs.lock`, and its hash and snapshot are the
  image's `dev.threadbear.box.debs-lock` and `-snapshot` labels. Moving it on (a Debian security
  update, a new base image) is `runner/box/lock-debs.sh [YYYYMMDDTHHMMSSZ]`
  on a machine with Docker that runs linux/amd64 (the Hetzner box), then
  reading the diff and committing it, which rebuilds the image. apt reads
  the snapshot over http inside the base image (which has no CA
  certificates yet), so the script fetches each index apt used again over
  https and stops unless they're the same bytes. Until then
  a box keeps the packages it has, security fixes included: that's the
  trade for knowing what's in it. A test fails when the Dockerfile's base
  image changes without a new lock.

The fifth slice (19 Nov 2026), **starting from the Mac and the token
card** (docs/protocol.md, Virtual runners: "Waiting for a cloud token",
"Cloud tokens' lifecycle", "Cloud tokens on the Mac", "Starting from the
Mac"; Box mode, "A refused token"), behind the `virtualRunners` experiment
(decision 14), with tests in `box-service.test.ts`, `boxes-backend.test.ts`,
`virtual-runners.test.ts`, `thread-index.test.ts`, `thread-keys.test.ts`,
`box-mode.test.ts`, desktop/core's unit tests and
`features/virtual-runners.feature`:

- **Runs on.** After the machines, one entry per virtual runner
  (`RemoteThreads.services`, from `boxes:runnerServices`), with a cloud
  icon and no online word; it's in Default too. A box's own runner is never
  listed as a machine (Runs on, Move to, Settings, schedules). With one
  picked, the folder and login are this Mac's: `threads.create` with
  `serviceId` reads the repo here (`runner/src/virtual-runners.ts`: origin
  without credentials, subfolder, the upstream or origin's default branch)
  and the login's email, and calls `boxes:startThread`, which now writes
  the thread's sidebar row at once, so it's listed while it waits.
- **Rows.** "Starting a machine" and "Waking" with the small spinner,
  "Asleep" as quietly as a hibernating thread, and "Needs a cloud token"
  with the needs-you mark (`desktop/core`, the row rule).
- **The token card** (Mike's option C, 17 Nov), on the thread's message box
  where the limit box goes, while its box's login has no cloud token or a
  refused one (`RemoteRunner.box.token`): Make one (the runner runs `claude
  setup-token` headless in a pseudo-terminal as that login,
  `runner/src/cloud-token-helper.py`, and sends the token to
  `setCloudToken`), Paste a token, and Use this Mac's token when that login
  has a year-long token here. A click shows a spinner with the buttons off
  until the runner answers.
- **Waiting for a token** (backend API 94). A login's cloud token is a
  state machine (`cloudTokenMachine.ts`: valid, dead), and a box whose
  login has none, or a dead one, starts in `needsToken`: nothing is asked
  of the provider until a token is set, which puts it in its virtual
  runner's queue for room (`waitingForRoom`), started oldest first under
  `maxBoxes` whatever released it; one whose token was refused meanwhile
  goes back to waiting for a token (Codex's second look). Archiving one that
  never started ends it there and then, its archive done and its sidebar
  row archived (Codex's review of slice 5, with the first sidebar row's
  secrets scrubbed).
- **A refused token.** A box's turn refused with a 401 sends
  `boxes:tokenRefused` (only its own grant is quarantined), holds the thread
  and asks `boxes:boxCloudToken` every 30 s; a newer token is written in,
  the CLI closed, and the thread carries on by itself
  (`runner/src/box-token.ts`). Only that box’s card comes back meanwhile; other threads keep using the login token. An owner SET releases grants already quarantined; active boxes cannot fetch a succession of replacements.

Not built in this slice: Settings' list of cloud tokens with their expiry,
a picture with a virtual runner thread's first message, and the first
message showing in the thread before the box has written it (the row's
preview has it).

Not built yet, in about the order they're needed:

- TODO a real box started from the Mac end to end, on Fly with the box
  image.
- TODO a save bigger than one upload, 10 MB, in chunks, as a move's are;
  and the save's push of the branch and `refs/threadbear/save` (decision
  7), with GitHub tokens (decision 11).
- TODO a lost box's taken command put back to pending once (decision 12).
- TODO starting and waking from the phone (`startThread` takes the owner
  key only), and archiving a sleeping box's thread without waking it.
- TODO the phone (Order, 4), Settings' section per virtual runner and its
  cloud tokens, and the experiment made standard (14).

## Order

1. **Spike, outside the app** (`runner/box/spike/`), on **Fly Machines and
   Daytona** (Mike has accounts with both, so nothing to sign up for; E2B
   can be a third later). The image, both adapters, a throwaway Convex
   deployment. It should prove:
   - **A paused box comes back as the same runner.** Pause for 10 minutes
     with the runner's Convex connection open, then resume: it reconnects
     and heartbeats, a command queued while it was paused stays `pending`
     and is taken exactly once. A repeated create with the same
     idempotency key doesn't make a second box. If neither provider's
     pause keeps the process reliably, stop and rethink.
   - **Losing a box loses nothing.** Destroy a paused box under a thread
     with uncommitted work: a new box restores the save, resumes the same
     Claude session with the work intact, and the old credential is
     refused.
     Passed 18 Nov on Fly with a stand-in for the runner
     (`runner/box/spike/lose-box.ts`); the git push of the save ref waits
     for GitHub tokens.
   - **Claude Code runs on the setup token from Convex**: one real turn on
     the cheapest model, with the token reaching the box only through the
     boot exchange, and absent from the provider's machine config.
     Passed 17 Nov (`runner/box/spike/claude-turn.ts`).
   - The numbers: cold start to first reply including clone and worktree
     setup on threadbear itself, warm wake to first reply, and the cost of
     an hour awake, paused and saved.
     Measured 18 Nov on Fly with the real runner
     (`runner/box/spike/cold-start.ts`): 159 s from create to first reply,
     about 88 s once Claude Code and the runner are baked into the image;
     5.3 s from resume to a reply; about 1.9 cents an hour awake and well
     under a tenth of a cent paused.
2. **Box mode, box keys and `boxes:startThread`**: one thread started from
   the Mac app on one provider, runs a turn, saves, sleeps, wakes on a
   message, archived and deleted. The backend's box keys, boot exchange,
   cloud tokens and box machine are built ("What's built"); the rest of
   this step is its TODO list.
3. **The second provider in the app**, to prove the interface isn't shaped
   like the first.
4. **The GPUI app**: the Runs-on entry, Starting/Asleep/Waking on rows,
   the Settings section. Then the phone.
5. **Move to** and from a virtual runner, GitHub tokens from Convex,
   limits and costs in Settings.

Everything here goes through the cross-lab review in Mike's global instructions before
it's called done.

## Faster starts

Mike, 18 Nov, after the cold start took 159 s on Fly: "The spin up time is
annoying, but I guess a lot of companies solve that by having warm boxes".
He chose to stay on Fly (it's about a seventh of E2B's price for the same
box). Where the time went, and what takes each part away, cheapest first:

1. **Bake the image** (71 s: installing Claude Code and the runner's
   packages). The box image carries both. No running cost. Built 19 Nov
   (slice 4, "What's built"); its first real start will say what's left.
2. **Find the 30 s** between a new thread and its first text that the
   setup and the turn don't explain. Read the runner's log in box mode.
3. **A pool of suspended spare boxes.** The service keeps a few boxes
   already booted with the runner up but no thread and no secrets, then
   suspended. On Fly a suspended Machine bills only its root disk ($0.15
   per GB-month, so cents a month each), and resuming took 1.1 s with a
   reply 5.3 s after. Starting a thread takes a spare, gives it a boot
   token by command (decision 5 still holds: nothing reusable is in its
   environment), and the service makes a new spare behind it. Spares are
   wiped and replaced, never reused after a thread.
4. **A spare per repo with the clone already in it** (16 s of clone, 11 s
   of setup): the spare is made for a repo, cloned and set up, and does a
   `git fetch` when it's taken. Worth it only for repos used often; the
   rest take a plain spare.
5. **Start booting early**: when Cloud is picked in Runs-on, before the
   message is sent.

1 and 2 belong in box mode. 3 to 5 come after it works end to end.

## Questions for Mike

- **The login** (answered 17 Nov): a setup token pasted once and kept in
  Convex, as Capy does it, not a proxy. See 10.

## What the review changed

The first draft (same day) was reviewed by Fable, Opus and Grok, each
reading the code. All three kept "a whole runner per box" and "the
service in Convex". What changed:

- **Runner keys can't be used for boxes** (all three): there are at most
  three, and a new one drops shared logins. Hence box keys (4).
- **A sleeping box would be refused as offline** before any wake could be
  scheduled, on the Mac and the phone alike, and a remote create errors
  after 30 s (all three). Hence 6.
- **Parking through the move protocol doesn't work** (all three): a move
  needs an online target, a running source to pack, and deletes its chunks
  at the end. And a provider can lose a paused box, so a thread that lives
  only in a paused box can be lost (Opus). Hence saving on every sleep
  (7), which also makes every provider able to sleep.
- **A new `runnerId` per box** would make every wake a move (Opus).
  Hence one per thread (3).
- **Secrets in the environment and a shared sealing key** were the
  biggest holes (all three): the setup token in the box is a whole
  subscription handed to an agent that runs untrusted code. Hence the
  boot-token exchange (5) and per-thread keys (7). The login proxy the
  panel suggested was later dropped for a token kept in Convex (10).
- **GitHub tokens**: the box mustn't choose the repo, and the `cloud/**`
  ruleset only exists on threadbear (Opus). Hence 11.
- **Lost commands, duplicate boxes and runaway boxes** (Grok, Fable):
  idempotent creates, requeueing a dead box's taken command, a heartbeat
  lease and an awake cap that sleeps. Hence 9 and 12.
- **The spike** now tests what the providers don't advertise (a pause
  with a live connection, losing a box, no token in the box) rather than
  their brochure.
