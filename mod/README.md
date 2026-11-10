# The mod (the full system for Claude Code on Windows)

This folder is the part of Neuraxis that lives inside Claude Code: the context layers (the rules every session
reads), the context clean-up (a long conversation stays small; the archived text is kept and can be brought back),
keep-warm, and the decision log's tools. It asks the engine server on this computer (http://127.0.0.1:8478) for the
layers and the decisions; nothing leaves the computer. Agent messages and usage reporting are off in this build.

Install it through the setup, which also prepares everything it needs:

    node tools/setup-full.mjs            (from the repository root, first)
    node tools/setup-full.mjs --mod      (installs this folder; Windows asks for an administrator)

What the install does: it copies the plugin to C:\Program Files\Havok\claude-plugins (a folder only an administrator
can change, so no other program can alter the mod), writes Claude Code's managed settings to load it, and runs its
checks on throwaway sessions. It also takes out of your user settings the hooks the mod does itself, with a backup
(settings.json.bak-repoint-<date>) beside the file. Each change is printed.

By hand, as an administrator:

    powershell -NoProfile -ExecutionPolicy Bypass -File release\install.ps1 -Force

To remove it, as an administrator:

    powershell -NoProfile -ExecutionPolicy Bypass -File release\uninstall.ps1

The mod turns on in a session only when the user variable HAVOK_MOD_AGENT names an assistant that has a settings
file (~/.claude/havok-mod.<name>.json, written by the setup). Everywhere else it stays off and changes nothing.

Comments are stripped from this code, and the build fails if any file names a machine, address or person of the
authors.
