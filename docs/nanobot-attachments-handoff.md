# Nanobot attachment implementation handoff

This is the device-side work after Threadbear's API 63 and attachment-aware
runner are live. Read `docs/intake.md` and the File intake section of
`docs/protocol.md` before implementation. This document contains no secrets.
Do not change capture rules or enable/restart the gateway merely to test files.
Consult Emīls when a source adapter, credential, missing detail or permission
requires a decision. Never ask him to paste a secret into a conversation.

## Goal and existing behavior

Deliver selected original email/Telegram content and files to the existing
Threadbear Backlog. One finalized message becomes one dormant draft containing
its original text and all declared files. No task runs before Emīls presses
Send. Threadbear owns the downloaded originals on its computer. Convex is a
temporary transfer buffer, not a permanent media library.

Preserve the existing stable message identities, durable SQLite outbox, frozen
payloads, leases, retry/backoff and source provenance. Use deterministic capture,
not a model deciding whether or remembering to forward. No historical backfill.

- Telegram: Emīls's private chat only. A forward alone remains nanobot context.
  Create a task only with an explicit `/tb` trigger, including `/tb` replying
  to the selected message. Resolve files from that selected message/album,
  not arbitrary surrounding messages. Preserve caption/text and attribution.
- Email: every new message in `robby@plepo.com` INBOX becomes a task. No subject
  tag. Include `Subject: …\n\n<body>` and its original attachments.
- Preserve the raw event's sent time/source identity before normalization.
  Do not guess missing timestamps or drop files while sending the text.
- Preserve original bytes, filenames, MIME type, ordering and association.
  Handle documents, images, audio/video and attachment-only messages. Do not
  transcode, extract archives or silently substitute thumbnails for originals.
  Check source-adapter download limits; hold an unavailable original locally
  with a clear reason and consult Emīls about access rather than truncating it.
  Agree with him how email inline signature/tracking images are distinguished
  from meaningful inline content before activating that new selection behavior.

## Credentials and endpoints

Read the existing private credential file inside the process:
`/home/robby/.nanobot/secrets/threadbear-intake.json` (0600; parent 0700).
Use its configured origin; the current deployment is
`https://useful-porcupine-951.eu-west-1.convex.site`.
Use `Authorization: Bearer <existing tbi_… key>` on every request. No new key is
needed. Do not print it, put it in shell arguments, pass it to a model, follow
redirects with it, or request a deploy/owner/runner key. This credential can
only submit and inspect its own intake receipts/transfers.

## Wire contract

All JSON requests use `Content-Type: application/json`, with at most 64 KiB
UTF-8 for the entire envelope; message text is at most 48 KiB. Binary uploads
use `application/octet-stream`. There is no 25 MB file limit. The 8 MiB size
is a transport block, allowing bounded-memory transfer of larger files.

1. Download selected originals into a private durable local spool first.
   Freeze message fields and an ordered manifest. Each file has a stable
   message-local `id`, display `name`, MIME `mediaType`, safe integer byte
   `size` and full-file lowercase SHA-256 `sha256`. Never use a temporary file
   path or a newly generated random ID on each attempt. Persist spool and
   queue references before acknowledging source capture.
2. `POST /intake/v2/prepare` with the following envelope:

   ```json
   {
     "message": {
       "messageId": "<same stable source message ID on every retry>",
       "source": "email",
       "sourceMessageId": "<original source ID>",
       "text": "Subject: Example\n\nOriginal body",
       "sentAt": "2026-11-08T09:00:00Z",
       "sender": "<optional original sender>"
     },
     "attachments": [
       {"id":"part-1","name":"Original.pdf","mediaType":"application/pdf","size":35000000,"sha256":"<64 lowercase hex characters>"}
     ]
   }
   ```

   First prepare returns 201; identical prepare returns 200. Response contains
   `transferId`, `state`, `chunkSize: 8388608`, delivery flags and per-file
   `blocks`/`uploaded` counts. Changed frozen content under the same message ID
   returns 409. Text may be empty when at least one file is declared.
3. Stream each original in exact blocks of `chunkSize` bytes. For zero-based
   `index`, POST raw bytes to
   `/intake/v2/upload?messageId=…&attachmentId=…&index=N`, encoding query values.
   Last block must equal the remaining byte count. First block acceptance is
   201; an identical retry is 200 with the same block SHA-256. Validate that
   response against your local block. A changed block is 409. Persist each
   accepted block in the outbox; receipt loss retries the same index and bytes.
   Uploads may be repeated safely. `uploaded` is a count, not a contiguous
   offset: never infer which blocks exist from that count. Local progress
   provides the resume index; replay unchanged blocks if local progress is lost.
   Empty files upload zero blocks and declare the SHA-256 of empty bytes.
