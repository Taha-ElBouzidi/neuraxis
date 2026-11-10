import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { terms as qterms } from './tokenize.mjs';
export const SHORT_FOLLOW_UP = 25;
export function makeRecall({ brain, getEmbedder, indexVersion }) {
    const BRAIN = brain;
    const RRF_K = 60;
    const SPARSE_MIN = Number(process.env.RECALL_MIN || 0.10);
    const PER_CHANNEL = 20;
    const RECALL_MODE = process.env.RECALL_MODE || 'threshold';
    const MEANING_BAR = Number(process.env.RECALL_MEANING_BAR || 0.50);
    const LINK_BAR = Number(process.env.RECALL_LINK_BAR || 0.5);
    const LINK_FLOOR = Number(process.env.RECALL_LINK_FLOOR || 1.2);
    const ALWAYS_FUSED = 3;
    const CONTEXT_WEIGHT = 0.9;
    const PART_K = 2;
    const BODY_HITS = 5;
    const SPREAD = 0.5;
    const SPREAD_ITERS = 20;
    const MEANING_K = 5;
    const MEANING_FLOOR = 0.55;
    const EMBED_BUDGET_MS = Number(process.env.RECALL_EMBED_BUDGET_MS || 6000);
    let partBar = null, partLinkBar = null;
    let current = null, currentSeq = 0, building = null, buildSeq = 0;
    function graphFromEdges(n, from, to, weight) {
        const g = Array.from({ length: n }, () => new Map());
        for (let e = 0; e < from.length; e++)
            g[from[e]].set(to[e], weight[e]);
        return g;
    }
    const GRAPH_TIMEOUT_MS = Number(process.env.RECALL_GRAPH_TIMEOUT_MS || 120000);
    function graphInWorker(emb) {
        const n = emb.slugs.length;
        const dim = n ? emb.vectors[0].length : 0;
        const vectors = new Float64Array(n * dim);
        for (let i = 0; i < n; i++)
            vectors.set(emb.vectors[i], i * dim);
        return new Promise((ok, fail) => {
            const w = new Worker(new URL('./recall-graph-worker.mjs', import.meta.url), {
                workerData: { brain: BRAIN, slugs: emb.slugs, dim, vectors, meaningK: MEANING_K, meaningFloor: MEANING_FLOOR },
                transferList: [vectors.buffer],
            });
            const timer = setTimeout(() => { w.terminate(); fail(new Error('graph worker gave no answer in ' + GRAPH_TIMEOUT_MS + ' ms')); }, GRAPH_TIMEOUT_MS);
            w.once('message', (m) => { clearTimeout(timer); ok({ graph: graphFromEdges(n, m.from, m.to, m.weight), contacts: new Map(m.contacts) }); });
            w.once('error', (e) => { clearTimeout(timer); fail(e); });
            w.once('exit', (code) => { clearTimeout(timer); fail(new Error('graph worker exited with code ' + code + ' before answering')); });
        });
    }
    async function buildSnapshot(v) {
        const kw = JSON.parse(await readFile(join(BRAIN, 'index', 'keywords.json'), 'utf8'));
        let emb;
        try {
            emb = JSON.parse(await readFile(join(BRAIN, 'index', 'embeddings.json'), 'utf8'));
            if (!Array.isArray(emb.slugs) || !Array.isArray(emb.vectors))
                throw new Error('embeddings.json has no slugs or vectors');
        }
        catch (e) {
            emb = { slugs: [], vectors: [], missing: 'there is no usable embeddings index (' + String((e && e.code) || (e && e.message) || e).slice(0, 80) + ')' };
        }
        let parts;
        try {
            parts = await graphInWorker(emb);
        }
        catch (e) {
            process.stderr.write('recall: graph worker failed (' + String(e && e.message).slice(0, 160) + '), building on the main thread\n');
            parts = { graph: linkGraph(emb), contacts: contactsByFirstName(emb) };
        }
        return { v, kw, emb, graph: parts.graph, contacts: parts.contacts };
    }
    async function snapshot() {
        const v = indexVersion().version;
        if (current && current.v === v)
            return current;
        if (!building) {
            const seq = ++buildSeq;
            const promise = buildSnapshot(v).then((s) => {
                if (seq > currentSeq) {
                    current = s;
                    currentSeq = seq;
                }
                return s;
            }).finally(() => { if (building && building.seq === seq)
                building = null; });
            building = { v, seq, promise };
            if (current)
                promise.catch((e) => process.stderr.write('recall: index rebuild failed (' + String(e && e.message).slice(0, 160) + ')\n'));
        }
        if (current)
            return current;
        return building.promise;
    }
    function linkGraph(emb) {
        const n = emb.slugs.length;
        const at = new Map(emb.slugs.map((s, i) => [s, i]));
        const g = Array.from({ length: n }, () => new Map());
        const link = (i, j, w) => { if (i === j)
            return; g[i].set(j, Math.max(g[i].get(j) || 0, w)); g[j].set(i, Math.max(g[j].get(i) || 0, w)); };
        for (const s of emb.slugs) {
            let text = '';
            try {
                text = readFileSync(join(BRAIN, 'memory', s + '.md'), 'utf8');
            }
            catch {
                continue;
            }
            for (const m of text.matchAll(/\[\[([a-z0-9_-]+)\]\]/g)) {
                const j = at.get(m[1]);
                if (j !== undefined)
                    link(at.get(s), j, 1);
            }
        }
        for (let i = 0; i < n; i++) {
            const vi = emb.vectors[i];
            const sims = [];
            for (let j = 0; j < n; j++) {
                if (j === i)
                    continue;
                const vj = emb.vectors[j];
                let d = 0;
                for (let k = 0; k < vi.length; k++)
                    d += vi[k] * vj[k];
                sims.push([j, d]);
            }
            sims.sort((a, b) => b[1] - a[1]);
            for (const [j, d] of sims.slice(0, MEANING_K))
                if (d >= MEANING_FLOOR)
                    link(i, j, d);
        }
        return g;
    }
    function contactsByFirstName(emb) {
        const map = new Map();
        for (const s of emb.slugs.filter((x) => x.startsWith('contact_'))) {
            let nm = '';
            try {
                nm = (readFileSync(join(BRAIN, 'memory', s + '.md'), 'utf8').match(/^name:\s*(.*)$/m) || [])[1] || '';
            }
            catch { }
            const first = (nm.replace(/^contact_/, '').split(/[\s,_-]+/)[0] || '').toLowerCase();
            if (first.length >= 3)
                map.set(first, (map.get(first) || []).concat([s]));
        }
        return map;
    }
    function spreadActivation(seed, g) {
        const total = seed.reduce((a, b) => a + b, 0) || 1;
        const s0 = seed.map((x) => x / total);
        const out = g.map((m) => { let w = 0; for (const v of m.values())
            w += v; return w; });
        let s = Float64Array.from(s0);
        for (let t = 0; t < SPREAD_ITERS; t++) {
            const nx = new Float64Array(s.length);
            for (let i = 0; i < s.length; i++) {
                if (!s[i])
                    continue;
                if (!out[i]) {
                    nx[i] += SPREAD * s[i];
                    continue;
                }
                for (const [j, w] of g[i])
                    nx[j] += SPREAD * s[i] * w / out[i];
            }
            for (let i = 0; i < s.length; i++)
                nx[i] += (1 - SPREAD) * s0[i];
            s = nx;
        }
        return s;
    }
    async function recall(prompt, queries, limit, bodyChars = 0, explicitLimit = true, parts = 0, contextIndex = -1) {
        const snap = await snapshot();
        const { kw, emb } = snap;
        let qEmb = null;
        try {
            qEmb = JSON.parse(readFileSync(join(BRAIN, 'index', 'question-embeddings.json'), 'utf8'));
        }
        catch { }
        const best = new Float64Array(emb.slugs.length).fill(-Infinity);
        const queryVectors = [];
        let embedded = 0;
        const ctxBest = new Float64Array(emb.slugs.length).fill(-Infinity);
        let vectors = [];
        let degraded = '';
        try {
            if (!emb.slugs.length)
                throw new Error(emb.missing || 'there is no embeddings index');
            const e = await getEmbedder();
            const t0 = Date.now();
            for (let qi = 0; qi < queries.length; qi++) {
                if (qi > 0 && Date.now() - t0 > EMBED_BUDGET_MS)
                    throw new Error('embedding the message took over ' + EMBED_BUDGET_MS + ' ms');
                vectors.push((await e(String(queries[qi]).slice(0, 4000), { pooling: 'mean', normalize: true })).data);
            }
        }
        catch (err) {
            vectors = [];
            degraded = String((err && err.message) || err).slice(0, 160);
        }
        for (let qi = 0; qi < vectors.length; qi++) {
            const qv = vectors[qi];
            queryVectors.push(qv);
            embedded++;
            const target = (contextIndex >= 0 && qi >= contextIndex) ? ctxBest : best;
            for (let i = 0; i < emb.slugs.length; i++) {
                const v = emb.vectors[i];
                let dot = 0;
                for (let k = 0; k < v.length; k++)
                    dot += qv[k] * v[k];
                if (dot > target[i])
                    target[i] = dot;
            }
        }
        const qBest = new Map();
        if (qEmb && qEmb.vectors && qEmb.vectors.length) {
            for (const qv of queryVectors) {
                for (let i = 0; i < qEmb.vectors.length; i++) {
                    const v = qEmb.vectors[i];
                    let dot = 0;
                    for (let k = 0; k < v.length; k++)
                        dot += qv[k] * v[k];
                    const slug = qEmb.slugs[i];
                    if (dot > (qBest.get(slug) ?? -Infinity))
                        qBest.set(slug, dot);
                }
            }
        }
        const denseRanked = embedded
            ? emb.slugs.map((s, i) => [s, Math.max(best[i], qBest.get(s) ?? -Infinity)])
                .sort((a, b) => b[1] - a[1]).slice(0, PER_CHANNEL)
            : [];
        const words = new Set(qterms(String(prompt).slice(0, 20000).toLowerCase()));
        const score = new Map();
        for (const w of words) {
            const slugs = kw.terms[w];
            if (!slugs)
                continue;
            const weight = 1 / slugs.length;
            for (const s of slugs)
                score.set(s, (score.get(s) || 0) + weight);
        }
        const sparseRanked = [...score.entries()]
            .filter(([, v]) => v >= SPARSE_MIN)
            .sort((a, b) => b[1] - a[1])
            .slice(0, PER_CHANNEL);
        const fused = new Map();
        sparseRanked.forEach(([s], r) => fused.set(s, (fused.get(s) || 0) + 1 / (RRF_K + r + 1)));
        denseRanked.forEach(([s], r) => fused.set(s, (fused.get(s) || 0) + 1 / (RRF_K + r + 1)));
        const bySparse = new Set(sparseRanked.map(([s]) => s));
        const byDense = new Set(denseRanked.map(([s]) => s));
        const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]);
        let chosen = ranked.slice(0, limit).map(([s]) => s);
        const linked = new Set();
        const viaContext = new Set();
        if (RECALL_MODE === 'threshold' && !explicitLimit && embedded) {
            chosen = ranked.slice(0, ALWAYS_FUSED).map(([s]) => s);
            const meaning = emb.slugs.map((s, i) => [s, Math.max(best[i], qBest.get(s) ?? -Infinity, ctxBest[i] * CONTEXT_WEIGHT)])
                .filter(([, v]) => v >= (partBar ?? MEANING_BAR)).sort((a, b) => b[1] - a[1]);
            const bar = partBar ?? MEANING_BAR;
            const at0 = new Map(emb.slugs.map((s, i) => [s, i]));
            for (const [s] of meaning) {
                if (chosen.includes(s))
                    continue;
                chosen.push(s);
                const i = at0.get(s);
                if (Math.max(best[i], qBest.get(s) ?? -Infinity) < bar)
                    viaContext.add(s);
            }
            for (let qi = 1; qi <= Math.min(parts, queryVectors.length - 1); qi++) {
                const qv = queryVectors[qi];
                emb.vectors.map((v, i) => { let d = 0; for (let k = 0; k < v.length; k++)
                    d += qv[k] * v[k]; return [emb.slugs[i], d]; })
                    .sort((a, b) => b[1] - a[1]).slice(0, PART_K)
                    .forEach(([s]) => { if (!chosen.includes(s))
                    chosen.push(s); });
            }
            const CTX_PART_K = Number(process.env.RECALL_CTX_PART_K || 0);
            const CTX_PART_MIN = Number(process.env.RECALL_CTX_PART_MIN || 0.45);
            if (CTX_PART_K > 0 && contextIndex >= 0) {
                for (let qi = contextIndex; qi < queryVectors.length; qi++) {
                    const qv = queryVectors[qi];
                    emb.vectors.map((v, i) => { let d = 0; for (let k = 0; k < v.length; k++)
                        d += qv[k] * v[k]; return [emb.slugs[i], d]; })
                        .filter(([, d]) => d >= CTX_PART_MIN).sort((a, b) => b[1] - a[1]).slice(0, CTX_PART_K)
                        .forEach(([s]) => { if (!chosen.includes(s))
                        chosen.push(s); });
                }
            }
            const PART_SPARSE_K = Number(process.env.RECALL_PART_SPARSE_K || 2);
            if (PART_SPARSE_K > 0) {
                for (let qi = 1; qi <= Math.min(parts, queries.length - 1); qi++) {
                    const sc = new Map();
                    for (const w of new Set(qterms(String(queries[qi]).toLowerCase()))) {
                        const ss = kw.terms[w];
                        if (!ss)
                            continue;
                        for (const s of ss)
                            sc.set(s, (sc.get(s) || 0) + 1 / ss.length);
                    }
                    [...sc.entries()].filter(([, v]) => v >= Number(process.env.RECALL_PART_SPARSE_MIN || 0.25)).sort((a, b) => b[1] - a[1]).slice(0, PART_SPARSE_K)
                        .forEach(([s]) => { if (!chosen.includes(s))
                        chosen.push(s); });
                }
            }
            if (process.env.RECALL_ENTITY !== '0') {
                const words = new Set(String(prompt).toLowerCase().match(/[a-zà-ÿ]{3,}/g) || []);
                for (const [first, ss] of snap.contacts)
                    if (ss.length === 1 && words.has(first) && !chosen.includes(ss[0]))
                        chosen.push(ss[0]);
            }
            const at = new Map(emb.slugs.map((s, i) => [s, i]));
            const seed = new Array(emb.slugs.length).fill(0);
            for (const [s, v] of fused)
                if (at.has(s))
                    seed[at.get(s)] = v;
            const act = spreadActivation(seed, snap.graph);
            let strongest = 0;
            for (const v of act)
                if (v > strongest)
                    strongest = v;
            emb.slugs.map((s, i) => [s, act[i]])
                .filter(([s]) => { const m = Number(process.env.RECALL_LINK_MEANING_MIN || 0); return m <= 0 || best[at.get(s)] >= m; })
                .filter(([s, v]) => !chosen.includes(s) && v > 0 && v >= strongest * (partLinkBar ?? LINK_BAR) && v >= LINK_FLOOR / emb.slugs.length)
                .sort((a, b) => b[1] - a[1])
                .forEach(([s]) => { chosen.push(s); linked.add(s); });
        }
        const SPLIT_MIN = Number(process.env.RECALL_SPLIT_MIN ?? 400);
        if (RECALL_MODE === 'threshold' && !explicitLimit && SPLIT_MIN > 0 && String(prompt).length >= SPLIT_MIN) {
            for (let qi = 1; qi <= Math.min(parts, queries.length - 1); qi++) {
                if (contextIndex >= 0 && qi >= contextIndex)
                    continue;
                const pb = Number(process.env.RECALL_PART_BAR || 0);
                if (pb > 0)
                    partBar = pb;
                const plb = Number(process.env.RECALL_PART_LINK_BAR || 0);
                if (plb > 0)
                    partLinkBar = plb;
                let sub;
                try {
                    sub = await recall(queries[qi], [queries[qi]], limit, 0, false, 0, -1);
                }
                finally {
                    partBar = null;
                    partLinkBar = null;
                }
                const plt = Number(process.env.RECALL_PART_LINK_TOP || 0);
                let partLinked = 0;
                for (const h of sub) {
                    if (plt > 0 && h.how === 'linked' && ++partLinked > plt)
                        continue;
                    if ((process.env.RECALL_PART_LINKS === '0' || process.env.RECALL_PART_LINKS === 'global') && h.how === 'linked')
                        continue;
                    if (chosen.includes(h.slug))
                        continue;
                    chosen.push(h.slug);
                    if (h.how === 'linked')
                        linked.add(h.slug);
                }
            }
        }
        if (process.env.RECALL_PART_LINKS === 'global' && RECALL_MODE === 'threshold' && !explicitLimit && SPLIT_MIN > 0 && String(prompt).length >= SPLIT_MIN && parts > 0) {
            const at2 = new Map(emb.slugs.map((s, i) => [s, i]));
            const seed2 = new Array(emb.slugs.length).fill(0);
            chosen.forEach((s, r) => { if (at2.has(s) && !linked.has(s))
                seed2[at2.get(s)] = 1 / (RRF_K + r + 1); });
            const act2 = spreadActivation(seed2, snap.graph);
            let top2 = 0;
            for (const v of act2)
                if (v > top2)
                    top2 = v;
            const gb = Number(process.env.RECALL_GLOBAL_LINK_BAR || LINK_BAR);
            emb.slugs.map((s, i) => [s, act2[i]])
                .filter(([s, v]) => !chosen.includes(s) && v > 0 && v >= top2 * gb && v >= LINK_FLOOR / emb.slugs.length)
                .sort((a, b) => b[1] - a[1])
                .forEach(([s]) => { chosen.push(s); linked.add(s); });
        }
        const idxOf = new Map(emb.slugs.map((s, i) => [s, i]));
        const matchOf = (s) => {
            const i = idxOf.get(s);
            if (!embedded || i === undefined)
                return null;
            const v = Math.max(best[i], qBest.get(s) ?? -Infinity);
            return Number.isFinite(v) ? +v.toFixed(3) : null;
        };
        const out = chosen
            .map((slug, rank) => {
            const hit = {
                slug,
                how: linked.has(slug) ? 'linked' : bySparse.has(slug) && byDense.has(slug) ? 'both' : byDense.has(slug) ? 'meaning' : 'keyword',
                direct: !linked.has(slug) && !viaContext.has(slug),
                match: matchOf(slug),
                description: kw.descriptions[slug] || '',
            };
            if (bodyChars > 0 && rank < BODY_HITS) {
                try {
                    const raw = readFileSync(join(BRAIN, 'memory', slug + '.md'), 'utf8').replace(/\r\n/g, '\n');
                    const afterFm = raw.startsWith('---') ? raw.slice(Math.max(raw.indexOf('\n---', 3) + 4, 0)) : raw;
                    const body = afterFm.trim();
                    hit.chars = body.length;
                    hit.body = body.slice(0, bodyChars);
                    hit.truncated = body.length > bodyChars;
                }
                catch { }
            }
            return hit;
        });
        if (degraded)
            Object.defineProperty(out, 'degraded', { value: degraded });
        return out;
    }
    recall.snapshotVersion = () => (current ? current.v : null);
    return recall;
}
