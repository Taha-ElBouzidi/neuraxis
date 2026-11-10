import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync, execFile } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CERT = join(BRAIN, 'server-cert.pem').split('\\').join('/');
const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');
const execFileAsync = promisify(execFile);
const NL = String.fromCharCode(10);
const results = [];
const pass = (n, d) => { results.push(1); console.log('  PASS  ' + n.padEnd(34) + d); };
const fail = (n, d) => { results.push(0); console.log('  FAIL  ' + n.padEnd(34) + d); };
const warn = (n, d) => { console.log('  WARN  ' + n.padEnd(34) + d); };
function tailscaleBin() {
    const candidates = ['tailscale',
        'C:/Program Files/Tailscale/tailscale.exe',
        '/usr/bin/tailscale', '/usr/local/bin/tailscale',
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
    for (const c of candidates) {
        try {
            execFileSync(c, ['version'], { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
            return c;
        }
        catch { }
    }
    return null;
}
let TAILNET = '';
try {
    const bin = tailscaleBin();
    if (!bin)
        throw new Error('tailscale not found on PATH or any known location');
    TAILNET = execFileSync(bin, ['ip', '-4'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim().split(NL)[0].trim();
}
catch { }
if (!/^100\./.test(TAILNET)) {
    console.log('  Tailscale is not reporting a tailnet address, so the remote path cannot be tested.');
    console.log('  This is the only suite that covers how other machines actually connect. Not passing it silently.');
    process.exit(1);
}
const ENDPOINT = JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8'));
let BASE = String(ENDPOINT.url || '');
while (BASE.endsWith('/'))
    BASE = BASE.slice(0, -1);
if (!BASE || BASE.includes('127.0.0.1') || BASE.includes('localhost')) {
    console.log('  server-endpoint.json publishes ' + (BASE || 'nothing') + ', which is loopback.');
    console.log('  This suite exists to test the non-loopback path, so it will not pretend to pass.');
    process.exit(1);
}
const SELF = BASE.includes(TAILNET);
console.log('  target: ' + BASE + (SELF ? '  (this machine IS the host)' : '  (a REMOTE server, the real case)'));
console.log('  from:   ' + TAILNET);
const NAME = 'REMOTETEST';
let MINTED = true;
const TOKFILE = join(tmpdir(), 'havok-remotetest.token');
try {
    execFileSync(process.execPath, [join(BRAIN, 'tools', 'token.mjs'), 'revoke', NAME], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
}
catch { }
try {
    execFileSync(process.execPath, [join(BRAIN, 'tools', 'token.mjs'), 'issue', NAME, '--scope', 'recall', '--out', TOKFILE], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
}
catch { }
let recallToken = '';
try {
    recallToken = readFileSync(TOKFILE, 'utf8').trim();
}
catch { }
if (!recallToken) {
    try {
        recallToken = readFileSync(join(homedir(), '.claude', 'havok-server-token'), 'utf8').trim();
    }
    catch { }
    if (recallToken) {
        MINTED = false;
        console.log("  token: could not mint one, using this machine own token instead");
    }
}
if (!recallToken) {
    console.log('  no token to test with, minting failed and this machine has none');
    process.exit(1);
}
function cleanup() {
    try {
        execFileSync(process.execPath, [join(BRAIN, 'tools', 'token.mjs'), 'revoke', NAME], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
    }
    catch { }
    try {
        unlinkSync(TOKFILE);
    }
    catch { }
}
function confFile(lines) {
    const f = join(tmpdir(), 'rt_' + process.pid + '_' + results.length + '.conf');
    writeFileSync(f, lines.join(NL) + NL, 'utf8');
    return f;
}
async function call(path, { token = recallToken, body = null, pin = true } = {}) {
    const lines = [
        'header = "Authorization: Bearer ' + token + '"',
        'url = "' + BASE + path + '"',
        'silent', 'connect-timeout = 8', 'max-time = 120',
        'write-out = "|CODE:%{http_code}"',
    ];
    if (pin)
        lines.push('cacert = "' + CERT + '"');
    let bodyFile = null;
    if (body) {
        bodyFile = join(tmpdir(), 'rt_body_' + process.pid + '_' + results.length + '.json');
        writeFileSync(bodyFile, JSON.stringify(body), 'utf8');
        lines.push('header = "content-type: application/json"', 'request = "POST"', 'data-binary = "@' + bodyFile.split('\\').join('/') + '"');
    }
    const conf = confFile(lines);
    try {
        const { stdout } = await execFileAsync('curl', ['-K', conf], { windowsHide: true, timeout: 130000, maxBuffer: 16 * 1024 * 1024 });
        const s = String(stdout);
        const code = (s.match(/\|CODE:(\d+)/) || [])[1] || '000';
        const raw = s.split('|CODE:')[0];
        let json = null;
        try {
            json = JSON.parse(raw);
        }
        catch { }
        return { code, raw, json };
    }
    catch (e) {
        const s = String((e && e.stdout) || '');
        const code = (s.match(/\|CODE:(\d+)/) || [])[1] || '000';
        return { code, raw: s.split('|CODE:')[0], json: null, curlError: String(e.message).slice(0, 90) };
    }
    finally {
        try {
            unlinkSync(conf);
            if (bodyFile)
                unlinkSync(bodyFile);
        }
        catch { }
    }
}
{
    const r = await call('/health');
    r.code === '200'
        ? pass('TLS verifies on the tailnet IP', 'pinned cert accepted at ' + TAILNET)
        : fail('TLS verifies on the tailnet IP', 'health ' + r.code + ' ' + (r.curlError || '') +
            ' -- if this says certificate, the SAN no longer covers ' + TAILNET + ' and every remote machine is locked out');
}
{
    const t = Date.now();
    const r = await call('/recall', { body: { prompt: 'verify before claiming anything works' } });
    const ranked = (r.json && r.json.ranked) || [];
    const ms = Date.now() - t;
    ranked.length > 0
        ? pass('recall over the tailnet', ranked.length + ' memories in ' + ms + 'ms, top: ' + ranked[0].slug)
        : fail('recall over the tailnet', 'code ' + r.code + ', ' + ranked.length + ' memories');
    if (ranked.length && ms > 1500)
        warn('recall latency', ms + 'ms over the tailnet, slower than the ~70ms loopback path');
}
{
    const rules = await call('/rules');
    const n = (rules.json && (rules.json.rules || []).length) || 0;
    n > 0 ? pass('rules over the tailnet', n + ' rules served') : fail('rules over the tailnet', 'code ' + rules.code + ', ' + n + ' rules');
    const v = await call('/index/version');
    (v.code === '200' && v.json && v.json.version)
        ? pass('index version', String(v.json.version).slice(0, 24))
        : fail('index version', 'code ' + v.code);
}
{
    const list = await call('/vault/list');
    const get = await call('/vault/get/anything');
    const pass1 = list.code === '403';
    const pass2 = get.code === '403';
    if (!MINTED) {
        warn('vault shut to a recall token', 'SKIPPED: using this machine’s own token, not a recall-scoped one');
    }
    else if (pass1 && pass2) {
        pass('vault shut to a recall token', 'both /vault/list and /vault/get returned 403');
    }
    else {
        fail('vault shut to a recall token', '/vault/list ' + list.code + ', /vault/get ' + get.code + ' -- A RECALL MACHINE CAN READ THE VAULT');
    }
    const said = (list.json && (list.json.detail || list.json.error)) || '';
    /ask the person|do not retry/i.test(said)
        ? pass('refusal tells the agent what to do', 'names the person and says do not retry')
        : warn('refusal wording', 'a refused agent may just retry: ' + String(said).slice(0, 70));
}
{
    const slug = 'reference_stress_remote';
    const content = '---' + NL + 'name: Remote write probe' + NL
        + 'description: probe proving a recall-scoped machine on the tailnet can still write a memory to the server' + NL
        + 'type: reference' + NL + '---' + NL + NL + 'See [[reference_deep_test_probe]].' + NL;
    const r = await call('/memory', { body: { slug, content } });
    (r.code === '200' && r.json && r.json.ok)
        ? pass('recall token can write', 'accepted over the tailnet, indexed')
        : fail('recall token can write', 'code ' + r.code + ' ' + JSON.stringify(r.json || r.raw).slice(0, 90));
    const back = await call('/recall', { body: { prompt: 'remote write probe recall scoped machine tailnet' } });
    const hit = ((back.json && back.json.ranked) || []).some((m) => m.slug === slug);
    hit ? pass('and it is immediately findable', 'the write reindexed before returning')
        : fail('and it is immediately findable', 'written but recall does not surface it');
    try {
        unlinkSync(join(BRAIN, 'memory', slug + '.md'));
    }
    catch { }
    try {
        execFileSync(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], { cwd: BRAIN, stdio: 'ignore', windowsHide: true, timeout: 180000 });
    }
    catch { }
}
{
    const m = await call('/dist');
    const files = (m.json && m.json.files) || [];
    files.length > 0
        ? pass('/dist serves a manifest', files.length + ' files a blocked machine can self-update from')
        : fail('/dist serves a manifest', 'code ' + m.code + ' -- a machine that cannot reach the repo has no other update path');
    const hasCert = files.some((f) => /server-cert\.pem$/.test(f.path));
    hasCert ? pass('cert is redistributable', 'a regenerated cert can reach a blocked machine')
        : fail('cert is redistributable', 'server-cert.pem is not in /dist: regenerating it strands any machine that cannot reach the repo');
    const SECRETS = ['vault.json', 'havok-tokens.json', 'server-key.pem', 'havok-server-key.pem', 'havok-server-token'];
    const listed = files.filter((f) => SECRETS.includes(f.path.split('/').pop()) || /\.age$|\.key$/.test(f.path));
    listed.length === 0 ? pass('no secret material in /dist', 'manifest carries code and docs only')
        : fail('no secret material in /dist', 'EXPOSED: ' + listed.map((f) => f.path).join(', '));
    const direct = await call('/dist/vault.json');
    const trav = await call('/dist/..%2F..%2FUsers%2F<user>%2F.claude%2Fhavok-tokens.json');
    (direct.code !== '200' && trav.code !== '200')
        ? pass('/dist refuses what is off-list', 'vault.json ' + direct.code + ', traversal ' + trav.code)
        : fail('/dist refuses what is off-list', 'vault.json ' + direct.code + ', traversal ' + trav.code + ' -- ONE OF THESE SERVED');
}
{
    if (!MINTED) {
        warn('revocation is immediate', 'SKIPPED: not our token to revoke, would lock this machine out');
    }
    else {
        const before = await call('/index/version');
        if (before.code !== '200') {
            fail('revocation is immediate', 'skipped: the token was not working before revoke (' + before.code + '), so this proves nothing');
        }
        else {
            execFileSync(process.execPath, [join(BRAIN, 'tools', 'token.mjs'), 'revoke', NAME], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
            const r = await call('/recall', { body: { prompt: 'anything at all' } });
            r.code === '401'
                ? pass('revocation is immediate', 'worked, then 401 straight after revoke, no restart')
                : fail('revocation is immediate', 'a revoked token still got ' + r.code + ' -- a lost laptop stays connected');
        }
    }
}
cleanup();
const passed = results.reduce((a, b) => a + b, 0);
console.log('');
console.log('  ' + passed + ' passed, ' + (results.length - passed) + ' failed, ' + results.length + ' checks');
if (existsSync(TOKFILE))
    console.log('  WARNING: test token file still on disk at ' + TOKFILE);
process.exit(passed === results.length ? 0 : 1);
