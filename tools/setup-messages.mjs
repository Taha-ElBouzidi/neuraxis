#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.USERPROFILE || process.env.HOME || homedir();
const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n) => { const i = argv.indexOf('--' + n); return i > -1 ? String(argv[i + 1] || '') : ''; };
const all = (n) => argv.flatMap((a, i) => (a === '--' + n ? [String(argv[i + 1] || '')] : [])).filter(Boolean);
const CHECK = flag('check');
const say = (s) => process.stdout.write(s + NL);
const stop = (s) => { say('STOP: ' + s); process.exit(2); };
const changed = [];
const step = (what, fn) => { if (CHECK) {
    say('would: ' + what);
    return;
} fn(); changed.push(what); say('done: ' + what); };
const { nodeOk } = await import('../hooks/messages-client.mjs');
const MACHINE = String(process.env.COMPUTERNAME || hostname() || 'LOCAL').toUpperCase();
const PORT = Number(opt('port') || 8499);
const HOST = opt('listen') || '127.0.0.1';
const DATA = join(HOME, '.neuraxis', 'messages');
const CONFIG = join(DATA, 'config.json');
const ROSTER = join(DATA, 'roster.json');
const TOKEN = join(HOME, '.claude', 'havok-server-token');
const MSG_TOKEN = join(HOME, '.claude', 'messages-token');
const STARTUP = join(process.env.APPDATA || join(HOME, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const LAUNCHER = join(STARTUP, 'neuraxis-messages.vbs');
const WIN = process.platform === 'win32';
const readJson = (p, d = {}) => { try {
    return JSON.parse(readFileSync(p, 'utf8'));
}
catch {
    return d;
} };
const writeJson = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 2) + NL, 'utf8'); };
const fwd = (p) => String(p).split(String.fromCharCode(92)).join('/');
function setBrainUrl(url) {
    const p = join(BRAIN, 'brain.json');
    const b = existsSync(p) ? readJson(p, null) : {};
    if (!b)
        stop('brain.json does not parse; fix it first');
    if (b.messagesUrl === url)
        return;
    step('brain.json messagesUrl = ' + url, () => { b.messagesUrl = url; writeJson(p, b); });
}
function setModMail(url, tokenFile) {
    const dir = join(HOME, '.claude');
    let files = [];
    try {
        files = readdirSync(dir).filter((f) => /^havok-mod\.[a-z0-9._-]+\.json$/.test(f));
    }
    catch { }
    for (const f of files) {
        const p = join(dir, f);
        const c = readJson(p, null);
        if (!c)
            continue;
        const want = { ...(c.mail || {}), enabled: true, url, ...(tokenFile ? { tokenFile: fwd(tokenFile) } : {}) };
        if (JSON.stringify(c.mail || {}) === JSON.stringify(want))
            continue;
        step('~/.claude/' + f + ': messages on, ' + url, () => { c.mail = want; writeJson(p, c); });
    }
}
async function health(url) {
    try {
        const r = await fetch(url + '/health', { signal: AbortSignal.timeout(2000) });
        return r.ok;
    }
    catch {
        return false;
    }
}
function registerClients() {
    if (CHECK) {
        say('would: register the assistants found (node tools/setup-agents.mjs)');
        return;
    }
    const r = spawnSync(process.execPath, [join(BRAIN, 'tools', 'setup-agents.mjs')], { encoding: 'utf8', windowsHide: true });
    say(String(r.stdout || '').trim());
    if (r.status !== 0)
        say('note: setup-agents.mjs exit ' + r.status + ': ' + String(r.stderr || '').trim().slice(0, 300));
}
if (flag('remove')) {
    if (existsSync(LAUNCHER))
        step('removed the login start (' + LAUNCHER + ')', () => unlinkSync(LAUNCHER));
    else
        say('nothing starts it at login');
    say('The service keeps running until this computer restarts; its data stays in ' + DATA + '.');
    process.exit(0);
}
if (opt('join')) {
    const url = opt('join').replace(/\/+$/, '');
    let token = '';
    try {
        token = readFileSync(0, 'utf8').trim();
    }
    catch { }
    if (!token && !existsSync(MSG_TOKEN))
        stop('give the token this computer was issued on stdin: node messages/tools/mail-token.mjs issue ' + MACHINE + ' on the other computer writes it');
    if (token)
        step('~/.claude/messages-token (the token for ' + url + ')', () => { mkdirSync(dirname(MSG_TOKEN), { recursive: true }); writeFileSync(MSG_TOKEN, token + NL, { mode: 0o600 }); });
    if (!CHECK && !(await health(url)))
        say('note: ' + url + '/health does not answer from here yet; check the address and the network');
    setBrainUrl(url);
    setModMail(url, MSG_TOKEN);
    registerClients();
    say(CHECK ? 'check only: nothing was changed' : 'this computer now uses ' + url + ' as ' + MACHINE + '.');
    process.exit(0);
}
if (!nodeOk())
    stop('agent messages need Node 22.13 or later (they keep messages in node:sqlite); this is Node ' + process.versions.node + '. The rest of the engine works on Node 18 or later. Install a current Node from https://nodejs.org and run this again.');
