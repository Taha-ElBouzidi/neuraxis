import { readFileSync } from 'node:fs';
import { isPingText, fromTimer, pingContext } from './keepwarm-rules.mjs';
let data = {};
try {
    data = JSON.parse(readFileSync(0, 'utf8') || '{}');
}
catch {
    process.exit(0);
}
if (!isPingText(data.prompt))
    process.exit(0);
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: pingContext(!fromTimer(data)) } }));
process.exit(0);
