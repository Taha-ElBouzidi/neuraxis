import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { styleProblems, writingRulesOn, brainConfigNear } from './content-rules.mjs';
import { fileURLToPath } from 'node:url';
function readStdin() {
    try {
        return readFileSync(0, 'utf8');
    }
    catch {
        return '';
    }
}
let data = {};
try {
    data = JSON.parse(readStdin() || '{}');
}
catch {
    process.exit(0);
}
if (data.stop_hook_active === true)
    process.exit(0);
let text = typeof data.last_assistant_message === 'string' ? data.last_assistant_message : '';
if (!text && typeof data.last_assistant_message !== 'string') {
    const tp = data.transcript_path;
    if (!tp)
        process.exit(0);
    try {
        const lines = readFileSync(tp, 'utf8').trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            let obj;
            try {
                obj = JSON.parse(lines[i]);
            }
            catch {
                continue;
            }
            const content = obj && obj.message && obj.message.content;
            if (obj && obj.type === 'assistant' && Array.isArray(content)) {
                const t = content
                    .filter(c => c && c.type === 'text' && typeof c.text === 'string')
                    .map(c => c.text)
                    .join('\n');
                if (t) {
                    text = t;
                    break;
                }
            }
        }
    }
    catch {
        process.exit(0);
    }
}
if (!text)
    process.exit(0);
let cfg = null;
cfg = brainConfigNear(fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, ''), readFileSync, process.env.USERPROFILE || process.env.HOME || '');
if (!writingRulesOn(cfg))
    process.exit(0);
const reasons = styleProblems(text);
if (reasons.length) {
    try {
        const dir = join(homedir(), '.claude', 'havok-style-notes');
        mkdirSync(dir, { recursive: true });
        const sid = String(data.session_id || 'none').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'none';
        writeFileSync(join(dir, sid + '.json'), JSON.stringify({ at: new Date().toISOString(), reasons }));
    }
    catch { }
}
process.exit(0);
