import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { pipeline, env } from '@xenova/transformers';
import { embedText, textHash } from './embed-text.mjs';
import { probeBackendSync } from './embed-guard.mjs';
import { load as loadWasm } from './embed-wasm.mjs';
env.allowLocalModels = false;
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDX = join(BRAIN, 'index');
export const MODEL = 'Xenova/all-MiniLM-L6-v2';
const keywords = JSON.parse(readFileSync(join(IDX, 'keywords.json'), 'utf8'));
const slugs = Object.keys(keywords.descriptions).sort();
const docs = slugs.map((s) => embedText(BRAIN, s, keywords.descriptions[s]));
const t0 = Date.now();
const backend = process.env.HAVOK_EMBED_BACKEND || probeBackendSync(join(BRAIN, '.embed-probe.json'), MODEL);
if (!backend) {
    console.error('the embedding model did not run here, natively or on WebAssembly: vectors not built. A model download that failed or timed out looks the same as a processor that cannot run it: run node tools/build-embeddings.mjs again; if it fails again, the processor likely lacks AVX and recall stays keyword only (nothing was saved, so the next run tries again)');
    process.exit(3);
}
const embed = backend === 'wasm' ? await loadWasm(MODEL) : await pipeline('feature-extraction', MODEL);
if (backend === 'wasm')
    console.log('embedding on WebAssembly (the native runtime cannot run on this CPU)');
const loadMs = Date.now() - t0;
const docHashes = docs.map((d) => hash(d));
const reuse = new Map();
try {
    const prev = JSON.parse(readFileSync(join(IDX, 'embeddings.json'), 'utf8'));
    if (prev.model === MODEL && Array.isArray(prev.docHashes))
        prev.slugs.forEach((s, i) => reuse.set(s + ' ' + prev.docHashes[i], prev.vectors[i]));
}
catch { }
const t1 = Date.now();
const vectors = [];
let embedded = 0;
for (let i = 0; i < docs.length; i++) {
    const again = reuse.get(slugs[i] + ' ' + docHashes[i]);
    if (again) {
        vectors.push(again);
        continue;
    }
    const out = await embed(docs[i], { pooling: 'mean', normalize: true });
    vectors.push(Array.from(out.data).map((x) => Math.round(x * 1e4) / 1e4));
    embedded++;
}
const embedMs = Date.now() - t1;
mkdirSync(IDX, { recursive: true });
const payload = {
    model: MODEL,
    dims: vectors[0]?.length ?? 0,
    count: slugs.length,
    descriptionsHash: textHash(BRAIN, keywords.descriptions),
    slugs,
    docHashes,
    vectors,
};
writeFileSync(join(IDX, 'embeddings.json'), JSON.stringify(payload), 'utf8');
let questionRows = { slugs: [], texts: [] };
try {
    questionRows = JSON.parse(readFileSync(join(IDX, 'questions.json'), 'utf8'));
}
catch { }
const qVectors = [];
for (const q of questionRows.texts || []) {
    const out = await embed(q, { pooling: 'mean', normalize: true });
    qVectors.push(Array.from(out.data).map((x) => Math.round(x * 1e4) / 1e4));
}
const qPayload = {
    model: MODEL,
    dims: qVectors[0]?.length ?? 0,
    count: qVectors.length,
    questionsHash: hash((questionRows.texts || []).join('')),
    slugs: questionRows.slugs || [],
    vectors: qVectors,
};
writeFileSync(join(IDX, 'question-embeddings.json'), JSON.stringify(qPayload), 'utf8');
function hash(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++)
        h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36);
}
const bytes = Buffer.byteLength(JSON.stringify(payload));
console.log(`embeddings: ${slugs.length} memories, ${payload.dims} dims, ${Math.round(bytes / 1024)}KB`);
console.log(`model load ${loadMs}ms, embed ${embedMs}ms, ${embedded} embedded, ${slugs.length - embedded} reused`);
