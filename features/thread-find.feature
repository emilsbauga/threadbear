Feature: Find in the thread
  As someone looking for something said earlier in a thread
  I want ⌘F to find words in its transcript
  So I don't have to scroll and read the whole thread again

  # GPUI-only: the Swift app is frozen and hasn't got it (Mike asked for
  # the usual editor keys, 24 Nov), so every scenario here is @swift-pending.

  Background:
    Given the app is connected to a runner with the demo threads

  @transcript.find @swift-pending
  Scenario: Words only in a folded tool's output are found, and the tool opens to show them
    When I open the thread "Make uploads resume after a crash"
    And I look for "testServerOffsetWins" in the thread
    Then the thread's find bar says "testServerOffsetWins: 1 of 1"
    And the picked match is in the step "Run the upload tests", opened
    When I close the thread's find bar
    Then the thread has no find bar
    And the step "Run the upload tests" is still open

  @transcript.find @swift-pending
  Scenario: The thread's find bar starts from the newest match at the end of a thread, and goes round
    When I open the thread "Make uploads resume after a crash"
    And I look for "UploadTests" in the thread
    Then the thread's find bar says "UploadTests: 4 of 4"
    When I find the next match in the thread
    Then the thread's find bar says "UploadTests: 1 of 4"
    When I find the match before in the thread
    And I find the match before in the thread
    Then the thread's find bar says "UploadTests: 3 of 4"
    When I look for "zzz" in the thread
    Then the thread's find bar says "zzz: not found"

  @transcript.find @swift-pending
  Scenario: Find in Thread is in the Edit menu on ⌘F
    Then the "Edit" menu has "Find in Thread…" on "⌘F"
