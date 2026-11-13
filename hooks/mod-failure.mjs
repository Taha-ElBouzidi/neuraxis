#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export const FILE = ['.claude', 'havok-mod', 'mod-failures.jsonl'];
const SEND_MS = 8000;
const safe = (s, n = 80) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, n);
const machineName = () => String(process.env.COMPUTERNAME || hostname() || '').toUpperCase();
export function readRows(home) {
    try {
        return readFileSync(join(home, ...FILE), 'utf8').split('\n').filter(Boolean).map((l) => { try {
            return JSON.parse(l);
        }
        catch {
            return null;
        } }).filter(Boolean);
    }
    catch {
        return [];
    }
}
export function addRow(home, { session, source, cause, why, agent = '', mod = '', now = Date.now() }) {
    const sid = safe(session);
    const c = safe(cause, 40) || 'mod-off';
    if (readRows(home).some((r) => r.session === sid && r.cause === c))
        return null;
    const row = { at: new Date(now).toISOString(), machine: machineName(), agent: safe(agent, 48), session: sid, source: safe(source, 30), cause: c, why: String(why || '').slice(0, 400), mod: String(mod || '').slice(0, 20), sent: false };
    const f = join(home, ...FILE);
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify(row) + '\n');
    return row;
}
function orgOf(home) {
    const read = (p) => { try {
        return JSON.parse(readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    } };
    const mk = read(join(home, '.claude', 'plugins', 'known_marketplaces.json'));
    const dir = String(mk?.['havok-org']?.installLocation || mk?.['havok-org']?.source?.path || '');
    const fromMarket = dir ? read(join(dir, 'plugins', 'havok-mod', 'org.json')) : null;
    if (fromMarket)
        return fromMarket;
    const reg = read(join(home, '.claude', 'plugins', 'installed_plugins.json'));
    const inst = (reg?.plugins?.['havok-mod@havok-org'] || [])[0];
    return inst?.installPath ? read(join(String(inst.installPath), 'org.json')) : null;
}
export function target(home) {
    try {
        const org = orgOf(home);
        if (!org)
            return null;
        const to = String(org.alertsTo || org.reportTo || '');
        const url = machineName() === String(org.home || '').toUpperCase() ? org.mailLocal : org.mailRemote;
        const token = readFileSync(join(home, '.claude', 'havok-server-token'), 'utf8').trim();
        return to && url && token ? { to, url: String(url), token } : null;
    }
    catch {
        return null;
    }
}
export function text(r) {
    return `Mod failure on ${r.machine}: agent ${r.agent || '(no agent name)'}, session ${r.session}${r.mod ? `, mod ${r.mod}` : ''}. ${r.why} ` +
        `Seen by the ${r.source === 'statusline' ? 'status line' : 'session start hook'} at ${r.at.slice(11, 16)} UTC. The agent runs without its mod until it is restarted through its launcher (when idle).`;
}
export async function sendAll(home, fetchImpl = fetch) {
    const rows = readRows(home);
    const todo = rows.filter((r) => !r.sent);
    if (!todo.length)
        return { sent: 0, left: 0 };
    const t = target(home);
    if (!t)
        return { sent: 0, left: todo.length, why: 'no mod org.json, address or token on this machine' };
    let sent = 0;
    for (const r of todo) {
        try {
            const res = await fetchImpl(t.url.replace(/\/+$/, '') + '/send', {
                method: 'POST', signal: AbortSignal.timeout(SEND_MS),
                headers: { authorization: 'Bearer ' + t.token, 'x-agent': 'mod-watch', 'content-type': 'application/json' },
                body: JSON.stringify({ to: t.to, text: text(r), expect_reply: false, key: `modfail-${r.session}-${r.cause}` }),
            });
            if (!res.ok)
                break;
            r.sent = true;
            r.sentAt = new Date().toISOString();
            sent++;
        }
        catch {
            break;
        }
    }
    if (sent) {
        const f = join(home, ...FILE);
        const tmp = f + '.tmp';
        writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
        renameSync(tmp, f);
    }
    return { sent, left: todo.length - sent };
}
export function report(home, row, self = fileURLToPath(import.meta.url)) {
    const added = addRow(home, row);
    if (readRows(home).some((r) => !r.sent)) {
        try {
            spawn(process.execPath, [self, 'send'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, USERPROFILE: home, HOME: home } }).unref();
        }
        catch { }
    }
    return added;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const home = process.env.USERPROFILE || process.env.HOME || homedir();
    const [cmd, session, source, cause, ...why] = process.argv.slice(2);
    if (cmd === 'send') {
        const r = await sendAll(home);
        console.log(JSON.stringify(r));
        process.exit(0);
    }
    if (cmd === 'report') {
        console.log(JSON.stringify(report(home, { session, source, cause, why: why.join(' '), agent: process.env.HAVOK_MOD_AGENT || '' })));
        process.exit(0);
    }
    console.error('usage: mod-failure.mjs report <session> <source> <cause> <why...> | send');
    process.exit(2);
}
