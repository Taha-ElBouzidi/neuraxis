// The decision log inside the brain server (tools/decision-store.mjs holds the rows). Part of the engine since 0.4.90:
// every name, port and address below comes from the instance's brain.json, with the defaults given here.
//
// CONFIG (brain.json, all optional; read on every call, so a change needs no restart):
//   owner                    the owner's name, used in the reversal message and as the reviewer on the local page.
//                            Default: "the owner".
//   pronoun                  he | she; anything else is "their". Default: their.
//   decisionReviewPort       the review page listener, 127.0.0.1 only. Default 8502; HAVOK_DECISIONS_PORT overrides;
//                            0 turns the page off.
//   decisionReviewIdentity   how the page knows the owner: "local" or "tailscale". Default: "tailscale" when
//                            decisionReviewers lists at least one login (installs set up before 0.4.90), else "local".
//   decisionReviewers        tailnet logins allowed to review in "tailscale" mode. Default []: nobody.
//   decisionReviewerAgents   agent@MACHINE addresses that may review OTHER agents' decisions with their brain token.
//                            Default []: no agent reviews anything.
//   messagesUrl              the agent messages service a reversal is told through. Default: none, so no message is
//                            sent and the reversal is seen on the page and in the recall answer (its state and note).
//                            HAVOK_MESSAGES_URL overrides; an empty string turns it off.
//
// WHO CAN CALL WHAT ON A STOCK INSTALL (no brain.json keys set; the brain server on 127.0.0.1, the page on 8502).
// The owner and the agents run as the same OS user, so nothing on disk is out of an agent's reach; the boundary is
// that a review needs a secret that no agent tool ever sends, and the rules forbid an agent to fetch it.
//
// 1. Routes on the bearer-token server (any valid brain token, so the owner AND every agent):
//      POST /decisions             one decision row or { rows: [...] }; analytics style answer (the ids taken)
//      GET  /decisions?agent=&area=&state=&since=&limit=   newest first, with the state from the last review
//      GET  /decisions?q=<words>&limit=   the search: best matches first (decision-store search)
//      GET  /decisions/count       { waiting }
//      POST /decisions/<id>/review { state, note, agent }: refused (403) unless agent@<token's machine> is in
//                                  decisionReviewerAgents, and ALWAYS refused on that agent's own decision. The list is
//                                  empty by default, so on a stock install no token can review anything. The token
//                                  names the machine, not the agent, so list only the main agent of a machine the owner
//                                  controls.
//    No token: 401 on every route. Logging and reading are what agents need; a review is not.
//
// 2. The review page, on a second listener of the same process: plain HTTP on 127.0.0.1 only, never another interface.
//      GET  /                                the page (tools/decisions-page.html), static, no data in it
//      GET  /api/decisions?agent=&area=&state=&since=&limit=
//      POST /api/decisions/<id>/review { state: kept | reversed, note }
//    A path may also start with /decisions, in case a proxy does not strip its mount path.
//    "local" mode (the default): every /api call needs the header x-review-key holding the per-install review key, a
//    random 32-byte secret in <HAVOK_HOME or ~/.claude>/havok-decision-review-key (created on first start, mode 600,
//    compared in constant time; delete it to change it, the next start or link makes a new one). The owner opens the
//    link printed by
//      node tools/decision-review.mjs link
//    (http://127.0.0.1:<port>/#key=<key>: after the # so it never reaches a server log or a Referer); the page keeps it
//    for the tab and sends it as the header. The Host header must be 127.0.0.1, localhost or [::1], so a web page that
//    points its own domain at 127.0.0.1 (DNS rebinding) is refused. The bearer token buys nothing here, so an agent
//    using its normal tools (brain-client, the mod) cannot review. The link command refuses to run inside an agent
//    session (CLAUDECODE or HAVOK_MOD_AGENT set): a guard, not a lock, since the key file is readable by the user.
//    "tailscale" mode: reading needs nothing; a review is accepted only when the header Tailscale-User-Login (added by
//    tailscale serve, which proxies https://<host>.<tailnet>.ts.net/decisions to this port) is in decisionReviewers.
//    KNOWN LIMITS of that mode: any process on this machine can open the port and send the header it likes, and every
//    device signed in with the owner's tailnet login is seen as the owner. Use it only where that is acceptable.
//    Both modes, against a page on another site posting through the owner's browser: the review call needs a JSON
//    content type (a cross-site form cannot send one without a CORS preflight, which is never answered; nor can it
//    send x-review-key) and is refused when the browser says the request is cross-site (Sec-Fetch-Site).
//    Every review, accepted or refused, is written to the server's audit log.
//
// 3. A reversal is told to the agent that decided, as an agent message from system@<server machine> through the
//    messages service, only when one is configured (messagesUrl). The messages service proves the machine part of an
//    address by the token and takes the agent name from the x-agent header, so this process sends with the server's
//    own token and x-agent: system. Off by default: the public engine has no agent messages.
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

