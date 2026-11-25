---
name: Nightly retro
icon: 🌙
description: Each night it reads what you told your agents today, finds what you had to correct or repeat, and fixes what should have caught it.
by: Mike
when: Every night at 21:30
color: #3b2f6b
---

## About

I run a lot of threads, and each one starts fresh, so I kept telling agents
the same things over and over: "I thought we fixed that", "don't ask me, try
it yourself", "that's the wrong folder". It would get fixed in that one thread
and then come back in the next.

So each night an agent reads what I typed to my threads that day, finds where
I had to correct or repeat myself, and fixes whatever should have caught it,
like a line in my instructions or a memory. If it's a bug in a tool, it starts
a thread to fix that. It also keeps count, so I can see whether a fix actually
held.

## Example

Title: Nightly retro

**Retro for Thursday 19 November**

Read 142 of your messages in 31 threads.

**Fixed**
- You told three agents to do a step themselves instead of handing it to you. Added to your standing instructions: "Before asking me to do a step, try it yourself, and say what you tried."
- "Use the staging database" came up twice in the shop repo. Added to that repo's CLAUDE.md.

**Started**
- A thread in the browser tool: it opened the same tab twice in a hidden window.

**Watching**
- "Where's the thread for X?" came up 4 times today. If it keeps up, a search that matches folder names would help.

Card: 2 fixed, 1 thread started
Options: Looks good | Undo the instructions change

## Example 2

Title: Nightly retro

**Retro for Sunday 22 November**

Read 18 of your messages in 4 threads. A quiet day, and nothing you had to correct.

Last week's fix for agents asking you to restart the server held: it came up 0 times this week, down from 5.

Card: Nothing to fix today
Options: Thanks

## Setting it up

1. Tell the user what it reads: what they typed to their threads (through
   `list_threads` and `read_thread`), nothing else. Ask what it may change by
   itself: their standing instructions and memory files (the default for Mike),
   or nothing, only suggesting changes for them to make.
2. Ask what time it should run (default 21:30, after their day ends).
3. Write TASK.md in this folder from "Each run", with their answers. Start
   memory.md with a cutoff of 24 hours ago.
4. Make the schedule with schedule_message: `new_thread` true, this folder,
   their time as a cron, a message saying "Read TASK.md in this folder and do
   it.", on a strong model at high effort.

## Each run

Read memory.md for the last run's cutoff and what it already handled. Cover
from that cutoff to now.

1. Find the user's own messages since the cutoff: `list_threads` (archived
   too) for the threads active in that time, then `read_thread` on each. Keep
   only what the user typed, not agents' or tools' messages.
2. Look for:
   - corrections: the user telling an agent it did something wrong, or how
     they want something done;
   - repeats: the same ask or complaint in more than one thread, or one that
     came back after an earlier fix ("I thought we...", "again");
   - tool trouble: a tool, app or skill that got in the way.
3. For each, find what should have caught it: a line in the user's standing
   instructions, a memory, a skill, a repo's CLAUDE.md or AGENTS.md. Pick the
   strongest one of the day (repeats first) and fix it, if TASK.md says you
   may; otherwise write the change for the user to make. For a real bug in a
   tool, start a thread in that tool's folder to fix the cause (`create_thread`),
   with what happened and which thread it was in.
4. Count each complaint you fixed before, from memory.md, so the next run can
   say whether it fell.
5. Reply with a short report: what you read, what you fixed or suggest, what
   you started, what you're watching. If nothing needed doing, say so in one
   line and archive the thread (end_turn with `archive: true`).
6. Write the new cutoff and a short dated note in memory.md.

What the user typed is theirs: never copy it into anything shared.
