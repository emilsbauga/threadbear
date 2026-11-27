Feature: Quietly archived threads
  As someone whose finished threads mostly just say they did what I asked
  I want the ones a model is sure I didn't need to see to skip my inbox
  So I only open the threads that have something for me, and can bring back one it got wrong

  # Experiment quietInboxMine (docs/protocol/threads.md, "Inbox guess"): the
  # runner archives the thread. Mike checks them in a daily thread; in the
  # app, an archived row it hid offers Should Have Shown Me. The Swift app is
  # frozen and shows them as plain archived threads.

  Background:
    Given the app is connected to a runner with the demo threads
    And the quiet inbox archived "Rename the Settings tabs" and "Morning brief" today

  @sidebar.quiet @swift-pending
  Scenario: A quietly archived row offers Should Have Shown Me
    Given the "archived" section is unfolded
    And the "inbox" section is folded away
    When I right-click the row "Morning brief"
    Then the row's menu offers "Should Have Shown Me | Unarchive"

  @sidebar.quiet @swift-pending
  Scenario: Should Have Shown Me brings a thread back to the inbox at once
    When I choose Should Have Shown Me for "Morning brief"
    Then the "Inbox" section lists "Morning brief"
    And the runner was told I should have been shown "Morning brief"

  @sidebar.quiet @swift-pending
  Scenario: A refused Should Have Shown Me puts the thread back where it was, with the error
    Given the runner will refuse the next Should have shown me
    When I choose Should Have Shown Me for "Morning brief"
    Then the error bar says "Couldn't bring it back just now. Try again in a moment."
    And the "Archived" section lists "Morning brief"

  # The lines come after the turn, and folded into its work out of sight
  # until 25 Nov 2026 (RowContent::is_place_note).
  @sidebar.quiet @swift-pending
  Scenario: A quietly archived thread says so, and says why when it comes back
    When I open the thread "Morning brief"
    Then the transcript shows the line "Archived by Quiet inbox on Tue 24 Nov, 8:10 pm: it finished with nothing for you"
    When I choose Should Have Shown Me for "Morning brief"
    Then the transcript shows the line "Brought back from the archive by you on Wed 25 Nov, 9:40 am: Quiet inbox shouldn't have hidden it."
