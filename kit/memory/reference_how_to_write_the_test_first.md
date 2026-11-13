---
name: How to write the test first
description: Write the test first, add tests for this, TDD, fix this bug and prove it stays fixed: how to write one failing test, watch it fail for the right reason, write the least code that passes, then run the whole test suite. Read before writing code that needs a test.
type: reference
metadata:
  type: reference
  asserted: 2026-11-13
  updated: 2026-11-13
  kit_version: 1
  kit_hash: 5ffd7de072aa272d
---

# How to write the test first

The loop, repeated once per behaviour:

1. Write one test for one behaviour and name it after that behaviour. Run the real code path. Use a mock only for something slow or external.
2. Run it and watch it fail. Read the failure message. It must fail because the behaviour is missing, not because of a typo, a wrong import or a bad path. A test that passes at once is checking something that already exists, so fix the test.
3. Write the least code that makes it pass. No extra options, no tidying of other code, nothing the test does not ask for.
4. Run the test again, then run the whole test command of the project, not only your file. The scope of a task limits what you build, not what you check. Name every failure you see in your report, including ones you did not cause.
5. Only now clean up duplication and names, with everything still green. Then take the next behaviour.

For a bug, the first test reproduces the bug and fails for that reason. After the fix turns it green, prove the test guards the fix: undo the fix once, confirm the test fails again, restore the fix, confirm it passes.

## Excuses and the answer to each

- "Too simple to test." Simple code breaks, and the test takes a minute.
- "I will add the test after." A test written after the code passes at once and proves nothing. It records what the code does, not what it should do.
- "I tested it by hand." There is no record of it and it cannot be run again.
- "The test is hard to write." The design is probably too coupled. Simplify the interface first.

## Where it applies

A failing test first is required for every security or correctness bug. For other new behaviour, and for refactors that change behaviour, in code that has tests, treat it as the default. Skip it for throwaway prototypes, generated code and plain configuration, and say that you skipped it.

If code was written before its test, do not delete it. Keep the part that matters, that you have seen the test fail, and get there by undoing the change once, watching the test fail, and restoring the change.

The companion on test quality is [[reference_how_to_write_tests_that_can_fail]].

## Related
[[reference_how_to_write_tests_that_can_fail]] [[reference_how_to_plan_test_and_verify]] [[reference_how_to_debug_systematically]] [[reference_how_to_review_work_before_calling_it_done]]
