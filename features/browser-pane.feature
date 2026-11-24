Feature: The Browser pane
  As someone whose agents use web pages through BrowserBear
  I want each thread's pages listed beside it, with the one handed to me in front
  So I can find the page an agent means, sign in there and tell it I'm done

  Background:
    Given the app is connected to a runner with the demo threads

  # The Swift app's dump has no Browser button or pane (AppDump.rails, Pane),
  # and it's frozen, so these are checked on the GPUI app only.
  #
  # None run on Windows: BrowserBear is a Mac tool (Linux works too) that talks
  # over a Unix socket, which the GPUI app only opens on Unix
  # (agent_browser.rs), and the stand-in can't listen on a file path there
  # (Windows wants a named pipe: listen EACCES on browserbear.sock).

  @browserbear @windows-pending @browser.pages @rail.right @swift-pending
  Scenario: The Browser button counts a thread's pages and the pane lists them
    Given BrowserBear has "Example Domain" at "https://example.com/" open for "Morning brief"
    When I open the thread "Morning brief"
    Then the right rail's Browser button shows 1 page
    When I click the right rail's Browser button
    Then the Browser pane lists "Example Domain" from "example.com" with "Show window"

  @browserbear @windows-pending @browser.show @swift-pending
  Scenario: Show window brings the selected page forward
    Given BrowserBear has "Example Domain" at "https://example.com/" open for "Morning brief"
    When I open the thread "Morning brief"
    And I click the right rail's Browser button
    And BrowserBear has "Second" at "https://second.example/" open for "Morning brief"
    Then the Browser pane lists "Second" from "second.example" with "Show window"
    When I press "Show window" on "Example Domain"
    Then BrowserBear was asked to show that page for "Morning brief"

  @browserbear @windows-pending @browser.show @swift-pending
  Scenario: A service supporting panelShow handles the first request
    Given BrowserBear supports panelShow
    And BrowserBear has "Example Domain" at "https://example.com/" open for "Morning brief"
    When I open the thread "Morning brief"
    And I click the right rail's Browser button
    And I press "Show window" on "Example Domain"
    Then BrowserBear received only the panelShow request for "Example Domain"

  @browserbear @windows-pending @browser.handoff @swift-pending
  Scenario: A handoff without a waiting agent has no Done button
    Given BrowserBear has "Sign in" at "https://login.example.com/" open for "Morning brief"
    When I open the thread "Morning brief"
    And the agent hands "Sign in" to me without waiting
    Then the Browser pane lists "Sign in" from "login.example.com" with "Show window"

  @browserbear @windows-pending @browser.show @swift-pending
  Scenario: A rejected Show window request explains the failure on the page
    Given BrowserBear has "Example Domain" at "https://example.com/" open for "Morning brief"
    When I open the thread "Morning brief"
    And I click the right rail's Browser button
    And the browser window becomes unavailable
    And I press "Show window" on "Example Domain"
    Then the page "Example Domain" reports "This Chrome profile is not connected."

  @browserbear @windows-pending @browser.handoff @swift-pending
  Scenario: A page handed to me opens the pane by itself, and Done tells the agent
    Given BrowserBear has "Sign in" at "https://login.example.com/" open for "Morning brief"
    When I open the thread "Morning brief"
    And the agent hands "Sign in" to me
    Then the dock has the "browser" panel
    And the Browser pane lists "Sign in" from "login.example.com" with "Show window, Done"
    When I press "Done" on "Sign in"
    Then BrowserBear was told I'm done with "Sign in"
    And the page "Sign in" reports "Done sent"
    When the agent resumes work in "Sign in"
    Then the Browser pane lists "Sign in" from "login.example.com" with "Show window"

  @browserbear @windows-pending @browser.handoff @panel.requests @swift-pending
  Scenario: show_panel for the browser brings the Browser pane up
    Given BrowserBear has "Example Domain" at "https://example.com/" open for "Morning brief"
    When I open the thread "Morning brief"
    And I'm looking at the app
    And the agent asks to show the "browser" panel
    Then the dock has the "browser" panel
    And the runner heard the panel was shown

  # The Qantas sign-in (30 Oct): the agent's tab on the page came forward
  # rather than a second one opening in the browser.
  @browserbear @windows-pending @rich.browserbear
  Scenario: A link to a page an agent has open brings its tab forward instead of opening another
    Given BrowserBear has "Sign in" at "https://login.example.com/" open for "Morning brief"
    When I open the thread "Morning brief"
    And a reply linking "sign in here" to "https://login.example.com/" streams in
    And I click the link "sign in here"
    Then BrowserBear was asked to hand over "https://login.example.com/"
    And nothing was opened in another app

  @browserbear @windows-pending @rich.browserbear
  Scenario: A link to a page no agent has open opens in the browser
    Given BrowserBear has "Sign in" at "https://login.example.com/" open for "Morning brief"
    When I open the thread "Morning brief"
    And a reply linking "the docs" to "https://docs.example.com/" streams in
    And I click the link "the docs"
    Then "https://docs.example.com/" was opened in the browser
