# The full system, for Claude Code on Windows

Memory and recall are complete without this page. The full system is an extra for Claude Code on Windows only. It is
not available on macOS or Linux, or with another assistant.

## What it adds

- **Rules you write once**, in the global context (`layers/global.md`), that every conversation follows.
- **A conversation that stays small.** Long conversations are cleaned up as you go, so your assistant stays sharp and
  costs less.
- **A decision log.** Decisions your assistant takes for you are kept with the reason, on a page you can open on your
  computer (`node tools/decision-review.mjs link`), to keep or reverse them.
- **More than one assistant.** For example one for work and one for your personal life, each with its own rules.

It runs a small server on 127.0.0.1 only: nothing leaves your computer.

## What you need

- Claude Code, on Windows.
- A personal Claude plan (Pro or Max). A Team or Enterprise organization may not allow plugins.
- A Windows administrator, once, for the last step (see below). On a work computer that is usually your IT team.

## Set it up

Your assistant normally does this with you. The commands are:

```
node tools/setup-full.mjs --check
node tools/setup-full.mjs
node tools/setup-full.mjs --mod --yes
```

The first two run without an administrator. They turn on the local engine server (127.0.0.1 only), point the mod at
it, and name the assistant `assistant` for the mod (`--agent <name>` chooses another). The check prints
`check: engine server answers`.

`node tools/setup-full.mjs --help` prints the usage and changes nothing. Without `--yes` the `--mod` step refuses and
changes nothing.

## The administrator step

`--mod --yes` installs the mod, the part that lives inside Claude Code. It changes settings for every user of the
computer, so Windows shows an administrator prompt and you approve it. The install ends with `all checks passed`, and a
new Claude Code session shows the layers in its first answer's context.

If you are not an administrator, hand this command to your IT team (replace `<folder>` with the folder where Neuraxis
is installed):

```
powershell -NoProfile -ExecutionPolicy Bypass -File "<folder>\mod\release\install.ps1" -Force
```

Everything else can be set up meanwhile. To remove the full system, an administrator runs
`powershell -File mod\release\uninstall.ps1`.

When an update changes `mod/`, it says so; reinstalling the mod needs the administrator step again.

## Names you may see

Neuraxis was called Infinite Context until version 0.4.107; an install under the old name updates by itself. Parts of
the full system keep an older name, Havok, on purpose, so that existing installs keep working:

- the settings that start with `HAVOK_`, such as `HAVOK_MOD_AGENT` and `HAVOK_SERVER_PORT`;
- the files `~/.claude/havok-*`;
- the plugin `havok-mod`;
- the folder `C:\Program Files\Havok`.

That is expected. Do not rename them.

## Windows only

The full system is Windows only: tested on Windows, not available on macOS or Linux. The scheduling helpers under
`tools/*.ps1` are Windows-only.
