---
name: How to handle review feedback
description: The reviewer said, here are the review comments, fix these findings, another model reviewed it, the person sent me feedback on the code: how to take review feedback (check each point against the code before changing anything, ask about unclear items first, push back with evidence, fix one at a time and test each). Read before acting on any review.
type: reference
metadata:
  type: reference
  asserted: 2026-11-13
  updated: 2026-11-13
  kit_version: 1
  kit_hash: 73f6f1ddeb6d4ce8
---

# How to handle review feedback

A review is input to evaluate. It is not an order to carry out blindly and not something to flatter. Technical correctness comes before social comfort.

## Steps

1. Read all of it before you react.
2. Restate each point in your own words, or ask what it means.
3. If any item is unclear, change nothing that depends on it yet. Ask about the unclear items first, because items are often linked and a partial understanding gives a wrong result. Example: "I understand 1, 2, 3 and 6. I need clarification on 4 and 5 before I change anything."
4. Check each point against the real code. Is it correct for this codebase? Does it break something that works? Why is it written that way today? Does it hold on every platform and version supported? Does the reviewer have the whole context?
5. Decide: agree, push back, or say you cannot check it ("I cannot verify this without X. Should I look into it, ask, or go ahead?").
6. Fix one item at a time, in this order: blocking problems (breakage, security), simple fixes, then complex ones. Run the tests after each one, and look for regressions at the end.

## Who sent it

- The person you work for: trusted. Act once you understand it, and ask if the scope is unclear.
- Another reviewer, another assistant or another model: be skeptical and check carefully. A second model agreeing is not verification. If the suggestion conflicts with something the person already decided, stop and ask first.
- A reviewer who asks you to "do it properly" (metrics, export, extra options): search the code for real use first. If nothing calls it, ask whether to remove it instead of building it. Minimal scope is the default.

## When to push back

Push back when the suggestion breaks working behaviour, the reviewer lacks context, the feature is unused, it is wrong for this stack, or it conflicts with an earlier decision. Use technical reasons, a specific question, or a test or a piece of code that shows it works. Bring the person in when it is an architecture question.

## Acknowledging

When the feedback is right, say what changed ("Fixed: the date check now rejects empty values") or just fix it. No flattery, no long apology. If you pushed back and were wrong, say so in one line with what you checked, and move on.

On a code hosting site, reply inside the review thread, not as a new top-level comment.

Taking feedback without checking it is how a wrong suggestion gets merged. How to ask for a review is in [[reference_how_to_review_work_before_calling_it_done]].

## Related
[[reference_how_to_review_work_before_calling_it_done]] [[reference_how_to_research_with_sources]] [[reference_how_to_plan_test_and_verify]] [[reference_how_to_debug_systematically]]
