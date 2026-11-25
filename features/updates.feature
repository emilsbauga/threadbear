Feature: The Updates panel
  As someone whose runner and agent CLIs keep themselves up to date
  I want one place that says what's on its way and what's waiting for me
  So I can see an update coming, and act on the few that need me

  Background:
    Given the app is connected to a runner with the demo threads

  @updates.panel
  Scenario: It says how the runner's update is going and what each CLI has
    When the runner starts building main at "abc1234" for "Fix the thing"
    And I open the Updates panel
    Then the Updates panel lists "Building the runner from main at abc1234: Fix the thing."
    And the Updates panel lists "Claude Code 2.1.311, 2.1.312 available (automatic) [Update]"
    And the Updates panel lists "Codex 0.165.0 is held back because the app-server protocol changed (automatic) [Update anyway] [Go back to 0.163.0]"
    And the Updates panel lists "  Missing: thread/backgroundTerminals/list"

  @updates.panel
  Scenario: Update installs a CLI's new version, saying so while it runs
    When I open the Updates panel
    And I press "Install the new version now" in the Updates panel
    Then the Updates panel lists "Claude Code 2.1.311, 2.1.312 available (automatic): Updating Claude Code to 2.1.312"
    And the Updates panel lists "Claude Code 2.1.312, up to date (automatic)"

  @updates.panel
  Scenario: Update it updates Threadbear Runner from the panel, with no command to copy
    When the runner says Threadbear Runner.app is behind main
    And I open the Updates panel
    Then the Updates panel lists "Threadbear Runner.app was built from older launcher sources than main's. Updating it stops nothing; the new one starts next time your Mac restarts."
    And the Updates panel lists "  [Update it]"
    When I press "Put the new Threadbear Runner in place" in the Updates panel
    Then the Updates panel lists "Updating Threadbear Runner. Nothing stops; the new one starts next time your Mac restarts."
    And the Updates panel lists "  [Updating: busy]"
    And the Updates panel lists "The runner is up to date."

  @updates.panel
  Scenario: Mike's release says what's new, and Bring Them In starts a thread for it
    When Mike has a release of 10 Nov with 3 new changes
    And I open the Updates panel
    Then the Updates panel lists "Mike's release of 10 Nov has 3 new changes."
    And the Updates panel lists "  Runners in the app"
    When I press "Start a thread that merges Mike's release into your main" in the Updates panel
    Then a thread called "Bring in Mike's release of 10 Nov" opens

  # The What's new page's cards for the releases a fork doesn't have
  # (protocol "Mike's releases", changelog), which Mike picked over the
  # notes as text on 17 Nov 2026. A release the page has no entry for yet
  # keeps its notes.
  @updates.panel @swift-pending
  Scenario: Mike's releases show the What's new page's cards, counts and important fixes
    When Mike has releases of 14 to 16 Nov with cards on the What's new page
    And I open the Updates panel
    Then the Updates panel lists "[card] Pick who reviews code -> https://threadbear.mikecann.app/changelog#2026-11-16"
    And the Updates panel lists "[card] Open Anything (clip) -> https://threadbear.mikecann.app/changelog#2026-11-14"
    And the Updates panel lists "6 added, 20 changed, 14 fixed [See all -> https://threadbear.mikecann.app/changelog]"
    And the Updates panel lists "2 important fixes (tip: Pairing used a reusable token; A swapped file could launch an app)"
    And the Updates panel lists "## 15 Nov"
    And the Updates panel lists "  A note for a day the page hasn't got yet"

  # Someone's fork with changes of their own to the old Swift app (protocol
  # "Your changes to the old app"). The Swift app has nothing to rebuild.
  @updates.swiftchanges @swift-pending
  Scenario: My own changes to the old app are listed, and Port this starts a thread for one
    When my copy has 2 changes of its own to the old app
    And I open the Updates panel
    Then the Updates panel lists "You changed the old app in 2 places that aren't in this one yet. Port each to rebuild it here, or dismiss it."
    And the Updates panel lists "  Orange dock badge (2 Nov · abc1234 · Badge.swift)"
    And the Updates panel lists "  Bigger sidebar font (20 Oct · 0123456 · Sidebar.swift)"
    # A press goes to the last button with that tip: the second change's.
    When I press "Leave this change out of the new app" in the Updates panel
    Then the Updates panel lists "You changed the old app in 1 place that isn't in this one yet. Port it to rebuild it here, or dismiss it."
    When I press "Start a thread that rebuilds this change in the new app" in the Updates panel
    Then a thread called 'Rebuild "Orange dock badge" in the new app' opens
    And the Updates panel lists '  > Being rebuilt in Rebuild "Orange dock badge" in the new app'

  # The app's own update is made up (`updates` with `preview`): a scripted
  # app never follows main, as only the installed one does.
  # Exercised by core's BuildDebounce tests and remote lease tests. An
  # installed updater is required to observe this over real landings.
  @system.selfupdate @swift-pending @manual
  Scenario: Automatic update builds leave queued screen tests and timings ahead
    When several changes to the desktop app land on main within ten minutes
    Then the updater waits until the latest desktop tree has settled for ten minutes
    And it requests only that latest tree once no update build is running
    And a busy build Mac or one with timings queued makes it try again later
    And a build already running finishes with the host kept exclusive

  @system.selfupdate
  Scenario: The app's next version waiting says so in the Updates panel
    When the app's next version, def5678, is ready
    And I open the Updates panel
    Then the Updates panel lists "The app's next version (def5678) is ready. It switches in when you're not using the app, or now."

  # A message typed and not sent goes across a restart in the drafts file, so
  # it doesn't hold one off: Mike, 19 Nov, "just restart and put the text
  # back in the box". In front, it counts down from 5 s and starts again at
  # any input (core's restart_wait tests that, as a scripted app is kept
  # behind).
  @system.selfupdate @swift-pending
  Scenario: A message typed and not sent doesn't hold the next version
    When I open the thread "Morning brief"
    And I type "half a thought" in the composer
    And the app's next version, def5678, is ready
    And I open the Updates panel
    Then the Updates panel lists "The app's next version (def5678) is ready. It switches in when you're not using the app, or now."
    And a restart onto it waits for nothing

  # The Swift app's menu bar didn't show the made-up update's item within 5 s
  # of a script making it up (its SwiftUI commands, read by `menus`), so this
  # is only checked on the GPUI app for now.
  @system.selfupdate @swift-pending
  Scenario: Restart to Update is in the app menu once the next version is ready
    When the app's next version, def5678, is ready
    Then the app menu has "Restart to Update to def5678"

  # The Swift app builds where it is, so it never waits for a Mac.
  @system.selfupdate @swift-pending
  Scenario: A new version with no Mac to build it on says it's waiting for one
    When the app's next version is waiting for a Mac to build it on
    And I open the Updates panel
    Then the Updates panel lists "The app has a new version on main, waiting for a Mac to build it on."

  # On 20 Nov the ring turned for over an hour while the build sat behind
  # other threads' runs on Tinker Desk, and the panel only said it was
  # building, so Mike kept opening it to see.
  @system.selfupdate @swift-pending
  Scenario: A build queued behind other work on its Mac says so, and how long it's waited
    When the app's next version is queued behind other work on its Mac
    And I open the Updates panel
    Then the Updates panel lists "The app's next version is queued on build-mac behind 2 other runs (12 minutes so far)."

  # Mike opened Updates before hibernating a thread waiting on its fix, and
  # the panel couldn't say whether the fix was in yet. He picked a list of
  # the waiting threads there (review 0a7d18e2, 21 Nov).
  @system.selfupdate @swift-pending
  Scenario: The threads waiting on the app say which build has their fix
    When the app's next version is building
    And "Make uploads resume after a crash" is waiting on the app, its fix "building"
    And "Ship the beta to TestFlight" is waiting on the app, its fix "next"
    And I open the Updates panel
    Then the Updates panel lists "  Make uploads resume after a crash: In this build"
    And the Updates panel lists "  Ship the beta to TestFlight: Landed after it, in the next one"

  @system.selfupdate @swift-pending
  Scenario: A new version waits for nearby changes to settle before building
    When the app's next version is waiting for main to settle
    And I open the Updates panel
    Then the Updates panel lists "The app has a new version on main, waiting for two quiet minutes before building."

  # Check hosts only run tests: what an update's build host sends back runs
  # here, so it's only one named in updateBuildHosts (Daybreak 108). With
  # check hosts and none of those it builds nowhere and asks for one.
  @system.selfupdate @swift-pending
  Scenario: With check hosts but no update build host it asks for one
    When no Mac is trusted to build the app's next version
    And I open the Updates panel
    Then the Updates panel lists "The app isn't following main: no Mac is trusted to build it. Check hosts only run tests, so add one you trust with what this Mac runs to updateBuildHosts in runner.json."

  # Going in by itself: straight away with another app in front, and in front
  # once it's had five seconds with no input (core's should_auto_restart, with
  # its tests), but never over a menu that's open. Words typed in the message
  # box go across in the drafts file, so they don't hold it. The GPUI app
  # says what its once-a-second look sees (`updates` with `restartCheck`), as
  # a scripted app never restarts. The Swift app restarts in front only when
  # its handover would go unseen, and has no such check.
  @system.selfupdate @swift-pending
  Scenario: The next version waits to go in while a menu is open, not for words typed
    When the app's next version, def5678, is ready
    And I open the thread "Morning brief"
    Then a restart onto it waits for nothing
    When I type "half a thought" in the composer
    Then a restart onto it waits for nothing
    When I clear the composer
    Then a restart onto it waits for nothing
    When I open the Hibernate menu for "Morning brief"
    Then a restart onto it waits for the open menu

  # Codex's review of the restart, 12 Nov: a card's own answer, a shell
  # running something or typed in, and where the app comes back to.
  # A card's own answer goes across a restart in the drafts file, so it
  # doesn't hold one off: Mike, 19 Nov, "just reboot and then just put the
  # text back in the box".
  @system.selfupdate @swift-pending
  Scenario: My own answer to a card doesn't hold the next version, and comes back after it
    When the app's next version, def5678, is ready
    And I open the thread "Ship the beta to TestFlight"
    And I pick answer 1 of ask 1 on the card
    And I write "not before Friday" as my own answer to ask 2
    Then a restart onto it waits for nothing
    When I wait a moment
    And the app is quit and opened again
    And I open the thread "Ship the beta to TestFlight"
    Then ask 2 on the card is answered "something else: \"not before Friday\""
    And ask 1 on the card is answered "done"

  # Which field, not just "a field": a hold on words typed somewhere sat for
  # hours on 13 Nov with nobody able to find the box. And which thread, with
  # a way there: on 19 Nov one held it and he couldn't tell whose.
  @system.selfupdate @swift-pending
  Scenario: The next version names the field it's waiting for, and its thread
    When the app's next version, def5678, is ready
    And I open the thread "Ship the beta to TestFlight"
    # The panel first: a click on its icon mid-rename ends the rename
    # (Windows saves it as the box loses focus), and nothing's held then.
    And I open the Updates panel
    And I start renaming the open thread
    And I type "Beta on Friday" where the cursor is
    Then a restart onto it waits for the words typed
    And the Updates panel lists "The app's next version (def5678) is ready. It switches in once what you're typing in the title box in “Ship the beta to TestFlight” is sent, saved or cleared, or now."
    And the Updates panel lists "  > Ship the beta to TestFlight"

  # Windows has no foreground-process check for ConPTY yet. Every live shell
  # holds a restart, as it could be running a command the app cannot see.
  @system.selfupdate @swift-pending @windows-pending
  Scenario: The next version waits while a shell is typed in or running something
    Given the thread "Rename the Settings tabs" works in a folder of its own
    When the app's next version, def5678, is ready
    And I open the thread "Rename the Settings tabs"
    And I press ⌘J
    Then a restart onto it waits for nothing
    When I type "echo half" in the Terminal without pressing Return
    Then a restart onto it waits for the Terminal
    When I press Return in the Terminal
    Then a restart onto it waits for nothing
    When I type "sleep 30" and press Return in the Terminal
    Then a restart onto it waits for the Terminal

  @system.selfupdate @swift-pending
  Scenario: Back from restarting onto the next version, the list and the thread are as they were
    When the app comes back from restarting onto its next version on the Scheduled list with "Morning brief" open
    Then the sidebar shows the Scheduled list with "Morning brief" open

  # Each thread comes back where it was scrolled to, not just the one open
  # (the Swift app keeps only that one's): the spec reads what a restart
  # would save, then puts it back as a new launch would, with nothing
  # remembered or kept loaded.
  @system.selfupdate @swift-pending @long-thread
  Scenario: Back from restarting onto the next version, a thread I'd scrolled up in is where I left it
    When I open the thread "A very long thread"
    And I scroll up to the first row and read the rows on screen
    And I open the thread "Add dark mode to the dashboard"
    And the app comes back from restarting onto its next version with "A very long thread" open
    Then the view isn't at the bottom
    And what I was reading is still on screen

  # The new build starts under the old window, shows the same thread in the
  # same place and takes over, so the window never goes (handover.rs). A
  # scripted app never restarts itself and the two windows are two apps, so
  # it's checked by hand on a real screen. Only on a Mac so far.
  @system.handover @manual @windows-pending @linux-pending
  Scenario: Restarting onto the next version keeps the window on screen
    When the app restarts onto its next version with "Morning brief" open
    Then the window stays on screen showing "Morning brief" throughout

  # The quick way to take the app's update: a popover by the icon.
  @updates.popover
  Scenario: Right-clicking Updates offers Restart to Update once the next version is ready
    When the app's next version, def5678, is ready
    And I right-click the Updates icon
    Then the update popover says "A new version of the app is ready."

  @updates.popover
  Scenario: The update popover says when the app is up to date
    When I right-click the Updates icon
    Then the update popover says "The app is up to date."

  @updates.panel @swift-pending
  Scenario: An old web runtime says so in Updates
    When the web runtime needs a security update
    And I open the Updates panel
    Then the Updates panel lists "Web runtime: CEF is over two weeks behind stable. Chromium's sandbox is off."

  @updates.panel @swift-pending
  Scenario: A web runtime waiting on cef-rs is a quiet line in Updates
    When the web runtime is behind but waiting on cef-rs
    And I open the Updates panel
    Then the Updates panel lists "Web runtime: CEF is over two weeks behind stable. Waiting on cef-rs to support it. Chromium's sandbox is off."
