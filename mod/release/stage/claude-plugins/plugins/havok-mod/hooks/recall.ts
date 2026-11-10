import type { Engine, HookLink } from './shared';
import { S, hasIdleMark, setDecisionsWaiting, org, owner, mainAgent } from './shared';
import { B, brainInit, brainUpAt } from './brainjobs';
import { isPingText } from './brain/keepwarm-rules.mjs';
import { type Host, hostRequest, resolveHost } from './brainhost';
import type { Versions } from './layersource';
import { usageRow } from './usage';
import { type Release, parseRelease } from './update';
import { recordProof } from './hostproof';
import { sendSystemNote } from './mail';
export const RECALL_BUDGET_MS = 6000;
const REPORT_FILE = 'havok-recall-down-reported.json';
const REPORT_AGAIN_MS = 30 * 60000;
export const REPORT_TO = () => org().reportTo;
const FAILS_FOR_DOWN = 2;
const PREVIOUS = 3;
const DESCRIPTION_CHARS = 60;
const PROMPT_CHARS = 20000;
const DOWN_MARK = 'havok-remote-embed-down';
const RM_JS = "require('fs').rmSync(process.argv[1],{force:true})";
export const SKIPPED_SLOW = 'recall skipped: the brain server did not answer in 6 s';
export const downLine = () => `recall is off: the brain server did not answer twice in a row; ${mainAgent()} was told, and recall resumes on its first healthy answer`;
export const STILL_DOWN_LINE = 'recall is off: the brain server is still not answering; it resumes on its first healthy answer';
type Memory = {
    slug: string;
    description: string;
    why: string;
};
export type FoundDecision = {
    id: string;
    at: string;
    by: string;
    area: string;
    what: string;
    state: string;
};
export type RecallAnswer = {
    memories: Memory[];
    earlier: {
        slug: string;
        description: string;
    }[];
    note: string;
    layers?: Versions;
    release?: Release;
    decisionsWaiting?: number;
    decisions?: FoundDecision[];
    distVersion?: string;
    agyQuotaAt?: string;
};
let failures = 0;
let down = false;
let downSince = 0;
let reported = false;
let marked = false;
let previous: string[] = [];
let host: Promise<Host | null> | null = null;
let hostFor = '';
let shownDecisions = new Set<string>();
let agySeenAt = '';
export function recallReset() { agySeenAt = ''; pullAsked = { version: '', at: 0 }; failures = 0; down = false; downSince = 0; reported = false; marked = false; previous = []; host = null; hostFor = ''; shownDecisions = new Set(); }
export const recallIsDown = () => down;
const cut = (s: string, n: number) => { const x = String(s ?? '').replace(/\s+/g, ' ').trim(); return x.length <= n ? x : x.slice(0, n).replace(/\s+\S*$/, '') + '...'; };
export function formatRecall(a: RecallAnswer, where: {
    memDir: string;
    client: string;
}, shown: Set<string> = new Set()): string {
    const n = a.memories.length + a.earlier.length;
    const lines: string[] = [];
    if (n) {
        const open = where.memDir ? `files: ${where.memDir}/<name>.md` : `on the brain server only; open one with node ${where.client} read <name>`;
        lines.push(`BRAIN RECALL: ${n} memories (${open}). These lines only say which files are worth opening, never what they say: open the relevant ones before answering.`);
        let again = a.earlier.length;
        for (const m of a.memories) {
            if (m.why === 'earlier') {
                again++;
                continue;
            }
            lines.push(`- [${m.why}] ${m.slug}: ${cut(m.description, DESCRIPTION_CHARS)}`);
        }
        if (again)
            lines.push(`${again} more matched again: shown earlier in this conversation, not listed again.`);
    }
    const ds = a.decisions ?? [];
    if (ds.length) {
        const fresh = ds.filter((d) => !shown.has(d.id));
        lines.push(`DECISIONS LOG: ${ds.length} matching decision${ds.length === 1 ? '' : 's'} (decided already: check here before asking ${owner()}; search more with decision_search).`);
        for (const d of fresh) {
            shown.add(d.id);
            lines.push(`- ${d.id} (${d.at.slice(0, 10)}, by ${d.by || 'an agent'}, ${d.state || 'waiting'}${d.area ? `, ${d.area}` : ''}): ${cut(d.what, DESCRIPTION_CHARS)}`);
        }
        if (ds.length > fresh.length)
            lines.push(`${ds.length - fresh.length} more matched again: listed earlier in this conversation.`);
    }
    if (a.note)
        lines.push(a.note);
    return lines.join('\n');
}
function parseAnswer(text: string): RecallAnswer | null {
    let v: Record<string, unknown>;
    try {
        v = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (!v || typeof v !== 'object' || !Array.isArray(v.memories))
        return null;
    const str = (x: unknown) => (typeof x === 'string' ? x : '');
    const memories = (v.memories as Record<string, unknown>[]).filter((m) => m && str(m.slug)).map((m) => ({ slug: str(m.slug), description: str(m.description), why: str(m.why) || 'keyword' }));
    const earlier = (Array.isArray(v.earlier) ? (v.earlier as Record<string, unknown>[]) : []).filter((m) => m && str(m.slug)).map((m) => ({ slug: str(m.slug), description: str(m.description) }));
    const layers = v.layers && typeof v.layers === 'object' && !Array.isArray(v.layers) ? (v.layers as Versions) : undefined;
    const release = parseRelease(v.release);
    const waiting = typeof v.decisionsWaiting === 'number' && Number.isFinite(v.decisionsWaiting) ? v.decisionsWaiting : undefined;
    const decisions = (Array.isArray(v.decisions) ? (v.decisions as Record<string, unknown>[]) : []).filter((d) => d && str(d.id) && str(d.what)).slice(0, 5)
        .map((d) => ({ id: str(d.id), at: str(d.at), by: str(d.by), area: str(d.area), what: str(d.what), state: str(d.state) }));
    const dist = /^[0-9a-f]{8,64}$/.test(str(v.distVersion)) ? str(v.distVersion) : '';
    const agyAt = Number.isFinite(Date.parse(str(v.agyQuotaAt))) ? str(v.agyQuotaAt) : '';
    return { memories, earlier, note: str(v.note), ...(layers ? { layers } : {}), ...(release ? { release } : {}), ...(waiting !== undefined ? { decisionsWaiting: waiting } : {}), ...(decisions.length ? { decisions } : {}), ...(agyAt ? { agyQuotaAt: agyAt } : {}), ...(dist ? { distVersion: dist } : {}) };
}
async function reportDown($: Engine, now: number, why: string) {
    const agent = S.cfg?.agent ?? '';
    const machine = (S.cfg?.machine || B.machine || '').toUpperCase();
    if (!agent || !REPORT_TO() || `${agent}@${machine}` === REPORT_TO() || agent === 'havok')
        return;
    if (!B.brainDir && !B.root)
        return;
    const path = `${B.home}/.claude/${REPORT_FILE}`;
    try {
        const prev = JSON.parse(await $.fs.read(path)) as {
            at?: number;
        };
        if (prev.at && now - prev.at < REPORT_AGAIN_MS)
            return;
    }
    catch { }
    const sent = await sendSystemNote($, REPORT_TO(), `Recall is down on ${machine} (seen by ${agent}@${machine} at ${new Date(now).toISOString().slice(11, 16)} UTC): the brain server did not answer twice in a row (${why.slice(0, 160)}). Recall is off there and resumes on the first healthy answer of the server.`).catch(() => false);
    if (!sent)
        return;
    await $.fs.write(path, JSON.stringify({ at: now, by: agent })).catch(() => undefined);
    reported = true;
}
async function recallBack($: Engine, now: number) {
    const since = downSince;
    down = false;
    downSince = 0;
    failures = 0;
    await markDown($, false);
    $.ui.log(`recall back: the brain server answered /health after ${Math.round((now - since) / 1000)} s`, { to: 'debug' });
    if (!reported)
        return;
    reported = false;
    const machine = (S.cfg?.machine || B.machine || '').toUpperCase();
    await $.process.run(['node', '-e', RM_JS, `${B.home}/.claude/${REPORT_FILE}`], { timeoutMs: 10000 }).catch(() => undefined);
    await sendSystemNote($, REPORT_TO(), `Recall is back on ${machine} at ${new Date(now).toISOString().slice(11, 16)} UTC: the brain server answered after about ${Math.max(1, Math.round((now - since) / 60000))} minutes down. Stop any repair of it you started.`).catch(() => undefined);
}
async function markDown($: Engine, down: boolean) {
    const path = `${B.home}/.claude/${DOWN_MARK}`;
    if (down) {
        marked = true;
        await $.fs.write(path, new Date(await $.clock.now()).toISOString()).catch(() => undefined);
    }
    else if (marked) {
        marked = false;
        await $.process.run(['node', '-e', RM_JS, path], { timeoutMs: 10000 }).catch(() => undefined);
    }
}
async function row($: Engine, r: Record<string, unknown>, hook?: HookLink) {
    await usageRow($, { id: 'r-' + crypto.randomUUID(), at: new Date(await $.clock.now()).toISOString(), session: S.sessionId || B.sid, kind: 'recall', ...r }, hook).catch(() => undefined);
}
let preTurnFor = '';
let preTurnIs = false;
async function preTurnKept($: Engine): Promise<boolean> {
    const sid = S.sessionId || B.sid;
    if (preTurnFor === sid && sid)
        return preTurnIs;
    preTurnFor = sid;
    const dir = String((await $.env.get('CLAUDE_CONFIG_DIR')) || `${B.home}/.claude`).replace(/\\/g, '/').replace(/\/+$/, '');
    try {
        const s = JSON.parse(await $.fs.read(`${dir}/settings.json`)) as {
            hooks?: {
                UserPromptSubmit?: unknown;
            };
        };
        preTurnIs = /pre-turn\.mjs/.test(JSON.stringify(s.hooks?.UserPromptSubmit ?? ''));
    }
    catch {
        preTurnIs = false;
    }
    return preTurnIs;
}
export const PULL_RETRY_MS = 10 * 60000;
let pullAsked = { version: '', at: 0 };
const DETACH_JS = "const{spawn}=require('child_process');spawn(process.execPath,process.argv.slice(1),{detached:true,stdio:'ignore',windowsHide:true}).unref()";
export async function agyQuotaSync($: Engine, h: Host, at: string): Promise<boolean> {
    if (!at || at === agySeenAt || !B.home)
        return false;
    const file = `${B.home}/.agy-runs/quota.json`;
    let local = '';
    try {
        local = String((JSON.parse(String(await $.fs.read(file)).replace(/^\uFEFF/, '')) as {
            at?: unknown;
        }).at ?? '');
    }
    catch { }
    if (Date.parse(local) >= Date.parse(at)) {
        agySeenAt = at;
        return false;
    }
    const r = await hostRequest($, h, 'GET', '/agy/quota', { budgetMs: 5000 });
    if (!r.ok || r.status !== 200)
        return false;
    let q: {
        at?: unknown;
        ok?: unknown;
        pools?: unknown;
    };
    try {
        q = JSON.parse(r.text);
    }
    catch {
        return false;
    }
    if (q.ok !== true || !Array.isArray(q.pools) || Date.parse(String(q.at)) <= (Date.parse(local) || 0))
        return false;
    await $.fs.write(file, JSON.stringify(q, null, 2) + '\n');
    agySeenAt = String(q.at);
    $.ui.log(`agy quota: took the shared reading of ${String(q.at)} (local ${local || 'none'})`, { to: 'debug' });
    return true;
}
export async function mirrorPull($: Engine, h: Host, version: string): Promise<boolean> {
    if (/^https?:\/\/(127\.|localhost|\[::1\])/i.test(h.url))
        return false;
    const dir = B.brainDir;
    if (!dir)
        return false;
    const script = `${dir}/tools/pull-from-server.mjs`;
    if (!(await $.fs.exists(script).catch(() => false)))
        return false;
    let seen = '';
    try {
        seen = String((JSON.parse(String(await $.fs.read(`${dir}/.pull-from-server.state`))) as {
            remote?: unknown;
        }).remote ?? '');
    }
    catch { }
    if (seen === version)
        return false;
    const now = await $.clock.now();
    if (pullAsked.version === version && now - pullAsked.at < PULL_RETRY_MS)
        return false;
    pullAsked = { version, at: now };
    await $.process.run(['node', '-e', DETACH_JS, script, '--quiet'], { timeoutMs: 10000 });
    $.ui.log(`brain mirror: server code version ${version}, local ${seen || 'none'}: pull started`, { to: 'debug' });
    return true;
}
export async function brainHost($: Engine): Promise<Host | null> {
    await brainInit($);
    const machine = (S.cfg?.machine || B.machine || '').toUpperCase();
    const key = `${B.brainDir}|${machine}|${S.cfg?.context.layerHost ?? ''}`;
    if (!host || hostFor !== key) {
        hostFor = key;
        host = resolveHost($, { home: B.home, machine, brainDir: B.brainDir, url: S.cfg?.context.layerHost });
    }
    return host;
}
export async function recallTurn($: Engine, prompt: string, hook?: HookLink): Promise<{
    block: string;
    layers?: Versions;
    release?: Release;
}> {
    const text = String(prompt ?? '');
    if (!text.trim() || isPingText(text) || hasIdleMark(text))
        return { block: '' };
    const machine = (S.cfg?.machine || B.machine || '').toUpperCase();
    const h = await brainHost($);
    if (!h)
        return { block: '' };
    const now = await $.clock.now();
    if (down) {
        if (!reported)
            await reportDown($, now, 'still not answering');
        if ((await brainUpAt($)) <= downSince)
            return { block: STILL_DOWN_LINE };
        await recallBack($, now);
    }
    const body = {
        prompt: text.slice(0, PROMPT_CHARS),
        previous: previous.slice(-PREVIOUS),
        session: S.sessionId || B.sid,
        machine,
        agent: S.cfg?.agent ?? '',
        groups: S.cfg?.groups ?? [],
    };
    previous = [...previous, text.slice(0, PROMPT_CHARS)].slice(-PREVIOUS);
    const r = await hostRequest($, h, 'POST', '/recall/turn', { body, budgetMs: RECALL_BUDGET_MS });
    const latencyMs = (await $.clock.now()) - now;
    const a = r.ok && r.status === 200 ? parseAnswer(r.text) : null;
    await recordProof($, B.home, 'recall', !!a);
    if (a) {
        failures = 0;
        await markDown($, false);
        if (a.decisionsWaiting !== undefined)
            setDecisionsWaiting($, a.decisionsWaiting);
        if (a.distVersion && h)
            await mirrorPull($, h, a.distVersion).catch(() => undefined);
        if (a.agyQuotaAt && h)
            await agyQuotaSync($, h, a.agyQuotaAt).catch(() => undefined);
        await row($, { ok: true, latencyMs, memories: a.memories.length, earlier: a.earlier.length }, hook);
        const memDir = B.brainDir && (await $.fs.exists(`${B.brainDir}/memory`).catch(() => false)) ? `${B.brainDir}/memory` : '';
        if (await preTurnKept($))
            return { block: '', ...(a.layers ? { layers: a.layers } : {}), ...(a.release ? { release: a.release } : {}) };
        return { block: formatRecall(a, { memDir, client: `${B.root || B.brainDir}/tools/brain-client.mjs` }, shownDecisions), ...(a.layers ? { layers: a.layers } : {}), ...(a.release ? { release: a.release } : {}) };
    }
    const why = r.ok ? (r.status === 200 ? 'an answer that is not a recall list' : `status ${r.status}`) : r.why;
    await row($, { ok: false, latencyMs, memories: 0, earlier: 0, why: why.slice(0, 160) }, hook);
    failures++;
    if (failures >= FAILS_FOR_DOWN) {
        failures = 0;
        down = true;
        downSince = now;
        await markDown($, true);
        $.ui.log(`recall off: ${why}; resumes on the first healthy /health answer`, { to: 'debug' });
        await reportDown($, now, why);
        return { block: downLine() };
    }
    return { block: !r.ok && r.timedOut ? SKIPPED_SLOW : `recall skipped: the brain server did not answer (${why.slice(0, 80)})` };
}
