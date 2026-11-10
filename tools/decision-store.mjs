// The decision log (The owner, 2026-11-04: "keep track of every decision taken by any agent so I review them through the
// work"). Part of the engine since 0.4.90: nothing in it names a person or a machine; the owner's name comes from the
// instance's brain.json (owner), and is only used to spell a decision the owner gave the same way every time.
//
// Every decision an agent takes is one row; every review the owner makes on the page is another. Both go into one
// append-only file, <brain>/.analytics/decisions.jsonl, like the analytics rows: never edited, never deleted, never
// committed (.analytics/ is in .gitignore). The current state of a decision is computed from its rows: the last review
// wins, and a decision with no review is waiting.
//
//   decision  { kind: 'decision', id, at, agent, machine, session, what, why, options_left_out, area, relates_to,
//               backfilled?, received }
//   review    { kind: 'review', id, decision, at, state: 'kept' | 'reversed', note, by, via }
//
// The id of a decision is given by the client (the mod's outbox), so a row sent twice (a lost answer, a retry) is kept
// once and still reported as taken, which is what lets the outbox clear it. A review id is made here.
import { readFileSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// The instance's brain.json, read on each call that needs it (small, and a change needs no restart).
function brainConfig(brain) {
  try { return JSON.parse(readFileSync(join(brain, 'brain.json'), 'utf8')) || {}; } catch { return {}; }
}
const ownerOf = (brain) => String(brainConfig(brain).owner || '').trim().slice(0, 64);

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_TEXT = 2000;           // what, why, and a review note
export const MAX_AREA = 40;
export const MAX_OPTIONS = 4000;
export const MAX_RELATES = 20;
export const MAX_RELATE_CHARS = 200;
export const MAX_ROWS = 200;
export const MAX_BODY_CHARS = 2_000_000;
export const STATES = ['kept', 'reversed'];

export const storeFile = (brain) => join(brain, '.analytics', 'decisions.jsonl');

// One cache per brain folder. Only this process appends, but the file is re-read when its size is not the size this
// cache last saw (a row added by hand or by a backfill script), so the cache can never hide a row for long.
const caches = new Map();
function load(brain) {
  const file = storeFile(brain);
  let size = 0;
  try { size = statSync(file).size; } catch { /* no file yet */ }
  const had = caches.get(brain);
  if (had && had.size === size) return had;
  const c = { size, decisions: new Map(), last: new Map(), reviewIds: new Set(), waiting: 0 };
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { /* no file yet */ }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; } // a torn line
    if (o.kind === 'decision' && o.id && !c.decisions.has(o.id)) c.decisions.set(o.id, o);
    else if (o.kind === 'review' && o.decision) { c.last.set(o.decision, o); c.reviewIds.add(o.id); }
  }
  c.waiting = [...c.decisions.keys()].filter((id) => !c.last.has(id)).length;
  caches.set(brain, c);
  return c;
}

