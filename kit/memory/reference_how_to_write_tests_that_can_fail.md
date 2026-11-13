---
name: How to write tests that can fail
description: Do these tests test anything, review the tests the agent wrote, write tests for this, the tests pass but I do not trust them, mocks, coverage: how to write tests that can actually fail (name the bug each one catches, hand-written expected values, never assert on a mock). Read before writing or reviewing tests.
type: reference
metadata:
  type: reference
  asserted: 2026-11-13
  updated: 2026-11-13
  kit_version: 1
  kit_hash: 7115e58e863da398
---

# How to write tests that can fail

A test exists to catch one specific break. Two rules cover most of it: every test names the break it catches, and every test exercises the real thing.

## Name the break

Before writing the body, say which change to the production code would make this test fail, and whether that change would be a bug or only a decision. If you cannot name one, redesign the test around something observable or drop it.

- Work out the expected value yourself. Use a literal or a hand-checked fixture. If the expected value is computed by the same function the test checks, the test always passes.
- Do not test decisions. A constant's value or the exact wording of a message fails on every redesign and sleeps through real bugs. Test the behaviour that depends on it: "a failing call is retried five times and a sixth attempt never happens", not "the retry limit equals 5".
- Test what code does, not what its text says. Run a script with controlled input and check its output, side effects or exit code. Do not search your own source for a line.
- Test your own boundary: the route you register, the query you send, the payload you produce. The documented behaviour of a framework is the test of its authors to write.

## Exercise the real thing

- Never assert on a mock. If the check would pass because the mock exists and fail if it is removed, it checks nothing.
- Mock at the right level. List what the real method does (writes configuration, fills a cache, sends an event) and mock only the slow or external part below it, so the effects the test depends on stay real.
- Copy real data completely. A partial fake response passes while the real integration breaks on the field you left out.
- Make doubles specific wherever arguments, counts or order matter, and give each branch (success, error, malformed input) its own fixture, so the wrong branch cannot satisfy the test.
- Code that only tests call, such as a reset or cleanup method, lives in test helpers, not in the production class.
- When the mock setup is bigger than the test, switch to an integration test with the real parts.

## Mutation check before you finish

Imagine five small breaks in the production code: a wrong constant, a wrong branch, a missing side effect, an empty return, a missing check for empty or unauthorised input. At least one test should fail for each. A break that nothing catches means that behaviour is unprotected or a test is empty.

## Where it applies

It applies when writing tests and when reviewing tests written by another agent or another model: never accept generated code unread. The cycle itself is in [[reference_how_to_write_the_test_first]].

A test that passes without proving anything is worse than no test, because it buys false confidence. It is also the guard against trusting a mental model of the code over a real run.

## Related
[[reference_how_to_write_the_test_first]] [[reference_how_to_plan_test_and_verify]] [[reference_how_to_debug_systematically]] [[reference_how_to_review_work_before_calling_it_done]]
