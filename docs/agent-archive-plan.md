# Agent Archive through Threadbear

Plan written 20 Nov 2026 (thread b2612e00, asked for by the weekly Convex
usage check, ff30633e). Mike said build it the same day; stages 1 and 2 are
built behind the `archive` experiment (runner/src/experiments/archive.md),
the rest waits. Five changes he agreed before the build are folded in below:
the sync stays a background service of its own, Tinker Desk is out (it has
no runner), the experiment's check-in asks about the next stage, the two
repos stay apart until stage 4, and stage 2 comes straight after stage 1.

Mike wants Agent Archive (`~/dev/me/agent-archive`, private) done through
Threadbear, so there's one daemon, one search and one place agents ask,
instead of two systems that each read the same CLI folders on the same
Macs. Three shapes were sketched (`docs/agent-archive-design/`) and he
picked A: **every runner feeds one archive host**.

## The idea

Each runner sends what its machine's agents did to one archive host: a URL
and a token in its settings. The host stores it faithfully, forever, and
answers search. Anything that speaks the host contract can be the host:

- Bruce, as today, for Mike.
- The same Mac on loopback, for someone with one Mac.
- Another machine on Tailscale, or a cloud box.
- Convex, since Agent Archive's original Convex backend speaks the same
  contract (`convex/http.ts`, kept in step by `contractParity.test.ts`).
  It can't fit the free plan, so it's only for someone on a paid plan who
  wants it, and it isn't the supported host (below, "One host to keep").

Convex's mirror stays what it is: live state, small, made to fit a
stranger's free plan. History never goes into it. That's what took Agent
Archive's Convex to 137 GB of I/O in a month (docs/convex-backend.md), and
it's why full sync (30 days of scrubbed tool output in the mirror) is
nothing to do with this.

```text
  M5 runner              cloud runner              Bruce runner
     |                        |                         |
     | each machine's sync: CLI folders (Claude, Codex, Grok, Muse),    |
     | RememBear summaries, plus which Threadbear thread is which
     v                        v                         v
  +---------------------------------------------------------------+
  |  archive host (Bruce): SQLite + FTS5, LanceDB, files; 27 GB   |
  |  daemon RPC   search   reader   Quick Ask                     |
  +---------------------------------------------------------------+
     ^                  ^                         ^
  agents' archive    the reader (browser,      phone Ask
  tools (MCP)        later a Threadbear panel)
```

## What there is today

- **The daemon** (`daemon/`, 12k lines): a LaunchAgent on the M5 and on
  Bruce, polling every 10 minutes. It reads Claude, Codex, Grok and Muse
  history read-only, including sessions run outside Threadbear, redacts
  secrets, and uploads through one RPC route, `POST /api/daemon/rpc`, with
  a device token kept in Keychain. Per-file checkpoints in
  `sync-state.json` mean a file is only re-sent when it changed.
  The cloud runner has no daemon, so its threads aren't archived. (Tinker
  Desk runs no Threadbear and isn't part of this.)
- **The host** (`server/`, 26k lines): one Node process on Bruce since
  24 Oct, at `https://bruce.<tailnet>.ts.net:9443` (tailnet only). 27 GB
  on 20 Nov: `archive.db` 6 GB, files 12 GB, vectors 8.6 GB (LanceDB and
  `vectors.db`). Hybrid search, the indexer (embeddings through Mike's
  OpenRouter key), the reader, Quick Ask. Its own LaunchAgent and deployer.
- **The MCP server** (`mcp/`, 4k lines): `get_archive_context`,
  `search_archive`, `read_archive_thread`, `list_recent_threads`,
  `list_user_messages`, `find_computer_history`,
  `read_computer_history_summary`, with a read-only token. Registered in
  Mike's global Claude and Codex config, so every thread, in Threadbear or
  not, has them. The `agent-archive` and `agent-archive-lessons` skills sit
  on top.
- **The Convex backend** (`convex/`): the old host, kept until stage 15 of
  `docs/bruce-migration.md` there. Its cloud project was deleted 29 Oct.
