#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NL = String.fromCharCode(10);
const LONG_DASHES = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)];
const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
const SAME = 0.75, RELATED = 0.55;
const KINDS = ['user', 'contact', 'project', 'feedback', 'reference'];
const problems = [], notes = [];
let text = '', desc = '', slug = '';
if (flag('--file')) {
    const p = flag('--file');
    if (!existsSync(p)) {
        process.stderr.write('no such file: ' + p + NL);
        process.exit(2);
    }
    text = readFileSync(p, 'utf8').split('\r').join('');
    slug = p.split(/[\\/]/).pop().replace(/\.md$/, '');
    const end = text.startsWith('---') ? text.indexOf(NL + '---', 3) : -1;
    const fm = end > 0 ? text.slice(3, end) : '';
    if (!fm)
        problems.push('no front matter (--- name, description, type, metadata ---)');
    const get = (k) => ((fm.match(new RegExp('^\\s*' + k + ':\\s*(.*)$', 'm')) || [])[1] || '').trim().replace(/^["']|["']$/g, '');
    desc = get('description');
    const type = get('type');
    if (!get('name'))
        problems.push('missing name');
    if (!desc)
        problems.push('missing description');
    if (!type)
        problems.push('missing type');
    else if (!KINDS.includes(type))
        problems.push('type "' + type + '" is not one of ' + KINDS.join(', '));
    else if (!slug.startsWith(type + '_'))
        problems.push('file name must start with "' + type + '_" to match its type');
    const body = end > 0 ? text.slice(end + 4).trim() : text;
    if (body.length < 80)
        problems.push('body too thin: say the fact, its scope (which system, company, period), why, and how it was verified');
    for (const m of text.matchAll(/\[\[([a-z0-9_\-]+)\]\]/g)) {
        if (!existsSync(join(BRAIN, 'memory', m[1] + '.md')))
            problems.push('broken link [[' + m[1] + ']]');
    }
    if (!/\[\[[a-z0-9_\-]+\]\]/.test(body))
        notes.push('no links yet: connect it to the memories it depends on or changes (see RELATED below)');
}
else if (flag('--desc')) {
    desc = flag('--desc');
}
else {
    process.stderr.write('usage: node tools/neuron-check.mjs --file draft.md | --desc "text" [--ack-overlap]' + NL);
    process.exit(2);
}
if (desc) {
    if (desc.length < 60)
        problems.push('description too short: write it in the words the person would type, what it is and when to read it');
    if (LONG_DASHES.some((d) => desc.includes(d)))
        problems.push('description contains an em or en dash');
}
let near = [];
try {
    let local = null;
    const vec = async (text) => {
        if (!local) {
            try {
                return (await (await fetch('http://127.0.0.1:8477/embed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })).json()).vector;
            }
            catch {
                const { pipeline, env } = await import('@xenova/transformers');
                env.allowLocalModels = false;
                local = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
            }
        }
        return Array.from((await local(text, { pooling: 'mean', normalize: true })).data);
    };
    const vector = await vec(slug ? slug.replace(/_/g, ' ') + '. ' + desc : desc);
    const kw = JSON.parse(readFileSync(join(BRAIN, 'index', 'keywords.json'), 'utf8'));
    const cacheFile = join(tmpdir(), 'havok-neuron-check-descriptions.json');
    let cache = {};
    try {
        cache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    }
    catch { }
    const emb = { slugs: Object.keys(kw.descriptions).sort(), vectors: [] };
    let fresh = 0;
    for (const s of emb.slugs) {
        const text = s.replace(/_/g, ' ') + '. ' + kw.descriptions[s];
        if (!cache[s] || cache[s].t !== text) {
            cache[s] = { t: text, v: await vec(text) };
            fresh++;
        }
        emb.vectors.push(cache[s].v);
    }
    if (fresh)
        writeFileSync(cacheFile, JSON.stringify(cache));
    near = emb.slugs.map((s, i) => {
        const v = emb.vectors[i];
        let d = 0;
        for (let k = 0; k < v.length; k++)
            d += vector[k] * v[k];
        return [s, d];
    }).filter(([s]) => s !== slug).sort((a, b) => b[1] - a[1]).slice(0, 8);
}
catch (e) {
    notes.push('could not compare with the brain (no embed service and no local model, run npm install): ' + e.message);
}
const same = near.filter(([, s]) => s >= SAME);
const related = near.filter(([, s]) => s >= RELATED && s < SAME);
if (same.length && !argv.includes('--ack-overlap')) {
    problems.push('ALREADY IN THE BRAIN, update or replace instead of adding: '
        + same.map(([s, v]) => s + ' (' + v.toFixed(2) + ')').join(', '));
}
const out = [problems.length ? 'NOT READY' : 'READY'];
for (const p of problems)
    out.push('  fix: ' + p);
for (const n of notes)
    out.push('  note: ' + n);
if (related.length)
    out.push('  related, link with [[...]] (>= ' + RELATED + '): ' + related.map(([s, v]) => s + ' ' + v.toFixed(2)).join(', '));
if (!same.length && !related.length && near.length)
    out.push('  new area of the map; nearest: ' + near.slice(0, 3).map(([s, v]) => s + ' ' + v.toFixed(2)).join(', '));
process.stdout.write(out.join(NL) + NL);
process.exit(problems.length ? 1 : 0);
