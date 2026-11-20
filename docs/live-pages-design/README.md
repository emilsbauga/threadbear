# Live pages

Mike, 19 Nov 2026, from his phone while a thread showed him still renders of
his garden's 3D model with the Christmas light strings drawn on: "render 3D
objects like the one that you just showed me inside of Threadbear, both on
the mobile and on desktop, or render HTML inside iframes ... so I can kind of
like see it in real time, in line".

Three directions were mocked with a real three.js garden running inside
(thread ae88bd2c, review d3fda522): A, live pages (agent HTML with scripts,
sealed); B, a scene card (the app's own 3D viewer, data only); C, pinning a
dev server's URL. **Mike picked A.** B and C were passed over.

The prototype page is `~/dev/me/misc/live-3d-proto` (`build.py` makes
`out/garden-live.html`: one 5.5 MB file with three.js, the Draco decoder,
`garden04.glb` and 1,764 LED positions inline, no network).

## What it is

An agent writes a page as one self-contained `.html` file and puts it in its
reply as `![Garden lights](/path/garden.html)`, the way it shows a picture or
a video today, or pins it. Every surface shows it in the transcript as a
card: a still of the page with Run. Run turns its scripts on, there in the
card, still sealed. The full size button opens it big (a window on the Mac,
full screen on the phone).

- One file: what's inline is all it gets. Nothing beside it is served (the
  side pane's named assets stay a side pane thing), so it looks the same on
  the Mac, the phone and the web, which only ever get the one file.
- At most 10 MB, the reply media limit.
- Behind the `livePages` experiment, on for Mike.

## Sealed

What a running page can't do, on every surface:

- reach the network (no fetch, socket, WebRTC, prefetch, navigation, form,
  window, download);
- read anything but its own bytes (no files beside it, no other page's
  storage: a fresh opaque origin or a token origin per card, no persistent
  storage);
- leave its box (no top navigation, no popups, no dialogs, clipboard writes
  only through the existing guards);
- run while it isn't wanted: only after Run (per device, for those exact
  bytes, by digest), only while on screen, one running card at a time per
  window; scrolled away it pauses.

Run per page is the consent and the battery saver both. What's left once
it runs: it uses CPU and GPU while visible, and it can draw anything,
including something that looks like Threadbear asking for a password. With
no network, nothing typed into it can leave.

The upload: an agent could name any file with `.html` on the end, so the
runner sends only a file that looks like HTML (UTF-8, markup in its first
bytes), as reply pictures are checked to be pictures. Storage keeps it as
`application/octet-stream`, never `text/html`, so its URL opened in a
browser downloads rather than running on the backend's origin; the apps
fetch the bytes and load them into their sealed views.

## Each surface

| | Still | Running |
|---|---|---|
| Mac (GPUI) | a card with Run (no page made until then) | the side pane's sealed page view, placed in the card |
| iPhone | a card with Run | WKWebView, RichWebSandbox's rules, scripts on |
| Android | WebView, scripts off, blocking network loads | scripts on |
| Website | iframe, `sandbox=""` | `sandbox="allow-scripts"`, CSP `default-src 'none'` with inline and data: |

## Slices

1. Runner and backend (built, API 95): `.html` reply media goes up as a
   page, checked to be markup, stored as plain bytes, with `mediaType` on
   the phone's pictures. No new request, so no parity row; the phones and
   website show a page as the picture they can't load until their slices.
2. Mac (built): the reply's `![title](page.html)` becomes a card
   (`desktop/gpui/src/live_pages.rs`). Run shows the page there in the side
   pane's sealed page view (`web_panels::live_page`, a fresh token origin,
   served only while its bytes are the ones Run was pressed for), scripts
   on, with `worker-src blob:` added for a live page only, as three.js
   decodes models in a worker. The view is native, so it shows only while
   the whole card is in the transcript; partly scrolled out it hides and
   Chromium pauses it. One runs at a time; Stop closes its view. Full size
   (Mike, 20 Nov: "a bit small and can't be resized") moves the running
   page into the side pane, as wide as he drags it; the card says it's
   there, and Stop, Run on another or the pane closing stop it.
