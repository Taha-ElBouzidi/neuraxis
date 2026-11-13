import type { On, SessionMessage, SessionCompactInput, SessionCompactResult, PromptComposeInput, PromptComposeResult, PromptSubmitInput, TurnStartInput, TurnCompleteInput } from 'claude-code';
import { type Config, type Engine, owner, recordHidden, PLUGIN, VERSION, S, IDLE_MARK, hasIdleMark, GUARD_REASON, FORK_REFUSAL, appendText, brainMarker, cleanupAllowed, setCleanedContext, setCleanedAt, isBackgroundFork, knownGuard, settleGuard, setStatus, storeDelete, storeSet, toolName, toolMatch } from './shared';
import { type LayerSourceCfg, type Versions, fetchLayers, checkLayerVersions } from './layersource';
import { resolveHost } from './brainhost';
import { recordProof } from './hostproof';
import { ContextWatch, type Limits } from './force';
import { contextOf } from './brain/compact-rules.mjs';
type ApiBlock = {
    type: string;
    [k: string]: unknown;
};
type ApiMsg = {
    role: 'user' | 'assistant';
    content: ApiBlock[];
};
type Row = SessionMessage;
type IdleCfg = {
    enabled: boolean;
    minutes: number;
    floorTokens: number;
    fork: boolean;
    applyMinutes: number;
    keepWarm: RegExp;
    keepWarmOn: boolean;
};
type Cfg = {
    agent: string;
    machine: string;
    groups: string[];
    main: boolean;
    home: string;
    cwd: string;
    layersDir: string;
    agentLayerDir: string;
    machineLayerFile: string;
    archiveDir: string;
    layerMaxChars: number;
    hostBudgetMs: number;
    layerHost: string;
    brainDir: string;
    locks: boolean;
    notesFile: string;
    dropThinkingOnLayerChange: boolean;
    restartSafe: boolean;
    systemPromptSnapshot: 'on' | 'off';
    lockRecentTurns: number;
    lockRecentTokens: number;
    hideOldToolOutputs: boolean;
    hideAfterTurns: number;
    hideMinTokens: number;
    layerColdMinutes: number;
    heldColdMinutes: number;
    padding: {
        enabled: boolean;
        minBytes: number;
    };
    idle: IdleCfg;
    remindAt: number;
    forceAt: number;
    outcomeTurns: number;
    mailTurns: {
        archive: boolean;
        minTokens: number;
    };
    debugDir: string;
};
type Layer = {
    key: string;
    id: string;
    title: string;
    path: string;
    text: string;
    urgent?: boolean;
};
type RowRef = {
    i: number;
    fp: string;
};
type PartRef = {
    id: number;
    kind: string;
    label: string;
    tokens: number;
    rows: RowRef[];
};
type PendingArchive = {
    archive: string;
    note: string;
    parts: PartRef[];
    at: number;
    rowCount: number;
    auto?: boolean;
    plan?: 'idle';
};
type Pending = {
    archives: PendingArchive[];
    keeps: {
        fact: string;
        at: number;
    }[];
};
export type CleanList = {
    at: number;
    keys: string[];
    built?: Record<string, BuiltRow>;
    archivedTools: string[];
    fileHolds?: boolean;
};
type Part = {
    id: number;
    kind: 'prompt' | 'text' | 'tool' | 'archived' | 'other';
    tool?: string;
    rows: number[];
    tokens: number;
    label: string;
    turn: number;
    locked?: string;
    lossy?: string;
    link: number;
};
type Analysis = {
    rows: Row[];
    parts: Part[];
    rowPart: Map<number, number>;
    thinkingRows: Set<number>;
    carryRows: Set<number>;
    unknownRows: Map<number, string>;
    thinkingTokens: number;
    lastTurn: number;
    unknown: string[];
    resultTypes: Map<string, string[]>;
    realTurns: number[];
};
const TOOL_PREFIX = `mcp__${PLUGIN}__`;
export const NOTE_TOOL = toolName('archive_note');
const TOOLS = { map: toolName('context_map'), archive: toolName('context_archive'), restore: toolName('context_restore'), keep: toolName('context_keep') };
const MARK_APPLY = 'havok-mod: apply the agent\'s clean-up';
const MARK_LAYER = 'havok-mod: send the system prompt again after a layer change';
const MARK_REAPPLY = 'havok-mod: apply the cleaned conversation again after a restart';
const CHARS_PER_TOKEN = 3.5;
const ARCHIVE_FILE_MAX = 3500000;
const RESTORE_PAGE_CHARS = 60000;
const MAP_COMPRESS_OVER = 150;
const MAP_SMALL_TOKENS = 400;
const MAP_CANDIDATES = 10;
const NOTE_COST_TOKENS = 300;
const NOTES_SHOW_CHARS = 6000;
const RESTORE_CONTEXT_LINES = 2;
const NOTE_PREFIX = 'archived: ';
const DEFAULT_KEEP_WARM = '^\\s*keep-warm ping\\s*$';
const URGENT_RE = /^\s*<!--\s*urgent\s*-->\s*(?:\r?\n|$)/i;
const DEFAULT_RECENT_TURNS = 3;
const DEFAULT_RECENT_TOKENS = 30000;
const WORDS_LOCK = 'words: never archived';
const REPLY_LOCK = 'your reply to the user: kept word for word';
const recentLock = (n: number) => `one of the last ${n} turns: kept whole`;
const NOTE_FIELDS = ['Outcome', 'Exact values', 'Errors', 'Restore'] as const;
const VALUES_LABEL = 'Exact values:';
const VALUES_MIN_CHARS = 600;
const VALUES_MAX_CHARS = 2000;
const VALUES_SHARE = 0.02;
const ERRORS_SHOWN = 5;
const ERROR_COMMAND_CHARS = 160;
const ERROR_LINE_CHARS = 300;
let cfg: Cfg | null = null;
let sessionId = '';
let layers: Layer[] = [];
let inForce: Layer[] = [];
let sourceMissing = false;
let layerTold = new Set<string>();
let idleAsked = false;
let statusNote = '';
let layerNote = '';
let lastCleanup = '';
let cleanupLine = '';
let reapplyWanted = false;
let layerWanted = false;
let guardTold = false;
let changeNote = '';
let noted: Layer[] | null = null;
export const EARLY_WHY = 'not in your system prompt yet: follow the new lines from now on; they land there at your next clean-up';
const est = (s: string | undefined) => Math.ceil((s ? s.length : 0) / CHARS_PER_TOKEN);
const kfmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const oneLine = (s: string, n: number) => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
function fnv(s: string, seed = 0x811c9dc5): string {
    let h = seed;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
}
const h64 = (s: string) => fnv(s) + fnv(s, 0x01234567);
const fp = (r: Row) => `${r.role}|${r.toolUses.map((u) => u.tool_use_id).join(',')}|${(r.toolResults ?? []).map((t) => t.tool_use_id).join(',')}|${fnv(r.text)}`;
export const rowFp = (r: Row) => fp(r);
const EMPTY_FP = fp({ role: 'assistant', text: '', toolUses: [] } as unknown as Row);
export const rowKey = (r: Row) => `${fp(r)}|${fnv(r.toolUses.map((u) => JSON.stringify(u.input)).join('\u0001'))}|${fnv((r.toolResults ?? []).map((t) => t.text).join('\u0001'))}`;
const isEmptyAssistant = (r: Row) => r.role === 'assistant' && !r.text && r.toolUses.length === 0;
const kPending = () => `pending:${sessionId}`;
const kSeq = () => `archseq:${sessionId}`;
const kClean = () => `clean:${sessionId}`;
const cleanPath = () => `${cfg!.archiveDir}/${sessionId}.clean.json`;
const restoredPath = () => `${cfg!.archiveDir}/${sessionId}.restored.json`;
const historyPath = () => `${cfg!.archiveDir}/${sessionId}.cleanups.json`;
const kInForce = () => `inforce:${cfg?.agent ?? ''}`;
const kLayers = () => `layers:${cfg?.agent ?? ''}`;
const stamp = () => new Date().toISOString();
const hhmm = () => stamp().slice(11, 16);
const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
export function fromShared(c: Config): Cfg {
    let keepWarm: RegExp;
    const esc = c.keepWarm.pingText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
        keepWarm = new RegExp(`^\\s*${esc}\\s*$`, 'i');
    }
    catch {
        keepWarm = new RegExp(DEFAULT_KEEP_WARM, 'i');
    }
    return {
        agent: c.agent, machine: c.machine, groups: c.groups, main: c.main, home: c.home, cwd: c.cwd,
        layersDir: c.context.layersDir, agentLayerDir: c.context.agentLayerDir, machineLayerFile: String(c.context.machineLayerFile || `${c.home}/.claude/havok-mod/layers/machine.md`).replace(/\\/g, '/'), archiveDir: c.context.archiveDir, layerMaxChars: c.context.layerMaxChars, hostBudgetMs: c.context.hostBudgetMs ?? 0,
        layerHost: c.context.layerHost, brainDir: c.checks.brainDir,
        locks: c.context.locks, notesFile: c.context.notesFile,
        dropThinkingOnLayerChange: true, restartSafe: c.context.restartSafe, systemPromptSnapshot: c.context.systemPromptSnapshot,
        lockRecentTurns: c.context.lockRecentTurns, lockRecentTokens: c.context.lockRecentTokens,
        hideOldToolOutputs: c.context.hideOldToolOutputs, hideAfterTurns: c.context.hideAfterTurns, hideMinTokens: c.context.hideMinTokens,
        layerColdMinutes: c.context.layerColdMinutes, heldColdMinutes: c.context.heldColdMinutes, padding: { ...c.padding },
        idle: { enabled: c.context.idle.enabled, minutes: c.context.idle.minutes, floorTokens: c.context.idle.floorTokens, fork: c.context.idle.fork !== false, applyMinutes: c.context.idle.applyMinutes > 0 ? c.context.idle.applyMinutes : 50, keepWarm, keepWarmOn: c.keepWarm.enabled && c.keepWarm.maxPings > 0 },
        remindAt: c.context.remindAt, forceAt: c.context.forceAt, outcomeTurns: c.context.outcomeTurns, mailTurns: { ...c.context.mailTurns },
        debugDir: c.debugDir,
    };
}
function render($: Engine) {
    if (!cfg)
        return;
    const layerLine = layerNote || (sourceMissing && hasText(inForce) ? 'layer host unreachable, layers in force kept' : '');
    let text = statusNote || layerLine || lastCleanup;
    if (S.guarded === true)
        text = 'clean-up off (organization guard)';
    else if (!statusNote && !layerLine && layersWaiting())
        text = `layer update waiting (${waitingKeys().join(', ')}), lands at the next clean-up`;
    setStatus($, 'ctx', text ? `ctx ${text}` : '');
}
async function report($: Engine, what: string, toTranscript: boolean, status: string | null) {
    if (status !== null) {
        statusNote = status;
        render($);
    }
    $.ui.log(`${what}`, { to: toTranscript ? 'transcript' : 'debug' });
    if (!cfg)
        return;
    try {
        const v = await $.session.version();
        await appendText($, `${cfg.archiveDir}/unknown.log`, JSON.stringify({ at: stamp(), session: sessionId, agent: cfg.agent, version: v.version, what }) + '\n');
    }
    catch { }
}
async function debugDump($: Engine, name: string, data: unknown) {
    if (!cfg?.debugDir)
        return;
    try {
        await $.fs.write(`${cfg.debugDir}/${Date.now()}-${name}.json`, JSON.stringify(data, null, 1));
    }
    catch { }
}
function apiDigest(api: ApiMsg[]) {
    const content = (m: ApiMsg) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content } as ApiBlock] : m.content);
    const shape = api.map((m) => m.role[0] + ':' + content(m).map((b) => b.type === 'thinking' ? 'TH' : b.type === 'redacted_thinking' ? 'RTH' : b.type === 'tool_use' ? 'U' : b.type === 'tool_result' ? 'R' : b.type === 'text' ? 't' : `[${b.type}]`).join('')).join(' ');
    const blocks = api.map((m) => content(m).map((b) => { const j = JSON.stringify(b); return `${b.type}:${j.length}:${h64(j)}`; }));
    const ids = api.flatMap((m) => content(m).filter((b) => b.type === 'tool_use').map((b) => String(b.id)));
    return { messages: api.length, chars: JSON.stringify(api).length, hash: h64(JSON.stringify(api)), shape, duplicateToolUseIds: ids.filter((x, i) => ids.indexOf(x) !== i), blocks };
}
function layerPlan(c: Cfg): Omit<Layer, 'text'>[] {
    return [
        { key: 'global', id: `${PLUGIN}:global`, title: 'global layer (every agent; owner: Havok)', path: 'host:global' },
        { key: 'machine', id: `${PLUGIN}:machine`, title: `machine layer (every agent on ${c.machine}; owner: the machine's lead agent; kept on this machine only)`, path: c.machineLayerFile },
        ...c.groups.map((g) => ({ key: 'group:' + g, id: `${PLUGIN}:group:${g}`, title: `group layer "${g}" (owner: the agent that created it)`, path: `host:group/${g}` })),
        { key: 'agent', id: `${PLUGIN}:agent`, title: `agent layer (what you, ${c.agent}, chose to keep; change it only through context_keep)`, path: `${c.agentLayerDir}/${c.agent}.md` },
    ];
}
export const sigOf = (ls: {
    key: string;
    text: string;
}[]) => fnv(ls.map((l) => l.key + '\u0000' + l.text).join('\u0001'));
const textOf = (ls: Layer[], key: string) => (ls.find((l) => l.key === key)?.text ?? '').trim();
const changedKeys = (next: Layer[], cur: Layer[]) => [...new Set([...next.map((l) => l.key), ...cur.map((l) => l.key)])].filter((k) => textOf(next, k) !== textOf(cur, k));
const hasText = (ls: Layer[]) => ls.some((l) => l.text.trim());
const waitingKeys = () => changedKeys(layers, inForce);
export const layersWaiting = () => waitingKeys().length > 0;
const urgentWaiting = () => layers.some((l) => l.urgent && textOf(layers, l.key) !== textOf(inForce, l.key));
export function parseLayerText(raw: string): {
    text: string;
    urgent: boolean;
} {
    const urgent = URGENT_RE.test(raw);
    return { text: urgent ? raw.replace(URGENT_RE, '') : raw, urgent };
}
type LayerProblem = {
    what: string;
    status: string;
};
let source: LayerSourceCfg | null = null;
let layerFrom: 'host' | 'cache' | 'seed' | '' = '';
function layerSources(): string {
    const shared = layerFrom === 'host' ? `the layer host ${source?.host?.url ?? ''}`.trim() : layerFrom ? `the ${layerFrom} copy of the layer host` : 'the layer host';
    const list = inForce.filter((l) => l.text.trim()).map((l) => `${l.key} (${l.key === 'machine' ? `local file ${cfg?.machineLayerFile}` : l.key === 'agent' ? `local file in ${cfg?.agentLayerDir}` : shared})`);
    return list.join(', ') || 'none in force yet';
}
async function initSource($: Engine) {
    const c = cfg!;
    const brainDir = c.brainDir || (await brainMarker($, c.home));
    source = {
        machine: c.machine, groups: c.groups, layerMaxChars: c.layerMaxChars, versionsBudgetMs: c.hostBudgetMs,
        cacheDir: `${c.home}/.claude/havok-mod/layers-cache`, seedDir: `${$.plugin.root.replace(/\\/g, '/')}/seed-layers`,
        host: await resolveHost($, { home: c.home, machine: c.machine, brainDir, url: c.layerHost }),
    };
}
async function readLayers($: Engine): Promise<{
    next: Layer[];
    missing: boolean;
    problems: LayerProblem[];
}> {
    const c = cfg!;
    const problems: LayerProblem[] = [];
    const prev = new Map(layers.map((l) => [l.key, l]));
    const known = (key: string) => ({ text: prev.get(key)?.text ?? '', urgent: prev.get(key)?.urgent ?? false });
    const src = source ? await fetchLayers($, source) : { layers: [], from: 'seed' as const, problems: [] };
    layerFrom = src.from;
    if (source?.host)
        await recordProof($, c.home, 'layers', src.from === 'host');
    const missing = src.from !== 'host';
    problems.push(...src.problems);
    const next: Layer[] = [];
    for (const p of layerPlan(c)) {
        let text = '';
        let urgent = false;
        if (p.path.startsWith('host:')) {
            const got = src.layers.find((l) => l.key === p.path.slice('host:'.length))?.text ?? '';
            const k = known(p.key);
            if (src.from === 'seed' && k.text.trim())
                ({ text, urgent } = k);
            else
                ({ text, urgent } = parseLayerText(got));
            next.push({ ...p, text, ...(urgent ? { urgent: true } : {}) });
            continue;
        }
        try {
            const raw = (await $.fs.exists(p.path)) ? await $.fs.read(p.path) : '';
            ({ text, urgent } = parseLayerText(raw));
        }
        catch (err) {
            problems.push({ what: `layer ${p.key} unreadable (${String(err).slice(0, 80)}); its known version is kept`, status: `layer ${p.key} unreadable, last version kept` });
            ({ text, urgent } = known(p.key));
        }
        const binary = text.includes('\u0000');
        if (binary || text.length > c.layerMaxChars) {
            problems.push({
                what: `layer ${p.key} ${binary ? 'holds binary bytes' : `is ${text.length} characters, over the cap of ${c.layerMaxChars}`}; not taken, its known version is kept`,
                status: `layer ${p.key} ${binary ? 'is not text' : 'too long'}, not loaded`,
            });
            ({ text, urgent } = known(p.key));
        }
        next.push({ ...p, text, ...(urgent ? { urgent: true } : {}) });
    }
    return { next, missing, problems };
}
async function tellLayerProblems($: Engine, missing: boolean, problems: LayerProblem[]) {
    sourceMissing = missing;
    layerNote = problems.find((p) => p.status)?.status ?? '';
    for (const p of problems) {
        if (layerTold.has(p.what))
            continue;
        layerTold.add(p.what);
        await report($, p.what, false, null);
    }
    render($);
}
async function initLayers($: Engine) {
    const saved = (await $.store.get(kLayers()).catch(() => undefined)) as Layer[] | undefined;
    layers = Array.isArray(saved) ? saved : inForce.map((l) => ({ ...l }));
    const { next, missing, problems } = await readLayers($);
    layers = next;
    if (!missing)
        await storeSet($, kLayers(), layers).catch(() => undefined);
    await tellLayerProblems($, missing, problems);
}
async function refreshLayers($: Engine): Promise<boolean> {
    const { next, missing, problems } = await readLayers($);
    await tellLayerProblems($, missing, problems);
    if (sigOf(next) === sigOf(layers))
        return false;
    layers = next;
    await storeSet($, kLayers(), layers).catch(() => undefined);
    await debugDump($, 'layers-changed', { waiting: waitingKeys(), sizes: layers.map((l) => [l.key, l.text.length]) });
    render($);
    return true;
}
async function landLayers($: Engine, why: string) {
    if (!layersWaiting())
        return;
    const keys = waitingKeys();
    const note = layerChangeNote(noted ?? inForce, layers, why);
    noted = null;
    if (note)
        changeNote = changeNote ? `${changeNote}\n\n${note}` : note;
    inForce = layers.map((l) => ({ ...l }));
    await storeSet($, kInForce(), { session: sessionId, sig: sigOf(inForce), layers: inForce }).catch(() => undefined);
    $.ui.log(`layer change in force (${why}): ${keys.join(', ')}`, { to: 'transcript' });
    render($);
}
const sectionText = (l: Layer) => `# Havok context: ${l.title}\n\n${l.text.trim()}`;
export const CHANGE_LINES_MAX = 40;
export function layerChangeNote(before: {
    key: string;
    title?: string;
    text: string;
}[], after: {
    key: string;
    title?: string;
    text: string;
}[], why: string): string {
    const keys = [...new Set([...after.map((l) => l.key), ...before.map((l) => l.key)])];
    const linesOf = (t: string) => t.split(/\r?\n/).map((x) => x.trimEnd()).filter((x) => x.trim());
    const parts: string[] = [];
    for (const k of keys) {
        const was = (before.find((l) => l.key === k)?.text ?? '').trim();
        const now = (after.find((l) => l.key === k)?.text ?? '').trim();
        if (was === now)
            continue;
        const name = after.find((l) => l.key === k)?.title || before.find((l) => l.key === k)?.title || k;
        if (!was) {
            parts.push(`The ${k} layer is new in your context (${linesOf(now).length} lines, "${name}"): read it in your system prompt.`);
            continue;
        }
        if (!now) {
            parts.push(`The ${k} layer was removed from your context ("${name}"): its rules no longer apply.`);
            continue;
        }
        const left = new Map<string, number>();
        for (const l of linesOf(was))
            left.set(l, (left.get(l) ?? 0) + 1);
        const added: string[] = [];
        for (const l of linesOf(now)) {
            const n = left.get(l) ?? 0;
            if (n > 0)
                left.set(l, n - 1);
            else
                added.push(l);
        }
        const removed: string[] = [];
        for (const l of linesOf(was)) {
            const n = left.get(l) ?? 0;
            if (n > 0) {
                left.set(l, n - 1);
                removed.push(l);
            }
        }
        if (!added.length && !removed.length)
            continue;
        const rows = [...removed.map((l) => `removed: ${l}`), ...added.map((l) => `added: ${l}`)];
        const shown = rows.slice(0, CHANGE_LINES_MAX);
        if (rows.length > shown.length)
            shown.push(`(${rows.length - shown.length} more changed lines: the whole layer is in your system prompt)`);
        parts.push(`The ${k} layer changed:\n${shown.join('\n')}`);
    }
    if (!parts.length)
        return '';
    return `CONTEXT CHANGE (${why}): a new version of your context is in force.\n${parts.join('\n')}`;
}
export function takeChangeNote(): string {
    const n = changeNote;
    changeNote = '';
    return n;
}
type Align = {
    thinkingRows: Set<number>;
    carryRows: Set<number>;
    unknownRows: Map<number, string>;
    resultTypes: Map<string, string[]>;
    groupUnknown: Map<number, string>;
    thinkingTokens: number;
};
function align(rows: Row[], api: ApiMsg[]): Align {
    const out: Align = { thinkingRows: new Set(), carryRows: new Set(), unknownRows: new Map(), resultTypes: new Map(), groupUnknown: new Map(), thinkingTokens: 0 };
    for (const m of api) {
        if (m.role !== 'user')
            continue;
        for (const b of m.content) {
            if (b.type !== 'tool_result')
                continue;
            const c = b.content;
            const types = typeof c === 'string' ? ['text'] : Array.isArray(c) ? (c as ApiBlock[]).map((x) => x.type) : ['text'];
            out.resultTypes.set(String(b.tool_use_id), types);
        }
    }
    const apiA = api.filter((m) => m.role === 'assistant');
    const norm = (s: string) => s.replace(/\s+/g, '');
    const isTT = (b: ApiBlock | undefined) => !!b && (b.type === 'text' || b.type === 'tool_use');
    const isTh = (b: ApiBlock | undefined) => !!b && (b.type === 'thinking' || b.type === 'redacted_thinking');
    const byTool = new Map<string, [
        number,
        number
    ]>();
    const byText = new Map<string, [
        number,
        number
    ][]>();
    apiA.forEach((m, mi) => m.content.forEach((b, k) => {
        if (b.type === 'tool_use')
            byTool.set(String(b.id), [mi, k]);
        else if (b.type === 'text') {
            const key = norm(String(b.text ?? ''));
            if (key) {
                const l = byText.get(key) ?? [];
                l.push([mi, k]);
                byText.set(key, l);
            }
        }
        else if (isTh(b))
            out.thinkingTokens += Math.ceil(JSON.stringify(b).length / 4);
    }));
    const anchor = new Map<number, [
        number,
        number
    ]>();
    const textSeen = new Map<string, number>();
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.role !== 'assistant' || isEmptyAssistant(r))
            continue;
        let a: [
            number,
            number
        ] | undefined;
        if (r.toolUses.length)
            a = byTool.get(r.toolUses[0]!.tool_use_id);
        else {
            const key = norm(r.text);
            const n = textSeen.get(key) ?? 0;
            textSeen.set(key, n + 1);
            a = byText.get(key)?.[n];
        }
        if (!a)
            continue;
        anchor.set(i, a);
        const blocks = apiA[a[0]]!.content;
        const strange = blocks.filter((b) => !isTT(b) && !isTh(b)).map((b) => b.type);
        if (strange.length)
            out.groupUnknown.set(i, strange.join(','));
        if (a[1] > 0 && isTh(blocks[a[1] - 1]) && !(i > 0 && isEmptyAssistant(rows[i - 1]!)))
            out.carryRows.add(i);
    }
    for (let i = 0; i < rows.length; i++) {
        if (!isEmptyAssistant(rows[i]!))
            continue;
        let j = i;
        while (j + 1 < rows.length && isEmptyAssistant(rows[j + 1]!))
            j++;
        const run: number[] = [];
        for (let k = i; k <= j; k++)
            run.push(k);
        const next = anchor.get(j + 1);
        const prev = anchor.get(i - 1);
        let picked: (ApiBlock | undefined)[] | null = null;
        if (next && next[1] - run.length >= 0)
            picked = run.map((_, n) => apiA[next[0]]!.content[next[1] - run.length + n]);
        else if (prev)
            picked = run.map((_, n) => apiA[prev[0]]!.content[prev[1] + 1 + n]);
        run.forEach((row, n) => {
            const b = picked?.[n];
            if (!picked)
                out.unknownRows.set(row, 'not covered by the API form');
            else if (isTh(b))
                out.thinkingRows.add(row);
            else
                out.unknownRows.set(row, b ? b.type : 'rows and blocks do not line up');
        });
        i = j;
    }
    return out;
}
function inputSummary(tool: string, input: Record<string, unknown>): string {
    const pick = (k: string) => (typeof input[k] === 'string' ? String(input[k]) : '');
    const short = tool.startsWith('mcp__') ? tool.split('__').slice(1).join(':') : tool;
    const main = pick('command') || pick('file_path') || pick('path') || pick('pattern') || pick('url') || pick('description') || pick('query') || pick('prompt');
    return `${short} ${main || JSON.stringify(input)}`;
}
function lockAnswers(parts: Part[], rows: Row[], lastTurn: number, openTurn: boolean): number[] {
    const keepWarm = cfg?.idle.keepWarm ?? new RegExp(DEFAULT_KEEP_WARM, 'i');
    const real = new Map<number, boolean>();
    const byTurn = new Map<number, Part[]>();
    for (const p of parts) {
        const list = byTurn.get(p.turn) ?? [];
        list.push(p);
        byTurn.set(p.turn, list);
        if (p.kind !== 'prompt' || real.has(p.turn))
            continue;
        const text = rows[p.rows[0]!]!.text;
        real.set(p.turn, !keepWarm.test(text) && !hasIdleMark(text));
    }
    const turns = [...byTurn.keys()].filter((t) => real.get(t) !== false).sort((x, y) => x - y);
    if (!cfg?.locks)
        return turns;
    for (const [t, list] of byTurn) {
        if (real.get(t) === false)
            continue;
        for (let k = list.length - 1; k >= 0; k--) {
            const p = list[k]!;
            if (p.kind === 'prompt')
                continue;
            if (p.kind !== 'text')
                break;
            if (!p.locked)
                p.locked = REPLY_LOCK;
        }
    }
    const n = cfg?.lockRecentTurns ?? DEFAULT_RECENT_TURNS;
    const budget = cfg?.lockRecentTokens ?? DEFAULT_RECENT_TOKENS;
    const recent = [...byTurn.keys()].filter((t) => real.get(t) !== false && !(openTurn && t === lastTurn)).sort((x, y) => y - x).slice(0, n);
    let start = Infinity;
    let used = 0;
    for (const t of recent) {
        const cost = byTurn.get(t)!.reduce((s, p) => s + p.tokens, 0);
        if (start !== Infinity && used + cost > budget)
            break;
        used += cost;
        start = t;
    }
    for (const p of parts)
        if (!p.locked && p.turn >= start)
            p.locked = recentLock(n);
    return turns;
}
const unknownPart = (reason: string): Pick<Part, 'locked' | 'lossy'> => (cfg?.locks ? { locked: reason } : { lossy: reason });
const FIRST_MESSAGE_LOCK = 'first message of the conversation: the API needs a user message first';
export const SUMMARY_OPENING = /^This session is being continued from a previous conversation/;
export const OPENING_AFTER_SUMMARY = 'The opening of this conversation (an earlier summary) is archived; its note follows.';
function analyze(rows: Row[], api: ApiMsg[], openTurn: boolean): Analysis {
    const al = align(rows, api);
    const parts: Part[] = [];
    const rowPart = new Map<number, number>();
    const toolPart = new Map<string, Part>();
    const unknown: string[] = [];
    let turn = 0;
    let pendingThink: number[] = [];
    let link = 0;
    const add = (p: Omit<Part, 'id' | 'link'> & {
        link?: number;
    }): Part => {
        const part: Part = { ...p, id: parts.length + 1, link: p.link ?? ++link };
        parts.push(part);
        for (const i of part.rows)
            rowPart.set(i, part.id);
        return part;
    };
    const flushThink = () => {
        if (!pendingThink.length)
            return;
        const prev = parts[parts.length - 1];
        if (prev && prev.kind !== 'prompt' && rows[pendingThink[0]! - 1]?.role === 'assistant') {
            prev.rows.push(...pendingThink);
            for (const i of pendingThink)
                rowPart.set(i, prev.id);
        }
        else {
            add({ kind: 'text', rows: [...pendingThink], tokens: 0, label: '(saved reasoning only)', turn });
        }
        pendingThink = [];
    };
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        if (r.role === 'user') {
            flushThink();
            const results = r.toolResults ?? [];
            const owners = new Set<number>();
            for (const tr of results) {
                const p = toolPart.get(tr.tool_use_id);
                if (p) {
                    if (!p.rows.includes(i))
                        p.rows.push(i);
                    rowPart.set(i, p.id);
                    p.tokens += est(tr.text);
                    p.label = `${p.label}, result: ${safeLabel(tr.text, 50)}`;
                    const types = al.resultTypes.get(tr.tool_use_id) ?? [];
                    if (types.some((t) => t === 'tool_reference' || t === 'tool_addition'))
                        p.locked = 'loads a tool (tool_reference)';
                    else if (types.some((t) => t !== 'text' && t !== 'image')) {
                        Object.assign(p, unknownPart('unknown block: ' + types.join(',')));
                        unknown.push(`part ${p.id}: result block types ${types.join(',')}`);
                    }
                    owners.add(p.link);
                }
                else {
                    add({ kind: 'other', rows: [i], tokens: est(tr.text), label: 'result without its call', turn, ...unknownPart('result without its call') });
                }
            }
            if (owners.size > 1) {
                const target = [...owners][0]!;
                for (const p of parts)
                    if (owners.has(p.link))
                        p.link = target;
            }
            if (!results.length) {
                turn++;
                if (r.text)
                    add({ kind: 'prompt', rows: [i], tokens: est(r.text), label: safeLabel(r.text, 90), turn, ...(cfg?.locks ? { locked: WORDS_LOCK } : {}) });
                else
                    add({ kind: 'other', rows: [i], tokens: 0, label: 'message without text (image or unknown)', turn, ...unknownPart('unknown user content') });
            }
            else if (r.text) {
                add({ kind: 'prompt', rows: [i], tokens: est(r.text), label: safeLabel(r.text, 90), turn, ...(cfg?.locks ? { locked: WORDS_LOCK } : {}) });
            }
            continue;
        }
        if (isEmptyAssistant(r)) {
            if (al.thinkingRows.has(i)) {
                pendingThink.push(i);
                continue;
            }
            flushThink();
            const why = al.unknownRows.get(i) ?? 'unknown';
            add({ kind: 'other', rows: [i], tokens: 0, label: 'assistant block: ' + why, turn, ...unknownPart('unknown block') });
            continue;
        }
        if (r.toolUses.length) {
            const shared = r.toolUses.length > 1 ? ++link : undefined;
            r.toolUses.forEach((u, n) => {
                const rowsOf = n === 0 ? [...pendingThink, i] : [i];
                const p = add({
                    kind: u.tool === NOTE_TOOL ? 'archived' : 'tool', tool: u.tool, rows: rowsOf, turn,
                    tokens: est(JSON.stringify(u.input)) + (n === 0 ? est(r.text) : 0),
                    label: safeLabel(inputSummary(u.tool, u.input), 70),
                    ...(shared !== undefined ? { link: shared } : {}),
                });
                toolPart.set(u.tool_use_id, p);
            });
            pendingThink = [];
        }
        else {
            const kind = r.text.startsWith(NOTE_PREFIX) ? 'archived' : 'text';
            add({ kind, rows: [...pendingThink, i], tokens: est(r.text), label: safeLabel(r.text, 90), turn });
            pendingThink = [];
        }
        const gu = al.groupUnknown.get(i);
        if (gu) {
            const p = parts[parts.length - 1]!;
            Object.assign(p, unknownPart('unknown block: ' + gu));
            unknown.push(`part ${p.id}: assistant block types ${gu}`);
        }
    }
    flushThink();
    for (const p of parts) {
        if ((p.kind === 'tool' || p.kind === 'archived') && p.tool && p.rows.every((i) => rows[i]!.role === 'assistant') && !p.locked)
            p.locked = 'waiting for its result';
        if (openTurn && p.turn === turn && !p.locked)
            p.locked = 'current turn';
    }
    const realTurns = lockAnswers(parts, rows, turn, openTurn);
    lockNotes(parts, cfg?.idle.floorTokens ?? 0);
    if (parts[0]?.kind === 'prompt' && !parts[0].locked && !SUMMARY_OPENING.test(rows[parts[0].rows[0]!]?.text ?? ''))
        parts[0].locked = FIRST_MESSAGE_LOCK;
    const lockedLinks = new Map<number, string>();
    for (const p of parts)
        if (p.locked && p.kind !== 'prompt')
            lockedLinks.set(p.link, p.locked);
    for (const p of parts)
        if (!p.locked && lockedLinks.has(p.link))
            p.locked = 'shares a message with a locked part';
    return {
        rows, parts, rowPart,
        thinkingRows: al.thinkingRows, carryRows: al.carryRows, unknownRows: al.unknownRows,
        thinkingTokens: al.thinkingTokens, lastTurn: turn, unknown, resultTypes: al.resultTypes, realTurns,
    };
}
export function currentStart(rows: readonly Row[], recorded: readonly string[]): number {
    if (!recorded.length || rows.length <= recorded.length)
        return 0;
    const n = Math.min(3, recorded.length);
    const keys = rows.map(rowKey);
    for (let k = rows.length - recorded.length; k > 0; k--) {
        let ok = true;
        for (let j = 0; j < n && ok; j++)
            ok = keys[k + j] === recorded[j];
        if (ok)
            return k;
    }
    return 0;
}
async function readNow($: Engine, openTurn: boolean): Promise<Analysis> {
    let rows = await $.session.messages();
    const clean = await loadClean($).catch(() => undefined);
    const cut = clean?.keys?.length ? currentStart(rows, fromSeam(clean)) : 0;
    if (cut > 0)
        rows = rows.slice(cut);
    const api = (await $.session.messages({ as: 'api' })) as unknown as ApiMsg[];
    await debugDump($, 'map-rows', { listed: cut + rows.length, cut, keys: rows.map(rowKey) });
    return analyze(rows, api, openTurn);
}
async function readState<T>($: Engine, path: string): Promise<T | undefined> {
    if (!(await $.fs.exists(path)))
        return undefined;
    const text = await $.fs.read(path);
    try {
        return JSON.parse(text) as T;
    }
    catch {
        return undefined;
    }
}
async function writeState($: Engine, path: string, value: unknown) {
    const text = JSON.stringify(value);
    await $.fs.write(path, text);
    if ((await $.fs.read(path)) !== text)
        throw new Error(`${path} does not hold what was written`);
}
async function loadClean($: Engine): Promise<CleanList | undefined> {
    const found = await readState<CleanList>($, cleanPath());
    if (found)
        return found;
    const old = (await $.store.get(kClean())) as CleanList | undefined;
    if (!old)
        return undefined;
    await writeState($, cleanPath(), old);
    await storeDelete($, kClean());
    return old;
}
async function saveClean($: Engine, v: CleanList) { await writeState($, cleanPath(), v); }
async function loadPending($: Engine): Promise<Pending> {
    const p = (await $.store.get(kPending())) as Partial<Pending> | undefined;
    return { archives: p?.archives ?? [], keeps: p?.keeps ?? [] };
}
async function savePending($: Engine, p: Pending) {
    if (!p.archives.length && !p.keeps.length)
        await storeDelete($, kPending());
    else
        await storeSet($, kPending(), p);
}
function parseIds(spec: string, max: number): number[] | string {
    const ids = new Set<number>();
    for (const raw of spec.split(/[,\s]+/).filter(Boolean)) {
        const m = /^#?(\d+)(?:\s*-\s*#?(\d+))?$/.exec(raw);
        if (!m)
            return `cannot read "${raw}": use ids and ranges like 12-20, 25`;
        const a = Number(m[1]);
        const b = m[2] ? Number(m[2]) : a;
        if (a < 1 || b < a || b > max)
            return `range ${raw} is outside the map (1 to ${max})`;
        for (let k = a; k <= b; k++)
            ids.add(k);
    }
    return [...ids].sort((x, y) => x - y);
}
const fmtIds = (ids: number[]) => {
    const out: string[] = [];
    let s = ids[0]!;
    let prev = s;
    for (const n of ids.slice(1).concat([-1])) {
        if (n === prev + 1) {
            prev = n;
            continue;
        }
        out.push(s === prev ? `#${s}` : `#${s}-#${prev}`);
        s = n;
        prev = n;
    }
    return out.join(', ');
};
const VALUE_PATTERNS: [
    string,
    RegExp
][] = [
    ['url', /\bhttps?:\/\/(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#][^\s"'`<>)\]}|]*)?/g],
    ['email', /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g],
    ['winpath', /\b[A-Za-z]:[\\/][^\s"'`<>|*?,;()]+/g],
    ['path', /(?:~|\.{1,2})?\/?(?:[\w.@-]+\/)+[\w.@-]+/g],
    ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
    ['datetime', /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?(?:\s?UTC)?/g],
    ['time', /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:UTC|GMT|Z\b|am\b|pm\b)/gi],
    ['ip', /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g],
    ['version', /\bv?\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/g],
    ['money', /\$\d[\d,]*\.\d+|\$\d{2,}[\d,]*|[€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|MAD|DH|Dhs?|dirhams?|euros?|dollars?|HT|TTC)\b|\b(?:USD|EUR|GBP|MAD)\s?\d[\d,]*(?:\.\d+)?/g],
    ['dims', /\b\d+(?:\.\d+)?\s?[x×]\s?\d+(?:\.\d+)?(?:\s?(?:cm|mm|m)\b)?/g],
    ['unit', /\b\d[\d,]*(?:\.\d+)?\s?(?:%|(?:percent|ms|s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?|days?|weeks?|months?|KB|MB|GB|TB|KiB|MiB|GiB|bytes?|k|tokens?|chars?|characters?|lines?|rows?|files?|records?|messages?|steps?|calls?|points?|cm|mm|km|kg)\b)/g],
    ['ratio', /\b\d+(?:\.\d+)?\s?\/\s?\d+\b/g],
    ['status', /\b(?:HTTP|status|error|code|exit code|exit)\s*[:=]?\s*\d{1,3}\b|\b[45]\d{2}\s(?:Too Many Requests|Forbidden|Not Found|Unauthorized|Bad Request|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Conflict)\b/gi],
    ['errno', /\bE(?:NOENT|ACCES|PERM|EXIST|NOTDIR|ISDIR|CONNREFUSED|CONNRESET|CONNABORTED|TIMEDOUT|NOTFOUND|ADDRINUSE|PIPE|BUSY|MFILE|NOTEMPTY|AI_AGAIN|HOSTUNREACH)\b|\b0x[0-9A-Fa-f]{4,}\b|\b[A-Z][A-Za-z]+(?:Error|Exception)\b/g],
    ['const', /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g],
    ['snake', /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}\b/g],
    ['issue', /#\d{3,}\b/g],
    ['hash', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g],
    ['id', /\b(?=[\w-]*\d[\w-]*\d)(?=[\w-]*[A-Za-z])[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*\b/g],
    ['decimal', /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d+\b/g],
    ['longnum', /\b\d{5,}\b/g],
];
const LONG_RUN = /\S{200,}/g;
const SECRET_NAMES = 'password|passwd|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?|authorization|cookie|signature|sig';
const SECRET_RULES: [
    RegExp,
    number
][] = [
    [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, 0],
    [/\b(?:sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,})/g, 0],
    [/(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+:[^\s/@]+)(?=@)/gi, 2],
    [new RegExp(`(\\b(?:[A-Za-z0-9]+[_-])*(?:${SECRET_NAMES})["']?\\s*[:=]\\s*["']?(?:(?:Bearer|Basic|Token)\\s+)?)([^\\s"'&;,]{3,})`, 'gi'), 2],
    [/((?:^|\s)--?(?:password|passwd|token|secret|api[_-]?key)[ \t]+["']?)([^\s"']{3,})/gi, 2],
    [/(?<![0-9A-Za-z])(?:[0-9a-f]{41,}|[0-9A-F]{41,})(?![0-9A-Za-z])/g, 0],
    [/(?<![A-Za-z0-9+/=])(?=[A-Za-z0-9+/=]*[+/])(?=[A-Za-z0-9+/=]*[A-Z])(?=[A-Za-z0-9+/=]*[a-z])(?=[A-Za-z0-9+/=]*\d)[A-Za-z0-9+/]{32,}={0,2}/g, 0],
    [/(?<![A-Za-z0-9+_=-])(?=[A-Za-z0-9+_=-]*[A-Z])(?=[A-Za-z0-9+_=-]*[a-z])(?=[A-Za-z0-9+_=-]*\d)[A-Za-z0-9+_=-]{32,}/g, 0],
];
const blankFill = (m: string) => ' '.repeat(m.length);
const secretFill = () => '[secret]';
export function blankSecrets(text: string, fill: (m: string) => string = blankFill): string {
    let t = String(text ?? '').replace(LONG_RUN, fill);
    for (const [re, g] of SECRET_RULES)
        t = t.replace(re, (...m: string[]) => (g ? m.slice(1, g).join('') + fill(m[g] ?? '') : fill(m[0]!)));
    return t;
}
const safeLabel = (s: string, n: number) => oneLine(blankSecrets(oneLine(s, 400), secretFill), n);
const FILE_TEXT_KEYS = new Set(['content', 'new_string', 'old_string', 'new_source', 'edits']);
const valueKey = (s: string) => s.toLowerCase().replace(/\\/g, '/').replace(/[\s,]/g, '');
const NOISE = /[\\/]AppData[\\/]Local[\\/]Temp[\\/]|^\/dev\/null$|^\d\s?(?:files?|lines?|rows?|records?|messages?|steps?|calls?|points?|chars?|characters?|tokens?)$/i;
export function exactValues(text: string): string[] {
    let t = blankSecrets(text);
    const found: string[] = [];
    for (const [kind, re] of VALUE_PATTERNS) {
        t = t.replace(re, (m) => {
            const v = m.replace(/[.,;:!?'")\]]+$/, '');
            if (kind === 'path') {
                const segs = v.split('/').filter(Boolean);
                if (segs.length < 2 || !segs.some((s) => /[A-Za-z]/.test(s)))
                    return m;
                const rooted = /^[~./]/.test(v);
                if (!rooted && !(/\.[A-Za-z0-9]{1,5}$/.test(v) || segs.length >= 3 || segs.some((s) => /[-_.]/.test(s))))
                    return m;
            }
            if (kind === 'id' && v.length < 5)
                return m;
            if (v && !NOISE.test(v))
                found.push(v);
            return ' '.repeat(m.length);
        });
    }
    return found;
}
const inputText = (input: Record<string, unknown>) => Object.entries(input ?? {}).filter(([k]) => !FILE_TEXT_KEYS.has(k)).map(([, v]) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 3) + '...' : s);
const EXIT_LINE = /^exit code\s+(-?\d+)/i;
const ERROR_WORDS = /\b(?:error|failed|failure|fatal|denied|refused|not found|cannot|can't|unable|exception|traceback|timed out|ENOENT|EACCES|EPERM|ECONNREFUSED)\b/i;
function failureLine(text: string, isError: boolean): string | null {
    const lines = blankSecrets(text, secretFill).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const exit = lines.find((l) => EXIT_LINE.test(l));
    const failed = isError || (exit !== undefined && Number(EXIT_LINE.exec(exit)![1]) !== 0) || /^(?:error|fatal|traceback)\b/i.test(lines[0] ?? '');
    if (!failed)
        return null;
    const line = lines.find((l) => !EXIT_LINE.test(l) && ERROR_WORDS.test(l)) ?? lines.find((l) => !EXIT_LINE.test(l)) ?? '(no output)';
    return (exit ? `${exit}: ` : '') + clip(line, ERROR_LINE_CHARS);
}
function errorsField(a: Analysis, parts: Part[], note: string): {
    text: string;
    shown: number;
    more: number;
} {
    const inNote = valueKey(note);
    const calls = new Map<string, string>();
    const found: string[] = [];
    for (const p of parts) {
        for (const i of p.rows) {
            const r = a.rows[i]!;
            for (const u of r.toolUses)
                calls.set(u.tool_use_id, clip(safeLabel(inputSummary(u.tool, u.input), ERROR_COMMAND_CHARS), ERROR_COMMAND_CHARS));
            for (const t of r.toolResults ?? []) {
                const line = failureLine(t.text, t.isError);
                if (!line)
                    continue;
                const bare = line.replace(EXIT_LINE, '').replace(/^:\s*/, '');
                if (inNote.includes(valueKey(bare)))
                    continue;
                const exit = EXIT_LINE.exec(line)?.[0];
                found.push(`${calls.get(t.tool_use_id) ?? 'a call'}: ${exit ? exit + ', ' : ''}tool output: "${bare.replace(/"/g, "'")}"`);
            }
        }
    }
    const shown = found.slice(0, ERRORS_SHOWN);
    const more = found.length - shown.length;
    return { text: shown.length ? shown.join('; ') + (more ? ` (+${more} more failed calls in the archive)` : '') : '', shown: shown.length, more };
}
function valuesField(a: Analysis, parts: Part[], already: string): {
    text: string;
    added: number;
    more: number;
} {
    const inNote = valueKey(already);
    const stays = new Set<string>();
    const taking = new Set(parts.map((p) => p.id));
    for (const p of a.parts) {
        if (taking.has(p.id) || (p.kind !== 'prompt' && p.kind !== 'text'))
            continue;
        for (const i of p.rows)
            for (const v of exactValues(a.rows[i]!.text))
                stays.add(valueKey(v));
    }
    const seen = new Set<string>();
    const fresh = (v: string) => {
        const k = valueKey(v);
        if (!k || seen.has(k) || stays.has(k) || inNote.includes(k))
            return false;
        seen.add(k);
        return true;
    };
    const own: string[] = [];
    const perPart: string[][] = [];
    for (const p of parts) {
        const tools: string[] = [];
        for (const i of p.rows) {
            const r = a.rows[i]!;
            if (r.role === 'assistant') {
                own.push(...exactValues(r.text));
                for (const u of r.toolUses)
                    tools.push(...exactValues(inputText(u.input)));
            }
            else {
                for (const t of r.toolResults ?? [])
                    tools.push(...exactValues(t.text));
            }
        }
        perPart.push(tools);
    }
    const ordered = own.filter(fresh);
    const queues = perPart.map((l) => l.filter(fresh));
    for (let k = 0; queues.some((q) => k < q.length); k++)
        for (const q of queues)
            if (k < q.length)
                ordered.push(q[k]!);
    const archivedChars = parts.reduce((s, p) => s + p.tokens, 0) * CHARS_PER_TOKEN;
    const cap = Math.min(VALUES_MAX_CHARS, Math.max(VALUES_MIN_CHARS, Math.round(archivedChars * VALUES_SHARE)));
    let body = '';
    let added = 0;
    for (const v of ordered) {
        const next = added ? `${body}; ${v}` : v;
        if (next.length > cap)
            continue;
        body = next;
        added++;
    }
    const more = ordered.length - added;
    return { text: added ? `${body}${more ? ` (+${more} more in the archive)` : ''}` : '', added, more };
}
function composeNote(a: Analysis, parts: Part[], outcome: string) {
    const errors = errorsField(a, parts, outcome);
    const values = valuesField(a, parts, outcome + ' ' + errors.text);
    const end = (s: string) => (/[.!?]$/.test(s) ? s : s + '.');
    const note = `Outcome: ${end(outcome)} ${VALUES_LABEL} ${end(values.text || 'none left out')} Errors: ${end(errors.text || 'none')}`;
    return { note, values, errors };
}
export const NOTE_LOCK = 'an earlier note (notes are not folded into notes while they stay under the floor)';
export function lockNotes(parts: {
    kind: string;
    tokens: number;
    locked?: string;
}[], floor: number): void {
    const notes = parts.filter((p) => p.kind === 'archived' && !p.locked);
    let excess = notes.reduce((n, p) => n + p.tokens, 0) - floor;
    for (const p of notes) {
        if (excess > 0) {
            excess -= p.tokens;
            continue;
        }
        p.locked = NOTE_LOCK;
    }
}
export function renderNote(archive: string, parts: number[], what: string, tokens: number, note: string): string {
    return `${NOTE_PREFIX}${archive}. I archived ${fmtIds(parts)} here with context_archive (${what}, about ${kfmt(tokens)} tokens). ${note} Restore: context_restore ${archive} brings back the full text.`;
}
export function checkNote(text: string): string[] {
    const missing: string[] = [];
    let at = 0;
    for (const f of NOTE_FIELDS) {
        const k = text.indexOf(` ${f}: `, at);
        if (k < 0)
            missing.push(f);
        else
            at = k + f.length + 2;
    }
    return missing;
}
function ageOf(p: Part, last: number) {
    const d = last - p.turn;
    return d === 0 ? 'this turn' : d === 1 ? '1 turn ago' : `${d} turns ago`;
}
function candidatesLine(a: Analysis): string {
    const big = a.parts.filter((p) => p.kind === 'tool' && !p.locked && p.tokens >= MAP_SMALL_TOKENS)
        .sort((x, y) => y.tokens - x.tokens || x.turn - y.turn).slice(0, MAP_CANDIDATES);
    if (!big.length)
        return 'Biggest archivable tool outputs: none over the small-part size.';
    return `Biggest archivable tool outputs (a suggestion; you decide): ${big.map((p) => `#${p.id} (${kfmt(p.tokens)} tokens, ${ageOf(p, a.lastTurn)}, ${p.tool!.replace(/^mcp__/, '')})`).join('; ')}.`;
}
const saves = (tokens: number) => Math.max(0, tokens - NOTE_COST_TOKENS);
type Restored = Record<string, {
    n: number;
    partial: number;
    last: number;
    tokens: number;
}>;
function restoredLine(h: Restored): string {
    const list = Object.entries(h).sort((x, y) => Number(x[0].slice(1)) - Number(y[0].slice(1)));
    if (!list.length)
        return 'Brought back this session: nothing yet.';
    const each = list.map(([id, r]) => `${id} x${r.n} (${r.partial ? r.partial + ' of them partial; ' : ''}last ${new Date(r.last).toISOString().slice(0, 16).replace('T', ' ')} UTC; its full text is about ${kfmt(r.tokens)} tokens)`);
    return `Brought back this session: ${each.join('; ')}. A bring-back puts its text at the end of the conversation again, where it stays until the next clean-up.`;
}
async function notesBlock($: Engine): Promise<string> {
    const path = cfg!.notesFile;
    let text = '';
    try {
        if (!(await $.fs.exists(path))) {
            return `Your clean-up notes: ${path} does not exist yet. It is yours: create it with your file tools and write what you learn about what to keep and what to drop for your kind of work; the mod shows it here at the top of every map and only adds one dated line after each clean-up saying what followed it.`;
        }
        text = (await $.fs.read(path)).trim();
    }
    catch (err) {
        return `Your clean-up notes: ${path} could not be read right now (${String(err).slice(0, 100)}).`;
    }
    if (!text)
        return `Your clean-up notes: ${path} is empty. Write there what you learn about what to keep and what to drop; it is shown here at the top of every map.`;
    const cut = text.length > NOTES_SHOW_CHARS;
    return `Your clean-up notes (${path}; you write this file, the mod shows it and adds one dated line per clean-up${cut ? `; showing the first ${NOTES_SHOW_CHARS} of ${text.length} characters, read the rest with your file tools` : ''}):\n${cut ? text.slice(0, NOTES_SHOW_CHARS) : text}\n---`;
}
const rulesLine = () => cfg?.locks
    ? `Rules: archive finished work you will not need word for word, in one batch; a tool call is archived with its result; locked: words from the user, your reply that ends each turn (what you told them), everything in the last ${cfg?.lockRecentTurns ?? DEFAULT_RECENT_TURNS} turns (keep-warm pings not counted) and the current turn; each note becomes Outcome (yours), Exact values and Errors (the mod adds the numbers with units, paths, ids, hashes, error codes, URLs, amounts and failed commands your note leaves out), Restore; an archive applies when this turn ends; context_restore brings any archive back.`
    : `What you can archive: everything except the turn in progress, a call still waiting for its result and the first message of the conversation. That includes the user's words and your own replies, which then survive only as your note: Outcome (yours), Exact values and Errors (the mod adds the numbers with units, paths, ids, hashes, error codes, URLs, amounts and failed commands your note leaves out) and Restore. A tool call is archived with its result. An archive applies when this turn ends. context_restore brings any archive back, or only the lines you search for (search) or name (lines).`;
function mapText(a: Analysis, pend: Pending, ctxTokens: number | undefined, from: number, to: number, all: boolean, restored: Restored = {}, history: History = { cleanups: [], baseline: 0 }): string {
    const archivable = a.parts.filter((p) => !p.locked);
    const total = a.parts.reduce((s, p) => s + p.tokens, 0) + a.thinkingTokens;
    const head = [
        `Context map of this session (${stamp().slice(0, 16)} UTC, ${PLUGIN} ${VERSION}).`,
        `Context now: ${ctxTokens ? kfmt(ctxTokens) + ' tokens (last request)' : 'unknown'}; conversation parts estimated at ${kfmt(total)} tokens, of which saved reasoning about ${kfmt(a.thinkingTokens)}.`,
        `Parts: ${a.parts.length}; can be archived now: ${archivable.length} (about ${kfmt(archivable.reduce((s, p) => s + p.tokens, 0))} tokens).`,
        `Layers in force: ${inForce.filter((l) => l.text.trim()).map((l) => `${l.key} ${kfmt(est(l.text))}`).join(', ') || 'none'}.` +
            (layersWaiting() ? ` A newer version of ${waitingKeys().join(', ')} is waiting; it lands at your next clean-up${urgentWaiting() ? ' (marked urgent: at once)' : ''}.` : ''),
        ...(S.guarded === true ? [`Clean-up is off in this session: ${GUARD_REASON}. You can read this map and restore archives; archiving and keeping are refused.`] : []),
        pend.archives.length || pend.keeps.length ? `Waiting for the end of this turn: ${pend.archives.map((f) => `${f.archive} (${fmtIds(f.parts.map((p) => p.id))})`).join(', ') || 'no archives'}${pend.keeps.length ? `, ${pend.keeps.length} keep(s)` : ''}.` : 'Nothing waiting.',
        rulesLine(),
        restoredLine(restored),
        outcomesLine(history),
        `Saves: tokens minus about ${NOTE_COST_TOKENS} for the note that takes a part's place (joined parts share one note). A bring-back costs the full text again, a search or a line range only what it returns.`,
        costLine(a),
        candidatesLine(a),
        'id | turn (age) | kind | tokens | saves if archived | label | lock',
    ];
    const lines: string[] = [];
    const shown = a.parts.filter((p) => p.id >= from && p.id <= to);
    const compress = !all && shown.length > MAP_COMPRESS_OVER;
    for (let n = 0; n < shown.length; n++) {
        const p = shown[n]!;
        if (compress && !p.locked && p.tokens < MAP_SMALL_TOKENS) {
            let m = n;
            while (m + 1 < shown.length) {
                const q = shown[m + 1]!;
                if (q.locked || q.tokens >= MAP_SMALL_TOKENS || q.turn !== p.turn)
                    break;
                m++;
            }
            if (m > n) {
                const run = shown.slice(n, m + 1);
                const kinds = new Map<string, number>();
                for (const q of run) {
                    const k = q.kind === 'tool' ? q.tool!.replace(/^mcp__/, '') : q.kind;
                    kinds.set(k, (kinds.get(k) ?? 0) + 1);
                }
                const runTokens = run.reduce((s, q) => s + q.tokens, 0);
                lines.push(`#${p.id}-#${shown[m]!.id} | t${p.turn} (${ageOf(p, a.lastTurn)}) | ${run.length} small parts | ${kfmt(runTokens)} | ${kfmt(saves(runTokens))} | ${[...kinds].map(([k, c]) => `${k} x${c}`).join(', ')} |`);
                n = m;
                continue;
            }
        }
        const kind = p.kind === 'tool' ? 'tool:' + p.tool!.replace(/^mcp__/, '') : p.kind;
        const linked = a.parts.filter((q) => q.link === p.link && q.id !== p.id).map((q) => q.id);
        const lock = p.locked ? `LOCKED (${p.locked})` : p.lossy ? `holds content the archive cannot store word for word (${p.lossy})` : linked.length ? `joined with ${fmtIds(linked)}` : '';
        lines.push(`#${p.id} | t${p.turn} (${ageOf(p, a.lastTurn)}) | ${kind} | ${kfmt(p.tokens)} | ${p.locked ? '-' : kfmt(saves(p.tokens))} | ${p.label} | ${lock}`);
    }
    if (a.unknown.length)
        lines.push(`Unknown blocks left in place: ${a.unknown.slice(0, 5).join('; ')}`);
    return [...head, ...lines].join('\n');
}
const utf8Bytes = (s: string) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3;
    }
    return n;
};
async function archiveFiles($: Engine): Promise<string[]> {
    const c = cfg!;
    const num = (name: string) => Number(/\.(\d+)\.jsonl$/.exec(name)?.[1] ?? 1);
    try {
        const list = await $.fs.list(c.archiveDir);
        return list.filter((e) => e.name.startsWith(sessionId) && e.name.endsWith('.jsonl'))
            .sort((x, y) => num(x.name) - num(y.name)).map((e) => `${c.archiveDir}/${e.name}`);
    }
    catch {
        return [];
    }
}
export function splitRecords(lines: string[], max: number): string[] {
    const chunks: string[] = [];
    let cur = '';
    for (const l of lines) {
        const piece = l + '\n';
        if (cur && utf8Bytes(cur) + utf8Bytes(piece) > max) {
            chunks.push(cur);
            cur = '';
        }
        cur += piece;
    }
    if (cur)
        chunks.push(cur);
    return chunks;
}
async function writeArchiveRecords($: Engine, records: Record<string, unknown>[]) {
    const c = cfg!;
    const chunks = splitRecords(records.map((r) => JSON.stringify(r)), ARCHIVE_FILE_MAX);
    const pathOf = (k: number) => (k === 1 ? `${c.archiveDir}/${sessionId}.jsonl` : `${c.archiveDir}/${sessionId}.${k}.jsonl`);
    let n = (await archiveFiles($)).length + 1;
    const paths: string[] = [];
    for (const add of chunks) {
        if (utf8Bytes(add) > ARCHIVE_FILE_MAX)
            throw new Error(`one archive is ${utf8Bytes(add)} bytes, over ${ARCHIVE_FILE_MAX}`);
        while (await $.fs.exists(pathOf(n)))
            n++;
        const path = pathOf(n);
        await $.fs.write(path, add);
        if ((await $.fs.read(path)) !== add)
            throw new Error(`${path} does not hold what was written`);
        paths.push(path);
        n++;
    }
    return paths.join(', ');
}
async function highestArchiveId($: Engine): Promise<number> {
    let top = 0;
    for (const f of await archiveFiles($)) {
        let text = '';
        try {
            text = await $.fs.read(f);
        }
        catch {
            continue;
        }
        for (const m of text.matchAll(/"archive":"A(\d+)"/g))
            top = Math.max(top, Number(m[1]));
    }
    return top;
}
export function notesInConversation(rows: readonly Row[]): Map<string, string> {
    const notes = new Map<string, string>();
    const byTool = new Map<string, string>();
    for (const r of rows) {
        for (const u of r.toolUses ?? []) {
            const id = String((u.input as {
                archive?: unknown;
            } | undefined)?.archive ?? '');
            if (u.tool === NOTE_TOOL && /^A\d+$/.test(id))
                byTool.set(u.tool_use_id, id);
        }
        for (const t of r.toolResults ?? []) {
            const id = byTool.get(t.tool_use_id);
            if (id)
                notes.set(id, String(t.text ?? ''));
        }
        const m = /^.{0,40}?\b(A\d+)\b/.exec(r.text ?? '');
        if (m && String(r.text ?? '').startsWith(NOTE_PREFIX))
            notes.set(m[1]!, String(r.text));
    }
    return notes;
}
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
export function noteMatches(rec: Record<string, unknown>, shown: string): boolean {
    const own = squash(String(rec.note ?? '')).slice(0, 160);
    return own.length >= 20 && squash(shown).includes(own);
}
async function otherSessionFiles($: Engine): Promise<string[]> {
    const c = cfg!;
    try {
        const list = await $.fs.list(c.archiveDir);
        return list.filter((e) => e.kind === 'file' && /\.jsonl$/.test(e.name) && !e.name.startsWith(sessionId)).map((e) => `${c.archiveDir}/${e.name}`);
    }
    catch {
        return [];
    }
}
async function findArchive($: Engine, id: string, shown?: string): Promise<Record<string, unknown> | null> {
    const own = await findIn($, (await archiveFiles($)).reverse(), id);
    if (own && (!shown || noteMatches(own, shown)))
        return own;
    if (!shown)
        return own;
    return (await findIn($, await otherSessionFiles($), id, shown)) ?? own;
}
async function findIn($: Engine, files: string[], id: string, shown?: string): Promise<Record<string, unknown> | null> {
    for (const f of files) {
        let text = '';
        try {
            text = await $.fs.read(f);
        }
        catch {
            continue;
        }
        for (const line of text.split('\n').reverse()) {
            if (!line.includes(`"archive":"${id}"`))
                continue;
            try {
                const rec = JSON.parse(line) as Record<string, unknown>;
                if (rec.archive === id && (!shown || noteMatches(rec, shown)))
                    return rec;
            }
            catch { }
        }
    }
    return null;
}
const plainRow = (r: Row) => ({
    role: r.role,
    text: r.text,
    toolUses: r.toolUses.map((u) => ({ tool_use_id: u.tool_use_id, tool: u.tool, input: u.input, ...(u.text !== undefined ? { text: u.text } : {}), ...(u.isError ? { isError: true } : {}) })),
    ...(r.toolResults ? { toolResults: r.toolResults.map((t) => ({ tool_use_id: t.tool_use_id, text: t.text, isError: t.isError })) } : {}),
});
export function locate(rows: readonly Row[], f: PendingArchive): number[] | null {
    const refs = f.parts.flatMap((p) => p.rows);
    if (!refs.length)
        return null;
    const fps = rows.map(fp);
    const tryOffset = (d: number) => refs.every((r) => fps[r.i + d] === r.fp);
    const cands = new Set<number>([0, rows.length - f.rowCount]);
    const anchor = refs.find((r) => !r.fp.startsWith('assistant|||') && !r.fp.startsWith('user|||'));
    if (anchor)
        fps.forEach((x, k) => {
            if (x === anchor.fp)
                cands.add(k - anchor.i);
        });
    for (const d of cands)
        if (tryOffset(d))
            return refs.map((r) => r.i + d);
    const seen = new Map<string, number[]>();
    fps.forEach((x, k) => {
        const l = seen.get(x);
        if (l)
            l.push(k);
        else
            seen.set(x, [k]);
    });
    const sorted = [...refs].sort((x, y) => x.i - y.i);
    const once = sorted.find((r) => seen.get(r.fp)?.length === 1);
    if (!once)
        return null;
    const shift = seen.get(once.fp)![0]! - once.i;
    const found = new Map<number, number>();
    let prev = -1;
    for (const r of sorted) {
        const want = r.i + shift;
        const ks = (seen.get(r.fp) ?? []).filter((k) => k > prev);
        if (!ks.length && r.fp === EMPTY_FP)
            continue;
        if (!ks.length)
            return null;
        const k = ks.reduce((best, x) => (Math.abs(x - want) < Math.abs(best - want) ? x : best));
        found.set(r.i, k);
        prev = k;
    }
    return refs.filter((r) => found.has(r.i)).map((r) => found.get(r.i)!);
}
type Built = {
    notesConverted: number;
    firstChange: number;
    riskAfterCut: number;
    messages: Row[];
    archived: {
        archive: string;
        parts: number[];
        tokens: number;
        note: string;
        toolIds: string[];
    }[];
    failed: string[];
    droppedThinking: number;
    rebuilt: number;
    keptUnknown: number;
    cut: number;
    thinkCut: number;
    tokensBefore: number;
    tokensAfter: number;
    mapsDropped: number;
    records: Record<string, unknown>[];
};
function buildCleanup(rows: Row[], a: Analysis, pend: Pending, dropAllThinking: boolean, restartSafe: boolean, freshPrompt = false): Built {
    const archRows = new Map<number, string>();
    const archived: Built['archived'] = [];
    const failed: string[] = [];
    const records: Record<string, unknown>[] = [];
    for (const f of pend.archives) {
        const idx = locate(rows, f);
        if (!idx) {
            failed.push(`${f.archive}: its parts are no longer in the conversation`);
            continue;
        }
        const partIds = [...new Set(idx.map((i) => a.rowPart.get(i)).filter((x): x is number => x !== undefined))];
        const parts = partIds.map((id) => a.parts[id - 1]!);
        const blocked = parts.filter((p) => p.locked && p.locked !== 'current turn');
        if (blocked.length) {
            failed.push(`${f.archive}: ${fmtIds(blocked.map((p) => p.id))} locked now (${blocked[0]!.locked})`);
            continue;
        }
        const rowsOf = parts.flatMap((p) => p.rows);
        if (rowsOf.some((i) => archRows.has(i))) {
            failed.push(`${f.archive}: overlaps another archive`);
            continue;
        }
        const tokens = parts.reduce((s, p) => s + p.tokens, 0);
        const record = {
            archive: f.archive, session: sessionId, agent: cfg?.agent, at: stamp(), note: f.note,
            parts: parts.map((p) => ({ id: p.id, kind: p.kind, tool: p.tool, label: p.label, tokens: p.tokens })),
            tokens, rows: [...rowsOf].sort((x, y) => x - y).map((i) => plainRow(rows[i]!)),
        };
        const bytes = utf8Bytes(JSON.stringify(record)) + 1;
        if (bytes > ARCHIVE_FILE_MAX) {
            failed.push(`${f.archive}: its text is ${bytes} bytes, over the ${ARCHIVE_FILE_MAX} an archive file holds; archive smaller ranges`);
            continue;
        }
        for (const i of rowsOf)
            archRows.set(i, f.archive);
        const toolIds = rowsOf.flatMap((i) => [...rows[i]!.toolUses.map((u) => u.tool_use_id), ...(rows[i]!.toolResults ?? []).map((t) => t.tool_use_id)]);
        archived.push({ archive: f.archive, parts: parts.map((p) => p.id), tokens, note: f.note, toolIds: [...new Set(toolIds)] });
        records.push(record);
    }
    const mapRows = new Set<number>();
    for (const p of a.parts) {
        if (p.kind !== 'tool' || p.tool !== TOOL_PREFIX + 'context_map')
            continue;
        for (const i of p.rows)
            if (rows[i]!.role === 'user' && !archRows.has(i))
                mapRows.add(i);
    }
    const cut = archRows.size ? Math.min(...archRows.keys()) : mapRows.size ? Math.min(...mapRows) : rows.length;
    const rebuildResults = new Set<number>();
    const riskRows: number[] = [];
    const resultExtra = new Map<string, string>();
    if (restartSafe) {
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i]!;
            if (r.role !== 'user' || !r.toolResults?.length || archRows.has(i) || mapRows.has(i))
                continue;
            rebuildResults.add(i);
            for (const t of r.toolResults) {
                const ty = a.resultTypes.get(t.tool_use_id) ?? ['text'];
                const images = ty.filter((x) => x === 'image').length;
                const loads = ty.filter((x) => x === 'tool_reference').length;
                const other = ty.filter((x) => x !== 'text' && x !== 'image' && x !== 'tool_reference');
                const extra: string[] = [];
                if (images)
                    extra.push(`[${images} image${images > 1 ? 's' : ''} not kept after the clean-up; the session file still holds ${images > 1 ? 'them' : 'it'}, and the full copy archived when it is slimmed]`);
                if (loads)
                    extra.push(`[this result loaded ${loads} deferred tool${loads > 1 ? 's' : ''}; after the clean-up load ${loads > 1 ? 'them' : 'it'} again with ToolSearch before calling]`);
                if (other.length)
                    extra.push(`[${other.join(', ')} block${other.length > 1 ? 's' : ''} not kept after the clean-up]`);
                if (extra.length) {
                    resultExtra.set(t.tool_use_id, extra.join(' '));
                    riskRows.push(i);
                }
            }
        }
    }
    const openEnd = freshPrompt ? rows.findIndex((r) => r.role === 'assistant' && !isEmptyAssistant(r)) : -1;
    const oldNotes = new Set<number>();
    if (archRows.size || mapRows.size) {
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i]!;
            if (r.role === 'assistant' && !archRows.has(i) && !r.toolUses.length && r.text.startsWith(NOTE_PREFIX) && /^archived: A\d+(\. I archived | continues here)/.test(r.text))
                oldNotes.add(i);
        }
    }
    let notesConverted = 0;
    const firstChange = freshPrompt ? 0 : Math.min(cut, oldNotes.size ? Math.min(...oldNotes) : rows.length, rebuildResults.size ? Math.min(...rebuildResults) : rows.length);
    const thinkCut = dropAllThinking || freshPrompt ? 0 : firstChange;
    const messages: Row[] = [];
    let droppedThinking = 0;
    let rebuilt = 0;
    let keptUnknown = 0;
    let mapsDropped = 0;
    const noted = new Set<string>();
    let runArch = '';
    let runHasNote = false;
    const putNote = (f: string) => {
        runHasNote = true;
        if (noted.has(f))
            return;
        noted.add(f);
        const info = archived.find((x) => x.archive === f)!;
        messages.push(...noteRows(f, info.tokens, noteText(info, a)));
    };
    const endRun = () => {
        if (runArch && !runHasNote)
            putNote(runArch);
        runArch = '';
        runHasNote = false;
    };
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]!;
        const f = archRows.get(i);
        if (f !== undefined) {
            if (f !== runArch) {
                endRun();
                runArch = f;
                runHasNote = false;
            }
            if (r.role === 'assistant' && !a.thinkingRows.has(i) && !runHasNote)
                putNote(f);
            continue;
        }
        endRun();
        if (oldNotes.has(i)) {
            const t = r.text;
            const m = NOTE_ROW.exec(t);
            if (m)
                messages.push(...noteRows(m[1]!, 0, t, m[2]!));
            notesConverted++;
            continue;
        }
        if (i <= openEnd) {
            if (isEmptyAssistant(r)) {
                if (a.thinkingRows.has(i))
                    droppedThinking++;
                else
                    keptUnknown++;
                continue;
            }
            rebuilt++;
            messages.push({ role: r.role, text: r.text, toolUses: r.toolUses.map((u) => ({ tool_use_id: u.tool_use_id, tool: u.tool, input: u.input })), ...(r.toolResults ? { toolResults: r.toolResults.map((t) => ({ tool_use_id: t.tool_use_id, isError: t.isError, text: t.text })) } : {}) });
            continue;
        }
        if (i >= thinkCut && a.thinkingRows.has(i)) {
            droppedThinking++;
            continue;
        }
        if (i >= thinkCut && isEmptyAssistant(r) && !a.thinkingRows.has(i))
            keptUnknown++;
        if (rebuildResults.has(i)) {
            rebuilt++;
            messages.push({ role: 'user', text: r.text, toolUses: [], toolResults: (r.toolResults ?? []).map((t) => { const x = resultExtra.get(t.tool_use_id); return { tool_use_id: t.tool_use_id, isError: t.isError, text: x ? (t.text ? t.text + '\n' : '') + x : t.text }; }) });
            continue;
        }
        if (mapRows.has(i)) {
            mapsDropped++;
            messages.push({ role: 'user', text: r.text, toolUses: [], toolResults: (r.toolResults ?? []).map((t) => ({ tool_use_id: t.tool_use_id, isError: t.isError, text: t.text.length > 300 ? '[context map, dropped after the clean-up]' : t.text })) });
            continue;
        }
        if (i >= thinkCut && a.carryRows.has(i)) {
            rebuilt++;
            messages.push({ role: r.role, text: r.text, toolUses: r.toolUses.map((u) => ({ tool_use_id: u.tool_use_id, tool: u.tool, input: u.input })), ...(r.toolResults ? { toolResults: r.toolResults.map((t) => ({ tool_use_id: t.tool_use_id, isError: t.isError, text: t.text })) } : {}) });
            continue;
        }
        messages.push(r);
    }
    endRun();
    if (messages.length && messages[0]!.role !== 'user')
        messages.unshift({ role: 'user', text: OPENING_AFTER_SUMMARY, toolUses: [] } as unknown as Row);
    const size = (list: Row[]) => list.reduce((s, r) => s + est(r.text) + r.toolUses.reduce((x, u) => x + est(JSON.stringify(u.input)), 0) + (r.toolResults ?? []).reduce((x, t) => x + est(t.text), 0), 0);
    return { notesConverted, messages, archived, failed, droppedThinking, rebuilt, keptUnknown, cut, thinkCut, tokensBefore: size(rows) + a.thinkingTokens, tokensAfter: size(messages), mapsDropped, records, firstChange, riskAfterCut: riskRows.filter((i) => i > cut).length };
}
export function cleanupSummary(archived: {
    archive: string;
    parts: number[];
    tokens: number;
}[], keptLine: string, conv: {
    before: number;
    after: number;
}, whole: {
    before: number;
    after: number;
}, archiveFile: string, force: boolean): string {
    const fixed = Math.max(0, whole.before - conv.before);
    return (force ? 'Layer change sent with the next request. ' : '') +
        `Clean-up applied: ${archived.map((f) => `${f.archive} ${fmtIds(f.parts)} (about ${kfmt(f.tokens)} tokens)`).join('; ') || 'no archives'}${keptLine}; ` +
        `context about ${kfmt(whole.before)} to ${kfmt(whole.after)} tokens (conversation about ${kfmt(conv.before)} to ${kfmt(conv.after)}, and ${kfmt(fixed)} fixed: system prompt, tools, hook texts)` +
        `${archiveFile ? '; archive file ' + archiveFile : ''}.`;
}
let noteSeq = 0;
export function noteRows(archive: string, tokens: number, note: string, size?: string): Row[] {
    const id = `toolu_havoknote_${archive}_${Date.now().toString(36)}${(noteSeq++).toString(36)}`;
    const outcome = /Outcome: ([^]*?)(?: Exact values:| Errors:| Restore:|$)/.exec(note)?.[1] ?? note.replace(/^archived: [^.]*\.\s*/, '');
    const about = `${size ?? kfmt(tokens)} tokens: ${oneLine(outcome, 100)}`;
    return [
        { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: NOTE_TOOL, input: { archive, about } }] } as Row,
        { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, isError: false, text: note }] } as Row,
    ];
}
function noteText(info: {
    archive: string;
    parts: number[];
    tokens: number;
    note: string;
}, a: Analysis) {
    const kinds = new Map<string, number>();
    for (const id of info.parts) {
        const p = a.parts[id - 1]!;
        const k = p.kind === 'tool' ? p.tool!.replace(/^mcp__/, '') : p.kind;
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
    const what = [...kinds].map(([k, c]) => `${k} x${c}`).join(', ');
    return renderNote(info.archive, info.parts, what, info.tokens, info.note);
}
async function applyCleanup($: Engine, e: SessionCompactInput, dropAllThinking: boolean, force = false): Promise<SessionCompactResult> {
    const rows = e.messages as Row[];
    const api = (await $.session.messages({ as: 'api' })) as unknown as ApiMsg[];
    const a = analyze(rows, api, false);
    const pend = await loadPending($);
    const keeps = pend.keeps;
    let keptLine = '';
    if (keeps.length && cfg) {
        const path = `${cfg.agentLayerDir}/${cfg.agent}.md`;
        try {
            let cur = '';
            try {
                cur = await $.fs.read(path);
            }
            catch {
                cur = '';
            }
            const add = keeps.map((k) => `- ${k.fact.trim()} (kept ${new Date(k.at).toISOString().slice(0, 10)})`).join('\n');
            await $.fs.write(path, (cur.trim() ? cur.replace(/\s*$/, '\n') : '') + add + '\n');
            await refreshLayers($);
            keptLine = `, ${count(keeps.length, 'fact')} added to the agent layer`;
        }
        catch (err) {
            await report($, `the agent layer could not be written (${String(err).slice(0, 120)}); the keeps stay queued`, true, 'keep not saved to the agent layer, still queued');
        }
    }
    const landing = layersWaiting();
    const fresh = (force || landing) && cfg?.systemPromptSnapshot !== 'off';
    const b = buildCleanup(rows, a, pend, dropAllThinking || landing, cfg?.restartSafe === true, fresh);
    if (b.riskAfterCut)
        await report($, `${b.riskAfterCut} tool result(s) with images or tool loading after the first archived part were kept whole`, false, null);
    await debugDump($, 'apply', { rows: rows.map(rowKey), archives: pend.archives.map((f) => ({ archive: f.archive, rowCount: f.rowCount, refs: f.parts.flatMap((x) => x.rows) })), failed: b.failed });
    for (const f of b.failed)
        await report($, `archive not applied: ${f}`, true, 'an archive was not applied, see the transcript');
    if (b.keptUnknown)
        await report($, `${b.keptUnknown} assistant block(s) after the first change could not be identified and were left in place`, false, null);
    const nothing = !b.archived.length && !keeps.length && !b.droppedThinking && !b.mapsDropped;
    if (nothing && !force) {
        await savePending($, { archives: [], keeps: [] });
        return { skip: `${PLUGIN}: nothing to clean up` };
    }
    let archiveFile = '';
    try {
        if (b.records.length)
            archiveFile = await writeArchiveRecords($, b.records);
    }
    catch (err) {
        await savePending($, { archives: [], keeps: keptLine ? [] : keeps });
        await report($, `the archived text could not be saved (${String(err).slice(0, 120)}); nothing was archived and the queued archives (${pend.archives.map((f) => f.archive).join(', ')}) were dropped: queue smaller ranges again`, true, 'clean-up failed: archive file not saved, queue dropped');
        return { skip: `${PLUGIN}: could not save the archived text` };
    }
    await savePending($, { archives: [], keeps: keptLine ? [] : keeps });
    const prev = await loadClean($);
    await saveCleaned($, b.messages, [...new Set([...(prev?.archivedTools ?? []), ...b.archived.flatMap((x) => x.toolIds)])], cfg?.restartSafe === true);
    if (landing || force)
        await landLayers($, force ? 'urgent change' : 'with the clean-up');
    const usage = (await $.session.usage().catch(() => undefined))?.context;
    const before = Math.max(usage?.tokens ?? 0, b.tokensBefore);
    const whole = { before, after: Math.max(0, before - (b.tokensBefore - b.tokensAfter)) };
    if (b.archived.length)
        await recordCleanup($, b.archived.map((x) => x.archive), b.messages, whole);
    const layerOnly = nothing && force;
    chainCheckDue = cfg?.restartSafe === true;
    lastCleanup = layerOnly ? `layers updated at ${hhmm()} UTC` : `cleaned at ${hhmm()} UTC, ${kfmt(whole.before)} to ${kfmt(whole.after)} tokens`;
    statusNote = '';
    render($);
    if (!layerOnly)
        setCleanedContext($, { tokens: whole.after, window: usage?.window ?? 0, at: stamp() });
    cleanupLine = cleanupSummary(b.archived, keptLine, { before: b.tokensBefore, after: b.tokensAfter }, whole, archiveFile, force);
    await debugDump($, 'cleanup', {
        trigger: e.trigger, rowsBefore: rows.length, rowsAfter: b.messages.length, cut: b.cut, firstChange: b.firstChange, thinkCut: b.thinkCut, restartSafe: cfg?.restartSafe === true,
        archived: b.archived, failed: b.failed, droppedThinking: b.droppedThinking, rebuilt: b.rebuilt, keptUnknown: b.keptUnknown,
        mapsDropped: b.mapsDropped, tokensBefore: b.tokensBefore, tokensAfter: b.tokensAfter, keeps: keeps.length,
        out: b.messages.map((m) => ({ role: m.role, handle: !!m.handle, text: oneLine(m.text, 60), tools: m.toolUses.length, results: m.toolResults?.length ?? 0 })),
    });
    return { messages: b.messages, tokensBefore: b.tokensBefore, tokensAfter: b.tokensAfter };
}
export type BuiltRow = {
    role: 'user' | 'assistant';
    text: string;
    toolUses: {
        tool_use_id: string;
        tool: string;
        input: Record<string, unknown>;
    }[];
    toolResults?: {
        tool_use_id: string;
        text: string;
        isError: boolean;
    }[];
};
export type ReapplyPlan = {
    ok: true;
    out: ({
        i: number;
    } | {
        built: BuiltRow;
    })[];
    stale: number[];
    rebuilt: number;
} | {
    ok: false;
    reason: string;
};
const asBuilt = (r: Row): BuiltRow => ({
    role: r.role, text: r.text,
    toolUses: r.toolUses.map((u) => ({ tool_use_id: u.tool_use_id, tool: u.tool, input: u.input })),
    ...(r.toolResults ? { toolResults: r.toolResults.map((t) => ({ tool_use_id: t.tool_use_id, text: t.text, isError: t.isError })) } : {}),
});
export function fromSeam(clean: CleanList): string[] {
    const k = clean.keys;
    const seam = k.length ? k.lastIndexOf(k[0]!) : -1;
    if (seam <= 0)
        return k;
    const archived = new Set(clean.archivedTools);
    const ids = (key: string) => key.split('|').slice(1, 3).join(',').split(',').filter(Boolean);
    return k.slice(0, seam).some((key) => ids(key).some((id) => archived.has(id))) ? k.slice(seam) : k;
}
export function boundaryOf(rows: readonly Row[], keys: readonly string[], recorded: readonly string[]): number {
    const inRecord = new Map<string, number>();
    for (const k of recorded)
        inRecord.set(k, (inRecord.get(k) ?? 0) + 1);
    const past = (b: number, k: string) => {
        while (b < keys.length && keys[b] === k)
            b++;
        return b;
    };
    for (let w = recorded.length - 1; w >= 0; w--) {
        const k = recorded[w]!;
        if (inRecord.get(k) !== 1)
            continue;
        const p = keys.indexOf(k);
        if (p < 0 || isEmptyAssistant(rows[p]!))
            continue;
        let b = past(p, k);
        for (const want of recorded.slice(w + 1)) {
            if (b < keys.length && keys[b] === want)
                b = past(b, want);
            else
                break;
        }
        return b;
    }
    return -1;
}
export function planReapply(rows: readonly Row[], clean: CleanList): ReapplyPlan {
    clean = { ...clean, keys: fromSeam(clean) };
    const allKeys = rows.map(rowKey);
    const cut = boundaryOf(rows, allKeys, clean.keys);
    if (cut < 0)
        return { ok: false, reason: 'no row of the cleaned conversation could be placed for sure in what was loaded' };
    const keys = allKeys.slice(0, cut);
    const out: ({
        i: number;
    } | {
        built: BuiltRow;
    })[] = [];
    const stale: number[] = [];
    const built = clean.built ?? {};
    let rebuilt = 0;
    let j = 0;
    for (const want of clean.keys) {
        let k = j;
        while (k < keys.length && keys[k] !== want)
            k++;
        if (k === keys.length) {
            const b = built[want];
            if (!b)
                return { ok: false, reason: `row ${out.length + 1} of the cleaned conversation is not in what was loaded` };
            out.push({ built: b });
            rebuilt++;
            continue;
        }
        for (let x = j; x < k; x++)
            stale.push(x);
        out.push({ i: k });
        j = k + 1;
    }
    const recorded = new Set(clean.keys);
    const isSibling = (r: Row) => r.role === 'assistant' || (r.toolResults?.length ?? 0) > 0;
    while (j < cut && recorded.has(keys[j]!) && isSibling(rows[j]!))
        stale.push(j++);
    const archived = new Set(clean.archivedTools);
    const uses = new Set<string>();
    const results = new Set<string>();
    for (const o of out) {
        const r = 'i' in o ? rows[o.i]! : o.built;
        for (const u of r.toolUses)
            uses.add(u.tool_use_id);
        for (const t of r.toolResults ?? [])
            results.add(t.tool_use_id);
    }
    for (let x = j; x < rows.length; x++) {
        const r = rows[x]!;
        const u = r.toolUses.map((t) => t.tool_use_id);
        const res = (r.toolResults ?? []).map((t) => t.tool_use_id);
        const back = [...u, ...res].some((id) => archived.has(id)) || (u.length > 0 && u.every((id) => uses.has(id))) || (res.length > 0 && res.every((id) => results.has(id)));
        if (back) {
            stale.push(x);
            continue;
        }
        u.forEach((id) => uses.add(id));
        res.forEach((id) => results.add(id));
        out.push({ i: x });
    }
    return { ok: true, out, stale, rebuilt };
}
async function saveCleaned($: Engine, messages: readonly Row[], archivedTools: string[], fileHolds: boolean) {
    const keys = messages.map(rowKey);
    const built: Record<string, BuiltRow> = {};
    for (let i = 0; i < messages.length; i++)
        built[keys[i]!] = asBuilt(messages[i]!);
    await saveClean($, { at: Date.now(), keys, built, archivedTools, fileHolds } satisfies CleanList);
}
export function resultExtras(api: readonly ApiMsg[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of api) {
        if (m.role !== 'user' || !Array.isArray(m.content))
            continue;
        for (const b of m.content) {
            if (b.type !== 'tool_result' || !Array.isArray(b.content))
                continue;
            const ty = (b.content as ApiBlock[]).map((x) => x.type);
            const images = ty.filter((x) => x === 'image').length;
            const loads = ty.filter((x) => x === 'tool_reference').length;
            const other = ty.filter((x) => x !== 'text' && x !== 'image' && x !== 'tool_reference');
            const extra: string[] = [];
            if (images)
                extra.push(`[${images} image${images > 1 ? 's' : ''} not kept after the clean-up; the session file still holds ${images > 1 ? 'them' : 'it'}, and the full copy archived when it is slimmed]`);
            if (loads)
                extra.push(`[this result loaded ${loads} deferred tool${loads > 1 ? 's' : ''}; after the clean-up load ${loads > 1 ? 'them' : 'it'} again with ToolSearch before calling]`);
            if (other.length)
                extra.push(`[${other.join(', ')} block${other.length > 1 ? 's' : ''} not kept after the clean-up]`);
            if (extra.length)
                out.set(String(b.tool_use_id), extra.join(' '));
        }
    }
    return out;
}
export function freshRow(r: Row | BuiltRow, extras: Map<string, string>): BuiltRow {
    const b = asBuilt(r as Row);
    if (b.toolResults)
        b.toolResults = b.toolResults.map((t) => { const x = extras.get(t.tool_use_id); return x ? { ...t, text: (t.text ? t.text + '\n' : '') + x } : t; });
    return b;
}
async function checkResume($: Engine): Promise<number> {
    let clean: CleanList | undefined;
    try {
        clean = await loadClean($);
    }
    catch (err) {
        await report($, `the cleaned conversation record could not be read (${String(err).slice(0, 100)}); left as loaded`, false, 'earlier clean-up not re-applied after restart');
        return 0;
    }
    if (!clean?.keys?.length)
        return 0;
    const when = (await loadHistory($)).cleanups.at(-1)?.at;
    if (when)
        setCleanedAt($, new Date(when).toISOString());
    const rows = await $.session.messages();
    const plan = planReapply(rows, clean);
    await debugDump($, 'resume-check', { rows: rows.length, recorded: clean.keys, loaded: rows.map((r) => `${rowKey(r)} ${oneLine(r.text, 40)}`), plan });
    if (!plan.ok) {
        await report($, `after the restart the cleaned conversation could not be matched (${plan.reason}); left as loaded`, false, 'earlier clean-up not re-applied after restart');
        return 0;
    }
    const off = plan.stale.length + plan.rebuilt;
    if (clean.fileHolds) {
        if (off)
            await report($, `after the restart the session file did not load the clean-up as recorded (${plan.stale.length} rows came back, ${plan.rebuilt} were missing); re-applied from the record`, false, 'session file did not hold the clean-up');
        else
            $.ui.log('resume: the session file held the clean-up; nothing re-applied', { to: 'debug' });
        return off;
    }
    return Math.max(off, 1);
}
async function applyReapply($: Engine, e: SessionCompactInput): Promise<SessionCompactResult> {
    const clean = await loadClean($);
    const rows = e.messages as Row[];
    reapplyWanted = false;
    if (!clean?.keys?.length)
        return { skip: `${PLUGIN}: no cleaned conversation recorded for this session` };
    const plan = planReapply(rows, clean);
    if (!plan.ok) {
        await report($, `the cleaned conversation could not be applied again (${plan.reason}); left as loaded`, true, 'earlier clean-up not re-applied after restart');
        return { skip: `${PLUGIN}: ${plan.reason}` };
    }
    if (!plan.stale.length && !plan.rebuilt && clean.fileHolds)
        return { skip: `${PLUGIN}: the conversation came back clean` };
    const extras = resultExtras((await $.session.messages({ as: 'api' })) as unknown as ApiMsg[]);
    const messages: Row[] = plan.out.map((o) => {
        const r = 'i' in o ? rows[o.i]! : (o.built as unknown as Row);
        return (r.toolResults?.length ? freshRow(r, extras) : r) as Row;
    });
    await saveCleaned($, messages, clean.archivedTools, true);
    const size = (list: Row[]) => list.reduce((s, r) => s + est(r.text) + r.toolUses.reduce((x, u) => x + est(JSON.stringify(u.input)), 0) + (r.toolResults ?? []).reduce((x, t) => x + est(t.text), 0), 0);
    cleanupLine = !plan.stale.length && !plan.rebuilt ? 'Earlier clean-up written into the session file once, so later restarts load it as it is.' : `Earlier clean-up applied again after the restart: ${count(plan.stale.length, 'removed part')} had come back${plan.rebuilt ? ` and ${count(plan.rebuilt, 'part')} of the cleaned conversation had not been loaded and came back from the record` : ''}.`;
    await debugDump($, 'reapply', { rowsBefore: rows.length, rowsAfter: messages.length, stale: plan.stale, rebuilt: plan.rebuilt });
    chainCheckDue = true;
    lastCleanup = `clean-up re-applied after restart at ${hhmm()} UTC`;
    statusNote = '';
    render($);
    return { messages, tokensBefore: size(rows), tokensAfter: size(messages) };
}
let answered = false;
export const landsLayers = (instructions: string) => instructions !== MARK_REAPPLY;
let chainCheckDue = false;
export async function checkChain($: Engine): Promise<{
    reached: boolean;
    rows: number;
    stop: string;
} | undefined> {
    const c = cfg;
    if (!c || !chainCheckDue)
        return undefined;
    chainCheckDue = false;
    const configDir = ((await $.env.get('CLAUDE_CONFIG_DIR')) || `${c.home}/.claude`).replace(/\\/g, '/').replace(/\/+$/, '');
    const path = sessionFilePath(configDir, c.cwd, sessionId);
    let out: {
        reached: boolean;
        rows: number;
        stop: string;
    } | undefined;
    try {
        const r = await $.process.run(['node', '-e', CHAIN_SCRIPT, path], { timeoutMs: 20000 });
        out = JSON.parse(String((r as {
            stdout?: string;
        }).stdout ?? '').trim().split('\n').at(-1) ?? '');
    }
    catch (err) {
        $.ui.log(`chain walk could not run (${String(err).slice(0, 120)})`, { to: 'debug' });
        return undefined;
    }
    if (!out)
        return undefined;
    $.ui.log(`chain walk after the clean-up: reaches the boundary ${out.reached ? 'yes' : 'no'} (${out.rows} rows, stopped at ${out.stop})`, { to: 'debug' });
    if (!out.reached) {
        const clean = await loadClean($).catch(() => undefined);
        if (clean?.fileHolds)
            await saveClean($, { ...clean, fileHolds: false });
        await report($, `the session file does not hold the last clean-up (the walk stopped at ${out.stop}); the next start re-applies it from the record`, false, 'session file does not hold the clean-up');
    }
    return out;
}
async function runCleanup($: Engine, instructions: string): Promise<boolean> {
    if (!cleanupAllowed()) {
        await tellGuard($);
        return false;
    }
    cleanupLine = '';
    answered = false;
    try {
        await padSessionFile($);
        const res = await $.session.compact({ instructions });
        if (!answered) {
            await settleGuard($, true);
            await report($, `the mod's clean-up hook did not answer; Claude Code compacted the conversation itself (${GUARD_REASON}); the clean-up is off from now on`, true, null);
            return false;
        }
        if (res.skip !== undefined) {
            $.ui.log(`clean-up skipped: ${res.skip}`, { to: 'debug' });
            return false;
        }
        if (cleanupLine)
            $.ui.log(cleanupLine, { to: 'transcript' });
        if (landsLayers(instructions))
            layerWanted = false;
        if (cfg?.debugDir)
            await debugDump($, 'after-cleanup', apiDigest((await $.session.messages({ as: 'api' })) as unknown as ApiMsg[]));
        return true;
    }
    catch (err) {
        await report($, `the clean-up could not run (${String(err).slice(0, 160)}); it stays queued`, true, 'clean-up failed, still queued');
        return false;
    }
}
async function tellGuard($: Engine) {
    render($);
    if (guardTold || S.guarded !== true)
        return;
    guardTold = true;
    $.ui.log(`context clean-up off in this session: ${GUARD_REASON}; nothing was compacted`, { to: 'debug' });
}
export const WARM_RATIO = 1.0;
export const COLD_MINUTES = 61;
const coldMinutes = () => (cfg && cfg.heldColdMinutes > 0 ? cfg.heldColdMinutes : COLD_MINUTES);
export const HELD_MARK = 'The cache is cold: the mod applies your held clean-up now, with no model request.';
let heldTimer: {
    cancel: () => void;
} | null = null;
let coldTurn = false;
let heldSince = '';
export function weighOf(parts: readonly {
    tokens: number;
    archived: boolean;
}[], noteTokens: number): {
    removed: number;
    rewritten: number;
} {
    const first = parts.findIndex((p) => p.archived);
    if (first < 0)
        return { removed: 0, rewritten: 0 };
    let archived = 0;
    let kept = 0;
    for (let i = first; i < parts.length; i++) {
        if (parts[i]!.archived)
            archived += parts[i]!.tokens;
        else
            kept += parts[i]!.tokens;
    }
    return { removed: Math.max(0, archived - noteTokens), rewritten: kept + noteTokens };
}
export const paysWhileWarm = (w: {
    removed: number;
    rewritten: number;
}) => w.removed >= WARM_RATIO * w.rewritten;
function weighPending(a: Analysis, pend: Pending): {
    removed: number;
    rewritten: number;
} {
    const taken = new Set(pend.archives.flatMap((f) => f.parts.flatMap((p) => p.rows.map((r) => r.fp + '@' + r.i))));
    const parts = a.parts.map((p) => ({ tokens: p.tokens, archived: p.rows.some((i) => taken.has(fp(a.rows[i]!) + '@' + i)) }));
    const notes = pend.archives.reduce((s, f) => s + est(f.note), 0);
    return weighOf(parts, notes);
}
async function isCold($: Engine): Promise<boolean> {
    return S.lastRequest > 0 && (await $.clock.now()) - S.lastRequest >= coldMinutes() * 60000;
}
function armHeld($: Engine) {
    heldTimer?.cancel();
    heldTimer = null;
    const wait = Math.max(60000, S.lastRequest + coldMinutes() * 60000 - Date.now());
    heldTimer = $.clock.after(wait, () => void heldFire($));
}
async function heldFire($: Engine) {
    heldTimer = null;
    if (!cfg || S.guarded === true)
        return;
    const pend = await loadPending($);
    if (!pend.archives.length)
        return;
    if (S.turnRunning || !(await isCold($))) {
        if (!S.turnRunning)
            armHeld($);
        return;
    }
    const res = await $.prompt.submit({ text: coldTurnText() }).catch((err: unknown) => ({ drop: String(err) }));
    if ('drop' in res && res.drop !== undefined) {
        await report($, `the held clean-up could not start its turn (${String(res.drop).slice(0, 100)}); it applies at the next turn's end or restart`, false, null);
        return;
    }
    $.ui.log('cache cold: submitted the mod\'s own turn to apply the held clean-up', { to: 'debug' });
}
let coldNonce = '';
export function coldTurnText() { coldNonce = crypto.randomUUID().slice(0, 8); return `${IDLE_MARK} ${HELD_MARK} (${coldNonce})`; }
export function coldTurnStart(text: string) {
    coldTurn = !!coldNonce && String(text ?? '').includes(HELD_MARK) && String(text ?? '').includes(`(${coldNonce})`);
    if (coldTurn)
        coldNonce = '';
}
export const isColdTurn = () => coldTurn;
export const COLD_TURN_ANSWER = 'Held clean-up applied while the cache was cold; no model request was made.';
export const PAD_SCRIPT = [
    "const fs=require('fs');const p=process.argv[1];const min=Number(process.argv[2]);",
    "const size=fs.statSync(p).size;if(!(min>0)||size>=min){console.log(JSON.stringify({padded:0,size}));process.exit(0)}",
    "const fd=fs.openSync(p,'r');const b=Buffer.alloc(1);fs.readSync(fd,b,0,1,size-1);fs.closeSync(fd);",
    "const row={type:'havok-padding',note:'Padding of the Neuraxis mod: keeps this session file above 5 MiB so Claude Code resumes it from its last compaction (anthropics/claude-code#106422). Never sent to the model.',at:new Date().toISOString(),pad:''};",
    "row.pad='.'.repeat(Math.max(0,min-size-JSON.stringify(row).length+64));",
    "fs.appendFileSync(p,(size>0&&b[0]!==10?'\\n':'')+JSON.stringify(row)+'\\n');",
    "console.log(JSON.stringify({padded:fs.statSync(p).size-size,size:fs.statSync(p).size}))",
].join('');
export const CHAIN_SCRIPT = [
    "const fs=require('fs');const t=fs.readFileSync(process.argv[1],'utf8');",
    "const k=t.lastIndexOf('\"subtype\":\"compact_boundary\"');if(k<0){console.log(JSON.stringify({reached:false,rows:0,stop:'no boundary'}));process.exit(0)}",
    "const L=t.slice(t.lastIndexOf('\\n',k)+1).split('\\n').filter(Boolean).map((l)=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);",
    "const b=L[0];const by=new Map(L.filter((r)=>r.uuid).map((r)=>[r.uuid,r]));",
    "let leaf=null;for(let i=L.length-1;i>0;i--)if(L[i].type==='user'||L[i].type==='assistant'){leaf=L[i];break}",
    "let r=leaf,n=0,stop='';while(r&&r!==b){n++;const p=r.parentUuid;if(!p){stop='a row with no parent';break}const q=by.get(p);if(!q){stop='a parent from before the boundary';break}r=q}",
    "console.log(JSON.stringify({reached:r===b,rows:n,stop:r===b?'the boundary':stop||'no row after the boundary'}))",
].join('');
export function sessionFilePath(configDir: string, cwd: string, session: string) {
    return `${configDir}/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${session}.jsonl`;
}
async function padSessionFile($: Engine) {
    const c = cfg;
    if (!c || !c.main || !c.padding.enabled)
        return;
    const configDir = ((await $.env.get('CLAUDE_CONFIG_DIR')) || `${c.home}/.claude`).replace(/\\/g, '/').replace(/\/+$/, '');
    const path = sessionFilePath(configDir, c.cwd, sessionId);
    let size = -1;
    try {
        size = (await $.fs.stat(path)).size;
    }
    catch {
        size = -1;
    }
    if (size < 0) {
        await report($, `padding skipped: the session file was not found at ${path}`, false, null);
        return;
    }
    if (size >= c.padding.minBytes)
        return;
    try {
        const r = await $.process.run(['node', '-e', PAD_SCRIPT, path, String(c.padding.minBytes)], { timeoutMs: 30000 });
        if (r.exitCode !== 0)
            throw new Error(r.stderr.slice(0, 160) || `exit ${r.exitCode}`);
        $.ui.log(`session file padded above ${c.padding.minBytes} bytes before the clean-up: ${r.stdout.trim()}`, { to: 'debug' });
    }
    catch (err) {
        await report($, `padding failed (${String(err).slice(0, 160)}); the clean-up goes on and re-apply covers a restart`, false, null);
    }
}
async function registerTools($: Engine) {
    await $.tool.register({
        name: 'context_map',
        isDeferred: false,
        description: 'Show a numbered map of your own conversation in this session: each part with its kind, estimated size in tokens, age in turns, a one-line label, and whether it is locked. ' +
            'Use it before archiving. Reading it changes nothing; the map is dropped from the conversation at the next clean-up.',
        inputSchema: {
            type: 'object',
            properties: {
                from: { type: 'number', description: 'First part id to list (default 1).' },
                to: { type: 'number', description: 'Last part id to list (default the last).' },
                all: { type: 'boolean', description: 'List every part on its own line, without grouping small parts (default false).' },
            },
        },
    });
    await $.tool.register({
        name: 'context_archive',
        isDeferred: false,
        description: 'Archive finished parts of your conversation you no longer need word for word: each archive replaces the parts you name (ids or ranges from context_map, like "12-20, 25") with your own note. ' +
            'It applies when the current turn ends, not at once; the full text is saved in your archive file and context_restore brings it back. ' +
            'Archive rarely and in one batch (a clean-up re-reads everything after the first archived part once). ' + (cfg?.locks ? 'Never archived: words from the user, your reply that ends each turn (what you told them), everything in the last few turns, and the current turn; a tool call is always archived with its result. ' : 'Not archivable: the turn in progress, a call still waiting for its result and the first message of the conversation; anything else is yours to decide, the user\'s words and your replies included, so put what they said that you will need into your note. A tool call is always archived with its result. The map shows what each part would save and what you brought back before. ') +
            'Your note is the Outcome field, written so you could work from it alone: what it was, the outcome, what is still open. Name what is still open now (a step not done, an answer awaited, a check not run, a decision for ' + owner() + '), or say that nothing is open. The mod adds from the archived parts the Exact values your note leaves out (numbers with units, paths, ids, hashes, error codes, URLs, amounts), the Errors (each failed call\'s command and error line) and the Restore pointer, so put the values that matter in your sentences and leave the rest to those fields.',
        inputSchema: {
            type: 'object',
            properties: {
                archives: {
                    type: 'array',
                    description: 'One entry per archive.',
                    items: {
                        type: 'object',
                        properties: {
                            parts: { type: 'string', description: 'Part ids and ranges from context_map, e.g. "12-20, 25".' },
                            note: { type: 'string', description: 'The Outcome field of the note that stays in place of the parts: what it was, the outcome, what is still open. Name what is still open now (a step not done, an answer awaited, a check not run, a decision for ' + owner() + '), or say that nothing is open.' },
                        },
                        required: ['parts', 'note'],
                    },
                },
                cancel: { type: 'array', items: { type: 'string' }, description: 'Optional: ids of archives you queued this turn or earlier that have not applied yet (like "A12"), to drop them from the queue.' },
            },
            required: ['archives'],
        },
    });
    await $.tool.register({
        name: 'context_restore',
        isDeferred: false,
        description: 'Bring an archive back: its full original text comes back at the end of the conversation as this tool\'s result; the note stays where it is. Give the archive id (like A3). ' +
            'To bring back only part of one archive, add search (a word or phrase: the lines holding it with two lines around, numbered) or lines (a range like 120-180 of the restored text); that costs only what it returns.',
        inputSchema: {
            type: 'object',
            properties: {
                archive: { type: 'string', description: 'The archive id, like A3.' },
                page: { type: 'number', description: 'For a long archive, which page of the text (default 1).' },
                search: { type: 'string', description: 'Optional: bring back only the lines holding this text (any case), with two lines around each, numbered.' },
                lines: { type: 'string', description: 'Optional: bring back only these lines of the restored text, like "120-180" or "7".' },
            },
            required: ['archive'],
        },
    });
    await $.tool.register({
        name: 'archive_note',
        isDeferred: false,
        description: 'Not for you to call: where the mod archived parts of your conversation it writes one call of this tool, and its result is the note of that archive. context_restore brings the full text back.',
        inputSchema: { type: 'object', properties: { archive: { type: 'string' }, about: { type: 'string' } } },
    });
    await $.tool.register({
        name: 'context_keep',
        isDeferred: false,
        description: 'Keep a short fact pinned in your agent layer (your own section of the system prompt, read on every step). It is added at the next clean-up, when this turn ends. ' +
            'Keep it rare and short: changing the layer makes the whole context be read again once.',
        inputSchema: { type: 'object', properties: { fact: { type: 'string', description: 'The fact, one or two lines.' } }, required: ['fact'] },
    });
}
function costLine(a: Analysis): string {
    const parts = a.parts.map((p) => ({ tokens: p.tokens, archived: !p.locked }));
    const free = parts.filter((p) => p.archived).length;
    const w = weighOf(parts, free ? NOTE_COST_TOKENS * Math.max(1, Math.ceil(free / 40)) : 0);
    return `Cost: a clean-up rewrites in the cache everything kept after its first archived part. While the cache is warm it applies at the end of the turn only if it removes at least ${WARM_RATIO === 1 ? 'as much as' : WARM_RATIO + ' times what'} it rewrites; otherwise it is held and applied for free ${coldMinutes()} minutes after the last request. ` +
        (free ? `Archiving everything archivable now: removes about ${kfmt(w.removed)}, rewrites about ${kfmt(w.rewritten)}; archiving from a later part rewrites less.` : 'Nothing archivable now.');
}
async function toolMap($: Engine, input: Record<string, unknown>, given?: Analysis) {
    const a = given ?? (await readNow($, true));
    const pend = await loadPending($);
    const usage = await $.session.usage().catch(() => undefined);
    const from = Number(input.from) || 1;
    const to = Number(input.to) || a.parts.length;
    const restored = (await readState<Restored>($, restoredPath()).catch(() => undefined)) ?? {};
    return (await notesBlock($)) + '\n\n' + mapText(a, pend, usage?.context.tokens, from, to, input.all === true, restored, await loadHistory($));
}
async function toolArchive($: Engine, input: Record<string, unknown>, given?: Analysis, auto = false, plan?: 'idle'): Promise<{
    result: string;
} | {
    deny: string;
}> {
    const list = Array.isArray(input.archives) ? (input.archives as Record<string, unknown>[]) : [];
    const cancel = Array.isArray(input.cancel) ? (input.cancel as unknown[]).map((x) => String(x).trim().toUpperCase()).filter((x) => /^A\d+$/.test(x)) : [];
    if (!list.length && !cancel.length)
        return { deny: 'Give archives: [{ parts: "12-20", note: "..." }], or cancel: ["A12"] to drop a queued archive.' };
    const cancelled: string[] = [];
    if (cancel.length) {
        const before = await loadPending($);
        const left = before.archives.filter((f) => {
            if (cancel.includes(f.archive)) {
                cancelled.push(f.archive);
                return false;
            }
            return true;
        });
        if (cancelled.length)
            await savePending($, { archives: left, keeps: before.keeps });
    }
    const cancelLine = cancel.length ? (cancelled.length ? `Cancelled ${cancelled.join(', ')}: dropped from the queue.` : `No queued archive ${cancel.join(', ')}: nothing was cancelled.`) : '';
    if (!list.length) {
        render($);
        return { result: cancelLine };
    }
    const a = given ?? (await readNow($, true));
    const rows = a.rows;
    const pend = await loadPending($);
    const taken = new Set(pend.archives.flatMap((f) => f.parts.map((p) => p.rows.map((r) => r.fp + '@' + r.i)).flat()));
    const storedSeq = await $.store.get(kSeq());
    let seq = storedSeq === undefined ? await highestArchiveId($) : Number(storedSeq);
    for (const k of notesInConversation(rows).keys())
        seq = Math.max(seq, Number(k.slice(1)) || 0);
    const lines: string[] = [];
    const queued: PendingArchive[] = [];
    for (const item of list) {
        const note = String(item.note ?? '').trim();
        if (!note) {
            lines.push(`Refused "${String(item.parts)}": a note is required.`);
            continue;
        }
        const maxNote = auto ? MAIL_NOTE_MAX : 2000;
        if (note.length > maxNote) {
            lines.push(`Refused "${String(item.parts)}": the note is over ${maxNote} characters; a note should be short.`);
            continue;
        }
        const ids = parseIds(String(item.parts ?? ''), a.parts.length);
        if (typeof ids === 'string') {
            lines.push(`Refused: ${ids}.`);
            continue;
        }
        const want = new Set(ids);
        for (const id of ids)
            for (const q of a.parts)
                if (q.link === a.parts[id - 1]!.link)
                    want.add(q.id);
        const parts = [...want].sort((x, y) => x - y).map((id) => a.parts[id - 1]!);
        const locked = parts.filter((p) => p.locked);
        if (locked.length) {
            const why = new Map<string, number[]>();
            for (const p of locked)
                why.set(p.locked!, [...(why.get(p.locked!) ?? []), p.id]);
            const free = parts.filter((p) => !p.locked).map((p) => p.id);
            lines.push(`Refused ${fmtIds(ids)}: it holds locked parts: ${[...why].map(([r, l]) => `${fmtIds(l)} (${r})`).join('; ')}. ` +
                (free.length ? `The parts of that range you can archive: ${fmtIds(free)}.` : 'Nothing in that range can be archived now.'));
            continue;
        }
        const bytes = parts.reduce((s, p) => s + p.rows.reduce((t, i) => t + utf8Bytes(JSON.stringify(plainRow(rows[i]!))), 0), 0);
        if (bytes > ARCHIVE_FILE_MAX * 0.9) {
            lines.push(`Refused ${fmtIds(ids)}: its text is about ${bytes} bytes, over what one archive holds (${Math.floor(ARCHIVE_FILE_MAX * 0.9)}); archive it in smaller ranges.`);
            continue;
        }
        const refs: PartRef[] = parts.map((p) => ({ id: p.id, kind: p.kind === 'tool' ? 'tool:' + p.tool : p.kind, label: p.label, tokens: p.tokens, rows: p.rows.map((i) => ({ i, fp: fp(rows[i]!) })) }));
        if (refs.some((r) => r.rows.some((x) => taken.has(x.fp + '@' + x.i)))) {
            lines.push(`Refused ${fmtIds(ids)}: part of it is already in a waiting archive.`);
            continue;
        }
        for (const r of refs)
            for (const x of r.rows)
                taken.add(x.fp + '@' + x.i);
        seq++;
        const archive = `A${seq}`;
        const extra = parts.length > ids.length ? ` (joined parts ${fmtIds(parts.map((p) => p.id).filter((x) => !ids.includes(x)))} added: they share a message)` : '';
        const composed = composeNote(a, parts, note);
        const { values, errors } = composed;
        const told = (values.added ? `; ${values.added} exact value(s) your note left out were added to it${values.more ? ` (${values.more} more stay in the archive)` : ''}` : '') +
            (errors.shown ? `; ${errors.shown + errors.more} failed call(s) added to its errors with the command and the error line` : '');
        queued.push({ archive, note: composed.note, parts: refs, at: Date.now(), rowCount: rows.length, ...(auto ? { auto: true } : {}), ...(plan ? { plan } : {}) });
        lines.push(`Queued ${archive}: ${fmtIds(parts.map((p) => p.id))}, about ${kfmt(parts.reduce((s, p) => s + p.tokens, 0))} tokens${extra}${told}.`);
    }
    if (queued.length) {
        await storeSet($, kSeq(), seq);
        await savePending($, { archives: [...pend.archives, ...queued], keeps: pend.keeps });
        statusNote = `${count(pend.archives.length + queued.length, 'archive')} queued for the end of this turn`;
        render($);
    }
    if (queued.length && !auto) {
        const w = weighPending(a, { archives: [...pend.archives, ...queued], keeps: pend.keeps });
        lines.push(paysWhileWarm(w)
            ? `It removes about ${kfmt(w.removed)} tokens and rewrites about ${kfmt(w.rewritten)}: it applies when this turn ends, and the map is dropped. Carry on with your work.`
            : `It removes about ${kfmt(w.removed)} tokens but rewrites about ${kfmt(w.rewritten)} while the cache is warm, so it is held: it applies for free ${coldMinutes()} minutes after your last request (or at a restart after that). To apply it at this turn's end instead, archive more of the older parts. Carry on with your work.`);
    }
    else
        lines.push(queued.length ? 'Nothing changes until this turn ends; then the clean-up applies them all at once and the map is dropped. Carry on with your work.' : 'Nothing was queued.');
    if (cancelLine)
        lines.unshift(cancelLine);
    return { result: lines.join('\n') };
}
async function toolRestore($: Engine, input: Record<string, unknown>): Promise<{
    result: string;
} | {
    deny: string;
}> {
    const id = String(input.archive ?? '').trim().toUpperCase();
    if (!/^A\d+$/.test(id))
        return { deny: 'Give the archive id, like A3.' };
    const shown = notesInConversation(((await $.session.messages().catch(() => [])) as unknown as Row[]) ?? []).get(id);
    const rec = await findArchive($, id, shown);
    if (!rec)
        return { deny: `No archive ${id} in this session's archive file${shown ? ' or in the earlier sessions of this archive folder' : ''}.` };
    const rows = (rec.rows as ReturnType<typeof plainRow>[]) ?? [];
    const parts = (rec.parts as {
        id: number;
    }[]) ?? [];
    const body = rows.map((r) => {
        if (r.role === 'user')
            return (r.toolResults ?? []).map((t) => `result of ${t.tool_use_id}${t.isError ? ' (error)' : ''}:\n${t.text}`).join('\n') + (r.text ? `\n${r.text}` : '');
        const calls = r.toolUses.map((u) => `call ${u.tool_use_id} ${u.tool} ${JSON.stringify(u.input)}`).join('\n');
        return [r.text, calls].filter(Boolean).join('\n');
    }).filter(Boolean).join('\n\n');
    const search = typeof input.search === 'string' ? input.search.trim() : '';
    const range = input.lines === undefined || input.lines === '' ? null : /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(input.lines));
    if (input.lines !== undefined && input.lines !== '' && (!range || Number(range[2] ?? range[1]) < Number(range[1])))
        return { deny: 'lines must be a line number or a range like 120-180.' };
    const fullTokens = typeof rec.tokens === 'number' ? rec.tokens : est(body);
    const head = (what: string) => `Restored ${id} (archived ${String(rec.at).slice(0, 16)}, parts ${fmtIds(parts.map((p) => p.id))}). Your note was: ${String(rec.note)}\n${what} The note stays in place; this text now sits at the end of the conversation.\n\n`;
    if (search || range) {
        const all = body.split('\n');
        const from = range ? Math.max(1, Number(range[1])) : 1;
        const to = range ? Math.min(all.length, Number(range[2] ?? range[1])) : all.length;
        if (from > all.length)
            return { deny: `${id} has ${all.length} lines in its restored text; lines ${from} and up do not exist.` };
        const keep = new Set<number>();
        if (search) {
            const needle = search.toLowerCase();
            for (let n = from; n <= to; n++) {
                if (!all[n - 1]!.toLowerCase().includes(needle))
                    continue;
                for (let k = Math.max(from, n - RESTORE_CONTEXT_LINES); k <= Math.min(to, n + RESTORE_CONTEXT_LINES); k++)
                    keep.add(k);
            }
            if (!keep.size) {
                await noteRestored($, id, fullTokens, true, search ? 'search' : 'lines', 0);
                return { result: `No match: no line of ${id} holds "${search}"${range ? ` between lines ${from} and ${to}` : ''} (its restored text has ${all.length} lines).` };
            }
        }
        else
            for (let n = from; n <= to; n++)
                keep.add(n);
        let out = '';
        let last = 0;
        let cut = false;
        for (const n of [...keep].sort((x, y) => x - y)) {
            const line = `${last && n > last + 1 ? '...\n' : ''}${n}: ${all[n - 1]}\n`;
            if (out.length + line.length > RESTORE_PAGE_CHARS) {
                cut = true;
                break;
            }
            out += line;
            last = n;
        }
        await noteRestored($, id, fullTokens, true, search ? 'search' : 'lines', est(out));
        return { result: head(`Part of the original text (${keep.size} of ${all.length} lines${search ? `, lines around "${search}"` : `, lines ${from} to ${to}`}${cut ? `; cut at ${RESTORE_PAGE_CHARS} characters, narrow the term or the lines` : ''}).`) + out };
    }
    const pages = Math.max(1, Math.ceil(body.length / RESTORE_PAGE_CHARS));
    const page = Math.min(Math.max(1, Number(input.page) || 1), pages);
    const text = body.slice((page - 1) * RESTORE_PAGE_CHARS, page * RESTORE_PAGE_CHARS);
    if (page === 1)
        await noteRestored($, id, fullTokens, false, 'whole', est(text));
    else
        await noteBroughtBack($, id, 'whole', est(text), true);
    return { result: head(`The original text follows${pages > 1 ? ` (page ${page} of ${pages}; ask for the next with page)` : ''}.`) + text };
}
async function noteRestored($: Engine, id: string, tokens: number, partial: boolean, how: BringBack['how'], returned: number) {
    const at = Date.now();
    try {
        const h = { ...((await readState<Restored>($, restoredPath())) ?? {}) };
        const r = h[id] ?? { n: 0, partial: 0, last: at, tokens };
        h[id] = { n: r.n + 1, partial: r.partial + (partial ? 1 : 0), last: at, tokens };
        await writeState($, restoredPath(), h);
    }
    catch { }
    await noteBroughtBack($, id, how, returned);
}
type BringBack = {
    archive: string;
    how: 'whole' | 'search' | 'lines';
    tokens: number;
};
type CleanupRecord = {
    at: number;
    archives: string[];
    before: number;
    after: number;
    turns: number;
    bringBacks: BringBack[];
    written?: boolean;
};
type History = {
    cleanups: CleanupRecord[];
    baseline: number;
};
const outcomeTurns = () => cfg?.outcomeTurns ?? 5;
async function loadHistory($: Engine): Promise<History> {
    const h = await readState<History>($, historyPath()).catch(() => undefined);
    return { cleanups: Array.isArray(h?.cleanups) ? h!.cleanups : [], baseline: Number(h?.baseline) || 0 };
}
async function saveHistory($: Engine, h: History) {
    try {
        await writeState($, historyPath(), h);
    }
    catch { }
}
const archivableOf = (a: Analysis) => a.parts.filter((p) => !p.locked).reduce((s, p) => s + p.tokens, 0);
async function noteBroughtBack($: Engine, archive: string, how: BringBack['how'], tokens: number, nextPage = false) {
    const h = await loadHistory($);
    const last = h.cleanups.at(-1);
    if (!last || last.turns > outcomeTurns())
        return;
    const prev = nextPage ? [...last.bringBacks].reverse().find((b) => b.archive === archive && b.how === 'whole') : undefined;
    if (prev)
        prev.tokens += tokens;
    else
        last.bringBacks.push({ archive, how, tokens });
    await saveHistory($, h);
}
async function recordCleanup($: Engine, archives: string[], kept: Row[], whole: {
    before: number;
    after: number;
}) {
    const h = await loadHistory($);
    const prev = h.cleanups.at(-1);
    if (prev && !prev.written)
        await writeOutcome($, prev);
    h.cleanups.push({ at: await $.clock.now(), archives, ...whole, turns: 0, bringBacks: [] });
    h.baseline = archivableOf(analyze(kept, [], false));
    await saveHistory($, h);
}
async function closeOutcome($: Engine) {
    const h = await loadHistory($);
    const last = h.cleanups.at(-1);
    if (!last || last.written || last.turns < outcomeTurns())
        return;
    await writeOutcome($, last);
    await saveHistory($, h);
}
const idsOf = (archives: string[]) => {
    const n = archives.map((x) => Number(x.slice(1)));
    const run = n.every((x, i) => i === 0 || x === n[i - 1]! + 1);
    return archives.length > 1 && run ? `${archives[0]}-${archives.at(-1)}` : archives.join(', ');
};
function followedBy(r: CleanupRecord): string {
    const b = r.bringBacks;
    if (!b.length)
        return 'no bring-back';
    const each = b.map((x) => `${x.archive} (${x.how}${r.archives.includes(x.archive) ? ', archived in this clean-up' : ''})`);
    const list = each.length > 1 ? `${each.slice(0, -1).join(', ')} and ${each.at(-1)}` : each[0]!;
    return `${count(b.length, 'bring-back')} of ${list}, ${kfmt(b.reduce((s, x) => s + x.tokens, 0))} tokens`;
}
const whenOf = (at: number) => new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
function outcomeLine(r: CleanupRecord, open = false): string {
    const span = open ? `${r.turns} of the next ${outcomeTurns()} turns so far` : `next ${count(r.turns, 'turn')}`;
    return `${whenOf(r.at)} ${idsOf(r.archives)}: cleaned ${kfmt(r.before)} to ${kfmt(r.after)}; ${span}: ${followedBy(r)}.`;
}
async function writeOutcome($: Engine, r: CleanupRecord) {
    try {
        const path = cfg!.notesFile;
        const cur = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
        await $.fs.write(path, (cur.trim() ? cur.replace(/\s*$/, '\n') : '') + outcomeLine(r) + '\n');
        r.written = true;
    }
    catch (err) {
        $.ui.log(`the clean-up outcome could not be added to the notes file (${String(err).slice(0, 120)})`, { to: 'debug' });
    }
}
function outcomesLine(h: History): string {
    if (!h.cleanups.length)
        return 'Clean-ups of this session and what followed them: none yet.';
    return `Clean-ups of this session and what followed them (also in your clean-up notes): ${h.cleanups.map((r) => outcomeLine(r, !r.written)).join(' ')}`;
}
async function countTurn($: Engine) {
    const h = await loadHistory($);
    const last = h.cleanups.at(-1);
    if (!last)
        return;
    last.turns++;
    await saveHistory($, h);
}
function broughtBackLine(h: History): string {
    if (!h.cleanups.length)
        return 'not cleaned yet this session';
    const all = h.cleanups.flatMap((c) => c.bringBacks);
    const times = h.cleanups.length === 1 ? 'once' : `${h.cleanups.length} times`;
    const back = all.length
        ? `; brought back ${all.map((b) => `${b.archive} (${b.how})`).join(', ')}, about ${kfmt(all.reduce((s, b) => s + b.tokens, 0))} tokens`
        : '';
    return `cleaned ${times} this session${back}`;
}
async function toolKeep($: Engine, input: Record<string, unknown>): Promise<{
    result: string;
} | {
    deny: string;
}> {
    const fact = String(input.fact ?? '').trim();
    if (!fact)
        return { deny: 'Give the fact to keep.' };
    if (fact.length > 600)
        return { deny: 'Keep it short: 600 characters at most.' };
    const pend = await loadPending($);
    pend.keeps.push({ fact, at: Date.now() });
    await savePending($, pend);
    statusNote = `${count(pend.keeps.length, 'keep')} queued for the end of this turn`;
    render($);
    return { result: `Queued for your agent layer; it is added at the clean-up when this turn ends (${pend.keeps.length} waiting).` };
}
async function queueOldToolOutputs($: Engine, a: Analysis) {
    const c = cfg!;
    const age = (t: number) => a.realTurns.filter((x) => x > t).length;
    const old = a.parts.filter((p) => p.kind === 'tool' && !p.locked && age(p.turn) >= c.hideAfterTurns);
    const oldIds = new Set(old.map((p) => p.id));
    const whole = old.filter((p) => a.parts.every((q) => q.link !== p.link || oldIds.has(q.id)));
    const tokens = whole.reduce((s, p) => s + p.tokens, 0);
    if (!whole.length || tokens < c.hideMinTokens)
        return false;
    const calls = whole.map((p) => p.label.split(', result: ')[0]!);
    const note = oneLine(`Old tool outputs hidden automatically (older than ${c.hideAfterTurns} turns): ${calls.slice(0, 8).join('; ')}${calls.length > 8 ? `; and ${calls.length - 8} more` : ''}.`, 1500);
    const r = await toolArchive($, { archives: [{ parts: whole.map((p) => p.id).join(','), note }] }, a, true);
    $.ui.log(`old tool outputs hidden: ${'result' in r ? r.result.split('\n')[0] : r.deny}`, { to: 'debug' });
    return true;
}
const WARM_MINUTES = 60;
function cleanUpAsk() {
    return 'If your conversation holds finished work you no longer need word for word, call context_map, then archive it in one batch with context_archive, each archive with your own note; queue any fact you must keep pinned with context_keep. In each note, name what is still open now (a step not done, an answer awaited, a check not run, a decision for ' + owner() + '), or say that nothing is open. ' +
        (cfg?.locks
            ? 'Words from the user, your replies to them and the last turns are never archived.'
            : 'Nothing is locked: keep what you still need, write notes that let you find the rest, and read your clean-up notes and what you brought back before.');
}
type IdleFacts = {
    context: number;
    archivable: number;
    floor: number;
    history: History;
};
export const FORK_PLAN_ASK = 'Answer with JSON only, no other text: {"archives":[{"parts":"12-20, 25","note":"..."}]}, or {"archives":[]} to archive nothing.';
export function parsePlan(text: string): {
    parts: string;
    note: string;
}[] | null {
    const t = String(text ?? '');
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a)
        return null;
    try {
        const j = JSON.parse(t.slice(a, b + 1)) as {
            archives?: unknown;
        };
        if (!Array.isArray(j.archives))
            return null;
        const out = j.archives
            .filter((x): x is {
            parts: string;
            note: string;
        } => !!x && typeof (x as {
            parts?: unknown;
        }).parts === 'string' && typeof (x as {
            note?: unknown;
        }).note === 'string')
            .map((x) => ({ parts: x.parts.trim(), note: x.note.trim() }))
            .filter((x) => x.parts && x.note);
        return out;
    }
    catch {
        return null;
    }
}
let idleApplyTimer: {
    cancel: () => void;
} | null = null;
function armIdleApply($: Engine, minutes: number) {
    idleApplyTimer?.cancel();
    idleApplyTimer = $.clock.after(minutes * 60000, () => void idleApplyFire($));
}
async function idleApplyFire($: Engine) {
    idleApplyTimer = null;
    if (!cfg || S.guarded === true)
        return;
    if (S.turnRunning)
        return;
    const pend = await loadPending($);
    if (!pend.archives.some((f) => f.plan === 'idle'))
        return;
    const res = await $.prompt.submit({ text: coldTurnText() }).catch((err: unknown) => ({ drop: String(err) }));
    if ('drop' in res && res.drop !== undefined) {
        $.ui.log(`idle plan: its turn could not start (${String(res.drop).slice(0, 100)}); it is dropped at the next turn`, { to: 'debug' });
        return;
    }
    $.ui.log('idle plan: applied in the mod\'s own turn before the cache goes cold', { to: 'debug' });
}
export async function dropIdlePlan($: Engine): Promise<number> {
    idleApplyTimer?.cancel();
    idleApplyTimer = null;
    const p = await loadPending($);
    const kept = p.archives.filter((f) => f.plan !== 'idle');
    const dropped = p.archives.length - kept.length;
    if (!dropped)
        return 0;
    await savePending($, { ...p, archives: kept });
    await recordHidden($, { kind: 'cleanup', ok: true, why: 'idle', reason: `plan dropped: a turn came before it was applied (${dropped} archive(s))` });
    $.ui.log(`idle plan dropped: a turn came before it was applied (${dropped} archive(s))`, { to: 'debug' });
    return dropped;
}
async function planByFork($: Engine, why: 'idle' | 'force', facts: string): Promise<'queued' | 'none' | 'failed'> {
    let refusal = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
        const r = await planOnce($, why, facts, refusal, attempt);
        if (r.done)
            return r.done;
        refusal = r.refusal;
        await recordHidden($, { kind: 'cleanup', ok: false, why, try: attempt, reason: refusal.slice(0, 300) });
        if (S.turnRunning || !cfg)
            break;
    }
    $.ui.log(`clean-up fork (${why}): no plan after two tries; the conversation is left as it is (${refusal.slice(0, 160)})`, { to: 'debug' });
    return 'failed';
}
async function planOnce($: Engine, why: 'idle' | 'force', facts: string, refusal: string, attempt: number): Promise<{
    done?: 'queued' | 'none';
    refusal: string;
}> {
    if (!cfg || S.turnRunning)
        return { refusal: 'a turn started' };
    const serial = turnSerial;
    let map = '';
    let a: Analysis;
    try {
        a = await readNow($, true);
        map = await toolMap($, { all: false }, a);
    }
    catch (err) {
        return { refusal: 'the map could not be made: ' + String(err).slice(0, 120) };
    }
    const again = refusal ? ` Your first answer was refused (${refusal.slice(0, 300)}); answer again, with part ids from the map below only.` : '';
    const prompt = `${IDLE_MARK} Background clean-up (${why}: ${facts}). This is a fork of your conversation: nothing you write here enters it, and every tool is denied. ` +
        cleanUpAsk().replace('call context_map, then archive it in one batch with context_archive', 'choose it from the map below, in one batch') +
        again + ' ' + FORK_PLAN_ASK + '\n\n' + map;
    const r = (await $.model.fork({ prompt }).catch((err: unknown) => ({ isAnswered: false, reason: 'error: ' + String(err).slice(0, 80) }))) as {
        isAnswered?: boolean;
        text?: string;
        reason?: string;
        status?: number;
        usage?: {
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            output_tokens?: number;
        };
    };
    const read = Number(r.usage?.cache_read_input_tokens ?? 0);
    const write = Number(r.usage?.cache_creation_input_tokens ?? 0);
    const out = Number(r.usage?.output_tokens ?? 0);
    if (!r.isAnswered)
        return { refusal: `the fork got no answer (${String(r.reason)}${r.status ? ' ' + r.status : ''})` };
    const plan = parsePlan(String(r.text ?? ''));
    $.ui.log(`clean-up fork (${why}, try ${attempt}): ${plan ? plan.length + ' archive(s) planned' : 'no plan in its answer'}; ${read} read from the cache, ${write} written to it, ${out} out`, { to: 'debug' });
    if (!plan)
        return { refusal: 'the answer held no JSON with an archives list: ' + String(r.text ?? '').slice(0, 120) };
    if (!plan.length) {
        await recordHidden($, { kind: 'cleanup', ok: true, why, try: attempt, read, write, out, archives: 0 });
        return { done: 'none', refusal: '' };
    }
    if (S.turnRunning || turnSerial !== serial)
        return { refusal: 'a turn started before the plan was queued' };
    const q = await toolArchive($, { archives: plan }, a, true, why === 'idle' ? 'idle' : undefined);
    if (!('result' in q) || !q.result.includes('Queued'))
        return { refusal: 'deny' in q ? q.deny : q.result };
    await recordHidden($, { kind: 'cleanup', ok: true, why, try: attempt, read, write, out, archives: plan.length });
    if (why === 'idle') {
        S.lastRequest = await $.clock.now();
        armIdleApply($, cfg.idle.applyMinutes);
        $.ui.log(`clean-up fork (idle): ${plan.length} archive(s) planned; applied in ${cfg.idle.applyMinutes} minutes if still idle`, { to: 'debug' });
        return { done: 'queued', refusal: '' };
    }
    const res = await $.prompt.submit({ text: coldTurnText() }).catch((err: unknown) => ({ drop: String(err) }));
    if ('drop' in res && res.drop !== undefined) {
        $.ui.log(`clean-up fork (${why}): queued; its turn could not start (${String(res.drop).slice(0, 100)}), it applies at the next turn's end`, { to: 'debug' });
    }
    return { done: 'queued', refusal: '' };
}
function idlePrompt(minutes: number, f: IdleFacts) {
    return `${IDLE_MARK} Idle for ${minutes} minutes; the cache expires at about ${WARM_MINUTES} minutes.\n` +
        `Archivable now: about ${kfmt(f.archivable)} tokens (${broughtBackLine(f.history)}).\n` +
        'Clean up now with context_map then context_archive, or answer: no clean-up.';
}
function forcePrompt(tokens: number, limit: number) {
    return `${IDLE_MARK} Your conversation holds about ${tokens.toLocaleString('en-US')} tokens (the clean-up limit is ${limit.toLocaleString('en-US')}), and Claude Code compacts by itself near its own limit with a summary you do not control. You must clean up now, before anything else. ` +
        cleanUpAsk() + ' Then answer in one line what you archived.';
}
let idleTimer: {
    cancel: () => void;
} | null = null;
function armIdle($: Engine) {
    idleTimer?.cancel();
    idleTimer = null;
    const c = cfg;
    if (!c || !c.idle.enabled || c.idle.keepWarmOn || S.guarded === true)
        return;
    idleTimer = $.clock.after(c.idle.minutes * 60000, () => void idleFire($));
}
export async function askIdle($: Engine): Promise<boolean> {
    const c = cfg;
    if (!c || !c.idle.enabled || S.turnRunning || idleAsked || S.guarded === true)
        return false;
    const history = await loadHistory($);
    if (history.cleanups.at(-1)?.turns === 0) {
        $.ui.log('idle question skipped: no turn of work since the last clean-up', { to: 'debug' });
        return false;
    }
    const archivable = archivableOf(await readNow($, false));
    if (archivable - history.baseline < c.idle.floorTokens) {
        $.ui.log(`idle question skipped: ${archivable - history.baseline} tokens became archivable since the last clean-up or question, under the floor of ${c.idle.floorTokens}`, { to: 'debug' });
        return false;
    }
    const context = (await $.session.usage().catch(() => undefined))?.context?.tokens ?? 0;
    const idleMs = (await $.clock.now()) - S.lastReal;
    idleAsked = true;
    const text = idlePrompt(Math.round(idleMs / 60000), { context, archivable, floor: c.idle.floorTokens, history });
    const before = history.baseline;
    history.baseline = archivable;
    await saveHistory($, history);
    if (c.idle.fork) {
        const planned = await planByFork($, 'idle', `idle for ${Math.round(idleMs / 60000)} minutes; about ${kfmt(archivable)} tokens archivable`);
        return planned === 'queued';
    }
    const res = await $.prompt.submit({ text }).catch((err: unknown) => ({ drop: String(err) }));
    if ('drop' in res && res.drop !== undefined) {
        idleAsked = false;
        history.baseline = before;
        await saveHistory($, history);
        await report($, `the idle question was refused (${String(res.drop).slice(0, 100)}); it is asked again after the next real work`, false, null);
        return false;
    }
    $.ui.log(`idle for ${Math.round(idleMs / 60000)} min of real activity; asked the agent whether to clean up`, { to: 'debug' });
    await debugDump($, 'idle-asked', { idleMs, lastReal: new Date(S.lastReal).toISOString() });
    return true;
}
async function idleFire($: Engine) {
    idleTimer = null;
    const c = cfg;
    if (!c || !c.idle.enabled || S.turnRunning || idleAsked || S.guarded === true)
        return;
    const idleMs = (await $.clock.now()) - S.lastReal;
    if (idleMs < c.idle.minutes * 60000 - 1000) {
        idleTimer = $.clock.after(c.idle.minutes * 60000 - idleMs, () => void idleFire($));
        return;
    }
    await askIdle($);
}
const FORCE_DELAY_MS = 2000;
const watch = new ContextWatch();
let reminderText = '';
let knownWindow = 0;
const REMIND_MAX_SHARE = 0.6;
const FORCE_MAX_SHARE = 0.9;
function limitFor(value: number, window: number, share: number) {
    return value > 0 && window > 0 ? Math.min(value, Math.floor(window * share)) : value;
}
export const AUTO_COMPACT_GAP = 33000;
const FORCE_MARGIN = 25000;
export function limitsOf(c: {
    remindAt: number;
    forceAt: number;
}, window: number): Limits {
    const share = limitFor(c.forceAt, window, FORCE_MAX_SHARE);
    const cap = window > AUTO_COMPACT_GAP + FORCE_MARGIN ? window - AUTO_COMPACT_GAP - FORCE_MARGIN : 0;
    const forceAt = share > 0 && cap > 0 ? Math.min(share, cap) : share;
    let remindAt = limitFor(c.remindAt, window, REMIND_MAX_SHARE);
    if (forceAt < share && remindAt > forceAt - 30000)
        remindAt = Math.max(0, forceAt - 30000);
    return { remindAt, forceAt };
}
async function nearLimit($: Engine): Promise<boolean> {
    const c = cfg;
    if (!c || (!c.remindAt && !c.forceAt))
        return false;
    const usage = await $.session.usage().catch(() => undefined);
    const l = limitsOf(c, usage?.context?.window ?? knownWindow);
    const line = l.remindAt || l.forceAt;
    return line > 0 && (usage?.context?.tokens ?? 0) >= line;
}
async function checkContextSize($: Engine) {
    const c = cfg;
    if (!c || (!c.remindAt && !c.forceAt) || !cleanupAllowed())
        return;
    const usage = await $.session.usage().catch(() => undefined);
    const tokens = usage?.context?.tokens ?? 0;
    const window = usage?.context?.window ?? 0;
    if (window)
        knownWindow = window;
    const l = limitsOf(c, window);
    if (tokens < (l.remindAt || l.forceAt))
        reminderText = '';
    const d = watch.afterTurn(tokens, l);
    if (d.kind === 'force') {
        reminderText = '';
        $.clock.after(FORCE_DELAY_MS, () => void forceFire($, tokens, l.forceAt));
    }
    else if (d.kind === 'note')
        reminderText = d.text;
}
export async function contextStep($: Engine, usage: Parameters<typeof contextOf>[0], toolCalls: number) {
    const c = cfg;
    if (!c || (!c.remindAt && !c.forceAt) || !cleanupAllowed() || !toolCalls)
        return;
    const tokens = contextOf(usage);
    if (!tokens)
        return;
    if (!knownWindow)
        knownWindow = (await $.session.usage().catch(() => undefined))?.context?.window ?? 0;
    const text = watch.afterStep(tokens, limitsOf(c, knownWindow));
    if (!text)
        return;
    reminderText = text;
    $.ui.log(`context at ${tokens} tokens inside a turn; a note goes with the next tool result`, { to: 'debug' });
}
export function takeContextNote(): string {
    const note = reminderText;
    reminderText = '';
    return note;
}
async function forceFire($: Engine, tokens: number, limit: number) {
    if (!cfg || S.turnRunning || S.guarded === true) {
        watch.forceNotStarted();
        return;
    }
    if (cfg.idle.fork) {
        const planned = await planByFork($, 'force', `the conversation holds about ${tokens.toLocaleString('en-US')} tokens, over the clean-up limit of ${limit.toLocaleString('en-US')}`);
        if (planned === 'queued')
            return;
        $.ui.log(`forced clean-up: the background fork ${planned === 'none' ? 'archived nothing' : 'gave no plan'}; tried again after the next turn`, { to: 'debug' });
        watch.forceNotStarted();
        return;
    }
    const res = await $.prompt.submit({ text: forcePrompt(tokens, limit) }).catch((err: unknown) => ({ drop: String(err) }));
    if ('drop' in res && res.drop !== undefined) {
        watch.forceNotStarted();
        await report($, `the forced clean-up turn was refused (${String(res.drop).slice(0, 100)}); it is tried again after the next turn`, false, 'forced clean-up refused, retried after the next turn');
    }
    else {
        $.ui.log(`context at ${tokens} tokens (limit ${limit}); started a clean-up turn`, { to: 'debug' });
    }
}
async function detectGuard($: Engine) {
    S.composeSeen = false;
    try {
        await $.prompt.compose();
    }
    catch { }
    if (S.composeSeen)
        await settleGuard($, false);
    else {
        const before = await knownGuard($);
        if (before !== false)
            await settleGuard($, true);
    }
}
export function globalDelivered(): {
    delivered: boolean;
    from: string;
    keys: string[];
} {
    const keys = inForce.filter((l) => l.text.trim()).map((l) => l.key);
    return { delivered: !!cfg && S.guarded === false && keys.includes('global'), from: layerFrom, keys };
}
export async function contextStart($: Engine, c: Config, onLayers?: () => Promise<void>) {
    cfg = fromShared(c);
    sessionId = S.sessionId;
    watch.reset();
    reminderText = '';
    knownWindow = 0;
    idleAsked = false;
    reapplyWanted = false;
    layerWanted = false;
    guardTold = false;
    statusNote = '';
    lastCleanup = '';
    changeNote = '';
    noted = null;
    if (!c.context.enabled) {
        cfg = null;
        return;
    }
    await detectGuard($);
    layers = [];
    inForce = [];
    layerNote = '';
    sourceMissing = false;
    layerTold = new Set();
    const rows = await $.session.messages();
    const stored = (await $.store.get(kInForce())) as {
        session?: string;
        layers?: Layer[];
    } | undefined;
    const resumed = rows.length > 0 && stored?.session === sessionId && Array.isArray(stored.layers);
    if (resumed)
        inForce = stored!.layers!;
    await initSource($);
    await initLayers($);
    if (!resumed) {
        inForce = layers.map((l) => ({ ...l }));
        await storeSet($, kInForce(), { session: sessionId, sig: sigOf(inForce), layers: inForce }).catch(() => undefined);
    }
    if (onLayers)
        await onLayers().catch((err: unknown) => $.ui.log(`layers-live marker: ${String(err).slice(0, 160)}`, { to: 'debug' }));
    if (rows.length > 0 && layersWaiting()) {
        const cold = S.lastRequest > 0 && (await $.clock.now()) - S.lastRequest > cfg.layerColdMinutes * 60000;
        const none = !inForce.some((l) => l.text.trim());
        if (urgentWaiting() || cold || none) {
            if (cfg.systemPromptSnapshot === 'off')
                await landLayers($, none ? 'no layers were in force' : urgentWaiting() ? 'urgent change' : 'restart with a cold cache');
            else
                layerWanted = true;
        }
    }
    await registerTools($);
    const pend = await loadPending($);
    if (pend.archives.length || pend.keeps.length)
        statusNote = `${[pend.archives.length ? count(pend.archives.length, 'archive') : '', pend.keeps.length ? count(pend.keeps.length, 'keep') : ''].filter(Boolean).join(' and ')} queued for the end of the next turn`;
    if (pend.archives.length && rows.length > 0 && cleanupAllowed()) {
        if (await isCold($)) {
            $.ui.log('clean-up starts: restart, cache cold', { to: 'debug' });
            if (await runCleanup($, MARK_APPLY))
                $.ui.log('held clean-up applied at the restart, before the first request (cache cold)', { to: 'transcript' });
        }
        else
            armHeld($);
    }
    if (cfg.debugDir)
        await debugDump($, 'start', apiDigest((await $.session.messages({ as: 'api' })) as unknown as ApiMsg[]));
    if (rows.length > 0) {
        const stale = await checkResume($);
        if (stale > 0) {
            reapplyWanted = true;
            statusNote = 're-applying the earlier clean-up after a restart';
            render($);
            if (cleanupAllowed() && (await runCleanup($, MARK_REAPPLY)))
                reapplyWanted = false;
        }
    }
    if (layerWanted && cleanupAllowed() && rows.length > 0 && (await runCleanup($, MARK_LAYER)))
        layerWanted = false;
    render($);
    $.ui.log(`${VERSION}: agent ${cfg.agent} on ${cfg.machine}; layers ${layerSources()}; guard ${S.guarded === true ? 'present: clean-up off' : S.guarded === false ? 'absent' : 'unknown'}; idle ${cfg.idle.enabled ? cfg.idle.minutes + ' min' : 'off'}; hide old outputs ${cfg.hideOldToolOutputs ? 'on' : 'off'}`, { to: 'debug' });
}
let composeDumped = false;
export async function contextCompose($: Engine, e: PromptComposeInput, next: (e: PromptComposeInput) => Promise<PromptComposeResult>): Promise<PromptComposeResult> {
    S.composeSeen = true;
    if (S.guarded !== false && S.cfg)
        await settleGuard($, false);
    const r = await next(e);
    if (cfg?.debugDir && !composeDumped) {
        composeDumped = true;
        await debugDump($, 'compose', r.sections.map((x) => ({ id: x.id, scope: x.scope, chars: x.text.length })));
    }
    if (!cfg || !inForce.length)
        return r;
    const base = r.sections.filter((s) => !s.id.startsWith(PLUGIN + ':'));
    const mine = inForce.filter((l) => l.text.trim()).map((l) => ({ id: l.id, text: sectionText(l), scope: 'session' as const }));
    return { sections: [...base, ...mine] };
}
export async function contextLayerCheck($: Engine, versions?: Versions, offline = false) {
    if (!cfg || S.turnRunning)
        return;
    if (source && (versions || !offline))
        await checkLayerVersions($, source, versions);
    {
        await refreshLayers($);
        if (layersWaiting()) {
            const cold = S.lastRequest > 0 && (await $.clock.now()) - S.lastRequest > cfg.layerColdMinutes * 60000;
            if (urgentWaiting()) {
                if (cfg.systemPromptSnapshot === 'off')
                    await landLayers($, 'urgent change');
                else
                    layerWanted = true;
            }
            else if (cold && cfg.systemPromptSnapshot === 'off') {
                await landLayers($, 'the cache was cold');
            }
            if (layersWaiting()) {
                const note = layerChangeNote(noted ?? inForce, layers, EARLY_WHY);
                noted = layers.map((l) => ({ ...l }));
                if (note)
                    changeNote = changeNote ? `${changeNote}\n\n${note}` : note;
            }
            render($);
        }
    }
}
export async function contextSubmit($: Engine, e: PromptSubmitInput): Promise<PromptSubmitInput> {
    if (!cfg)
        return e;
    if (reminderText && !e.command) {
        const note = reminderText;
        reminderText = '';
        return { ...e, context: [...(e.context ?? []), note] };
    }
    return e;
}
export function realActivity() { idleAsked = false; }
let turnSerial = 0;
export async function contextTurnStart($: Engine) {
    turnSerial++;
    if (!cfg)
        return;
    await dropIdlePlan($);
    await countTurn($);
}
export async function contextTurn($: Engine, e: TurnCompleteInput, kind: string) {
    if (!cfg || e.agentId !== undefined)
        return;
    if (S.guarded !== false && e.usage)
        await settleGuard($, !S.composeSeen);
    if (S.guarded === true) {
        await tellGuard($);
        return;
    }
    await checkChain($);
    if (reapplyWanted && (await runCleanup($, MARK_REAPPLY)))
        reapplyWanted = false;
    if (cfg.hideOldToolOutputs && (kind === 'real' || kind === 'mail')) {
        const a = await readNow($, false);
        await queueOldToolOutputs($, a);
    }
    if (kind === 'real' || kind === 'mail')
        await closeOutcome($);
    if (kind === 'mail')
        await archiveMailTurn($);
    const pend = await loadPending($);
    if (pend.archives.length && !coldTurn && !pend.archives.some((f) => f.auto) && !(await nearLimit($))) {
        const w = weighPending(await readNow($, false), pend);
        if (!paysWhileWarm(w) && !(await isCold($))) {
            if (!heldSince)
                heldSince = new Date(await $.clock.now()).toISOString();
            statusNote = `clean-up held until the cache is cold (removes about ${kfmt(w.removed)}, rewrites about ${kfmt(w.rewritten)})`;
            $.ui.log(`clean-up held: removes about ${w.removed} tokens, rewrites about ${w.rewritten}; applies ${coldMinutes()} minutes after the last request`, { to: 'debug' });
            armHeld($);
            render($);
            if (kind === 'real' || kind === 'mail')
                armIdle($);
            await checkContextSize($);
            return;
        }
    }
    if (pend.archives.length || pend.keeps.length) {
        const was = coldTurn;
        coldTurn = false;
        $.ui.log(`clean-up starts: ${was ? "the mod's own turn, cache cold" : 'turn end'}`, { to: 'debug' });
        if (await runCleanup($, MARK_APPLY)) {
            heldTimer?.cancel();
            heldTimer = null;
            if (heldSince || was)
                $.ui.log(`held clean-up applied${was ? ' in the mod\'s own turn (cache cold, no request)' : ''}${heldSince ? `, held since ${heldSince.slice(11, 16)} UTC` : ''}`, { to: 'transcript' });
            heldSince = '';
        }
    }
    else if (layerWanted && layersWaiting())
        await runCleanup($, MARK_LAYER);
    if (kind === 'real' || kind === 'mail')
        armIdle($);
    await checkContextSize($);
}
const SOFT_LOCKS = (p: Part) => p.locked === REPLY_LOCK || /^one of the last \d+ turns/.test(p.locked ?? '');
const SEND_TOOL = /__send_message$/;
const MAIL_NOTE_MAX = 4000;
export function mailTurnNote(a: Analysis, parts: Part[]): string {
    const rows = a.rows;
    const prompt = parts.find((p) => p.kind === 'prompt');
    const ptext = prompt ? rows[prompt.rows[0]!]!.text : '';
    const head = (ptext.match(/AGENT MESSAGE: ([^\n]*)/)?.[1] ?? 'an agent message').trim();
    const body = ptext.replace(/^[\s\S]*?<<<msg-[a-z0-9]+\n/, '').replace(/\nmsg-[a-z0-9]+>>>[\s\S]*$/, '');
    const sent: string[] = [];
    for (const p of parts) {
        if (p.kind !== 'tool' || !p.tool || !SEND_TOOL.test(p.tool))
            continue;
        for (const i of p.rows)
            for (const u of rows[i]!.toolUses ?? []) {
                if (!SEND_TOOL.test(u.tool))
                    continue;
                const inp = (u.input ?? {}) as Record<string, unknown>;
                const to = String(inp.to ?? (inp.reply_to ? 'the sender' : 'an agent'));
                sent.push(`to ${to}: ${oneLine(String(inp.text ?? ''), MAIL_NOTE_MAX)}`);
            }
    }
    const lastText = [...parts].reverse().find((p) => p.kind === 'text');
    const answer = sent.length ? 'Answered ' + sent.join(' Then ') : lastText ? 'No message sent; last words: ' + oneLine(rows[lastText.rows[lastText.rows.length - 1]!]!.text, 400) : 'No answer was sent.';
    return oneLine(`Message turn (${head}): ${oneLine(body, 400)} ${answer}`, MAIL_NOTE_MAX - 100);
}
async function archiveMailTurn($: Engine): Promise<void> {
    const want = cfg?.mailTurns;
    if (!want?.archive)
        return;
    const a = await readNow($, false);
    const parts = a.parts.filter((p) => p.turn === a.lastTurn);
    if (!parts.some((p) => p.kind === 'prompt'))
        return;
    for (const p of parts)
        if (SOFT_LOCKS(p))
            p.locked = undefined;
    const free = parts.filter((p) => !p.locked && p.kind !== 'archived');
    const tokens = free.reduce((s, p) => s + p.tokens, 0);
    if (!free.length || tokens < want.minTokens) {
        $.ui.log(`message turn kept: ${tokens} tokens, below ${want.minTokens}`, { to: 'debug' });
        return;
    }
    const ids = fmtIds(free.map((p) => p.id));
    const prompt = parts.find((p) => p.kind === 'prompt')!;
    const first = prompt.id;
    const last = parts[parts.length - 1]!.id;
    void $.clock.after(0, () => void mailNoteByFork($, a, ids, first, last, tokens));
}
export const MAIL_NOTE_ASK = 'Answer with JSON only, no other text: {"note":"..."} (at most 1,800 characters), or {"note":""} to keep the turn as it is.';
export function parseNote(text: string): string | null {
    const t = String(text ?? '');
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a < 0 || b <= a)
        return null;
    try {
        const j = JSON.parse(t.slice(a, b + 1)) as {
            note?: unknown;
        };
        return typeof j.note === 'string' ? j.note.trim() : null;
    }
    catch {
        return null;
    }
}
async function mailNoteByFork($: Engine, a: Analysis, ids: string, first: number, last: number, tokens: number): Promise<void> {
    let refusal = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
        const again = refusal ? ` Your first answer was refused (${refusal.slice(0, 200)}); answer again.` : '';
        const ask = `${IDLE_MARK} Background note (the turn started by the agent message at part #${first} has ended). This is a fork of your conversation: nothing you write here enters it, and every tool is denied. ` +
            `The work of that turn (parts ${ids}, about ${kfmt(tokens)} tokens) is archived now, and your note stays in its place: you will work from the note alone. ` +
            'Write it in plain sentences: what the message asked; what you did and found; the results with their exact values (versions, hashes, paths, numbers); ' +
            'what is still open now (a step not done, an answer awaited, a check not run, a decision for ' + owner() + '), or that nothing is open; and any news ' + owner() + ' must hear, or none.' +
            again + ' ' + MAIL_NOTE_ASK;
        const r = (await $.model.fork({ prompt: ask }).catch((err: unknown) => ({ isAnswered: false, reason: 'error: ' + String(err).slice(0, 80) }))) as {
            isAnswered?: boolean;
            text?: string;
            reason?: string;
            usage?: {
                cache_read_input_tokens?: number;
                cache_creation_input_tokens?: number;
                output_tokens?: number;
            };
        };
        const read = Number(r.usage?.cache_read_input_tokens ?? 0);
        const write = Number(r.usage?.cache_creation_input_tokens ?? 0);
        const out = Number(r.usage?.output_tokens ?? 0);
        if (!r.isAnswered) {
            refusal = `the fork got no answer (${String(r.reason)})`;
            await recordHidden($, { kind: 'mailnote', ok: false, try: attempt, reason: refusal });
            continue;
        }
        const note = parseNote(String(r.text ?? ''));
        if (note === null) {
            refusal = 'the answer held no JSON with a note: ' + String(r.text ?? '').slice(0, 120);
            await recordHidden($, { kind: 'mailnote', ok: false, try: attempt, read, write, out, reason: refusal });
            continue;
        }
        if (!note) {
            await recordHidden($, { kind: 'mailnote', ok: true, try: attempt, read, write, out, archives: 0 });
            $.ui.log('message turn kept: the fork chose to keep it', { to: 'debug' });
            return;
        }
        const q = await toolArchive($, { archives: [{ parts: ids, note: note.slice(0, 2000) }] }, a, true);
        if ('result' in q && q.result.includes('Queued')) {
            await recordHidden($, { kind: 'mailnote', ok: true, try: attempt, read, write, out, archives: 1 });
            $.ui.log(`message turn archived (${tokens} tokens), note by the fork: ${oneLine(q.result, 200)}; ${read} read from the cache, ${write} written, ${out} out`, { to: 'debug' });
            return;
        }
        refusal = 'deny' in q ? q.deny : q.result;
        await recordHidden($, { kind: 'mailnote', ok: false, try: attempt, read, write, out, reason: refusal.slice(0, 300) });
        if (/already in a waiting archive|locked/.test(refusal))
            break;
    }
    $.ui.log(`message turn kept: the fork gave no note after two tries (${refusal.slice(0, 160)})`, { to: 'debug' });
}
export const ownCompaction = (e: SessionCompactInput) => e.trigger === 'plugin' && e.agentId === undefined && [MARK_APPLY, MARK_LAYER, MARK_REAPPLY].includes(String(e.instructions));
export const OWN_COMPACTION_FAILED = `${PLUGIN}: the clean-up failed inside the mod; the conversation is unchanged`;
export async function contextCompact($: Engine, e: SessionCompactInput, next: (e: SessionCompactInput) => Promise<SessionCompactResult>): Promise<SessionCompactResult> {
    if (ownCompaction(e))
        S.ownCompactAt = await $.clock.now();
    if (!cfg || e.agentId !== undefined)
        return next(e);
    if (ownCompaction(e)) {
        answered = true;
        try {
            if (e.instructions === MARK_APPLY)
                return await applyCleanup($, e, false);
            if (e.instructions === MARK_LAYER)
                return await applyCleanup($, e, cfg.dropThinkingOnLayerChange, true);
            return await applyReapply($, e);
        }
        catch (err) {
            await report($, `${OWN_COMPACTION_FAILED} (${String(err).slice(0, 160)})`, true, 'clean-up failed, conversation unchanged').catch(() => undefined);
            return { skip: OWN_COMPACTION_FAILED };
        }
    }
    const pend = await loadPending($);
    if (pend.archives.length && e.trigger === 'precompute')
        return { skip: `${PLUGIN}: the agent's own archive list is waiting` };
    if (pend.archives.length && e.trigger === 'auto') {
        $.ui.log(`Claude Code compacted ${S.turnRunning ? 'inside a turn' : 'between turns'}; the agent's queued clean-up answers it`, { to: 'debug' });
        const done = await applyCleanup($, e, false);
        if (done.skip === undefined)
            return done;
    }
    if (e.trigger === 'auto') {
        const own = await compactMechanical($, e, S.turnRunning);
        if (own)
            return own;
    }
    const r = await next(e);
    if (r.skip === undefined && e.trigger !== 'precompute')
        await landLayers($, 'Claude Code compacted');
    return r;
}
const SUMMARY_SHARE = 0.97;
async function compactMechanical($: Engine, e: SessionCompactInput, inside: boolean): Promise<SessionCompactResult | undefined> {
    const usage = await $.session.usage().catch(() => undefined);
    const tokens = usage?.context?.tokens ?? 0;
    const window = usage?.context?.window ?? 0;
    const where = inside ? 'inside a turn' : 'between turns';
    let line = Math.floor(window * SUMMARY_SHARE);
    if (inside && (!window || tokens < line)) {
        $.ui.log(`Claude Code compacted inside a turn at ${tokens} of ${window} tokens with nothing queued; skipped`, { to: 'debug' });
        return { skip: `${PLUGIN}: no summary inside a turn; the agent was asked to archive` };
    }
    if (!inside) {
        if (!window || !cfg)
            return undefined;
        const l = limitsOf(cfg, window);
        line = l.remindAt || l.forceAt || Math.floor(window * REMIND_MAX_SHARE);
    }
    const rows = e.messages as Row[];
    const a = analyze(rows, (await $.session.messages({ as: 'api' })) as unknown as ApiMsg[], false);
    const need = tokens - line + 1;
    const picked: Part[] = [];
    let freed = 0;
    const take = (ok: (p: Part) => boolean) => {
        for (const p of a.parts) {
            if (freed >= need)
                break;
            if (p.locked || picked.includes(p) || !ok(p))
                continue;
            const group = a.parts.filter((q) => q.link === p.link);
            if (group.some((q) => q.locked || !ok(q)))
                continue;
            picked.push(...group.filter((q) => !picked.includes(q)));
            freed = picked.reduce((s, q) => s + q.tokens, 0);
        }
    };
    take((p) => p.kind === 'tool');
    if (!inside && freed < need)
        take((p) => p.kind !== 'archived');
    picked.sort((x, y) => x.id - y.id);
    const calls = picked.filter((p) => p.kind === 'tool').map((p) => p.label.split(', result: ')[0]!);
    const prompts = picked.filter((p) => p.kind === 'prompt').map((p) => p.label);
    const pct = window ? Math.round((tokens / window) * 100) : 0;
    const note = oneLine(`${inside ? 'Old tool outputs' : 'Old work'} archived automatically when the conversation reached ${pct} percent of the window ${where}` +
        (prompts.length ? `; requests: ${prompts.slice(0, 8).join('; ')}${prompts.length > 8 ? `; and ${prompts.length - 8} more` : ''}` : '') +
        (calls.length ? `; calls: ${calls.slice(0, 8).join('; ')}${calls.length > 8 ? `; and ${calls.length - 8} more` : ''}` : '') + '.', 1500);
    if (!picked.length || freed - est(note) < need) {
        $.ui.log(`Claude Code compacted ${where} at ${tokens} of ${window} tokens; the mod can free about ${freed}, ${need} needed; its summary runs`, { to: 'debug' });
        return undefined;
    }
    const q = await toolArchive($, { archives: [{ parts: picked.map((p) => p.id).join(','), note }] }, a, true);
    if (!('result' in q) || !q.result.includes('Queued'))
        return undefined;
    $.ui.log(`Claude Code compacted ${where} at ${tokens} of ${window} tokens; the mod archived ${picked.length} part(s), about ${freed} tokens`, { to: 'debug' });
    const done = await applyCleanup($, e, false);
    return done.skip === undefined ? done : undefined;
}
const NOT_CONFIGURED = `${PLUGIN} is not configured in this folder (no .claude/havok-mod.json, or its context part is off).`;
const guardRefusal = (what: string) => `${what} is off in this session: ${GUARD_REASON}. Nothing was queued and the conversation is unchanged; Claude Code's own compaction works as usual. Archiving needs this agent on a personal account, or the mod seated above the guard by managed settings (an admin decides).`;
export function contextTools(on: On) {
    on('tool.call', toolMatch('context_map'), async ($, e) => {
        if (!cfg)
            return { deny: NOT_CONFIGURED };
        if (e.agentId !== undefined)
            return { deny: 'The map covers the main conversation only.' };
        return { result: await toolMap($, e as unknown as Record<string, unknown>) };
    }).catch(() => ({ deny: "The map could not be made this time; nothing changed. Try again." }));
    on('tool.call', toolMatch('context_archive'), async ($, e) => {
        if (!cfg)
            return { deny: NOT_CONFIGURED };
        if (await isBackgroundFork($, e.agentId))
            return { deny: FORK_REFUSAL };
        if (e.agentId !== undefined)
            return { deny: 'Archiving covers the main conversation only.' };
        if (!S.composeSeen)
            await settleGuard($, true);
        if (S.guarded === true) {
            await tellGuard($);
            return { deny: guardRefusal('Archiving') };
        }
        return toolArchive($, e as unknown as Record<string, unknown>);
    }).catch(() => ({ deny: "The archive failed in the mod; nothing was queued. Try again." }));
    on('tool.call', toolMatch('context_restore'), async ($, e) => {
        if (!cfg)
            return { deny: NOT_CONFIGURED };
        if (await isBackgroundFork($, e.agentId))
            return { deny: FORK_REFUSAL };
        return toolRestore($, e as unknown as Record<string, unknown>);
    }).catch(() => ({ deny: "The bring-back failed in the mod; nothing changed. Try again." }));
    on('tool.call', toolMatch('archive_note'), async () => ({ deny: 'Nothing to do: the mod writes these calls where it archived parts; the note is the result of the call already in your conversation. Use context_restore to bring an archive back.' }));
    on('tool.call', toolMatch('context_keep'), async ($, e) => {
        if (!cfg)
            return { deny: NOT_CONFIGURED };
        if (await isBackgroundFork($, e.agentId))
            return { deny: FORK_REFUSAL };
        if (!S.composeSeen)
            await settleGuard($, true);
        if (S.guarded === true) {
            await tellGuard($);
            return { deny: guardRefusal('Keeping a fact in your layer') };
        }
        return toolKeep($, e as unknown as Record<string, unknown>);
    }).catch(() => ({ deny: "The keep failed in the mod; nothing was queued. Try again." }));
}
const NOTE_ROW = /^archived: (A\d+)\. I archived [^\n]*?about ([\d.]+k?) tokens\)/;
const NOTE_MORE = /^archived: (A\d+) continues here/;
export function foldedNote(text: string): string {
    const t = String(text ?? '');
    const m = NOTE_ROW.exec(t);
    if (m)
        return `archived: ${m[1]}, about ${m[2]} tokens`;
    const c = NOTE_MORE.exec(t);
    return c ? `archived: ${c[1]}, continued` : '';
}
