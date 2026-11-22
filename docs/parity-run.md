# The nightly parity run

Mike's setup only. `scripts/parity/nightly.sh` runs only when his schedule
calls it (`nightly.sh --check` at 2:00 and 4:00 from the M5), on a parity
host it finds in `THREADBEAR_PARITY_HOST` or `checkHosts` (Tinker Desk). It
needs things a fork doesn't have: Xcode, Chrome and Desk Runner on that
host, an Android SDK and emulator in `/Volumes/TinkerSSD/android-parity`,
and a Claude small-model pool on the Mac that calls it. Nothing in
`check.sh`, CI or setup runs it, so a fork without them never meets it.

What it does, per scenario (`runner/test/helpers/scenario-list.ts`, seeded
into a throwaway backend by `runner/scripts/parity-seed.ts`):

| Surface | How it's drawn | How its words are checked |
|---|---|---|
| Mac (GPUI), as another runner's thread | `mac-shots.sh`, `gpui-shots.ts` | the app's row dump |
| iPhone | `ios-shots.sh`, a simulator | the picture, read by macOS text recognition (`ocr.swift`) |
| Android | `android-shots.sh`, `android-shots.mjs`, a headless emulator (2 GB) | its accessibility tree (uiautomator) |
| Website | `web-shots.mjs`, headless Chrome | the page's text |

A word is checked on letters and digits only (`words.mjs`), so a wrapped
line or a curly quote isn't a miss. Then, back on the M5, `looks.ts` shows
Opus (through `models.pool`, the login with room) the Mac's picture beside
the iPhone's, Android's and the website's, and asks only for real
differences in content or structure: a missing note, another order, a
card drawn as plain text, a part in a different role. Its prompt lists
what never counts (the Mac's sidebar, banners, the message box, fonts,
card chrome like "Decision needed", folded activity rows).

Results go in `~/Library/Caches/Threadbear/parity/<time>/`: `index.html`
(the four pictures side by side, with what's missing or different),
`results.json` (`failures`: missing pictures and words; `differences`: the
looks check's; `lookErrors` when it couldn't compare), and `--check`
prints both, which is what starts a thread.

Debug builds only take a pairing from a launch: the iPhone's
`-ThreadbearPair`, Android's `parityUrl`/`parityToken` intent extras
(`AppModel.pairForParity`, a local http backend only).

Try a change from a worktree with `THREADBEAR_PARITY_REF=HEAD
scripts/parity/nightly.sh` (commit first: it copies that commit).
