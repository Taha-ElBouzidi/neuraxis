import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const TODAY = new Date().toISOString().slice(0, 10);
let status = '';
try {
    status = execSync('git status --porcelain -- memory/', { cwd: BRAIN, encoding: 'utf8' });
}
catch {
    process.exit(0);
}
const changed = status.split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('D'))
    .map((l) => l.replace(/^\S+\s+/, '').replace(/^"|"$/g, ''))
    .filter((f) => f.startsWith('memory/') && f.endsWith('.md') && !f.endsWith('MEMORY.md'));
const META_KEYS = /^[+-]\s*(type|asserted|updated|node_type|originSessionId):/;
function isGenuineEdit(rel) {
    let diff;
    try {
        diff = execSync(`git diff --unified=0 -- "${rel}"`, { cwd: BRAIN, encoding: 'utf8' });
    }
    catch {
        return true;
    }
    if (!diff.trim())
        return true;
    const body = diff.split('\n')
        .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
        .filter((l) => l.slice(1).trim() !== '');
    if (!body.length)
        return false;
    return body.some((l) => !META_KEYS.test(l));
}
const stamped = [];
const skipped = [];
for (const rel of changed) {
    if (!isGenuineEdit(rel)) {
        skipped.push(rel);
        continue;
    }
    const path = join(BRAIN, rel);
    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    }
    catch {
        continue;
    }
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const norm = raw.replace(/\r\n/g, '\n');
    if (!norm.startsWith('---'))
        continue;
    const end = norm.indexOf('\n---', 3);
    if (end < 0)
        continue;
    const lines = norm.slice(0, end).split('\n');
    const tail = norm.slice(end);
    const metaIdx = lines.findIndex((l) => /^metadata:\s*$/.test(l));
    const nested = metaIdx >= 0;
    const indent = nested ? '  ' : '';
    const re = nested ? /^\s+updated:/ : /^updated:/;
    const existing = lines.findIndex((l) => re.test(l));
    if (existing >= 0) {
        if (lines[existing].trim() === `updated: ${TODAY}`)
            continue;
        lines[existing] = `${indent}updated: ${TODAY}`;
    }
    else {
        let insertAt;
        if (nested) {
            insertAt = metaIdx + 1;
            while (insertAt < lines.length && /^\s+\S/.test(lines[insertAt]))
                insertAt++;
        }
        else {
            insertAt = lines.length;
        }
        lines.splice(insertAt, 0, `${indent}updated: ${TODAY}`);
    }
    const out = (lines.join('\n') + tail).replace(/\n/g, eol === '\r\n' ? '\r\n' : '\n');
    if (!DRY)
        writeFileSync(path, out, 'utf8');
    stamped.push(rel);
}
console.log(`${DRY ? '[dry] ' : ''}stamped updated=${TODAY} on ${stamped.length} memory file(s), skipped ${skipped.length} metadata-only`);
stamped.forEach((f) => console.log('  ' + f));
