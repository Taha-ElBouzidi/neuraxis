import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, hostname, tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { whoAmI } from './provenance.mjs';
import { reportFailure } from './brain-recover.mjs';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NL = String.fromCharCode(10);
const DOWN_COOLDOWN_MIN = 3;
function resolveServerUrl() {
    if (process.env.HAVOK_SERVER_URL)
        return process.env.HAVOK_SERVER_URL.replace(/\/$/, '');
    try {
        const ep = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server-endpoint.json'), 'utf8'));
        if (ep && ep.url)
            return String(ep.url).replace(/\/$/, '');
    }
    catch { }
    return 'https://127.0.0.1:8443';
}
const URL_BASE = resolveServerUrl();
let MAGIC = '';
try {
    MAGIC = JSON.parse(readFileSync(join(BRAIN, 'server-endpoint.json'), 'utf8')).tailnet.magicdns || '';
}
catch { }
const ADDR = URL_BASE.match(/^https?:\/\/([^:\/]+)(?::(\d+))?/) || [];
const BY_NAME = Boolean(MAGIC && ADDR[1] && /^[0-9.]+$/.test(ADDR[1]));
const CALL_BASE = BY_NAME ? 'https://' + MAGIC + (ADDR[2] ? ':' + ADDR[2] : '') : URL_BASE;
const CONNECT_TO = BY_NAME ? MAGIC + ':' + ADDR[2] + ':' + ADDR[1] + ':' + ADDR[2] : '';
const TOKEN_FILE = resolve(homedir(), '.claude', 'havok-server-token');
const KEYFILE = resolve(homedir(), '.claude', 'havok-vault-key');
const token = () => {
    if (process.env.HAVOK_SERVER_TOKEN)
        return process.env.HAVOK_SERVER_TOKEN.trim();
    try {
        return readFileSync(TOKEN_FILE, 'utf8').trim();
    }
    catch {
        return '';
    }
};
function call(path, { method = 'GET', body = null, timeoutSec = 20 } = {}) {
    const t = token();
    if (!t) {
        process.stderr.write('NO TOKEN on this machine. Not calling ' + path + ' with an empty credential,'
            + ' because the 401 would look like the server being down.' + NL
            + 'Expected at: ' + TOKEN_FILE + NL
            + 'Ask the person to arm a bootstrap, then collect it with:' + NL
            + '  curl -s --cacert <brain>/server-cert.pem ' + URL_BASE + '/bootstrap/<THIS-MACHINE>' + NL);
        return null;
    }
    const lines = [
        'header = "Authorization: Bearer ' + t + '"',
        'url = "' + CALL_BASE + path + '"',
        'silent',
        'connect-timeout = 5',
        'max-time = ' + timeoutSec,
    ];
    if (CONNECT_TO)
        lines.push('connect-to = "' + CONNECT_TO + '"');
    if (/^https:/i.test(URL_BASE)) {
        const cert = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server-cert.pem');
        if (existsSync(cert))
            lines.push('cacert = "' + cert.split('\\').join('/') + '"');
    }
    if (!body && method && method !== 'GET')
        lines.push('request = "' + method + '"');
    let bodyFile = null;
    if (body) {
        bodyFile = join(tmpdir(), 'havok-bc-' + process.pid + '.json');
        writeFileSync(bodyFile, JSON.stringify(body), 'utf8');
        lines.push('request = "' + (method && method !== 'GET' ? method : 'POST') + '"', 'header = "content-type: application/json"', 'data-binary = "@' + bodyFile.split('\\').join('/') + '"');
    }
    try {
        const out = execFileSync('curl', ['-K', '-'], {
            input: lines.join('\n') + '\n',
            encoding: 'utf8', timeout: (timeoutSec + 2) * 1000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
        });
        return JSON.parse(out || '{}');
    }
    catch (e) {
        if (!(e instanceof SyntaxError))
            reportFailure('brain', 'brain-client ' + path.split('/').slice(0, 2).join('/') + ' got no answer');
        return null;
    }
    finally {
        if (bodyFile) {
            try {
                unlinkSync(bodyFile);
            }
            catch { }
        }
    }
}
const [cmd, arg] = process.argv.slice(2);
const REPO_TOOL = join(BRAIN, 'tools', 'repo.mjs');
function gitServerUrl() {
    try {
        return String(JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).gitServer.url || '').replace(/\/+$/, '');
    }
    catch {
        return '';
    }
}
if (cmd === 'status') {
    const AGEKEY = resolve(homedir(), '.claude', 'havok-age-key.txt');
    const me = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
    let readable = 0, total = 0, registered = false, host = '';
    try {
        const v = JSON.parse(readFileSync(join(BRAIN, 'vault.json'), 'utf8'));
        for (const box of Object.values(v.secrets || {})) {
            total++;
            if (box.keys && box.keys[me])
                readable++;
        }
    }
    catch { }
    try {
        const r = JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8'));
        registered = !!r.machines[me];
        host = (r.host || '').toUpperCase();
    }
    catch { }
    const isHost = host && host === me;
    const h = call('/health', { timeoutSec: 3 });
    const reachable = !!(h && h.ok);
    if (isHost) {
        process.stdout.write('brain server (this machine hosts it): ' + (reachable ? 'UP on ' + URL_BASE : 'DOWN, expected UP. Start it: Start-ScheduledTask -TaskName HavokBrainServer') + '\n');
        process.stdout.write('server token: ' + (token() ? 'present' : 'MISSING, the server cannot authenticate callers') + '\n');
    }
    else {
        process.stdout.write('brain server: ' + (reachable
            ? 'reachable at ' + URL_BASE
            : 'NOT reachable at ' + URL_BASE + '. Vault and memories still work from this clone. Semantic recall does not,'
                + ' unless this machine runs its own daemon. If you are on the same network as ' + (host || 'the host')
                + ', that is a fault and not a normal state.') + '\n');
    }
    process.stdout.write('machine name: ' + me + (registered ? ' (registered)' : ' (NOT registered as a recipient)') + '\n');
    if (isHost) {
        process.stdout.write('age identity: ' + (existsSync(AGEKEY)
            ? 'present, correct, this machine is the only one that should hold it'
            : 'MISSING on the host, so the server cannot decrypt the vault at all') + '\n');
    }
    else if (existsSync(AGEKEY)) {
        let decrypts = false;
        try {
            decrypts = execFileSync(process.execPath, [join(BRAIN, 'tools', 'vault.mjs'), 'list'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim().length > 0;
        }
        catch { }
        process.stdout.write('age identity: PRESENT at ' + AGEKEY + ', and it '
            + (decrypts ? 'DOES decrypt the local vault' : 'decrypts nothing (dead leftover)')
            + '. Private keys are meant to live only on the brain host: report this rather than ignoring it.\n');
    }
    else {
        process.stdout.write('age identity: none on this machine, which is correct. Secrets come from the server.\n');
    }
    if (isHost) {
        process.stdout.write('secrets: ' + total + ' in the vault, decrypted here (this machine holds the keys)' + NL);
    }
    else {
        const vl = call('/vault/list', { timeoutSec: 6 });
        process.stdout.write('secrets: ' + (vl && Array.isArray(vl.secrets)
            ? 'readable through the server, ' + vl.secrets.length + ' available'
            : vl && vl.error === 'forbidden'
                ? 'NOT permitted for this machine (recall-scoped token, 403). This is deliberate, do not retry.'
                : 'cannot be read: the server did not answer /vault/list') + NL);
        if (readable > 0) {
            process.stdout.write('  note: vault.json still lists a local key for ' + me + '. Keys are meant to live only on'
                + ' the brain server, so that is stale, pull the brain.' + NL);
        }
    }
    const DOWN = resolve(homedir(), '.claude', 'havok-remote-embed-down');
    const ALIVE = resolve(homedir(), '.claude', 'havok-embed.alive');
    const localDaemon = existsSync(ALIVE);
    try {
        const raw = readFileSync(DOWN, 'utf8').trim();
        const m = /^\d+$/.test(raw) ? { at: Number(raw), reason: 'unknown (mark predates reasons)' } : JSON.parse(raw);
        const mins = Math.floor((Date.now() - Number(m.at)) / 60000);
        const cooled = (Date.now() - Number(m.at)) >= DOWN_COOLDOWN_MIN * 60 * 1000;
        process.stdout.write('remote embedding: ' + (cooled
            ? 'marked down ' + mins + ' min ago (' + m.reason + '), cooldown lapsed so the next turn retries'
            : 'SKIPPED, marked down ' + mins + ' min ago (' + m.reason + '), retrying in ' + (DOWN_COOLDOWN_MIN - mins) + ' min') + '\n');
    }
    catch {
        process.stdout.write('remote embedding: not marked down\n');
    }
    process.stdout.write('local embed daemon: ' + (localDaemon
        ? 'running, available as the fallback if the server is unreachable'
        : 'not running, so the server is the only semantic path') + '\n');
    let markFresh = false;
    try {
        const raw = readFileSync(DOWN, 'utf8').trim();
        const m = /^\d+$/.test(raw) ? { at: Number(raw) } : JSON.parse(raw);
        markFresh = (Date.now() - Number(m.at)) < DOWN_COOLDOWN_MIN * 60 * 1000;
    }
    catch { }
    process.stdout.write('recall right now: ' + ((reachable && !markFresh) ? 'SEMANTIC, via the server at ' + URL_BASE
        + (localDaemon ? ' (a local daemon is also running, used only if the server is unreachable)' : '')
        : localDaemon ? 'SEMANTIC, via the LOCAL daemon (the server is ' + (markFresh ? 'marked down' : 'not reachable') + ')'
            : 'KEYWORD ONLY, no local daemon and the server is ' + (markFresh ? 'marked down' : 'not reachable')) + '\n');
    if (existsSync(KEYFILE))
        process.stdout.write('legacy v1 passphrase still present at ' + KEYFILE + ', delete it once every secret is v2\n');
    const fs_hasMemories = (d) => { try {
        return readdirSync(d).some((n) => n.endsWith('.md') && n !== 'MEMORY.md');
    }
    catch {
        return false;
    } };
    process.stdout.write('local brain clone: ' + (existsSync(join(BRAIN, 'memory')) && fs_hasMemories(join(BRAIN, 'memory')) ? 'yes, memories and rules work offline' : 'none, memories are on the brain server only') + '\n');
}
else if (cmd === 'bootstrap') {
    const AGEKEY = resolve(homedir(), '.claude', 'havok-age-key.txt');
    const vaultTool = join(BRAIN, 'tools', 'vault.mjs');
    let pub = '';
    try {
        pub = execFileSync(process.execPath, [vaultTool, 'machine-init'], { encoding: 'utf8' }).trim();
    }
    catch (e) {
        process.stderr.write('Could not create a machine key: ' + (e.message || e) + '\n');
        process.exit(1);
    }
    const machine = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
    process.stdout.write(pub + '\n');
    process.stderr.write([
        '',
        'This machine now has its own key. The private half stays at ' + AGEKEY + ' and never moves.',
        'The line above is the PUBLIC key and is safe to paste anywhere.',
        '',
        'To finish, on a machine that ALREADY has vault access, run:',
        '  node tools/vault.mjs machine-add ' + machine + ' ' + pub,
        '  node tools/vault.mjs grant --all --to ' + machine,
        '  git commit -am "vault: grant ' + machine + '" && git push',
        '',
        'Then pull here. No passphrase is ever copied, and no secret crosses the network.',
        '',
    ].join('\n'));
}
else if (cmd === 'list') {
    const r = call('/vault/list');
    if (r && r.secrets) {
        for (const s of r.secrets)
            process.stdout.write(s.name.padEnd(34) + 'updated ' + s.updated + '\n');
    }
    else {
        process.stderr.write(r && r.error === 'forbidden'
            ? 'this machine may not list the vault (recall-scoped token, 403, deliberate). Showing the local clone\n'
            : 'server unreachable, using the local clone\n');
        process.stdout.write(execFileSync(process.execPath, [join(BRAIN, 'tools', 'vault.mjs'), 'list'], { encoding: 'utf8' }));
    }
}
else if (cmd === 'decision') {
    const [, sub, id, state, ...rest] = process.argv.slice(2);
    const agent = String(process.env.HAVOK_MOD_AGENT || '').trim();
    if (sub !== 'review' || !id || !['kept', 'reversed'].includes(state)) {
        process.stderr.write('usage: node tools/brain-client.mjs decision review <id> kept|reversed "<note>"' + NL);
        process.exit(2);
    }
    if (!agent) {
        process.stderr.write('HAVOK_MOD_AGENT is not set: run this from the agent\'s own session.' + NL);
        process.exit(2);
    }
    const r = call('/decisions/' + encodeURIComponent(id) + '/review', { method: 'POST', body: { state, note: rest.join(' '), agent } });
    if (!r)
        process.exit(1);
    if (r.error) {
        process.stderr.write(r.error + NL);
        process.exit(1);
    }
    process.stdout.write('reviewed ' + id + ': ' + state + (r.message ? (r.message.sent ? ', the agent is told' : ', the agent could not be told: ' + r.message.why) : '') + NL);
}
else if (cmd === 'outlook') {
    const rest = process.argv.slice(3);
    const command = rest.shift() || 'help';
    const SWITCHES = new Set(['Unread', 'Slow', 'Full', 'ReplyAll']);
    const params = {};
    let text = '';
    let html = '';
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--text-file' || a === '--html-file') {
            const f = rest[++i];
            if (!f || !existsSync(f)) {
                process.stderr.write(a + ' needs an existing file' + NL);
                process.exit(2);
            }
            if (a === '--text-file')
                text = readFileSync(f, 'utf8');
            else
                html = readFileSync(f, 'utf8');
            continue;
        }
        const m = /^-([A-Za-z]+)$/.exec(a);
        if (!m) {
            process.stderr.write('unexpected argument: ' + a + NL);
            process.exit(2);
        }
        if (SWITCHES.has(m[1]))
            params[m[1]] = true;
        else {
            params[m[1]] = rest[++i] ?? '';
        }
    }
    const agent = String(process.env.HAVOK_MOD_AGENT || '').trim();
    if (!agent) {
        process.stderr.write('HAVOK_MOD_AGENT is not set: run this from the agent\'s own session, so the call is recorded with its name.' + NL);
        process.exit(2);
    }
    const r = call('/outlook', { method: 'POST', body: { command, params, agent, ...(text ? { text } : {}), ...(html ? { html } : {}) }, timeoutSec: 220 });
    if (!r)
        process.exit(1);
    if (r.error) {
        process.stderr.write(r.error + NL);
        process.exit(1);
    }
    if (r.output)
        process.stdout.write(r.output);
    if (r.error === undefined && r.exit !== 0 && r.error !== '')
        process.stderr.write(String(r.error || ''));
    process.exit(r.exit === 0 ? 0 : 1);
}
else if (cmd === 'agy-quota') {
    const [, sub, file] = process.argv.slice(2);
    if (!['push', 'pull'].includes(sub) || !file) {
        process.stderr.write('usage: node tools/brain-client.mjs agy-quota push|pull <quota.json>' + NL);
        process.exit(2);
    }
    const local = (() => { try {
        return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    }
    catch {
        return null;
    } })();
    if (sub === 'push') {
        if (!local) {
            process.stderr.write('no reading in ' + file + NL);
            process.exit(1);
        }
        const r = call('/agy/quota', { method: 'POST', body: local, timeoutSec: 15 });
        if (!r || r.error) {
            process.stderr.write('agy quota not sent: ' + ((r && r.error) || 'no answer') + NL);
            process.exit(1);
        }
        process.stdout.write((r.kept ? 'sent, now the shared reading: ' : 'a newer reading stands: ') + r.at + NL);
    }
    else {
        const r = call('/agy/quota', { timeoutSec: 15 });
        if (!r || r.error || !r.at) {
            process.stderr.write('no shared agy quota reading: ' + ((r && r.error) || 'no answer') + NL);
            process.exit(1);
        }
        if (local && Date.parse(local.at) >= Date.parse(r.at)) {
            process.stdout.write('this machine has the newest reading: ' + local.at + NL);
            process.exit(0);
        }
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(r, null, 2) + NL, 'utf8');
        process.stdout.write('took the shared reading from ' + (r.machine || 'another machine') + ', ' + r.at + NL);
    }
}
else if (cmd === 'secret') {
    if (!arg) {
        process.stderr.write('usage: brain-client.mjs secret <name>\n');
        process.exit(1);
    }
    let r = call('/vault/get/' + encodeURIComponent(arg));
    if (!(r && typeof r.value === 'string')) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
        r = call('/vault/get/' + encodeURIComponent(arg));
    }
    if (r && typeof r.value === 'string') {
        process.stdout.write(r.value);
    }
    else {
        try {
            process.stdout.write(execFileSync(process.execPath, [join(BRAIN, 'tools', 'vault.mjs'), 'get', arg], { encoding: 'utf8' }));
        }
        catch {
            process.stderr.write('Could not read "' + arg + '" from the server or locally.\n'
                + 'If this machine has no passphrase, run: node tools/brain-client.mjs bootstrap\n');
            process.exit(1);
        }
    }
}
else if (cmd === 'store-secret') {
    const flag = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
    if (!arg) {
        process.stderr.write('usage: <key on stdin> | brain-client.mjs store-secret <name> --note "what it is" [--replace]' + NL);
        process.exit(1);
    }
    let value = '';
    try {
        value = readFileSync(0, 'utf8').trim();
    }
    catch {
        value = '';
    }
    if (!value) {
        process.stderr.write('No value on stdin. Pipe the key in, never put it on the command line.' + NL);
        process.exit(1);
    }
    const r = call('/vault/set/' + encodeURIComponent(arg), { method: 'POST', body: { value, note: flag('--note') || '', replace: process.argv.includes('--replace') }, timeoutSec: 120 });
    if (!r) {
        process.stderr.write('The server did not answer, so NOTHING was stored. Check with: node tools/brain-client.mjs status' + NL);
        process.exit(1);
    }
    if (!r.ok) {
        process.stderr.write('REFUSED: ' + (r.error || 'unknown') + (r.detail ? ': ' + r.detail : '') + NL);
        process.exit(1);
    }
    process.stdout.write((r.replaced ? 'replaced ' : 'stored ') + r.name + ' in the vault on the brain host' + (r.pushed ? '' : ' (git backup failed, the key IS stored)') + NL);
}
else if (cmd === 'write') {
    const flag = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
    const fromStdin = process.argv.includes('--stdin');
    const file = flag('--file');
    if (!arg || (!file && !fromStdin)) {
        process.stderr.write([
            'usage: brain-client.mjs write <slug> --file <path>',
            '       brain-client.mjs write <slug> --stdin',
            '',
            'The slug must start with user, contact, project, feedback or reference, and the file must',
            'carry frontmatter with name, description and a matching type. The description is the ONLY',
            'thing indexed for recall, so write it in the words the person would actually type.',
            '',
        ].join(NL));
        process.exit(1);
    }
    let content = '';
    try {
        content = fromStdin ? readFileSync(0, 'utf8') : readFileSync(resolve(file), 'utf8');
    }
    catch (e) {
        process.stderr.write('cannot read the memory body: ' + String(e.message) + NL);
        process.exit(1);
    }
    if (!content.trim()) {
        process.stderr.write('the body is empty, refusing to write' + NL);
        process.exit(1);
    }
    const r = call('/memory', { method: 'POST', body: { slug: arg, content, by: whoAmI() }, timeoutSec: 300 });
    if (!r) {
        process.stderr.write('The server did not answer, so NOTHING was written. Do not commit this to'
            + ' your local clone instead: the server owns writes and git is only its backup.' + NL
            + 'Check with: node tools/brain-client.mjs status' + NL);
        process.exit(1);
    }
    if (!r.ok) {
        process.stderr.write('REFUSED: ' + (r.error || 'unknown') + NL
            + (r.detail ? String(r.detail) + NL : '')
            + 'The write was validated before it landed, so nothing is half-written. Fix it and run again.' + NL);
        process.exit(1);
    }
    process.stdout.write((r.updated ? 'updated ' : 'wrote ') + r.slug + (r.queued
        ? ' on the server. Indexing and the git backup run there in the background, a few seconds.'
        : ', indexed, index now ' + r.v) + NL);
    if (r.pushed === false) {
        process.stdout.write('git backup did NOT get it: ' + (r.pushError || 'no reason given') + NL
            + 'The memory IS on the server and is live for every machine. This only means the backup is behind.' + NL);
    }
}
else if (cmd === 'delete') {
    const flag = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
    const why = flag('--why');
    if (!arg || !why) {
        process.stderr.write([
            'usage: brain-client.mjs delete <slug> --why "it was wrong because ..."',
            '       add --force only when the memories that link to it are being left alone on purpose',
            '',
            'The file moves to deleted/ on the server, it is never unlinked, and the index is rebuilt',
            'there. Anything still pointing at it is named and the delete is refused, because a link to',
            'a memory that does not exist blocks writes for every machine.',
            '',
        ].join(NL));
        process.exit(1);
    }
    const r = call('/memory/' + encodeURIComponent(arg), {
        method: 'DELETE', body: { why, force: process.argv.includes('--force'), by: whoAmI() }, timeoutSec: 120,
    });
    if (!r) {
        process.stderr.write('The server did not answer, so NOTHING was deleted. Never delete from your'
            + ' local clone instead: the server owns the brain and git is only its backup.' + NL);
        process.exit(1);
    }
    if (!r.ok) {
        process.stderr.write('REFUSED: ' + (r.error || 'unknown') + NL + (r.detail ? String(r.detail) + NL : ''));
        process.exit(1);
    }
    process.stdout.write('deleted ' + r.slug + '. A sealed copy is kept on the brain host, outside the'
        + ' repo and encrypted to that machine, and only it can open it: node tools/graveyard.mjs restore '
        + r.slug + NL + 'Reindexing and the git backup run on the server in the background.' + NL);
    if (r.linked && r.linked.length) {
        process.stdout.write('WARNING: ' + r.linked.length + ' memories still link to it and were left as they are: '
            + r.linked.join(', ') + NL + 'Fix them or the next write from any machine is refused.' + NL);
    }
}
else if (cmd === 'recall') {
    const q = process.argv.slice(3).join(' ').trim();
    if (!q) {
        process.stderr.write('usage: brain-client.mjs recall "<what you are about to do>"' + NL);
        process.exit(1);
    }
    const r = call('/recall', { method: 'POST', body: { prompt: q, queries: [q] } });
    const hits = (r && (r.ranked || r.hits || r.results)) || null;
    if (!hits) {
        process.stderr.write('recall failed: the brain server did not answer' + NL);
        process.exit(1);
    }
    for (const h of hits.slice(0, 15))
        process.stdout.write((h.slug || h) + '  ' + String(h.description || '').slice(0, 140) + NL);
}
else if (cmd === 'search') {
    const args = process.argv.slice(3);
    if (args.includes('--saved')) {
        process.stdout.write('Noted: the learned items of this turn are already in the brain.' + NL);
        process.exit(0);
    }
    const needs = [], learned = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--learned') {
            if (args[i + 1])
                learned.push(args[++i]);
        }
        else
            needs.push(args[i]);
    }
    if (!needs.length && !learned.length) {
        process.stderr.write('usage: brain-client.mjs search "<need>" ["<need>" ...] [--learned "<what was learned or corrected>" ...]' + NL);
        process.exit(1);
    }
    const r = call('/search', { method: 'POST', body: { needs, learned } });
    if (!r || !Array.isArray(r.memories)) {
        process.stderr.write('search failed: the brain server did not answer' + NL);
        process.exit(2);
    }
    process.stdout.write('BRAIN RECALL: ' + r.memories.length + ' memories. Open the ones you need with node "' + join(BRAIN, 'tools', 'brain-client.mjs').replace(/\\/g, '/') + '" read <slug> (or the file in memory/ on the brain host) before answering.' + NL);
    for (const m of r.memories)
        process.stdout.write('- ' + m.slug + (m.how === 'both' ? ' [keyword and meaning]' : ' [' + m.score + ']') + ': ' + m.description.slice(0, 100) + NL);
    if (r.learned && r.learned.length) {
        process.stdout.write(NL + 'LEARNED, check each against the brain now:' + NL);
        for (const l of r.learned) {
            process.stdout.write('* ' + l.item + NL);
            if (!l.closest.length)
                process.stdout.write('  nothing close in the brain: write it as a new memory.' + NL);
            for (const c of l.closest)
                process.stdout.write('  closest: ' + c.slug + ' [' + c.score + ']: ' + c.description.slice(0, 140) + NL);
        }
        process.stdout.write('For each: already said correctly in a memory, nothing to do; missing, write a new memory; an old memory says the opposite, replace it, which keeps an archive of the old one (on the brain host: node tools/replace-memory.mjs old new --why "..."; on another machine: brain-client.mjs write the new one, then brain-client.mjs delete the old one, which the server archives). If all are already saved correctly, run: node "' + join(BRAIN, 'tools', 'brain-client.mjs').replace(/\\/g, '/') + '" search --saved' + NL);
    }
}
else if (cmd === 'repo' && existsSync(REPO_TOOL)) {
    const r = spawnSync(process.execPath, [REPO_TOOL, ...process.argv.slice(3)], { stdio: 'inherit', windowsHide: true });
    process.exit(r.status == null ? 1 : r.status);
}
else if (cmd === 'wa') {
    const { runWa } = await import('./wa-client.mjs').catch(() => ({ runWa: null }));
    if (!runWa) {
        process.stderr.write('the WhatsApp tool is not part of this install' + NL);
        process.exit(2);
    }
    process.exitCode = runWa(process.argv.slice(3));
}
else if (cmd === 'read') {
    if (!arg) {
        process.stderr.write('usage: brain-client.mjs read <slug>' + NL);
        process.exit(1);
    }
    const slug = arg.slice(-3) === '.md' ? arg.slice(0, -3) : arg;
    const r = call('/memory/' + encodeURIComponent(slug));
    if (r && typeof r.content === 'string') {
        process.stdout.write(r.content);
    }
    else {
        try {
            process.stdout.write(readFileSync(join(BRAIN, 'memory', slug + '.md'), 'utf8'));
        }
        catch {
            process.stderr.write('no memory named ' + slug + ' on the server or on this machine' + NL);
            process.exit(1);
        }
    }
}
else {
    process.stdout.write([
        'brain-client.mjs, talk to the live brain server with a local fallback',
        '',
        '  status                      is the server up, and what works on this machine',
        '  bootstrap                   fetch the vault passphrase onto this machine, once',
        '  list                        secret names and dates',
        '  secret <name>               print one secret value',
        '  read <slug>                 print one memory, from the server, no local copy needed',
        '  write <slug> --file <path>  write a memory through the server (also --stdin)',
        ...(existsSync(REPO_TOOL) ? ['  repo list|url|clone|pull|push   any repo from the git server' + (gitServerUrl() ? ' (' + gitServerUrl() + ')' : '') + ', no GitHub'] : []),
        '',
        'Server URL: ' + URL_BASE + '  (override with HAVOK_SERVER_URL)',
        '',
    ].join('\n'));
}
