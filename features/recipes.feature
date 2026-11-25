Feature: Recipes
  As someone who wants the techniques other people found worth keeping
  I want a gallery of recipes an agent sets up for me, each with a switch
  So I can try one, see how it's going and turn it off again whenever I like

  # Experiment recipes (docs/protocol/projects.md, "Recipes"): the GPUI app only. The
  # Swift app is frozen and has no Recipes view.

  Background:
    Given the app is connected to a runner with the demo threads

  @recipes.view @recipes @swift-pending
  Scenario: The view lists the recipes added, and the gallery every one
    When I open the Recipes view
    Then the activity bar's "Recipes" button counts 3
    And the Recipes sidebar lists "Daily brief" as "on"
    And the Recipes sidebar lists "Weekly step back" as "off"
    And the Recipes sidebar doesn't list "Docs freshness"
    And the gallery has a card "Docs freshness" tagged "+ Add"
    And the gallery has a card "Daily brief" saying "needed you"

  @recipes.view @recipes @swift-pending
  Scenario: The switch moves at once and the runner keeps it
    When I open the Recipes view
    And I switch off "Daily brief"
    Then the Recipes sidebar lists "Daily brief" as "off"
    And nothing in the Recipes view is waiting on the runner
    And the Recipes sidebar lists "Daily brief" as "off"

  @recipes.view @recipes @swift-pending
  Scenario: Adding a recipe opens the thread that sets it up
    When I open the Recipes view
    And I add "Docs freshness"
    Then the thread "Set up Docs freshness" is open
    And the Recipes sidebar lists "Docs freshness" as "settingUp"

  @recipes.page @recipes @swift-pending
  Scenario: A recipe's page has an example of a run and its last 30 days
    When I open the Recipes view
    And I open the recipe "Daily brief"
    Then the recipe page for "daily-brief" has an example and its runs

  @recipes.habit @recipes @swift-pending
  Scenario: A habit is added by its switch, with no thread to set it up
    When I open the Recipes view
    Then the gallery has a card "Show a few options" tagged "+ Add"
    And the habit of "Show a few options" says "while it's on"
    When I add the habit "Show a few options"
    Then the Recipes sidebar lists "Show a few options" as "on"
    And the habit of "Show a few options" says "is being told this"
    And nothing in the Recipes view is waiting on the runner

  @recipes.examples @recipes @swift-pending
  Scenario: A recipe's page flips between its examples and goes back to the gallery
    When I open the Recipes view
    And I open the recipe "Daily brief"
    Then the recipe page for "daily-brief" shows example 1 of 3
    When I go to example 2
    Then the recipe page for "daily-brief" shows example 2 of 3
    When I go back to all recipes
    Then the gallery is showing
