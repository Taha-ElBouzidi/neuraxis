export const WATCH_TURNS = 10;
export function compactRow(atIso, host, session, trigger, ctxBefore, summary) {
    return JSON.stringify({ at: atIso, host, session, ev: 'compacted', trigger, ctxBefore, summaryChars: String(summary || '').length }) + '\n';
}
export const watchState = (nowMs) => JSON.stringify({ at: nowMs, turnsLeft: WATCH_TURNS, turn: 0 });
export const contextOf = (u) => (u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0);
