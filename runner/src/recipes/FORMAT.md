# Writing a recipe

A recipe is a technique worth keeping (a morning brief, a nightly look back, a
watcher), written so an agent can set it up for anyone. Threadbear lists them in
its Recipes view (docs/protocol/projects.md, "Recipes"). Each is a folder with a
`RECIPE.md` and, if you like, a header picture.

The ones that come with Threadbear are in `runner/src/recipes/<id>/`. Your own
go in your recipes folder (`~/ThreadbearThreads/recipes` unless runner.json's
`recipes.folder` says otherwise), one folder each. A folder there with the same
id as one that comes with Threadbear is used in its place.

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

A made-up run, in Markdown, so people can see what they'd get. Never a real
one: real runs hold someone's email, calendar and messages.

## Setting it up

For the agent that sets it up: what to ask the user, what to check (a
connector signed in, a command installed), and the schedule to make.

## Each run

What the scheduled thread does each time. The setup agent copies this into
TASK.md in the recipe's working folder, adapted to what the user said.
```

The fields:

- `name`, `icon` (one emoji) and `description` (one line, for its card) are
  needed. The rest are optional.
- `by`: who wrote it.
- `when`: how often, in words.
- `color`: the header's colour, `#rrggbb`, when there's no picture.
- `experiment`: the id of a Threadbear experiment this recipe switches. Its
  switch in Recipes is that experiment's, and "Each run" isn't needed.

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
