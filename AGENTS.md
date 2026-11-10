# Neuraxis, for the agent installing it

Neuraxis was called Infinite Context until version 0.4.107. Nothing else changed in how it works.

You are an AI agent, and a person gave you this repository, perhaps with nothing but its link. This file is for
you. **Do not wait for more instructions.** Read the repository in the order below, all of it, then run the install
as a conversation with the person: ask first, install to match their answers, check every step, and do not say it
is installed until the checklist at the end passes. An install done by an agent that skimmed this file missed
almost everything; the checklist exists so that does not happen again.

## 1. Read in this order

1. This file, to the end.
2. `README.md`: what the person gets, the requirements, and the commands.
3. `CLAUDE.md`: how recall reaches an assistant and how a memory is written. It applies to every assistant, not
   only Claude.
4. The methods in `kit/memory/` that the map below names, at least their first paragraph each.
5. `docs/GUIDE.md` (what you will tell the person in plain words) and `docs/TUTORIAL.md` (what you will show them).

Read all five before your first question to the person, not after their answers: an install that read only this file
and asked first never came back to the rest, and named kit methods it had not opened. Then tell the person in one or
two sentences what this is and that you will ask a few questions before installing anything. If a file you were told
to read is missing, say which one.

## 2. The map: every part, what it is for, where it is explained

| Part | What it is for | Explained in |
|---|---|---|
| Memory (`memory/`, the neuron rules) | what the assistant remembers: one fact per file, plain markdown | `CLAUDE.md`; kit `reference_how_to_save_a_memory` |
| Recall (`hooks/pre-turn.mjs`, `tools/recall-core.mjs`) | brings a pointer to every matching memory into each prompt | `CLAUDE.md`; README "How it works" |
| Meaning recall (`tools/embed-server.mjs`, `node_modules/`) | finds memories by meaning, not only by keyword, all on this machine | README "Requirements" |
| Rules (memories with a `rule:` line) | short rules injected on every turn | `CLAUDE.md` |
| Plans and limits (`tools/plan.mjs`, `brain.json` "plan") | how much the assistant may spend for the person: helpers, models, background work | step 4.1 below |
| Kit (`kit/memory`, `kit/files`) | ready methods: documents, decks, research, meetings, debugging, goals and more | each method's first paragraph; `node tools/kit.mjs status` lists them |
| Helpers, sub-agents, forks, branches | how the assistant delegates, and how the four differ | kit `reference_how_to_brief_sub_agents_and_pick_models` |
| Other assistants (`tools/setup-agents.mjs`, `tools/setup-codex.mjs`, `tools/recall-mcp.mjs`) | memory and recall for Codex, Gemini CLI, Antigravity, Cursor, Claude Desktop and others | README "Using it with other assistants" |
| The full system for Claude Code on Windows (`tools/setup-full.mjs`) | context layers, context clean-up, keep-warm and the decision log, on top of memory and recall | step 4.4 below |
| The engine server (`tools/brain-server.mjs`) | runs on this machine only (127.0.0.1): serves the layers and the decision log to the mod | step 4.4 below |
| The mod (`mod/`) | the part of the full system that lives inside Claude Code; installed by an administrator | `mod/README.md`; step 4.4 below |
| Context layers (`layers/global.md`) | the rules every session of the assistant reads, written with the person | kit `reference_how_to_write_a_context`, `reference_how_to_use_shared_contexts` |
| Context clean-up | keeps a long conversation small: finished parts are archived with a note, the full text kept | kit `reference_how_to_clean_up_the_context` |
| Decision log (`tools/decision-store.mjs`, `tools/decision-review.mjs`) | decisions the assistant takes are kept for the person to review, kept or reversed | README "The decision log" |
| The map (`dashboard/`, `tools/dashboard.mjs`) | the whole memory as one picture in the browser, grouped by topic; by kind, with one line saying why, when there is no meaning model | README "The map" |
| Updates (`tools/update.mjs`) | the install updates itself, checks itself, goes back on a failure, and tells the person once | README "Updates"; section 5 below |
| Checks (`tools/verify.mjs`, `tools/reflect.mjs`) | prove the install works; find broken links, duplicates and contradictions | section 6 below |
| Agent messages | agents of one person talking to each other | not in the public engine yet: do not offer it |

