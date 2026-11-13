import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
export const QUIET_MS = 2 * 60000;
export const KINDS = new Set(['recall']);
const MAX_ERROR = 300;
const KEEP_IN_MEMORY = 500;
export function openOutages(dataDir, { now = () => Date.now(), quietMs = QUIET_MS } = {}) {
    const file = join(dataDir, 'outages.jsonl');
    const all = new Map();
    let seq = 0;
    const open = new Map();
    function apply(e) {
        if (e.type === 'open') {
            all.set(e.id, { id: e.id, kind: e.kind, start: e.at, end: null, closingAt: null, reports: [], alert: e.alert ?? null, back: null });
            open.set(e.kind, e.id);
            seq = Math.max(seq, Number(String(e.id).split('-').pop()) || 0);
        }
        else if (e.type === 'report') {
            const o = all.get(e.id);
            if (!o)
                return;
            o.reports.push(e.report);
            if (e.report.state === 'down' && e.report.at < o.start)
                o.start = e.report.at;
            if (o.end === null) {
                const lastDown = Math.max(...o.reports.filter((x) => x.state === 'down').map((x) => x.at));
                const ups = o.reports.filter((x) => x.state === 'up' && x.at >= lastDown).map((x) => x.at);
                o.closingAt = ups.length ? Math.min(...ups) + quietMs : null;
            }
        }
        else if (e.type === 'close') {
            const o = all.get(e.id);
            if (!o)
                return;
            o.end = e.end;
            o.closingAt = null;
            o.back = e.back ?? null;
            if (open.get(o.kind) === o.id)
                open.delete(o.kind);
        }
        else if (e.type === 'stray') {
            const key = 'stray';
            if (!all.has(key))
                all.set(key, { id: key, kind: 'none', start: 0, end: 0, closingAt: null, reports: [], alert: null, back: null });
            all.get(key).reports.push(e.report);
        }
        else if (e.type === 'alert') {
            const o = all.get(e.id);
            if (o)
                o.alert = e.alert;
        }
        if (all.size > KEEP_IN_MEMORY) {
            const oldest = [...all.values()].filter((x) => x.end !== null && x.id !== 'stray').sort((a, b) => a.start - b.start)[0];
            if (oldest)
                all.delete(oldest.id);
        }
    }
    function record(e) {
        appendFileSync(file, JSON.stringify(e) + '\n');
        apply(e);
    }
    if (existsSync(file)) {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim())
                continue;
            try {
                apply(JSON.parse(line));
            }
            catch { }
        }
    }
    function report(kind, r) {
        const t = now();
        const at = Number.isFinite(r.at) ? Math.min(Math.max(r.at, t - 7 * 86400000), t) : t;
        const rep = { state: r.state, at, received: t, by: r.by, machine: r.machine, error: String(r.error ?? '').slice(0, MAX_ERROR), serverHealthy: r.serverHealthy ?? null, serverMs: r.serverMs ?? null };
        const openId = open.get(kind);
        if (r.state === 'down') {
            if (openId) {
                record({ type: 'report', id: openId, report: rep });
                return { outage: all.get(openId), opened: false };
            }
            const past = [...all.values()].find((o) => o.kind === kind && o.end !== null && at >= o.start && at <= o.end + quietMs);
            if (past) {
                record({ type: 'report', id: past.id, report: rep });
                return { outage: past, opened: false };
            }
            const id = `${kind}-${new Date(at).toISOString().slice(0, 10)}-${++seq}`;
            record({ type: 'open', id, kind, at });
            record({ type: 'report', id, report: rep });
            return { outage: all.get(id), opened: true };
        }
        if (openId) {
            record({ type: 'report', id: openId, report: rep });
            return { outage: all.get(openId), opened: false };
        }
        const past = [...all.values()].find((o) => o.kind === kind && o.end !== null && at >= o.start && at <= o.end + quietMs);
        if (past) {
            record({ type: 'report', id: past.id, report: rep });
            return { outage: past, opened: false };
        }
        record({ type: 'stray', report: { ...rep, kind } });
        return { outage: null, opened: false };
    }
    function due() {
        const t = now();
        const out = [];
        for (const id of open.values()) {
            const o = all.get(id);
            if (o && o.closingAt !== null && o.closingAt <= t) {
                const lastDown = Math.max(...o.reports.filter((x) => x.state === 'down').map((x) => x.at));
                const ups = o.reports.filter((x) => x.state === 'up' && x.at >= lastDown).map((x) => x.at);
                const end = ups.length ? Math.min(...ups) : t;
                out.push({ o, end });
            }
        }
        for (const { o, end } of out)
            record({ type: 'close', id: o.id, end });
        return out.map(({ o }) => all.get(o.id));
    }
    const nextClosing = () => { let at = null; for (const id of open.values()) {
        const c = all.get(id)?.closingAt;
        if (c != null && (at === null || c < at))
            at = c;
    } return at; };
    const noteAlert = (id, alert) => record({ type: 'alert', id, alert });
    const list = () => [...all.values()].filter((o) => o.id !== 'stray').sort((a, b) => b.start - a.start);
    const strays = () => all.get('stray')?.reports ?? [];
    return { report, due, nextClosing, noteAlert, list, strays, file };
}
const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + ' UTC';
const minutes = (ms) => Math.max(1, Math.round(ms / 60000));
const HUB = String(process.env.MAIL_HOME_MACHINE || process.env.COMPUTERNAME || 'this machine').toUpperCase();
export function diagnosis(o) {
    const downs = o.reports.filter((r) => r.state === 'down');
    const machines = [...new Set(downs.map((r) => r.machine))];
    const checked = downs.filter((r) => r.serverHealthy !== null);
    const sick = checked.filter((r) => r.serverHealthy === false).length;
    if (checked.length && sick === 0)
        return machines.length === 1 && machines[0] !== HUB
            ? `${HUB}'s brain server answered its own health check every time, so this was ${machines[0]}'s link to ${HUB}, not the server`
            : `${HUB}'s brain server answered its own health check every time, so the server was up; the machines that reported could not reach it`;
    if (checked.length && sick === checked.length)
        return `${HUB}'s brain server did not answer its own health check either, so the server itself was down`;
    if (checked.length)
        return `${HUB}'s brain server failed its own health check at ${sick} of ${checked.length} reports`;
    return `${HUB}'s own health check was not taken`;
}
export function alertText(o, pageUrl) {
    const r = o.reports[0];
    const late = r.received - r.at > 60000 ? ` (the report reached the messages service at ${hhmm(r.received)}, late)` : '';
    const health = r.serverHealthy === null ? '' : r.serverHealthy ? ` ${HUB}'s brain server answers its own health check (${r.serverMs} ms), so it looks like ${r.machine}'s link.` : ` ${HUB}'s brain server does not answer its own health check either.`;
    return `Recall is down: first reported by ${r.by} at ${hhmm(r.at)}${late}: ${r.error || 'no error text'}.${health} Other reports join this outage without a message; one message comes when recall is back. Outages: ${pageUrl}`;
}
export function backText(o, pageUrl) {
    const downs = o.reports.filter((r) => r.state === 'down');
    const who = [...new Set(downs.map((r) => r.by))];
    const machines = [...new Set(downs.map((r) => r.machine))];
    return `Recall is back: the outage from ${hhmm(o.start)} to ${hhmm(o.end)} lasted ${minutes(o.end - o.start)} minutes; ${who.length} agent${who.length === 1 ? '' : 's'} on ${machines.join(', ')} reported it. ${diagnosis(o)}. Outages: ${pageUrl}`;
}
