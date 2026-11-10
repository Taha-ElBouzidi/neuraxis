import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { accept, review, list, get, facets, waitingCount, search, MAX_BODY_CHARS } from './decision-store.mjs';
export const DEFAULT_REVIEW_PORT = 8502;
export const SYSTEM_AGENT = 'system';
export const REVIEW_KEY_FILE = 'havok-decision-review-key';
export const IDENTITIES = ['local', 'tailscale'];
let INSTANCE_MESSAGES_URL = '';
const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
async function readBody(req, max) {
    let t = '';
    for await (const chunk of req) {
        t += chunk;
        if (t.length > max) {
            req.destroy();
            return null;
        }
    }
    return t;
}
function brainConfig(brain) {
    if (!brain)
        return {};
    try {
        return JSON.parse(readFileSync(join(brain, 'brain.json'), 'utf8')) || {};
    }
    catch {
        return {};
    }
}
export function reviewPort(brain) {
    const env = process.env.HAVOK_DECISIONS_PORT;
    if (env != null && env !== '')
        return Number(env);
    const raw = brainConfig(brain).decisionReviewPort;
    const p = Number(raw);
    return raw != null && raw !== '' && Number.isInteger(p) && p >= 0 ? p : DEFAULT_REVIEW_PORT;
}
export function messagesUrlOf(brain) {
    const env = process.env.HAVOK_MESSAGES_URL;
    if (env != null)
        return String(env).trim();
    const c = brainConfig(brain);
    if (typeof c.messagesUrl === 'string')
        return c.messagesUrl.trim();
    return INSTANCE_MESSAGES_URL;
}
export function reviewIdentity(brain) {
    const c = brainConfig(brain);
    if (IDENTITIES.includes(c.decisionReviewIdentity))
        return c.decisionReviewIdentity;
    return Array.isArray(c.decisionReviewers) && c.decisionReviewers.length ? 'tailscale' : 'local';
}
export const configDir = () => process.env.HAVOK_HOME || resolve(homedir(), '.claude');
export const reviewKeyFile = (dir = configDir()) => join(dir, REVIEW_KEY_FILE);
export function readReviewKey(file = reviewKeyFile()) {
    try {
        const k = readFileSync(file, 'utf8').trim();
        return k.length >= 32 ? k : '';
    }
    catch {
        return '';
    }
}
export function ensureReviewKey(file = reviewKeyFile()) {
    const had = readReviewKey(file);
    if (had)
        return had;
    const k = randomBytes(32).toString('base64url');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, k + '\n', { encoding: 'utf8', mode: 0o600 });
    return k;
}
const digest = (t) => createHash('sha256').update(String(t)).digest();
const sameKey = (given, real) => !!given && !!real && timingSafeEqual(digest(given), digest(real));
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function hostIsLocal(req) {
    try {
        return LOCAL_HOSTS.has(new URL('http://' + String(req.headers.host || '')).hostname.toLowerCase());
    }
    catch {
        return false;
    }
}
const ownerName = (cfg) => String(cfg.owner || '').trim().slice(0, 64) || 'the person';
const filtersOf = (q) => ({ agent: q.get('agent') || '', area: q.get('area') || '', state: q.get('state') || '', since: q.get('since') || '', limit: q.get('limit') || '' });
export async function handleDecisionRoute(req, res, { brain, path, url, caller, audit = () => { }, getToken = null }) {
    const rm = /^\/decisions\/([A-Za-z0-9_-]{1,64})\/review$/.exec(path);
    if (rm && req.method === 'POST') {
        const body = await readBody(req, 20000);
        if (body == null)
            return true;
        let p;
        try {
            p = JSON.parse(body || '{}');
        }
        catch {
            send(res, 400, { error: 'bad json' });
            return true;
        }
        const agent = String(p.agent || '').trim().toLowerCase();
        const machine = caller && caller.name !== 'unnamed' ? String(caller.name) : '';
        const address = agent && machine ? agent + '@' + machine : '';
        const allowedList = brainConfig(brain).decisionReviewerAgents;
        const allowed = (Array.isArray(allowedList) ? allowedList : []).map((a) => String(a).toLowerCase());
        if (!address || !allowed.includes(address.toLowerCase())) {
            audit('DECISION-REVIEW-REFUSED ' + rm[1] + ' agent=' + (address || '(none)').slice(0, 80));
            send(res, 403, { error: (address || 'an unnamed agent') + ' may not review decisions (brain.json decisionReviewerAgents)' });
            return true;
        }
        const d = get(brain, rm[1]);
        if (!d) {
            send(res, 404, { error: 'no decision with id ' + rm[1] });
            return true;
        }
        if (String(d.agent || '').toLowerCase() === address.toLowerCase() || String(d.agent || '').toLowerCase() === agent) {
            audit('DECISION-REVIEW-REFUSED ' + rm[1] + ' own decision of ' + address);
            send(res, 403, { error: 'an agent does not review its own decision: that one is the person\'s' });
            return true;
        }
        const r = review(brain, rm[1], p.state, p.note, agent, 'agent');
        audit('DECISION-REVIEW ' + rm[1] + ' ' + String(p.state).slice(0, 10) + ' by=' + address + ' status=' + r.status);
        if (r.status === 200 && p.state === 'reversed')
            await tellReversal({ brain, id: rm[1], body: r.body, getToken, audit });
        send(res, r.status, r.body);
        return true;
    }
    if (path === '/decisions' && req.method === 'POST') {
        const body = await readBody(req, MAX_BODY_CHARS);
        if (body == null)
            return true;
        let p;
        try {
            p = JSON.parse(body || '{}');
        }
        catch {
            send(res, 400, { error: 'bad json' });
            return true;
        }
        const r = acceptRows(brain, p, caller);
        audit('DECISIONS ' + (caller && caller.name) + ' taken=' + (r.body.accepted || []).length + ' added=' + (r.body.added || 0) + ' refused=' + (r.body.refused || []).length);
        send(res, r.status, r.body);
        return true;
    }
    if (path === '/decisions/count' && req.method === 'GET') {
        send(res, 200, { waiting: waitingCount(brain) });
        return true;
    }
    if (path === '/decisions' && req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').slice(0, 2000);
        const decisions = q ? search(brain, q, { limit: url.searchParams.get('limit') || 10 }) : list(brain, filtersOf(url.searchParams));
        send(res, 200, { decisions, waiting: waitingCount(brain) });
        return true;
    }
    return false;
}
export function acceptRows(brain, payload, caller) {
    return accept(brain, payload, { machine: caller && caller.name !== 'unnamed' ? caller.name : '' });
}
async function tellReversal({ brain, id, body, getToken, audit, messagesUrl }) {
    let token = '';
    try {
        token = getToken ? String(await getToken() || '') : '';
    }
    catch { }
    const n = await notifyReversal({ brain, decision: get(brain, id), reviewRow: body.review, token, messagesUrl });
    audit('DECISION-REVERSAL-MESSAGE ' + id + (n.sent ? ' sent ' + n.id : ' NOT SENT: ' + n.why));
    if (!n.off)
        body.message = { sent: n.sent, ...(n.sent ? { id: n.id } : { why: n.why }) };
}
function reversalText(cfg, d, note) {
    const owner = String(cfg.owner || 'The person');
    const pron = cfg.pronoun === 'she' ? 'Her' : cfg.pronoun === 'he' ? 'His' : 'Their';
    const what = String(d.what).replace(/[.\s]+$/, '');
    return owner + ' reversed your decision ' + d.id + ' (' + d.area + '): ' + what + '. ' + pron + ' note: ' + (note || '(none)') + '.';
}
export function notifyReversal({ brain, decision, reviewRow, token, messagesUrl = messagesUrlOf(brain), timeoutMs = 5000 }) {
    if (!messagesUrl)
        return Promise.resolve({ sent: false, off: true, why: 'no messages service configured (brain.json messagesUrl)' });
    const agent = String(decision.agent || '').toLowerCase();
    const machine = String(decision.machine || '');
    if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(agent) || !/^[A-Za-z0-9._-]{1,64}$/.test(machine)) {
        return Promise.resolve({ sent: false, why: 'the decision names no agent address' });
    }
    if (!token)
        return Promise.resolve({ sent: false, why: 'no token' });
    return sendSystemMessage({ token, messagesUrl, timeoutMs, to: agent + '@' + machine, text: reversalText(brainConfig(brain), decision, reviewRow.note), key: 'decision-reversed-' + reviewRow.id });
}
export function sendSystemMessage({ token, messagesUrl = messagesUrlOf(null), to, text, key, timeoutMs = 5000 }) {
    if (!messagesUrl)
        return Promise.resolve({ sent: false, off: true, why: 'no messages service configured' });
    if (!token)
        return Promise.resolve({ sent: false, why: 'no token' });
    const body = JSON.stringify({ to, text, key, expect_reply: false });
    let target;
    try {
        target = new URL('/send', messagesUrl);
    }
    catch {
        return Promise.resolve({ sent: false, why: 'bad messages url' });
    }
    return new Promise((done) => {
        const rq = httpRequest(target, {
            method: 'POST', agent: false,
            headers: { authorization: 'Bearer ' + token, 'x-agent': SYSTEM_AGENT, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' },
        }, (r) => {
            let t = '';
            r.setEncoding('utf8');
            r.on('data', (d) => { t += d; });
            r.on('end', () => {
                let o = {};
                try {
                    o = JSON.parse(t);
                }
                catch { }
                done(r.statusCode >= 200 && r.statusCode < 300 ? { sent: true, id: o.id || '' } : { sent: false, why: 'messages service answered ' + r.statusCode + (o.error ? ': ' + String(o.error).slice(0, 160) : '') });
            });
        });
        rq.on('error', (e) => done({ sent: false, why: 'messages service unreachable: ' + String(e.code || e.message).slice(0, 80) }));
        rq.setTimeout(timeoutMs, () => rq.destroy(new Error('timeout')));
        rq.end(body);
    });
}
function pageCaller(req, brain, keyFile) {
    const cfg = brainConfig(brain);
    const mode = reviewIdentity(brain);
    if (mode === 'tailscale') {
        const login = String(req.headers['tailscale-user-login'] || '');
        const reviewers = cfg.decisionReviewers;
        return { mode, viewer: login, mayReview: !!login && Array.isArray(reviewers) && reviewers.includes(login), byWho: login,
            why: login ? 'this tailnet login may not review decisions' : 'no tailnet login: open the page through the tailnet address' };
    }
    if (!hostIsLocal(req))
        return { mode, refuse: [403, 'open the page as http://127.0.0.1 on this machine'] };
    if (!sameKey(String(req.headers['x-review-key'] || ''), readReviewKey(keyFile))) {
        return { mode, refuse: [401, 'no review key: open the link printed by node tools/decision-review.mjs link (in your own terminal)'] };
    }
    const owner = ownerName(cfg);
    return { mode, viewer: owner, mayReview: true, byWho: owner };
}
export function startReviewListener({ brain, port, getToken, messagesUrl, keyFile = reviewKeyFile(), audit = () => { }, log = () => { } }) {
    const pageFile = join(brain, 'tools', 'decisions-page.html');
    if (reviewIdentity(brain) === 'local') {
        try {
            ensureReviewKey(keyFile);
        }
        catch (e) {
            log('decision review key not written: ' + String(e && e.message).slice(0, 80));
        }
    }
    const handler = async (req, res) => {
        req.setEncoding('utf8');
        const url = new URL(req.url, 'http://x');
        let path = url.pathname;
        if (path === '/decisions' || path.startsWith('/decisions/'))
            path = path.slice('/decisions'.length) || '/';
        if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
            let html;
            try {
                html = readFileSync(pageFile, 'utf8');
            }
            catch {
                return send(res, 500, 'the page file is missing', 'text/plain');
            }
            return send(res, 200, html, 'text/html');
        }
        const who = pageCaller(req, brain, keyFile);
        if (req.method === 'GET' && path === '/api/decisions') {
            if (who.refuse)
                return send(res, who.refuse[0], { error: who.refuse[1], identity: who.mode });
            return send(res, 200, {
                decisions: list(brain, filtersOf(url.searchParams)), waiting: waitingCount(brain), ...facets(brain),
                identity: who.mode, viewer: who.viewer, mayReview: who.mayReview, ...(who.mayReview ? {} : { hint: who.why }),
            });
        }
        const m = /^\/api\/decisions\/([A-Za-z0-9_-]{1,64})\/review$/.exec(path);
        if (m && req.method === 'POST') {
            if (who.refuse || !who.mayReview) {
                audit('DECISION-REVIEW-REFUSED ' + m[1] + ' mode=' + who.mode + ' ' + (who.viewer ? 'login=' + who.viewer.slice(0, 80) : '(no identity)'));
                return send(res, who.refuse ? who.refuse[0] : 403, { error: who.refuse ? who.refuse[1] : who.why });
            }
            if (!/^application\/json\b/i.test(String(req.headers['content-type'] || '')))
                return send(res, 415, { error: 'send JSON' });
            if (String(req.headers['sec-fetch-site'] || '') === 'cross-site')
                return send(res, 403, { error: 'cross-site request refused' });
            const body = await readBody(req, 20000);
            if (body == null)
                return;
            let p;
            try {
                p = JSON.parse(body || '{}');
            }
            catch {
                return send(res, 400, { error: 'bad json' });
            }
            const r = review(brain, m[1], p.state, p.note, who.byWho, 'page');
            audit('DECISION-REVIEW ' + m[1] + ' ' + String(p.state).slice(0, 10) + ' by=' + String(who.byWho).slice(0, 80) + ' mode=' + who.mode + ' status=' + r.status);
            if (r.status !== 200)
                return send(res, r.status, r.body);
            if (p.state === 'reversed')
                await tellReversal({ brain, id: m[1], body: r.body, getToken, audit, messagesUrl });
            return send(res, 200, r.body);
        }
        return send(res, 404, { error: 'no such route' });
    };
    const srv = createServer((req, res) => handler(req, res).catch((e) => {
        audit('DECISION-PAGE-ERROR ' + String(e && e.message).slice(0, 120));
        try {
            if (!res.headersSent)
                send(res, 500, { error: 'request failed' });
            else
                res.end();
        }
        catch { }
    }));
    srv.on('error', (e) => log('decision review page not served on 127.0.0.1:' + port + ': ' + String(e && (e.code || e.message)).slice(0, 80)));
    srv.listen(port, '127.0.0.1', () => log('decision review page on http://127.0.0.1:' + port + '/ (' + reviewIdentity(brain) + ' identity'
        + (reviewIdentity(brain) === 'local' ? '; to review, open the link from: node tools/decision-review.mjs link' : '') + ')'));
    return srv;
}
const BRAIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const NL = String.fromCharCode(10);
    const cmd = process.argv[2];
    if (cmd !== 'link') {
        process.stderr.write('usage: node tools/decision-review.mjs link' + NL);
        process.exit(2);
    }
    if (process.env.CLAUDECODE || process.env.HAVOK_MOD_AGENT) {
        process.stderr.write('refused: this prints the key that lets its holder review decisions. Run it in your own terminal, not through an agent.' + NL);
        process.exit(3);
    }
    const brain = process.env.HAVOK_BRAIN || BRAIN_DIR;
    if (reviewIdentity(brain) !== 'local') {
        process.stdout.write('this install reviews through ' + reviewIdentity(brain) + ' identity (brain.json decisionReviewIdentity); no link is needed.' + NL);
        process.exit(0);
    }
    const port = reviewPort(brain);
    if (!(port > 0)) {
        process.stderr.write('the review page is off (decisionReviewPort 0).' + NL);
        process.exit(1);
    }
    const key = ensureReviewKey();
    process.stdout.write('http://127.0.0.1:' + port + '/#key=' + key + NL);
}
