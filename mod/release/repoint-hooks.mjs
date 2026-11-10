import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const slash = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
export const COVERED = new Set([
    'dispatch.mjs', 'check-session-start.mjs', 'check-limit.mjs', 'check-keep-warm.mjs', 'brain-gate.mjs', 'recall-gate.mjs',
    'style-note.mjs', 'pre-turn.mjs', 'check-content.mjs', 'check-secrets.mjs', 'check-brain-commit.mjs',
    'check-commit-message.mjs', 'check-windows.mjs', 'helper-brain.mjs', 'check-stop.mjs', 'check-memory-written.mjs',
    'post-compact.mjs',
]);
const BRAIN_HOOK = /[A-Za-z]:[\\/][^"'\s]*?[\\/]hooks[\\/]([^"'\s\\/]+\.mjs)/;
export function covered(command) {
    const m = String(command ?? '').match(BRAIN_HOOK);
    return !!m && COVERED.has(m[1].toLowerCase());
}
export function dropCovered(settings) {
    const dropped = [];
    const hooks = settings?.hooks;
    if (!hooks || typeof hooks !== 'object')
        return dropped;
    for (const [event, list] of Object.entries(hooks)) {
        if (!Array.isArray(list))
            continue;
        const keptGroups = [];
        for (const group of list) {
            const inner = Array.isArray(group?.hooks) ? group.hooks : [];
            const kept = inner.filter((h) => {
                if (h?.type === 'command' && covered(h.command)) {
                    dropped.push({ event, command: h.command });
                    return false;
                }
                return true;
            });
            if (kept.length || !inner.length)
                keptGroups.push(kept.length === inner.length ? group : { ...group, hooks: kept });
        }
        if (keptGroups.length)
            hooks[event] = keptGroups;
        else
            delete hooks[event];
    }
    if (!Object.keys(hooks).length)
        delete settings.hooks;
    return dropped;
}
export function repoint(settings, brainDir, exists = existsSync) {
    const to = slash(brainDir);
    const changes = [];
    const hooks = settings?.hooks;
    if (!to || !hooks || typeof hooks !== 'object')
        return changes;
    const pattern = /([A-Za-z]:[\\/][^"'\s]*?)[\\/]((?:hooks|tools)[\\/][^"'\s\\/]+\.mjs)/g;
    for (const list of Object.values(hooks)) {
        if (!Array.isArray(list))
            continue;
        for (const group of list)
            for (const h of group?.hooks ?? []) {
                if (typeof h?.command !== 'string')
                    continue;
                const next = h.command.replace(pattern, (whole, folder, rel) => {
                    const from = slash(folder);
                    if (from.toLowerCase() === to.toLowerCase())
                        return whole;
                    const target = `${to}/${slash(rel)}`;
                    if (!exists(target))
                        return whole;
                    const sep = whole.includes('\\') ? '\\' : '/';
                    return target.split('/').join(sep);
                });
                if (next !== h.command) {
                    changes.push({ from: h.command, to: next });
                    h.command = next;
                }
            }
    }
    return changes;
}
export function setShell(settings) {
    const set = [];
    for (const list of Object.values(settings?.hooks ?? {})) {
        if (!Array.isArray(list))
            continue;
        for (const group of list)
            for (const h of group?.hooks ?? []) {
                if (h?.type === 'command' && typeof h.command === 'string' && !h.shell) {
                    h.shell = 'powershell';
                    set.push(h.command);
                }
            }
    }
    return set;
}
export function fixServerUrl(settings, url) {
    const want = slash(url);
    const env = settings?.env;
    if (!want || !env || typeof env !== 'object' || typeof env.HAVOK_SERVER_URL !== 'string')
        return null;
    if (slash(env.HAVOK_SERVER_URL) === want)
        return null;
    const from = env.HAVOK_SERVER_URL;
    env.HAVOK_SERVER_URL = want;
    return { from, to: want };
}
const GIT_BASH = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe'];
export const hasGitBash = (exists = existsSync) => GIT_BASH.some((p) => exists(p)) || !!process.env.CLAUDE_CODE_GIT_BASH_PATH;
export function change(settings, org, opts = {}) {
    const exists = opts.exists ?? existsSync;
    const dropped = dropCovered(settings);
    const repointed = repoint(settings, org.brainDir ?? '', exists);
    const shells = (opts.gitBash ?? hasGitBash(exists)) ? [] : setShell(settings);
    const url = fixServerUrl(settings, org.layerHost ?? '');
    return { dropped, repointed, shells, url };
}
if (slash(process.argv[1] ?? '').endsWith('/repoint-hooks.mjs')) {
    const [orgFile, settingsArg] = process.argv.slice(2);
    if (orgFile) {
        let org = {};
        try {
            org = JSON.parse(readFileSync(orgFile, 'utf8'));
        }
        catch { }
        const file = settingsArg || join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', 'settings.json');
        if (!org.brainDir)
            console.log('no engine folder in org.json: nothing to change');
        else if (!existsSync(file))
            console.log('no ' + file + ': nothing to change');
        else {
            const raw = readFileSync(file, 'utf8');
            const bom = raw.charCodeAt(0) === 0xfeff;
            const settings = JSON.parse(bom ? raw.slice(1) : raw);
            const r = change(settings, org);
            if (!r.dropped.length && !r.repointed.length && !r.shells.length && !r.url)
                console.log('hooks: nothing to change');
            else {
                const backup = file + '.bak-repoint-' + new Date().toISOString().slice(0, 10);
                copyFileSync(file, backup);
                writeFileSync(file, (bom ? String.fromCharCode(0xfeff) : '') + JSON.stringify(settings, null, 2) + '\n');
                for (const d of r.dropped)
                    console.log(`hook taken out (${d.event}), the mod does its work: ${d.command}`);
                for (const c of r.repointed)
                    console.log('hook repointed: ' + c.from + '  is now  ' + c.to);
                for (const c of r.shells)
                    console.log('hook set to run in PowerShell (no Git Bash here): ' + c);
                if (r.url)
                    console.log(`env HAVOK_SERVER_URL ${r.url.from} is now ${r.url.to}`);
                console.log('backup: ' + backup);
            }
        }
    }
}
