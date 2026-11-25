---
id: archive
name: Agent Archive
title: Agent Archive: the runner lists which agent session is which thread for Agent Archive, watches its sync, and keeps the sync up to date
added: 2026-11-20
on: false
reminder: 1a56bc60
---

## What it does

For people running Agent Archive, Mike's archive of every agent conversation, which isn't public yet: without it installed, this only keeps a list. Every ten minutes the runner writes `archive-sessions.json` in its data folder, saying which Claude or Codex session belongs to which Threadbear thread, with the thread's title, project and folder, and where each of your Claude and Codex logins keeps its sessions, so a login you add is archived too. Agent Archive's sync reads that list and sends it to the archive with its own credentials, so search results and the archive's reader can open the thread in Threadbear. The runner also reads the sync's state for `tb status` and says when it has stopped, and asks the archive server it syncs to how it is (`/api/health`): whether it answers, and any failed deploy or backup or low disk. On the server's own machine, a server that has stopped and that launchd hasn't started again is started. When runner.json's `archive.repo` names the archive's git repo, the runner builds the sync from its main whenever main moves and installs it with the archive's own installer, then on the machines in `archive.pushTo` over ssh. A machine running the archive server leaves that to the server's own deployer. With Agent Archive installed, the app's thread search also searches the archive, after your threads: every word said anywhere in a session, sessions run outside Threadbear, and every machine that syncs to it. A result opens read-only in the thread's place, with New thread from this to pick it back up. Every thread's agent gets the archive's own tools, even on a login whose config doesn't list them. The sync stays a background service of its own, so the runner restarting never stops it mid-upload. The plan for the rest is in docs/agent-archive-plan.md.

## Lives in

`runner/src/agent-archive.ts` (the list, the status and the updates; `formatArchive` is tb status's line; `archive.search` and `archive.read`; `archiveMcpServer`); started in `main.ts` beside the email watcher, with `archive` in `runner.status`, and its MCP server added to Claude's `mcpServersFor` and Codex's `mcpServers`; the app's side in `desktop/` (the sidebar search's Agent Archive section and the read-only view); `ArchiveStatus` in `restart.ts`; runner.json's `archive` in `config.ts`

## Taking it out

Delete `agent-archive.ts` and its test, its lines in `main.ts`, `restart.ts`, `tb-dev.ts`, `config.ts` and the Codex adapter's `mcpServers`, the app's archive search and read-only view in `desktop/`, and `archive-sessions.json` and `agent-archive-update.json` from the data folder. Agent Archive's own sync carries on as it was, without thread names.
