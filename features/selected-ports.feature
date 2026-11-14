# These scenarios use GPUI's new script preview and settings dump. The frozen
# Swift client's corresponding behavior remains covered by its original tests.
@swift-pending
Feature: Keep the selected custom account and composer behavior
  Background:
    Given the app is connected to a runner with the demo threads

  @composer.account @foundation.protocol
  Scenario: A configured Pi profile becomes selectable only as an advertised account
    When the runner advertises the configured Pi login
    And I start a new thread
    And I pin the new thread to the login "pi:local"
    Then the Pi model chip includes "Local model"
    And Pi offers no Claude model aliases or unadvertised effort choices

  @banner.signin
  Scenario: Pi sign-in uses its interactive login and selected profile
    When the runner advertises the configured Pi login
    Then Pi sign-in opens the interactive profile and explains "/login lmstudio"

  @settings.general
  Scenario: Evolving titles can be switched off without renaming anything
    When I open Settings on "general"
    And I press "Let the librarian update thread titles as the work moves on" in Settings
    Then Evolving titles is off
    And the row "Morning brief" is in "misc"

  @composer.slash
  Scenario: Skill results follow every keystroke and put displayed titles first
    When I start a new thread
    And I pin the new thread to the login "codex-main"
    And the current folder offers the ranked test skills
    And I type "/review" in the composer
    Then the palette lists "/audit" first
    When I type "/publish" in the composer, replacing what's there
    Then the palette lists "/ship" first

  @composer.slash
  Scenario: Switching folders refreshes skills and an empty list removes old skills
    When I start a new thread
    And I pin the new thread to the login "codex-main"
    And the current folder offers the ranked test skills
    And I type "/review" in the composer
    Then the palette has the command "/audit"
    When I choose the folder "/mock/empty-project" for the new thread
    Then the palette no longer offers "/audit"

  @composer.slash.keys @composer.permission
  Scenario: Return inserts a skill while Pi refuses Plan first
    When I start a new thread
    And I pin the new thread to the login "codex-main"
    And the current folder offers the ranked test skills
    And I type "/review" in the composer
    Then the palette lists "/audit" first
    And I press Return
    Then the composer says "$audit "
    When the runner advertises the configured Pi login
    And I pin the new thread to the login "pi:local"
    Then Pi does not offer Plan first
