#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NL = String.fromCharCode(10);
const SLUG = /^[a-z0-9_-]+$/;
const TOOLS = [
    {
        name: 'recall',
        description: 'Search the long-term memory (the brain) for everything relevant to a message. Call it with the user\'s message before answering anything that could depend on past facts, decisions, people, projects or rules, unless a BRAIN RECALL block is already in your context. Returns matching memories with a one-line description each; open the ones that matter with read_memory before relying on them.',
        inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'The user\'s message, or the question you need answered, in their words.' } }, required: ['message'] },
    },
    {
        name: 'read_memory',
        description: 'Read one memory in full by its slug (the name recall shows before the colon). Never answer from the one-line description alone.',
        inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
];
function recall(message) {
    const r = spawnSync(process.execPath, [join(BRAIN, 'hooks', 'pre-turn.mjs')], {
        input: JSON.stringify({ prompt: String(message).slice(0, 20000), hook_event_name: 'UserPromptSubmit' }),
        encoding: 'utf8', timeout: 30000, windowsHide: true, cwd: BRAIN,
    });
    try {
        const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext || '';
        return ctx.trim() || 'The brain returned nothing for this message.';
    }
    catch {
        return 'Recall failed (exit ' + r.status + '). Say so to the user before answering: ' + String(r.stderr || '').slice(0, 300);
    }
}
function readMemory(slug) {
    if (!SLUG.test(String(slug || '')))
        return 'Not a memory slug: ' + slug;
    const file = join(BRAIN, 'memory', slug + '.md');
    if (existsSync(file))
        return readFileSync(file, 'utf8');
    const client = join(BRAIN, 'tools', 'brain-client.mjs');
    if (existsSync(client)) {
        const r = spawnSync(process.execPath, [client, 'read', slug], { encoding: 'utf8', timeout: 30000, windowsHide: true, cwd: BRAIN });
        if (r.status === 0 && r.stdout.trim())
            return r.stdout;
    }
    return 'No memory named ' + slug + '.';
}
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const text = (s) => ({ content: [{ type: 'text', text: s }] });
function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
        return ok(id, { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'brain', version: '1.0.0' } });
    }
    if (method === 'tools/list')
        return ok(id, { tools: TOOLS });
    if (method === 'tools/call') {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (name === 'recall')
            return ok(id, text(recall(args.message || args.question || '')));
        if (name === 'read_memory')
            return ok(id, text(readMemory(args.slug)));
        return { jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool ' + name } };
    }
    if (method === 'ping')
        return ok(id, {});
    if (id === undefined || id === null)
        return null;
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method ' + method } };
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf(NL)) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line)
            continue;
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            continue;
        }
        const out = handle(msg);
        if (out)
            process.stdout.write(JSON.stringify(out) + NL);
    }
});
