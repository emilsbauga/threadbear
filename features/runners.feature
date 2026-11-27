Feature: The Runners panel
  As someone whose threads run on more than one machine
  I want to see which machines are up, what they run and what's running on each
  So I can tell where my threads are and whether a machine needs a look

  Background:
    Given the app is connected to a runner with the demo threads

  @runners.panel
  Scenario: Each runner says it's up, for how long, and the commit it runs
    When I open the Runners panel
    Then the Runners panel says "All online"
    And the Runners panel shows "laptop" online on "c4d90ca"
    And the Runners panel shows "mac-mini" online on "51ae514"

  @runners.panel
  Scenario: A runner's details show its CPU, memory and disk
    When I open the Runners panel
    And I open mac-mini's details in the Runners panel
    And the runners send their figures
    Then the Runners panel shows "Memory 7.4 of 8 GB (high)" under "mac-mini"
    And the Runners panel shows "Disk 41 GB free" under "mac-mini"
    And the Runners panel shows "Apple M1, macOS 27.1" under "mac-mini"
    When I close mac-mini's details in the Runners panel
    Then the Runners panel shows no figures under "mac-mini"

  @runners.panel @remote-threads
  Scenario: A runner lists the threads running on it, and one opens from there
    When I open the Runners panel
    Then the Runners panel shows "> Render the shed walkthrough" under "mac-mini"
    When I press "Open Render the shed walkthrough" in the Runners panel
    Then the open thread is "Render the shed walkthrough"

  # The Swift app's cards move by a real drag, which its scripts can't make
  # without the real pointer (AGENTS.md, "Tests that need the real screen").
  @runners.panel @swift-pending
  Scenario: Dragging a runner's card changes the order
    When I open the Runners panel
    And I drag "mac-mini" onto "laptop" in the Runners panel
    Then the Runners panel lists "mac-mini" before "laptop"

  # Another runner's Claude logins get a year-long token from here: that
  # runner runs claude setup-token, the page opens in the browser, and the
  # code it ends on comes back from the clipboard. The Swift app is frozen
  # and never had it. At CI's Mac window size the login's buttons are below
  # the panel's fold, so a press scrolls to them as a person would.
  @runners.panel @swift-pending
  Scenario: A year-long token for another runner's login
    Given the window is 1024 by 675 points
    When I open the Runners panel
    And I open mac-mini's details in the Runners panel
    Then the Runners panel offers a year-long token for "alex@example.com" under "mac-mini"
    When I press "Make a year-long token for alex@example.com on mac-mini" in the Runners panel
    Then the Runners panel shows "  Approve it in your browser, press Copy code on the page it ends on, then Paste code." under "mac-mini"
    And the app opened the claude.ai page for that token
    When I copy "abc123#SomeoneElsesState0000"
    And I press "Send the code you copied from the page to that runner" in the Runners panel
    Then the Runners panel shows "  That isn't the code from this page." under "mac-mini"
    When I copy "abc123#MockState0123456789abcdef"
    And I press "Send the code you copied from the page to that runner" in the Runners panel
    Then the Runners panel shows "  Year-long token made." under "mac-mini"

  # Another runner can use this Mac's Claude logins: the switch sends the ones
  # with year-long tokens there, sealed to that runner's key, and keeps them
  # up to date; off takes them back off. The click shows at once and takes no
  # more clicks until this Mac's runner says how it went. The Swift app is
  # frozen and never had it.
  @runners.panel @swift-pending
  Scenario: Using this Mac's Claude logins on another runner
    Given the window is 1024 by 675 points
    And the runner holds shared logins
    When I open the Runners panel
    And I open mac-mini's details in the Runners panel
    Then the Runners panel shows "Use this Mac's Claude logins: off" under "mac-mini"
    When I press "Send this Mac's Claude logins with year-long tokens to mac-mini" in the Runners panel
    Then the Runners panel shows "Use this Mac's Claude logins: on (busy)" under "mac-mini"
    And the Runners panel shows "  Sending this Mac's logins…" under "mac-mini"
    When the runner lets the shared logins through
    Then the Runners panel shows "Use this Mac's Claude logins: on" under "mac-mini"
    And the Runners panel shows "  From this Mac: me@example.com" under "mac-mini"
    And the Runners panel shows "  Signed in there already: alex@example.com" under "mac-mini"
    When I press "Take this Mac's Claude logins off mac-mini" in the Runners panel
    Then the Runners panel shows "Use this Mac's Claude logins: off" under "mac-mini"
