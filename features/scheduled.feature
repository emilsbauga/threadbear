Feature: Scheduled messages
  As someone who leaves messages to send themselves later
  I want every schedule in one list, with what's coming up and what went wrong
  So I can see at a glance what will happen, and change it there

  Background:
    Given the app is connected to a runner with the demo threads

  @schedule.list
  Scenario: Schedules fall under Active, Paused and Done
    When I click "Scheduled" in the activity bar
    Then the sidebar shows the "scheduled" view
    And the "Active" section lists "Check the CI run again"
    And the "Paused" section lists "Nightly backup report"
    And the "Done" section lists "Check the domain renewal went through"
    And the "Done" section is folded

  @schedule.list
  Scenario: A row says when it runs next, where it goes, and what went wrong last time
    When I click "Scheduled" in the activity bar
    Then the schedule "Check the CI run again" runs "in 40m"
    And the schedule "Check the CI run again" sends to "Why is the build slow on CI?"
    And the schedule "Photo library check" runs on "mac-mini" and sends to "New thread in Photos"
    And the schedule "Disk space report" notes "Waiting for mac-mini to run it"
    And the schedule "Weekly dependency check" notes "Skipped last run: the last thread it started was still running"
    And the schedule "Nightly backup report" runs "Paused"
    And the schedule "Nightly backup report" notes "Last run failed: the folder /Users/alex/dev/old-backups is gone"

  @schedule.page
  Scenario: The page beside the list says what's next and counts them
    When I click "Scheduled" in the activity bar
    Then the Scheduled page is in place of the thread
    And the page says what's next, starting "Next: "
    And the page's tiles include "6 On, 5 Repeating, 1 Set by a thread, 1 Paused, 49 Runs so far"

  @schedule.page
  Scenario: Picking a thread puts it back in place of the page, and the list stays
    Given the thread "Morning brief" is in the inbox
    When I click "Scheduled" in the activity bar
    And I pick the thread "Morning brief" from where I am
    Then no page is in place of the thread
    And the sidebar shows the "scheduled" view

  # Back to a page put the thread behind it back first and recorded that
  # as a place of its own, which cut off Forward (Codex's review, 11 Nov).
  @schedule.page @nav.history
  Scenario: Back from a thread picked beside the page brings the page back, and Forward the thread
    Given the thread "Rename the Settings tabs" is in the inbox
    When I open the thread "Morning brief"
    And I click "Scheduled" in the activity bar
    And I pick the thread "Rename the Settings tabs" from where I am
    Then no page is in place of the thread
    When I press the mouse's "back" button
    Then the Scheduled page is in place of the thread
    When I press the mouse's "forward" button
    Then no page is in place of the thread
    And the open thread is "Rename the Settings tabs"

  @schedule.list
  Scenario: Pausing a schedule moves it under Paused at once, and Resume brings it back
    When I click "Scheduled" in the activity bar
    And I hover the row "Weekly dependency check"
    Then the row "Weekly dependency check" offers the buttons "Run now, Pause, Delete"
    When I press the row button "Pause"
    Then the "Paused" section lists "Weekly dependency check"
    When I hover the row "Weekly dependency check"
    And I press the row button "Resume"
    Then the "Active" section lists "Weekly dependency check"

  @schedule.list
  Scenario: Another Mac's schedule is asked of that Mac
    When I click "Scheduled" in the activity bar
    And I hover the row "Photo library check"
    Then the row "Photo library check" offers the buttons "Ask mac-mini to run it now, Pause, Delete"

  @schedule.editor
  Scenario: New schedule opens the editor on weekdays at 9
    When I click "Scheduled" in the activity bar
    And I press the row button "Schedule a message for later"
    Then the schedule editor is open on a new schedule that repeats on "0 9 * * 1-5"

  # Mike's Main pool of Claude and OpenCode logins (21 Nov): the editor
  # listed only one kind's models, and a run went on whichever kind the
  # model's name suggested.
  @schedule.editor @swift-pending
  Scenario: A schedule on a pool of Codex and Claude logins lists both, and keeps the kind picked under
    Given there's a thread called "Tidy the garden notes" on alex+3 in the Personal pool
    When I open the thread "Tidy the garden notes"
    And I start a schedule from this thread that starts a new thread each time
    Then the schedule editor's model menu has a row "## Claude"
    And the schedule editor's model menu has a row "## Codex"
    When I pick "GPT-6.1-Sol" under "Codex" in the schedule editor's model menu
    Then the schedule would start its threads on "codex"
    And the schedule editor's model menu has a row "[x] GPT-6.1-Sol"

  @schedule.editor
  Scenario: A schedule opens in the editor with what it sends and when
    When I click "Scheduled" in the activity bar
    And I open the schedule "Weekly dependency check" in the editor
    Then the schedule editor is open on "Look for outdated npm and Swift packages in ~/code and list the ones worth updating." repeating on "0 10 * * 1"

  # Mike's daily brief (25 Nov): each morning's thread should land in
  # Starred, above the Inbox, without starring it by hand.
  @schedule.editor @swift-pending
  Scenario: A schedule that starts a new thread each time can star each one
    When I click "Scheduled" in the activity bar
    And I open the schedule "Weekly dependency check" in the editor
    Then the schedule editor doesn't star each new thread
    When I tick "Star each new thread" in the schedule editor and save it
    And I open the schedule "Weekly dependency check" in the editor
    Then the schedule editor stars each new thread
