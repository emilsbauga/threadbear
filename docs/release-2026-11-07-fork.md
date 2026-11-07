# Release 2026-11-07 integration

Prepared in thread be593907 for review before landing. The release must keep
its original commit IDs through a merge. No live deployment or settings
change is authorized until the user approves landing.

## Agreed behaviour

- One combined command/skills panel. Keep multiword skill-title search,
  title ranking and Codex `$` mentions within messages. Choosing a skill
  inserts it without sending; commands may run directly.
- Backlog remains separate. Inbox may show clear while saved drafts remain.
  Keep draft autosave, images, librarian context in Highlights and advisory
  context on a matching first send.
- Pi exposes only supported controls. Keep isolated OpenRouter and Local
  pools, models and compact tools. Unsupported Plan first and sandboxed
  sessions are refused. Preserve shared-tool approval and cancellation fixes.
- Keep evolving titles and the asynchronous guarded project picker.
- Keep BrowserBear isolated from the personal browser.

## Settings to apply only after landing approval

Merge these fields into runner.json without replacing other settings:

```json
{
  "experiments": {
    "standingInstructions": true,
    "looseEnds": true,
    "replyButtons": true,
    "scheduleChecks": true,
    "richBlocks": true,
    "labReview": false,
    "voiceMode": false,
    "keepAwake": false
  },
  "sync": { "full": false }
}
```

Keep existing instruction files; move no content into the Instructions box
automatically. Existing schedules get no check unless explicitly configured.
Voice controls, engine downloads and microphone prompts remain disabled.

## Backend compatibility

This fork used API 49 for Backlog, while upstream used 49 for wake notes.
The merged backend is API 61, and the new runner only sends Backlog fields
to 61 or newer. Upgrade the backend before the runner for remote Backlog
visibility. Local saved drafts remain intact while the backend is older.

## Deletion

Backlog and Archived rows gain a trash icon and a right-click Delete action.
Both require confirmation and use existing runner deletion semantics: remove
the thread from the app and move its stored folder to the runner trash.
There is no in-app Undo. This is not a secure erase of files on disk.
