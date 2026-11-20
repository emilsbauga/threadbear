Feature: Screen readers
  As someone using VoiceOver
  I want the app's buttons, rows and switches to be controls it can find
  So I can use the app without seeing it

  # The Swift app's are AppKit's own controls; its script has no command to
  # read an element's role, and that app is frozen.

  Background:
    Given the app is connected to a runner with the demo threads

  @foundation.accessibility @swift-pending
  Scenario: Send is a button, dimmed with nothing to send
    When I open the thread "Morning brief"
    Then "Send" is a button to a screen reader
    And "Send" is disabled to a screen reader
    When I type "Ship it" in the composer
    Then "Send" is enabled to a screen reader

  @foundation.accessibility @swift-pending
  Scenario: A thread's row is a list item, selected while it's open
    When I open the thread "Morning brief"
    Then the row of "Morning brief" is a list item to a screen reader
    And the row of "Morning brief" is selected to a screen reader

  @foundation.accessibility @header.share @swift-pending
  Scenario: The share popover's choices say who can read it, and which is chosen
    When I open the thread "Morning brief"
    And I click the share button
    Then "Only you" is a radio button to a screen reader
    And "Only you" is chosen to a screen reader
    And "Anyone with the link" is a radio button to a screen reader
    And "Anyone with the link" isn't chosen to a screen reader
    When I make a share link for the open thread
    Then "Anyone with the link" is chosen to a screen reader
    And "Only you" isn't chosen to a screen reader

  @manual @foundation.theme
  Scenario: Increase Contrast follows the Mac's display preference
    When I turn on Increase Contrast in macOS and return to Threadbear
    Then text and borders use the Mac's higher contrast colours
    When I turn off Increase Contrast in macOS and return to Threadbear
    Then the ordinary colours return
