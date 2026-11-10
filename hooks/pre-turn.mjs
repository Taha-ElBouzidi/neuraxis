#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync, appendFileSync, unlinkSync, statSync, mkdirSync, readdirSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { terms as qterms } from '../tools/tokenize.mjs';
import { CONTEXT_CHARS, contextMessage, prepareQueries, translateSync } from '../tools/recall-turn.mjs';
import { reportFailure } from '../tools/brain-recover.mjs';
const PUBLIC_NAME = /^(neuraxis|infinite-context)$/;
import { execFileSync as execFileSyncRaw, spawn } from 'node:child_process';
let DEADLINE_HIT = false;
function execFileSync(file, args, opts = {}) {
    const left = msLeft();
    if (left < 150) {
        DEADLINE_HIT = true;
        throw new Error('hook deadline reached');
    }
    try {
        return execFileSyncRaw(file, args, { ...opts, timeout: Math.min(Number(opts.timeout) || left, left) });
    }
    catch (e) {
        if (msLeft() < 150)
            DEADLINE_HIT = true;
        throw e;
    }
}
const HOOK_STARTED = Date.now();
const SMART_COMPACTION = false;
const COMPACT_FROM = 300000;
const ALIVE = join(homedir(), '.claude', 'havok-embed.alive');
let LAST_SERVER_V = null;
let RATE_LIMITED = false;
let REMOTE = undefined;
const MISS = { remote: '', local: '' };
const msLeft = () => HOOK_LIMIT_MS - HOOK_MARGIN_MS - (Date.now() - HOOK_STARTED);
const EMBED_PORT = process.env.HAVOK_EMBED_PORT || 8477;
function skippedWhy() {
    const m = readRemoteDown();
    if (!m)
        return 'the brain server was skipped';
    const ago = Math.max(0, Math.round((Date.now() - m.at) / 1000));
    const left = Math.max(0, Math.round((DOWN_COOLDOWN_MS - (Date.now() - m.at)) / 1000));
    return 'the brain server failed ' + ago + ' s ago (' + m.reason + ') and is skipped for another ' + left + ' s';
}
function remoteFailWhy(e, elapsedMs, cfg, maxSec) {
    if (e instanceof SyntaxError)
        return 'the brain server answered with something that is not JSON';
    const timedOut = (e && e.code === 'ETIMEDOUT') || (e && e.status === 28);
    if (!timedOut)
        return 'the brain server call failed: ' + curlWhy(e);
    if (elapsedMs >= ((cfg && cfg.ct) || 1) * 1000 + 1000)
        return 'the brain server did not answer within ' + maxSec + ' s (busy, not off)';
    return 'the brain server did not take the connection within ' + ((cfg && cfg.ct) || 1) + ' s (busy, or down)';
}
let DAEMON_STATE = null;
function daemonState(brain) {
    if (DAEMON_STATE)
        return DAEMON_STATE;
    if (!holdsMemoriesLocally(brain) || !existsSync(join(brain, 'node_modules', '@xenova', 'transformers')))
        return (DAEMON_STATE = 'none');
    if (msLeft() < 1500)
        return 'unknown';
    let out = '';
    try {
        out = execFileSync('curl', ['-s', '-w', '\\n%{http_code} %{time_connect}', '--connect-timeout', '1', '--max-time', '1',
            'http://127.0.0.1:' + EMBED_PORT + '/health'], { encoding: 'utf8', windowsHide: true, timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] });
    }
    catch (e) {
        out = String((e && e.stdout) || '');
    }
    const [code, connect] = (out.trim().split('\n').pop() || '').split(' ');
    DAEMON_STATE = code === '200' ? 'up' : Number(connect) > 0 ? 'busy' : out ? 'down' : 'unknown';
    if (DAEMON_STATE === 'down')
        ensureEmbedDaemon(brain);
    return DAEMON_STATE;
}
function semanticMissNote(brain) {
    const why = [MISS.remote || (remoteRecentlyFailed() ? skippedWhy() : 'the brain server gave no usable answer')];
    const d = daemonState(brain);
    if (d === 'down')
        why.push('the local embed server is not running (nothing takes a connection on 127.0.0.1:' + EMBED_PORT + '). Start it: node tools/embed-server.mjs');
    else if (d === 'busy')
        why.push('the local embed server is running but busy (it took the connection and did not answer within 1 s)');
    else if (d === 'up' && MISS.local)
        why.push(MISS.local);
    return 'NOTE: semantic recall missed this turn, so the recall below is keyword only and a paraphrase may not match. Why: ' + why.join('; ') + '.';
}
const SERVER_TOKEN_FILE = join(homedir(), '.claude', 'havok-server-token');
const TOKEN_CACHE = join(homedir(), '.claude', 'havok-token-cache');
function remoteEmbedConfig(brain) {
    if (REMOTE !== undefined)
        return REMOTE;
    REMOTE = null;
    try {
        const ep = JSON.parse(readFileSync(join(brain, 'server-endpoint.json'), 'utf8'));
        if (!ep.url)
            return REMOTE;
        let url = ep.url;
        try {
            const host = String(JSON.parse(readFileSync(join(brain, 'vault-recipients.json'), 'utf8')).host || '').toUpperCase();
            const me = String(process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
            if (host && host === me)
                url = url.replace(/\/\/[^/:]+/, '//127.0.0.1');
        }
        catch { }
        let token = '';
        for (const f of [SERVER_TOKEN_FILE, TOKEN_CACHE]) {
            try {
                token = readFileSync(f, 'utf8').trim();
            }
            catch { }
            if (token)
                break;
        }
        if (!token) {
            token = execFileSync(process.execPath, [join(brain, 'tools', 'vault.mjs'), 'get', 'havok_server_token'], { encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            if (token) {
                try {
                    writeFileSync(TOKEN_CACHE, token, { encoding: 'utf8', mode: 0o600 });
                }
                catch { }
            }
        }
        let cacert = '';
        if (/^https:/i.test(url)) {
            const c = join(brain, 'server-cert.pem');
            if (existsSync(c))
                cacert = c.replace(/\\/g, '/');
        }
        let connectTo = '';
        try {
            const ep2 = JSON.parse(readFileSync(join(brain, 'server-endpoint.json'), 'utf8'));
            const magic = (ep2.tailnet && ep2.tailnet.magicdns) || '';
            const m = url.match(/^https?:\/\/([^:\/]+)(?::(\d+))?/);
            if (magic && m && /^[0-9.]+$/.test(m[1]) && m[1] !== '127.0.0.1') {
                connectTo = magic + ':' + m[2] + ':' + m[1] + ':' + m[2];
                url = 'https://' + magic + (m[2] ? ':' + m[2] : '');
            }
        }
        catch { }
        const ct = connectTo ? 4 : 1;
        if (token)
            REMOTE = { url, token, cacert, connectTo, ct };
    }
    catch { }
    return REMOTE;
}
function forgetCachedToken() {
    try {
        unlinkSync(TOKEN_CACHE);
    }
    catch { }
}
function fetchRulesRemote(brain) {
    if (remoteRecentlyFailed())
        return null;
    const cfg = remoteEmbedConfig(brain);
    if (!cfg)
        return null;
    try {
        const conf = 'header = "Authorization: Bearer ' + cfg.token + '"' + '\n'
            + (cfg.cacert ? 'cacert = "' + cfg.cacert + '"' + '\n' : '')
            + (cfg.connectTo ? 'connect-to = "' + cfg.connectTo + '"' + '\n' : '')
            + 'url = "' + cfg.url + '/rules"' + '\n'
            + 'silent' + '\n' + 'connect-timeout = ' + cfg.ct + '\n' + 'max-time = 6' + '\n';
        const out = curlRemote(conf, 6000, cfg);
        const parsed = JSON.parse(out || '{}');
        if (Array.isArray(parsed.rules) && parsed.rules.length) {
            try {
                writeFileSync(RULES_CACHE, JSON.stringify({ at: new Date().toISOString(), rules: parsed.rules }), 'utf8');
            }
            catch { }
            return parsed.rules;
        }
        return null;
    }
    catch (e) {
        if (!(e instanceof SyntaxError))
            markRemoteDown(curlWhy(e));
        return null;
    }
}
const RULES_CACHE = resolve(process.env.HAVOK_HOME || resolve(homedir(), '.claude'), 'havok-rules-cache.json');
function cachedRules() {
    try {
        const c = JSON.parse(readFileSync(RULES_CACHE, 'utf8'));
        return Array.isArray(c.rules) && c.rules.length ? c.rules : null;
    }
    catch {
        return null;
    }
}
const REMOTE_DOWN = join(process.env.HAVOK_HOME || join(homedir(), '.claude'), 'havok-remote-embed-down');
const DOWN_COOLDOWN_MS = 3 * 60 * 1000;
const HOOK_LIMIT_MS = Number(process.env.HAVOK_PRETURN_LIMIT_MS) || 5000;
const HOOK_MARGIN_MS = 500;
function curlRemote(conf, timeoutMs, cfg) {
    const t0 = Date.now();
    try {
        return execFileSync('curl', ['-K', '-'], {
            input: conf, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, stdio: ['pipe', 'pipe', 'ignore'],
        });
    }
    catch (e) {
        const inConnectPhase = typeof e.status === 'number' && Date.now() - t0 < ((cfg && cfg.ct) || 1) * 1000 + 1000;
        const leftMs = HOOK_LIMIT_MS - HOOK_MARGIN_MS - (Date.now() - HOOK_STARTED);
        const leftSec = Math.floor(leftMs / 1000);
        if (!inConnectPhase || !(cfg && cfg.connectTo) || leftSec < 1)
            throw e;
        const retry = conf
            .replace(/connect-timeout = \d+/, 'connect-timeout = ' + Math.min(cfg.ct, leftSec))
            .replace(/max-time = \d+/, 'max-time = ' + leftSec);
        return execFileSync('curl', ['-K', '-'], {
            input: retry, encoding: 'utf8', windowsHide: true, timeout: Math.min(timeoutMs, leftMs), stdio: ['pipe', 'pipe', 'ignore'],
        });
    }
}
function curlWhy(e) {
    if (e instanceof SyntaxError)
        return 'the server answered with something that is not JSON';
    if (e && e.code === 'ENOENT')
        return 'curl not found on this machine';
    if (e && e.code === 'ETIMEDOUT')
        return 'the hook stopped waiting for curl';
    const reasons = {
        6: 'could not resolve the server name',
        7: 'could not connect (refused, or no route)',
        28: 'timed out (connect or answer)',
        35: 'TLS handshake failed',
        52: 'the server closed the connection with no answer',
        56: 'the connection was reset while receiving',
        60: 'server certificate not trusted',
        77: 'could not read the CA certificate file',
    };
    const status = e && e.status;
    return typeof status === 'number' ? (reasons[status] || 'curl exit ' + status) : 'unknown failure';
}
function readRemoteDown() {
    try {
        const raw = readFileSync(REMOTE_DOWN, 'utf8').trim();
        if (/^\d+$/.test(raw))
            return { at: Number(raw), reason: 'unknown (written before reasons were recorded)' };
        const j = JSON.parse(raw);
        return { at: Number(j.at), reason: String(j.reason || 'unknown') };
    }
    catch {
        return null;
    }
}
function remoteRecentlyFailed() {
    const m = readRemoteDown();
    if (!m || !Number.isFinite(m.at))
        return false;
    const age = Date.now() - m.at;
    return age >= 0 && age < DOWN_COOLDOWN_MS;
}
function fetchVectorRemote(text, brain) {
    if (remoteRecentlyFailed())
        return null;
    const cfg = remoteEmbedConfig(brain);
    if (!cfg)
        return null;
    try {
        const conf = 'header = "content-type: application/json"' + '\n'
            + 'header = "Authorization: Bearer ' + cfg.token + '"' + '\n'
            + (cfg.cacert ? 'cacert = "' + cfg.cacert + '"' + '\n' : '')
            + (cfg.connectTo ? 'connect-to = "' + cfg.connectTo + '"' + '\n' : '')
            + 'url = "' + cfg.url + '/embed"' + '\n'
            + 'request = "POST"' + '\n'
            + 'data-binary = "' + JSON.stringify({ text }).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' + '\n'
            + 'silent' + '\n' + 'connect-timeout = ' + cfg.ct + '\n' + 'max-time = 6' + '\n';
        const out = curlRemote(conf, 5000, cfg);
        const parsedOne = JSON.parse(out || '{}');
        if (parsedOne.v)
            LAST_SERVER_V = parsedOne.v;
        const v = parsedOne.vector;
        if (Array.isArray(v)) {
            try {
                unlinkSync(REMOTE_DOWN);
            }
            catch { }
            return v;
        }
        if (parsedOne.error === 'too many requests') {
            RATE_LIMITED = true;
            return null;
        }
        if (parsedOne.error === 'unauthorized')
            forgetCachedToken();
        markRemoteDown('server answered without a vector, likely an expired or wrong token');
        return null;
    }
    catch (e) {
        markRemoteDown('embed failed: ' + curlWhy(e));
        return null;
    }
}
function fetchVectorsRemote(texts, brain) {
    if (remoteRecentlyFailed())
        return null;
    const cfg = remoteEmbedConfig(brain);
    if (!cfg)
        return null;
    try {
        const conf = 'header = "content-type: application/json"' + '\n'
            + 'header = "Authorization: Bearer ' + cfg.token + '"' + '\n'
            + (cfg.cacert ? 'cacert = "' + cfg.cacert + '"' + '\n' : '')
            + (cfg.connectTo ? 'connect-to = "' + cfg.connectTo + '"' + '\n' : '')
            + 'url = "' + cfg.url + '/embed"' + '\n'
            + 'request = "POST"' + '\n'
            + 'data-binary = "' + JSON.stringify({ texts }).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' + '\n'
            + 'silent' + '\n' + 'connect-timeout = ' + cfg.ct + '\n' + 'max-time = 9' + '\n';
        const out = curlRemote(conf, 9000, cfg);
        const parsed = JSON.parse(out || '{}');
        if (parsed.v)
            LAST_SERVER_V = parsed.v;
        const vs = parsed.vectors;
        if (Array.isArray(vs) && vs.length) {
            try {
                unlinkSync(REMOTE_DOWN);
            }
            catch { }
            return vs;
        }
        if (parsed.error === 'too many requests') {
            RATE_LIMITED = true;
            return null;
        }
        if (parsed.error === 'unauthorized')
            forgetCachedToken();
        markRemoteDown('server answered without vectors, likely an expired or wrong token');
        return null;
    }
    catch (e) {
        markRemoteDown('batch embed failed: ' + curlWhy(e));
        return null;
    }
}
function postPulse(hits, brain) {
    if (!hits.length)
        return;
    postJson('/pulse', { at: Date.now(), host: hostname(), slugs: hits.map((h) => h.slug), how: hits.map((h) => h.how) }, brain);
}
function postJson(route, body, brain) {
    try {
        const cfg = remoteEmbedConfig(brain);
        if (!cfg)
            return;
        const payload = JSON.stringify(body);
        const conf = 'header = "content-type: application/json"' + '\n'
            + 'header = "Authorization: Bearer ' + cfg.token + '"' + '\n'
            + (cfg.cacert ? 'cacert = "' + cfg.cacert + '"' + '\n' : '')
            + (cfg.connectTo ? 'connect-to = "' + cfg.connectTo + '"' + '\n' : '')
            + 'url = "' + cfg.url + route + '"' + '\n'
            + 'request = "POST"' + '\n'
            + 'data-binary = "' + payload.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' + '\n'
            + 'silent' + '\n' + 'output = "' + (process.platform === 'win32' ? 'NUL' : '/dev/null') + '"' + '\n'
            + 'connect-timeout = ' + cfg.ct + '\n' + 'max-time = 6' + '\n';
        const dir = join(brain, '.pulse-tmp');
        try {
            mkdirSync(dir, { recursive: true });
        }
        catch { }
        try {
            const cutoff = Date.now() - 5 * 60 * 1000;
            for (const f of readdirSync(dir)) {
                const full = join(dir, f);
                try {
                    if (statSync(full).mtimeMs < cutoff)
                        unlinkSync(full);
                }
                catch { }
            }
        }
        catch { }
        const file = join(dir, 'p' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.conf');
        writeFileSync(file, conf, { encoding: 'utf8', mode: 0o600 });
        const child = spawn('curl', ['-K', file], { stdio: 'ignore', windowsHide: true, detached: true });
        child.on('error', () => { });
        child.unref();
    }
    catch { }
}
function holdsMemoriesLocally(brain) {
    try {
        return readdirSync(join(brain, 'memory')).some((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    }
    catch {
        return false;
    }
}
function fetchRecallLocal(prompt, queries, brain, parts = 0, contextIndex = -1) {
    if (!existsSync(ALIVE) && daemonState(brain) !== 'up')
        return null;
    const budget = Math.min(6, Math.floor(msLeft() / 1000));
    if (budget < 1) {
        MISS.local = 'no time was left to ask the local embed server';
        return null;
    }
    try {
        const out = execFileSync("curl", [
            "-s", "--connect-timeout", "1", "--max-time", String(budget), "-X", "POST",
            "http://127.0.0.1:" + EMBED_PORT + "/recall",
            "-H", "content-type: application/json",
            "--data-binary", "@-",
        ], {
            input: Buffer.from(JSON.stringify({ brain, prompt: String(prompt).slice(0, 20000), queries, parts, contextIndex }), "utf8"),
            encoding: "utf8", timeout: budget * 1000 + 500, stdio: ["pipe", "pipe", "ignore"],
        });
        const parsed = JSON.parse(out || "{}");
        if (Array.isArray(parsed.ranked))
            return parsed.ranked;
        MISS.local = 'the local embed server answered without a result (' + String(parsed.error || 'no ranked list').slice(0, 60) + ')';
        return null;
    }
    catch {
        MISS.local = 'the local embed server did not answer its recall within ' + budget + ' s';
        return null;
    }
}
let SERVER_NOTE = '';
function fetchRecallRemote(prompt, queries, brain, parts = 0, contextIndex = -1) {
    if (remoteRecentlyFailed()) {
        MISS.remote = skippedWhy();
        return null;
    }
    const cfg = remoteEmbedConfig(brain);
    if (!cfg) {
        MISS.remote = 'this machine has no brain server address or token';
        return null;
    }
    const t0 = Date.now();
    try {
        const payload = JSON.stringify({
            prompt: String(prompt).slice(0, 20000),
            queries,
            parts,
            contextIndex,
            bodies: !holdsMemoriesLocally(brain),
        });
        const conf = 'header = "content-type: application/json"' + '\n'
            + 'header = "Authorization: Bearer ' + cfg.token + '"' + '\n'
            + (cfg.cacert ? 'cacert = "' + cfg.cacert + '"' + '\n' : '')
            + (cfg.connectTo ? 'connect-to = "' + cfg.connectTo + '"' + '\n' : '')
            + 'url = "' + cfg.url + '/recall"' + '\n'
            + 'request = "POST"' + '\n'
            + 'data-binary = "' + payload.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"' + '\n'
            + 'silent' + '\n' + 'connect-timeout = ' + cfg.ct + '\n' + 'max-time = 9' + '\n';
        let parsed = JSON.parse(curlRemote(conf, 9000, cfg) || '{}');
        if (parsed.error === 'too many requests') {
            execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1200)'], { windowsHide: true });
            parsed = JSON.parse(curlRemote(conf, 9000, cfg) || '{}');
            if (parsed.error === 'too many requests') {
                RATE_LIMITED = true;
                MISS.remote = 'the brain server refused this turn as rate limited (too many requests from this machine in the last minute), ask again in a minute';
                return null;
            }
        }
        if (parsed.v)
            LAST_SERVER_V = parsed.v;
        if (!Array.isArray(parsed.ranked)) {
            MISS.remote = 'the brain server answered without a result (' + String(parsed.error || 'no ranked list').slice(0, 60) + ')';
            return null;
        }
        try {
            unlinkSync(REMOTE_DOWN);
        }
        catch { }
        SERVER_NOTE = typeof parsed.note === 'string' ? parsed.note.slice(0, 400) : '';
        return parsed.ranked;
    }
    catch (e) {
        MISS.remote = remoteFailWhy(e, Date.now() - t0, cfg, 9);
        markRemoteDown('recall failed: ' + MISS.remote.replace(/^the brain server /, ''));
        return null;
    }
}
const SYNC_LOCK = join(homedir(), '.claude', 'havok-index-syncing');
let localVersionCache = null;
function localIndexVersion(brain) {
    const names = ['keywords.json', 'embeddings.json', 'rules.json', 'contact.md', 'feedback.md', 'project.md', 'reference.md', 'user.md', 'translate-system.txt'];
    const stat = [];
    for (const n of names) {
        try {
            const st = statSync(join(brain, 'index', n));
            stat.push(n + ':' + st.size + ':' + Math.floor(st.mtimeMs));
        }
        catch { }
    }
    const key = stat.join('|');
    if (localVersionCache && localVersionCache.key === key)
        return localVersionCache.version;
    const whole = createHash('sha256');
    for (const n of names) {
        try {
            whole.update(n + ':' + createHash('sha256').update(readFileSync(join(brain, 'index', n))).digest('hex').slice(0, 16) + '|');
        }
        catch { }
    }
    const version = whole.digest('hex').slice(0, 16);
    localVersionCache = { key, version };
    return version;
}
function repairIndexInBackground(serverVersion, brain) {
    if (!serverVersion)
        return null;
    let mine;
    try {
        mine = localIndexVersion(brain);
    }
    catch {
        return null;
    }
    if (mine === serverVersion)
        return null;
    try {
        const age = Date.now() - Number(readFileSync(SYNC_LOCK, 'utf8').trim());
        if (age >= 0 && age < 5 * 60 * 1000)
            return 'already refreshing';
    }
    catch { }
    try {
        writeFileSync(SYNC_LOCK, String(Date.now()), 'utf8');
    }
    catch { }
    try {
        const child = spawn(process.execPath, [join(brain, 'tools', 'brain-sync.mjs'), '--quiet'], {
            detached: true, stdio: 'ignore', cwd: brain,
        });
        child.unref();
    }
    catch {
        return null;
    }
    return 'refreshing';
}
let RECOVER_BRAIN = null;
function markRemoteDown(reason) {
    if (/hook deadline reached/.test(String(reason)))
        return;
    try {
        writeFileSync(REMOTE_DOWN, JSON.stringify({ at: Date.now(), reason: reason || 'unknown' }), 'utf8');
    }
    catch { }
    if (RECOVER_BRAIN && !/rate limited|token/i.test(String(reason)))
        reportFailure('brain', 'pre-turn: ' + String(reason || 'unknown').slice(0, 160), RECOVER_BRAIN);
}
const EMBED_LOCK = resolve(homedir(), '.claude', 'havok-embed-starting');
function ensureEmbedDaemon(brain) {
    try {
        if (!existsSync(join(brain, 'node_modules', '@xenova', 'transformers')))
            return;
        if (!existsSync(join(brain, 'tools', 'embed-server.mjs')))
            return;
        try {
            const age = Date.now() - Number(readFileSync(EMBED_LOCK, 'utf8').trim());
            if (age >= 0 && age < 5 * 60 * 1000)
                return;
        }
        catch { }
        writeFileSync(EMBED_LOCK, String(Date.now()), 'utf8');
        const child = spawn(process.execPath, [join(brain, 'tools', 'embed-server.mjs')], { detached: true, stdio: 'ignore', cwd: brain, windowsHide: true });
        child.unref();
    }
    catch { }
}
const SERVER_LOCK = resolve(homedir(), '.claude', 'havok-server-starting');
function ensureLocalServer(brain) {
    try {
        let cfg = {};
        try {
            cfg = JSON.parse(readFileSync(join(brain, 'brain.json'), 'utf8'));
        }
        catch {
            return;
        }
        if (cfg.localServer !== true || !existsSync(join(brain, 'tools', 'brain-server.mjs')))
            return;
        try {
            const alive = JSON.parse(readFileSync(join(brain, '.server-alive.json'), 'utf8'));
            if (alive && Number.isInteger(alive.pid) && alive.pid > 0) {
                process.kill(alive.pid, 0);
                return;
            }
        }
        catch { }
        try {
            const age = Date.now() - Number(readFileSync(SERVER_LOCK, 'utf8').trim());
            if (age >= 0 && age < 5 * 60 * 1000)
                return;
        }
        catch { }
        writeFileSync(SERVER_LOCK, String(Date.now()), 'utf8');
        const env = { ...process.env, HAVOK_LAYERS_DIR: process.env.HAVOK_LAYERS_DIR || join(brain, 'layers') };
        const child = spawn(process.execPath, [join(brain, 'tools', 'brain-server.mjs')], { detached: true, stdio: 'ignore', cwd: brain, windowsHide: true, env });
        child.unref();
    }
    catch { }
}
function fetchVectorSync(text, brain) {
    if (!existsSync(ALIVE)) {
        ensureEmbedDaemon(brain);
        return fetchVectorRemote(text, brain);
    }
    try {
        const out = execFileSync("curl", [
            "-s", "--connect-timeout", "1", "--max-time", "3", "-X", "POST",
            "http://127.0.0.1:" + (process.env.HAVOK_EMBED_PORT || 8477) + "/embed",
            "-H", "content-type: application/json",
            "--data-binary", "@-",
        ], {
            input: Buffer.from(JSON.stringify({ text }), "utf8"),
            encoding: "utf8", timeout: 3500, stdio: ["pipe", "pipe", "ignore"],
        });
        const v = JSON.parse(out || "{}").vector;
        if (Array.isArray(v))
            return v;
        ensureEmbedDaemon(brain);
        return fetchVectorRemote(text, brain);
    }
    catch {
        ensureEmbedDaemon(brain);
        return fetchVectorRemote(text, brain);
    }
}
export function pluginEntryStandsDown(home = process.env.HAVOK_HOME || resolve(homedir(), '.claude')) {
    try {
        const st = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
        const groups = st?.hooks?.UserPromptSubmit;
        if (Array.isArray(groups) && groups.some((g) => (g?.hooks || []).some((h) => /pre-turn\.mjs/.test(String(h?.command || '')))))
            return true;
    }
    catch { }
    return false;
}
const ok = (ctx) => {
    if (ctx) {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx },
        }));
    }
    process.exit(0);
};
const TAIL_START = 1 << 20;
const TAIL_MAX = 64 << 20;
function tailLines(tp, enough) {
    const fd = openSync(tp, "r");
    try {
        const size = fstatSync(fd).size;
        for (let want = TAIL_START;; want *= 4) {
            const len = Math.min(want, size);
            const buf = Buffer.alloc(len);
            readSync(fd, buf, 0, len, size - len);
            let lines = buf.toString("utf8").split(String.fromCharCode(10));
            if (len < size)
                lines = lines.slice(1);
            lines = lines.filter(Boolean);
            if (enough(lines) || len >= size || want >= TAIL_MAX)
                return lines;
        }
    }
    finally {
        closeSync(fd);
    }
}
function readRecentContext(payload) {
    try {
        if (payload && typeof payload.context === "string" && payload.context.trim()) {
            return payload.context.slice(-CONTEXT_CHARS);
        }
        const tp = payload && payload.transcript_path;
        if (!tp || !existsSync(tp))
            return "";
        let msgs = [];
        tailLines(tp, (lines) => (msgs = recentMessages(lines)).join(" ").length >= CONTEXT_CHARS * 2);
        return msgs.join(" ").slice(-CONTEXT_CHARS);
    }
    catch {
        return "";
    }
}
function recentMessages(lines) {
    const msgs = [];
    for (let i = lines.length - 1; i >= 0 && msgs.join(" ").length < CONTEXT_CHARS * 2; i -= 1) {
        let o = null;
        try {
            o = JSON.parse(lines[i]);
        }
        catch {
            continue;
        }
        const role = o && o.message && o.message.role;
        if (role !== "user" && role !== "assistant")
            continue;
        const c = o.message.content;
        let text = "";
        if (typeof c === "string")
            text = c;
        else if (Array.isArray(c))
            text = c.filter((p) => p && p.type === "text").map((p) => p.text).join(" ");
        const m = contextMessage(text);
        if (m)
            msgs.unshift(m);
    }
    return msgs;
}
try {
    if (process.argv.includes('--from-plugin') && pluginEntryStandsDown())
        ok('');
    const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const marker = (() => {
        try {
            return readFileSync(resolve(process.env.HAVOK_HOME || resolve(homedir(), '.claude'), 'havok-brain-path'), 'utf8').trim();
        }
        catch {
            return null;
        }
    })();
    const isBrain = (p) => {
        try {
            return !!p && existsSync(join(p, 'memory'))
                && existsSync(join(p, 'REFLEX.md'));
        }
        catch {
            return false;
        }
    };
    const BRAIN = [process.env.HAVOK_BRAIN, HERE, marker].find(isBrain) || HERE;
    RECOVER_BRAIN = BRAIN;
    ensureLocalServer(BRAIN);
    let raw = '';
    try {
        raw = readFileSync(0, 'utf8');
    }
    catch { }
    let prompt = '';
    let payload = {};
    try {
        payload = JSON.parse(raw || '{}');
        prompt = String(payload.prompt || '');
    }
    catch {
        prompt = raw;
    }
    if (!prompt.trim())
        ok('');
    if (prompt.trim() === 'keep-warm ping')
        ok('');
    const systemEvent = prompt.trimStart().startsWith('<task-notification>') || prompt.includes('[SYSTEM NOTIFICATION - NOT USER INPUT]');
    const recentContext = readRecentContext(payload);
    const head = prompt.slice(0, 2000).toLowerCase();
    const out = [];
    const DEPTH = /\b(plan|analys|analyz|compare|comparison|tradeoff|trade-off|pros and cons|options|design|architect|audit|review|brainstorm|exhaust|research|investigate|walk me through|explain why|deep dive|strategy|roadmap)\b/;
    const ACTION = /^(log|add|send|set|update|delete|remove|fix|change|rename|commit|push|run|start|stop|restart|check)\b|\bi (ate|drank|paid|bought|spent|weigh)\b/;
    let OWNER = process.env.HAVOK_OWNER || "";
    let PRONOUN = process.env.HAVOK_OWNER_PRONOUN || "";
    try {
        const cfg = JSON.parse(readFileSync(join(BRAIN, "brain.json"), "utf8"));
        OWNER = OWNER || cfg.owner || "";
        PRONOUN = PRONOUN || cfg.pronoun || "";
    }
    catch { }
    const WHO = OWNER ? ("TO " + OWNER.toUpperCase()) : "TO THE USER";
    const THEY = PRONOUN || "they";
    const CAP = THEY.charAt(0).toUpperCase() + THEY.slice(1);
    let tier;
    if (DEPTH.test(head)) {
        tier = CAP + ' asked for depth here, so take the room you need for the substance. The cuts below still apply.';
    }
    else if (ACTION.test(head)) {
        tier = CAP + ' asked you to DO something. Say it is done and give the numbers that changed, plus anything that surprised you while doing it.';
    }
    else {
        tier = CAP + ' asked a question. Answer it and stop.';
    }
    let rulesMode = 'auto';
    try {
        rulesMode = JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).rulesMode || 'auto';
    }
    catch { }
    if (process.env.HAVOK_RULES_MODE)
        rulesMode = process.env.HAVOK_RULES_MODE;
    let turnNo = 1;
    const sid = payload && payload.session_id && /^[A-Za-z0-9_-]{6,80}$/.test(String(payload.session_id)) ? String(payload.session_id) : null;
    if (sid) {
        const turnFile = join(homedir(), '.claude', 'havok-recall-shown', sid + '.turns');
        try {
            turnNo = Number(readFileSync(turnFile, 'utf8')) + 1 || 1;
        }
        catch {
            turnNo = 1;
        }
        try {
            mkdirSync(dirname(turnFile), { recursive: true });
            writeFileSync(turnFile, String(turnNo));
        }
        catch { }
    }
    const fullRules = rulesMode === 'full' || (rulesMode === 'auto' && (turnNo % 10) === 1);
    out.push(fullRules
        ? 'HOW TO REPLY ' + WHO + '. Generated from the brain, delivered every turn because a rule loaded'
        : 'HOW TO REPLY ' + WHO + ' (short form; the full text comes every 10th message).', ...(fullRules ? ['once at session start loses to recency by turn fifty.', ''] : []), '1. ' + tier);
    let rules = null;
    try {
        rules = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules || [];
    }
    catch {
        rules = null;
    }
    if (!rules || !rules.length)
        rules = fetchRulesRemote(BRAIN);
    let rulesFromCache = false;
    if (!rules || !rules.length) {
        rules = cachedRules();
        rulesFromCache = Boolean(rules);
    }
    if (rulesFromCache)
        out.push('(brain rules from this machine\'s last copy: the brain server did not answer this turn.)');
    const matchesTopic = (r) => { if (!r.when)
        return true; try {
        return new RegExp(r.when, 'i').test(prompt);
    }
    catch {
        return true;
    } };
    if (rules && rules.length)
        rules = rules.filter(matchesTopic);
    if (rules && rules.length) {
        rules.forEach((r, i) => out.push(`${i + 2}. ${fullRules || !r.short ? r.rule : r.short}`));
    }
    else {
        out.push('(brain rules unavailable: no local index/rules.json and the brain server could not be'
            + ' reached. You are running with almost no behaviour rules. Tell the person before answering.)');
    }
    try {
        const { planOf, planLine } = await import('./plan-rules.mjs');
        let cfg = {};
        try {
            cfg = JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8'));
        }
        catch { }
        let pub = false;
        try {
            pub = PUBLIC_NAME.test(JSON.parse(readFileSync(join(BRAIN, 'package.json'), 'utf8')).name);
        }
        catch { }
        const line = planLine(planOf(cfg, pub));
        if (line)
            out.push('', line);
    }
    catch { }
    const idxPath = join(BRAIN, 'index', 'keywords.json');
    const idx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : null;
    {
        let denseRanked = [];
        let denseNote = "";
        let serverRanked = null;
        try {
            const embPath = join(BRAIN, "index", "embeddings.json");
            const emb = existsSync(embPath) ? JSON.parse(readFileSync(embPath, "utf8")) : null;
            {
                const prep = prepareQueries(prompt, recentContext, { translate: (t) => translateSync(t, BRAIN) });
                const { hasArabic, baseQueries, queries, translationFailed } = prep;
                if (prep.note)
                    denseNote = prep.note;
                if (!translationFailed && !systemEvent)
                    serverRanked = fetchRecallRemote(prompt, queries, BRAIN, baseQueries.length - 1, queries.length > baseQueries.length ? baseQueries.length : -1);
                if (serverRanked && SERVER_NOTE)
                    denseNote = (denseNote ? denseNote + ' ' : '') + SERVER_NOTE;
                if (!serverRanked && !translationFailed && !systemEvent && holdsMemoriesLocally(BRAIN))
                    serverRanked = fetchRecallLocal(prompt, queries, BRAIN, baseQueries.length - 1, queries.length > baseQueries.length ? baseQueries.length : -1);
                let vecs = [];
                if (serverRanked || translationFailed || systemEvent) {
                }
                else if (!emb) {
                    denseNote = semanticMissNote(BRAIN) + ' This machine holds no embeddings index of its own to fall back on.';
                }
                else if (msLeft() < 4000) {
                }
                else if (queries.length > 1 && !existsSync(ALIVE)) {
                    const batch = fetchVectorsRemote(queries, BRAIN);
                    if (batch)
                        vecs = batch.filter((v) => Array.isArray(v) && v.length === emb.dims);
                }
                else {
                    for (const q of queries) {
                        const v = fetchVectorSync(q, BRAIN);
                        if (v && v.length === emb.dims)
                            vecs.push(v);
                        else if (!v)
                            break;
                    }
                }
                const vec = vecs[0] || null;
                if (vecs.length) {
                    const best = new Float64Array(emb.slugs.length).fill(-Infinity);
                    for (const q of vecs) {
                        for (let i2 = 0; i2 < emb.slugs.length; i2++) {
                            const v = emb.vectors[i2];
                            let dot = 0;
                            for (let k = 0; k < v.length; k++)
                                dot += q[k] * v[k];
                            if (dot > best[i2])
                                best[i2] = dot;
                        }
                    }
                    denseRanked = emb.slugs
                        .map((s, i2) => [s, best[i2]])
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 20);
                }
                else if (!vec && !hasArabic && !serverRanked && !systemEvent) {
                    denseNote = semanticMissNote(BRAIN);
                }
                const refreshing = holdsMemoriesLocally(BRAIN) ? repairIndexInBackground(LAST_SERVER_V, BRAIN) : null;
                if (refreshing === 'refreshing') {
                    denseNote = (denseNote ? denseNote + ' ' : '')
                        + 'NOTE: this machine index was behind the server and is refreshing in the background. '
                        + 'The memories below came from the older copy; ask again if something looks missing.';
                }
            }
        }
        catch (e) {
            denseNote = "NOTE: semantic recall missed this turn because of an error inside the recall hook (" + String((e && e.message) || e).slice(0, 120) + "). Keyword only.";
        }
        const sparseSource = recentContext ? (recentContext + " " + prompt) : prompt;
        const words = new Set(qterms(sparseSource.slice(0, 20000).toLowerCase()));
        const score = new Map();
        for (const w of words) {
            const slugs = idx ? idx.terms[w] : null;
            if (!slugs)
                continue;
            const weight = 1 / slugs.length;
            for (const s of slugs)
                score.set(s, (score.get(s) || 0) + weight);
        }
        const sparseRanked = [...score.entries()]
            .filter(([, v]) => v >= Number(process.env.RECALL_MIN || 0.10))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20);
        const RRF_K = 60;
        const fused = new Map();
        sparseRanked.forEach(([slug], r) => fused.set(slug, (fused.get(slug) || 0) + 1 / (RRF_K + r + 1)));
        denseRanked.forEach(([slug], r) => fused.set(slug, (fused.get(slug) || 0) + 1 / (RRF_K + r + 1)));
        const localRanked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        const bySparse = new Set(sparseRanked.map(([s]) => s));
        const byDense = new Set(denseRanked.map(([s]) => s));
        const hits = systemEvent ? [] : serverRanked
            ? serverRanked.filter((m) => m && m.slug).map((m) => ({
                slug: m.slug, how: m.how || 'both', description: m.description || '',
                body: m.body || '', chars: m.chars || 0, truncated: !!m.truncated,
            }))
            : localRanked.map(([slug]) => ({
                slug,
                how: bySparse.has(slug) && byDense.has(slug) ? 'both' : byDense.has(slug) ? 'meaning' : 'keyword',
                description: (idx && idx.descriptions[slug]) || '',
            }));
        try {
            const PULSE = join(BRAIN, '.recall-pulse.jsonl');
            appendFileSync(PULSE, JSON.stringify({
                at: Date.now(), host: hostname(), slugs: hits.map((h) => h.slug), how: hits.map((h) => h.how),
            }) + '\n', 'utf8');
            const lines = readFileSync(PULSE, 'utf8').split('\n').filter(Boolean);
            if (lines.length > 400)
                writeFileSync(PULSE, lines.slice(-300).join('\n') + '\n', 'utf8');
        }
        catch { }
        postPulse(hits, BRAIN);
        try {
            const al = JSON.parse(readFileSync(join(BRAIN, '.brain-alerts.json'), 'utf8')).alerts || {};
            const cutoff = Date.now() - 6 * 3600 * 1000;
            const live = Object.values(al).filter((a) => a && Date.parse(a.firstSeen) > cutoff);
            if (live.length) {
                const shown = live.slice(0, 3);
                out.push('', 'BRAIN RESULTS, ' + live.length + ' condition(s) flagged by the analyzer. For YOU to keep an eye on: check, act if it is yours, and do NOT raise it with the person unless it changes what he would do.');
                for (const a of shown)
                    out.push('  ' + a.text + '   (since ' + String(a.firstSeen).slice(11, 16) + ' UTC)');
                if (live.length > shown.length)
                    out.push('  and ' + (live.length - shown.length) + ' more in .brain-alerts.json');
            }
        }
        catch { }
        if (denseNote && !hits.length)
            out.push("", denseNote);
        if (hits.length) {
            const memPath = (slug) => join(BRAIN, 'memory', slug + '.md').replace(/\\/g, '/');
            const shownFile = payload && payload.session_id && /^[A-Za-z0-9_-]{6,80}$/.test(String(payload.session_id))
                ? join(homedir(), '.claude', 'havok-recall-shown', String(payload.session_id) + '.json') : null;
            let shown = [];
            try {
                if (shownFile)
                    shown = JSON.parse(readFileSync(shownFile, 'utf8'));
            }
            catch { }
            const shownSet = new Set(shown);
            const cut = (s, n) => { const x = String(s || ''); return x.length <= n ? x : x.slice(0, n).replace(/\s+\S*$/, '') + '...'; };
            out.push('', `BRAIN RECALL: ${hits.length} memories (${holdsMemoriesLocally(BRAIN) ? 'files: ' + join(BRAIN, 'memory').split(String.fromCharCode(92)).join('/') + '/<name>.md' : 'on the brain server only; open one with node tools/brain-client.mjs read <slug>'}). `
                + 'These lines only say which files are worth opening, never what they say: open the relevant ones before answering.', ...(denseNote ? [denseNote] : []));
            const again = hits.filter((h) => shownSet.has(h.slug) && existsSync(memPath(h.slug))).map((h) => h.slug);
            try {
                if (shownFile) {
                    mkdirSync(dirname(shownFile), { recursive: true });
                    writeFileSync(shownFile, JSON.stringify([...new Set([...shown, ...hits.map((h) => h.slug)])]));
                }
            }
            catch { }
            if (again.length)
                out.push('- shown earlier in this conversation, still relevant: ' + again.join(', '));
            for (const h of hits) {
                if (again.includes(h.slug))
                    continue;
                out.push(`- [${h.how}] ${h.slug}: ${cut(h.description, 60)}`);
                const p = memPath(h.slug);
                if (existsSync(p))
                    continue;
                if (h.body) {
                    out.push('  ---');
                    for (const line of String(h.body).split('\n'))
                        out.push('  ' + line);
                    out.push(h.truncated
                        ? '  --- [cut at ' + String(h.body).length + ' of ' + h.chars + ' characters. The rest: '
                            + 'node tools/brain-client.mjs read ' + h.slug + ']'
                        : '  ---');
                }
                else {
                    out.push(`  node tools/brain-client.mjs read ${h.slug}   (no local copy, fetch it from the server)`);
                }
            }
        }
    }
    try {
        const as = JSON.parse(readFileSync(join(BRAIN, 'hooks', 'agent-search.json'), 'utf8'));
        if (as.on && !systemEvent) {
            const at = out.findIndex((l) => typeof l === 'string' && l.startsWith('BRAIN RECALL:'));
            if (at >= 0)
                out.splice(at > 0 && out[at - 1] === '' ? at - 1 : at);
            const cli = join(BRAIN, 'tools', 'brain-client.mjs').replace(/\\/g, '/');
            out.push('', 'BRAIN RECALL BY SEARCH, YOUR FIRST STEP THIS TURN. Before any other tool and before answering, work out from this message and the conversation what knowledge you need, one need per separate piece of knowledge, including the standing rules or preferences that apply to the task, and run ONE command with one quoted question per need: as many as the message really has separate pieces (a short message often 2 to 4; a long message, a pasted text or a file with many instructions, one per topic, up to 20), each written as the direct question you need the brain to answer, as long as it needs to be precise (usually 10 to 30 words), plain English, names of people, companies, systems and topics spelled out, typing mistakes corrected, "it" and "that" resolved. Add --learned "<one sentence>" for each thing learned or corrected since the last message (a decision, a fact that turned out different, a correction the user gave you); none if nothing was learned:', 'node "' + cli + '" search "<question 1>" "<question 2>" ... --learned "<what was learned>"', 'Every other tool and the end of the turn are refused until it has run, and while a learned item is not settled: save it, replace the memory it contradicts, or confirm it is already saved.');
        }
    }
    catch { }
    try {
        let ctxTokens = 0;
        const tp = payload && payload.transcript_path;
        if (tp && existsSync(tp) && !systemEvent) {
            for (const l of tailLines(tp, (ls) => ls.some((x) => x.includes('"type":"assistant"') && x.includes('"usage"'))).reverse()) {
                let o;
                try {
                    o = JSON.parse(l);
                }
                catch {
                    continue;
                }
                const u = o && o.type === 'assistant' && o.message && o.message.usage;
                if (u) {
                    ctxTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
                    break;
                }
            }
        }
        if (SMART_COMPACTION && ctxTokens >= COMPACT_FROM) {
            const cli = join(BRAIN, 'tools', 'compact-approve.mjs').replace(/\\/g, '/');
            out.push('', 'CONTEXT IS AT ' + Math.round(ctxTokens / 1000) + ',000 TOKENS (compaction is considered from ' + COMPACT_FROM / 1000 + ',000). You judge whether this conversation should be compacted: not while a long piece of work is under way, yes at a natural break. If you think it should, ask the person in one line, in the word "compacting", and wait; never compact without his yes, and no reply means he is away. On his yes: settle anything learned into the brain, run node "' + cli + '", then write your compaction brief with the Write tool to ~/.claude/havok-compact-brief/<session id>.md, never as a chat message (the person: keep it out of the chat to save tokens) (what you are working on and its exact state; what you still need exactly: his instructions and decisions in his words with their dates and what each answered, numbers with what they measured, paths, ids, amounts, open questions, ways of working he set; what can go: finished work already saved and where, old tool output, dead ends), then end with a two-line reply; the compaction starts on the next request.');
        }
    }
    catch { }
    try {
        if (!systemEvent && PUBLIC_NAME.test(JSON.parse(readFileSync(join(BRAIN, 'package.json'), 'utf8')).name)) {
            const { updateNotice } = await import('../tools/update.mjs');
            const note = updateNotice(BRAIN);
            if (note)
                out.push('', note);
        }
    }
    catch { }
    if (DEADLINE_HIT)
        out.push('', 'brain unreachable, recall skipped (no answer within ' + Math.round(HOOK_LIMIT_MS / 1000) + ' s)');
    ok(out.join('\n'));
}
catch (e) {
    try {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: 'BRAIN RULES FAILED TO LOAD (' + String(e && e.message).slice(0, 120) + '). You are '
                    + 'running with NO behaviour rules and no recall this turn. Tell the person before answering, '
                    + 'and keep replies short and honest from memory. Fix: node tools/build-index.mjs in '
                    + 'the brain, then check hooks/pre-turn.mjs.',
            },
        }));
    }
    catch { }
    process.exit(0);
}
