import type { Engine } from './shared';
import { VERSION, S, HOOK_MS, HOOK_MARGIN_MS, subscriptionReserve, owner, homeName, org } from './shared';
import { markerKey, marked, safeSession, ALIVE_DIR } from './brain/alive-rules.mjs';
import { contentProblems, contentDenyReason, styleProblems, slipNote, writingRulesOn } from './brain/content-rules.mjs';
import { commandProblems, HOW_TO_WRITE } from './brain/commit-message-rules.mjs';
import { isShell, isCommitAttempt, commitDir, secretsIn, secretDenyReason, SCAN_UNFINISHED, skipsVerify, NO_VERIFY_REASON, tokenFiles, tokensFrom } from './brain/secret-rules.mjs';
import { COMMIT_CMD, VERIFY_MS, needsVerify, failedReason, HUNG_REASON } from './brain/commitgate-rules.mjs';
import { BYPASS_MS, type reserveOf, agentExempt, claudeFiles, hitsOf, isTyped, typedUrgent, relayedUrgent, isPing, urgentStillOpen, blockMessage, TOOL_STOP, PING_BLOCKED, blockKind, blockRow, bypassName, BYPASS_OUTBOX, BYPASS_REASON, bypassUseRow, BYPASS_MARKER, bypassMarkerAfter } from './brain/limit-rules.mjs';
import { windowProblems, windowDenyReason } from './brain/window-rules.mjs';
import { withHelperBlock, recallQuery, withRecall } from './brain/helper-rules.mjs';
import { HOW, toolExempt, fresh, toolDenyReason, stopBlockReason } from './brain/gate-rules.mjs';
import { type Host, hostRequest, resolveHost } from './brainhost';
import { freshState, onPrompt, onTool, onStop } from './brain/recall-rules.mjs';
import { snapshotOf, afterStop } from './brain/memory-rules.mjs';
import { isPingText, fromTimer, pingContext } from './brain/keepwarm-rules.mjs';
import { compactRow, watchState, contextOf } from './brain/compact-rules.mjs';
type Data = Record<string, unknown>;
type GateState = {
    down?: boolean;
    since?: number;
    checkedAt?: number;
    upAt?: number;
    serverOff?: number;
    detail?: string;
    reason?: string;
    kind?: string;
    stopBlocks?: number;
    slowMs?: number;
};
export type ToolVerdict = {
    deny: string;
} | {
    input: Data;
} | null;
const GIT_MS = 10000;
const SCRIPT_MS = 30000;
const SEARCH_MS = 8000;
const SESSION_START_MS = 120000;
export const TOOL_TIMED_OUT = 'brain check timed out, run it again';
const MARGIN_MS = HOOK_MARGIN_MS;
const JOB_MS = { tool: 6000, prompt: 5000, stop: 5000, start: 5000, compact: 5000 } as const;
type JobName = keyof typeof JOB_MS;
const JOB_WORDS: Record<JobName, string> = { tool: 'tool call', prompt: 'prompt', stop: 'end of the reply', start: 'session start', compact: 'compaction' };
export type HookLink = {
    readonly signal?: AbortSignal;
    readonly budget?: {
        readonly remainingMs: number;
    };
};
type Ending = 'budget' | 'signal';
type Job = {
    hook?: HookLink;
    name: JobName;
    waited: number;
    live: AbortController;
    ending: Ending;
};
export class BrainTimeout extends Error {
    constructor(name: JobName, ending: Ending) {
        super(ending === 'signal'
            ? `brain ${JOB_WORDS[name]} check stopped when its hook was ended, and was let through`
            : `brain ${JOB_WORDS[name]} check timed out within its ${JOB_MS[name] / 1000} s budget, and was let through`);
        this.name = 'BrainTimeout';
    }
}
const META = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta']);
const APPEND_JS = "require('fs').appendFileSync(process.argv[1], require('fs').readFileSync(0))";
const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
const parse = (s: string): unknown => {
    try {
        return JSON.parse(s);
    }
    catch {
        return null;
    }
};
export const B = {
    ready: null as Promise<void> | null,
    readyDone: false,
    home: '',
    claude: '',
    root: '',
    brainDir: '',
    machine: '',
    sid: '',
    marker: null as unknown,
    notes: [] as string[],
    lastTyped: null as {
        text: string;
        at: number;
    } | null,
    answerWith: '',
    recallOn: false,
    recallState: freshState() as Record<string, unknown>,
    memState: undefined as unknown,
    gateProbe: null as Promise<void> | null,
    probeDone: true,
    probeAt: 0,
    gateHost: null as Promise<GateHost | null> | null,
    ctxTokens: 0,
    oldHooks: false,
    startNote: '',
    aliveAt: 0,
};
export function brainReset() {
    writingCache = null;
    Object.assign(B, { ready: null, readyDone: false, home: '', claude: '', root: '', brainDir: '', machine: '', sid: '', marker: null, notes: [], startNote: '', aliveAt: 0, lastTyped: null, answerWith: '', recallOn: false, recallState: freshState(), memState: undefined, gateProbe: null, probeDone: true, probeAt: 0, gateHost: null, ctxTokens: 0, oldHooks: false });
}
async function readText($: Engine, path: string): Promise<string> {
    try {
        return String(await $.fs.read(path));
    }
    catch {
        return '';
    }
}
export function brainInit($: Engine, brainDirFromConfig = S.cfg?.checks.brainDir ?? ''): Promise<void> {
    if (B.ready)
        return B.ready;
    B.ready = (async () => {
        B.home = slash(String((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''));
        B.claude = `${B.home}/.claude`;
        B.machine = String((await $.env.get('COMPUTERNAME')) || (await $.env.get('HOSTNAME')) || '');
        B.sid = safeSession(await $.session.id().catch(() => ''));
        const marked = (await readText($, `${B.claude}/havok-brain-path`)).split(/\r?\n/)[0]!.trim();
        B.brainDir = slash(brainDirFromConfig) || (/^([a-zA-Z]:)?[\\/]/.test(marked) ? slash(marked) : '');
        const installed = parse(await readText($, `${B.claude}/plugins/installed_plugins.json`)) as {
            plugins?: Record<string, {
                installPath?: string;
            }[]>;
        } | null;
        const entry = (installed?.plugins?.['havok-brain@havok-brain'] ?? []).find((x) => x && x.installPath);
        B.root = entry?.installPath ? slash(entry.installPath) : B.brainDir;
        if (entry?.installPath) {
            const hooks = await readText($, `${B.root}/hooks/hooks.json`);
            B.oldHooks = !!hooks && !hooks.includes('dispatch.mjs');
        }
        try {
            B.marker = parse(await $.fs.read(markerFile()));
        }
        catch {
            B.marker = null;
        }
    })().finally(() => { B.readyDone = true; });
    return B.ready;
}
const markerFile = () => `${B.home}/${ALIVE_DIR}/${B.sid || 'none'}.json`;
const client = () => `${B.root}/tools/brain-client.mjs`;
export async function markHandled($: Engine, event: string, data: Data) {
    if (!B.home || !B.sid || B.oldHooks)
        return;
    B.marker = marked(B.marker, VERSION, event, markerKey(event, data), await $.clock.now());
    B.aliveAt = await $.clock.now();
    await $.fs.write(markerFile(), JSON.stringify(B.marker));
}
const ALIVE_REFRESH_MS = 30000;
export async function touchAlive($: Engine) {
    if (!B.home || !B.sid || B.oldHooks || !B.marker)
        return;
    const now = await $.clock.now();
    if (now - B.aliveAt < ALIVE_REFRESH_MS)
        return;
    B.aliveAt = now;
    await $.fs.write(markerFile(), JSON.stringify(B.marker));
}
async function appendLine($: Engine, path: string, line: string) {
    try {
        const cur = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
        await $.fs.write(path, cur + line);
    }
    catch {
        await $.process.run(['node', '-e', APPEND_JS, path], { stdin: line, timeoutMs: 10000 }).catch(() => undefined);
    }
}
function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
    if (!signal)
        return () => undefined;
    if (signal.aborted) {
        fn();
        return () => undefined;
    }
    signal.addEventListener('abort', fn, { once: true });
    return () => signal.removeEventListener('abort', fn);
}
const newJob = (name: JobName, hook?: HookLink): Job => ({ hook, name, waited: 0, live: new AbortController(), ending: 'budget' });
function endJob(job: Job, ending: Ending): never {
    if (!job.live.signal.aborted) {
        job.ending = ending;
        job.live.abort();
    }
    throw new BrainTimeout(job.name, job.ending);
}
async function within<T>(job: Job, work: Promise<T>): Promise<T> {
    const off = onAbort(job.hook?.signal, () => {
        if (!job.live.signal.aborted) {
            job.ending = 'signal';
            job.live.abort();
        }
    });
    const ended = new Promise<never>((_, reject) => { onAbort(job.live.signal, () => reject(new BrainTimeout(job.name, job.ending))); });
    ended.catch(() => undefined);
    work.catch(() => undefined);
    try {
        return await Promise.race([work, ended]);
    }
    finally {
        off();
        job.live.abort();
    }
}
function stillLive(job?: Job) {
    if (job?.live.signal.aborted)
        throw new BrainTimeout(job.name, job.ending);
}
async function waitFor($: Engine, job: Job, work: Promise<unknown>, done: () => boolean, soft = false): Promise<boolean> {
    if (done()) {
        await work;
        return true;
    }
    stillLive(job);
    const left = Math.min(JOB_MS[job.name] - job.waited, (job.hook?.budget?.remainingMs ?? HOOK_MS) - MARGIN_MS);
    if (!(left > 0)) {
        if (soft)
            return false;
        endJob(job, 'budget');
    }
    const timer = new AbortController();
    const off = onAbort(job.live.signal, () => timer.abort());
    const from = await $.clock.now();
    let finished = false;
    try {
        finished = await Promise.race([
            work.then(() => true, () => true),
            $.clock.sleep(left, { signal: timer.signal }).then(() => false, () => false),
        ]);
    }
    finally {
        timer.abort();
        off();
    }
    job.waited += Math.max(0, (await $.clock.now()) - from);
    if (!finished) {
        stillLive(job);
        if (soft)
            return false;
        endJob(job, 'budget');
    }
    await work;
    return true;
}
async function ready($: Engine, job: Job) {
    await waitFor($, job, brainInit($), () => B.readyDone);
}
async function run($: Engine, job: Job, argv: string[], init: {
    cwd?: string;
    timeoutMs?: number;
    stdin?: string;
}) {
    stillLive(job);
    return $.process.run(argv, init);
}
async function runScript($: Engine, file: string, args: string[], data: Data, timeoutMs = SCRIPT_MS, job?: Job) {
    stillLive(job);
    return $.process.run(['node', `${B.root}/hooks/${file}`, ...args], { stdin: JSON.stringify(data), timeoutMs, env: { CLAUDE_PLUGIN_ROOT: B.root } });
}
let writingCache: boolean | null = null;
async function writingOn($: Engine): Promise<boolean> {
    if (writingCache !== null)
        return writingCache;
    const dir = B.brainDir || B.root;
    writingCache = org().writingStyle === 'plain' || (dir ? writingRulesOn(parse(await readText($, `${dir}/brain.json`))) : false);
    return writingCache;
}
async function mainSession($: Engine) { return !!B.sid && (await readText($, `${B.claude}/havok-main-session.txt`)).trim() === B.sid; }
async function gateFile($: Engine) { return slash(String((await $.env.get('HAVOK_GATE_STATE')) || `${B.claude}/havok-brain-gate.json`)); }
async function gateState($: Engine): Promise<GateState> { return (parse(await readText($, await gateFile($))) as GateState | null) ?? { down: false }; }
async function reserve($: Engine) { return subscriptionReserve($, B.home, B.brainDir || B.root); }
async function limitHits($: Engine, now: number, r: ReturnType<typeof reserveOf>) {
    if (!r.enabled)
        return { five: null, week: null, hits: [] as ReturnType<typeof hitsOf>['hits'] };
    return hitsOf(parse(await readText($, claudeFiles(B.home, String((await $.env.get('CLAUDE_CONFIG_DIR')) ?? '')).limits)), now);
}
async function exempt($: Engine, r: ReturnType<typeof reserveOf>, now: number) {
    if (await mainSession($))
        return through($, 'havok-main-session.txt', BYPASS_REASON.main, now);
    const env = { HAVOK_MOD_AGENT: (await $.env.get('HAVOK_MOD_AGENT')) ?? '', CLAUDE_CODE_EXECPATH: (await $.env.get('CLAUDE_CODE_EXECPATH')) ?? '' };
    return agentExempt(env, r);
}
const bypassFile = () => `${B.claude}/havok-limit-bypass/${bypassName(B.sid)}`;
async function through($: Engine, file: string, reason: string, now: number): Promise<true> {
    const outbox = `${B.claude}/havok-mod/${BYPASS_OUTBOX}`;
    const markerFile = `${B.claude}/havok-mod/${BYPASS_MARKER}`;
    const marker = bypassMarkerAfter(parse(await readText($, markerFile)), B.sid, file, now);
    if (!marker)
        return true;
    await $.fs.write(markerFile, JSON.stringify(marker)).catch(() => undefined);
    await appendLine($, outbox, JSON.stringify(bypassUseRow(now, String((await $.env.get('HAVOK_MOD_AGENT')) ?? ''), B.sid, file, reason)) + '\n').catch(() => undefined);
    if (B.root)
        void $.process.run(['node', `${B.root}/hooks/send-analytics.mjs`, 'reserve-bypass', outbox], { timeoutMs: 30000 }).catch(() => undefined);
    return true;
}
const bypassUse = () => `havok-limit-bypass/${bypassName(B.sid)}`;
async function logLimit($: Engine, kind: string, event: string, five: unknown, week: unknown, now: number) {
    await appendLine($, `${B.claude}/havok-limit-blocks.jsonl`, blockRow(now, B.sid, kind, event, five, week) + '\n');
}
export function blockedNotice(hits: ReturnType<typeof hitsOf>['hits'], mainName = ''): string {
    const what = hits.map(([name, w]) => `${name} limit at ${Math.round(Number((w as {
        used_percentage?: number;
    }).used_percentage ?? 0))} percent`).join(' and ');
    return `Blocked: ${what}; the rest is reserved for ${mainName || 'the main agent'}. Start your message with urgent to go ahead.`;
}
export const HELD_TEXT_MAX = 4000;
export function heldSince(rows: string, session: string): {
    at: number;
    text: string;
}[] {
    const mine = rows.split('\n').map((l) => parse(l) as {
        at?: number;
        session?: string;
        kind?: string;
        text?: string;
    } | null)
        .filter((r): r is {
        at: number;
        session: string;
        kind: string;
        text?: string;
    } => !!r && r.session === session && typeof r.at === 'number');
    let from = 0;
    mine.forEach((r, i) => {
        if (r.kind === 'handled')
            from = i + 1;
    });
    return mine.slice(from).filter((r) => r.kind === 'prompt' && typeof r.text === 'string' && r.text.trim()).map((r) => ({ at: r.at, text: r.text! }));
}
export function heldNote(held: {
    at: number;
    text: string;
}[]): string {
    if (!held.length)
        return '';
    const lines = held.map((h) => `- ${new Date(h.at).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${h.text.length > HELD_TEXT_MAX ? h.text.slice(0, HELD_TEXT_MAX) + ' [cut]' : h.text}`);
    return `HELD MESSAGES: ${owner()}'s earlier ${held.length === 1 ? 'message was' : 'messages were'} held by the limit reserve and answered only with the Blocked notice, so you have not answered ${held.length === 1 ? 'it' : 'them'}. Answer ${held.length === 1 ? 'it' : 'them'} together with this message:\n${lines.join('\n')}`;
}
async function limitHeld($: Engine, now: number): Promise<string> {
    const file = `${B.claude}/havok-limit-blocks.jsonl`;
    const held = heldSince(await readText($, file), B.sid);
    if (!held.length)
        return '';
    await appendLine($, file, JSON.stringify({ at: now, session: B.sid, kind: 'handled', count: held.length }) + '\n').catch(() => undefined);
    return heldNote(held);
}
async function limitPrompt($: Engine, data: Data, now: number): Promise<{
    block: string;
} | {
    answer: string;
} | {
    pass: string;
}> {
    if (isTyped(data))
        B.lastTyped = { text: String(data.prompt ?? ''), at: now };
    const r = await reserve($);
    const typed = typedUrgent(data) || relayedUrgent(data, r.mainAgent, r.relays);
    if (typed)
        await $.fs.write(bypassFile(), String(now + BYPASS_MS)).catch(() => undefined);
    const { five, week, hits } = await limitHits($, now, r);
    const pass = async () => ({ pass: isTyped(data) && !isPing(data) ? await limitHeld($, now) : '' });
    if (!hits.length)
        return pass();
    if (isPing(data)) {
        await logLimit($, 'keep-warm', 'UserPromptSubmit', five, week, now);
        return { block: PING_BLOCKED };
    }
    if (await exempt($, r, now))
        return pass();
    if (typed || Number(await readText($, bypassFile())) > now) {
        await through($, bypassUse(), BYPASS_REASON.urgent, now);
        return pass();
    }
    if (isTyped(data)) {
        const row = { ...(parse(blockRow(now, B.sid, 'prompt', 'UserPromptSubmit', five, week)) as object), text: String(data.prompt ?? '') };
        await appendLine($, `${B.claude}/havok-limit-blocks.jsonl`, JSON.stringify(row) + '\n');
        return { answer: blockedNotice(hits, r.mainName || r.mainAgent) };
    }
    await logLimit($, 'prompt', 'UserPromptSubmit', five, week, now);
    return { block: blockMessage(hits, r.mainName || r.mainAgent) };
}
export function takeBlockedAnswer(): string {
    const t = B.answerWith;
    B.answerWith = '';
    return t;
}
async function limitTool($: Engine, tool: string, now: number): Promise<string | null> {
    const r = await reserve($);
    const { five, week, hits } = await limitHits($, now, r);
    if (!hits.length)
        return null;
    if (await exempt($, r, now))
        return null;
    if (Number(await readText($, bypassFile())) > now) {
        await through($, bypassUse(), BYPASS_REASON.urgent, now);
        return null;
    }
    if (urgentStillOpen(B.lastTyped, now)) {
        await $.fs.write(bypassFile(), String(B.lastTyped!.at + BYPASS_MS)).catch(() => undefined);
        await through($, bypassUse(), BYPASS_REASON.urgent, now);
        return null;
    }
    await logLimit($, blockKind('PreToolUse', tool), 'PreToolUse', five, week, now);
    return blockMessage(hits, r.mainName || r.mainAgent) + TOOL_STOP;
}
const HEALTH_MS = 6000;
const DOWN_AFTER_MS = 30000;
const SLOW_MS = 2000;
const HEALTH_SPAWN_MS = 1500;
const PROBE_EVERY_MS = 60000;
const KNOWN_MS = 10 * 60000;
const TAILSCALE_MS = 5000;
type GateHost = {
    host: Host;
    ip: string;
    local: boolean;
};
type Diagnosis = {
    kind: string;
    detail: string;
};
async function gateHost($: Engine): Promise<GateHost | null> {
    if (!B.gateHost) {
        B.gateHost = (async () => {
            const url = String((await $.env.get('HAVOK_GATE_URL')) ?? '') || S.cfg?.context.layerHost || undefined;
            const host = await resolveHost($, { home: B.home, machine: (S.cfg?.machine || B.machine).toUpperCase(), brainDir: B.brainDir, url });
            if (!host)
                return null;
            const ep = B.brainDir ? (parse(await readText($, `${B.brainDir}/server-endpoint.json`)) as {
                tailnet?: {
                    ipv4?: string;
                };
            } | null) : null;
            const ip = String((await $.env.get('HAVOK_GATE_IP')) ?? '') || String(ep?.tailnet?.ipv4 ?? '');
            return { host, ip, local: /\/\/127\.0\.0\.1[:/]/.test(host.url + '/') };
        })().catch(() => null);
    }
    return B.gateHost;
}
async function putGate($: Engine, s: GateState) {
    await $.fs.write(await gateFile($), JSON.stringify(s)).catch(() => undefined);
}
const healthMs = () => Math.min(Math.max(Number(S.cfg?.checks.healthTimeoutMs) || HEALTH_MS, 1000), 8000);
const downAfterMs = () => Math.min(Math.max(Number(S.cfg?.checks.downAfterMs) || DOWN_AFTER_MS, 4000), 120000);
export const retryWaits = (after: number) => [0, Math.round(after / 2), after - Math.round(after / 2)];
let lastHealthMs = 0;
async function healthOnce($: Engine, g: GateHost): Promise<string> {
    const budget = healthMs();
    const t0 = await $.clock.now();
    const r = await hostRequest($, g.host, 'GET', '/health', { budgetMs: budget, spawnMs: HEALTH_SPAWN_MS, open: true });
    lastHealthMs = (await $.clock.now()) - t0;
    if (!r.ok)
        return r.timedOut ? `no answer within ${budget / 1000} s` : r.why;
    if (r.status !== 200)
        $.ui.log(`brain /health answered ${r.status}: counted as up (an answer)`, { to: 'debug' });
    return '';
}
async function diagnose($: Engine, g: GateHost): Promise<Diagnosis> {
    if (g.local)
        return { kind: 'server', detail: `this is ${homeName()} and its own brain service does not answer` };
    try {
        const r = await $.process.run(['tailscale', 'status', '--json'], { timeoutMs: TAILSCALE_MS });
        const j = JSON.parse(r.stdout) as {
            BackendState?: string;
            Self?: {
                Online?: boolean;
            };
            Peer?: Record<string, {
                TailscaleIPs?: string[];
                Online?: boolean;
                LastSeen?: string;
            }>;
        };
        if (j.BackendState !== 'Running' || !(j.Self || {}).Online)
            return { kind: 'local', detail: 'Tailscale on this machine is ' + (j.BackendState || 'not running') };
        const peer = Object.values(j.Peer || {}).find((p) => (p.TailscaleIPs || []).includes(g.ip));
        if (peer && peer.Online === false)
            return { kind: 'server-off', detail: `Tailscale shows ${homeName()} offline (last seen ` + (peer.LastSeen || 'unknown') + ')' };
        return { kind: 'server', detail: `${homeName()} is online in Tailscale but the brain service does not answer` };
    }
    catch {
        return { kind: 'local', detail: 'the tailscale command does not answer on this machine' };
    }
}
async function proxyNote($: Engine) {
    const file = String(S.cfg?.checks.proxyStateFile ?? '').trim();
    const s = file ? (await readText($, file)).trim() : '';
    return s ? ' The VPN proxy state file says: ' + s.slice(0, 200) + '.' : '';
}
async function probeBrain($: Engine, g: GateHost, full: boolean) {
    let why = '';
    for (const wait of full ? retryWaits(downAfterMs()) : [0]) {
        if (wait)
            await $.clock.sleep(wait);
        why = await healthOnce($, g);
        if (!why)
            break;
    }
    const now = await $.clock.now();
    if (!why) {
        await putGate($, { down: false, upAt: now, checkedAt: now, ...(lastHealthMs > SLOW_MS ? { slowMs: lastHealthMs } : {}) });
        return;
    }
    const prev = await gateState($);
    if (!full) {
        await putGate($, { ...prev, checkedAt: now, reason: why });
        return;
    }
    const d = await diagnose($, g);
    if (d.kind === 'server-off') {
        await putGate($, { down: false, serverOff: now, checkedAt: now });
        B.notes.push('BRAIN OFFLINE: ' + d.detail + `. ${homeName().replace(/^./, (c) => c.toUpperCase())} is switched off, so work normally without the brain this turn and say so in one line.`);
        return;
    }
    await putGate($, { down: true, since: prev.down ? prev.since : now, checkedAt: now, reason: why, kind: d.kind, detail: d.detail, stopBlocks: 0 });
    B.notes.push('BRAIN DOWN, REPAIR FIRST. The brain server gave no answer at all three times over ' + Math.round(downAfterMs() / 1000) + ' s (' + why + '; ' + d.detail + ').' + (await proxyNote($)) +
        " The user's rule (memory feedback_brain_or_vpn_down_agent_fixes_first): repair it before doing anything else in their message. Until the brain answers, every tool except reading and network repair commands is refused. " + (HOW[d.kind as keyof typeof HOW] ?? HOW.local) +
        ' When it answers again, carry on with his message.');
}
export async function brainUpAt($: Engine): Promise<number> {
    try {
        return Number((await gateState($)).upAt) || 0;
    }
    catch {
        return 0;
    }
}
function startProbe($: Engine, g: GateHost, full: boolean, now: number) {
    if (!B.probeDone)
        return;
    B.probeDone = false;
    B.probeAt = now;
    B.gateProbe = probeBrain($, g, full).catch(() => undefined).finally(() => { B.probeDone = true; });
}
const known = (s: GateState, now: number) => !!s.checkedAt && now - s.checkedAt < KNOWN_MS;
const due = (s: GateState, now: number) => now - Math.max(s.checkedAt ?? 0, B.probeAt) >= PROBE_EVERY_MS;
async function gatePrompt($: Engine) {
    const g = await gateHost($);
    if (!g)
        return;
    const s = await gateState($);
    const now = await $.clock.now();
    if (s.down || !known(s, now) || due(s, now))
        startProbe($, g, true, now);
}
async function stillDown($: Engine, job: Job, s: GateState, g: GateHost): Promise<boolean> {
    const now = await $.clock.now();
    if (fresh(s, now) || !B.probeDone)
        return true;
    startProbe($, g, false, now);
    if (B.gateProbe && !(await waitFor($, job, B.gateProbe, () => B.probeDone, true)))
        return true;
    return !!(await gateState($)).down;
}
async function gateTool($: Engine, job: Job, tool: string, input: Data): Promise<string | null> {
    if (await mainSession($))
        return null;
    if (toolExempt(tool, input))
        return null;
    let s = await gateState($);
    const now = await $.clock.now();
    const g = await gateHost($);
    if (!g)
        return s.down && fresh(s, now) ? toolDenyReason(s) : null;
    if (s.down)
        return (await stillDown($, job, s, g)) ? toolDenyReason(s) : null;
    if (known(s, now)) {
        if (due(s, now))
            startProbe($, g, true, now);
        return null;
    }
    startProbe($, g, true, now);
    if (B.gateProbe)
        await waitFor($, job, B.gateProbe, () => B.probeDone);
    s = await gateState($);
    return s.down ? toolDenyReason(s) : null;
}
async function gateStop($: Engine, job: Job): Promise<string | null> {
    if (await mainSession($))
        return null;
    const g = await gateHost($);
    if (!g)
        return null;
    let s = await gateState($);
    if (!s.down && !known(s, await $.clock.now()) && B.gateProbe) {
        await waitFor($, job, B.gateProbe, () => B.probeDone);
        s = await gateState($);
    }
    if (!s.down || (s.stopBlocks || 0) >= 1)
        return null;
    if (!(await stillDown($, job, s, g)))
        return null;
    await putGate($, { ...(await gateState($)), stopBlocks: (s.stopBlocks || 0) + 1 });
    return stopBlockReason(s);
}
async function recallSwitch($: Engine) {
    const on = !!(parse(await readText($, `${B.root}/hooks/agent-search.json`)) as {
        on?: boolean;
    } | null)?.on;
    B.recallOn = on && String((await $.env.get('HAVOK_RELAY')) ?? '') !== '1';
}
async function recallLog($: Engine, log: unknown) {
    if (!log)
        return;
    const dir = slash(String((await $.env.get('HAVOK_RECALL_GATE_DIR')) || `${B.claude}/havok-recall-gate`));
    await appendLine($, `${dir}/gate-log.jsonl`, JSON.stringify({ at: new Date(await $.clock.now()).toISOString(), sid: B.sid || 'none', ...(log as object) }) + '\n');
}
const cliPath = () => client().replace(/\\/g, '/');
async function secretScan($: Engine, job: Job, cwd?: string): Promise<string | null> {
    let r;
    try {
        r = await run($, job, ['git', 'diff', '--cached', '--no-color', '--', '.', ':(exclude)index/'], { cwd, timeoutMs: GIT_MS });
    }
    catch {
        return SCAN_UNFINISHED;
    }
    if (r.exitCode !== 0)
        return null;
    if (r.isStdoutTruncated)
        return SCAN_UNFINISHED + ' (The staged diff is over 4 MiB; commit it in smaller parts.)';
    const known: string[] = [];
    for (const p of tokenFiles(B.home) as string[]) {
        try {
            known.push(...(tokensFrom(p, await $.fs.read(p)) as string[]));
        }
        catch { }
    }
    const hits = secretsIn(r.stdout, known);
    return hits.length ? secretDenyReason(hits) : null;
}
async function brainCommitGate($: Engine, job: Job, cwd?: string): Promise<string | null> {
    let top: string;
    try {
        const r = await run($, job, ['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: GIT_MS });
        if (r.exitCode !== 0)
            return null;
        top = slash(r.stdout.trim());
    }
    catch {
        return null;
    }
    if (!top || !(await $.fs.exists(`${top}/REFLEX.md`)) || !(await $.fs.exists(`${top}/memory`)))
        return null;
    try {
        const files = await $.fs.list(`${top}/memory`);
        if (!files.some((f) => f.kind === 'file' && f.name.endsWith('.md') && f.name !== 'MEMORY.md'))
            return null;
    }
    catch { }
    let staged: string;
    try {
        const r = await run($, job, ['git', 'diff', '--cached', '--name-only'], { cwd: top, timeoutMs: GIT_MS });
        if (r.exitCode !== 0)
            return null;
        staged = r.stdout;
    }
    catch {
        return null;
    }
    const { risky, verify } = needsVerify(staged);
    if (!verify || !(await $.fs.exists(`${top}/tools/verify.mjs`)))
        return null;
    const verifier = (await $.fs.exists(`${top}/tools/verify-staged.mjs`)) ? `${top}/tools/verify-staged.mjs` : `${top}/tools/verify.mjs`;
    try {
        const r = await run($, job, ['node', verifier, '--quiet'], { cwd: top, timeoutMs: VERIFY_MS });
        return r.exitCode === 0 ? null : failedReason(risky.length, (r.stdout + r.stderr).trim());
    }
    catch {
        return HUNG_REASON;
    }
}
export const inputOf = (e: Data): Data => Object.fromEntries(Object.entries(e).filter(([k]) => !META.has(k)));
export async function brainToolCall($: Engine, e: Data, hook?: HookLink): Promise<ToolVerdict> {
    try {
        const job = newJob('tool', hook);
        return await within(job, toolJobs($, job, e));
    }
    catch (err) {
        if (err instanceof BrainTimeout)
            return { deny: TOOL_TIMED_OUT };
        throw err;
    }
}
export const MEMORY_THROUGH_SERVER = (brain: string) => `On this brain host a memory is saved through the brain server, never by writing into ${brain}/memory/: write the whole ` +
    `file somewhere else (your scratchpad), then node "${brain}/tools/brain-client.mjs" write <slug> --file <path>. ` +
    `To delete: brain-client.mjs delete <slug> --why "<reason>"; to replace: tools/replace-memory.mjs. Brain server down: ` +
    `node "${brain}/tools/save-brain.mjs" --fallback "<message>" <slug>.`;
export function memoryFileOf(input: Data, brain: string): string {
    const raw = String(input.file_path ?? input.notebook_path ?? input.path ?? '');
    if (!raw || !brain)
        return '';
    const p = slash(raw).toLowerCase();
    const dir = slash(brain).toLowerCase().replace(/\/+$/, '') + '/memory/';
    if (!p.startsWith(dir))
        return '';
    const name = p.slice(dir.length);
    return name.endsWith('.md') && !name.includes('/') && name !== 'memory.md' ? name : '';
}
async function memoryGuard($: Engine, tool: string, input: Data): Promise<string | null> {
    if (!/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) || !B.brainDir)
        return null;
    if (!memoryFileOf(input, B.brainDir))
        return null;
    try {
        const cfg = JSON.parse(String(await $.fs.read(`${B.brainDir}/brain.json`))) as {
            memoryWritesThroughServer?: unknown;
        };
        return cfg.memoryWritesThroughServer === true ? MEMORY_THROUGH_SERVER(B.brainDir) : null;
    }
    catch {
        return null;
    }
}
async function toolJobs($: Engine, job: Job, e: Data): Promise<ToolVerdict> {
    await ready($, job);
    if (B.oldHooks)
        return null;
    const tool = String(e.tool ?? '');
    const input = inputOf(e);
    const data: Data = { session_id: B.sid, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: e.tool_use_id };
    if (e.agentId)
        data.agent_id = e.agentId;
    const now = await $.clock.now();
    const cmd = isShell(tool) ? String(input.command ?? '') : '';
    const limit = await limitTool($, tool, now);
    if (limit)
        return { deny: limit };
    const memory = await memoryGuard($, tool, input);
    if (memory)
        return { deny: memory };
    const gate = await gateTool($, job, tool, input);
    if (gate)
        return { deny: gate };
    if (B.recallOn && !(await gateState($)).down) {
        const r = onTool(B.recallState, tool, input, cliPath()) as {
            state: Record<string, unknown>;
            deny?: string;
            log?: unknown;
        };
        B.recallState = r.state;
        await recallLog($, r.log);
        if (r.deny)
            return { deny: r.deny };
    }
    const content = (await writingOn($)) ? contentProblems(tool, input) : null;
    if (content)
        return { deny: contentDenyReason(content) };
    const repo = cmd && isCommitAttempt(cmd) ? commitDir(cmd, await $.session.cwd().catch(() => '')) || undefined : undefined;
    if (cmd && isCommitAttempt(cmd)) {
        if (skipsVerify(cmd))
            return { deny: NO_VERIFY_REASON };
        const secret = await secretScan($, job, repo);
        if (secret)
            return { deny: secret };
    }
    if (cmd && COMMIT_CMD.test(cmd)) {
        const gateWord = await brainCommitGate($, job, repo);
        if (gateWord)
            return { deny: gateWord };
    }
    if (cmd) {
        const problems = commandProblems(cmd);
        if (problems.length)
            return { deny: 'Commit blocked: ' + problems.join(', ') + '. ' + HOW_TO_WRITE };
        const windows = windowProblems(tool, input);
        if (windows.length)
            return { deny: windowDenyReason(windows) };
    }
    if ((tool === 'Agent' || tool === 'Task') && B.root) {
        const withBlock = withHelperBlock(input, cliPath());
        if (withBlock)
            return { input: withBlock };
    }
    if (tool === 'SendMessage' && B.root) {
        const q = recallQuery(input);
        if (q) {
            try {
                const r = await run($, job, ['node', client(), 'search', q], { timeoutMs: SEARCH_MS });
                const withMsg = r.exitCode === 0 ? withRecall(input, r.stdout, cliPath()) : null;
                if (withMsg)
                    return { input: withMsg };
            }
            catch { }
        }
    }
    return null;
}
export async function brainPrompt($: Engine, data: Data, hook?: HookLink): Promise<{
    block: string;
} | {
    answer: string;
} | {
    context: string[];
}> {
    const job = newJob('prompt', hook);
    return within(job, promptJobs($, job, data));
}
async function promptJobs($: Engine, job: Job, data: Data): Promise<{
    block: string;
} | {
    answer: string;
} | {
    context: string[];
}> {
    await ready($, job);
    if (B.oldHooks)
        return { context: [] };
    const now = await $.clock.now();
    const prompt = String(data.prompt ?? '');
    B.answerWith = '';
    const limit = await limitPrompt($, data, now);
    if ('block' in limit)
        return limit;
    if ('answer' in limit) {
        B.answerWith = limit.answer;
        return limit;
    }
    const context: string[] = [];
    if (limit.pass)
        context.push(limit.pass);
    if (isPingText(prompt))
        context.push(pingContext(S.pingSent && !fromTimer(data)));
    if (await lightSession($))
        return { context };
    if (!isPingText(prompt) && !(await mainSession($))) {
        stillLive(job);
        await gatePrompt($);
    }
    await recallSwitch($);
    if (B.recallOn) {
        const r = onPrompt(prompt, now) as {
            state: Record<string, unknown>;
            log: unknown;
        };
        B.recallState = r.state;
        await recallLog($, r.log);
    }
    if (B.startNote) {
        context.push(B.startNote);
        B.startNote = '';
    }
    context.push(...B.notes.splice(0));
    return { context };
}
async function memDir($: Engine) {
    for (const d of [B.brainDir && `${B.brainDir}/memory`, B.root && `${B.root}/memory`])
        if (d && (await $.fs.exists(d)))
            return d;
    return '';
}
export async function brainStop($: Engine, data: Data, hook?: HookLink): Promise<string | null> {
    const job = newJob('stop', hook);
    return within(job, stopJobs($, job, data));
}
export async function disarmBackup($: Engine) {
    if (!B.home || !B.sid || !B.root)
        return;
    const f = `${B.home}/.claude/havok-backup-armed/${safeSession(B.sid)}.json`;
    if (!(await $.fs.exists(f).catch(() => false)))
        return;
    const cur = parse(await readText($, f)) as {
        armed?: boolean;
    } | null;
    if (!cur || cur.armed !== true)
        return;
    await $.fs.write(f, JSON.stringify({ armed: false, at: new Date(await $.clock.now()).toISOString(), why: `disarmed by havok-mod ${VERSION}` }));
    const r = await $.process.run(['node', `${B.root}/tools/backup-arm.mjs`, 'recompute'], { timeoutMs: 15000 }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }));
    $.ui.log(`backup hooks disarmed for this session: ${String(r.stdout || r.stderr).trim().slice(0, 160)}`, { to: 'debug' });
}
async function stopJobs($: Engine, job: Job, data: Data): Promise<string | null> {
    if (await lightSession($))
        return null;
    await ready($, job);
    if (B.oldHooks)
        return null;
    await disarmBackup($).catch(() => undefined);
    if (data.stop_hook_active !== true) {
        const reasons = (await writingOn($)) ? styleProblems(String(data.last_assistant_message ?? '')) : [];
        if (reasons.length)
            B.notes.push(slipNote(reasons));
        const mem = await memDir($);
        if (mem && B.sid) {
            const stateFile = `${B.claude}/havok-sessions/${B.sid}.json`;
            if (B.memState === undefined)
                B.memState = parse(await readText($, stateFile));
            try {
                const now = snapshotOf((await $.fs.list(mem)).filter((x) => x.kind === 'file'));
                const r = afterStop(B.memState, now, mem) as {
                    state: unknown;
                    note?: string;
                };
                B.memState = r.state;
                await $.fs.write(stateFile, JSON.stringify(r.state)).catch(() => undefined);
                if (r.note)
                    B.notes.push(r.note);
            }
            catch { }
        }
    }
    const gate = await gateStop($, job);
    if (gate)
        return gate;
    if (B.recallOn && !(await gateState($)).down) {
        const r = onStop(B.recallState, cliPath()) as {
            state: Record<string, unknown>;
            block?: string;
            log?: unknown;
        };
        B.recallState = r.state;
        await recallLog($, r.log);
        if (r.block)
            return r.block;
    }
    return null;
}
export async function brainSessionStart($: Engine, data: Data, hook?: HookLink): Promise<void> {
    const job = newJob('start', hook);
    return within(job, startJobs($, job, data));
}
export async function lightSession($: Engine) { return String((await $.env.get('HAVOK_MOD_LIGHT')) ?? '').trim() === '1'; }
async function startJobs($: Engine, job: Job, data: Data) {
    if (await lightSession($))
        return;
    await ready($, job);
    if (!B.root || B.oldHooks)
        return;
    await disarmBackup($).catch(() => undefined);
    stillLive(job);
    void (async () => {
        try {
            const own = data.source === 'compact' && S.ownCompactAt > 0 && (await $.clock.now()) - S.ownCompactAt < 120000;
            const r = await runScript($, 'check-session-start.mjs', [], own ? { ...data, source: 'havok-cleanup' } : data, SESSION_START_MS);
            const text = r.stdout.trim();
            if (!text)
                return;
            const o = parse(text) as {
                hookSpecificOutput?: {
                    additionalContext?: string;
                };
            } | null;
            const ctx = o ? o.hookSpecificOutput?.additionalContext : text;
            if (ctx)
                B.startNote = ctx;
        }
        catch (err) {
            $.ui.log(`brain session start did not finish: ${String(err).slice(0, 160)}`, { to: 'debug' });
        }
    })();
}
export function brainRequest(usage: unknown) {
    const n = contextOf(usage as never);
    if (n)
        B.ctxTokens = n;
}
export async function brainCompact($: Engine, data: Data, hook?: HookLink): Promise<void> {
    const job = newJob('compact', hook);
    return within(job, compactJobs($, job, data));
}
async function compactJobs($: Engine, job: Job, data: Data) {
    await ready($, job);
    if (B.oldHooks)
        return;
    const now = await $.clock.now();
    await appendLine($, `${B.claude}/havok-compact-log.jsonl`, compactRow(new Date(now).toISOString(), B.machine, B.sid, data.trigger, B.ctxTokens, data.compact_summary));
    if (B.sid)
        await $.fs.write(`${B.claude}/havok-compact-watch/${B.sid}.json`, watchState(now)).catch(() => undefined);
}
