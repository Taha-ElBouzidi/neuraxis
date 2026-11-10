#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const say = (s) => process.stdout.write(s + NL);
const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');
const SETTINGS = join(CONFIG_DIR, 'settings.json');
const HOOK_PATH = join(BRAIN, 'hooks', 'pre-turn.mjs').split(BS).join('/');
const COMMAND = 'node "' + HOOK_PATH + '"';
const TIMEOUT = 10;
let settings = {};
let existed = false;
if (existsSync(SETTINGS)) {
    existed = true;
    try {
        settings = JSON.parse(readFileSync(SETTINGS, 'utf8'));
    }
    catch (e) {
        say('settings.json exists but is not valid JSON: ' + e.message);
        say('Refusing to touch it. Fix or move it first, because rewriting it would lose every other');
        say('setting in it.');
        process.exit(1);
    }
}
settings.hooks = settings.hooks || {};
const list = Array.isArray(settings.hooks.UserPromptSubmit) ? settings.hooks.UserPromptSubmit : [];
let wiredHere = false;
const otherBrains = [];
for (const entry of list) {
    for (const h of (entry && entry.hooks) || []) {
        const c = String((h && h.command) || '');
        if (!c.includes('pre-turn.mjs'))
            continue;
        if (c.includes(HOOK_PATH))
            wiredHere = true;
        else
            otherBrains.push(c);
    }
}
if (process.argv.includes('--remove')) {
    if (!existed) {
        say('no settings.json: nothing to remove');
        process.exit(0);
    }
    const kept = [];
    let removed = 0;
    for (const entry of list) {
        const hooks = ((entry && entry.hooks) || []).filter((h) => { const mine = String((h && h.command) || '').includes(HOOK_PATH); if (mine)
            removed++; return !mine; });
        if (hooks.length)
            kept.push({ ...entry, hooks });
    }
    if (!removed) {
        say('this brain’s recall hook is not registered: nothing to remove');
        process.exit(0);
    }
    copyFileSync(SETTINGS, SETTINGS + '.before-havok-remove');
    if (kept.length)
        settings.hooks.UserPromptSubmit = kept;
    else
        delete settings.hooks.UserPromptSubmit;
    writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + NL, 'utf8');
    say('removed the recall hook of ' + BRAIN + ' (a copy is in ' + SETTINGS + '.before-havok-remove). Restart the session.');
    process.exit(0);
}
say('brain    : ' + BRAIN);
say('settings : ' + SETTINGS + (existed ? '' : '  (does not exist yet)'));
say('wired    : ' + (wiredHere ? 'YES, to this brain' : 'NO'));
for (const c of otherBrains)
    say('  WARNING: also registered to a DIFFERENT brain: ' + c);
if (wiredHere && !otherBrains.length) {
    say('');
    say('Nothing to do. Recall will load on the next session start.');
    process.exit(0);
}
if (CHECK) {
    say('');
    say('--check: not wired to this brain, nothing changed. Run without --check to fix it.');
    process.exit(1);
}
if (otherBrains.length) {
    say('');
    say('Leaving the other registration alone: removing it is a judgement call, not a repair.');
    say('If this machine should only use this brain, delete that entry by hand.');
}
if (!wiredHere) {
    list.push({ hooks: [{ type: 'command', command: COMMAND, timeout: TIMEOUT }] });
    settings.hooks.UserPromptSubmit = list;
    if (existed) {
        const bak = SETTINGS + '.before-havok-hook';
        copyFileSync(SETTINGS, bak);
        say('');
        say('backed up: ' + bak);
    }
    else {
        mkdirSync(CONFIG_DIR, { recursive: true });
    }
    writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + NL, 'utf8');
    say('registered UserPromptSubmit: ' + COMMAND);
    say('');
    say('A running session loads hooks at start, so restart the session before expecting recall.');
}