// The messages service of this instance when brain.json and the environment say nothing. None in the engine.
let INSTANCE_MESSAGES_URL = '';

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

async function readBody(req, max) {
  let t = '';
  for await (const chunk of req) {
    t += chunk;
    if (t.length > max) { req.destroy(); return null; }
  }
  return t;
}

function brainConfig(brain) {
  if (!brain) return {};
  try { return JSON.parse(readFileSync(join(brain, 'brain.json'), 'utf8')) || {}; } catch { return {}; }
}

export function reviewPort(brain) {
  const env = process.env.HAVOK_DECISIONS_PORT;
  if (env != null && env !== '') return Number(env);
  const raw = brainConfig(brain).decisionReviewPort;
  const p = Number(raw);
  return raw != null && raw !== '' && Number.isInteger(p) && p >= 0 ? p : DEFAULT_REVIEW_PORT;
}

// '' means off. The environment wins, then brain.json messagesUrl, then the instance default.
export function messagesUrlOf(brain) {
  const env = process.env.HAVOK_MESSAGES_URL;
  if (env != null) return String(env).trim();
  const c = brainConfig(brain);
  if (typeof c.messagesUrl === 'string') return c.messagesUrl.trim();
  return INSTANCE_MESSAGES_URL;
}

export function reviewIdentity(brain) {
  const c = brainConfig(brain);
  if (IDENTITIES.includes(c.decisionReviewIdentity)) return c.decisionReviewIdentity;
  return Array.isArray(c.decisionReviewers) && c.decisionReviewers.length ? 'tailscale' : 'local';
}

// The per-install review key (local mode), beside the server's token. A server started with HAVOK_HOME (a boot task)
// and the owner's link command agree when the owner runs the command with the same HAVOK_HOME.
export const configDir = () => process.env.HAVOK_HOME || resolve(homedir(), '.claude');
export const reviewKeyFile = (dir = configDir()) => join(dir, REVIEW_KEY_FILE);
export function readReviewKey(file = reviewKeyFile()) {
  try { const k = readFileSync(file, 'utf8').trim(); return k.length >= 32 ? k : ''; } catch { return ''; }
}
export function ensureReviewKey(file = reviewKeyFile()) {
  const had = readReviewKey(file);
  if (had) return had;
  const k = randomBytes(32).toString('base64url');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, k + '\n', { encoding: 'utf8', mode: 0o600 });
  return k;
}
const digest = (t) => createHash('sha256').update(String(t)).digest();
const sameKey = (given, real) => !!given && !!real && timingSafeEqual(digest(given), digest(real));
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function hostIsLocal(req) {
  try { return LOCAL_HOSTS.has(new URL('http://' + String(req.headers.host || '')).hostname.toLowerCase()); } catch { return false; }
}
const ownerName = (cfg) => String(cfg.owner || '').trim().slice(0, 64) || 'the owner';

const filtersOf = (q) => ({ agent: q.get('agent') || '', area: q.get('area') || '', state: q.get('state') || '', since: q.get('since') || '', limit: q.get('limit') || '' });

