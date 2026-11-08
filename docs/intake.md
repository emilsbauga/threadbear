# External message intake

Text intake accepts email and Telegram content and returns durable receipts.
The optional Backlog consumer below saves received messages as dormant drafts.
`received` still means stored in Convex, not confirmation of a draft or execution.
Capture/forwarding is implemented on the separate device. V1 remains text-only;
API 66 adds the V2 temporary file transfer described below. No task agent is started automatically.

No client is enabled by default. A deployment administrator provisions a
dedicated client; never give a capture device a deploy, runner or phone key.

## Consuming into Backlog

Backend API 65 adds a runner-bound consumer behind the `externalIntake`
experiment (off by default). An administrator binds a client once with internal
`intakeConsumer:bindConsumer`, passing `{ clientId, runnerId }`. Binding cannot
be silently changed to another runner. Revoke a client to stop intake/delivery;
turn off the experiment to stop the consumer while leaving HTTP intake available.

Before binding a production client, explicitly exclude known synthetic receipts
with internal `intakeConsumer:ignoreMessage`, passing `{ clientId, messageId }`.
An ignored receipt stays available to its sender but never becomes a draft.
Use a separate test client for later smoke tests rather than submitting synthetic
messages into an already-active production client.

With `"experiments": { "externalIntake": true }` in the owning runner's
runner.json, it polls every 15 seconds while online. It takes fenced 60-second
claims and atomically saves each message as a Backlog draft in the runner's
default folder, using normal default login/pool/model settings. Original text
is unchanged. Message source in Highlights links the original payload, sender,
timestamps and receipt provenance. The existing librarian may review drafts;
no task session, turn or worktree starts until the user sends one.

Draft delivery is recorded in separate fields on the backend row. Sender HTTP
receipts remain unchanged, avoiding incompatibility with nanobot's receipt
validation. Retries reconcile the same deterministic thread ID; edited, started,
archived and deleted drafts are never overwritten or recreated. Durable local
completion markers live in `<runner home>/intake-imports/`; retain them even if
you delete a task or clear runner trash. Corrupt markers stop that import rather
than causing a new task. A failed import stays pending and triggers a runner
warning; transient outages and restarts retry automatically.

The consumer does not infer task intent or filter private sources. The sender
must apply the agreed source rules before submitting: Telegram only on an
explicit task trigger, and all new messages in the agreed nanobot email inbox.
External content remains untrusted data. No remote access to the capture device
is required for consumer operation.

## Provisioning and rotation

Generate a bearer key locally as `tbi_` followed by 32 random bytes in lowercase
hex. Store it in a private file (directory 0700, file 0600). Hash the complete
key with SHA-256; provide only that lowercase hex hash to the internal function
`intake:provision` using the Convex dashboard or an authenticated admin CLI:

```json
{ "clientId": "nanobot", "keyHash": "<SHA-256 hex of the complete bearer key>" }
```

Choose the deployment explicitly: the repo's `.env.local` may be development
while your installed runner uses production. Find the runner's target in
`runner.json` under `sync.url`. HTTP requests use that URL's `.convex.site`
twin, preserving the region. For self-hosting, use the deployment's configured
HTTP actions origin instead of its query/mutation origin.

Reprovisioning the same client ID changes its credential while keeping receipts
and allowance. The previous key immediately stops working. Revoke with the
admin-only internal `intake:revoke`, passing `{ "clientId": "nanobot" }`.
Revocation retains messages and receipts. Neither function is callable by
capture devices. Send the credential privately to the capture device; keep it
out of chat, command arguments, source control and diagnostic logs.

## Sending and checking

POST JSON to `/intake/v1/messages` with `Content-Type: application/json` and
`Authorization: Bearer <key>`:

```json
{
  "messageId": "telegram:account:chat:42",
  "source": "telegram",
  "sourceMessageId": "chat:42",
  "text": "Original message text",
  "sentAt": "2026-11-07T20:00:00+02:00",
  "sender": "Emīls"
}
```

