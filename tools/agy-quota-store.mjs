// One Gemini (agy) quota reading for every machine (The owner, 2026-11-09: "why is it not sync for all machines, we run it at
// every gemini run"; d-70c589fd). Every machine signs in to agy with the same Google account, so there is one quota.
// A run reads it at its end (tools/agy-run.mjs, agy-quota.ps1) and sends it here; the newest reading by its own `at`
// wins. The recall answer carries `agyQuotaAt`, and a machine whose own copy is older takes this one: still refreshed
// only by a Gemini run (d-e8c6d921), no timer anywhere.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const quotaFile = (brain) => join(brain, '.agy-quota.json');

export function readQuota(brain) {
  try { return JSON.parse(readFileSync(quotaFile(brain), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

// Only the fields the status line and agy-run read, each checked: a reading is data from another machine.
export function cleanQuota(q) {
  if (!q || typeof q !== 'object' || q.ok !== true) return null;
  const at = Date.parse(String(q.at || ''));
  if (!Number.isFinite(at) || at > Date.now() + 5 * 60_000) return null;
  const pools = (Array.isArray(q.pools) ? q.pools : []).slice(0, 8).filter((p) => p && typeof p === 'object' && String(p.pool || '').trim()).map((p) => {
    const o = { pool: String(p.pool).slice(0, 60) };
    for (const k of ['weekly', 'fiveHour']) { const n = Number(p[k]); if (Number.isFinite(n) && n >= 0 && n <= 100) o[k] = n; }
    for (const k of ['weeklyReset', 'fiveHourReset']) if (p[k] != null) o[k] = String(p[k]).slice(0, 40);
    return o;
  });
  if (!pools.length) return null;
  return { at: new Date(at).toISOString(), machine: String(q.machine || '').slice(0, 64), ok: true, pools };
}

// Keeps the reading when it is newer than the stored one. Returns { kept, at } with the reading that stands.
export function acceptQuota(brain, q) {
  const c = cleanQuota(q);
  if (!c) return { status: 400, body: { error: 'not a quota reading (ok, at, pools)' } };
  const cur = readQuota(brain);
  if (cur && Date.parse(cur.at) >= Date.parse(c.at)) return { status: 200, body: { kept: false, at: cur.at } };
  const tmp = quotaFile(brain) + '.tmp';
  writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', 'utf8');
  renameSync(tmp, quotaFile(brain));
  return { status: 200, body: { kept: true, at: c.at } };
}