- **On Threadbear's side**: `runner/src/redaction.ts` is a copy of the
  archive's `shared/redaction.ts`; Ask on the phone talks to the host
  (docs/ask-server.md); and `archivedMediaDays` (housekeeping.ts) only
  clears archived threads' pictures on Mike's runners, "as Agent Archive
  keeps its own copy", with strangers' kept "until archiving to their own
  storage is worked out". This plan is that.

## What changes for each part

| | Today | With this plan |
|---|---|---|
| Sync | a daemon LaunchAgent on the M5 and Bruce, updated by hand on the M5 | the same service on every runner's machine (cloud too), kept on main and watched by Threadbear |
| Host | Bruce, its own LaunchAgent and deployer | Bruce, started by Bruce's runner, updated with Threadbear's releases |
| Agents' tools | the agent-archive MCP server, global config | the same seven tools, same names, from the runner's release |
| Reader | `bruce.<tailnet>.ts.net:9443` | the same, plus an Archive panel in Threadbear and links both ways |
| Quick Ask | the host's `/api/quick/ask` | unchanged |
| The 27 GB | on Bruce | stays on Bruce. Nothing is copied |
| Code | the agent-archive repo | Threadbear's repo, once Mike makes it public (stage 4) |

## Decisions in this plan

**The CLI folders stay the source.** The runner has every event of its own
threads, but the archive keeps reading the CLIs' own files. They cover
sessions run outside Threadbear with the same code, they're what the
archive's importers, checkpoints and repairs are built on, and the
archive's promise is the CLI's own record, not Threadbear's view of it.
What the runner adds is what only it knows (stage 2): which session
belongs to which Threadbear thread, its title, project, runner and
account.

**The sync stays a background service of its own.** The first draft had the
runner start the sync as a child process. But the runner moves to a new
release several times an hour (three in the hour before the build), and
each move would stop the sync mid-upload, so a big transcript (one is
418 MB) could keep starting over. So the sync stays a LaunchAgent (systemd
on Linux), and Threadbear updates and watches it instead: runner restarts
never touch it. Its lock, checkpoints and backoff stay the archive's own.
The same goes for the server on Bruce in stage 3.

**The runner never holds an archive credential.** It writes what only it
knows to a file in its data folder, and the archive's sync, which has the
device token already, reads the file and sends it up. So nothing in
Threadbear can upload to or read from the archive by itself.

**The archive's tools stay a server of their own.** Adding seven tools to
the `threadbear` MCP would put them in every stranger's thread, on the
context budget (`runner/context-budget.json`). When the archive is on, the
runner registers an `agent-archive` MCP server for its threads, the same
name and tools Mike's global config has now, so his skills, memories and
habits keep working. It's also a plain stdio command, so terminal Claude
and Codex sessions can keep using it.

**One host to keep.** Two host implementations means every change to
search, the reader or Quick Ask made twice. The Node server is the
supported host. The contract is written down so anyone can point a runner
at something else, and the Convex host goes with bruce-migration's stage 15
unless Mike wants it kept.

**An experiment first.** It changes what runs on the machine and what's
sent where, so it lands as an experiment, `archive`, off by default and on
for Mike (AGENTS.md, "Experiments"). It can't go on for everyone until the
code is public (stage 4), so its check-in (schedule 1a56bc60, 24 Nov) asks
whether to go on to the next stage, not whether to make it standard. For
anyone else it only keeps the sessions list, and its description says it's
for people running Agent Archive.

## Stages

### 1. Threadbear keeps the sync up to date and watches it (built 20 Nov)

`runner/src/agent-archive.ts`, every ten minutes with the experiment on:

- **Watching.** It runs the sync's `status --json` and puts one line in
  `tb status`: where it syncs to, when it last finished, failing files, and
  "nothing synced for ..." past three hours. An older sync without
  `--json` is said to be too old, and the next update fixes that.
