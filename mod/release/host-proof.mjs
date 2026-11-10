import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
export const PROVEN_MS = 24 * 3600000;
export function verdict(events, now) {
    const recent = events.filter((e) => now - Number(e.at) < PROVEN_MS);
    const count = (kind, ok) => recent.filter((e) => e.kind === kind && e.ok === ok).length;
    const first = (kind) => { const at = events.filter((e) => e.ok && e.kind === kind).map((e) => Number(e.at)); return at.length ? Math.min(...at) : 0; };
    const firstLayers = first('layers'), firstRecall = first('recall');
    const firstOk = firstLayers && firstRecall ? Math.max(firstLayers, firstRecall) : 0;
    const c = { layersOk: count('layers', true), layersFailed: count('layers', false), recallOk: count('recall', true), recallFailed: count('recall', false) };
    const yes = c.layersOk > 0 && c.recallOk > 0 && !c.layersFailed && !c.recallFailed && !!firstOk && now - firstOk >= PROVEN_MS;
    return { yes, ...c, firstOk: firstOk ? new Date(firstOk).toISOString() : '' };
}
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) {
    const i = process.argv.indexOf('--home');
    const home = i > 0 ? process.argv[i + 1] : process.env.USERPROFILE || homedir();
    let events = [];
    try {
        events = JSON.parse(readFileSync(join(home, '.claude', 'havok-mod', 'host-proof.json'), 'utf8')).events || [];
    }
    catch { }
    const v = verdict(events, Date.now());
    console.log(`${v.yes ? 'yes' : 'no'}: last 24 h, layers ${v.layersOk} ok and ${v.layersFailed} failed, recall ${v.recallOk} ok and ${v.recallFailed} failed; first success ${v.firstOk || 'never'}`);
    process.exit(v.yes ? 0 : 1);
}
