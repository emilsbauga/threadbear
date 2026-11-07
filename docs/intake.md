# External message intake

This first delivery step accepts email and Telegram text and returns durable
receipts. It does not yet forward from nanobot, create Backlog drafts, process
attachments or run models. `received` means stored in Convex, not on a runner.

No client is enabled by default. A deployment administrator provisions a
dedicated client; never give a capture device a deploy, runner or phone key.

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
