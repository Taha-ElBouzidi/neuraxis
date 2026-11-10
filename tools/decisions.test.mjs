// node --test tools/decisions.test.mjs
// The decision log (The owner, 2026-11-04; in the engine since 0.4.90): the store on temp folders, then the routes, the recall
// answer, the review page listener in both identity modes and the reversal message, on a throwaway server with a stub
// messages service (the live ones are never touched). The server starts as a stock install (local identity, no
// messages); brain.json is read on every call, so the tests change it to set up the other cases.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest, createServer as createHttp } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { accept, review, list, waitingCount, storeFile, search } from './decision-store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const tmpBrain = () => mkdtempSync(join(tmpdir(), 'decisions-'));
const row = (id, extra = {}) => ({ id, at: '2026-11-04T10:00:00.000Z', agent: 'lead-dev', machine: 'SERVER', session: 's1', what: 'Chose X', why: 'Because Y', options_left_out: 'Z, too slow', area: 'mod', relates_to: ['abc123'], ...extra });
const lines = (brain) => readFileSync(storeFile(brain), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---- the store ----

test('validation: what and why required, the length limits, relates_to, and the id form', () => {
  const b = tmpBrain();
  try {
    const bad = [
      [row('a1', { what: '' }), 'what is required'],
      [row('a2', { why: '   ' }), 'why is required'],
      [row('a3', { what: 'x'.repeat(2001) }), 'what is over'],
      [row('a4', { why: 'x'.repeat(2001) }), 'why is over'],
      [row('a5', { area: 'x'.repeat(41) }), 'area is over'],
      [row('a6', { options_left_out: 'x'.repeat(4001) }), 'options_left_out is over'],
      [row('a7', { relates_to: Array(21).fill('c') }), 'relates_to'],
      [row('a8', { relates_to: ['x'.repeat(201)] }), 'relates_to'],
      [row('a9', { relates_to: [5] }), 'relates_to'],
      [row('a10', { relates_to: 'abc' }), 'relates_to'],
    ];
    for (const [r, why] of bad) {
      const out = accept(b, r);
      assert.equal(out.status, 400, r.id);
      assert.deepEqual(out.body.refused, [r.id]);
      assert.match(out.body.reasons[r.id], new RegExp(why));
    }
    for (const id of ['', 'has space', 'dot.ted', 'x'.repeat(65), 'a/b']) assert.equal(accept(b, row(id)).status, 400, id);
    // At the limits is fine.
    const ok = accept(b, row('A-z_9', { what: 'x'.repeat(2000), why: 'y'.repeat(2000), area: 'a'.repeat(40), options_left_out: 'o'.repeat(4000), relates_to: Array(20).fill('r'.repeat(200)), backfilled: true, extra: 'dropped' }));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.accepted, ['A-z_9']);
    const kept = lines(b);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].kind, 'decision');
    assert.equal(kept[0].backfilled, true);
    assert.equal(kept[0].extra, undefined);
    assert.ok(kept[0].received);
    assert.equal(accept(b, row('x'.repeat(64))).status, 200);
  } finally { rmSync(b, { recursive: true, force: true }); }
});

