Feature: Virtual runners
  As someone who wants more threads going than my Macs can hold
  I want to start a thread on a machine made for it in the cloud
  So it runs there, sleeps when idle, and asks me for a token only when it needs one

  # The Swift app is frozen (12 Nov 2026): this is the GPUI app's alone.
  Background:
    Given the app is connected to a runner with the demo threads

  @virtual.runs-on @virtual-runners @swift-pending
  Scenario: Runs on lists the virtual runner after the machines, and never a box
    When I start a new thread
    Then the Runs on menu lists "[ ] mac-mini, [ ] Cloud (Fly)" after This Mac
    When I pick "Cloud (Fly)" in Runs on
    Then the Runs on menu has "Cloud (Fly)" ticked

  @virtual.runs-on @virtual-runners @swift-pending
  Scenario: A thread sent on a virtual runner is that runner's
    When I start a new thread
    And I pick "Cloud (Fly)" in Runs on
    And I send "Tidy the retry loop"
    Then the row "Tidy the retry loop" is on the runner "On Cloud (Fly)"

  @virtual.rows @virtual-runners @swift-pending
  Scenario: A box thread's row says what its machine is doing
    Then the row "Tidy the sync retries" says "Starting a machine"
    And the row "Check the landing page copy" says "Waking"
    And the row "Port the usage chart" says "Asleep"
    And the row "Fix the flaky move test" says "Needs a cloud token"
    And the row "Fix the flaky move test" has the needs-you dot

  @virtual.token-card @virtual-runners @swift-pending
  Scenario: The token card offers this Mac's token only when there is one
    When I open the thread "Write the changelog entry"
    Then the token card says "alex@example.com needs a cloud token" with "Make one, Paste a token, Use this Mac's token"
    When I open the thread "Fix the flaky move test"
    Then the token card says "alex+3@example.com needs a cloud token" with "Make one, Paste a token"
    When I open the thread "Bump Claude Code in the box image"
    Then the token card says "Claude refused work@example.com's cloud token" with "Make one, Paste a token"

  @virtual.token-card @virtual-runners @swift-pending
  Scenario: Making a token shows it's waiting, then the card goes and the box starts
    Given the runner holds cloud token requests
    When I open the thread "Fix the flaky move test"
    And I press "Make one" on the token card
    Then the token card is busy with "Waiting for claude.ai"
    When the runner lets the cloud token request through
    Then there's no token card
    And the row "Fix the flaky move test" says "Starting a machine"
