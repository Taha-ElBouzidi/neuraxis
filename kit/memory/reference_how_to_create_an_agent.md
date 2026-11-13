---
name: How to create an agent
description: Make a new agent, a sub-agent, a second assistant, another assistant for my work, an assistant for one project, a helper or an agent, how many agents: when a helper is enough, the difference between a sub-agent (answers to the agent above it) and an agent (answers to the person), how to set up a second named assistant with its own context, and how to start it
type: reference
metadata:
  type: reference
  asserted: 2026-11-10
  updated: 2026-11-13
  kit_version: 2
  kit_hash: eeddc9ae4419162a
---

# How to create an agent or a sub-agent

The words ([[reference_how_to_brief_sub_agents_and_pick_models]]): a **branch** (an exact copy of the conversation)
and a **fork** (a clean context with a brief) are the two ways to start one. A **helper** is a hidden assistant you
start for one task; it reports back to you and ends. A **sub-agent** is a visible assistant with its own name and tab
that answers to the agent above it, either standing for one area or for one task. An **agent** is the top of its own
tree and answers to the person directly. All of them share the same memory: what one saves, every other one recalls.

## First decide which one

- One task with an end (research a question, review a file, write a draft): a **helper**, not a new assistant.
- The person wants to see and steer work that still belongs to you, now or again and again in one area (a project,
  finances, a job search): a **sub-agent**. It takes its work from you and reports to you.
- A separate area the person will run directly, not through you: a new **agent**.

Each visible assistant costs usage while it runs, so on a small plan keep to one or two. Say this choice to the
person in one line, with who it will answer to, before you set anything up.

## Set up a named sub-agent or agent (Claude Code on Windows, full system)

1. Pick a short lowercase name with the person, such as `finance` or `jobs`.
2. Run `node tools/setup-full.mjs --agent <name> --another`. It writes the assistant's settings file
   (`~/.claude/havok-mod.<name>.json`) and leaves the default assistant as it is. Without `--another` the new name
   becomes the default for every new session.
3. Start it in a terminal that names it. The script prints both ways: in PowerShell
   `$env:HAVOK_MOD_AGENT = '<name>'; claude`, or a Windows Terminal profile with that command line (Settings, Add a
   new profile), so the person can open it from the terminal's menu. Start it in the folder where its work lives.
4. In its first conversation, write its context with the person: what it is for, in one line, whom it answers to
   (the agent above it, or the person), and the few facts it needs on every step (template:
   `kit/files/context-templates/agent.md`, method [[reference_how_to_write_a_context]]). It keeps it with its
   `context_keep` tool; the file is `~/.claude/havok-mod/layers/agent/<name>.md`, and only that assistant changes it.
5. Check: in its first answer, the context shows an agent layer with its name, and a recall block
   (`BRAIN RECALL:`) appears.

Without the full system (another assistant, or not Windows), a second assistant is simply another conversation or
project folder in that assistant. Memory and recall are shared all the same; only its own context layer is missing.

## Teach the person

Tell them in two sentences: they can have more than one visible assistant, each with its own name and context, all
sharing one memory, either working for the main agent (a sub-agent) or on its own (an agent); and for a one-off task
they can ask for a helper instead, which costs less. Show them how to open the new one (the terminal command or the
profile) once.

## Messages between assistants

Assistants can message each other when the person's setup has a messages service
([[reference_how_to_message_another_agent]]); a sub-agent reports to the agent above it that way. The public install
has none by default: assistants share memory, not a mailbox.
