---
name: How to write a plan an agent can build from
description: Write the plan, break this into tasks, turn the spec into steps, plan the sprint for an agent to build, hand it to an implementer: how to write an implementation plan that someone who has never seen the code can follow, and check it against the spec before handing it over.
type: reference
metadata:
  type: reference
  asserted: 2026-11-13
  updated: 2026-11-13
  kit_version: 1
  kit_hash: 2d428028ce206bcd
---

# How to write a plan an agent can build from

The reader writes good code in the project's language but has not seen this code or this spec, and will make a sensible choice wherever the plan leaves one open. What the reader cannot know is what you decided: which files, which names and signatures, which exact values from the spec, which tests prove each task. Write those down and nothing else. A plan is the set of decisions the builder cannot make alone.

## Order of work

1. Scope check. If the spec covers several independent subsystems, propose one plan per subsystem, each producing working, testable software on its own.
2. File map first: the files to create or change and what each is responsible for. One responsibility per file, files that change together live together, and follow the existing patterns of the codebase.
3. Cut tasks where a reviewer could reasonably accept one and reject its neighbour. Fold setup, configuration and documentation into the task that needs them. Every task ends with something testable on its own.
4. Per task: the files (create, modify with a line range, test); what it consumes from earlier tasks and what it produces for later ones, with exact names and types (a builder sees only its own task, so this keeps names consistent); then the steps.
5. Steps are one action each with a checkable result: write the failing test, run it and say which failure to expect, implement, run it and say what passes, commit. A test step gives the test name and its assertions with the exact values of the spec. A code step gives the file and the signature and leaves the body to the builder, unless the signature and the tests do not decide an algorithm. A verification step gives the command and the output that means pass.
6. Header: the goal in one sentence, the approach in two or three, the stack, the path to the spec, the global constraints copied word for word from the spec (version floors, naming and copy rules, platform limits), and a review-focus list of the five inputs or failure modes the spec implies but no task tests, most likely first, each with the test that pins it.

## Check it yourself before handing it over

This is a checklist you run yourself, not a job for a sub-agent.

- Spec coverage: a task for every requirement, and a list of any gap.
- Step scan: each step lets the builder write exactly one reasonable thing. A line that decides nothing ("handle edge cases", "to be decided") is a gap. A body that the signature and tests already determine is a transcript.
- Type consistency: names and signatures in later tasks match the earlier ones. A function called clearLayers in task 3 and clearFullLayers in task 7 is a bug.
- Proportion: a plan several times longer than its spec is a transcript of the program. Replace bodies with signatures and assertions.

## Hand it over

Link the plan, ask the person to review it before anything is built, and recommend in one sentence how to run it. This applies to any multi-step build, above all one that another agent will build, and not to a one-line fix. The conversation-level plan, what you tell the person before you start, is in [[reference_how_to_plan_test_and_verify]].

## Related
[[reference_how_to_plan_test_and_verify]] [[reference_how_to_write_the_test_first]] [[reference_how_to_brief_sub_agents_and_pick_models]] [[reference_how_to_set_and_follow_a_goal]]
