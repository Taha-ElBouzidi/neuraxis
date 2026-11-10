import { readFileSync, writeFileSync, appendFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { homedir, hostname } from 'node:os';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_DIR = process.env.HAVOK_HOME || resolve(homedir(), '.claude');
export const MAX_PER_HOUR = 3;
const HOUR_MS = 3600 * 1000;
const PROBES = 3;
const PROBE_GAP_MS = 5000;
const PROBE_TIMEOUT_MS = 5000;
const UP_WAIT_MS = 120000;
const UP_POLL_MS = 2000;
const LOCK_STALE_MS = 10 * 60 * 1000;
export const TARGETS = {
    brain: { url: 'https://127.0.0.1:8443/health', port: 8443, task: 'HavokBrainServer', script: 'brain-server' },
    embed: { url: 'http://127.0.0.1:8477/health', port: 8477, task: 'HavokEmbedServer', script: 'embed-server' },
};
export function probeHealth(url, { timeoutMs = PROBE_TIMEOUT_MS, ca = null } = {}) {
    return new Promise((done) => {
        const t0 = Date.now();
        const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(url, { method: 'GET', ...(ca ? { ca } : {}) }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            res.on('end', () => done({ ok: res.statusCode === 200 && /"ok"\s*:\s*true/.test(body), status: res.statusCode, ms: Date.now() - t0 }));
        });
        req.on('error', (e) => done({ ok: false, error: String(e.message).slice(0, 80), ms: Date.now() - t0 }));
        req.setTimeout(timeoutMs, () => req.destroy(new Error('no answer in ' + timeoutMs + ' ms')));
        req.end();
    });
}
export async function recover({ what, why, enabled, now, sleep, probe, restart, state, log, alert, refuse = '' }) {
    if (refuse) {
        log({ at: new Date(now()).toISOString(), what, why, action: 'refused', reason: refuse });
        return 'refused';
    }
    const before = [];
    for (let i = 0; i < PROBES; i++) {
        if (i)
            await sleep(PROBE_GAP_MS);
        const r = await probe();
        before.push(r);
        if (r.ok) {
            log({ at: new Date(now()).toISOString(), what, why, action: 'none', reason: 'answered /health', before });
            return 'healthy';
        }
    }
    const recent = (state.restarts[what] || []).filter((t) => now() - t < HOUR_MS);
    if (recent.length >= MAX_PER_HOUR) {
        const text = 'the ' + what + ' server failed /health ' + PROBES + ' times and was NOT restarted: already '
            + recent.length + ' restarts in the last hour. A person or the main agent must look at the cause. Last failure: ' + why;
        log({ at: new Date(now()).toISOString(), what, why, action: 'capped', restartsLastHour: recent.length, before });
        alert('recover-capped-' + what, text);
        state.restarts[what] = recent;
        return 'capped';
    }
    if (!enabled) {
        log({ at: new Date(now()).toISOString(), what, why, action: 'would-restart', reason: 'recovery is not switched on', before });
        return 'disabled';
    }
    state.restarts[what] = recent.concat([now()]);
    let how = null;
    try {
        how = await restart();
    }
    catch (e) {
        how = { error: String((e && e.message) || e).slice(0, 200) };
    }
    const after = [];
    const until = now() + UP_WAIT_MS;
    for (;;) {
        const r = await probe();
        after.push(r);
        if (r.ok || now() >= until)
            break;
        await sleep(UP_POLL_MS);
    }
    const up = after[after.length - 1].ok;
    log({ at: new Date(now()).toISOString(), what, why, action: 'restarted', how, before, after: after.slice(-3), up, restartsLastHour: state.restarts[what].length });
    if (!up)
        alert('recover-failed-' + what, 'the ' + what + ' server was restarted after failing /health and still does not answer it. Last failure: ' + why);
    return up ? 'restarted' : 'restart-failed';
}
export function certRefusal(what, ca) {
    return what === 'brain' && !ca ? 'server-cert.pem cannot be read, so /health cannot be checked over https; not restarted' : '';
}
const TASK_WAIT_TRIES = 20;
export function restartScript(t) {
    return [
        "$ErrorActionPreference = 'Stop'",
        '$c = Get-NetTCPConnection -State Listen -LocalPort ' + t.port + ' -ErrorAction SilentlyContinue | Select-Object -First 1',
        "$killed = ''",
        'if ($c) {',
        '  $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess)',
        "  if ($p -and $p.CommandLine -like '*" + t.script + "*') { Stop-Process -Id $p.ProcessId -Force; $killed = [string]$p.ProcessId }",
        "  else { throw ('port " + t.port + " is held by something that is not " + t.script + ": ' + $c.OwningProcess) }",
        '}',
        'for ($i = 0; $i -lt ' + TASK_WAIT_TRIES + " -and (Get-ScheduledTask -TaskName '" + t.task + "').State -eq 'Running'; $i++) { Start-Sleep -Milliseconds 250 }",
        "Start-ScheduledTask -TaskName '" + t.task + "'",
        "Write-Output ('killed=' + $killed + ' task=" + t.task + "')",
    ].join('\n');
}
function windowsRestart(t) {
    const ps = restartScript(t);
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    return { done: out.trim().slice(0, 200) };
}
export function isBrainHost(brain = BRAIN) {
    try {
        const r = JSON.parse(readFileSync(join(brain, 'vault-recipients.json'), 'utf8'));
        return String(r.host || '').toUpperCase() === (process.env.HAVOK_MACHINE_NAME || hostname()).trim().toUpperCase();
    }
    catch {
        return false;
    }
}
export function reportFailure(what, why, brain = BRAIN) {
    try {
        if (!TARGETS[what] || !isBrainHost(brain))
            return false;
        const child = spawn(process.execPath, [join(brain, 'tools', 'brain-recover.mjs'), '--what', what, '--why', String(why).slice(0, 200)], { detached: true, stdio: 'ignore', cwd: brain, windowsHide: true });
        child.unref();
        return true;
    }
    catch {
        return false;
    }
}
export function writeAlert(file, id, text, nowIso) {
    let doc = { generated: nowIso, alerts: {} };
    try {
        doc = JSON.parse(readFileSync(file, 'utf8'));
        doc.alerts = doc.alerts || {};
    }
    catch { }
    doc.alerts[id] = { text, firstSeen: (doc.alerts[id] && doc.alerts[id].firstSeen) || nowIso, lastSeen: nowIso };
    writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}
