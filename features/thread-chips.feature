Feature: Threads named in a reply
  As someone whose agents point me at other threads
  I want a thread they name drawn as a chip with its card
  So I can see which thread it is and get to it with a click

  Background:
    Given the app is connected to a runner with the demo threads

  @rich.threadchips @transcript.reply
  Scenario: A thread's id in a reply is a chip that opens that thread
    Given there's a thread called "Check the release notes" with the id "4f9c2e7a-1b3d-4c5e-8f60-7a8b9c0d1e2f"
    When I open the thread "Morning brief"
    And a reply naming the thread 4f9c2e7a streams in
    Then the reply shows the thread chip "4f9c2e7a"
    And resting on the thread chip "4f9c2e7a" shows its card
    When I press the thread chip "4f9c2e7a"
    Then the open thread is "Check the release notes"

  @rich.threadchips @transcript.agentmessage
  Scenario: A message from another thread's agent names that thread as a chip that opens it
    When I open the thread "Morning brief"
    And the agent in "Tidy the imports in the uploader" sends this thread a message
    Then the message is headed by the thread chip "Tidy the imports in the uploader"
    When I press the thread chip "Tidy the imports in the uploader"
    Then the open thread is "Tidy the imports in the uploader"

  # The GPUI app's dump says whether a row is in view; the Swift one's doesn't.
  @rich.threadchips @sidebar.keys @swift-pending
  Scenario: A thread chip brings that thread's row into view
    Given the window is short
    When I click the first row in the sidebar
    And I press the down arrow until the last thread in the sidebar is open
    And the agent in "Tidy the imports in the uploader" sends this thread a message
    And I press the thread chip "Tidy the imports in the uploader"
    Then the open thread is "Tidy the imports in the uploader"
    And the open thread's row is in view in the sidebar

  # A link to another thread has a mark before it saying how that thread's
  # getting on, which changes as it does (Mike, 17 Nov, after Capy's marks).
  # The Swift app is frozen and draws only the link.
  @rich.threadlinkmarks @transcript.reply @swift-pending
  Scenario: A link to another thread shows that thread's state as it changes
    When I open the thread "Morning brief"
    And a reply linking "the uploads thread" to the thread "demo_upload_resume" streams in
    Then the mark before the link to "demo_upload_resume" says "Needs you"
    When the thread "demo_upload_resume" starts working
    Then the mark before the link to "demo_upload_resume" says "Working"
    When the thread "demo_upload_resume" finishes, saying it's done
    Then the mark before the link to "demo_upload_resume" says "Done"