- **Updating.** With `archive.repo` in runner.json, it checks the repo's
  main with `git ls-remote`. When main moves it builds the sync in
  `~/Library/Caches/Threadbear/agent-archive` (clone, `npm ci`,
  `build:daemon`, all at the runner's job priority) and runs the
  archive's own `install-runtime` with the runtime's own Node, which swaps
  the release in and restarts the service. A commit that fails isn't tried
  again; the next one is. The last build is kept in
  `agent-archive-update.json`.
- **Other machines.** The cloud box can't reach the private repo and has no
  Node on its ssh PATH, so after the M5's install the build is copied to
  each `archive.pushTo` machine (`{ host, node }`) over ssh and installed
  there with that machine's node.
- **Bruce.** Its archive server's deployer already builds main and runs
  `install-runtime` for Bruce's sync, so a machine with the server's
  folder leaves updates to it and only watches.
- **Enrolling the cloud box.** Done once by hand: Bruce's server opens a
  short enrollment window (`agent-archive-server admin enrollment open`),
  the cloud box enrolls and installs, and the window is closed.
- The services already installed on the M5 and Bruce are kept as they are,
  with their tokens and checkpoints: nothing is re-sent and nothing moves.
- Mike's runner.json on the M5: `"archive": { "repo":
  "https://github.com/mikecann/agent-archive.git", "pushTo": [{ "host":
  "cloud", "node": "<its node>" }] }`, and the experiment on there, on
  Bruce and on cloud. The repo is the https address, not ssh: the runner's
  LaunchAgent has no ssh agent, so `git@github.com:` is refused there,
  while https goes through git's own credential helper (`gh`).

### 2. The archive knows Threadbear's threads

The runner says which sessions are which threads, and both sides link to
each other.

- The runner writes `archive-sessions.json` in its data folder (built
  20 Nov): for each Claude or Codex session a thread has used, its thread
  id, title, project and folder, and the runner's name. A thread only
  remembers its current session, so the file keeps every one it has seen;
  a rename or a project change updates all of a thread's entries.
- The archive's sync reads that file each poll and sends what changed
  through a new RPC operation, `annotateSessions`, with its own token. The
  host keeps them in a table of their own beside the imported threads (an
  annotation never edits the faithful record). Merged in agent-archive
  #93 on 20 Nov, with `status --json` and the sync reading every login's
  folders from the file (`claudeRoots`, `codexRoots`).
- The archive's tools and reader say "Threadbear thread: <title>" with a
  `threadbear://thread/<id>` link, and search can filter by project.
- The app's thread search searches the archive too (built 23 Nov). Mike
  was shown three ways to bring the archive into the app (review
  4ead0306): earlier work in a panel beside each thread, the search box
  searching the archive, and an Ask panel. He picked the search box: "I
  don't think it makes sense to have a separate panel", and asking is a
  thread's job, as "the agent should always have access to it". Hits
  come after the app's own threads; one opens its Threadbear thread, or
  else read-only in the thread's place, with New thread from this. The
  runner runs the archive's own `search --json` and `read --json`
  (agent-archive #96) with its read-only key, so it still holds no
  credential (docs/protocol/threads.md, "Searching Agent Archive").
- Every thread gets the archive's MCP server while the experiment's on
  (built 23 Nov): the cloud box's Threadbear login had no `agent-archive`
  in its config, so threads there couldn't search it.
- Threadbear can then use the archive: "Threads already on it" (the
  `sameWork` experiment) could look past open threads, and the thread
  digests idea (6eecd8a8) that concluded "ask Bruce" has somewhere to ask.
- `archivedMediaDays` can wait for the host to have a thread before
  clearing its pictures, instead of trusting that it does.

### 3. Threadbear looks after the host (built 24 Nov)

The archive server on Bruce stays a LaunchAgent of its own, for the same
reason as the sync (runner restarts must never stop it), and its own
deployer keeps doing the builds until stage 4. Threadbear watches it and
starts it again when it has stopped. Mike chose this step on 24 Nov
(thread 1ac3962f), without the Archive panel he'd passed over.

- **Watching, on every runner.** Each tick, after the sync's status, the
  runner asks `/api/health` at the sync's own `archiveUrl` (so no new
  setting: the sync already knows its host). `tb status` adds a sentence:
  healthy on its release, or what's wrong (a failed deploy, a deployer that
  can't reach the repo, a failed backup or one over two days old, a failed
  restore test, under 10 GB of disk), or "isn't answering, for ..." with
  the error. Going down and coming back are logged once each.