test('a decision id seen before is kept once and still reported as taken; a batch keeps the valid rows', () => {
  const b = tmpBrain();
  try {
    let r = accept(b, { rows: [row('d1'), row('d1'), row('d2'), row('bad', { what: '' })] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.accepted, ['d1', 'd1', 'd2']);
    assert.deepEqual([r.body.added, r.body.duplicates, r.body.refused], [2, 1, ['bad']]);
    r = accept(b, row('d1', { what: 'changed' }));
    assert.deepEqual([r.status, r.body.accepted, r.body.added, r.body.duplicates], [200, ['d1'], 0, 1]);
    assert.equal(lines(b).length, 2);
    assert.equal(list(b).find((d) => d.id === 'd1').what, 'Chose X');
    assert.equal(waitingCount(b), 2);
  } finally { rmSync(b, { recursive: true, force: true }); }
});

test('the state comes from the last review; waiting when none; the count moves on each write', () => {
  const b = tmpBrain();
  try {
    accept(b, { rows: [row('o1', { at: '2026-11-01T00:00:00Z', agent: 'lead', area: 'brain' }), row('o2', { at: '2026-11-03T00:00:00Z' }), row('o3', { at: '2026-11-02T00:00:00Z' })] });
    assert.equal(waitingCount(b), 3);
    assert.deepEqual(list(b).map((d) => d.id), ['o2', 'o3', 'o1']);
    assert.equal(list(b)[0].state, 'waiting');
    assert.equal(review(b, 'nope', 'kept', '', 'me', 'page').status, 404);
    assert.equal(review(b, 'o1', 'maybe', '', 'me', 'page').status, 400);
    assert.equal(review(b, 'o1', 'kept', 'x'.repeat(2001), 'me', 'page').status, 400);
    const k = review(b, 'o1', 'kept', 'fine', 'me@github', 'page');
    assert.equal(k.status, 200);
    assert.deepEqual([k.body.review.state, k.body.review.by, k.body.review.via, k.body.review.decision], ['kept', 'me@github', 'page', 'o1']);
    assert.notEqual(k.body.review.id, 'o1');
    assert.equal(waitingCount(b), 2);
    review(b, 'o1', 'reversed', 'on second thought', 'me@github', 'page');
    assert.equal(waitingCount(b), 2, 'a second review does not count twice');
    const o1 = list(b).find((d) => d.id === 'o1');
    assert.deepEqual([o1.state, o1.review.note], ['reversed', 'on second thought']);
    assert.deepEqual(list(b, { state: 'waiting' }).map((d) => d.id), ['o2', 'o3']);
    assert.deepEqual(list(b, { state: 'reversed' }).map((d) => d.id), ['o1']);
    assert.deepEqual(list(b, { agent: 'lead' }).map((d) => d.id), ['o1']);
    assert.deepEqual(list(b, { area: 'mod' }).map((d) => d.id), ['o2', 'o3']);
    assert.deepEqual(list(b, { since: '2026-11-02' }).map((d) => d.id), ['o2', 'o3']);
    assert.deepEqual(list(b, { limit: 1 }).map((d) => d.id), ['o2']);
    assert.equal(lines(b).length, 5, 'append only: 3 decisions and 2 reviews');
    // A row added to the file by something else is seen on the next read.
    appendFileSync(storeFile(b), JSON.stringify({ kind: 'decision', ...row('o4', { at: '2026-11-04T00:00:00Z' }) }) + '\n');
    assert.equal(waitingCount(b), 3);
    assert.equal(list(b)[0].id, 'o4');
  } finally { rmSync(b, { recursive: true, force: true }); }
});

test('by: the owner of brain.json (or the word owner) is kept in the owner\'s spelling; left out means the agent took it', () => {
  const b = tmpBrain();
  try {
    writeFileSync(join(b, 'brain.json'), JSON.stringify({ owner: 'Sam' }));
    accept(b, { rows: [row('b1', { by: 'sam' }), row('b2'), row('b3', { by: 'lead' }), row('b4', { by: 'Owner' })] });
    const got = Object.fromEntries(list(b).map((d) => [d.id, d.by]));
    assert.deepEqual(got, { b1: 'Sam', b2: undefined, b3: 'lead', b4: 'Sam' });
  } finally { rmSync(b, { recursive: true, force: true }); }
  const n = tmpBrain();
  try {
    accept(n, row('n1', { by: 'owner' }));
    assert.equal(list(n)[0].by, 'owner', 'no owner configured: the word stays');
  } finally { rmSync(n, { recursive: true, force: true }); }
});

test('search: half the asked words in any field, best first; recall mode only clear matches led by the what line', () => {
  const b = tmpBrain();
  try {
    accept(b, { rows: [
      row('k1', { what: 'Denied five unused tools on SERVER: Artifact, Workflow, ReportFindings', why: 'They were never called in 7 days', area: 'machine', by: 'Sam' }),
      row('k2', { what: 'Kept the clean-up floor at 35,000 tokens', why: 'The bench showed notes of notes lose answers', area: 'context' }),
      row('k3', { what: 'Status line shows the reserve in red', why: 'Sam asked for it on the status line', area: 'mod' }),
      row('k4', { what: 'Chose Sonnet for routine code', why: 'cheaper', area: 'agents' }),
    ] });
    review(b, 'k2', 'reversed', 'floor changes', 'owner', 'page');
    assert.deepEqual(search(b, 'artifact workflow tools').map((d) => d.id), ['k1']);
    assert.equal(search(b, 'artifact workflow')[0].by, 'Sam');
    const floor = search(b, 'clean-up floor');
    assert.deepEqual([floor[0].id, floor[0].state], ['k2', 'reversed'], 'a reversed decision is returned with its state');
    assert.deepEqual(search(b, ''), []);
    assert.deepEqual(search(b, 'the and with'), [], 'common words only find nothing');
    assert.deepEqual(search(b, 'Can we deny the Artifact and Workflow tools on BOX2 too?', { recall: true }).map((d) => d.id), ['k1']);
    assert.deepEqual(search(b, 'hello, how are you today', { recall: true }), []);
    assert.deepEqual(search(b, 'a new reason given on the status line', { recall: true }), [], 'one phrase of two words is not enough');
  } finally { rmSync(b, { recursive: true, force: true }); }
});

test('search: the owner\'s name and one-word agent names say nothing about a decision', () => {
  const b = tmpBrain();
  try {
    writeFileSync(join(b, 'brain.json'), JSON.stringify({ owner: 'Sam Doe' }));
    accept(b, { rows: [row('w1', { agent: 'lead', what: 'Sam Doe asked lead for the backup schedule', why: 'nightly' })] });
    assert.deepEqual(search(b, 'sam doe lead'), []);
    assert.deepEqual(search(b, 'backup schedule').map((d) => d.id), ['w1']);
  } finally { rmSync(b, { recursive: true, force: true }); }
});

// ---- the server, the page listener and the reversal message ----
const MODULES = ['brain-server.mjs', 'agy-quota-store.mjs', 'brain-git-lock.mjs', 'vault-access.mjs', 'recall-core.mjs', 'recall-graph-worker.mjs', 'tailnet-watch.mjs', 'provenance.mjs', 'tokenize.mjs', 'layers-dist.mjs', 'server-alerts.mjs', 'layer-host.mjs', 'recall-turn.mjs', 'release-host.mjs', 'embed-guard.mjs', 'embed-worker.mjs', 'decision-store.mjs', 'decision-review.mjs', 'decisions-page.html'];
const REVIEWER = 'owner@github';
let root, port, pagePort, child, token, stub, stubPort, key;
const sent = [];
const freePort = () => new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function call(p, method, path, { headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const data = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { connection: 'close', ...(data != null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers };
    const rq = httpRequest({ host: '127.0.0.1', port: p, path, method, agent: false, headers: h }, (r) => {
      let t = ''; r.setEncoding('utf8'); r.on('data', (d) => { t += d; });
      r.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* html */ } ok({ status: r.statusCode, headers: r.headers, text: t, body: j }); });
    });
    rq.on('error', fail); rq.setTimeout(15000, () => rq.destroy(new Error('timeout'))); rq.end(data);
  });
}
const auth = () => ({ authorization: 'Bearer ' + token });
const config = (c) => writeFileSync(join(root, 'brain.json'), JSON.stringify(c));
// A stock install: an owner name and nothing else. messagesUrl '' stands for the engine default (no messages service),
// so these tests never reach a real one whichever build runs them.
const STOCK = { owner: 'Sam', pronoun: 'he', messagesUrl: '' };
const keyed = (extra = {}) => ({ 'x-review-key': key, ...extra });
const linkCmd = (env) => spawnSync(process.execPath, [join(root, 'tools', 'decision-review.mjs'), 'link'], { encoding: 'utf8', windowsHide: true, env });
const cleanEnv = () => { const e = { ...process.env, HAVOK_HOME: join(root, 'home'), HAVOK_BRAIN: root, HAVOK_DECISIONS_PORT: String(pagePort) }; delete e.CLAUDECODE; delete e.HAVOK_MOD_AGENT; return e; };

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'decisions-route-'));
  for (const d of ['tools', 'memory', 'home']) mkdirSync(join(root, d));
  for (const m of MODULES) if (existsSync(join(HERE, m))) copyFileSync(join(HERE, m), join(root, 'tools', m));
  const index = join(dirname(HERE), 'index');
  if (existsSync(index)) cpSync(index, join(root, 'index'), { recursive: true });
  writeFileSync(join(root, 'memory', 'MEMORY.md'), '# router\n');
  config(STOCK);
  stub = createHttp((req, res) => {
    let t = ''; req.on('data', (d) => { t += d; });
    req.on('end', () => { sent.push({ path: req.url, headers: req.headers, body: JSON.parse(t || '{}') }); res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: '01TESTMESSAGE' })); });
  });
  await new Promise((ok) => stub.listen(0, '127.0.0.1', ok));
  stubPort = stub.address().port;
  port = await freePort();
  pagePort = await freePort();
  const env = { ...process.env, HAVOK_HOME: join(root, 'home'), HAVOK_SERVER_PORT: String(port), HAVOK_DECISIONS_PORT: String(pagePort),
    HAVOK_LAYERS_DIR: join(root, 'LAYERS'), HAVOK_RELEASES_DIR: join(root, 'RELEASES') };
  delete env.HAVOK_MESSAGES_URL;
  child = spawn(process.execPath, [join(root, 'tools', 'brain-server.mjs'), '--allow-plaintext'], { env, windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 150; i += 1) {
    try { if ((await call(port, 'GET', '/health')).status === 200 && (await call(pagePort, 'GET', '/')).status === 200) break; } catch { /* starting */ }
    await sleep(100);
  }
  token = readFileSync(join(root, 'home', 'havok-server-token'), 'utf8').trim();
  key = readFileSync(join(root, 'home', 'havok-decision-review-key'), 'utf8').trim();
});
after(() => { try { child.kill(); } catch { /* gone */ } try { stub.close(); } catch { /* gone */ } rmSync(root, { recursive: true, force: true }); });