// For the bearer server. Returns true when the path was a decisions route and an answer was sent.
export async function handleDecisionRoute(req, res, { brain, path, url, caller, audit = () => {}, getToken = null }) {
  // A REVIEW BY AN AGENT (The owner, 2026-11-09: the lead agent reviews the other agents' decisions through its brain token;
  // the owner reviews the lead agent's and any). POST /decisions/<id>/review { state, note, agent }, with a brain token.
  // Allowed when agent@<token's machine> is in brain.json decisionReviewerAgents (empty by default), and never on the
  // agent's own decision (those stay the owner's). The token names the machine, not the agent: any session on that
  // machine could name the agent, so the list holds only the main agent of a machine the owner controls. The row
  // records by: the agent, via: agent.
  const rm = /^\/decisions\/([A-Za-z0-9_-]{1,64})\/review$/.exec(path);
  if (rm && req.method === 'POST') {
    const body = await readBody(req, 20_000);
    if (body == null) return true;
    let p; try { p = JSON.parse(body || '{}'); } catch { send(res, 400, { error: 'bad json' }); return true; }
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
    if (!d) { send(res, 404, { error: 'no decision with id ' + rm[1] }); return true; }
    if (String(d.agent || '').toLowerCase() === address.toLowerCase() || String(d.agent || '').toLowerCase() === agent) {
      audit('DECISION-REVIEW-REFUSED ' + rm[1] + ' own decision of ' + address);
      send(res, 403, { error: 'an agent does not review its own decision: that one is the owner\'s' });
      return true;
    }
    const r = review(brain, rm[1], p.state, p.note, agent, 'agent');
    audit('DECISION-REVIEW ' + rm[1] + ' ' + String(p.state).slice(0, 10) + ' by=' + address + ' status=' + r.status);
    if (r.status === 200 && p.state === 'reversed') await tellReversal({ brain, id: rm[1], body: r.body, getToken, audit });
    send(res, r.status, r.body);
    return true;
  }
  if (path === '/decisions' && req.method === 'POST') {
    const body = await readBody(req, MAX_BODY_CHARS);
    if (body == null) return true;
    let p; try { p = JSON.parse(body || '{}'); } catch { send(res, 400, { error: 'bad json' }); return true; }
    const r = acceptRows(brain, p, caller);
    audit('DECISIONS ' + (caller && caller.name) + ' taken=' + (r.body.accepted || []).length + ' added=' + (r.body.added || 0) + ' refused=' + (r.body.refused || []).length);
    send(res, r.status, r.body);
    return true;
  }
  if (path === '/decisions/count' && req.method === 'GET') { send(res, 200, { waiting: waitingCount(brain) }); return true; }
  if (path === '/decisions' && req.method === 'GET') {
    // ?q= is the search (the mod's decision_search tool): the best matches first instead of the newest.
    const q = (url.searchParams.get('q') || '').slice(0, 2000);
    const decisions = q ? search(brain, q, { limit: url.searchParams.get('limit') || 10 }) : list(brain, filtersOf(url.searchParams));
    send(res, 200, { decisions, waiting: waitingCount(brain) });
    return true;
  }
  return false;
}

// Also used by the analytics route for kind 'decision'. The caller's token name stands in for a missing machine.
export function acceptRows(brain, payload, caller) {
  return accept(brain, payload, { machine: caller && caller.name !== 'unnamed' ? caller.name : '' });
}

// After a reversal: the message to the deciding agent when a messages service is configured. The answer carries
// message only then; without one the reversal is still on the page and in the recall answer, and the audit says why.
async function tellReversal({ brain, id, body, getToken, audit, messagesUrl }) {
  let token = '';
  try { token = getToken ? String(await getToken() || '') : ''; } catch { /* no token */ }
  const n = await notifyReversal({ brain, decision: get(brain, id), reviewRow: body.review, token, messagesUrl });
  audit('DECISION-REVERSAL-MESSAGE ' + id + (n.sent ? ' sent ' + n.id : ' NOT SENT: ' + n.why));
  if (!n.off) body.message = { sent: n.sent, ...(n.sent ? { id: n.id } : { why: n.why }) };
}

