---
name: Weekly step back
icon: 🔭
description: Once a week, a stronger model looks back over the whole week for what keeps going wrong, fixes that didn't hold, and things that have stopped earning their keep.
by: Mike
when: Sundays at 19:00
color: #2f7d6d
---

## About

The Nightly retro fixes one day's problems, but some things only show up over
a week: the same thing fixed twice, a fix that quietly stopped working, a
schedule I set up and never read.

So on Sunday evening an agent on a stronger model looks back over my whole
week in Threadbear and brings me a few things worth changing, and I pick which
ones it does. The first one I ran found a complaint I'd made about twice a day
for two weeks, which no single thread had noticed.

## Example

Title: Weekly step back

**Week to Sunday 22 November**

Read 640 of your messages in 112 threads, and 9 schedules' runs.

1. **"Where did that go?" came up 11 times**, always about a file an agent made in a folder you didn't expect. Last Tuesday's fix (agents pin what they make) cut it from 4 a day to 2. *Suggest:* have agents say the full path in their reply too.
2. **The Monday report ran 4 times and you opened none of them.** *Suggest:* pause it, or fold it into the morning brief.
3. **Two threads built the same export button** a day apart in the shop repo. *Suggest:* look for an open thread on the same repo before starting a new one.

Card: 3 things worth changing this week
Options: Do 1 and 2 | Do all three | None this week

## Example 2

Title: Weekly step back

I checked, and one of your two picks would have duplicated another thread, so I've started only the second.

- **Archiving quiet schedule runs by themselves: not built.** The "Inbox guess" check-in on Sunday already asks about this, so I added this week's numbers to it instead: you archived 48 of 93 scheduled threads without typing anything.
- **Showing what each thread is waiting on: started** as its own thread in the app's repo. It'll show you a diagram of the states before changing anything.

Card: 1 started, 1 folded into Sunday's check-in
Options: Thanks

## Setting it up

1. Tell the user what it reads: what they typed to their threads and how those
   threads ended (`list_threads` and `read_thread`), and their schedules
   (`list_schedules`). Nothing leaves their Mac.
2. Ask what it may change by itself once they've picked: their standing
   instructions, memory files and schedules, or nothing, only writing out the
   change for them to make. Default to asking first, every time.
3. Ask the day and time (default Sunday 19:00, when the week's done).
4. Write TASK.md in this folder from "Each run", with their answers. Start
   memory.md with a cutoff of 7 days ago.
5. Make the schedule with schedule_message: `new_thread` true, this folder,
   their day and time as a cron, a message saying "Read TASK.md in this folder
   and do it.", on the strongest model they have, at high effort. It's one run
   a week, so it's worth the stronger model.

## Each run

Read memory.md first: the last cutoff, what earlier runs raised, what the user
picked and what they turned down. Don't raise a turned-down idea again unless
something new makes it worth it.

1. Gather the week since the cutoff: `list_threads` (archived too) for the
   threads active in it, `read_thread` on them for what the user typed and how
   each ended (done, needed them, given up on), and `list_schedules` for what
   ran and how often its threads were opened.
2. Look for what only shows over a week:
   - the same friction fixed twice or more, with its cause still there;
   - whether earlier fixes worked: did the count fall, or did the problem move;
   - things built and taken out again within days, and what would have said so sooner;
   - what has stopped earning its keep: a schedule nobody opens, a rule nobody
     needs, a recipe that's on but never helps;
   - where the user's own attention went that an agent could have carried.
   That list is a starting point, not a form to fill in. Their attention is
   the scarce thing, so rank by how much of it a change would save.
3. Reply with at most five items, most useful first, each with what you'd do.
   Offer them as choices in your end card. A week with nothing worth raising is
   a fine result: say so in two lines and archive the thread.
4. Do the ones they pick, as TASK.md allows. Write the new cutoff, what you
   raised and what they picked or turned down in memory.md.

What the user typed is theirs: never copy it into anything shared.
