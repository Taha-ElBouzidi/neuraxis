#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, readdirSync, appendFileSync, statSync, } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CERT = join(BRAIN, 'server-cert.pem');
const CHECK = process.argv.includes('--check');
const QUIET = process.argv.includes('--quiet');
const FORCE = process.argv.includes('--force');
const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);
const LOG = join(BRAIN, '.pull-from-server.log');
const STATE = join(BRAIN, '.pull-from-server.state');
const MIRRORED = [];
const MIN_MEMORIES_TO_TRUST = 50;
const SWEEP_GRACE_MS = 10 * 60 * 1000;
function out(s) {
    if (!QUIET)
        process.stdout.write(s + NL);
    try {
        if (existsSync(LOG) && statSync(LOG).size > 1024 * 1024)
            writeFileSync(LOG, '');
        appendFileSync(LOG, new Date().toISOString() + String.fromCharCode(9) + s + NL);
    }
    catch { }
}
const done = (code) => process.exit(QUIET ? 0 : code);
const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');
let token = '';
try {
    token = readFileSync(join(CONFIG_DIR, 'havok-server-token'), 'utf8').trim();
}
catch { }
if (!token) {
    out('NO TOKEN on this machine, at ' + join(CONFIG_DIR, 'havok-server-token') + '.');
    out('Ask the person to arm a bootstrap, then collect it. Not calling with an empty credential, because');
    out('the 401 would look like the server being down.');
    done(1);
}
let base = process.env.HAVOK_SERVER_URL;
if (!base) {
    try {
        base = JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8')).url;
    }
    catch { }
}
if (!base) {
    out('no server endpoint published, cannot update');
    done(1);
}
while (base.endsWith('/'))
    base = base.slice(0, -1);
let magic = '';
try {
    magic = JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8')).tailnet.magicdns || '';
}
catch { }
const ipHost = (base.match(/^https?:\/\/([^:/]+)(?::(\d+))?/) || []);
const useConnectTo = Boolean(magic && ipHost[1] && /^[0-9.]+$/.test(ipHost[1]));
const namedBase = useConnectTo ? 'https://' + magic + (ipHost[2] ? ':' + ipHost[2] : '') : base;
function fetch(path, binary) {
    const conf = [
        'header = "Authorization: Bearer ' + token + '"',
        'url = "' + namedBase + path + '"',
        'silent', 'connect-timeout = 5', 'max-time = 60',
    ];
    if (useConnectTo) {
        conf.push('connect-to = "' + magic + ':' + ipHost[2] + ':' + ipHost[1] + ':' + ipHost[2] + '"');
    }
    if (base.slice(0, 6).toLowerCase() === 'https:' && existsSync(CERT)) {
        conf.push('cacert = "' + CERT.split(BS).join('/') + '"');
    }
    return execFileSync('curl', ['-K', '-'], {
        input: conf.join(NL) + NL,
        encoding: binary ? null : 'utf8',
        windowsHide: true, timeout: 65000,
        stdio: ['pipe', 'pipe', 'ignore'],
    });
}
function localDigest(paths) {
    const h = createHash('sha256');
    for (const rel of [...paths].sort()) {
        try {
            const st = statSync(join(BRAIN, rel));
            h.update(rel + ':' + st.size + ':' + Math.floor(st.mtimeMs) + '|');
        }
        catch {
            h.update(rel + ':absent|');
        }
    }
    return h.digest('hex').slice(0, 16);
}
function saveState(remote, paths) {
    try {
        writeFileSync(STATE, JSON.stringify({ remote, local: localDigest(paths), paths }));
    }
    catch { }
}
let remoteVersion = null;
if (!FORCE) {
    try {
        const v = JSON.parse(fetch('/dist/version') || '{}');
        if (v && v.version) {
            remoteVersion = v.version;
            let seen = null;
            try {
                seen = JSON.parse(readFileSync(STATE, 'utf8'));
            }
            catch { }
            if (seen && seen.remote === remoteVersion && Array.isArray(seen.paths)
                && seen.local === localDigest(seen.paths)) {
                if (!QUIET)
                    out('already current (version ' + remoteVersion + ', ' + v.files + ' files)');
                done(0);
            }
        }
    }
    catch { }
}
let manifest;
try {
    manifest = JSON.parse(fetch('/dist'));
}
catch {
    out('server unreachable at ' + base + ', nothing changed');
    done(1);
}
if (!manifest || !Array.isArray(manifest.files)) {
    out('the server did not return a manifest. If this is a 403, this machine may not be permitted.');
    done(1);
}
const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const stale = [];
for (const f of manifest.files) {
    let mine = null;
    try {
        mine = readFileSync(join(BRAIN, f.path));
    }
    catch { }
    if (!mine || sha16(mine) !== f.sha)
        stale.push({ ...f, missing: !mine });
}
const published = new Set(manifest.files.map((f) => f.path));
const memoryCount = manifest.files.filter((f) => f.path.slice(0, 7) === 'memory/').length;
const orphans = [];
const spared = [];
if (memoryCount >= MIN_MEMORIES_TO_TRUST) {
    for (const d of MIRRORED) {
        let names = [];
        try {
            names = readdirSync(join(BRAIN, d));
        }
        catch {
            continue;
        }
        for (const n of names) {
            const rel = d + '/' + n;
            const isSyncable = n.slice(-3) === '.md' || n.slice(-5) === '.json';
            if (!isSyncable || published.has(rel))
                continue;
            let age = Infinity;
            try {
                age = Date.now() - statSync(join(BRAIN, rel)).mtimeMs;
            }
            catch { }
            if (age < SWEEP_GRACE_MS) {
                spared.push(rel + ' (' + Math.round(age / 1000) + 's old)');
                continue;
            }
            orphans.push(rel);
        }
    }
}
else if (MIRRORED.length && manifest.files.length) {
    out('NOT sweeping deletions: the server listed only ' + memoryCount + ' memories, below the '
        + MIN_MEMORIES_TO_TRUST + ' needed to trust it. Files were updated, none removed.');
}
for (const p of spared)
    out('held back, too recent to be sure it is a deletion: ' + p);