function reversalText(cfg, d, note) {
  const owner = String(cfg.owner || 'The owner');
  const pron = cfg.pronoun === 'she' ? 'Her' : cfg.pronoun === 'he' ? 'His' : 'Their';
  const what = String(d.what).replace(/[.\s]+$/, '');
  return owner + ' reversed your decision ' + d.id + ' (' + d.area + '): ' + what + '. ' + pron + ' note: ' + (note || '(none)') + '.';
}

// Sends the reversal message; never throws. { sent: true, id } or { sent: false, why, off? } (off: none configured).
export function notifyReversal({ brain, decision, reviewRow, token, messagesUrl = messagesUrlOf(brain), timeoutMs = 5000 }) {
  if (!messagesUrl) return Promise.resolve({ sent: false, off: true, why: 'no messages service configured (brain.json messagesUrl)' });
  const agent = String(decision.agent || '').toLowerCase();
  const machine = String(decision.machine || '');
  if (!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(agent) || !/^[A-Za-z0-9._-]{1,64}$/.test(machine)) {
    return Promise.resolve({ sent: false, why: 'the decision names no agent address' });
  }
  if (!token) return Promise.resolve({ sent: false, why: 'no token' });
  return sendSystemMessage({ token, messagesUrl, timeoutMs, to: agent + '@' + machine, text: reversalText(brainConfig(brain), decision, reviewRow.note), key: 'decision-reversed-' + reviewRow.id });
}