3. iPhone (built): `ios/Threadbear/LivePageView.swift`. Run fetches the
   bytes and runs them in a WKWebView with RichWebSandbox's dead proxy,
   fresh store and link guard, a rule list of about:, data: and blob: only,
   and a policy ahead of the page that it can only narrow; no alerts. Full
   screen from the card.
4. Website and Android.
5. Telling agents: the guide, and a line in what agents read about showing
   things (within the context budget).

## What the reviews found (Codex and Gemini, 19 Nov)

Fixed:

- A reply's `.html` was read with a plain `readFileSync`: a FIFO named
  `.html` (or `.png`, before this) held the runner up, and a link to
  `/dev/zero` read without end. `readCapped` now opens without waiting,
  checks it's a regular file on the descriptor and reads to the cap.
- A runner key's upload was stored with whatever type it said, so one
  that said `text/html` was a page on the deployment's origin behind the
  website's link to it. `/runner/upload` (and the relay's and phone's)
  now keep a picture's or video's type and make anything else plain bytes
  (`uploads.ts` `storedType`).
- An agent could write the card's fence itself and get a card with the
  experiment off, or in another Mac's thread. The fence's name now has a
  random part made at each start, so only the app's own rewrite makes one.
- The Mac served a live page its folder's named assets, which its scripts
  could read: a live page's site is now the page alone (`Site::page_only`).
- The Mac's sealed page views let a page open alert, confirm and prompt
  boxes and the file chooser (the side pane's Run them too): both refused
  now. The dead proxy didn't cover loopback: `<-loopback>`.
- A running page whose card went out of sight (another thread opened)
  kept its workers running hidden: it stops once its view has been hidden
  for three seconds (read from the view, as the app draws nothing while
  Mike drags inside the page). The card hashed the file every frame: it's
  checked once a second off the main thread.
- The iPhone's link guard ran in the page's own world, where its scripts
  could undo it: a copy runs in the app's world too. A page doesn't run
  if WebKit's switch for WebRTC is missing. Clipboard, file picker, share
  sheet and printing are locked away before the page's scripts run.
- The website drew a page as a broken picture linking to its file: it
  leaves it out. Android shows its title and where to open it.

Second round (the fixes above, again):

- `window.print()` put the Mac's print dialog over the app: locked in the
  page guard, and `printing.enabled` off where Chromium has it.
- iPhone: a long press on a link offered Open Link in Safari, taking the
  address out: link previews and the context menu are off. A page
  scrolled out of view kept running (the transcript keeps its rows):
  it stops on scroll visibility. A Stop while the rule list was still
  being made could still load the page: it doesn't now.
- A link named `.html` to some other kind of file went up if it read like
  markup: the runner checks the real name too.
- The iPhone's clipboard and file picker guard runs in the page's own
  world, so a page can get round it. Left as best effort: the view has
  no network, so nothing it gets that way can leave the phone.

For Mike:

- **The Mac's Chromium runs with its own sandbox off** (`host.rs`,
  `no_sandbox`), as it can't read the runtime in the data folder with it
  on. That was there before live pages: the side pane's Run them and the
  web panels (real websites) run under it too. A live page is
  agent-written script under it, so a Chromium exploit in one would have
  Mike's user's access. Turning the sandbox on means bundling the runtime
  in the app (docs/gpui-port.md, "Choice 1", option B).
  Mike, 20 Nov: not yet. Asked again at the experiment's check-in.

Not fixed, lower:

- A script can still make an `about:blank` frame whose fresh window
  hasn't had the clipboard guard yet (Mac); the page's view is sealed
  from the network either way.
- Mac sealed views share one in-memory cookie jar for the app's run, so
  one agent page can leave a cookie another reads.
- On the Mac, if DevTools refused to add the page guard, the page would
  load without it (the side pane's Run them as well); never seen.
- Any `.html` an agent names in a reply goes up to Mike's own backend
  when the experiment's on, as any picture it names does.
- The Mac's native view hides under the picture viewer and the pane's
  menu now, but can still draw over a few of the app's own overlays near
  the card (the transcript's fades, a link's peek).