function append(brain, c, rows) {
  mkdirSync(join(brain, '.analytics'), { recursive: true });
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  appendFileSync(storeFile(brain), text, 'utf8');
  c.size += Buffer.byteLength(text, 'utf8');
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const isoOr = (v, now) => {
  const t = typeof v === 'number' ? v : Date.parse(str(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date(now).toISOString();
};

// A row as the client sent it, checked and cut to the fields kept. { row } or { error }.
// owner: the instance owner's name (brain.json owner); a by naming the owner, or the word owner, is kept in that spelling.
export function checkDecision(r, { machine = '', now = Date.now(), owner = '' } = {}) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { error: 'a row must be an object' };
  const id = str(r.id);
  if (!ID_RE.test(id)) return { error: 'id must be 1 to 64 letters, digits, dashes or underscores' };
  const what = str(r.what).trim();
  const why = str(r.why).trim();
  if (!what) return { error: 'what is required' };
  if (!why) return { error: 'why is required' };
  if (what.length > MAX_TEXT) return { error: 'what is over ' + MAX_TEXT + ' characters' };
  if (why.length > MAX_TEXT) return { error: 'why is over ' + MAX_TEXT + ' characters' };
  const area = str(r.area).trim() || 'other';
  if (area.length > MAX_AREA) return { error: 'area is over ' + MAX_AREA + ' characters' };
  const options = str(r.options_left_out).trim();
  if (options.length > MAX_OPTIONS) return { error: 'options_left_out is over ' + MAX_OPTIONS + ' characters' };
  const rel = r.relates_to == null ? [] : r.relates_to;
  if (!Array.isArray(rel) || rel.length > MAX_RELATES || rel.some((x) => typeof x !== 'string' || x.length > MAX_RELATE_CHARS)) {
    return { error: 'relates_to must be at most ' + MAX_RELATES + ' strings of at most ' + MAX_RELATE_CHARS + ' characters' };
  }
  const row = {
    kind: 'decision', id, at: isoOr(r.at, now),
    agent: str(r.agent).slice(0, 64), machine: (str(r.machine) || machine).slice(0, 64), session: str(r.session).slice(0, 128),
    what, why, options_left_out: options, area, relates_to: rel.filter((x) => x.trim()),
  };
  // by: who took the decision. The owner's name (or the word owner) for a decision the owner gave an agent, which the
  // agent logs the moment it gets it (The owner, 2026-11-04); left out, the agent took it itself.
  const by = str(r.by).trim().slice(0, 64);
  if (by) {
    const isOwner = by.toLowerCase() === 'owner' || (owner && by.toLowerCase() === owner.toLowerCase());
    row.by = isOwner ? (owner || 'owner') : by;
  }
  if (r.backfilled === true) row.backfilled = true;
  row.received = new Date(now).toISOString();
  return { row };
}

// One row, or { rows: [...] } (the analytics shape, { kind: 'decision', rows }, is the same). Answer in the analytics
// style: { status, body: { ok, kind, accepted (ids taken, a duplicate counted), added, duplicates, refused, reasons } }.
// machine: the caller's token name, used when a row names no machine.
export function accept(brain, payload, { machine = '', now = Date.now() } = {}) {
  const many = payload && typeof payload === 'object' && Array.isArray(payload.rows);
  const rows = many ? payload.rows.slice(0, MAX_ROWS) : [payload];
  const c = load(brain);
  const owner = ownerOf(brain);
  const fresh = [];
  const accepted = [];
  const refused = [];
  const reasons = {};
  for (const r of rows) {
    const got = checkDecision(r, { machine, now, owner });
    if (got.error) {
      const id = r && typeof r === 'object' && ID_RE.test(str(r.id)) ? str(r.id) : '(no valid id)';
      refused.push(id); reasons[id] = got.error;
      continue;
    }
    accepted.push(got.row.id);
    if (c.decisions.has(got.row.id) || fresh.some((f) => f.id === got.row.id)) continue;
    fresh.push(got.row);
  }
  if (!accepted.length) return { status: 400, body: { error: 'no valid decision row', refused, reasons } };
  if (fresh.length) {
    append(brain, c, fresh);
    for (const f of fresh) { c.decisions.set(f.id, f); if (!c.last.has(f.id)) c.waiting++; }
  }
  return { status: 200, body: { ok: true, kind: 'decision', accepted, added: fresh.length, duplicates: accepted.length - fresh.length, refused, reasons } };
}

function view(c, d) {
  const r = c.last.get(d.id);
  const out = { ...d, state: r ? r.state : 'waiting' };
  delete out.kind;
  if (r) out.review = { id: r.id, at: r.at, state: r.state, note: r.note, by: r.by, via: r.via };
  return out;
}

// { status, body }: 200 with the review row and the decision as it now stands, 404 for an unknown decision, 400 for a
// bad state or note. A decision can be reviewed again; the last review is its state.
export function review(brain, id, state, note, by, via, now = Date.now()) {
  const c = load(brain);
  const d = c.decisions.get(str(id));
  if (!d) return { status: 404, body: { error: 'no decision with id ' + str(id).slice(0, 64) } };
  if (!STATES.includes(state)) return { status: 400, body: { error: 'state must be kept or reversed' } };
  const n = str(note).trim();
  if (n.length > MAX_TEXT) return { status: 400, body: { error: 'note is over ' + MAX_TEXT + ' characters' } };
  let rid;
  do { rid = 'r' + now.toString(36) + randomBytes(5).toString('hex'); } while (c.reviewIds.has(rid));
  const row = { kind: 'review', id: rid, decision: d.id, at: new Date(now).toISOString(), state, note: n, by: str(by).slice(0, 200), via: str(via).slice(0, 20) };
  append(brain, c, [row]);
  if (!c.last.has(d.id)) c.waiting--;
  c.last.set(d.id, row);
  c.reviewIds.add(rid);
  return { status: 200, body: { ok: true, review: row, decision: view(c, d) } };
}

// Newest first (by the time the agent took it), with the state from the last review. Filters: agent, area, state
// (waiting, kept, reversed), since (an ISO time or date: decisions at or after it), limit (default 200, at most 1000).
export function list(brain, { agent, area, state, since, limit } = {}) {
  const c = load(brain);
  const sinceT = since ? Date.parse(str(since)) : NaN;
  const sinceIso = Number.isFinite(sinceT) ? new Date(sinceT).toISOString() : '';
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const out = [];
  const all = [...c.decisions.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const d of all) {
    if (agent && d.agent !== agent) continue;
    if (area && d.area !== area) continue;
    if (sinceIso && d.at < sinceIso) continue;
    const v = view(c, d);
    if (state && v.state !== state) continue;
    out.push(v);
    if (out.length >= lim) break;
  }
  return out;
}

// SEARCH (The owner, 2026-11-04: decisions are searchable, so an agent checks the log before asking him). Words of three
// letters or more, without common ones, matched in what, why, options left out, area, relates_to and by. Each word found
// counts by how rare it is in the log (a word in every decision says nothing). A tool search keeps decisions that
// match at least half of the asked words; the recall answer (prompt text, often long) keeps those with at least two
// distinct words found and a score over minScore. Newest wins a tie. Every state is returned: a reversed decision is
// as much an answer as a kept one. Besides the common words below, the owner's name and the one-word agent names seen in
// the log are left out of the match: they are in most decisions and say nothing about what a decision is about.
const STOP = new Set(('the and for are but not you all any can had her was one our out his has how its may new now old see '
  + 'two way who did get let put say she too use that with have this will your from they know want been good much some time '
  + 'very when come here just like long make many more only over such take than them well were what which while into also '
  + 'there their then these those would could should about after before being does done each other where whether still '
  + 'agent agents message messages please need needs keep off turn using used make made sure first last '
  + 'next yes thing things work works working own wrote write writes written json file files').split(' '));
export function wordsOf(text, extraStop = null) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/)) {
    if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w) && !(extraStop && extraStop.has(w))) out.add(w);
  }
  return out;
}
function instanceStop(brain, c) {
  const s = new Set();
  for (const w of ownerOf(brain).toLowerCase().split(/[^a-z0-9]+/)) if (w) s.add(w);
  for (const d of c.decisions.values()) { const a = String(d.agent || '').toLowerCase(); if (/^[a-z0-9]+$/.test(a)) s.add(a); }
  return s;
}
const textOf = (d) => [d.what, d.why, d.options_left_out, d.area, (d.relates_to || []).join(' '), d.by || ''].join(' ');

