#!/usr/bin/env node
// The map: your memories grouped by topic, live in the browser. A zero-dependency server for
// dashboard/index.html.
//
//   node tools/dashboard.mjs [--port 8492] [--host 127.0.0.1] [--brain <folder>] [--open]
//
// No framework, no build step, no npm install. It reads memory/ and index/topics.json directly and
// answers five routes for the page:
//   /api/memory   every memory as an entity, every [[wikilink]] between two memories as a relation
//   /api/topics   the topics of index/topics.json (built by tools/build-topics.mjs through build-index),
//                 keyed by display name; empty with a one-line note when the brain has none
//   /api/links    your own shortcuts, from "links" in dashboard/config.json
//   /api/pulse    which memories recent turns recalled, from .recall-pulse.jsonl (written by the recall hook)
//   /api/events   server-sent events: graph when memory/ changes, topics when index/topics.json changes,
//                 pulse when a recall is logged, links when dashboard/config.json changes. fs.watch, no timer
//                 that polls; the page fetches only the route that changed.
//
// Settings that still apply live in dashboard/config.json (your own file, not part of the engine):
// name, tagline, colors and links. The old band settings (regions, showMachines) are ignored: the map
// groups by topic, and by kind when there are no topics.

import { readFileSync, existsSync, readdirSync, statSync, createReadStream, watch } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join, extname, normalize, sep } from 'node:path';

const ENGINE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ENGINE, 'dashboard');
const NL = String.fromCharCode(10);
const say = (s) => process.stdout.write(s + NL);

export const DEFAULT_PORT = 8492;

// ---- settings --------------------------------------------------------------------------------
// The keys of the old dashboard's config.json that still mean something. regions and showMachines
// are dropped: the bands are replaced by topics, and machine nodes are not part of the engine's map.
export const KEPT_KEYS = ['name', 'tagline', 'colors', 'links'];
const DEFAULTS = { name: 'Your AI', tagline: 'the brain', colors: {}, links: [] };
// config key -> CSS variable of the page
const COLOR_VARS = {
  void: '--void', ink: '--ink', ink2: '--ink2', ink3: '--ink3', accent: '--gold', accent2: '--gold2',
  pulse: '--volt', pulse2: '--volt2', up: '--go', down: '--stop',
};
const HEX = /^#[0-9a-f]{3,8}$/i;

export function keptSettings(user) {
  const out = {};
  if (!user || typeof user !== 'object') return out;
  for (const k of KEPT_KEYS) if (user[k] !== undefined) out[k] = user[k];
  return out;
}

export function readConfig(web = WEB) {
  const f = join(web, 'config.json');
  if (!existsSync(f)) return { ...DEFAULTS };
  let user = {};
  try { user = JSON.parse(readFileSync(f, 'utf8')); } catch (e) {
    say('dashboard/config.json is not valid JSON, using defaults: ' + e.message);
    return { ...DEFAULTS };
  }
  const k = keptSettings(user);
  const colors = {};
  for (const [key, v] of Object.entries(k.colors || {})) if (COLOR_VARS[key] && HEX.test(String(v))) colors[key] = String(v);
  const links = (Array.isArray(k.links) ? k.links : [])
    .filter((l) => l && typeof l.url === 'string' && /^(https?:\/\/|\/)/i.test(l.url))
    .map((l) => ({ label: String(l.label || l.url).slice(0, 80), url: l.url, note: String(l.note || '').slice(0, 40) }));
  return {
    name: typeof k.name === 'string' && k.name.trim() ? k.name.trim().slice(0, 40) : DEFAULTS.name,
    tagline: typeof k.tagline === 'string' ? k.tagline.slice(0, 60) : DEFAULTS.tagline,
    colors,
    links,
  };
}

// ---- reading the brain -------------------------------------------------------------------------
// The same rules as the map's original graph builder: CRLF-safe frontmatter, a display name that keeps a
// human title and turns a raw slug into one, one observation per non-trivial body line.
const TYPE_MAP = { user: 'person', person: 'person', contact: 'person', project: 'project', feedback: 'feedback_rule', feedback_rule: 'feedback_rule', rule: 'feedback_rule', reference: 'reference' };
const TYPE_PREFIXES = ['user', 'contact', 'feedback', 'project', 'reference'];
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const sanitize = (s) => String(s).split(EM).join(' - ').split(EN).join(' - ').replace(/ {2,}/g, ' ').trim();
const humanize = (slug) => slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const normalizeKey = (s) => String(s).toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');

