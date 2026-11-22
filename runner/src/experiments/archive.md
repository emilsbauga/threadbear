---
id: archive
name: Agent Archive
title: Agent Archive: the runner lists which agent session is which thread for Agent Archive, watches its sync, and keeps the sync up to date
added: 2026-11-20
on: false
reminder: 1a56bc60
---

## What it does

For people running Agent Archive, Mike's archive of every agent conversation, which isn't public yet: without it installed, this only keeps a list. Every ten minutes the runner writes `archive-sessions.json` in its data folder, saying which Claude or Codex session belongs to which Threadbear thread, with the thread's title, project and folder, and where each of your Claude and Codex logins keeps its sessions, so a login you add is archived too. Agent Archive's sync reads that list and sends it to the archive with its own credentials, so search results and the archive's reader can open the thread in Threadbear. The runner also reads the sync's state for `tb status` and says when it has stopped. When runner.json's `archive.repo` names the archive's git repo, the runner builds the sync from its main whenever main moves and installs it with the archive's own installer, then on the machines in `archive.pushTo` over ssh. A machine running the archive server leaves that to the server's own deployer. The sync stays a background service of its own, so the runner restarting never stops it mid-upload. The plan for the rest is in docs/agent-archive-plan.md.

## Lives in

`runner/src/agent-archive.ts` (the list, the status and the updates; `formatArchive` is tb status's line); started in `main.ts` beside the email watcher, with `archive` in `runner.status`; `ArchiveStatus` in `restart.ts`; runner.json's `archive` in `config.ts`

## Taking it out

Self-contained: delete `agent-archive.ts` and its test, its lines in `main.ts`, `restart.ts`, `tb-dev.ts` and `config.ts`, and `archive-sessions.json` and `agent-archive-update.json` from the data folder. Agent Archive's own sync carries on as it was, without thread names.
