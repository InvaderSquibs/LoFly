Feature: Smoke the active page
  As a QA fly
  I want to interact with whatever tab is open
  So that Gherkin drives real sites

  Scenario: Find something clickable
    When I click "Sign in"
    Then I should see "Password"
