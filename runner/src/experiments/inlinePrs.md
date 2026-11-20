---
id: inlinePrs
name: Pull requests in the side pane
title: Pull requests in the side pane: a PR link opens as a tab beside the thread, with its diff, checks and Merge
added: 2026-11-18
on: false
reminder: 13927306
---

## What it does

A GitHub pull request link clicked in a reply, or in Highlights' Links, opens as a tab in the pane beside the thread instead of your browser (⌘-click still goes to the browser). A PR link in a reply has GitHub's pull request mark before it, green while it's open, grey as a draft, purple once merged and red if closed. The tab has the PR's title, who opened it and when, its branch with lines added and removed, its status (approved, changes asked for, conflicts, merged, closed), and its checks, with any that failed named. Below that: the description, comments and reviews, and a box to comment on GitHub. Diff shows every changed file, each folding open or shut; Checks lists each check with its time, and clicking one opens its log. Review approves it or asks for changes (with what you typed in the comment box), and Merge merges it the way its menu's Default says (rebase, squash or a merge commit, whichever the repo allows). Close without merging is at the bottom. Every button spins until GitHub has answered, then the PR is read again. Start a thread puts the PR in a new thread's message box in the same folder; Ask Claude to review starts a thread there that reads the PR and says whether to merge it, without touching it on GitHub. Resting the pointer on a PR link starts reading it, so it's usually there by the time you click, and so does opening a thread whose last few messages link to PRs, or a turn ending with one. Grey shapes show where the PR will go while it's read, and the PR shows while its changes are still on their way. A PR you've opened before shows straight away as it was last time while it's read again, with its buttons waiting until GitHub has answered; one read more than a minute ago is read again behind it each time you open it. The app keeps the last 200 PRs it read in its cache folder for this. Each PR you open stays as a tab at the top of the pane until you close it, and Back goes to Highlights. It uses the gh command line tool, signed in as whoever `gh auth login` made it, so it needs gh installed and signed in. Desktop (GPUI) app only.

## Lives in

`runner/src/github-pr.ts` (reading a PR, its diff and its repo's merge methods through gh, and the merge, close, reopen, comment and review actions), the `github.pr`, `github.prFiles`, `github.prStates` and `github.prAct` requests in `runner/src/rpc.ts`. In the GPUI app: the tab in `desktop/gpui/src/pr_view.rs`, `Target::Pr` and the Merge and Review menu actions in `highlights.rs`, its arms in `files.rs`, the link click and the read started by resting on a link (`preload_pr`) in `reply_links.rs`, the reads as a thread shows or a turn ends (`preload_recent_prs`) in `thread.rs`, the copy kept between runs (`mod cache` in `pr_view.rs`, in `~/Library/Caches/Threadbear/prs`), the marks before PR links in replies (`PrMarks`, put in by `with_link_marks` in `chips.rs`) (`open_pr_link`, and the starred merge method in its prefs), and the rules and words in `desktop/core/src/pull_requests.rs`. The app learns it's on from `hello`'s `experiments`.

## Taking it out

Delete `runner/src/github-pr.ts` and its test, the four `github.*` cases and `reqPrRef`/`ghCall` in `rpc.ts`, and "Pull requests" in `docs/protocol.md`. In the app delete `pr_view.rs` and `core/src/pull_requests.rs`, `Target::Pr` and its arms, `PrMarks` and the PR half of `with_link_marks`, the `PrMerge`, `PrMergeDefault` and `PrReview` menu actions, the `prs` field on `SidePane`, the PR checks in `SidePane::follow_link` and `ThreadPane::follow_link`, `pr_merge_method` and `preload_pr` in `reply_links.rs`, and `preload_recent_prs` and its calls in `thread.rs`.