## 3. The install conversation: ask before installing

Ask these seven, one or two at a time, in plain words. Nothing installs before the answers. When the person does not
know, take the default in brackets and say so.

1. **Which assistant do you use?** Claude Code, Codex, Gemini CLI or Antigravity, or another (Cursor, Claude Desktop,
   VS Code Copilot, Cline, Windsurf, LM Studio, Continue). Several is fine.
2. **Which plan do you pay for?** (small) It sets how much you may spend on their behalf; see step 4.1.
3. **For Claude Code: what kind of Claude account, and is this your own computer?** A personal account (Pro or
   Max) on a computer where they are an administrator can have the full system. A work account (Team or
   Enterprise) or a work computer may need their IT team for one step (installing the mod), and their organization
   may not allow plugins at all: then they keep memory and recall, which need no administrator.
4. **What do you want help with?** Their own words. You use them for the global context and to pick the three kit
   methods you show them.
5. **Do you want the map of your memory?** (no)
6. **Updates: automatic, tell me first, or off?** (automatic) See section 5.
7. **Where should it live?** (a folder named `neuraxis` in their home folder) The memory lives there, so it is their
   choice, not the folder you happened to start in.

Then say back in two or three sentences what you will set up, and start.

## 4. The steps

Run each from the repository root. Each has a check; do the check before the next step. Say in one plain sentence
what each step did.

### Requirements (check first)

```
node --version        v18 or newer
git --version         any recent version
```

If Node or git is missing, stop and tell the person what to install; do not install it without asking. About 300 MB
of disk for the meaning model. Meaning recall needs a processor with AVX (almost every computer made since 2013);
without it, recall works by keyword and `init` says so. The full system (4.4) needs Windows and Claude Code.

### 4.1 The plan, then the memory folder

| plan | for | what it allows |
|---|---|---|
| `small` | a plan with tight limits, about 20 dollars a month, or when they are not sure | no helper agent and no background task unless the person asks; small or balanced models and low effort for helpers |
| `standard` | a middle plan, about 100 dollars a month | a helper on your own only for a large task with independent parts, at most two at a time |
| `large` | a top plan, about 200 dollars a month or more | helpers in the background and in parallel when a task splits, no more than the task needs |

The prices are approximate: what counts is how tight their usage limits are. When in doubt, the smaller plan.

```
node tools/init.mjs --plan small
```

Check: the output contains `rules now active : 8`, `plan             : <their plan>` and `semantic recall  : ON`.
Rules 0: stop, the index did not build. Semantic OFF: tell the person why it printed (no AVX, the model download
failed, or on Windows the missing Visual C++ Redistributable, which init names with its link) and continue; keyword
recall still works. If they install the runtime, run `node tools/build-index.mjs` again and check for `semantic recall : ON`.

### 4.2 Recall in their assistant

Claude Code:

```
node tools/install-hook.mjs
```

Check: the output contains `registered UserPromptSubmit` or `wired : YES`. It backs up `~/.claude/settings.json`
first. A session restart is needed.

Any other assistant (and Claude Code too, if they use others beside it):

```
node tools/setup-agents.mjs --check     then without --check
node tools/setup-codex.mjs --check      Codex only, then without --check
```

Check: each assistant it found is listed with PASS. Codex needs one step from the person: in Codex type `/hooks`,
trust the hooks, start a new session.

### 4.3 One memory, not two

The assistant's own built-in memory must be off, or two stores drift apart and one ends up confidently wrong.

