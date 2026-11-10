// SERVER ALERTS ON THE EVENT (hardening item 4, 2026-11-04; the owner: alerts go to HAVOK, events instead of timers).
//
// tools/analytics.mjs ran every 5 minutes from task HavokBrainAnalytics (288 runs a day) to find slow recalls, silences
// and a dead embedder in the access log, and wrote what it found to .brain-alerts.json, which only the old pre-turn hook
// read; since the mod replaced that hook (0.1.29), those alerts reached nobody. The server sees each of those things the
// moment it happens, so it says so then, as an agent message to the alert address (brain.json alertsTo; none by
// default in the engine), sent as the server's system agent through the messages service (brain.json messagesUrl;
// none by default, and then the alert is only written to the audit log):
//   slow     SLOW_RUN recall answers in a row each over SLOW_MS (the server's own time, normally 50 to 130 ms)
//   embed    the embedder timed out (a request over its limit, or the model not loaded in time)
// Each kind is told at most once per QUIET_MS; the next one in that time is only counted and goes with the next message.
// A silence (no recall for 45 minutes in active hours) is not an alert any more: with the mod, every agent that cannot
// reach the brain reports it to HAVOK itself, and no recall while nobody works is not a fault.
// analytics.mjs stays, run by hand for the 24-hour sheet.

export const SLOW_MS = 500;
export const SLOW_RUN = 3;
export const QUIET_MS = 6 * 3600_000;
// The first recalls after a start are slow while the embedder warms (6.1 and 5.7 s after the 16:12 restart, 2026-11-04):
// no slow alert in the first WARMUP_MS after the server started.
export const WARMUP_MS = 90_000;
// A run counts only slow recalls close together: the first recall after hours of quiet is slow while the embedder pages
// back in (2026-11-08 04:30 5.7 s, 06:14 1.3 s, 2026-11-09 04:30 1.0 s made one false 'in a row' alert over 24 hours).
export const RUN_WINDOW_MS = 10 * 60_000;

// send(text, key) -> Promise<{ sent, why? }>; now() for tests. Returns { recall(ms), embed(what, limitMs) }.
export function makeAlerts({ send, now = () => Date.now(), audit = () => {}, startedAt = now() }) {
  let run = [];
  let runAt = 0;               // time of the last slow recall in the run
  const last = new Map();      // kind -> time of the last message sent
  const held = new Map();      // kind -> count of events held back by the quiet time

  function tell(kind, text) {
    const t = now();
    const prev = last.get(kind) || 0;
    if (prev && t - prev < QUIET_MS) { held.set(kind, (held.get(kind) || 0) + 1); return false; }
    const more = held.get(kind) || 0;
    held.delete(kind);
    last.set(kind, t);
    const body = text + (more ? ' (' + more + ' more of this kind since the last alert ' + Math.round((t - prev) / 60_000) + ' min ago.)' : '');
    Promise.resolve().then(() => send(body, 'server-alert-' + kind + '-' + t))
      .then((r) => audit('ALERT ' + kind + ' ' + (r && r.sent ? 'sent' : 'not sent: ' + String(r && r.why).slice(0, 100))))
      .catch((e) => audit('ALERT ' + kind + ' not sent: ' + String(e && e.message).slice(0, 100)));
    return true;
  }

  return {
    recall(ms) {
      if (!Number.isFinite(ms)) return false;
      if (now() - startedAt < WARMUP_MS) { run = []; return false; }
      if (ms <= SLOW_MS) { run = []; return false; }
      const t = now();
      if (run.length && t - runAt > RUN_WINDOW_MS) run = [];
      runAt = t;
      run.push(Math.round(ms));
      if (run.length < SLOW_RUN) return false;
      const got = run; run = [];
      return tell('slow', 'Brain server: ' + got.length + ' recall answers in a row over ' + SLOW_MS + ' ms (' + got.join(', ')
        + ' ms; normal is 50 to 130 ms). Check the server (node tools/analytics.mjs prints the last 24 hours).');
    },
    embed(what, limitMs) {
      return tell('embed', 'Brain server: the embedder ' + (what === 'load-timeout' ? 'did not load' : 'did not answer') + ' within '
        + limitMs + ' ms, so recall fell back to keyword only. Check the server (audit log lines EMBED-).');
    },
  };
}
