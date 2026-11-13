#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODE = process.argv[2];
const NL = String.fromCharCode(10);
let input = {};
try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
}
catch { }
function recall(prompt, extra = {}) {
    if (!String(prompt || '').trim())
        return '';
    const r = spawnSync(process.execPath, [join(BRAIN, 'hooks', 'pre-turn.mjs')], {
        input: JSON.stringify({ prompt, ...extra }), encoding: 'utf8', timeout: 20000, cwd: BRAIN, windowsHide: true,
    });
    try {
        return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || '';
    }
    catch {
        return '';
    }
}
function rulesAndInstruction() {
    let rules = [];
    try {
        rules = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules || [];
    }
    catch { }
    return [
        'This computer has a long-term memory. Before answering anything that could depend on past facts, decisions,',
        'people, projects or rules, call the MCP tool `recall` (server "brain") with the user\'s message, then open what',
        'matters with `read_memory`. Save lasting facts as memories. If the memory is unreachable, say so first.',
        ...(rules.length ? ['', 'Standing rules:', ...rules.map((r, i) => (i + 1) + '. ' + (r.short || r.rule))] : []),
    ].join(NL);
}
function lastUserRequest(transcriptPath) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const p = String(transcriptPath || '').replace(/^~/, home);
    if (!p || !existsSync(p))
        return { text: '', latest: false, context: '' };
    const steps = readFileSync(p, 'utf8').split(NL).filter(Boolean).map((l) => { try {
        return JSON.parse(l);
    }
    catch {
        return null;
    } }).filter(Boolean);
    let idx = -1;
    for (let i = steps.length - 1; i >= 0; i--)
        if (steps[i].type === 'USER_INPUT') {
            idx = i;
            break;
        }
    if (idx < 0)
        return { text: '', latest: false, context: '' };
    const content = String(steps[idx].content || '');
    const m = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
    const earlier = steps.slice(Math.max(0, idx - 6), idx).map((s) => String(s.content || '').replace(/<[^>]+>/g, ' ')).join(' ');
    return { text: (m ? m[1] : content).trim(), latest: idx === steps.length - 1, context: earlier.replace(/\s+/g, ' ').slice(-700) };
}
let out = {};
try {
    const messages = async (session, kind = 'gemini') => { try {
        const { turnBlock } = await import('../hooks/messages-client.mjs');
        return await turnBlock({ kind, session, cwd: process.cwd() });
    }
    catch {
        return '';
    } };
    if (MODE === 'gemini') {
        const ctx = [recall(input.prompt, { session_id: input.session_id }), await messages(input.session_id || '')].filter(Boolean).join(String.fromCharCode(10, 10));
        out = ctx ? { hookSpecificOutput: { additionalContext: ctx } } : {};
    }
    else if (MODE === 'agy') {
        const u = lastUserRequest(input.transcriptPath);
        const ctx = u.latest ? [recall(u.text, { session_id: input.conversationId, ...(u.context ? { context: u.context } : {}) }), await messages(input.conversationId || '')].filter(Boolean).join(String.fromCharCode(10, 10)) : '';
        out = ctx ? { injectSteps: [{ ephemeralMessage: ctx }] } : {};
    }
    else if (MODE === 'cursor') {
        out = { additional_context: [rulesAndInstruction(), await messages(input.session_id || input.conversation_id || '', 'cursor')].filter(Boolean).join(String.fromCharCode(10, 10)) };
    }
    else if (MODE === 'cline') {
        const ctx = recall(input.prompt || (input.userPromptSubmit && input.userPromptSubmit.prompt), {});
        out = { cancel: false, ...(ctx ? { contextModification: ctx } : {}) };
    }
}
catch {
    out = MODE === 'cline' ? { cancel: false } : {};
}
process.stdout.write(JSON.stringify(out));
