#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isPublicInstall } from './public-install.mjs';
export const STATE_FILE = '.kit-state.json';
export const WAIT_DIR = 'kit-updates';
const SELF = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOM = String.fromCharCode(0xFEFF);
const BOOKKEEPING = /^\s*(asserted|updated|kit_version|kit_hash):/;
const isoToday = () => new Date().toISOString().slice(0, 10);
const mdFiles = (dir) => { try {
    return readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
}
catch {
    return [];
} };
const readJson = (p, fallback) => { try {
    return JSON.parse(readFileSync(p, 'utf8'));
}
catch {
    return fallback;
} };
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
function lines(text) {
    let t = String(text);
    if (t.startsWith(BOM))
        t = t.slice(1);
    return t.replace(/\r\n?/g, '\n').split('\n');
}
function frontEnd(ls) { return ls[0] === '---' ? ls.indexOf('---', 1) : -1; }
export function canonical(text) {
    const ls = lines(text).map((l) => l.replace(/[ \t]+$/, ''));
    const end = frontEnd(ls);
    const kept = end > 0 ? ['---', ...ls.slice(1, end).filter((l) => !BOOKKEEPING.test(l)), ...ls.slice(end)] : ls;
    return kept.join('\n').replace(/\n+$/, '') + '\n';
}
export function kitHash(text) {
    return createHash('sha256').update(canonical(text), 'utf8').digest('hex').slice(0, 16);
}
function fieldValue(text, key) {
    const ls = lines(text);
    const end = frontEnd(ls);
    for (const l of end > 0 ? ls.slice(1, end) : []) {
        const m = l.match(/^\s*([A-Za-z_]+):\s*(.*?)\s*$/);
        if (m && m[1] === key)
            return m[2];
    }
    return null;
}
export function readKitFields(text) {
    const out = {};
    const v = fieldValue(text, 'kit_version');
    const h = fieldValue(text, 'kit_hash');
    if (v !== null && v !== '')
        out.kit_version = Number(v);
    if (h)
        out.kit_hash = h;
    return out;
}
export function withFields(text, fields) {
    const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
    const ls = lines(text);
    let end = frontEnd(ls);
    if (end < 0)
        return text;
    for (const [key, value] of Object.entries(fields)) {
        const at = ls.findIndex((l, i) => i > 0 && i < end && new RegExp('^\\s*' + key + ':').test(l));
        if (at > 0) {
            ls[at] = ls[at].match(/^\s*/)[0] + key + ': ' + value;
            continue;
        }
        const meta = ls.findIndex((l, i) => i > 0 && i < end && /^metadata:\s*$/.test(l));
        let insert = end;
        let indent = '';
        if (meta > 0) {
            insert = meta + 1;
            while (insert < end && /^\s+\S/.test(ls[insert]))
                insert += 1;
            indent = '  ';
        }
        ls.splice(insert, 0, indent + key + ': ' + value);
        end += 1;
    }
    return ls.join(eol);
}
export function stampKit(kitDir, { today = isoToday(), check = false } = {}) {
    const memDir = join(kitDir, 'memory');
    const histPath = join(kitDir, 'history.json');
    const history = readJson(histPath, {});
    let historyChanged = false;
    const changed = [];
    const stale = [];
    for (const name of mdFiles(memDir)) {
        const path = join(memDir, name);
        const text = readFileSync(path, 'utf8');
        const f = readKitFields(text);
        const hash = kitHash(text);
        const versionOk = Number.isInteger(f.kit_version) && f.kit_version >= 1;
        if (f.kit_hash === hash && versionOk)
            continue;
        stale.push(name);
        if (check)
            continue;
        let version = versionOk ? f.kit_version : 1;
        const fields = {};
        if (f.kit_hash && f.kit_hash !== hash) {
            version += 1;
            const list = Array.isArray(history[name]) ? history[name] : (history[name] = []);
            if (!list.includes(f.kit_hash)) {
                list.push(f.kit_hash);
                historyChanged = true;
            }
            fields.updated = today;
        }
        fields.kit_version = String(version);
        fields.kit_hash = hash;
        writeFileSync(path, withFields(text, fields), 'utf8');
        changed.push({ name, version });
    }
    if (historyChanged)
        writeJson(histPath, history);
    return { changed, stale };
}
function remember(state, name) { if (!state.seen.includes(name))
    state.seen.push(name); }
