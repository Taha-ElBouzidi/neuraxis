import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { COMMIT_CMD, VERIFY_MS, needsVerify, failedReason, HUNG_REASON } from './commitgate-rules.mjs';
import { commitDir } from './secret-rules.mjs';
const SELF_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function allow() { process.exit(0); }
let input = '';
try {
    input = readFileSync(0, 'utf8');
}
catch {
    allow();
}
let cmd = '';
let payloadCwd = '';
try {
    const payload = JSON.parse(input || '{}');
    cmd = payload?.tool_input?.command || '';
    payloadCwd = payload?.cwd ? commitDir(cmd, payload.cwd) : '';
}
catch {
    allow();
}
let BRAIN = SELF_DIR;
try {
    if (payloadCwd) {
        BRAIN = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd: payloadCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        }).trim() || SELF_DIR;
    }
}
catch {
    BRAIN = SELF_DIR;
}
if (!existsSync(join(BRAIN, 'REFLEX.md')) || !existsSync(join(BRAIN, 'memory')))
    allow();
if (!readdirSync(join(BRAIN, 'memory')).some((f) => f.endsWith('.md') && f !== 'MEMORY.md'))
    allow();
if (!COMMIT_CMD.test(cmd))
    allow();
let staged = '';
try {
    staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: BRAIN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
}
catch {
    allow();
}
const { risky, verify } = needsVerify(staged);
if (!verify)
    allow();
const staged_ = join(BRAIN, 'tools', 'verify-staged.mjs');
const verifier = existsSync(staged_) ? staged_ : join(BRAIN, 'tools', 'verify.mjs');
if (!existsSync(verifier))
    allow();
const deny = (reason) => {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    process.exit(0);
};
try {
    execFileSync(process.execPath, [verifier, '--quiet'], {
        cwd: BRAIN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: VERIFY_MS, windowsHide: true,
    });
    allow();
}
catch (e) {
    if (e.code === 'ETIMEDOUT' || e.signal)
        deny(HUNG_REASON);
    deny(failedReason(risky.length, String((e.stdout || '') + (e.stderr || '')).trim()));
}
