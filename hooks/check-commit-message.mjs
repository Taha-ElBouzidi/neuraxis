import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { commandProblems, HOW_TO_WRITE } from './commit-message-rules.mjs';
let data = {};
try {
    data = JSON.parse(readFileSync(0, 'utf8') || '{}');
}
catch {
    process.exit(0);
}
const problems = commandProblems(String((data.tool_input || {}).command || ''), {
    readFile: (f) => readFileSync(isAbsolute(f) ? f : resolve(data.cwd || process.cwd(), f), 'utf8'),
});
if (problems.length) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Commit blocked: ' + problems.join(', ') + '. ' + HOW_TO_WRITE,
        },
    }));
}
process.exit(0);
