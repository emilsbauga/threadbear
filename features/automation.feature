Feature: Driving a private preview of the app
  An agent can prepare screenshots without exposing login names
  and inspect a live reply without changing the thread.

  Background:
    Given the app is connected to a runner with the demo threads

  @system.testharness
  Scenario: A screenshot can use login ids and a chosen amount of room
    When I prepare anonymous logins with 44 percent room
    And I click the honey pot in the activity bar
    Then the screenshot logins have anonymous names and 44 percent room

  @system.testharness
  Scenario: The script can read live text and a row's debug information
    When I open the thread "Rebuild the three landing pages"
    Then the script can read the streaming text
    And the script can copy a row's debug information

  @system.testharness
  Scenario: Older scripts can size a window and click a control by coordinates
    When I size the preview window to 1000 by 600
    Then the script reports a window id and size 1000 by 600
    When I click Librarian by its coordinates
    Then the sidebar shows the "librarian" view

  @system.testharness
  Scenario: A script selects a deployment the Convex panel offers
    When I open the thread "Add dark mode to the dashboard"
    And I give that thread a Convex panel
    When I select the production deployment through the script
    Then the script reports the production Convex dashboard
    And the script refuses an unknown deployment

  # A covered window draws only when asked, so a shot straight after a panel
  # moved caught the move's first frame: the Usage panel's column missing or
  # empty (20 Nov). Linux's windows can't render to an image yet
  # (render_to_image isn't there in gpui's Linux platform); the frozen Swift
  # app shoots the screen instead.
  @system.testharness @linux-pending @swift-pending
  Scenario: A screenshot straight after a panel moves shows the panel drawn
    When I click the honey pot in the activity bar
    And I move the "usage" panel to the "right" edge
    And I take a screenshot straight away
    Then the screenshot shows the Usage tile "Tokens in the last 60 minutes" drawn where the panel has it
