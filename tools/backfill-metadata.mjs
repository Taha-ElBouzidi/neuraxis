import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEM = join(BRAIN, 'memory');
const DRY = process.argv.includes('--dry');
const VALID = new Set(['user', 'contact', 'project', 'feedback', 'reference']);
const BULK_THRESHOLD = 20;
function commitDates() {
    const map = new Map();
    let log = '';
    try {
        log = execSync('git log --pretty=format:@@C@@%cs --name-only -- memory/', {
            cwd: BRAIN, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
        });
    }
    catch {
        return map;
    }
    for (const chunk of log.split('@@C@@')) {
        if (!chunk.trim())
            continue;
        const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
        const date = lines.shift();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
            continue;
        const touched = lines.filter((l) => l.startsWith('memory/')).map((l) => l.slice('memory/'.length));
        const bulk = touched.length > BULK_THRESHOLD;
        for (const f of touched) {
            const e = map.get(f) || { first: null, last: null };
            e.first = date;
            if (!bulk && !e.last)
                e.last = date;
            map.set(f, e);
        }
    }
    return map;
}
const commits = commitDates();
const first = new Map([...commits].map(([f, e]) => [f, e.first]));
const last = new Map([...commits].map(([f, e]) => [f, e.last || e.first]));
const files = readdirSync(MEM).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
const report = { typed: [], dated: [], updated: [], noFrontmatter: [], noMetaBlock: [], untouched: 0 };
for (const f of files) {
    const raw = readFileSync(join(MEM, f), 'utf8');
    if (!raw.startsWith('---')) {
        report.noFrontmatter.push(f);
        continue;
    }
    const end = raw.indexOf('\n---', 3);
    if (end < 0) {
        report.noFrontmatter.push(f);
        continue;
    }
    const head = raw.slice(0, end);
    const tail = raw.slice(end);
    const lines = head.split('\n');
    const metaIdx = lines.findIndex((l) => /^metadata:\s*$/.test(l));
    const nested = metaIdx >= 0;
    const indent = nested ? '  ' : '';
    let blockStart, blockEnd;
    if (nested) {
        blockStart = metaIdx + 1;
        blockEnd = blockStart;
        while (blockEnd < lines.length && /^\s+\S/.test(lines[blockEnd]))
            blockEnd++;
    }
    else {
        blockStart = 1;
        blockEnd = lines.length;
    }
    const block = lines.slice(blockStart, blockEnd);
    const typeRe = nested ? /^\s+type:/ : /^type:/;
    const assertedRe = nested ? /^\s+asserted:/ : /^asserted:/;
    const updatedRe = nested ? /^\s+updated:/ : /^updated:/;
    const hasType = block.some((l) => typeRe.test(l));
    const hasAsserted = block.some((l) => assertedRe.test(l));
    const hasUpdated = block.some((l) => updatedRe.test(l));
    const add = [];
    if (!hasType) {
        const prefix = f.split('_')[0];
        if (VALID.has(prefix)) {
            add.push(`${indent}type: ${prefix}`);
            report.typed.push(`${f} -> ${prefix}`);
        }
    }
    if (!hasAsserted) {
        const d = first.get(f);
        if (d) {
            add.push(`${indent}asserted: ${d}`);
            report.dated.push(`${f} -> ${d}`);
        }
    }
    if (!hasUpdated) {
        const d = last.get(f) || first.get(f);
        if (d) {
            add.push(`${indent}updated: ${d}`);
            report.updated.push(`${f} -> ${d}`);
        }
    }
    if (!add.length) {
        report.untouched++;
        continue;
    }
    lines.splice(blockEnd, 0, ...add);
    if (!DRY)
        writeFileSync(join(MEM, f), lines.join('\n') + tail, 'utf8');
}
console.log(DRY ? '=== DRY RUN, nothing written ===' : '=== APPLIED ===');
console.log(`files scanned:        ${files.length}`);
console.log(`already complete:     ${report.untouched}`);
console.log(`type added:           ${report.typed.length}`);
console.log(`asserted added:       ${report.dated.length}`);
console.log(`updated added:        ${report.updated.length}`);
console.log(`no frontmatter:       ${report.noFrontmatter.length} ${report.noFrontmatter.join(', ')}`);
console.log(`no metadata block:    ${report.noMetaBlock.length} ${report.noMetaBlock.join(', ')}`);
if (report.typed.length)
    console.log('\ntype inferred from prefix:\n  ' + report.typed.join('\n  '));
