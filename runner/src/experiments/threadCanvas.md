---
id: threadCanvas
name: Canvas
title: Canvas: every live thread on one zoomable board, by project, with arrows from each thread to the ones it started
added: 2026-11-24
on: false
reminder: 6f57df52
---

## What it does

A Canvas button in the rail (three windows joined by arrows) opens a board in place of the thread list and the thread, with every live thread on it as a small copy of its window: its title with the amber dot while it waits on you, what you last asked, the agent's latest words and its question, and the message box. Each project is an area with a fixed place and its name faint above it, the biggest on the left; threads in no project are in Loose. Inside an area threads grow left to right, with a curved arrow from each thread to the ones it started, labelled in handwriting with why. A new thread grows in beside the thread that started it, or at its area's open edge, its area glows for a moment, and nothing else moves. An archived thread shrinks to a faint pill that keeps its arrows, and the pills go once their whole tree is archived (after an hour and a half), or when you press Tidy, which also closes the gaps. Threads a schedule, a tool or Threadbear started on their own wait in a strip along the bottom, and move onto their area only once they need you. Click a project's name to fade the others back; Esc or a click on the empty board brings them back. ⌘ or Control with the wheel, or a pinch, zooms round the pointer; the wheel or two fingers move the board, and you can drag a thread's window to another place, where it stays. Click a thread and the board flies in until it fills the view, and the real thread takes over there: the wheel scrolls it and the message box works. ⌘ and the wheel toward you, a pinch out, Esc or a click beside it flies back out. Where everything sits is kept between launches. Mac and the other desktops (the GPUI app) only.

## Lives in

The board's rules in `desktop/core/src/thread_canvas.rs` (which threads, the areas and their places, where a thread arrives, ghosts, Tidy, the arrows' curves); the page in `desktop/gpui/src/thread_canvas.rs` (drawing, the camera, the mouse and the hand-over to the real thread view), shown in place of the dock by `render_shell` in `shell.rs`, its rail button in `rails.rs` with its icon in `icons.rs`, `CanvasPage` on `Threadbear` in `app.rs` (taken down by `open_with` and `set_mode`), the board's two fingers kept from Back and Forward in `swipe_nav.rs`, its layout saved as `threadCanvas` in `desktop-settings.json` (`settings.rs`), and the scripted app's `canvas` command in `automation.rs`. The spec is `features/thread-canvas.feature` (the mock's `TB_MOCK_THREAD_CANVAS`).

## Taking it out

Delete this file, both `thread_canvas.rs` files and their `mod` lines, `thread_canvas` on `Threadbear` and in `Saved`, the canvas branch in `render_shell`, the `hide_thread_canvas` calls in `open_with` and `set_mode`, the rail button and `on_canvas` in `rails.rs`, `CANVAS` in `icons.rs`, `takes_scroll` in `swipe_nav.rs`, `in_motion` in `moving`, the `canvas` automation command, the feature file with its steps, and `TB_MOCK_THREAD_CANVAS` in the mock and `features/support/world.ts`. A saved `threadCanvas` in someone's settings file is kept as an unknown field and does nothing.
