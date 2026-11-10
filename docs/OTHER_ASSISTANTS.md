# Using Neuraxis with other assistants

The memory is not tied to one tool. Claude Code, Codex, Gemini CLI, Antigravity, Cursor, Claude Desktop, VS Code
Copilot, Cline, Windsurf, LM Studio and Continue can all use it. Your assistant can do this setup for you; this page
is what it does and what is left for you.

## One command for all of them

```
node tools/setup-agents.mjs            add --check to see what it would do first
```

It finds the assistants on the computer and connects each one. Every assistant gets the memory as an MCP server named
`brain` (tools `recall` and `read_memory`, read-only), and a short instruction to call `recall` before answering, in
whichever file it reads. Claude Code, Codex, Gemini CLI and Antigravity also get the automatic recall on every prompt,
Cursor gets the rules at session start, and Cline gets the automatic recall on macOS and Linux (not tested).

| Assistant | What it gets |
|---|---|
| Claude Code | MCP, CLAUDE.md, automatic recall |
| Codex (CLI, IDE, app) | MCP, AGENTS.md, automatic recall |
| Claude Desktop, LM Studio, Continue | MCP (add "call recall first" to their system prompt or project) |
| Gemini CLI, Antigravity | MCP, instruction file, automatic recall |
| Cursor | MCP, rules at session start |
| VS Code Copilot, Cline, Windsurf | MCP and their instruction file (Cline: automatic recall on macOS and Linux, not tested) |

Every file is backed up before it changes, your other servers are kept, and running it again changes nothing. Restart
each assistant afterwards; the first call may ask you to approve `recall`. Not covered: plain Ollama (no MCP support)
and Open WebUI (needs mcpo in front).

## Codex in detail

The recall hook is not Claude-only. OpenAI Codex (the CLI and the IDE extension) has the same `UserPromptSubmit` and
`SessionStart` hooks and takes the same output, so the same hook gives Codex the same memory. One command wires it
(`node tools/setup-agents.mjs` runs it for you when it finds Codex):

```
node tools/setup-codex.mjs            add --check to run the tests without changing anything
```

It writes three files in `~/.codex` (or `CODEX_HOME`), each backed up first:

| File | What it gets |
|---|---|
| `hooks.json` | recall on every prompt and the session-start banner. Hooks already there are kept. |
| `config.toml` | Codex's own memories switched off, so there is one memory, not two. |
| `AGENTS.md` | a short block saying where the memory is, and what to do if recall does not appear. |

Then it runs each hook exactly as Codex will and prints PASS or FAIL.

**One step is yours:** Codex skips a hook until you trust it. Open Codex, type `/hooks`, trust the hooks, and start a
new session. You will see the recall block on your first prompt.

Why hooks and not instructions: an agent told to use a memory system it did not come with will often argue for its
own. A hook is configuration, so there is nothing to argue with.

The Codex desktop app ignores the memories setting in `config.toml`; turn memories off in its Settings, under
Personalization. The app may also not run hooks, so the setup registers the memory as an MCP server too
(`tools/recall-mcp.mjs`, tools `recall` and `read_memory`) and tells Codex to call it when no recall block appears. In
the app, check that the MCP server `brain` is listed and enabled.

More on how recall works: [HOW_IT_WORKS.md](HOW_IT_WORKS.md).
