import type { EngineInterface } from 'claude-code';
import { reserveOf, accountOf, claudeFiles } from './brain/limit-rules.mjs';
export type Engine = EngineInterface;
export const PLUGIN = 'havok-mod';
export const VERSION = '0.1.86';
export const toolName = (n: string) => `mcp__${PLUGIN}__${n}`;
export const toolMatch = (n: string) => ({ tool: new RegExp('^' + toolName(n).replace(/[.*+?^${}()|[\]\\]/g, (c) => '\\' + c) + '$') });
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const MACHINE_RE = /^[A-Z0-9][A-Z0-9_-]{0,62}$/;
const MIN_TIMER_SECONDS = 5;
export type ContextConfig = {
    enabled: boolean;
    layersDir: string;
    layerHost: string;
    agentLayerDir: string;
    machineLayerFile: string;
    archiveDir: string;
    layerMaxChars: number;
    hostBudgetMs: number;
    locks: boolean;
    notesFile: string;
    lockRecentTurns: number;
    lockRecentTokens: number;
    hideOldToolOutputs: boolean;
    hideAfterTurns: number;
    hideMinTokens: number;
    systemPromptSnapshot: 'on' | 'off';
    layerColdMinutes: number;
    heldColdMinutes: number;
    restartSafe: boolean;
    idle: {
        enabled: boolean;
        minutes: number;
        floorTokens: number;
        fork: boolean;
        applyMinutes: number;
    };
    outcomeTurns: number;
    mailTurns: {
        archive: boolean;
        minTokens: number;
    };
    remindAt: number;
    forceAt: number;
};
export type Config = {
    agent: string;
    main: boolean;
    machine: string;
    groups: string[];
    home: string;
    cwd: string;
    context: ContextConfig;
    padding: {
        enabled: boolean;
        minBytes: number;
    };
    mail: {
        enabled: boolean;
        url: string;
        tokenFile: string;
        waitSeconds: number;
        beatSeconds: number;
        heldRetrySeconds: number;
        failRetrySeconds: number;
        asUser: boolean;
        ownerNames: string[];
    };
    keepWarm: {
        enabled: boolean;
        pingText: string;
        everyMinutes: number;
        maxPings: number;
        limitPercent: number;
        limitsFile: string;
        quietHoursUtc: number[];
        fork: boolean;
    };
    usage: {
        enabled: boolean;
        dir: string;
    };
    checks: {
        brainDir: string;
        healthTimeoutMs: number;
        downAfterMs: number;
        proxyStateFile: string;
        recallBudgetMs: number;
    };
    remoteControl: {
        enabled: boolean;
        name: string;
        heal: boolean;
    };
    menu: {
        enabled: boolean;
        name: string;
        icon: string;
        color: string;
    };
    modelEffort: {
        model: string;
        effort: string;
    };
    debugDir: string;
};
export type Org = {
    home: string;
    mailLocal: string;
    mailRemote: string;
    reportTo: string;
    alertsTo: string;
    layerHost: string;
    brainDir: string;
    owner: string;
    mainAgent: string;
    reviewUrl: string;
    writingStyle: string;
};
const NO_ORG: Org = { home: '', mailLocal: '', mailRemote: '', reportTo: '', alertsTo: '', layerHost: '', brainDir: '', owner: '', mainAgent: '', reviewUrl: '', writingStyle: '' };
let ORG: Org = NO_ORG;
export const org = (): Org => ORG;
export const owner = () => ORG.owner || 'the owner';
export const mainAgent = () => ORG.mainAgent || 'the main agent';
export const homeName = () => ORG.home || 'the brain server';
export function setOrg(o: Partial<Org> | null) {
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    ORG = o ? { home: str(o.home), mailLocal: str(o.mailLocal), mailRemote: str(o.mailRemote), reportTo: str(o.reportTo), alertsTo: str(o.alertsTo), layerHost: str(o.layerHost), brainDir: str(o.brainDir), owner: str(o.owner), mainAgent: str(o.mainAgent), reviewUrl: str(o.reviewUrl), writingStyle: str(o.writingStyle) } : NO_ORG;
}
async function loadOrg($: Engine) {
    try {
        setOrg(JSON.parse(await $.fs.read(`${slash(String($.plugin.root ?? ''))}/org.json`)) as Partial<Org>);
    }
    catch { }
}
export const PADDING_MIN_BYTES = 5767168;
const isHome = (machine: string) => !!ORG.home && machine.toUpperCase() === ORG.home.toUpperCase();
export function defaults(home: string, machine: string, cwd: string, configDir = ''): Omit<Config, 'agent'> {
    const base = `${home}/.claude/havok-mod`;
    return {
        main: false,
        machine,
        groups: [],
        home,
        cwd,
        context: {
            enabled: true,
            layersDir: '',
            layerHost: ORG.layerHost,
            agentLayerDir: '',
            machineLayerFile: '',
            archiveDir: `${base}/archive`,
            layerMaxChars: 20000,
            hostBudgetMs: 0,
            locks: false,
            notesFile: '',
            lockRecentTurns: 3,
            lockRecentTokens: 30000,
            hideOldToolOutputs: false,
            hideAfterTurns: 3,
            hideMinTokens: 2000,
            systemPromptSnapshot: 'on',
            layerColdMinutes: 60,
            heldColdMinutes: 61,
            restartSafe: true,
            idle: { enabled: false, minutes: isHome(machine) ? 50 : 55, floorTokens: 35000, fork: isHome(machine), applyMinutes: 50 },
            outcomeTurns: 5,
            mailTurns: { archive: false, minTokens: 1500 },
            remindAt: 600000,
            forceAt: 900000,
        },
        padding: { enabled: true, minBytes: PADDING_MIN_BYTES },
        mail: {
            enabled: false,
            url: isHome(machine) ? ORG.mailLocal : ORG.mailRemote,
            tokenFile: `${home}/.claude/havok-server-token`,
            waitSeconds: 25,
            beatSeconds: 20,
            heldRetrySeconds: 30,
            failRetrySeconds: 300,
            asUser: true,
            ownerNames: [],
        },
        keepWarm: {
            enabled: false,
            pingText: 'keep-warm ping',
            everyMinutes: 50,
            maxPings: 8,
            limitPercent: 95,
            limitsFile: claudeFiles(home, configDir).limits,
            quietHoursUtc: [0, 8],
            fork: true,
        },
        usage: { enabled: true, dir: `${base}/usage` },
        checks: { brainDir: ORG.brainDir, healthTimeoutMs: 6000, downAfterMs: 30000, proxyStateFile: '', recallBudgetMs: 6000 },
        remoteControl: { enabled: true, name: '', heal: true },
        menu: { enabled: true, name: '', icon: '', color: '' },
        modelEffort: { model: '', effort: '' },
        debugDir: '',
    };
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function merge<T>(base: T, over: unknown): T {
    if (!isObj(base) || !isObj(over))
        return base;
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(over)) {
        const cur = (base as Record<string, unknown>)[k];
        if (cur === undefined)
            continue;
        if (isObj(cur))
            out[k] = merge(cur, v);
        else if (Array.isArray(cur) ? Array.isArray(v) : typeof v === typeof cur)
            out[k] = v;
    }
    return out as T;
}
const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
async function readJson($: Engine, path: string): Promise<Record<string, unknown> | null | 'bad'> {
    let text: string;
    try {
        text = await $.fs.read(path);
    }
    catch {
        return null;
    }
    try {
        const v = JSON.parse(text);
        return isObj(v) ? v : 'bad';
    }
    catch {
        return 'bad';
    }
}
async function agentConfig($: Engine, cwd: string): Promise<{
    file: string;
    raw: Record<string, unknown>;
    agent: string;
} | null> {
    const dir = `${slash(cwd)}/.claude`;
    const parent = String((await $.env.get('CLAUDECODE')) ?? '').trim();
    if (parent && parent !== '0' && String((await $.env.get('HAVOK_MOD_ALLOW_CHILD')) ?? '').trim() !== '1')
        return null;
    const named = String((await $.env.get('HAVOK_MOD_AGENT')) ?? '').trim().toLowerCase();
    const plain = `${dir}/havok-mod.json`;
    const home = slash((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '');
    const homeFile = home && `${home}/.claude` !== dir ? [`${home}/.claude/havok-mod.${named}.json`] : [];
    const candidates = named && NAME_RE.test(named) ? [`${dir}/havok-mod.${named}.json`, plain, ...homeFile] : [];
    for (const file of candidates) {
        const raw = await readJson($, file);
        if (raw === null)
            continue;
        if (raw === 'bad') {
            $.ui.log(`${file} is not a JSON object; the mod stays off in this session`, { to: 'transcript' });
            return null;
        }
        const given = String(raw.agent ?? '').toLowerCase();
        if (file === plain) {
            if (named && given !== named)
                return null;
            if (!NAME_RE.test(given)) {
                $.ui.log(`${file} needs "agent", a lowercase name; the mod stays off in this folder`, { to: 'transcript' });
                return null;
            }
            return { file, raw, agent: given };
        }
        if (given && given !== named) {
            $.ui.log(`${file} names agent "${given}" but HAVOK_MOD_AGENT is "${named}"; the mod stays off in this session`, { to: 'transcript' });
            return null;
        }
        return { file, raw, agent: named };
    }
    return null;
}
export async function brainMarker($: Engine, home: string): Promise<string> {
    try {
        const first = (await $.fs.read(`${home}/.claude/havok-brain-path`)).split(/\r?\n/)[0]!.trim();
        return /^([a-zA-Z]:)?[\\/]/.test(first) ? slash(first) : '';
    }
    catch {
        return '';
    }
}
export async function brainPluginRoot($: Engine, home: string): Promise<string> {
    try {
        const installed = JSON.parse(await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`)) as {
            plugins?: Record<string, {
                installPath?: string;
            }[]>;
        };
        const entry = (installed.plugins?.['havok-brain@havok-brain'] ?? []).find((x) => x && x.installPath);
        return entry?.installPath ? slash(entry.installPath) : '';
    }
    catch {
        return '';
    }
}
export async function subscriptionReserve($: Engine, home: string, brainDir: string) {
    const json = async (f: string): Promise<unknown> => {
        try {
            return JSON.parse(await $.fs.read(f));
        }
        catch {
            return null;
        }
    };
    const dir = brainDir || (await brainMarker($, home)) || (await brainPluginRoot($, home));
    const { claudeJson } = claudeFiles(home, String((await $.env.get('CLAUDE_CONFIG_DIR')) ?? ''));
    return reserveOf(dir ? await json(`${dir}/brain.json`) : null, accountOf(await json(claudeJson)));
}
export function resolveLayerDirs(home: string, layersDir: string, agentLayerDir: string, brainDir: string): {
    layersDir: string;
    agentLayerDir: string;
} {
    const local = `${home}/.claude/havok-mod/layers`;
    const brainLayers = brainDir ? `${slash(brainDir)}/layers` : '';
    const shared = slash(layersDir) || brainLayers || local;
    const inBrain = !!brainLayers && shared.toLowerCase() === brainLayers.toLowerCase();
    return { layersDir: shared, agentLayerDir: slash(agentLayerDir) || (inBrain ? `${local}/agent` : `${shared}/agent`) };
}
export async function loadConfig($: Engine, cwd: string): Promise<Config | null> {
    await loadOrg($);
    const found = await agentConfig($, cwd);
    if (!found)
        return null;
    const agentRaw = found.raw;
    const home = slash((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '');
    const machineFile = slash((await $.env.get('HAVOK_MOD_MACHINE_CONFIG')) || `${home}/.claude/havok-mod/machine.json`);
    let machineRaw = await readJson($, machineFile);
    if (machineRaw === 'bad') {
        $.ui.log(`${machineFile} is not a JSON object; it is ignored`, { to: 'transcript' });
        machineRaw = null;
    }
    const host = String((await $.env.get('COMPUTERNAME')) || (await $.env.get('HOSTNAME')) || 'LOCAL').toUpperCase();
    let machineName = String(agentRaw.machine || machineRaw?.machine || host).toUpperCase();
    if (!MACHINE_RE.test(machineName)) {
        $.ui.log(`machine "${machineName.slice(0, 40)}" is not a plain name; ${host} is used`, { to: 'transcript' });
        machineName = MACHINE_RE.test(host) ? host : 'LOCAL';
    }
    const agent = found.agent;
    let c = defaults(home, machineName, slash(cwd), String((await $.env.get('CLAUDE_CONFIG_DIR')) ?? '')) as Config;
    c = merge(c, machineRaw ?? {});
    c = merge(c, agentRaw);
    c.agent = agent;
    c.machine = machineName;
    c.home = home;
    c.cwd = slash(cwd);
    c.groups = c.groups.map((g) => String(g).toLowerCase()).filter((g) => NAME_RE.test(g));
    Object.assign(c.context, resolveLayerDirs(home, c.context.layersDir, c.context.agentLayerDir, slash(c.checks.brainDir) || (await brainMarker($, home))));
    c.context.archiveDir = slash(c.context.archiveDir);
    c.context.notesFile = slash(c.context.notesFile) || `${c.context.archiveDir}/cleanup-notes.${agent}.md`;
    c.context.systemPromptSnapshot = c.context.systemPromptSnapshot === 'off' ? 'off' : 'on';
    c.usage.dir = slash(c.usage.dir);
    c.mail.url = slash(c.mail.url);
    c.mail.ownerNames = Array.isArray(c.mail.ownerNames) ? c.mail.ownerNames.filter((n: unknown) => typeof n === 'string' && n.trim()).map((n: string) => n.trim()).slice(0, 20) : [];
    const pos = (v: number, d: number) => (Number.isFinite(v) && v > 0 ? v : d);
    const d = defaults(home, machineName, c.cwd);
    c.mail.waitSeconds = Math.min(pos(c.mail.waitSeconds, d.mail.waitSeconds), 28);
    c.keepWarm.everyMinutes = Math.min(pos(c.keepWarm.everyMinutes, d.keepWarm.everyMinutes), 58);
    c.mail.beatSeconds = Math.max(MIN_TIMER_SECONDS, pos(c.mail.beatSeconds, d.mail.beatSeconds));
    c.mail.heldRetrySeconds = Math.max(MIN_TIMER_SECONDS, pos(c.mail.heldRetrySeconds, d.mail.heldRetrySeconds));
    c.mail.failRetrySeconds = Math.max(MIN_TIMER_SECONDS, pos(c.mail.failRetrySeconds, d.mail.failRetrySeconds));
    const hours = c.keepWarm.quietHoursUtc.map(Number);
    c.keepWarm.quietHoursUtc = hours.length === 2 && hours.every((x) => Number.isInteger(x) && x >= 0 && x <= 23) ? hours : d.keepWarm.quietHoursUtc;
    c.keepWarm.fork = c.keepWarm.fork !== false;
    c.keepWarm.maxPings = Math.max(0, Math.floor(c.keepWarm.maxPings));
    const tokens = (v: number, dflt: number) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : dflt);
    c.context.remindAt = tokens(c.context.remindAt, d.context.remindAt);
    c.context.forceAt = tokens(c.context.forceAt, d.context.forceAt);
    c.context.idle.floorTokens = tokens(c.context.idle.floorTokens, d.context.idle.floorTokens);
    c.context.idle.fork = c.context.idle.fork !== false;
    if (!(c.context.idle.applyMinutes > 0))
        c.context.idle.applyMinutes = 50;
    c.context.outcomeTurns = Math.max(1, Math.floor(pos(c.context.outcomeTurns, d.context.outcomeTurns)));
    c.context.lockRecentTurns = Math.max(0, Math.floor(c.context.lockRecentTurns));
    c.context.hideAfterTurns = Math.max(1, Math.floor(c.context.hideAfterTurns));
    return c;
}
export type TurnKind = 'real' | 'ping' | 'idle' | 'mail' | 'none';
export const S = {
    cfg: null as Config | null,
    sessionId: '',
    turnRunning: false,
    commandUntil: 0,
    turnKind: 'none' as TurnKind,
    lastReal: 0,
    lastRequest: 0,
    ownCompactAt: 0,
    composeSeen: false,
    guarded: undefined as boolean | undefined,
    pingSent: false,
};
export const IDLE_MARK = '[Neuraxis mod, not the user]';
const OLD_IDLE_MARK = '[Havok context mod, not the user]';
export const hasIdleMark = (t: string) => t.includes(IDLE_MARK) || t.includes(OLD_IDLE_MARK);
export const stripIdleMarks = (t: string) => t.split(OLD_IDLE_MARK).join('').split(IDLE_MARK).join('');
export const MAIL_WORD = 'AGENT MESSAGE: ';
const MAIL_HEADER = /^(?:[^\n]*sent a message:\n)?AGENT MESSAGE: [^\s,]+, (?:\d{4}-\d\d-\d\d \d\d:\d\d UTC|unknown time) \(id /;
export const isMailText = (t: string) => MAIL_HEADER.test(String(t ?? ''));
export function kindOf(text: string): TurnKind {
    const c = S.cfg;
    const t = String(text ?? '');
    if (c && (t.trim() === c.keepWarm.pingText || (S.pingSent && t.includes(c.keepWarm.pingText)))) {
        S.pingSent = false;
        return 'ping';
    }
    if (hasIdleMark(t))
        return 'idle';
    if (isMailText(t))
        return 'mail';
    return 'real';
}
export async function markReal($: Engine) { S.lastReal = await $.clock.now(); }
const STORE_TRIES = 6;
const STORE_RETRY_MS = 50;
export async function update<T>($: Engine, key: string, change: (cur: T | undefined) => T, holds?: (stored: T | undefined) => boolean): Promise<T> {
    let last: unknown = null;
    for (let i = 0; i < STORE_TRIES; i++) {
        try {
            const next = change((await $.store.get(key)) as T | undefined);
            await $.store.set(key, next);
            if (!holds || holds((await $.store.get(key)) as T | undefined))
                return next;
            last = new Error('overwritten by another session');
        }
        catch (err) {
            last = err;
        }
        if (i < STORE_TRIES - 1)
            await $.clock.sleep(STORE_RETRY_MS * 2 ** i);
    }
    throw last instanceof Error ? last : new Error(String(last));
}
export async function storeSet($: Engine, key: string, value: unknown) { return update($, key, () => value); }
export async function storeDelete($: Engine, key: string) {
    for (let i = 0; i < STORE_TRIES; i++) {
        try {
            await $.store.delete(key);
            return;
        }
        catch {
            if (i < STORE_TRIES - 1)
                await $.clock.sleep(STORE_RETRY_MS * 2 ** i);
        }
    }
}
export async function isBackgroundFork($: Engine, agentId: string | undefined): Promise<boolean> {
    if (!agentId)
        return false;
    const listed = await $.agent.list().catch(() => []);
    const fork = !listed.some((a) => a.id === agentId);
    if (fork)
        $.ui.log(`refused a background fork (agentId ${agentId}) on one of this mod's tools`, { to: 'debug' });
    return fork;
}
export const FORK_REFUSAL = 'The Neuraxis mod answers the conversation itself and its own agents, not a background fork of Claude Code; nothing was done.';
export const GUARD_REASON = 'an organization guard of Claude Code skips this mod\'s clean-up and system-prompt hooks on this account (Team or Enterprise plan, or managed settings)';
const kGuard = () => `guard:${S.cfg?.machine ?? ''}`;
export async function knownGuard($: Engine): Promise<boolean | undefined> {
    const g = (await $.store.get(kGuard()).catch(() => undefined)) as {
        guarded?: boolean;
    } | undefined;
    return typeof g?.guarded === 'boolean' ? g.guarded : undefined;
}
export async function settleGuard($: Engine, guarded: boolean) {
    const was = S.guarded;
    S.guarded = guarded;
    if (was !== guarded)
        await storeSet($, kGuard(), { guarded, at: await $.clock.now() }).catch(() => undefined);
}
export const cleanupAllowed = () => S.guarded === false;
export type CleanedContext = {
    tokens: number;
    window: number;
    at: string;
};
export type WarmLast = {
    at: string;
    ok: boolean;
    read: number;
};
export type WarmStatus = {
    on: false;
} | {
    on: true;
    pings: number;
    max: number;
    next?: string;
    last?: WarmLast;
};
export type UpdateField = {
    version: string;
    state: 'waiting' | 'failed';
};
export type RcStatus = {
    on: boolean;
    name: string;
    want: string;
};
export type OwnStatus = {
    model: string;
    effort: string;
    by?: string;
};
export type StatusFile = {
    at: string;
    agent?: string;
    turn?: 'running' | 'idle';
    mail: 'on' | 'off' | 'down';
    cleanup: string;
    attention: string;
    detail: string;
    context?: CleanedContext;
    warm?: WarmStatus;
    cleanedAt?: string;
    update?: UpdateField;
    rc?: RcStatus;
    own?: OwnStatus;
    decisions?: number;
};
const parts = new Map<string, string>();
let cleaned: CleanedContext | null = null;
let cleanedAt = '';
let warm: WarmStatus | null = null;
let waitingUpdate: UpdateField | null = null;
let rc: RcStatus | null = null;
let ownStatus: OwnStatus | null = null;
let decisionsWaiting = -1;
let shownAttention = '';
let lastWrite = '';
let lastWriteAt = 0;
const STATUS_REFRESH_MS = 2 * 60000;
export const STATUS_DIR = 'havok-mod/status';
export const statusFile = (home: string, session: string) => `${home}/.claude/${STATUS_DIR}/${session}.json`;
export function statusOf(p: ReadonlyMap<string, string>): Omit<StatusFile, 'at'> {
    const mail = p.get('mail') ?? '';
    const ctx = (p.get('ctx') ?? '').replace(/^ctx /, '');
    const attention: string[] = [];
    let mailState: StatusFile['mail'] = mail ? 'on' : 'off';
    if (/not reachable|server error/.test(mail)) {
        mailState = 'down';
        attention.push(mail);
    }
    else if (/type anything to let them in/.test(mail))
        attention.push(mail);
    let cleanup = '';
    if (/not re-applied/.test(ctx)) {
        cleanup = 're-apply failed';
        attention.push(ctx);
    }
    else if (/failed|refused|not applied|not saved|unreadable|too long|not text|not loaded|unreachable|not downloaded|seed copy/.test(ctx))
        attention.push(ctx);
    else if (/queued for the end/.test(ctx))
        cleanup = 'queued';
    else if (/organization guard/.test(ctx))
        cleanup = 'off';
    const remote = p.get('rc') ?? '';
    if (remote)
        attention.push(remote);
    const detail = ['ctx', 'mail', 'warm'].filter((k) => p.has(k)).map((k) => p.get(k)!).join(' | ');
    return { mail: mailState, cleanup, attention: attention.join(' | '), detail };
}
const STEP_REFRESH_MS = 30000;
async function writeStatus($: Engine, force: boolean, refreshMs = STATUS_REFRESH_MS) {
    const c = S.cfg;
    if (!c || !S.sessionId)
        return;
    const s = { agent: c.agent, turn: S.turnRunning ? 'running' : 'idle', ...statusOf(parts), ...(cleaned ? { context: cleaned } : {}), ...(warm ? { warm } : {}), ...(cleanedAt ? { cleanedAt } : {}), ...(waitingUpdate ? { update: waitingUpdate } : {}), ...(rc ? { rc } : {}), ...(ownStatus ? { own: ownStatus } : {}), ...(decisionsWaiting >= 0 ? { decisions: decisionsWaiting } : {}) };
    const key = JSON.stringify(s);
    const now = await $.clock.now();
    if (!force && key === lastWrite && now - lastWriteAt < refreshMs)
        return;
    lastWrite = key;
    lastWriteAt = now;
    await $.fs.write(statusFile(c.home, S.sessionId), JSON.stringify({ at: new Date(now).toISOString(), ...s })).catch(() => undefined);
}
let writing: Promise<unknown> = Promise.resolve();
export function setStatus($: Engine, part: string, text: string) {
    if (text)
        parts.set(part, text);
    else
        parts.delete(part);
    if (!S.cfg)
        return;
    const { attention } = statusOf(parts);
    if (attention !== shownAttention) {
        shownAttention = attention;
        $.ui.status(attention ? `havok ${S.cfg.agent}: ${attention}` : undefined);
    }
    writing = writing.then(() => writeStatus($, false)).catch(() => undefined);
}
export function setUpdateStatus($: Engine, u: UpdateField | null) {
    if (JSON.stringify(u) === JSON.stringify(waitingUpdate))
        return;
    waitingUpdate = u;
    writing = writing.then(() => writeStatus($, false)).catch(() => undefined);
}
export function setRcStatus($: Engine, v: RcStatus | null) {
    if (JSON.stringify(v) === JSON.stringify(rc))
        return;
    rc = v;
    writing = writing.then(() => writeStatus($, false)).catch(() => undefined);
}
export function setCleanedContext($: Engine, v: CleanedContext) {
    cleaned = v;
    cleanedAt = v.at;
    writing = writing.then(() => writeStatus($, false)).catch(() => undefined);
}
export function setCleanedAt($: Engine, iso: string) {
    cleanedAt = iso;
    writing = writing.then(() => writeStatus($, false)).catch(() => undefined);
}
export function setDecisionsWaiting($: Engine, n: number) {
    const v = Number.isFinite(n) && n >= 0 ? Math.floor(n) : -1;
    if (v === decisionsWaiting)
        return;
    decisionsWaiting = v;
    writing = writing.then(() => writeStatus($, false)).catch(() => undefined);
}
export function setOwnStatus($: Engine, v: OwnStatus | null) {
    const next = v && (v.model || v.effort) ? v : null;
    if (JSON.stringify(next) === JSON.stringify(ownStatus))
        return;
    ownStatus = next;
    writing = writing.then(() => writeStatus($, false)).catch(() => undefined);
}
export type HiddenRow = {
    kind: 'keepwarm' | 'cleanup' | 'mailnote';
    ok: boolean;
    why?: string;
    try?: number;
    read?: number;
    write?: number;
    out?: number;
    reason?: string;
    archives?: number;
};
const HIDDEN_APPEND_JS = "require('fs').appendFileSync(process.argv[1], require('fs').readFileSync(0))";
export async function recordHidden($: Engine, row: HiddenRow) {
    try {
        const home = slash((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '');
        if (!home)
            return;
        const agent = String((await $.env.get('HAVOK_MOD_AGENT')) ?? '');
        const session = String((await $.session.id().catch(() => '')) ?? '');
        const line = JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), agent, session, ...row }) + '\n';
        const path = `${home}/.claude/havok-mod/hidden-turns.jsonl`;
        await $.process.run(['node', '-e', HIDDEN_APPEND_JS, path], { stdin: line, timeoutMs: 10000 }).catch(() => undefined);
    }
    catch { }
}
export function setWarm($: Engine, v: WarmStatus) {
    warm = v;
    writing = writing.then(() => writeStatus($, false)).catch(() => undefined);
}
export function dropCleanedContext(): boolean {
    if (!cleaned)
        return false;
    cleaned = null;
    return true;
}
export async function statusBeat($: Engine) {
    writing = writing.then(() => writeStatus($, true)).catch(() => undefined);
    await writing;
}
export function statusStep($: Engine): Promise<void> {
    const run = writing.then(() => writeStatus($, false, STEP_REFRESH_MS)).catch(() => undefined);
    writing = run;
    return run;
}
const PRUNE_DAYS = 7;
const PRUNE_JS = "for(const p of process.argv.slice(1))require('fs').rmSync(p,{force:true})";
export async function statusStart($: Engine) {
    parts.clear();
    cleaned = null;
    cleanedAt = '';
    warm = null;
    waitingUpdate = null;
    rc = null;
    shownAttention = '';
    lastWrite = '';
    lastWriteAt = 0;
    const c = S.cfg;
    if (!c)
        return;
    const cutoff = (await $.clock.now()) - PRUNE_DAYS * 86400000;
    const old: string[] = [];
    for (const dir of [`${c.home}/.claude/${STATUS_DIR}`, `${c.home}/.claude/havok-mod/layers-live`]) {
        const list = await $.fs.list(dir).catch(() => []);
        for (const f of list)
            if (f.kind === 'file' && f.mtimeMs > 0 && f.mtimeMs < cutoff)
                old.push(`${dir}/${f.name}`);
    }
    if (old.length)
        void $.process.run(['node', '-e', PRUNE_JS, ...old.slice(0, 500)], { timeoutMs: 30000 }).catch(() => undefined);
    await statusBeat($);
}
export const HOOK_MS = 10000;
export const HOOK_MARGIN_MS = 2500;
export type HookLink = {
    readonly signal?: AbortSignal;
    readonly budget?: {
        readonly remainingMs: number;
    };
};
export async function waitCapped($: Engine, work: Promise<unknown>, capMs: number, hook?: HookLink): Promise<boolean> {
    const left = Math.min(capMs, (hook?.budget?.remainingMs ?? HOOK_MS) - HOOK_MARGIN_MS);
    if (!(left > 0) || hook?.signal?.aborted)
        return false;
    const timer = new AbortController();
    const stop = () => timer.abort();
    hook?.signal?.addEventListener('abort', stop, { once: true });
    try {
        return await Promise.race([
            work.then(() => true, () => true),
            $.clock.sleep(left, { signal: timer.signal }).then(() => false, () => false),
        ]);
    }
    finally {
        timer.abort();
        hook?.signal?.removeEventListener('abort', stop);
    }
}
export async function appendText($: Engine, path: string, text: string) {
    const cur = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
    await $.fs.write(path, cur + text);
}
const APPEND_LINE_JS = "require('fs').appendFileSync(process.argv[1], require('fs').readFileSync(0))";
export async function appendShared($: Engine, path: string, text: string) {
    try {
        const r = await $.process.run(['node', '-e', APPEND_LINE_JS, path], { stdin: text, timeoutMs: 10000 });
        if (r.exitCode === 0)
            return;
    }
    catch { }
    await appendText($, path, text);
}
