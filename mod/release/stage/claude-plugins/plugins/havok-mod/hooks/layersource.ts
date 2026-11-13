import type { Engine } from './shared';
import { type Host, hostRequest } from './brainhost';
import { brainKnownDown } from './brainjobs';
import { type Release, parseRelease } from './update';
export type Versions = Record<string, string>;
export type SourceLayer = {
    key: string;
    text: string;
};
export type LayerProblem = {
    what: string;
    status: string;
};
export type LayerSourceCfg = {
    machine: string;
    groups: string[];
    layerMaxChars: number;
    cacheDir: string;
    seedDir: string;
    host: Host | null;
    versionsBudgetMs?: number;
};
export type Fetched = {
    layers: SourceLayer[];
    from: 'host' | 'cache' | 'seed';
    problems: LayerProblem[];
};
export const VERSIONS_BUDGET_MS = 1500;
const LAYER_BUDGET_MS = 5000;
let refused: Versions = {};
export function layerSourceReset() { refused = {}; lastCheck = null; seenRelease = undefined; }
let seenRelease: Release | undefined;
export const hostRelease = () => seenRelease;
export const layerKeys = (c: LayerSourceCfg) => ['global', ...c.groups.map((g) => `group/${g}`)];
async function readText($: Engine, path: string): Promise<string | null> {
    try {
        return String(await $.fs.read(path));
    }
    catch {
        return null;
    }
}
async function cachedVersions($: Engine, c: LayerSourceCfg): Promise<Versions> {
    try {
        const v = JSON.parse((await readText($, `${c.cacheDir}/versions.json`)) ?? '');
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Versions) : {};
    }
    catch {
        return {};
    }
}
async function hostVersions($: Engine, c: LayerSourceCfg): Promise<{
    v: Versions;
} | {
    why: string;
}> {
    if (await brainKnownDown($).catch(() => false))
        return { why: 'the brain server is known to be down on this machine' };
    if (!c.host)
        return { why: 'no layer host known on this machine (no brain checkout and no context.layerHost)' };
    const q = `/layers/versions?machine=${encodeURIComponent(c.machine)}${c.groups.length ? `&groups=${c.groups.map(encodeURIComponent).join(',')}` : ''}`;
    const r = await hostRequest($, c.host, 'GET', q, { budgetMs: c.versionsBudgetMs || VERSIONS_BUDGET_MS });
    if (!r.ok)
        return { why: r.why };
    if (r.status !== 200)
        return { why: `the host answered ${r.status}` };
    try {
        const v = JSON.parse(r.text);
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            seenRelease = parseRelease((v as Record<string, unknown>).release) ?? seenRelease;
            return { v: Object.fromEntries(Object.entries(v).filter(([k, x]) => typeof x === 'string' && layerKeys(c).includes(k))) as Versions };
        }
    }
    catch { }
    return { why: 'the host answered something that is not a version list' };
}
const differs = (host: Versions, cached: Versions, keys: string[]) => keys.some((k) => !!host[k] && host[k] !== cached[k] && refused[k] !== host[k]);
let lastCheck: {
    v: Versions | null;
    why: string;
} | null = null;
export async function checkLayerVersions($: Engine, c: LayerSourceCfg, given?: Versions): Promise<boolean> {
    let v: Versions | null = given ?? null;
    let why = '';
    if (!v) {
        const r = await hostVersions($, c);
        v = 'v' in r ? r.v : null;
        why = 'why' in r ? r.why : '';
    }
    lastCheck = { v, why };
    if (!v)
        return false;
    return differs(v, await cachedVersions($, c), layerKeys(c));
}
const badText = (t: string, max: number) => (t.includes('\u0000') ? 'holds binary bytes' : t.length > max ? `is ${t.length} characters, over the cap of ${max}` : '');
export async function fetchLayers($: Engine, c: LayerSourceCfg, given?: Versions): Promise<Fetched> {
    const keys = layerKeys(c);
    const problems: LayerProblem[] = [];
    const cached = await cachedVersions($, c);
    const checked = lastCheck;
    lastCheck = null;
    let versions: Versions | null = given ?? checked?.v ?? null;
    let downWhy = checked && !checked.v ? checked.why : '';
    if (!versions && !checked) {
        const r = await hostVersions($, c);
        if ('v' in r)
            versions = r.v;
        else
            downWhy = r.why;
    }
    const cacheText = async (k: string) => (cached[k] ? ((await readText($, `${c.cacheDir}/${k}.md`)) ?? '') : '');
    if (!versions) {
        if (Object.keys(cached).some((k) => keys.includes(k))) {
            problems.push({ what: `layer host unreachable (${downWhy}); the cached copy is used`, status: 'layer host unreachable, cached copy used' });
            return { layers: await Promise.all(keys.map(async (k) => ({ key: k, text: await cacheText(k) }))), from: 'cache', problems };
        }
        problems.push({ what: `layer host unreachable (${downWhy}) and no cached copy; the seed copy shipped with the mod is used`, status: 'context from seed copy' });
        const seeded = await Promise.all(keys.map(async (k) => ({ key: k, text: (await readText($, `${c.seedDir}/${k}.md`)) ?? '' })));
        return { layers: seeded, from: 'seed', problems };
    }
    const next: Versions = {};
    const layers: SourceLayer[] = [];
    for (const k of keys) {
        const want = versions[k];
        if (!want) {
            layers.push({ key: k, text: await cacheText(k) });
            if (cached[k])
                next[k] = cached[k]!;
            continue;
        }
        if (cached[k] === want) {
            const t = await readText($, `${c.cacheDir}/${k}.md`);
            if (t !== null) {
                layers.push({ key: k, text: t });
                next[k] = want;
                continue;
            }
        }
        if (refused[k] === want) {
            layers.push({ key: k, text: await cacheText(k) });
            if (cached[k])
                next[k] = cached[k]!;
            continue;
        }
        const r = await hostRequest($, c.host!, 'GET', `/layers/${encodeURIComponent(k)}`, { budgetMs: LAYER_BUDGET_MS, headers: cached[k] ? { 'if-none-match': `"${cached[k]}"` } : {} });
        if (r.ok && r.status === 304 && cached[k]) {
            layers.push({ key: k, text: await cacheText(k) });
            next[k] = want;
            continue;
        }
        if (!r.ok || r.status !== 200) {
            problems.push({ what: `layer ${k} could not be downloaded (${r.ok ? `the host answered ${r.status}` : r.why}); the cached copy is kept`, status: `layer ${k} not downloaded, cached copy kept` });
            layers.push({ key: k, text: await cacheText(k) });
            if (cached[k])
                next[k] = cached[k]!;
            continue;
        }
        const bad = badText(r.text, c.layerMaxChars);
        if (bad) {
            refused[k] = want;
            problems.push({ what: `layer ${k} ${bad}; not taken, its cached version is kept`, status: `layer ${k} ${bad.startsWith('holds') ? 'is not text' : 'too long'}, not loaded` });
            layers.push({ key: k, text: await cacheText(k) });
            if (cached[k])
                next[k] = cached[k]!;
            continue;
        }
        await $.fs.write(`${c.cacheDir}/${k}.md`, r.text);
        layers.push({ key: k, text: r.text });
        next[k] = want;
    }
    if (JSON.stringify(next) !== JSON.stringify(cached))
        await $.fs.write(`${c.cacheDir}/versions.json`, JSON.stringify(next)).catch(() => undefined);
    return { layers, from: 'host', problems };
}
export const liveMarker = (home: string, session: string) => `${home}/.claude/havok-mod/layers-live/${session}`;
export async function writeLayersLive($: Engine, home: string, session: string, info: {
    from: string;
    keys: string[];
}) {
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(session))
        return;
    await $.fs.write(liveMarker(home, session), JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), from: info.from, layers: info.keys }));
}
