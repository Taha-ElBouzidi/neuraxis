import { execFileSync, execSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { mergeSharedSettings, wireAntigravity, wantsGitHooks, ensurePreTurnHook, verifyWithRetry, ensureGlobalGitHooks } from '../tools/session-setup.mjs';
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = resolve(homedir(), '.claude', 'havok-brain-path');
const isPluginCopy = (p) => /[\\/]plugins[\\/]/.test(p);
const isBrainRepo = (p) => {
    try {
        return !!p && existsSync(resolve(p, '.git')) && existsSync(resolve(p, 'memory'));
    }
    catch {
        return false;
    }
};
let marked = null;
try {
    marked = readFileSync(MARKER, 'utf8').trim();
}
catch { }
if (!isPluginCopy(HERE) && isBrainRepo(HERE) && !isBrainRepo(marked)) {
    try {
        writeFileSync(MARKER, HERE, 'utf8');
        marked = HERE;
    }
    catch { }
}
const BRAIN = [process.env.HAVOK_BRAIN, marked, HERE].find(isBrainRepo) || HERE;
const memDir = join(BRAIN, 'memory');
let localMemories = 0;
try {
    localMemories = readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length;
}
catch {
    localMemories = 0;
}
const noLocalBrain = localMemories === 0 || (isPluginCopy(BRAIN) && !existsSync(join(BRAIN, '.git')));
const LF = String.fromCharCode(10);
function runIn(cwd, cmd, ms) {
    const t0 = Date.now();
    try {
        const out = execSync(cmd, { cwd, encoding: 'utf8', timeout: ms, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        return { ok: true, out, err: '', stderr: '', ms: Date.now() - t0 };
    }
    catch (e) {
        const stderr = String((e && e.stderr) || '').trim();
        const err = stderr.split(LF).map((l) => l.trim()).filter(Boolean)[0] || '';
        return { ok: false, out: '', err, stderr, ms: Date.now() - t0, timedOut: !!(e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM')) };
    }
}
const tryRun = (cmd, ms) => runIn(BRAIN, cmd, ms);
const notes = [];
if (BRAIN !== HERE && isBrainRepo(HERE)) {
    runIn(HERE, 'git checkout -- memory/MEMORY.md index/ MANIFEST.md', 8000);
    const pluginPull = runIn(HERE, 'git pull --no-rebase --quiet', 15000);
    if (!pluginPull.ok)
        notes.push('NOTE: could not update the plugin copy of the brain at ' + HERE.replace(/\\/g, '/') + '. Its enforcement hooks may be stale. Run: claude plugin marketplace update');
}
{
    const note = ensurePreTurnHook({ brain: BRAIN, home: homedir() });
    if (note)
        notes.push(note);
}
try {
    const bj = JSON.parse(readFileSync(resolve(BRAIN, 'brain.json'), 'utf8'));
    if (bj.noClaudeAttribution === true) {
        const settingsPath = resolve(homedir(), '.claude', 'settings.json');
        const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
        const a = s.attribution || {};
        if (a.commit !== '' || a.pr !== '' || a.sessionUrl !== false) {
            s.attribution = { ...a, commit: '', pr: '', sessionUrl: false };
            writeFileSync(settingsPath, JSON.stringify(s, null, 2), 'utf8');
            notes.push('Turned off Claude attribution in commits and pull requests on this machine (~/.claude/settings.json attribution).');
        }
    }
}
catch { }
try {
    const changed = mergeSharedSettings({ here: HERE, home: homedir() });
    if (changed.length)
        notes.push('Applied the shared Claude Code settings (hooks/claude-settings.json) to ~/.claude/settings.json: ' + changed.join(', ')
            + '. The permission mode applies to sessions started from now on; restart a session that is still in auto mode.');
}
catch { }
try {
    wireAntigravity({ here: HERE, home: homedir() });
}
catch { }
try {
    const cacheRoot = resolve(homedir(), '.claude', 'plugins', 'cache', 'havok-brain');
    let loadedPath = '';
    let loadedVer = '';
    try {
        const reg = JSON.parse(readFileSync(resolve(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8'));
        const rec = ((reg.plugins || reg)['havok-brain@havok-brain'] || [])[0];
        if (rec && rec.installPath) {
            loadedPath = resolve(rec.installPath);
            loadedVer = rec.version || '';
        }
    }
    catch { }
    if (existsSync(cacheRoot)) {
        const liveCount = readdirSync(join(BRAIN, 'memory')).filter((f) => f.endsWith('.md')).length;
        const copies = [];
        const stack = [cacheRoot];
        while (stack.length) {
            const dir = stack.pop();
            let kids = [];
            try {
                kids = readdirSync(dir, { withFileTypes: true });
            }
            catch {
                continue;
            }
            if (kids.some((k) => k.isDirectory() && k.name === 'memory')) {
                const n = readdirSync(join(dir, 'memory')).filter((f) => f.endsWith('.md')).length;
                copies.push({ dir: resolve(dir), n, hooks: existsSync(join(dir, 'hooks', 'hooks.json')) });
                continue;
            }
            for (const k of kids)
                if (k.isDirectory())
                    stack.push(join(dir, k.name));
        }
        const norm = (p) => p.split(String.fromCharCode(92)).join('/');
        const loaded = copies.find((c) => c.dir === loadedPath);
        if (loaded && (loaded.n < liveCount - 10 || !loaded.hooks)) {
            notes.push('STALE PLUGIN COPY LOADS HERE: the recorded install path ' + norm(loaded.dir) + ' (version '
                + (loadedVer || '?') + ') has ' + loaded.n + ' memories against the live ' + liveCount
                + (loaded.hooks ? '' : ' and no hooks.json') + '. Hook code runs from here. Fix: claude plugin marketplace update havok-brain, then claude plugin update havok-brain@havok-brain -y, then restart.');
        }
        const leftover = copies.filter((c) => c.dir !== loadedPath && (c.n < liveCount - 10 || !c.hooks));
        if (leftover.length && loaded) {
            notes.push('Old plugin copies left on disk, not loaded (' + leftover.map((c) => norm(c.dir).split('/').pop()).join(', ')
                + '); the loaded one is ' + (loadedVer || '?') + '. Harmless, removable when convenient.');
        }
        else if (leftover.length && !loadedPath) {
            notes.push('Plugin copies found but installed_plugins.json was unreadable, so which one loads is unconfirmed: '
                + leftover.map((c) => norm(c.dir) + ' (' + c.n + ' memories' + (c.hooks ? '' : ', no hooks') + ')').join('; ') + '.');
        }
    }
}
catch { }
try {
    const alive = resolve(homedir(), '.claude', 'havok-embed.alive');
    const server = join(BRAIN, 'tools', 'embed-server.mjs');
    const embedPort = process.env.HAVOK_EMBED_PORT || 8477;
    let running = false;
    if (existsSync(alive)) {
        let out = '';
        try {
            out = execFileSync('curl', ['-s', '-w', '\\n%{http_code} %{time_connect}', '--connect-timeout', '1', '--max-time', '2',
                'http://127.0.0.1:' + embedPort + '/health'], { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        }
        catch (e) {
            out = String((e && e.stdout) || '');
        }
        const [code, connect] = (out.trim().split(/\r?\n/).pop() || '').split(' ');
        running = !out.trim() || (code === '200' ? out.includes('"ok"') : Number(connect) > 0);
        if (!running) {
            try {
                unlinkSync(alive);
            }
            catch { }
        }
    }
    if (!running && existsSync(server)) {
        if (!noLocalBrain && !existsSync(join(BRAIN, 'node_modules', '@xenova', 'transformers'))) {
            notes.push('Semantic recall is unavailable on this machine: run npm install in ' + BRAIN.split(String.fromCharCode(92)).join('/') + ' to enable it. Recall falls back to keyword only until then.');
        }
        else {
            const child = spawn(process.execPath, [server], { detached: true, stdio: 'ignore', cwd: BRAIN });
            child.unref();
            notes.push('Started the embedding daemon for semantic recall. It takes a few seconds to load; the first turn or two may be keyword only.');
        }
    }
}
catch { }
try {
    let isHost = false;
    try {
        const r = JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8'));
        const me = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
        isHost = (r.host || '').toUpperCase() === me;
    }
    catch { }
    const server = join(BRAIN, 'tools', 'brain-server.mjs');
    if (isHost && existsSync(server)) {
        const certArg = '--cacert "' + join(BRAIN, 'server-cert.pem').split(String.fromCharCode(92)).join('/') + '"';
        const probe = runIn(BRAIN, 'curl -s --connect-timeout 1 --max-time 2 ' + certArg + ' https://127.0.0.1:8443/health', 4000);
        const up = probe.ok && probe.out.includes('"ok"');
        if (!up) {
            const child = spawn(process.execPath, [server, '--public'], { detached: true, stdio: 'ignore', cwd: BRAIN, windowsHide: true });
            child.unref();
            notes.push('Started the brain server on port 8443 (TLS). It serves recall, the vault and embeddings to every machine on the tailnet; they reach it with tools/brain-client.mjs.');
        }
    }
}
catch { }
function serverGet(brain, path) {
    let url = (process.env.HAVOK_SERVER_URL || '').replace(/[/]$/, '');
    let magic = '';
    try {
        const ep = JSON.parse(readFileSync(join(brain, 'server-endpoint.json'), 'utf8'));
        if (!url)
            url = String(ep.url || '').replace(/[/]$/, '');
        magic = ((ep.tailnet || {}).magicdns) || '';
    }
    catch { }
    if (!url)
        url = 'https://127.0.0.1:8443';
    let token = (process.env.HAVOK_SERVER_TOKEN || '').trim();
    if (!token) {
        try {
            token = readFileSync(resolve(homedir(), '.claude', 'havok-server-token'), 'utf8').trim();
        }
        catch {
            token = '';
        }
    }
    if (!token)
        return '';
    const host = (url.match(/^https?:\/\/([^:/]+)(?::(\d+))?/) || []);
    const byName = Boolean(magic && host[1] && /^[0-9.]+$/.test(host[1]));
    const cert = join(brain, 'server-cert.pem');
    const conf = ['header = "Authorization: Bearer ' + token + '"',
        'url = "' + (byName ? 'https://' + magic + (host[2] ? ':' + host[2] : '') : url) + path + '"']
        .concat(byName ? ['connect-to = "' + magic + ':' + host[2] + ':' + host[1] + ':' + host[2] + '"'] : [])
        .concat(existsSync(cert) ? ['cacert = "' + cert.split(String.fromCharCode(92)).join('/') + '"'] : [])
        .concat(['silent', 'fail', 'connect-timeout = 3', 'max-time = 15']);
    try {
        return execFileSync('curl', ['-K', '-'], {
            input: conf.join(LF) + LF, encoding: 'utf8', timeout: 18000, windowsHide: true,
            stdio: ['pipe', 'pipe', 'ignore'],
        });
    }
    catch {
        return '';
    }
}
function vaultProbe(brain) {
    let url = (process.env.HAVOK_SERVER_URL || '').replace(/[/]$/, '');
    if (!url) {
        try {
            url = JSON.parse(readFileSync(join(brain, 'server-endpoint.json'), 'utf8')).url || '';
        }
        catch {
            url = '';
        }
    }
    if (!url)
        url = 'https://127.0.0.1:8443';
    let token = (process.env.HAVOK_SERVER_TOKEN || '').trim();
    if (!token) {
        try {
            token = readFileSync(resolve(homedir(), '.claude', 'havok-server-token'), 'utf8').trim();
        }
        catch {
            token = '';
        }
    }
    if (!token)
        return { code: 'no-token', count: 0 };
    const cert = join(brain, 'server-cert.pem');
    const conf = 'header = "Authorization: Bearer ' + token + '"' + LF
        + (existsSync(cert) ? 'cacert = "' + cert.split(String.fromCharCode(92)).join('/') + '"' + LF : '')
        + 'url = "' + url + '/vault/list"' + LF + 'silent' + LF + 'connect-timeout = 2' + LF + 'max-time = 5' + LF
        + 'write-out = "__CODE__%{http_code}"' + LF;
    let out = '';
    try {
        out = execFileSync('curl', ['-K', '-'], { input: conf, encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    }
    catch (e) {
        out = String((e && e.stdout) || '');
    }
    const i = out.lastIndexOf('__CODE__');
    if (i === -1)
        return { code: '000', count: 0 };
    const code = out.slice(i + 8).trim() || '000';
    let count = 0;
    if (code === '200') {
        try {
            count = (JSON.parse(out.slice(0, i)).secrets || []).length;
        }
        catch {
            count = -1;
        }
    }
    return { code, count };
}
let serverAnswered = null;
try {
    const agekey = resolve(homedir(), '.claude', 'havok-age-key.txt');
    const vaultPath = join(BRAIN, 'vault.json');
    const me = (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
    let vault = { secrets: {} };
    try {
        vault = JSON.parse(readFileSync(vaultPath, 'utf8'));
    }
    catch { }
    const total = Object.keys(vault.secrets || {}).length;
    const readable = Object.values(vault.secrets || {}).filter((b) => b.keys && b.keys[me]).length;
    let vaultHost = '';
    try {
        vaultHost = String(JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8')).host || '').toUpperCase();
    }
    catch {
        vaultHost = '';
    }
    const isHost = vaultHost !== '' && vaultHost === me;
    if (!isHost) {
        const v = vaultProbe(BRAIN);
        serverAnswered = v.code === '200' || v.code === '403';
        if (total === 0) {
        }
        else if (v.code === '200') {
            notes.push('VAULT: ' + (v.count < 0 ? 'readable' : v.count + ' secret(s) readable') + ' through the server from ' + me + '. Fetch one with: node tools/brain-client.mjs secret <name>.');
        }
        else if (v.code === '403') {
            notes.push('VAULT: secrets are deliberately withheld from ' + me + ' (recall-scoped token). Memories and rules work normally. Do not ask the person for a credential and do not run connect-machine.');
        }
        else if (v.code === '401') {
            notes.push('VAULT: the server rejected this machine token (401), so secrets are unavailable until the host issues a new one. Memories work from the local copy. Do not run connect-machine.');
        }
        else if (v.code === 'no-token') {
            notes.push('VAULT: no server token on ' + me + ', so secrets and live recall are unavailable until the host issues one (see reference_brain_live_server). Memories work from the local copy. Do not run connect-machine.');
        }
        else {
            notes.push('VAULT: the server did not answer /vault/list from ' + me + ' (curl ' + v.code + '). Secrets are unavailable until it is back; memories work from the local copy. Nothing to install.');
        }
    }
    else if (total > 0 && readable === 0) {
        notes.push('ACTION REQUIRED, do this before anything else. This machine (' + me + ') is not connected '
            + 'to the vault: ' + total + ' secret(s) are present and 0 are readable. Run this ONE command now, '
            + 'it needs no input and no admin:' + String.fromCharCode(10)
            + '    node tools/connect-machine.mjs' + String.fromCharCode(10)
            + 'It installs age if missing, generates this machine key (the private half never leaves), publishes '
            + 'ONLY the public half as a request, and pushes it. Then an agent on the host approves. Until then '
            + 'memories and rules work normally and secrets do not. Do NOT ask the person for any credential in the '
            + 'meantime, and do NOT ask him to run anything: this is fully automatic.');
    }
    else if (total > 0 && readable < total) {
        notes.push('VAULT: ' + readable + ' of ' + total + ' secrets readable on ' + me
            + '. The rest were deliberately not granted to this machine.');
    }
    try {
        const reqDir = join(BRAIN, 'vault-requests');
        const reg = JSON.parse(readFileSync(join(BRAIN, 'vault-recipients.json'), 'utf8'));
        if ((reg.host || '').toUpperCase() === me && existsSync(reqDir)) {
            const pending = readdirSync(reqDir).filter((f) => f.endsWith('.json'))
                .map((f) => f.replace(/\.json$/, '')).filter((n) => !reg.machines[n]);
            if (pending.length) {
                notes.push('VAULT REQUESTS PENDING from: ' + pending.join(', ')
                    + '. Approve with: node tools/vault.mjs approve <NAME>, then commit and push. '
                    + 'Check the name against the person\'s known machines first; a company-issued machine must never be approved.');
            }
        }
    }
    catch { }
    if (!noLocalBrain && !existsSync(join(BRAIN, 'node_modules', '@xenova', 'transformers'))) {
        notes.push('Semantic recall is OFF on this machine: run npm install in ' + BRAIN.split(String.fromCharCode(92)).join('/')
            + '. Recall works on keywords alone until then, which misses anything phrased differently from the memory.');
    }
}
catch { }
const pushUrl = noLocalBrain ? { ok: false, out: '' } : tryRun('git remote get-url --push origin', 5000);
const serverOnly = noLocalBrain || (pushUrl.ok && pushUrl.out.trim().startsWith('DISABLED-'));
const remoteReachable = noLocalBrain ? false
    : (serverOnly ? tryRun('git ls-remote --exit-code -q origin HEAD', 10000).ok : true);
let beforeRev = noLocalBrain ? { ok: false, out: '' } : tryRun('git rev-parse HEAD', 5000);
let unwedge = { ok: true, out: '' };
let pull = { ok: false, out: '', err: 'GitHub is not reachable from this machine', stderr: '' };
if (remoteReachable) {
    const genDirty = tryRun('git status --porcelain -- memory/MEMORY.md index/ MANIFEST.md', 5000);
    if (genDirty.ok && genDirty.out.trim()) {
        const restored = tryRun('git checkout -- memory/MEMORY.md index/ MANIFEST.md', 8000);
        if (restored.ok)
            notes.push('Discarded local edits to generated files (memory/MEMORY.md, index/, MANIFEST.md) so the pull could proceed. They are rebuilt from memory/, nothing was lost.');
    }
    beforeRev = tryRun('git rev-parse HEAD', 5000);
    unwedge = tryRun('node tools/unwedge-pull.mjs', 30000);
    pull = tryRun('git pull --no-rebase --quiet', 15000);
}
if (pull.ok && beforeRev.ok) {
    const afterRev = tryRun('git rev-parse HEAD', 5000);
    if (afterRev.ok && afterRev.out && afterRev.out !== beforeRev.out) {
        const changed = tryRun('git diff --name-only ' + beforeRev.out + ' ' + afterRev.out + ' -- hooks/ .claude-plugin/', 8000);
        if (changed.ok && changed.out.trim()) {
            notes.push('Brain HOOKS changed in this pull, so the plugin copy on this machine is stale:');
            notes.push('  claude plugin marketplace update');
            notes.push('  then restart Claude Code (or run /hooks once) - hooks only load at session start.');
            notes.push('Details: memory/reference_brain_machine_update.md');
        }
    }
}
let pushLine = '';
if (pull.ok) {
    const upstream = tryRun('git rev-parse --abbrev-ref --symbolic-full-name @{u}', 5000);
    if (upstream.ok && upstream.out) {
        const ahead = tryRun('git rev-list --count ' + upstream.out + '..HEAD', 5000);
        const aheadCount = ahead.ok ? parseInt(ahead.out, 10) || 0 : 0;
        if (aheadCount > 0) {
            const push = tryRun('git push --quiet', 20000);
            pushLine = push.ok
                ? 'Flushed ' + aheadCount + ' commit(s) that were stuck local, now pushed.'
                : 'WARNING: ' + aheadCount + ' commit(s) are still stuck local, push failed again this session.';
        }
    }
}
const unwedgeSummary = (unwedge.out.split(LF).find((l) => l.startsWith('unwedge:')) || '').replace('unwedge: ', '').trim();
const keptFiles = unwedge.out.split(LF).filter((l) => l.includes('kept, differs')).map((l) => l.split(': ').pop().trim());
const gitBlocked = /would be overwritten/.test(pull.stderr || '');
const indented = new RegExp('^[ ' + String.fromCharCode(9) + ']+[^ ]');
const gitFiles = gitBlocked ? (pull.stderr || '').split(LF).filter((l) => indented.test(l)).map((l) => l.trim()).filter((l) => !/^Please|^Aborting|^error|^hint/.test(l)) : [];
const blockedFiles = keptFiles.length ? keptFiles : gitFiles;
const offline = !remoteReachable || /fetch failed/.test(unwedgeSummary) || /unable to access|Could not read from remote|Could not resolve|Connection refused|timed out|Network is unreachable/.test(pull.stderr || '');
const unwedgeNote = unwedge.ok ? '' : ' Unwedge did not run on this machine (tools older than the fix, or node failed); pull it once by hand.';
let syncLine;
if (noLocalBrain) {
    syncLine = serverAnswered
        ? 'Server-only machine: no memories on disk, which is the designed state. The brain server answered, so the tiers below came from it and recall reads it every turn. Git is not used here and nothing is stale.'
        : 'WARNING: THE BRAIN SERVER DID NOT ANSWER and this machine keeps no memories of its own, so you have NO recall this session. Say so in your first reply and do not answer from anything local. Check Tailscale, then: node tools/brain-client.mjs status';
}
else if (pull.ok) {
    const touched = /moved [1-9]|restored [1-9]/.test(unwedgeSummary);
    syncLine = 'Brain synced (git pull ok).' + (touched ? ' Unwedge first: ' + unwedgeSummary + '.' : '') + (pushLine ? ' ' + pushLine : '');
}
else if (blockedFiles.length) {
    syncLine = 'WARNING: brain pull BLOCKED by ' + blockedFiles.length + ' local file(s) that differ from the remote, left untouched to protect work: ' + blockedFiles.join(', ') + '. Memory is STALE until they are reconciled by hand: diff each against origin, then git checkout -- <file> or commit it.' + unwedgeNote;
}
else if (offline && serverOnly && serverAnswered) {
    syncLine = 'Server-only machine: GitHub is not reachable from here, which is expected on this network. Memories and rules come from the brain server, which answered; code arrives through the mirror. Nothing is stale.';
}
else if (offline && serverOnly) {
    syncLine = 'WARNING: server-only machine, and the brain server did not answer at session start. Recall runs on the local fallback copy until it is back; say so in your first reply if memory matters for the task.';
}
else if (offline) {
    syncLine = 'WARNING: brain pull FAILED, the remote could not be reached' + (pull.err ? ' (' + pull.err + ')' : '') + '. Memory is STALE; nothing local was changed.' + unwedgeNote;
}
else {
    syncLine = 'WARNING: brain pull FAILED' + (pull.err ? ': ' + pull.err : ' for an unnamed reason') + '. Memory is STALE. Run git pull by hand to see the full error.' + (unwedge.ok ? ' Unwedge ran first (' + (unwedgeSummary || 'no output') + ').' : unwedgeNote);
}
const hp = noLocalBrain || !wantsGitHooks(BRAIN) ? { ok: true, out: 'hooks/git' } : tryRun('git config --get core.hooksPath', 5000);
if (!hp.ok || hp.out !== 'hooks/git') {
    const set = tryRun('git config core.hooksPath hooks/git', 5000);
    if (set.ok)
        notes.push('Armed the brain git pre-commit gate on this machine (core.hooksPath).');
}
{
    const note = ensureGlobalGitHooks({ hooksDir: join(dirname(fileURLToPath(import.meta.url))), home: homedir(), git: (args) => { try {
            return execFileSync('git', args, { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        }
        catch {
            return '';
        } } });
    if (note)
        notes.push(note);
}
try {
    const skillsDir = resolve(homedir(), '.claude', 'skills');
    if (existsSync(skillsDir)) {
        const ours = readdirSync(skillsDir).filter((n) => existsSync(resolve(skillsDir, n, '.installed-by-brain')));
        for (const n of ours)
            rmSync(resolve(skillsDir, n), { recursive: true, force: true });
        if (ours.length)
            notes.push('Removed ' + ours.length + ' starter-kit skill folder(s): methods are how-to memories now, found by recall.');
    }
}
catch { }
const vr = serverOnly ? { ok: true, out: '' } : verifyWithRetry(() => tryRun('node "' + BRAIN.split(String.fromCharCode(92)).join('/') + '/tools/verify.mjs" --quiet', 40000), (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
const prLine = serverOnly
    ? 'Gate: not run here, this machine never commits to the shared brain; verify runs on the brain host and on every server write.'
    : vr.ok ? 'Brain verify PASSED.' : vr.timedOut ? 'Brain verify did not finish in time here, so it was not judged (the brain is not known to be broken). To check: node tools/verify.mjs' : 'WARNING: brain verify FAILED. The shared brain is broken for every machine. Run: node tools/verify.mjs';
if (!vr.ok && !vr.timedOut) {
    notes.push('Brain verification is failing. Fix before making other changes:');
    notes.push('  node tools/verify.mjs');
    notes.push('A red gate usually means a hook or tool does not parse, the generated index');
    notes.push('drifted from memory/, or reflect.mjs found contradictions.');
}
function readTier(rel, cap) {
    try {
        const body = readFileSync(resolve(BRAIN, rel), 'utf8').replace(/\r\n/g, '\n').trim();
        if (!body)
            return null;
        if (body.length > cap) {
            return body.slice(0, cap) + `\n\n[TRUNCATED at ${cap} chars. ${rel} has outgrown its injection budget, so entries below this line are INVISIBLE to this session. Fix the brain, do not assume this list is complete.]`;
        }
        return body;
    }
    catch {
        return null;
    }
}
try {
    globalThis.__havokEv = readFileSync(0, 'utf8') || '{}';
}
catch { }
let layersLive = false;
try {
    const sid = String(JSON.parse(globalThis.__havokEv || '{}').session_id || '');
    if (/^[A-Za-z0-9_-]{6,80}$/.test(sid))
        layersLive = existsSync(resolve(homedir(), '.claude', 'havok-mod', 'layers-live', sid));
}
catch { }
const reflex = layersLive ? null : readTier('REFLEX.md', 16000);
let router = layersLive ? null : readTier('memory/MEMORY.md', 16000);
let hot = layersLive ? null : readTier('index/HOT.md', 16000);
if (noLocalBrain && !layersLive) {
    if (!router) {
        try {
            router = (JSON.parse(serverGet(BRAIN, '/memory/MEMORY')).content || '').trim().slice(0, 16000) || null;
        }
        catch {
            router = null;
        }
    }
    if (!hot)
        hot = (serverGet(BRAIN, '/index/HOT.md') || '').trim().slice(0, 16000) || null;
}
const parts = [
    'BRAIN: ' + syncLine + ' ' + prLine + ' Enforcement hooks (no em dash, no emoji, secret scan) are active via the havok-brain plugin.',
];
if (notes.length)
    parts.push(notes.join('\n'));
if (layersLive) {
}
else if (reflex || router || hot) {
    parts.push('', 'The brain below IS your memory. It is injected in full, so do not re-read these files.', '', 'RECALL IS NOT OPTIONAL AND IT IS NOT A SEARCH. Every turn, the brain searches ALL of its', 'memories against what was just said and names the ones that match. OPEN them, ' + (noLocalBrain
        ? 'with `node tools/brain-client.mjs read <slug>`, before you answer or act.'
        : 'at'), noLocalBrain ? '' : '`' + BRAIN.replace(/\\/g, '/') + '/memory/<slug>.md`, before you answer or act.', 'A description tells you whether to open a file, never what the file says, so never answer', 'from the one line alone.', '', 'The list below is NOT the whole brain and does not need to be. It is what this fleet has been', 'using and what changed this week, so you know what you are walking into. To look by hand: ' + (noLocalBrain
        ? 'ask the server, nothing is on this disk.'
        : 'MANIFEST.md holds every slug on disk, index/<type>.md holds one type, grep -ril finds a term.'), '', 'The most common failure is skipping this because you believe you already know the answer.', 'You cannot know what the brain corrected, superseded, or decided since you last looked.', 'When you learn something durable, write it back ' + (noLocalBrain
        ? 'with `node tools/brain-client.mjs write <slug> --file <path>`. Never create a file under'
            + ' memory/ on this machine: the mirror treats anything the server does not list as deleted.'
        : 'as a memory file under memory/.'));
    const LOCAL_MEMORIES = !noLocalBrain;
    const REMEDY = LOCAL_MEMORIES
        ? ' Rebuild it here: node tools/build-index.mjs'
        : ' This machine deliberately keeps no local copy of the brain, so this is EXPECTED and you must NOT create one. Recall comes from the server on every turn regardless.';
    if (!reflex)
        parts.push('', 'WARNING: REFLEX.md is missing or unreadable, so the always-on hard rules are NOT loaded. Treat nothing below as complete and fix the brain at ' + BRAIN.replace(/\\/g, '/'));
    if (!router)
        parts.push('', 'NOTE: memory/MEMORY.md is not readable here, so you have no router.' + REMEDY);
    if (!hot)
        parts.push('', 'NOTE: index/HOT.md is not readable here, so you start with no sense of what is in play. Per-prompt recall still reaches every memory, so this is not a broken brain.' + REMEDY);
    if (reflex)
        parts.push('', '===== BRAIN TIER 0: REFLEX (always applies) =====', reflex);
    if (router)
        parts.push('', '===== BRAIN TIER 1: MEMORY ROUTER =====', router);
    if (hot)
        parts.push('', '===== BRAIN TIER 1.5: HOT, what is in play right now (NOT everything) =====', hot);
}
else {
    parts.push('WARNING: could not read REFLEX.md or memory/MEMORY.md. The brain is NOT loaded into this session. Read them manually from ' + BRAIN.replace(/\\/g, '/'));
}
try {
    const ev2 = JSON.parse(globalThis.__havokEv || "{}");
    if (ev2.source === "compact") {
        let open = "";
        try {
            open = readFileSync(join(BRAIN, "memory", "project_open_items.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "");
        }
        catch { }
        parts.push("", "===== AFTER COMPACT =====", "This conversation was just compacted into a summary. Exact facts are NOT in the summary: get them from the brain (recall, or read the memory), or from the full transcript at " + String(ev2.transcript_path || "").split(String.fromCharCode(92)).join("/") + " (read only the part you need, it is large).", ...(open ? ["", "OPEN ITEMS (memory/project_open_items.md):", open.slice(0, 6000)] : []));
    }
}
catch { }
if (!layersLive)
    try {
        const fwd = (p) => p.replace(/\\/g, '/');
        const t = fwd(resolve(HERE, 'tools'));
        const local = !noLocalBrain;
        const fill = {
            WHERE: local
                ? 'The memories are files in `' + fwd(BRAIN) + '/memory/`. Write them there with the Write tool.'
                : 'The memories live on the brain server only; this machine keeps no copy and must never create files under memory/. Write one by putting it in a temporary file, then `node "' + t + '/brain-client.mjs" write <slug> --file <path>`.',
            SAVE: local
                ? 'After writing, run `node tools/save-brain.mjs "<what changed>"` from ' + fwd(BRAIN) + ': it indexes, verifies, commits and pushes in the background.'
                : 'The server indexes and backs up what you write, in the background.',
            CHECK: local
                ? 'run `node tools/neuron-check.mjs --desc "<description>"` from ' + fwd(BRAIN) + ' (0.75 or more means it is already there).'
                : 'run `node "' + t + '/brain-client.mjs" search "<description>"` and read the close matches.',
            REPLACE: local
                ? '`node tools/replace-memory.mjs <old> <new> --why "<reason>"`'
                : 'write the corrected one, then `node "' + t + '/brain-client.mjs" delete <old> --why "<reason>"`',
        };
        const mi = readFileSync(resolve(HERE, 'hooks', 'memory-instructions.md'), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => fill[k] || m);
        parts.push('', mi.trim());
    }
    catch { }
const out = {
    hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: parts.join('\n'),
    }
};
process.stdout.write(JSON.stringify(out));
process.exit(0);