const beforeVersions = (history) => (Array.isArray(history._before_versions) ? history._before_versions : []);
function writeWaitingReadme(brain) {
    const dir = join(brain, WAIT_DIR);
    const readme = join(dir, 'README.md');
    const waiting = mdFiles(dir).filter((n) => n !== 'README.md');
    if (!waiting.length) {
        if (existsSync(readme))
            unlinkSync(readme);
        return;
    }
    writeFileSync(readme, [
        '# Kit updates waiting',
        '',
        'Each file here is a newer version of a kit method that you changed in memory/. Yours was not touched.',
        'Compare the two. To take the new one (yours is kept in kit-updates/replaced/):',
        '',
        '    node tools/kit.mjs accept <name>',
        '',
        'To keep yours, delete the file here: that version will not be offered again.',
        '',
        ...waiting.map((n) => '- ' + n + ' (yours: memory/' + n + ')'),
        '',
    ].join('\n'), 'utf8');
}
export function refreshKit({ brain = SELF, today = isoToday(), init = false, force = false } = {}) {
    const kitMem = join(brain, 'kit', 'memory');
    const memDir = join(brain, 'memory');
    const waitDir = join(brain, WAIT_DIR);
    const history = readJson(join(brain, 'kit', 'history.json'), {});
    const statePath = join(brain, STATE_FILE);
    const had = readJson(statePath, null);
    const state = { seen: [], offered: {}, ...(had || {}) };
    if (!Array.isArray(state.seen))
        state.seen = [];
    if (!state.offered || typeof state.offered !== 'object')
        state.offered = {};
    const before = beforeVersions(history);
    if (!had && !init && before.some((n) => existsSync(join(memDir, n))))
        for (const n of before)
            remember(state, n);
    const r = { added: [], refreshed: [], waiting: [], kept: [], current: [], skipped: [] };
    mkdirSync(memDir, { recursive: true });
    for (const name of mdFiles(kitMem)) {
        const kitText = readFileSync(join(kitMem, name), 'utf8');
        const K = kitHash(kitText);
        const dest = join(memDir, name);
        if (!existsSync(dest)) {
            if (state.seen.includes(name) && !force && !init) {
                r.skipped.push(name);
                continue;
            }
            writeFileSync(dest, withFields(kitText, { asserted: today, updated: today }), 'utf8');
            remember(state, name);
            r.added.push(name);
            continue;
        }
        remember(state, name);
        const mine = readFileSync(dest, 'utf8');
        const C = kitHash(mine);
        if (C === K) {
            r.current.push(name);
            continue;
        }
        const own = readKitFields(mine).kit_hash;
        const known = new Set([...(Array.isArray(history[name]) ? history[name] : []), ...(own ? [own] : [])]);
        if (known.has(C)) {
            const asserted = fieldValue(mine, 'asserted');
            writeFileSync(dest, withFields(kitText, { ...(asserted ? { asserted } : {}), updated: today }), 'utf8');
            r.refreshed.push(name);
            continue;
        }
        if (state.offered[name] === K) {
            r.kept.push(name);
            continue;
        }
        mkdirSync(waitDir, { recursive: true });
        writeFileSync(join(waitDir, name), kitText, 'utf8');
        state.offered[name] = K;
        r.waiting.push(name);
    }
    if (existsSync(waitDir))
        writeWaitingReadme(brain);
    writeJson(statePath, state);
    return r;
}
export function acceptKit({ brain = SELF, name, today = isoToday() }) {
    const file = String(name || '').replace(/\.md$/, '') + '.md';
    const kitPath = join(brain, 'kit', 'memory', file);
    if (!existsSync(kitPath))
        throw new Error('no kit method named ' + file);
    const kitText = readFileSync(kitPath, 'utf8');
    const dest = join(brain, 'memory', file);
    let backup = null;
    if (existsSync(dest)) {
        const mine = readFileSync(dest, 'utf8');
        const dir = join(brain, WAIT_DIR, 'replaced');
        mkdirSync(dir, { recursive: true });
        const stem = file.replace(/\.md$/, '') + '.' + today;
        backup = join(dir, stem + '.md');
        for (let n = 2; existsSync(backup); n += 1)
            backup = join(dir, stem + '.' + n + '.md');
        writeFileSync(backup, mine, 'utf8');
        const asserted = fieldValue(mine, 'asserted');
        writeFileSync(dest, withFields(kitText, { ...(asserted ? { asserted } : {}), updated: today }), 'utf8');
    }
    else {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, withFields(kitText, { asserted: today, updated: today }), 'utf8');
    }
    const waiting = join(brain, WAIT_DIR, file);
    if (existsSync(waiting))
        unlinkSync(waiting);
    const statePath = join(brain, STATE_FILE);
    const state = { seen: [], offered: {}, ...readJson(statePath, {}) };
    remember(state, file);
    state.offered[file] = kitHash(kitText);
    writeJson(statePath, state);
    if (existsSync(join(brain, WAIT_DIR)))
        writeWaitingReadme(brain);
    return { file, backup };
}
export function kitStatus({ brain = SELF } = {}) {
    const history = readJson(join(brain, 'kit', 'history.json'), {});
    const state = readJson(join(brain, STATE_FILE), { seen: [], offered: {} });
    return mdFiles(join(brain, 'kit', 'memory')).map((name) => {
        const kitText = readFileSync(join(brain, 'kit', 'memory', name), 'utf8');
        const K = kitHash(kitText);
        const version = readKitFields(kitText).kit_version || null;
        const waiting = existsSync(join(brain, WAIT_DIR, name));
        const dest = join(brain, 'memory', name);
        if (!existsSync(dest))
            return { name, version, state: (state.seen || []).includes(name) || beforeVersions(history).includes(name) ? 'deleted' : 'new', waiting };
        const mine = readFileSync(dest, 'utf8');
        const C = kitHash(mine);
        const own = readKitFields(mine);
        if (C === K)
            return { name, version, state: 'current', waiting };
        const known = new Set([...(Array.isArray(history[name]) ? history[name] : []), ...(own.kit_hash ? [own.kit_hash] : [])]);
        return { name, version, yours: own.kit_version || null, state: known.has(C) ? 'older' : 'changed', waiting };
    });
}
function isInfiniteContext(brain) {
    return isPublicInstall(brain);
}
function rebuildIndex(brain) {
    try {
        execFileSync(process.execPath, [join(brain, 'tools', 'build-index.mjs')], { cwd: brain, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000, windowsHide: true });
        return true;
    }
    catch {
        return false;
    }
}
export function summary(r) {
    const parts = [];
    if (r.added.length)
        parts.push(r.added.length + ' new');
    if (r.refreshed.length)
        parts.push(r.refreshed.length + ' refreshed');
    if (r.waiting.length)
        parts.push(r.waiting.length + ' waiting in ' + WAIT_DIR + '/ because you changed yours');
    return parts.length ? 'kit methods: ' + parts.join(', ') : '';
}
function main(argv) {
    const say = (s) => process.stdout.write(s + '\n');
    const [cmd, arg] = argv.filter((a) => !a.startsWith('--'));
    const flag = (f) => argv.includes(f);
    if (cmd === 'stamp') {
        const r = stampKit(join(SELF, 'kit'), { check: flag('--check') });
        if (flag('--check')) {
            if (r.stale.length) {
                say('kit methods edited without a new stamp (run: node tools/kit.mjs stamp): ' + r.stale.join(', '));
                process.exit(1);
            }
            say('every kit method carries its current version and hash');
            return;
        }
        for (const c of r.changed)
            say('  stamped ' + c.name + ' version ' + c.version);
        say(r.changed.length ? 'stamped ' + r.changed.length + ' kit method(s)' : 'nothing to stamp, every kit method is current');
        return;
    }
    if (cmd === 'refresh') {
        if (!isInfiniteContext(SELF) && !flag('--anyway')) {
            say('This brain is not a Neuraxis install (package.json does not name neuraxis), so its kit is');
            say('authored here and its memory copies differ on purpose. Refreshing would offer every method as changed.');
            say('Run with --anyway to do it regardless.');
            process.exit(2);
        }
        const r = refreshKit({ brain: SELF, force: flag('--force') });
        const touched = r.added.length + r.refreshed.length;
        if (touched && !flag('--no-index'))
            r.indexed = rebuildIndex(SELF);
        if (flag('--json')) {
            say(JSON.stringify(r));
            return;
        }
        for (const n of r.added)
            say('  added      ' + n);
        for (const n of r.refreshed)
            say('  refreshed  ' + n);
        for (const n of r.waiting)
            say('  waiting    ' + n + '  (you changed yours; the new version is in ' + WAIT_DIR + '/' + n + ')');
        say(summary(r) || 'kit methods: all current');
        if (r.indexed === false)
            say('build-index FAILED: run node tools/build-index.mjs, nothing new is findable until it succeeds');
        return;
    }
    if (cmd === 'accept') {
        if (!arg) {
            say('usage: node tools/kit.mjs accept <name>');
            process.exit(2);
        }
        const r = acceptKit({ brain: SELF, name: arg });
        rebuildIndex(SELF);
        say('took the new ' + r.file + (r.backup ? '; yours is kept at ' + r.backup : ''));
        return;
    }
    if (cmd === 'status' || !cmd) {
        for (const s of kitStatus({ brain: SELF })) {
            const label = { current: 'current', older: 'older version, unchanged (refresh updates it)', changed: 'changed by you', deleted: 'deleted by you', new: 'not installed yet' }[s.state];
            say('  ' + s.name.padEnd(62) + ' kit ' + String(s.version || '?').padEnd(4) + label + (s.waiting ? ', new version waiting in ' + WAIT_DIR + '/' : ''));
        }
        return;
    }
    say('usage: node tools/kit.mjs status | refresh [--json] [--force] | accept <name> | stamp [--check]');
    process.exit(2);
}
const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === here.toLowerCase() : invoked === here))
    main(process.argv.slice(2));