- Claude Code: look at what `~/.claude/projects/<project>/memory/` holds; copy it somewhere safe; move every fact
  worth keeping into `memory/` here as its own file; back up `~/.claude/settings.json` and add
  `"autoMemoryEnabled": false`, keeping every other setting; replace the built-in `MEMORY.md` with a four-line
  pointer to this repository ("This local memory is intentionally empty ... All memory lives in <path> ... Do not
  write memories here."). Setting the key back to `true` undoes it.
- Codex: `setup-codex.mjs` switches its memories off in `config.toml`; in the Codex desktop app, Settings,
  Personalization, memories off.
- Others: tell the person where their assistant keeps its own memory and ask them to turn it off.

Check: `~/.claude/settings.json` still parses and holds `"autoMemoryEnabled": false`. Tell the person you did this,
because it changes where their notes live.

### 4.4 The full system (Claude Code on Windows only)

Skip this step on another system or another assistant, and say what they do not get: context layers, context
clean-up and the decision log. Memory and recall are complete without it.

Not being an administrator is no reason to skip it: both `setup-full` commands below run without one. Only the last
step, `--mod`, needs an administrator; without one, hand that step to them as it says and do everything else.

```
node tools/setup-full.mjs --check --owner "<their name>"
node tools/setup-full.mjs --owner "<their name>"
```

It turns on the local engine server (127.0.0.1 only, nothing leaves the machine), points the mod at it, and names
the assistant `assistant` for the mod (`--agent <name>` to choose another). Check: it prints `check: engine server
answers`.

Then the **global context**: replace `layers/global.md` with the person's own rules, written from their answers in
section 3, in their words, short (follow kit `reference_how_to_write_a_context`). Read it back to them.

Then the **mod**, which needs a Windows administrator and changes settings for every user of the computer. Ask the
person first, in one sentence that says so. Only when they say yes:

```
node tools/setup-full.mjs --mod --yes
```

Never run `--mod` to read its usage: `node tools/setup-full.mjs --help` prints it and changes nothing. Without `--yes`
the mod step refuses and changes nothing. Windows shows an administrator prompt; the person approves it. If they are
not an administrator (a work computer), do not run it: give them the command for their IT team, which is
`powershell -NoProfile -ExecutionPolicy Bypass -File "<this folder>\mod\release\install.ps1" -Force`, and carry on
with everything else. Check: the
install ends with `all checks passed`, and a new Claude Code session shows the layers in its first answer's context.

### 4.5 Prove it works

```
node tools/verify.mjs
```

Check: the last line is `BRAIN VERIFY PASSED`. If it fails, read which check failed and fix that. Never report
success on a failing verify.

## 5. Updates

At most once a day, the recall hook checks in the background for a newer release, installs it, runs the checks, and
goes back on its own if they fail. Its news reaches you as a line starting `NEURAXIS UPDATE:`: tell the person in one
line, once. Their choice from section 3:

```
node tools/update.mjs --on | --notify | --off     automatic (default), tell only, or off
node tools/update.mjs --status                    the setting and the last result
```

Update by hand with `node tools/update.mjs`, never `git pull`: it never touches their memories and rolls back a
release that fails. A kit method they changed is never overwritten; the new version waits in `kit-updates/`
(`node tools/kit.mjs status`). When an update changes `mod/`, it says so; reinstalling the mod needs the
administrator step again (`node tools/setup-full.mjs --mod --yes`, after the person agrees).

## 6. The install checklist

Go through every item before you say the install is done. For each, say how you checked it. An item you could not
do is said plainly, with what the person can do about it.

1. **Read everything.** The five files of section 1, whole, and every kit method you name to the person, whole, before
   you name it (never from its first lines or its description); list them, each with one thing you took from it.
2. **Asked first.** The seven questions of section 3, and their answers written down in your reply.
3. **Memory folder.** `init` ran; `index/` built; meaning recall ON, or OFF with the reason said.
4. **Recall wired.** A test prompt in a new session shows a recall block (`BRAIN RECALL:`), in each assistant set up.
5. **One memory.** The assistant's own memory is off (4.3).
6. **Context.** Claude Code on Windows: `layers/global.md` holds the person's own rules, read back to them. Elsewhere:
   said that context layers need the full system.
7. **Kit.** The kit methods are in place (`node tools/kit.mjs status`); three named to the person, matched to what
   they want help with, each one opened and read whole first (`kit/memory/<name>.md`), never named from the list alone.
8. **Helpers and agents.** Tell the person these five, in your own words or as written here, then show the plan's rule
   set (`node tools/plan.mjs`):
   - A **sub-agent** (fork helper) is a hidden assistant I start with a written brief for one task; it reports back and
     ends.
   - A **branch helper** is a hidden copy of our conversation that does one task; it is the cheaper choice when the
     material is already in our conversation.
   - A **branch** is a copy of our conversation that you open and steer yourself, to try another direction.
   - A **fork** is a new conversation that you open and steer, started with a brief, for a separate task.
   - A second **agent** is a standing assistant with its own name and context, sharing the same memory; ask me and I
     set one up (kit `reference_how_to_create_an_agent`).
   When to use which is in kit `reference_how_to_brief_sub_agents_and_pick_models`.
9. **Clean-up.** With the mod: the context clean-up is on and explained in two sentences. Without it: said that a long
   conversation is handled by the assistant's own compaction.
10. **Updates.** Set as they chose (`node tools/update.mjs --status`); they know what an update line looks like.
11. **The map.** Opened once with `node tools/dashboard.mjs --open` (port 8492, `--port` to change it), if they wanted it.
    The memories are coloured by topic; on a keyword-only install the page says in one line that topics need the
    meaning model, and the person was told the same.
12. **A first memory.** One fact from this conversation saved as a memory (kit `reference_how_to_save_a_memory`),
    `node tools/build-index.mjs` run, and recalled in a new session.

Then give the person `docs/TUTORIAL.md`'s first two things to try.

## How to use it once installed

- **Recall is automatic.** `BRAIN RECALL: N memories` appears in your context with pointers. **Open the files it
  names. Never answer from the one-line description**: it says whether a file is worth opening, not what it says.
- **Write memories as you learn.** The moment something becomes durably true (a decision and its reason, a fact
  about a system, a correction from the person), write `memory/<type>_<slug>.md`, type one of `user`, `contact`,
  `project`, `feedback`, `reference`, with the frontmatter in `CLAUDE.md`, then `node tools/build-index.mjs`. The
  description is the only thing indexed: write it in the words the person would use.
- **Link memories** with `[[slug]]`. A memory with no links in or out fails `verify.mjs`.
- **The plan line comes with every turn** (`PLAN:`): follow it before any rule or method that says to start helpers.
- **If recall is unavailable, say so** in your first sentence. Degraded memory that announces itself is recoverable;
  silent degradation is answering from nothing while sounding sure.
- **Decisions** (full system): a decision you take for the person is logged with the mod's `log_decision` tool; they
  review it on the page `node tools/decision-review.mjs link` prints.

## Contributing back

If, while working for your person, you fix a bug in the engine, measure a recall change that helps, or write a
how-to method that would help anyone (not one about your person), propose it upstream.

1. **Ask your person first.** A pull request publishes their work under their GitHub account, and they must accept
   the CLA (`CLA.md`). Never open one without a clear yes.
2. **Strip everything personal.** No names, machine names, paths, addresses, credentials or memory content.
3. **Prove it.** `node tools/verify.mjs`; for a recall change, the before and after on a test set and the command.
4. **Open the pull request against `staging`**, saying what changed, why, and how you measured it.

## What can go wrong, in order of likelihood

| symptom | cause | fix |
|---|---|---|
| no `BRAIN RECALL` line in your context | session not restarted after 4.2 | restart the session |
| `rules unavailable` | `index/rules.json` empty or missing | `node tools/init.mjs --force`, then `node tools/build-index.mjs` |
| a memory you wrote is never recalled | vague description | rewrite the description in the person's words |
| `verify.mjs` fails on reflection | orphan memory or broken `[[link]]` | link it, or fix the slug |
| `semantic recall missed this turn` | the note says why: the embed server starting, or not running | wait one prompt; if it repeats, `node tools/embed-server.mjs` shows why |
| no layers in a new Claude Code session | the mod is not installed, or the session started before `HAVOK_MOD_AGENT` was set | `node tools/setup-full.mjs --check`; start a new terminal, then a new session |
| `engine server did not answer` | another program holds port 8478, or Node cannot start it | `node tools/brain-server.mjs` prints why; `HAVOK_SERVER_PORT` chooses another port (then run setup-full again) |
| helpers or background tasks the person did not ask for, and their limit runs out fast | the plan is larger than the one they pay for | `node tools/plan.mjs small` |
| the same fact in the built-in memory and here, differing | the assistant's own memory is still on | step 4.3 |
| `NEURAXIS UPDATE: ... was not installed automatically` | an engine file the release also changes was edited here | the line gives the reason and the command; with the person's yes, follow it |
| `NEURAXIS UPDATE: ... went back to` | the checks failed after the update, so it rolled back | `node tools/update.mjs` runs it again and prints why; report it upstream if it repeats |