function displayName(rawName, base) {
  const raw = String(rawName || base).trim();
  if (/\s/.test(raw)) return sanitize(raw);
  const parts = raw.split(/[-_]+/);
  if (parts.length > 1 && TYPE_PREFIXES.includes(parts[0].toLowerCase())) parts.shift();
  return sanitize(humanize(parts.join('-')));
}

function parseFrontmatter(raw) {
  const meta = {};
  if (!raw.startsWith('---')) return { meta, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta, body: raw };
  for (const line of raw.slice(3, end).split(/\r?\n/)) {
    // Top-level keys only: an indented metadata.type must not overwrite the top-level type.
    const m = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
    if (m && m[2].trim() && meta[m[1].toLowerCase()] === undefined) meta[m[1].toLowerCase()] = m[2].trim();
  }
  return { meta, body: raw.slice(end + 4).replace(/^[^\n]*\n/, '') };
}

function observations(body, resolveLink) {
  return body.split(/\r?\n+/).map((line) => sanitize(line
    .replace(/\[\[([^\]]+)\]\]/g, (_, s) => resolveLink(s))
    .replace(/^\s*#{1,6}\s+/, '').replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+\.\s+/, '')
    .replace(/~~/g, '').replace(/\*\*/g, '').replace(/`/g, '').trim())).filter((p) => p.length > 2);
}

const memoryFiles = (mem) => (existsSync(mem) ? readdirSync(mem) : []).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'memory.md');

// Count plus the newest mtime: cheap, and it moves on any edit, add or delete.
export function signature(brain) {
  const mem = join(brain, 'memory');
  let newest = 0;
  const files = memoryFiles(mem);
  for (const f of files) { try { newest = Math.max(newest, statSync(join(mem, f)).mtimeMs); } catch { /* raced */ } }
  return 'brain:' + files.length + ':' + Math.round(newest);
}

export function buildGraph(brain, coreName = DEFAULTS.name) {
  const mem = join(brain, 'memory');
  const raws = [];
  const bySlug = {};
  const keyToName = new Map();
  let latest = 0;
  for (const file of memoryFiles(mem)) {
    let raw = '';
    let st = null;
    try { raw = readFileSync(join(mem, file), 'utf8'); st = statSync(join(mem, file)); } catch { continue; }
    const { meta, body } = parseFrontmatter(raw);
    const base = file.replace(/\.md$/, '');
    const name = displayName(meta.name, base);
    const entityType = TYPE_MAP[String(meta.type || base.split('_')[0] || 'reference').toLowerCase()] || 'reference';
    raws.push({ name, entityType, body, links: [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim()), description: meta.description });
    bySlug[base] = name;
    latest = Math.max(latest, st.mtimeMs);
    keyToName.set(normalizeKey(name), name);
    keyToName.set(normalizeKey(base), name);
    if (meta.name) keyToName.set(normalizeKey(meta.name), name);
  }
  const resolveLink = (s) => keyToName.get(normalizeKey(s)) || humanize(s);
  const entities = [{ type: 'entity', name: coreName, entityType: 'core', observations: ['The whole brain.'] }];
  const relations = [];
  for (const r of raws) {
    const obs = observations(r.body, resolveLink);
    entities.push({ type: 'entity', name: r.name, entityType: r.entityType, observations: obs.length ? obs : ['(no detail recorded)'], ...(r.description ? { description: r.description } : {}) });
    const seen = new Set();
    for (const l of r.links) {
      const target = keyToName.get(normalizeKey(l));
      if (!target || target === r.name || seen.has(target)) continue;
      seen.add(target);
      relations.push({ type: 'relation', from: r.name, to: target, relationType: 'relates_to' });
    }
  }
  const memories = entities.length - 1;
  const facts = entities.slice(1).reduce((a, e) => a + e.observations.length, 0);
  const pairs = new Set(relations.map((r) => [r.from, r.to].sort().join(NL)));
  return {
    entities, relations, bySlug, source: 'brain',
    lastModified: new Date(latest || 0).toISOString(),
    counts: { memories, facts, links: pairs.size, fullNodes: 1 + memories + facts },
  };
}

// Why topics are missing, in one line, or '' when they are there.
export function topicsNote(brain) {
  const idx = join(brain, 'index');
  if (!existsSync(join(idx, 'embeddings.json'))) {
    return 'No topics: the meaning model is not running here, so memories are grouped by kind. To get topics, '
      + 'set it up (on Windows, install the Microsoft Visual C++ Redistributable), then run node tools/build-index.mjs.';
  }
  return 'No topics yet: run node tools/build-index.mjs to group your memories by topic.';
}

export function readTopics(brain, graph) {
  let file = null;
  try { file = JSON.parse(readFileSync(join(brain, 'index', 'topics.json'), 'utf8')); } catch { /* none yet */ }
  const topics = file && Array.isArray(file.topics) ? file.topics : [];
  const byName = {};
  for (const [slug, id] of Object.entries((file && file.of) || {})) {
    const name = graph.bySlug[slug];
    if (name) byName[name] = id;
  }
  const out = { topics: topics.map((t) => ({ id: t.id, name: t.name, size: t.size })), byName };
  if (!out.topics.length) out.note = topicsNote(brain);
  return out;
}

export function readPulse(brain, graph, since = 0) {
  const f = join(brain, '.recall-pulse.jsonl');
  let lines = [];
  try { lines = readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(-400); } catch { return []; }
  const out = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (!e || !e.at || e.at <= since) continue;
      out.push({ at: e.at, host: e.host || '', hits: (e.slugs || []).map((s) => ({ name: graph.bySlug[s] || s })) });
    } catch { /* a half-written line is not an error */ }
  }
  return out;
}

// ---- the page ------------------------------------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const safeJson = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function page(cfg, web) {
  let html = readFileSync(join(web, 'index.html'), 'utf8');
  const vars = Object.entries(cfg.colors).map(([k, v]) => COLOR_VARS[k] + ':' + v).join(';');
  const inject = '<script>window.MAP_CONFIG=' + safeJson({ name: cfg.name, tagline: cfg.tagline }) + ';</script>'
    + (vars ? '<style>:root{' + vars + '}</style>' : '')
    + (cfg.colors.void ? '<meta name="theme-color" content="' + cfg.colors.void + '">' : '');
  return html.replace('</head>', inject + '</head>');
}

function icon(cfg) {
  const ground = cfg.colors.void || '#07080A';
  const accent = cfg.colors.accent || '#D9C08C';
  return "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='" + ground + "'/>"
    + "<circle cx='16' cy='16' r='9' fill='none' stroke='" + accent + "' stroke-width='1.6'/><circle cx='16' cy='16' r='3' fill='" + accent + "'/></svg>";
}

function manifest(cfg) {
  return {
    name: cfg.name, short_name: cfg.name, description: 'The map of your memories.', start_url: '/', scope: '/',
    display: 'standalone', background_color: cfg.colors.void || '#07080A', theme_color: cfg.colors.void || '#07080A',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}

// ---- the server ----------------------------------------------------------------------------------
export function createMapServer({ brain = ENGINE, web = WEB } = {}) {
  brain = resolve(brain);
  let cache = { sig: '', graph: null, name: '' };
  const graph = () => {
    const sig = signature(brain);
    const name = readConfig(web).name;
    if (cache.graph && cache.sig === sig && cache.name === name) return cache;
    cache = { sig, name, graph: buildGraph(brain, name) };
    return cache;
  };
  const send = (res, code, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

  // One set of watchers for every open page, closed when the last one leaves.
  const subscribers = new Set();
  const watchers = [];
  const pending = new Map();
  const emit = (name) => {
    if (pending.has(name)) return;
    pending.set(name, setTimeout(() => { pending.delete(name); for (const s of subscribers) s(name); }, 300));
  };
  const SOURCES = [
    { dir: join(brain, 'memory'), names: ['graph'] },
    { dir: join(brain, 'index'), file: 'topics.json', names: ['topics'] },
    { dir: brain, file: '.recall-pulse.jsonl', names: ['pulse'] },
    { dir: web, file: 'config.json', names: ['links', 'graph'] },
  ];
  const startWatching = () => {
    if (watchers.length) return;
    for (const s of SOURCES) {
      try {
        watchers.push(watch(s.dir, (_ev, name) => {
          // A null name (some platforms) is treated as a change, so nothing is ever missed.
          if (s.file && name && String(name).toLowerCase() !== s.file.toLowerCase()) return;
          for (const n of s.names) emit(n);
        }));
      } catch { /* a folder that does not exist yet sends nothing */ }
    }
  };
  const stopWatching = () => {
    for (const w of watchers.splice(0)) { try { w.close(); } catch { /* closed */ } }
    for (const t of pending.values()) clearTimeout(t);
    pending.clear();
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (p === '/api/memory') { const g = graph(); return send(res, 200, { ...g.graph, signature: g.sig }); }
      if (p === '/api/topics') return send(res, 200, readTopics(brain, graph().graph));
      if (p === '/api/links') return send(res, 200, { links: readConfig(web).links });
      if (p === '/api/pulse') return send(res, 200, { events: readPulse(brain, graph().graph, Number(url.searchParams.get('since') || 0)) });
      if (p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
        res.write('retry: 5000\nevent: hello\ndata: {}\n\n');
        const sub = (name) => { try { res.write('event: ' + name + '\ndata: {}\n\n'); } catch { /* closed */ } };
        subscribers.add(sub);
        startWatching();
        // A comment line now and then keeps a proxy from closing an idle stream. It carries no data.
        const keep = setInterval(() => { try { res.write(': keep\n\n'); } catch { /* closed */ } }, 25000);
        req.on('close', () => { clearInterval(keep); subscribers.delete(sub); if (!subscribers.size) stopWatching(); });
        return;
      }
      if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (p === '/' || p === '/index.html') return send(res, 200, page(readConfig(web), web), TYPES['.html']);
      if (p === '/icon.svg') return send(res, 200, icon(readConfig(web)), TYPES['.svg']);
      if (p === '/manifest.webmanifest') return send(res, 200, manifest(readConfig(web)), 'application/manifest+json');
      // Static files from dashboard/ only, and never the settings file. The RESOLVED path must still be
      // inside the folder, or a ../ in the URL reads any file on the machine.
      const rel = decodeURIComponent(p).replace(/^\/+/, '');
      const file = resolve(web, normalize(rel));
      if (!file.startsWith(web + sep) || /config\.json$/i.test(file) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
      res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
      createReadStream(file).pipe(res);
    } catch (e) {
      send(res, 500, { error: String(e && e.message || e) });
    }
  });
  server.on('close', stopWatching);
  return server;
}

// ---- command line --------------------------------------------------------------------------------
const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 ? argv[i + 1] : d; };
  const PORT = Number(flag('port', process.env.BRAIN_DASHBOARD_PORT || DEFAULT_PORT));
  // Loopback by default: a picture of your own memory is not something to bind to every interface by accident.
  const HOST = flag('host', '127.0.0.1');
  const BRAIN = resolve(flag('brain', ENGINE));
  const server = createMapServer({ brain: BRAIN });
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') say('port ' + PORT + ' is already in use. Try: node tools/dashboard.mjs --port ' + (PORT + 1));
    else say('map server error: ' + (e && e.message));
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const cfg = readConfig();
    const g = buildGraph(BRAIN, cfg.name);
    const t = readTopics(BRAIN, g);
    const url = 'http://' + HOST + ':' + PORT;
    say('');
    say('  ' + cfg.name + ' map on ' + url);
    say('  ' + g.counts.memories + ' memories, ' + g.counts.links + ' links, ' + (t.topics.length ? t.topics.length + ' topics.' : 'no topics yet.'));
    if (!t.topics.length) say('  ' + t.note);
    say('');
    if (argv.includes('--open')) {
      const win = process.platform === 'win32';
      const cmd = win ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
      import('node:child_process').then(({ spawn }) => {
        spawn(cmd, win ? ['/c', 'start', '', url] : [url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
      });
    }
  });
}
