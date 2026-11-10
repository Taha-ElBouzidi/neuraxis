import type { Engine } from 'claude-code';
import { S } from './shared';
import { B } from './brainjobs';
import { rcTitle } from './remote';
export type MenuConfig = {
    enabled: boolean;
    name: string;
    icon: string;
    color: string;
};
let done = '';
export let interactive = true;
export function setInteractive(v: boolean) { interactive = v; }
export function registerArgs(o: {
    agent: string;
    session: string;
    name: string;
    menu: MenuConfig;
    interactive: boolean;
    root: string;
    cwd?: string;
}): {
    argv: string[];
} | {
    skip: string;
} {
    if (!o.menu.enabled)
        return { skip: 'menu registration is off for this agent' };
    if (!o.agent)
        return { skip: 'no agent name' };
    if (/^verify-/i.test(o.agent))
        return { skip: 'a verify session' };
    if (!o.interactive)
        return { skip: 'not an interactive session' };
    if (!o.root)
        return { skip: 'the brain tools were not found' };
    const name = o.menu.name.trim() || o.name.trim();
    if (!name)
        return { skip: 'no display name (menu.name or the Remote Control name)' };
    const argv = ['node', `${o.root}/tools/agent-menu.mjs`, 'register', o.agent, '--name', name, '--session', o.session];
    if (o.cwd)
        argv.push('--cwd', o.cwd);
    if (o.menu.icon)
        argv.push('--icon', o.menu.icon);
    if (o.menu.color)
        argv.push('--color', o.menu.color);
    return { argv };
}
export async function menuTurn($: Engine, kind: string, agentId: string | undefined) {
    const c = S.cfg;
    if (!c || agentId !== undefined || (kind !== 'real' && kind !== 'mail') || done === S.sessionId)
        return;
    done = S.sessionId;
    let title = '';
    try {
        title = await rcTitle($);
    }
    catch {
        title = '';
    }
    const a = registerArgs({ agent: c.agent, session: S.sessionId, name: title, menu: c.menu, interactive, root: B.root || c.checks.brainDir, cwd: c.cwd });
    if ('skip' in a) {
        $.ui.log(`agent menu: ${a.skip}`, { to: 'debug' });
        return;
    }
    try {
        const r = await $.process.run(a.argv, { timeoutMs: 20000 });
        const out = String(r.stdout || '').trim().split('\n').at(-1) || '';
        let j: {
            ok?: boolean;
            changed?: boolean;
            what?: string;
            why?: string;
        } = {};
        try {
            j = JSON.parse(out);
        }
        catch {
            j = { ok: false, why: (out || r.stderr || `exit ${r.exitCode}`).slice(0, 200) };
        }
        if (j.ok === false)
            $.ui.log(`agent menu: not registered (${j.why})`, { to: 'debug' });
        else
            $.ui.log(`agent menu: ${j.changed ? j.what : `nothing to change (${j.what ?? 'already registered'})`}`, { to: 'debug' });
    }
    catch (err) {
        $.ui.log(`agent menu: could not run the writer (${String(err).slice(0, 160)})`, { to: 'debug' });
    }
}
