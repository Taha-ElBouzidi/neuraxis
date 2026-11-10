import type { Engine } from './shared';
type Window = {
    used_percentage?: number;
    resets_at?: number;
};
export type Limits = {
    at?: number;
    five?: Window;
    week?: Window;
};
export async function readLimits($: Engine, file: string): Promise<Limits | null> {
    if (!file)
        return null;
    try {
        return JSON.parse(String(await $.fs.read(file))) as Limits;
    }
    catch {
        return null;
    }
}
const span = (ms: number) => {
    if (ms <= 0)
        return 'now';
    const m = Math.round(ms / 60000);
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    const mm = m % 60;
    return d ? `${d} d ${h} h` : h ? `${h} h ${mm} min` : `${mm} min`;
};
const one = (name: string, w: Window | undefined, now: number) => {
    if (!w || typeof w.used_percentage !== 'number')
        return '';
    const reset = Number(w.resets_at) > 0 ? Number(w.resets_at) * 1000 : 0;
    return `${name} ${Math.round(w.used_percentage)} percent${reset ? `, resets in ${span(reset - now)}` : ''}`;
};
export function limitLine(l: Limits | null, now: number): string {
    if (!l)
        return '';
    const parts = [one('5-hour', l.five, now), one('week', l.week, now)].filter(Boolean);
    if (!parts.length)
        return '';
    const at = Number(l.at) || 0;
    const old = at && now - at > 15 * 60000 ? ` (as of ${new Date(at).toISOString().slice(11, 16)} UTC)` : '';
    return `LIMITS: ${parts.join('; ')}${old}.`;
}
