import { type Config, type Engine, S, setRcStatus, setStatus } from './shared';
const API = 'https://api.anthropic.com';
const API_HEADERS = { 'anthropic-version': '2023-06-01', 'Anthropic-Beta': 'ccr-byoc-2025-07-29' };
export const RC_FIRST_MS = 20000;
export const RC_EVERY_MS = 5 * 60000;
export const RC_TURN_MS = 60000;
const RC_SOON_MS = 1000;
export const RC_RECHECK_MS = 20000;
export const COMMAND_HOLD_MS = 15000;
export const RC_AFTER_LOGIN_MS = 15000;
const STALE_LOOKS = 2;
type Pid = {
    name: string;
    user: boolean;
    bridge: string;
};
export type Look = {
    on: boolean;
    title: string;
    linked: boolean;
    bridge: string;
} | null;
let cfg: Config['remoteControl'] | null = null;
let home = '';
let want = '';
let lastLook = 0;
let stale = 0;
let timer: {
    cancel: () => void;
} | null = null;
let busy = false;
let lastBridge = '';
const tried = new Set<string>();
let pidFile = '';
async function pidRecord($: Engine, sessionId = S.sessionId): Promise<Pid | null> {
    const dir = `${home}/.claude/sessions`;
    for (const f of await $.fs.list(dir).catch(() => [])) {
        if (f.kind !== 'file' || !f.name.endsWith('.json'))
            continue;
        try {
            const j = JSON.parse(await $.fs.read(`${dir}/${f.name}`)) as Record<string, unknown>;
            if (j.sessionId !== sessionId)
                continue;
            pidFile = `${dir}/${f.name}`;
            return { name: String(j.name ?? ''), user: j.nameSource === 'user', bridge: typeof j.bridgeSessionId === 'string' ? j.bridgeSessionId : '' };
        }
        catch { }
    }
    return null;
}
const BRIDGE_RE = /^(session|cse)_[A-Za-z0-9]+$/;
const cardId = (bridge: string) => bridge.replace(/^session_/, 'cse_');
const sessionId = (bridge: string) => bridge.replace(/^cse_/, 'session_');
async function card($: Engine, bridge: string): Promise<{
    title: string;
    connected: boolean;
} | null> {
    const auth = await $.session.authorize().catch(() => null);
    if (!auth)
        return null;
    const r = await $.http.fetch(`${API}/v1/code/sessions/${cardId(bridge)}`, { auth: auth.handle, headers: API_HEADERS }).catch(() => null);
    if (!r?.ok)
        return null;
    try {
        const j = JSON.parse(r.text) as {
            response_shape?: Record<string, unknown>;
        } & Record<string, unknown>;
        const s = j.response_shape ?? j;
        return { title: String(s.title ?? ''), connected: s.connection_status === 'connected' };
    }
    catch {
        return null;
    }
}
export async function rcWant($: Engine): Promise<string> {
    if (want || !cfg)
        return want;
    if (cfg.name.trim())
        return (want = cfg.name.trim());
    const p = await pidRecord($);
    if (p?.user && p.name.trim())
        want = p.name.trim();
    return want;
}
export async function rcLook($: Engine): Promise<Look> {
    const p = await pidRecord($);
    if (!p)
        return null;
    await rcWant($);
    if (!p.bridge)
        return { on: false, title: '', linked: false, bridge: '' };
    if (!BRIDGE_RE.test(p.bridge))
        return null;
    const c = await card($, p.bridge);
    if (!c)
        return null;
    return { on: c.connected, title: c.title, linked: true, bridge: p.bridge };
}
function show($: Engine, l: NonNullable<Look>) {
    setRcStatus($, { on: l.on, name: l.on ? l.title : '', want });
    let text = '';
    if (!l.on)
        text = 'Remote Control off';
    else if (want && l.title !== want)
        text = `Remote Control named "${l.title}", not "${want}"`;
    setStatus($, 'rc', text);
}
async function rename($: Engine, bridge: string): Promise<boolean> {
    if (!BRIDGE_RE.test(bridge))
        return false;
    const auth = await $.session.authorize().catch(() => null);
    if (!auth)
        return false;
    const r = await $.http.fetch(`${API}/v1/sessions/${sessionId(bridge)}`, { method: 'PATCH', auth: auth.handle, headers: { ...API_HEADERS, 'content-type': 'application/json' }, body: JSON.stringify({ title: want }) }).catch(() => null);
    return !!r?.ok;
}
async function heal($: Engine, l: NonNullable<Look>, bridge: string): Promise<boolean> {
    if (!cfg?.heal || S.turnRunning)
        return false;
    if (!l.linked) {
        if (!want)
            return false;
        const cause = `off:${bridge}`;
        if (tried.has(cause))
            return false;
        const box = await $.prompt.read().catch(() => ({ text: '' }));
        if (box.text.trim())
            return false;
        tried.add(cause);
        $.ui.log(`Remote Control off: turning it on as "${want}"`, { to: 'debug' });
        S.commandUntil = (await $.clock.now()) + COMMAND_HOLD_MS;
        void $.command.run({ command: 'remote-control', args: want }).catch((err: unknown) => $.ui.log(`Remote Control: ${String(err).slice(0, 200)}`, { to: 'debug' }));
        return true;
    }
    if (l.on && want && l.title !== want) {
        const cause = `name:${bridge}:${l.title}`;
        if (tried.has(cause))
            return false;
        tried.add(cause);
        const ok = await rename($, bridge);
        $.ui.log(`Remote Control card "${l.title}" renamed to "${want}": ${ok ? 'done' : 'refused'}`, { to: 'debug' });
        return ok;
    }
    return false;
}
export async function rcCheck($: Engine): Promise<void> {
    if (!cfg || busy)
        return;
    busy = true;
    try {
        lastLook = await $.clock.now();
        const l = await rcLook($);
        if (!l)
            return;
        if (!l.on && ++stale < STALE_LOOKS) {
            arm($, RC_RECHECK_MS);
            return;
        }
        if (l.on)
            stale = 0;
        if (l.bridge)
            lastBridge = l.bridge;
        show($, l);
        if (await heal($, l, l.bridge || lastBridge))
            arm($, RC_RECHECK_MS);
    }
    finally {
        busy = false;
    }
}
function arm($: Engine, ms: number) {
    timer?.cancel();
    timer = $.clock.after(ms, () => {
        timer = null;
        void rcCheck($).finally(() => { if (!timer && cfg)
            arm($, RC_EVERY_MS); });
    });
}
export function rcCredentialsPath(): string { return home ? `${home}/.claude/.credentials.json` : ''; }
export async function rcPidPath($: Engine, sessionId: string): Promise<string> {
    const c = S.cfg;
    if (!c?.remoteControl.enabled)
        return '';
    home = home || c.home;
    await pidRecord($, sessionId).catch(() => null);
    return pidFile;
}
export const isPidPath = (path: string) => !!pidFile && path.toLowerCase() === pidFile.toLowerCase();
export async function rcPidChanged($: Engine) {
    if (!cfg)
        return;
    const p = await pidRecord($);
    if (!p)
        return;
    if (!p.bridge && lastBridge) {
        $.ui.log(`remote control: the link ${lastBridge} dropped; fixed now`, { to: 'debug' });
        stale = STALE_LOOKS - 1;
        arm($, RC_SOON_MS);
    }
    else if (p.bridge && p.bridge !== lastBridge) {
        lastBridge = p.bridge;
        arm($, RC_SOON_MS);
    }
}
export async function rcAccountChanged($: Engine) {
    if (!cfg)
        return;
    tried.clear();
    stale = 0;
    lastLook = 0;
    $.ui.log('sign-in changed: Remote Control looked at again', { to: 'debug' });
    arm($, RC_AFTER_LOGIN_MS);
}
export async function rcStart($: Engine, c: Config) {
    timer?.cancel();
    timer = null;
    want = '';
    lastLook = 0;
    stale = 0;
    lastBridge = '';
    tried.clear();
    cfg = c.remoteControl.enabled ? { ...c.remoteControl } : null;
    home = c.home;
    if (cfg)
        arm($, RC_FIRST_MS);
}
export async function rcTurn($: Engine) {
    if (!cfg || !S.cfg)
        return;
    if ((await $.clock.now()) - lastLook < RC_TURN_MS)
        return;
    arm($, RC_SOON_MS);
}
export async function rcTitle($: Engine): Promise<string> {
    const c = S.cfg;
    if (!c?.remoteControl.enabled)
        return '';
    if (c.remoteControl.name.trim())
        return c.remoteControl.name.trim();
    home = c.home;
    const p = await pidRecord($);
    return p?.user ? p.name.trim() : '';
}
