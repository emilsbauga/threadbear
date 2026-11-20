Feature: Other runners' threads
  As someone with threads running on other machines
  I want them listed beside this Mac's, and to work with them here
  So it doesn't matter where a thread runs

  Background:
    Given the app is connected to a runner with the demo threads

  @sidebar.row.remote @remote-threads
  Scenario: Another runner's threads are listed with its machine
    Then the row "Check the photo library backup" is on the runner "On mac-mini"
    And the row "Check the photo library backup" has the machine tile
    And the row "Morning brief" isn't on another runner

  @sidebar.row.remote @remote-threads
  Scenario: Opening one shows its transcript
    When I open the thread "Tidy the media drive"
    Then the transcript shows my message "Find duplicate videos on the media drive."
    And the transcript shows a reply starting "Found 14 duplicates"
    And the composer is on the runner "mac-mini"

  @sidebar.move @remote-threads
  Scenario: An old index row cannot undo a move to another Mac
    When I open the thread "Morning brief"
    And its runner lets the thread go to mac-mini while the old Mac still lists it
    Then the box is locked, saying "Moving to mac-mini…"
    And the row "Morning brief" isn't on another runner
    When the destination lists the moved thread
    Then the row "Morning brief" is on the runner "On mac-mini"
    And the composer is on the runner "mac-mini"

  @sidebar.move @remote-threads
  Scenario: A moved open thread resumes when its destination lists it
    When I open the thread "Morning brief"
    And its runner lets the thread go to mac-mini
    Then the box is locked, saying "Moving to mac-mini…"
    When the destination lists the moved thread
    Then the row "Morning brief" is on the runner "On mac-mini"
    And the box isn't locked
    When a reply arrives on the destination
    Then the transcript shows a reply starting "The destination is serving this thread"

  @sidebar.move @remote-threads
  Scenario: A thread moved between two other Macs keeps its destination
    When I open the thread "Tidy the media drive"
    And its runner lets the thread go to "cloud"
    Then the box is locked, saying "Moving to cloud…"
    And the row "Tidy the media drive" is on the runner "On mac-mini"
    When the destination lists the moved thread
    Then the row "Tidy the media drive" is on the runner "On cloud"
    When a reply arrives on the destination
    Then the transcript shows a reply starting "The destination is serving this thread"

  @sidebar.move @remote-threads
  Scenario: A thread moved back to this Mac resumes here
    When I open the thread "Tidy the media drive"
    And its runner lets the thread go to "This Mac"
    Then the box is locked, saying "Moving to This Mac…"
    And the row "Tidy the media drive" is on the runner "On mac-mini"
    When the destination lists the moved thread
    Then the row "Tidy the media drive" isn't on another runner
    When a reply arrives on the destination
    Then the transcript shows a reply starting "The destination is serving this thread"
    And the row "Tidy the media drive" isn't on another runner

  @sidebar.move @remote-threads
  Scenario: A move back to this Mac arrives after its source has cleared the move label
    When I open the thread "Tidy the media drive"
    And its move to this Mac is claimed before the local thread arrives
    Then the row "Tidy the media drive" isn't on another runner
    When a reply arrives on the destination
    Then the transcript shows a reply starting "The destination is serving this thread"

  @sidebar.move @remote-threads
  Scenario: Restarting the index during a waiting move keeps the source until it really moves
    When I open the thread "Tidy the media drive"
    And the index restarts while its move to this Mac is waiting
    Then the row "Tidy the media drive" is on the runner "On mac-mini"
    When that waiting move is cancelled
    And a reply arrives on the destination
    Then the transcript shows a reply starting "The destination is serving this thread"
    And the row "Tidy the media drive" is on the runner "On mac-mini"

  # Daybreak 113: a secondary runner taking its row out and putting it back
  # while a move here waits made the thread look like this Mac's, its box
  # unlocked, while every message still went to that runner.
  @sidebar.move @remote-threads
  Scenario: A thread on its way here stays its old runner's, locked, until this Mac has it
    When I open the thread "Tidy the media drive"
    And its runner lets the thread go to "This Mac"
    Then the box is locked, saying "Moving to This Mac…"
    And the row "Tidy the media drive" is on the runner "On mac-mini"
    When its old runner lists the thread again
    Then the box is locked, saying "Moving to This Mac…"
    And the row "Tidy the media drive" is on the runner "On mac-mini"
    And the composer is on the runner "mac-mini"

  # Its picture is a path on mac-mini: asked of the runner, which gets a
  # picture pasted there from the backend (API 87), never whatever this Mac
  # has at that path.
  @transcript.images @remote-threads @swift-pending
  Scenario: Another Mac's pasted picture comes from that Mac
    When I open the thread "Check the photo library backup"
    Then the pictures of my message say "picture"

  # A click on it opens the viewer, as one of this Mac's does (Mike, 18 Nov:
  # it showed, but a click on it opened nothing).
  @transcript.images @remote-threads @swift-pending
  Scenario: A click on another Mac's picture shows it in the viewer
    When I open the thread "Check the photo library backup"
    And the pictures of my message say "picture"
    And I click picture 1 of my message
    Then the viewer shows picture 1 of 1 "backblaze.png"

  # Its chip names the same file on mac-mini: pressed, it opens that Mac's
  # picture in the viewer, never this Mac's file at that path (Codex, 12 Nov).
  @rich.picturechips @remote-threads @swift-pending
  Scenario: Another Mac's picture chip opens that Mac's picture
    When I open the thread "Check the photo library backup"
    Then pressing the picture chip in my message opens picture 1 of 1 "backblaze.png"

  # One that Mac never put up (an older runner's): the tile says it couldn't
  # get it, rather than showing a file of this Mac's.
  @transcript.images @remote-threads
  Scenario: Another Mac's picture it couldn't get says where it is
    Given mac-mini's pasted pictures were never put up
    When I open the thread "Check the photo library backup"
    Then the pictures of my message say "Couldn't get it from mac-mini"

  # Its chip still opens the viewer, which says it couldn't show it rather
  # than "Loading…" for ever (Codex, 18 Nov).
  @rich.picturechips @remote-threads @swift-pending
  Scenario: Another Mac's picture chip says when the picture couldn't be got
    Given mac-mini's pasted pictures were never put up
    When I open the thread "Check the photo library backup"
    And the pictures of my message say "Couldn't get it from mac-mini"
    Then pressing the picture chip in my message says it couldn't show picture 1 of 1 "backblaze.png"

  @sidebar.row.remote @remote-threads
  Scenario: It takes a message like any other thread
    When I open the thread "Tidy the media drive"
    And I send "Keep the copies in Inbox for now"
    Then the transcript shows my message "Keep the copies in Inbox for now"

  @composer.runner @remote-threads
  Scenario: The new-thread page offers each machine, with the default starred
    When I start a new thread
    Then the "runner" menu has a row "[x] This Mac *"
    And the "runner" menu has a row "[ ] mac-mini"

  @composer.runner @remote-threads
  Scenario: Picking a machine is where the thread will start
    When I start a new thread
    And I pick "mac-mini" from the "runner" menu
    Then the composer is on the runner "mac-mini"
    And the note under the box says "Starts in misc on mac-mini, with alex"
    And the "runner" menu has a row "[x] mac-mini"

  # There's no folder picker for another Mac, so Other… asks for its path
  # (`typeRemoteFolder`). The Swift app has it under "+" › Folder, and its
  # automation, frozen since 12 Nov, can't open that dialog.
  @composer.runner @remote-threads @swift-pending
  Scenario: A new thread on another machine can start in a folder typed in
    When I start a new thread
    And I pick "mac-mini" from the "runner" menu
    Then the "runner" menu has a row "    [ ] Other…"
    When I type "/Users/alex/dev/backup" as the folder on that machine
    Then the note under the box says "Starts in backup on mac-mini, with alex"
    And the "runner" menu has a row "    [x] /Users/alex/dev/backup"

  @composer.runner @remote-threads
  Scenario: A new thread started on another machine is listed as its
    When I start a new thread
    And I pick "mac-mini" from the "runner" menu
    And I send "Check the backup drive's health"
    Then a thread called "Check the backup drive's health" opens
    And the transcript shows my message "Check the backup drive's health"
    And the row "Check the backup drive's health" is on the runner "On mac-mini"

  @sidebar.move @remote-threads
  Scenario: A moved thread stays in the sidebar before its destination lists it
    When I open the thread "Morning brief"
    And its runner lets the thread go to mac-mini
    Then the box is locked, saying "Moving to mac-mini…"
    And the row "Morning brief" isn't on another runner

  @sidebar.move @remote-threads
  Scenario: Move to offers the other machines from the row
    When I right-click the row "Morning brief"
    Then the row's menu offers "Move to"

  # The machine chip under the box: where the thread is, and a menu to move
  # it, as Capy's "Cloud ▸ Move to a device" (Mike, 17 Nov). The Swift app
  # is frozen and has only the row's Move to.
  @sidebar.move @remote-threads @swift-pending
  Scenario: The machine chip under the box moves the thread
    Given a move would leave nothing behind
    When I open the thread "Morning brief"
    Then the box's machine menu reads "✓ laptop, Move to mac-mini"
    When I pick "Move to mac-mini" from the box's machine menu
    Then the box's machine menu reads "✓ laptop, Cancel Move"
    And nothing asked the runner to cancel a move

  # Mike, 18 Nov: moving a thread back from Hetzner, "Moving to M5" spun
  # for a second, then went with the box open again while his Mac's
  # runner asked where it would go, and came back once the move began: the
  # row coming in meanwhile, without the move, took the app's guess away.
  @sidebar.move @remote-threads @swift-pending
  Scenario: The box stays locked while the runner works out where the thread would go
    Given a move would leave nothing behind
    And the runner is slow to say where a thread would go
    When I open the thread "Tidy the media drive"
    And I pick "Move to laptop" from the box's machine menu
    Then the box is locked, saying "Moving to laptop…"
    When the thread's row comes in again while it looks
    Then the box is locked, saying "Moving to laptop…"
    And the row "Tidy the media drive" says "Moving to laptop" on the right
    When the runner says where it would go
    Then the box is locked, saying "Moving to laptop once this turn ends…"
    And nothing asked the runner to cancel a move

  # Codex's review of that fix: Cancel Move while the runner was still
  # looking reached a runner with no move to cancel, and the move started
  # anyway once the look came back.
  @sidebar.move @remote-threads @swift-pending
  Scenario: Cancel Move while the runner is still looking stops the move
    Given a move would leave nothing behind
    And the runner is slow to say where a thread would go
    When I open the thread "Tidy the media drive"
    And I pick "Move to laptop" from the box's machine menu
    Then the box is locked, saying "Moving to laptop…"
    When I pick "Cancel Move" from the box's machine menu
    Then the box isn't locked
    When the runner says where it would go
    Then no move has started
    And the box isn't locked

  @sidebar.move @remote-threads
  Scenario: The sheet opens when something won't come with it
    When I ask to move the thread "Morning brief" to "mac-mini"
    Then the move sheet says "Move “Morning brief” to mac-mini"
    And the move sheet warns "1 background job, which gets stopped"
    And the move sheet offers the folder "/Users/alex/code/threadbear-threads/slot-4"
    And the move sheet's login is "claude-main"

  # The sheet asks the other runner as it's made, inside the app's own
  # update, and it read the app back for the runner's connection, which
  # crashed the GPUI app (a double lease, 12 Nov).
  @sidebar.move @remote-threads
  Scenario: Move to while this Mac's runner is away opens the sheet to wait
    When the runner goes away without a word for 8 seconds
    And the app has lost the runner
    And I ask to move the thread "Morning brief" to "mac-mini"
    Then the move sheet says "Move “Morning brief” to mac-mini"

  @sidebar.move @remote-threads
  Scenario: Moving from the sheet takes it off, and says so on the row
    When I ask to move the thread "Morning brief" to "mac-mini"
    Then the move sheet says "Move “Morning brief” to mac-mini"
    When I press Move in the move sheet for "mac-mini"
    Then the move sheet is closed
    And the row "Morning brief" says "Moving to mac-mini" on the right

  @sidebar.move @remote-threads
  Scenario: With nothing to decide, it goes straight away
    Given a move would leave nothing behind
    When I ask to move the thread "Morning brief" to "mac-mini"
    Then the row "Morning brief" says "Moving to mac-mini" on the right
    And the move sheet stayed closed
    And the move was started with the preview it showed

  # Daybreak 142 (16 Nov 2026): a clone is shown first, where from and to,
  # and Move then starts exactly the look that showed it.
  @sidebar.move @remote-threads
  Scenario: A move that would clone the repo shows where from and to first
    Given a move would clone its repo from "git@github.com:alex-example/foo.git" to "/Users/alex/code/foo"
    When I ask to move the thread "Morning brief" to "mac-mini"
    Then the move sheet says it clones from "git@github.com:alex-example/foo.git" to "/Users/alex/code/foo"
    When I press Move in the move sheet for "mac-mini"
    Then the move sheet is closed
    And the move was started with the preview it showed

  # Security review, 17 Nov 2026: a folder typed and not yet looked at went
  # without the look, so the runner's own (never shown) decided the move.
  # Move looks at it first and shows that; Move again starts it.
  @sidebar.move @remote-threads
  Scenario: A folder typed in the move sheet is looked at before the move starts
    When I ask to move the thread "Morning brief" to "mac-mini"
    Then the move sheet says "Move “Morning brief” to mac-mini"
    When I type "/Users/alex/dev/other" as the move sheet's folder
    And I press Move in the move sheet for "mac-mini"
    Then the move sheet offers the folder "/Users/alex/dev/other"
    And no move has started
    When I press Move in the move sheet for "mac-mini"
    Then the move sheet is closed
    And the move was started with the preview it showed, for the folder "/Users/alex/dev/other"

  @sidebar.move @remote-threads
  Scenario: A moving row offers Cancel Move instead
    Given a move would leave nothing behind
    When I ask to move the thread "Morning brief" to "mac-mini"
    Then the row "Morning brief" says "Moving to mac-mini" on the right
    When I right-click the row "Morning brief"
    Then the row's menu offers "Cancel Move"

  # Anything typed or answered while it moves could land on the wrong side
  # of the move, so the box and its card wait (ComposerView's `moving`). The
  # Swift app's dump, frozen since 12 Nov, has no "moving".
  @sidebar.move @remote-threads
  Scenario: The box is locked while its thread moves, and given back when the move is called off
    Given a move would leave nothing behind
    When I open the thread "Morning brief"
    And I ask to move the thread "Morning brief" to "mac-mini"
    Then the box is locked, saying "Moving to mac-mini once this turn ends…"
    When I cancel the move of "Morning brief"
    Then the box isn't locked

  @composer.runner @remote-threads
  Scenario: The star sets where new threads start
    When I start a new thread
    And I make "mac-mini" the default runner
    Then the "runner" menu has a row "[x] mac-mini *"
    And the composer is on the runner "mac-mini"
    When I make "This Mac" the default runner
    Then the "runner" menu has a row "[x] This Mac *"