export function search(brain, query, { limit = 10, recall = false, minScore = 9 } = {}) {
  const c = load(brain);
  const extra = instanceStop(brain, c);
  const asked = [...wordsOf(query, extra)].slice(0, recall ? 400 : 40);
  if (!asked.length) return [];
  const docs = [...c.decisions.values()].map((d) => ({ d, w: wordsOf(textOf(d), extra), lead: wordsOf(d.what, extra) }));
  const n = docs.length || 1;
  const idf = new Map();
  for (const w of asked) {
    let df = 0;
    for (const x of docs) if (x.w.has(w)) df++;
    if (df) idf.set(w, Math.log(1 + n / df));
  }
  const need = recall ? 2 : Math.max(1, Math.ceil(asked.length / 2));
  const scored = [];
  for (const x of docs) {
    let hits = 0, score = 0;
    let lead = 0;
    // A word in the one-line what counts twice: that line says what the decision is about, the why only explains it.
    for (const w of asked) if (x.w.has(w)) { hits++; const lw = x.lead.has(w); if (lw) lead++; score += (idf.get(w) || 0) * (lw ? 2 : 1); }
    if (hits < need) continue;
    // From a prompt, a decision comes only when its own one-line what shares a word with it, and the score is clear.
    // Two words alone (often one phrase, such as status line) need a clearly higher score than three.
    if (recall && (!lead || score < minScore || (hits < 3 && score < minScore * 1.3))) continue;
    // A long prompt (an agent message, a pasted log) shares a few common words with many decisions. Kept only when the
    // match is a real share of either side: a fifth of the decision's what line, or a third of the prompt's words.
    if (recall && (lead < 2 || (lead / Math.max(x.lead.size, 1) < 0.2 && hits / asked.length < 0.3))) continue;
    scored.push({ x, hits, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.x.d.at < b.x.d.at ? 1 : -1));
  const lim = Math.min(Math.max(Number(limit) || 10, 1), 50);
  return scored.slice(0, lim).map((s) => ({ ...view(c, s.x.d), score: Math.round(s.score * 100) / 100, matched: s.hits }));
}

export function get(brain, id) {
  const c = load(brain);
  const d = c.decisions.get(str(id));
  return d ? view(c, d) : null;
}

// The agents and areas seen, for the page's filters.
export function facets(brain) {
  const c = load(brain);
  const agents = new Set();
  const areas = new Set();
  for (const d of c.decisions.values()) { if (d.agent) agents.add(d.agent); if (d.area) areas.add(d.area); }
  return { agents: [...agents].sort(), areas: [...areas].sort() };
}

// Decisions with no review yet. Kept in memory and moved on each write, so the recall answer pays nothing for it.
export function waitingCount(brain) {
  return load(brain).waiting;
}
