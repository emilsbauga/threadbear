---
id: feed
name: Feed
title: Feed: your Inbox as cards, one after another, each answerable where it is
added: 2026-11-20
on: false
reminder: 2a6685c0
---

## What it does

A Feed button in the activity bar (and Go > Show Feed) shows your Inbox in the main panel as one roomy card per thread, one after another, instead of a row each in the sidebar: those that need you first, then the running ones, then the rest, each newest first. Hibernating and archived threads aren't in it, and the sidebar stays as it is. A card starts with what you asked, your first message to the thread (for a thread you didn't start, who started it: another thread, a schedule or a tool, then its title). Under that, "Where it's at" is the latest turn's headline and when it was last updated, with its questions drawn as the thread's own buttons and rows, Recommended included, to answer right there: the button you press spins and the others wait until the thread has the answer. A thread that's working says what it's doing with a spinner instead. The footer's fold ("Claude · 9 messages") opens the thread's recent messages inside the card, each cut to three lines with See full and Open thread. Done archives the thread and shrinks its card to one line with Undo until you leave the Feed; Later is the usual hibernate menu. A card that needs you, or whose messages you opened, has a box to reply to the thread from there. When new cards come in while you're scrolled down, a "↑ 3 new" pill at the top takes you back up. Desktop (GPUI) app only. Not in it yet: a box at the top to start a new thread, and asking several models at once from one card.

## Lives in

The page in `desktop/gpui/src/inbox_feed.rs` (cards, fold, reply box, Done and Undo, the new pill, its dump and script command `feed`), opened as `SidebarMode::Feed` in `shell.rs` (Go > Show Feed, the main panel, back and forward) with its button in `rails.rs`; its order, card states and words in `desktop/core/src/feed.rs`. The asks reuse the Decisions card (`DecisionCard::for_feed` in `project_decisions.rs`) and `AskHost::ask_sending` and `sending_button` in `composer_card.rs`. The card's top line is the summary's `request` (docs/protocol.md, "What Mike first asked"), set in `runner/src/runner.ts` (`requestLine`, `backfillRequest`) and carried to other Macs on `threadIndex` rows from backend API 96. The mock runner's `TB_MOCK_FEED` demo; `features/feed.feature`. The app learns it's on from `hello`'s `experiments`.

## Taking it out

Delete `inbox_feed.rs`, `core/src/feed.rs`, `features/feed.feature` and its steps, `SidebarMode::Feed` and its arms, `Command::ShowFeed` and its Go menu item, the rail's Feed button, the `inbox_feed` field on `Threadbear`, `leave_feed_for_thread` and its calls, the Feed line in `leave_selection`, `DecisionCard::for_feed` with `keeps_picks` and `sending_now`, and `ask_sending` with `sending_button`. `request` can stay: it's harmless without the Feed reading it.
