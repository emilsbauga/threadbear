---
id: loadEndTurn
name: End turn up front
title: Claude threads get end_turn ready, without looking it up first
added: 2026-11-21
on: false
reminder: 0d391cfe
---

## What it does

Claude Code keeps MCP tools out of a session until the agent looks them up with its tool search, so a fresh Claude thread spent its first step just loading end_turn, sending the whole conversation again to do it. With this on, end_turn is part of every request from the start, so that step goes. A "hello" in a new thread takes 2 requests instead of 3 (about a third fewer tokens, and the first reply arrives one round trip sooner). The other Threadbear tools still load when they're needed. Claude only: Codex lists every tool anyway.

## Lives in

`loaded` in `endTurn` in `runner/src/threadbear-mcp.ts` (the `loadEndTurn` option), switched by `runner/src/main.ts` where it builds the threadbear server

## Taking it out

Delete `loaded` and the `loadEndTurn` option in `threadbear-mcp.ts`, the extra argument to `threadbearMcpServer` in `main.ts`, and this file.
