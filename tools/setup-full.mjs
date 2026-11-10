#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, platform } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
const WITH_VALUE = new Set(['--agent', '--owner']);
const KNOWN = new Set(['--check', '--mod', '--another', '--yes', ...WITH_VALUE]);
const unknown = argv.filter((a, i) => !KNOWN.has(a) && !(i > 0 && WITH_VALUE.has(argv[i - 1])));
if (unknown.length || argv.includes('--help') || argv.includes('-h')) {
    const usage = readFileSync(fileURLToPath(import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^\/\/\s+node tools\/setup-full\.mjs/.test(l)).map((l) => l.replace(/^\/\/ ?/, ''));
    process.stdout.write((unknown.length && !unknown.every((u) => u === '--help' || u === '-h') ? 'unknown option: ' + unknown.join(' ') + '. Nothing was changed.\n' : '') + 'usage:\n' + usage.join('\n') + '\nNothing was changed.\n');
    process.exit(unknown.every((u) => u === '--help' || u === '-h') ? 0 : 2);
}
const YES = argv.includes('--yes');
const CHECK = argv.includes('--check');
const MOD = argv.includes('--mod');
const AGENT = String(flag('--agent') || 'assistant').trim().toLowerCase();
const OWNER = flag('--owner');
const ANOTHER = argv.includes('--another');
const PORT = Number(process.env.HAVOK_SERVER_PORT || 8478);
if (MOD && !CHECK && !YES && !confirmed()) {
    process.stderr.write('not installed, nothing changed: the mod changes machine-wide settings for every user of this computer (C:\\Program Files). Ask the person; when they agree, run: node tools/setup-full.mjs --mod --yes' + String.fromCharCode(10));
    process.exit(1);
}
const HOME = homedir();
const say = (s) => process.stdout.write(s + NL);
function confirmed() {
    if (!process.stdin.isTTY)
        return false;
    process.stdout.write('The mod changes machine-wide settings for every user of this computer. Type yes to install it: ');
    const buf = Buffer.alloc(64);
    let n = 0;
    try {
        n = readSync(0, buf, 0, 64, null);
    }
    catch {
        return false;
    }
    return buf.toString('utf8', 0, n).trim().toLowerCase() === 'yes';
}
const stop = (s) => { process.stderr.write(s + NL); process.exit(1); };
if (platform() !== 'win32') {
    stop('The full system (context layers, clean-up, decision log) runs on Windows only for now. Memory and recall work here:'
        + ' node tools/setup-agents.mjs wires them into your assistant.');
}
if (!/^[a-z][a-z0-9-]{1,40}$/.test(AGENT))
    stop('--agent must be a lowercase name (letters, digits, dashes), for example assistant');
const claude = spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true });
if (claude.status !== 0) {
    stop('Claude Code is not installed here (no claude command). The full system is for Claude Code; for another assistant,'
        + ' node tools/setup-agents.mjs gives memory and recall.');
}
const changed = [];
const step = (what, fn) => { if (CHECK) {
    say('would: ' + what);
    return;
} fn(); changed.push(what); say('done: ' + what); };
const cfgFile = join(BRAIN, 'brain.json');
let cfg = {};
if (existsSync(cfgFile)) {
    try {
        cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    }
    catch {
        stop('brain.json does not parse; fix it first, nothing was changed');
    }
}
if (cfg.localServer !== true || (OWNER && cfg.owner !== OWNER)) {
    step('brain.json: localServer on' + (OWNER ? ', owner ' + OWNER : ''), () => {
        const next = { ...cfg, localServer: true, ...(OWNER ? { owner: OWNER } : {}) };
        writeFileSync(cfgFile, JSON.stringify(next, null, 2) + NL, 'utf8');
    });
}
const layers = join(BRAIN, 'layers');
const global = join(layers, 'global.md');
if (!existsSync(global)) {
    step('layers/global.md: a starting global context (replace it with the person\u2019s own, AGENTS.md item 6)', () => {
        mkdirSync(layers, { recursive: true });
        const seed = join(BRAIN, 'kit', 'files', 'global-layer-template.md');
        if (existsSync(seed))
            copyFileSync(seed, global);
        else
            writeFileSync(global, '# Global context: every session of this assistant' + NL + NL
                + '- Work in the language the person writes in.' + NL
                + '- Memory: before answering, open the memories the recall block names; save a lasting fact the moment it is true.' + NL, 'utf8');
    });
}
const marker = join(HOME, '.claude', 'havok-brain-path');
let markerNow = '';
try {
    markerNow = readFileSync(marker, 'utf8').split(/\r?\n/)[0].trim();
}
catch { }
if (!markerNow || resolve(markerNow) !== BRAIN) {
    step('~/.claude/havok-brain-path: ' + BRAIN, () => { mkdirSync(dirname(marker), { recursive: true }); writeFileSync(marker, BRAIN + NL, 'utf8'); });
}
const modCfg = join(HOME, '.claude', 'havok-mod.' + AGENT + '.json');
if (!existsSync(modCfg)) {
    step('~/.claude/havok-mod.' + AGENT + '.json: the mod settings for this assistant', () => {
        writeFileSync(modCfg, JSON.stringify({
            agent: AGENT,
            main: true,
            context: { layerHost: 'http://127.0.0.1:' + PORT, idle: { enabled: true } },
            checks: { brainDir: BRAIN.split('\\').join('/') },
            mail: { enabled: false },
            usage: { enabled: false },
            keepWarm: { enabled: true },
            remoteControl: { enabled: false },
        }, null, 2) + NL, 'utf8');
    });
}
const envNow = spawnSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('HAVOK_MOD_AGENT','User')"], { encoding: 'utf8', windowsHide: true });
if (ANOTHER) {
    console.log('another assistant: the default stays "' + (String(envNow.stdout || '').trim() || 'none') + '". Start ' + AGENT + ' in a terminal that names it:');
    console.log("  PowerShell:  $env:HAVOK_MOD_AGENT = '" + AGENT + "'; claude");
    console.log("  or a Windows Terminal profile whose command line is:  powershell -NoExit -Command \"$env:HAVOK_MOD_AGENT='" + AGENT + "'; claude\"");
}
else if (String(envNow.stdout || '').trim() !== AGENT) {
    step('user variable HAVOK_MOD_AGENT=' + AGENT + ' (sessions started from now on)', () => {
        const r = spawnSync('powershell', ['-NoProfile', '-Command', "[Environment]::SetEnvironmentVariable('HAVOK_MOD_AGENT','" + AGENT + "','User')"], { encoding: 'utf8', windowsHide: true });
        if (r.status !== 0)
            stop('could not set HAVOK_MOD_AGENT: ' + String(r.stderr || '').trim());
    });
}
async function health() {
    try {
        const r = await fetch('http://127.0.0.1:' + PORT + '/health', { signal: AbortSignal.timeout(2000) });
        return r.ok;
    }
    catch {
        return false;
    }
}
if (!(await health())) {
    step('engine server started on 127.0.0.1:' + PORT, () => {
        const env = { ...process.env, HAVOK_LAYERS_DIR: process.env.HAVOK_LAYERS_DIR || layers };
        spawn(process.execPath, [join(BRAIN, 'tools', 'brain-server.mjs')], { detached: true, stdio: 'ignore', cwd: BRAIN, windowsHide: true, env }).unref();
    });
    if (!CHECK) {
        let up = false;
        for (let i = 0; i < 30 && !up; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            up = await health();
        }
        if (!up)
            stop('the engine server did not answer on 127.0.0.1:' + PORT + ' within 30 seconds: run node tools/brain-server.mjs to see why');
    }
}
if (!CHECK)
    say('check: engine server answers on http://127.0.0.1:' + PORT + '/health');
const install = join(BRAIN, 'mod', 'release', 'install.ps1');
if (MOD) {
    if (!existsSync(install))
        stop('mod/release/install.ps1 is missing from this repository; update it first (node tools/update.mjs)');
    if (CHECK)
        say('would: install the mod (a Windows administrator prompt appears)');
    else {
        say('installing the mod: Windows asks for an administrator. On a work computer where you are not one, your IT team runs: '
            + 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + install + '" -Force');
        const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', install, '-Force'], { stdio: 'inherit', windowsHide: true });
        if (r.status !== 0)
            stop('the mod install did not finish (exit ' + r.status + '); nothing else is affected, memory and recall work without it');
        changed.push('mod installed');
    }
}
else if (!CHECK) {
    say('next: node tools/setup-full.mjs --mod --yes installs the mod (layers, clean-up), once the person agrees; it needs a Windows administrator and changes settings for every user of this computer.');
}
say(CHECK ? 'check only: nothing was changed' : (changed.length ? 'changed: ' + changed.length + ' item(s). Start a new Claude Code session.' : 'everything was already in place'));
