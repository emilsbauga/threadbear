# Scrolling and drawing: measurements

What a scroll costs the GPUI app, from `features/tools/render-perf.ts`: real
trackpad flings through the window server on Tinker Desk's M2 (a 60 Hz
screen, so 16.7 ms a frame; Mike's M5 is a 120 Hz screen, 8.3 ms a frame),
release builds with frame-stats, at the size of Mike's install: 1,186
threads over 80 projects, nearly all archived (TB_MOCK_PERF_PROJECTS), the
decisions experiment's folded Projects rows, and a 1,500-turn thread open.
Builds are compared with `features/tools/render-ab.mjs`, which takes them in
turns so the host's other work falls on each alike.

The number to trust most is the main thread's CPU time per frame shown
(`mainCpuMs` from frame-stats): Tinker Desk is a shared check host, often at
a load of 30 to 200, and frame times and late frames move with that much
more than the main thread's own CPU time does (it leaves out waiting for a
core, though a loaded Mac may still move the thread to an efficiency core,
so loaded and idle numbers aren't comparable with each other). "Loaded" adds one spinning
process per core on top.

## 13 Nov: sidebar lists

Mike's recording (13 Nov) was the Projects list scrolling with a delay.
A scroll in a plain scrolling div makes GPUI draw the view it's in again, so
each frame of a sidebar scroll rebuilt the whole sidebar: every row of the
list, and its sections worked out afresh from every thread.

First measured against main at 23767da5c, medians of 3 rounds each: the
sections kept between frames and sorted by keys read once (B), and with rows
far out of view drawn as gaps too (C):

| Scroll | CPU a frame, ms (main, B, C) | Late frames (main, B, C) |
|---|---|---|
| Inbox | 19.9, 15.9, 9.3 | 66%, 37%, 1.7% |
| Projects | 14.7, 12.1, 9.4 | 30%, 20%, 2.9% |
| Inbox, loaded | 14.5, 11.6, 7.8 | 33%, 16%, 8% |
| Projects, loaded | 13.4, 9.3, 8.1 | 67%, 11%, 7% |

A profile of C showed a row's hover redrawing the whole window as rows passed
under the pointer, and perf 1's change (795dd29cb) took that, the kept
sections and the sort. Measured again on main after it (14 Nov), the gaps
alone:

| Scroll | CPU a frame, ms (main, gaps) | Late frames | Slowest 1 in 100, ms |
|---|---|---|---|
| Inbox | 9.67, 9.06 | 3.4%, 2.3% | 33.7, 22.7 |
| Projects | 9.23, 9.07 | 3.7%, 4.0% | 24.4, 21.2 |
| Inbox, loaded | 14.0, 10.9 | 11.7%, 0.6% | 19.5, 16.0 |
| Projects, loaded | 11.2, 9.5 | 2.1%, 1.3% | 17.6, 17.0 |

## 14 Nov: a long real thread

A copy of a real 13,700-event thread with pictures and thread chips
(private, never in git), scrolled: 9.2 ms of main-thread CPU a frame on the
M2, 5% of frames late. Keeping each reply's thread chips and pictures worked
out between frames (they parse a reply's markdown whole) made no measurable
difference (9.20 to 9.05 ms), so it was left out. Where a frame goes
(`sample`): drawing it is 25% of the main thread's time, of which layout
14%, prepaint 15% and building elements 7%; the composer, drawn again on
every frame of the transcript's scroll though nothing in it changed, is
about a fifth of that.
