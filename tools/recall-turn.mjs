import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { terms as qterms } from './tokenize.mjs';
import { layerVersions } from './layer-host.mjs';
import { releaseSummary } from './release-host.mjs';
export const CONTEXT_CHARS = 700;
export const HARNESS_NOISE = /HOW TO REPLY|BRAIN RECALL|system-reminder|<function_/i;
export function contextMessage(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length < 12)
        return '';
    if (HARNESS_NOISE.test(t))
        return '';
    return t.slice(0, 400);
}
export function contextFromPrevious(previous) {
    const msgs = [];
    const list = Array.isArray(previous) ? previous.filter((x) => typeof x === 'string') : [];
    for (let i = list.length - 1; i >= 0 && msgs.join(' ').length < CONTEXT_CHARS * 2; i -= 1) {
        const m = contextMessage(list[i]);
        if (m)
            msgs.unshift(m);
    }
    return msgs.join(' ').slice(-CONTEXT_CHARS);
}
export const isSystemEvent = (prompt) => String(prompt).trimStart().startsWith('<task-notification>') || String(prompt).includes('[SYSTEM NOTIFICATION - NOT USER INPUT]');
export const hasArabicText = (text) => /[؀-ۿݐ-ݿ]/.test(text);
export function translateSync(text, brainDir) {
    try {
        const sys = join(brainDir, 'index', 'translate-system.txt');
        if (!existsSync(sys))
            return null;
        const out = execFileSync('claude', [
            '-p', '--model', 'haiku', '--output-format', 'json',
            '--system-prompt-file', sys,
            '--strict-mcp-config', '--disable-slash-commands',
            '--disallowed-tools', 'Bash Read Write Edit Glob Grep WebFetch WebSearch Task Agent TodoWrite Monitor Skill SlashCommand',
        ], {
            input: Buffer.from(text, 'utf8'),
            encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['pipe', 'pipe', 'ignore'],
        });
        const r = JSON.parse(out || '{}').result;
        return (typeof r === 'string' && r.trim() && r.length < 500) ? r.trim() : null;
    }
    catch {
        return null;
    }
}
const CHUNK_CHARS = 400, MAX_CHUNKS = 8;
export function chunkPrompt(text) {
    const parts = text.split(/(?<=[.!?\n])\s+/);
    const out = [];
    let cur = '';
    for (const p of parts) {
        if ((cur + ' ' + p).length > CHUNK_CHARS && cur) {
            out.push(cur.trim());
            cur = p;
        }
        else
            cur = cur ? cur + ' ' + p : p;
    }
    if (cur.trim())
        out.push(cur.trim());
    let kept = out;
    if (out.length > MAX_CHUNKS) {
        const end = Math.ceil(MAX_CHUNKS / 2);
        kept = [...out.slice(0, MAX_CHUNKS - end), ...out.slice(-end)];
    }
    const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    if (sentences.length > 1) {
        for (const edge of [sentences[0], sentences[sentences.length - 1]]) {
            if (edge.length >= 12 && edge.length <= CHUNK_CHARS && !kept.includes(edge))
                kept.push(edge);
        }
    }
    return kept;
}
export function splitParts(t) {
    const parts = String(t).split(/(?<=[.?!])\s+|\s+(?:also|and also|et aussi|aussi|btw|plus)\s+|,\s+(?:and|et)\s+|;\s+/i)
        .map((s) => s.trim()).filter((s) => s.length >= 15);
    return parts.length > 1 ? parts.slice(0, 8) : [];
}
export function prepareQueries(prompt, recentContext, { translate } = {}) {
    const hasArabic = hasArabicText(prompt);
    let queryText = prompt.slice(0, 2000);
    let note = '';
    if (hasArabic) {
        const translated = translate ? translate(queryText) : null;
        if (translated) {
            queryText = translated;
            note = "NOTE: your prompt was in Arabic. It was translated to English for recall (\"" + translated.slice(0, 80) + "\"). If that translation is wrong, the memories below are the wrong ones.";
        }
        else {
            note = "NOTE: this prompt is in Arabic and the translation step failed, so the brain was NOT consulted. Ask again in English or French, or tell the person the brain was not searched for this one.";
        }
    }
    const baseQueries = (!hasArabic && prompt.length > 2000) ? chunkPrompt(prompt) : [queryText, ...(hasArabic ? [] : splitParts(queryText))];
    const queries = (!hasArabic && recentContext) ? baseQueries.concat([recentContext]) : baseQueries;
    const translationFailed = hasArabic && queryText === prompt.slice(0, 2000);
    return {
        hasArabic, queryText, note, translationFailed, baseQueries, queries,
        parts: baseQueries.length - 1,
        contextIndex: queries.length > baseQueries.length ? baseQueries.length : -1,
    };
}
export function keywordRecall(kw, text, limit = 5) {
    const score = new Map();
    for (const w of new Set(qterms(String(text).slice(0, 20000).toLowerCase()))) {
        const slugs = kw && kw.terms ? kw.terms[w] : null;
        if (!slugs)
            continue;
        const weight = 1 / slugs.length;
        for (const s of slugs)
            score.set(s, (score.get(s) || 0) + weight);
    }
    return [...score.entries()]
        .filter(([, v]) => v >= Number(process.env.RECALL_MIN || 0.10))
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([slug]) => ({ slug, how: 'keyword', direct: true, description: (kw.descriptions && kw.descriptions[slug]) || '' }));
}
const SESSION = /^[A-Za-z0-9_-]{6,80}$/;
const STATE_KEEP_MS = 7 * 24 * 3600 * 1000;
const SHORT_FOLLOW_UP_DEFAULT = 25;
export function makeRecallTurn({ brain, recall, layersDir, releasesDir, stateDir, translate, shortFollowUp = SHORT_FOLLOW_UP_DEFAULT }) {
    let lastPrune = 0;
    const stateFile = (sid) => join(stateDir, sid + '.json');
    function readShown(sid) {
        try {
            return JSON.parse(readFileSync(stateFile(sid), 'utf8'));
        }
        catch {
            return [];
        }
    }
    function writeShown(sid, list) {
        try {
            mkdirSync(stateDir, { recursive: true });
            writeFileSync(stateFile(sid), JSON.stringify(list));
            if (Date.now() - lastPrune > 3600 * 1000) {
                lastPrune = Date.now();
                for (const f of readdirSync(stateDir)) {
                    try {
                        if (Date.now() - statSync(join(stateDir, f)).mtimeMs > STATE_KEEP_MS)
                            unlinkSync(join(stateDir, f));
                    }
                    catch { }
                }
            }
        }
        catch { }
    }
    const keywords = () => { try {
        return JSON.parse(readFileSync(join(brain, 'index', 'keywords.json'), 'utf8'));
    }
    catch {
        return { terms: {}, descriptions: {} };
    } };
    return async function recallTurn(body) {
        const prompt = typeof body.prompt === 'string' ? body.prompt : '';
        const sid = SESSION.test(String(body.session || '')) ? String(body.session) : null;
        const answer = { memories: [], droppedEarlier: [], note: '' };
        if (body.machine)
            answer.layers = layerVersions(layersDir, String(body.machine), Array.isArray(body.groups) ? body.groups.map(String) : []);
        const release = body.machine && releasesDir ? releaseSummary(releasesDir) : null;
        if (release)
            answer.release = release;
        if (!prompt.trim() || isSystemEvent(prompt))
            return answer;
        const prep = prepareQueries(prompt, contextFromPrevious(body.previous), { translate: translate ? (t) => translate(t) : null });
        answer.note = prep.note;
        if (prep.translationFailed)
            return answer;
        const bodyChars = body.bodies ? 1500 : 0;
        let hits;
        try {
            hits = await recall(prompt, prep.queries, 5, bodyChars, false, Math.max(0, Math.min(prep.parts, 16)), prompt.trim().length >= shortFollowUp ? prep.contextIndex : -1);
            if (hits.degraded)
                answer.note = (answer.note ? answer.note + ' ' : '') + 'NOTE: semantic recall missed this turn, so the recall below is keyword only and a paraphrase may not match. Why: '
                    + hits.degraded + '.';
        }
        catch (e) {
            hits = keywordRecall(keywords(), prep.contextIndex >= 0 ? prep.queries[prep.contextIndex] + ' ' + prompt : prompt);
            answer.note = (answer.note ? answer.note + ' ' : '') + 'NOTE: semantic recall missed this turn, so the recall below is keyword only and a paraphrase may not match. Why: '
                + String((e && e.message) || e).slice(0, 120) + '.';
        }
        const shown = sid ? readShown(sid) : [];
        const before = new Set(shown);
        const earlier = [];
        for (const h of hits) {
            if (!h || !h.slug)
                continue;
            const m = { slug: h.slug, description: h.description || '', why: h.how || 'keyword' };
            for (const k of ['body', 'chars', 'truncated'])
                if (h[k] !== undefined)
                    m[k] = h[k];
            if (before.has(h.slug)) {
                if (h.direct === false) {
                    answer.droppedEarlier.push(h.slug);
                    continue;
                }
                m.why = 'earlier';
                earlier.push([m, typeof h.match === 'number' ? h.match : -Infinity]);
                continue;
            }
            answer.memories.push(m);
        }
        earlier.sort((a, b) => b[1] - a[1]);
        for (const [m] of earlier)
            answer.memories.push(m);
        if (sid)
            writeShown(sid, [...new Set([...shown, ...hits.filter((h) => h && h.slug).map((h) => h.slug)])]);
        return answer;
    };
}
