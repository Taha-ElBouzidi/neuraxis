import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = ['brain-server.mjs', 'agy-quota-store.mjs', 'outlook-remote.mjs', 'brain-git-lock.mjs', 'vault-access.mjs', 'recall-core.mjs', 'recall-graph-worker.mjs', 'tailnet-watch.mjs', 'provenance.mjs', 'tokenize.mjs', 'layers-dist.mjs', 'server-alerts.mjs', 'archive-upload.mjs', 'layer-host.mjs', 'recall-turn.mjs', 'release-host.mjs', 'embed-guard.mjs', 'embed-worker.mjs', 'decision-store.mjs', 'decision-review.mjs', 'analytics-store.mjs'];
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const roots = [];
after(() => { for (const r of roots)
    rmSync(r, { recursive: true, force: true }); });
function makeBrain() {
    const root = mkdtempSync(join(tmpdir(), 'server-queue-'));
    roots.push(root);
    for (const d of ['tools', 'memory', 'index', 'home'])
        mkdirSync(join(root, d));
    for (const m of MODULES)
        if (existsSync(join(HERE, m)))
            copyFileSync(join(HERE, m), join(root, 'tools', m));
    writeFileSync(join(root, 'memory', 'MEMORY.md'), '# memory\n');
    writeFileSync(join(root, 'MANIFEST.md'), '# manifest\n');
    writeFileSync(join(root, 'index', 'keywords.json'), '{}\n');
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', windowsHide: true });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'start');
    git('config', 'user.name', 't');
    git('config', 'user.email', 't@example.com');
    return { root, git };
}
async function startServer(root) {
    const port = await freePort();
    const child = spawn(process.execPath, [join(root, 'tools', 'brain-server.mjs'), '--allow-plaintext'], {
        env: { ...process.env, HAVOK_HOME: join(root, 'home'), HAVOK_SERVER_PORT: String(port), HAVOK_DECISIONS_PORT: '0', HAVOK_EMBED_PROBE: 'off' }, windowsHide: true, stdio: 'ignore',
    });
    for (let i = 0; i < 150; i += 1) {
        try {
            if ((await fetch('http://127.0.0.1:' + port + '/health')).ok)
                break;
        }
        catch { }
        await sleep(100);
    }
    const token = readFileSync(join(root, 'home', 'havok-server-token'), 'utf8').trim();
    return { port, child, token };
}
const memory = (slug, text) => '---\nname: ' + slug + '\ndescription: ' + text + ', a test memory long enough to be indexed for recall\ntype: reference\nmetadata:\n  type: reference\n  asserted: 2026-11-10\n---\n' + text + '\n';
async function waitFor(fn, ms = 60000) { const t = Date.now(); while (Date.now() - t < ms) {
    if (fn())
        return true;
    await sleep(250);
} return false; }
test('two overlapping writes are both committed and both logged', { timeout: 120000 }, async () => {
    const { root, git } = makeBrain();
    const { port, child, token } = await startServer(root);
    try {
        const write = (slug) => fetch('http://127.0.0.1:' + port + '/memory', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ slug, content: memory(slug, 'about ' + slug) }) });
        const [a, b] = await Promise.all([write('reference_queue_test_one'), write('reference_queue_test_two')]);
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        const log = () => { try {
            return readFileSync(join(root, '.server-access.log'), 'utf8');
        }
        catch {
            return '';
        } };
        assert.ok(await waitFor(() => /MEMORY-WRITE \S+ \S+ reference_queue_test_one/.test(log()) && /MEMORY-WRITE \S+ \S+ reference_queue_test_two/.test(log())), 'both writes logged');
        const files = git('log', '--name-only', '--format=%s');
        assert.match(files, /memory\/reference_queue_test_one\.md/, log().split('\n').filter((l) => /MEMORY|FAIL|INDEX|SAVE/.test(l)).join(' | '));
        assert.match(files, /memory\/reference_queue_test_two\.md/);
        assert.equal(existsSync(join(root, '.save-queue.jsonl')), false, 'the queue file is gone once the batch ran');
    }
    finally {
        child.kill();
    }
});
test('a queue a stopped server left on disk is committed by the next start', { timeout: 120000 }, async () => {
    const { root, git } = makeBrain();
    const slug = 'reference_queue_test_left';
    writeFileSync(join(root, 'memory', slug + '.md'), memory(slug, 'left behind by a restart'));
    writeFileSync(join(root, '.save-queue.jsonl'), JSON.stringify({ slug, existed: false, callerName: 'TEST', ip: '127.0.0.1' }) + '\n');
    const { child } = await startServer(root);
    try {
        const log = () => { try {
            return readFileSync(join(root, '.server-access.log'), 'utf8');
        }
        catch {
            return '';
        } };
        assert.ok(await waitFor(() => /MEMORY-QUEUE-RESUMED reference_queue_test_left/.test(log()) && /MEMORY-WRITE \S+ TEST reference_queue_test_left/.test(log())), 'resumed and logged');
        assert.match(git('log', '--name-only', '--format=%s'), /memory\/reference_queue_test_left\.md/);
        assert.equal(existsSync(join(root, '.save-queue.jsonl')), false);
    }
    finally {
        child.kill();
    }
});
