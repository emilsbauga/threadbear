@gpui-pending
Feature: The frozen Swift review stage
  The Swift app keeps the single-picture stage. GPUI uses the review board,
  covered in review-canvas.feature; these stage controls are deliberately retired there.

  Background:
    Given the app is connected to a runner with the demo threads
    When I open the thread "Compare account picker designs"

  @review.nav
  Scenario: Next steps through every option, then shows them all to choose from
    When I open the review
    And I press "Next (→)" in the review
    Then the review is on option "B", shot 1
    When I press "Next (→)" in the review
    And I press "Next (→)" in the review
    Then the review is on option "D", shot 1
    When I press "See them all and choose (→)" in the review
    Then the review shows them all
    When I press "Back to the last one (←)" in the review
    Then the review is on option "D", shot 1

  # Mike, 20 Nov: the options' words were small and grey in a column down the
  # right, so he went back to the thread to read them. They're under the
  # picture now, at the thread's size, for the option on show; the agent's
  # lead is there with all of them side by side. The Swift window keeps its
  # column.
  @review.window @swift-pending
  Scenario: The words under the picture are the option on show's
    When I open the review
    Then the review's words start "A. Auto account"
    And the review's words say "Keep the account menu and add Auto."
    When I press "Next (→)" in the review
    Then the review's words start "B. One picker"
    When I press "C. Account pools" in the review
    Then the review's words start "C. Account pools"
    When I press "See them all and choose (Esc)" in the review
    Then the review shows them all
    And the review's words start "Three ways to let you pick"

  @review.nav
  Scenario: Every shot of an option comes before the next option
    Given the agent shows options with several shots each
    When I open that review
    Then the review is on option "A", shot 1
    When I press "Next (→)" in the review
    Then the review is on option "A", shot 2
    When I press "Next (→)" in the review
    And I press "Next (→)" in the review
    Then the review is on option "B", shot 1
    When I press "Previous (←)" in the review
    Then the review is on option "A", shot 3
    When I press "B. One picker, shot 1" in the review
    And I press "B. One picker, shot 2" in the review
    Then the review is on option "B", shot 2

  # The Swift scripts' keys go to the main window, not a review's.
  @review.nav @swift-pending
  Scenario: The arrow keys step through the shots, and Return shows them all
    Given the agent shows options with several shots each
    When I open that review
    And I press the "right" key in the review
    Then the review is on option "A", shot 2
    When I press the "down" key in the review
    Then the review is on option "B", shot 1
    When I press the "enter" key in the review
    Then the review shows them all
    When I press the "enter" key in the review
    Then the review is on option "B", shot 1

  @review.zoom @review.minimap
  Scenario: Full size shows the shot at its own size, with a minimap of all of it
    When I open the review
    And I show the shot at full size
    Then the shot is zoomed in, with the minimap showing
    When I fit the shot in its space
    Then the shot fits, with no minimap

  # The Swift scripts' keys go to the main window, not a review's.
  @review.zoom @swift-pending
  Scenario: Esc takes a zoomed shot back to fitting, then shows them all
    When I open the review
    And I show the shot at full size
    And I press the "escape" key in the review
    Then the shot fits, with no minimap
    When I press the "escape" key in the review
    Then the review shows them all

  @review.holdspace
  Scenario: Today's version can be flicked to and back
    When I open the review
    And I press "Flick to Moving mid-thread: click, or hold Space" in the review
    Then the review shows today's version over option "A"
    When I press "Back to A (or let go of Space)" in the review
    Then the review shows option "A" again

  @review.openlive
  Scenario: An option that runs live can be tried from its caption
    Given the agent shows options with several shots each
    When I open that review
    Then the caption offers nothing to try live
    When I press "C. Account pools" in the review
    Then the caption offers "http://localhost:5190/c" to try live

  @review.media @windows-pending @linux-pending
  Scenario: A clip plays on the stage
    Given the agent shows options with several shots each
    When I open that review
    And I press "C. Account pools" in the review
    Then the stage plays the clip

  # A sound is its waveform with the pane's play bar on it, paused at the
  # start (Mike, 24 Nov: comparing music beds). The Swift window is frozen.
  @review.media @swift-pending @windows-pending @linux-pending
  Scenario: A sound has a play bar on the stage
    Given the agent shows options with several shots each
    When I open that review
    And I press "B. One picker, shot 1" in the review
    And I press "B. One picker, shot 3" in the review
    Then the stage has the sound's play bar

  # A page shows in place, sealed with its scripts off, as the pane's local
  # pages do: the GPUI window through the web runtime, which isn't on
  # Windows and Linux yet (there it's the still, with Open the page).
  @review.media @web-runtime @windows-pending @linux-pending
  Scenario: A page shows in place on the stage
    Given the web runtime is installed
    And the agent shows options with several shots each
    When I open that review
    And I press "B. One picker, shot 1" in the review
    And I press "B. One picker, shot 2" in the review
    Then the stage shows the page
