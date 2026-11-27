Feature: Section headings in the sidebar
  As someone with a long list of threads
  I want to fold sections away and choose the Inbox's order
  So I can keep what I'm working through in view

  Background:
    Given the app is connected to a runner with the demo threads

  @sidebar.sections
  Scenario: A folded heading says how many threads it's hiding
    Then the "Archived" section is folded
    And the "Archived" heading says "3"

  @sidebar.sections
  Scenario: An open heading doesn't count its threads
    Then the "Inbox" section isn't folded
    And the "Inbox" heading says nothing

  @sidebar.sections
  Scenario: Clicking a heading folds it, and clicking again unfolds it
    When I click the "Inbox" heading
    Then the "Inbox" section is folded
    When I click the "Inbox" heading
    Then the "Inbox" section isn't folded

  @sidebar.archived.paging
  Scenario: The Archived section draws the most recent few, and more on asking
    Given there are 30 more archived threads
    And the "archived" section is unfolded
    Then the Archived section draws 20 of its 33 threads
    When I ask for more of the Archived section
    Then the Archived section draws 33 of its 33 threads

  @sidebar.sort
  Scenario: The Inbox can be sorted oldest first
    Given the Inbox is sorted by what needs me first
    And "Ship the beta to TestFlight" comes before "Add dark mode to the dashboard" in the "Inbox" section
    When I sort the Inbox oldest first
    Then the Inbox is sorted oldest first
    And "Add dark mode to the dashboard" comes before "Ship the beta to TestFlight" in the "Inbox" section

  # A thread whose turn waits on a card (ask_secret, a question) goes first
  # whatever the order, as the card runs out: sorted oldest first it sat at
  # the bottom while Mike worked down from the top, and his password card
  # timed out unseen (19 Nov).
  # The Swift app is frozen (AGENTS.md, "The GPUI port"), so only the GPUI app has it.
  @sidebar.sort @swift-pending
  Scenario: A thread waiting on a card stays first when the Inbox is sorted oldest first
    Given the Inbox is sorted by what needs me first
    When I sort the Inbox oldest first
    Then the Inbox is sorted oldest first
    And "Stop Keep Awake asking for my password" comes before "Add dark mode to the dashboard" in the "Inbox" section
    And "Add dark mode to the dashboard" comes before "Compare SQLite and plain files for the runner" in the "Inbox" section

  # A tick beside the order it's in, in its own column beside the line's
  # icon, as a macOS menu has it (Mike, 12 Nov: the GPUI app's had none).
  @sidebar.sort
  Scenario: The sort menu ticks the order the Inbox is in
    Given the Inbox is sorted by what needs me first
    When I open the Inbox's sort menu
    Then the sort menu ticks "Needs you first" and nothing else
    When I sort the Inbox oldest first
    Then the Inbox is sorted oldest first
    When I open the Inbox's sort menu
    Then the sort menu ticks "Oldest first" and nothing else

  @sidebar.sections
  Scenario: A quiet thread with a check-in booked waits under Hibernating
    Given the "Inbox" section lists "Add dark mode to the dashboard"
    When a check-in is booked on "Add dark mode to the dashboard"
    And the "hibernating" section is unfolded
    Then the "Hibernating" section lists "Add dark mode to the dashboard"
    And the row "Add dark mode to the dashboard" says when its schedule messages it

  # Waiting on its own work isn't done: on 19 Nov a thread waiting for
  # main's CI before it could land showed Done, and Mike archived it with
  # nothing landed. It stays under Running until the work is over.
  @sidebar.sections
  Scenario: A thread waiting on another thread stays under Running
    Given the "Inbox" section lists "Add dark mode to the dashboard"
    When "Add dark mode to the dashboard" waits on "Ship the beta to TestFlight"
    Then the "Running" section lists "Add dark mode to the dashboard"
    And the row "Add dark mode to the dashboard" says "Waiting on" on the right

  @sidebar.sections
  Scenario: A thread waiting for the app to update stays under Running
    Given the "Inbox" section lists "Add dark mode to the dashboard"
    When "Add dark mode to the dashboard" waits for the app update
    Then the "Running" section lists "Add dark mode to the dashboard"
    And the row "Add dark mode to the dashboard" says "Waiting for the app update" on the right

  # The Swift app is frozen (AGENTS.md, "The GPUI port"), so only the GPUI app has these.
  @sidebar.sections @coordinators @swift-pending
  Scenario: Starred appears above Coordinators by default
    When I hover the row "Morning brief"
    And I press the row button "Star: keep at the top"
    Then the "Starred" section lists "Morning brief"
    And the "Starred" section comes before the "Coordinators" section
    And the "Coordinators" section comes before the "Inbox" section

  @sidebar.sections @swift-pending
  Scenario: Dragging a section heading folds open sections, reorders them live, and remembers the order
    When I hover the row "Morning brief"
    And I press the row button "Star: keep at the top"
    Then the "Starred" section lists "Morning brief"
    And the "Inbox" section comes before the "Running" section
    When I start dragging the "Running" heading to "Starred"
    Then the "Inbox" section is folded
    And the "Running" section comes before the "Starred" section
    When I drop the dragged section heading
    Then the "Running" section comes before the "Starred" section
    And the "Inbox" section isn't folded
    When the app is quit and opened again
    Then the "Running" section comes before the "Starred" section

  @sidebar.sections @swift-pending
  Scenario: Pressing Escape while dragging a section heading cancels the reorder
    When I hover the row "Morning brief"
    And I press the row button "Star: keep at the top"
    Then the "Starred" section lists "Morning brief"
    And the "Starred" section comes before the "Inbox" section
    When I start dragging the "Running" heading to "Starred"
    Then the "Running" section comes before the "Starred" section
    When I cancel the section heading drag
    Then the "Starred" section comes before the "Inbox" section
    And the "Inbox" section comes before the "Running" section
    And the "Inbox" section isn't folded
