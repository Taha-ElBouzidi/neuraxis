#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { whoAmI, record } from './provenance.mjs';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MEM = join(BRAIN, 'memory');
const NL = String.fromCharCode(10);
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
const slug = (s) => String(s || '').replace(/\.md$/, '');
const [oldSlug, newSlug] = [slug(argv[0]), slug(argv[1])];
const why = flag('--why');
const dry = argv.includes('--dry');
if (!oldSlug || !newSlug || argv[0].startsWith('--') || argv[1].startsWith('--') || !why) {
    process.stderr.write('usage: node tools/replace-memory.mjs <old-slug> <new-slug> --why "what changed" [--dry]' + NL);
    process.exit(2);
}
if (oldSlug === newSlug) {
    process.stderr.write('old and new are the same memory' + NL);
    process.exit(2);
}
for (const s of [oldSlug, newSlug]) {
    if (!existsSync(join(MEM, s + '.md'))) {
        process.stderr.write('no such memory: ' + s + NL);
        process.exit(2);
    }
}
const SERVER_ONLY = existsSync(join(BRAIN, 'server-endpoint.json')) && (() => { try {
    return JSON.parse(readFileSync(join(BRAIN, 'brain.json'), 'utf8')).memoryWritesThroughServer === true;
}
catch {
    return false;
} })();
const throughServer = [];
const linkRe = new RegExp('\\[\\[' + oldSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]\\]', 'g');
const changed = [];
for (const f of readdirSync(MEM).filter((n) => n.endsWith('.md') && n !== oldSlug + '.md')) {
    const p = join(MEM, f);
    const before = readFileSync(p, 'utf8');
    if (!linkRe.test(before))
        continue;
    linkRe.lastIndex = 0;
    const target = f === newSlug + '.md' ? '`' + oldSlug + '` (replaced)' : '[[' + newSlug + ']]';
    let after = before.replace(linkRe, target);
    after = after.split('[[' + newSlug + ']], [[' + newSlug + ']]').join('[[' + newSlug + ']]')
        .split('[[' + newSlug + ']] [[' + newSlug + ']]').join('[[' + newSlug + ']]');
    changed.push(f);
    if (!dry) {
        if (SERVER_ONLY)
            throughServer.push([f.replace(/\.md$/, ''), after]);
        else
            writeFileSync(p, after);
    }
}
process.stdout.write((dry ? 'would repoint' : 'repointed') + ' links in ' + changed.length + ' memories'
    + (changed.length ? ': ' + changed.join(', ') : '') + NL);
if (dry) {
    process.stdout.write('dry run: nothing deleted' + NL);
    process.exit(0);
}
if (!existsSync(join(BRAIN, 'server-endpoint.json'))) {
    const stamp = new Date().toISOString();
    mkdirSync(join(BRAIN, 'deleted'), { recursive: true });
    const old = join(MEM, oldSlug + '.md');
    writeFileSync(join(BRAIN, 'deleted', oldSlug + '.' + stamp.replace(/[:.]/g, '-') + '.md'), '<!-- deleted ' + stamp + ': replaced by ' + newSlug + ': ' + why.slice(0, 300) + ' -->' + NL + readFileSync(old, 'utf8'));
    rmSync(old);
    record([{ slug: oldSlug, action: 'replace', to: newSlug, why }], whoAmI(), 'replace-memory');
    const b = spawnSync(process.execPath, [join(BRAIN, 'tools', 'build-index.mjs')], { encoding: 'utf8', windowsHide: true });
    process.stdout.write('replaced ' + oldSlug + ' with ' + newSlug + ' (old copy in deleted/), index '
        + (b.status === 0 ? 'rebuilt' : 'FAILED to rebuild: run node tools/build-index.mjs') + NL);
    process.exit(b.status === 0 ? 0 : 1);
}
if (throughServer.length) {
    const dir = mkdtempSync(join(tmpdir(), 'replace-memory-'));
    try {
        for (const [s, text] of throughServer) {
            const f = join(dir, s + '.md');
            writeFileSync(f, text);
            const w = spawnSync(process.execPath, [join(BRAIN, 'tools', 'brain-client.mjs'), 'write', s, '--file', f], { encoding: 'utf8', windowsHide: true });
            if (w.status !== 0) {
                process.stderr.write((w.stderr || w.stdout || '') + NL + 'REPOINT FAILED for ' + s + ': nothing was deleted. Fix the cause and rerun.' + NL);
                process.exit(1);
            }
        }
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
const r = spawnSync(process.execPath, [join(BRAIN, 'tools', 'brain-client.mjs'), 'delete', oldSlug,
    '--why', 'replaced by ' + newSlug + ': ' + why], { encoding: 'utf8', windowsHide: true });
process.stdout.write(r.stdout || '');
if (r.status !== 0) {
    process.stderr.write((r.stderr || '') + NL + 'DELETE FAILED, the links above were already repointed; '
        + 'fix the cause and rerun, or revert them with git.' + NL);
    process.exit(1);
}
record([{ slug: oldSlug, action: 'replace', to: newSlug, why }], whoAmI(), 'replace-memory');
process.stdout.write('replaced ' + oldSlug + ' with ' + newSlug + (SERVER_ONLY ? '; the brain server commits it.' : '. Now run node tools/save-brain.mjs') + NL);
