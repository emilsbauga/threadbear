---
id: coordinators
name: Project coordinators
title: Talk to a project while its coordinator keeps its work and notes current
added: 2026-11-25
on: false
reminder: 0a6f42cb
---

## What it does

A project can have a coordinator, using the normal pool and model selection. Its project home has Conversation, Activity, To-dos and Threads tabs, with the shared project goals, state and notes as a living document in Highlights. The coordinator keeps those records current and delegates routine work to built-in helpers, which stay out of the inbox. Helpers bring questions to the coordinator; it answers from your instructions or asks you once. A thread can start a project's coordinator for you too (create_project or update_project with `coordinator`), handing it a charter, to-dos and where things stand. Pause stops the coordinator and its helpers. There are no coordinator spending controls or cost estimates.

Coordinators run on their owning runner using any supported provider and model, and can switch models at will. Routine work runs in hidden runner-managed helper sessions kept out of the inbox and shown in Activity. Work records survive compaction and runner restart: a helper an update or a crash cuts off carries on by itself, told to check what is already done, and its coordinator only hears when it finishes. The full project home is a desktop experiment; other clients can still read and answer the underlying conversation.

## Lives in

`runner/src/coordinators.ts` (registry, hidden helper lifecycle, event batching, timers and RPC), the shared coordinator policy in `runner/src/coordinator-policy.ts` and adapter boundaries (`claude/`, `codex/`, `acp/`, `tool-gate.ts`), session/summary integration in `runner.ts`, the coordinator tool in `threadbear-mcp.ts`, the thread-key restriction in `rpc-gate.ts`, and the project home and sidebar in `desktop/`. The shared project fields remain in `projects.json`; coordinator execution records are in `coordinators.json`. The contract is docs/protocol/projects.md, "Project coordinators".

## Taking it out

Pause the coordinators first. Remove the coordinator module, boundary, session/RPC/MCP wiring and desktop views, then this experiment file. Keep the ordinary conversations and the shared project goals, state and notes. The registry can be exported or retained as history; never remove its permission boundary while a coordinator CLI or helper is still running.
