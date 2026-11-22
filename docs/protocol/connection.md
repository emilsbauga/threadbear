# Runner protocol: Connection, auth and requests

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## Auth

The token is the contents of
`~/Library/Application Support/Threadbear/secrets/runner-token`. It
never travels: the client proves it has it, and the runner proves the same
back, so the client knows it reached the real runner before it trusts
anything it's told. Whoever holds the port while the runner is down (another
account on the Mac can bind 127.0.0.1:8797 then) learns nothing it can use.

1. The client connects with no `Authorization` header. The runner's first
   message is
   `{"jsonrpc":"2.0","method":"auth.challenge","params":{"version":1,"nonce":"<64 hex>","port":8797}}`:
   32 fresh random bytes for this connection, and the TCP port it listens on.
2. The client picks its own 32 random bytes and sends, as its first message,
   `{"jsonrpc":"2.0","id":1,"method":"auth.prove","params":{"nonce":"<client's 64 hex>","proof":"<64 hex>"}}`,
   where `proof` is HMAC-SHA256, keyed with the token's UTF-8 bytes, of
   `"threadbear-rpc-auth-v1 client\n" + runnerNonce + "\n" + clientNonce + "\n" + server + " " + port`
   (lowercase hex throughout). `server` is `primary` for the runner's main
   server, the one on its port that every client talks to, and `drain` for
   a draining runner's own (Handovers), which only a primary taking over
   from it means to reach. `port` is the one the client dialed when it
   dialed a loopback address, and the challenge's `port` otherwise (behind a
   proxy, where the dialed port is the proxy's).
3. The runner answers `{"result":{"proof":"<64 hex>"}}`: the same HMAC of
   `"threadbear-rpc-auth-v1 runner\n" + runnerNonce + "\n" + clientNonce + "\n" + server + " " + port`,
   with its own kind of server and its own listening port.
   The client checks it (constant time) before it sends or reads anything
   else, and closes the socket when it's wrong or missing.

The two strings differ so neither side's proof can be played back as the
other's, and each side's fresh nonce means an old proof is no good on a new
connection. A client never sends the token or a bearer header, not even to a
server that doesn't send a challenge: it closes instead and says the runner
didn't prove itself (an impostor could just as well pretend to be an old
runner).

The last line binds the proofs to the connection. Something holding the
runner's port while it's down could pass a challenge on from a real runner
on another port (a draining one, say) and pass the client's answer back;
without it, that would leave it holding a connection the runner had let in.
With it, the client's proof is for the port it dialed (or, on another Mac,
for a `primary`), and the runner on the other port, or a draining runner,
works out a different one and closes the socket. Nothing protects the
messages after auth beyond that (no encryption on loopback); the binding is
what keeps a relay from getting that far.

