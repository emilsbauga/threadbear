Feature: The Feed: my Inbox as cards, one after another
  As someone with many threads going at once
  I want my Inbox as cards I can read and answer one after another
  So I can get through what needs me without opening each thread

  # Experiment feed (runner/src/experiments/feed.md): the GPUI app only. The
  # Swift app is frozen and has no Feed. The mock's TB_MOCK_FEED demo has the
  # threads of the mockup Mike picked on 20 Nov (r3-c-status).

  Background:
    Given the app is connected to a runner with the demo threads
    When I open the Feed

  @inbox.feed @feed @swift-pending
  Scenario: Cards that need me come first, then the running ones, then the rest
    Then the Feed's card "Explain the Claude 5-hour limit" needs me
    And the Feed's card "Keep main green" is running
    And the Feed's card "Explain the Claude 5-hour limit" comes before "Keep main green"
    And the Feed's card "Keep main green" comes before "Bedtime Tube"
    And the Feed's card "Explain the Claude 5-hour limit" starts with "Explain the Claude 5-hour limit in the guide and FAQ"
    And the Feed's card "Browser pane: back button" starts with "Browser pane: back button"
    And the sidebar still shows the Inbox

  @inbox.feed @feed @swift-pending
  Scenario: Answering a card's question sends it to the thread
    Given the runner takes its time to change threads
    When I answer "Drop the idea" on the Feed's card "Explain the Claude 5-hour limit"
    Then the Feed's card "Explain the Claude 5-hour limit" is sending
    And the thread "Explain the Claude 5-hour limit" got "Drop the idea"

  @inbox.feed @feed @swift-pending
  Scenario: The fold opens a card's recent messages
    When I open the fold on the Feed's card "Bedtime Tube"
    Then the Feed's card "Bedtime Tube" says "Claude · 8 messages"
    And the Feed's card "Bedtime Tube" shows the message "Thanks, and check again tonight?"
    And the Feed's card "Bedtime Tube" has a reply box

  @inbox.feed @feed @swift-pending
  Scenario: Done shrinks a card to one line, and Undo brings it back
    When I mark the Feed's card "San Francisco hotel" Done
    Then the Feed's card "San Francisco hotel" is one line
    And the thread "San Francisco hotel" is archived
    When I undo the Feed's card "San Francisco hotel"
    Then the Feed's card "San Francisco hotel" is a card again

  @inbox.feed @feed @swift-pending
  Scenario: A reply from a card goes to its thread
    When I reply "Hold off till Monday" on the Feed's card "Browser pane: back button"
    Then the thread "Browser pane: back button" got "Hold off till Monday"

  @inbox.feed @feed @swift-pending
  Scenario: Open thread leaves the Feed for the thread
    When I open the fold on the Feed's card "Bedtime Tube"
    And I click "Open thread" on the Feed
    Then the open thread is "Bedtime Tube"
