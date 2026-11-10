---
name: How to brief sub-agents and pick the right model
description: Parallel agents, helpers, sub agents, fork, branch, a copy of this conversation, delegate, split the work, which model to use: what a helper, a branch helper, a fork helper, a branch and a fork are and when to use which, how much to spend, the six part brief a sub-agent needs, and the small, balanced or strongest model choice.
type: reference
metadata:
  type: reference
  asserted: 2026-09-26
  updated: 2026-11-10
  kit_version: 3
  kit_hash: 3dc3afe3d3b7fb2e
---

# How to brief sub-agents and pick the right model

A sub-agent is worth starting only when a task splits into parts that do not depend on each other: researching several options, checking several files, writing tests while another agent reads documentation. Those parts can run in parallel and in the background, so the main conversation is not blocked waiting on them, but only as far as the person's plan allows. A task whose steps each need the previous step's result should not be split; that work gets done directly, in order, by whoever is already holding the context.

## Helpers, branches and forks: the words, and when to use which

Five words, used the same way by you and the person. Explain them in two sentences each when you set up
(AGENTS.md checklist item 8).

| Word | What it starts from | Who sees and steers it | In Claude Code |
|---|---|---|---|
| **branch helper** | a copy of this conversation | hidden; it works for you and reports back | the Agent tool with the fork type |
| **fork helper** (a sub-agent) | a clean context and your written brief | hidden; it works for you and reports back | the Agent tool with a normal sub-agent type |
| **branch** | a copy of this conversation | the person, in a new terminal tab | `claude --resume <this session id> --fork-session` |
| **fork** | a clean context and a written brief | the person, in a new terminal tab | `claude`, with the brief as its first message |
| **agent** | its own standing name and context | the person, who comes back to it | see [[reference_how_to_create_an_agent]] |

Which one:

- **The work is yours and ends with this task:** a helper. Over material already read in this conversation (a long
  file, a long discussion), use **branch helpers**: they read your conversation from the prompt cache instead of
  reading the material again. Measured on Claude Code with three helpers over one file: about 58 percent cheaper than
  three fresh helpers that each read it. Read the material once yourself first, then start them. On new, unrelated
  material, a **fork helper** with a full brief is lighter, because it does not carry your whole conversation.
  A helper that starts helpers of its own pays the full start again for each one: avoid it.
- **The person wants to follow and steer it:** a branch or a fork, opened only when they ask, in a new tab of the
  terminal they use, never a new window. A **branch** when they want to try another direction from the same point and
  keep this conversation as it is; a **fork** when it is a separate task that does not need this conversation's past.
- **The person will come back to the same area again and again:** a standing **agent**.
- **One small task:** none of these. Do it yourself.

Every helper costs usage; the plan below decides how many you may start. Name each one's model and the reason in one
line when you start it (Choosing the model, below). Assistants other than Claude Code may not offer all five: say
which ones the person's assistant has.

## How much the plan allows

The plan setting (`node tools/plan.mjs`, shown as a PLAN line in every turn) comes first. On a small plan, such as 20 dollars a month, no sub-agent and no background task starts unless the person asks for one, and the one they ask for runs on the small or balanced model with low effort. On a standard plan, a sub-agent may start on its own only for a large task with independent parts, at most two at a time. On a large plan, sub-agents may run in parallel in the background, still no more than the task needs.

## How much delegation a question deserves

Scale the effort to the question rather than defaulting to a fixed number of agents. A single fact needs no sub-agent, or at most one doing a few searches. A comparison of options fits two to four sub-agents, one per option or angle. A genuinely wide research question can take more, each with a narrow slice. Ten agents dispatched on a simple question waste time and money and mostly return duplicate work; the judgment call is matching the split to how independent and how large the task really is.

## What a workable brief contains

A sub-agent does not see the conversation that spawned it and has no memory recall of its own. It knows only what the brief tells it, so the brief has to stand on its own:

1. The goal, in one sentence, and what "done" looks like.
2. The facts it needs, including any relevant memory copied in directly rather than referenced as "as discussed".
3. Exact places to look: file paths, URLs, names, never "search the whole disk".
4. Limits: what it must not do, such as edit files, send anything, install, or delete, plus a size or time limit.
5. The exact output format wanted back, with a length limit.
6. How it should check its own result before returning it.

The agent holding the conversation is the one that recalls memory; a sub-agent only ever gets what its brief hands it.

## Choosing the model

Name the model and the reason in one line whenever a sub-agent or a large task is started.

| Task | Tier | Examples |
|---|---|---|
| Finding files, searching, simple lookups, reading and listing | Small and fast | a lightweight or mini-class model |
| Summarizing, writing and editing documents, routine code, tests, refactors | Balanced | a mid-tier general model |
| Planning, architecture, hard debugging, security, decisions with real consequences | Strongest | the strongest reasoning model available |

Judgment never goes to the small tier, even when it would be cheaper. If the model actually running a session is weaker than the task in front of it needs, that gets said before starting, along with which model to switch to. Available models depend on the account in use; on a plan with tight limits, the strongest tier is reserved for the jobs that actually need it.

## After a sub-agent returns

What a sub-agent returns is checked before it is relied on or reported onward. Its "done" is a claim, not a result, so the file gets opened, the test gets run, and the source gets read, the same as with any other claim of completion; see [[reference_how_to_review_work_before_calling_it_done]].

## Related
[[reference_how_to_review_work_before_calling_it_done]] [[reference_how_to_research_with_sources]] [[reference_how_to_create_an_agent]] [[reference_how_to_message_another_agent]] [[feedback_sub_agents_get_a_ready_brief]] [[feedback_best_model_for_each_task]]
