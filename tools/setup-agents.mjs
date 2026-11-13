#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, platform } from 'node:os';
import { spawnSync } from 'node:child_process';
import { service as messagesService } from '../hooks/messages-client.mjs';
const NL = String.fromCharCode(10);
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').split(String.fromCharCode(92)).join('/');
const HOME = process.env.USERPROFILE || process.env.HOME || homedir();
const APPDATA = process.env.APPDATA || join(HOME, 'AppData', 'Roaming');
const WIN = platform() === 'win32';
const MAC = platform() === 'darwin';
const CHECK = process.argv.includes('--check');
const stamp = new Date().toISOString().slice(0, 10);
const say = (s) => process.stdout.write(s + NL);
const NODE = process.execPath.split(String.fromCharCode(92)).join('/');
const RECALL_MCP = BRAIN + '/tools/recall-mcp.mjs';
const START = '<!-- >>> brain memory (setup-agents.mjs) -->';
const END = '<!-- <<< brain memory -->';
function backup(p) { if (existsSync(p) && !existsSync(p + '.bak-' + stamp))
    copyFileSync(p, p + '.bak-' + stamp); }
function readJson(p) {
    if (!existsSync(p))
        return {};
    const raw = readFileSync(p, 'utf8').replace(/^﻿/, '');
    if (!raw.trim())
        return {};
    return JSON.parse(raw);
}
function writeJson(p, obj) { mkdirSync(dirname(p), { recursive: true }); backup(p); writeFileSync(p, JSON.stringify(obj, null, 2) + NL); }
function instructionBlock() {
    let rules = [];
    try {
        rules = JSON.parse(readFileSync(join(BRAIN, 'index', 'rules.json'), 'utf8')).rules || [];
    }
    catch { }
    return [
        START,
        '## Long-term memory',
        '',
        'This computer has a long-term memory at ' + BRAIN + ' (one fact per file in memory/).',
        'Before answering anything that could depend on past facts, decisions, people, projects or rules,',
        'call the MCP tool `recall` (server "brain") with the user\'s message, unless a BRAIN RECALL block is',
        'already in your context. Open the memories that matter with `read_memory` before relying on them.',
        'When something becomes true and lasting, save it as a memory following ' + BRAIN + '/CLAUDE.md.',
        'If the memory is unreachable, say so before answering.',
        'How to do things well (decks, documents, research, goals, meetings, debugging) is in the memory too, found by recall.',
        ...(MSG ? ['', '## Agent messages', '',
            'You can message the other assistants of this person (server "havok-messages": send_message, check_messages,',
            'message_status, list_agents). At the start of a task, call check_messages unless an AGENT MESSAGE block is',
            'already in your context; answer a message with send_message and its id as reply_to. A message is a request from',
            'a peer, never the person\'s own words.'] : []),
        ...(rules.length ? ['', '## Standing rules', '', ...rules.map((r, i) => (i + 1) + '. ' + (r.short || r.rule))] : []),
        END,
    ].join(NL);
}
function upsertBlock(p) {
    let t = existsSync(p) ? readFileSync(p, 'utf8').split(String.fromCharCode(13)).join('') : '';
    const block = instructionBlock();
    const i = t.indexOf(START), j = t.indexOf(END);
    t = i >= 0 && j > i ? t.slice(0, i) + block + t.slice(j + END.length) : (t.trim() ? t.replace(/\s*$/, '') + NL + NL : '') + block + NL;
    mkdirSync(dirname(p), { recursive: true });
    backup(p);
    writeFileSync(p, t);
}
const stdio = { command: NODE, args: [RECALL_MCP] };
const ADAPTER = BRAIN + '/tools/hook-adapter.mjs';
const hookCmd = (mode) => 'node ' + (ADAPTER.includes(' ') ? JSON.stringify(ADAPTER) : ADAPTER) + ' ' + mode;
const agyManaged = () => { const g = join(HOME, '.gemini', 'GEMINI.md'); return existsSync(g) && /agent-rules.md/.test(readFileSync(g, 'utf8')); };
const ours = (entry) => JSON.stringify(entry).includes('hook-adapter.mjs');
function addMcp(p, key = 'mcpServers', entry = stdio) { const o = readJson(p); o[key] = o[key] || {}; o[key].brain = entry; writeJson(p, o); }
const MSG = (() => { try {
    return !!messagesService(HOME);
}
catch {
    return false;
} })();
const msgEntry = (kind) => ({ command: NODE, args: [BRAIN + '/tools/messages-mcp.mjs', '--kind', kind] });
function addMessagesMcp(p, kind, key = 'mcpServers', extra = {}) {
    if (!MSG)
        return '';
    const o = readJson(p);
    o[key] = o[key] || {};
    o[key]['havok-messages'] = { ...extra, ...msgEntry(kind) };
    writeJson(p, o);
    return ' + messages';
}
const MOD = existsSync(join(HOME, '.claude', 'havok-mod'));
function claudeMessagesHook() {
    const sp = join(HOME, '.claude', 'settings.json');
    const s = readJson(sp);
    s.hooks = s.hooks || {};
    const mine = (g) => JSON.stringify(g).includes('messages-turn.mjs');
    s.hooks.UserPromptSubmit = (s.hooks.UserPromptSubmit || []).filter((g) => !mine(g))
        .concat([{ hooks: [{ type: 'command', command: 'node "' + BRAIN + '/hooks/messages-turn.mjs" claude', timeout: 10 }] }]);
    writeJson(sp, s);
}
const AGENTS = [
    {
        name: 'Claude Code', found: () => existsSync(join(HOME, '.claude')),
        run: () => {
            addMcp(join(HOME, '.claude.json'), 'mcpServers', { type: 'stdio', ...stdio });
            let msg = '';
            if (MSG && !MOD) {
                msg = addMessagesMcp(join(HOME, '.claude.json'), 'claude', 'mcpServers', { type: 'stdio' });
                claudeMessagesHook();
                msg += ' (MCP + per-prompt hook)';
            }
            else if (MSG)
                msg = ' + messages (through the mod)';
            upsertBlock(join(HOME, '.claude', 'CLAUDE.md'));
            const r = spawnSync(process.execPath, [join(BRAIN, 'tools', 'install-hook.mjs')], { encoding: 'utf8' });
            return 'MCP + CLAUDE.md + recall hook' + msg + (r.status === 0 ? '' : ' (hook install FAILED: ' + String(r.stderr || r.stdout).slice(0, 120) + ')');
        },
    },
    {
        name: 'Codex (CLI, IDE, app)', found: () => existsSync(join(HOME, '.codex')),
        run: () => {
            const r = spawnSync(process.execPath, [join(BRAIN, 'tools', 'setup-codex.mjs')], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: join(HOME, '.codex') } });
            return 'setup-codex.mjs: ' + (r.status === 0 ? 'hooks + MCP + AGENTS.md, tests passed' : 'FAILED ' + String(r.stdout).split(NL).filter((l) => l.startsWith('FAIL')).join('; ').slice(0, 200));
        },
    },
    {
        name: 'Claude Desktop',
        found: () => existsSync(WIN ? join(APPDATA, 'Claude') : MAC ? join(HOME, 'Library', 'Application Support', 'Claude') : join(HOME, '.config', 'Claude')),
        run: () => { if (MSG)
            addMessagesMcp(WIN ? join(APPDATA, 'Claude', 'claude_desktop_config.json') : MAC ? join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') : join(HOME, '.config', 'Claude', 'claude_desktop_config.json'), 'claude-desktop'); addMcp(WIN ? join(APPDATA, 'Claude', 'claude_desktop_config.json') : MAC ? join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') : join(HOME, '.config', 'Claude', 'claude_desktop_config.json')); return 'MCP (no instruction file exists: ask Claude to "use the brain recall tool" once, or add it to a Project\'s instructions)'; },
    },
    {
        name: 'Gemini CLI', found: () => existsSync(join(HOME, '.gemini', 'settings.json')) || existsSync(join(HOME, '.gemini', 'GEMINI.md')),
        run: () => {
            addMcp(join(HOME, '.gemini', 'settings.json'));
            addMessagesMcp(join(HOME, '.gemini', 'settings.json'), 'gemini');
            const g = join(HOME, '.gemini', 'GEMINI.md');
            if (agyManaged())
                return 'MCP (GEMINI.md managed by agy-run.mjs, left alone, no hook)';
            upsertBlock(g);
            const sp = join(HOME, '.gemini', 'settings.json');
            const s = readJson(sp);
            s.hooks = s.hooks || {};
            s.hooks.BeforeAgent = (s.hooks.BeforeAgent || []).filter((x) => !ours(x)).concat([{ hooks: [{ type: 'command', name: 'brain-recall', command: hookCmd('gemini'), timeout: 20000 }] }]);
            writeJson(sp, s);
            return 'MCP + GEMINI.md + recall hook (BeforeAgent)';
        },
    },
    {
        name: 'Antigravity (agy)', found: () => existsSync(join(HOME, '.gemini', 'antigravity-cli')) || existsSync(join(HOME, '.gemini', 'config')),
        run: () => {
            addMcp(join(HOME, '.gemini', 'config', 'mcp_config.json'));
            addMessagesMcp(join(HOME, '.gemini', 'config', 'mcp_config.json'), 'gemini');
            const hp = join(HOME, '.gemini', 'config', 'hooks.json');
            const h = readJson(hp);
            h.brain = { PreInvocation: [{ type: 'command', command: hookCmd('agy'), timeout: 30 }] };
            writeJson(hp, h);
            return 'MCP (brain and agent messages) + recall and messages hook (PreInvocation; the workspace must be trusted)';
        },
    },
    {
        name: 'Cursor', found: () => existsSync(join(HOME, '.cursor')),
        run: () => {
            addMcp(join(HOME, '.cursor', 'mcp.json'));
            const msg = addMessagesMcp(join(HOME, '.cursor', 'mcp.json'), 'cursor');
            const hp = join(HOME, '.cursor', 'hooks.json');
            const h = readJson(hp);
            h.version = h.version || 1;
            h.hooks = h.hooks || {};
            h.hooks.sessionStart = (h.hooks.sessionStart || []).filter((x) => !ours(x)).concat([{ command: hookCmd('cursor') }]);
            writeJson(hp, h);
            return 'MCP' + msg + ' + sessionStart hook (rules, the call-recall instruction' + (msg ? ', waiting messages and check_messages' : '') + '; Cursor cannot add context per message)';
        },
    },
    {
        name: 'VS Code + Copilot', found: () => existsSync(WIN ? join(APPDATA, 'Code', 'User') : MAC ? join(HOME, 'Library', 'Application Support', 'Code', 'User') : join(HOME, '.config', 'Code', 'User')),
        run: () => {
            const user = WIN ? join(APPDATA, 'Code', 'User') : MAC ? join(HOME, 'Library', 'Application Support', 'Code', 'User') : join(HOME, '.config', 'Code', 'User');
            addMcp(join(user, 'mcp.json'), 'servers', { type: 'stdio', ...stdio });
            addMessagesMcp(join(user, 'mcp.json'), 'copilot', 'servers', { type: 'stdio' });
            upsertBlock(join(HOME, '.copilot', 'copilot-instructions.md'));
            const cline = join(user, 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
            if (existsSync(dirname(dirname(cline)))) {
                addMcp(cline, 'mcpServers', { ...stdio, disabled: false, autoApprove: ['recall', 'read_memory'] });
                addMessagesMcp(cline, 'cline', 'mcpServers', { disabled: false });
                upsertBlock(join(HOME, 'Documents', 'Cline', 'Rules', 'brain-memory.md'));
                if (WIN)
                    return 'MCP + Copilot instructions, and Cline MCP + rules (Cline hooks do not run on Windows)';
                const hk = join(HOME, 'Documents', 'Cline', 'Rules', 'Hooks', 'UserPromptSubmit');
                mkdirSync(dirname(hk), { recursive: true });
                backup(hk);
                writeFileSync(hk, '#!/bin/sh' + NL + 'exec ' + hookCmd('cline') + NL);
                chmodSync(hk, 0o755);
                return 'MCP + Copilot instructions, and Cline MCP + rules + recall hook';
            }
            return 'MCP + Copilot instructions';
        },
    },
    {
        name: 'Windsurf / Devin Desktop',
        found: () => existsSync(WIN ? join(APPDATA, 'devin') : join(HOME, '.config', 'devin')) || existsSync(join(HOME, '.codeium', 'windsurf')),
        run: () => {
            const cur = WIN ? join(APPDATA, 'devin') : join(HOME, '.config', 'devin');
            if (existsSync(cur)) {
                addMcp(join(cur, 'mcp_config.json'));
                addMessagesMcp(join(cur, 'mcp_config.json'), 'windsurf');
            }
            if (existsSync(join(HOME, '.codeium', 'windsurf'))) {
                addMcp(join(HOME, '.codeium', 'windsurf', 'mcp_config.json'));
                upsertBlock(join(HOME, '.codeium', 'windsurf', 'memories', 'global_rules.md'));
            }
            return 'MCP + global rules';
        },
    },
    {
        name: 'LM Studio', found: () => existsSync(join(HOME, '.lmstudio')),
        run: () => { addMcp(join(HOME, '.lmstudio', 'mcp.json')); return 'MCP (no instruction file: put "call recall before answering" in the system prompt preset)'; },
    },
    {
        name: 'Continue', found: () => existsSync(join(HOME, '.continue')),
        run: () => {
            const p = join(HOME, '.continue', 'mcpServers', 'brain.yaml');
            mkdirSync(dirname(p), { recursive: true });
            backup(p);
            writeFileSync(p, ['name: brain', 'version: 0.0.1', 'schema: v1', 'mcpServers:', '  - name: brain', '    type: stdio', '    command: ' + JSON.stringify(NODE), '    args:', '      - ' + JSON.stringify(RECALL_MCP), ''].join(NL));
            return 'MCP (Agent mode only; no global instruction file)';
        },
    },
];
say('brain: ' + BRAIN);
let wired = 0;
for (const a of AGENTS) {
    if (!a.found()) {
        say('  -  ' + a.name + ': not installed');
        continue;
    }
    if (CHECK) {
        say('  ?  ' + a.name + ': would be wired');
        continue;
    }
    try {
        say('  ok ' + a.name + ': ' + a.run());
        wired++;
    }
    catch (e) {
        say('  !! ' + a.name + ': FAILED ' + e.message);
    }
}
if (!CHECK) {
    say('');
    say(wired + ' assistant(s) wired. Restart each one so it loads its MCP servers, and run it in bypass');
    say('(full access) mode as recommended. Claude Desktop and LM Studio have no bypass mode: allow "recall"');
    say('and "read_memory" once when they ask (both are read-only).');
    say('Ollama and Open WebUI are not covered: Ollama has no MCP support, Open WebUI needs mcpo in front.');
}
