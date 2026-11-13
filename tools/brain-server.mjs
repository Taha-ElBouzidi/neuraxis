import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { homedir, networkInterfaces, hostname } from 'node:os';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { withBrainLock } from './brain-git-lock.mjs';
import { vaultAccess, mayReplace, ownEntries, memoryAccess, readList, listFor } from './vault-access.mjs';
import { makeRecall, SHORT_FOLLOW_UP } from './recall-core.mjs';
import { watchTailnet } from './tailnet-watch.mjs';
import { servedLayerFiles } from './layers-dist.mjs';
import { makeAlerts } from './server-alerts.mjs';
import { layerVersions, readLayer } from './layer-host.mjs';
import { releaseSummary, releaseManifest, releaseZip, releasePath, VERSION_RE } from './release-host.mjs';
import { makeRecallTurn, translateSync } from './recall-turn.mjs';
import { waitingCount as decisionsWaiting, search as searchDecisions, MAX_BODY_CHARS as DECISIONS_MAX_BODY } from './decision-store.mjs';
import { handleDecisionRoute, acceptRows as acceptDecisionRows, startReviewListener, reviewPort, sendSystemMessage, reviewKeyFile, messagesUrlOf } from './decision-review.mjs';
import { acceptQuota, readQuota } from './agy-quota-store.mjs';
import { record as recordProvenance } from './provenance.mjs';
import { makeGuardedEmbedder } from './embed-guard.mjs';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HAVOK_SERVER_PORT || 8478);
const LAYERS_DIR = process.env.HAVOK_LAYERS_DIR || resolve(BRAIN, '..', 'LAYERS');
const RELEASES_DIR = process.env.HAVOK_RELEASES_DIR || resolve(BRAIN, '..', 'RELEASES');
const PUBLIC = process.argv.includes('--public');
const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');
const TOKEN_FILE = resolve(CONFIG_DIR, 'havok-server-token');
const ACCESS_LOG = join(BRAIN, '.server-access.log');
const TLS_KEY = resolve(CONFIG_DIR, 'havok-server-key.pem');
const TLS_CERT = resolve(CONFIG_DIR, 'havok-server-cert.pem');
const HAVE_TLS = existsSync(TLS_KEY) && existsSync(TLS_CERT);
const ALLOW_PLAINTEXT = process.argv.includes('--allow-plaintext') || !HAVE_TLS || !PUBLIC;
let TOKEN;
if (existsSync(TOKEN_FILE)) {
    TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
}
else {
    TOKEN = randomBytes(32).toString('base64url');
    mkdirSync(dirname(TOKEN_FILE), { recursive: true });
    writeFileSync(TOKEN_FILE, TOKEN, 'utf8');
    process.stdout.write("New server token written to " + TOKEN_FILE + ". Read that file to copy it to your other machines." + String.fromCharCode(10));
}
const TOKENS_FILE = resolve(CONFIG_DIR, 'havok-tokens.json');
function loadTokens() {
    try {
        return JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
    }
    catch {
        return {};
    }
}
const EXTRA_TOKENS_NOW = () => loadTokens();
function constEq(a, b) {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    if (x.length !== y.length)
        return false;
    try {
        return timingSafeEqual(x, y);
    }
    catch {
        return false;
    }
}
function authOf(header) {
    const given = String(header || '').replace(/^Bearer\s+/i, '');
    if (!given)
        return null;
    let found = null;
    if (constEq(given, TOKEN))
        found = { name: 'SERVER', scope: 'full' };
    for (const [tok, meta] of Object.entries(EXTRA_TOKENS_NOW())) {
        if (constEq(given, tok))
            found = { name: meta.name || 'unnamed', scope: meta.scope || 'recall', store: meta.store === true, read: readList(meta), ...(meta.memoryWrites ? { memoryWrites: String(meta.memoryWrites) } : {}) };
    }
    return found;
}
const EPHEMERAL_SLUG = /^reference_stress_/;
const hits = new Map();
const UNKNOWN_CALLER_LIMIT = 120;
const KNOWN_CALLER_LIMIT = 600;
function rateLimited(key, limit = UNKNOWN_CALLER_LIMIT) {
    const now = Date.now();
    const win = hits.get(key) || [];
    const recent = win.filter((t) => now - t < 60000);
    recent.push(now);
    hits.set(key, recent);
    return recent.length > limit;
}
const saveQueue = new Map();
let saveRunning = false;
let saveGate = Promise.resolve();
const runAsync = (cmd, args, timeout) => new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: BRAIN, timeout, windowsHide: true, maxBuffer: 16 << 20, env: { ...process.env, HAVOK_BRAIN_SERVER_COMMIT: '1' } }, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stdout, stderr })) : resolve(stdout)));
});
const QUEUE_FILE = join(BRAIN, '.save-queue.jsonl');
function persistQueue() {
    try {
        if (!saveQueue.size && !inFlight.size) {
            rmSync(QUEUE_FILE, { force: true });
            return;
        }
        const rows = [...inFlight.entries(), ...saveQueue.entries()].map(([slug, m]) => JSON.stringify({ slug, ...m }));
        writeFileSync(QUEUE_FILE, rows.join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
    }
    catch { }
}
const inFlight = new Map();
function queueBrainSave(slug, existed, callerName, ip) {
    const prev = saveQueue.get(slug) || inFlight.get(slug);
    saveQueue.set(slug, { existed: prev ? prev.existed : existed, callerName, ip });
    persistQueue();
    if (!saveRunning)
        drainBrainSaves();
}
function resumeQueue() {
    let rows = [];
    try {
        rows = readFileSync(QUEUE_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try {
            return JSON.parse(l);
        }
        catch {
            return null;
        } }).filter(Boolean);
    }
    catch {
        return;
    }
    const wanted = rows.filter((r) => typeof r.slug === 'string' && /^[a-z0-9_-]+$/i.test(r.slug) && existsSync(join(BRAIN, 'memory', r.slug + '.md')));
    if (!wanted.length) {
        try {
            rmSync(QUEUE_FILE, { force: true });
        }
        catch { }
        return;
    }
    audit('MEMORY-QUEUE-RESUMED ' + wanted.map((r) => r.slug).join(', '));
    for (const r of wanted)
        queueBrainSave(r.slug, !!r.existed, String(r.callerName || 'resumed'), String(r.ip || '-'));
}
async function drainBrainSaves() {
    saveRunning = true;
    try {
        while (saveQueue.size) {
            await withBrainLock('brain-server: memory queue', saveOneBatch)
                .catch((e) => audit('SAVE-LOCK ' + String(e.message).slice(0, 200)));
        }
    }
    finally {
        saveRunning = false;
    }
}
async function saveOneBatch() {
    const batch = [...saveQueue.entries()];
    saveQueue.clear();
    for (const [sl, m] of batch)
        inFlight.set(sl, m);
    let openGate = () => { };
    saveGate = new Promise((r) => { openGate = r; });
    try {
        await runAsync(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], 120000);
    }
    catch (e) {
        audit('INDEX-FAIL ' + String(e.message).slice(0, 120));
    }
    const keep = batch.filter(([s]) => !EPHEMERAL_SLUG.test(s));
    for (const [s, m] of batch)
        if (EPHEMERAL_SLUG.test(s))
            audit('MEMORY-WRITE ' + m.ip + ' ' + m.callerName + ' ' + s + ' PUSH-FAILED: ephemeral test slug, deliberately not committed');
    if (!keep.length) {
        openGate();
        for (const [sl] of batch)
            inFlight.delete(sl);
        persistQueue();
        return;
    }
    let pushError = null;
    try {
        const mine = keep.map(([s]) => 'memory/' + s + '.md');
        const paths = [...mine, 'memory/MEMORY.md', 'index/', 'MANIFEST.md', 'provenance/'].filter((p) => p.endsWith('/') ? existsSync(join(BRAIN, p)) : true);
        await runAsync('git', ['-C', BRAIN, 'add', '-A', '--', ...paths], 30000);
        await runAsync(process.execPath, [join(BRAIN, 'tools', 'stamp-updated.mjs')], 60000).catch(() => undefined);
        await runAsync('git', ['-C', BRAIN, 'add', '-A', '--', ...mine.filter((p) => existsSync(join(BRAIN, p)))], 30000).catch(() => undefined);
        const who = [...new Set(keep.map(([, m]) => m.callerName))].join(', ');
        const message = keep.length === 1
            ? (keep[0][1].existed ? 'memory: update ' : 'memory: ') + keep[0][0] + ' (via ' + who + ')'
            : 'memory: ' + keep.map(([s]) => s).join(', ') + ' (via ' + who + ')';
        try {
            await runAsync('git', ['-C', BRAIN, 'commit', '-m', message, '--', ...paths], 180000);
            await runAsync('git', ['-C', BRAIN, 'reset', '-q', '--', ...paths], 30000).catch(() => undefined);
        }
        finally {
            openGate();
        }
        try {
            const stray = String(await runAsync('git', ['-C', BRAIN, 'status', '--porcelain', '--', 'memory/'], 30000)).split('\n').filter((l) => /\.md$/.test(l) && !/MEMORY\.md$/.test(l)).map((l) => l.slice(3).trim());
            if (stray.length)
                audit('MEMORY-STRAY files in memory/ not written through the server: ' + stray.slice(0, 10).join(', '));
        }
        catch { }
        try {
            await runAsync('git', ['-C', BRAIN, 'push', '-q', 'origin', 'HEAD'], 120000);
        }
        catch (pe) {
            if (!/non-fast-forward|fetch first|rejected/i.test(String((pe && (pe.stderr || pe.message)) || '')))
                throw pe;
            await runAsync('git', ['-C', BRAIN, 'pull', '-q', '--no-rebase', '--no-edit', 'gitea', 'master'], 180000);
            await runAsync('git', ['-C', BRAIN, 'push', '-q', 'origin', 'HEAD'], 120000);
        }
    }
    catch (ge) {
        const msg = String((ge && (ge.stderr || ge.stdout || ge.message)) || '');
        pushError = /VERIFY FAILED/i.test(msg) ? 'the pre-commit gate refused it: run node tools/verify.mjs'
            : /nothing to commit/i.test(msg) ? 'nothing to commit (content identical)'
                : msg.replace(/\s+/g, ' ').slice(0, 160) || 'git failed with no output';
    }
    openGate();
    for (const [s, m] of keep)
        audit('MEMORY-WRITE ' + m.ip + ' ' + m.callerName + ' ' + s + (m.existed ? ' update' : ' new') + (pushError ? ' PUSH-FAILED: ' + pushError : ''));
    for (const [sl] of batch)
        inFlight.delete(sl);
    persistQueue();
    if (keep.some(([s]) => s.startsWith('contact_')) && existsSync(join(BRAIN, 'tools', 'contacts.mjs'))) {
        try {
            spawn(process.execPath, [join(BRAIN, 'tools', 'contacts.mjs')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        }
        catch { }
    }
}
function audit(line) {
    try {
        appendFileSync(ACCESS_LOG, new Date().toISOString() + ' ' + String(line).replace(/[\u0000-\u001f\u007f]+/g, ' ') + '\n');
    }
    catch { }
}
const INDEX_FILES = ['keywords.json', 'embeddings.json', 'rules.json', 'contact.md', 'feedback.md', 'project.md', 'reference.md', 'user.md', 'translate-system.txt'];
let versionCache = null;
function indexVersion() {
    const stat = [];
    for (const name of INDEX_FILES) {
        const f = join(BRAIN, 'index', name);
        try {
            const st = statSync(f);
            stat.push(name + ':' + st.size + ':' + Math.floor(st.mtimeMs));
        }
        catch { }
    }
    const key = stat.join('|');
    if (versionCache && versionCache.key === key)
        return versionCache.payload;
    const files = {};
    const whole = createHash('sha256');
    for (const name of INDEX_FILES) {
        const f = join(BRAIN, 'index', name);
        let buf = null;
        try {
            buf = readFileSync(f);
        }
        catch {
            continue;
        }
        const sha = createHash('sha256').update(buf).digest('hex').slice(0, 16);
        files[name] = { bytes: buf.length, sha };
        whole.update(name + ':' + sha + '|');
    }
    const payload = {
        version: whole.digest('hex').slice(0, 16),
        files,
        memories: (() => {
            try {
                return readdirSync(join(BRAIN, 'memory')).filter((f) => f.endsWith('.md')).length;
            }
            catch {
                return 0;
            }
        })(),
    };
    versionCache = { key, payload };
    return payload;
}
const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
};
const EMBED_TIMEOUT_MS = Number(process.env.HAVOK_EMBED_TIMEOUT_MS || 4000);
const EMBED_LOAD_TIMEOUT_MS = Number(process.env.HAVOK_EMBED_LOAD_TIMEOUT_MS || 180000);
let embedder = null;
async function getEmbedder() {
    if (!embedder) {
        embedder = makeGuardedEmbedder({
            model: 'Xenova/all-MiniLM-L6-v2', module: process.env.HAVOK_EMBED_MODULE || null,
            timeoutMs: EMBED_TIMEOUT_MS, loadTimeoutMs: EMBED_LOAD_TIMEOUT_MS,
            probe: process.env.HAVOK_EMBED_PROBE !== 'off', stateFile: join(BRAIN, '.embed-probe.json'),
            onEvent: (what) => {
                if (/^probe-/.test(what)) {
                    audit('EMBED-' + what.toUpperCase());
                    return;
                }
                const limit = what === 'load-timeout' ? EMBED_LOAD_TIMEOUT_MS : EMBED_TIMEOUT_MS;
                audit('EMBED-' + what.toUpperCase() + ' limit ' + limit + 'ms');
                try {
                    if (/timeout/.test(what))
                        serverAlerts.embed(what, limit);
                }
                catch { }
            },
        });
    }
    return embedder.embed;
}
const KEYWORD_ONLY_NOTE = 'NOTE: semantic recall missed this turn, so the recall below is keyword only and a paraphrase may not match. Why: the brain server ';
const recall = makeRecall({ brain: BRAIN, getEmbedder, indexVersion });
const recallTurn = makeRecallTurn({ brain: BRAIN, recall, layersDir: LAYERS_DIR, releasesDir: RELEASES_DIR, stateDir: join(BRAIN, '.recall-turn-state'), translate: (text) => translateSync(text, BRAIN), shortFollowUp: SHORT_FOLLOW_UP });
const handler = async (req, res) => {
    const ip = req.socket.remoteAddress || '?';
    if (!String(req.url || '').startsWith('/archive/upload'))
        req.setEncoding('utf8');
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (path === '/health')
        return json(res, 200, { ok: true });
    if (path === '/tailnet/sweep' && req.method === 'POST') {
        if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip))
            return json(res, 403, { error: 'loopback only' });
        const bound = tailnetSweep ? tailnetSweep.sweep() : [];
        return json(res, 200, { ok: true, bound, known: tailnetSweep ? tailnetSweep.known() : [], addresses: tailnetAddresses() });
    }
    if (path.startsWith('/bootstrap/')) {
        const want = decodeURIComponent(path.slice('/bootstrap/'.length));
        const from = String(ip).replace(/^::ffff:/, '');
        let armed = {};
        try {
            armed = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'havok-bootstrap.json'), 'utf8'));
        }
        catch { }
        const entry = armed[want];
        if (!entry || entry.ip !== from) {
            audit('BOOTSTRAP-REFUSED ' + from + ' wanted=' + want + (entry ? ' armed-for=' + entry.ip : ' not-armed'));
            return json(res, 403, { error: 'not armed', detail: 'ask the person to arm this machine: node tools/token.mjs arm <NAME> --ip <your tailnet ip>' });
        }
        const hit = Object.entries(EXTRA_TOKENS_NOW()).find(([, m]) => m.name === want);
        if (!hit) {
            audit('BOOTSTRAP-NOTOKEN ' + from + ' ' + want);
            return json(res, 404, { error: 'no token issued for ' + want });
        }
        try {
            delete armed[want];
            writeFileSync(resolve(CONFIG_DIR, 'havok-bootstrap.json'), JSON.stringify(armed, null, 2), 'utf8');
        }
        catch (e) {
            audit('BOOTSTRAP-ARMFAIL ' + from + ' ' + want);
            return json(res, 500, { error: 'could not consume the arm, refusing to hand out a token' });
        }
        audit('BOOTSTRAP-OK ' + from + ' ' + want + ' scope=' + hit[1].scope);
        return json(res, 200, { name: want, scope: hit[1].scope, token: hit[0] });
    }
    const known = authOf(req.headers.authorization);
    if (known ? rateLimited('token:' + known.name, KNOWN_CALLER_LIMIT) : rateLimited(ip)) {
        audit('RATE-LIMITED ' + ip + (known ? ' ' + known.name : ''));
        return json(res, 429, { error: 'too many requests' });
    }
    const caller = known;
    if (!caller) {
        audit('DENIED ' + ip + ' ' + path);
        return json(res, 401, { error: 'unauthorized' });
    }
    const vAccess = vaultAccess(caller, req.method, path);
    if (vAccess === 'deny') {
        audit('REFUSED-SCOPE ' + ip + ' ' + caller.name + ' scope=' + caller.scope + (caller.store ? '+store' : '') + ' ' + path);
        return json(res, 403, { error: 'forbidden',
            detail: 'this token has scope "' + caller.scope + '"' + (caller.store ? ' with store: it can add a new secret and list the ones it added, never read one' : ' and cannot read the vault') + '. Ask the person of the brain, do not retry.' });
    }
    try {
        if (path === '/vault/list') {
            const v = JSON.parse(readFileSync(join(BRAIN, 'vault.json'), 'utf8'));
            let out = Object.entries(v.secrets || {}).map(([name, s]) => ({ name, updated: s.updated, note: s.note || '' }));
            if (vAccess === 'own-list')
                out = listFor(out, caller);
            audit('list ' + ip + (vAccess === 'own-list' ? ' ' + caller.name + ' own and granted only' : ''));
            return json(res, 200, { secrets: out });
        }
        if (path.startsWith('/vault/get/')) {
            const name = basename(decodeURIComponent(path.slice('/vault/get/'.length)));
            let value;
            try {
                value = await new Promise((ok, fail) => execFile(process.execPath, [join(BRAIN, 'tools', 'vault.mjs'), 'get', name], { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout, stderr) => err ? fail(Object.assign(err, { stderr })) : ok(stdout)));
            }
            catch (e) {
                audit('SECRET-MISS ' + name + ' by ' + ip + ' ' + (e.killed ? 'timeout' : String(e.stderr || e.message || '').split(String.fromCharCode(10))[0].slice(0, 160)));
                if (e.killed)
                    return json(res, 503, { error: 'vault busy', detail: 'the decrypt took over 15 s; retry in a few seconds' });
                return json(res, 404, {
                    error: 'no such secret',
                    detail: 'the vault has no secret named "' + name + '". This is NOT a permission problem'
                        + ' and NOT the server being broken. Run: node tools/brain-client.mjs list',
                });
            }
            audit('READ SECRET ' + name + ' by ' + (caller ? caller.name + ' ' : '') + ip + (caller && caller.scope !== 'full' ? ' (granted)' : ''));
            return json(res, 200, { name, value });
        }
        if (path.startsWith('/vault/set/') && req.method === 'POST') {
            const name = basename(decodeURIComponent(path.slice('/vault/set/'.length)));
            if (!/^[a-z0-9][a-z0-9_]{1,59}$/.test(name))
                return json(res, 400, { error: 'bad name', detail: 'lowercase letters, digits and _ only' });
            let raw = '';
            for await (const chunk of req) {
                raw += chunk;
                if (raw.length > 20000) {
                    req.destroy();
                    return;
                }
            }
            let body;
            try {
                body = JSON.parse(raw || '{}');
            }
            catch {
                return json(res, 400, { error: 'bad json' });
            }
            const value = String(body.value || '').trim();
            if (!value)
                return json(res, 400, { error: 'empty value' });
            const v = JSON.parse(readFileSync(join(BRAIN, 'vault.json'), 'utf8'));
            if ((v.secrets || {})[name] && !mayReplace(caller, body)) {
                return json(res, 409, { error: 'exists', detail: name + ' is already in the vault. ' + (caller.scope === 'full'
                        ? 'Pass --replace only if the person asked for the old key to be replaced.'
                        : 'This token can only add new secrets; pick another name, or have it replaced with a full-scope token on the brain host.') });
            }
            const note = String(body.note || '').slice(0, 300) + ' (stored by ' + caller.name + ' ' + new Date().toISOString().slice(0, 10) + ')';
            const onlyNew = !mayReplace(caller, body);
            const result = await new Promise((ok) => {
                const p = spawn(process.execPath, [join(BRAIN, 'tools', 'vault.mjs'), 'set', name, '--note', note.trim(), ...(onlyNew ? ['--new'] : [])], { cwd: BRAIN, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
                let err = '';
                p.stderr.on('data', (d) => { err += d; });
                p.on('close', (code) => ok({ code, err }));
                p.stdin.end(value);
            });
            if (result.code === 3 && onlyNew) {
                audit('SECRET-SET-EXISTS ' + name + ' by ' + caller.name + ' ' + ip);
                return json(res, 409, { error: 'exists', detail: name + ' was stored by someone else a moment ago and was not replaced.' });
            }
            if (result.code !== 0) {
                audit('SECRET-SET-FAILED ' + name + ' by ' + caller.name + ' ' + ip);
                return json(res, 500, { error: 'vault refused', detail: String(result.err).split(String.fromCharCode(10)).filter(Boolean).pop() });
            }
            let pushed = false;
            for (let attempt = 0; attempt < 5 && !pushed; attempt++) {
                if (attempt)
                    await new Promise((r) => setTimeout(r, 4000));
                try {
                    await withBrainLock('brain-server: vault ' + name, async () => {
                        await runAsync('git', ['add', 'vault.json'], 30000);
                        await runAsync('git', ['com' + 'mit', '-m', 'vault: ' + name + ' stored by ' + caller.name, '--', 'vault.json'], 60000).catch((e) => { if (!/nothing to commit|no changes added/i.test(String(e.stdout || '') + String(e.stderr || '')))
                            throw e; });
                        await runAsync('git', ['push', '--quiet'], 60000);
                    }, 90000);
                    pushed = true;
                }
                catch { }
            }
            audit('STORED SECRET ' + name + ' by ' + caller.name + ' ' + ip + (pushed ? '' : ' (git backup failed)'));
            return json(res, 200, { ok: true, name, replaced: !!(v.secrets || {})[name], pushed });
        }
        if (path === '/vault/passphrase') {
            audit('REFUSED retired /vault/passphrase from ' + ip);
            return json(res, 410, {
                error: 'retired: the vault no longer has a shared passphrase',
                do: 'on the new machine run: node tools/vault.mjs machine-init, then send the PUBLIC key here and run: node tools/vault.mjs machine-add <NAME> <key> && node tools/vault.mjs grant --all --to <NAME>',
            });
        }
        const rawPath = String(req.url || '').split('?')[0];
        if (req.method === 'GET' && path === '/layers/versions') {
            const groups = String(url.searchParams.get('groups') || '').split(',').map((g) => g.trim()).filter(Boolean);
            const release = releaseSummary(RELEASES_DIR);
            return json(res, 200, { ...layerVersions(LAYERS_DIR, String(url.searchParams.get('machine') || ''), groups), ...(release ? { release } : {}) });
        }
        if (req.method === 'GET' && rawPath.startsWith('/layers/')) {
            let key = '';
            try {
                key = decodeURIComponent(rawPath.slice('/layers/'.length));
            }
            catch {
                return json(res, 400, { error: 'bad layer key' });
            }
            const r = readLayer(LAYERS_DIR, key);
            if (r.status !== 200)
                return json(res, r.status, { error: r.error });
            const etag = '"' + r.version + '"';
            if (req.headers['if-none-match'] === etag) {
                res.writeHead(304, { etag });
                return res.end();
            }
            res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', etag });
            return res.end(r.text);
        }
        if (req.method === 'GET' && rawPath.startsWith('/release/')) {
            const rest = rawPath.slice('/release/'.length);
            if (rest === 'latest') {
                const s = releaseSummary(RELEASES_DIR);
                return s ? json(res, 200, releaseManifest(RELEASES_DIR, s.version)) : json(res, 404, { error: 'no release published' });
            }
            const p = releasePath(rest);
            if (!p)
                return json(res, 400, { error: 'bad release version' });
            if (!p.zip) {
                const man = releaseManifest(RELEASES_DIR, p.version);
                return man ? json(res, 200, man) : json(res, 404, { error: 'no such release' });
            }
            const file = releaseZip(RELEASES_DIR, p.version);
            if (!file)
                return json(res, 404, { error: 'no such release' });
            const buf = readFileSync(file);
            audit('RELEASE ' + ip + ' ' + caller.name + ' ' + p.version + ' ' + buf.length + 'b');
            res.writeHead(200, { 'content-type': 'application/zip', 'content-length': buf.length });
            return res.end(buf);
        }
        if (path === '/dist' || path.startsWith('/dist/')) {
            const allowed = distFiles;
            const canonical = (buf) => {
                let n = 0;
                const o = Buffer.allocUnsafe(buf.length);
                for (let i = 0; i < buf.length; i += 1) {
                    if (buf[i] === 13 && buf[i + 1] === 10)
                        continue;
                    o[n] = buf[i];
                    n += 1;
                }
                return o.subarray(0, n);
            };
            if (path === '/dist/version') {
                return json(res, 200, distVersion(0));
            }
            if (path === '/dist') {
                const files = [];
                for (const rel of allowed()) {
                    try {
                        const buf = canonical(readFileSync(join(BRAIN, rel)));
                        files.push({ path: rel, bytes: buf.length, sha: createHash('sha256').update(buf).digest('hex').slice(0, 16) });
                    }
                    catch { }
                }
                audit('DIST-MANIFEST ' + ip + ' ' + caller.name + ' ' + files.length + ' files');
                return json(res, 200, { files });
            }
            const rel = decodeURIComponent(path.slice('/dist/'.length));
            if (!allowed().includes(rel)) {
                audit('DIST-REFUSED ' + ip + ' ' + caller.name + ' ' + rel);
                return json(res, 403, { error: 'not served', detail: 'only files listed by GET /dist are available' });
            }
            const abs = resolve(BRAIN, rel);
            if (!abs.startsWith(resolve(BRAIN))) {
                audit('DIST-TRAVERSAL ' + ip + ' ' + caller.name + ' ' + rel);
                return json(res, 400, { error: 'bad path' });
            }
            try {
                const buf = canonical(readFileSync(abs));
                audit('DIST ' + ip + ' ' + caller.name + ' ' + rel + ' ' + buf.length + 'b');
                res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
                return res.end(buf);
            }
            catch {
                return json(res, 404, { error: 'not found on the server' });
            }
        }
        if (path === '/rules') {
            return json(res, 200, JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')));
        }
        if (path === '/index/version') {
            return json(res, 200, indexVersion());
        }
        if (path.startsWith('/index/')) {
            const name = basename(decodeURIComponent(path.slice('/index/'.length)));
            const f = join(BRAIN, 'index', name);
            if (!existsSync(f))
                return json(res, 404, { error: 'no such index file' });
            const body = readFileSync(f);
            res.writeHead(200, {
                'content-type': name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8',
                'content-length': body.length,
                'x-brain-version': indexVersion().version,
            });
            return res.end(body);
        }
        if (path.startsWith('/memory/') && req.method === 'GET') {
            const slug = basename(decodeURIComponent(path.slice('/memory/'.length))).replace(/\.md$/, '');
            const f = join(BRAIN, 'memory', slug + '.md');
            if (!existsSync(f))
                return json(res, 404, { error: 'no such memory' });
            return json(res, 200, { slug, content: readFileSync(f, 'utf8') });
        }
        if (path === '/memory' && req.method === 'POST') {
            let raw = '';
            for await (const chunk of req) {
                raw += chunk;
                if (raw.length > 200000) {
                    req.destroy();
                    return;
                }
            }
            let body;
            try {
                body = JSON.parse(raw || '{}');
            }
            catch {
                return json(res, 400, { error: 'bad json' });
            }
            const slug = String(body.slug || '').trim();
            const content = String(body.content || '');
            if (!/^[a-z][a-z0-9_]{2,80}$/.test(slug)) {
                return json(res, 400, { error: 'bad slug', detail: 'lowercase letters, digits and underscores only, 3 to 81 chars. No dots or slashes.' });
            }
            const prefix = slug.split('_')[0];
            const TYPES = ['user', 'contact', 'project', 'feedback', 'reference'];
            if (!TYPES.includes(prefix)) {
                return json(res, 400, { error: 'bad prefix', detail: 'slug must start with one of: ' + TYPES.join(', ') });
            }
            if (content.length < 40)
                return json(res, 400, { error: 'too short', detail: 'a memory needs frontmatter and a body' });
            const fm = content.replace(/\r\n/g, '\n');
            if (!fm.startsWith('---'))
                return json(res, 400, { error: 'no frontmatter' });
            const end = fm.indexOf('\n---', 3);
            if (end < 0)
                return json(res, 400, { error: 'unterminated frontmatter' });
            const head = fm.slice(3, end);
            const field = (k) => (head.match(new RegExp('^\\s*' + k + ':\\s*(.+)$', 'm')) || [])[1];
            const desc = field('description');
            if (!field('name'))
                return json(res, 400, { error: 'missing name' });
            if (!desc || desc.trim().length < 20) {
                return json(res, 400, { error: 'missing or thin description', detail: 'the description is the only thing indexed for recall. Write it in the words the person would type, at least 20 chars.' });
            }
            const topType = (head.match(/^type:[ 	]*(.+)$/m) || [])[1];
            if (!topType) {
                return json(res, 400, {
                    error: 'type must be top level',
                    detail: 'add a line "type: ' + prefix + '" at the top level of the frontmatter. Nested under metadata does not count: the mind map cannot see it and reflection then blocks commits on every machine.',
                });
            }
            if (topType.trim() !== prefix) {
                return json(res, 400, { error: 'type mismatch', detail: 'frontmatter type "' + topType.trim() + '" does not match slug prefix "' + prefix + '"' });
            }
            const links = [...new Set((fm.match(/\[\[([^\]]+)\]\]/g) || [])
                    .map((l) => l.slice(2, -2).trim()))];
            const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
            const resolvable = new Set([norm(slug)]);
            try {
                for (const f of readdirSync(join(BRAIN, 'memory'))) {
                    if (!f.endsWith('.md') || f === 'MEMORY.md')
                        continue;
                    resolvable.add(norm(f.slice(0, -3)));
                    const head = readFileSync(join(BRAIN, 'memory', f), 'utf8').slice(0, 600);
                    const nm = /^name:\s*(.+)$/m.exec(head);
                    if (nm)
                        resolvable.add(norm(nm[1].replace(/["']/g, '')));
                }
            }
            catch { }
            const ownName = /^name:\s*(.+)$/m.exec(fm);
            if (ownName)
                resolvable.add(norm(ownName[1].replace(/["']/g, '')));
            const dead = links.filter((l) => !resolvable.has(norm(l)));
            if (dead.length) {
                return json(res, 400, { error: 'broken wikilink', detail: 'these point at memories that do not exist: '
                        + dead.join(', ') + '. Create them first, or drop the link. A broken edge blocks commits for every machine.' });
            }
            const leaf = /^leaf:\s*true\s*$/m.test(head);
            if (!links.length && leaf)
                audit('MEMORY-WRITE-LEAF ' + ip + ' ' + caller.name + ' ' + slug);
            if (!links.length && !leaf) {
                const LINK_BAR = 0.45;
                try {
                    const emb = JSON.parse(readFileSync(join(BRAIN, 'index', 'embeddings.json'), 'utf8'));
                    const bodyText = fm.slice(end + 4).replace(/\s+/g, ' ').trim().slice(0, 1200);
                    const e = await getEmbedder();
                    const v = (await e(slug.replace(/_/g, ' ') + '. ' + desc + ' ' + bodyText, { pooling: 'mean', normalize: true })).data;
                    const near = emb.slugs.map((s, i) => { let d = 0; const w = emb.vectors[i]; for (let k = 0; k < w.length; k++)
                        d += v[k] * w[k]; return [s, d]; })
                        .filter(([s, d]) => s !== slug && !EPHEMERAL_SLUG.test(s) && d >= LINK_BAR).sort((a, b) => b[1] - a[1]).slice(0, 6);
                    if (near.length) {
                        audit('MEMORY-WRITE-REFUSED ' + ip + ' ' + caller.name + ' ' + slug + ' no links, ' + near.length + ' candidates');
                        return json(res, 400, { error: 'no links', candidates: near.map(([s]) => s),
                            detail: 'add at least one [[slug]] to a memory this one depends on, changes or is used with. Closest by meaning: '
                                + near.map(([s, d]) => s + ' (' + d.toFixed(2) + ')').join(', ') + '. Link the one it really relates to, not just the first. If none of them truly relates, add "leaf: true" to the header.' });
                    }
                }
                catch (err) {
                    audit('LINK-CHECK-SKIPPED ' + slug + ' ' + String(err.message).slice(0, 80));
                }
            }
            const file = join(BRAIN, 'memory', slug + '.md');
            const existed = existsSync(file);
            const mAccess = memoryAccess(caller, { method: 'POST', slug, exists: existed, force: false });
            if (mAccess !== 'allow') {
                audit('MEMORY-WRITE-REFUSED ' + ip + ' ' + caller.name + ' ' + slug + ' scope: ' + mAccess);
                return json(res, 403, { error: 'not allowed', detail: mAccess });
            }
            try {
                await saveGate;
                writeFileSync(file, fm, 'utf8');
                recordProvenance([{ slug, action: existed ? 'update' : 'new' }], { ...(body.by || {}), machine: caller.name }, 'server');
                queueBrainSave(slug, existed, caller.name, ip);
                return json(res, 200, { ok: true, slug, updated: existed, queued: true, pushed: null, v: indexVersion().version });
            }
            catch (e) {
                audit('MEMORY-WRITE-FAIL ' + ip + ' ' + caller.name + ' ' + slug + ' ' + String(e.message).slice(0, 80));
                return json(res, 500, { error: 'write failed', detail: String(e.message).slice(0, 200) });
            }
        }
        if (path.startsWith('/memory/') && req.method === 'DELETE') {
            const slug = basename(decodeURIComponent(path.slice('/memory/'.length))).replace(/\.md$/, '');
            if (!/^[a-z][a-z0-9_]{2,80}$/.test(slug))
                return json(res, 400, { error: 'bad slug' });
            const file = join(BRAIN, 'memory', slug + '.md');
            if (!existsSync(file))
                return json(res, 404, { error: 'no such memory', detail: slug + ' is not on the server.' });
            let raw = '';
            for await (const chunk of req) {
                raw += chunk;
                if (raw.length > 20000) {
                    req.destroy();
                    return;
                }
            }
            let body = {};
            try {
                body = JSON.parse(raw || '{}');
            }
            catch { }
            const dAccess = memoryAccess(caller, { method: 'DELETE', slug, exists: true, force: !!body.force });
            if (dAccess !== 'allow') {
                audit('MEMORY-DELETE-REFUSED ' + ip + ' ' + caller.name + ' ' + slug + ' scope: ' + dAccess);
                return json(res, 403, { error: 'not allowed', detail: dAccess });
            }
            const why = String(body.why || '').trim();
            if (why.length < 10) {
                return json(res, 400, { error: 'no reason', detail: 'say why in at least ten characters. A deletion with no reason is indistinguishable from an accident.' });
            }
            const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
            const ownNames = new Set([norm(slug)]);
            try {
                const head = readFileSync(file, 'utf8').slice(0, 600);
                const nm = /^name:\s*(.+)$/m.exec(head);
                if (nm)
                    ownNames.add(norm(nm[1].replace(/["']/g, '')));
            }
            catch { }
            const pointing = [];
            try {
                for (const f of readdirSync(join(BRAIN, 'memory'))) {
                    if (!f.endsWith('.md') || f === 'MEMORY.md' || f === slug + '.md')
                        continue;
                    const txt = readFileSync(join(BRAIN, 'memory', f), 'utf8');
                    const links = [...txt.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => norm(m[1]));
                    if (links.some((l) => ownNames.has(l)))
                        pointing.push(f.slice(0, -3));
                }
            }
            catch { }
            if (pointing.length && !body.force) {
                return json(res, 409, {
                    error: 'still linked',
                    detail: pointing.length + ' memories link to ' + slug + ': ' + pointing.slice(0, 12).join(', ')
                        + '. A link to a memory that does not exist is a broken edge and it blocks writes for every'
                        + ' machine. Remove those links first, or repeat with force to have them left as they are.',
                    linked: pointing,
                });
            }
            try {
                const grave = join(CONFIG_DIR, 'brain-graveyard');
                mkdirSync(grave, { recursive: true });
                const stamp = new Date().toISOString();
                const note = '<!-- deleted ' + stamp + ' by ' + caller.name + ' from ' + ip + ': ' + why.slice(0, 300) + ' -->\n';
                const plain = note + readFileSync(file, 'utf8');
                const reg = JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8')) || {};
                const pub = ((reg.machines || {})[reg.host] || {}).pubkey;
                if (!pub)
                    throw new Error('no age recipient for this machine, refusing to delete without a recoverable backup');
                const sealed = execFileSync('age', ['-r', pub, '-a'], { input: plain, encoding: 'utf8' });
                writeFileSync(join(grave, slug + '.' + stamp.replace(/[:.]/g, '-') + '.age'), sealed, 'utf8');
                rmSync(file);
                audit('MEMORY-DELETE ' + ip + ' ' + caller.name + ' ' + slug + ' :: ' + why.slice(0, 120));
                recordProvenance([{ slug, action: 'delete' }], { ...(body.by || {}), machine: caller.name }, 'server');
                queueBrainSave(slug, true, caller.name, ip);
                return json(res, 200, { ok: true, slug, deleted: true, linked: pointing, queued: true });
            }
            catch (e) {
                audit('MEMORY-DELETE-FAIL ' + ip + ' ' + caller.name + ' ' + slug + ' ' + String(e.message).slice(0, 80));
                return json(res, 500, { error: 'delete failed', detail: String(e.message).slice(0, 200) });
            }
        }
        if (path === '/search' && req.method === 'POST') {
            let sbody = '';
            for await (const chunk of req) {
                sbody += chunk;
                if (sbody.length > 100000) {
                    req.destroy();
                    return;
                }
            }
            let sp;
            try {
                sp = JSON.parse(sbody || '{}');
            }
            catch {
                return json(res, 400, { error: 'bad json' });
            }
            const strs = (a, n) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x.trim()).slice(0, n).map((x) => x.slice(0, 1000)) : []);
            const needs = strs(sp.needs, 20), learned = strs(sp.learned, 10);
            if (!needs.length && !learned.length)
                return json(res, 400, { error: 'needs or learned required' });
            const SEARCH_MIN = 0.5, LEARNED_SHOW = 0.45;
            const ts = Date.now();
            const emb = JSON.parse(readFileSync(join(BRAIN, 'index', 'embeddings.json'), 'utf8'));
            const kwd = JSON.parse(readFileSync(join(BRAIN, 'index', 'keywords.json'), 'utf8'));
            const e = await getEmbedder();
            let searchDegraded = '';
            const vec = async (t) => { try {
                return (await e(t, { pooling: 'mean', normalize: true })).data;
            }
            catch (err) {
                searchDegraded = String(err.message).slice(0, 160);
                return null;
            } };
            const scores = (v) => (!v ? [] : emb.slugs.map((sl, i) => { let d = 0; const w = emb.vectors[i]; for (let k = 0; k < w.length; k++)
                d += v[k] * w[k]; return [sl, d]; }));
            const keep = new Map();
            for (const n of needs) {
                const fused = await recall(n, [n], 5, 0, false, 0, -1);
                if (fused.degraded)
                    searchDegraded = fused.degraded;
                for (const h of fused)
                    if (h.how === 'both')
                        keep.set(h.slug, { score: 1, how: 'both' });
                for (const h of fused.filter((x) => x.how !== 'linked').slice(0, 3))
                    if (!keep.has(h.slug))
                        keep.set(h.slug, { score: 0.5, how: h.how });
                for (const [sl, d] of scores(await vec(n)))
                    if (d >= SEARCH_MIN && (!keep.has(sl) || keep.get(sl).score < d))
                        keep.set(sl, { score: d, how: keep.get(sl)?.how || 'meaning' });
            }
            const memories = [...keep.entries()].sort((a, b) => b[1].score - a[1].score)
                .map(([sl, v]) => ({ slug: sl, how: v.how, score: +Math.min(v.score, 1).toFixed(3), description: String(kwd.descriptions[sl] || '').slice(0, 160) }));
            const learnedOut = [];
            for (const l of learned) {
                const near = scores(await vec(l)).filter(([, d]) => d >= LEARNED_SHOW).sort((a, b) => b[1] - a[1]).slice(0, 3)
                    .map(([sl, d]) => ({ slug: sl, score: +d.toFixed(3), description: String(kwd.descriptions[sl] || '').slice(0, 200) }));
                learnedOut.push({ item: l, closest: near });
            }
            audit('SEARCH ' + ip + ' needs=' + needs.length + ' learned=' + learned.length + ' hits=' + memories.length + ' ' + (Date.now() - ts) + 'ms');
            return json(res, 200, { memories, learned: learnedOut, v: indexVersion().version, ...(searchDegraded ? { note: KEYWORD_ONLY_NOTE + searchDegraded + '.' } : {}) });
        }
        if (path === '/recall/turn' && req.method === 'POST') {
            let tbody = '';
            for await (const chunk of req) {
                tbody += chunk;
                if (tbody.length > 200000) {
                    req.destroy();
                    return;
                }
            }
            let tp;
            try {
                tp = JSON.parse(tbody || '{}');
            }
            catch {
                return json(res, 400, { error: 'bad json' });
            }
            if (typeof tp.prompt !== 'string' || !tp.prompt.trim())
                return json(res, 400, { error: 'prompt required' });
            tp.previous = (Array.isArray(tp.previous) ? tp.previous : []).filter((x) => typeof x === 'string').slice(-3).map((x) => x.slice(0, 4000));
            tp.prompt = tp.prompt.slice(0, 20000);
            tp.machine = String(tp.machine || '').slice(0, 64);
            const tt = Date.now();
            const out = await recallTurn(tp);
            try {
                serverAlerts.recall(Date.now() - tt);
            }
            catch { }
            if (out.memories.length) {
                try {
                    const PULSE = join(BRAIN, '.recall-pulse.jsonl');
                    appendFileSync(PULSE, JSON.stringify({ at: Date.now(), host: tp.machine || caller.name, slugs: out.memories.map((m) => m.slug).slice(0, 20), how: out.memories.map((m) => m.why).slice(0, 20) }) + '\n', 'utf8');
                    const lines = readFileSync(PULSE, 'utf8').split('\n').filter(Boolean);
                    if (lines.length > 800)
                        writeFileSync(PULSE, lines.slice(-600).join('\n') + '\n', 'utf8');
                }
                catch { }
            }
            try {
                out.distVersion = distVersion().version;
            }
            catch { }
            try {
                const q = readQuota(BRAIN);
                if (q && q.at)
                    out.agyQuotaAt = q.at;
            }
            catch { }
            try {
                out.decisionsWaiting = decisionsWaiting(BRAIN);
            }
            catch { }
            try {
                const ds = searchDecisions(BRAIN, tp.prompt, { limit: 3, recall: true });
                if (ds.length)
                    out.decisions = ds.map((d) => ({ id: d.id, at: d.at, by: d.by || d.agent, agent: d.agent, area: d.area, what: d.what, state: d.state, ...(d.state === 'reversed' && d.review && d.review.note ? { note: String(d.review.note).slice(0, 300) } : {}) }));
            }
            catch { }
            audit('RECALL-TURN ' + ip + ' ' + caller.name + ' chars=' + tp.prompt.length + ' hits=' + out.memories.length + ' earlier=' + out.memories.filter((m) => m.why === 'earlier').length + ' dropped=' + out.droppedEarlier.length + ' ' + (Date.now() - tt) + 'ms');
            return json(res, 200, out);
        }
        if (path === '/recall' && req.method === 'POST') {
            let rbody = '';
            for await (const chunk of req) {
                rbody += chunk;
                if (rbody.length > 200000) {
                    req.destroy();
                    return;
                }
            }
            let rp;
            try {
                rp = JSON.parse(rbody || '{}');
            }
            catch {
                return json(res, 400, { error: 'bad json' });
            }
            const prompt = typeof rp.prompt === 'string' ? rp.prompt : '';
            if (!prompt.trim())
                return json(res, 400, { error: 'prompt required' });
            const queries = Array.isArray(rp.queries) && rp.queries.length
                ? rp.queries.filter((t) => typeof t === 'string' && t.trim()).slice(0, 16)
                : [prompt.slice(0, 4000)];
            const tr = Date.now();
            const bodyChars = rp.bodies === false ? 0
                : rp.bodies ? Math.min(Math.max(Number(rp.bodyChars) || 1500, 200), 4000) : 0;
            const ranked = await recall(prompt, queries, Math.min(Math.max(Number(rp.limit) || 5, 1), 20), bodyChars, rp.limit != null, Math.max(0, Math.min(Number(rp.parts) || 0, 16)), (Number.isInteger(rp.contextIndex) && prompt.trim().length >= SHORT_FOLLOW_UP) ? rp.contextIndex : -1);
            audit('RECALL ' + ip + ' q=' + queries.length + ' chars=' + prompt.length
                + ' hits=' + ranked.length + (bodyChars ? ' bodies=' + bodyChars : '') + (ranked.degraded ? ' keyword-only' : '') + ' ' + (Date.now() - tr) + 'ms');
            return json(res, 200, { ranked, v: indexVersion().version, ...(ranked.degraded ? { note: KEYWORD_ONLY_NOTE + ranked.degraded + '.' } : {}) });
        }
        if (path === '/decisions' || path === '/decisions/count' || /^\/decisions\/[A-Za-z0-9_-]{1,64}\/review$/.test(path)) {
            if (await handleDecisionRoute(req, res, { brain: BRAIN, path, url, caller, audit, getToken: () => TOKEN }))
                return;
        }
        if (path === '/pulse' && req.method === 'POST') {
            let pbody = '';
            for await (const chunk of req) {
                pbody += chunk;
                if (pbody.length > 20000) {
                    req.destroy();
                    return;
                }
            }
            let pp;
            try {
                pp = JSON.parse(pbody || '{}');
            }
            catch {
                return json(res, 400, { error: 'bad json' });
            }
            const host = String(pp.host || '').slice(0, 64);
            const slugs = Array.isArray(pp.slugs)
                ? pp.slugs.filter((x) => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 200))
                : [];
            const how = Array.isArray(pp.how)
                ? pp.how.filter((x) => typeof x === 'string').slice(0, 20)
                : [];
            if (!host || !slugs.length)
                return json(res, 400, { error: 'host and slugs required' });
            if (host.toUpperCase() === hostname().toUpperCase())
                return json(res, 200, { ok: true, skipped: 'local' });
            const at = Number(pp.at) || Date.now();
            try {
                const PULSE = join(BRAIN, '.recall-pulse.jsonl');
                appendFileSync(PULSE, JSON.stringify({ at, host, slugs, how }) + '\n', 'utf8');
                const lines = readFileSync(PULSE, 'utf8').split('\n').filter(Boolean);
                if (lines.length > 800)
                    writeFileSync(PULSE, lines.slice(-600).join('\n') + '\n', 'utf8');
            }
            catch { }
            audit('PULSE ' + ip + ' host=' + host + ' hits=' + slugs.length);
            return json(res, 200, { ok: true });
        }
        if (path === '/embed' && req.method === 'POST') {
            let body = '';
            for await (const chunk of req) {
                body += chunk;
                if (body.length > 100000) {
                    req.destroy();
                    return;
                }
            }
            const parsed = JSON.parse(body || '{}');
            if (Array.isArray(parsed.texts)) {
                const texts = parsed.texts.filter((t) => typeof t === 'string' && t.trim()).slice(0, 16);
                if (!texts.length)
                    return json(res, 400, { error: 'texts must be a non-empty array of strings' });
                const tb = Date.now();
                const embedB = await getEmbedder();
                const vectors = [];
                try {
                    for (const t of texts) {
                        const o = await embedB(t.slice(0, 4000), { pooling: 'mean', normalize: true });
                        vectors.push(Array.from(o.data));
                    }
                }
                catch (e) {
                    audit('EMBED-FAIL ' + ip + ' n=' + texts.length + ' ' + (Date.now() - tb) + 'ms ' + String(e.message).slice(0, 120));
                    return json(res, 503, { error: 'embedding unavailable', detail: String(e.message).slice(0, 160) });
                }
                audit('EMBED-BATCH ' + ip + ' n=' + texts.length
                    + ' chars=' + texts.reduce((a, t) => a + t.length, 0) + ' ' + (Date.now() - tb) + 'ms');
                return json(res, 200, { vectors, v: indexVersion().version });
            }
            const { text } = parsed;
            if (typeof text !== 'string' || !text.trim())
                return json(res, 400, { error: 'text or texts required' });
            const t0 = Date.now();
            const embed = await getEmbedder();
            let out;
            try {
                out = await embed(text.slice(0, 4000), { pooling: 'mean', normalize: true });
            }
            catch (e) {
                audit('EMBED-FAIL ' + ip + ' chars=' + text.length + ' ' + (Date.now() - t0) + 'ms ' + String(e.message).slice(0, 120));
                return json(res, 503, { error: 'embedding unavailable', detail: String(e.message).slice(0, 160) });
            }
            audit('EMBED ' + ip + ' chars=' + text.length + ' ' + (Date.now() - t0) + 'ms');
            return json(res, 200, { vector: Array.from(out.data), v: indexVersion().version });
        }
        return json(res, 404, { error: 'no such route' });
    }
    catch (e) {
        audit('ERROR ' + ip + ' ' + path + ' ' + String(e.message).slice(0, 120));
        return json(res, 500, { error: 'request failed' });
    }
};
const safeHandler = (req, res) => handler(req, res).catch((e) => {
    audit('ERROR-EARLY ' + (req.socket.remoteAddress || '?') + ' ' + String(e && e.message).slice(0, 120));
    try {
        if (!res.headersSent)
            json(res, 400, { error: 'bad request' });
        else
            res.end();
    }
    catch { }
});
const server = createServer(safeHandler);
const holderAnswers = (url) => new Promise((resolve) => {
    import(url.startsWith('https') ? 'node:https' : 'node:http').then(({ get }) => {
        const r = get(url, { rejectUnauthorized: false, timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
        r.on('timeout', () => { r.destroy(); resolve(false); });
        r.on('error', () => resolve(false));
    }).catch(() => resolve(false));
});
const takenOrRetry = async (what, healthUrl, retry, attempt) => {
    const tail = String.fromCharCode(10);
    for (let i = 0; i < 3; i++) {
        if (await holderAnswers(healthUrl)) {
            process.stdout.write('brain server ' + what + ' already listening and answering, another server serves this machine, exiting' + tail);
            process.exit(0);
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    if (attempt >= 30) {
        process.stdout.write('brain server ' + what + ': the port stayed taken by something that does not answer /health for 30 tries; exiting 1 so the task retries' + tail);
        process.exit(1);
    }
    process.stdout.write('brain server ' + what + ': the port is held by a copy that does not answer (a restart in progress?); trying again, ' + (attempt + 1) + tail);
    setTimeout(retry, 1000);
};
let plainAttempt = 0;
const host = PUBLIC ? '0.0.0.0' : '127.0.0.1';
server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        takenOrRetry('on ' + host + ':' + PORT, 'http://127.0.0.1:' + PORT + '/health', () => server.listen(PORT, host), plainAttempt++);
        return;
    }
    throw e;
});
function distFiles() {
    const list = ['server-cert.pem', 'server-endpoint.json', 'CLAUDE.md', 'REFLEX.md',
        'METHODOLOGIES.md', 'GOVERNANCE.md', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', '.mcp.json',
        'tools/subagent-rules.md', 'tools/agent-rules.md',
        'hooks/memory-instructions.md',
        'tools/email-blocks.html',
        'tools/release-signing-key.pub.pem'];
    for (const d of ['tools', 'hooks']) {
        let names = [];
        try {
            names = readdirSync(join(BRAIN, d));
        }
        catch {
            continue;
        }
        for (const n of names) {
            if (/\.(mjs|json|ps1|cmd)$/.test(n))
                list.push(d + '/' + n);
        }
    }
    list.push(...servedLayerFiles(BRAIN));
    return list;
}
let distCache = { at: 0, v: null };
function distVersion(maxAgeMs = 20000) {
    if (distCache.v && maxAgeMs > 0 && Date.now() - distCache.at < maxAgeMs)
        return distCache.v;
    const h = createHash('sha256');
    let n = 0;
    for (const rel of distFiles().sort()) {
        try {
            const st = statSync(join(BRAIN, rel));
            h.update(rel + ':' + st.size + ':' + Math.floor(st.mtimeMs) + '|');
            n += 1;
        }
        catch { }
    }
    distCache = { at: Date.now(), v: { version: h.digest('hex').slice(0, 16), files: n } };
    return distCache.v;
}
var serverAlerts = makeAlerts({
    send: (text, key) => {
        let to = '';
        try {
            const c = JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8'));
            if (typeof c.alertsTo === 'string' && c.alertsTo)
                to = c.alertsTo;
        }
        catch { }
        if (!to)
            return { sent: false, why: 'no alert address (brain.json alertsTo)' };
        return sendSystemMessage({ token: TOKEN, to, text, key, messagesUrl: messagesUrlOf(BRAIN) });
    },
    audit: (l) => audit(l),
});
const KEEPALIVE_MS = 45000;
const KEEPALIVE_TEXT = 'keepalive';
let keepaliveFailed = '';
async function touchModel(label) {
    try {
        const e = await getEmbedder();
        const t = Date.now();
        await e(KEEPALIVE_TEXT, { pooling: 'mean', normalize: true });
        if (keepaliveFailed)
            audit('KEEPALIVE-OK ' + label + ' after: ' + keepaliveFailed);
        keepaliveFailed = '';
        return Date.now() - t;
    }
    catch (err) {
        const why = String(err && err.message).slice(0, 80);
        if (why !== keepaliveFailed)
            audit('KEEPALIVE-FAIL ' + label + ' ' + why);
        keepaliveFailed = why;
        return null;
    }
}
resumeQueue();
if (ALLOW_PLAINTEXT)
    server.listen(PORT, host, () => {
        try {
            writeFileSync(join(BRAIN, '.server-alive.json'), JSON.stringify({ pid: process.pid, port: PORT, at: new Date().toISOString() }) + '\n', 'utf8');
        }
        catch { }
        process.stdout.write('brain server on ' + host + ':' + PORT
            + (PUBLIC ? '  PUBLIC, expose only behind a tunnel' : '  local only') + '\n');
        process.stdout.write('token file: ' + TOKEN_FILE + '\n');
        touchModel('boot').then((ms) => {
            if (ms != null)
                process.stdout.write('embedder warm, ' + ms + 'ms\n');
        });
        setInterval(() => { touchModel('tick'); }, KEEPALIVE_MS);
    });
{
    const decisionsPort = reviewPort(BRAIN);
    if (decisionsPort > 0) {
        startReviewListener({ brain: BRAIN, port: decisionsPort, getToken: () => TOKEN, keyFile: reviewKeyFile(CONFIG_DIR), audit, log: (l) => process.stdout.write(l + String.fromCharCode(10)) });
    }
}
function tailnetAddresses() {
    const out = [];
    for (const list of Object.values(networkInterfaces() || {})) {
        for (const a of (list || [])) {
            if (a.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address))
                out.push(a.address);
        }
    }
    return out;
}
if (PUBLIC && tailnetAddresses().length === 0) {
    process.stdout.write('WARNING: --public but no Tailscale address found yet, serving loopback only until one appears' + String.fromCharCode(10));
}
const TLS_PORT = Number(process.env.HAVOK_SERVER_TLS_PORT || 8443);
const TAILNET_POLL_MS = process.env.HAVOK_TAILNET_POLL_MS !== undefined ? Number(process.env.HAVOK_TAILNET_POLL_MS) : existsSync(join(BRAIN, '.tailnet-event')) ? 0 : 15000;
let tailnetSweep = null;
if (HAVE_TLS) {
    import('node:https').then(({ createServer: createHttps }) => {
        const opts = { key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) };
        const listenOn = (addr, onFail) => {
            const tls = createHttps(opts, safeHandler);
            let tlsAttempt = 0;
            tls.on('error', (e) => {
                const tail = String.fromCharCode(10);
                if (e && e.code === 'EADDRINUSE' && addr === '127.0.0.1' && (!ALLOW_PLAINTEXT || !process.env.HAVOK_SERVER_TLS_PORT)) {
                    takenOrRetry('TLS on ' + addr + ':' + TLS_PORT, 'https://127.0.0.1:' + TLS_PORT + '/health', () => tls.listen(TLS_PORT, addr), tlsAttempt++);
                    return;
                }
                if (e && e.code === 'EADDRINUSE') {
                    process.stdout.write('brain server TLS already listening on ' + addr + tail);
                    return;
                }
                process.stdout.write('brain server TLS failed on ' + addr + ': ' + String(e && e.message).slice(0, 120) + tail);
                if (onFail)
                    onFail(addr);
            });
            tls.listen(TLS_PORT, addr, () => {
                process.stdout.write('brain server TLS on ' + addr + ':' + TLS_PORT + String.fromCharCode(10));
            });
        };
        listenOn('127.0.0.1');
        const tailnet = watchTailnet({
            list: tailnetAddresses,
            intervalMs: TAILNET_POLL_MS,
            bind: (addr) => listenOn(addr, (a) => tailnet.forget(a)),
        });
        tailnetSweep = tailnet;
    }).catch(() => { });
}
else {
    process.stdout.write('NO TLS CERT, serving plaintext only. Generate one to encrypt the transport.\n');
}
