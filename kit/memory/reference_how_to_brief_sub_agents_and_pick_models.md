---
name: How to brief helpers and sub-agents and pick the right model
description: Parallel agents, helpers, sub agents, sub-agents, fork, branch, a copy of this conversation, a clean context, delegate, split the work, which model to use: what a branch and a fork are (the two ways to start one), what a helper (hidden) and a sub-agent (visible, answers to the agent above it) are, when to use which, how much to spend, the six part brief a helper needs, and the small, balanced or strongest model choice.
type: reference
metadata:
  type: reference
  asserted: 2026-09-26
  updated: 2026-11-13
  kit_version: 5
  kit_hash: 1330eeab05625cbe
---

# How to brief helpers and sub-agents and pick the right model

A helper is worth starting only when a task splits into parts that do not depend on each other: researching several options, checking several files, writing tests while another reads documentation. Those parts can run in parallel and in the background, so the main conversation is not blocked waiting on them, but only as far as the person's plan allows. A task whose steps each need the previous step's result should not be split; that work gets done directly, in order, by whoever is already holding the context.

## The words: branch, fork, helper, sub-agent, agent

Use these words the same way as the person. Explain them in two sentences each when you set up (AGENTS.md checklist
item 8).

**Two ways to start one.** Every helper or sub-agent starts one of two ways:

- a **branch** is an exact copy of the current conversation;
- a **fork** is a new conversation with a clean context, started with a written brief.

**Three kinds, by who sees them and whom they answer to:**

| Kind | Visible to the person | Answers to | Starts as | In Claude Code |
|---|---|---|---|---|
| **helper** | no, hidden | the agent that started it; reports back and ends with its task | a branch or a fork | the Agent tool: the fork type for a branch, a normal type with a full brief for a fork |
| **sub-agent** | yes, its own tab and name | the agent above it; standing (comes back to the same area) or for one task | a branch or a fork | branch: `claude --resume <this session id> --fork-session`; fork: `claude` with the brief as its first message |
| **agent** | yes | the person directly; the top of its own tree | its own setup | see [[reference_how_to_create_an_agent]] |

A sub-agent is part of the tree of the agent that opened it: it takes its work from that agent and reports to it,
even though the person can see and steer it. An agent answers to nobody but the person.

Which one:

- **The work is yours and ends with this task:** a helper. Over material already read in this conversation (a long
  file, a long discussion), start it as a **branch**: it reads your conversation from the prompt cache instead of
  reading the material again. Measured on Claude Code with three helpers over one file: about 58 percent cheaper than
  three fresh helpers that each read it. Read the material once yourself first, then start them. On new, unrelated
  material, a helper started as a **fork** with a full brief is lighter, because it does not carry your whole
  conversation. A helper that starts helpers of its own pays the full start again for each one: avoid it. A branch pays a cache read of the whole conversation on every request, so it is cheapest when each branch is short; for long jobs on a very large conversation, fresh helpers with a short brief that names the exact lines to read can cost less.
- **The person wants to follow and steer the work, and it still belongs to you:** a sub-agent, opened only when they
  ask, in a new tab of the terminal they use, never a new window. Start it as a **branch** when they want to try
  another direction from the same point and keep this conversation as it is; as a **fork** when it is a separate task
  that does not need this conversation's past. It may stay (a standing sub-agent for one area) or end with its task.
- **A separate area the person runs directly, not through you:** a new **agent**.
- **One small task:** none of these. Do it yourself.

Every helper and sub-agent costs usage; the plan below decides how many you may start. Name each one's model and the
reason in one line when you start it (Choosing the model, below). Assistants other than Claude Code may not offer all
of these: say which ones the person's assistant has.

## How much the plan allows

The plan setting (`node tools/plan.mjs`, shown as a PLAN line in every turn) comes first. On a small plan, such as 20 dollars a month, no helper and no background task starts unless the person asks for one, and the one they ask for runs on the small or balanced model with low effort. On a standard plan, a helper may start on its own only for a large task with independent parts, at most two at a time. On a large plan, helpers may run in parallel in the background, still no more than the task needs.

## How much delegation a question deserves

Scale the effort to the question rather than defaulting to a fixed number of helpers. A single fact needs no helper, or at most one doing a few searches. A comparison of options fits two to four helpers, one per option or angle. A genuinely wide research question can take more, each with a narrow slice. Ten helpers dispatched on a simple question waste time and money and mostly return duplicate work; the judgment call is matching the split to how independent and how large the task really is.

## What a workable brief contains

A helper started as a fork does not see the conversation that started it and has no memory recall of its own. It knows only what the brief tells it, so the brief has to stand on its own:

1. The goal, in one sentence, and what "done" looks like.
2. The facts it needs, including any relevant memory copied in directly rather than referenced as "as discussed".
3. Exact places to look: file paths, URLs, names, never "search the whole disk".
4. Limits: what it must not do, such as edit files, send anything, install, or delete, plus a size or time limit.
5. The exact output format wanted back, with a length limit.
6. How it should check its own result before returning it.

The agent holding the conversation is the one that recalls memory; a helper only ever gets what its brief hands it (or, started as a branch, the conversation it was copied from).

## Choosing the model

Name the model and the reason in one line whenever a helper, a sub-agent or a large task is started.

| Task | Tier | Examples |
|---|---|---|
| Finding files, searching, simple lookups, reading and listing | Small and fast | a lightweight or mini-class model |
| Summarizing, writing and editing documents, routine code, tests, refactors | Balanced | a mid-tier general model |
| Planning, architecture, hard debugging, security, decisions with real consequences | Strongest | the strongest reasoning model available |

Judgment never goes to the small tier, even when it would be cheaper. If the model actually running a session is weaker than the task in front of it needs, that gets said before starting, along with which model to switch to. Available models depend on the account in use; on a plan with tight limits, the strongest tier is reserved for the jobs that actually need it.

## After a helper or a sub-agent returns

What a helper or a sub-agent returns is checked before it is relied on or reported onward. Its "done" is a claim, not a result, so the file gets opened, the test gets run, and the source gets read, the same as with any other claim of completion; see [[reference_how_to_review_work_before_calling_it_done]].

## Related
[[reference_how_to_review_work_before_calling_it_done]] [[reference_how_to_research_with_sources]] [[reference_how_to_create_an_agent]] [[reference_how_to_message_another_agent]] [[feedback_sub_agents_get_a_ready_brief]] [[feedback_best_model_for_each_task]]
