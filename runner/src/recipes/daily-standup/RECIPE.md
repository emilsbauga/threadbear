---
name: Daily standup
icon: 🗣️
description: Each work morning, a draft of your standup from what you actually did yesterday, for Slack, Discord, Teams, email or X, ready for you to check and post.
by: Mike
when: Weekdays at 8:00
color: #c9783a
---

## About

I'm meant to post a standup every morning, and I'm forever forgetting. When I
do remember, I undersell what I did because I can't remember half of it. My
threads can though.

So each work morning an agent reads what I got done yesterday and drafts my
standup in the format my team uses. I check it, change what I like and post
it. It works wherever your team does standups: Slack, Discord, Teams, an
email, or even a post on X if you build in public. It only posts when you
press Post, and it learns from what you change, so the drafts sound more like
you over time.

## Example

Title: Daily standup

Here's your standup for #team-standup, covering yesterday:

**Yesterday**
- Shipped the CSV export for invoices (PR merged, live by 4 pm)
- Fixed the sign-in loop on Safari that support flagged
- Reviewed Ana's billing PR, two small notes

**Today**
- [ ] Start on the team invites page
- [ ] 11:00 planning call

**Blockers**
- None

**Why each line:** the export is [PR #482](https://github.com/example/app/pull/482), the Safari fix is the "Sign-in loop" thread, and the review is your comment on [PR #479](https://github.com/example/app/pull/479).

Card: Standup draft ready for #team-standup
Options: Post it | I'll post it myself | Skip today

## Example 2

Title: Daily standup

You already posted today's standup at 8:42, so there's nothing to draft.

I ticked off two of yesterday's Today items that you finished: the invites page and the planning call notes.

Card: Already posted, nothing to do
Options: Thanks

## Example 3

Title: Daily standup

A build-in-public post for X, from what you shipped yesterday:

> Day 41 of building Tally 🧾 Shipped CSV export for invoices and fixed a nasty sign-in loop on Safari. Next up: inviting your team. What would you want in a team invite flow?

Card: X post ready
Options: Post it | Edit first | Skip today

## Setting it up

1. Ask where they post their standup: a Slack, Discord or Teams channel, an
   email to their team, a doc, or a build-in-public post on X. It can be more
   than one. Ask the format their team uses, and the time they'd like the
   draft, and for a past standup or two to copy the style from.
2. Check what you can read and where you can post: their threads (always),
   their calendar if a calendar connector is signed in, and each place they
   post (a connector, a command, or a browser that's signed in). Say plainly
   which you can reach. Ask whether they'd like a Post button on each draft,
   which posts exactly the draft they saw when they press it, or drafts only
   (saved as a draft where the tool has them, as Slack does).
3. Write TASK.md in this folder from "Each run", with their answers and the
   example standups. Start learnings.md empty.
4. Make the schedule with schedule_message: `new_thread` true, this folder,
   weekdays at their time as a cron, a message saying "Read TASK.md in this
   folder and do it."

## Each run

1. Read learnings.md: how the user changed earlier drafts. It wins over
   anything else here.
2. If they've already posted today's standup (when you can check), say so in
   one line and archive the thread.
3. Gather the last working day: `list_threads` for threads active since then,
   with what each did and how it ended (`read_thread` where the summary isn't
   enough); merged pull requests and commits in their repos if you can see
   them; yesterday's and today's calendar.
4. Draft the standup in their format, in their words: specific, short, what
   they did rather than what agents did. Don't undersell real work, and leave
   out noise (archived chores, failed tries that went nowhere).
5. Show the draft in your reply and end with needs "you". If TASK.md allows
   posting, offer "Post it" in your card and post exactly the draft they saw,
   only when they press it; otherwise save it as a draft where the tool has
   them. Never post anything they haven't seen and pressed for.
6. If they change the draft and tell you, or you can see what they posted,
   note what they changed and why in learnings.md, then archive the thread.
