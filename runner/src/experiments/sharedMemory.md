---
id: sharedMemory
name: Shared memory
title: Shared memory: the main Mac's global CLAUDE.md and memory folders reach every runner
added: 2026-11-17
on: false
reminder: 8a7b5dff
---

## What it does

A thread on your main Mac knows you mostly from what Claude Code loads before your first message: your global `CLAUDE.md`, and the memory folder of the project it's in (`MEMORY.md` and the notes agents save as they learn things). Without this, those stay on the main Mac, so a thread on another runner starts knowing nothing about you. With it on, the main Mac puts them up to your backend every minute, and each other runner copies them into its own Claude logins (and the global file into Codex's `AGENTS.md`), under its own home folder: `~/dev/me/misc`'s memory on the main Mac becomes `~/dev/me/misc`'s on the other runner too. Only folders under your home folder go, not `~/Library`. A file that was on the other runner before sync wrote it is left alone. When an agent on another runner saves a memory, or changes one the main Mac sent, it's sent back as an offer, not written into the main Mac's memory (its own edit stays there until the main Mac has a newer version): offers land in `memory-offers/<runner>/` in the main Mac's data dir, for you or a scheduled job to fold in or drop. Another runner's key can't change what the main Mac's agents read. Secret values the runner knows of are masked before anything goes up. Turn it on on every runner (`"experiments": { "sharedMemory": true }` in runner.json): the main Mac to put its files up, the others to take them.

## Lives in

`runner/src/memory-sync.ts` (scanning, writing down, offers, the minute timer), `memoryBackend` and the attach in `runner/src/sync.ts`'s heartbeat, its construction in `runner/src/main.ts`. In the backend: `convex/memorySync.ts`, the `memoryFiles`, `memoryOffers` and `memoryOfferCounts` tables in `convex/schema.ts`, and `putMemory`, `memorySince`, `offerMemory`, `memoryOffers` and `takeMemoryOffers` in `convex/sync.ts` (API 84). The runner keeps `memory-sync.json` and `memory-cache/` in its data dir.

## Taking it out

Delete `runner/src/memory-sync.ts` and its test, `memory` in `ConvexSync`'s deps, `memoryBackend` and its attach line in `runner/src/sync.ts`, and `memorySync` in `runner/src/main.ts`. In the backend, delete `convex/memorySync.ts`, the five functions in `convex/sync.ts` and their rows in `ACCESS` (`convex/runnerAccess.ts`) and in docs/protocol.md's table, then the three tables once they're empty. Files sync wrote on other runners stay where they are.
