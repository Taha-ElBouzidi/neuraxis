import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAlerts, SLOW_MS, SLOW_RUN, QUIET_MS, WARMUP_MS } from './server-alerts.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('three slow recalls in a row send one message; a fast one between them resets the run', async () => {
  const sent = [];
  let t = 1_000_000;
  const a = makeAlerts({ send: (text, key) => { sent.push({ text, key }); return { sent: true }; }, now: () => t, startedAt: t - WARMUP_MS });
  a.recall(SLOW_MS + 1); a.recall(SLOW_MS + 2); a.recall(100); a.recall(SLOW_MS + 3); a.recall(SLOW_MS + 4);
  await tick();
  assert.equal(sent.length, 0);
  assert.equal(a.recall(SLOW_MS + 5), true);
  await tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, new RegExp(SLOW_RUN + ' recall answers in a row over ' + SLOW_MS + ' ms \\(503, 504, 505 ms'));
  assert.match(sent[0].key, /^server-alert-slow-/);
});

test('each kind is told at most once in the quiet time; the held ones are counted in the next message', async () => {
  const sent = [];
  let t = 1_000_000;
  const a = makeAlerts({ send: (text) => { sent.push(text); return { sent: true }; }, now: () => t, startedAt: t - WARMUP_MS });
  assert.equal(a.embed('timeout', 4000), true);
  t += 60_000;
  assert.equal(a.embed('timeout', 4000), false);
  assert.equal(a.embed('load-timeout', 90000), false);
  for (let i = 0; i < SLOW_RUN; i++) a.recall(SLOW_MS + 10);
  t += QUIET_MS;
  assert.equal(a.embed('timeout', 4000), true);
  await tick();
  assert.equal(sent.length, 3, 'embed, slow (its own kind), embed again after the quiet time');
  assert.match(sent[0], /did not answer within 4000 ms/);
  assert.match(sent[2], /\(2 more of this kind since the last alert/);
});

test('a send that throws or fails never throws out of the alert call', async () => {
  const lines = [];
  const a = makeAlerts({ send: () => { throw new Error('down'); }, audit: (l) => lines.push(l) });
  assert.equal(a.embed('timeout', 4000), true);
  await tick(); await tick();
  assert.match(lines[0], /^ALERT embed not sent: down/);
});

test('no slow alert while the embedder warms after a start', async () => {
  const sent = [];
  let t = 1_000_000;
  const a = makeAlerts({ send: (text) => { sent.push(text); return { sent: true }; }, now: () => t, startedAt: t });
  for (let i = 0; i < SLOW_RUN; i++) assert.equal(a.recall(6000), false);
  t += WARMUP_MS;
  for (let i = 0; i < SLOW_RUN - 1; i++) a.recall(6000);
  assert.equal(a.recall(6000), true);
  await tick();
  assert.equal(sent.length, 1);
});

test('slow recalls hours apart are not a run (the embedder pages back in after quiet)', async () => {
  const { makeAlerts, RUN_WINDOW_MS, WARMUP_MS } = await import('./server-alerts.mjs');
  let t = 0; const sent = [];
  const a = makeAlerts({ send: async (text, key) => { sent.push({ text, key }); return { sent: true }; }, now: () => t, startedAt: 0 });
  t = WARMUP_MS + 1;
  for (let i = 0; i < 3; i++) { a.recall(1500); t += RUN_WINDOW_MS + 1; }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 0);
  a.recall(1500); t += 1000; a.recall(1500); t += 1000; a.recall(1500);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1, 'three slow recalls within the window still alert');
});
