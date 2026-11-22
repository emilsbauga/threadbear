# Runner protocol: Tools for agents

Part of the runner protocol. [docs/protocol.md](../protocol.md) has the rules for all of it and which file each section is in.

## Tools for agents

Every CLI the runner starts knows which thread it belongs to, two ways: the
`threadbear` MCP server for the agent itself, and environment variables for
the commands it runs (`tb`, the deploy script). Both name the same thread.

Every session, Claude or Codex, gets an MCP server called `threadbear`
(`runner/src/threadbear-mcp.ts`), bound to its own thread, so an agent can
drive Threadbear itself: `list_threads`, `read_thread`, `list_accounts`,
`create_thread`, `send_message`, `update_thread`, `move_thread`,
`interrupt_thread`, `delete_thread`, `schedule_message`,
`list_schedules`, `update_schedule` and `delete_schedule` (see Schedules),
and `list_projects`, `read_project`, `create_project`, `update_project`,
`join_project` and `leave_project` (see Projects), and `pin` and
`unpin` (see Highlights), `show_panel` (see Showing panels), and
`wait_for_app_restart` (see App restarts).
`list_accounts` shows each account's provider, note and room left, then
the pools with their logins and room, and which pool a new thread starts
on; `create_thread` and `move_thread` take Codex accounts, and
`create_thread` and `update_thread` take a `pool` (an id or title;
`update_thread`'s `null` or `"pin"` pins the thread to its login). They call the same runner methods as
the requests above, so once a restart has begun `create_thread` and
`send_message` get its "send again in a moment" too. Messages an agent sends
to another thread (or as a new thread's first message) start with a line
saying which thread sent them, `[Sent by the agent in the thread "<title>"
(<id8>)]` (on one line); the app draws such a message as a card from that
thread rather than as Mike's. The `then` a thread's agent gives
`move_thread` starts with `[Sent by the agent before moving to <folder>]`
instead, and the app draws it as a card from the thread's own agent. The
runner doesn't take either kind for Mike's: they leave reviews open and
don't stop a turn for a waiting login switch, and `read_thread` and the
handoff note label them as the agent's. `delete_thread` always asks for approval,
even in a thread with full access. Outside full access the tools that
change something or act elsewhere ask too (`pin`, `show_options` and
`show_panel` among them, as they can open a URL or a panel that runs
commands), and the ones that only read or end the turn
(`NEVER_ASK_TOOLS`: `end_turn`, the list and read tools, `unpin`,
`ask_secret`) never do, in any mode. No tool can delete, interrupt, snooze
or archive the thread that's calling it; `tb` inside a thread refuses the
same.

Raising access. From a thread whose mode isn't `full`, a call that would let
something run with more access than the caller has puts up its own
`approval.requested` (options `["allow", "deny"]`, the title saying what it
would do) and waits for it, whatever the CLI's rules or Auto's classifier
said about the tool: `update_thread` or `update_schedule` setting a mode
above the target's (`ask` < `auto` < `full`), `create_thread` or a
`new_thread` `schedule_message` with a mode above the caller's,
`send_message`, `move_thread`, `schedule_message` or `update_thread`'s
`title` to a thread with more access than the caller (a title reaches its
agent and others', as in list_threads; `tb` refuses the
same rename), `join_project` putting such a thread in a project,
`update_project` changing the title, goals, state, notes or folders of a
project such a thread is in (by the project's list or the thread's own), `move_thread` of a thread a schedule's check runs for
(the check runs in its folder), `update_schedule` changing the text, title, time,
folder or paused state of a schedule whose runs are above the caller or that
has a check, and any `check`. A project-update approval names the current
project as `{ title, id }` in its input, separately from any proposed new
`title`. A thread's access there is the most its agent
has now (`Runner.accessOf`): its mode, or more while a turn that had more is
still running, as a Codex turn keeps the mode it started with. Setting the
mode a thread or schedule already has is left out of the write, so it can't
raise it back if it lands after the mode was lowered. Without a `permissionMode`, a thread such a
caller starts or schedules gets the caller's mode, not `full`. A folder on a card is where it
really leads, links followed, and that's the folder used; one that leads
elsewhere by the time Mike answers is refused (full access callers keep
the path as written). `join_project`'s card shows the project's whole
brief (title, folders, goals, state, notes, Notion board and its cards, links), and one
that changed while the card was up is refused; `update_project` asks for
the Notion board and links too. A project with a folder that's a link can't
be joined to such a thread this way at all, as the link can be pointed
elsewhere after the card; Mike can do it himself. A message's sender line is
on its card, one line, and goes as shown. A card shows every argument of the call whole, never a
first part of one: a string longer than an event takes (16 KB) is refused
with no card. Denied or
expired, nothing changes and the tool says so; a message from Mike declines
it. Lowering a mode never asks, except another thread's that has more access than the caller (it would let its schedules be deleted), and a `full` thread is never asked. There's no tool for restarting the runner: that's `runner.restart`.

Other runners' threads, as the Mac's sidebar has them (`remoteThreads.list`),
reach the tools through the relay (see "Other runners' threads through the
backend"), so only on the owner key: `list_threads` lists and searches them
with this runner's (the same lists and the same word match on title and
preview), each row's flags ending `on <runner name>`; `read_thread` reads
one's messages from `threads.events` in relay seqs (its settings say the
runner, and tool output stays there; like the app's view, it still has
messages an edit there took out, as `thread.rewound` isn't mirrored);
`send_message` sends with `threads.send`, and says the message is queued
rather than sent when that runner hasn't taken it (`queued`). A thread id or prefix is looked for in both, and one that
fits threads in both is refused like any other. `interrupt_thread` stops
one with `threads.interrupt`, and `update_thread` snoozes, wakes,
archives or unarchives one with `threads.update` (an archive with
`archivedBy: "agent"`, below); its title, model, pool and mode stay with
that runner, which alone knows whether Mike named it, and snoozing until
the next release isn't asked of it. `move_thread` and `delete_thread`
say it's on that runner rather than that it's missing. A
runner that isn't watching the list (no app connected lately) starts the
watch and waits up to 3 seconds for its answer, rows and all (a refusal or
an error ends the wait); one that runs out isn't waited for again for a
minute. A draining runner has stopped its sync, so its kept turns ask the
primary instead: `remoteThreads.list` with `forTools: true` over its link
for the list (the primary answers as for its own tools, the wait
included), and the other calls passed on to the primary, whose relay
takes them as it does the Mac app's. With sync off, a runner key or the backend failing, they see this
runner's threads only.

| Variable | Value |
|---|---|
| `THREADBEAR_THREAD_ID` | the id of the thread the CLI belongs to |
| `THREADBEAR_HOME` | the runner's data dir, where `tb` looks for a runner (agents may point it at a dev runner) |
| `THREADBEAR_RUNNER_HOME` | the runner's data dir too, which agents never change: the scripts' guards against restarting the runner a thread runs on go by it |
| `THREADBEAR_RUNNER_VERSION` | the runner's version, as in `hello` |
| `THREADBEAR_MEDIA_DIR` | the thread's media folder (`<data dir>/threads/<id>/media`): the only place a shared page's pictures come from (see "Sharing") |
| `THREADBEAR_NODE` | the Node binary the runner runs on, so the repo's scripts a thread runs (`check.sh`, `tb land`, `deploy-runner.sh`, a worktree's setup) use the same one (`runner/scripts/find-node.sh`) |

The runner also puts its own `bin/` (the release's, or the checkout's for a
runner run from source) at the front of `PATH`, so a bare `tb` in a thread
is the `tb` that matches the runner.
