import { readFileSync, appendFileSync, mkdirSync, statSync, renameSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ALIVE_DIR, FRESH_MS, handled, safeSession } from './alive-rules.mjs';
const SHELL = /^(Bash|PowerShell)$/;
const COMMIT = (cmd) => /git\s+commit/.test(cmd) || /\bgit\b[^|;&]*\bcommit\b/.test(cmd);
export const JOBS = {
    SessionStart: [{ file: 'check-session-start.mjs', ms: 30000 }],
    UserPromptSubmit: [
        { file: 'check-limit.mjs', ms: 5000, safety: 'the limit reserve check' },
        { file: 'check-keep-warm.mjs', ms: 15000 },
        { file: 'brain-gate.mjs', args: ['prompt'], ms: 30000 },
        { file: 'recall-gate.mjs', args: ['prompt'], ms: 5000 },
        { file: 'style-note.mjs', ms: 5000 },
        { file: 'pre-turn.mjs', args: ['--from-plugin'], ms: 10000 },
    ],
    PreToolUse: [
        { file: 'check-limit.mjs', ms: 5000, safety: 'the limit reserve check' },
        { file: 'brain-gate.mjs', args: ['tool'], ms: 10000, safety: 'the brain outage check' },
        { file: 'recall-gate.mjs', args: ['tool'], ms: 5000 },
        { file: 'check-content.mjs', ms: 10000, tools: /^(Write|Edit|NotebookEdit|Bash|PowerShell)$|^mcp__/, safety: 'the writing rules check' },
        { file: 'check-secrets.mjs', ms: 15000, tools: SHELL, commit: true, safety: 'the secret scan of the staged diff' },
        { file: 'check-brain-commit.mjs', ms: 130000, tools: SHELL, commit: true, safety: 'the brain verification' },
        { file: 'check-commit-message.mjs', ms: 10000, tools: SHELL, safety: 'the commit message check' },
        { file: 'check-windows.mjs', ms: 5000, tools: SHELL, safety: 'the visible window and watcher check' },
        { file: 'helper-brain.mjs', ms: 5000, tools: /^(Agent|Task|SendMessage)$/ },
    ],
    Stop: [
        { file: 'check-stop.mjs', ms: 10000 },
        { file: 'check-memory-written.mjs', ms: 10000 },
        { file: 'brain-gate.mjs', args: ['stop'], ms: 10000 },
        { file: 'recall-gate.mjs', args: ['stop'], ms: 5000 },
    ],
};
const LOG_MAX_BYTES = 5 * 1024 * 1024;
export function whyNotHandled(marker, event, now) {
    if (!marker || typeof marker !== 'object')
        return { cause: 'no-marker', why: 'no mod marker for this session (the mod did not load, is not installed here, or never handled an event)' };
    const at = Number(marker.at) || 0;
    const v = marker.v ? ' (mod ' + marker.v + ')' : '';
    if (!at || now - at > FRESH_MS)
        return { cause: 'stale-marker', why: 'the mod last handled an event ' + (at ? Math.round((now - at) / 1000) + ' s' : 'an unknown time') + ' ago' + v + ', so it stopped running in this session' };
    if (marker.ev && Array.isArray(marker.ev[event]) && marker.ev[event].length)
        return { cause: 'missed-event', why: 'the mod handled other ' + event + ' events but not this one (it threw, ran out of time or skipped it)' + v };
    return { cause: 'event-not-handled', why: 'the mod is running in this session but handled no ' + event + v };
}
export function jobsFor(event, data) {
    const tool = String(data.tool_name || '');
    const cmd = String((data.tool_input || {}).command || '');
    return (JOBS[event] || []).filter((j) => (!j.tools || j.tools.test(tool)) && (!j.commit || COMMIT(cmd)));
}
function runJob(dir, job, raw, ms) {
    return import('node:child_process').then(({ spawn }) => new Promise((done) => {
        let out = '', err = '', over = false;
        const child = spawn(process.execPath, [join(dir, job.file), ...(job.args || [])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env });
        const timer = setTimeout(() => { over = true; try {
            child.kill();
        }
        catch { } }, ms);
        child.stdout.on('data', (b) => { out += b; });
        child.stderr.on('data', (b) => { err += b; });
        child.on('error', () => { clearTimeout(timer); done({ job, out: '', err: '', code: 0, over: false }); });
        child.on('close', (code) => { clearTimeout(timer); done({ job, out, err, code, over }); });
        child.stdin.on('error', () => { });
        child.stdin.end(raw);
    }));
}
const parse = (s) => { try {
    return JSON.parse(s);
}
catch {
    return null;
} };
export function merge(event, results) {
    const secs = (r) => Math.round(r.ms / 1000);
    const late = results.find((r) => r.over && r.job.safety);
    if (event === 'PreToolUse') {
        if (late)
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Blocked: ' + late.job.safety + ' did not finish within ' + secs(late) + ' s, so this call was not checked and did not run. Run it again; if it keeps happening, tell the user the hook backup is slow on this machine.' } };
        let rewrite = null;
        for (const r of results) {
            if (r.over)
                continue;
            if (r.code === 2)
                return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.err.trim() || r.job.file } };
            const o = parse(r.out.trim());
            const h = o && o.hookSpecificOutput;
            if (h && h.permissionDecision === 'deny')
                return o;
            if (o && o.decision === 'block')
                return o;
            if (!rewrite && h && h.updatedInput)
                rewrite = o;
        }
        return rewrite;
    }
    if (event === 'UserPromptSubmit' || event === 'Stop') {
        if (late && event === 'UserPromptSubmit')
            return { decision: 'block', reason: late.job.safety + ' did not finish within ' + secs(late) + ' s, so this message was held back. Send it again; if it keeps happening, tell the user the hook backup is slow on this machine.' };
        const context = [];
        for (const r of results) {
            if (r.over)
                continue;
            if (r.code === 2)
                return { decision: 'block', reason: r.err.trim() || r.job.file };
            const text = r.out.trim();
            if (!text)
                continue;
            const o = parse(text);
            if (o && o.decision === 'block')
                return o;
            if (o && o.hookSpecificOutput && o.hookSpecificOutput.additionalContext)
                context.push(o.hookSpecificOutput.additionalContext);
            else if (!o && event === 'UserPromptSubmit')
                context.push(text);
        }
        return context.length ? { hookSpecificOutput: { hookEventName: event, additionalContext: context.join('\n\n') } } : null;
    }
    const r = results[0];
    return r && !r.over && r.out.trim() ? r.out : null;
}
export const BACKUP_NOTE_DIR = 'backup';
export const START_WAIT_MS = Number(process.env.HAVOK_DISPATCH_START_WAIT_MS) >= 0 && process.env.HAVOK_DISPATCH_START_WAIT_MS !== undefined ? Number(process.env.HAVOK_DISPATCH_START_WAIT_MS) : 10000;
function noteBackup(home, sid, note) {
    try {
        const dir = join(home, '.claude', 'havok-mod', BACKUP_NOTE_DIR);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, sid + '.json'), JSON.stringify(note));
    }
    catch { }
}
function logBackup(home, line) {
    try {
        const dir = join(home, '.claude', 'havok-mod');
        mkdirSync(dir, { recursive: true });
        const f = join(dir, 'backup.log');
        try {
            if (statSync(f).size > LOG_MAX_BYTES)
                renameSync(f, f + '.1');
        }
        catch { }
        appendFileSync(f, line + '\n');
    }
    catch { }
}
async function main() {
    const event = process.argv[2];
    let raw = '';
    try {
        raw = readFileSync(0, 'utf8');
    }
    catch { }
    const data = parse(raw || '{}') || {};
    const home = homedir();
    const sid = safeSession(data.session_id);
    let marker = null;
    if (sid)
        marker = parse((() => { try {
            return readFileSync(join(home, ...ALIVE_DIR.split('/'), sid + '.json'), 'utf8');
        }
        catch {
            return '';
        } })());
    let now = Date.now();
    if (handled(marker, event, data, now))
        process.exit(0);
    if (event === 'SessionStart' && sid && existsSync(join(home, '.claude', 'havok-mod'))) {
        const until = Date.now() + START_WAIT_MS;
        while (Date.now() < until) {
            await new Promise((r) => setTimeout(r, 250));
            marker = parse((() => { try {
                return readFileSync(join(home, ...ALIVE_DIR.split('/'), sid + '.json'), 'utf8');
            }
            catch {
                return '';
            } })());
            if (handled(marker, event, data, Date.now()))
                process.exit(0);
        }
        now = Date.now();
    }
    if (existsSync(join(home, '.claude', 'havok-mod'))) {
        if (event === 'SessionStart' && sid) {
            try {
                const { report } = await import('./mod-failure.mjs');
                const { cause, why } = whyNotHandled(marker, event, now);
                report(home, { session: sid, source: 'sessionstart', cause, why: 'The mod did not handle the session start (' + String(data.source || '') + '): ' + why + '.', agent: process.env.HAVOK_MOD_AGENT || '', mod: (marker && marker.v) || '' });
            }
            catch { }
        }
        try {
            const { disarmAll, recompute } = await import('../tools/backup-arm.mjs');
            disarmAll(home);
            recompute(home, fileURLToPath(import.meta.url));
        }
        catch { }
        process.exit(0);
    }
    if (event === 'SessionStart') {
        try {
            const { arm, recompute, PERMANENT } = await import('../tools/backup-arm.mjs');
            const self = fileURLToPath(import.meta.url);
            arm(home, PERMANENT, 'no mod on this machine');
            recompute(home, self);
        }
        catch { }
    }
    const dir = process.env.HAVOK_DISPATCH_HOOKS || dirname(fileURLToPath(import.meta.url));
    const jobs = jobsFor(event, data);
    const forced = Number(process.env.HAVOK_DISPATCH_JOB_MS) || 0;
    const { cause, why } = whyNotHandled(marker, event, now);
    const results = await Promise.all(jobs.map((j) => runJob(dir, j, raw, forced || j.ms).then((r) => ({ ...r, ms: forced || j.ms }))));
    const answer = merge(event, results);
    const late = results.filter((r) => r.over).map((r) => r.job.file);
    const ran = jobs.map((j) => j.file + (j.args ? ':' + j.args.join(',') : '')).join(' ');
    const at = new Date(now).toISOString();
    const modHere = existsSync(join(home, '.claude', 'havok-mod'));
    if (modHere)
        logBackup(home, at + ' ' + event + ' session=' + (sid || 'none') + ' why="' + why + '" ran=' + ran
            + (late.length ? ' late=' + late.join(',') : '') + (marker && marker.v ? ' mod=' + marker.v : ''));
    if (modHere && sid)
        noteBackup(home, sid, { at, event, cause, why });
    if (answer)
        process.stdout.write(typeof answer === 'string' ? answer : JSON.stringify(answer));
    process.exit(0);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main();
