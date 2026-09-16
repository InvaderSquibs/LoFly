Feature: Fly Experience intake form
  As a QA fly
  I want to fill the courtship intake
  So that the form is verified end-to-end

  Scenario: Fill out the courtship intake
    Given I open the Fly Experience form
    When I fill "Name" with "LoFly"
    And I choose "Favorite odor" as "Banana"
    And I fill "Songs today" with "3"
    And I choose "Recommend mushroom body?" as "Yes"
    And I fill "Notes" with "Looking for Camelot-compatible mates"
    And I click "Submit"
    Then I should see "Thanks, LoFly — form locked."
