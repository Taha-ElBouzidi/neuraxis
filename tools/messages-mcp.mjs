#!/usr/bin/env node
import { identity, machineName, send, receive, status, agents } from '../hooks/messages-client.mjs';
const KIND = (() => { const i = process.argv.indexOf('--kind'); return i > 0 ? String(process.argv[i + 1] || 'agent') : 'agent'; })();
const NL = String.fromCharCode(10);
const TOOLS = [
    {
        name: 'send_message',
        description: 'Send a message to another Havok agent (on any machine) through the agent messages service. Give to (an address like havok@SERVER) or reply_to (the id of a message you received, to answer it). Write only the message: the service shows who sent it.',
        inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' }, reply_to: { type: 'string' } }, required: ['text'] },
    },
    {
        name: 'check_messages',
        description: 'Read the agent messages waiting for you now (they also arrive by themselves at the start of your next turn). Each comes with its sender, time and id; answer with send_message and reply_to.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'message_status',
        description: 'The state of a message you sent: waiting, being delivered, delivered, answered, or why not.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
        name: 'list_agents',
        description: 'The agents the messages service knows, whether each is listening now, and whether you may message it.',
        inputSchema: { type: 'object', properties: {} },
    },
];
const me = () => identity({ kind: KIND, cwd: process.cwd() });
const words = (o) => (typeof o === 'string' ? o : JSON.stringify(o, null, 1));
async function run(name, args) {
    const agent = me();
    if (name === 'send_message') {
        const r = await send(agent, { to: args.to, text: args.text, reply_to: args.reply_to });
        if (r.error)
            return 'Not sent: ' + r.error;
        if (r.queued)
            return 'Queued, not sent yet: ' + r.why + '.';
        return `Sent: message ${r.id} to ${r.to}, from ${agent}@${machineName()}.`;
    }
    if (name === 'check_messages') {
        const r = await receive(agent, { session: process.env.HAVOK_MESSAGES_SESSION || '' });
        if (!r.count)
            return r.why ? 'No messages read: ' + r.why + '.' : 'No message is waiting.';
        return r.text;
    }
    if (name === 'message_status')
        return words(await status(agent, args.id));
    if (name === 'list_agents')
        return words(await agents(agent));
    throw new Error('unknown tool ' + name);
}
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const text = (s) => ({ content: [{ type: 'text', text: s }] });
async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize')
        return ok(id, { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'havok-messages', version: '1.0.0' } });
    if (method === 'tools/list')
        return ok(id, { tools: TOOLS });
    if (method === 'tools/call') {
        try {
            return ok(id, text(await run(params && params.name, (params && params.arguments) || {})));
        }
        catch (e) {
            return { jsonrpc: '2.0', id, error: { code: -32601, message: String(e.message || e) } };
        }
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
        handle(msg).then((out) => { if (out)
            process.stdout.write(JSON.stringify(out) + NL); });
    }
});
