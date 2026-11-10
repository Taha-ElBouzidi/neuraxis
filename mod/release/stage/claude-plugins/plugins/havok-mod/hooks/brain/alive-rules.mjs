export const ALIVE_DIR = '.claude/havok-mod/alive';
export const FRESH_MS = 60000;
export const KEEP_KEYS = 32;
export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop', 'PostCompact'];
export const safeSession = (sid) => String(sid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
export function hash(text) {
    let h = 0x811c9dc5;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16);
}
export function markerKey(event, data) {
    const d = data || {};
    if (event === 'PreToolUse')
        return String(d.tool_use_id || '') || ('h' + hash(String(d.tool_name || '') + JSON.stringify(d.tool_input || {})));
    if (event === 'UserPromptSubmit')
        return String(d.prompt_id || '') + '|' + hash(d.prompt);
    if (event === 'Stop')
        return String(d.prompt_id || '') + '|' + (d.stop_hook_active ? 1 : 0) + '|' + hash(d.last_assistant_message);
    if (event === 'SessionStart')
        return String(d.source || '');
    if (event === 'PostCompact')
        return String(d.trigger || '') + '|' + hash(d.compact_summary);
    return '';
}
export function marked(marker, version, event, key, now) {
    const m = marker && typeof marker === 'object' && marker.ev && typeof marker.ev === 'object' ? marker : { ev: {} };
    const list = (Array.isArray(m.ev[event]) ? m.ev[event] : []).filter((x) => Array.isArray(x) && x[0] !== key && now - x[1] < FRESH_MS);
    list.push([key, now]);
    return { v: version, at: now, ev: { ...m.ev, [event]: list.slice(-KEEP_KEYS) } };
}
export function handled(marker, event, data, now) {
    if (!marker || !marker.ev || !Array.isArray(marker.ev[event]))
        return false;
    const key = markerKey(event, data);
    return marker.ev[event].some((x) => Array.isArray(x) && x[0] === key && now - Number(x[1]) < FRESH_MS && Number(x[1]) <= now + 5000);
}
