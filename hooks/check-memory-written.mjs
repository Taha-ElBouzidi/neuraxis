import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { snapshotOf, afterStop } from './memory-rules.mjs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
const readStdin = () => { try {
    return readFileSync(0, 'utf8');
}
catch {
    return '';
} };
let data = {};
try {
    data = JSON.parse(readStdin() || '{}');
}
catch {
    process.exit(0);
}
if (data.stop_hook_active === true)
    process.exit(0);
const sid = String(data.session_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
if (!sid)
    process.exit(0);
const NOTES = join(homedir(), '.claude', 'havok-style-notes');
const note = (kind, text) => {
    try {
        mkdirSync(NOTES, { recursive: true });
        writeFileSync(join(NOTES, sid + '.' + kind + '.json'), JSON.stringify({ at: new Date().toISOString(), text }));
    }
    catch { }
};
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let marked = '';
try {
    marked = readFileSync(join(homedir(), '.claude', 'havok-brain-path'), 'utf8').split(String.fromCharCode(10))[0].trim();
}
catch { }
const MEM = [marked && join(marked, 'memory'), join(PLUGIN, 'memory')].find((d) => d && existsSync(d));
if (!MEM)
    process.exit(0);
const STATE_DIR = join(homedir(), '.claude', 'havok-sessions');
const STATE = join(STATE_DIR, sid + '.json');
let state = null;
try {
    state = JSON.parse(readFileSync(STATE, 'utf8'));
}
catch { }
let now;
try {
    now = snapshotOf(readdirSync(MEM, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => { let m = 0; try {
        m = statSync(join(MEM, e.name)).mtimeMs;
    }
    catch { } return { name: e.name, mtimeMs: m }; }));
}
catch {
    process.exit(0);
}
const r = afterStop(state, now, MEM);
try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE, JSON.stringify(r.state), 'utf8');
}
catch { }
if (r.note)
    note('work', r.note);
process.exit(0);
