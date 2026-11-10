// The limit reserve (check-limit.mjs) as rules, in one place: the command hook and the mod import this file.
// Pure: no Node imports; the callers read the files and pass what they read.
//
// Keeps the last 5 percent of the Claude plan for the main assistant. The owner, 2026-10-02: at 97 percent of the 5 hour
// or the weekly limit, every other session stops taking new prompts and launching helper agents, so the main assistant still has
// room for an emergency. Every tool call too since 2026-10-16 ("the last two times we hit the limit, we hit them
// with other agents, not by you"). Bypass: the owner starts a prompt with "urgent", which opens the session for BYPASS_MS.

// 95 since 2026-11-02 (the owner via HAVOK, task 16): 3 percent was not enough room for the main agent.
export const BAR = 95;
export const BYPASS_MS = 2 * 60 * 60 * 1000;
export const KEEP_WARM_PROMPT = 'keep-warm ping';

// Only what the owner typed opens the reserve (audit 2026-11-01): a scheduled, loop or system wakeup, or a message relayed
// from another agent, that starts with "urgent" opened it too. A missing or unknown source still counts as typed.
export const AUTOMATED_SOURCES = new Set(['schedule_wakeup', 'loop_wakeup', 'poll_event', 'system']);
export const URGENT = /^\s*urgent\b/i;

// This machine's own reading, from its status line (~/.claude/havok-limits.json). Inside one window usage only rises;
// a reading counts until its window resets (resets_at), so an old number never blocks work.
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

// HAVOK RELAYS THE OWNER'S "urgent" (the owner via HAVOK, 2026-11-05): a message the mod delivers as a prompt (not typed) from the
// main agent (reserve.mainAgent, "havok") whose text starts with "urgent" opens the session as the owner's own "urgent" does,
// so HAVOK can start an agent for him while the reserve holds. The frame is the mod's own: a header line
// "AGENT MESSAGE: <address>, <time> (id <id>)" then a fenced body; a body line that starts like a header is quoted by
// the mod, so a message cannot forge one. Only a relay's own address counts (lead@<machine>, not lead-dev@...).
// The relays: this subscription's reserve keeper, and the agents brain.json "urgentRelays" names (reserveOf gives them
// as reserve.relays): the agent the owner talks to relays for them even on another account's login, where the keeper
// is that account's agent (2026-11-05). An install that names none has only the keeper.
const RELAY_HEAD = /^AGENT MESSAGE: ([^\s,]+), [^\n]*\n<<<msg-[A-Za-z0-9]+\r?\n([^\n]*)/gm;
export function isUrgentRelay(address, mainAgent, extra = []) {
  const from = String(address || '').trim().toLowerCase();
  const relays = [String(mainAgent || '').trim().toLowerCase(), ...(Array.isArray(extra) ? extra : []).map((r) => String(r).trim().toLowerCase())].filter(Boolean);
  return relays.some((r) => from === r || from.startsWith(r + '@'));
}
export function relayedUrgent(data, mainAgent, extra = []) {
  if (isTyped(data)) return false;
  for (const m of promptOf(data).matchAll(RELAY_HEAD)) {
    if (isUrgentRelay(m[1], mainAgent, extra) && URGENT.test(m[2])) return true;
  }
  return false;
}

export const isPing = (data) => promptOf(data).trim() === KEEP_WARM_PROMPT;

// A transcript row a person typed: { text, at }, or null. Only entries a person typed (origin.kind "human", or no
// origin in older transcripts) count; tool results, meta rows and compaction summaries do not.
export function typedRow(e, now) {
  if (!e || e.type !== 'user' || e.isMeta || e.isCompactSummary || !e.message) return null;
  if (e.origin && e.origin.kind && e.origin.kind !== 'human') return null;
  const at = Date.parse(e.timestamp) || now;
  const c = e.message.content;
  if (typeof c === 'string') return { text: c, at };
  if (Array.isArray(c)) {
    if (c.some((p) => p && p.type === 'tool_result')) return null;
    const t = c.find((p) => p && p.type === 'text');
    if (t) return { text: String(t.text || ''), at };
  }
  return null;
}

// Two hours from when he typed it, not from now: re-armed from now, one "urgent" kept the reserve open for as long as
// the turn ran.
export const urgentStillOpen = (last, now) => !!last && URGENT.test(last.text) && last.at + BYPASS_MS > now;

