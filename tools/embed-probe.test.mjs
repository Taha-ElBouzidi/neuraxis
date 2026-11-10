import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGuardedEmbedder, probeReason, probeKey, ILLEGAL_INSTRUCTION, WASM_MODULE, savedBackend } from './embed-guard.mjs';
import { makeRecall } from './recall-core.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'embed-probe-'));
const fake = join(dir, 'fake-embed.mjs');
writeFileSync(fake, "export async function load() { return async () => ({ data: Float32Array.from([1, 0, 0, 0]) }); }\n");
const crash = join(dir, 'crash-probe.mjs');
writeFileSync(crash, `process.exit(${ILLEGAL_INSTRUCTION});\n`);
test('the illegal instruction exit names the missing AVX', () => {
    assert.match(probeReason(ILLEGAL_INSTRUCTION, null, ''), /no AVX/);
    assert.match(probeReason(-1073741795, null, ''), /no AVX/);
    assert.match(probeReason(2, null, 'boom'), /exit 2: boom/);
});
test('a probe that crashes: every embed fails at once with the reason, and no model worker is started', async () => {
    const events = [];
    const g = makeGuardedEmbedder({ model: 'm', module: fake, timeoutMs: 1000, loadTimeoutMs: 20000, probe: true, probeScript: crash, onEvent: (e) => events.push(e) });
    await assert.rejects(g.embed('x'), /being checked/);
    for (let i = 0; i < 100 && !events.includes('probe-failed'); i++)
        await sleep(50);
    await assert.rejects(g.embed('x'), /no AVX/);
    assert.match(g.state(), /^probe: /);
    g.close();
});
test('a probe that answers: the success is remembered for this CPU, and the next embedder skips the probe', async () => {
    const stateFile = join(dir, 'state.json');
    const events = [];
    const g = makeGuardedEmbedder({ model: 'm', module: fake, timeoutMs: 5000, loadTimeoutMs: 20000, probe: true, stateFile, onEvent: (e) => events.push(e) });
    await assert.rejects(g.embed('x'), /being checked/);
    for (let i = 0; i < 200 && !events.includes('probe-ok'); i++)
        await sleep(50);
    assert.ok(events.includes('probe-ok'), events.join(','));
    assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).ok, probeKey());
    const r = await g.embed('x');
    assert.equal(r.data.length, 4);
    g.close();
    const g2 = makeGuardedEmbedder({ model: 'm', module: fake, timeoutMs: 5000, loadTimeoutMs: 20000, probe: true, stateFile, onEvent: () => { } });
    assert.equal((await g2.embed('x')).data.length, 4);
    g2.close();
});
test('a brain with no embeddings index answers from the keyword index and says why', async () => {
    const brain = join(dir, 'brain');
    mkdirSync(join(brain, 'index'), { recursive: true });
    mkdirSync(join(brain, 'memory'), { recursive: true });
    writeFileSync(join(brain, 'index', 'keywords.json'), JSON.stringify({ terms: { tomatoes: ['reference_tomatoes'], garden: ['reference_tomatoes'] }, descriptions: { reference_tomatoes: 'how the tomatoes grow in the garden' } }));
    writeFileSync(join(brain, 'memory', 'reference_tomatoes.md'), '---\nname: reference_tomatoes\ndescription: how the tomatoes grow in the garden\ntype: reference\n---\nbody\n');
    let asked = 0;
    const recall = makeRecall({ brain, getEmbedder: async () => { asked++; return async () => ({ data: [1] }); }, indexVersion: () => ({ version: 'v1' }) });
    const ranked = await recall('tomatoes in the garden', ['tomatoes in the garden'], 5, 0, true);
    assert.ok(ranked.map((r) => r.slug ?? r[0] ?? r).join(' ').includes('reference_tomatoes'), JSON.stringify(ranked).slice(0, 300));
    assert.match(String(ranked.degraded), /no usable embeddings index/);
    assert.equal(asked, 0, 'the embedder is not asked when there is nothing to compare with');
});
test('the native runtime crashes, the WASM backend answers: the embedder runs on WebAssembly and remembers it', async () => {
    const onlyWasm = join(dir, 'only-wasm-probe.mjs');
    writeFileSync(onlyWasm, `process.exit(String(process.argv[3] || '').endsWith('embed-wasm.mjs') ? 0 : ${ILLEGAL_INSTRUCTION});
`);
    const stateFile = join(dir, 'state-wasm.json');
    const events = [];
    const g = makeGuardedEmbedder({ model: 'Xenova/all-MiniLM-L6-v2', module: null, timeoutMs: 20000, loadTimeoutMs: 60000, probe: true, stateFile, probeScript: onlyWasm, onEvent: (e) => events.push(e) });
    await assert.rejects(g.embed('x'), /being checked/);
    for (let i = 0; i < 200 && !events.includes('probe-ok'); i++)
        await sleep(50);
    assert.deepEqual(events.slice(0, 4), ['probe-start', 'probe-failed', 'probe-wasm-start', 'probe-ok']);
    assert.equal(savedBackend(stateFile), 'wasm');
    const r = await g.embed('how the tomatoes grow in the garden');
    assert.equal(r.data.length, 384);
    g.close();
});
test.after(() => rmSync(dir, { recursive: true, force: true }));
