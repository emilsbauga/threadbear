Feature: Words selected in a reply
  As someone reading what an agent wrote
  I want to do something with the words I select
  So I can ask about them, answer them, or take them elsewhere with their links

  Background:
    Given the app is connected to a runner with the demo threads

  # Only the Mac's clipboard gets the HTML so far (selection_bar.rs).
  @rich.selectionbar @rich.copy @windows-pending @linux-pending
  Scenario: Copy on the bar over selected words copies them with their links
    When I open the thread "Morning brief"
    And a reply saying "Ship the [release notes](https://example.com/notes) **today**." streams in
    And I select "Ship the release notes today." in the reply
    Then the bar shows over the words
    When I press "copy" on the bar over "Ship the release notes today."
    Then the clipboard holds "Ship the release notes today."
    And the clipboard's HTML has '<a href="https://example.com/notes">release notes</a> <b>today</b>'

  @rich.selectionbar
  Scenario: Quote on the bar puts the words in my reply as a quote
    When I open the thread "Morning brief"
    And a reply saying "Ship the [release notes](https://example.com/notes) **today**." streams in
    And I press "quote" on the bar over "Ship the release notes today."
    Then the composer starts with a quote of "Ship the release notes today."

  @rich.explain
  Scenario: Explain on the bar explains the words beside the thread
    When I open the thread "Morning brief"
    And a reply saying "Ship the [release notes](https://example.com/notes) **today**." streams in
    And I press "explain" on the bar over "Ship the release notes today."
    Then the pane explains "Ship the release notes today." with "is what the agent called this step"

  # A follow-up asked the runner through the pane's own entity from inside
  # the pane's update, and GPUI aborts on that: every follow-up took the app
  # down until 18 Nov (explain_pane.rs, `fetch_explanation`). GPUI's only, as
  # the Swift app is frozen and its script has no way to ask one.
  @rich.explain @swift-pending
  Scenario: A follow-up question in the pane gets its own answer
    When I open the thread "Morning brief"
    And a reply saying "Ship the [release notes](https://example.com/notes) **today**." streams in
    And I press "explain" on the bar over "Ship the release notes today."
    Then the pane explains "Ship the release notes today." with "is what the agent called this step"
    When I ask the follow-up "Why today?" in the pane
    Then the pane explains "Ship the release notes today." with "Why today? That's the mock runner's answer to a follow-up."

  # A scripted Swift app's ⌘C goes to the Mac's own clipboard, not the
  # instance's own that `clipboard` reads (Automation.pasteboard), so it
  # can't be read back there; its Copy on the bar is checked above. And as
  # above, only the Mac's clipboard gets the HTML so far.
  @rich.copy @swift-pending @windows-pending @linux-pending
  Scenario: ⌘C on selected words copies them with their links
    When I open the thread "Morning brief"
    And a reply saying "Ship the [release notes](https://example.com/notes) **today**." streams in
    And I select "Ship the release notes today." in the reply
    And I press ⌘C
    Then the clipboard holds "Ship the release notes today."
    And the clipboard's HTML has '<a href="https://example.com/notes">release notes</a> <b>today</b>'
