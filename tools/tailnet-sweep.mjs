#!/usr/bin/env node
// Tells the local brain server to bind any tailnet address it does not serve yet (POST /tailnet/sweep).
//
// Run by the task HavokTailnetUp on Windows' "network connected" event (Microsoft-Windows-NetworkProfile/Operational,
// event 10000; Tailscale logs it under the name Tailscale when the tailnet comes up). Replaces the brain server's
// 15-second timer (2026-11-05, the owner's timers-to-events review, item 3). The address can appear a few seconds after
// the event, so the call is repeated at most four times within 30 seconds, until a tailnet address is served, then the
// script ends: a bounded wait inside one event, not a timer. Output goes to <brain>/.tailnet-sweep.log.
//
//   node tools/tailnet-sweep.mjs
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const BRAIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HAVOK_SERVER_TLS_PORT || 8443);
const LOG = join(BRAIN, '.tailnet-sweep.log');
const log = (m) => { try { appendFileSync(LOG, new Date().toISOString() + ' ' + m + '\n'); } catch { /* best effort */ } };
const cert = join(BRAIN, 'server-cert.pem');

function call() {
  return new Promise((ok) => {
    const req = https.request({ host: '127.0.0.1', port: PORT, path: '/tailnet/sweep', method: 'POST', timeout: 5000, ...(existsSync(cert) ? { ca: readFileSync(cert) } : {}) }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { ok(JSON.parse(d)); } catch { ok({ error: 'status ' + res.statusCode }); } });
    });
    req.on('timeout', () => req.destroy(new Error('no answer within 5 s')));
    req.on('error', (e) => ok({ error: String(e.message || e) }));
    req.end();
  });
}

const waits = [0, 5000, 10000, 15000];
for (const w of waits) {
  if (w) await new Promise((r) => setTimeout(r, w));
  const r = await call();
  if (r.error) { log('brain server: ' + r.error); continue; }
  log('bound ' + (r.bound.join(', ') || 'nothing new') + '; serving ' + r.known.join(', '));
  if ((r.known || []).some((a) => a !== '127.0.0.1')) break;
}
