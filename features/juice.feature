Feature: The small motions
  As someone clicking about the app all day
  I want what I do to answer with a small motion where it lands
  So it feels alive without ever slowing me down

  # Mike picked these from the Swift app's, filmed beside GPUI's, on 13 Nov
  # (the bears he passed over). Most are only seen on video
  # (features/tools/motion-clip.ts); the GPUI app's dump says where the two
  # that hang on state went (`juice`). The Swift app's dump doesn't.

  Background:
    Given the app is connected to a runner with the demo threads

  @sidebar.rowmotion @swift-pending
  Scenario: A row archived from its button slides off before it goes
    Given I open the thread "Morning brief"
    When I hover the row "Tidy the imports in the uploader"
    And I press the row button "Archive"
    Then the row "Tidy the imports in the uploader" slid off

  @card.done @swift-pending
  Scenario: A card that arrives while I'm watching settles in
    Given I open the thread "Morning brief"
    When I send "Any follow-ups?"
    Then the card that came settled in

  # Confetti for the rare wins: Mike picked it from three directions on 18
  # Nov, for the inbox reaching zero and a login's year-long token
  # (usage.feature). Only the GPUI app has it.
  @juice.confetti @swift-pending
  Scenario: Archiving the last thread in the Inbox throws confetti from the empty inbox
    When I archive every thread in the Inbox but "Compare account picker designs"
    Then no confetti was thrown
    When I archive every thread in the Inbox
    Then confetti popped from the empty inbox

  # Mike picked these from clips on 18 Nov: picking an answer is the button
  # he presses most, and it only changed colour.
  @juice.pickfill @swift-pending
  Scenario: An answer I pick fills its button
    Given I open the thread "Ship the beta to TestFlight"
    When I pick the first answer on the card
    Then the answer's button filled

  @juice.picturedrop @swift-pending
  Scenario: A picture I paste drops into the box
    Given I open the thread "Morning brief"
    When I paste a picture into the box
    Then the picture dropped into the box

  @juice.replyfade @swift-pending
  Scenario: A reply fades in as it streams
    Given I open the thread "Morning brief"
    When I send "Any follow-ups?"
    Then a reply's new words fade in as they stream
    And the card that came settled in

  @juice.confetti @swift-pending
  Scenario: A thread milestone throws confetti from its note
    When the thread count reaches 1000 with 100 already remembered
    Then the milestone says "That's 1,000 threads"
    And confetti popped from the milestone note
