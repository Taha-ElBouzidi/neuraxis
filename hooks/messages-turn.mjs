#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { turnBlock } from './messages-client.mjs';
const kind = String(process.argv[2] || 'codex');
let input = {};
try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
}
catch { }
let ctx = '';
try {
    ctx = await turnBlock({ kind, session: input.session_id || '', cwd: input.cwd || process.cwd() });
}
catch {
    ctx = '';
}
process.stdout.write(JSON.stringify(ctx ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } } : {}));
process.exit(0);
