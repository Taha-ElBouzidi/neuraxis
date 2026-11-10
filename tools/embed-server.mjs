import { createServer } from 'node:http';
import { writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { pipeline, env } from '@xenova/transformers';
import { makeRecall, SHORT_FOLLOW_UP } from './recall-core.mjs';
env.allowLocalModels = false;
const DEFAULT_PORT = 8477;
const PORT = Number(process.env.HAVOK_EMBED_PORT || DEFAULT_PORT);
const IS_THE_DAEMON = PORT === DEFAULT_PORT;
const MODEL = 'Xenova/all-MiniLM-L6-v2';
process.stdout.write(`loading ${MODEL} ...\n`);
const t0 = Date.now();
const embed = await pipeline('feature-extraction', MODEL);
process.stdout.write(`ready in ${Date.now() - t0}ms on 127.0.0.1:${PORT}\n`);
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localIndexVersion = () => {
    const parts = [];
    for (const f of ['keywords.json', 'embeddings.json']) {
        try {
            const st = statSync(join(BRAIN, 'index', f));
            parts.push(f + ':' + st.size + ':' + Math.floor(st.mtimeMs));
        }
        catch { }
    }
    return { version: parts.join('|') };
};
const recall = makeRecall({ brain: BRAIN, getEmbedder: async () => embed, indexVersion: localIndexVersion });
const norm = (p) => String(p || '').split(String.fromCharCode(92)).join('/').replace(/\/+$/, '').toLowerCase();
const server = createServer(async (req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, model: MODEL, recall: true }));
    }
    if (req.method === 'POST' && req.url === '/recall') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 400000)
            req.destroy(); });
        req.on('end', async () => {
            try {
                const rp = JSON.parse(body || '{}');
                if (norm(rp.brain) !== norm(BRAIN)) {
                    res.writeHead(409, { 'content-type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'different brain' }));
                }
                const prompt = String(rp.prompt || '');
                const queries = (Array.isArray(rp.queries) && rp.queries.length ? rp.queries : [prompt]).map(String).slice(0, 24);
                const parts = Math.max(0, Math.min(Number(rp.parts) || 0, 16));
                const ctx = (Number.isInteger(rp.contextIndex) && prompt.trim().length >= SHORT_FOLLOW_UP) ? rp.contextIndex : -1;
                const ranked = await recall(prompt, queries, 5, 0, false, parts, ctx);
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ranked }));
            }
            catch (e) {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: String(e.message).slice(0, 200) }));
            }
        });
        return;
    }
    if (req.method !== 'POST' || req.url !== '/embed') {
        res.writeHead(404);
        return res.end();
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000)
        req.destroy(); });
    req.on('end', async () => {
        try {
            const { text } = JSON.parse(body || '{}');
            if (typeof text !== 'string' || !text.trim()) {
                res.writeHead(400, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'text required' }));
            }
            const out = await embed(text.slice(0, 4000), { pooling: 'mean', normalize: true });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ vector: Array.from(out.data) }));
        }
        catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: String(e.message).slice(0, 200) }));
        }
    });
});
const ALIVE = join(homedir(), '.claude', 'havok-embed.alive');
server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        process.stdout.write('embed daemon already listening on 127.0.0.1:' + PORT + ', nothing to do' + String.fromCharCode(10));
        process.exit(0);
    }
    throw e;
});
let ownsPort = false;
server.listen(PORT, '127.0.0.1', () => {
    ownsPort = IS_THE_DAEMON;
    if (!IS_THE_DAEMON) {
        process.stdout.write('running on ' + PORT + ', not the default, so leaving the liveness marker alone' + String.fromCharCode(10));
        return;
    }
    try {
        writeFileSync(ALIVE, String(process.pid), 'utf8');
    }
    catch { }
});
const cleanup = () => { if (ownsPort) {
    try {
        unlinkSync(ALIVE);
    }
    catch { }
} process.exit(0); };
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(sig, cleanup);
process.on('exit', () => { if (ownsPort) {
    try {
        unlinkSync(ALIVE);
    }
    catch { }
} });
