Feature: Naming another thread with #
  As someone whose threads build on each other
  I want to type # in the message box and pick one of my threads
  So a link to it goes in my message, for the agent to read

  Background:
    Given the app is connected to a runner with the demo threads
    And I open the thread "Morning brief"

  # The GPUI app's alone: the Swift app is frozen.

  @composer.threadpicker @swift-pending
  Scenario: Typing # lists my other threads, and what I type narrows them by title or folder
    When I type "see #" in the composer
    Then the thread picker lists "Stop Keep Awake asking for my password"
    And the thread picker doesn't list "Morning brief"
    When I type "photo" in the composer
    Then the thread picker lists "Make uploads resume after a crash"
    And the thread picker doesn't list "Stop Keep Awake asking for my password"

  @composer.threadpicker @swift-pending
  Scenario: Return puts the thread in as its chip
    When I type "ask #keep" in the composer
    Then the thread picker's threads are "Stop Keep Awake asking for my password"
    When I press Return
    Then the composer's chips are "thread: Stop Keep Awake asking for my password"
    And the composer says "ask [Stop Keep Awake asking for my password](thread:demo_keep_awake) "
    And the thread picker is closed

  @composer.threadpicker @swift-pending
  Scenario: Clicking a thread in the picker puts it in as its chip
    When I type "#keep" in the composer
    And I click "Stop Keep Awake asking for my password" in the thread picker
    Then the composer's chips are "thread: Stop Keep Awake asking for my password"

  @composer.threadpicker @swift-pending
  Scenario: Esc closes the picker, and a # that matches no thread doesn't open it
    When I type "#keep" in the composer
    Then the thread picker's threads are "Stop Keep Awake asking for my password"
    When I press Escape
    Then the thread picker is closed
    When I type "fixes #zzzz" in the composer, replacing what's there
    Then the thread picker is closed
