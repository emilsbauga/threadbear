---
id: inboxGuess
name: Inbox guess
title: Inbox guess: Archive asks whether you needed to see the thread, and a model's guess is scored against your answer
added: 2026-11-18
on: false
reminder: 994605b5
---

## What it does

Finds out which finished threads you didn't need to see, without hiding any. On the done card, Archive opens a small menu: "Didn't need this" (the agent only did what you'd told it to, and the thread could have gone straight to Archived), "Glad I saw this", or "Not sure" for the in-between ones, which is kept but not scored. Each archives the thread as before, and leaves a line in it saying which you picked. ⌘E, a row's archive button and a swipe still archive straight off, with no menu.

Meanwhile, each time one of your own threads finishes with nothing for you, two models (a cheap one and a strong one) each guess whether you needed to see it, from your last message to it and the agent's reply. A thread that suggested follow-ups or left anything open always counts as one to see, with no model asked. The guess does nothing and shows nowhere: the thread stays in your inbox either way. The guesses and your picks are written to `inbox-guess.jsonl` in the runner's data folder, so you can see how often a model would have been right before letting it archive anything. Threads in a private folder aren't sent to a model. Threads on another runner, and archives from the phone or the website, aren't part of it yet.

## Lives in

`runner/src/runner/inbox-guess.ts`, called from `completeTurn`, `start` and `update` in `runner/src/runner.ts` and from `adopt` in `runner/src/runner/handovers.ts`; the three verdicts `didntNeedToSee`, `gladISaw` and `notSure` (`runner/src/protocol.ts`); the Archive menu in `desktop/gpui/src/composer_card.rs` and `MenuAction::ArchiveAs` (`desktop/gpui/src/sidebar.rs`)

## Taking it out

Delete `runner/src/runner/inbox-guess.ts`, its three calls in `runner.ts`, the one in `handovers.ts`, and its part in the `Runner` interface and the parts list, `inboxGuess` on the thread record (`store.ts`), the three verdicts and their notes, and in the desktop app `inbox_guess_on`, `open_archive_menu` and `MenuAction::ArchiveAs`, so Archive is a plain button again.
