import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BAR as RULE_BAR, reserveOf, accountOf, claudeFiles } from '../hooks/limit-rules.mjs';
export const BAR = RULE_BAR;
export function limitReached(bar = BAR) {
    const json = (f) => { try {
        return JSON.parse(readFileSync(f, 'utf8'));
    }
    catch {
        return null;
    } };
    const brain = json(join(dirname(fileURLToPath(import.meta.url)), '..', 'brain.json'));
    const files = claudeFiles(homedir(), process.env.CLAUDE_CONFIG_DIR);
    if (!reserveOf(brain, accountOf(json(files.claudeJson))).enabled)
        return null;
    let lim = null;
    try {
        lim = JSON.parse(readFileSync(files.limits, 'utf8'));
    }
    catch {
        return null;
    }
    const live = (w) => (w && typeof w.used_percentage === 'number' && Number(w.resets_at) * 1000 > Date.now() ? w : null);
    const hit = [['5 hour', live(lim && lim.five)], ['weekly', live(lim && lim.week)]].filter(([, w]) => w && w.used_percentage >= bar);
    if (!hit.length)
        return null;
    return hit.map(([n, w]) => n + ' limit at ' + Math.round(w.used_percentage) + '%, resets ' + new Date(w.resets_at * 1000).toISOString()).join('; ');
}
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].replace(/\//g, '\\').toLowerCase()) {
    const why = limitReached();
    if (why) {
        process.stdout.write(why + '\n');
        process.exit(1);
    }
    process.exit(0);
}
export function limitResetsAt(bar = BAR) {
    const why = limitReached(bar);
    if (!why)
        return null;
    const at = [...why.matchAll(/resets (\S+?)(?:;|$)/g)].map((m) => Date.parse(m[1])).filter((t) => t > 0);
    return at.length ? Math.max(...at) : null;
}
