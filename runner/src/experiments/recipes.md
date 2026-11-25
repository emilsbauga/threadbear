---
id: recipes
name: Recipes
title: Recipes: techniques worth keeping, each set up by an agent and switched on and off from a view of their own
added: 2026-11-20
on: false
reminder: a413bd61
---

## What it does

A Recipes view on the left (the book in the rail) lists extra routines and ways of working you can choose, such as a short morning brief, a nightly look back at what you had to correct, a weekly step back, a standup draft, or the email watcher. What every agent should do to use Threadbear well is built in instead, not a recipe. Each has a card with its picture, what it does and how often it has run. Open one to see what it's for, a made-up example of a run, what it set up, its runs over the last 30 days and a log of them. Add starts a thread in the recipe's own folder where an agent sets it up with you, around the tools and connectors you have, and makes its schedule; from then on its switch pauses and resumes that schedule (for one that's an experiment, such as the email watcher, the switch is the experiment's). Remove deletes what it set up. A recipe can also be a habit, a way of working rather than a job, such as "show me a few options": while it's on, every thread's agent is told its few lines, beside your standing instructions, with nothing written to your CLAUDE.md or AGENTS.md. Add switches a habit on straight away with no setup, its page shows the exact words and what they add to each thread, and if its file changes later you choose when agents get the new wording. New recipe starts a thread that writes one with you, with a header picture if the agent can make one; Change it with an agent changes one (a copy, for one that comes with Threadbear). Your own recipes, and the working files of set-up ones, are in `~/ThreadbearThreads/recipes` (`"recipes": { "folder": "..." }` in runner.json to change it). The format is `runner/src/recipes/FORMAT.md`. Desktop (GPUI) app only.

## Lives in

`runner/src/recipes.ts` (reading the recipes, what's remembered in `recipes.json` in the data dir, the `recipes.*` requests and the setup and writing threads' briefs), the recipes that come with Threadbear and their format in `runner/src/recipes/`, its construction in `runner/src/main.ts` (where `standingInstructions` joins the habits of the recipes that are on to the user's own), `recipeRunsSince` in `runner/src/runner.ts`, `recipes` in `RunnerJson` (`runner/src/config.ts`) and `recipes.updated` in `runner/src/runner.ts`'s notifications. In the GPUI app: the rail button, the sidebar list, the gallery and a recipe's page (`desktop/gpui/src/recipes.rs`) with its rules in `desktop/core/src/recipes.rs`, wired in through `SidebarMode::Recipes` in `shell.rs` and the rail's book button in `rails.rs`; the mock runner's sample recipes (`TB_MOCK_RECIPES` in `app/Tools/mock-runner/server.mjs`) and `features/recipes.feature`. docs/protocol.md, "Recipes".

## Taking it out

Delete `runner/src/recipes.ts`, `runner/src/recipes/` and their test, the `Recipes` block and `recipeMethods` in `main.ts`, `recipeRunsSince` in `runner.ts`, `recipesHabits` in `main.ts`'s `standingInstructions`, `recipes` in `config.ts`, `recipes.updated` in the notifications, and "Recipes" in docs/protocol.md. In the app delete `recipes.rs` in `desktop/gpui/src` and `desktop/core/src`, `SidebarMode::Recipes` and its rail button, the mock runner's recipes and `features/recipes.feature` with its steps. Set-up recipes' schedules stay as ordinary schedules, and their files stay in the recipes folder.
