---
id: warmStart
name: Warm start
title: Warm start: a new thread's agent starts while you write its first message
added: 2026-11-20
on: false
reminder: 4405eba9
---

## What it does

When you open a new thread (⌘N or the new-thread button), the runner starts its Claude Code straight away, while you write, instead of after you press Send. Claude Code takes about half a second to start, so the first reply of every new thread comes that much sooner. If you change the folder, login, model, effort or mode before sending, it starts another to match; if you quit the app or don't send within ten minutes, it stops. Until you send, it holds the memory of one more Claude Code (about 150 MB) but makes no requests. Claude threads only, in a folder as it is: one that gets a worktree, or a thread started in a project, starts as before.

## Lives in

`runner/src/runner/warm-start.ts` (with `threads.warm` in `runner/src/rpc.ts`, `sessionOptions` and the `takeSpare` call in `startSession` in `runner/src/runner.ts`, and `draftRecord` and the `warmId` in `runner/src/runner/new-threads.ts`); in the app, `warm_new_thread` in `desktop/gpui/src/new_thread.rs`

## Taking it out

Delete `warm-start.ts`, the `threads.warm` case and the `dropSpare` call on a closing connection in `rpc.ts` and `rpc-gate.ts`, the `takeSpare` call in `startSession` (keep `sessionOptions`), the `warmId` handling in `create`, the `dropSpare` calls in `shutdown` and `handovers.ts`, and the app's `warm_new_thread` and the `warmId` it sends.
