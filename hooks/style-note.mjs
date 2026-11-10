import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { slipNote } from './content-rules.mjs';
let data = {};
try {
    data = JSON.parse(readFileSync(0, 'utf8') || '{}');
}
catch {
    process.exit(0);
}
const sid = String(data.session_id || 'none').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'none';
const dir = join(homedir(), '.claude', 'havok-style-notes');
const take = (name) => {
    const file = join(dir, name);
    if (!existsSync(file))
        return null;
    let note = null;
    try {
        note = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch { }
    try {
        unlinkSync(file);
    }
    catch { }
    return note;
};
const out = [];
const slip = take(sid + '.json');
if (slip && Array.isArray(slip.reasons) && slip.reasons.length)
    out.push(slipNote(slip.reasons));
for (const kind of ['learn', 'work']) {
    const n = take(sid + '.' + kind + '.json');
    if (n && n.text)
        out.push(n.text);
}
if (!out.length)
    process.exit(0);
process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out.join('\n\n') },
}));
process.exit(0);
