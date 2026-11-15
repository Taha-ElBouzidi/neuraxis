import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
export const SAME = 0.75;
export const RELATED = 0.55;
export async function nearDescriptions({ brain, slug = '', desc, embed, top = 8, cacheFile = join(tmpdir(), 'havok-neuron-check-descriptions.json') }) {
    const vector = await embed(slug ? slug.replace(/_/g, ' ') + '. ' + desc : desc);
    const kw = JSON.parse(readFileSync(join(brain, 'index', 'keywords.json'), 'utf8'));
    let cache = {};
    try {
        cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    }
    catch { }
    const slugs = Object.keys(kw.descriptions || {}).sort();
    const vectors = [];
    let fresh = 0;
    for (const s of slugs) {
        const text = s.replace(/_/g, ' ') + '. ' + kw.descriptions[s];
        if (!cache[s] || cache[s].t !== text) {
            cache[s] = { t: text, v: await embed(text) };
            fresh++;
        }
        vectors.push(cache[s].v);
    }
    if (fresh) {
        try {
            writeFileSync(cacheFile, JSON.stringify(cache));
        }
        catch { }
    }
    return slugs.map((s, i) => {
        const v = vectors[i];
        let d = 0;
        for (let k = 0; k < v.length; k++)
            d += vector[k] * v[k];
        return [s, d];
    }).filter(([s]) => s !== slug).sort((a, b) => b[1] - a[1]).slice(0, top);
}
