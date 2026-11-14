# The frozen Swift app has these behaviors, but these scenarios use the new
# GPUI draft/file automation. Its original BacklogComposerTests cover Swift.
@swift-pending
Feature: Save tasks for later in Backlog
  Saved prompts and conversations put aside for later belong in Backlog,
  separate from conversations in Inbox. Opening a saved prompt starts no agent.

  Background:
    Given the app is connected to a runner with the demo threads

  @sidebar.sections
  Scenario: Save a prompt without starting an agent
    When I start a new thread
    And I type "Plan the garden" in the composer
    And I save the composer to Backlog
    Then "Plan the garden" appears only in Backlog
    And the composer says "Plan the garden"
    And the saved task has no messages or running agent

  @sidebar.sections
  Scenario: Put an existing conversation aside and bring it back
    When I open the thread "Morning brief"
    And I move the open conversation to Backlog
    Then "Morning brief" appears only in Backlog
    When I move the open conversation to Inbox
    Then "Morning brief" appears only in Inbox

  @sidebar.sections
  Scenario: Autosave keeps spaces and blank lines
    When I start a new thread
    And I paste "Plan the garden  \n\n" into the composer
    And I save the composer to Backlog
    And I paste "Add trees  \n\n" into the composer
    And I wait a moment
    Then the runner keeps the saved prompt exactly as "Plan the garden  \n\nAdd trees  \n\n"
    When I reopen the saved Backlog task
    Then the composer says the lines "Plan the garden  \n\nAdd trees  \n\n"

  @sidebar.sections
  Scenario: Cancel deleting a saved task
    When I start a new thread
    And I type "Keep this task" in the composer
    And I save the composer to Backlog
    And I ask to delete the saved Backlog task
    And I cancel the deletion
    Then "Keep this task" appears only in Backlog

  @sidebar.sections
  Scenario: Confirmed deletion shows progress while the runner removes the task
    When I start a new thread
    And I type "Remove this task" in the composer
    And I save the composer to Backlog
    And the runner takes its time to start threads
    And I ask to delete the saved Backlog task
    And I confirm the deletion
    Then deletion shows progress
    And the saved task "Remove this task" disappears

  @composer.filedrop
  Scenario: Imported files stay with the saved task until removed or sent
    When a captured Backlog task named "Captured task" arrives with a file
    And I open the thread "Captured task"
    Then the saved task offers the file "task-notes.txt"
    When I preview the saved task's file "task-notes.txt"
    Then the preview shows "Notes captured for the saved task."
    When I remove the saved task's file "task-notes.txt"
    Then the saved task has no imported files

  @composer.filedrop
  Scenario: Starting a captured task sends its owned files
    When a captured Backlog task named "Read captured notes" arrives with a file
    And I open the thread "Read captured notes"
    And I press Return
    Then the runner received the imported file "task-notes.txt"

  @highlights.librarian
  Scenario: Prepared context is separate from the saved prompt
    When a captured Backlog task named "Garden task" arrives with prepared context "The garden project already has a planting plan."
    And I open the thread "Garden task"
    Then Highlights shows prepared task context "The garden project already has a planting plan."
    And the composer says "Garden task"
