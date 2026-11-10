import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export const BODY_CHARS = 1200;
export function bodyStart(brain, slug) {
    try {
        const raw = readFileSync(join(brain, 'memory', slug + '.md'), 'utf8').split(String.fromCharCode(13)).join('');
        const end = raw.startsWith('---') ? raw.indexOf(String.fromCharCode(10) + '---', 3) : -1;
        return (end > 0 ? raw.slice(end + 4) : raw).replace(/\s+/g, ' ').trim().slice(0, BODY_CHARS);
    }
    catch {
        return '';
    }
}
export function embedText(brain, slug, description) {
    return slug.replace(/_/g, ' ') + '. ' + (description || '') + ' ' + bodyStart(brain, slug);
}
export function textHash(brain, descriptions) {
    const str = Object.keys(descriptions).sort()
        .map((s) => s + String.fromCharCode(0) + embedText(brain, s, descriptions[s])).join(String.fromCharCode(1));
    let h = 5381;
    for (let i = 0; i < str.length; i++)
        h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36);
}
