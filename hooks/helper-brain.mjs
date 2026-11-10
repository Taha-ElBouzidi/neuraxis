import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { withHelperBlock, recallQuery, withRecall } from './helper-rules.mjs';
let data = {};
try {
    data = JSON.parse(readFileSync(0, 'utf8') || '{}');
}
catch {
    process.exit(0);
}
const input = data.tool_input || {};
const tool = String(data.tool_name || '');
const root = process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');
const client = join(root, 'tools', 'brain-client.mjs').replace(/\\/g, '/');
const allow = (updated) => {
    if (!updated)
        process.exit(0);
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: updated },
    }));
    process.exit(0);
};
if (tool === 'SendMessage') {
    const q = recallQuery(input);
    if (!q)
        process.exit(0);
    let recall = '';
    try {
        recall = execFileSync('node', [client, 'search', q], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    }
    catch {
        process.exit(0);
    }
    allow(withRecall(input, recall, client));
}
allow(withHelperBlock(input, client));
