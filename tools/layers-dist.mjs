import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const SUBFOLDERS = ['', 'machine', 'group'];
export function servedLayerFiles() { return []; }
export function allLayerFiles(brain) {
    const out = [];
    for (const sub of SUBFOLDERS) {
        const dir = sub ? join(brain, 'layers', sub) : join(brain, 'layers');
        let names = [];
        try {
            names = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const n of names) {
            if (!n.endsWith('.md'))
                continue;
            try {
                if (!statSync(join(dir, n)).isFile())
                    continue;
            }
            catch {
                continue;
            }
            out.push(['layers', sub, n].filter(Boolean).join('/'));
        }
    }
    return out;
}
export function layerOrphans(brain, published) {
    if (!published.has('layers/README.md'))
        return [];
    return allLayerFiles(brain).filter((rel) => !published.has(rel));
}
