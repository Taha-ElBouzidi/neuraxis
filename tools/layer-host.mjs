import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export const LAYER_MAX_CHARS = 20000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function validKey(key) {
    if (key === 'global')
        return true;
    const m = /^group\/([^/]+)$/.exec(String(key || ''));
    return !!m && NAME.test(m[1]);
}
const fileOf = (root, key) => join(root, key + '.md');
const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
function load(root, key) {
    try {
        return readFileSync(fileOf(root, key), 'utf8').replace(/\r\n/g, '\n');
    }
    catch {
        return null;
    }
}
export function readLayer(root, key) {
    if (!validKey(key))
        return { status: 400, error: 'bad layer key' };
    const text = load(root, key);
    if (text === null)
        return { status: 404, error: 'no such layer' };
    if (text.length > LAYER_MAX_CHARS)
        return { status: 413, error: 'layer over ' + LAYER_MAX_CHARS + ' characters' };
    return { status: 200, text, version: sha(text) };
}
export function layerVersions(root, machine, groups) {
    const keys = ['global'];
    for (const g of Array.isArray(groups) ? groups : [])
        keys.push('group/' + g);
    const out = {};
    for (const k of keys) {
        if (k in out)
            continue;
        const r = readLayer(root, k);
        if (r.status === 200)
            out[k] = r.version;
    }
    return out;
}
