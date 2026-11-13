import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');
const FILE = resolve(CONFIG_DIR, 'havok-tokens.json');
const SCOPES = ['recall', 'full'];
const load = () => { try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
}
catch {
    return {};
} };
function save(db) {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(db, null, 2), 'utf8');
    try {
        chmodSync(FILE, 0o600);
    }
    catch { }
    if (process.platform === 'win32') {
        try {
            execFileSync('icacls', [FILE, '/inheritance:r', '/grant:r', process.env.USERNAME + ':(R,W)', '/grant:r', 'SYSTEM:(F)'], { stdio: 'ignore', timeout: 15000 });
        }
        catch { }
    }
}
const [cmd, name] = process.argv.slice(2);
const flag = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
if (cmd === 'issue') {
    if (!name) {
        console.log('usage: node tools/token.mjs issue <NAME> [--scope recall|full]');
        process.exit(1);
    }
    const scope = flag('--scope', 'recall');
    if (!SCOPES.includes(scope)) {
        console.log('scope must be one of: ' + SCOPES.join(', '));
        process.exit(1);
    }
    const db = load();
    for (const [tok, meta] of Object.entries(db))
        if (meta.name === name)
            delete db[tok];
    const value = randomBytes(32).toString('base64url');
    db[value] = { name, scope, issued: new Date().toISOString() };
    save(db);
    const out = flag('--out', join(CONFIG_DIR, 'issued-' + name + '.token'));
    writeFileSync(out, value, 'utf8');
    console.log('issued ' + name + '  scope=' + scope);
    console.log('value written to: ' + out);
    console.log('Move that file to the target machine as ~/.claude/havok-server-token, then DELETE it here.');
    console.log('Restart the server so it reloads the token list: Start-ScheduledTask -TaskName HavokBrainServer');
}
else if (cmd === 'list') {
    const db = load();
    const rows = Object.values(db);
    if (!rows.length) {
        console.log('no scoped tokens issued. The server token itself is always scope=full.');
        process.exit(0);
    }
    console.log('SERVER'.padEnd(16) + 'full'.padEnd(10) + '(the built-in token, not listed in this file)');
    for (const m of rows.sort((a, b) => String(a.name).localeCompare(b.name))) {
        console.log(String(m.name).padEnd(16) + String(m.scope).padEnd(10) + 'issued ' + String(m.issued).slice(0, 10) + (Array.isArray(m.read) && m.read.length ? '  reads: ' + m.read.join(', ') : ''));
    }
}
else if (cmd === 'grant' || cmd === 'ungrant') {
    const secret = String(process.argv[4] || '');
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(secret)) {
        console.log('usage: node tools/token.mjs ' + cmd + ' <NAME> <secret name>  (an exact name, no wildcard)');
        process.exit(1);
    }
    const db = load();
    let n = 0;
    for (const meta of Object.values(db)) {
        if (meta.name !== name)
            continue;
        const list = new Set(Array.isArray(meta.read) ? meta.read : []);
        if (cmd === 'grant')
            list.add(secret);
        else
            list.delete(secret);
        meta.read = [...list];
        n++;
    }
    if (!n) {
        console.log('no token found for ' + name);
        process.exit(1);
    }
    save(db);
    console.log((cmd === 'grant' ? 'granted ' : 'took back ') + secret + (cmd === 'grant' ? ' to ' : ' from ') + name + ' (' + n + ' token(s)); it may now read: ' + (Object.values(db).find((m) => m.name === name).read.join(', ') || 'nothing'));
}
else if (cmd === 'revoke') {
    if (!name) {
        console.log('usage: node tools/token.mjs revoke <NAME>');
        process.exit(1);
    }
    const db = load();
    let n = 0;
    for (const [tok, meta] of Object.entries(db))
        if (meta.name === name) {
            delete db[tok];
            n++;
        }
    save(db);
    console.log(n ? 'revoked ' + n + ' token(s) for ' + name : 'no token found for ' + name);
    if (n)
        console.log('Restart the server so it stops accepting it: Start-ScheduledTask -TaskName HavokBrainServer');
}
else if (cmd === 'arm') {
    const ip = flag('--ip', null);
    if (!name || !ip) {
        console.log('usage: node tools/token.mjs arm <NAME> --ip <tailnet-ip>');
        process.exit(1);
    }
    if (!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) {
        console.log('refusing: ' + ip + ' is not a tailnet address (100.64.0.0/10). Only a tailnet IP is an identity.');
        process.exit(1);
    }
    if (!Object.values(load()).some((m) => m.name === name)) {
        console.log('no token issued for ' + name + '. Run: node tools/token.mjs issue ' + name + ' --scope recall');
        process.exit(1);
    }
    const F = resolve(CONFIG_DIR, 'havok-bootstrap.json');
    let armed = {};
    try {
        armed = JSON.parse(readFileSync(F, 'utf8'));
    }
    catch { }
    armed[name] = { ip, armed: new Date().toISOString() };
    writeFileSync(F, JSON.stringify(armed, null, 2), 'utf8');
    console.log('armed ' + name + ' for ' + ip + ', ONE SHOT.');
    console.log('That machine collects it with:');
    let epUrl = '<server url>';
    try {
        epUrl = String(JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8')).url || epUrl);
    }
    catch { }
    console.log('  curl -s --cacert <brain>/server-cert.pem ' + epUrl + '/bootstrap/' + name);
    console.log('Restart the server so it can read the arm: Start-ScheduledTask -TaskName HavokBrainServer');
}
else if (cmd === 'show') {
    if (!name) {
        console.log('usage: node tools/token.mjs show <NAME> --out <path>');
        process.exit(1);
    }
    const out = flag('--out', null);
    if (!out) {
        console.log('--out is required. The value is never printed to stdout.');
        process.exit(1);
    }
    const hit = Object.entries(load()).find(([, m]) => m.name === name);
    if (!hit) {
        console.log('no token for ' + name);
        process.exit(1);
    }
    writeFileSync(out, hit[0], 'utf8');
    console.log('written to: ' + out);
}
else {
    console.log('token.mjs, scoped server tokens');
    console.log('  issue <NAME> [--scope recall|full]   mint one, value written to a file');
    console.log('  list                                 names and scopes, never values');
    console.log('  revoke <NAME>');
    console.log('  arm <NAME> --ip <tailnet-ip>          one-shot self-collect over the tailnet');
    console.log('  show <NAME> --out <path>');
    console.log('');
    console.log('scope recall = /recall /embed /rules /index/* /memory/*, and 403 on /vault/*');
}
