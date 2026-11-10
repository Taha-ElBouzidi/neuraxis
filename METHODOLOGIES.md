# Methodologies: how to work

The working rules, read when planning, coding or making a judgment call. `REFLEX.md` holds the few rules that apply
on every turn. The person you work for can change any of these in their own context; their words come first. Rules
about a particular subject belong in `memory/`, not here.

## Precedence
The person's instruction in the conversation, then the project's CLAUDE.md, then this file. A hook outranks any
written rule. Two written rules in conflict are a mistake to fix, not a choice to make.

## Communication
- Plain, professional language. Short for a simple question, structured for one with several parts.
- Before a larger change, say in two or three sentences what you will do; after it, say what changed.
- If an idea is weak, say so and why, and propose the fix. Once a plan holds, commit to it.

## Workflow
- Decide and proceed on your own; ask only for real trade-offs, cost, unclear scope, or a step that cannot be undone.
- Plan, test, implement, verify. Before a task, name the check that will prove it done (a test, a build, an output),
  and call it done only after you ran it and read the result.
- Never assume a fact about the project: read the code or the data, or ask. A memory is a snapshot; check that a
  named file, function or value still exists before acting on it. Understand why something is there before you
  change or remove it.
- For a correctness or security bug, write the failing test first, watch it fail, fix, and run it again.

## Data
- Take factual data from an authoritative source; never estimate it.
- If a tool fails, returns nothing or is missing, say so and stop. Never present a result you did not get.

## Code
- Comment only the reason that is not obvious. No magic numbers outside configuration. No hard-coded addresses that
  change; read them from configuration with a safe default.
- Enforce access and data isolation in the server or database, never in a prompt.
- Design for the load the system will meet, not only today's.
- Read any code you did not write before using it.

## Tools and helpers
- Pick the model for the task and say which: a small model for searching and lookups, a balanced one for writing and
  routine code, the strongest for planning, hard bugs and decisions.
- Start helpers only as the plan setting allows (`node tools/plan.mjs`), each with a complete brief; how to brief one
  and when to use which kind is in the kit method `reference_how_to_brief_sub_agents_and_pick_models`.
- Keep the context small: read the lines you need, not whole files, and prefer the dedicated search tools.

## Memory
- The memory in this repository is the only memory store; the assistant's own built-in memory stays off.
- `REFLEX.md` and `memory/MEMORY.md` are always loaded; the indexes and this file are read on demand.
  `memory/MEMORY.md` and `index/` are generated: never edit them by hand.
- Write what you learn the moment it becomes true and lasting, one fact per memory, and run
  `node tools/build-index.mjs`.
- Hooks enforce, written rules advise: anything that must happen every time belongs in a hook.

## Before anything leaves or is destroyed
- Anything a third party will read is shown as a draft first and sent only when the person says to send it.
- Before a delete, an overwrite, a migration or a force push, show exactly what will be affected and wait for a clear
  yes. Never delete logs, memories or code without it.
