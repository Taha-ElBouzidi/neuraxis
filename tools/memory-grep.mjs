import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export const GREP_MAX_MEMORIES = 50;
export const GREP_LINES_PER_MEMORY = 3;
export const GREP_LINE_CHARS = 240;
export function grepMemories(memoryDir, q, { limit = 20 } = {}) {
    const needle = String(q || '').trim().toLowerCase();
    if (needle.length < 2 || needle.length > 200)
        return { error: 'q must be 2 to 200 characters' };
    const max = Math.min(Math.max(Number(limit) || 20, 1), GREP_MAX_MEMORIES);
    let files = [];
    try {
        files = readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
    }
    catch {
        return { q: needle, matches: [], total: 0, capped: false };
    }
    const matches = [];
    let total = 0;
    for (const f of files) {
        let text = '';
        try {
            text = readFileSync(join(memoryDir, f), 'utf8');
        }
        catch {
            continue;
        }
        if (!text.toLowerCase().includes(needle))
            continue;
        total++;
        if (matches.length >= max)
            continue;
        const lines = [];
        const all = text.split(/\r?\n/);
        for (let i = 0; i < all.length && lines.length < GREP_LINES_PER_MEMORY; i++) {
            const l = all[i];
            const at = l.toLowerCase().indexOf(needle);
            if (at < 0)
                continue;
            const from = Math.max(0, Math.min(at - 80, l.length - GREP_LINE_CHARS));
            const cut = l.slice(from, from + GREP_LINE_CHARS);
            lines.push({ n: i + 1, text: (from > 0 ? '...' : '') + cut + (from + GREP_LINE_CHARS < l.length ? '...' : '') });
        }
        matches.push({ slug: f.replace(/\.md$/, ''), lines });
    }
    return { q: needle, matches, total, capped: total > matches.length };
}
export function memoryManual(brainDir) {
    const f = join(brainDir, 'CLAUDE.md');
    if (!existsSync(f))
        return '';
    const all = readFileSync(f, 'utf8').split(/\r?\n/);
    const start = all.findIndex((l) => /^##\s+Writing a memory\b/i.test(l));
    if (start < 0)
        return '';
    let end = all.findIndex((l, i) => i > start && /^##\s/.test(l));
    if (end < 0)
        end = all.length;
    return all.slice(start, end).join('\n').trim() + '\n';
}
