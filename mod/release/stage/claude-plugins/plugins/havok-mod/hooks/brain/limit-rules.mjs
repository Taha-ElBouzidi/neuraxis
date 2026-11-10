export const BAR = 95;
export const BYPASS_MS = 2 * 60 * 60 * 1000;
export const KEEP_WARM_PROMPT = 'keep-warm ping';
export const AUTOMATED_SOURCES = new Set(['schedule_wakeup', 'loop_wakeup', 'poll_event', 'system']);
export const URGENT = /^\s*urgent\b/i;
export function hitsOf(lim, now) {
    const live = (w) => (w && typeof w.used_percentage === 'number' && Number(w.resets_at) * 1000 > now ? w : null);
    const five = live(lim && lim.five);
    const week = live(lim && lim.week);
    return { five, week, hits: [['5 hour', five], ['weekly', week]].filter(([, w]) => w && w.used_percentage >= BAR) };
}
export const promptOf = (data) => (data && data.hook_event_name === 'UserPromptSubmit' ? String(data.prompt || '') : '');
export function isTyped(data) {
    return !AUTOMATED_SOURCES.has(String((data && data.source) || '')) && !(data && data.origin && data.origin.kind && data.origin.kind !== 'human');
}
export const typedUrgent = (data) => URGENT.test(promptOf(data)) && isTyped(data);
const RELAY_HEAD = /^AGENT MESSAGE: ([^\s,]+), [^\n]*\n<<<msg-[A-Za-z0-9]+\r?\n([^\n]*)/gm;
export function isUrgentRelay(address, mainAgent, extra = []) {
    const from = String(address || '').trim().toLowerCase();
    const relays = [String(mainAgent || '').trim().toLowerCase(), ...(Array.isArray(extra) ? extra : []).map((r) => String(r).trim().toLowerCase())].filter(Boolean);
    return relays.some((r) => from === r || from.startsWith(r + '@'));
}
export function relayedUrgent(data, mainAgent, extra = []) {
    if (isTyped(data))
        return false;
    for (const m of promptOf(data).matchAll(RELAY_HEAD)) {
        if (isUrgentRelay(m[1], mainAgent, extra) && URGENT.test(m[2]))
            return true;
    }
    return false;
}
export const isPing = (data) => promptOf(data).trim() === KEEP_WARM_PROMPT;
export function typedRow(e, now) {
    if (!e || e.type !== 'user' || e.isMeta || e.isCompactSummary || !e.message)
        return null;
    if (e.origin && e.origin.kind && e.origin.kind !== 'human')
        return null;
    const at = Date.parse(e.timestamp) || now;
    const c = e.message.content;
    if (typeof c === 'string')
        return { text: c, at };
    if (Array.isArray(c)) {
        if (c.some((p) => p && p.type === 'tool_result'))
            return null;
        const t = c.find((p) => p && p.type === 'text');
        if (t)
            return { text: String(t.text || ''), at };
    }
    return null;
}
export const urgentStillOpen = (last, now) => !!last && URGENT.test(last.text) && last.at + BYPASS_MS > now;
export function reserveOf(brainConfig, accountEmail) {
    const accounts = (brainConfig && brainConfig.limitReserve && brainConfig.limitReserve.accounts) || {};
    const key = Object.keys(accounts).find((k) => k.trim().toLowerCase() === String(accountEmail || '').trim().toLowerCase());
    const v = key === undefined ? '' : accounts[key];
    const mainAgent = typeof v === 'string' ? v.trim().toLowerCase() : '';
    const names = (brainConfig && brainConfig.limitReserve && brainConfig.limitReserve.names) || {};
    const nameKey = Object.keys(names).find((k) => k.trim().toLowerCase() === mainAgent);
    const mainName = mainAgent ? String((nameKey !== undefined && names[nameKey]) || mainAgent).trim() : '';
    const relays = (Array.isArray(brainConfig && brainConfig.urgentRelays) ? brainConfig.urgentRelays : []).map((r) => String(r).trim().toLowerCase()).filter(Boolean);
    return { enabled: v !== false, mainAgent, mainName, relays };
}
export function claudeFiles(home, configDir) {
    const tidy = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    const dir = tidy(configDir);
    const base = dir || tidy(home) + '/.claude';
    return { claudeJson: dir ? dir + '/.claude.json' : tidy(home) + '/.claude.json', limits: base + '/havok-limits.json' };
}
export const accountOf = (claudeJson) => String((claudeJson && claudeJson.oauthAccount && claudeJson.oauthAccount.emailAddress) || '');
export const isMainAgent = (agent, reserve) => !!reserve.mainAgent && String(agent || '').trim().toLowerCase() === reserve.mainAgent;
export const SESSION_SHELL_VAR = 'CLAUDE_CODE_EXECPATH';
export const startedFromSession = (env) => String((env && env[SESSION_SHELL_VAR]) || '').trim() !== '';
export const agentExempt = (env, reserve) => !startedFromSession(env) && isMainAgent(env && env.HAVOK_MOD_AGENT, reserve);
export function blockMessage(hits, mainName = '') {
    const when = (w) => (w.resets_at ? new Date(w.resets_at * 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'unknown');
    return hits.map(([name, w]) => name + ' limit at ' + Math.round(w.used_percentage) + '%, resets ' + when(w)).join('; ')
        + '. The rest is reserved for ' + (mainName || 'the main agent') + '. Start your message with "urgent" to open this session for 2 hours.';
}
export const TOOL_STOP = ' Stop working now: write where you stopped so the work can resume after the reset, and end your turn.';
export const PING_BLOCKED = 'keep-warm: limit reserve reached, ping skipped';
export const blockKind = (event, tool) => (event === 'UserPromptSubmit' ? 'prompt' : /^(Agent|Task)$/.test(String(tool || '')) ? 'agent' : 'tool');
export function blockRow(at, session, kind, event, five, week) {
    return JSON.stringify({ at, session, kind, event, five: five && five.used_percentage, week: week && week.used_percentage });
}
export const bypassName = (session) => String(session || '').replace(/[^\w-]/g, '') + '.txt';
export const BYPASS_OUTBOX = 'outbox/reserve-bypass.jsonl';
export const BYPASS_REASON = { urgent: 'urgent bypass', main: 'main session' };
export function bypassUseRow(at, agent, session, file, reason) {
    return { id: 'rb-' + String(session || 'none').replace(/[^\w-]/g, '').slice(0, 60) + '-' + at, at: new Date(at).toISOString(), agent: String(agent || ''), session: String(session || ''), file, reason };
}
export const BYPASS_ROW_EVERY_MS = 10 * 60000;
export const BYPASS_MARKER = 'outbox/reserve-bypass.last.json';
export function bypassMarkerAfter(marker, session, file, now) {
    const key = String(session || 'none') + '|' + file;
    const cur = marker && typeof marker === 'object' ? marker : {};
    if (now - (Number(cur[key]) || 0) < BYPASS_ROW_EVERY_MS)
        return null;
    const kept = Object.fromEntries(Object.entries(cur).filter(([, at]) => now - Number(at) < 24 * 3600000));
    return { ...kept, [key]: now };
}
