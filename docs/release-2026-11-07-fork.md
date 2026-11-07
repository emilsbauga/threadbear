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

## Validation

- Full `./check.sh --all` passed: runner typecheck and unit suite, deployment
  tests, Mac build and tests, web and Convex typechecks, web tests, BearDock
  tests and iPhone shared-code tests. A complete Node/npm toolchain was used.
- After the final Pi mode-transition guard, runner typecheck and 20 focused
  Pi account/adapter/approval tests passed. They use fixtures, no paid model.
- The real dev-runner first-run tour passed; all 16 screenshots were reviewed.
- Debug-app visual checks confirmed the combined panel, multiword title
  search, inline dollar-skill insertion, and visible Return behaviour.
- Debug Backlog and Archived rows both show trash icons and right-click
  Delete entries. Only synthetic drafts were created; no real chat deleted.
- Shared standing instructions reach Pi session startup in regression tests.
- The signed release and latest local Backlog librarian commit are both
  ancestors of the prepared branch. Main and live settings are unchanged.

The original local skills popup is superseded by the combined panel; its
search and insertion behaviour stays. Pi shared-tool handling receives
upstream cancellation/read-only fixes. The guarded asynchronous project
picker stays, with the new busy feedback. No local feature was discarded.

Review this branch before landing. Do not deploy or apply the settings above
until landing is approved. App Store iPhone installation is outside this
preparation; the shared-code tests are not a signed phone build.
