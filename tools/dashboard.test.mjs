import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { createMapServer, readConfig, KEPT_KEYS } from './dashboard.mjs';
import { writeSample } from './map-sample.mjs';
import { runUpdate } from './update.mjs';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temps = [];
const temp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); temps.push(d); return d; };
const servers = [];
after(() => {
    for (const s of servers) {
        try {
            s.closeAllConnections();
            s.close();
        }
        catch { }
    }
    for (const d of temps) {
        try {
            rmSync(d, { recursive: true, force: true });
        }
        catch { }
    }
});
function web(config) {
    const d = temp('map-web-');
    copyFileSync(join(REPO, 'dashboard', 'index.html'), join(d, 'index.html'));
    copyFileSync(join(REPO, 'dashboard', 'instrument-serif.woff2'), join(d, 'instrument-serif.woff2'));
    if (config !== undefined)
        writeFileSync(join(d, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
    return d;
}
async function start({ keywordOnly = false, config } = {}) {
    const brain = temp('map-brain-');
    writeSample(brain, { keywordOnly });
    const server = createMapServer({ brain, web: web(config) });
    servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port;
    return { brain, base };
}
const get = async (base, p) => { const r = await fetch(base + p); return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }; };
const getJson = async (base, p) => { const r = await get(base, p); assert.equal(r.status, 200, p + ' answered ' + r.status); return JSON.parse(r.text); };
test('the page is served with the settings that still apply, and the settings file itself is not', async () => {
    const { base } = await start({ config: {
            name: 'Orbit', tagline: 'second brain', colors: { void: '#101820', accent: '#F6A21E', ink: 'red;}body{x' },
            regions: [{ key: 'PEOPLE', types: ['person'], color: '#E27D60' }], showMachines: false,
            links: [{ label: 'My notes', url: 'https://example.com', note: 'notes' }, { label: 'bad', url: 'javascript:alert(1)' }],
        } });
    const page = await get(base, '/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    assert.match(page.text, /window\.MAP_CONFIG=\{"name":"Orbit","tagline":"second brain"\}/);
    assert.match(page.text, /--void:#101820/);
    assert.match(page.text, /--gold:#F6A21E/);
    assert.doesNotMatch(page.text, /red;\}body/, 'a colour that is not a colour never reaches the CSS');
    assert.doesNotMatch(page.text, /PEOPLE/, 'the old bands are not used');
    assert.match(page.text, /id="topicNote" hidden/);
    const links = await getJson(base, '/api/links');
    assert.deepEqual(links.links, [{ label: 'My notes', url: 'https://example.com', note: 'notes' }]);
    assert.match((await get(base, '/icon.svg')).text, /#F6A21E/);
    assert.equal(JSON.parse((await get(base, '/manifest.webmanifest')).text).name, 'Orbit');
    assert.equal((await get(base, '/instrument-serif.woff2')).status, 200);
    assert.equal((await get(base, '/config.json')).status, 404, 'the settings file is not served');
    assert.equal((await get(base, '/..%2Fpackage.json')).status, 404, 'nothing outside dashboard/');
    assert.equal((await get(base, '/api/services')).status, 404, 'no machine panel routes in the engine');
});
test('/api/memory answers every memory and every link between two memories', async () => {
    const { base } = await start();
    const g = await getJson(base, '/api/memory');
    const mems = g.entities.filter((e) => e.entityType !== 'core');
    assert.equal(mems.length, 20);
    assert.equal(g.entities.filter((e) => e.entityType === 'core').length, 1);
    const me = mems.find((e) => e.name === 'About me');
    assert.equal(me.entityType, 'person');
    assert.equal(me.description, 'who I am, what I do, how I like answers written');
    assert.ok(me.observations.length >= 2);
    assert.ok(mems.every((e) => ['person', 'project', 'feedback_rule', 'reference'].includes(e.entityType)));
    assert.ok(g.relations.length > 10);
    assert.ok(g.relations.every((r) => r.relationType === 'relates_to' && mems.some((e) => e.name === r.from) && mems.some((e) => e.name === r.to)));
    assert.equal(g.bySlug.contact_alex_rivera, 'Alex Rivera');
    assert.match(g.signature, /^brain:20:\d+$/);
    assert.equal(g.counts.memories, 20);
    assert.ok(g.counts.links > 0 && g.counts.facts > 20);
});
test('/api/topics groups the memories by topic, keyed by display name', async () => {
    const { base } = await start();
    const t = await getJson(base, '/api/topics');
    assert.equal(t.topics.length, 4);
    assert.deepEqual(Object.keys(t.topics[0]).sort(), ['id', 'name', 'size']);
    assert.equal(t.byName['About me'], 0);
    assert.equal(t.byName['Tax calendar'], 3);
    assert.equal(Object.keys(t.byName).length, 20);
    assert.equal(t.note, undefined, 'no note when topics are there');
});
test('a keyword-only install gets the plain view and one line on how to get topics', async () => {
    const { base } = await start({ keywordOnly: true });
    const t = await getJson(base, '/api/topics');
    assert.deepEqual(t.topics, []);
    assert.deepEqual(t.byName, {});
    assert.match(t.note, /meaning model/);
    assert.match(t.note, /Microsoft Visual C\+\+ Redistributable/);
    assert.match(t.note, /node tools\/build-index\.mjs/);
    assert.equal(t.note.split('\n').length, 1, 'one line');
    assert.equal((await getJson(base, '/api/memory')).counts.memories, 20, 'the memories are all still there');
    const page = readFileSync(join(REPO, 'dashboard', 'index.html'), 'utf8');
    assert.match(page, /paintTopicNote\(topics\.length \? "" : String\(data\.note \|\| ""\)\)/);
    assert.match(page, /if \(!S\.topics \|\| S\.topics\.order\.length <= 1\) \{ S\.group = "kind"; ORDER = KIND_ORDER; \}/);
});
test('an empty topics.json is the same honest view as none at all', async () => {
    const { brain, base } = await start({ keywordOnly: true });
    mkdirSync(join(brain, 'index'), { recursive: true });
    writeFileSync(join(brain, 'index', 'topics.json'), JSON.stringify({ topics: [], of: {} }));
    writeFileSync(join(brain, 'index', 'embeddings.json'), '{}');
    const t = await getJson(base, '/api/topics');
    assert.deepEqual(t.topics, []);
    assert.match(t.note, /run node tools\/build-index\.mjs/);
});
test('/api/pulse names the memories a turn recalled', async () => {
    const { brain, base } = await start();
    writeFileSync(join(brain, '.recall-pulse.jsonl'), JSON.stringify({ at: 1000, host: 'pc', slugs: ['user_profile', 'reference_tax_calendar'] }) + '\nnot json\n');
    const p = await getJson(base, '/api/pulse?since=0');
    assert.deepEqual(p.events, [{ at: 1000, host: 'pc', hits: [{ name: 'About me' }, { name: 'Tax calendar' }] }]);
    assert.deepEqual((await getJson(base, '/api/pulse?since=1000')).events, []);
});
function events(base, act, want) {
    return new Promise((resolveP, reject) => {
        const seen = [];
        const timer = setTimeout(() => { req.destroy(); reject(new Error('events seen: ' + seen.join(', '))); }, 8000);
        const req = http.get(base + '/api/events', (res) => {
            assert.match(res.headers['content-type'], /text\/event-stream/);
            let buf = '';
            res.on('data', (c) => {
                buf += c;
                for (const m of buf.matchAll(/event: (\w+)/g))
                    if (!seen.includes(m[1])) {
                        seen.push(m[1]);
                        if (m[1] === 'hello')
                            setTimeout(act, 150);
                    }
                if (want.every((w) => seen.includes(w))) {
                    clearTimeout(timer);
                    req.destroy();
                    resolveP(seen);
                }
            });
        });
        req.on('error', () => { });
    });
}
test('a change in memory/ or index/ is pushed to the page as an event', async () => {
    const { brain, base } = await start();
    const seen = await events(base, () => {
        writeFileSync(join(brain, 'memory', 'reference_new_thing.md'), '---\nname: New thing\ndescription: a new thing\ntype: reference\n---\n\nNew.\n');
        writeFileSync(join(brain, 'index', 'topics.json'), JSON.stringify({ topics: [{ id: 0, name: 'All', size: 21 }], of: {} }));
    }, ['hello', 'graph', 'topics']);
    assert.deepEqual(seen.slice(0, 1), ['hello']);
    assert.equal((await getJson(base, '/api/memory')).counts.memories, 21, 'the new memory is in the next read');
});
test('an install that had the old dashboard updates to the map and keeps its settings', () => {
    const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
    const show = (rel) => execFileSync('git', ['show', 'HEAD:' + rel], { cwd: REPO, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 26 });
    const write = (dir, files) => { for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
    } };
    let oldPage = '';
    try {
        oldPage = show('dashboard/index.html');
    }
    catch { }
    if (!/IDENTITY/.test(oldPage) || /MAP_CONFIG/.test(oldPage))
        oldPage = '<!doctype html><title>old</title><script>const REGIONS=["IDENTITY","PROJECTS","RULES","REFERENCE"]</script>\n';
    const releaseConfig = readFileSync(join(REPO, 'dashboard', 'config.json'), 'utf8');
    const base = (version) => ({
        'package.json': JSON.stringify({ name: 'neuraxis', version, dependencies: {} }, null, 2) + '\n',
        '.gitattributes': '* text=auto eol=lf\n',
        '.gitignore': 'index/\n.update-state.json\n.update.lock\n*.log\n',
        'memory/.gitkeep': '',
        'tools/verify.mjs': "console.log('BRAIN VERIFY PASSED');\n",
        'dashboard/config.json': releaseConfig,
    });
    const up = temp('map-up-');
    git(up, 'init', '-q');
    write(up, { ...base('0.1.0'), 'dashboard/index.html': oldPage });
    git(up, 'add', '-A');
    git(up, 'commit', '-q', '-m', 'old dashboard');
    git(up, 'tag', 'v0.1.0');
    const home = temp('map-install-');
    const install = join(home, 'brain');
    git(home, 'clone', '-q', up, install);
    const mine = JSON.parse(releaseConfig);
    Object.assign(mine, { name: 'Orbit', tagline: 'second brain', colors: { ...mine.colors, accent: '#F6A21E' },
        links: [{ label: 'My notes', url: 'https://example.com' }], regions: [{ key: 'PEOPLE', types: ['person'], color: '#E27D60' }], showMachines: false });
    const mineText = JSON.stringify(mine, null, 2) + '\n';
    writeFileSync(join(install, 'dashboard', 'config.json'), mineText);
    write(up, { ...base('0.2.0'), 'dashboard/index.html': readFileSync(join(REPO, 'dashboard', 'index.html'), 'utf8'), 'tools/dashboard.mjs': readFileSync(join(REPO, 'tools', 'dashboard.mjs'), 'utf8') });
    git(up, 'add', '-A');
    git(up, 'commit', '-q', '-m', 'the map');
    git(up, 'tag', 'v0.2.0');
    const e = { ...process.env };
    for (const k of Object.keys(e))
        if (/^INFINITE_CONTEXT_|^NEURAXIS_|^HAVOK_BRAIN$/.test(k))
            delete e[k];
    const r = runUpdate({ brain: install, url: up, env: e });
    assert.equal(r.status, 'updated', JSON.stringify(r));
    assert.equal(r.to, '0.2.0');
    assert.equal(readFileSync(join(install, 'dashboard', 'config.json'), 'utf8'), mineText, 'the settings file is byte for byte theirs');
    assert.match(readFileSync(join(install, 'dashboard', 'index.html'), 'utf8'), /MAP_CONFIG/, 'the new map is in place');
    assert.ok(existsSync(join(install, 'tools', 'dashboard.mjs')), 'the same command starts it');
    const cfg = readConfig(join(install, 'dashboard'));
    assert.equal(cfg.name, 'Orbit');
    assert.equal(cfg.tagline, 'second brain');
    assert.equal(cfg.colors.accent, '#F6A21E');
    assert.deepEqual(cfg.links, [{ label: 'My notes', url: 'https://example.com', note: '' }]);
    assert.deepEqual(Object.keys(cfg).sort(), [...KEPT_KEYS].sort());
});
