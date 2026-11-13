import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { marked, markerKey, ALIVE_DIR } from '../hooks/alive-rules.mjs';
import { JOBS } from '../hooks/dispatch.mjs';
const HOOKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const DISPATCH = join(HOOKS, 'dispatch.mjs');
const EM = String.fromCharCode(0x2014);
function home({ mod = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-'));
    mkdirSync(join(root, '.claude'));
    if (mod)
        mkdirSync(join(root, '.claude', 'havok-mod'));
    return root;
}
function run(root, event, input, env = {}) {
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [DISPATCH, event], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, USERPROFILE: root, HOME: root, CLAUDE_PLUGIN_ROOT: '', ...env } });
    return { out: r.stdout.trim() ? JSON.parse(r.stdout) : null, ms: Date.now() - t0, status: r.status, err: r.stderr };
}
function mark(root, sid, event, input, at = Date.now()) {
    const dir = join(root, ...ALIVE_DIR.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, sid + '.json'), JSON.stringify(marked(null, '0.1.7', event, markerKey(event, input), at)));
}
const backupLog = (root) => { const f = join(root, '.claude', 'havok-mod', 'backup.log'); return existsSync(f) ? readFileSync(f, 'utf8') : ''; };
const bashEm = { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_input: { command: 'echo a ' + EM + ' b' }, cwd: tmpdir() };
function fakeHooks(behaviour) {
    const dir = mkdtempSync(join(tmpdir(), 'fakehooks-'));
    const ran = join(dir, 'ran');
    mkdirSync(ran);
    const files = new Set(Object.values(JOBS).flat().map((j) => j.file));
    for (const f of files) {
        const b = behaviour[f] || {};
        writeFileSync(join(dir, f), [
            "import { writeFileSync, readFileSync } from 'node:fs';",
            'readFileSync(0);',
            `writeFileSync(${JSON.stringify(join(ran, f + '.' + Math.random().toString(16).slice(2)))}, process.argv.slice(2).join(' '));`,
            b.hang ? 'setInterval(() => {}, 1000);' : '',
            b.print ? `process.stdout.write(${JSON.stringify(JSON.stringify(b.print))});` : '',
        ].join('\n'));
    }
    return { dir, ran: () => readdirSync(ran).map((n) => n.replace(/\.[0-9a-f]+$/, '')) };
}
test('with no mod installed, the dispatcher runs the hooks but writes no mod files and starts no sender', () => {
    const root = home({ mod: false });
    try {
        const r = run(root, 'PreToolUse', bashEm);
        assert.equal(r.out.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(r.out));
        assert.ok(!existsSync(join(root, '.claude', 'havok-mod')), 'a mod folder was written in a home with no mod');
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('every job the dispatcher names exists in hooks/, so the backup can run them', () => {
    for (const jobs of Object.values(JOBS))
        for (const j of jobs)
            assert.ok(existsSync(join(HOOKS, j.file)), j.file);
});
test('the mod handled this very tool call: the dispatcher runs nothing and says nothing', () => {
    const root = home();
    const fake = fakeHooks({});
    try {
        mark(root, 's1', 'PreToolUse', bashEm);
        const r = run(root, 'PreToolUse', bashEm, { HAVOK_DISPATCH_HOOKS: fake.dir });
        assert.equal(r.out, null);
        assert.deepEqual(fake.ran(), []);
        assert.equal(backupLog(root), '');
    }
    finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(fake.dir, { recursive: true, force: true });
    }
});
test('no marker at all (mod missing, crashed or skipped): the old hooks run', () => {
    const root = home();
    try {
        const r = run(root, 'PreToolUse', bashEm);
        assert.equal(r.out?.hookSpecificOutput?.permissionDecision, 'deny');
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('the backup runs only the hooks of this event whose matcher fits the tool, as hooks.json did', () => {
    const root = home();
    const fake = fakeHooks({});
    try {
        run(root, 'PreToolUse', { ...bashEm, tool_name: 'Read', tool_input: { file_path: 'x' } }, { HAVOK_DISPATCH_HOOKS: fake.dir });
        assert.deepEqual(fake.ran().sort(), ['brain-gate.mjs', 'check-limit.mjs', 'recall-gate.mjs']);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(fake.dir, { recursive: true, force: true });
    }
});
test('a safety hook that does not finish refuses the call instead of letting it through', () => {
    const root = home();
    const fake = fakeHooks({ 'check-secrets.mjs': { hang: true } });
    try {
        const commit = { ...bashEm, tool_input: { command: 'git commit -m "x"' } };
        const r = run(root, 'PreToolUse', commit, { HAVOK_DISPATCH_HOOKS: fake.dir, HAVOK_DISPATCH_JOB_MS: '1500' });
        assert.equal(r.out?.hookSpecificOutput?.permissionDecision, 'deny');
        assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /secret scan .*did not finish/i);
        assert.ok(r.ms < 15000, 'took ' + r.ms);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(fake.dir, { recursive: true, force: true });
    }
});
test('a hook that is not a safety check and does not finish is dropped, as Claude Code drops a timed-out hook', () => {
    const root = home();
    const fake = fakeHooks({ 'helper-brain.mjs': { hang: true } });
    try {
        const r = run(root, 'PreToolUse', { ...bashEm, tool_name: 'Agent', tool_input: { prompt: 'p' } }, { HAVOK_DISPATCH_HOOKS: fake.dir, HAVOK_DISPATCH_JOB_MS: '1500' });
        assert.equal(r.out, null);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(fake.dir, { recursive: true, force: true });
    }
});
test('a refusal wins over an input rewrite; with no refusal the rewrite goes through', () => {
    const root = home();
    const rewrite = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { prompt: 'p2' } } };
    const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'limit' } };
    const a = fakeHooks({ 'helper-brain.mjs': { print: rewrite } });
    const b = fakeHooks({ 'helper-brain.mjs': { print: rewrite }, 'check-limit.mjs': { print: deny } });
    try {
        const agent = { ...bashEm, tool_name: 'Agent', tool_input: { prompt: 'p' } };
        assert.deepEqual(run(root, 'PreToolUse', agent, { HAVOK_DISPATCH_HOOKS: a.dir }).out, rewrite);
        assert.equal(run(root, 'PreToolUse', agent, { HAVOK_DISPATCH_HOOKS: b.dir }).out.hookSpecificOutput.permissionDecisionReason, 'limit');
    }
    finally {
        for (const d of [root, a.dir, b.dir])
            rmSync(d, { recursive: true, force: true });
    }
});
test('a prompt: a block wins, otherwise every hook\'s context is handed on together', () => {
    const root = home();
    const ctx = (t) => ({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: t } });
    const a = fakeHooks({ 'style-note.mjs': { print: ctx('slip') }, 'brain-gate.mjs': { print: ctx('down') } });
    const b = fakeHooks({ 'style-note.mjs': { print: ctx('slip') }, 'check-limit.mjs': { print: { decision: 'block', reason: 'reserve' } } });
    try {
        const p = { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi', prompt_id: 'p1' };
        const ra = run(root, 'UserPromptSubmit', p, { HAVOK_DISPATCH_HOOKS: a.dir }).out;
        assert.match(ra.hookSpecificOutput.additionalContext, /down/);
        assert.match(ra.hookSpecificOutput.additionalContext, /slip/);
        assert.deepEqual(run(root, 'UserPromptSubmit', p, { HAVOK_DISPATCH_HOOKS: b.dir }).out, { decision: 'block', reason: 'reserve' });
    }
    finally {
        for (const d of [root, a.dir, b.dir])
            rmSync(d, { recursive: true, force: true });
    }
});
test('the limit check that does not finish blocks the prompt (it is a safety check)', () => {
    const root = home();
    const fake = fakeHooks({ 'check-limit.mjs': { hang: true } });
    try {
        const r = run(root, 'UserPromptSubmit', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'hi' }, { HAVOK_DISPATCH_HOOKS: fake.dir, HAVOK_DISPATCH_JOB_MS: '1500' });
        assert.equal(r.out?.decision, 'block');
        assert.match(r.out.reason, /did not finish/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(fake.dir, { recursive: true, force: true });
    }
});
test('a Stop runs the stop hooks and keeps their block', () => {
    const root = home();
    const fake = fakeHooks({ 'brain-gate.mjs': { print: { decision: 'block', reason: 'brain down' } } });
    try {
        const s = { hook_event_name: 'Stop', session_id: 's1', prompt_id: 'p1', stop_hook_active: false, last_assistant_message: 'done' };
        const r = run(root, 'Stop', s, { HAVOK_DISPATCH_HOOKS: fake.dir });
        assert.equal(r.out?.decision, 'block');
        assert.ok(fake.ran().includes('brain-gate.mjs'));
    }
    finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(fake.dir, { recursive: true, force: true });
    }
});
test('the handled path is quick: one node start and one small file read', () => {
    const root = home();
    try {
        mark(root, 's1', 'PreToolUse', bashEm);
        const times = [0, 1, 2].map(() => run(root, 'PreToolUse', bashEm).ms);
        assert.ok(Math.min(...times) < 1500, 'took ' + times.join(', '));
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('the backup refuses a visible window and a new watcher when the mod did not run, and lets a hidden call through', () => {
    const root = home();
    try {
        const call = (tool, command) => ({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: tool, tool_use_id: 'toolu_w' + command.length, tool_input: { command }, cwd: tmpdir() });
        const window = run(root, 'PreToolUse', call('PowerShell', 'Start-Process notepad.exe'));
        assert.equal(window.out?.hookSpecificOutput?.permissionDecision, 'deny');
        assert.match(window.out.hookSpecificOutput.permissionDecisionReason, /-WindowStyle Hidden/);
        const watcher = run(root, 'PreToolUse', call('Bash', 'schtasks /Create /SC MINUTE /MO 1 /TN W /TR "wscript C:/x/l.vbs" /F'));
        assert.match(watcher.out?.hookSpecificOutput?.permissionDecisionReason || '', /add the marker/);
        assert.equal(run(root, 'PreToolUse', call('PowerShell', 'Start-Process node -ArgumentList s.mjs -WindowStyle Hidden')).out, null);
        assert.equal(run(root, 'PreToolUse', call('Read', 'x')).out, null);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('the window check is a safety check: past its time it refuses, and it runs for Bash and PowerShell only', () => {
    const root = home();
    const fake = fakeHooks({ 'check-windows.mjs': { hang: true } });
    try {
        const r = run(root, 'PreToolUse', bashEm, { HAVOK_DISPATCH_HOOKS: fake.dir, HAVOK_DISPATCH_JOB_MS: '1500' });
        assert.equal(r.out?.hookSpecificOutput?.permissionDecision, 'deny');
        assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /window and watcher check .*did not finish/i);
        const fake2 = fakeHooks({});
        run(root, 'PreToolUse', { ...bashEm, tool_name: 'Read', tool_input: { file_path: 'x' } }, { HAVOK_DISPATCH_HOOKS: fake2.dir });
        assert.ok(!fake2.ran().includes('check-windows.mjs'));
        rmSync(fake2.dir, { recursive: true, force: true });
    }
    finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(fake.dir, { recursive: true, force: true });
    }
});
test('the backup never blocks a keep-warm ping: an old timer is told to delete itself, any other ping to answer ok', () => {
    const root = home();
    try {
        const p = { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'keep-warm ping', prompt_id: 'p1' };
        const timer = run(root, 'UserPromptSubmit', { ...p, source: 'schedule_wakeup' }).out;
        assert.equal(timer?.decision, undefined);
        assert.match(timer.hookSpecificOutput.additionalContext, /CronDelete/);
        const own = run(root, 'UserPromptSubmit', { ...p, prompt_id: 'p2' }).out;
        assert.equal(own?.decision, undefined);
        assert.match(own.hookSpecificOutput.additionalContext, /single word ok/);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('a session start with an old marker waits for the mod: marked during the wait, nothing runs and no note is left', async () => {
    const root = home();
    const input = { hook_event_name: 'SessionStart', session_id: 's9', source: 'resume' };
    mark(root, 's9', 'UserPromptSubmit', { prompt: 'old', prompt_id: 'p' }, Date.now() - 20 * 60000);
    const { spawn } = await import('node:child_process');
    const fake = fakeHooks({});
    const child = spawn(process.execPath, [DISPATCH, 'SessionStart'], { windowsHide: true, env: { ...process.env, USERPROFILE: root, HOME: root, CLAUDE_PLUGIN_ROOT: '', HAVOK_DISPATCH_HOOKS: fake.dir, HAVOK_DISPATCH_START_WAIT_MS: '4000' } });
    child.stdin.end(JSON.stringify(input));
    await new Promise((r) => setTimeout(r, 1200));
    mark(root, 's9', 'SessionStart', input);
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 0);
    assert.deepEqual(fake.ran(), []);
    assert.equal(existsSync(join(root, '.claude', 'havok-mod', 'backup', 's9.json')), false);
    rmSync(root, { recursive: true, force: true });
});
const failures = (root) => { const f = join(root, '.claude', 'havok-mod', 'mod-failures.jsonl'); return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; };
test('with the mod installed, an event the mod did not handle runs no old hook and refuses nothing', () => {
    const root = home({ mod: true });
    const fake = fakeHooks({});
    const r = run(root, 'PreToolUse', bashEm, { HAVOK_DISPATCH_HOOKS: fake.dir });
    assert.equal(r.status, 0);
    assert.equal(r.out, null);
    assert.deepEqual(fake.ran(), []);
    assert.equal(backupLog(root), '');
    rmSync(root, { recursive: true, force: true });
});
test('with the mod installed, a session start the mod never marks is reported once after the wait, and nothing runs', () => {
    const root = home({ mod: true });
    const input = { hook_event_name: 'SessionStart', session_id: 's8', source: 'resume' };
    mark(root, 's8', 'UserPromptSubmit', { prompt: 'old', prompt_id: 'p' }, Date.now() - 20 * 60000);
    const fake = fakeHooks({});
    const env = { HAVOK_DISPATCH_HOOKS: fake.dir, HAVOK_DISPATCH_START_WAIT_MS: '1500', HAVOK_MOD_AGENT: 'dev-2' };
    const r = run(root, 'SessionStart', input, env);
    assert.equal(r.status, 0);
    assert.ok(r.ms >= 1500, 'waited ' + r.ms + ' ms');
    assert.deepEqual(fake.ran(), []);
    const rows = failures(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session, 's8');
    assert.equal(rows[0].agent, 'dev-2');
    assert.equal(rows[0].cause, 'stale-marker');
    assert.equal(rows[0].sent, false);
    assert.match(rows[0].why, /did not handle the session start \(resume\)/);
    run(root, 'SessionStart', input, env);
    assert.equal(failures(root).length, 1);
    rmSync(root, { recursive: true, force: true });
});
test('with the mod installed, a session start the mod marks is not reported', async () => {
    const root = home({ mod: true });
    const input = { hook_event_name: 'SessionStart', session_id: 's7', source: 'startup' };
    mark(root, 's7', 'SessionStart', input);
    const r = run(root, 'SessionStart', input, { HAVOK_DISPATCH_START_WAIT_MS: '500' });
    assert.equal(r.status, 0);
    assert.deepEqual(failures(root), []);
    rmSync(root, { recursive: true, force: true });
});
