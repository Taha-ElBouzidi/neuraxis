import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const QUIET = process.argv.includes('--quiet');
const NL = '\n';
const say = (s) => process.stdout.write(s + NL);
const INDEX_FILES = ['keywords.json', 'embeddings.json', 'rules.json', 'contact.md', 'feedback.md', 'project.md', 'reference.md', 'user.md', 'translate-system.txt'];
const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
function localIndex() {
    const files = {};
    const whole = createHash('sha256');
    for (const name of INDEX_FILES) {
        let buf = null;
        try {
            buf = readFileSync(join(BRAIN, 'index', name));
        }
        catch {
            continue;
        }
        const sha = sha16(buf);
        files[name] = { bytes: buf.length, sha };
        whole.update(name + ':' + sha + '|');
    }
    return { version: whole.digest('hex').slice(0, 16), files };
}
const me = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
let host = '';
try {
    host = (JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8')).host || '').toUpperCase();
}
catch { }
if (host && host === me) {
    if (!QUIET)
        say('this machine (' + me + ') IS the source of truth, nothing to sync');
    process.exit(0);
}
let base = process.env.HAVOK_SERVER_URL;
if (!base) {
    try {
        base = JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8')).url;
    }
    catch { }
}
if (!base) {
    if (!QUIET)
        say('no server endpoint published, staying on the local copy');
    process.exit(0);
}
base = base.replace(/\/$/, '');
const TOKEN_FILE = resolve(process.env.HAVOK_HOME || resolve(homedir(), '.claude'), 'havok-server-token');
let token = (process.env.HAVOK_SERVER_TOKEN || '').trim();
if (!token) {
    try {
        token = readFileSync(TOKEN_FILE, 'utf8').trim();
    }
    catch { }
}
if (!token) {
    try {
        token = execFileSync(process.execPath, [join(BRAIN, 'tools', 'vault.mjs'), 'get', 'havok_server_token'], { encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    }
    catch { }
}
if (!token) {
    if (!QUIET)
        say('no server token on this machine: looked at HAVOK_SERVER_TOKEN, ' + TOKEN_FILE
            + ', and the vault. Staying on the local copy.');
    process.exit(0);
}
function fetchRaw(path, binary) {
    const conf = [
        'header = "Authorization: Bearer ' + token + '"',
        'url = "' + base + path + '"',
        'silent', 'connect-timeout = 3', 'max-time = 30',
    ];
    if (/^https:/i.test(base)) {
        const cert = join(BRAIN, 'server-cert.pem');
        if (existsSync(cert))
            conf.push('cacert = "' + cert.split('\\').join('/') + '"');
        else if (!QUIET)
            say('WARNING: no server-cert.pem in this clone, so TLS cannot be verified and every fetch will fail');
    }
    conf.push('');
    const confText = conf.join(NL);
    return execFileSync('curl', ['-K', '-'], {
        input: confText, encoding: binary ? null : 'utf8', windowsHide: true, timeout: 35000, stdio: ['pipe', 'pipe', 'ignore'],
    });
}
let remote;
try {
    remote = JSON.parse(fetchRaw('/index/version'));
}
catch {
    if (!QUIET)
        say('server unreachable at ' + base + ', staying on the local copy');
    process.exit(0);
}
if (!remote || !remote.version) {
    if (!QUIET)
        say('server did not return a version, staying on the local copy');
    process.exit(0);
}
const local = localIndex();
if (local.version === remote.version) {
    if (!QUIET)
        say('index current: ' + local.version + ' (' + remote.memories + ' memories)');
    process.exit(0);
}
const stale = INDEX_FILES.filter((n) => (local.files[n] || {}).sha !== (remote.files[n] || {}).sha && remote.files[n]);
say('INDEX DIVERGED. local ' + local.version + ', server ' + remote.version);
for (const n of stale) {
    const l = local.files[n], r = remote.files[n];
    say('   ' + n.padEnd(22) + (l ? l.bytes + ' bytes' : 'MISSING').padStart(12) + '  ->  ' + r.bytes + ' bytes');
}
if (CHECK) {
    say('--check: nothing changed');
    process.exit(1);
}
let fixed = 0;
for (const n of stale) {
    try {
        const buf = fetchRaw('/index/' + n, true);
        if (sha16(buf) !== remote.files[n].sha) {
            say('   ' + n + ': fetched copy does not match the published hash, left alone');
            continue;
        }
        const dest = join(BRAIN, 'index', n);
        const tmp = dest + '.sync-tmp';
        writeFileSync(tmp, buf);
        renameSync(tmp, dest);
        fixed++;
    }
    catch (e) {
        say('   ' + n + ': fetch failed, left alone (' + String(e.message).split(NL)[0].slice(0, 60) + ')');
    }
}
const after = localIndex();
say('repaired ' + fixed + ' of ' + stale.length + ' file(s), now ' + after.version
    + (after.version === remote.version ? ' (matches the server)' : ' (STILL DIFFERS, investigate)'));
try {
    const STAMP = resolve(process.env.HAVOK_HOME || resolve(homedir(), '.claude'), 'havok-code-check');
    let last = 0;
    try {
        last = Number(readFileSync(STAMP, 'utf8').trim()) || 0;
    }
    catch { }
    if (Date.now() - last > 3600000) {
        writeFileSync(STAMP, String(Date.now()), 'utf8');
        const manifest = JSON.parse(fetchRaw('/dist'));
        const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
        const old = [];
        for (const f of manifest.files || []) {
            let mine = null;
            try {
                mine = readFileSync(join(BRAIN, f.path));
            }
            catch { }
            if (!mine || sha16(mine) !== f.sha)
                old.push(f.path);
        }
        if (old.length) {
            say('CODE IS STALE on this machine: ' + old.length + ' of ' + manifest.files.length
                + ' file(s) differ from the server, including ' + old.slice(0, 3).join(', ')
                + (old.length > 3 ? ' and ' + (old.length - 3) + ' more' : '') + '.');
            say('   Nothing was changed. Run: node tools/pull-from-server.mjs');
        }
    }
}
catch { }
try {
    unlinkSync(resolve(homedir(), '.claude', 'havok-index-syncing'));
}
catch { }
process.exit(after.version === remote.version ? 0 : 1);
