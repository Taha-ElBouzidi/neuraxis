import { readFileSync } from 'node:fs';
import { contentProblems, contentDenyReason, writingRulesOn, brainConfigNear } from './content-rules.mjs';
import { dirname, join as joinPath } from 'node:path';
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
let cfg = null;
cfg = brainConfigNear(fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, ''), readFileSync, process.env.USERPROFILE || process.env.HOME || '');
if (!writingRulesOn(cfg))
    process.exit(0);
const p = contentProblems(String(data.tool_name || ''), data.tool_input || {});
if (p) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: contentDenyReason(p) },
    }));
}
process.exit(0);
