import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const versionOf = (text) => (/^\/\/ havok-statusline (\S+)/.exec(String(text ?? '').split(/\r?\n/)[0] ?? '') ?? [])[1] ?? '';
const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14);
export function installPlan(targetText, sourceText, existing) {
    if (targetText === null || targetText === undefined)
        return { backup: '', copy: true };
    if (targetText === sourceText)
        return { backup: '', copy: false };
    const v = versionOf(targetText);
    const name = v ? `statusline.mjs.bak-${v}` : `statusline.mjs.bak-original-${stamp()}`;
    return { backup: existing.includes(name) ? '' : name, copy: true };
}
const parts = (v) => v.split('.').map((n) => parseInt(n, 10) || 0);
const older = (a, b) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < 3; i++)
        if ((x[i] || 0) !== (y[i] || 0))
            return (x[i] || 0) - (y[i] || 0);
    return 0;
};
export function restoreChoice(baks) {
    const originals = baks.filter((b) => b.startsWith('statusline.mjs.bak-original-')).sort();
    if (originals.length)
        return originals[0];
    const versioned = baks.filter((b) => /^statusline\.mjs\.bak-\d+\.\d+\.\d+$/.test(b)).sort((a, b) => older(a.slice(19), b.slice(19)));
    return versioned[0] ?? '';
}
const read = (f) => {
    try {
        return readFileSync(f, 'utf8');
    }
    catch {
        return null;
    }
};
const baksIn = (dir) => {
    try {
        return readdirSync(dir).filter((f) => f.startsWith('statusline.mjs.bak-'));
    }
    catch {
        return [];
    }
};
export function installStatusline(source, target) {
    const plan = installPlan(read(target), read(source), baksIn(dirname(target)));
    if (plan.backup)
        writeFileSync(join(dirname(target), plan.backup), read(target));
    if (plan.copy)
        writeFileSync(target, read(source));
    return plan;
}
export function restoreStatusline(target) {
    const pick = restoreChoice(baksIn(dirname(target)));
    if (pick)
        writeFileSync(target, read(join(dirname(target), pick)));
    return pick;
}
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
    const [what, a, b] = process.argv.slice(2);
    if (what === 'install' && a && b && existsSync(a)) {
        const p = installStatusline(a, b);
        console.log(`status line ${p.copy ? 'installed' : 'already this release'}${p.backup ? ', old one kept as ' + p.backup : ''}`);
    }
    else if (what === 'restore' && a) {
        const p = restoreStatusline(a);
        console.log(p ? `status line restored from ${basename(p)}` : 'no status line backup to restore');
    }
    else {
        console.error('usage: node statusline-backup.mjs install <source> <target> | restore <target>');
        process.exit(2);
    }
}
