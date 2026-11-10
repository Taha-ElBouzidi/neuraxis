import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wt = createRequire(import.meta.url)('node:worker_threads');
const RealWorker = wt.Worker;
let live = 0;
let peak = 0;
let hang = false;
wt.Worker = class extends RealWorker {
    constructor(file, opts) {
        super(hang ? 'setInterval(() => {}, 1000);' : file, hang ? { eval: true } : opts);
        live += 1;
        peak = Math.max(peak, live);
        let done = false;
        const end = () => { if (!done) {
            done = true;
            live -= 1;
        } };
        this.once('message', end);
        this.once('exit', end);
    }
};
syncBuiltinESMExports();
process.env.RECALL_GRAPH_TIMEOUT_MS = '1500';
const { makeRecall } = await import('./recall-core.mjs');
const emb = JSON.parse(readFileSync(join(BRAIN, 'index', 'embeddings.json'), 'utf8'));
const probe = Float32Array.from(emb.vectors[0]);
const getEmbedder = async () => async () => ({ data: probe });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('a burst of index changes never runs more than one graph build at a time', async () => {
    let version = 'burst-0';
    const recall = makeRecall({ brain: BRAIN, getEmbedder, indexVersion: () => ({ version }) });
    const ask = () => recall('what does this memory say', ['what does this memory say'], 5, 0, false);
    await ask();
    peak = live;
    for (let i = 1; i <= 6; i += 1) {
        version = 'burst-' + i;
        await ask();
        await sleep(30);
    }
    for (let i = 0; i < 400 && recall.snapshotVersion() !== 'burst-6'; i += 1) {
        await ask();
        await sleep(50);
    }
    assert.equal(recall.snapshotVersion(), 'burst-6', 'the newest index is served in the end');
    assert.ok(peak <= 1, peak + ' graph builds ran at the same time');
});
test('a graph worker that never answers does not hang recall', async () => {
    hang = true;
    try {
        const recall = makeRecall({ brain: BRAIN, getEmbedder, indexVersion: () => ({ version: 'hang-1' }) });
        const answer = await Promise.race([
            recall('what does this memory say', ['what does this memory say'], 5, 0, false),
            sleep(20000).then(() => 'HUNG'),
        ]);
        assert.notEqual(answer, 'HUNG', 'the first recall was still waiting after 20 s');
        assert.ok(answer.length > 0);
        await sleep(200);
        assert.equal(live, 0, 'the silent worker was left running');
    }
    finally {
        hang = false;
    }
});
