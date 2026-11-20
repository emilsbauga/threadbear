# A native Windows runner: the plan

Written 17 Nov 2026, from the 9 Nov audit (`runner-windows.md`), Keith's
fork as it stood on 10 Nov (`platima/main`, 113 commits; his GitHub repo is
gone now, so the local copy is all there is), and a look at the Dell XPS.

When this was written, a Windows PC ran the GPUI app natively and the runner
in WSL (Ubuntu 24.04, mirrored networking, a systemd unit copying the token
across). The goal was the runner running on Windows itself, installed and
kept up to date the way it is on the Mac, with WSL no longer needed. *Done:
since 19 Nov nothing uses WSL. The Dell's Ubuntu and its start-up task are
deleted, and the app no longer looks for the token WSL copied (it brings an
older app's settings across from that folder once).*

## Where things stood (17 Nov)

- **Main's runner has nothing for Windows yet.** Four files mention `win32`.
  Everything in the audit is still to do.
- **Keith's fork did most of the runner half**, on a base that is now 530
  runner commits behind: `platform.ts` (one place for what differs),
  `win32-hide.ts` (no console windows), `taskkill /T` kills checked against
  start times, Git Bash for patch actions and checks, a single-instance lock
  that doesn't fail open, a logon task installer (`install-windows.mjs`, which
  also fixed a real PATH-corrupting bug), `tb.cmd`, Node stand-ins for the
  `#!/bin/sh` fake CLIs in tests, a Windows CI job with a known-failing list,
  and a round of trust fixes from a six-reviewer pass (8.3 short names,
  `/c/Users` and `\\?\` spellings, `::$DATA`, SMB paths, `npm.cmd` and
  `powershell.exe` running unhashed scripts). He did not do releases or
  following main (his runner ran from the checkout and updated by installer),
  Job Objects, or the GPUI app (his UI was Tauri).
- A trial merge of his branch into main conflicts in 45 files.
- **The Dell is bare:** Windows 11 Home 26200, x64, no native Node, Git or
  Claude Code, 381 GB free.
- **The GPUI app looks for the runner at**
  `%USERPROFILE%\Library\Application Support\Threadbear` (the Mac's names,
  which is why the WSL setup copies the token there) on `127.0.0.1:8797`.

## Approaches

**A. Port main per the audit, taking Keith's pieces as they fit (my pick).**
Each slice brings in the matching part of his work as a commit with him as
author, rebased onto today's code, plus what he left out. Small landings,
each green on Mac, Linux and Windows CI, and the runner on Windows updates
itself from main like every other runner.

**B. Bring his branch in whole, then catch up.** Merge `platima/main`'s
runner and CI parts, fix 45 files of conflicts, then add releases and
follow-main. Faster to a first native thread, but one huge landing nobody
can review well, and his release model (installers, no follow-main) to undo.

**C. Keep Linux, hide WSL.** An installer that sets up and manages the WSL
runner for you. Cheapest, but it is still WSL (admin, a VM, a reboot on a
fresh PC), which is what you want gone.

## Slices (approach A)

1. **Foundations and a Windows CI job.** `platform.ts`, one spawn wrapper
   with `windowsHide`, `path.delimiter`, `expandHome` for `~\`, case-folding
   `isInside`, `.gitattributes` keeping `*.sh` LF, Node stand-ins for the
   shell fakes in tests. A `windows-latest` job in `runner.yml`: typecheck
   plus every test file not on a known-failing list that only shrinks.
   Changes nothing on the Mac.
2. **One thread natively, from source.** `claude.exe`, Git for Windows'
   `bash.exe` (never `System32\bash.exe`), `CLAUDE_CODE_USE_POWERSHELL_TOOL=0`
   so the `Bash` gates still hold, kills by `taskkill /T` checked against
   start times, the runner lock by start time, `getuid` guards, npm through
   `npm-cli.js`, `tb.cmd`, graceful stop over the IPC channel. Tried on the
   Dell on a spare port with a temp data folder and Haiku.
3. **Install and update.** `install-runner` gets a Windows path: a per-user
   Scheduled Task at logon (no admin, restarts on failure, keeps running on
   battery), started through a windowless launcher so nothing flashes up.
   Node 24 and Git are fetched per user (no UAC prompt), Claude Code by its
   own installer. Releases use a `current` text file instead of a symlink and
   a junction for `node_modules`; `deploy.mjs` becomes three-way; the runner
   follows main and hands over to a new release as on the Mac.
4. **Move the Dell XPS over.** The native runner takes the WSL one's
   runner id and key (no fifth key) and its threads, then the WSL runner is
   stopped and its units turned off. The app's `default_home` and the
   runner's data folder move to `%LOCALAPPDATA%\Threadbear` together, with
   the app still reading the old place for one release.
5. **The native helper and security parity.** A small Rust exe (it builds
   in the desktop workspace's CI already): Job Objects so nothing a thread
   started outlives it, the process table, which process owns a socket (peer
   identity), idle time and keep-awake. *Done differently (18 Nov): the
   helper is one hidden PowerShell the runner keeps
   (`runner/src/win32-helper.ps1`), with kernel32 declared in memory for
   the Job Objects, so there's no binary to build, ship or keep up to date;
   peer identity and Job Objects are in, idle time and keep-awake not yet.*
   Then the secrets guard's Windows
   forms, Keith's trust fixes, git hooks off `/dev/null`, ACLs on
   `secrets\`. Another lab tries to break each before it's called done.
   *18 Nov: the guard's Windows forms (from Keith's fork), the ACL (set by
   the helper, before the token is written) and hooks off `/dev/null`
   (plus hooks named in a repo's config, on every platform) are in, after
   five rounds of Codex's review. Keith's trust fixes are what's left.*
   *19 Nov: Keith's trust fixes are in, with four rounds of Codex's
   review. Each round still found about six ways round following a script
   on Windows, so there, for now, a project's patch and a folder's Claude
   Code settings run nothing by themselves: buttons run when clicked, and
   hooks, worktree setup and teardown, live functions' commands and
   Claude's hooks don't run (`clicksOnly` in `runner/src/platform.ts`).*
   *19 Nov: idle time and keep-awake are in, from the same helper
   (`GetLastInputInfo`, `SetThreadExecutionState`, `GetSystemPowerStatus`).
   Settings still shows the keep-awake switch on a Mac only, as its words
   say Mac; it's on by default, and `"keepAwake": false` in runner.json
   turns it off.*
   *19 Nov: following on Windows also hashes every file Windows could run
   by a bare name in the folders commands run from, so a program a pull
   drops there asks again, and refuses round 4's ways round
   NoDefaultCurrentDirectoryInExePath. Codex's sixth review still found
   gaps (a JS subprocess's cwd and package commands, a variable named by
   an expansion, which this repo's own scripts use, a DLL beside a repo
   program), so clicks-only stays on for now.*
6. **Polish.** Codex on Windows, pictures, stuck-job detection, a Windows
   check host, client path display (`C:\Users\...` shown as `~`).
   *19 Nov: pictures are converted with Windows' own imaging
   (`runner/src/win-image.ps1`, WIC through a hidden PowerShell; no SVG),
   the app shows a Windows home as `~` whatever its case or slashes
   (`abbreviate_home` in `desktop/core/src/new_thread.rs`, and every place
   that shortened paths on its own now uses it), and the test helpers run
   Git Bash rather than `/bin/sh`.*
   *19 Nov: Codex runs on the Dell as it is: the runner's own copy
   (`tools\codex`, 0.170.0) signed in as codex-main, in the Misc pool. A
   thread in Full ran a command (Codex uses PowerShell there) and
   Threadbear's tools; one in Ask put up an approval card for its
   PowerShell command, and ran it once allowed.*

Slices 1 to 4 replace WSL on the Dell. 5 is where it's as safe as the Mac.

## What stays Mac-only

Screen tools (`mac-screen`), the `swiftc` secret check, BrowserBear and
ComputerCub, `taskpolicy`, frozen-CLI detection (it watches for macOS
privacy prompts), and the repo's own dev scripts (`check.sh`,
`dev-runner.sh`), which run under Git Bash at best. On Windows, patches
and a folder's Claude Code settings run only what's clicked until following
a script there has no known gaps (slice 5's note).

## Things only Mike can do

- Sign in to Claude on the Dell once (slice 2). I'll start `claude auth
  login` over ssh and hand you the page on the Mac, so it shouldn't need the
  laptop itself.
- A WhatsApp to Keith saying his work is coming in under his name, if you'd
  like one.
