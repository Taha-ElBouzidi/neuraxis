import type { PromptSubmitInput, TurnCompleteInput } from 'claude-code';
import { type Config, type Engine, type WarmLast, PLUGIN, S, recordHidden, setStatus, setWarm } from './shared';
import { askIdle } from './context';
const COLD_MS = 59 * 60000;
let cfg: Config['keepWarm'] | null = null;
let timer: {
    cancel: () => void;
} | null = null;
let pings = 0;
let nextAt = 0;
let finalAsked = false;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
function render($: Engine, text: string) { setStatus($, 'warm', cfg ? `keep-warm ${text}` : ''); }
let last: WarmLast | null = null;
function publish($: Engine) {
    setWarm($, cfg ? { on: true, pings, max: cfg.maxPings, ...(timer && nextAt && pings > 0 ? { next: new Date(nextAt).toISOString() } : {}), ...(last ? { last } : {}) } : { on: false });
}
function disarm() { timer?.cancel(); timer = null; nextAt = 0; }
async function arm($: Engine) {
    disarm();
    if (!cfg)
        return;
    const ms = cfg.everyMinutes * 60000;
    nextAt = (await $.clock.now()) + ms;
    timer = $.clock.after(ms, () => void fire($));
    publish($);
    render($, `next ping ${hhmm(nextAt)} UTC (${pings + 1} of ${cfg.maxPings})`);
}
function stop($: Engine, why: string, short: string) {
    disarm();
    publish($);
    render($, `stopped: ${short}`);
    $.ui.log(`keep-warm stopped: ${why}`, { to: 'debug' });
}
export async function limitUsed($: Engine, file: string): Promise<number> {
    let pct = 0;
    const usage = await $.session.usage().catch(() => undefined);
    for (const r of usage?.rateLimits ?? [])
        if (r.kind === 'five_hour' || r.kind === 'seven_day')
            pct = Math.max(pct, r.percentUsed);
    try {
        const l = JSON.parse(await $.fs.read(file)) as Record<string, {
            used_percentage?: number;
            resets_at?: number;
        } | undefined>;
        const now = await $.clock.now();
        for (const w of [l.five, l.week])
            if (w && typeof w.used_percentage === 'number' && Number(w.resets_at) * 1000 > now)
                pct = Math.max(pct, w.used_percentage);
    }
    catch { }
    return pct;
}
async function fire($: Engine) {
    timer = null;
    const c = cfg;
    if (!c)
        return;
    if (S.turnRunning)
        return;
    const now = await $.clock.now();
    if (S.lastRequest && now - S.lastRequest > COLD_MS)
        return stop($, 'the cache was already cold', 'cache already cold');
    const quiet = (at: number) => {
        const h = new Date(at).getUTCHours();
        const [from, to] = [c.quietHoursUtc[0] ?? 0, c.quietHoursUtc[1] ?? 0];
        return from !== to && (from < to ? h >= from && h < to : h >= from || h < to);
    };
    const [from, to] = [c.quietHoursUtc[0] ?? 0, c.quietHoursUtc[1] ?? 0];
    const final = async (why: string) => {
        if (!(await askIdle($)))
            return false;
        finalAsked = true;
        stop($, `${why}; the idle clean-up question was sent in place of the last ping`, 'clean-up question sent instead of the last ping');
        return true;
    };
    if (quiet(now)) {
        if (await final(`quiet hours ${from}:00 to ${to}:00 UTC`))
            return;
        return stop($, `quiet hours ${from}:00 to ${to}:00 UTC`, `quiet hours until ${to}:00 UTC`);
    }
    const used = await limitUsed($, c.limitsFile);
    if (used >= c.limitPercent) {
        if (await final(`limit reserve: ${used}% used, pings stop at ${c.limitPercent}%`))
            return;
        return stop($, `limit reserve: ${used}% used, pings stop at ${c.limitPercent}%`, `usage limit at ${used}%`);
    }
    if (pings + 1 >= c.maxPings && (await final(`${c.maxPings} pings with no real activity`)))
        return;
    if (quiet(now + c.everyMinutes * 60000) && (await final(`quiet hours ${from}:00 to ${to}:00 UTC begin before the next ping`)))
        return;
    if (c.fork) {
        let reason = '';
        for (let attempt = 1; attempt <= 2; attempt++) {
            const r = await $.model.fork({ prompt: 'Keep-warm ping from the Neuraxis mod. Reply with the single word ok.' }).catch((err: unknown) => ({ isAnswered: false, reason: 'error: ' + String(err).slice(0, 80) }) as never);
            const rr = r as {
                isAnswered?: boolean;
                reason?: string;
                status?: number;
                usage?: {
                    cache_read_input_tokens?: number;
                    cache_creation_input_tokens?: number;
                };
            };
            const read = Number(rr.usage?.cache_read_input_tokens ?? 0);
            const write = Number(rr.usage?.cache_creation_input_tokens ?? 0);
            const at = new Date(await $.clock.now()).toISOString();
            if (rr.isAnswered) {
                await recordHidden($, { kind: 'keepwarm', ok: true, try: attempt, read, write });
                S.lastRequest = await $.clock.now();
                pings++;
                last = { at, ok: true, read };
                $.ui.log(`keep-warm ping ${pings} of ${c.maxPings} as a fork: ${read} read from the cache, ${write} written`, { to: 'debug' });
                if (pings < c.maxPings)
                    await arm($);
                else
                    stop($, `${c.maxPings} pings with no real activity`, `${c.maxPings} pings with no activity`);
                return;
            }
            reason = `${String(rr.reason)}${rr.status ? ' ' + rr.status : ''}`;
            await recordHidden($, { kind: 'keepwarm', ok: false, try: attempt, read, write, reason });
            if (rr.reason === 'nothing-to-fork') {
                last = { at, ok: false, read: 0 };
                return stop($, 'nothing to fork: no request since the session started or since /clear, so no cache to keep', 'nothing to keep warm');
            }
        }
        pings++;
        last = { at: new Date(await $.clock.now()).toISOString(), ok: false, read: 0 };
        $.ui.log(`keep-warm ping ${pings} of ${c.maxPings} failed twice (${reason})`, { to: 'debug' });
        if (pings < c.maxPings)
            await arm($);
        else
            stop($, `${c.maxPings} pings with no real activity`, `${c.maxPings} pings with no activity`);
        return;
    }
    S.pingSent = true;
    const res = await $.prompt.submit({ text: c.pingText, asUser: true }).catch((err: unknown) => ({ drop: String(err) }));
    if ('drop' in res && res.drop !== undefined) {
        S.pingSent = false;
        return stop($, `the session refused the ping (${String(res.drop).slice(0, 80)})`, 'the session refused the ping');
    }
    render($, `ping ${pings + 1} of ${c.maxPings} sent ${hhmm(now)} UTC`);
    $.ui.log(`keep-warm ping ${pings + 1} of ${c.maxPings}`, { to: 'debug' });
}
export async function warmStart($: Engine, c: Config) {
    disarm();
    pings = 0;
    finalAsked = false;
    cfg = c.keepWarm.enabled && c.keepWarm.maxPings > 0 ? { ...c.keepWarm } : null;
    publish($);
    if (!cfg) {
        setStatus($, 'warm', '');
        return;
    }
    render($, 'on, starts after the next reply');
}
export function warmSubmit($: Engine, e: PromptSubmitInput): PromptSubmitInput {
    if (!cfg)
        return e;
    const own = e.origin?.kind === 'plugin' && (e.origin as {
        name?: string;
    }).name === PLUGIN;
    if (!own) {
        disarm();
        publish($);
    }
    return e;
}
export async function warmTurn($: Engine, e: TurnCompleteInput, kind: string) {
    if (!cfg || e.agentId !== undefined)
        return;
    if (e.isAborted) {
        disarm();
        publish($);
        return;
    }
    if (kind === 'real' || kind === 'mail') {
        pings = 0;
        finalAsked = false;
        await arm($);
        return;
    }
    if (kind === 'ping') {
        pings++;
        if (pings < cfg.maxPings)
            await arm($);
        else
            stop($, `${cfg.maxPings} pings with no real activity`, `${cfg.maxPings} pings with no activity`);
        return;
    }
    if (kind === 'idle' && !finalAsked && pings < cfg.maxPings)
        await arm($);
}
export const warmState = () => ({ on: !!cfg, pings, nextAt, armed: !!timer });
