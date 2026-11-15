# This Mac setting and native guard have no Swift automation commands.
# Other platforms keep their existing test window behavior.
@swift-pending @windows-pending @linux-pending
Feature: Choose whether Threadbear testing windows are hidden
  @settings.general
  Scenario: New test copies are hidden and the switch can be saved off
    When I open Settings on "general"
    Then Hide all testing windows is on
    And all of this test copy's visible windows are transparent and ignore the mouse
    When I press "Hide windows from new Threadbear test and debug copies" in Settings
    Then Hide all testing windows is off
    And all of this test copy's visible windows are transparent and ignore the mouse
    When I relaunch the testing copy
    And I open Settings on "general"
    Then Hide all testing windows is off