- **Starting it again, on Bruce.** On the machine with the server's folder,
  a server that hasn't answered two checks running (one could be a deploy
  swapping releases) and that `launchctl print` shows without a pid is
  started with `launchctl kickstart`, never `-k`, so a running server is
  never stopped; at most once an hour. A running server that doesn't
  answer, or a service that isn't loaded (taken out on purpose), is only
  reported. Its LaunchAgent has `KeepAlive`, so this is for when launchd
  has given up on it.
- The server keeps its data folder, `server.json`, backups and Tailscale
  address. Bruce has 8 GB and already swaps, so this adds no process.

### 4. The code moves into Threadbear

The archive's `daemon/`, `server/`, `mcp/`, `shared/`, the reader and the
skills move into this repo as `archive/`, with history (`git subtree`),
and the agent-archive repo is retired.

- **This publishes Agent Archive**: its repo is private and this one is
  public. It waits for Mike to say he's ready to release it (he's said
  he'll talk about it first, docs/guide.md).
- `archive/` keeps its own `package.json`, so LanceDB's native binaries and
  the rest are only installed on a runner with the archive on, never for
  everyone.
- `runner/src/redaction.ts` and the archive's redaction become one.
- The sync and the host are built from the runner's release instead of
  agent-archive's main, so `archive.repo`, `archive.pushTo` and the
  server's deployer go: every runner already follows Threadbear's main.
- The Convex host (`convex/`) is dropped, as bruce-migration's stage 15
  already plans.
- `docs/forking.md` gets the archive: where it lives, how to take it out,
  and Mike's own values (the Tailscale name, OpenRouter use).

### 5. Anyone can turn it on

Once the code is public, a stranger's runner can run the archive too.

- Turning it on in Settings starts the host on that Mac, on loopback, and
  the sync sending to it. Nothing leaves the Mac. Their other Macs can
  send to it over their tailnet, or to a host at an address of their own.
- Keyword search works with nothing else. Embeddings need a key (OpenRouter
  or OpenAI), asked for in Settings, and say what they'll cost before the
  first backfill.
- A switch for sessions run outside Threadbear (on by default, as it's
  their own Mac) and the archive's own exclude rules for folders.
- Ask on the phone points at their host as it does at any Ask server
  (docs/ask-server.md): Tailscale or their own address. Later, Ask could
  go through Convex to the host's runner (small: a question in, an answer
  out), so a phone without Tailscale works; not in this plan.
- `archivedMediaDays` can then be offered to everyone with the archive on.

## Moving Mike's archive

Nothing is copied. The 27 GB stays on Bruce, the M5's and Bruce's device
tokens stay what they are, and their checkpoints carry on. In order:

1. Stage 1 on the M5: the experiment on and `archive.repo` set, the next
   build of main installed over the existing service by its own installer,
   a sync checked (`agent-archive status` shows the same checkpoints
   moving).
2. Bruce: the experiment on, so the runner watches; its deployer carries
   on updating.
3. The cloud box enrolled; its first runs backfill whatever its CLI
   folders still hold (older history on them is gone where the CLIs
   cleaned it up).
4. Stage 3 on Bruce: the runner watches the server and starts it again when
   it stops (its deployer keeps the updates until stage 4), Quick Ask and the reader checked from the phone and the M5.

Each step goes back by turning the experiment off (the services carry on
as they are), or for a bad build, the archive's own rollback to its
previous runtime release.

## Still to decide

1. When Agent Archive goes public, which is when stage 4 can happen.
   Stages 1 to 3 don't need it.
2. Whether the Convex host is dropped (this plan) or kept as a second host.
3. Whether a stranger's default includes sessions run outside Threadbear.
