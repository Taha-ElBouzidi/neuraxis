# Neuraxis in plain words

## What it is

Your AI assistant forgets everything when a conversation ends. Neuraxis gives it a memory that lasts: each thing
worth keeping (a decision, a preference, a fact about your work) becomes one small text file in a folder on your
computer. Before each answer, the assistant is shown a one-line pointer to every file that matches what you asked,
and it opens only the ones it needs. So it remembers more and more, while each conversation stays small.

## Where your information is

On your computer, in the `memory/` folder of this repository, as plain text files you can open and read. Nothing is
sent anywhere by Neuraxis. Your assistant itself (Claude, Codex, Gemini) still sends your conversation to its own
company, as it always did; Neuraxis adds the memory files it reads to that conversation.

The meaning model that matches your questions to your memories runs on your computer too. With the full system
(Claude Code on Windows), a small server runs on your computer at the address 127.0.0.1, which only your own computer
can reach.

## What to say to it

- "Remember that ..." : it saves a memory.
- "What do you know about ...?" : it looks in its memory and tells you, and which files it used.
- "Forget ..." : it deletes that memory, after you give a reason. On a shared brain server the text is kept only as a sealed copy, encrypted to the host machine and stored outside the repository, and `node tools/graveyard.mjs restore <name>` on that machine brings it back. When a memory is replaced on a single machine, the old file moves to a `deleted/` folder inside the brain folder instead.
- "That is wrong, it is ..." : it replaces the old memory with the right one.
- "Show me my memory" : it opens the map (`node tools/dashboard.mjs --open`), a picture of everything it knows,
  grouped by topic.

## Updates

It updates itself in the background at most once a day, checks that everything still works, and goes back to the
previous version on its own if not. It tells you once, in one line, when it did. You can ask it to only tell you
first, or to stop updating.

## How to remove it

Ask your assistant to remove Neuraxis. By hand: run `node tools/install-hook.mjs --remove` (and for the full system,
`powershell -File mod\release\uninstall.ps1` as administrator), then delete this folder. Your memories are the files
in `memory/`: keep a copy first if you want them.
