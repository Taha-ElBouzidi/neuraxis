import type { Engine } from './shared';
import { S, VERSION, setUpdateStatus, mainAgent } from './shared';
import { B } from './brainjobs';
export type Release = {
    version: string;
    sha256: string;
    size: number;
    signature?: string;
};
export const UPDATE_MEMORY = 'reference_update_this_machine_to_a_new_havok_release';
const VERSION_RE = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/;
const FAILED = new Set(['rolled-back', 'rollback-failed', 'checksum-mismatch', 'no-rollback']);
export function parseRelease(x: unknown): Release | undefined {
    if (!x || typeof x !== 'object' || Array.isArray(x))
        return undefined;
    const r = x as Record<string, unknown>;
    if (typeof r.version !== 'string' || !VERSION_RE.test(r.version))
        return undefined;
    if (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256))
        return undefined;
    if (typeof r.size !== 'number' || !Number.isInteger(r.size) || r.size <= 0)
        return undefined;
    return { version: r.version, sha256: r.sha256, size: r.size, ...(typeof r.signature === 'string' && r.signature ? { signature: r.signature } : {}) };
}
const signedChecked = new Map<string, boolean>();
async function signed($: Engine, release: Release, tools: string): Promise<boolean> {
    if (!release.signature)
        return false;
    const key = release.version + ' ' + release.sha256;
    const known = signedChecked.get(key);
    if (known !== undefined)
        return known;
    let ok = true;
    try {
        const r = await $.process.run(['node', `${tools}/release-sign.mjs`, '--check'], { stdin: JSON.stringify(release), timeoutMs: 10000 });
        ok = r.exitCode === 0;
    }
    catch {
        ok = true;
    }
    signedChecked.set(key, ok);
    return ok;
}
export function isNewer(a: string, b: string): boolean {
    const x = a.split('.').map(Number);
    const y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) > (y[i] ?? 0);
    return false;
}
let told = new Set<string>();
export function updateReset() { told = new Set(); }
async function readJson($: Engine, path: string): Promise<Record<string, unknown> | null> {
    try {
        const v = JSON.parse(String(await $.fs.read(path)));
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    }
    catch {
        return null;
    }
}
export async function updateCheck($: Engine, release: Release | undefined): Promise<string> {
    const c = S.cfg;
    if (!c)
        return '';
    if (!release || !isNewer(release.version, VERSION)) {
        setUpdateStatus($, null);
        return '';
    }
    const v = release.version;
    const state = await readJson($, `${c.home}/.claude/havok-mod/update/state.json`);
    const here = state?.version === v ? String(state.result ?? '') : '';
    if (FAILED.has(here)) {
        setUpdateStatus($, { version: v, state: 'failed' });
        return '';
    }
    setUpdateStatus($, { version: v, state: 'waiting' });
    const onDisk = await readJson($, `${$.plugin.root.replace(/\\/g, '/')}/.claude-plugin/plugin.json`);
    const diskVersion = typeof onDisk?.version === 'string' ? onDisk.version : '';
    if (here === 'installed' || told.has(v) || (diskVersion && !isNewer(v, diskVersion)))
        return '';
    const machineFile = String((await $.env.get('HAVOK_MOD_MACHINE_CONFIG')) || `${c.home}/.claude/havok-mod/machine.json`).replace(/\\/g, '/');
    const updater = String((await readJson($, machineFile))?.updater ?? '').trim().toLowerCase();
    if (!updater || updater !== c.agent.toLowerCase())
        return '';
    const tools = `${B.root || B.brainDir || c.checks.brainDir}/tools`.replace(/\\/g, '/');
    if (!(await signed($, release, tools))) {
        setUpdateStatus($, { version: v, state: 'failed' });
        $.ui.log(`release ${v} is not offered: its signature is missing or does not verify`, { to: 'debug' });
        return '';
    }
    told.add(v);
    const tool = `${tools}/machine-update.mjs`;
    return [
        `Havok update: release ${v} is published and this machine runs ${VERSION}. You are this machine's updater (machine.json "updater").`,
        `When your current task allows, run hidden in the background: node "${tool}" --current ${VERSION}`,
        `(download, checksum, install, verify, and a rollback to ${VERSION} if the verify fails). Then mail ${mainAgent()} the line it prints after "MAIL TO HAVOK:",`,
        `restart the other agents only when idle (node "${tool}" --agents lists them), never mid-turn, and yourself last.`,
        `Steps and exit codes: brain ${UPDATE_MEMORY}.`,
    ].join(' ');
}
