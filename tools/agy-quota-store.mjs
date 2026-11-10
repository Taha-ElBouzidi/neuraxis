import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
export const quotaFile = (brain) => join(brain, '.agy-quota.json');
export function readQuota(brain) {
    try {
        return JSON.parse(readFileSync(quotaFile(brain), 'utf8').replace(/^﻿/, ''));
    }
    catch {
        return null;
    }
}
export function cleanQuota(q) {
    if (!q || typeof q !== 'object' || q.ok !== true)
        return null;
    const at = Date.parse(String(q.at || ''));
    if (!Number.isFinite(at) || at > Date.now() + 5 * 60000)
        return null;
    const pools = (Array.isArray(q.pools) ? q.pools : []).slice(0, 8).filter((p) => p && typeof p === 'object' && String(p.pool || '').trim()).map((p) => {
        const o = { pool: String(p.pool).slice(0, 60) };
        for (const k of ['weekly', 'fiveHour']) {
            const n = Number(p[k]);
            if (Number.isFinite(n) && n >= 0 && n <= 100)
                o[k] = n;
        }
        for (const k of ['weeklyReset', 'fiveHourReset'])
            if (p[k] != null)
                o[k] = String(p[k]).slice(0, 40);
        return o;
    });
    if (!pools.length)
        return null;
    return { at: new Date(at).toISOString(), machine: String(q.machine || '').slice(0, 64), ok: true, pools };
}
export function acceptQuota(brain, q) {
    const c = cleanQuota(q);
    if (!c)
        return { status: 400, body: { error: 'not a quota reading (ok, at, pools)' } };
    const cur = readQuota(brain);
    if (cur && Date.parse(cur.at) >= Date.parse(c.at))
        return { status: 200, body: { kept: false, at: cur.at } };
    const tmp = quotaFile(brain) + '.tmp';
    writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', 'utf8');
    renameSync(tmp, quotaFile(brain));
    return { status: 200, body: { kept: true, at: c.at } };
}
