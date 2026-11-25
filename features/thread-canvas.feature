Feature: The Canvas page
  As someone with many threads going at once
  I want every live thread on one board, by project, with arrows from each thread to the ones it started
  So I can see how my work hangs together and step into any thread from there

  # The threadCanvas experiment (runner/src/experiments/threadCanvas.md), GPUI
  # only: the Swift app is frozen. Mike, 24 Nov 2026, picked the layout and the
  # zoom-in from prototypes (~/dev/me/misc/thread-canvas). The demo here is the
  # nested demo's coordinator and the threads it started (TB_MOCK_NESTED).
  Background:
    Given the app is connected to a runner with the demo threads

  @thread.canvas @swift-pending
  Scenario: The board has every live thread, each project an area, and an arrow from a thread to the ones it started
    When I open the Canvas page
    Then the board has the thread "nest_coordinator"
    And the board has the thread "nest_browser" beside "nest_coordinator"
    And the board has arrows
    And the board has no thread "nest_done_menus"

  @thread.canvas @swift-pending
  Scenario: A click on a thread flies in until the real thread takes over, and Esc flies back out
    When I open the Canvas page
    And I click the thread "nest_browser" on the board
    Then the board is inside the thread "nest_browser"
    And the thread "GPUI: the Browser pane and sign-in handoff" is open
    When I leave the thread on the board
    Then the board is out of any thread

  @thread.canvas @swift-pending
  Scenario: An archived thread is a ghost that keeps its arrow until Tidy
    When I open the Canvas page
    And I archive the thread "nest_browser"
    Then the board has a ghost of "nest_browser"
    And the board has arrows
    When I tidy the board
    Then the board has no thread "nest_browser"

  @thread.canvas @swift-pending
  Scenario: The rail's other views take the board down
    When I open the Canvas page
    And I go to the Threads view
    Then the Canvas page is down
