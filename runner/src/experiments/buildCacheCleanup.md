---
id: buildCacheCleanup
name: Build cache cleanup
title: Build cache cleanup: clears stale desktop, worktree and iPhone build caches before disks fill up
added: 2026-11-26
on: false
reminder: b79db352
---

## What it does

Threadbear clears its own stale build caches so a full disk doesn't break saves, checks or runner updates. In thread worktrees it removes git-ignored Cargo build folders (`desktop/target` and any other Cargo `CACHEDIR.TAG` folder not in the worktree's `keep` list): right away in spare and kept-archived worktrees, and in open threads once idle for two days. In `~/Library/Caches/Threadbear` it clears `update-desktop/target`, `update/build`, `check-desktop-target` and non-App-Store subfolders of `ios-builds`, and in `~/.cache/threadbear-check/local-builds` it clears `check.sh`'s `shared-*` folders, once unused for a week. Sweeps run hourly; when free space drops below 10 GiB (checked every ten minutes and before every runner update build), it clears everything not in use, including open worktrees idle for two hours, until 20 GiB is free. Nothing is touched while a build lock, a live process cwd or a write within the last 30 minutes is present, and it never touches the main checkout, borrowed worktrees or user files.

## Lives in

`runner/src/build-cache-cleanup.ts`, started in `runner/src/main.ts` alongside the borrow sweep and called before each update build via `beforeBuild` in `runner/src/update.ts`.

## Taking it out

Delete `runner/src/build-cache-cleanup.ts`, `runner/test/unit/build-cache-cleanup.test.ts` and this file, remove the `BuildCacheCleaner` wiring in `runner/src/main.ts` and `beforeBuild` in `runner/src/update.ts`, and run `npm run experiment-docs`.
