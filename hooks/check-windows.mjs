import { readFileSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { windowProblems, windowDenyReason, askedForWindow } from './window-rules.mjs';
const TAIL = 512 * 1024;
export function lastPersonText(transcriptPath) {
    let text = '';
    try {
        const fd = openSync(transcriptPath, 'r');
        try {
            const size = fstatSync(fd).size;
            const len = Math.min(size, TAIL);
            const buf = Buffer.alloc(len);
            readSync(fd, buf, 0, len, size - len);
            text = buf.toString('utf8');
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return '';
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        let o;
        try {
            o = JSON.parse(lines[i]);
        }
        catch {
            continue;
        }
        if (!o || o.type !== 'user' || !o.message)
            continue;
        const c = o.message.content;
        const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text).join('\n') : '';
        if (!t.trim())
            continue;
        if (/^AGENT MESSAGE:/m.test(t) || /keep-warm ping/i.test(t))
            return '';
        return t;
    }
    return '';
}
let data = {};
try {
    data = JSON.parse(readFileSync(0, 'utf8') || '{}');
}
catch {
    process.exit(0);
}
let problems = [];
try {
    const asked = data.transcript_path ? askedForWindow(lastPersonText(String(data.transcript_path))) : false;
    problems = windowProblems(data.tool_name, data.tool_input || {}, { asked });
}
catch {
    process.exit(0);
}
if (!problems.length)
    process.exit(0);
process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: windowDenyReason(problems) },
}));
process.exit(0);