test('POST /decisions and GET /decisions need the token; one row or { rows }, answered with the ids taken', async () => {
  assert.equal((await call(port, 'POST', '/decisions', { body: row('s1') })).status, 401);
  assert.equal((await call(port, 'GET', '/decisions')).status, 401);
  assert.equal((await call(port, 'GET', '/decisions/count')).status, 401);
  let r = await call(port, 'POST', '/decisions', { headers: auth(), body: row('s1', { machine: '' }) });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.accepted, r.body.added], [['s1'], 1]);
  r = await call(port, 'POST', '/decisions', { headers: auth(), body: { rows: [row('s1'), row('s2', { at: '2026-11-04T11:00:00Z', agent: 'lead', area: 'brain' })] } });
  assert.deepEqual([r.status, r.body.accepted, r.body.added, r.body.duplicates], [200, ['s1', 's2'], 1, 1]);
  assert.equal((await call(port, 'POST', '/decisions', { headers: auth(), body: row('s3', { why: '' }) })).status, 400);
  r = await call(port, 'GET', '/decisions?agent=lead', { headers: auth() });
  assert.deepEqual(r.body.decisions.map((d) => d.id), ['s2']);
  r = await call(port, 'GET', '/decisions', { headers: auth() });
  assert.deepEqual(r.body.decisions.map((d) => d.id), ['s2', 's1']);
  assert.equal(r.body.decisions[1].machine, 'SERVER', 'a row with no machine takes the caller token name');
  assert.equal((await call(port, 'GET', '/decisions/count', { headers: auth() })).body.waiting, 2);
});


