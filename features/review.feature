Feature: Design reviews
  As someone an agent shows design options to (its show_options)
  I want them in a window of their own, big enough to compare
  So I can step through them, read why under each, tick one or several, say why and send it

  # The demo thread's review has four options, each one picture: A, B and C to
  # pick from, C the agent's pick, and D for reference only.
  Background:
    Given the app is connected to a runner with the demo threads
    When I open the thread "Compare account picker designs"

  @review.window @transcript.review
  Scenario: The card opens the review on its first option
    When I press "Compare 4 images"
    Then the review window is open on option "A"

  # The card shows each option's small picture and name (Mike, 20 Nov: the
  # reply needn't list them), and a click on one opens the window on it. The
  # Swift app's card has only the button.
  @review.window @transcript.review @swift-pending
  Scenario: An option's picture on the card opens the review on that option
    When I press the picture of "C. Account pools" on the review's card
    Then the review window is open on option "C"

  @review.window
  Scenario: A review: link in the agent's reply opens that review
    When I follow the link "review:review_account" in the agent's last reply
    Then the review window is open on option "A"

  # An ask's link is followed from inside the composer's own update, and the
  # transcript read the composer back to reach the app, which crashed the
  # GPUI app ("Open the design options" on a card, 12 Nov).
  @review.window @card.needsyou
  Scenario: A review: link on an ask in the composer opens that review
    When I send "Which one? Pick a design"
    Then the card in the composer asks "Pick one of the account picker designs"
    When I press link 1 of ask 1 on the card
    Then the review window is open on option "A"

  @header.pendingreviews
  Scenario: The bar over the thread says how many reviews are waiting
    Then the bar over the thread says "Review design options (1)"

  # The Swift bar's list is a popover, a window of its own that the Swift
  # app's `click` doesn't look in.
  @header.pendingreviews @swift-pending
  Scenario: The bar's list opens a review that's waiting
    When I press the bar's "Review design options (1)"
    And I press the review "Account picker" in the bar's list
    Then the review window is open on option "A"

  @review.picks
  Scenario: Ticking options says what Send will send
    When I open the review
    And I tick "B" in the review
    And I tick "C" in the review
    Then the review's Send says "Send B + C"
    When I choose None in the review
    Then the review's Send says "Send none of them"
    And no option is ticked in the review

  @review.picks
  Scenario: An option there for reference can't be ticked
    When I open the review
    Then "D" has no tick in the review

  @review.picks
  Scenario: Closing the window keeps the draft
    When I open the review
    And I tick "B" in the review
    And I write "Bigger, please" in the review
    And I close the review
    And I open the review
    Then the review has "B" ticked and the reply "Bigger, please"

  # Voice Type puts what Mike says on the clipboard and presses ⌘V in the
  # window in front. He ticks an option and talks straight away, before
  # clicking the reply box, and the words went nowhere (12 Nov). The Swift
  # app's `clipboard` can't be set from a script.
  @review.picks @swift-pending
  Scenario: Words pasted after ticking an option go in the reply box
    When I open the review
    And I tick "B" in the review
    And I paste "Bigger, please" in the review with ⌘V
    Then the review has "B" ticked and the reply "Bigger, please"
    When I paste ". That one." in the review with ⌘V
    Then the review has "B" ticked and the reply "Bigger, please. That one."
    When I close the review
    And I open the review
    Then the review has "B" ticked and the reply "Bigger, please. That one."

  # Mike, 17 Nov: a screenshot pasted in the reply went in as its file path,
  # where the thread's box makes it a chip, so the agent never saw it.
  @review.picks @swift-pending @windows-pending @linux-pending
  Scenario: A picture pasted in the reply is a chip and goes with the answer
    When I open the review
    And I tick "C" in the review
    And I paste "Is it cut off at the bottom? " in the review with ⌘V
    And I paste a picture in the review with ⌘V
    Then the review's reply holds 1 picture, and says "Is it cut off at the bottom? [Picture 1]"
    # Mike, 17 Nov: to look at it full size, as a chip in the thread's box opens.
    When I click picture 1 in the review's reply
    Then the review shows picture 1 of 1 full size
    When I close the picture in the review
    And I press Send in the review
    Then the review window has closed
    And the transcript shows my message "Review: Account picker"
    When I press "Open review"
    Then the review window shows it sent "Is it cut off at the bottom? [Picture 1]" with 1 picture

  @review.picks
  Scenario: Sending answers the agent, and the review can't be changed after
    When I open the review
    And I tick "C" in the review
    And I write "C, please." in the review
    And I press Send in the review
    Then the review window has closed
    And the transcript shows my message "Review: Account picker"
    When I press "Open review"
    Then the review window shows what was sent: "C" and "C, please."
    And nothing can be changed in the review