// One agent message from system@<this machine> through the messages service (the server's own token, x-agent system).
// Used for reversals and for the server's alerts (tools/server-alerts.mjs). Never throws: { sent: true, id } or
// { sent: false, why, off? }. With no messages service configured it sends nothing and says so (off: true).
export function sendSystemMessage({ token, messagesUrl = messagesUrlOf(null), to, text, key, timeoutMs = 5000 }) {
  if (!messagesUrl) return Promise.resolve({ sent: false, off: true, why: 'no messages service configured' });
  if (!token) return Promise.resolve({ sent: false, why: 'no token' });
  const body = JSON.stringify({ to, text, key, expect_reply: false });
  let target;
  try { target = new URL('/send', messagesUrl); } catch { return Promise.resolve({ sent: false, why: 'bad messages url' }); }
  return new Promise((done) => {
    const rq = httpRequest(target, {
      method: 'POST', agent: false,
      headers: { authorization: 'Bearer ' + token, 'x-agent': SYSTEM_AGENT, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' },
    }, (r) => {
      let t = ''; r.setEncoding('utf8');
      r.on('data', (d) => { t += d; });
      r.on('end', () => {
        let o = {}; try { o = JSON.parse(t); } catch { /* not json */ }
        done(r.statusCode >= 200 && r.statusCode < 300 ? { sent: true, id: o.id || '' } : { sent: false, why: 'messages service answered ' + r.statusCode + (o.error ? ': ' + String(o.error).slice(0, 160) : '') });
      });
    });
    rq.on('error', (e) => done({ sent: false, why: 'messages service unreachable: ' + String(e.code || e.message).slice(0, 80) }));
    rq.setTimeout(timeoutMs, () => rq.destroy(new Error('timeout')));
    rq.end(body);
  });
}

// Who is on the page, by the identity mode. { mode, viewer, mayReview, refuse? } where refuse is [status, error] for a
// caller that may not even read (local mode without the key, or a host that is not this machine).
function pageCaller(req, brain, keyFile) {
  const cfg = brainConfig(brain);
  const mode = reviewIdentity(brain);
  if (mode === 'tailscale') {
    const login = String(req.headers['tailscale-user-login'] || '');
    const reviewers = cfg.decisionReviewers;
    return { mode, viewer: login, mayReview: !!login && Array.isArray(reviewers) && reviewers.includes(login), byWho: login,
      why: login ? 'this tailnet login may not review decisions' : 'no tailnet login: open the page through the tailnet address' };
  }
  if (!hostIsLocal(req)) return { mode, refuse: [403, 'open the page as http://127.0.0.1 on this machine'] };
  if (!sameKey(String(req.headers['x-review-key'] || ''), readReviewKey(keyFile))) {
    return { mode, refuse: [401, 'no review key: open the link printed by node tools/decision-review.mjs link (in your own terminal)'] };
  }
  const owner = ownerName(cfg);
  return { mode, viewer: owner, mayReview: true, byWho: owner };
}

// The page listener. getToken() returns the token to send messages with. keyFile: the review key (local mode).
export function startReviewListener({ brain, port, getToken, messagesUrl, keyFile = reviewKeyFile(), audit = () => {}, log = () => {} }) {
  const pageFile = join(brain, 'tools', 'decisions-page.html');
  if (reviewIdentity(brain) === 'local') {
    try { ensureReviewKey(keyFile); } catch (e) { log('decision review key not written: ' + String(e && e.message).slice(0, 80)); }
  }
  const handler = async (req, res) => {
    req.setEncoding('utf8');
    const url = new URL(req.url, 'http://x');
    let path = url.pathname;
    if (path === '/decisions' || path.startsWith('/decisions/')) path = path.slice('/decisions'.length) || '/';

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      let html;
      try { html = readFileSync(pageFile, 'utf8'); } catch { return send(res, 500, 'the page file is missing', 'text/plain'); }
      return send(res, 200, html, 'text/html');
    }
    const who = pageCaller(req, brain, keyFile);
    if (req.method === 'GET' && path === '/api/decisions') {
      if (who.refuse) return send(res, who.refuse[0], { error: who.refuse[1], identity: who.mode });
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
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'send JSON' });
      if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') return send(res, 403, { error: 'cross-site request refused' });
      const body = await readBody(req, 20_000);
      if (body == null) return;
      let p; try { p = JSON.parse(body || '{}'); } catch { return send(res, 400, { error: 'bad json' }); }
      const r = review(brain, m[1], p.state, p.note, who.byWho, 'page');
      audit('DECISION-REVIEW ' + m[1] + ' ' + String(p.state).slice(0, 10) + ' by=' + String(who.byWho).slice(0, 80) + ' mode=' + who.mode + ' status=' + r.status);
      if (r.status !== 200) return send(res, r.status, r.body);
      if (p.state === 'reversed') await tellReversal({ brain, id: m[1], body: r.body, getToken, audit, messagesUrl });
      return send(res, 200, r.body);
    }
    return send(res, 404, { error: 'no such route' });
  };
  const srv = createServer((req, res) => handler(req, res).catch((e) => {
    audit('DECISION-PAGE-ERROR ' + String(e && e.message).slice(0, 120));
    try { if (!res.headersSent) send(res, 500, { error: 'request failed' }); else res.end(); } catch { /* gone */ }
  }));
  // Never takes the brain down: a port in use (another brain server already serving it) is logged and left.
  srv.on('error', (e) => log('decision review page not served on 127.0.0.1:' + port + ': ' + String(e && (e.code || e.message)).slice(0, 80)));
  srv.listen(port, '127.0.0.1', () => log('decision review page on http://127.0.0.1:' + port + '/ (' + reviewIdentity(brain) + ' identity'
    + (reviewIdentity(brain) === 'local' ? '; to review, open the link from: node tools/decision-review.mjs link' : '') + ')'));
  return srv;
}

// node tools/decision-review.mjs link   prints the owner's review link (local mode), making the key when there is none.
// Run it in your own terminal: it refuses inside an agent session, where the link would let the agent review.
const BRAIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const NL = String.fromCharCode(10);
  const cmd = process.argv[2];
  if (cmd !== 'link') { process.stderr.write('usage: node tools/decision-review.mjs link' + NL); process.exit(2); }
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
  if (!(port > 0)) { process.stderr.write('the review page is off (decisionReviewPort 0).' + NL); process.exit(1); }
  const key = ensureReviewKey();
  process.stdout.write('http://127.0.0.1:' + port + '/#key=' + key + NL);
}
