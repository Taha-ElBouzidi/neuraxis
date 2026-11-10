import { readFileSync, writeFileSync, renameSync, statSync, existsSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const AGENTS_FOLDER = 'Agents';
export const ARCHIVED_FOLDER = 'Archived';
export const ROBOT = '\u{1F916}';
export const CABINET = '\u{1F5C4}';
const NAMESPACE = 'havok-agent';
export function menuPath(home = homedir()) {
    const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const pk = join(local, 'Packages');
    try {
        for (const d of readdirSync(pk)) {
            if (!d.startsWith('Microsoft.WindowsTerminal_'))
                continue;
            const f = join(pk, d, 'LocalState', 'settings.json');
            if (existsSync(f))
                return f;
        }
    }
    catch { }
    const f = join(local, 'Microsoft', 'Windows Terminal', 'settings.json');
    return existsSync(f) ? f : '';
}
export const slugOf = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export function ownedGuid(machine, slug) {
    const h = createHash('sha1').update(`${NAMESPACE}:${String(machine).toUpperCase()}:${slug}`).digest('hex');
    return `{${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}}`;
}
export function colorOf(name) {
    const h = createHash('sha1').update(String(name)).digest();
    const c = (i) => (40 + (h[i] % 60)).toString(16).padStart(2, '0');
    return `#${c(0)}${c(1)}${c(2)}`.toUpperCase();
}
export function readSettings(file) {
    const raw = readFileSync(file, 'utf8');
    const bom = raw.charCodeAt(0) === 0xfeff;
    return { s: JSON.parse(bom ? raw.slice(1) : raw), bom };
}
export const winPath = (p) => String(p || '').split('/').join('\\');
export const fill = (template, v) => String(template).replace(/\{(name|session|spec|slug)\}/g, (_, k) => String(v[k] ?? ''));
function folders(s) {
    if (!Array.isArray(s.newTabMenu))
        s.newTabMenu = [{ type: 'remainingProfiles' }];
    const menu = s.newTabMenu;
    let agents = menu.find((e) => e && e.type === 'folder' && e.name === AGENTS_FOLDER);
    if (!agents) {
        agents = { type: 'folder', name: AGENTS_FOLDER, icon: ROBOT, inline: 'never', allowEmpty: false, entries: [] };
        menu.unshift(agents);
    }
    if (!Array.isArray(agents.entries))
        agents.entries = [];
    return { menu, agents };
}
function archivedFolder(s, create) {
    const { menu, agents } = folders(s);
    let arch = menu.find((e) => e && e.type === 'folder' && e.name === ARCHIVED_FOLDER);
    if (!arch && create) {
        arch = { type: 'folder', name: ARCHIVED_FOLDER, icon: CABINET, inline: 'never', allowEmpty: false, entries: [] };
        menu.splice(menu.indexOf(agents) + 1, 0, arch);
    }
    if (arch && !Array.isArray(arch.entries))
        arch.entries = [];
    return arch;
}
const entryOf = (guid) => ({ type: 'profile', profile: guid, icon: null });
const sameGuid = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const drop = (folder, guid) => { if (folder)
    folder.entries = folder.entries.filter((e) => !(e && e.type === 'profile' && sameGuid(e.profile, guid))); };
const holds = (folder, guid) => !!folder && folder.entries.some((e) => e && e.type === 'profile' && sameGuid(e.profile, guid));
export const inArchived = (s, guid) => holds(archivedFolder(s, false), guid);
export const inAgents = (s, guid) => holds(folders(s).agents, guid);
export function findProfile(s, { machine, slug, name }) {
    const list = s?.profiles?.list || [];
    const g = machine && slug ? ownedGuid(machine, slug) : '';
    return list.find((p) => g && sameGuid(p.guid, g)) || list.find((p) => name && p.name === name) || null;
}
function ensureList(s) {
    if (!s.profiles || typeof s.profiles !== 'object')
        s.profiles = { list: [] };
    if (!Array.isArray(s.profiles.list))
        s.profiles.list = [];
    return s.profiles.list;
}
export function register(s, a) {
    const list = ensureList(s);
    const guid = ownedGuid(a.machine, a.slug);
    const hand = list.find((p) => p.name === a.name && !sameGuid(p.guid, guid));
    if (hand)
        return { changed: false, what: 'hand-made', guid: hand.guid };
    if (inArchived(s, guid))
        return { changed: false, what: 'archived', guid };
    const want = { guid, name: a.name, tabTitle: a.name, suppressApplicationTitle: true, tabColor: a.color || colorOf(a.name), icon: a.icon || ROBOT, hidden: false, startingDirectory: a.startingDirectory, commandline: a.commandline };
    let p = list.find((x) => sameGuid(x.guid, guid));
    let what = 'unchanged';
    if (!p) {
        p = { ...want };
        list.push(p);
        what = 'created';
    }
    else {
        for (const k of ['name', 'tabTitle', 'commandline', 'startingDirectory'])
            if (want[k] !== undefined && p[k] !== want[k]) {
                p[k] = want[k];
                what = 'updated';
            }
        for (const k of ['icon', 'tabColor', 'suppressApplicationTitle'])
            if (p[k] === undefined) {
                p[k] = want[k];
                what = 'updated';
            }
        if (p.hidden) {
            p.hidden = false;
            what = 'updated';
        }
    }
    const { agents } = folders(s);
    if (!holds(agents, guid)) {
        agents.entries.push(entryOf(guid));
        if (what === 'unchanged')
            what = 'added to Agents';
    }
    return { changed: what !== 'unchanged', what, guid };
}
export function ensureProfile(s, a) {
    const list = ensureList(s);
    const guid = ownedGuid(a.machine, a.slug);
    if (list.some((x) => sameGuid(x.guid, guid)))
        return { changed: false, guid };
    list.push({ guid, name: a.name, tabTitle: a.name, suppressApplicationTitle: true, tabColor: a.color || colorOf(a.name), icon: a.icon || ROBOT, hidden: false, startingDirectory: a.startingDirectory, commandline: a.commandline });
    return { changed: true, guid };
}
export function move(s, guid, toArchived) {
    const { agents } = folders(s);
    const arch = archivedFolder(s, toArchived);
    if (!toArchived && !arch) {
        if (holds(agents, guid))
            return { changed: false };
        agents.entries.push(entryOf(guid));
        return { changed: true };
    }
    const from = toArchived ? agents : arch;
    const to = toArchived ? arch : agents;
    const had = holds(to, guid) && !holds(from, guid);
    drop(from, guid);
    if (!holds(to, guid))
        to.entries.push(entryOf(guid));
    return { changed: !had };
}
export function changeMenu(file, change, { backup = true } = {}) {
    if (!file || !existsSync(file))
        return { ok: false, why: 'no Windows Terminal settings.json on this machine' };
    for (let attempt = 0; attempt < 3; attempt++) {
        let at;
        try {
            at = statSync(file).mtimeMs;
        }
        catch (e) {
            return { ok: false, why: `settings.json could not be read: ${e.message}` };
        }
        let s;
        let bom = false;
        try {
            ({ s, bom } = readSettings(file));
        }
        catch (e) {
            return { ok: false, why: `settings.json does not parse (left alone): ${e.message}` };
        }
        const r = change(s);
        if (!r || !r.changed)
            return { ok: true, ...r, changed: false };
        const out = (bom ? '\uFEFF' : '') + JSON.stringify(s, null, 4) + '\n';
        const bak = file + '.bak-havok-agents';
        try {
            if (backup && !existsSync(bak))
                copyFileSync(file, bak);
        }
        catch (e) {
            return { ok: false, why: `the backup could not be written: ${e.message}` };
        }
        const tmp = `${file}.havok-${process.pid}.tmp`;
        writeFileSync(tmp, out);
        let now;
        try {
            now = statSync(file).mtimeMs;
        }
        catch {
            now = -1;
        }
        if (now !== at)
            continue;
        renameSync(tmp, file);
        return { ok: true, ...r, changed: true };
    }
    return { ok: false, why: 'settings.json kept changing under the writer (3 tries)' };
}
export function machineConfig(home = homedir()) {
    try {
        return JSON.parse(readFileSync(join(home, '.claude', 'havok-mod', 'machine.json'), 'utf8'));
    }
    catch {
        return {};
    }
}
export const machineName = () => String(process.env.COMPUTERNAME || process.env.HOSTNAME || '').toUpperCase();
export function writeSpec(launcher, a) {
    if (!launcher.specDir)
        return '';
    const file = join(launcher.specDir, `${a.name}.json`);
    let spec = {};
    try {
        spec = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch {
        spec = {};
    }
    const next = { ...spec, name: a.name, resume: a.session, cwd: a.cwd || spec.cwd || launcher.cwd || '', profile: a.name, env: { ...(spec.env || {}), HAVOK_MOD_AGENT: a.slug } };
    if (launcher.debugFile && !spec.debugFile)
        next.debugFile = fill(launcher.debugFile, a);
    if (JSON.stringify(next) !== JSON.stringify(spec)) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file + '.tmp', JSON.stringify(next) + '\n');
        renameSync(file + '.tmp', file);
    }
    return file;
}
export const archivedPath = (home = homedir()) => join(home, '.claude', 'havok-mod', 'archived.json');
export function archivedList(home = homedir()) {
    try {
        const j = JSON.parse(readFileSync(archivedPath(home), 'utf8'));
        return j && j.agents && typeof j.agents === 'object' ? j : { agents: {} };
    }
    catch {
        return { agents: {} };
    }
}
export function setArchived(home, slug, info) {
    const j = archivedList(home);
    if (info)
        j.agents[slug] = info;
    else
        delete j.agents[slug];
    mkdirSync(dirname(archivedPath(home)), { recursive: true });
    writeFileSync(archivedPath(home) + '.tmp', JSON.stringify(j, null, 1) + '\n');
    renameSync(archivedPath(home) + '.tmp', archivedPath(home));
}
export function launchFor(launcher, a) {
    if (!launcher || !launcher.command)
        return null;
    const spec = /\{spec\}/.test(launcher.command) ? writeSpec(launcher, a) : '';
    return { commandline: fill(launcher.command, { ...a, spec }), startingDirectory: a.cwd ? winPath(a.cwd) : launcher.startingDirectory, spec };
}
export function registerAgent({ home = homedir(), machine = machineName(), slug, name, session, cwd = '', icon, color, file = menuPath(home) }) {
    if (!slug || !name || !session)
        return { ok: false, why: 'slug, name and session are needed' };
    if (/^verify-/.test(slug))
        return { ok: true, changed: false, what: 'verify session, never registered' };
    if (archivedList(home).agents[slug])
        return { ok: true, changed: false, what: 'archived on this machine' };
    const launcher = machineConfig(home).launcher;
    if (!launcher || !launcher.command)
        return { ok: true, changed: false, what: 'no launcher in machine.json' };
    const a = { machine, slug, name, session, cwd, icon, color };
    let pre;
    try {
        pre = readSettings(file).s;
    }
    catch (e) {
        return { ok: false, why: `settings.json does not parse (left alone): ${e.message}` };
    }
    const hand = (pre?.profiles?.list || []).find((p) => p.name === name && !sameGuid(p.guid, ownedGuid(machine, slug)));
    if (hand)
        return { ok: true, changed: false, what: 'hand-made', guid: hand.guid };
    if (inArchived(pre, ownedGuid(machine, slug)))
        return { ok: true, changed: false, what: 'archived' };
    const l = launchFor(launcher, a);
    return changeMenu(file, (s) => register(s, { ...a, commandline: l.commandline, startingDirectory: l.startingDirectory }));
}
async function main() {
    const [cmd, who, ...rest] = process.argv.slice(2);
    const opt = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
    const file = menuPath();
    if (cmd === 'register') {
        console.log(JSON.stringify(registerAgent({ slug: who, name: opt('name'), session: opt('session'), cwd: opt('cwd') || '', icon: opt('icon'), color: opt('color'), file })));
        return;
    }
    if (cmd === 'list') {
        let s;
        try {
            s = readSettings(file).s;
        }
        catch (e) {
            console.log(JSON.stringify({ ok: false, why: e.message }));
            return;
        }
        const names = (folder) => (folder?.entries || []).filter((e) => e.type === 'profile').map((e) => s.profiles.list.find((p) => sameGuid(p.guid, e.profile))?.name || e.profile);
        console.log(JSON.stringify({ ok: true, agents: names(folders(s).agents), archived: names(archivedFolder(s, false)), archivedHere: Object.keys(archivedList().agents) }));
        return;
    }
    console.error('usage: node tools/agent-menu.mjs register <slug> --name <Name> --session <id> [--icon] [--color] | list   (archive and restore: tools/agent-archive.mjs)');
    process.exit(2);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
    main();