4. Only after all files' blocks are accepted, POST
   `/intake/v2/finalize` with `{"messageId":"…"}`. First success is 201;
   identical retry is 200. Validate and save the unchanged four-field receipt:
   `receiptId`, `messageId`, `state: "received"`, `receivedAt`.
   Until finalize succeeds, Threadbear cannot consume the message.
5. Reconcile receipt loss with the existing
   `GET /intake/v1/receipt?messageId=…`. Inspect transfer progress separately
   with `GET /intake/v2/status?messageId=…`. Status includes the finalized
   `receipt`, `localSaved` and `cloudDeleted`; each file retains its manifest.
   `received` alone never means a task exists or files are locally saved.
6. Continue low-frequency status checks with persisted backoff until
   `localSaved: true`. Only then release the device's spool bytes. The runner
   has verified and durably published all files with the local draft, or
   recovered that already-published result. Cloud deletion follows separately
   and retries automatically. Keep compact outbox provenance/receipt metadata
   for deduplication after clearing bytes. Never remove the original source
   email or Telegram message as part of spool cleanup.

Text-only messages may continue using V1 unchanged. Do not send a V1 text-only
fallback for a V2 message with missing files. An existing V1 ID cannot be
upgraded to attachments; report that case rather than inventing another task.

## Reliability and retained states

- Same source event always reuses the same message ID, ordered file IDs,
  manifest, bytes and receipt. Do not regenerate identities after restart.
- Preserve existing bounded connect/read timeouts, TLS verification, no
  redirects, bounded concurrency and exponential backoff with jitter.
  Retry network/5xx and 429 (`Retry-After`); pause on 401 until credential
  repair. Hold 400/409/413/415 for investigation. Keep original spool bytes.
- A Mac asleep/offline does not expire registered pending files. Do not
  reupload a finalized transfer merely because `localSaved` is still false.
  Status polling should become infrequent while waiting; do not loop rapidly.
- `POST /intake/v2/cancel` with `{"messageId":"…"}` is available only before
  finalize. Use it only for an explicit abandoned-upload decision. Wait for
  `cloudDeleted` before re-preparing that same immutable transfer. Finalized
  pending delivery cannot be cancelled by this client.
- A checksum error on Threadbear holds the local transfer rather than repeatedly
  downloading billable data. Report source manifest/byte discrepancies to Emīls;
  do not change frozen bytes under the existing message ID to repair them.
- Do not add a device size cutoff silently. If disk space, source access or
  maximum JSON metadata makes a message impossible to transfer, retain it
  visibly for Emīls to decide. Do not omit individual files and send the rest.

## Implementation and activation sequence

1. Review the existing code and this contract; summarize the proposed outbox
   migration and raw-source capture changes before touching gateway behavior.
2. Extend the SQLite outbox for frozen file manifests, private spool paths,
   per-block progress and the separate states uploading, received and locally
   delivered. Preserve text-only queue compatibility and existing receipts.
3. Add source-specific original download handling below normalization. Preserve
   email MIME part identity and Telegram selected-message/album association.
   Ask Emīls about any unresolved source-selection or access question.
4. Implement V2 prepare/upload/finalize/status/cancel in the deterministic
   worker. Keep credential access in process and use bounded memory/disk I/O.
5. Test against a local fake server first: restart at every boundary,
   timeout-after-acceptance, duplicate/out-of-order blocks, changed manifest,
   revoked key, full disk, corrupt original, interrupted source download,
   multi-file/empty-file/attachment-only messages and files above 25 MB.
6. Ask Emīls to confirm the Threadbear API63/runner rollout is complete. Run a
   standalone synthetic V2 smoke without enabling real-source capture: small
   image + document + file above 25 MB, no real private source content. Expect
   one dormant draft with locally verified originals; confirm `localSaved`,
   cloud cleanup and immutable receipt on retry. Coordinate deletion of that
   synthetic draft with Emīls; do not start its task agent.
7. Report changed files, test results, spool/delivery state and any remaining
   source/startup/permission decisions. Only then activate the approved
   capture rules and startup services under Emīls's instructions. Do not
   silently change the gateway, its restart policy or systemd/linger setup.