const SERVICE = resolve(opt('service') || join(BRAIN, 'messages'));
if (!existsSync(join(SERVICE, 'server.mjs')))
    stop('no messages service in ' + SERVICE + ' (server.mjs). Update the engine (node tools/update.mjs), or give --service <folder>.');
if (!existsSync(TOKEN)) {
    step('~/.claude/havok-server-token (this computer\'s token, shared with the engine server)', () => {
        mkdirSync(dirname(TOKEN), { recursive: true });
        writeFileSync(TOKEN, randomBytes(32).toString('base64url') + NL, { mode: 0o600 });
    });
}
const roster = readJson(ROSTER, { machines: [], aliases: {}, default: 'allow' });
const machines = [...new Set([...(roster.machines || []), MACHINE, ...all('allow').map((m) => m.toUpperCase())])];
if (JSON.stringify(machines) !== JSON.stringify(roster.machines || []) || !existsSync(ROSTER)) {
    step('roster: ' + machines.join(', ') + ' may use the service', () => writeJson(ROSTER, { aliases: {}, default: 'allow', ...roster, machines }));
}
const config = { service: fwd(SERVICE), port: PORT, host: HOST, machine: MACHINE, dataDir: fwd(join(DATA, 'data')), roster: fwd(ROSTER), brainHome: fwd(join(HOME, '.claude')) };
if (JSON.stringify(readJson(CONFIG, null)) !== JSON.stringify(config))
    step('settings in ' + CONFIG, () => writeJson(CONFIG, config));
if (HOST !== '127.0.0.1')
    say('note: listening on ' + HOST + ' lets other computers reach it; keep it on a private network or behind TLS, the token travels in every call.');
const START = join(BRAIN, 'tools', 'messages-start.mjs');
if (WIN) {
    const q = (s) => '""' + s + '""';
    const vbs = 'CreateObject("WScript.Shell").Run "' + q(process.execPath) + ' ' + q(START) + '", 0, False' + NL;
    let now = '';
    try {
        now = readFileSync(LAUNCHER, 'utf8');
    }
    catch { }
    if (now !== vbs)
        step('started at login, hidden (' + LAUNCHER + ')', () => { mkdirSync(STARTUP, { recursive: true }); writeFileSync(LAUNCHER, vbs, 'utf8'); });
}
else {
    say('note: to start it at login here, run "' + process.execPath + ' ' + START + '" from your login items (launchd or systemd).');
}
const URL_LOCAL = 'http://127.0.0.1:' + PORT;
if (!CHECK && !(await health(URL_LOCAL))) {
    step('messages service started on ' + HOST + ':' + PORT, () => {
        spawn(process.execPath, [START], { detached: true, stdio: 'ignore', windowsHide: true, cwd: SERVICE }).unref();
    });
    let up = false;
    for (let i = 0; i < 20 && !up; i++) {
        await new Promise((r) => setTimeout(r, 500));
        up = await health(URL_LOCAL);
    }
    if (!up)
        stop('the messages service did not answer on ' + URL_LOCAL + ' within 10 seconds: run node tools/messages-start.mjs to see why');
}
if (!CHECK)
    say('check: messages service answers on ' + URL_LOCAL + '/health');
setBrainUrl(URL_LOCAL);
setModMail(URL_LOCAL, '');
registerClients();
say(CHECK ? 'check only: nothing was changed' : (changed.length ? 'changed: ' + changed.length + ' item(s). Start a new session of each assistant to pick it up. Address: <agent>@' + MACHINE + '.' : 'everything was already in place'));
