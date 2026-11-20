# Agent Archive through Threadbear

Plan written 20 Nov 2026 (thread b2612e00, asked for by the weekly Convex
usage check, ff30633e). Nothing here is built yet: build when Mike says.

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
  M5 runner      Tinker Desk runner      cloud runner      Bruce runner
     |                  |                     |                 |
     | sync worker: CLI folders (Claude, Codex, Grok, Muse),    |
     | RememBear summaries, plus which Threadbear thread is which
     v                  v                     v                 v
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
  Tinker Desk and the cloud runner have no daemon, so their threads aren't
  archived.
- **The host** (`server/`, 26k lines): one Node process on Bruce since
  24 Oct, at `https://bruce.tail9ef766.ts.net:9443` (tailnet only). 27 GB
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
| Sync | a daemon LaunchAgent on the M5 and Bruce | a worker each runner starts and watches, on every runner (Tinker Desk and cloud too) |
| Host | Bruce, its own LaunchAgent and deployer | Bruce, started by Bruce's runner, updated with Threadbear's releases |
| Agents' tools | the agent-archive MCP server, global config | the same seven tools, same names, from the runner's release |
| Reader | `bruce.tail9ef766.ts.net:9443` | the same, plus an Archive panel in Threadbear and links both ways |
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

**The worker is a child process, not the runner.** The importer parses
rollouts up to 1 GB (a 418 MB one is in the archive) and the runner's own
loop has to stay quick. The runner starts the sync worker, restarts it if
it dies, stops it for a restart, and shows its state; the worker keeps the
daemon's lock, checkpoints and backoff as they are. Same for the host on
Bruce. One thing to install and update, two processes as now.

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
for Mike (AGENTS.md, "Experiments").

## Stages

### 1. The runner runs the sync

The runner starts the archive's sync worker and keeps it running, in place
of the daemon's LaunchAgent.

- Until stage 4 the worker is the installed Agent Archive runtime
  (`~/Library/Application Support/Agent Archive/runtime/current`,
  `run-service`), so no archive code enters this repo yet. Its config,
  device token and `sync-state.json` stay where they are, so on the M5 and
  Bruce it picks up from the daemon's checkpoints and nothing is sent
  again. Then the daemon's LaunchAgent is removed (`agent-archive
  uninstall`, which keeps config and state).
- The handover: stop the LaunchAgent, wait for `daemon.lock` to clear,
  start the worker. The lock already refuses two at once, so a mistake
  waits rather than doubling up.
- Tinker Desk and the cloud runner are enrolled as new devices. Each needs
  the enrollment secret once; it goes over ssh from the M5 for that one
  command and isn't kept there. Their threads start reaching the archive.
- `tb status` shows the worker: last sync, files waiting, failing files,
  and the host it sends to. Settings > General lists the host.
- Sandboxes and disposable runners never run it.
- docs: `on-your-mac.md` (the worker, what it reads, where it sends),
  the experiment's file, `guide.md` under its experiment.

### 2. The archive knows Threadbear's threads

The runner tells the host which sessions are which threads, and both sides
link to each other.

- A new RPC operation, `annotateSessions`: for each CLI session id a
  thread has used, its Threadbear thread id, title, project, runner and
  account, sent when a thread starts a session or is renamed or moved. The
  host keeps them in a table of their own beside the imported threads (an
  annotation never edits the faithful record).
- The archive's tools and reader say "Threadbear thread: <title>" with a
  `threadbear://thread/<id>` link, and search can filter by project.
- Threadbear can then use the archive: "Threads already on it" (the
  `sameWork` experiment) could look past open threads, and the thread
  digests idea (6eecd8a8) that concluded "ask Bruce" has somewhere to ask.
- `archivedMediaDays` can wait for the host to have a thread before
  clearing its pictures, instead of trusting that it does.

### 3. Bruce's runner runs the host

Bruce's runner starts the archive server and keeps it running, in place of
its own LaunchAgent, and it updates with Threadbear's releases instead of
its own deployer.

- A runner setting, `archive.host`: the URL it sends to, or `"here"` to
  run the host on this runner (Bruce's). The worker takes its URL from it.
- The server keeps its data folder (`~/Library/Application Support/Agent
  Archive Server/data`), its `server.json`, its backups and its Tailscale
  address. Bruce has 8 GB and already swaps, so this adds no process: the
  same server, started by something else.
- Until stage 4 the runner starts the server's installed release, as in
  stage 1.
- A Threadbear panel, Archive, opens the host's reader for this thread's
  project. It's a URL panel, so no reader is rebuilt.

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
- The worker and the host are built from the runner's release instead of
  the separate runtime, and the Agent Archive runtime folder goes.
- The Convex host (`convex/`) is dropped, as bruce-migration's stage 15
  already plans.
- `docs/forking.md` gets the archive: where it lives, how to take it out,
  and Mike's own values (the Tailscale name, OpenRouter use).

### 5. Anyone can turn it on

Once the code is public, a stranger's runner can run the archive too.

- Turning it on in Settings starts the host on that Mac, on loopback, and
  the worker sending to it. Nothing leaves the Mac. Their other Macs can
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

1. Stage 1 on the M5: worker started by the runner, daemon removed, a sync
   checked (`agent-archive status` shows the same checkpoints moving).
2. The same on Bruce.
3. Tinker Desk and cloud enrolled; their first runs backfill whatever their
   CLI folders still hold (older history on them is gone where the CLIs
   cleaned it up).
4. Stage 3 on Bruce: the server's LaunchAgent removed once the runner has
   it running, Quick Ask and the reader checked from the phone and the M5.

Each step goes back by reinstalling the LaunchAgent it replaced, with the
same config and state.

## Still to decide

1. When Agent Archive goes public, which is when stage 4 can happen.
   Stages 1 to 3 don't need it.
2. Whether the Convex host is dropped (this plan) or kept as a second host.
3. Whether a stranger's default includes sessions run outside Threadbear.
