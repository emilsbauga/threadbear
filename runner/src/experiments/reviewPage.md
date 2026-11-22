---
id: reviewPage
name: Reviews as a page beside the thread
title: Reviews as a page beside the thread: an agent's design options open in the side pane with their words at reading size, and you answer in the message box
added: 2026-11-20
on: false
reminder: ddd156fc
---

## What it does

When an agent shows you design options, they open as a page in the pane beside the thread, not in a window of their own. The page has the agent's lead, then each option with its words at the thread's reading size and its pictures under them, so there's one place to look and read. The card in the thread shows each option's small picture and name, and a click on one opens the page. The pane opens wide enough for it (wider for a wide design, like a desktop app's mockup) and goes back to your own width when the page closes, unless you dragged it meanwhile. The agent is told its notes are read there, so its reply needn't list the options again. Tick the options you like on the page: they show as chips over the message box, and sending it sends them as your answer, with what you typed as the reply and any pictures you added. Ticks alone can be sent, with Return or Send, and the ✕ on a chip unticks it. The page closes once your answer has gone. Click a picture to see it full size in a window, with that option's words under it and the arrow keys flicking between the options in the same spot. A message that's a command (starting with /), or one sent with answers picked on a card of asks, is an ordinary message: like any message you send without ticking, it puts the review aside. Desktop (GPUI) app only, for threads on this Mac; the iPhone and the website keep their own sheets.

## Lives in

In the runner, only `REVIEW_PAGE_NOTE` in `runner/src/threadbear-mcp.ts` (what show_options adds to its answer so the agent doesn't write the options out again in its reply) and `experiment` on the Runner and the ThreadRouter that it asks: the app uses the review RPCs that were there (`reviews.save` for a tick, `reviews.respond` for the answer). The page's HTML is `desktop/core/src/review_page.rs`; `Site::made` in `desktop/core/src/local_preview.rs` serves it; `PreviewSite::made`, `asked` and `Event::Asked` in `desktop/web` tell the app which tick or picture was clicked; `desktop/gpui/src/review_pane.rs` shows it (`Target::Review` in highlights.rs and files.rs, `made_page` in web_panels.rs, `open_review` and `closer_look` in review_window.rs with `render_words` in review_window/rail.rs, the card's pictures in rows/cards.rs, and the ticks over the message box with `send_review_answer` in composer.rs). The pane's width is `show_pane_wide` and `restore_pane_width` in shell.rs, over `widen` in `desktop/dock/layout`. The mock runner's `keptForReview` and `TB_MOCK_REVIEW_PAGE`, and `features/review-page.feature`, try it.

## Taking it out

Delete the file, `REVIEW_PAGE_NOTE` and its use, review_page.rs, review_pane.rs and `Target::Review`, the branch in `open_review` and `closer_look` with `render_words`, the card's pictures in rows/cards.rs, the ticks row, `review_sending` and `send_review_answer` in composer.rs, `made_page` and `asks` in web_panels.rs, `Site::made`, `PreviewSite::made`, `asked` and `Event::Asked`, and the mock's `keptForReview`. The dock's `widen` and the app's `show_pane_wide` can stay for whatever else wants them.
