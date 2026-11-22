Feature: A design review as a page beside the thread
  As someone an agent shows design options to (its show_options)
  I want them on a page beside the thread, with their words at reading size
  So I read and look in one place, and answer in the message box

  # Experiment reviewPage (docs/protocol/events.md, "Design reviews"): the GPUI app
  # only. The Swift app is frozen and opens the review in its window. Mike,
  # 20 Nov: he went into the window for the pictures and back to the thread
  # to read about them, as the window's words were small, grey and narrow.
  # The demo thread's review has four options, each one picture: A, B and C
  # to pick from, C the agent's pick, and D for reference only.
  # Not on Windows yet: a page's site reads its folder through file
  # descriptors there's no Windows version of (local_preview.rs), so no local
  # page shows there, this one included.

  Background:
    Given the app is connected to a runner with the demo threads
    When I open the thread "Compare account picker designs"

  @review.page @review-page @swift-pending @windows-pending
  Scenario: The review opens as a page in the pane, with each option's words and picture
    When I open the review's page
    Then the pane shows the review's page
    And the review's page has "Account pools" as the agent's pick
    And the review's page has a picture and a tick for "One picker"
    And the review's page has a picture and no tick for "Moving mid-thread"
    And the pane is as wide as a wide design wants

  @review.page @review-page @swift-pending @windows-pending
  Scenario: A tick on the page shows over the message box
    When I open the review's page
    And I click the tick of option 2 on the review's page
    Then the review's page has "B" ticked
    And the message box shows the ticks "One picker"
    When I click the tick of option 3 on the review's page
    Then the review's page has "B, C" ticked
    And the message box shows the ticks "One picker, Account pools"
    When I click the tick of option 2 on the review's page
    Then the review's page has "C" ticked
    And the message box shows the ticks "Account pools"

  @review.page @review-page @swift-pending @windows-pending
  Scenario: The message sent with ticks is the review's answer, and the page closes
    When I open the review's page
    And I click the tick of option 3 on the review's page
    Then the message box shows the ticks "Account pools"
    When I send "With the picker in the header"
    Then a review card says "answered"
    And the review's page has closed
    And the message box shows no ticks

  @review.page @review-page @swift-pending @windows-pending
  Scenario: Ticks alone can be sent
    When I open the review's page
    And I click the tick of option 1 on the review's page
    Then the message box shows the ticks "Auto account"
    When I press Return in the empty message box
    Then a review card says "answered"
    And the message box shows no ticks

  @review.page @review-page @swift-pending @windows-pending
  Scenario: A picture on the page opens it full size, with its words under it
    When I open the review's page
    And I click the picture of option 2 on the review's page
    Then the review window is open on option "B", one at a time
    And the review window is a closer look, with no column down the right

  @review.page @review-page @swift-pending @windows-pending
  Scenario: A reference can't be ticked from the page
    When I open the review's page
    And I click the tick of option 4 on the review's page
    Then the review's page has "" ticked
    And the message box shows no ticks

  # A tick shows on the page before the runner has saved it, and it's the
  # page's ticks the box goes by: with only the runner's, Return straight
  # after a first tick allowed a waiting tool (Codex's review, 20 Nov).
  @review.page @review-page @swift-pending @windows-pending
  Scenario: A tick counts for the message box before the runner has it
    When I open the review's page
    And the runner is slow to save
    And I click the tick of option 1 on the review's page without waiting
    Then the message box shows the ticks "Auto account" before the runner has them
    And the review's page has "A" ticked
