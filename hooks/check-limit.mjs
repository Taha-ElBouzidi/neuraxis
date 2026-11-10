import { readFileSync, writeFileSync, mkdirSync, appendFileSync, openSync, readSync, fstatSync, closeSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { BYPASS_MS, reserveOf, accountOf, agentExempt, claudeFiles, hitsOf, typedUrgent, relayedUrgent, isPing, typedRow, urgentStillOpen, blockMessage, TOOL_STOP, PING_BLOCKED, blockKind, blockRow, bypassName, BYPASS_OUTBOX, BYPASS_REASON, bypassUseRow, BYPASS_MARKER, bypassMarkerAfter } from './limit-rules.mjs';
const HOME = join(homedir(), '.claude');
const BYPASS_DIR = join(HOME, 'havok-limit-bypass');
let data = {};
try {
    data = JSON.parse(readFileSync(0, 'utf8') || '{}');
}
catch {
    process.exit(0);
}
const session = String(data.session_id || '');
const parse = (s) => { try {
    return JSON.parse(s);
}
catch {
    return null;
} };
const read = (f) => { try {
    return readFileSync(f, 'utf8').trim();
}
catch {
    return '';
} };
const files = claudeFiles(homedir(), process.env.CLAUDE_CONFIG_DIR);
const reserve = reserveOf(parse(read(join(dirname(dirname(fileURLToPath(import.meta.url))), 'brain.json'))), accountOf(parse(read(files.claudeJson))));
if (!reserve.enabled)
    process.exit(0);
const { five, week, hits } = hitsOf(parse(read(files.limits)), Date.now());
const typed = typedUrgent(data) || relayedUrgent(data, reserve.mainAgent, reserve.relays);
const bypassFile = join(BYPASS_DIR, bypassName(session));
const openBypass = (until) => { try {
    mkdirSync(BYPASS_DIR, { recursive: true });
    writeFileSync(bypassFile, String(until));
}
catch { } };
if (typed)
    openBypass(Date.now() + BYPASS_MS);
if (!hits.length)
    process.exit(0);
const logBlock = (kind) => { try {
    appendFileSync(join(HOME, 'havok-limit-blocks.jsonl'), blockRow(Date.now(), session, kind, data.hook_event_name, five, week) + String.fromCharCode(10));
}
catch { } };
if (isPing(data)) {
    logBlock('keep-warm');
    process.stdout.write(JSON.stringify({ decision: 'block', reason: PING_BLOCKED }));
    process.exit(0);
}
const through = (file, reason) => {
    try {
    }
    catch { }
    process.exit(0);
};
const bypassFileName = 'havok-limit-bypass/' + bypassName(session);
if (session && read(join(HOME, 'havok-main-session.txt')) === session)
    through('havok-main-session.txt', BYPASS_REASON.main);
if (agentExempt(process.env, reserve))
    process.exit(0);
if (typed)
    through(bypassFileName, BYPASS_REASON.urgent);
if (Number(read(bypassFile)) > Date.now())
    through(bypassFileName, BYPASS_REASON.urgent);
function lastTypedPrompt(path) {
    let fd;
    try {
        fd = openSync(path, 'r');
        const size = fstatSync(fd).size;
        for (const span of [1 << 20, 8 << 20, 64 << 20]) {
            const len = Math.min(size, span);
            const buf = Buffer.alloc(len);
            readSync(fd, buf, 0, len, size - len);
            const lines = buf.toString('utf8').split(String.fromCharCode(10));
            for (let i = lines.length - 1; i >= (len < size ? 1 : 0); i--) {
                const row = typedRow(parse(lines[i]), Date.now());
                if (row)
                    return row;
            }
            if (len === size)
                break;
        }
    }
    catch { }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch { }
        }
    }
    return { text: '', at: 0 };
}
if (data.hook_event_name === 'PreToolUse' && data.transcript_path) {
    const last = lastTypedPrompt(data.transcript_path);
    if (urgentStillOpen(last, Date.now())) {
        openBypass(last.at + BYPASS_MS);
        through(bypassFileName, BYPASS_REASON.urgent);
    }
}
const msg = blockMessage(hits, reserve.mainName || reserve.mainAgent);
logBlock(blockKind(data.hook_event_name, data.tool_name));
if (data.hook_event_name === 'UserPromptSubmit') {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: msg }));
}
else {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg + TOOL_STOP } }));
}
process.exit(0);