test('the /recall/turn answer carries decisionsWaiting', async () => {
  const want = (await call(port, 'GET', '/decisions/count', { headers: auth() })).body.waiting;
  assert.ok(want > 0);
  const r = await call(port, 'POST', '/recall/turn', { headers: auth(), body: { prompt: 'what did we decide about the mod', previous: [], session: 'dec-test', machine: 'SERVER', agent: 'test' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.decisionsWaiting, want);
});

test('GET /decisions?q= searches; the /recall/turn answer carries matching decisions', async () => {
  await call(port, 'POST', '/decisions', { headers: auth(), body: row('q1', { what: 'Moved the brain mirror timer to a pushed event on BOX2', why: 'Mirror pulls every minute cost antivirus scans', area: 'brain', by: 'Sam' }) });
  let r = await call(port, 'GET', '/decisions?q=' + encodeURIComponent('mirror timer'), { headers: auth() });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.decisions[0].id, r.body.decisions[0].by], ['q1', 'Sam']);
  assert.equal((await call(port, 'GET', '/decisions?q=mirror')).status, 401);
  r = await call(port, 'POST', '/recall/turn', { headers: auth(), body: { prompt: 'should the brain mirror timer on BOX2 keep pulling every minute?', previous: [], session: 'dec-test-2', machine: 'SERVER', agent: 'test' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.decisions.map((d) => [d.id, d.by, d.state]), [['q1', 'Sam', 'waiting']]);
  r = await call(port, 'POST', '/recall/turn', { headers: auth(), body: { prompt: 'hello there', previous: [], session: 'dec-test-3', machine: 'SERVER', agent: 'test' } });
  assert.equal(r.body.decisions, undefined, 'no field when nothing matches');
});

test('stock install, local identity: the page needs the per-install key and a local host; the token buys nothing', async () => {
  assert.ok(key.length >= 32, 'the server made the review key on start');
  const page = await call(pagePort, 'GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.text, /Agent decisions/);
  assert.equal((await call(pagePort, 'GET', '/decisions/')).status, 200, 'also under a proxy mount path');
  assert.equal((await call(pagePort, 'GET', '/api/decisions')).status, 401, 'no key, no reading');
  assert.equal((await call(pagePort, 'GET', '/api/decisions', { headers: { 'x-review-key': 'x'.repeat(43) } })).status, 401);
  assert.equal((await call(pagePort, 'GET', '/api/decisions', { headers: auth() })).status, 401, 'the brain token is not the key');
  assert.equal((await call(pagePort, 'GET', '/api/decisions', { headers: { 'tailscale-user-login': REVIEWER } })).status, 401, 'the tailnet header means nothing in local mode');
  assert.equal((await call(pagePort, 'GET', '/api/decisions', { headers: keyed({ host: 'evil.example:' + pagePort }) })).status, 403, 'a rebound host is refused');
  const l = await call(pagePort, 'GET', '/api/decisions?state=waiting', { headers: keyed() });
  assert.equal(l.status, 200);
  assert.deepEqual([l.body.identity, l.body.viewer, l.body.mayReview], ['local', 'Sam', true]);
  assert.ok(l.body.decisions.length > 0);
  const path = '/api/decisions/s1/review';
  assert.equal((await call(pagePort, 'POST', path, { headers: auth(), body: { state: 'kept' } })).status, 401);
  assert.equal((await call(pagePort, 'POST', path, { headers: { 'tailscale-user-login': REVIEWER }, body: { state: 'kept' } })).status, 401);
  assert.equal((await call(pagePort, 'POST', path, { headers: keyed({ host: 'evil.example' }), body: { state: 'kept' } })).status, 403);
  assert.equal((await call(pagePort, 'POST', path, { headers: keyed({ 'content-type': 'text/plain' }), body: '{"state":"kept"}' })).status, 415);
  assert.equal((await call(pagePort, 'POST', path, { headers: keyed({ 'sec-fetch-site': 'cross-site' }), body: { state: 'kept' } })).status, 403);
  assert.equal((await call(pagePort, 'POST', '/api/decisions/none/review', { headers: keyed(), body: { state: 'kept' } })).status, 404);
  assert.ok(!lines(root).some((x) => x.kind === 'review'), 'nothing refused was written');
  const r = await call(pagePort, 'POST', '/decisions' + path, { headers: keyed(), body: { state: 'kept', note: 'good' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.review.via, r.body.review.by, r.body.decision.state], ['page', 'Sam', 'kept']);
  assert.equal(r.body.message, undefined, 'kept tells nobody');
});

test('stock install: a reversal sends no message, and shows on the page and in the recall answer with its note', async () => {
  await call(port, 'POST', '/decisions', { headers: auth(), body: row('rv1', { what: 'Rotated the nightly backup archive to weekly snapshots', why: 'disk space', area: 'brain' }) });
  const before = sent.length;
  const r = await call(pagePort, 'POST', '/api/decisions/rv1/review', { headers: keyed(), body: { state: 'reversed', note: 'keep nightly' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.message, undefined, 'no messages service: no message field');
  await sleep(200);
  assert.equal(sent.length, before);
  const l = await call(pagePort, 'GET', '/api/decisions?state=reversed', { headers: keyed() });
  assert.deepEqual(l.body.decisions.map((d) => [d.id, d.review.note]), [['rv1', 'keep nightly']]);
  const t = await call(port, 'POST', '/recall/turn', { headers: auth(), body: { prompt: 'should the nightly backup archive become weekly snapshots?', previous: [], session: 'dec-test-4', machine: 'SERVER', agent: 'test' } });
  assert.deepEqual(t.body.decisions.map((d) => [d.id, d.state, d.note]), [['rv1', 'reversed', 'keep nightly']]);
});

test('stock install: no agent token reviews anything, its own decision or another\'s', async () => {
  await call(port, 'POST', '/decisions', { headers: auth(), body: { rows: [row('st1', { agent: 'lead' })] } });
  for (const agent of ['lead', 'lead-dev', 'system', '']) {
    const r = await call(port, 'POST', '/decisions/st1/review', { headers: auth(), body: { state: 'kept', agent } });
    assert.equal(r.status, 403, agent);
  }
  assert.equal(list(root).find((d) => d.id === 'st1').state, 'waiting');
});

test('the review link: printed for the owner with the same key; refused inside an agent session', () => {
  const ok = linkCmd(cleanEnv());
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), 'http://127.0.0.1:' + pagePort + '/#key=' + key);
  for (const v of ['CLAUDECODE', 'HAVOK_MOD_AGENT']) {
    const no = linkCmd({ ...cleanEnv(), [v]: '1' });
    assert.equal(no.status, 3, v);
    assert.doesNotMatch(no.stdout, /key=/);
  }
});

test('tailscale identity: a review needs a reviewer login, and records via page and the login', async () => {
  config({ ...STOCK, decisionReviewers: [REVIEWER] });
  const l = await call(pagePort, 'GET', '/api/decisions?state=waiting', { headers: { 'tailscale-user-login': REVIEWER } });
  assert.equal(l.status, 200);
  assert.deepEqual([l.body.identity, l.body.mayReview], ['tailscale', true]);
  assert.equal((await call(pagePort, 'GET', '/api/decisions')).body.mayReview, false);
  assert.equal((await call(pagePort, 'POST', '/api/decisions/s2/review', { headers: auth(), body: { state: 'kept' } })).status, 403);
  assert.equal((await call(pagePort, 'POST', '/api/decisions/s2/review', { headers: keyed(), body: { state: 'kept' } })).status, 403, 'the local key means nothing in tailscale mode');
  assert.equal((await call(pagePort, 'POST', '/api/decisions/s2/review', { headers: { 'tailscale-user-login': 'someone@github' }, body: { state: 'kept' } })).status, 403);
  assert.equal((await call(pagePort, 'POST', '/api/decisions/s2/review', { headers: { 'tailscale-user-login': REVIEWER, 'sec-fetch-site': 'cross-site' }, body: { state: 'kept' } })).status, 403);
  const r = await call(pagePort, 'POST', '/api/decisions/q1/review', { headers: { 'tailscale-user-login': REVIEWER }, body: { state: 'kept', note: 'good' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.review.via, r.body.review.by, r.body.decision.state], ['page', REVIEWER, 'kept']);
  // Set explicitly, local wins over a reviewers list.
  config({ ...STOCK, decisionReviewers: [REVIEWER], decisionReviewIdentity: 'local' });
  assert.equal((await call(pagePort, 'GET', '/api/decisions', { headers: { 'tailscale-user-login': REVIEWER } })).status, 401);
});

test('with a messages service configured, a reversal is sent to the deciding agent as system through it', async () => {
  config({ ...STOCK, decisionReviewers: [REVIEWER], messagesUrl: 'http://127.0.0.1:' + stubPort });
  const r = await call(pagePort, 'POST', '/api/decisions/s2/review', { headers: { 'tailscale-user-login': REVIEWER }, body: { state: 'reversed', note: 'ask me first' } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.message, { sent: true, id: '01TESTMESSAGE' });
  const m = sent.at(-1);
  assert.equal(m.path, '/send');
  assert.equal(m.headers['x-agent'], 'system');
  assert.ok(m.headers.authorization === 'Bearer ' + token, 'sent with the server token');
  assert.deepEqual(m.body, { to: 'lead@SERVER', text: 'Sam reversed your decision s2 (brain): Chose X. His note: ask me first.', key: 'decision-reversed-' + r.body.review.id, expect_reply: false });
  const c = (await call(port, 'GET', '/decisions/count', { headers: auth() })).body.waiting;
  assert.equal(c, list(root).filter((d) => d.state === 'waiting').length);
});

// The owner, 2026-11-09: the lead agent reviews the other agents' decisions with its brain token; its own stay the owner's.
test('an allowed agent reviews another agent\'s decision with the token; never its own; others may not', async () => {
  config({ ...STOCK, decisionReviewerAgents: ['lead@SERVER'], messagesUrl: 'http://127.0.0.1:' + stubPort });
  await call(port, 'POST', '/decisions', { headers: auth(), body: { rows: [row('ag1'), row('ag2', { agent: 'lead' })] } });
  const before = sent.length;
  const route = (id) => '/decisions/' + id + '/review';
  assert.equal((await call(port, 'POST', route('ag1'), { body: { state: 'kept', agent: 'lead' } })).status, 401);
  let r = await call(port, 'POST', route('ag1'), { headers: auth(), body: { state: 'kept', note: 'fine', agent: 'lead' } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.review.by, r.body.review.via, r.body.review.state], ['lead', 'agent', 'kept']);
  r = await call(port, 'POST', route('ag2'), { headers: auth(), body: { state: 'kept', agent: 'lead' } });
  assert.equal(r.status, 403, 'its own decision is the owner\'s');
  r = await call(port, 'POST', route('ag2'), { headers: auth(), body: { state: 'kept', agent: 'LEAD' } });
  assert.equal(r.status, 403, 'any case');
  r = await call(port, 'POST', route('ag1'), { headers: auth(), body: { state: 'kept', agent: 'lead-dev' } });
  assert.equal(r.status, 403, 'an agent not in decisionReviewerAgents');
  r = await call(port, 'POST', route('ag1'), { headers: auth(), body: { state: 'reversed', note: 'undo it', agent: 'lead' } });
  assert.equal(r.status, 200);
  for (let i = 0; i < 50 && sent.length === before; i += 1) await sleep(50);
  assert.equal(sent.length, before + 1, 'the deciding agent is told of the reversal');
  assert.equal(sent.at(-1).body.to, 'lead-dev@SERVER');
  config(STOCK);
});
