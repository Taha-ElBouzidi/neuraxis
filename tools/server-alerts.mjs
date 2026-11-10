export const SLOW_MS = 500;
export const SLOW_RUN = 3;
export const QUIET_MS = 6 * 3600000;
export const WARMUP_MS = 90000;
export const RUN_WINDOW_MS = 10 * 60000;
export function makeAlerts({ send, now = () => Date.now(), audit = () => { }, startedAt = now() }) {
    let run = [];
    let runAt = 0;
    const last = new Map();
    const held = new Map();
    function tell(kind, text) {
        const t = now();
        const prev = last.get(kind) || 0;
        if (prev && t - prev < QUIET_MS) {
            held.set(kind, (held.get(kind) || 0) + 1);
            return false;
        }
        const more = held.get(kind) || 0;
        held.delete(kind);
        last.set(kind, t);
        const body = text + (more ? ' (' + more + ' more of this kind since the last alert ' + Math.round((t - prev) / 60000) + ' min ago.)' : '');
        Promise.resolve().then(() => send(body, 'server-alert-' + kind + '-' + t))
            .then((r) => audit('ALERT ' + kind + ' ' + (r && r.sent ? 'sent' : 'not sent: ' + String(r && r.why).slice(0, 100))))
            .catch((e) => audit('ALERT ' + kind + ' not sent: ' + String(e && e.message).slice(0, 100)));
        return true;
    }
    return {
        recall(ms) {
            if (!Number.isFinite(ms))
                return false;
            if (now() - startedAt < WARMUP_MS) {
                run = [];
                return false;
            }
            if (ms <= SLOW_MS) {
                run = [];
                return false;
            }
            const t = now();
            if (run.length && t - runAt > RUN_WINDOW_MS)
                run = [];
            runAt = t;
            run.push(Math.round(ms));
            if (run.length < SLOW_RUN)
                return false;
            const got = run;
            run = [];
            return tell('slow', 'Brain server: ' + got.length + ' recall answers in a row over ' + SLOW_MS + ' ms (' + got.join(', ')
                + ' ms; normal is 50 to 130 ms). Check the server (node tools/analytics.mjs prints the last 24 hours).');
        },
        embed(what, limitMs) {
            return tell('embed', 'Brain server: the embedder ' + (what === 'load-timeout' ? 'did not load' : 'did not answer') + ' within '
                + limitMs + ' ms, so recall fell back to keyword only. Check the server (audit log lines EMBED-).');
        },
    };
}
