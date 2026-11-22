# Projects

Mike, 2026-10-27: a project is a grouping above folders. It can span
several folders or repos, a thread can be in more than one, and it keeps
a lasting sense of its goals, what's known and where things are up to.
Nobody should have to make them by hand: a cheap background job and the
agents themselves create and update them. And a project is the unit of
patching: the patches a thread loads come from every folder of every
project it's in, so switching threads switches the UI.

This replaces the line in `threadbear-design/README.md` that said
"multiple projects isn't a thread concept". It is now.

## What a project is

```ts
type Project = {
  id: string            // "p_threadbear"
  title: string         // "Threadbear"
  folders: string[]     // ["~/dev/me/threadbear", "~/dev/me/threadbear-notes"]
  goals: string         // a few lines: what it's for, what done looks like
  state: string         // a few lines: where it's up to, what's next, what's blocked
  notes: string         // longer markdown: decisions, gotchas, commands, links
  createdBy: "mike" | "agent" | "librarian"
  createdAt: string
  updatedAt: string
  archived?: boolean
}

// On ThreadSummary
projects?: {
  id: string
  title: string
  by: "mike" | "agent" | "librarian" // who put the thread there
  pinned?: boolean      // Mike put it there or said "yes": the librarian won't move it
}[]
```

Stored by the runner, not in a repo, since a project spans repos:
`<data>/projects/<id>/project.json` and `notes.md`. It's live shared
state, so it goes to Convex with the thread summaries in main plan step 5.
A folder can be in several projects (`~/dev/me/misc` is in lots), which
is why membership is per thread and not worked out from the folder alone.

## Who makes and keeps them

**The librarian**, a background job in the runner on the existing small
model layer (`models/`, Haiku on the Claude pool or through OpenRouter, the daily budget and
private folders already there). It runs:

- after a thread's first turn ends,
- after a turn that edited files in a folder none of its projects has,
- after a thread moves folder,
- and otherwise at most once an hour per busy thread, to refresh `state`.

It's given the project list (titles, folders, goals, one line of state),
and for the thread: its title, folder, the first message, the last few
messages, the folders of the files it edited, and the repos its shell
commands ran in (`cd`, `pushd`, `git -C`), since a thread in a catch-all
folder often works on a repo with nothing but Bash. It answers with which
projects the thread belongs to, a new project if none fits, and a short
`state` update when the thread moved things on. Most of the signal is
cheap and doesn't need the model at all: a thread that edits files in
`~/dev/me/threadbear` from a thread in `~/dev/me/misc` is almost
certainly about Threadbear. A call is a few thousand tokens in, so well
under a cent; with the daily budget spent it just stops until tomorrow.

**The agents**, through the `threadbear` MCP server every session gets:

- `list_projects`, `read_project` (goals, state, notes, folders, threads)
- `update_project` (goals, state, notes; append a note)
- `create_project`, `add_thread_to_project`, `remove_thread_from_project`,
  `add_folder_to_project`

An agent that's told "this is part of the Poddle work" puts itself there
and pins it. Agents are the better writers of `notes`, since they know
what they just learned; the librarian mostly does membership and state.

**Mike** can rename, merge, archive, move a thread in or out (which pins
it) and edit any field, in the project page. He never has to.

## What a thread gets from its projects

1. **Patches.** Today a thread loads patches by walking up from its own
   folder, plus `~/.threadbear/patches/`. With projects it also loads
   them from every folder of every project it's in, deduplicated, in the
   order: home, each project's folders, then the thread's own folder
   chain (closest wins a clash, as now). Each patch keeps the folder it
   came from, and that's where its action or hook runs, not the thread's
   folder. A hook's `edited` glob is matched against edits inside its own
   folder only, so a typecheck hook from repo B doesn't fire after a turn
   that only touched repo A. The Patches tab groups them by project, so
   it's clear why a chip is there.

   The ids get the folder's name in front when two folders have a patch
   of the same name (`threadbear:checks`, `poddle:checks`).

2. **A short brief in context.** When a session starts, the project's
   title, goals and state (a few hundred words at most, all projects
   together) go in as appended system prompt text, with a line saying
   `read_project` has the notes. When the librarian moves a thread into
   a new project mid-session, the next turn gets a one-line runner note
   saying so.

3. **The UI.** Switching to a thread switches the panels, chips and
   Patches tab to its projects'. Nothing else changes yet; when patches
   can add more than panels, actions, hooks and tools, it all comes in
   through the same door.

## In the app

- The activity bar gets a Projects view: one section per project, its
  threads under it (a thread in two projects shows in both), newest
  first; threads in no project at the bottom. The folder view stays.
- A project page (click the section header): title, goals, state and
  notes, editable; its folders; its threads; its patches and where each
  came from.
- The thread header shows its projects as small chips; click to open
  the project, right-click to remove the thread or pin it.
- A thread the librarian has just put in a project shows that once in
  the transcript as a `system.note` ("Put in Threadbear"), so a wrong
  guess is noticed and one click undoes it.

## Protocol

- `ThreadSummary.projects` as above.
- `projects.list`, `projects.get`, `projects.create`, `projects.update`,
  `projects.archive`, `projects.merge`, `threads.setProjects`.
- `projects.updated` and `librarian.updated` notifications.
- `PatchInfo` gains `folder` and `projectId`.

## Build order

1. Store, protocol and agent tools: projects exist, agents can make and
   update them, the summary carries them. `tb projects`.
2. Patches from projects: load from project folders, run each patch in
   its own folder, hooks scoped to their folder. The bit that makes the
   UI follow the thread.
3. The librarian: membership, new projects, state updates, the
   transcript note, a backfill over existing threads (dry run first,
   like `tb retitle`).
4. The app: Projects view, project page, header chips.
5. The brief in context.
6. Convex sync, with step 5 of the main plan.
