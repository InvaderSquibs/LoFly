Feature: FlyMart checkout
  As a QA fly
  I want to buy an odor from the catalog and check out
  So that Gherkin steps resolve against a real multi-page DOM

  Scenario: Buy banana extract and place an order
    Given I am on the "Home" page
    When I click "Browse catalog"
    Then I should see "Banana extract"
    When I click "Add Banana extract to cart"
    And I click "Cart"
    Then I should see "Banana extract"
    When I click "Checkout"
    And I fill "Email" with "lofly@nest.test"
    And I fill "Ship to" with "42 Kenyon Lane"
    And I select "Payment" as "Mushroom body points"
    And I click "Place order"
    Then I should see "Order confirmed"
    And I should see "lofly@nest.test"