// The limit is per Claude subscription, so the reserve is too (The owner, 2026-11-02 20:25: "it's not dependent on the
// machine, it's dependent on the agent, on the subscription. So for my personal subscription, it should be Havoc").
// brain.json, the same on every machine: { limitReserve: { accounts: { "<account email>": "<agent>" | false } } }.
// The account is the one this machine is signed in with (~/.claude.json oauthAccount.emailAddress). An agent name:
// that agent keeps working past the bar. false: no reserve on that subscription. Not listed: the reserve holds and
// only the main-session file exempts.
export function reserveOf(brainConfig, accountEmail) {
  const accounts = (brainConfig && brainConfig.limitReserve && brainConfig.limitReserve.accounts) || {};
  const key = Object.keys(accounts).find((k) => k.trim().toLowerCase() === String(accountEmail || '').trim().toLowerCase());
  const v = key === undefined ? '' : accounts[key];
  const mainAgent = typeof v === 'string' ? v.trim().toLowerCase() : '';
  // The name a person reads in the notice (The owner, 2026-11-09: "the rest is reserved for HAVOK"): limitReserve.names
  // maps an agent to it; an agent without one is named as it is.
  const names = (brainConfig && brainConfig.limitReserve && brainConfig.limitReserve.names) || {};
  const nameKey = Object.keys(names).find((k) => k.trim().toLowerCase() === mainAgent);
  const mainName = mainAgent ? String((nameKey !== undefined && names[nameKey]) || mainAgent).trim() : '';
  const relays = (Array.isArray(brainConfig && brainConfig.urgentRelays) ? brainConfig.urgentRelays : []).map((r) => String(r).trim().toLowerCase()).filter(Boolean);
  return { enabled: v !== false, mainAgent, mainName, relays };
}

// Where Claude Code keeps the account file and where the status line writes its readings: inside CLAUDE_CONFIG_DIR
// when it is set (Claude Code then keeps .claude.json there), else the home folder (audit 2026-11-02: a machine with
// its own config folder was read from the wrong place).
export function claudeFiles(home, configDir) {
  const tidy = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const dir = tidy(configDir);
  const base = dir || tidy(home) + '/.claude';
  return { claudeJson: dir ? dir + '/.claude.json' : tidy(home) + '/.claude.json', limits: base + '/havok-limits.json' };
}

// The account email from ~/.claude.json, as read by the caller.
export const accountOf = (claudeJson) => String((claudeJson && claudeJson.oauthAccount && claudeJson.oauthAccount.emailAddress) || '');

export const isMainAgent = (agent, reserve) => !!reserve.mainAgent && String(agent || '').trim().toLowerCase() === reserve.mainAgent;

// A session started from another Claude Code session's tool shell (a `claude -p` run by the main agent) inherits that
// shell's environment, HAVOK_MOD_AGENT included, so it must not be exempt as the agent it names (audit 2026-11-02).
// CLAUDECODE cannot tell it apart here: Claude Code sets CLAUDECODE and CLAUDE_CODE_CHILD_SESSION in the environment
// of every hook and status line, the main session's too (checked on 2.1.316). CLAUDE_CODE_EXECPATH is set in its tool
// shells only, so only a session started from one carries it.
export const SESSION_SHELL_VAR = 'CLAUDE_CODE_EXECPATH';
export const startedFromSession = (env) => String((env && env[SESSION_SHELL_VAR]) || '').trim() !== '';
// The agent exemption, from the environment: the agent the launcher named, unless it was only inherited.
export const agentExempt = (env, reserve) => !startedFromSession(env) && isMainAgent(env && env.HAVOK_MOD_AGENT, reserve);

// mainName: the subscription's main agent as a person reads it (reserve.mainName).
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
// At most one row per session and bypass file this often: a row (and a sender process) on every allowed tool call of
// a two-hour urgent window would cost a process spawn per call. The marker keeps the last time per session and file.
export const BYPASS_ROW_EVERY_MS = 10 * 60_000;
export const BYPASS_MARKER = 'outbox/reserve-bypass.last.json';
// The marker after a row for this session and file at `now`, or null when a row was written too recently. Entries
// older than a day are dropped, so the marker stays small.
export function bypassMarkerAfter(marker, session, file, now) {
  const key = String(session || 'none') + '|' + file;
  const cur = marker && typeof marker === 'object' ? marker : {};
  if (now - (Number(cur[key]) || 0) < BYPASS_ROW_EVERY_MS) return null;
  const kept = Object.fromEntries(Object.entries(cur).filter(([, at]) => now - Number(at) < 24 * 3600_000));
  return { ...kept, [key]: now };
}
