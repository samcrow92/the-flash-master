---
name: Test-driven development
command: tdd
description: Red, green, refactor
---
1. RED: write one small test for the next behaviour. Run it and watch it fail for the right reason.
2. GREEN: write the minimum code to pass. Run the tests.
3. REFACTOR: clean up with all tests green.
Never write production code without a failing test that demands it. Commit after each green step.
For embedded targets, run the logic tests on the host and keep the hardware-dependent layers thin.