**Before the challenge (old clients).** A runner still takes the two ways
clients used to authenticate, so an app or `tb` older than the challenge
keeps working while it updates: `Authorization: Bearer <token>` on the
upgrade request (no challenge is then sent), or a first message
`{"jsonrpc":"2.0","id":1,"method":"auth","params":{"token":"..."}}`. Both
send the token itself, which is what the challenge is for; accepting them
leaks nothing by itself. They can go once nothing older than 5 Nov 2026
connects: Mike's Mac app restarted onto a build with the challenge, and
every release a runner might still hand over from (bruce's and the cloud
runner's included) newer than that. One exception in this release relies on
them: a new runner taking over from a draining runner whose `drain-<pid>.json`
has no `"auth": "challenge"` (one that predates it) connects to it with the
header, because that runner can't answer a challenge and the file, in the
runner's own data dir, says so; no server can talk a client into it. Even
then the header only goes over a connection whose other end, as `lsof`
sees it, is an open file of that pid, a process of the same user: the
draining runner closes its server before its drain file goes, so its port
can be someone else's while its pid lives on. Anything else counts as the
draining runner gone.

**A thread's own key.** A thread's CLI gets `THREADBEAR_THREAD_KEY` in its
environment, never the runner's token: HMAC-SHA256, keyed with the token's
UTF-8 bytes, of `"threadbear-thread-key-v1\n" + threadId`, lowercase hex. `tb`
in a thread answers the challenge with the key in place of the token, and adds
`"threadId"` to `auth.prove`'s params. The runner works the key out from the
id, so it keeps nothing per thread and a key only ever names its own thread.
`tb` falls back to the token only when it's pointed at another runner's data
dir (a dev runner) or when it has no key. A
thread that started before this (an older runner's CLI still finishing a turn)
has none either, and its older `tb` carries on as before until its next start.

The connection then belongs to that thread: every request is checked against
what the thread can do at that moment (`runner/src/rpc-gate.ts`), by the same
rules as its threadbear tools ("Raising access"). A thread on Full access
isn't limited. Any other gets the reads, and the writes that
don't reach past it: a thread or schedule at most as high as its own
(`permissionMode` is filled in with the caller's when left out), a message to
a thread no higher, lowering its own mode or that of a thread no higher,
renaming, snoozing or archiving another thread, moving a thread no higher (`unconfine` is forced false, which an
older runner across a handover reads as an agent's move). Anything else
is refused with `-32060`, whose message says which tool to use instead. Unknown
methods are refused too. In particular it can't answer a card
(`approvals.respond`, `plans.approve`, `secrets.answer`), press a button, run
an action, trust a patch, set instructions, delete a thread, restart the runner
or change settings; these all need the Mac app or a thread with Full access.
`auth.whoami` (any authenticated client) says who the runner took the caller
for: `{}` for its owner, or `{"threadId", "mode", "limited"}`.

**Who's really calling.** A key can be got round by wiping it from the
environment and reading the token file, so the runner doesn't only go by what's
presented. After auth it finds the process at the other end of the connection
and walks up its parents; if one is a thread's CLI, the connection is that
thread. On Windows the runner's helper (`runner/src/win32-helper.ps1`)
answers in place of `lsof` and `ps`, and a parent that started after its
child isn't counted: Windows keeps a dead parent's id as its children's
parent id and gives the id to the next process. The process is the one `lsof` shows holding a socket named exactly
client address and port `->` the runner's address and port: never one that
only shares the client's port number (another loopback address, or a socket
whose far end uses that number), which could be another thread's (Daybreak
finding 137). The lookup can only lower what a credential gets: the owner
token from under a thread's CLI is that thread, but a thread's key is already
a thread, so a lookup naming a different thread (a key lifted from another
thread's environment with `ps eww`) closes the connection with 4403 before
any request runs, as does one whose socket is held by processes under two
threads. So the token in a thread's shell is worth no more than the thread's
own mode, and another thread's key used from under a thread is worth nothing.
A key used from a process the lookup can't place (one that started a new
session, or a lookup that failed or took over 3 seconds) is taken at its word,
like the token below. A client that isn't under
a CLI (the app, a terminal, a patch's action, the runner's own jobs) is what it
says it is. If the lookup fails (no `lsof`, or it times out), the runner goes by the credential.
A process that has lost its parents (a `nohup`, a backgrounded subshell) still
counts if it's in a process group a thread's tool command ran in, as the
registry has noted them. One that deliberately starts a new session and reads
the token can still pass as the owner, which is why outside Full access
Claude's file and shell tools are denied the runner's `secrets` folder as well;
that deny is defence in depth (`SECURITY.md` says what's out of scope). A
draining runner's own server applies all of this too. `tb runner`
uses this Mac's keys from disk, so the runner never sees them: from a thread they
need the real runner to say it isn't limited. A CLI started by a runner older
than this has no key and isn't recorded with its thread, so it keeps the old
`tb` until its next start.

**No browsers.** An upgrade with an `Origin` header is turned away with HTTP
403 before anything else is looked at. Browsers always send one on a
WebSocket and the runner's own clients (`tb`, the apps, another runner)
never do, so a web page that can reach `127.0.0.1` can't take the slots
below and keep them out (Daybreak finding 146).

**Limits before auth.** Until a connection has authenticated, a frame is at
most 64 KiB (more closes it with 1009), there are 3 seconds to finish, and
anything but `auth.prove` or `auth` (a binary frame, bad JSON, a wrong
proof) closes it with 4401, cut off a second later if it doesn't answer the
close; a frame over the limit, or any other protocol error, is cut off at
once. At most 16 connections may be waiting to authenticate at once,
refused ones counting until they've gone; the next upgrade is turned away
with HTTP 503. An
upgrade with an `Authorization` header that's wrong is turned away with HTTP
401 before it becomes a WebSocket. Once authenticated, and once the process
lookup above has finished, a frame can be up to 64 MiB (what the runner
accepts; what it sends, like a big `threads.events` page, has no such limit).
While the lookup runs, frames keep the 64 KiB limit and wait for it, at most
256 of them and 1 MiB in all; more closes the connection with 4408. A
lookup counts until it settles, even after its client has gone: the owner
token's against the 16 waiting to authenticate (a bearer client's upgrade
waits for a slot like the rest), a thread key's against its own limit of 4
per thread and 16 for all threads, past which the connection is closed with
4429, so one thread can't keep the app out (Daybreak finding 158). The answer to `hello` comes once the lookup
is done, so a client that waits for it can send big frames straight after.

## Configured Pi profiles

`hello` may include `piProfiles: PiProfile[]`. These are opt-in configuration
metadata. Enabled profiles advertise `capabilities.threads: true` and register
runnable accounts as `pi:<profile ID>`, with `piProfileId`, `executable` and
`connection` metadata. Existing IDs/defaults stay unchanged when no Pi profile
is configured. `CliProvider` and `clis.*` remain Claude/Codex-only; Pi is a
runnable `Provider` but is never sent through their installers or update paths.
The profile connection's model is its default, not its only allowed model.
At startup, the runner asks an isolated, short-lived Pi RPC process for
`get_available_models`, filters it to the profile's inference provider and
publishes safe model IDs/titles through the existing account model list.
This uses Pi's cached catalog, starts no model turn and never loads tools or
project extensions. Failure leaves the configured default available. The same
profile and credentials serve any of its advertised models.
Pi profiles may set `toolContext: "auto" | "compact" | "full"` (default
`auto`). On Pi runtimes with deferred tool search, auto selects compact
exposure for loopback endpoints or models with a known context window below
70,000 tokens. Other models retain full exposure; this policy does not change
Claude/Codex tools. The selection is reevaluated before each prompt, including
after model switches and resume. Unknown remote context sizes use full mode.
Compact exposure keeps native tools and `end_turn` active, with a shorter
completion description/schema documentation. Other Threadbear tools keep
their full definitions but are deferred behind Pi's `tool_search`; discovery
loads them for use in the current turn. The next prompt resets compact
exposure, avoiding accumulated tool schemas. Full argument validation,
legacy forms and approval policy stay in the host for every discovered call.
`tool_search` only discovers tools and requires no action approval.
With Pi configured, an official CLI without any registered accounts is not
automatically probed, checked or installed.
Older runners omit the field; clients treat it as an empty list. Older clients
ignore it. Unknown profile fields are ignored, and clients skip malformed rows.

```ts
type PiProfile = {
  id: string
  engine: "pi"
  title: string
  executable: string
  configDir: string
  connection: { provider: string, model: string }
  capabilities: { threads: boolean }
  toolContext?: "auto" | "compact" | "full"
}
```

Configure them in `runner.json`:

```json
{
  "pi": {
    "path": "pi",
    "profiles": [
      {
        "id": "pi-local",
        "title": "Local Pi",
        "connection": { "provider": "ollama", "model": "my-local-model" }
      }
    ]
  }
}
```

The executable defaults to `pi` (a PATH command); absolute and `~/` executable
paths are accepted. Profile IDs are unique, 1–64 letters/digits/underscores/
hyphens and start with a letter or digit. Titles default to the ID. `configDir`
defaults to `<runner home>/pi/profiles/<id>`; explicit paths must be absolute
or start with `~/`. Provider and model must be nonempty strings. The provider
is Pi's inference-provider ID, such as `openrouter` or `ollama`, not the agent
engine. Endpoint details and credentials belong in that Pi profile's own
configuration; do not put secrets in this public metadata.

Missing/null `pi`, `pi.enabled: false` or no profiles leaves behavior unchanged.
A profile with `enabled: false` is omitted. Invalid active configuration is
rejected with its field location, without echoing its contents. Unknown fields
are discarded. Parsing does not create directories, read Pi credentials,
discover models, start a process or make a network request. Changes take effect
after a normal runner restart; profile definitions remain local; safe runnable account metadata may sync.

### Pi RPC adapter lifecycle

The Pi adapter implements the internal session contract using Pi 1.5's
LF-delimited RPC protocol. It is registered for opt-in Pi profile accounts. Shared tool handlers use an
authenticated, session-scoped loopback bridge. Native tool calls and writable
Threadbear tools request approval in ask/auto mode; full mode bypasses normal
requests but always-ask tools still ask. Read-only tools remain available.
Always allow rules are persisted; native rules cover the exact input and cwd.

Each session owns one process and uses its configured Pi directory through
`PI_CODING_AGENT_DIR`. Session files live under that directory's
`sessions/threadbear/<threadId>`. New sessions use a preassigned session ID;
resume uses that same ID and directory, with no replay of old transcript events.
The adapter refuses a missing resume rather than silently starting a new one.

Sending before startup or during a response queues messages in order. Each
prompt is acknowledged separately; `agent_settled`, not `agent_end`, completes
it. The adapter reports the runner message ID and remaining queue count.
This slice queues whole prompts rather than steering an active response.
Final assistant messages replace streamed text/reasoning blocks using stable
item IDs. Unknown events are ignored; malformed or oversized RPC frames,
request timeouts and unexpected process exits terminate the session.

Stop clears queued prompts before aborting, including messages waiting for
startup. If abort does not complete within its deadline, the owned process
group is killed. End closes stdin with bounded termination fallback. Pending
RPC requests always resolve or reject, and exit is reported once. Settings
changes apply between prompts. Image inputs are passed as native Pi images;
tool images are saved to the thread's media directory. Usage charts are deferred.

The adapter enables built-in Pi tools and one explicit Threadbear bridge
extension. MCP and extension discovery remain disabled; profiles cannot load
arbitrary project extensions at startup. The caller's project instructions and
Threadbear tool guidance are appended. Permission changes apply between prompts. Startup catalog/telemetry calls
are disabled; model requests still use the selected configured endpoint.
Stderr is kept separately in a bounded private file under the supplied temporary
directory, never parsed as RPC or copied into protocol errors.

## External message intake

Opt-in, text-only intake lives in Convex, independently of runner commands.
HTTP intake does not start a task. HTTP actions use the deployment's
`.convex.site` URL (including its region when present), not `.convex.cloud`.

- `POST /intake/v1/messages`, with `Authorization: Bearer tbi_<64 hex>`
  and `Content-Type: application/json`. Body: `{ messageId, source, sourceMessageId,
  text, sentAt, sender? }`. `source` is `email` or `telegram`; `sentAt` is an ISO
  timestamp with timezone. Original text and source values are preserved.
- `GET /intake/v1/receipt?messageId=...`, with the same header, reads only that
  client's receipt. Missing receipts give 404.
- Receipt: `{ receiptId, messageId, state: "received", receivedAt }`, with
  `receivedAt` as epoch milliseconds. POST returns 201 on first acceptance and
  200 for an identical retry. This confirms durable backend storage only.
- `(clientId, messageId)` is unique transactionally. Reusing an ID with different
  content gives 409. A rotated key keeps the same clientId and receipts; intake
  records are not pruned with commands. Neither endpoint updates or deletes one.
- Bad/revoked/missing keys give 401; malformed input 400; non-JSON POST 415;
  requests over 64 KiB or text over 48 KiB 413. New entries are limited to
  120 per client per fixed UTC hour (429); identical retries do not use allowance.
  Message IDs are 1–256 printable ASCII characters without spaces; source IDs
  and optional sender are 1–512 characters. Unknown body fields are ignored.
- Admin-only internal `intake:provision` accepts `{ clientId, keyHash }` (SHA-256
  hex of the complete bearer key), creating or rotating a dedicated client key.
  `intake:revoke` disables that client. Plain keys are generated and stored only
  by the operator; they never go in Convex arguments or tables. Intake keys
  cannot call runner or phone APIs, provision keys, enumerate intake, or change
  receipt states. No clients are provisioned by default.

### File intake (backend API 96)

V1 stays text-only and its four-field receipts remain unchanged. V2 uses the
same restricted bearer credential and JSON envelopes up to 64 KiB:

- `POST /intake/v2/prepare`: `{ message, attachments }`. `message` has the V1
  fields; its text may be blank if there are files. Each attachment is
  `{ id, name, mediaType, size, sha256 }`: stable printable ASCII ID, original
  display name, MIME type, safe integer byte size and lowercase SHA-256 hex.
  The ordered manifest is immutable. Returns upload block size and status.
- `POST /intake/v2/upload?messageId=...&attachmentId=...&index=N`: authenticated
  binary upload, at most 8 MiB. Index is zero-based; the last block has its exact
  remaining length. Duplicate blocks must have identical bytes/hash. This is a
  transport block limit, not a file-size cap. Blob IDs are never accepted from
  capture clients, preventing attachment of someone else's storage objects.
- `POST /intake/v2/finalize`: `{ messageId }`; only succeeds when all declared
  blocks exist. Returns the same immutable receipt shape as V1. Until then no
  intake row is available to the runner. Retries return the same result.
- `GET /intake/v2/status?messageId=...`: own transfer's state, attachment block
  counts, receipt when finalized, and `localSaved`/`cloudDeleted`. This is separate
  from the receipt's original meaning. A sender may clear local staging only
  after `localSaved` is true. Source emails/Telegram messages are untouched.
- `POST /intake/v2/cancel`: `{ messageId }` cancels an unfinalized upload and
  schedules safe cleanup. Finalized/pending messages never expire while the Mac
  is offline. Re-preparing a cancelled ID with the same manifest restarts it.

Runner-authenticated block downloads use `GET /intake/v2/download`, with
`runnerId`, `receiptId`, `attachmentId` and `index` query fields;
the lease token is in `X-Intake-Lease` and the runner credential is in
Authorization, never the URL. Each request checks
client binding and the current lease. No public download URL is exposed. The
consumer renews its lease while downloading, resumes verified blocks, streams
assembly into a local temporary file, verifies full size/hash and only then
publishes one complete draft. After durable completion it confirms delivery;
retryable internal cleanup deletes cloud bytes but retains manifests/receipts.

`AttachmentRef = { id, path, name, mediaType, size, sha256 }` references a local
regular file owned by the thread. `BacklogDraft.attachments?` and optional
`attachments` on save/send let clients remove/reorder attachments explicitly.
Omitting that argument preserves a saved draft's files for older clients;
`[]` removes them. Files survive draft autosave, restart and send. Images get
thumbnails; other files get filename/size chips. Sending supplies supported
images to the provider and other files as local file references, without
rewriting the saved draft text or starting work before explicit Send.

A checksum mismatch creates a local `.held.json` marker and requires investigation
before another download. Unregistered upload blobs left by an action crash are
removed after a day; registered pending uploads and finalized transfers do not expire.
Older runners omit `includeAttachments` on `pendingIntake` and see text-only items.

### Intake to Backlog (backend API 96)

The `externalIntake` experiment enables a runner's 15-second consumer.
A failed pending poll is logged once per outage and retried quietly; it does
not mean a message failed to save. Delivery failures after a receipt is found
retain the warning, with receipt ID, stage and safe error diagnostics in the log. Clients
must first be bound to that runner by admin-only `intakeConsumer:bindConsumer`
(`{ clientId, runnerId }`). Unbound or revoked clients are not consumed. The
admin-only `intakeConsumer:ignoreMessage` (`{ clientId, messageId }`) permanently
excludes an explicit test receipt; known synthetic receipts are excluded before
enabling production consumption. No content-based task inference is performed.

Runner-facing `intakeConsumer:pendingIntake`, `claimIntake`, `finishIntake` require
runner authentication and the client's bound runner. Claims last 60 seconds,
are fenced by an opaque lease token and reserve a deterministic UUID derived
from client ID and receipt ID. A lost claim or acknowledgement is retried.
Completion records `deliveryState: "saved"`, `deliveryThreadId`, runner ID and
completion time on the intake row, separately from its immutable four-field
sender receipt. That receipt still means `received`, including after import.

The runner atomically persists the complete unsent draft with its intake
provenance in the initial thread record, then a per-receipt completion marker
in `<home>/intake-imports/`, before confirming completion. Retries preserve an
edited, started, archived or deleted thread. Deletion preserves the marker;
an acknowledged or locally completed receipt never recreates the task. Source
text remains unchanged in the composer; provenance is stored separately and
linked from Highlights. Imported threads use normal runner defaults in its
default folder, start no task session/turn/worktree, and may receive the existing
Backlog librarian review. External source content remains untrusted data.

## Backlog

Existing idle Inbox conversations may also be deferred here with
`threads.update { threadId, backlogged: true }`; `backlogged: false` returns
one to Inbox. `ThreadSummary.backlogged?: boolean` is independent of the
unsent `backlog` draft: it preserves history, session, asks and composer text.
Busy, archived, hibernating threads and unsent drafts cannot be moved this
way. A validated send clears the marker; failed validation retains it.
Archiving retains the marker, so restoring returns the thread to Backlog.
The Mac thread menu offers Move to Backlog and Move to Inbox. Deferred
conversations take precedence over stars and do not count toward the inbox badge.
Backend API 96 mirrors the marker; older backends omit it.

Backlog is a collapsible section in the existing thread list. Unsent items are
threads with a saved first prompt, not turns or a separate task store.
`ThreadSummary.backlog?: { text: string, images: ImageRef[], revision: number, context?: string }`
is present only until the first send. The status is `idle`, `live` and
`needsYou` are false. Saving or opening starts no execution session, title
job or worktree. The librarian may separately review the saved prompt.
Draft images are copied into the thread's media directory before saving,
just as sent images are.

- `threads.createDraft`: the same settings as `threads.create`, with `text`
  and optional `images`; returns `{ thread }` without starting a turn.
- `threads.saveDraft`: `{ threadId, text, images?, revision }` replaces that
  Backlog prompt and returns `{ thread }`. Empty edits are allowed. A stale
  revision or a thread that has already started gives `-32602`, without
  changing anything. Each successful save increases the revision.
- `threads.send` sends the composer's current prompt and removes `backlog`
  only after image validation succeeds. That first turn then follows the
  normal Running, Inbox and Archived lifecycle. Failed validation retains
  the saved draft. Archiving an unsent item retains its draft; restoring it
  returns it to Backlog.

Backlog is included in the existing `threads.list` inbox scope, but clients
place it in its own collapsible section, before Inbox and after Starred.
Backlog takes precedence over a star; archiving takes precedence over both.
The Mac sidebar offers Delete on Backlog and Archived rows, with confirmation,
using `threads.delete`; saved prompts and owned media move to runner trash together.
The composer restores the draft when opening it and saves edits to the
runner. Creation is offered as Save to Backlog in the new composer's + menu
and send button menu. It uses the selected folder, login/pool and model.
Nanobot and other capture integrations are independent future producers.

The librarian reviews new/edited Backlog prompts after its normal settling
period, including saved prompts found on startup. It files them into
existing projects using existing pin/removal rules and may add a short `context`
note. The note is separate from the user's prompt and visible at the top
of Highlights as Context for this task. It can use relevant existing
project goals/state/notes and bounded excerpts from related threads, with
source references when available; no task execution or browsing is run.
Backlog reviews cannot update existing project state, wake other threads,
or change Pocket cards. Private-folder and pause/model-pool rules still
apply. One review per saved prompt revision; edits invalidate the old
context. A result for a changed, started, archived or deleted item is dropped.
A first send that matches the annotated prompt and pictures preserves the
note as advisory context in the execution agent's startup instructions;
otherwise it is discarded. The librarian may also improve a Backlog title
from the saved prompt and supplied context, under the normal Evolving
titles and user-chosen-title rules. A librarian title survives draft
autosaves and first send; a later review may evolve it again. The first
prompt itself is never rewritten.

## Composer skills

`skills.list { accountId: string, cwd: string }` returns
`{ skills: { name, title?, description, path, scope }[], errors: string[] }`.
The runner asks the selected login's Codex app-server for `skills/list`
with `cwds: [cwd]` and `forceReload: true`, without starting a thread or
model turn. Only enabled skills are returned; unknown scopes are allowed.
A provider without discovery returns no skills and an explanatory error.
Unknown accounts are `-32010`; paths must be absolute existing folders.
The Mac composer offers these skills when a word starts with `/` or `$`.
Slash searches accept spaces and treat hyphens as word separators. The list
floats above the entire composer (including its attached card) with an
eight-point gap, over other UI without reserving layout space. Its result
list scrolls within the available height above the composer.
Choosing one replaces the search query with `$name `, leaving the rest of the
message and its pictures intact; sending uses the existing text protocol.
An old runner's `-32601` is shown in the picker, never as a broken composer.

## Requests (app to runner)

| method | params | result |
|---|---|---|
| `hello` | `{ client: string, version: string, build?: { commit, short, tree }, pid?: number }` (`build`: the Mac apps' own builds, see App restarts; a draining runner's link to the primary says `client: "threadbear-drain"` with its `pid`, for the log) | `{ runnerVersion, protocol: 1, accounts: Account[], providers?: ProviderInfo[], piProfiles?: PiProfile[], pools?: Pool[], defaults: { cwd, accountId, poolId?, model?, models?: { claude?, codex? }, efforts?: { claude?: EffortLevel, codex?: EffortLevel }, permissionMode?: "full" \| "ask" \| "auto" }, clis?: CliStatus[], updates?: RunnerUpdates, experiments?: string[] }`. `providers` is what each provider this runner knows is called and can do, in its own order (`ProviderInfo` above; absent from older runners, when a client uses what it knows of Claude and Codex). `experiments` is the ids of the experiments on for this runner (docs/experiments.md), read at each `hello`, so the app shows what belongs to one (the Projects page's decisions for `projectDecisions`) from its next connect. `updates` is under Runner updates; `pools` and `defaults.poolId` under Pools. `defaults.accountId` is the account a `threads.create` with no `accountId` uses: the one with the most room among the last-used account's provider (skipping blocked ones, ones under 1% and ones with a note), worked out again as usage changes; a client keeps its own copy of the rule rather than asking again. `defaults.models[provider]` is the model a new thread on that provider gets when it names none (`runner.json`'s `defaults.models`; a dev runner sets the cheapest); `defaults.model` is the same for Claude, kept for older apps. Absent means the account's own default (`accounts[].defaultModel` names it, when known). `defaults.efforts[provider]` likewise for effort; absent means the model's own level. `defaults.permissionMode` is the mode a `threads.create` with none starts on, and the one the app's new-thread composer starts on and goes back to after each send (`runner.json`'s `defaults.permissionMode`, read at startup; `"plan"` or anything else there is ignored). Absent means `"full"`: setup writes `"auto"` into the `runner.json` it makes for a new install, and an install from before has none. A client that doesn't know the runner's (an older runner, or another runner reached through the backend) starts on `"full"`. `runnerVersion` is `<package version>+<release id>` when the runner runs from a release, else `<package version>+source` `client` is `threadbear-mac` for the Swift app and `threadbear-desktop` for the GPUI one; either counts as the app being open (the GPUI one not for a browser panel, which only the Swift app has) |
| `threads.list` | `{ include?: ("inbox" \| "snoozed" \| "archived")[], ids?: string[] }` (default `["inbox"]`; a value the runner doesn't know is left out; `ids` keeps only those threads, unknown ones left out; an older runner ignores it, so pick yours out of the answer) | `{ threads: ThreadSummary[] }` newest activity first |
| `threads.search` | `{ query: string, limit?: number }` | `{ threads: ThreadSummary[] }` matches title, preview and `keywords` across all threads, archived included (Search) |
| `threads.create` | `{ text: string, images?: ImageRef[], cwd?: string, accountId?: string, poolId?: string, provider?: string, model?: string, effort?: EffortLevel, permissionMode?: "full" \| "ask", title?: string, worktree?: boolean, startedBy?: { kind, label, icon?, threadId?, why? }, detached?: true, projectIds?: string[], serviceId?: string, warmId?: string }` | `{ thread: ThreadSummary }` (the first turn starts straight away). `warmId` is one `threads.warm` gave this connection: the thread is made under it, and takes the CLI started for it when its settings still match (see Warm start below). `serviceId` starts it on a virtual runner instead (Virtual runners, "Starting from the Mac"). `confined: true` is refused (see Sandboxed threads (taken out)). `projectIds` (New Thread on a project's page) puts it in those projects before its first turn, pinned as Mike's, so that turn already has their brief; an unknown project is `-32602` and makes no thread. In a repo that asks for worktrees (see Worktrees) the thread gets one of its own before its first turn; `worktree: false` starts it in the folder as it is. The thread's `provider` is its account's. `provider` with a `poolId` says which of a mixed pool's providers to start on (the one the model picker's pick was under, as an OpenCode model id can look like a Codex one); without one, the named model's provider, else the pool's first. With no `model`, the thread gets `defaults.models[provider]` from `hello`, or `defaults.model` for Claude, or else the account's own default. With no `effort`, `defaults.efforts[provider]`, or else the model's own level. With no `permissionMode`, `defaults.permissionMode`, or else `"full"`; the runner's own threads (bringing in releases, fixing a failed update, a note about this Mac) always name `"full"`. See "Models and effort across providers" |
| `cloudTokens.make`, `cloudTokens.set`, `cloudTokens.useMac`, `cloudTokens.list` | `{ login }`; `{ login, token }`; `{ login }`; `{}` | A virtual runner's cloud token for a Claude login (Virtual runners, "Cloud tokens on the Mac"): made with `claude setup-token` here (up to 10 minutes, waiting on Mike in the browser), pasted, or this Mac's year-long token for that login. `{}` once set; `list` answers `{ tokens: { login, madeAt, setAt, state }[] }`, never a token |
| `threads.samples` | `{ cwd: string, remove?: boolean }` | `{ threads: ThreadSummary[] }`. The app's first-run tour's sample threads (`runner/src/samples.ts`): made up exchanges written as finished turns with no CLI, in `cwd` (the app's `~/ThreadbearThreads/Welcome`, where it writes an example patch), with `sample: true`; the first needs you, with a card of asks, and one is left unread. Asking again deletes any there are and makes them afresh (writing the patch again if it's gone, and trusting it as written). `remove: true` deletes them all, archived and hibernating ones too, and returns none. `threads.send` to a sample is `-32602` |
| `threads.send` | `{ threadId, text, images?: ImageRef[], answers?: AskAnswer[], origin?: "phone", runnerId?: string \| null }` | `{ turnId }`. `runnerId` is the runner the client shows the thread on (`null` for this Mac's own): given, the primary refuses the message with `-32031` when it would reach any other runner (a thread still on the runner it's moving from, say), rather than passing it on; absent, it's routed as before, except that a message for another runner's thread is refused the same way while this runner knows of a move of it under way (an older app may have shown it as already moved). `text` can place the `images` among its words with `[Picture N]` markers (Pictures in a message). `origin: "phone"` is only for a phone command the primary passes on to a draining runner (Sync, "Commands"), so the message keeps its origin there; any other `origin` is `-32602`. If a turn is running and its CLI is live, the message goes into that turn straight away (a `user.message` under the running `turnId`, which is returned): the agent takes it at its next step, or right after its reply if that was already finishing, and the turn doesn't complete until it has been answered. If the thread was moved to another login (usually another provider) during the running turn, a message from Mike (or the phone) doesn't steer into the old CLI: the turn is stopped (`system.note` "Stopped here so <model> can take over.") and the message starts the next turn on the new login, with the handoff, as T3 Code does. If the agent is waiting on a card for its own tool call (an approval or a question, with an `itemId`), a message from Mike declines that card first (`approval.resolved` with `deny` and a `message` telling the agent he wrote instead), as the CLI reads nothing else until the card is answered; a background subagent's card is left open. Otherwise (the CLI is still starting or leaving, messages are already waiting, a move or fresh CLI is due on the next turn, Stop has been pressed, or the turn was opened only for a card) the message is queued and starts its own turn when the running one ends |
| `threads.interrupt` | `{ threadId }` | `{}`. Stop ends the turn. Claude reports which user inputs it queued, started and cancelled. An input it never started is saved, including pictures, with a `system.note`; one it started is a deliberate cancel, even at zero tokens. With no receipt support, the fallback saves only a turn with no model output and zero input/output tokens, or one whose CLI never became ready. Saved inputs persist across restarts and precede the next ordinary user message in one model input, with pictures renumbered. Stop alone never retries them. `/clear` discards them; other slash commands and scheduled messages leave them saved. Editing a message discards saved rows in the cut history, and restores earlier saved rows when the edit cuts the input that carried them. A move to another runner drops automatic replay state (the original messages stay in its history). Missing pictures are marked unavailable; recovery only reads pictures inside this thread's own media folder |
| `threads.edit` | `{ threadId, seq, text, images?: ImageRef[], stopBackground?: boolean, runnerId?: string \| null }` | `{ turnId, rewound: { seq, fromSeq, toSeq, files } }`. `runnerId` as for `threads.send`. Replaces the message at `seq` and carries on from there (see Editing a message): stops any turn, cuts the conversation back to just before it, undoes the agent's file changes since, and sends `text` as a new turn. Answers once the new turn has started, which can take a few seconds. `-32602` with the reason when the message can't be edited; `-32020` while another edit of the thread is under way or the runner is handing over; `-32050` while the thread has background work running and `stopBackground` isn't `true` (see Editing a message) |
| `threads.update` | `{ threadId, title?, titleBy?: "mike" \| "agent", cwd?, accountId?, poolId?: string \| null, provider?: Provider, byAgent?: boolean, model?: string \| null, effort?: EffortLevel \| null, permissionMode?, snoozedUntil?: string \| null, archived?: boolean, archivedBy?: "mike" \| "agent" \| "threadbear", verdict?: "worked" \| "didntWork" \| "notNeeded" \| "didntNeedToSee" \| "gladISaw" \| "notSure", starred?: boolean, carryOnAtReset?: boolean, carryOn?: boolean, detached?: boolean }` | `{ thread: ThreadSummary }`. `detached` takes a thread out from under the thread that started it in the sidebar, or (`false`) puts it back (Nested threads). `carryOn` with an `accountId` on a thread whose last turn stopped at its login's limit carries on there at once with the runner's own carry-on message, rather than waiting for one from Mike (the limit box's Continue now on, since 12 Nov 2026); otherwise it's ignored. Since 13 Nov 2026 any move to another login (`accountId` or `poolId`) on an idle thread whose last turn stopped at a limit carries on the same way without `carryOn`, unless `carryOnAtReset` is `false` or the call is an agent's (`byAgent: true`, which the thread-key gate, `update_thread` and `move_thread` set, as the thread may have more access than the agent); a pool move picks a login of the provider it names (`provider`, which only goes with `poolId`: the menu's column), else of the named `model`'s, else of the thread's own, even when the thread's current login is in that pool (with none of that provider's logins free, the pool's usual pick, which may be the other provider's); an idle move with nothing to carry on gets a `system.note` ("<model> takes over from your next message."). `archivedBy` and `verdict` go with `archived: true`; see "Who archived a thread". `starred` sets or clears `starredAt`; starring a thread that's already starred keeps its place, and neither stops a turn. A `title` is Mike's unless `titleBy` is `"agent"` (the `update_thread` tool, unless the agent says Mike asked for it). Once Mike has named a thread, an agent's different title is `-32602` and nothing in the call changes, and no model title replaces it. `snoozedUntil` is an ISO time, or `"restart"` for until the runner next starts (any start: a planned restart, a crash, a reboot), when the thread wakes before the restart's resume is sent, so a thread put away while its own restart waited is still carried on. `"release"` is the same but only a start (or taking it over from a draining runner) on another release than this runner's wakes it, so a crash or a restart on the same build leaves it asleep (`snoozedUntilRelease`); a runner from a source checkout has no release to tell apart, so there it is `"restart"`. `update_thread`, `end_turn`'s `snooze` and `tb snooze` take it too. Snoozing or archiving releases the CLI (and archives a Codex thread in Codex too). Changing account or cwd takes effect on the next turn; an account change during a turn says so in a `system.note` ("<model> takes over from your next message, which stops this turn."), see `threads.send`. A model or effort change reaches a live Claude CLI straight away (`null` goes back to the default); on Codex it applies from the next turn, with a `system.note` if a turn is running. A folder change on the same Claude account copies the native session's transcript to the new folder and resumes it; on the same Codex account the session carries on in the new folder from the next turn. Otherwise (or if that fails) it starts a new native session with a handoff note: the thread so far under a 16,000-character budget (runner/src/handoff-history.ts, after T3 Code's): messages, tool calls with a little of their output, edited files and errors; the last user message, the last reply and the first message first, then newest to oldest, with gaps marked and a pointer to `read_thread` for the rest. An account of the other provider switches `provider`, resets `model` and `effort` to that provider's defaults unless the same call sets them, and clears the thread's "Always allow" rules. `model` and `effort` are checked as in "Models and effort across providers". `accountId` pins the thread to that login (clearing `poolId`). `poolId: null` pins it to its current login; a pool id puts it in that pool, and moves it onto one of the pool's logins at once (from the next turn) if its current one isn't in it; an unknown one is `-32602`. A move from one Claude login to another copies the session's transcript into the new login's config folder and resumes it there, as a folder move does |
| `threads.retitle` | `{ dryRun?: boolean, threadIds?: string[] }` | `{ threads: { threadId, from: string, to?: string, reason?: string }[] }`. Gives a model title to every thread, archived and snoozed included, whose title is still its first message's first line and that nobody has named (`titleSet`); see "Titles" under "Settings and models". One entry per such thread: `to` when it was renamed, `reason` when it wasn't (no key, private folder, over budget, renamed meanwhile). With `threadIds`, those threads whatever their title (a poor model title can be asked for again), still never one named by hand. The model also gets the start of the thread's first reply. `dryRun` lists them without asking the model (`tb retitle`) |
| `threads.delete` | `{ threadId }` | `{}`. Stops the thread's CLI and moves its folder to `trash/` in the data dir (a Codex thread is archived in Codex too). Every client gets `thread.deleted` |
| `threads.events` | `{ threadId, afterSeq?: number, beforeSeq?: number, limit?: number }` (default: the newest 500) | `{ events: Event[], firstSeq, lastSeq, inProgress: { itemId, type: "assistant.text" \| "reasoning", text }[] }` |
| `threads.heldBody` | `{ threadId, seq }` | `{ state }`. Another runner's thread only: one tool's output from the backend (see "Other runners' threads through the backend") |
| `threads.subscribe` | `{ threadId, afterSeq?: number, relaySeen?: [number, number][] }` | `{ events: Event[], inProgress: { itemId, type, text }[] }` (everything after `afterSeq`, and the text streamed so far for items still streaming), then pushes `thread.event` notifications. Deltas pushed after the reply carry on from `inProgress` |
| `threads.unsubscribe` | `{ threadId }` | `{}` |
| `threads.subagent` | `{ threadId, subagentId }` | `{ subagent?: Subagent, events: Event[] }`: what the sub-agent has done so far, read from the CLI's own record of it, as events (`user.message` for its brief, then `assistant.text`, `reasoning`, `tool.call`, `tool.result`, `edit.diff`) numbered from 1, with no `turnId`. Read again for more while it runs: thread.updated says when it has done something. `subagent` is absent once the thread's list has dropped it. `-32006` when there's no record of it (an older thread, or the CLI cleaned it up) |
| `threads.markSeen` | `{ threadId, seq }` | `{ thread: ThreadSummary }` |
| `threads.tickAsk` | `{ threadId, asksSeq, index, ticked: boolean }` | `{ thread: ThreadSummary }`. Ticks or unticks one of the open card's asks (Needs you), with an `asks.ticked` event. Sends nothing to the agent. `-32602` when `asksSeq` isn't the open card's or `index` is out of range |
| `threads.share` | `{ threadId, access: "off" \| "link", newLink?: boolean }` | `{ thread: ThreadSummary }`. Whether anyone with the link can read the thread on the website (see Sharing). `newLink` makes a fresh slug, which stops the old link. Another access is `-32602` |
| `approvals.respond` | `{ threadId, approvalId, decision: "allow" \| "allowAlways" \| "deny" \| "answered", message?: string, answers?: Record<string, string>, queued?: Record<string, "allow" \| "deny"> }` | `{}`. `queued` answers calls from the card's `approval.queued` list, by `itemId`, in the same click ("Queued calls"); ids not on the list are ignored, as is the whole of it from the phone or another Mac's view (`remote`). `allowAlways` on a card that didn't offer it counts as `allow`. `allowAlways` allows matching requests for the rest of this thread only; it never changes the thread's permission mode or saves anything in the project. With `answered`, the app sends the chosen answers in one line as `message` too: the runner keeps it in `approval.resolved` (only `answers` goes to the CLI), so the transcript can show what was chosen |
| `plans.approve` | `{ threadId, itemId }` | `{}`. Go ahead on a waiting plan (see "Plan first"); `-32602` if that plan isn't waiting |
| `secrets.answer` | `{ threadId, approvalId, secret?: string, decline?: true }` | `{}`. Answers a `secret.requested` card (Secrets). The runner never logs, emits or mirrors `secret` |
| `media.import` | `{ path: string }` | `{ image: ImageRef }` copies a file into `inbox/` and reads its size; HEIC becomes JPEG and TIFF or BMP becomes PNG. From a thread's own key below Full access it's metered (Daybreak finding 157): one at a time per thread, two at once across them, and pictures of at most 25 MB, 50 files or 200 MB a day per thread, 200 files or 1 GB for all of them (a converted picture counting at its real size), refused with -32602 before the file is opened once over (a converted picture that no longer fits is refused once made). Such a thread's `threads.send` and `threads.create` take only pictures it imported this way, each once and at most 10 at a time, and only to a thread on this runner, and carry a copy the runner makes then from the inbox file, which must still be the file imported, at the size imported, and a picture of the type imported (never converted); otherwise -32602. A thread's import never holds the runner up: it copies in the background from the file as opened, only once its first bytes say it's a picture, leaves nothing behind when it fails, and is removed at once if its client has gone by the time it's done |
| `patches.trust` | `{ threadId, files: { file, hash }[] }` | `{ trusted: string[] }`. Trusts those versions of the thread's waiting patch files (each a `file` its `patches` lists with `untrusted`, and the `hash` given there), then every thread's patches are read again, so the answer comes once they have been. The `claude` entry's file trusts the folder's Claude Code settings the same way. `-32602` for a file the thread isn't waiting on, or one whose hash has moved on since (look again). See "Trusting a folder's patches" |
| `actions.run` | `{ threadId, actionId }` | For a prompt action, `{ turnId }`: its prompt was sent as a message (as `threads.send`). For a url action (only an older client calls it for one), `{ ok: true, durationMs }` once the page is opened on the runner's Mac, with nothing in the transcript. For a command action, `{ ok, exitCode?, durationMs, seq }` once the command has finished, with its output in the transcript as the `action.run` event at `seq`. The command runs in the thread's folder through a login shell with the thread's variables (`THREADBEAR_THREAD_ID` and the rest) and is stopped after 10 minutes. `-32602` for an action the thread doesn't have, `-32020` while the same action is still running |
| `panels.render` | `{ threadId, panelId }` | `{ image?: ImageRef, items?: PanelItem[], note?: string }` draws an `image` panel or fills a `list` panel now. For `xcode.simulator`, a screenshot of the booted simulator (`xcrun simctl io booted screenshot`), written to the same file each time under the thread's `panels/`; with no device booted (or another failure) there's only `note`. For a `list` panel, the rows its patch's `items` function returned (at most 200), or `note` with the error when it threw or took over 20 seconds. Slow: it waits for the screenshot or the function. `-32602` for a panel the thread doesn't have |
| `panels.toggle` | `{ threadId, panelId, toggleId, on }` | `{ items?: PanelItem[], note?: string }`. A list panel row's switch was pressed: calls the `toggle` function of the panel's patch with `{ id: toggleId, on }` and the same context as `items`, then fills the panel again and answers as `panels.render` does, so the row shows what the patch now says. A throw or a call over 20 seconds is `-32000` with its first line ("Couldn't switch it: ..."). `-32602` for a list panel the thread doesn't have, one whose patch has no `toggle` function, or an `on` that isn't a boolean. The app shows the new state at once, takes no more presses of that switch until the answer, and puts it back if the call fails |
| `panels.convexDeployments` | `{ threadId, panelId, refresh?: boolean }` | `{ deployments: { deployment, deploymentUrl, label }[], note?: string }`. The configured cloud deployment and the project's Development and Production deployments, resolved through the runner's own Convex CLI, run in the project's folder, with read-only queries of `process.env.CONVEX_CLOUD_URL`. Duplicate names are combined; `note` explains unavailable choices. Cached for one minute; `refresh` bypasses the cache. Makes no deploy keys and changes no project settings. `-32602` for a missing or non-cloud panel |
| `panels.convexKey` | `{ threadId, panelId, deployment?: string, renew?: boolean }` | `{ deployment, deploymentUrl, adminKey }`, a deploy key for a panel with `convex`, for Convex's embedded dashboard. `deployment` defaults to the panel's configured deployment; any other name must be one returned by `panels.convexDeployments` for this panel's project. The runner makes it the first time (`convex deployment token create` in the project's folder, with the runner's own Convex CLI, so an older `convex` package in the project doesn't matter, on Mike's Convex CLI login) and keeps it in `secrets/convex-panels/<deployment>.json`; `renew` deletes that one from Convex and makes a fresh one. A kept key is first checked with the deployment's `/api/check_admin_key` (only at its own `<name>[.<region>].convex.cloud` address), and one Convex says no to (revoked) is replaced the same way; an unclear answer keeps it. Slow the first time. `-32602` for a panel the thread doesn't have or one without `convex`; `-32040` when the runner's Convex CLI isn't signed in (or its login expired), `-32041` when its login can't reach the deployment, otherwise `-32000` with the CLI's message, each in plain words |
| `panels.convexLogin` | `{ threadId, panelId, check?: boolean, force?: boolean }` | `{ state: "idle" \| "waiting" \| "done" \| "failed", url?, code?, message? }`. Signs the runner's Convex CLI in (`convex login --no-open --login-flow poll`), for a panel that got `-32040` (or `-32041`, with `force`, to switch accounts). Answers once the CLI prints its device page: `url` to open in the browser on the Mac the person is at (any browser can approve it, so a remote runner's sign-in works from here), `code` what that page shows. A call while one is waiting joins it. `check` only reports: poll it until `done` (then the deployment list is fetched afresh) or `failed` (`message` says why, or that it wasn't approved within the code's five minutes) |
| `threads.commands` | `{ threadId }` | `{ commands: SlashCommand[] }`: what the composer's picker offers for the thread (see Slash commands) |
| `threads.contextUsage` | `{ threadId }` | `{ usage?: ContextUsage, live: boolean, note?: string }`: what fills the thread's context, in Claude's own words, for the composer ring's popover (see Context breakdown). Asked of the thread's running CLI; never starts one. Fast (about a second) |
| `threads.warm` | `{ cwd?, accountId?, poolId?, provider?, model?, effort?, permissionMode?, worktree?, projectIds? }` (what the new-thread page's `threads.create` would send, without the words), or `{ cancel: true }` | `{ warmId?: string }`: starts a CLI for the new thread being written, so its first message doesn't wait for one to boot (see Warm start below). No `warmId` when this runner doesn't (the `warmStart` experiment off, a folder that asks for a worktree or isn't there, a project, a provider other than Claude). `cancel` stops this connection's. Refused to a thread's own connection |
| `folders.commands` | `{ cwd?: string, accountId?: string, permissionMode?: PermissionMode }` | `{ commands: SlashCommand[] }`: the same list for a new thread's box, before the thread exists: the login and folder it would start on, each defaulting as `threads.create` does. `-32010` for an unknown login |
| `threads.highlights` | `{ threadId }` | `ThreadHighlights` (see Highlights): what the thread has made, shared and pinned, read from its events since the last call and kept with the thread |
| `threads.explain` | `{ threadId, selection: string, message?: string, question?: string, earlier?: { question?: string, answer: string }[] }` | `{ answer: string, model: string }`. Explains words Mike selected in the transcript, on the small model (see Explain). `message` is the whole message they came from, as the app shows it; `earlier` and `question` are a follow-up. Writes nothing to the thread. `-32000` with the reason when no model answers |
| `threads.hibernateWhen` | `{ threadId, said: string }` (at most 300 characters) | `{ thread: ThreadSummary, until?: string, topic?: string, why: string }`. Hibernates the thread until when Mike said, in his own words (see Hibernate in words). It's away at once, with `wakeWhen.pending`, and the answer comes once the model has worked out when. `-32000` with the reason when it can't say, and the thread is back in the inbox |
| `threads.removeHighlight` | `{ threadId, highlightId }` | `{ thread: ThreadSummary }` takes one off the list for good (a pin or a found one); a later mention doesn't bring it back. `-32602` for an id the thread doesn't have |
| `threads.panelShown` | `{ threadId, requestId }` | `{ thread: ThreadSummary }`. The app has shown the thread's `panelRequest` (see Showing panels), which clears it. Another id (a newer request replaced it, or it's gone already) changes nothing |
| `threads.showPanel` | `{ threadId, panel, reload?: boolean }` | `{ available, request?, shown? }`. Queues the same request as `show_panel` when the Mac app is connected. Otherwise returns `available: false` without queuing anything. Used by `tb show-panel` and BrowserBear handoff |
| `schedules.list` | `{ threadId?: string }` | `{ schedules: Schedule[] }`, soonest `nextRunAt` first, then the paused and finished ones. With `threadId`, only the ones that send to that thread or were made by it |
| `schedules.create` | `{ text: string, title?: string, at?: string, cron?: string, timezone?: string, threadId?: string, cwd?, accountId?, poolId?, provider?, model?, effort?, permissionMode?, check?: string, checkTimeoutSecs?: number, paused?: boolean, createdBy?: string, runnerId?: string }` | `{ schedule: Schedule }`. Exactly one of `at` and `cron`. `provider` only with `poolId` (else `-32602`): which kind of its logins each run starts on, as `threads.create`'s. `check` (at most 2,000 characters) and `checkTimeoutSecs` (1 to 300; 60 without): see "Schedule checks" below. `accountId` and `poolId` together, or a `poolId` this runner doesn't have, is `-32602`. An `at` in the past runs straight away. With `threadId` it sends there, otherwise it starts a new thread each time (`cwd` defaults like `threads.create`'s, checked now). A bad cron or zone is `-32602` with a message saying what's wrong. `runnerId` (an id or a name from `runners.list`) puts a new-thread schedule on another runner: its folder and account are checked there when it runs, and an absent `cwd` means that runner's default. Absent, it's this runner. Needs schedules in the backend (see Schedules, "Runners"); otherwise `-32602` |
| `schedules.update` | `{ scheduleId, title?, text?, at?: string, cron?: string, timezone?: string \| null, paused?: boolean, cwd?, accountId?, poolId?: string \| null, provider?: Provider \| null, model?: string \| null, effort?: EffortLevel \| null, permissionMode?, check?: string \| null, checkTimeoutSecs?: number \| null }` | `{ schedule: Schedule }`. A new `poolId`, `accountId` or `model` without `provider` drops the one it had, so a model never goes to a login of another kind; with no pool left `provider` goes too. `check: null` or `""` takes the check off (its `checkTimeoutSecs` stays); `checkTimeoutSecs: null` puts it back to 60. Setting `at` drops `cron` and the other way round; setting `accountId` drops `poolId` and the other way round (`poolId: null` leaves neither). The folder, login and model are only for one that starts a new thread: on one that sends to a thread they're `-32602`. A new time works out `nextRunAt` again; so does unpausing. Setting `at` on a finished one-off makes it run again then. The target thread can't be changed (make a new schedule) |
| `schedules.delete` | `{ scheduleId }` | `{}`. From a thread's key not on Full access, refused (`-32060`, pointing at `delete_schedule`, which asks on a card) when the schedule's runs have more access than the thread, it has a check, or it isn't this runner's. On such a schedule `schedules.update` refuses lowering its `permissionMode`, taking its `check` off (`null` or blank), or changing its `timezone`, `accountId`, `poolId`, `model` or `effort` too, and `threads.update` refuses lowering the mode of a thread with more access than the caller's, so none of them can be chained into a delete; pausing it is free |
| `schedules.run` | `{ scheduleId }` | `{ schedule: Schedule, threadId?: string, turnId?: string, queued?: boolean }` runs it now, as if it were due, even when paused. A repeating schedule keeps its `nextRunAt`; a one-off is finished. For a schedule on another runner it answers at once with `queued: true` and no thread: that runner runs it when it next hears (`runRequestedAt` is set until then) |
| `runners.list` | `{}` | `{ runners: RunnerInfo[] }`, this runner first, then the rest by name. Without a backend, just this runner |
| `requests.get` | `{ threadId, approvalId }` | `{ request, target?, runners, fingerprint, missingFolder? }`: another runner's request for a new thread (Asking another runner), exactly as it was filed (`relay:runnerRequest`) but for a folder starting on this Mac, which is the folder it would start in here ("The folder" there), the runner it names if this runner can find it (`{ id, name, self }`), and every runner to pick from instead. `missingFolder` is the folder as filed when it would start here and isn't a folder on this Mac. Main Mac's runner only; `-32602` for no such request on that thread |
| `requests.answer` | `{ threadId, approvalId, allow: boolean, runnerId?: string }` | `{ thread?: { id, runnerId, runnerName } }`. `allow` starts the filed request (on `runnerId` if given, else the runner it named), marks it allowed and answers its card; otherwise marks it denied and declines the card. `-32602` once the card has closed (answered, expired, declined from the phone) or the request was already answered. Main Mac's runner only |
| `runners.stats` | `{}` | `{ stats: RunnerMachineStats[] }`: each runner's latest machine figures, `{ runnerId, at, cpuPercent, cores, memUsed, memTotal, diskFree, diskTotal, load1?, uptimeSec, machine?, os? }` (bytes; `uptimeSec` is the machine's). Asking marks them wanted (`sync:watchRunnersFromMac`, at most every 20 s), so every runner reports every 10 s until nobody has asked for 45 s. The Mac app asks only while a runner's details are open in the Runners panel and its window can be seen. Empty with sync off, on an older backend, or on a runner key. A runner older than this answers `-32601`. The app leaves out a row with a figure past `setRunnerStats`'s limits, as one stored before those were checked would be |
| `remoteThreads.list` | `{ forTools?: boolean }` | `RemoteThreads`: other runners' threads for the sidebar (see "Other runners' threads"). `forTools` is a draining runner's agent tools asking the primary: it answers as for its own tools, waiting up to 3 seconds for the backend's rows (Agent tools). Empty with sync off, or before the backend (API 12) has answered. A runner older than this answers `-32601` |
| `runners.setOrder` | `{ runnerIds: string[] }` | `{}`. Mike's runner order, every runner's id with this one's: the same order the phone sets (`phone:setRunnerOrder`), which a phone's new thread follows, saved with `sync:setRunnerOrder` (backend API 58, the owner key only). It comes back as `RemoteThreads.order` in `remoteThreads.updated`. `-32602` for a list that isn't one of strings; an error on a runner key or an older backend. A runner older than this answers `-32601` |
| `files.read` | `{ path: string, maxBytes?: number, known?: { size, modifiedAt } }` | `{ path, size, modifiedAt, mediaType, data, truncated }` (`data` base64, at most `maxBytes`, default 16 MB, never over 48 MB; `truncated` when the file is longer), or `{ path, unchanged: true, size, modifiedAt }` when `known` matches the file. A file on this runner's Mac, for a Mac app showing one of its threads from another Mac (see "Other runners' threads"). `-32602` for a relative path, a missing file or a folder. With `runnerId` (another runner's), only a picture pasted into one of that runner's messages, from the backend (Other runners' threads through the backend, "Pictures in messages") |
| `files.list` | `{ path: string }` | `{ path, entries: [{ name, isFolder, hidden, size?, modifiedAt? }], truncated }` (`size` for a file only; `isFolder` follows a symlink; `hidden` is a dotfile; at most 5000 entries, in no set order, `truncated` when the folder has more; a `size` that isn't a whole number of bytes is read as none). A folder on this runner's Mac, for the side pane's folder browser on another Mac (see "Other runners' threads"). `-32602` for a relative path, a missing folder or a file |
| `schedules.preview` | `{ cron?: string, at?: string, timezone?: string, count?: number }` | `{ whenText: string, runs: string[] }`, the next `count` (default 5, at most 20) times it would run, for an editor to show as someone types. `-32602` with the reason for a cron or zone it can't read |
| `projects.list` | `{ archived?: boolean }` | `{ projects: Project[] }`, newest `lastActivityAt` first. Archived ones only with `archived: true` (then all of them) |
| `projects.get` | `{ projectId }` | `{ project: Project, threadIds: string[] }`, its threads newest activity first, put away ones included |
| `projects.create` | `{ title: string, folders?: string[], goals?, state?, notes?, links?: { title?, url }[], threadIds?: string[], parentId?: string }` | `{ project: Project }`, made by Mike (`createdBy: "mike"`). `threadIds` are put in it, pinned. Folders must exist (`-32602` otherwise). `parentId` makes it a part of that project (Projects, "Parts") |
| `projects.update` | `{ projectId, title?, folders?: string[], goals?, state?, notes?, links?: { title?, url }[], notion?: string, archived?: boolean }` | `{ project: Project }`. Replaces what's given. A new title is Mike's (`titleBy: "mike"`), so the librarian never renames it. A link that isn't http(s), or more than 8, is `-32602`. A change of folders reloads its threads' patches. `notion` is a Notion page or database address (notion.so, notion.site, notion.com, or a `collection://` data source), read straight away (see Project tasks); empty takes it off; anything else is `-32602`. `parentId` makes it a part of that project, or `""` (or `null`) its own project again (Projects, "Parts"); a parent that's itself or a part already, or a project that has parts of its own, is `-32602`, and one that doesn't exist `-32007` |
| `projects.refreshTasks` | `{ projectId, force?: boolean }` | `{ project: Project }` once its Notion board has been read again, unless it was read in the last minute (`force` reads it anyway). The project page asks when it opens. `-32602` for a project with no `notion` |
| `projects.setIcon` | `{ projectId, path?: string, symbol?: string }` | `{ project: Project }`. Mike's choice: `path` a picture on this Mac (PNG, JPEG, WebP, SVG, ICNS or ICO, copied in), or `symbol` an SF Symbol name; neither puts it back to automatic, and the librarian finds one again within seconds. `-32602` for a missing file or a name that isn't a symbol's |
| `projects.merge` | `{ projectId, intoId }` | `{ project: Project }` (the one kept). Folders and threads move over, notes are joined, and `projectId` is deleted |
| `projects.delete` | `{ projectId }` | `{}`. Its threads leave it; nothing else is touched |
| `threads.setProjects` | `{ threadId, add?: string[], remove?: string[] }` | `{ thread: ThreadSummary }`. What Mike does by hand: an added project is pinned (adding one the thread is already in pins it, which is how "keep it here" works), a removed one is remembered so the librarian never puts the thread back in it |
| `librarian.status` | `{}` | `{ librarian: LibrarianStatus }` |
| `github.pr` | `{ url, files? }` | `PrView` (see Pull requests). With `files: false`, without its files (`files: []`, `filesLater: true`). `-32602` for a link that isn't a github.com PR; gh's own error (`-32000`) when it can't be read |
| `github.prFiles` | `{ url }` | `{ files, filesError?, filesCut? }`: a PR's files alone, as in `PrView` |
| `github.prStates` | `{ urls: string[] }` | `{ states: { [url]: "open" \| "draft" \| "merged" \| "closed" } }`. A link it couldn't place is left out |
| `github.prAct` | `{ url, action, method?, body? }` | `{}` once GitHub has it, or gh's own error. `action` is `merge` (with `method` `rebase`, `squash` or `merge`), `close`, `reopen`, `comment` (`body`), `approve` (`body?`) or `requestChanges` (`body`) |
| `connectors.status` | `{ refresh?: boolean }` | `{ connectors: ConnectorsStatus }` (see Connectors). `refresh` asks the gateway's `/health` first, unless it did in the last 10 seconds; the app passes it when the Connectors panel opens. A runner from before Connectors answers `-32601` and the app leaves the panel out |
| `librarian.run` | `{ threadId?: string }` | `{ librarian: LibrarianStatus }`. Queues a look at the thread now (reason `asked`), or with no `threadId`, at every thread it has never looked at (a backfill, newest first) |
| `librarian.update` | `{ paused?: boolean, evolvingTitles?: boolean }` | `{ librarian: LibrarianStatus }`. Both settings persist in librarian.json. Evolving titles defaults on; off prevents later librarian renames, including an answer already in flight, without pausing other librarian work or initial naming |
| `pools.list` | `{}` | `{ pools: Pool[] }` (see Pools) |
| `pools.save` | `{ pools: Pool[] }` | `{ pools: Pool[] }`. Replaces the whole list in `runner.json` (`builtIn` is dropped; an empty list goes back to the built-in ones). `-32602` for a duplicate id, a blank id or title, an empty `accountIds`, or an account id the runner doesn't know. A blank or non-string `icon` is dropped. Every client gets `pools.updated` |
| `settings.get` | `{}` | `{ settings: Settings }` |
| `settings.update` | `{ defaultCwd?, idleMinutes?, maxLiveCLIs?, followMain?, bulletReplies?, oneReply?, labReview?, labReviewers?, labPanel?, keepAwake?, bringIn?, spareWeek?, fullSync?, models?: { pool?: string \| null, privateFolders? }, experiments?: { [id]: boolean } }` | `{ settings: Settings }`. Saves what's given to `runner.json` and applies it straight away, except `followMain` and `fullSync` (next restart). `experiments` sets those switches under runner.json's `experiments`, keeping the rest; `Settings.experiments` lists every one as `{ id, name, does, on }`, oldest first. `defaultCwd` must be an existing folder, `idleMinutes` at least 1, `maxLiveCLIs` 1 to 20, `pool` a pool id or `null`, each `experiments` key an experiment's id, `labReviewers` and `labPanel` each a list of `{ provider, model?, effort? }` with known providers and efforts (the same provider on the same model listed twice in one list counts once; an older app's `panel: true` entries in `labReviewers`, sent without `labPanel`, become the panel and stay in the list); otherwise `-32602` saying which. Every client gets `settings.updated` |
| `instructions.get` | `{}` | `{ instructions: StandingInstructions }` (see Standing instructions). `-32601` with the experiment off, and from an older runner: the app then shows no box |
| `instructions.set` | `{ text: string }` | `{ instructions: StandingInstructions }`. Saves and signs the text, trimmed; an empty one clears them and removes both files. `-32602` for a `text` that isn't a string or is over 20,000 characters, `-32601` as for `instructions.get`. Every client gets `instructions.updated` |
| `devices.list` | `{}` | `{ devices: Device[], site?: string, reason?: string }` (see Devices). `site` is the website's root while sync is on; `reason` says why nothing can pair when it's off |
| `devices.pair` | `{ kind: "phone" \| "browser", name?: string, days?: number }` | `{ device: Device, pairingLink?: string, signInLink?: string }`. For a phone, a one-use pairing code (see Devices) in the text the app draws as a QR code, `TBPAIR1_<base64url of url=…&code=…&key=<runnerId>:<key>>` (the `key` item is this runner's secret-box public key, see Secrets, "Trusting the key"; absent when the runner has none); no token. For a browser, a one-use sign-in code in the website's sign-in link (`<site>/#code=…`), for the app to open; no token. `days` is 1 to 365 (default 90). `-32000` while sync is off, or while the backend is older than this |
| `devices.revoke` | `{ deviceId }` | `{ devices: Device[] }`. The phone or browser is signed out at its next request. `-32602` for an id that isn't there |
| `models.run` | `{ job: "classify" \| "extract" \| "summarize" \| "generate", text: string, labels?: string[], fields?: Record<string, string>, maxWords?: number, system?: string, cwd?: string, maxTokens?: number }` | `{ ok: true, value, model }` or `{ ok: false, reason: "no-pool" \| "off" \| "private" \| "no-room" \| "timeout" \| "provider", message }`. One model call by hand (`tb models try`), on the pool like any other, with `feature: "tb"`. `maxTokens` (generate only, 1 to 8000, default 500) caps the answer, reasoning included; `classify` needs 2 or more `labels` and answers one of them; `extract` needs `fields` (name to a plain description) and answers an object of them, `null` where the text doesn't say |
| `runner.status` | `{}` | `{ version, release?, branch?, pid, startedAt, home, logFile, liveClis, running: string[], background: { threadId, tasks: string[] }[], busy?: string[], pendingRestart?: { when, reason?, release?, resumeThreadId?, requestedAt, backgroundUntil?, waitingFor: string[] }, rolledBack?: { from, at }, draining?: { pid, version, release?, since, threads: string[] }[], update?: { state, checkout?, reason?, checkedAt?, commit?, release?, logFile?, launcherChanged?, launcherReason?, followsOrigin?, followProblem? }, behindRunners?: { name, problem }[], macScreen?: { fullDiskAccess?, dialogs, dialogsSince? }, clis?: CliStatus[] }`. `running` lists the threads that are starting, running or waiting on an approval or a question; `background` the threads whose CLI is still running background shells or subagents (`tasks` describes each). A restart waits for both. `busy` is every thread a restart would wait for: those, plus a turn-end hook still running or a thread between turns (deploy.mjs `--check-idle` reads it). `branch` is the branch the release was built from. `rolledBack` is set when this release is running because `launch.mjs` went back to it from `from`, which kept crashing at startup (and nobody has activated it on purpose since). `update` is the runner following main by itself (docs/dev-tools.md): `state` is `off` (`reason` says why), `idle`, `checking`, `building`, `waiting` (`release` is built and starts on the pending restart) or `failed` (`reason` is the error; `logFile` has the build's output); `commit` is main's tip at the last check (`checkedAt`). `followsOrigin` is set while `followOrigin` is on in `runner.json` (docs/dev-tools.md); `followProblem` says what's wrong with following GitHub's main, when something is. `behindRunners` is the other runners saying that of themselves, or that their update to main failed (whose fix thread the main Mac starts, docs/dev-tools.md), on the main Mac's runner |
| `runner.restart` | `{ when?: "idle" \| "now", resume?: { threadId, text }, reason?: string, release?: string, backgroundWaitMs?: number, cancel?: boolean }` | `{ scheduled: boolean, waitingFor: string[], background?: { threadId, tasks: string[] }[], note?: string, noResume?: string, handover?: { keeps: string[] } }`. See Restarts below; `handover` under Handovers. `scheduled` is true once the restart is saved; an empty `waitingFor` means it is happening now. `background` is the background work among `waitingFor`. `release` is the release the restart should come back on (the deploy script sets it). `backgroundWaitMs` limits how long background shells and subagents hold the restart. `cancel: true` withdraws a pending restart that hasn't begun and returns `scheduled: false` (`-32020` once it has begun), with a `note` when it also put `current` back. `noResume` says why the `resume` won't be sent as things stand (the thread has already been resumed 3 times in the last hour), so whoever asked can say so rather than wait for it. A runner older than this answers `-32601` |
| `runner.profile` | `{ seconds?: number }` | `{ file, summary: { ms, busyMs, gcMs, self, own, total } }`. `tb profile`: runs V8's CPU profiler on the runner's own main thread in-process (node:inspector, no restart or debug port) for `seconds` (default 10, at most 120), writes a `.cpuprofile` to `<home>/profiles/` (the newest ten kept) and returns where the time went. Each list is `{ name, where, ms, pct }[]`: `self` the leaf frames, `own` the nearest frame of the runner's own code under each sample (so a `readdirSync` is charged to whoever called it), `total` every function on the stack. One at a time; a second gets `-32602`. The runner also logs `event loop stalled` (info, with `ms`) whenever its main thread was held up for a second or more |
| `runner.reinstall` | `{}` | `{ reinstall: RunnerUpdates["reinstall"] \| null }`. The Updates panel's Update it and Try again: the runner runs `install-runner.sh --stage` as a launchd job of its own (runner/src/reinstall.ts) straight away, stopping nothing, and says how it's going in `runner.updates`. `null` when the LaunchAgent isn't behind main. Refused to a thread's own key (rpc-gate.ts). A runner older than 14 Nov 2026 answers `-32601` |
| `clis.list` | `{}` | `{ clis: CliStatus[] }` |
| `clis.check` | `{ provider?: Provider }` | `{ clis: CliStatus[] }`. Starts a version check (both CLIs when `provider` is absent) and returns at once, with the state as it was when the call arrived; the result comes through `clis.updated` |
| `accounts.useReset` | `{ accountId }` | `{ outcome: "reset" \| "nothingToReset" \| "noCredit" \| "alreadyRedeemed", account?: Account }`. Spends one of a Codex login's usage resets (Pools, "Usage resets"): Mike's click on the limit box, never a thread's (the thread-key gate refuses it). `account` is the login after the reading taken straight after. `-32010` for an unknown login, `-32602` for one whose provider has no resets, `-32020` while a reset for the same login is still on its way, `-32000` with Codex's words when it fails. A runner older than this answers `-32601` |
| `accounts.findWork` | `{ accountId }` | `{ threadId, started: boolean, thread: ThreadSummary }`. The Usage panel's Find work for it, on a login whose week will go partly unused: starts a thread pinned to that login that suggests 2 to 4 jobs to spend the rest of its week on and asks before starting any (runner/src/spare-week.ts), whatever `Settings.spareWeek` says. While that login's last such thread is still open (not archived) it answers that one, `started: false`, rather than starting another. The app opens the thread either way. `-32010` for an unknown login. The app's, never a thread's (the thread-key gate refuses it). A runner older than this answers `-32601` |
| `accounts.recheck` | `{ accountId? }` | `{ accounts: Account[] }`. Reads the login list again and asks the Claude CLI about that login's sign-in now (every Claude login without `accountId`), rather than at the next check, up to 10 minutes away. The app calls it every few seconds while a Sign in… it opened is unfinished, so the row stops waiting as soon as Terminal's sign-in is done. `accounts.updated` follows as usual. The app's, never a thread's (the thread-key gate refuses it). A runner older than this answers `-32601` |
| `accounts.yearToken` | `{ accountId, runnerId?, code?, check?: boolean, cancel?: boolean }` | `{ state: "idle" \| "starting" \| "waiting" \| "checking" \| "done" \| "failed", url?, message?, madeAt? }`. Year-long token… for a Claude login on another runner (Accounts, "Year-long tokens", "On another runner"), with `runnerId` that runner's, through Convex as a `call` (backend API 90); without it this runner's own. With none of `code`, `check` or `cancel` it starts `claude setup-token` for the login, or joins the one already going, and answers within a few seconds: `starting` until setup-token has printed its sign-in page, then `waiting` with `url`, the claude.ai page to approve it on in any browser. `code` is what the page shows after Authorize (`<code>#<state>`, letters, digits, `-` and `_`, its state the url's own): the runner types it in and answers `checking`, then `done` (with `madeAt`) once the token is in the login's `threadbear-token.json`, or `failed` with `message`. `check` only reports (`idle` when nothing has been started, or the last one ended over 10 minutes ago); `cancel` stops it. One not finished within 10 minutes is stopped. The token is never in an answer. `-32010` for an unknown login, `-32602` for one that isn't Claude's or a code of the wrong shape or for another page, `-32020` while a code is being checked. The app's, never a thread's (the thread-key gate refuses it). A runner older than this answers `-32601`, or through Convex an error naming the method |
| `clis.update` | `{ provider: Provider, version?: string, force?: boolean }` | `{ clis: CliStatus[] }`. Starts an update and returns at once, with `update.state` `running` or `waiting`; progress comes through `clis.updated`. `version` picks a kept Codex version (how "Go back" works). `force: true` installs a held version anyway |
| `clis.setPolicy` | `{ provider: Provider, policy: "auto" \| "notify" \| "off" }` | `{ clis: CliStatus[] }` |
| `usage.stats` | `{ days?: number }` | `UsageStats` (see Usage history): each login's tokens by the hour and its limit readings over time, for the Usage panel's charts. `days` is 1 to 14 (default 8). A runner older than this answers `-32601` |

Errors use JSON-RPC error objects: `-32602` bad params, `-32004` thread not
found, `-32005` schedule not found, `-32006` sub-agent not found, `-32007` project not found, `-32010` account not found, `-32020` busy (e.g. two sends racing), `-32030` a draining runner no longer holds that thread (Handovers), `-32031` the thread isn't on the runner the request named (`threads.send`'s `runnerId`), `-32050` background work would be stopped (`threads.edit`), `-32060` the calling thread doesn't have the access for this (A thread's own key),
`-32601` a method this runner doesn't have (`clis.*` on a runner older than
them), `-32000` anything else with a readable `message`.

### Warm start

Claude Code takes about half a second from starting to its first request, and
a new thread's first message used to wait for it after Send. With the
`warmStart` experiment on (docs/experiments.md), the app calls `threads.warm`
when its new-thread page opens (⌘N or the button, not at launch), and again
when the box's settings change. The runner starts a CLI with the options that
thread would start with, under an id it keeps for the thread, and answers that
id. The app sends it back as `threads.create`'s `warmId`: the thread is made
under that id, and its first start takes the running CLI if every option still
matches (folder, login, model, effort, mode, instructions), else stops it and
starts as before.

There is one at a time, for the connection that asked: a new `threads.warm`
with other settings replaces it, and it's stopped when that connection closes
(the app quitting leaves no CLI behind), on `{ cancel: true }`, when the runner
hands over or stops, and after ten minutes unused. A thread's own connection
can't ask for one or name one.

### Models and effort across providers

The Mac app offers **Continue with Codex Sol** above the composer when the
latest failed Claude turn has the provider's safeguards refusal error and
the thread's runner has an unrestricted Codex login with room and
`gpt-6.1-sol` in its model list. This is a user action: it awaits
`threads.update` with that login and model, then `threads.send` with a
request to continue the task. The normal provider handoff carries the
history. It pins the thread to that login, leaves any draft untouched and
never switches automatically. It uses the existing RPCs and recognises the
error text for transcripts from older runners too.

The runner checks `model` and `effort` in `threads.create` and
`threads.update` against the thread's provider, and corrects them rather than
answering `-32602`, because an older app always sends a model and can't
recover from an error. (An `effort` that isn't an `EffortLevel` at all is
still `-32602`.)

- Claude models are `opus`, `sonnet`, `haiku` and anything starting
  `claude-`. Codex models are those in a Codex account's `models`, or
  anything starting `gpt-` before the list is known.
- A model of the other provider, or a Codex id that isn't in the account's
  `models` once they're known, is replaced by the provider's default, with a
  `system.note` ("sonnet isn't a Codex model, so this thread uses
  GPT-6.1-Sol").
- An effort the model doesn't list in `effortLevels` (when known) is dropped
  with a note. `ultra` on a Claude thread always is.
- An ACP agent's model counts only if that account's `models` lists it, never
  by its name, and a Claude or Codex id goes to them first. OpenCode and
  Cursor have no effort levels (`ProviderInfo.effort` is `"none"`): an
  `effort` is dropped. Grok's models list theirs (`effortLevels`, from
  `_meta.reasoningEfforts` in its `session/new`), and a thread's effort is set
  as the session's `thought_level` config option, the model's own default for
  none.

## Notifications (runner to app)

| method | params |
|---|---|
| `thread.updated` | `{ thread: ThreadSummary }` sent to every connected client whenever a summary changes, `background` included: a sub-agent or shell job starting or finishing sends one even when nothing else changed |
| `thread.event` | `{ threadId, event: Event }` only for subscribed threads, persisted and transient |
| `thread.deleted` | `{ threadId }` sent to every connected client when a thread is deleted |
| `accounts.updated` | `{ accounts: Account[] }` sent to every connected client when the account list or what the runner knows about an account changes: a login appears or goes (checked every 10 seconds), its `models` once the CLI has been asked, its `defaultModel` once a turn has shown it, or its `usage` (Token Stats' `limits.json` changed, or a live reading moved a window by a point or more). The first change goes out at once, then at most one every 5 seconds, always ending on the latest list. Replaces the list from `hello` |
| `pools.updated` | `{ pools: Pool[] }` sent to every connected client after `pools.save`, and when a change in the login list changes the built-in pools. Replaces the list from `hello` |
| `clis.updated` | `{ clis: CliStatus[] }` sent to every connected client when a CLI's status changes (a check finished, an update started, moved on or ended). The latest list wins |
| `schedules.updated` | `{ schedules: Schedule[] }` sent to every connected client whenever any schedule changes (made, edited, run, deleted, or its thread deleted). The whole list, in `schedules.list` order |
| `remoteThreads.updated` | `RemoteThreads` sent to every connected client whenever another runner's threads, or what's known of that runner, change. The whole list, as `remoteThreads.list` |
| `projects.updated` | `{ projects: Project[] }` sent to every connected client when any project changes, as `projects.list` with `archived: true` would answer. Thread membership changes come as `thread.updated` |
| `librarian.updated` | `{ librarian: LibrarianStatus }` sent to every connected client when the librarian's status changes |
| `connectors.updated` | `{ connectors: ConnectorsStatus }` sent to every connected client when what the Connectors panel would show changes (a service signs out or back in, the gateway stops or starts answering); not when only `checkedAt` moves |
| `settings.updated` | `{ settings: Settings }` sent to every connected client when a setting or the key changes, and at most once a minute while model calls are adding to the spend |
| `instructions.updated` | `{ instructions: StandingInstructions }` sent to every connected client when they're saved, or found changed outside Settings |
| `runner.notice` | `{ level: "info" \| "warning" \| "error", message }`. Also sent straight after the `hello` result for things the client missed (startup problems, a missing `claude` binary) |
| `runner.updates` | `{ updates: RunnerUpdates }` sent to every connected client when the runner's own update state changes (below). Replaces the one from `hello` |
