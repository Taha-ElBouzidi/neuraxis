---
name: How to build software, the engineering rules
description: Build software, write code, review a change, release, is this design sound, how should we engineer this: fifty general engineering rules (task card, design note, small modules, types at boundaries, timeouts and retries, tests, small reviewed changes, safe release, security, records). Read before building, reviewing or releasing code.
type: reference
metadata:
  type: reference
  asserted: 2026-11-13
  updated: 2026-11-13
  kit_version: 2
  kit_hash: f5889615c28cc835
---

# How to build software, the engineering rules

Fifty rules that a developer agent follows. A rule that can be enforced by a script or a hook should be, rather than trusted to memory.

## Before writing code

1. Every task has a card: a one-sentence goal, the exit check that proves it done (at least one run on the live system), the folders it may touch, the risk level, and the memories recalled for it.
2. Write a one-page design note first when a change crosses a component boundary, changes a stored or wire format, adds a dependency or a service, or will take more than a day: goal, non-goals, the design, two alternatives and why not, the live check, the rollback. The person decides open choices before code.
3. Reuse before adding. Look for an existing module, a platform built-in or a dependency already in the repository before writing new code or adding a package. Verify that any new package exists, is mature and is widely used: models invent package names.
4. No rewrite into another language or from scratch without a written reason (a bug class, a measured limit, a platform rule) and an oracle (tests or the old version) to compare against.

## Designing the code

5. Deep modules, split by responsibility. A module hides a decision likely to change behind a small interface; split where a responsibility ends, never to meet a line quota. One folder is one module with one entry file that other modules import.
6. Files stay readable in one pass: a soft limit of 400 lines and a hard limit of 800, generated files exempt.
7. Parse outside data once, at the boundary, with a schema into a precise type. No casts, `any` or non-null assertions on outside data, model output included. Use discriminated unions so illegal states cannot be written.
8. One schema per contract, imported by both sides and validated in the tests of both sides.
9. Keep logic pure and push input and output to the edges, so logic is tested without mocks.
10. State the growth. A loop over data that grows (records, messages, logs) notes its complexity; nothing quadratic over an unbounded collection.
11. Comments say why, units, invariants and traps; never who, when or version history.
12. Use the strict type checker of the language for new code, and add type checking to existing untyped code as it is changed.

## Reliability

13. Every call that leaves the process has a timeout (network, database, model, mail, child process).
14. Retry only idempotent operations, at one layer, capped, with exponential backoff and jitter.
15. Every message, task and payment carries a unique id, and handlers ignore repeats. Delivery is at least once.
16. No empty or log-and-continue catch. A catch recovers with a stated reason, rethrows with context, or logs and stops; degraded modes announce themselves.
17. Slow or CPU-heavy work runs off the thread that answers requests and health checks, with a time limit.
18. Bound everything: queues, caches, result sets, log files, retries, memory per process.
19. One source of truth per kind of data, and everything derived has a rebuild script. Files are written atomically (a temporary file, then a rename).
20. Formats change in expand, migrate and contract steps. Readers ignore unknown fields, and the previous release can read the new data.

## Testing

21. A bug fix starts with a test that fails without the fix.
22. Every test names the break it catches, never asserts on a mock, and uses expected values worked out by hand.
23. Error paths get their own tests (network down, file missing, malformed input, timeout).
24. Before changing untested code, pin its behaviour with characterization tests.
25. Judge a test suite by the mutants it kills, not by coverage: for each change, name a few small breaks and check that a test fails for each, and run a mutation testing tool on core modules.
26. Unit tests are hermetic (no real network, injected clock, temporary directories) and the live system has its own smoke test. A flaky test is fixed or quarantined within a day, never retried until it is green.
27. Work in small steps that each end green. The test-first order matters less than the step size.

## Changes, review and merge

28. One task, one branch, one worktree. Stage files by name, never everything at once. No backup copies in a repository, because version control is the backup. Delete the worktree and branch when the task is released or dropped.
29. Small changes: a change for review aims under 200 changed lines and few files, and above 400 lines it is split unless it is mechanical.
30. A refactor and a behaviour change never share a commit.
31. Checks report inside the diff before review: type check, lint and static analysis on the changed lines, with rules tuned until almost every finding is acted on.
32. The author never reviews its own change. A fresh agent reviews the diff against the task card, correctness and design first and no style (style is the job of the formatter). Security, data-format and release-tool changes get a second reviewer from another model family.
33. Review is also for knowledge: the owner of the module reviews or is told, and the reviewer leaves a one-line summary of what changed and why.
34. Every module has one owning agent, named in an owners file, and changes by other agents go through that agent.
35. "Done" is evidence: the command run and its output, not a claim.
36. Merge one change at a time, tested on top of the current main branch. A commit touches only the folders the task allows, and no agent commits directly on the main branch.

## Release and operations

37. Only the release script sets a version, after the checks passed on that exact commit, and it builds the artifact that is tested on a clean install.
38. Staged rollout with bake time: one canary, a set watch period comparing error counts with the rest, then everyone. A failed live smoke test rolls back automatically.
39. Roll back first and debug after. The previous release is always on disk.
40. A blameless postmortem for every incident the person noticed before an agent did, any data loss, any wrong message sent and any rollback: a timeline, causes, action items with owners, and the trap saved to memory.
41. Structured logs with common fields, and no secrets, tokens or inbound message bodies.
42. Measure delivery, never activity: deployment frequency, lead time, change failure rate, recovery time and rework rate, computed from version control and release records, never lines of code or commits per agent.

## Security

43. Secrets live outside repositories, logs and messages, secret files are blocked from reading by agents, and a leaked secret is rotated.
44. Dependencies: exact versions, a committed lockfile, a release-age cooldown, no install scripts unless allowed by name, and security advisories for frameworks patched within days.
45. No session holds untrusted input, private data and the power to act all at once.

## Building AI parts (memory, recall, context)

46. Every change to retrieval, prompts, models or context rules is measured on a held-out evaluation before and after, and the evaluation itself is broken on purpose now and then to prove it can fail.
47. Index and query use the same embedding model, version, quantisation and pooling. Changing any of them means embedding everything again and re-running the evaluation.
48. Give agents less context, loaded just in time, and an outside check on their work. Instruction files stay short (one per repository under 100 lines: purpose, commands, owner, non-obvious boundaries), tools return short, meaningful output, and a compiler, a test or a fresh reviewer closes each loop.

## Records of the work

49. Commit messages: a subject under 72 characters in the imperative mood, no version number, and a body that says why, with a task trailer and a decision trailer when there is one.
50. Every decision goes to the decision log at once. A decision that shapes code for months also gets a short decision record. Every session or stopped task ends with a handoff note (state, what was verified with the command and output, what was not, the next step, traps; under 40 lines).

Related topics have their own files: [[reference_how_to_plan_test_and_verify]], [[reference_how_to_write_the_test_first]], [[reference_how_to_write_tests_that_can_fail]], [[reference_how_to_handle_review_feedback]], [[reference_how_to_structure_a_repo]].

## Related
[[reference_how_to_plan_test_and_verify]] [[reference_how_to_debug_systematically]] [[reference_how_to_review_work_before_calling_it_done]] [[reference_how_to_write_the_test_first]] [[reference_how_to_write_tests_that_can_fail]] [[reference_how_to_handle_review_feedback]] [[reference_how_to_structure_a_repo]] [[reference_how_to_write_a_plan_an_agent_can_build_from]]
