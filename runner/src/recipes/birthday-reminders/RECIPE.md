---
name: Birthday reminders
icon: 🎂
description: Every Monday, the birthdays coming up: family three weeks out with gift ideas, friends on the week, so you can message them on the day.
by: Mike
when: Mondays at 8:00
color: #d9805a
---

## About

I once forgot my dad's birthday, and I'd rather not do that again.

Every Monday an agent checks my calendar for birthdays coming up. For family,
the people I buy presents for, it warns me three weeks out with a couple of
gift ideas, so there's time to order something and get it posted. For friends
it just tells me which day this week, so I can message them on the day.

## Example

Title: Birthdays coming up

**Family**
- **Mum**, Saturday 19 December (18 days). She mentioned wanting to get back into watercolours.
  - A beginner watercolour set ([example](https://www.example.com/watercolours))
  - A voucher for a local painting class
- **Alex**, Tuesday 22 December (21 days). Ideas next week once it's closer.

**Friends this week**
- Jess, Wednesday
- Tom, Saturday

Card: Mum's birthday in 18 days
Options: Order the watercolours | Remind me next week

## Example 2

Title: Birthdays coming up

No family birthdays in the next three weeks.

**Friends this week**
- Priya, Thursday

Card: Priya's birthday is Thursday
Options: Remind me on the day | Thanks

## Setting it up

1. Ask where their birthdays live: a calendar (which one, if there's a
   connector signed in), their contacts, or a list they'd like to keep in
   birthdays.md in this folder. Check you can read it and say so.
2. Ask who's family (the people they buy presents for, warned three weeks
   out with gift ideas) and who's a friend (told on the week). Ask anything
   that shapes gifts: who lives far away, where they usually order from.
3. Ask whether they'd like a nudge on the day too: a thread that morning with
   a short message ready to send.
4. Ask the day and time (default Monday 8:00).
5. Write TASK.md in this folder from "Each run", with their answers. Keep
   names and notes about people in TASK.md and memory.md here, never in the
   recipe's own file.
6. Make the schedule with schedule_message: `new_thread` true, this folder,
   their day and time as a cron, a message saying "Read TASK.md in this folder
   and do it." If they want the on-the-day nudge, each run books it with
   schedule_message for that morning.

## Each run

1. Find birthdays from today through 21 days out. Calendars name them all
   sorts of ways, so search for "birthday" and "bday" and anything TASK.md
   says.
2. Keep family in the next 21 days and friends in the next 7. If nothing's
   left, say so in one line and archive the thread.
3. Family first, soonest first, with the date and how many days away, and one
   or two gift ideas each that fit what you know about them (memory.md and
   TASK.md), with links to where to buy, allowing for delivery time. Then
   friends this week, with the day.
4. If TASK.md asks for on-the-day nudges, book one with schedule_message for
   each friend's birthday morning: a short message they could send, in their
   own voice.
5. End with an ask (ordered, remind me next week). Note in memory.md what was
   bought or sent, so next year's ideas don't repeat.
