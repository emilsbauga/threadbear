---
id: virtualRunners
name: Virtual runners
title: Virtual runners: threads on a cloud box of their own, picked in Runs on
added: 2026-11-19
on: false
reminder: 00000000
---

## What it does

Runs on in the new-thread box lists your virtual runners after your Macs, for example Cloud (Fly): a thread started there gets a box of its own in the cloud, which clones the folder's repo and runs Claude Code there, sleeps when the thread's idle and wakes for its next message. The first time a thread runs on one with a Claude login that has no cloud token, the thread shows a card: Make one runs `claude setup-token` for that login and opens claude.ai to approve it, or paste one, or use that login's year-long token from this Mac. The message waits and goes once the token's set, and the card comes back if Claude ever refuses the token. A virtual runner has to be set up in your Convex backend first (docs/virtual-runners.md).

## Lives in

`runner/src/virtual-runners.ts` and `cloud-token-helper.py` (starting a thread on one, and cloud tokens), `virtualRunners` in `runner/src/main.ts` and `runner/src/sync.ts` (`virtualRunnersReady`), `watchServices` in `runner/src/thread-index.ts`; in the GPUI app, the Runs on entries, the rows' box states and the token card; the backend's `convex/boxes.ts`, `boxService.ts`, `boxMachine.ts` and `cloudTokenMachine.ts`, and box mode (`runner/src/box-mode.ts`).

## Taking it out

Delete `virtual-runners.ts`, `cloud-token-helper.py`, the `cloudTokens.*` methods and `virtualStart` in `main.ts`, `watchServices` and `services` in `thread-index.ts`, and the app's Runs on entries and token card. The backend's boxes can stay: with no virtual runner made, nothing runs.
