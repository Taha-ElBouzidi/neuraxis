import type { On, PromptSubmitInput, TurnCompleteInput, TurnStartInput, TurnStepResult } from 'claude-code';
import * as frameRules from './brain/mail-frame-rules.mjs';
const quoted = (t: string): string => frameRules.quoted(t);
const utc = (iso: string): string => frameRules.utc(iso);
const headerId = (id: unknown): string => frameRules.headerId(id);
import { type Config, type Engine, type TurnKind, subscriptionReserve, S, PLUGIN, MAIL_WORD, stripIdleMarks, FORK_REFUSAL, isBackgroundFork, setStatus, toolName, toolMatch, update, waitCapped, org, owner, mainAgent } from './shared';
import { BAR, isMainAgent, isUrgentRelay, URGENT } from './brain/limit-rules.mjs';
type Msg = {
    id: string;
    seq: number;
    from: string;
    to: string;
    text: string;
    reply_to: string | null;
    sent_at: string;
    expect_reply: boolean;
    age_s?: number;
    got?: number;
};
type Outgoing = {
    key: string;
    to?: string;
    text: string;
    reply_to?: string;
    queuedAt: number;
    tries: number;
};
type Reply = {
    ok: boolean;
    status: number;
    body: Record<string, unknown>;
    net: boolean;
};
const MAIL_VERSION = '1.2.0';
const KEEP_DELIVERED_MS = 14 * 24 * 3600 * 1000;
const KEEP_DELIVERED_MAX = 1000;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const EMPTY_POLL_MS = 3000;
const SEND_WAIT_MS = 6000;
const RETRY_RECHECK_MS = 10 * 60000;
export const QUEUED_NOT_SENT = `The message is queued, not sent yet: the messages service did not confirm it within ${SEND_WAIT_MS / 1000} s (an earlier send may still be going). It stays in the outbox and goes out in order; nothing is lost.`;
const RETRY_STATUS = new Set([401, 408, 429]);
export const TOOLS = { send: toolName('send_message'), status: toolName('message_status'), agents: toolName('list_agents') };
let cfg: Config['mail'] & {
    agent: string;
    machine: string;
    limitsFile: string;
    home: string;
    brainDir: string;
} = null as never;
let on = false;
let token = '';
let consumer = '';
let generation = 0;
let polling = false;
let stoppedReason = '';
let heldIds = new Set<string>();
let deliveredHere = new Set<string>();
const refusedTimes = new Map<string, number>();
export const SET_ASIDE_AFTER = 2;
let setAsideCount = 0;
let holding: Msg[] = [];
let waiting = 0;
let offline = '';
const REPORT_TO = () => org().reportTo;
let outboxLock: Promise<unknown> = Promise.resolve();
let wakeUp: (() => void) | null = null;
let beatTimer: {
    cancel: () => void;
} | null = null;
type Carried = {
    msgs: Msg[];
    turnId?: string;
    saw: boolean;
    at: number;
};
let lastMailTurnAt = 0;
export const UNBOUND_FALLBACK_MS = 5000;
let carried: Carried[] = [];
let retry: {
    at: number;
    reason: string;
    reserve?: boolean;
} | null = null;
export const BUSY_REASON = "waiting for the recipient's current turn to end; it gets the message at its next tool call or when the turn ends";
export const BUSY_TELL_MS = 60000;
let busySince = 0;
let busyRecorded = '';
let busyTold = '';
const addressOf = () => `${cfg.agent}@${cfg.machine}`;
const kDelivered = () => addressOf() + ':delivered';
const kOutbox = () => addressOf() + ':outbox';
const kConsumers = () => addressOf() + ':consumers';
const kInflight = () => addressOf() + ':inflight';
type Flight = {
    consumer: string;
    session: string;
    beatAt: number;
    msgs: Msg[];
};
const FLIGHT_STALE_MS = 90000;
let sessionId = '';
const flightOf = (v: unknown): Flight => {
    if (Array.isArray(v))
        return { consumer: '', session: '', beatAt: 0, msgs: v as Msg[] };
    const f = (v ?? {}) as Partial<Flight>;
    return { consumer: String(f.consumer ?? ''), session: String(f.session ?? ''), beatAt: Number(f.beatAt) || 0, msgs: Array.isArray(f.msgs) ? f.msgs : [] };
};
let flightLock: Promise<unknown> = Promise.resolve();
function inFlight<T>(run: () => Promise<T>): Promise<T> {
    const next = flightLock.then(run, run);
    flightLock = next.catch(() => undefined);
    return next;
}
function setInflight($: Engine, msgs: Msg[]) { return inFlight(() => setInflightNow($, msgs)); }
async function setInflightNow($: Engine, msgs: Msg[]) {
    const now = await $.clock.now();
    const ids = msgs.map((m) => m.id);
    await update<Flight>($, kInflight(), (cur) => {
        const f = flightOf(cur);
        return { consumer, session: sessionId, beatAt: now, msgs: [...f.msgs.filter((m) => !ids.includes(m.id)), ...msgs] };
    }, (stored) => ids.every((id) => flightOf(stored).msgs.some((m) => m.id === id))).catch((err: unknown) => {
        $.ui.log(`could not keep ${ids.join(', ')} in flight (${String(err).slice(0, 120)}); a kill before the turn ends would lose them`);
    });
}
function clearInflight($: Engine, ids: string[]) { return inFlight(() => clearInflightNow($, ids)); }
async function clearInflightNow($: Engine, ids: string[]) {
    await update<Flight>($, kInflight(), (cur) => { const f = flightOf(cur); return { ...f, msgs: f.msgs.filter((m) => !ids.includes(m.id)) }; }, (stored) => !flightOf(stored).msgs.some((m) => ids.includes(m.id))).catch(() => undefined);
}
function beatInflight($: Engine) { return inFlight(() => beatInflightNow($)); }
async function beatInflightNow($: Engine) {
    const now = await $.clock.now();
    await update<Flight>($, kInflight(), (cur) => { const f = flightOf(cur); return f.consumer === consumer && f.msgs.length ? { ...f, beatAt: now } : f; }).catch(() => undefined);
}
function takeInflight($: Engine): Promise<Msg[]> { return inFlight(() => takeInflightNow($)); }
async function takeInflightNow($: Engine): Promise<Msg[]> {
    const now = await $.clock.now();
    const mine = new Set(carried.flatMap((c) => c.msgs.map((m) => m.id)));
    let left: Msg[] = [];
    await update<Flight>($, kInflight(), (cur) => {
        const f = flightOf(cur);
        left = [];
        const gone = f.consumer !== consumer && (f.session === sessionId || now - f.beatAt > FLIGHT_STALE_MS);
        if (!gone || !f.msgs.length)
            return f;
        left = f.msgs.filter((m) => !mine.has(m.id));
        return { consumer, session: sessionId, beatAt: now, msgs: f.msgs };
    }).catch(() => { left = []; });
    return left;
}
async function readToken($: Engine): Promise<boolean> {
    try {
        token = (await $.fs.read(cfg.tokenFile)).trim();
        return !!token;
    }
    catch {
        token = '';
        return false;
    }
}
const API_MS = 6000;
const NO_ANSWER: Reply = { ok: false, status: 0, body: {}, net: true };
async function api($: Engine, method: string, path: string, body?: unknown): Promise<Reply> {
    const waitS = /^\/inbox\?/.test(path) ? Number((/[?&]wait=(\d+)/.exec(path) || [])[1] || 0) : 0;
    const budget = waitS ? waitS * 1000 + 5000 : API_MS;
    let timer: {
        cancel: () => void;
    } | null = null;
    const late = new Promise<Reply>((resolve) => { timer = $.clock.after(budget, () => resolve(NO_ANSWER)); });
    const r = await Promise.race([call($, method, path, body), late]);
    timer?.cancel();
    if (r === NO_ANSWER)
        $.ui.log(`messages service call ${method} ${path.slice(0, 40)} gave no answer within ${budget / 1000} s`, { to: 'debug' });
    return r;
}
async function call($: Engine, method: string, path: string, body?: unknown): Promise<Reply> {
    try {
        const r = await $.http.fetch(cfg.url + path, {
            method,
            headers: { authorization: 'Bearer ' + token, 'x-agent': cfg.agent, 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        let parsed: Record<string, unknown> = {};
        try {
            parsed = JSON.parse(r.text) as Record<string, unknown>;
        }
        catch {
            parsed = {};
        }
        if (r.status === 401)
            await readToken($);
        const net = r.status === 502 || r.status === 503 || r.status === 504;
        return { ok: r.ok, status: r.status, body: parsed, net };
    }
    catch (err) {
        $.ui.log(`messages service call ${method} ${path} failed: ${String(err).slice(0, 200)}`, { to: 'debug' });
        return { ok: false, status: 0, body: {}, net: true };
    }
}
export function problem(r: Reply): string {
    const said = typeof r.body.error === 'string' ? r.body.error.trim() : '';
    if (said)
        return said.charAt(0).toUpperCase() + said.slice(1) + (/[.!?]$/.test(said) ? '' : '.');
    if (r.net)
        return 'The messages service is not reachable right now; try again in a minute.';
    return `The messages service could not answer (error ${r.status}); try again in a minute.`;
}
async function getDelivered($: Engine): Promise<Record<string, number>> {
    return ((await $.store.get(kDelivered())) as Record<string, number> | undefined) ?? {};
}
async function markDelivered($: Engine, ids: string[]) {
    const now = Date.now();
    await update<Record<string, number>>($, kDelivered(), (cur) => {
        const all = { ...(cur ?? {}) };
        for (const id of ids)
            all[id] = now;
        const kept = Object.entries(all).filter(([, at]) => now - at < KEEP_DELIVERED_MS).sort((a, b) => b[1] - a[1]).slice(0, KEEP_DELIVERED_MAX);
        return Object.fromEntries(kept);
    }, (stored) => ids.every((id) => stored?.[id] !== undefined));
}
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
export function ageWords(s: number): string {
    if (s < 60)
        return 'less than a minute ago';
    if (s < 3600)
        return plural(Math.floor(s / 60), 'minute');
    if (s < 86400)
        return plural(Math.floor(s / 3600), 'hour');
    return plural(Math.floor(s / 86400), 'day');
}
type Body = Record<string, unknown>;
const since = (iso: unknown, nowMs: number) => (typeof iso === 'string' && !Number.isNaN(Date.parse(iso)) ? ageWords(Math.max(0, (nowMs - Date.parse(iso)) / 1000)) : 'never');
function presence(a: Body | undefined, nowMs: number): string {
    if (!a || a.state === 'never_seen')
        return 'never connected';
    if (a.archived || a.state === 'archived')
        return 'archived (messages to it are held until it is restored)';
    if (String(a.state ?? '').startsWith('restored'))
        return 'restored, not started yet (messages wait for its next start)';
    if (a.listening && (a.busy || a.state === 'busy'))
        return 'busy in a turn (it gets a message at its next tool call)';
    if (a.listening)
        return 'listening, idle';
    if (a.state === 'stopped')
        return `open but paused until someone types there, last seen ${since(a.last_seen, nowMs)}`;
    return `not listening, last seen ${since(a.last_seen, nowMs)}`;
}
export function statusWords(b: Body, nowMs: number = Date.now()): string {
    const held = b.held as {
        reason?: string;
        times?: number;
    } | null;
    const gone = b.undeliverable as {
        at?: string;
        reason?: string;
    } | null;
    const failed = b.failed as {
        at?: string;
        reason?: string;
    } | null | undefined;
    let state: string;
    if (gone)
        state = `undeliverable since ${utc(String(gone.at))}${gone.reason ? ` (${gone.reason})` : ''}`;
    else if (b.reply_id)
        state = `delivered ${utc(String(b.delivered_at))}, answered ${utc(String(b.replied_at))} by message ${String(b.reply_id)}`;
    else if (b.delivered_at)
        state = `delivered ${utc(String(b.delivered_at))}`;
    else if (failed)
        state = `delivery failed ${utc(String(failed.at))}${failed.reason ? ` (${failed.reason})` : ''}, will retry`;
    else if (b.state === 'timeout')
        state = 'not delivered, and no answer came in time';
    else if (b.state === 'held' && held?.reason)
        state = `not delivered yet: ${held.reason}`;
    else if (b.state === 'offered' || b.state === 'held')
        state = 'being delivered';
    else
        state = 'waiting to be delivered';
    if (b.state === 'timeout' && b.delivered_at)
        state += ', no answer came in time';
    const heldLine = held?.times ? ` It was held back ${held.times} time${held.times === 1 ? '' : 's'}${held.reason ? ` (${held.reason})` : ''}.` : '';
    const recipient = b.recipient as Body | undefined;
    const who = recipient ? ` The recipient is ${presence(recipient, nowMs)}.` : '';
    const text = typeof b.text === 'string' ? `\n<<<\n${quoted(b.text)}\n>>>` : '';
    return `Message ${String(b.id)} from ${String(b.from)} to ${String(b.to)}, sent ${utc(String(b.sent_at))} (${since(b.sent_at, nowMs)}): ${state}.${heldLine}${who}${text}`;
}
export function agentsWords(b: Body, nowMs: number = Date.now()): string {
    const aliases = Object.entries((b.aliases as Record<string, string> | undefined) ?? {});
    const agents = (Array.isArray(b.agents) ? b.agents : []) as Body[];
    const lines = agents.filter((a) => a.address !== b.me).map((a) => {
        const names = aliases.filter(([, to]) => to === a.address).map(([n]) => n);
        const n = Number(a.waiting) || 0;
        return `- ${String(a.address)}${names.length ? ` (also ${names.join(', ')})` : ''}: ${presence(a, nowMs)}${n ? `, ${n} message${n === 1 ? '' : 's'} waiting` : ''}${a.may_message ? '' : ', you may not message it'}`;
    });
    return `You are ${String(b.me)}.${lines.length ? '\n' + lines.join('\n') : ' No other agent is known.'}`;
}
export const stripSignature = (text: string, from: string): string => frameRules.stripSignature(text, from);
const randomBoundary = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);
export function frame(msgs: Msg[], _nowMs: number = Date.now(), boundary: () => string = randomBoundary, ownerNames: string[] = []): string {
    return frameRules.frame(msgs as never, boundary, ownerNames);
}
const HEADER_LINE = /^AGENT MESSAGE: ([^\s,]+), (\d{4}-\d\d-\d\d \d\d:\d\d UTC|unknown time) \(id [^\s)]+\)$/gm;
export function foldedRow(text: string): string | null {
    const heads = [...String(text ?? '').matchAll(HEADER_LINE)];
    if (!heads.length)
        return null;
    if (heads.length === 1)
        return `Message from ${heads[0]![1]}, ${heads[0]![2]} (ctrl+o to read)`;
    const senders = [...new Set(heads.map((h) => h[1]!))];
    return `${heads.length} messages from ${senders.join(', ')}, last ${heads.at(-1)![2]} (ctrl+o to read)`;
}
function render($: Engine) {
    if (!on)
        return;
    const bits: string[] = [];
    if (access)
        bits.push(`CUT OFF: Anthropic refused this session since ${hhmm(access.since)}, sign-in or network needed`);
    if (offline)
        bits.push(offline === 'unreachable' ? 'server not reachable, retrying' : `server error ${offline}, retrying`);
    if (stoppedReason)
        bits.push(`${holding.length || waiting} waiting, type anything to let them in`);
    else if (retry && holding.length)
        bits.push(`${holding.length} waiting, delivery failed, will retry ${retryWhen(retry.at)}`);
    else if (holding.length)
        bits.push(S.turnRunning ? `${holding.length} for the next tool call` : `${holding.length} being delivered`);
    else if (waiting > 0)
        bits.push(`${waiting} waiting`);
    void $.store.get(kOutbox()).catch(() => undefined).then((o) => {
        const n = Array.isArray(o) ? o.length : 0;
        if (n)
            bits.push(`${n} in outbox`);
        setStatus($, 'mail', `messages ${bits.length ? bits.join(', ') : 'listening'}`);
    });
}
async function busyHold($: Engine) {
    const now = await $.clock.now();
    const ids = holding.map((m) => m.id);
    const key = ids.join(',');
    if (!busySince)
        busySince = now;
    if (busyRecorded !== key) {
        busyRecorded = key;
        await api($, 'POST', '/held', { consumer, ids, reason: BUSY_REASON, tell_sender: false });
    }
    if (busyTold !== key && now - busySince >= BUSY_TELL_MS) {
        busyTold = key;
        await api($, 'POST', '/held', { consumer, ids, reason: BUSY_REASON });
    }
}
function busyClear() { busySince = 0; busyRecorded = ''; busyTold = ''; }
export async function mailToolContext($: Engine, agentId: string | undefined): Promise<string | null> {
    if (!on || agentId !== undefined || !S.turnRunning || !holding.length)
        return null;
    const msgs = holding;
    const ids = msgs.map((m) => m.id);
    holding = [];
    ids.forEach((id) => deliveredHere.add(id));
    waiting = Math.max(0, waiting - ids.length);
    retry = null;
    stoppedReason = '';
    heldIds = new Set();
    busyClear();
    const text = frame(msgs, await $.clock.now(), randomBoundary, cfg.ownerNames ?? []);
    try {
        await markDelivered($, ids);
    }
    catch (err) {
        $.ui.log(`delivered ${ids.join(', ')} mid-turn but could not record it in the store (${String(err).slice(0, 120)}); this session will still not repeat it`);
    }
    await api($, 'POST', '/ack', { consumer, ids });
    $.ui.log(`messages ${ids.join(', ')} delivered with a tool result of the running turn`, { to: 'debug' });
    render($);
    wakeUp?.();
    return text;
}
const handedBack = new Set<string>();
const AGAIN_TEXT = 'Delivered above, but the turn that received it ended before it was answered (an API error or a refusal). Answer it now from the text above.';
async function stillShown($: Engine, ids: string[]): Promise<Set<string>> {
    const shown = new Set<string>();
    if (!ids.length)
        return shown;
    try {
        const rows = (await $.session.messages({ as: 'api' })) as unknown as {
            role?: string;
            content?: unknown;
        }[];
        const said = rows.filter((r) => r.role === 'user').map((r) => JSON.stringify(r.content ?? '')).join('\n');
        for (const id of ids)
            if (said.includes(`(id ${headerId(id)})`))
                shown.add(id);
    }
    catch { }
    return shown;
}
async function deliver($: Engine): Promise<boolean> {
    busyClear();
    const msgs = holding;
    const ids = msgs.map((m) => m.id);
    await setInflight($, msgs);
    const shown = await stillShown($, ids.filter((id) => handedBack.has(id)));
    const sent = msgs.map((m) => (shown.has(m.id) ? { ...m, text: AGAIN_TEXT } : m));
    if (shown.size)
        $.ui.log(`messages ${[...shown].join(', ')} are still in the conversation: sent again as a pointer, not in full`, { to: 'debug' });
    const res = await $.prompt.submit({ text: frame(sent, await $.clock.now(), randomBoundary, cfg.ownerNames ?? []), asUser: cfg.asUser !== false }).catch((err: unknown) => ({ drop: 'delivery failed: ' + String(err) }));
    if ('drop' in res && res.drop !== undefined) {
        await clearInflight($, ids);
        if ((await reserveCanBlock($)) && (await limitNow($)).hit) {
            await handBack($, msgs, 'blocked');
            return false;
        }
        const reason = 'session refused the message: ' + String(res.drop).slice(0, 140);
        const fresh = ids.some((id) => !heldIds.has(id)) || stoppedReason !== reason;
        stoppedReason = reason;
        if (fresh) {
            ids.forEach((id) => heldIds.add(id));
            await api($, 'POST', '/held', { consumer, ids, reason });
            await beat($);
        }
        return false;
    }
    ids.forEach((id) => deliveredHere.add(id));
    carried.push({ msgs, saw: false, at: await $.clock.now() });
    retry = null;
    const wasStopped = !!stoppedReason;
    stoppedReason = '';
    heldIds = new Set();
    holding = [];
    waiting = Math.max(0, waiting - ids.length);
    try {
        await markDelivered($, ids);
    }
    catch (err) {
        $.ui.log(`delivered ${ids.join(', ')} but could not record it in the store (${String(err).slice(0, 120)}); this session will still not repeat it`);
    }
    await api($, 'POST', '/ack', { consumer, ids });
    if (wasStopped)
        await beat($);
    return true;
}
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + ' UTC';
const retryWhen = (at: number) => (Number.isFinite(at) ? `at ${hhmm(at)}` : 'at the next prompt');
async function limitNow($: Engine): Promise<{
    hit: boolean;
    resetAt: number | null;
}> {
    const now = await $.clock.now();
    const hits: (number | null)[] = [];
    const count = (pct: unknown, reset: number | null) => {
        if (typeof pct !== 'number' || pct < BAR)
            return;
        if (reset !== null && reset <= now)
            return;
        hits.push(reset);
    };
    const usage = await $.session.usage().catch(() => undefined);
    for (const r of usage?.rateLimits ?? []) {
        if (r.kind !== 'five_hour' && r.kind !== 'seven_day')
            continue;
        const t = r.resetsAt ? Date.parse(r.resetsAt) : NaN;
        count(r.percentUsed, Number.isNaN(t) ? null : t);
    }
    try {
        const l = JSON.parse(await $.fs.read(cfg.limitsFile)) as Record<string, {
            used_percentage?: number;
            resets_at?: number;
        } | undefined>;
        for (const w of [l.five, l.week])
            if (w && Number(w.resets_at) > 0)
                count(w.used_percentage, Number(w.resets_at) * 1000);
    }
    catch { }
    if (!hits.length)
        return { hit: false, resetAt: null };
    return { hit: true, resetAt: hits.some((x) => x === null) ? null : Math.max(...(hits as number[])) };
}
async function reserveCanBlock($: Engine): Promise<boolean> {
    const r = await subscriptionReserve($, cfg.home, cfg.brainDir);
    return r.enabled && !isMainAgent(cfg.agent, r);
}
async function handBack($: Engine, msgsIn: Msg[], why: 'error' | 'refusal' | 'blocked') {
    let msgs = msgsIn;
    if (why === 'refusal') {
        const aside = msgs.filter((m) => { const n = (refusedTimes.get(m.id) ?? 0) + 1; refusedTimes.set(m.id, n); return n >= SET_ASIDE_AFTER; });
        if (aside.length && (await setAside($, aside)))
            msgs = msgs.filter((m) => !aside.includes(m));
        if (!msgs.length) {
            render($);
            wakeUp?.();
            return;
        }
    }
    const ids = msgs.map((m) => m.id);
    if (why !== 'blocked')
        ids.forEach((id) => handedBack.add(id));
    const now = await $.clock.now();
    const lim = await limitNow($);
    const at = why === 'refusal' ? now + cfg.failRetrySeconds * 1000 : lim.hit ? (lim.resetAt ?? Infinity) : now + cfg.failRetrySeconds * 1000;
    const what = why === 'blocked' ? 'the limit reserve blocked the prompt'
        : why === 'refusal' ? 'the turn ended in a refusal'
            : lim.hit ? 'the turn ended on the usage limit' : 'the turn ended on an API error';
    const reason = `${what}; retry ${retryWhen(at)}`;
    ids.forEach((id) => deliveredHere.delete(id));
    try {
        await update<Record<string, number>>($, kDelivered(), (cur) => Object.fromEntries(Object.entries(cur ?? {}).filter(([id]) => !ids.includes(id))), (stored) => ids.every((id) => stored?.[id] === undefined));
    }
    catch (err) {
        $.ui.log(`could not take ${ids.join(', ')} off the delivered list (${String(err).slice(0, 120)}); a restart may not offer them again`);
    }
    const r = await api($, 'POST', '/failed', { consumer, ids, reason });
    if (!r.ok) {
        $.ui.log(`messages service could not record the failed delivery of ${ids.join(', ')}: ${problem(r)}`, { to: 'debug' });
        if (why === 'blocked')
            await api($, 'POST', '/held', { consumer, ids, reason });
    }
    holding = [...msgs, ...holding.filter((m) => !ids.includes(m.id))];
    retry = { at, reason, reserve: why === 'blocked' };
    $.ui.log(`messages ${ids.join(', ')} not seen by the agent (${reason})`, { to: 'debug' });
    render($);
    wakeUp?.();
}
async function setAside($: Engine, msgs: Msg[]): Promise<boolean> {
    const ids = msgs.map((m) => m.id);
    const reason = `the recipient's turn ended in a refusal ${SET_ASIDE_AFTER} times; set aside, not delivered`;
    const r = await api($, 'POST', '/setaside', { consumer, ids, reason });
    if (!r.ok) {
        $.ui.log(`messages ${ids.join(', ')} could not be set aside (${problem(r)}); retried instead`, { to: 'debug' });
        return false;
    }
    const done = ((r.body.setAside as string[] | undefined) ?? []).filter((id) => ids.includes(id));
    for (const id of done) {
        deliveredHere.delete(id);
        refusedTimes.delete(id);
    }
    try {
        await update<Record<string, number>>($, kDelivered(), (cur) => Object.fromEntries(Object.entries(cur ?? {}).filter(([id]) => !done.includes(id))), (stored) => done.every((id) => stored?.[id] === undefined));
    }
    catch { }
    holding = holding.filter((m) => !done.includes(m.id));
    setAsideCount += done.length;
    $.ui.log(`messages ${done.join(', ')} set aside after ${SET_ASIDE_AFTER} refused turns; the next ones are delivered`, { to: 'transcript' });
    return done.length === ids.length;
}
function sleepOrWake($: Engine, ms: number): Promise<void> {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done)
                return;
            done = true;
            wakeUp = null;
            resolve();
        };
        wakeUp = finish;
        $.clock.sleep(ms).then(finish, finish);
    });
}
async function waitForNewer($: Engine, gen: number, left: number): Promise<boolean> {
    const since = Math.max(0, ...holding.map((m) => Number(m.seq) || 0));
    const asked = await $.clock.now();
    const r = await api($, 'GET', `/inbox?consumer=${consumer}&wait=${Math.max(1, Math.min(cfg.waitSeconds, Math.ceil(left / 1000)))}&since=${since}`);
    if (gen !== generation)
        return false;
    if (!r.ok || r.body.since === undefined) {
        await sleepOrWake($, Math.min(left, RETRY_RECHECK_MS));
        return false;
    }
    const have = new Set(holding.map((m) => m.id));
    const got = ((r.body.messages as Msg[] | undefined) ?? []).filter((m) => !have.has(m.id) && !deliveredHere.has(m.id));
    if (!got.length)
        return false;
    let kept: Record<string, number> = {};
    try {
        kept = await getDelivered($);
    }
    catch { }
    const fresh = got.filter((m) => kept[m.id] === undefined).map((m) => ({ ...m, got: asked }));
    if (!fresh.length)
        return false;
    holding = [...holding, ...fresh];
    const reserve = await subscriptionReserve($, cfg.home, cfg.brainDir);
    const relay = fresh.find((m) => isUrgentRelay(m.from, reserve.mainAgent, reserve.relays) && URGENT.test(String(m.text ?? '')));
    const urgent = !!relay;
    if (relay)
        $.ui.log(`message from ${relay.from} relaying "urgent": the held messages go now`, { to: 'debug' });
    return urgent;
}
async function loop($: Engine, gen: number) {
    let failures = 0;
    while (on && gen === generation) {
        await flushOutbox($);
        if (holding.length && retry) {
            const left = retry.at - (await $.clock.now());
            if (left > 0) {
                render($);
                if (!Number.isFinite(retry.at)) {
                    render($);
                    await sleepOrWake($, Math.min(left, RETRY_RECHECK_MS));
                    continue;
                }
                if (await waitForNewer($, gen, left))
                    retry = null;
                continue;
            }
            retry = null;
        }
        if (holding.length) {
            if (S.turnRunning) {
                await busyHold($);
                render($);
                await sleepOrWake($, Math.min(cfg.heldRetrySeconds * 1000, BUSY_TELL_MS));
                continue;
            }
            const hold = S.commandUntil - (await $.clock.now());
            if (hold > 0) {
                await sleepOrWake($, hold);
                continue;
            }
            if (await deliver($)) {
                render($);
                continue;
            }
            render($);
            if (retry)
                continue;
            await sleepOrWake($, cfg.heldRetrySeconds * 1000);
            continue;
        }
        await beatInflight($);
        polling = true;
        const asked = await $.clock.now();
        const r = await api($, 'GET', `/inbox?consumer=${consumer}&wait=${cfg.waitSeconds}`);
        polling = false;
        if (gen !== generation)
            return;
        if (!r.ok) {
            offline = r.net ? 'unreachable' : String(r.status);
            await serviceSeen($, !!r.net, asked).catch(() => undefined);
            render($);
            await sleepOrWake($, BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]!);
            continue;
        }
        failures = 0;
        offline = '';
        await serviceSeen($, false, await $.clock.now()).catch(() => undefined);
        waiting = Number(r.body.waiting) || 0;
        const msgs = ((r.body.messages as Msg[] | undefined) ?? []).map((m) => ({ ...m, got: asked }));
        if (!msgs.length) {
            render($);
            const took = (await $.clock.now()) - asked;
            if (took < EMPTY_POLL_MS)
                await sleepOrWake($, EMPTY_POLL_MS - took);
            continue;
        }
        let kept: Record<string, number>;
        try {
            kept = await getDelivered($);
        }
        catch {
            await sleepOrWake($, BACKOFF_MS[0]!);
            continue;
        }
        const isDelivered = (m: Msg) => deliveredHere.has(m.id) || kept[m.id] !== undefined;
        const already = msgs.filter(isDelivered);
        if (already.length)
            await api($, 'POST', '/ack', { consumer, ids: already.map((m) => m.id) });
        holding = msgs.filter((m) => !isDelivered(m));
        render($);
    }
}
async function retakeLater($: Engine, gen: number) {
    for (;;) {
        await $.clock.sleep(FLIGHT_STALE_MS + 1000);
        if (gen !== generation || !on)
            return;
        const f = flightOf(await $.store.get(kInflight()).catch(() => undefined));
        if (f.consumer === consumer || !f.msgs.length)
            return;
        const left = await takeInflight($);
        if (left.length) {
            holding = [...left, ...holding.filter((m) => !left.some((x) => x.id === m.id))];
            wakeUp?.();
            return;
        }
    }
}
async function beat($: Engine) {
    await beatInflight($);
    if (offline === 'unreachable')
        return;
    const waitingForTyping = holding.length > 0 && !!retry && !Number.isFinite(retry.at);
    const state = stoppedReason || waitingForTyping ? 'stopped' : S.turnRunning ? 'busy' : 'listening';
    const r = await api($, 'POST', '/heartbeat', { consumer, state, version: MAIL_VERSION });
    offline = r.ok ? '' : r.net ? 'unreachable' : String(r.status);
    if (r.ok)
        render($);
}
type SendOutcome = {
    kind: 'sent';
    body: Record<string, unknown>;
} | {
    kind: 'refused';
    error: string;
} | {
    kind: 'unreachable';
    error: string;
};
async function trySend($: Engine, item: Outgoing): Promise<SendOutcome> {
    const r = await api($, 'POST', '/send', { to: item.to, text: item.text, reply_to: item.reply_to, expect_reply: false, key: item.key });
    if (r.ok)
        return { kind: 'sent', body: r.body };
    const error = problem(r);
    if (r.net || r.status >= 500 || RETRY_STATUS.has(r.status))
        return { kind: 'unreachable', error };
    return { kind: 'refused', error };
}
function flushOutbox($: Engine): Promise<Map<string, SendOutcome>> {
    const run = outboxLock.then(async () => {
        const done = new Map<string, SendOutcome>();
        for (;;) {
            let box: Outgoing[];
            try {
                box = ((await $.store.get(kOutbox())) as Outgoing[] | undefined) ?? [];
            }
            catch {
                break;
            }
            const item = box[0];
            if (!item || done.has(item.key))
                break;
            const out = await trySend($, item);
            if (out.kind === 'unreachable') {
                offline = 'unreachable';
                await update<Outgoing[]>($, kOutbox(), (cur) => (cur ?? []).map((x) => (x.key === item.key ? { ...x, tries: x.tries + 1 } : x))).catch(() => undefined);
                break;
            }
            done.set(item.key, out);
            try {
                await update<Outgoing[]>($, kOutbox(), (cur) => (cur ?? []).filter((x) => x.key !== item.key));
            }
            catch {
                break;
            }
            if (out.kind === 'sent' && item.tries > 0)
                $.ui.log(`queued message to ${item.to || 'the sender of ' + item.reply_to} sent as ${String(out.body.id)}`, { to: 'transcript' });
            else if (out.kind === 'refused' && item.tries > 0)
                $.ui.log(`queued message to ${item.to || item.reply_to} was refused: ${out.error}`, { to: 'transcript' });
        }
        return done;
    });
    outboxLock = run.catch(() => undefined);
    return run;
}
function describeSent(b: Record<string, unknown>): string {
    const rec = (b.recipient as {
        state?: string;
        last_seen?: string | null;
        already_waiting?: number;
    } | undefined) ?? {};
    const seen = rec.last_seen ? utc(rec.last_seen) : 'never';
    const where = rec.state === 'archived' ? `is archived; the message is held and delivered only if ${owner()} has it restored and it starts again` : String(rec.state ?? '').startsWith('restored') ? 'was restored but has not started again; the message is held until it does' : rec.state === 'busy' ? 'is busy in a turn; it gets the message at its next tool call' : rec.state === 'listening' ? 'is listening now, idle' : rec.state === 'stopped' ? `is open but paused (last seen ${seen}); it gets the message once someone types there` : rec.state === 'never_seen' ? 'has never connected yet; the message waits for it' : `is not listening (last seen ${seen}); the message waits for it`;
    const n = rec.already_waiting;
    const queue = typeof n === 'number' && n > 0 ? ` ${n} message${n === 1 ? '' : 's'} already wait${n === 1 ? 's' : ''} for it.` : '';
    const dup = b.duplicate ? ' (it had already reached the messages service; it is not sent twice)' : '';
    return `Sent: message ${String(b.id)} to ${String(b.to)}${dup}. The recipient ${where}.${queue}`;
}
async function registerTools($: Engine) {
    await $.tool.register({
        name: 'send_message',
        isDeferred: false,
        description: 'Send a message to another agent (on another machine or Claude account) through the Havok messages service. ' +
            'Use the full address agent@MACHINE, or a known agent name. To answer a message you received, pass its id as reply_to (to may then be left out). ' +
            'The recipient gets it as a new turn. Never put secrets in a message.',
        inputSchema: {
            type: 'object',
            properties: {
                to: { type: 'string', description: 'Recipient: agent@MACHINE, or a known agent name. Optional when reply_to is given.' },
                text: { type: 'string', description: 'The message.' },
                reply_to: { type: 'string', description: 'The id of the message this answers.' },
            },
            required: ['text'],
        },
    });
    await $.tool.register({
        name: 'message_status',
        isDeferred: false,
        description: 'Show the state and history of a Havok message you sent or received: accepted, offered, held, in_progress, done (answered), undeliverable (the address was retired). The receipt shows when it was delivered to the recipient session and when it was answered.',
        inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The message id.' } }, required: ['id'] },
    });
    await $.tool.register({
        name: 'list_agents',
        isDeferred: false,
        description: 'List the agents the Havok messages service knows, whether each is listening now, and whether you may message it.',
        inputSchema: { type: 'object', properties: {} },
    });
}
export async function postOutage($: Engine, body: Record<string, unknown>): Promise<'done' | 'kept'> {
    if (!on)
        return 'kept';
    const r = await api($, 'POST', '/outage/report', body);
    if (r.ok)
        return 'done';
    if (r.net || r.status === 0 || r.status === 429 || r.status === 401 || r.status >= 500)
        return 'kept';
    if (r.status === 404)
        return 'kept';
    $.ui.log(`outage report refused (${r.status}): ${JSON.stringify(r.body).slice(0, 160)}`, { to: 'debug' });
    return 'done';
}
export async function sendSystemNote($: Engine, to: string, text: string): Promise<boolean> {
    if (!on)
        return false;
    const r = await api($, 'POST', '/send', { to, text, expect_reply: false, key: 'k-' + crypto.randomUUID() });
    return r.ok;
}
export async function mailStart($: Engine, c: Config) {
    generation++;
    on = false;
    holding = [];
    access = null;
    cutSince = 0;
    beatTimer?.cancel();
    beatTimer = null;
    if (!c.mail.enabled)
        return;
    carried = [];
    retry = null;
    cfg = { ...c.mail, agent: c.agent, machine: c.machine, limitsFile: c.keepWarm.limitsFile, home: c.home, brainDir: c.checks.brainDir };
    if (!(await readToken($))) {
        $.ui.log(`no token at ${cfg.tokenFile}; messaging is off`, { to: 'transcript' });
        return;
    }
    on = true;
    consumer = 'c-' + crypto.randomUUID();
    sessionId = String(await $.session.id().catch(() => ''));
    deliveredHere = new Set();
    await registerTools($);
    let previous: string[] = [];
    await update<string[]>($, kConsumers(), (cur) => {
        previous = (cur ?? []).filter((x) => x !== consumer);
        return [consumer, ...previous].slice(0, 5);
    }).catch(() => undefined);
    const left = await takeInflight($);
    if (left.length)
        holding = left;
    beatTimer = $.clock.every(cfg.beatSeconds * 1000, () => {
        if (!polling)
            void beat($);
    });
    render($);
    const gen = generation;
    void (async () => {
        const rel = await api($, 'POST', '/release', { consumer, previous });
        if (!rel.ok)
            offline = rel.net ? 'unreachable' : String(rel.status);
        if (!left.length)
            retakeLater($, gen).catch(() => undefined);
        await beat($);
        render($);
        await loop($, gen);
    })().catch(() => undefined);
}
export function mailSubmit($: Engine, e: PromptSubmitInput) {
    if (!on || !stoppedReason)
        return;
    if (e.origin?.kind === 'plugin')
        return;
    wakeUp?.();
}
export async function mailBusy($: Engine, agentId: string | undefined) {
    if (!on || agentId !== undefined)
        return;
    await beat($);
}
export function mailTurnStart(e: TurnStartInput, kind: TurnKind, now: number = Date.now()) {
    if (!on || e.agentId !== undefined)
        return;
    const next = carried.find((c) => c.turnId === undefined);
    if (kind === 'mail') {
        lastMailTurnAt = now;
        if (next)
            next.turnId = e.turnId;
    }
    else if (kind === 'real' && next && lastMailTurnAt < next.at && now - next.at >= UNBOUND_FALLBACK_MS)
        next.turnId = e.turnId;
    if (kind === 'real' && retry)
        retry = null;
}
export function mailStep(r: TurnStepResult | undefined, agentId: string | undefined) {
    const c = on && agentId === undefined && r ? carried.find((x) => x.turnId === r.turnId) : undefined;
    if (c && (String(r!.answer ?? '').trim() || (r!.toolUses?.length ?? 0) > 0))
        c.saw = true;
}
export async function mailTurn($: Engine, e: TurnCompleteInput, kind: TurnKind | 'subagent') {
    if (!on)
        return;
    if (e.agentId === undefined)
        await accessCheck($, e);
    const i = e.agentId === undefined ? carried.findIndex((x) => x.turnId === e.turnId || (x.turnId === undefined && kind === 'mail')) : -1;
    if (i >= 0) {
        const c = carried.splice(i, 1)[0]!;
        await clearInflight($, c.msgs.map((m) => m.id));
        const died = e.reason === 'error' || e.reason === 'refusal';
        if (died && !c.saw)
            await handBack($, c.msgs, e.reason === 'refusal' ? 'refusal' : 'error');
    }
    if (holding.length)
        wakeUp?.();
    if (e.agentId === undefined)
        void beat($).catch(() => undefined);
}
export const ACCESS_ERROR = /run \/login|API Error: 40[13]|authentication_error|permission_error|Application Control|OAuth token/i;
export const CUT_REPORT_MS = 5 * 60000;
let access: {
    since: number;
    text: string;
    told: boolean;
} | null = null;
let cutSince = 0;
const reportsToItself = () => !REPORT_TO() || `${cfg.agent}@${cfg.machine}` === REPORT_TO() || cfg.agent === 'havok';
async function accessCheck($: Engine, e: TurnCompleteInput) {
    const now = await $.clock.now();
    const text = String(e.answer ?? '');
    if (e.reason === 'error' && ACCESS_ERROR.test(text)) {
        if (!access)
            access = { since: now, text: text.trim().slice(0, 200), told: false };
        render($);
        await tellAccess($, now);
        return;
    }
    if (e.reason === 'answer' && access) {
        const was = access;
        access = null;
        render($);
        if (!reportsToItself())
            await sendSystemNote($, REPORT_TO(), `${cfg.agent}@${cfg.machine} works again at ${hhmm(now)}: its calls to Anthropic were refused from ${hhmm(was.since)} (${was.text}).`).catch(() => false);
    }
}
async function tellAccess($: Engine, now: number) {
    if (!access || access.told || reportsToItself())
        return;
    access.told = await sendSystemNote($, REPORT_TO(), `${cfg.agent}@${cfg.machine} cannot reach Anthropic since ${hhmm(access.since)}: "${access.text}". A sign-in by ${owner()} (/login in its window) or a network fix is needed; noticed ${hhmm(now)}.`).catch(() => false);
}
async function serviceSeen($: Engine, unreachable: boolean, now: number) {
    if (unreachable) {
        if (!cutSince)
            cutSince = now;
        return;
    }
    if (access && !access.told)
        await tellAccess($, now);
    if (!cutSince)
        return;
    const from = cutSince;
    cutSince = 0;
    if (now - from >= CUT_REPORT_MS)
        $.ui.log(`messages service unreachable from ${hhmm(from)} to ${hhmm(now)} (${Math.round((now - from) / 60000)} minutes)`, { to: 'debug' });
}
export function accessState() { return access ? { since: access.since, text: access.text } : null; }
export function mailTools(onHook: On) {
    onHook('tool.call', toolMatch('send_message'), async ($, e, next) => {
        if (!on)
            return { deny: 'Havok messages are not configured in this folder.' };
        if (await isBackgroundFork($, (e as {
            agentId?: string;
        }).agentId))
            return { deny: FORK_REFUSAL };
        const input = e as unknown as {
            to?: unknown;
            text?: unknown;
            reply_to?: unknown;
        };
        const text = typeof input.text === 'string' ? input.text : '';
        if (!text.trim())
            return { deny: 'The message text is empty.' };
        if (!input.to && !input.reply_to)
            return { deny: 'Give to (agent@MACHINE or an agent name), or reply_to.' };
        const item: Outgoing = {
            key: 'k-' + crypto.randomUUID(),
            text,
            queuedAt: Date.now(),
            tries: 0,
            ...(input.to ? { to: String(input.to) } : {}),
            ...(input.reply_to ? { reply_to: String(input.reply_to) } : {}),
        };
        const queued = outboxLock.then(() => update<Outgoing[]>($, kOutbox(), (cur) => [...(cur ?? []), item], (stored) => !!stored?.some((x) => x.key === item.key)));
        outboxLock = queued.catch(() => undefined);
        const flushed = queued.then(() => flushOutbox($));
        flushed.catch(() => undefined);
        if (offline === 'unreachable') {
            await queued.catch(() => undefined);
            render($);
            return { result: 'The messages service is not reachable right now (its machine gives no answer). The message is kept in the outbox and will be sent once the service answers; nothing is lost.' };
        }
        if (!(await waitCapped($, flushed, SEND_WAIT_MS, next))) {
            render($);
            return { result: QUEUED_NOT_SENT };
        }
        const done = await flushed;
        render($);
        const out = done.get(item.key);
        if (!out)
            return { result: 'The messages service is not reachable right now. The message is kept in the outbox and will be sent once the service answers; nothing is lost.' };
        if (out.kind === 'refused')
            return { deny: 'The messages service refused the message. ' + out.error };
        if (out.kind === 'unreachable')
            return { result: 'The messages service could not take the message right now. It is kept in the outbox and will be sent once the service answers; nothing is lost.' };
        return { result: describeSent(out.body) };
    }).catch(() => ({ deny: 'The send failed in the mod. If the message reached the outbox it will still be sent; check with message_status later.' }));
    onHook('tool.call', toolMatch('message_status'), async ($, e) => {
        if (!on)
            return { deny: 'Havok messages are not configured in this folder.' };
        const id = String((e as unknown as {
            id?: unknown;
        }).id || '');
        const r = await api($, 'GET', '/status/' + encodeURIComponent(id));
        if (!r.ok)
            return { deny: problem(r) };
        return { result: statusWords(r.body) };
    }).catch(() => ({ deny: 'The status check failed in the mod; try again.' }));
    onHook('tool.call', toolMatch('list_agents'), async ($) => {
        if (!on)
            return { deny: 'Havok messages are not configured in this folder.' };
        const r = await api($, 'GET', '/agents');
        if (!r.ok)
            return { deny: problem(r) };
        return { result: agentsWords(r.body) };
    }).catch(() => ({ deny: 'Listing the agents failed in the mod; try again.' }));
}
export const stopForTests = () => { generation++; on = false; beatTimer?.cancel(); };
export const mailState = () => ({ on, holding: holding.length, stoppedReason, polling, S });
