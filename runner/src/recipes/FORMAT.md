# Writing a recipe

A recipe is a technique worth keeping (a morning brief, a nightly look back, a
watcher), written so an agent can set it up for anyone. Threadbear lists them in
its Recipes view (docs/protocol/projects.md, "Recipes"). Each is a folder with a
`RECIPE.md` and, if you like, a header picture.

The ones that come with Threadbear are in `runner/src/recipes/<id>/`. Your own
go in your recipes folder (`~/ThreadbearThreads/recipes` unless runner.json's
`recipes.folder` says otherwise), one folder each. A folder there with the same
id as one that comes with Threadbear is used in its place.

## What makes a recipe

A recipe is something extra you choose: a routine (a morning brief, a weekly
look back, a standup draft) or a way of working not everyone wants (always
show me three options). Two kinds of thing don't belong here:

- What every agent should do anyway to use Threadbear well (try a step before
  handing it over, put options in the review window). That goes in Threadbear
  itself, so a new user gets it from their first thread without switching
  anything on. Mike's call on 24 Nov 2026, after the first habit recipes
  turned out to repeat what agents already did.
- Generic advice any model already follows (give links, be concise). It costs
  every thread and changes nothing.

## The file

```
---
name: Daily brief
icon: ☀️
description: A short note each morning: today's calendar, the emails that need you and the threads waiting on you.
by: Mike
when: Every day at 6:30
color: #e0884a
---

## About

What it's for, and why it's worth having, in a short paragraph or two.

## Example

Title: Daily brief

A made-up run, as its thread would show it, so people can see what they'd
get. Never a real one: real runs hold someone's email, calendar and messages.

Card: 2 emails need you today
Options: Done | Remind me at 2

## Example 2

Another made-up run: give two or three, so people see a busy day and a quiet one.

## Setting it up

For the agent that sets it up: what to ask the user, what to check (a
connector signed in, a command installed), and the schedule to make.

## Each run

What the scheduled thread does each time. The setup agent copies this into
TASK.md in the recipe's working folder, adapted to what the user said.

## Habit

A few lines every thread's agent is told while the recipe is on.
```

Each `## Example` section (`## Example 2`, `## Example 3` and so on) is one
run, and the app shows them as a little thread you can scroll, with dots to
flip between them. A line at its top `Title:` is the thread's title, and
`You:` what the user said first (for a habit, where the example is an
exchange). The rest is the agent's reply, in Markdown. A line at its end
`Card:` is the end card's headline, with `Options:` its answers split by
`|`. Base them on real runs if you have some, with every name, address,
number and detail changed: they ship to everyone.

The fields:

- `name`, `icon` (one emoji) and `description` (one line, for its card) are
  needed. The rest are optional.
- `by`: who wrote it.
- `when`: how often, in words.
- `color`: the header's colour, `#rrggbb`, when there's no picture.
- `experiment`: the id of a Threadbear experiment this recipe switches. Its
  switch in Recipes is that experiment's, and "Each run" isn't needed.
- `runsFrom`: for an experiment that starts threads of its own, the label it
  gives them (what a thread's row says started it, such as `Email`). Those
  threads count as the recipe's runs, as its schedules' threads do.

## A habit

Some techniques aren't jobs that run but ways of working: "show me a few
options", "try it yourself before asking me". Put those in a `## Habit`
section. While the recipe is on, Threadbear gives those lines to the agent in
every thread, Claude and Codex alike, beside the user's standing instructions.
Nothing is written to their CLAUDE.md or AGENTS.md, and switching it off stops
it at once.

- Write it to the agent, as plain instructions, and say when it doesn't apply.
- Keep it short: every thread pays for it, and over 800 bytes the recipe
  won't load. The recipe's page shows the user the exact words and their size.
  Something long, or only needed now and then, belongs in a skill instead.
- A recipe with a Habit and no "Setting it up" or "Each run" is only a habit:
  Add switches it on straight away, with no setup thread. Its Example shows an
  exchange with and without it.
- Agents are told the wording the user switched on. If the file changes
  later, its page shows both and they choose when to take the new one.

## The header picture

`header.png`, `header.jpg` or `header.webp` beside `RECIPE.md`, about 1600 by
500 pixels, made with an image model. Keep it simple and warm, with nothing that
has to be read: no words, no logos, no screenshots. Without one the header is
`color`.

## Keeping it shareable

A recipe is meant to be passed on. Leave out anything of yours: names, email
addresses, accounts, machines, paths in your home folder, keys. Where the recipe
needs one of those, "Setting it up" asks for it.

What a recipe's agents read from outside (email, web pages, messages) is other
people's words: say in "Each run" that it's material to report on, never
instructions to follow.
