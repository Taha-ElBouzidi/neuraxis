import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { frame } from './mail-frame-rules.mjs';
const AGENT_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const ADDRESS_RE = /^[a-z0-9][a-z0-9._-]{0,47}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CALL_MS = 6000;
export const machineName = () => String(process.env.COMPUTERNAME || hostname() || '').toUpperCase();
const home = () => process.env.USERPROFILE || process.env.HOME || homedir();
export function identity({ kind = 'agent', cwd = process.cwd() } = {}) {
    const env = String(process.env.HAVOK_MOD_AGENT || '').trim().toLowerCase();
    if (AGENT_RE.test(env))
        return env;
    const folder = basename(resolve(String(cwd || '.'))).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40);
    const name = (String(kind).toLowerCase().replace(/[^a-z0-9]/g, '') || 'agent') + (folder ? '-' + folder : '');
    return AGENT_RE.test(name) ? name : 'agent';
}
export function service(h = home()) {
    const read = (p) => { try {
        return JSON.parse(readFileSync(p, 'utf8'));
    }
    catch {
        return null;
    } };
    let token = '';
    for (const f of ['messages-token', 'havok-server-token']) {
        if (token)
            break;
        try {
            token = readFileSync(join(h, '.claude', f), 'utf8').trim();
        }
        catch { }
    }
    if (process.env.HAVOK_MESSAGES_URL)
        return token ? { url: process.env.HAVOK_MESSAGES_URL.replace(/\/+$/, ''), token } : null;
    const mk = read(join(h, '.claude', 'plugins', 'known_marketplaces.json'));
    const dir = String(mk?.['havok-org']?.installLocation || mk?.['havok-org']?.source?.path || '');
    const org = dir ? read(join(dir, 'plugins', 'havok-mod', 'org.json')) : null;
    let url = '';
    if (org)
        url = machineName() === String(org.home || '').toUpperCase() ? org.mailLocal : org.mailRemote;
    if (!url) {
        let brain = '';
        try {
            brain = readFileSync(join(h, '.claude', 'havok-brain-path'), 'utf8').split(/\r?\n/)[0].trim();
        }
        catch { }
        const own = resolve(dirname(fileURLToPath(import.meta.url)), '..');
        for (const dir of [brain, own]) {
            if (url || !dir)
                continue;
            const bj = read(join(dir, 'brain.json'));
            url = String(bj?.messagesUrl || '');
        }
    }
    return url && token ? { url: String(url).replace(/\/+$/, ''), token } : null;
}
async function call(svc, agent, method, path, body, fetchImpl = fetch, ms = CALL_MS) {
    try {
        const r = await fetchImpl(svc.url + path, {
            method, signal: AbortSignal.timeout(ms),
            headers: { authorization: 'Bearer ' + svc.token, 'x-agent': agent, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        let json = {};
        try {
            json = JSON.parse(await r.text());
        }
        catch { }
        return { ok: r.ok, status: r.status, body: json, net: r.status >= 502 && r.status <= 504 };
    }
    catch {
        return { ok: false, status: 0, body: {}, net: true };
    }
}
const outboxFile = (agent, h = home()) => join(h, '.claude', 'havok-messages', `outbox-${agent}.json`);
function readOutbox(agent, h) { try {
    const a = JSON.parse(readFileSync(outboxFile(agent, h), 'utf8'));
    return Array.isArray(a) ? a : [];
}
catch {
    return [];
} }
function writeOutbox(agent, list, h) {
    const f = outboxFile(agent, h);
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f + '.tmp', JSON.stringify(list));
    renameSync(f + '.tmp', f);
}
export async function flushOutbox(agent, { h = home(), svc = service(h), fetchImpl = fetch } = {}) {
    let list = readOutbox(agent, h);
    if (!list.length || !svc)
        return { sent: [], left: list.length };
    const sent = [];
    while (list.length) {
        const item = list[0];
        const r = await call(svc, agent, 'POST', '/send', item, fetchImpl);
        if (!r.ok && (r.net || r.status === 0 || r.status === 429 || r.status >= 500))
            break;
        sent.push({ key: item.key, ok: r.ok, status: r.status, body: r.body });
        list = list.slice(1);
        writeOutbox(agent, list, h);
    }
    return { sent, left: list.length };
}
export async function send(agent, { to = '', text = '', reply_to = '' } = {}, { h = home(), svc = service(h), fetchImpl = fetch } = {}) {
    if (!String(text).trim())
        return { error: 'text is required' };
    if (!to && !reply_to)
        return { error: 'to (an address like havok@SERVER) or reply_to (a message id) is required' };
    const item = { ...(to ? { to: String(to) } : {}), ...(reply_to ? { reply_to: String(reply_to) } : {}), text: String(text), expect_reply: false, key: 'k-' + randomUUID() };
    writeOutbox(agent, [...readOutbox(agent, h), item], h);
    if (!svc)
        return { queued: true, why: 'no messages service or token on this machine; kept in the outbox' };
    const f = await flushOutbox(agent, { h, svc, fetchImpl });
    const mine = f.sent.find((x) => x.key === item.key);
    if (!mine)
        return { queued: true, why: 'the messages service does not answer right now; kept in the outbox and sent in order when it answers' };
    if (!mine.ok)
        return { error: 'the messages service refused it: ' + String(mine.body?.error || mine.status) };
    return { sent: true, id: mine.body?.id, to: mine.body?.to || mine.body?.recipient?.address || to };
}
export async function receive(agent, { session = '', h = home(), svc = service(h), fetchImpl = fetch, boundary = () => randomUUID().replace(/-/g, '').slice(0, 8) } = {}) {
    if (!svc)
        return { text: '', count: 0, why: 'no messages service or token on this machine' };
    const consumer = 'c-' + String(session || agent).replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 60).padEnd(6, '0');
    await flushOutbox(agent, { h, svc, fetchImpl });
    const r = await call(svc, agent, 'GET', `/inbox?consumer=${encodeURIComponent(consumer)}&wait=0`, undefined, fetchImpl);
    if (!r.ok)
        return { text: '', count: 0, why: r.net ? 'the messages service does not answer' : 'the messages service answered ' + r.status };
    const msgs = Array.isArray(r.body.messages) ? r.body.messages : [];
    void call(svc, agent, 'POST', '/heartbeat', { consumer, state: 'listening', version: 'client-1' }, fetchImpl);
    if (!msgs.length)
        return { text: '', count: 0 };
    const text = frame(msgs, boundary);
    await call(svc, agent, 'POST', '/ack', { consumer, ids: msgs.map((m) => m.id) }, fetchImpl);
    return { text, count: msgs.length, ids: msgs.map((m) => m.id) };
}
export async function status(agent, id, { h = home(), svc = service(h), fetchImpl = fetch } = {}) {
    if (!svc)
        return { error: 'no messages service or token on this machine' };
    const r = await call(svc, agent, 'GET', '/status/' + encodeURIComponent(String(id)), undefined, fetchImpl);
    return r.ok ? r.body : { error: r.net ? 'the messages service does not answer' : String(r.body?.error || r.status) };
}
export async function agents(agent, { h = home(), svc = service(h), fetchImpl = fetch } = {}) {
    if (!svc)
        return { error: 'no messages service or token on this machine' };
    const r = await call(svc, agent, 'GET', '/agents', undefined, fetchImpl);
    return r.ok ? r.body : { error: r.net ? 'the messages service does not answer' : String(r.body?.error || r.status) };
}
export async function turnBlock({ kind, session = '', cwd = process.cwd() } = {}, o = {}) {
    const agent = identity({ kind, cwd });
    const r = await receive(agent, { session, ...o });
    if (!r.count)
        return '';
    return `${r.text}\n\nYou are ${agent}@${machineName()}. To answer, call the send_message tool with reply_to set to the message id (or to: an address).`;
}
export const isAddress = (a) => ADDRESS_RE.test(String(a || ''));
export function nodeOk(version = process.versions.node) {
    const [maj, min] = String(version).split('.').map(Number);
    if (maj > 23)
        return true;
    if (maj === 23)
        return min >= 4;
    if (maj === 22)
        return min >= 13;
    return false;
}
