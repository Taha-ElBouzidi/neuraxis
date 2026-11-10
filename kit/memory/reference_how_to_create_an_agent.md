---
name: How to create an agent
description: Make a new agent, a second assistant, another assistant for my work, an agent for one project, a helper or an agent, how many agents: when a helper is enough, how to set up a second named assistant with its own context, and how to start it
type: reference
metadata:
  type: reference
  asserted: 2026-11-10
  updated: 2026-11-10
  kit_version: 1
  kit_hash: 523c04b4f39ac1cd
---

# How to create an agent

An **agent** is a standing assistant with its own name, its own context and its own conversation that the person
comes back to (one for a project, one for their finances, one for their job search). A **helper** is a short-lived
assistant you start for one task and that ends with it ([[reference_how_to_brief_sub_agents_and_pick_models]]).
Both share the same memory: what one saves, every other one recalls.

## First decide: is a helper enough?

Use a helper, not a new agent, when the work is one task with an end (research a question, review a file, write a
draft). Make an agent only when the person will come back to the same area again and again, and a separate
conversation with its own context keeps it clearer. Each agent costs usage while it runs, so on a small plan, keep
to one or two. Say this choice to the person in one line before you set anything up.

## Set up a second agent (Claude Code on Windows, full system)

1. Pick a short lowercase name with the person, such as `finance` or `jobs`.
2. Run `node tools/setup-full.mjs --agent <name> --another`. It writes the agent's settings file
   (`~/.claude/havok-mod.<name>.json`) and leaves the default assistant as it is. Without `--another` the new name
   becomes the default for every new session.
3. Start it in a terminal that names it. The script prints both ways: in PowerShell
   `$env:HAVOK_MOD_AGENT = '<name>'; claude`, or a Windows Terminal profile with that command line (Settings, Add a
   new profile), so the person can open it from the terminal's menu. Start it in the folder where its work lives.
4. In its first conversation, write its context with the person: what it is for, in one line, and the few facts it
   needs on every step (template: `kit/files/context-templates/agent.md`, method
   [[reference_how_to_write_a_context]]). The agent keeps it with its `context_keep` tool; the file is
   `~/.claude/havok-mod/layers/agent/<name>.md`, and only that agent changes it.
5. Check: in the new agent's first answer, the context shows an agent layer with its name, and a recall block
   (`BRAIN RECALL:`) appears.

Without the full system (another assistant, or not Windows), a second agent is simply another conversation or
project folder in that assistant. Memory and recall are shared all the same; only the agent's own context layer
is missing.

## Teach the person

Tell them in two sentences: they can have more than one assistant, each with its own name and context, all sharing
one memory; and for a one-off task they can ask for a helper instead, which costs less. Show them how to open the
new agent (the terminal command or the profile) once.

## Messages between agents

Agents on the same machine can message each other when the person's setup has a messages service
([[reference_how_to_message_another_agent]]). The public install has none by default: agents share memory, not a
mailbox.
