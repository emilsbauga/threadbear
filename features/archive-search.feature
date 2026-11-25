Feature: Searching Agent Archive from the sidebar
  As someone whose agents' history is in Agent Archive
  I want the thread search to find sessions in the archive too
  So I can find what was said anywhere, outside Threadbear and before it, in one place

  # Experiment archive (runner/src/experiments/archive.md; docs/protocol/threads.md,
  # "Searching Agent Archive"): the GPUI app only. The Swift app is frozen and
  # won't get it. The mock's TB_MOCK_ARCHIVE has made-up sessions about SQLite;
  # one belongs to the demo thread "Compare SQLite and plain files for the
  # runner" and one to "Make uploads resume after a crash".

  Background:
    Given the app is connected to a runner with the demo threads

  @sidebar.search.archive @archive @swift-pending
  Scenario: The archive's sessions come after the threads, the words marked
    When I search the threads for "sqlite"
    Then the sidebar lists "Compare SQLite and plain files for the runner"
    And the archive lists "Keep the upload queue in SQLite" under "Claude · photo-sync"
    And the archive lists "Is SQLite fast enough for 50,000 photos?" under "Codex · misc"
    And the archive marks "SQLite" in "Keep the upload queue in SQLite"
    And the archive doesn't list "Compare SQLite and plain files for the runner"

  @sidebar.search.archive @archive @swift-pending
  Scenario: A session opens read-only, at the message that matched
    When I search the threads for "sqlite"
    And I open "Keep the upload queue in SQLite" from the archive
    Then the archived session "Keep the upload queue in SQLite" is open read-only
    And its marked message says "one row per file"
    And its messages mark "SQLite"
    And the archived session has "Open in the archive" and "New thread from this"

  @sidebar.search.archive @archive @swift-pending
  Scenario: New thread from this starts a thread that names the session
    When I search the threads for "sqlite"
    And I open "Keep the upload queue in SQLite" from the archive
    And I click "New thread from this" under the archived session
    Then the new thread's box says "Pick up from this archived session: \"Keep the upload queue in SQLite\" (Agent Archive thread k57a2mq9x4rd8vbn3hcw6tzy1pejf0su)"

  @sidebar.search.archive @archive @swift-pending
  Scenario: A session that belongs to a thread opens the thread
    When I search the threads for "resume point"
    And I open "Make uploads resume after a crash" from the archive
    Then the thread "Make uploads resume after a crash" opens in place of a read-only session

  @sidebar.search.archive @archive @slow-archive @swift-pending
  Scenario: A row says the archive is being searched until it answers
    When I search the threads for "sqlite"
    Then the archive says it's searching
    And the archive lists "Keep the upload queue in SQLite" under "Claude · photo-sync"

  @sidebar.search.archive @archive @swift-pending
  Scenario: A search the archive can't answer says why
    When I search the threads for "offline"
    Then the archive says "Couldn't reach Agent Archive: its server didn't answer in 20 seconds."

  @sidebar.search.archive @swift-pending
  Scenario: With the archive off, the search is the threads alone
    When I search the threads for "sqlite"
    Then the sidebar lists "Compare SQLite and plain files for the runner"
    And the sidebar shows nothing from the archive