async function main() {
    const argv = process.argv.slice(2);
    const opt = (n) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : ''; };
    const what = opt('what');
    const t = TARGETS[what];
    if (!t) {
        process.stderr.write('usage: node tools/brain-recover.mjs --what brain|embed --why "<what failed>"\n');
        process.exit(2);
    }
    if (!isBrainHost())
        process.exit(0);
    const LOCK = join(BRAIN, '.brain-recover.lock');
    try {
        if (Date.now() - statSync(LOCK).mtimeMs > LOCK_STALE_MS)
            unlinkSync(LOCK);
    }
    catch { }
    let fd;
    try {
        fd = openSync(LOCK, 'wx');
    }
    catch {
        process.exit(0);
    }
    try {
        const STATE = join(BRAIN, '.brain-recover.json');
        let state = { restarts: {} };
        try {
            state = JSON.parse(readFileSync(STATE, 'utf8'));
            state.restarts = state.restarts || {};
        }
        catch { }
        let enabled = false;
        try {
            enabled = JSON.parse(readFileSync(join(CONFIG_DIR, 'havok-recover.json'), 'utf8')).enabled === true;
        }
        catch { }
        let ca = null;
        try {
            ca = readFileSync(join(BRAIN, 'server-cert.pem'));
        }
        catch { }
        const result = await recover({
            what, why: opt('why') || 'unspecified', enabled, refuse: certRefusal(what, ca),
            now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            probe: () => probeHealth(t.url, { ca }),
            restart: () => windowsRestart(t),
            state,
            log: (row) => appendFileSync(join(BRAIN, '.brain-recover.log'), JSON.stringify(row) + '\n', 'utf8'),
            alert: (id, text) => writeAlert(join(BRAIN, '.brain-alerts.json'), id, text, new Date().toISOString()),
        });
        writeFileSync(STATE, JSON.stringify(state) + '\n', 'utf8');
        process.stdout.write(what + ': ' + result + '\n');
    }
    finally {
        closeSync(fd);
        try {
            unlinkSync(LOCK);
        }
        catch { }
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await main();
