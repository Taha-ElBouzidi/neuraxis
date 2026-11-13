import { createServer } from 'node:http';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, copyFileSync, existsSync, watch } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { makeAuth } from './lib/auth.mjs';
import { ULID_RE } from './lib/ulid.mjs';
import { openOutages, alertText, backText, diagnosis, KINDS } from './lib/outages.mjs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
const otherWarnings = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning')
    for (const f of otherWarnings)
        f(w); });
const { openStore } = await import('./lib/store.mjs');
const APP = dirname(fileURLToPath(import.meta.url));
const VERSION = '1.8.1';
const PORT = Number(process.env.MAIL_PORT || process.env.PORT || 8499);
const HOST = process.env.MAIL_HOST || '127.0.0.1';
const BRAIN_HOME = process.env.MAIL_BRAIN_HOME || process.env.HAVOK_HOME || join(homedir(), '.claude');
const DATA_DIR = process.env.MAIL_DATA_DIR || join(homedir(), '.claude', 'havok-mail');
const ROSTER_FILE = process.env.MAIL_ROSTER || join(APP, 'roster.json');
const LEASE_MS = Number(process.env.MAIL_LEASE_MS || 120000);
const CONSUMER_STALE_MS = Number(process.env.MAIL_CONSUMER_STALE_MS || 90000);
const LISTENING_MS = Number(process.env.MAIL_LISTENING_MS || 60000);
const MAX_BODY = 256 * 1024;
const MAX_WAIT_S = 28;
const AGENT_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const MACHINE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const DEFAULT_LIMITS = {
    maxTextBytes: 32768, perSenderPerMinute: 20, perSenderPerHour: 200, perMachinePerMinute: 60,
    repliesPerMessage: 2, maxThreadDepth: 12, replyTimeoutSeconds: 1800, maxReplyTimeoutSeconds: 86400,
    requestsPerMachinePerMinute: 1200,
    perMachinePerHour: 600, maxPendingPerRecipient: 500,
};
const log = (s) => process.stdout.write(new Date().toISOString() + ' ' + s + '\n');
const auth = makeAuth({ brainHome: BRAIN_HOME, dataDir: DATA_DIR, homeMachine: process.env.MAIL_HOME_MACHINE || '' });
mkdirSync(DATA_DIR, { recursive: true });
if (process.platform === 'win32' && process.env.USERNAME) {
    try {
        execFileSync('icacls', [DATA_DIR, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(OI)(CI)(F)`, '/grant:r', 'SYSTEM:(OI)(CI)(F)'], { stdio: 'ignore' });
        for (const f of readdirSync(DATA_DIR))
            execFileSync('icacls', [join(DATA_DIR, f), '/inheritance:e'], { stdio: 'ignore' });
    }
    catch (e) {
        log('could not restrict the data folder: ' + e.message);
    }
}
const store = openStore(DATA_DIR, { leaseMs: LEASE_MS, consumerStaleMs: CONSUMER_STALE_MS, listeningMs: LISTENING_MS, log, isArchived: (address) => !!lastRoster && lastRoster.archived.some((p) => glob(p, address)) });
const outages = openOutages(DATA_DIR, { quietMs: Number(process.env.MAIL_OUTAGE_QUIET_MS) || undefined });
const SYSTEM_SENDER = `system@${String(process.env.MAIL_HOME_MACHINE || process.env.COMPUTERNAME || 'LOCAL').toUpperCase()}`;
function probeHealth(url) {
    return new Promise((resolve) => {
        if (!url)
            return resolve({ healthy: null, ms: null });
        const t = Date.now();
        let req;
        try {
            const u = new URL(url);
            const mod = u.protocol === 'https:' ? httpsRequest : httpRequest;
            req = mod(u, { method: 'GET', timeout: 3000, rejectUnauthorized: false }, (res) => {
                res.resume();
                res.on('end', () => resolve({ healthy: res.statusCode === 200, ms: Date.now() - t }));
            });
        }
        catch {
            return resolve({ healthy: null, ms: null });
        }
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', () => resolve({ healthy: false, ms: Date.now() - t }));
        req.end();
    });
}
const OPEN_EVERY_MS = 10 * 60000;
const openedAt = new Map();
function openIfAsleep(recipient) {
    try {
        const want = lastRoster && lastRoster.openOnMessage && lastRoster.openOnMessage[recipient];
        const profile = want && typeof want === 'object' ? String(want.profile || '') : '';
        if (!profile || !/^\w[\w .,()'-]{0,79}$/.test(profile))
            return;
        const a = store.agent(recipient);
        if (a && store.agentView(a).listening)
            return;
        const last = openedAt.get(recipient) || 0;
        if (Date.now() - last < OPEN_EVERY_MS)
            return;
        openedAt.set(recipient, Date.now());
        const child = spawn('wt.exe', ['-w', '0', 'new-tab', '-p', profile], { detached: true, stdio: 'ignore', windowsHide: false });
        child.on('error', (e) => log(`OPEN-ON-MESSAGE ${recipient} failed: ${e.message}`));
        child.unref();
        log(`OPEN-ON-MESSAGE ${recipient} profile "${profile}"`);
    }
    catch (e) {
        log(`OPEN-ON-MESSAGE ${recipient} failed: ${e.message}`);
    }
}
function systemMessage(to, text) {
    if (!to || !/^[a-z0-9][a-z0-9._-]{0,47}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(to))
        return null;
    try {
        const m = store.insert({ sender: SYSTEM_SENDER, recipient: to, text, bytes: Buffer.byteLength(text, 'utf8'), expectReply: false, replyTimeoutMs: 0 });
        wake(to);
        openIfAsleep(to);
        return m.id;
    }
    catch (e) {
        log('outage message failed: ' + e.message);
        return null;
    }
}
let outageTimer = null;
let lastAlertTo = '';
function armOutages() {
    clearTimeout(outageTimer);
    outageTimer = null;
    const at = outages.nextClosing();
    if (at === null)
        return;
    outageTimer = setTimeout(() => {
        let r = null;
        try {
            r = roster();
        }
        catch { }
        const cfg = (r && r.outages) || {};
        for (const o of outages.due()) {
            const to = cfg.alertsTo || o.alert?.to || lastAlertTo;
            const id = systemMessage(to, backText(o, cfg.page || `http://127.0.0.1:${PORT}/outages/page`));
            log(`OUTAGE-CLOSED ${o.id} ${Math.round((o.end - o.start) / 1000)}s reports=${o.reports.length} back=${id || 'not sent'}`);
        }
        armOutages();
    }, Math.min(Math.max(0, at - Date.now()) + 50, 2000000000));
    outageTimer.unref();
}
armOutages();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function outagesPage() {
    const t = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '');
    const rows = outages.list().slice(0, 200).map((o) => {
        const downs = o.reports.filter((x) => x.state === 'down');
        const reps = o.reports.map((x) => `<li>${esc(t(x.at))} <b>${esc(x.state)}</b> ${esc(x.by)}${x.serverHealthy === null ? '' : x.serverHealthy ? ` (server health ok, ${esc(x.serverMs)} ms)` : ' (server health failed)'}${x.error ? ': ' + esc(x.error) : ''}</li>`).join('');
        const len = o.end ? Math.max(1, Math.round((o.end - o.start) / 60000)) + ' min' : 'open';
        return `<tr><td>${esc(t(o.start))}</td><td>${esc(len)}</td><td>${esc([...new Set(downs.map((x) => x.machine))].join(', '))}</td><td>${esc(downs.length)}</td><td>${esc(o.end ? diagnosis(o) : '')}</td><td><details><summary>${esc(o.reports.length)} reports</summary><ul>${reps}</ul></details></td></tr>`;
    }).join('');
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brain outages</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f4f4f4}ul{margin:4px 0;padding-left:18px}</style>
<h1>Brain outages</h1><p>Every time an agent found recall down, newest first. The first report opens an outage and alerts once; later reports join it; it closes 2 minutes after recall answers again. "server health" is the brain server's own health check, asked by the messages service at each down report.</p>
<table><tr><th>Started</th><th>Length</th><th>Machines</th><th>Down reports</th><th>What it says</th><th>Reports</th></tr>${rows || '<tr><td colspan="6">No outage recorded yet.</td></tr>'}</table>`;
}
let lastRoster = null;
function roster() {
    try {
        const r = JSON.parse(readFileSync(ROSTER_FILE, 'utf8'));
        lastRoster = { machines: r.machines || [], aliases: r.aliases || {}, default: r.default || 'deny', restricted: r.restricted || {}, deny: r.deny || [], retired: r.retired || [], archived: Array.isArray(r.archived) ? r.archived.map(String) : [], outages: r.outages && typeof r.outages === 'object' ? r.outages : {}, openOnMessage: r.openOnMessage && typeof r.openOnMessage === 'object' ? r.openOnMessage : {}, limits: { ...DEFAULT_LIMITS, ...(r.limits || {}) } };
    }
    catch (e) {
        if (!lastRoster)
            throw new Error('roster unreadable and no earlier copy: ' + e.message);
        log('ROSTER-UNREADABLE keeping the last good copy: ' + e.message);
    }
    return lastRoster;
}
let retiredSeen = null;
function retireSweep(r, always = false) {
    const sig = JSON.stringify(r.retired);
    const changed = sig !== retiredSeen;
    retiredSeen = sig;
    if (!r.retired.length || !(changed || always))
        return;
    const hit = store.sweepRetired((address) => isRetired(r, address));
    if (hit.length)
        log(`RETIRED-SWEEP ${hit.length} waiting messages marked undeliverable`);
    for (const m of hit)
        tellSender(m, 'undeliverable', 'the address ' + m.recipient + ' was retired');
}
let archivedSeen = null;
function archiveSweep(r) {
    const sig = JSON.stringify(r.archived);
    if (sig === archivedSeen)
        return;
    store.reconcileArchived((address) => isArchived(r, address), r.archived.filter((p) => !p.includes('*') && p.includes('@')));
    if (archivedSeen !== null)
        for (const address of [...waiters.keys()])
            wake(address);
    archivedSeen = sig;
}
const glob = (pattern, s) => new RegExp('^' + pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(s);
const isRetired = (r, address) => r.retired.some((p) => glob(p, address));
const isArchived = (r, address) => r.archived.some((p) => glob(p, address));
const isRestricted = (r, address) => Object.keys(r.restricted).some((p) => glob(p, address));
function mayTalk(r, from, to) {
    for (const [pattern, peers] of Object.entries(r.restricted)) {
        if (glob(pattern, from) && !peers.some((p) => glob(p, to)))
            return `${from} may only message ${peers.join(', ')}`;
        if (glob(pattern, to) && !peers.some((p) => glob(p, from)))
            return `${to} may only receive from ${peers.join(', ')}`;
    }
    for (const [a, b] of r.deny)
        if ((glob(a, from) && glob(b, to)) || (glob(b, from) && glob(a, to)))
            return `${from} and ${to} may not message each other`;
    if (r.default !== 'allow')
        return 'the roster allows nothing by default';
    return null;
}
const windows = new Map();
function overLimit(key, limit, windowMs, now = Date.now()) {
    const hits = (windows.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
        windows.set(key, hits);
        return true;
    }
    hits.push(now);
    windows.set(key, hits);
    return false;
}
function wouldExceed(key, limit, windowMs, now = Date.now()) {
    return (windows.get(key) || []).filter((t) => now - t < windowMs).length >= limit;
}
const waiters = new Map();
function wake(address) {
    const set = waiters.get(address);
    if (!set)
        return;
    waiters.delete(address);
    for (const done of set)
        done();
}
const TELL_SENDER = false;
function tellSender(m, what, reason) {
    if (!TELL_SENDER)
        return;
    try {
        const from = (lastRoster && lastRoster.aliases && lastRoster.aliases.system) || 'system@' + String(process.env.COMPUTERNAME || 'localhost').toUpperCase();
        if (!m || m.sender === from || m.recipient === from)
            return;
        const key = what + ': ' + String(reason || '').slice(0, 160);
        if (store.wasTold(m.id, key))
            return;
        const sent = new Date(m.created).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
        const head = what === 'undeliverable' ? 'cannot be delivered' : what === 'failed' ? 'was not seen by the recipient' : 'is not delivered yet';
        const text = `Your message ${m.id} to ${m.recipient} (sent ${sent}) ${head}: ${reason}. message_status ${m.id} shows its state.`;
        store.insert({ sender: from, recipient: m.sender, text, bytes: Buffer.byteLength(text), expectReply: false, replyTimeoutMs: 0 });
        store.markTold(m.id, key);
        wake(m.sender);
        log(`TOLD-SENDER ${m.sender} ${what} ${m.id}`);
    }
    catch (e) {
        log('TOLD-SENDER failed for ' + (m && m.id) + ': ' + e.message);
    }
}
function waitForMail(address, seconds, res) {
    return new Promise((resolve) => {
        const set = waiters.get(address) ?? new Set();
        waiters.set(address, set);
        const done = () => {
            clearTimeout(timer);
            set.delete(done);
            if (!set.size && waiters.get(address) === set)
                waiters.delete(address);
            resolve();
        };
        const timer = setTimeout(done, seconds * 1000);
        set.add(done);
        res.on('close', done);
    });
}
function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const parts = [];
        req.on('data', (c) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(Object.assign(new Error('body too large'), { status: 413 }));
                req.destroy();
                return;
            }
            parts.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        req.on('error', reject);
    });
}
class HttpError extends Error {
    constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; }
}
function resolveRecipient(r, to, caller) {
    const t = String(to || '').trim();
    if (!t)
        throw new HttpError(400, 'to is required');
    if (t.includes('@')) {
        const [agent, machine] = t.split('@');
        if (!AGENT_RE.test(agent) || !MACHINE_RE.test(machine || ''))
            throw new HttpError(400, 'to must be agent@MACHINE or a known agent name');
        const m = r.machines.find((x) => x.toLowerCase() === machine.toLowerCase());
        if (!m)
            throw new HttpError(404, `machine ${machine} is not on the messages roster`);
        return `${agent}@${m}`;
    }
    const name = t.toLowerCase();
    if (r.aliases[name])
        return r.aliases[name];
    const visible = (a) => a.address !== caller && !mayTalk(r, caller, a.address);
    const seen = store.agentsNamed(name).filter((a) => !isRestricted(r, a.address) && !isRetired(r, a.address));
    if (seen.length === 1)
        return seen[0].address;
    if (seen.length > 1)
        throw new HttpError(409, `${name} is ambiguous: give the full address`, { candidates: seen.filter(visible).map((a) => a.address) });
    throw new HttpError(404, `no agent named ${name} is known: give the full address agent@MACHINE`, { known: store.agents().filter((a) => !isRetired(r, a.address)).filter(visible).map((a) => a.address) });
}
function recipientInfo(r, address) {
    const a = store.agent(address);
    if (a || !isArchived(r, address))
        return store.agentView(a);
    return { listening: false, state: 'archived', archived: true, last_seen: null };
}
function archivedNote(r, address) {
    if (!isArchived(r, address) && store.restartPending(address))
        return { recipientRestoredWaiting: true, note: `${address} was restored from the archive but has not started again. Your message is accepted and held; it is delivered when the agent starts again.` };
    return isArchived(r, address)
        ? { recipientArchived: true, note: `${address} is archived. Your message is accepted and held; it is not delivered until the agent is restored (taken off the archived list), then it arrives on its next poll.` }
        : {};
}
async function handleSend(caller, body, r) {
    const now = Date.now();
    const L = r.limits;
    const ignored = [];
    if ('from' in body || 'sender' in body) {
        ignored.push('from');
        log(`IGNORED-FROM ${caller.address} body claimed from=${JSON.stringify(String(body.from ?? body.sender)).slice(0, 80)}`);
    }
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim())
        throw new HttpError(400, 'text is required');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > L.maxTextBytes)
        throw new HttpError(413, `message is ${bytes} bytes, the cap is ${L.maxTextBytes}`);
    const key = body.key == null ? null : String(body.key);
    if (key !== null && !KEY_RE.test(key))
        throw new HttpError(400, 'key must be 8 to 128 characters of letters, digits, . _ : -');
    if (key) {
        const prior = store.byKey(caller.address, key);
        if (prior) {
            const sameTarget = !body.to || resolveRecipient(r, body.to, caller.address) === prior.recipient;
            if (prior.text !== text || !sameTarget)
                throw new HttpError(409, 'this key was already used for a different message');
            store.event(prior.id, 'duplicate_send', 'same key, not stored again');
            return { status: 200, out: { ...store.view(prior), duplicate: true, recipient: recipientInfo(r, prior.recipient), ...archivedNote(r, prior.recipient), ignored } };
        }
    }
    let parent = null;
    let recipient;
    if (body.reply_to != null) {
        const pid = String(body.reply_to);
        if (!ULID_RE.test(pid))
            throw new HttpError(400, 'reply_to must be a message id');
        parent = store.get(pid);
        if (!parent)
            throw new HttpError(404, `no message ${pid}`);
        if (parent.recipient !== caller.address)
            throw new HttpError(403, `${pid} was not sent to ${caller.address}, so it cannot reply to it`);
        recipient = body.to ? resolveRecipient(r, body.to, caller.address) : parent.sender;
        if (recipient !== parent.sender)
            throw new HttpError(400, `a reply to ${pid} goes to ${parent.sender}`);
        if (store.repliesBy(pid, caller.address) >= L.repliesPerMessage)
            throw new HttpError(422, `reply storm: already ${L.repliesPerMessage} replies to ${pid}; send it as a new message to ${parent.sender}`);
        if (parent.depth + 1 > L.maxThreadDepth)
            throw new HttpError(422, `reply storm: the thread is ${parent.depth + 1} messages deep, the cap is ${L.maxThreadDepth}`);
    }
    else {
        recipient = resolveRecipient(r, body.to, caller.address);
    }
    if (recipient === caller.address)
        throw new HttpError(400, 'an agent cannot message itself');
    if (isRetired(r, recipient))
        throw new HttpError(410, `${recipient} is retired and takes no messages`);
    const refusal = mayTalk(r, caller.address, recipient);
    if (refusal) {
        log(`REFUSED-ROSTER ${caller.address} to ${recipient}`);
        throw new HttpError(403, 'the roster refuses this: ' + refusal);
    }
    const sKey = 's:' + caller.address;
    const mKey = 'm:' + caller.machine;
    const hKey = 'h:' + caller.address;
    const mhKey = 'mh:' + caller.machine;
    if (wouldExceed(sKey, L.perSenderPerMinute, 60000, now) || wouldExceed(hKey, L.perSenderPerHour, 3600000, now) || wouldExceed(mKey, L.perMachinePerMinute, 60000, now) || wouldExceed(mhKey, L.perMachinePerHour, 3600000, now)) {
        log(`REFUSED-RATE ${caller.address}`);
        throw new HttpError(429, `rate cap: at most ${L.perSenderPerMinute} a minute and ${L.perSenderPerHour} an hour per agent, ${L.perMachinePerMinute} a minute and ${L.perMachinePerHour} an hour per machine`);
    }
    const pending = store.pendingCount(recipient);
    if (pending >= L.maxPendingPerRecipient) {
        log(`REFUSED-FULL ${caller.address} to ${recipient} pending=${pending}`);
        throw new HttpError(429, `${recipient} already has ${pending} messages waiting, the cap is ${L.maxPendingPerRecipient}`);
    }
    overLimit(sKey, Infinity, 60000, now);
    overLimit(hKey, Infinity, 3600000, now);
    overLimit(mKey, Infinity, 60000, now);
    overLimit(mhKey, Infinity, 3600000, now);
    const expectReply = body.expect_reply == null ? !parent : !!body.expect_reply;
    const timeoutS = Math.min(Math.max(Number(body.reply_timeout_s) || L.replyTimeoutSeconds, 10), L.maxReplyTimeoutSeconds);
    if (isArchived(r, recipient))
        store.markArchived(recipient);
    const m = store.insert({ sender: caller.address, recipient, text, bytes, replyTo: parent?.id, parent, idemKey: key, expectReply, replyTimeoutMs: timeoutS * 1000 });
    wake(recipient);
    openIfAsleep(recipient);
    if (expectReply || parent)
        armDeadline();
    return { status: 201, out: { ...store.view(m), recipient: { ...recipientInfo(r, recipient), already_waiting: pending }, ...archivedNote(r, recipient), ignored } };
}
function idsOf(body) {
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : body.id ? [String(body.id)] : [];
    if (!ids.length || ids.length > 200 || !ids.every((i) => ULID_RE.test(i)))
        throw new HttpError(400, 'ids must be 1 to 200 message ids');
    return ids;
}
function consumerOf(v) {
    const c = String(v || '');
    if (!/^[A-Za-z0-9._:-]{6,80}$/.test(c))
        throw new HttpError(400, 'consumer (the session instance id) is required');
    return c;
}
function archiveRoster(address, archived) {
    let doc;
    try {
        doc = JSON.parse(readFileSync(ROSTER_FILE, 'utf8'));
    }
    catch (e) {
        throw new HttpError(500, 'roster.json cannot be read, nothing changed: ' + e.message);
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc))
        throw new HttpError(500, 'roster.json is not an object, nothing changed');
    const list = Array.isArray(doc.archived) ? doc.archived.map(String) : [];
    const same = (p) => p.toLowerCase() === address.toLowerCase();
    const next = archived ? (list.some(same) ? list : [...list, address]) : list.filter((p) => !same(p));
    if (!archived && next.some((p) => glob(p, address)))
        throw new HttpError(409, `${address} is also matched by a pattern in the archived list (${next.filter((p) => glob(p, address)).join(', ')}); edit roster.json to restore it`);
    if (JSON.stringify(next) !== JSON.stringify(list) || !Array.isArray(doc.archived)) {
        const bak = ROSTER_FILE + '.bak-archive';
        if (!existsSync(bak))
            copyFileSync(ROSTER_FILE, bak);
        doc.archived = next;
        const tmp = ROSTER_FILE + '.tmp-' + process.pid;
        writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
        renameSync(tmp, ROSTER_FILE);
        log(`ARCHIVE ${archived ? 'on' : 'off'} ${address}`);
    }
    const r = roster();
    archiveSweep(r);
    return { ok: true, agent: address, archived: isArchived(r, address), archivedList: r.archived };
}
async function route(req, res) {
    const url = new URL(req.url || '/', 'http://mail');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
        return send(res, 200, { ok: true, service: 'havok-mail', version: VERSION, uptime_s: Math.round(process.uptime()) });
    }
    if (req.method === 'GET' && path === '/outages')
        return send(res, 200, { outages: outages.list().slice(0, 200), strays: outages.strays().slice(-100) });
    if (req.method === 'GET' && path === '/outages/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(outagesPage());
    }
    const who = auth.whoIs(req.headers.authorization);
    if (!who) {
        log(`REFUSED-TOKEN ${req.method} ${path}`);
        return send(res, 401, { error: 'unknown or missing token' });
    }
    const r = roster();
    retireSweep(r);
    archiveSweep(r);
    if (!r.machines.includes(who.machine)) {
        log(`REFUSED-MACHINE ${who.machine} ${path}`);
        return send(res, 403, { error: `machine ${who.machine} is not on the messages roster` });
    }
    if (overLimit('r:' + who.machine, r.limits.requestsPerMachinePerMinute, 60000))
        return send(res, 429, { error: 'too many requests from this machine' });
    const agentName = String(req.headers['x-agent'] || url.searchParams.get('agent') || '').toLowerCase();
    if (!AGENT_RE.test(agentName))
        return send(res, 400, { error: 'x-agent header (the agent name, lowercase letters, digits, . _ -) is required' });
    const caller = { machine: who.machine, kind: who.kind, address: `${agentName}@${who.machine}` };
    let body = {};
    if (req.method === 'POST') {
        const raw = await readBody(req);
        try {
            body = raw ? JSON.parse(raw) : {};
        }
        catch {
            throw new HttpError(400, 'body is not JSON');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body))
            throw new HttpError(400, 'body must be a JSON object');
    }
    if (req.method === 'POST' && path === '/outage/report') {
        const kind = String(body.kind || 'recall');
        if (!KINDS.has(kind))
            throw new HttpError(400, 'kind must be recall');
        if (body.state !== 'down' && body.state !== 'up')
            throw new HttpError(400, 'state must be down or up');
        const cfg = r.outages || {};
        const h = body.state === 'down' ? await probeHealth(cfg.healthUrl || '') : { healthy: null, ms: null };
        const out = outages.report(kind, { state: body.state, at: Number(body.at), error: body.error, by: caller.address, machine: caller.machine, serverHealthy: h.healthy, serverMs: h.ms });
        let alert = null;
        if (out.opened) {
            const to = cfg.alertsTo || String(body.to || '');
            if (to)
                lastAlertTo = to;
            const id = systemMessage(to, alertText(out.outage, cfg.page || `http://127.0.0.1:${PORT}/outages/page`));
            alert = { to, message: id };
            outages.noteAlert(out.outage.id, alert);
            log(`OUTAGE-OPENED ${out.outage.id} by ${caller.address} alert=${id || 'not sent'}`);
        }
        else
            log(`OUTAGE-REPORT ${out.outage ? out.outage.id : 'stray'} ${body.state} by ${caller.address}`);
        armOutages();
        return send(res, 200, { outage: out.outage ? out.outage.id : null, opened: out.opened, alerted: !!alert?.message });
    }
    if (req.method === 'POST' && path === '/send') {
        const { status, out } = await handleSend(caller, body, r);
        return send(res, status, out);
    }
    if (req.method === 'GET' && path === '/inbox') {
        const consumer = consumerOf(url.searchParams.get('consumer'));
        const max = Math.min(Math.max(Number(url.searchParams.get('max')) || 20, 1), 50);
        const wait = Math.min(Math.max(Math.floor(Number(url.searchParams.get('wait')) || 0), 0), MAX_WAIT_S);
        const since = Math.max(0, Math.floor(Number(url.searchParams.get('since')) || 0));
        const take = () => store.lease(caller.address, consumer, max).filter((m) => m.seq > since);
        store.seen(caller.address, caller.machine, { consumer });
        let msgs = take();
        if (!msgs.length && wait > 0) {
            await waitForMail(caller.address, wait, res);
            if (res.destroyed || res.writableEnded)
                return;
            roster();
            store.seen(caller.address, caller.machine, { consumer });
            msgs = take();
        }
        return send(res, 200, {
            me: caller.address,
            ...(wait > 0 ? { wait_s: wait } : {}),
            ...(since ? { since } : {}),
            now: new Date().toISOString(),
            waiting: store.pendingCount(caller.address),
            receipts: { delivered_unseen: store.unseenCount(caller.address) },
            messages: msgs.map((m) => ({ ...store.view(m, { withText: true }), from_listening: store.agentView(store.agent(m.sender)).listening })),
        });
    }
    if (req.method === 'POST' && path === '/ack') {
        const out = store.ack(caller.address, consumerOf(body.consumer), idsOf(body));
        return send(res, 200, out);
    }
    if (req.method === 'POST' && path === '/held') {
        const reason = String(body.reason || 'held').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, 200);
        const held = store.hold(caller.address, consumerOf(body.consumer), idsOf(body), reason);
        if (body.tell_sender !== false)
            for (const id of held)
                tellSender(store.get(id), 'held', reason);
        return send(res, 200, { held });
    }
    if (req.method === 'POST' && path === '/failed') {
        const reason = String(body.reason || 'delivery failed').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 200);
        const out = store.failDelivery(caller.address, consumerOf(body.consumer), idsOf(body), reason);
        for (const id of out.failed)
            tellSender(store.get(id), 'failed', reason);
        return send(res, 200, out);
    }
    if (req.method === 'POST' && path === '/setaside') {
        const reason = String(body.reason || 'set aside by the recipient').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 200);
        return send(res, 200, store.setAside(caller.address, consumerOf(body.consumer), idsOf(body), reason));
    }
    if (req.method === 'POST' && path === '/release') {
        const consumer = consumerOf(body.consumer);
        const previous = Array.isArray(body.previous) ? body.previous.map(String).slice(0, 20) : [];
        const released = store.release(caller.address, consumer, previous);
        if (released.length)
            wake(caller.address);
        return send(res, 200, { released });
    }
    if (req.method === 'POST' && path === '/heartbeat') {
        const consumer = consumerOf(body.consumer);
        const state = body.state === 'stopped' ? 'stopped' : body.state === 'busy' ? 'busy' : 'listening';
        store.seen(caller.address, caller.machine, { consumer, state, version: String(body.version || '').slice(0, 40) || null });
        if (state !== 'stopped')
            store.renew(caller.address, consumer);
        return send(res, 200, { me: caller.address, waiting: store.pendingCount(caller.address), receipts: { delivered_unseen: store.unseenCount(caller.address) }, now: new Date().toISOString() });
    }
    if (req.method === 'GET' && (path.startsWith('/status/') || path === '/status')) {
        const id = path.startsWith('/status/') ? decodeURIComponent(path.slice(8)) : null;
        let m = null;
        if (id) {
            if (!ULID_RE.test(id))
                throw new HttpError(400, 'not a message id');
            m = store.get(id);
        }
        else if (url.searchParams.get('key'))
            m = store.byKey(caller.address, url.searchParams.get('key'));
        else
            throw new HttpError(400, 'give /status/<id> or /status?key=<idempotency key>');
        if (!m || (m.sender !== caller.address && m.recipient !== caller.address))
            return send(res, 404, { error: 'no such message for ' + caller.address });
        store.markSeen(caller.address, [m.id]);
        return send(res, 200, { ...store.view(m, { withText: true, withHistory: true }), recipient: store.agentView(store.agent(m.recipient)) });
    }
    if (req.method === 'GET' && path === '/sent') {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);
        const open = url.searchParams.get('open') === '1';
        const sentRows = store.sentBy(caller.address, open ? 200 : limit);
        const rows = sentRows.map((m) => store.view(m));
        const list = open ? rows.filter((m) => m.state !== 'done').slice(0, limit) : rows;
        const shown = new Set(list.map((m) => m.id));
        store.markSeen(caller.address, sentRows.filter((m) => shown.has(m.id)).map((m) => m.id));
        return send(res, 200, { me: caller.address, messages: list });
    }
    if (req.method === 'POST' && path === '/roster/archive') {
        if (typeof body.archived !== 'boolean')
            throw new HttpError(400, 'archived must be true or false');
        const name = String(body.agent || '').trim();
        const [agent, machine, ...rest] = name.includes('@') ? name.split('@') : [name, caller.machine];
        if (rest.length || !AGENT_RE.test(String(agent).toLowerCase()))
            throw new HttpError(400, 'agent must be an agent name or agent@MACHINE');
        if (String(machine).toLowerCase() !== caller.machine.toLowerCase()) {
            log(`REFUSED-ARCHIVE ${caller.address} for ${name}`);
            throw new HttpError(403, `a machine may archive only its own agents: ${caller.machine} cannot archive ${agent}@${machine}`);
        }
        const address = `${String(agent).toLowerCase()}@${caller.machine}`;
        if (address === caller.address && body.archived)
            throw new HttpError(400, 'an agent cannot archive itself');
        const out = archiveRoster(address, body.archived);
        wake(address);
        return send(res, 200, out);
    }
    if (req.method === 'GET' && path === '/agents') {
        const now = Date.now();
        let agents = store.agents().filter((a) => !isRetired(r, a.address)).map((a) => ({ address: a.address, machine: a.machine, ...store.agentView(a, now), waiting: store.pendingCount(a.address), may_message: a.address !== caller.address && !mayTalk(r, caller.address, a.address) }));
        for (const ad of r.archived)
            if (!ad.includes('*') && ad.includes('@') && !agents.some((a) => a.address.toLowerCase() === ad.toLowerCase()) && !isRetired(r, ad)) {
                agents.push({ address: ad, machine: ad.split('@')[1], listening: false, state: 'archived', archived: true, last_seen: null, waiting: store.pendingCount(ad), may_message: ad !== caller.address && !mayTalk(r, caller.address, ad) });
            }
        if (isRestricted(r, caller.address))
            agents = agents.filter((a) => a.may_message || a.address === caller.address);
        return send(res, 200, { me: caller.address, aliases: r.aliases, agents });
    }
    return send(res, 404, { error: 'no such route' });
}
const server = createServer((req, res) => {
    route(req, res).catch((e) => {
        const status = e.status || 500;
        if (status >= 500)
            log(`ERROR ${req.method} ${req.url} ${e.stack || e.message}`);
        if (!res.headersSent)
            send(res, status, { error: e.message, ...(e.extra || {}) });
    });
});
server.on('error', (e) => { log('cannot listen, exiting so the runner can retry: ' + e.message); process.exit(1); });
function rosterChanged() {
    try {
        const r = roster();
        archiveSweep(r);
        retireSweep(r, true);
    }
    catch (e) {
        log('roster reconcile failed: ' + e.message);
    }
}
let rosterFold = null;
try {
    watch(dirname(ROSTER_FILE), (_ev, name) => {
        if (String(name || '').toLowerCase() !== basename(ROSTER_FILE).toLowerCase())
            return;
        clearTimeout(rosterFold);
        rosterFold = setTimeout(rosterChanged, 300);
    });
}
catch (e) {
    log('cannot watch the roster file, a change is applied at the next request: ' + e.message);
}
rosterChanged();
let deadlineTimer = null;
function armDeadline() {
    clearTimeout(deadlineTimer);
    deadlineTimer = null;
    let at = null;
    try {
        at = store.nextDeadline();
    }
    catch (e) {
        log('deadline read failed: ' + e.message);
        return;
    }
    if (at === null)
        return;
    const wait = Math.min(Math.max(0, at - Date.now()) + 50, 2000000000);
    deadlineTimer = setTimeout(() => {
        try {
            const n = store.sweepTimeouts();
            if (n)
                log(`TIMEOUT ${n} message(s) passed their reply deadline`);
        }
        catch (e) {
            log('timeout mark failed: ' + e.message);
        }
        armDeadline();
    }, wait);
    deadlineTimer.unref();
}
armDeadline();
server.listen(PORT, HOST, () => log(`havok-mail (agent messages service) ${VERSION} listening on http://${HOST}:${PORT} data=${DATA_DIR} roster=${ROSTER_FILE}`));
