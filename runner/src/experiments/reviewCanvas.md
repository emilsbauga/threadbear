---
id: reviewCanvas
name: Review canvas
title: Review canvas: design reviews become a board you drag and zoom, with the agent's notes on the pictures and marks of your own
added: 2026-11-22
on: false
reminder: ddc1ae8a
---

## What it does

A design review's window becomes a board you drag around and zoom into, with every picture laid out on it: each option's pages in a column under its name, on a faint glow with its big letter behind, the glow turning green and its pictures ringed once you tick it. The agent can draw on any of its pictures in a handwritten style: circles, underlines, marker swipes and curled arrows, each with a few words beside it, in colours with jobs (yellow points something out, green is what solves it, rose is a cost). A switch hides them when you want the pictures clean, and a tour flies from picture to picture. Tools of your own circle, highlight or pin a part of any picture: each drops a numbered chip into your reply, so you can say "[Mark 1] is too tight", and the agent gets a cut-out of that part with your answer. A clip, a sound or a page plays where it sits on the board: press Play on it, or double-click it.

## Lives in

`runner/src/reviews.ts` (`agentMarks`, `userMarks`, `markLine`, `reviewImages`) and `runner/src/runner/reviews.ts` (the `experimentOn` check in `createReview`, cut-outs kept in `keepReplyImages`), the gated `marks` in `show_options`' schema in `runner/src/threadbear-mcp.ts` (`reviewCanvas`, passed from `runner/src/main.ts`), the mark types in `runner/src/protocol.ts`. In the desktop app: the board's layout, tour, camera and doodle shapes in `desktop/core/src/review_canvas.rs`, the marks in `ReviewShot` and `ReviewDraft` (`desktop/core/src/reducer/event.rs`), the board itself in `desktop/gpui/src/review_window/canvas.rs` (on when hello lists the experiment), mark chips in the reply in `review_window/reply_pictures.rs`, and the Caveat handwriting font in `desktop/gpui/fonts/caveat`. The spec is `features/review-canvas.feature` (the mock's `TB_MOCK_REVIEW_CANVAS`). The contract is docs/protocol/events.md, "Marks: the canvas".

## Taking it out

Delete this file, the `reviewCanvas` option and the `marks` fields in threadbear-mcp.ts's `show_options` and its two uses in main.ts, the `marks` option of `reviewInput` with `agentMarks` and `fitAgentMarks`, `userMarks`, `fitUserMarks`, `markLine` and `reviewImages` in reviews.ts (sending `draft.images` again), the mark handling in runner/reviews.ts (`ownMarkImages`, the marks in `keepReplyImages` and `withSavedImages`) and in moves.ts's `dropMovedReplyImages`, the mark types in protocol.ts, the "Marked" line in runner.ts's `askedLine`, and in the desktop app `review_canvas.rs`, `review_window/canvas.rs` with its uses in `review_window.rs` and `band.rs`, the mark chips in `reply_pictures.rs`, the marks in `event.rs` and `review.rs`, the Caveat font with its line in `fonts.rs`, the feature file with its steps, and `TB_MOCK_REVIEW_CANVAS` in the mock and `features/support/world.ts`.