For email, use `source: "email"` and a source identifier stable within its
mailbox. The sender chooses a stable `messageId` within its client namespace
and must save and reuse it after restarts. Never generate a new ID on retries.
Original fields are preserved; unknown fields are ignored. Attachments and
forwarded-origin metadata are not supported yet and must be retained by the
capture adapter until they can be delivered.

First acceptance returns HTTP 201; an identical retry returns 200 with the same
JSON receipt: `{ receiptId, messageId, state: "received", receivedAt }`. The time
is epoch milliseconds. GET `/intake/v1/receipt?messageId=<URL-encoded ID>` with
the same authorization header returns that client's receipt, or 404.

Retry network failures, 5xx and 429 using the same saved message; honor
`Retry-After` on 429. A 401 needs credential repair. A 409 means that ID was
already accepted with different content; inspect the sender rather than retry
with a fresh ID. Invalid data (400), excess size (413) and wrong content type
(415) need correction. Exact limits are in
[the protocol](protocol.md#external-message-intake).

Messages and receipts are retained indefinitely in `intakeMessages`, separate
from the command queue. Original text is stored as submitted, without runner
secret scrubbing; choose what to submit accordingly. There is no public list,
edit, delete or task-start endpoint. Future consumers must treat source content
as external data and retain intake identity through Backlog creation.

## Attachments (API 66)

Use the same restricted credential with `/intake/v2/prepare`, `/upload`,
`/finalize`, `/status` and `/cancel`. The complete wire contract is in
[File intake](protocol.md#file-intake-backend-api-66); device implementation
instructions are in [Nanobot attachment handoff](nanobot-attachments-handoff.md).
No additional credential is needed and capture devices never receive a runner,
owner, deploy or storage administrator key.

Freeze the ordered file manifest and original bytes before prepare. Upload exact
8 MiB blocks (the last may be smaller), then finalize. Zero-byte files use no
blocks and still require the SHA-256 of empty bytes. There is no 25 MB file cap.
Names are metadata; storage IDs and local paths are chosen by Threadbear.
Attachment-only messages may have empty text. The 64 KiB JSON envelope and
48 KiB text limits still apply, including the manifest in the envelope budget.

Only finalized messages are consumed. The runner resumes verified blocks in
`threads/<id>/attachments/.transfer/`, assembles and hashes originals, then
publishes a complete dormant draft with local `AttachmentRef` values. The Mac
composer shows thumbnails and filename/size chips. Preview opens in the app;
Remove changes the draft selection and does not erase original bytes. Files also
appear in Highlights. On Send, supported images use provider image input and all
files are described to the agent by local path. No file is executed or archive
extracted during intake. Mobile/web attachment display is not implemented;
older clients preserve stored files when omitting the attachments argument.

`received` remains only a Convex receipt. V2 status separately reports
`localSaved` after durable local publication and `cloudDeleted` after retryable
cleanup. A sender must retain its local original spool until `localSaved`, even
if finalize succeeded. Cloud byte deletion retains receipt/manifest metadata,
so duplicate submissions never recreate a task or request a new upload. Local
files follow the thread into trash when it is deleted; normal backups are the
operator's responsibility after one-time cloud delivery.

Pending registered bytes have no age expiry, including while the Mac is asleep
or offline. This deliberately retains storage cost until delivery or explicit
cancellation. Cancel only applies before finalize. An unregistered blob left by
an interrupted HTTP action is swept after a day; it has no accepted message or
registered block. Cleanup of delivered/cancelled chunks is retried every 15
minutes. Do not enable any generic storage TTL that removes pending chunks.

A checksum mismatch is held locally with `<hash>.held.json` in `.transfer/`,
preventing repeated billable downloads. Investigate source bytes and the frozen
manifest first. A changed source needs a new explicit source/version identity;
never mutate an existing message ID. For a verified transient block problem,
remove that held marker to permit retry. Network and lease interruptions retry
automatically; credentials, cancellation and manifest conflicts require operator
attention. Never delete cloud bytes manually to fix a consumer error.
