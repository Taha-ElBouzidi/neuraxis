# How it works

This page explains how Neuraxis finds what your assistant already knows, what that costs, what was measured, how to
check it is working on your own computer, and how updates behave. The short version is in the [README](../README.md);
every option is in [OPTIONS.md](OPTIONS.md) and every number is in [BENCHMARKS.md](BENCHMARKS.md).

![Your prompt goes to a hook, which matches by keyword and meaning and returns a pointer for each memory that matches, each a slug, a one-line description and a path. The agent opens the one or two it needs and answers with the fact.](recall.svg)

## The idea

An agent using Neuraxis never loses a fact, and loads almost nothing on any given turn. Every prompt gets **a pointer
for each memory that clears the match bar**, plus the ones strongly linked to them: a slug and a one-line description
each. The agent opens only the memories the question actually needs. The memory can grow to thousands of facts and the
prompt stays the same size. It runs entirely on your computer: no account, no cloud, no data leaving the building.

## Memories are plain files

**Memories are markdown files**, one fact per file, under `memory/`. Plain text, yours, diffable, grep-able. Nothing
is hidden in a database.

**The description leads.** Each memory has a one-line `description`, written in the words a person would type when
looking for it. The index covers the name, that line and the first 1,200 characters of the memory, and the description
is what the agent sees in the recall list. A memory with a vague description is hard to find, which is by design: it
forces the author to say what the memory is *for*.

**Recall returns pointers, not text.** Injecting five whole memories into every prompt to save one file read is the
wrong trade. The agent reads what it needs, and reads it fresh.

## Two ways of matching, then a bar and the links

Keyword matching always works and catches exact names. Semantic matching, when the local embedder runs, catches
paraphrases keyword cannot: a question with no word in common with a memory still finds it. The two are fused. There
is no fixed number of results: every memory that clears its own bar comes back, plus the memories linked to them with
`[[file-name]]` that clear a lower bar of their own. A question that needs two memories usually finds the second
through a link. Everything runs on your machine.

The first `node tools/init.mjs` downloads the embedding model, about 280MB, once. The hook starts the local embedder
itself whenever it is not running, so there is nothing to keep alive by hand. To stay keyword-only,
`node tools/init.mjs --no-semantic`. Meaning recall needs AVX (almost every computer since 2013); otherwise recall is
by keyword. On Windows it also needs the Microsoft Visual C++ Redistributable (x64).

## Methods and rules are memories too

**Methods are memories.** How to make a deck, research with sources, debug, review work before calling it done, run a
meeting, set a goal, write an email or a chat message, make a video or voice audio, write a context for your agents,
and use the system itself (recall, the vault, a shared git server, messages between agents, cleaning up the context):
26 how-to memories ship, found by recall when the conversation needs them, not triggered like scripts. Write your own
the same way. They are kept up to date like the engine, except where you changed one (see Updates below).

**Behaviour rules are memories.** Any memory carrying a `rule:` line is injected on every turn. Eight generic ones
ship. Add your own by writing a memory. Change one by editing a file.

**It degrades loudly.** If the index is missing, the embedder is down, or a file cannot be opened, the agent is told
so in its context, in words, rather than silently answering from less.

## Why not a bigger context window

A bigger window is a bigger bill on every single prompt, and past a point more context makes a model worse, not
better. A memory that lives outside the window costs the same whether it holds fifty facts or fifty thousand. This is
the difference between remembering and re-reading.

## The measurements

Measured on the authors' own 41-query set, on a brain of about 270 memories:

| | |
|---|---|
| recall@5 | **97.6%**, identical on a laptop reaching the brain over a private network |
| cost per prompt | about **200ms** on the host, about 600ms over the network |
| context added | about **1.7k tokens**, whatever the size of the memory |
| returned nothing | **0** of 41 |
| keyword-only, for comparison | 92.7%, twice as fast, and 2 of 20 prompts came back empty |

Your numbers will differ. Measure them with `node tools/eval-recall.mjs` and `node tools/bench-recall.mjs`. How each
number was measured is in [BENCHMARKS.md](BENCHMARKS.md).

## Check it is working

```sh
node tools/verify.mjs          # the whole install, exits non-zero on any failure
node tools/eval-recall.mjs     # accuracy against a fixed query set
node tools/bench-recall.mjs    # latency of the real hook, end to end
node tools/analytics.mjs       # results sheet from every logged call, with alerts
```

What the engine keeps about your use (the recall log behind the map, `tools/status.mjs` and `tools/analytics.mjs`)
stays on your computer, for you. Nothing you type is collected for analysis or sent off it.

The tests need an installed brain: run `node tools/init.mjs` first (it builds the index and installs the model
runtime several tests use), then `node --test tools/*.test.mjs hooks/*.test.mjs`. In a fresh clone without init, the
tests that read the index or the model fail.

## Updates

A git clone keeps itself up to date. While you use your assistant, the recall hook checks at most once a day, in the
background, for a release newer than yours: a tag `vX.Y.Z` on `main`, never another branch. When there is one it moves
to it, runs `tools/verify.mjs`, and goes back on its own if the update brought a failure. Your agent tells you in one
line what changed.

It never touches your memories: a release that would put a file in `memory/`, or overwrite any file of yours, is
refused. An engine file you changed that the release also changes stops the update and you are told why. The how-to
memories are refreshed only where you have not changed them; for one you changed, the new version waits in
`kit-updates/` (`node tools/kit.mjs accept <name>` takes it and keeps yours as a backup).

```sh
node tools/update.mjs --status     # the setting, the last check and what it found
node tools/update.mjs              # update now
node tools/update.mjs --notify     # check daily, only tell you, install by hand
node tools/update.mjs --off        # no automatic checks (or INFINITE_CONTEXT_AUTO_UPDATE=0)
```

The daily check is one `git ls-remote`, git's own protocol rather than GitHub's API, so it never counts against the
API's limits. An install that is not a git clone, or that has commits of its own, is not updated automatically: it
says so once, with the command to update by hand. An install older than the version that brought this updates by hand
once: `git pull`, then `node tools/kit.mjs refresh` and `node tools/verify.mjs`.

## The decision log

With the full system, decisions your assistant takes for you (a choice between options, a setting, something left out)
are kept with the reason, for you to review: kept or reversed, with a note the assistant reads next time. Open your
review page with `node tools/decision-review.mjs link` in your own terminal; it is served on this computer only. See
[FULL_SYSTEM.md](FULL_SYSTEM.md).

## Multi-machine mode

A second mode exists where one host runs `tools/brain-server.mjs` and other machines reach it over a private network
with scoped tokens and per-machine encrypted secrets. It is how the authors run it, across three machines, one of
which cannot reach the internet. It is not documented for outside use yet. This release is **local only**.

## Platform

Tested on Windows. The engine is plain Node and should run wherever Node does. The scheduling helpers under
`tools/*.ps1` are Windows-only and are not needed for local mode.
