import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { freshState, onPrompt, onTool, onStop } from './recall-rules.mjs';
const HOME = join(homedir(), '.claude');
const BRAIN = process.env.HAVOK_BRAIN_DIR || join(dirname(fileURLToPath(import.meta.url)), '..');
let on = false;
try {
    on = !!JSON.parse(readFileSync(join(BRAIN, 'hooks', 'agent-search.json'), 'utf8')).on;
}
catch { }
if (!on)
    process.exit(0);
if (process.env.HAVOK_RELAY === '1')
    process.exit(0);
const raw = (() => { try {
    return readFileSync(0, 'utf8');
}
catch {
    return '';
} })();
let data = {};
try {
    data = JSON.parse(raw || '{}');
}
catch {
    process.exit(0);
}
const mode = process.argv[2];
const sid = String(data.session_id || 'none').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'none';
const DIR = process.env.HAVOK_RECALL_GATE_DIR || join(HOME, 'havok-recall-gate');
try {
    mkdirSync(DIR, { recursive: true });
}
catch { }
const file = join(DIR, sid + '.json');
const get = () => { try {
    return JSON.parse(readFileSync(file, 'utf8'));
}
catch {
    return freshState();
} };
const put = (s) => { try {
    writeFileSync(file, JSON.stringify(s));
}
catch { } };
const log = (o) => { if (!o)
    return; try {
    appendFileSync(join(DIR, 'gate-log.jsonl'), JSON.stringify({ at: new Date().toISOString(), sid, ...o }) + '\n');
}
catch { } };
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const brainDown = () => { try {
    return !!JSON.parse(readFileSync(join(HOME, 'havok-brain-gate.json'), 'utf8')).down;
}
catch {
    return false;
} };
const cli = join(BRAIN, 'tools', 'brain-client.mjs').replace(/\\/g, '/');
const settle = (s, r, refuse) => { if (r.state !== s)
    put(r.state); log(r.log); if (r.deny || r.block)
    out(refuse(r)); process.exit(0); };
if (mode === 'prompt') {
    const r = onPrompt(data.prompt, Date.now());
    put(r.state);
    log(r.log);
    process.exit(0);
}
const s = get();
if (brainDown())
    process.exit(0);
if (mode === 'tool') {
    settle(s, onTool(s, String(data.tool_name || ''), data.tool_input || {}, cli, BRAIN), (r) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: r.deny } }));
}
if (mode === 'stop') {
    settle(s, onStop(s, cli), (r) => ({ decision: 'block', reason: r.block }));
}
process.exit(0);
