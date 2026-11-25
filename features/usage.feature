Feature: The Usage panel and its honey pot
  As someone running threads on several logins
  I want to see what I've spent and how much room each login has left
  So I know which login to lean on and when one will run out

  Background:
    Given the app is connected to a runner with the demo threads

  @usage.spend
  Scenario: The panel says what's been spent, by the hour today or by the day this week
    When I click the honey pot in the activity bar
    Then the Usage panel is open
    And the Usage panel's tiles are "Today, Last hour, 7 days", each with a number
    And the Usage chart is "Tokens by hour"
    When I show the last 7 days on the Usage chart
    Then the Usage chart is "Tokens by day"
    And the Usage chart's key names "alex, work, alex+3, alex+4, Codex"

  @usage.pools
  Scenario: A card for each pool, with what each login has left
    When I click the honey pot in the activity bar
    Then the Usage panel has a card for each pool: "Claude, Work, Codex, Personal, Weekends"
    And in the "Claude" card, "alex@example.com" has "Weekly 78% left, Weekly Fable 71% left"
    And in the "Claude" card, "alex+4@example.com" says "Limit reached"
    And the "Personal" card names each login's provider: "Codex: alex@example.com, Claude: alex+3@example.com"

  # Option B of Mike's 17 Nov review: a card per login with its logo, a ring
  # with its week, and one line where "Limit reached" sat over "Used up". A
  # login with no number says why. The frozen Swift app has none of it.
  @usage.pools @swift-pending
  Scenario: Each login's card has its logo, a ring and one line saying how it stands
    When I click the honey pot in the activity bar
    Then in the "Claude" card, "alex@example.com" has the "claude" logo and a ring at 78%
    And in the "Claude" card, "alex+4@example.com" has the "claude" logo and a ring at 31%
    And in the "Claude" card, "alex+4@example.com"'s line starts "Used up, back"
    When a Grok login with no reading is added
    Then in the "Not in a pool" card, "Grok" has the "grok" logo and no ring
    And in the "Not in a pool" card, "Grok" says why: "Not read yet"

  # Mike's Gemini login showed no figures (23 Nov 2026). The runner reads its
  # Google plan with antigravity-acp's own /usage: the Gemini models' 5-hour
  # and weekly windows decide its room, and the Claude and GPT group's week
  # gets a meter of its own that never does.
  @usage.pools @swift-pending
  Scenario: A Gemini login shows how much of its Google plan is left
    When I click the honey pot in the activity bar
    And a Gemini login with its plan's usage is added
    Then in the "Not in a pool" card, "Gemini" has the "antigravity" logo and a ring at 55%
    And in the "Not in a pool" card, "Gemini" has "5-hour 91% left, Weekly 55% left, Weekly Claude and GPT 100% left"

  # Option A of Mike's 20 Nov review: a card per login with its own chart
  # took a screen for two or three logins, so each is one row now, and its
  # charts and buttons wait until it's clicked open.
  @usage.pools @swift-pending
  Scenario: A login's row opens to its charts and buttons when clicked, and shuts again
    When I click the honey pot in the activity bar
    Then in the "Claude" card, "alex@example.com" is shut
    When I click "claude-main"'s row in the Usage panel
    Then in the "Claude" card, "alex@example.com" is open
    And in the "Claude" card, "alex+4@example.com" is shut
    When I click "claude-main"'s row in the Usage panel
    Then in the "Claude" card, "alex@example.com" is shut

  # Mike, 18 Nov: the panel's settings were dumped at its foot; they're in
  # Settings › General › Usage now. The frozen Swift app keeps its card.
  @usage.pools @swift-pending
  Scenario: Weekly Fable can be switched off in Settings, and stays off
    When I open Settings
    Then Settings' "Show Weekly Fable" switch is on
    When I press "A login's own limit on one model" in Settings
    Then Settings' "Show Weekly Fable" switch is off
    When I click the honey pot in the activity bar
    Then in the "Claude" card, "alex@example.com" has "Weekly 78% left"
    # The GPUI app writes its settings at most every 300 ms, and the spec's
    # quit doesn't wait for that.
    When I wait a moment
    And the app is quit and opened again
    And I click the honey pot in the activity bar
    Then in the "Claude" card, "alex@example.com" has "Weekly 78% left"

  # Option C of Mike's 18 Nov review: the action beside "will go unused".
  @usage.pools @swift-pending
  Scenario: A login whose week will go unused offers Find work for it, which opens a thread on it
    When I click the honey pot in the activity bar
    Then in the "Claude" card, "alex@example.com"'s line starts "About"
    And in the "Claude" card, "alex@example.com" offers Find work for it
    And in the "Claude" card, "alex+4@example.com" doesn't offer Find work for it
    When I press Find work for it on "claude-main"
    Then the open thread is "Ideas for alex@example.com's spare week"
    When I press Find work for it on "claude-main"
    Then the open thread is "Ideas for alex@example.com's spare week"
    And there is one thread called "Ideas for alex@example.com's spare week"

  @settings.general @swift-pending
  Scenario: The spare week nudge can be turned off in Settings
    When I open Settings
    Then Settings says spare week nudges are on
    When I press "Start a thread with ideas a day before" in Settings
    Then Settings says spare week nudges are off

  @rail.honeypot
  Scenario: The honey pot is filled to the room the next thread would get, and follows it
    Then the honey pot is 78% full, for "claude-main"
    And the honey pot's tooltip says "Claude: 78% left"
    And the honey pot's tooltip says "Work: 95% left"
    When "claude-main" is down to 40% of its week
    Then the honey pot is 40% full, for "claude-main"
    And the honey pot's tooltip says "Claude: 40% left"
    When "claude-main"'s week resets
    Then the honey pot is 100% full, for "claude-main"

  # From Claude Code 2.1.325 a sign-in ends 28 days after it was made, and
  # claude-1's ended unnoticed on 14 Nov 2026. The frozen Swift app has none of it.
  @usage.sign-in @swift-pending
  Scenario: A login that's signed out, or whose sign-in ends in days, says so with a dot on the honey pot
    Then the honey pot has no dot
    When "claude-3"'s sign-in ends in 50 hours
    And I click the honey pot in the activity bar
    Then in the "Claude" card, "alex+3@example.com" warns its sign-in ends
    And the honey pot has a dot
    And a line of the honey pot's tooltip starts "claude-3 (alex+3@example.com): sign-in ends"
    When "claude-4" is signed out
    Then in the "Claude" card, "alex+4@example.com" says "Signed out"
    And the honey pot's tooltip says "claude-4 (alex+4@example.com) is signed out"
    When "claude-4" is signed in again
    Then confetti was thrown for "claude-4" signing back in

  # A Claude sign-in lasts 28 days; `claude setup-token` makes a token that
  # lasts a year. Mike, 17 Nov 2026: let each login opt in. The frozen Swift
  # app has none of it.
  @usage.sign-in @swift-pending
  Scenario: Each Claude login offers a year-long token, and one on a token says until when
    When I click the honey pot in the activity bar
    Then in the "Claude" card, "alex+3@example.com" offers a year-long token
    When "claude-3" runs on a year-long token made today
    Then in the "Claude" card, "alex+3@example.com" says it has a year-long token
    And confetti was thrown from "claude-3"'s Usage row
    And the honey pot has no dot

  # claude-main's cancelled Max ran out on 16 Nov 2026 while its row still
  # offered Sign in… and a weekly reset. The frozen Swift app has none of it.
  @usage.sign-in @swift-pending
  Scenario: A login whose paid plan has ended says so, with no sign-in warning
    When "claude-3"'s sign-in ends in 50 hours
    And "claude-3"'s plan has ended
    And I click the honey pot in the activity bar
    Then in the "Claude" card, "alex+3@example.com" says "Plan ended"
    And the honey pot has no dot

