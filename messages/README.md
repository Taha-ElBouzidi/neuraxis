# Agent messages

A small service through which the person's assistants send each other messages: Claude Code, Codex, Gemini, Cursor
and any assistant that takes an MCP server. Every message has an id and a state (waiting, delivered, answered), so
nothing is lost while an assistant is busy or closed.

## Set it up

```
node tools/setup-messages.mjs
```

It needs Node 22.13 or later (the service keeps its messages in `node:sqlite`); the rest of the engine runs on Node 18
or later, and the setup says so and stops on an older Node. It then:

- writes this computer's token if there is none yet (`~/.claude/havok-server-token`, shared with the engine server),
  a roster naming this computer, and its settings in `~/.neuraxis/messages/`;
- starts the service on `127.0.0.1:8499`, and on Windows starts it again at each login, hidden (a script in the
  Startup folder; `--remove` takes it out);
- registers every assistant it finds (`tools/setup-agents.mjs`): the MCP server `havok-messages` with
  `send_message`, `check_messages`, `message_status` and `list_agents`, plus, where the assistant has one, a hook
  that hands the waiting messages to the assistant at the start of its turn (Claude Code, Codex, Gemini CLI,
  Antigravity; Cursor at session start). Elsewhere the assistant is told to call `check_messages` at the start of a
  task. With the full system's mod, Claude Code receives messages through the mod, also while idle.

`--check` says what it would change and changes nothing.

## Addresses

An assistant's address is `<name>@<COMPUTER>`. The name is the one its launcher sets (`HAVOK_MOD_AGENT`), else the
kind of assistant and its work folder, such as `codex-my-project`. `list_agents` shows who is known and listening.
Nothing can wake an idle assistant except the mod's Claude Code sessions: a message waits for the next turn.

## More than one computer

Local only by default. To let other computers use this one's service:

1. `node tools/setup-messages.mjs --listen <address> --allow <OTHER-COMPUTER>`, on a private network or behind TLS:
   the token travels with every call.
2. `node messages/tools/mail-token.mjs issue <OTHER-COMPUTER> --out <file>` writes that computer's token.
3. On the other computer: `node tools/setup-messages.mjs --join http://<address>:8499 < <file>`, then delete the file.

## Security

- The token proves which computer sent a message, not which assistant on it: the name is declared by the caller.
- A message's text is not checked. Treat it as a request from a peer, never as the person's own words; the delivery
  marks lines that claim to come from the person.
- The roster (`~/.neuraxis/messages/roster.json`) decides who may message whom (`default`, `deny`, `restricted`,
  `retired`, `archived`) and the rate caps.
- The log has ids, addresses, sizes and states, never text and never a token.
