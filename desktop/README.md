# Threadbear for Mac, Windows and Linux (GPUI)

One native desktop app, drawn with [GPUI](https://gpui.rs) (Zed's UI
framework) and [gpui-kit](https://gpui-kit.com)'s components. It's growing
to replace the Swift Mac app in `app/`; `docs/gpui-port.md` has the plan and
what's left. The iPhone app stays Swift.

Like the Mac app, it holds no agent state of its own. It talks to a runner
(`runner/`) over the protocol in [`../docs/protocol.md`](../docs/protocol.md).

So far it signs in to the runner, shows the inbox, opens a thread (live, as
it streams), answers a card's asks and approvals, sends messages and stops a
turn, in the Swift app's window: the panels in BearDock with the activity bar
and right rail, the thread's title line and menu, banners, notes, the menu bar
and the keyboard shortcuts. It starts new threads (the new-thread page, on any
runner) and offers the slash command palette. Other runners' threads are listed
and open through this Mac's runner.
The pane beside the thread has Highlights, file previews, Patches and the
folder browser.

## How it's put together

- **`core/`, what the app knows with no window**: the inbox rules, and
  `reducer/`, a port of how the Swift app turns events into rows, checked
  against golden files both languages test (`core/tests/golden`).
- **`dock/`, BearDock for GPUI**: splits, tabs, panel dragging and torn-out
  windows, the shell of the app's window (`gpui/src/shell.rs`). Its layout tree
  (`dock/layout`) has no GPUI in it and reads what the Swift `dock/` saved. See
  `dock/README.md`.
- **`gpui/src/settings.rs`, what the app remembers** (window frame, zoom,
  folds, the Inbox's sort, the panel layout): one JSON file in the runner's data
  folder, `desktop-settings.json`, keyed by the Swift app's UserDefaults names
  so a one-time import is mechanical.
- **`client/`, the runner connection** (`runner.rs`): the challenge sign-in
  (`auth.rs`, the same HMAC as `runner/src/rpc-auth.ts`), hello, requests and
  replies, and reconnecting when the runner restarts. `tests/mock_runner.rs`
  signs in to the mock runner.
- **`vendor/gpui-component/`, gpui-kit's components** as published, with
  their popup menus laid out as macOS's are, in the app's own softer look
  (`src/menu/mac_look.rs`), patched in
  from `Cargo.toml`. Why, and how to bump it: `docs/gpui-port.md`.
- **`vendor/gpui-base/` and `vendor/gpui-pre/`**, the kit's base and GPUI
  itself with input, text, test-support and file-drop fixes, and
  **`vendor/gpui-pre-macos/` and `vendor/gpui-pre-windows/`**, its Mac and
  Windows platforms with keyboard and pointer-leave fixes. The patches in
  `Cargo.toml` select them; their changes are listed there and in
  `docs/gpui-port.md`.
- **`gpui/`, the app.** GPUI has no tokio, so the connection runs on its own
  runtime and its events cross on a channel (`main.rs`). With the `automation`
  feature (never in a release) `automation.rs` takes the same scripted commands
  as the Swift app, which is how `features/` drives it.
- **Which runner.** The one in `THREADBEAR_HOME` (default `~/Library/Application
  Support/Threadbear`, which the runner uses on Linux too), on the port from
  its `runner.json` (default 8797), as `tb` finds it.

The vendored base text style has two opt-in settings for reply Markdown:
`table_natural_width` caps short tables at their measured content width, and
`list_item_gap` sets the space between items. The kit defaults stay unchanged;
`gpui/src/rows/markdown.rs` enables them for Threadbear replies.

## Run it

You need Rust (`rustup`) and Node 24. On a Mac you also need Xcode's command
line tools; on Windows, the C++ build tools. On Linux:

```bash
sudo apt install libasound2-dev libfontconfig-dev libwayland-dev libx11-xcb-dev libxkbcommon-x11-dev libzstd-dev libvulkan-dev
```

On a flaky connection, crates.io downloads need
`CARGO_HTTP_MULTIPLEXING=false CARGO_NET_RETRY=10`.

```bash
npm ci --prefix ../mock-runner   # for the tests and the mock
cargo run -p threadbear-gpui
```

To run it against the mock runner instead of your real one, start
`node ../mock-runner/server.mjs --data-dir /tmp/tb-mock` and run
the app with `THREADBEAR_HOME=/tmp/tb-mock`.

## Installing it on a Mac

The Swift app offers it ("Try the new Threadbear app", which runs
`scripts/switch-from-swift.sh`), or from a terminal:

```bash
scripts/install-app.sh                      # builds here, about 10 minutes
scripts/install-app.sh --build-on <host>    # builds on another Mac and copies it
```

That puts `Threadbear GPUI.app` in `~/Applications`, beside the Swift app, using
the same runner.

The installed app then follows main as the Swift app does
(`gpui/src/app_update.rs`, built on a check host), so after landing a change an
agent calls `wait_for_app_restart` and hears when it's back on the new build
(docs/protocol/updates.md, "App restarts"), then checks it with `tb export` of the
thread and the scripted app (below) rather than asking Mike.

## Hangs and crashes

The app freezing: read `~/Library/Logs/Threadbear/hangs/desktop` first
(`gpui/src/hang_watch.rs`); its panics are in
`~/Library/Logs/Threadbear/crashes/desktop`. Fix the frame a stall's sample
names rather than guessing from logs. The installed app of Mike's repo, on the
real data folder, sends panics, crashes and freezes of 15 seconds or more to
Sentry (`gpui/src/crash_reporting.rs`, tag `component` desktop); debug builds
never do.

## Tests

On a Mac, Settings > General > Testing > **Hide all testing windows** hides
new scripted GPUI test and debug copies, including their Settings windows and
dialogs. It is on by default. Turn it off before starting a copy to see its
windows; existing copies and the installed app are unaffected. Screenshots
still work while hidden. This controls Threadbear copies, not other apps.
`THREADBEAR_HIDE_TEST_WINDOWS=1` or `0` overrides one launch; visible pointer
tests belong on a separate test desktop. `THREADBEAR_TEST_WINDOW_SETTINGS`
can point an isolated run at a fixture settings file instead of the installed
app's `desktop-settings.json`.

```bash
cargo test    # the connection (with the mock) and the app's rules
```

`../features/README.md` has the behaviour specs, which run the real app on the
mock runner. Run Rust builds and suites elsewhere, never on the Mac someone is
working on: `scripts/remote.sh cloud -- <command>`, or `scripts/remote.sh
tinker-desk --desk -- <command>` for a window on a real Mac:

```bash
scripts/remote.sh cloud -- bash -c 'cd desktop && cargo test -p threadbear-core'
```

The file-drop dispatch tests use GPUI's test platform, exposed by `automation`.
The Desktop workflow runs them explicitly on Linux, Mac and Windows. To run
them on a check host:

```bash
scripts/remote.sh cloud -- bash -c 'cd desktop && cargo test -p threadbear-gpui --features automation --test file_drop'
```

`../check.sh` (and so `tb land`) runs `cargo test -p threadbear-core -p
threadbear-client` on its check host whenever something under `desktop/`
changed, and the full check adds `cargo check --workspace --all-targets`.

### Formatting

The Rust is formatted by `cargo fmt` (`rustfmt.toml`: the defaults with the
crates' edition), with the toolchain `../rust-toolchain.toml` pins, which
rustup fetches by itself. `../check.sh` (so `tb land`, `--quick` included)
and the Desktop workflow fail a change it would reformat. Before committing
Rust:

```bash
cd desktop && cargo fmt --all
```

It's light, so it runs on the M5 too (`taskpolicy -b` in front). The
generated CEF loader (`web/src/mac/loader.rs`) and `vendor/` are left as
they are. Everything was formatted at once in one commit, listed in
`../.git-blame-ignore-revs` (`git config blame.ignoreRevsFile
.git-blame-ignore-revs` makes blame look past it). A branch from before it
lands across it by itself; `../scripts/replay-over-format.sh` does the same
by hand.

### Lints

Clippy runs with the lints in `Cargo.toml`'s `[workspace.lints.clippy]`
(each says why it's there) and the settings in `clippy.toml`, and
`../check.sh` (`--quick` included, when `desktop/` changed) and the Desktop
workflow (Mac and Linux) fail on any warning. To see what it says, on a
check host:

```bash
scripts/remote.sh tinker-desk --build -- bash -c 'cd desktop && cargo clippy --workspace --all-targets -- -D warnings'
```

- An exception is `#[expect(clippy::<lint>, reason = "...")]` on the
  smallest item that needs it, not `allow`: an expect that's no longer
  needed fails, so a fixed site comes off the list. A bare `allow` without
  a reason fails too. `allow` (with a reason) is for code where the lint
  only fires on some platforms or features.
- `unwrap()` and `expect()` warn outside tests: handle the error, or mark
  the line with why it can't fail. A lock's poisoning is taken with
  `.unwrap_or_else(|e| e.into_inner())`.
- Every `unsafe` block has a `// SAFETY:` comment right above it saying why
  it holds; a public function that dereferences a raw pointer it's handed is
  an `unsafe fn` with a `# Safety` section.
- The baselines (functions over 200 lines, more than 7 arguments, and a few
  `expect`s) are marked "baselined ... 20 Nov 2026": take the mark off when
  the code is split up.
- The automation feature's code isn't in the gate (its builds differ by
  feature), and nor is Windows'.

### Loops between modules

The Rust structure workflow (`.github/workflows/structure.yml`) fails when
modules start using each other in a circle, or types and functions in
different modules start knowing each other in one: none of them can then be
read or changed alone. [deslop-please](https://github.com/deterministic-machines/deslop-please)
finds them; `scripts/structure-allow.txt` lists the ones there already, and
`scripts/structure.mjs` says what passes and why. It isn't in `../check.sh`,
as indexing the workspace takes a few minutes. To run it on a check host:

```bash
scripts/remote.sh tinker-desk --build -- bash -c 'cd desktop && rustup component add rust-analyzer && node scripts/structure.mjs'
```

A new loop usually goes by moving what both sides share into a module of its
own (`gpui/src/rows/parts.rs`, `web/src/mac/status.rs`), making one module a
child of the other (`dock/src/view/overlay.rs`), or handing one side a
callback (`PreviewLife`'s `OnClose` in `web/src/mac/preview.rs`).

`scripts/spec.sh` is the one-command version for use through `remote.sh`: it
builds the app (Swift or GPUI), keeps its own copy of the GPUI binary so another
checkout's build can't swap it mid-run (the cargo target folder is shared), and
runs specs by tag or takes a picture (`--shot "<thread title>" out.png`).

`desktop/test/auth-vector-*.txt` are fixed sign-in proofs. The Rust tests
check them, and so does `runner/test/unit/desktop-auth-vector.test.ts` with
the runner's own code, so if the runner's auth changes both sides fail until
they agree again.

`.github/workflows/desktop.yml` runs it all on Linux, Mac and Windows and
uploads each platform's binary as the run's artifacts.

## Seeing and driving it on a Mac

`scripts/dev-app.sh start --mock` runs the debug build with the scripted
control (`automation.rs`) with Mac windows hidden by default, against the mock runner or a
dev runner's `--home`, then `do`, `dump`, `shot`, `rebuild`, `log` and
`stop` drive it (`--help` says the rest). A scripted app refuses the real
data folder and its live runner (`--live` only if Mike says), and copies to a
pasteboard of its own (`gpui/src/scripted.rs`). It runs headless: out of the
Dock, its windows transparent and letting clicks through, still drawing for
`dump` and `shot`, and named "Threadbear Headless Tester" in ps (`--visible`
puts it on screen, labelled, for a test that needs that). Instances belong to
the thread and checkout that started them: without `--id` a command means your
newest one, never another thread's, `stop --all` stops only yours, and `status`
says whose is whose. An instance quits after an hour with no command.

- A UI change: `scripts/dev-app.sh start --mock` (the demo threads;
  `--appearance dark` for pictures), then drive it with
  `do '{"cmd":"open","id":"demo_upload"}' '{"cmd":"waitFor","loaded":true}'`
  (`click-at` with `x`, `y` for what has no label), read it with `dump` and
  look at it with `shot <file.png>`. After an edit, `rebuild` restarts it on
  the new build with the same thread open. Look at the images before saying
  it works, then `stop`. The commands are in `gpui/src/automation.rs` and the
  Swift app's README ("Seeing and driving it from a script").
- A scripted app is never in front, so opening a thread doesn't mark it read
  until you send `{"cmd":"focus"}`.
- A click that asks first says so: `click` and `click-at` reply "ok, and it
  brought up a dialog with Cancel, Archive" (its buttons). A busy row's
  Archive or moon (running, or waiting on you, as several demo threads are)
  asks before stopping the turn, while the `archive` command doesn't ask.
- A bug in one of Mike's real threads: `tb export <id>`, then
  `dev-app.sh start --mock --fixtures .fixtures/threads/<id>` and `open`
  it. Exports are his private conversations: keep shots of them out of git
  and delete them when done.
- A runner change seen in the app: start `runner/scripts/dev-runner.sh`, then
  `dev-app.sh start --home <dev home>` (it prints that line). A message sent
  from that app's composer is a real turn; `dump` shows the model it would use.
- `dev-app.sh log` shows the app's own log (connection, RPC errors, the
  commands it ran). Mike can right-click a row for "Copy debug info" or use
  "Copy thread id" in the ... menu to point you at what he's seeing.
- A cursor bug only shows with the real pointer: unit tests, `dump` and `shot`
  can't see it, and two fixes for the done card's "?" passed them and changed
  nothing Mike could see. On Tinker Desk's desktop (AGENTS.md, "Tests that
  need the real screen"), read `NSCursor.currentSystem` from a small separate
  process that moves the pointer with CGEvent, and only once `HIDIdleTime`
  says nobody is at it, putting the pointer and front app back afterwards.
  The dev window sits behind others, so float it first (a temporary
  `window.level`), or you're reading whichever app is on top, and check its
  log shows the moves arriving. Rest about a second as well as moving: a tip
  coming up makes AppKit work the cursor out again, and SwiftUI's view behind
  AppKit content answers with the arrow. Run it with the fix taken out too,
  to see it fail.

To film it for a clip, run `scripts/film.sh` from the M5 (`--help` has a
whole take). It starts the same app on Tinker Desk's desktop with `--film`:
a normal window in front with no test-copy label, on the mock runner with
your `MOCK_SCRIPTED_TURNS` file, moved onto a 2x virtual display
(`scripts/film/stage.m`) so the recording is sharp. Then `film.sh do` drives
it and `film.sh record` records the window with
`site/scripts/record-window.swift` and copies the `.mov` back. `--film`
refuses to start anywhere film.sh hasn't set it up, as its window comes to
the front.

The build runs on an `updateBuildHosts` Mac and comes back here, or runs here
through `scripts/one-build.sh` if none answers. Its Lucide
SVGs are embedded in debug builds too (`rust-embed/debug-embed` in
`gpui/Cargo.toml`), so it needs no files from that Mac's Cargo registry.
`cargo test -p threadbear-gpui --test assets` checks the whole icon catalog
comes from embedded bytes, even when the registry is present.

The printed build log receives both output streams as the build runs,
whether here or on another Mac. Failed builds keep the full log.

`context-menus` lists the popup menus actually drawn in the scripted window,
with each menu's item titles. It reads the rendered menus rather than
calling a menu builder, so a test can catch two menus opening for one click.

`peek` with `picture: true` reports the PDF/video hover card’s actual cached
image dimensions or its loading/failure state. On a Mac,
`bash desktop/scripts/test-media-hover.sh` checks descriptor ownership, bounds,
private snapshots and late decoder callbacks with generated media.

The Mac selection bridge is `gpui/src/native_text.rs` and
`native/text_selection.m`; Translate's public SwiftUI popover is the small
`native/translation.swift` anchor. A root plugin watches focus/selection
changes once per window. It passes frozen plain text to AppKit; a return
rechecks the original field, range, words and editability before an undoable edit.
`native-text` automation uses real AppKit requestors with unique pasteboards;
its test-only entrypoints are absent from release builds. Native focus specs
carry `@real-screen` and run on Tinker Desk under the host lease.

## Seeing it on a server

`scripts/shot.sh OUT_DIR [--home DIR] [--click X,Y | --type TEXT | --key KEY]... [--record S]`
runs the debug build (`cargo build -p threadbear-gpui`) on a virtual display
(Xvfb) with Mesa's software Vulkan, against the mock (or the runner in
`--home`), and saves screenshots: `0.png` before any step, then one after
each. `--record S` also films the window through the steps for S seconds to
`clip.mp4` (needs ffmpeg), for motion when no Mac's screen is free. Under
`remote.sh cloud` it finds the build in `$CARGO_TARGET_DIR` by itself:

```bash
scripts/remote.sh cloud -- bash -c 'cd desktop && cargo build -p threadbear-gpui && scripts/shot.sh /tmp/out --record 6 --key Return'
scp 'cloud:/tmp/out/*' .
```

## Custom tasks and accounts

The fork's saved tasks live in **Backlog**, separate from **Inbox**. Save a
new prompt from the composer's + menu or Send's right-click menu without
starting an agent. Reopen it to edit; changes, whitespace, pictures and
imported files save to the runner. Imported files can be previewed or removed.
Highlights shows prepared task context separately from the prompt.
An idle conversation's menu offers Move to Backlog and Move to Inbox;
Backlog and Archived chats offer confirmed deletion to the runner's trash.

Configured Pi profiles and accounts retain their provider/model metadata.
Pi's sign-in opens its interactive CLI with `/login` guidance, and its
model picker avoids Claude aliases and only offers advertised effort levels. General settings
includes Evolving titles; names you choose remain fixed. Codex skill results
refresh after login/folder changes and rank their displayed titles first.

## Known gaps

- On Windows, path handling (`folderName` splits on `/`) and the runner's
  data dir are still Mac-shaped. The runner itself doesn't run on Windows
  yet.
