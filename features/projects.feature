Feature: A project's parts
  As someone with a big project split into parts
  I want each part shown inside its parent and saying whose it is
  So the Projects page stays one card a project

  Background:
    Given the app is connected to a runner with the demo threads

  @projects.parts @project-parts
  Scenario: A part shows inside its parent's card and says whose it is
    When I show the Projects page
    Then the project card "Threadbear" says "(parts: Photo sync)"
    When I open the project "Photo sync"
    Then the project page says it's a part of "Threadbear"
    When I open the project "Threadbear"
    Then the project page lists the part "Photo sync"

  @projects.parts @project-parts
  Scenario: A project can be made its own again
    When I open the project "Photo sync"
    And I make the project "Photo sync" its own project
    Then the project page says it's a part of nothing
