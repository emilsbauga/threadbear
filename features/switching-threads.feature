Feature: Switching threads
  As someone moving between threads all day
  I want a thread to show at once when I come back to it
  So I'm never left looking at an empty transcript while the runner's busy

  # The mock runner takes 3 seconds over every read of a thread here, as a
  # runner handing over to a new release or a loaded Mac can.
  Background:
    Given the app is connected to a runner with the demo threads

  @thread.loading
  Scenario: A thread being read shows a spinner where its transcript will be
    When I start opening the thread "Make uploads resume after a crash"
    Then the transcript is a spinner with no rows
    And the transcript shows my message "Uploads start again from zero if the app quits"

  # The reply's words so far come with the read, with no turn of their own
  # to say which turn they're in. The GPUI app drew them outside it, so its
  # turn never ended in the transcript (stress run, 18 Nov). The Swift app
  # is frozen.
  # Something on the error line (a picture that couldn't be added, a send that
  # failed) used to take the spinner away, leaving an empty pane until the read
  # answered (21 Nov). The picture step only runs on a Mac.
  @thread.loading @swift-pending @windows-pending @linux-pending
  Scenario: Something going wrong while a thread's read keeps its spinner
    When I start opening the thread "Make uploads resume after a crash"
    And I paste an unavailable image file beside a TIFF icon
    Then the picture import reports an error
    And the transcript is still a spinner with no rows

  @thread.loading @transcript.reply @swift-pending
  Scenario: A reply that's streaming as its thread is read stays in its turn
    When I start opening the thread "Morning brief"
    And a reply starts streaming in it, slowly enough to outlast the read
    Then the reply ends in its own turn

  @thread.kept
  Scenario: Going back to a thread shows it straight away
    When I open the thread "Make uploads resume after a crash"
    And I open the thread "Make a poster for the meetup"
    And I start opening the thread "Make uploads resume after a crash"
    Then straight away the transcript shows my message "Uploads start again from zero if the app quits"
