export const SUBSTANTIAL_STOPS = 8;
export function snapshotOf(entries) {
    const files = entries.filter((f) => f.name.endsWith('.md') && f.name !== 'MEMORY.md');
    let newest = 0;
    for (const f of files) {
        const m = Math.floor(f.mtimeMs || 0);
        if (m > newest)
            newest = m;
    }
    return { count: files.length, newest };
}
export function afterStop(state, now, memDir) {
    if (!state)
        return { state: { base: now, stops: 1, nudged: false } };
    const wrote = now.count > (state.base?.count ?? now.count) || now.newest > (state.base?.newest ?? now.newest);
    const stops = (state.stops || 1) + 1;
    const shouldNudge = !wrote && !state.nudged && stops >= SUBSTANTIAL_STOPS;
    const next = { base: state.base, stops, nudged: state.nudged || shouldNudge };
    if (!shouldNudge)
        return { state: next };
    return { state: next, note: 'BRAIN CHECK, once per session: ' + stops + ' turns of work and nothing written to the brain. If anything became true and durable (a decision and its reason, a fact about a client or system, a correction, a thing that broke and why), save it now in ' + String(memDir).split('\\').join('/') + ' and run node tools/save-brain.mjs. If genuinely nothing, ignore this.' };
}