try {
    const { layerOrphans } = await import('./layers-dist.mjs');
    for (const rel of layerOrphans(BRAIN, published))
        orphans.push(rel);
}
catch { }
try {
    const prev = JSON.parse(readFileSync(STATE, 'utf8'));
    const prevPaths = Array.isArray(prev && prev.paths) ? prev.paths : [];
    if (prevPaths.length && manifest.files.length >= prevPaths.length / 2) {
        const have = new Set(orphans);
        for (const rel of prevPaths) {
            if (typeof rel !== 'string' || published.has(rel) || have.has(rel) || rel.includes('..'))
                continue;
            if (existsSync(join(BRAIN, rel)))
                orphans.push(rel);
        }
    }
    else if (prevPaths.length) {
        out('NOT removing files the server dropped: its list has ' + manifest.files.length + ' files, against '
            + prevPaths.length + ' last time.');
    }
}
catch { }
if (!stale.length && !orphans.length) {
    if (remoteVersion)
        saveState(remoteVersion, manifest.files.map((f) => f.path));
    if (!QUIET)
        out('already current: ' + manifest.files.length + ' files match the server');
    done(0);
}
if (!QUIET || CHECK) {
    if (stale.length) {
        out(stale.length + ' file(s) differ from the server:');
        for (const f of stale.slice(0, 40))
            out('   ' + (f.missing ? 'MISSING ' : 'stale   ') + f.path);
        if (stale.length > 40)
            out('   ... and ' + (stale.length - 40) + ' more');
    }
    if (orphans.length) {
        out(orphans.length + ' local file(s) the server no longer has:');
        for (const p of orphans.slice(0, 40))
            out('   deleted ' + p);
    }
}
if (CHECK) {
    out('--check: nothing changed');
    done(1);
}
let fixed = 0;
for (const f of stale) {
    try {
        const buf = fetch('/dist/' + encodeURIComponent(f.path).split('%2F').join('/'), true);
        if (sha16(buf) !== f.sha) {
            out('   ' + f.path + ': download does not match the published hash, left alone');
            continue;
        }
        const dest = join(BRAIN, f.path);
        mkdirSync(dirname(dest), { recursive: true });
        const tmp = dest + '.tmp-' + process.pid;
        writeFileSync(tmp, buf);
        renameSync(tmp, dest);
        fixed++;
    }
    catch (e) {
        out('   ' + f.path + ': update failed, left alone (' + String(e.message).split(NL)[0].slice(0, 80) + ')');
    }
}
let removed = 0;
if (orphans.length) {
    const stampSrc = new Date().toISOString();
    let stamp = '';
    for (const ch of stampSrc)
        stamp += (ch === ':' || ch === '.') ? '-' : ch;
    const trash = join(BRAIN, '.sync-trash', stamp);
    for (const rel of orphans) {
        try {
            const dest = join(trash, rel);
            mkdirSync(dirname(dest), { recursive: true });
            renameSync(join(BRAIN, rel), dest);
            removed++;
        }
        catch (e) {
            out('   ' + rel + ': could not move to trash, left in place (' + String(e.message).split(NL)[0].slice(0, 60) + ')');
        }
    }
    if (removed)
        out('moved ' + removed + ' removed file(s) to .sync-trash/' + stamp);
}
const okAll = fixed === stale.length && removed === orphans.length;
out('updated ' + fixed + ' of ' + stale.length + ' file(s), removed ' + removed + ' of '
    + orphans.length + ', from ' + base);
if (remoteVersion && okAll)
    saveState(remoteVersion, manifest.files.map((f) => f.path));
if (fixed && stale.some((f) => f.path.slice(0, 6) === 'hooks/')) {
    out('NOTE: hooks changed. A running Claude Code session loads hooks at start, so restart the');
    out('session or they will not take effect this turn.');
}
done(okAll ? 0 : 1);
